#!/usr/bin/env bash
# tugtool-recorder.sh — print the tugtool a recipe records its run through, or nothing.
#
# The worktree's own debug build first, else PATH's, and either only when its
# `test run` knows `--unit` (an app build that predates the flag cannot record
# a lint run's checks). An empty answer means the recipe runs its command bare
# and says it is unrecorded.
#
# It builds nothing, unlike tugtool-bin.sh, which builds this checkout's
# tugtool for a recipe that must run its verbs: a recorder is optional.
#
# Usage: TUGTOOL_BIN="$(bash tugrust/scripts/tugtool-recorder.sh)"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
bin="$root/tugrust/target/debug/tugtool"
[ -x "$bin" ] || bin="$(command -v tugtool 2>/dev/null || true)"
[ -n "$bin" ] || exit 0
help="$("$bin" test run --help 2>/dev/null || true)"
case "$help" in
    *--unit*) printf '%s\n' "$bin" ;;
esac
exit 0
