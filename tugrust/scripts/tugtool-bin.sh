#!/usr/bin/env bash
# Print the path of this checkout's debug tugtool, built from the source as
# it stands.
#
# The build always runs. A binary that merely exists is no evidence it
# matches the source: a checkout that pulled in a new verb still holds the
# tugtool built before it, and a recipe that ran that one would call a verb
# it does not have. Cargo's incremental build makes a current binary a
# sub-second no-op, the same trade `app-release` makes for `tugbank`. Bare
# `tugtool` on PATH is not considered: it is the installed app's, and a
# recipe exercising this checkout wants this checkout's verbs.
#
# Usage: tugtool-bin.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# Cargo's progress goes to stderr; stdout carries only the path.
if ! (cd "$REPO_ROOT/tugrust" && cargo build -p tugtool >&2); then
    echo "error: could not build tugtool" >&2
    exit 1
fi
echo "$REPO_ROOT/tugrust/target/debug/tugtool"
