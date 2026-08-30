#!/usr/bin/env bash
# Compile the release "inputs" every release bundle is made of: the optimized
# Rust binaries, the bun-compiled tugcode/tugpulse, and the tugdeck static
# assets. Both `just app-release` (the developer launch bundle) and
# build-app.sh (the distribution bundle) get their compiled inputs from here,
# so the set of binaries and the build flags can't drift between the two paths.
#
# Populates tugrust/target/release/{tugcast,tug,tugexec,
# tugrelaunch,tugcode,tugpulse} and tugdeck/dist/. The Tug Xcode target's copy
# phase reads these binaries from target/$CONFIGURATION and errors if any are
# missing, so this script must build the full set.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "==> Building release Rust binaries"
(cd "$REPO_ROOT/tugrust" && cargo build --release -p tugcast -p tugtool -p tugexec -p tugrelaunch)

echo "==> Compiling tugcode + tugpulse (bun)"
# tugcode carries its own package.json/bun.lock; its imports (the agent SDK,
# tiktoken) resolve from tugcode/node_modules. Installing here rather than
# assuming a populated tree is what lets this run on a clean checkout.
(cd "$REPO_ROOT/tugcode" && bun install --frozen-lockfile)
(
    cd "$REPO_ROOT"
    bun build --compile tugcode/src/main.ts --outfile tugrust/target/release/tugcode
    bun build --compile tugcode/src/pulse/main-pulse.ts --outfile tugrust/target/release/tugpulse
)

echo "==> Building tugdeck static assets"
(cd "$REPO_ROOT/tugdeck" && bun install --frozen-lockfile && bun run build)
