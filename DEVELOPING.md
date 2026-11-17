# Developing Tug

This document takes you from a fresh checkout to a Tug build you made yourself. It covers the tools to install, the two ways to build the app, and how to run the tests. It does not describe the architecture; for that, start at [`tuglaws/tuglaws.md`](tuglaws/tuglaws.md) and [`CLAUDE.md`](CLAUDE.md).

Tug is made of several pieces that build with different toolchains and come together in one app bundle:

| Directory | What it is | Built with |
|-----------|------------|------------|
| `tugrust/` | The Rust workspace: `tugcast` (the WebSocket multiplexer), `tugtool` (the developer CLI), `tugexec`, `tugbank`, `tugrelaunch`, and their libraries | `cargo` |
| `tugcode/` | The Claude Code bridge, compiled to a single binary | `bun build --compile` |
| `tugdeck/` | The browser frontend, where the Session card lives | `bun` and Vite |
| `tugdeck/crates/` | WebAssembly crates the frontend loads; the built artifacts are checked in | `wasm-pack` |
| `tugproto/` | Protocol and message types shared between the Rust and TypeScript sides | TypeScript |
| `tugapp/` | The Swift macOS app that hosts everything | `xcodebuild` |
| `tugplug/` | The Claude Code plugin the app ships inside its bundle | nothing; copied as-is |

At runtime the pieces stack like this. `Tug.app`, the Swift host, owns the windows and shows the `tugdeck` frontend in web views. The frontend talks over a WebSocket to `tugcast`, which runs beside the app and multiplexes everything the cards show: sessions, shell output, file changes, git state. Each Claude Code session runs through `tugcode`, which speaks Claude Code's stream-json protocol on one side and `tugcast`'s on the other. `tugtool` is the command-line door to the same machinery, used by the recipes, by the plugin, and by you.

Every build, test, and lint command is a `just` recipe in the top-level [`Justfile`](Justfile). Run `just` with no arguments to list them all, grouped by purpose: `setup` readies your Mac, `app` builds and runs the app, `build` covers the pieces, `test` and `lint` check your work, `app-test` drives the real app, `inspect` reads a running instance, `clean` removes build products, and the rest (`release`, `lab`, `eval`, `generate`, `signing`) are for particular jobs.

## The short path

If you only want a running build, install Xcode as [section 1](#xcode) describes, then:

```sh
git clone https://github.com/kocienda/tug.git
cd tug
scripts/dev-setup.sh
just app-debug
```

`scripts/dev-setup.sh` checks your Mac against everything this document asks for, installs what is missing, and checks again. It asks once before running each of the two installers that edit your shell profile, rustup and Homebrew, and `--yes` answers both in advance. It never installs Xcode and never runs `sudo`; where one of those is needed it prints the commands for you to run. If it ends by telling you to open a new terminal, do that before `just app-debug`, because the terminal you ran it in does not yet see what it installed.

The same script with `--check` is a doctor: it reports and changes nothing. Once `just` is installed the two have shorter names:

```sh
just dev-doctor   # what is set up, what is not, and the command that fixes each
just dev-setup    # fix what can be fixed, then report
```

The report is in tiers. `run` is what `just app-debug` needs, `test` is what `just test` and `just lint` add, and `ship` is what `just dmg` adds, so a red line says what it stops you doing. `just app-debug` runs the `run` tier before it builds, and stops in its first second with the fix if a tool is missing.

The sections below explain what each step does and how to do it by hand.

## 1. Install the tools

You need a Mac with Apple silicon running macOS 15 or later. Install Xcode by hand. Everything after it in this section is what `scripts/dev-setup.sh` installs for you once you have the checkout, as [the short path](#the-short-path) describes; read on to do it by hand, or to see what the script does.

### Xcode

Install Xcode 26.3 or later from the App Store, from [developer.apple.com](https://developer.apple.com/xcode/), or from [xcodereleases.com](https://xcodereleases.com), which links every Xcode release directly. Make it the active developer directory, then accept the license and install its components. Launching Xcode once does the last two; these commands do the same from a terminal:

```sh
sudo xcode-select -s /Applications/Xcode.app
sudo xcodebuild -license accept
sudo xcodebuild -runFirstLaunch
xcodebuild -version
```

Xcode 26 is required because the dictation engine compiles against the macOS 26 SDK. The app itself still runs on macOS 15 (the deployment target). Xcode also provides the Command Line Tools, which supply `git`, `clang`, `make`, and `python3`.

Several Rust crates compile C code during the build, so confirm that Xcode's C compiler works before going further:

```sh
printf '#include <stddef.h>\nint main(void) { return 0; }\n' | cc -x c -c - -o /dev/null && echo "C compiler OK"
```

If this prints an error rather than `C compiler OK`, fix Xcode before installing anything else, because every later step that compiles C will fail the same way. An error naming a missing header inside `Xcode.app`, such as `'__stddef_ptrdiff_t.h' file not found`, means files are missing from your copy of Xcode. Xcode's code signature records every file it should contain, so you can confirm the damage directly. The check takes several minutes and prints nothing for a complete install:

```sh
codesign --verify --deep --strict /Applications/Xcode.app
```

If it prints anything, even a bare `/Applications/Xcode.app: No such file or directory`, the copy is damaged. Damage like this is rarely one file. Delete that copy of Xcode, install it again, and rerun both checks.

### Rust

Rust is installed with `rustup`, the official toolchain installer. Run its installer script and press Enter to accept the standard installation:

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

The installer puts `cargo`, `rustc`, and `rustup` in `~/.cargo/bin` and adds that directory to your `PATH` in your shell profile. Your current terminal does not see the change yet, so either open a new terminal window or load it into the one you have:

```sh
. "$HOME/.cargo/env"
```

Confirm that `cargo` is found:

```sh
cargo --version
```

Then add the two Rust tools the recipes use. `cargo-nextest` runs the Rust tests. Install its prebuilt binary straight into `~/.cargo/bin`, which needs no compiling:

```sh
curl -LsSf https://get.nexte.st/latest/mac | tar zxf - -C "${CARGO_HOME:-$HOME/.cargo}/bin"
cargo nextest --version
```

`wasm-pack` builds the WebAssembly crates. Install version 0.15.0 exactly, by unpacking its prebuilt binary beside `rustup` in `~/.cargo/bin`:

```sh
curl -LsSf https://github.com/wasm-bindgen/wasm-pack/releases/download/v0.15.0/wasm-pack-v0.15.0-aarch64-apple-darwin.tar.gz \
    | tar zxf - --strip-components 1 -C "${CARGO_HOME:-$HOME/.cargo}/bin" wasm-pack-v0.15.0-aarch64-apple-darwin/wasm-pack
wasm-pack --version
```

The version matters. The built WebAssembly packages under `tugdeck/crates/*/pkg/` are checked in, and `wasm-pack` chooses the optimizer that produces them. `just app-debug` rebuilds them every time, so a different `wasm-pack` rewrites three `.wasm` files and leaves your checkout modified after its first build. Version 0.15.0 is the one the CI workflow pins, and it reproduces the committed files byte for byte.

Use the prebuilt binaries rather than `cargo install`. Compiling either tool from source pulls in C libraries that can fail to build on a fresh Mac, and neither tool needs to be built locally.

The installer sets up the latest stable Rust, which is not necessarily the version Tug builds with. The checkout carries a `rust-toolchain.toml` that pins the exact compiler version along with the `rustfmt` and `clippy` components. The first `cargo` command you run inside the checkout downloads that pinned toolchain automatically, so there is nothing more to install by hand.

The Rust workspace treats warnings as errors (see `tugrust/.cargo/config.toml`). A build with a warning is a failed build.

### Homebrew

The remaining tools come from [Homebrew](https://brew.sh), which a fresh Mac does not have. Install it with its installer script, which asks for your password and then for Enter to confirm:

```sh
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

On Apple silicon, Homebrew installs into `/opt/homebrew`, which is not on your `PATH`. The installer ends by printing the lines that fix this. They add Homebrew to your login profile for future terminals and load it into the current one:

```sh
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
eval "$(/opt/homebrew/bin/brew shellenv)"
brew --version
```

Then install the tools:

```sh
brew install oven-sh/bun/bun@1.3.9 node python just tmux shellcheck
bun --version
```

- `bun` is the package manager, the test runner, the bundler, and the runtime for the Claude Code bridge. There is no npm step anywhere. It comes from the Bun project's own Homebrew tap, `oven-sh/bun`. The formula is pinned to `bun@1.3.9` because Tug builds with Bun 1.3 and the tap's unversioned `bun` has moved on to 1.4.
- `node` runs one thing: the Vite dev server that the debug bundle loads its frontend from. Bun 1.3 cannot run that server, because Vite's WebSocket proxy calls a Node API Bun does not have. Without `node` on your `PATH`, `just app-debug` builds and launches and the window stays empty. Any current Node works; Vite 7 needs 20.19 or later.
- `python` is for the disk-image builds, `just dmg` and `just notarize`. The tool that lays out the image needs Python 3.10 or later, and the `python3` that comes with Xcode is 3.9. Nothing else uses it.
- `just` runs the recipes.
- `tmux` hosts every shell the app runs. Distribution builds bundle their own copy of tmux, but the developer bundles built by `just app-debug` and `just app-release` find it on your `PATH`, and the app refuses to start without it.
- `shellcheck` is used by `just lint` over the build scripts.

### Optional

- `cargo install cargo-watch` enables `just dev-watch`, which rebuilds `tugcast` as you edit Rust.
- An Apple Developer ID Application certificate. The developer bundle runs without one, but the app-tests and notarized builds need it. See [section 4](#signing-ad-hoc-by-default-developer-id-if-you-have-one) for what it unlocks and how to get one.

## 2. Get the source and build the command-line tools

```sh
git clone https://github.com/kocienda/tug.git
cd tug
bun install --cwd tugcode --frozen-lockfile
bun install --cwd tugdeck --frozen-lockfile
bun install --cwd tests/app-test --frozen-lockfile
just build
```

`scripts/dev-setup.sh` runs the three `bun install` lines for you; `just build` is the step it leaves. The three lines fetch the dependencies of the Claude Code bridge, the frontend, and the app-test harness. The third is what `just lint` and `just test` type-check the harness against, so `just ci` fails without it. `just build` compiles the bridge from `tugcode/` and expects its packages to be present, and the debug bundle in [section 4](#4-build-and-run-the-developer-bundle) runs the frontend from `tugdeck/` the same way. The disk-image build in the next section installs both on its own.

`just build` compiles the Rust binaries and the Claude Code bridge in debug mode into `tugrust/target/debug/`, then symlinks them into `~/.local/bin`. Those symlinks are what the recipes and the app's development mode use, so add `~/.local/bin` to your `PATH` if it is not already there. The first build downloads and compiles every crate and takes several minutes; later builds are incremental.

If this succeeds, your toolchain is set up correctly. Everything from here on builds on it.

## 3. Build an unsigned app

The quickest way to a complete, runnable `Tug.app` needs no Apple developer account:

```sh
just dmg
```

This runs `tugrust/scripts/build-app.sh` with signing and notarization turned off. It compiles the Rust binaries in release mode, installs the frontend and bridge dependencies with `bun install`, builds the frontend with Vite, builds the Swift app with `xcodebuild`, assembles the bundle, and writes a drag-to-install disk image to `products/Tug.dmg`.

Two things about the first run:

- It builds a self-contained `tmux` from source (along with `libevent` and `ncurses`) to bundle inside the app. This takes a while cold and is cached under `.tmux-build/` afterwards.
- It creates a small Python virtual environment under `.build-tools/` for `dmgbuild`, the tool that lays out the disk image. Your system Python is not touched.

The resulting app is ad-hoc signed. It runs on the Mac that built it, but Gatekeeper will refuse it on any other machine. A build for other Macs needs the notarized path in [section 7](#7-ship-a-notarized-build).

## 4. Build and run the developer bundle

For day-to-day work on Tug you want the developer bundle rather than a disk image. It launches straight from the build and serves the frontend from a live Vite server, so frontend edits appear without a rebuild.

```sh
just app-debug      # Debug bundle: frontend served live by Vite, Rust debug binaries
just app-release    # Release bundle: optimized binaries, built frontend assets
```

Each recipe quits the previous instance of that bundle, builds, signs the bundle, and opens it. `just app-debug` runs `just build` and `just wasm` first, so it is the one command that takes a fresh checkout to a running app. The recipes that go with them:

| Recipe | What it does |
|--------|--------------|
| `just launch-debug`, `just launch-release` | Relaunch the bundle already built, without rebuilding |
| `just stop-debug`, `just stop-release` | Quit this checkout's debug or release instance |
| `just stop` | Quit every running Tug instance |
| `just instances` | List the running instances with their process id, port, and bundle path |
| `just logs-debug`, `just logs-release` | Tail the instance's newest `tugcast` and app logs |
| `just clean-debug`, `just clean-release` | Remove that bundle's build products |

The debug bundle is the normal inner loop:

- Edit the frontend under `tugdeck/`, and Vite reloads it in the running app.
- Edit Rust, and run `just app-debug` again, or run `just dev-watch` in a terminal to have `tugcast` rebuilt on save.
- Edit Swift, and run `just app-debug` again.

### Build identities: several Tugs at once

Tug is built to run in several copies at the same time: the released app you use, the debug build you are changing, and a build from each git worktree you have open. What keeps them apart is a build identity, computed from two things: the build flavor (`debug` or `release`) and the git branch the build was made on.

| Build | Bundle ID | App | Instance ID |
|-------|-----------|-----|-------------|
| Release on `main` | `dev.tugapp.app` | `Tug.app` | `release-main` |
| Debug on `main` | `dev.tugapp.app.debug` | `Tug-debug.app` | `debug-main` |
| Debug on another branch | `dev.tugapp.app.debug-<slug>` | `Tug-debug-<slug>.app` | `debug-<slug>` |
| Release on another branch | `dev.tugapp.app.release-<slug>` | `Tug-release-<slug>.app` | `release-<slug>` |
| App-tests, on any branch | `dev.tugapp.app.apptest` | `Tug-apptest.app` | `apptest-…`, one per test run |

The slug is the branch name in lowercase with every character outside `a-z` and `0-9` turned into a hyphen, so `feature/New_Thing` becomes `feature-new-thing`. A detached `HEAD` builds as `detached-<sha8>`.

Each identity gets four things of its own:

- **A bundle ID.** macOS keys permissions, LaunchServices, and the saved window state on it, so each build is a separate row in System Settings and none inherits another's grants.
- **An app file.** `Tug-debug.app` and `Tug.app` are different files, so building one never rewrites the binaries another is running from.
- **A build directory.** Xcode's default DerivedData is shared per project, which would have every variant overwrite the same product. The recipes pass their own `-derivedDataPath`: `~/Library/Developer/Xcode/DerivedData/Tug-debug` for the debug build on `main`, `…/Tug` for the release build, and so on.
- **A data directory.** `~/Library/Application Support/Tug/instances/<instance-id>/` holds that instance's workspaces, session ledger, and settings. A debug build starts with its own empty state and never touches the sessions of the Tug you work in.

The recipes are cwd-derived: they compute the identity from the directory you run them in. `just app-debug` in the main checkout builds and relaunches `debug-main`; the same command in a worktree on branch `fix-scroll` builds and relaunches `debug-fix-scroll`, and `debug-main` keeps running. `just stop-debug`, `just launch-debug`, and `just logs-debug` follow the same rule. `just stop` is the exception and quits everything.

Three things follow that are worth knowing before they surprise you:

- **`just app-release` on `main` is the same identity as the released Tug.** A downloaded `Tug.app` is also `dev.tugapp.app` and `release-main`, so the two share one data directory and one set of permissions, and `just app-release` quits the released app before it launches its own build. If you use a released Tug for your own work, do your development in `just app-debug`, or build release from a branch.
- **Instance data directories are yours, and nothing deletes them for you.** When a worktree is finished, `just worktree-remove <path>` removes it and, after asking, tears down its instance state in the same step. To retire a single instance's data, use `tugtool host instance remove <id>`, which confirms and moves the directory aside instead of deleting it. Do not `rm -rf` one by hand.
- **The app-test bundle is deliberately one identity for every branch.** Its Accessibility grant is given once and has to cover every worktree, so the bundle ID is forced to `dev.tugapp.app.apptest` while each worktree still builds into its own directory. Each test launches under a throwaway `apptest-…` instance, which is the only kind of instance directory the tooling reclaims on its own.

The mapping lives in three small scripts under `tugrust/scripts/`: `bundle-id-from-cwd.sh`, `product-name-from-cwd.sh`, and `derived-data-path.sh`. The reasoning is in [`tuglaws/code-signing-mac.md`](tuglaws/code-signing-mac.md).

### Inspecting a running instance

The `inspect` recipes take an instance ID from `just instances`:

```sh
just instances                        # which instances are up, and where their bundles are
just app-log debug-main --last 5m     # the app's system log; add --grep <text> to filter
just app-state debug-main             # the host's run-loop state
just app-sample debug-main            # a 3-second CPU sample of the host app, written to a file
```

`just logs-debug` tails the `tugcast` and app log files for this checkout's debug instance, and is usually the first place to look. The ledger databases under `~/Library/Application Support/Tug/` are live SQLite files; read them with `just db-inspect <name>`, which inspects a copy, and never with `sqlite3` directly.

### Signing: ad-hoc by default, Developer ID if you have one

These recipes sign the bundle with an Apple Developer ID Application certificate when your login keychain has one. When it does not, they sign ad-hoc and print a warning saying so. The ad-hoc bundle runs normally.

The difference is what macOS remembers. It ties the permissions you grant an app to the app's code signature. A Developer ID signature stays the same across rebuilds, so a grant persists. An ad-hoc signature changes with every build, so macOS may ask again for microphone and speech recognition access, which dictation uses, after each rebuild. The app-tests in [section 5](#5-run-the-tests) also depend on an Accessibility grant persisting, which is why they require the certificate. The full reasoning is in [`tuglaws/code-signing-mac.md`](tuglaws/code-signing-mac.md).

To use the certificate path, get the certificate once per machine. It requires a paid Apple Developer Program membership.

1. In Xcode, open Settings, then Accounts, and sign in with your Apple ID.
2. Select your team, click Manage Certificates, then the plus button, then Developer ID Application. Xcode generates the key, requests the certificate, and installs it in your login keychain.
3. Verify it from the checkout:

```sh
just setup-dev-signing
```

From then on, `just app-debug` and `just app-release` find the certificate and sign with it, with no other change.

## 5. Run the tests

```sh
just test
```

That runs four suites in order and names every failure in one pass:

| Recipe | What it runs |
|--------|--------------|
| `just test-rust` | `cargo nextest run` across the workspace |
| `just test-ts` | `bun test` in `tugdeck/`, `tugcode/`, `tugproto/`, and the app-test harness's own logic |
| `just test-swift` | The `TugTests` XCTest bundle, which compiles the app's Foundation-only sources and never launches the app |
| `just test-standalone` | The shipped plugin, driven from a scratch project with an empty `PATH`, the way a user's machine would |

None of these launch Tug. The suite that does is the app-tests under `tests/app-test/`, which drive a real `Tug.app` through its accessibility interface. They need a bundle signed with the Developer ID certificate described in the previous section, because their one-time Accessibility grant must survive rebuilds:

```sh
just build-app         # build the dedicated app-test bundle
just app-test-grant    # one-time: reveals the bundle and opens the Accessibility pane
just app-test          # the core tier, about twenty files, one app launch each
```

Each app-test file launches its own copy of the app, so the full corpus is slow and `just app-test-all` is rarely what you want. `just app-test-changed` runs the tests that cover the files you have modified, and `just app-test <file...>` runs exactly what you name. [`tests/app-test/README.md`](tests/app-test/README.md) covers writing and selecting app-tests; [`tuglaws/app-test-harness.md`](tuglaws/app-test-harness.md) explains how the harness works.

## 6. Lint

```sh
just lint   # clippy, rustfmt, oxlint, typechecks, shellcheck, and the frontend's own audits
just ci     # lint followed by the fast lane's tests; the same gate the CI workflow runs
just ci-full  # ci plus the integration suites; nightly and before a release
```

`just fmt` formats the Rust code. The frontend and bridge are checked with `bun run check` and `bun run lint` in their own directories, which `just lint` already runs for you.

## 7. Ship a notarized build

A build that other people can open on their Macs must be signed with a Developer ID and notarized by Apple:

```sh
just notarize   # writes products/Tug.dmg, signed, notarized, and stapled
```

Beyond the certificate, this needs a `notarytool` keychain profile named `tug-notary`, created once with your Apple ID, team ID, and an app-specific password:

```sh
xcrun notarytool store-credentials tug-notary \
    --apple-id <apple-id> --team-id <team-id> --password <app-specific-password>
```

Notarization submits the bundle to Apple and waits for the ticket, which typically takes five to fifteen minutes. The published releases and the nightly build are produced by the GitHub Actions workflows in `.github/workflows/`, which run this same script.

## When something goes wrong

- **Anything about the tools on your Mac.** Run `just dev-doctor`, or `scripts/dev-setup.sh --check` if `just` is the thing missing. It checks every tool and version this document asks for and prints the command that fixes each one; `just dev-setup` runs those commands for you.
- **`just` reports a missing tool.** `just build` needs the Rust toolchain and Bun; `just app-debug` also needs `wasm-pack` and Xcode. [Section 1](#1-install-the-tools) lists them all.
- **`just dmg` stops with "dmgbuild needs Python 3.10 or later".** The `python3` on your `PATH` is Xcode's. Run `brew install python`, open a new terminal, and run `just dmg` again.
- **`just app-debug` launches, and the window stays empty.** The debug bundle could not start its Vite dev server. `just logs-debug` shows the reason; `env: node: No such file or directory` means Node is not installed. Run `brew install node`, then `just launch-debug`.
- **`git status` shows modified `.wasm` files after a build you did not touch them in.** Your `wasm-pack` is not version 0.15.0, which is what `cargo install wasm-pack` gets you. Run `just dev-setup` to install the pinned version, or install it as [section 1](#rust) describes, then run `just wasm`, and the files return to their committed bytes.
- **A recipe cannot find `tugtool` or `tugcast`.** `just build` symlinks the binaries into `~/.local/bin`. Add that directory to your `PATH`.
- **The bridge build fails on a missing package.** Run the `bun install` lines from [section 2](#2-get-the-source-and-build-the-command-line-tools); `just build` does not install dependencies.
- **macOS asks for microphone or Accessibility access after every rebuild.** The bundle is ad-hoc signed, and an ad-hoc signature changes with each build. A Developer ID certificate makes grants persist; see [Signing](#signing-ad-hoc-by-default-developer-id-if-you-have-one).
- **A Rust or Swift change does not show up in the running app.** Only frontend edits reload live. Run `just app-debug` again.
- **A Rust or Swift change does not show up in an app-test.** `just app-test` builds its bundle only when none exists. Run `just app-test-build` after changing Rust or Swift.
- **The wrong app comes to the front, or an old build keeps launching.** Run `just instances` to see which bundle each instance runs from, `just stop` to quit them all, then launch the one you want.
- **A build is confused in a way nothing explains.** `just clean-debug` removes the debug bundle's build products and `just clean-all` removes everything; the next build starts cold.

## Cleaning up

```sh
just clean-rust      # the Rust target directory
just clean-debug     # the debug bundle's build products
just clean-release   # the release bundle's build products
just clean-all       # everything above
```

The cached tmux build under `.tmux-build/` and the `dmgbuild` environment under `.build-tools/` are safe to delete; the next `just dmg` recreates them.

## Where to go next

- [`CLAUDE.md`](CLAUDE.md) is the project's working agreement: the build and test discipline, the git policy, and the things that have gone wrong before.
- [`tuglaws/tuglaws.md`](tuglaws/tuglaws.md) and [`tuglaws/design-decisions.md`](tuglaws/design-decisions.md) hold the architecture laws and the decisions behind them. Read the relevant law before changing the frontend.
- [`tuglaws/INDEX.md`](tuglaws/INDEX.md) lists every design document.
- [`release-notes/README.md`](release-notes/README.md) describes how releases are versioned and noted.
