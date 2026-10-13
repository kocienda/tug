#!/usr/bin/env bash
# Compile the release "inputs" every release bundle is made of: the optimized
# Rust binaries, the bun-compiled tugcode, and the tugdeck static assets.
# Both `just app-release` (the developer launch bundle) and
# build-app.sh (the distribution bundle) get their compiled inputs from here,
# so the set of binaries and the build flags can't drift between the two paths.
#
# Populates tugrust/target/release/{tugcast,tug,tugexec,
# tugrelaunch,tugcode} and tugdeck/dist/. The Tug Xcode target's copy
# phase reads these binaries from target/$CONFIGURATION and errors if any are
# missing, so this script must build the full set.
#
# `--dev` is for `just app-release` only and changes caching, never what is
# built: the Rust build is incremental (a one-line tugcast edit rebuilds in
# ~20s instead of ~33s, at the cost of a large target/release/incremental
# and codegen that differs slightly from a clean build), and the tugdeck
# build is skipped when neither its inputs nor dist/ have changed since the
# last --dev build. The distribution build (build-app.sh) never passes it,
# so what ships is always a clean, full build.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

DEV=0
case "${1:-}" in
    --dev) DEV=1 ;;
    "") ;;
    *) echo "usage: $(basename "$0") [--dev]" >&2; exit 2 ;;
esac

echo "==> Building release Rust binaries"
(
    cd "$REPO_ROOT/tugrust"
    if [ "$DEV" = 1 ]; then export CARGO_INCREMENTAL=1; fi
    cargo build --release -p tugcast -p tugtool -p tugexec -p tugrelaunch
)

echo "==> Compiling tugcode (bun)"
# tugcode carries its own package.json/bun.lock; its imports (the agent SDK,
# tiktoken) resolve from tugcode/node_modules. Installing here rather than
# assuming a populated tree is what lets this run on a clean checkout.
(cd "$REPO_ROOT/tugcode" && bun install --frozen-lockfile)
bash "$SCRIPT_DIR/compile-tugcode.sh" "$REPO_ROOT/tugrust/target/release/tugcode"

echo "==> Building tugdeck static assets"
(cd "$REPO_ROOT/tugdeck" && bun install --frozen-lockfile)

# The stamp names everything the vite build reads — tugdeck itself, the
# @tugproto sources, the capabilities snapshot, and the bun that runs it —
# plus the dist/index.html it produced, whose hashed asset names change with
# the output. Recording the output too is what keeps a dist/ rewritten by
# some other build (build-app's) from passing for the stamped one.
STAMP="$REPO_ROOT/tugrust/target/release/tugdeck-dist.stamp"
tugdeck_stamp() {
    (
        cd "$REPO_ROOT"
        bun --version
        git ls-files -z -co --exclude-standard -- tugdeck tugproto capabilities \
            | { xargs -0 shasum -a 256 2>/dev/null || true; }
        shasum -a 256 tugdeck/dist/index.html 2>/dev/null || echo "no dist"
    ) | shasum -a 256 | cut -d' ' -f1
}
if [ "$DEV" = 1 ] && [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$(tugdeck_stamp)" ]; then
    echo "    tugdeck unchanged since the last build — reusing dist/"
else
    (cd "$REPO_ROOT/tugdeck" && bun run build)
    if [ "$DEV" = 1 ]; then
        mkdir -p "$(dirname "$STAMP")"
        tugdeck_stamp > "$STAMP"
    else
        rm -f "$STAMP"
    fi
fi
