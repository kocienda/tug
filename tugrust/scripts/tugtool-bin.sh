#!/usr/bin/env bash
# Print the path of this checkout's tugtool, building it when there is none.
#
# `app-release` builds tugtool only in release and `app-debug` only in
# debug, so either may be the one present; when both are, the newer is the
# one that matches the source. Bare `tugtool` on PATH is not considered: it
# is the installed app's, and a recipe exercising this checkout wants this
# checkout's verbs.
#
# Usage: tugtool-bin.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEBUG="$REPO_ROOT/tugrust/target/debug/tugtool"
RELEASE="$REPO_ROOT/tugrust/target/release/tugtool"

if [ -x "$DEBUG" ] && [ -x "$RELEASE" ]; then
    if [ "$RELEASE" -nt "$DEBUG" ]; then echo "$RELEASE"; else echo "$DEBUG"; fi
elif [ -x "$DEBUG" ]; then
    echo "$DEBUG"
elif [ -x "$RELEASE" ]; then
    echo "$RELEASE"
else
    echo "==> No tugtool in this checkout; building it" >&2
    (cd "$REPO_ROOT/tugrust" && cargo build -p tugtool >&2)
    echo "$DEBUG"
fi
