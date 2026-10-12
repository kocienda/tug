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

Every build, test, and lint command is a `just` recipe in the top-level [`Justfile`](Justfile). Run `just` with no arguments to list them all.

## 1. Install the tools

You need a Mac with Apple silicon running macOS 14 or later. Then install the following.

### Xcode

Install Xcode 26.3 or later from the App Store or from [developer.apple.com](https://developer.apple.com/xcode/), launch it once to accept the license, and make sure it is the active developer directory:

```sh
sudo xcode-select -s /Applications/Xcode.app
xcodebuild -version
```

Xcode 26 is required because the dictation engine compiles against the macOS 26 SDK. The app itself still runs on macOS 14 (the deployment target). Xcode also provides the Command Line Tools, which supply `git`, `clang`, `make`, and `python3`.

### Rust

Install `rustup` from [rustup.rs](https://rustup.rs). The checkout carries a `rust-toolchain.toml` that pins the compiler version and the `rustfmt` and `clippy` components, so the first `cargo` command in the tree installs the right toolchain on its own. Then add the two cargo tools the recipes use:

```sh
cargo install cargo-nextest   # runs the Rust tests
cargo install wasm-pack       # builds the WebAssembly crates
```

The Rust workspace treats warnings as errors (see `tugrust/.cargo/config.toml`). A build with a warning is a failed build.

### Bun

Install Bun 1.3 from [bun.sh](https://bun.sh). Bun is the only JavaScript runtime and package manager the project uses. There is no Node or npm step anywhere.

### Homebrew tools

```sh
brew install just tmux shellcheck
```

- `just` runs the recipes.
- `tmux` hosts every shell the app runs. Distribution builds bundle their own copy of tmux, but the developer bundles built by `just app-debug` and `just app-release` find it on your `PATH`, and the app refuses to start without it.
- `shellcheck` is used by `just lint` over the build scripts.

### Optional

- `cargo install cargo-watch` enables `just dev-watch`, which rebuilds `tugcast` as you edit Rust.
- An Apple Developer ID Application certificate. See [section 4](#4-build-the-signed-developer-bundle) for what it unlocks and how to get one.

## 2. Get the source and build the command-line tools

```sh
git clone https://github.com/kocienda/tug.git
cd tug
bun install --cwd tugcode --frozen-lockfile
bun install --cwd tugdeck --frozen-lockfile
just build
```

The two `bun install` lines fetch the dependencies of the Claude Code bridge and the frontend. `just build` compiles the bridge from `tugcode/` and expects its packages to be present, and the debug bundle in [section 4](#4-build-the-signed-developer-bundle) runs the frontend from `tugdeck/` the same way. The disk-image build in the next section installs both on its own.

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

The resulting app is ad-hoc signed. It runs on the Mac that built it, but Gatekeeper will refuse it on any other machine. That is what the signed path in the next section, and the notarized path in [section 7](#7-ship-a-notarized-build), are for.

## 4. Build the signed developer bundle

For day-to-day work on Tug you want the developer bundle rather than a disk image. It launches straight from the build, serves the frontend from a live Vite server so frontend edits appear without a rebuild, and carries a stable identity so macOS remembers the permissions you grant it.

That stable identity is why this path needs an Apple Developer ID Application certificate. Tug asks for the Accessibility permission, and macOS ties that grant to the app's code signature. An ad-hoc signature changes on every build, so every rebuild would revoke the grant. A Developer ID signature does not change, so the grant persists. The full reasoning is in [`tuglaws/code-signing-mac.md`](tuglaws/code-signing-mac.md).

Getting the certificate is a one-time, per-machine step. It requires a paid Apple Developer Program membership.

1. In Xcode, open Settings, then Accounts, and sign in with your Apple ID.
2. Select your team, click Manage Certificates, then the plus button, then Developer ID Application. Xcode generates the key, requests the certificate, and installs it in your login keychain.
3. Verify it from the checkout:

```sh
just setup-dev-signing
```

Now build and launch:

```sh
just app-debug      # Debug bundle: frontend served live by Vite, Rust debug binaries
just app-release    # Release bundle: optimized binaries, built frontend assets
```

Each recipe quits the previous instance of that bundle, builds, signs the bundle inside-out with your certificate, and opens it. The bundles are named for their build flavor and your current git branch (for example `Tug-debug.app` for the debug build on `main`), so a debug build, a release build, and a build from another worktree can all run at once without clobbering each other. Use `just launch-debug` or `just launch-release` to relaunch without rebuilding, `just stop` to quit every running instance, and `just logs-debug` or `just logs-release` to tail the logs.

The debug bundle is the normal inner loop:

- Edit the frontend under `tugdeck/`, and Vite reloads it in the running app.
- Edit Rust, and run `just app-debug` again, or run `just dev-watch` in a terminal to have `tugcast` rebuilt on save.
- Edit Swift, and run `just app-debug` again.

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

None of these launch Tug. The suite that does is the app-tests under `tests/app-test/`, which drive a real `Tug.app` through its accessibility interface. They need a signed bundle, so they need the Developer ID certificate from the previous section, plus a one-time Accessibility grant:

```sh
just build-app         # build the dedicated app-test bundle
just app-test-grant    # one-time: reveals the bundle and opens the Accessibility pane
just app-test          # the core tier, about twenty files, one app launch each
```

Each app-test file launches its own copy of the app, so the full corpus is slow and `just app-test-all` is rarely what you want. `just app-test-changed` runs the tests that cover the files you have modified, and `just app-test <file...>` runs exactly what you name. [`tests/app-test/README.md`](tests/app-test/README.md) covers writing and selecting app-tests; [`tuglaws/app-test-harness.md`](tuglaws/app-test-harness.md) explains how the harness works.

## 6. Lint

```sh
just lint   # clippy, rustfmt, oxlint, typechecks, shellcheck, and the frontend's own audits
just ci     # lint followed by test; the same gate the CI workflow runs
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
