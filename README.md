# Tug: An IDE for AI coding

Tug is a full-featured Integrated Development Environment (IDE) built from scratch to improve the experience of AI-assisted software development. It is a macOS app and uses Claude Code for the AI. All prompts, AI responses, shell commands, file edits, git history, and in-flight work are integrated together, with excellent typography, rich text input, and content display along with tools to visualize, track, and manage the work. Tug is open source, distributed under the MIT license.

I’ve made everything just like I want it. My hope is that the things I chose to please myself might also please you too.

## Download

> Tug is beta software: expect rough edges and frequent changes.

**[Download Tug for macOS](https://github.com/kocienda/tug/releases/latest/download/Tug.dmg)**: the latest release, as a disk image.

[![Latest release](https://img.shields.io/github/v/release/kocienda/tug?label=version)](https://github.com/kocienda/tug/releases/latest)
[![Release date](https://img.shields.io/github/release-date/kocienda/tug?label=released)](https://github.com/kocienda/tug/releases/latest)

### System requirements

- A Mac with Apple silicon
- macOS 15 Sequoia or later, including macOS 26 Tahoe and macOS 27 Golden Gate

### What else you’ll need

- A paid Claude plan that includes Claude Code, such as Pro or Max (the free plan doesn’t). Tug runs Claude Code, and the first-launch setup of Tug installs the `claude` program (if needed) and logs you in.
- The `git` program for changes and commits. If `git` isn’t on your Mac, setup offers to install Apple’s Command Line Tools (about 3 GB). You can skip the install at first and add `git` later, when you’re ready for your first commit.

Looking for an earlier version? [See all releases](https://github.com/kocienda/tug/releases). Want to know what changed? [Release notes](https://github.com/kocienda/tug/releases).

## For developers

Building Tug from source needs more than running it does. Beyond the requirements above, a build machine needs:

- Xcode 26.3 or later, for the Swift app and the macOS 26 SDK it compiles against
- A Rust toolchain from [rustup](https://rustup.rs) (the checkout pins the version), plus `cargo-nextest` for the tests
- [Bun](https://bun.sh) 1.3, for the frontend, the Claude Code bridge, and the TypeScript tests
- [Node.js](https://nodejs.org), which runs the frontend's dev server inside the debug build
- [`just`](https://github.com/casey/just), which runs every build, test, and lint recipe
- `tmux`, `wasm-pack`, and `shellcheck` for the day-to-day development loop, and Python 3.10 or later for building a disk image

An Apple Developer ID certificate is optional for building and running Tug. It is needed for the app-test suite and for builds you share with other Macs.

### Build and run

With the tools installed, a fresh checkout becomes a running app in five commands:

```sh
git clone https://github.com/kocienda/tug.git && cd tug
bun install --cwd tugcode --frozen-lockfile
bun install --cwd tugdeck --frozen-lockfile
bun install --cwd tests/app-test --frozen-lockfile
just app-debug
```

`just app-debug` builds every piece, signs the bundle, and launches it as `Tug-debug.app`. The first build takes several minutes; later ones are incremental. The debug app is separate from a Tug you downloaded, so the two run side by side. Frontend edits under `tugdeck/` reload in the running app; after a Rust or Swift edit, run `just app-debug` again.

### Everyday recipes

Every build, test, and lint command is a `just` recipe. Run `just` alone to list them all, grouped by purpose. These are the ones you will use most:

| To… | Run |
|-----|-----|
| Build and launch the app | `just app-debug`, `just app-release` |
| Relaunch without rebuilding | `just launch-debug`, `just launch-release` |
| See what is running, read its logs, stop it | `just instances`, `just logs-debug`, `just stop-debug`, `just stop` |
| Build only the command-line tools | `just build` |
| Check your work before sending a change | `just ci` (or its halves, `just lint` and `just test`) |
| Run the app-tests your change touches | `just app-test-changed` |
| Package a disk image | `just dmg`, `just notarize` |
| Clear build products | `just clean-debug`, `just clean-release`, `just clean-all` |

### Several Tugs at once

A build's identity comes from its flavor and the git branch it was built on. Each identity is its own app, with its own bundle ID, build directory, settings, and macOS permissions, so they all run at the same time:

| Build | Bundle ID | App | Instance |
|-------|-----------|-----|----------|
| Release on `main` | `dev.tugapp.app` | `Tug.app` | `release-main` |
| Debug on `main` | `dev.tugapp.app.debug` | `Tug-debug.app` | `debug-main` |
| Debug on another branch | `dev.tugapp.app.debug-<branch>` | `Tug-debug-<branch>.app` | `debug-<branch>` |
| Release on another branch | `dev.tugapp.app.release-<branch>` | `Tug-release-<branch>.app` | `release-<branch>` |

The recipes act on the identity of the directory you run them in, so `just app-debug` in a git worktree builds and relaunches that worktree's app and leaves the others alone. One identity is shared: `just app-release` on `main` produces the same bundle ID as the Tug you downloaded, and the two share settings and sessions. Use `just app-debug` for daily work if you also use a released Tug.

[DEVELOPING.md](DEVELOPING.md) has the full walkthrough: installing the tools, how the pieces fit together, the build identities in detail, signing, the tests, and what to do when something goes wrong.

## Learn more

- [More about Tug](https://kocienda.com/tug)
- [Read the journal](https://kocienda.com/tug/journal)
