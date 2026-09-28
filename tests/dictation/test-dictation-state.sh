#!/bin/bash
set -euo pipefail

# test-dictation-state.sh — unit test for dictation's event model and reducer.
#
# Concatenates the canonical Swift source (tugapp/Sources/DictationState.swift)
# with the test driver (tests/dictation/test-driver.swift) and runs the pair
# through the Swift interpreter via `swift -`. This avoids adding an XCTest
# bundle to the Xcode project while still testing the *actual* reducer the
# app builds against — no duplicated state machine.
#
# That idiom only works for a source with no app-type dependencies, which is
# why DictationState.swift is Foundation-only and the AVAudioEngine and
# recogniser glue lives apart from it in DictationEngine.swift.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

STATE_SRC="$REPO_ROOT/tugapp/Sources/DictationState.swift"
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
