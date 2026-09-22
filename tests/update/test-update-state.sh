#!/bin/bash
set -euo pipefail

# test-update-state.sh — unit test for the update flow's reducer.
#
# Concatenates the canonical Swift source (tugapp/Sources/UpdateState.swift)
# with the test driver (tests/update/test-driver.swift) and runs the pair
# through the Swift interpreter via `swift -`. This avoids adding an XCTest
# bundle to the Xcode project while still testing the *actual* reducer the
# app builds against — no duplicated state machine.
#
# That idiom only works for a source with no app-type dependencies, which is
# why UpdateState.swift is Foundation-only and the Sparkle glue lives apart
# from it in TugUpdateDriver.swift.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

STATE_SRC="$REPO_ROOT/tugapp/Sources/UpdateState.swift"
DRIVER="$SCRIPT_DIR/test-driver.swift"

if [ ! -f "$STATE_SRC" ]; then
    echo "error: $STATE_SRC not found" >&2
    exit 1
fi
if [ ! -f "$DRIVER" ]; then
    echo "error: $DRIVER not found" >&2
    exit 1
fi

cat "$STATE_SRC" "$DRIVER" | swift -
