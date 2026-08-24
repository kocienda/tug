# Version Management

All Rust binaries have divergent version numbers. tugcode, tugbank, tugtool,
and tugrelaunch inherit `0.7.48` from the workspace; tugcast is independently
at `0.1.0`. There is no tooling to set, bump, or synchronize versions. There
is no build number.

## Goals

1. **Unified version:** All Rust binaries share a single semantic version,
   managed from the workspace `Cargo.toml`. Starting point: `0.8.0`.

2. **Build number:** A monotonically-increasing integer that increments on
   every build. Starting point: `1`. Encoded as semver build metadata in
   the workspace version (e.g., `0.8.0+1`), so it appears in cargo's
   compile output automatically.

3. **Visible everywhere:** The build number appears in cargo's compile
   output (`Compiling tugcode v0.8.0+42`) and in every binary's
   `--version` output (`<name> 0.8.0 (build 42)`).

4. **Version management script:** A shell script (or Rust script via
   `cargo xtask`) to set versions, bump versions (major/minor/patch),
   and bump the build number.


## Current state

| Binary      | Cargo.toml                        | Version | Inherits workspace? |
|-------------|-----------------------------------|---------|---------------------|
| tugcode     | crates/tugrust/Cargo.toml         | 0.7.48  | Yes                 |
| tugcast     | crates/tugcast/Cargo.toml         | 0.1.0   | No                  |
| tugbank     | crates/tugbank/Cargo.toml         | 0.7.48  | Yes                 |
| tugtool     | crates/tugtool/Cargo.toml         | 0.7.48  | Yes                 |
| tugrelaunch | crates/tugrelaunch/Cargo.toml     | 0.7.48  | Yes                 |

Library crates (tugtool-core, tugcast-core, tugbank-core) inherit the
workspace version where applicable. tugcast-core is at `0.1.0` like tugcast.

### How `--version` works today

- **tugcode:** Has a custom `version` subcommand (`commands/version.rs`)
  with `--verbose` for commit/date/rustc info. Also has clap `--version`
  via `const VERSION: &str = env!("CARGO_PKG_VERSION")`.
- **All others:** Use clap's built-in `--version` which reads
  `CARGO_PKG_VERSION` automatically.
- **No binary displays a build number.**


## Design

### Build number as semver build metadata

The build number lives in the workspace version string itself, using
semver's `+` build metadata syntax: `0.8.0+42`. This means:

- **Cargo shows it automatically:** `Compiling tugcode v0.8.0+42 (/path/...)`
- **No separate file needed:** The workspace `Cargo.toml` is the single
  source of truth for both version and build number.
- **Semver-compatible:** Build metadata is ignored for version comparison
  per the semver spec, so `0.8.0+1` and `0.8.0+42` are the same version
  for dependency resolution purposes.

`CARGO_PKG_VERSION` includes the build metadata (e.g., `0.8.0+42`), so
binaries can parse it at compile time to extract both parts.

### Build-time injection

tugcode's `build.rs` already sets `TUG_COMMIT`, `TUG_BUILD_DATE`, and
`TUG_RUSTC_VERSION`. Add `TUG_BUILD_NUMBER` by parsing the `+N` suffix
from `CARGO_PKG_VERSION`. For other binaries, the version string from
`CARGO_PKG_VERSION` contains everything needed — no separate `build.rs`
required.

### Version string format

All binaries adopt this format for `--version`:

    <name> 0.8.0 (build 42)

The version string is constructed by splitting `CARGO_PKG_VERSION` on
`+`: the part before `+` is the semver version, the part after is the
build number.

For tugcode's verbose version subcommand:

    tug 0.8.0 (build 42)
      commit:     a34cb38
      built:      2026-04-01
      rustc:      1.85.0

For tugcode's JSON output:

    {"status":"ok","schema_version":"1","version":"0.8.0","build_number":42,...}

### Version management script

A shell script at `tugrust/scripts/version.sh` with these subcommands:

    version.sh set <major.minor.patch>
      Sets workspace.package.version in tugrust/Cargo.toml to
      `<major.minor.patch>+<current_build_number>`. Preserves the
      existing build number. Runs `cargo generate-lockfile` to update
      Cargo.lock.

    version.sh bump major|minor|patch
      Reads current version from workspace Cargo.toml, increments the
      specified component, resets lower components to 0, preserves the
      build number. Then runs `set` with the new version.

    version.sh build
      Reads the `+N` suffix from the workspace version, increments by 1,
      writes the updated version back to Cargo.toml. This is intended to
      be called before `cargo build`.

    version.sh show
      Prints current version and build number.

### Make tugcast use workspace version

Change `tugcast/Cargo.toml` and `tugcast-core/Cargo.toml` to use
`version.workspace = true` instead of hardcoded `0.1.0`. This is the
prerequisite for unified versioning -- all crates must inherit from the
workspace so `version.sh set` only needs to update one place.


## Sequencing

1. **Unify versions:** Change tugcast and tugcast-core to
   `version.workspace = true`. Set workspace version to `0.8.0+1`.
   Verify `cargo build` succeeds. Confirm cargo output shows
   `Compiling tugcode v0.8.0+1`.

2. **Update `--version` output:** Add a helper (const or function) to
   each binary that splits `CARGO_PKG_VERSION` on `+` and formats as
   `<name> 0.8.0 (build 1)`. Update tugcode's `version` subcommand to
   include build number in plain, verbose, and JSON output. Update
   tugcode's `build.rs` to emit `TUG_BUILD_NUMBER` for the verbose
   version command.

3. **Create version.sh script:** Implement `set`, `bump`, `build`,
   and `show` subcommands. Verify each works correctly.

4. **Verify:** Run `--version` on every binary and confirm the output
   matches the expected format.


## Files affected

| File | Change |
|------|--------|
| `tugrust/Cargo.toml` | version `0.7.48` -> `0.8.0+1` |
| `tugrust/crates/tugcast/Cargo.toml` | hardcoded `0.1.0` -> `version.workspace = true` |
| `tugrust/crates/tugcast-core/Cargo.toml` | hardcoded `0.1.0` -> `version.workspace = true` |
| `tugrust/crates/tugrust/build.rs` | Parse build number from `CARGO_PKG_VERSION`, emit `TUG_BUILD_NUMBER` |
| `tugrust/crates/tugrust/src/cli.rs` | Format VERSION to include build number |
| `tugrust/crates/tugrust/src/commands/version.rs` | Add build number to all output formats |
| `tugrust/crates/tugbank/src/main.rs` | Format clap version to include build number |
| `tugrust/crates/tugtool/src/main.rs` | Format clap version to include build number |
| `tugrust/crates/tugrelaunch/src/main.rs` | Format clap version to include build number |
| `tugrust/scripts/version.sh` | New file, version management script |
