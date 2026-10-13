#!/usr/bin/env bash
# compile-tugcode.sh — compile the tugcode bridge to a standalone binary.
#
# Usage:
#   compile-tugcode.sh <OUTFILE>
#
# Runs `bun build --compile tugcode/src/main.ts --outfile <OUTFILE>`. Every
# tugcode compile goes through here: the `build` and `build-app` recipes,
# build-release-inputs.sh, and tugcast's build.rs.
#
# Why a script rather than the bare command: `bun build --compile` stages
# the executable in a hidden temp file in the WORKING DIRECTORY, named
# `.<hash>-00000000.bun-build`, starting from a clone of the bun binary
# itself. When that bun binary is read-only, as every Homebrew install is
# (Cellar files are 0555), bun cannot write into the clone, falls back to
# another route, and abandons the clone: a 60 MB read-only copy of bun is
# left in the working directory on every compile. A writable bun (the
# bun.sh installer's) reuses the clone and leaves nothing.
#
# So the compile runs from a private scratch directory that is deleted
# afterwards, taking any abandoned clone with it, and a concurrent compile
# never sees another's in-flight temp file. The scratch directory sits in
# the repo root, not /tmp, because bun writes each bundled module's path
# into the binary as a comment relative to the working directory: from
# the repo root they read `../tugcode/...`, where from /tmp they would
# carry the builder's home directory into a shipped binary. The working
# directory changes nothing else in the bundle.

set -euo pipefail

if [ "$#" -ne 1 ]; then
    echo "usage: $(basename "$0") <OUTFILE>" >&2
    exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# The compile runs elsewhere, so resolve a relative OUTFILE against the
# caller's working directory first.
OUTFILE="$1"
case "$OUTFILE" in
    /*) ;;
    *) OUTFILE="$PWD/$OUTFILE" ;;
esac

SCRATCH="$(mktemp -d "$REPO_ROOT/.bun-compile.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

cd "$SCRATCH"
bun build --compile ../tugcode/src/main.ts --outfile "$OUTFILE"
