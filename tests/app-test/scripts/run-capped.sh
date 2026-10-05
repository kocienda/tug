#!/usr/bin/env bash
# run-capped.sh — run one app-test file's command, and stop it if it outlives its cap.
#
# Usage: run-capped.sh <cap-secs> <marker-file> <command> [args…]
#
# The command's stdout and stderr are this script's, so the recipe redirects or tees them
# exactly as it would the bare command. Under the cap the exit status is the command's. Past
# it the command (and any child it started) gets SIGTERM, then SIGKILL after a grace, the
# marker file is created, and the exit status is 124 — the marker, not the status, is what
# the recipe reads, so a command that happens to exit 124 is never mistaken for a wedge.
#
# The cap arithmetic is wedge-cap.ts's; this only enforces it. It is a script rather than
# recipe text so the kill path has a test that does not need a wedged app to exercise it.
set -u

cap="$1"
marker="$2"
shift 2
grace="${TUG_APPTEST_WEDGE_GRACE:-5}"

"$@" &
child=$!

# A background command ignores SIGINT in a non-interactive shell, so a ^C reaching this
# script is passed on by hand rather than leaving the file running behind the recipe.
trap 'kill -TERM $(pgrep -P "$child" 2>/dev/null) "$child" 2>/dev/null; exit 130' INT TERM

(
    # Every wait here is on a backgrounded sleep, which a trapped signal interrupts at
    # once; a foreground sleep would hold the trap — and the script — for its whole length.
    nap=""
    trap 'kill "$nap" 2>/dev/null; exit 0' TERM
    sleep "$cap" & nap=$!
    wait "$nap"
    kill -0 "$child" 2>/dev/null || exit 0
    : > "$marker"
    kids="$(pgrep -P "$child" 2>/dev/null | tr '\n' ' ')"
    kill -TERM $kids "$child" 2>/dev/null
    sleep "$grace" & nap=$!
    wait "$nap"
    kill -KILL $kids "$child" 2>/dev/null
    exit 0
) &
dog=$!

wait "$child"
rc=$?
kill "$dog" 2>/dev/null
wait "$dog" 2>/dev/null
[ -e "$marker" ] && exit 124
exit "$rc"
