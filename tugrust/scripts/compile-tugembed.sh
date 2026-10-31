#!/usr/bin/env bash
# compile-tugembed.sh — compile the on-device embedding helper with swiftc.
#
# Usage:
#   compile-tugembed.sh <OUTFILE>
#
# Every tugembed compile goes through here: the `build` and `build-app` recipes,
# build-release-inputs.sh, and its protocol test. It is the one helper in the
# bundle that cargo does not build. An output newer than its source is left
# alone, which is the incrementality cargo gives the others.
#
# The target pins the app's LSMinimumSystemVersion, so a binary built on a newer
# macOS still runs on every machine Tug does.

set -euo pipefail

if [ "$#" -ne 1 ]; then
    echo "usage: $(basename "$0") <OUTFILE>" >&2
    exit 2
fi

OUTFILE="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SOURCE="$REPO_ROOT/tugapp/tugembed/main.swift"
MIN_MACOS="$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$REPO_ROOT/tugapp/Info.plist")"

if [ "$OUTFILE" -nt "$SOURCE" ]; then
    exit 0
fi

mkdir -p "$(dirname "$OUTFILE")"
swiftc -O -swift-version 5 -target "$(uname -m)-apple-macos$MIN_MACOS" \
    -framework NaturalLanguage -o "$OUTFILE" "$SOURCE"
