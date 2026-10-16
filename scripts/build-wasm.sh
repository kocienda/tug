#!/usr/bin/env bash
#
# build-wasm.sh — Build every WASM crate under tugdeck/crates/ in
# release mode via wasm-pack, then normalize the per-crate `pkg/`
# auto-generated `.gitignore` so the built artifacts can be tracked
# without `git add -f`.
#
# ## Why this exists
#
# wasm-pack writes a `pkg/.gitignore` containing `**` after every
# build. We want the artifacts checked in (so contributors do not
# need wasm-pack installed for `bun run dev` and so the macOS app
# build phase doesn't need a Rust toolchain). The wasm-pack default
# fights that policy. This script overwrites the auto-generated file
# with an empty one after each build, restoring our convention.
#
# ## Discovery
#
# All crates are auto-discovered by globbing for `Cargo.toml` files
# one directory below `tugdeck/crates/`. Adding a new WASM crate
# (e.g. for a future ANSI parser) requires zero edits here — drop
# the crate next to its peers, ensure it's a member of
# `tugdeck/crates/Cargo.toml` with `crate-type = ["cdylib", …]`, and the
# next `just wasm` picks it up.
#
# ## Failure modes
#
# - wasm-pack missing: prints an actionable message and exits 1.
# - A crate's wasm-pack build failure: propagates the non-zero exit.
# - No crates discovered: exits 0 with a notice (treated as a no-op).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRATES_DIR="$REPO_ROOT/tugdeck/crates"

WASM_PACK="$(command -v wasm-pack 2>/dev/null || echo "$HOME/.cargo/bin/wasm-pack")"
if [[ ! -x "$WASM_PACK" ]]; then
    echo "build-wasm.sh: wasm-pack not found." >&2
    echo "  install with: cargo install wasm-pack" >&2
    exit 1
fi

# Discover every WASM crate: a directory whose Cargo.toml declares a
# `cdylib`. A plain library member (`tugmark`, the core `tugmark-wasm`
# wraps and tugcast links natively) has no `pkg/` to build.
shopt -s nullglob
crate_manifests=()
for manifest in "$CRATES_DIR"/*/Cargo.toml; do
    if grep -q '"cdylib"' "$manifest"; then
        crate_manifests+=("$manifest")
    fi
done
shopt -u nullglob

if (( ${#crate_manifests[@]} == 0 )); then
    echo "build-wasm.sh: no crates discovered under $CRATES_DIR (no-op)."
    exit 0
fi

# rustup reads the toolchain pin from the working directory up, so build
# from inside the workspace to pick up `tugdeck/crates/rust-toolchain.toml`.
cd "$CRATES_DIR"

# One phase per crate on the calling Session card's running block, through
# `tugtool progress phase`; `just wasm` runs alone and under the app recipes.
REPORT="$REPO_ROOT/tugrust/scripts/report-phase.sh"
crate_names=()
for manifest in "${crate_manifests[@]}"; do
    crate_names+=("$(basename "$(dirname "$manifest")")")
done
bash "$REPORT" wasm 0 "${crate_names[0]}" --of "${crate_names[@]}" \
    --needle "just app-debug" --needle "just app-release"

# Panic locations in registry crates carry the absolute path of the cargo
# home, and std's carry the sysroot's wherever `rust-src` is installed
# (elsewhere they stay rustc's own `/rustc/<commit>`), so without these the
# package's bytes would name the machine that built it and
# `just wasm-check` could only pass on that one.
RUST_SRC="$(rustc --print sysroot)/lib/rustlib/src/rust"
RUST_COMMIT="$(rustc -vV | sed -n 's/^commit-hash: //p')"
export RUSTFLAGS="--remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo --remap-path-prefix=$RUST_SRC=/rustc/$RUST_COMMIT ${RUSTFLAGS:-}"

i=0
for manifest in "${crate_manifests[@]}"; do
    crate_dir="$(dirname "$manifest")"
    crate_name="$(basename "$crate_dir")"
    echo "==> building $crate_name"
    [ "$i" -eq 0 ] || bash "$REPORT" wasm "$i" "$crate_name"
    i=$(( i + 1 ))
    "$WASM_PACK" build --target web --release "$crate_dir"

    pkg_gitignore="$crate_dir/pkg/.gitignore"
    if [[ -f "$pkg_gitignore" ]]; then
        # wasm-pack regenerates this on every build with `**`; an
        # empty file in its place leaves the contents trackable
        # without `git add -f`.
        : > "$pkg_gitignore"
    fi
done

bash "$REPORT" wasm "${#crate_names[@]}"
echo "==> wasm build complete"
