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
- macOS 14 Sonoma or later

### What else you’ll need

- A paid Claude plan that includes Claude Code, such as Pro or Max (the free plan doesn’t). Tug runs Claude Code, and the first-launch setup of Tug installs the `claude` program (if needed) and logs you in.
- The `git` program for changes and commits. If `git` isn’t on your Mac, setup offers to install Apple’s Command Line Tools (about 3 GB). You can skip the install at first and add `git` later, when you’re ready for your first commit.

Looking for an earlier version? [See all releases](https://github.com/kocienda/tug/releases).

## For developers

Building Tug from source needs more than running it does. Beyond the requirements above, a build machine needs:

- Xcode 26.3 or later, for the Swift app and the macOS 26 SDK it compiles against
- A Rust toolchain from [rustup](https://rustup.rs) (the checkout pins the version), plus `cargo-nextest` for the tests
- [Bun](https://bun.sh) 1.3, for the frontend, the Claude Code bridge, and the TypeScript tests
- [`just`](https://github.com/casey/just), which runs every build, test, and lint recipe
- `tmux`, `wasm-pack`, and `shellcheck` for the day-to-day development loop

An Apple Developer ID certificate is optional for building and running Tug. It is needed for the app-test suite and for builds you share with other Macs. [DEVELOPING.md](DEVELOPING.md) walks through installing the tools and going from a fresh checkout to a running build.

## Learn more

- [More about Tug](https://kocienda.com/tug)
- [Read the journal](https://kocienda.com/tug/journal)
