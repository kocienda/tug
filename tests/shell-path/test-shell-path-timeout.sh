#!/bin/bash
set -euo pipefail

# test-shell-path-timeout.sh — unit test for ShellPathResolver.
#
# Concatenates the canonical Swift source
# (tugapp/Sources/ShellPathResolver.swift) with the test driver
# (tests/shell-path/test-driver.swift) and runs the pair through the Swift
# interpreter via `swift -`. Same idiom as tests/build-info: no XCTest
# bundle in the Xcode project, and the test runs against the *actual*
# implementation the app builds against.
#
# The resolver is Foundation-only for exactly this reason — it takes its
# deadline, its fallback and its warn sink as arguments, so the driver can
# point it at a fake shell that sleeps past the bound and watch what it does
# about it.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

RESOLVER_SRC="$REPO_ROOT/tugapp/Sources/ShellPathResolver.swift"
DRIVER="$SCRIPT_DIR/test-driver.swift"

if [ ! -f "$RESOLVER_SRC" ]; then
    echo "error: $RESOLVER_SRC not found" >&2
    exit 1
fi
if [ ! -f "$DRIVER" ]; then
    echo "error: $DRIVER not found" >&2
    exit 1
fi

cat "$RESOLVER_SRC" "$DRIVER" | swift -
