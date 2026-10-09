#!/bin/bash
set -euo pipefail

# test-bridge-path-guard.sh — unit test for BridgePathGuard.
#
# Concatenates the canonical Swift source (tugapp/Sources/BridgePathGuard.swift)
# with the test driver (tests/bridge-path-guard/test-driver.swift) and runs the
# pair through the Swift interpreter via `swift -`, so the test exercises the
# guard the app's openPath/trashPath/restorePath handlers build against.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

GUARD_SRC="$REPO_ROOT/tugapp/Sources/BridgePathGuard.swift"
DRIVER="$SCRIPT_DIR/test-driver.swift"

if [ ! -f "$GUARD_SRC" ]; then
    echo "error: $GUARD_SRC not found" >&2
    exit 1
fi
if [ ! -f "$DRIVER" ]; then
    echo "error: $DRIVER not found" >&2
    exit 1
fi

cat "$GUARD_SRC" "$DRIVER" | swift -
