#!/usr/bin/env bash
# run-capped.sh — run one app-test file's command, and stop it if it outlives its cap.
#
# Usage: run-capped.sh <cap-secs> <marker-file> <command> [args…]
#
# The command's stdout and stderr are this script's, so the recipe redirects or tees them
# exactly as it would the bare command. Under the cap the exit status is the command's. Past
# it the command's whole process group — every descendant, the app it launched included —
# gets SIGTERM, then SIGKILL after a grace, the marker file is created, and the exit status
# is 124 — the marker, not the status, is what the recipe reads, so a command that happens
# to exit 124 is never mistaken for a wedge.
#
# The cap arithmetic is wedge-cap.ts's; this only enforces it. It is a script rather than
# recipe text so the kill path has a test that does not need a wedged app to exercise it.
set -u

cap="$1"
marker="$2"
shift 2
grace="${TUG_APPTEST_WEDGE_GRACE:-5}"

# The command's group is outside the terminal's foreground group, so a ^C reaching this
# script is passed on by hand rather than leaving the file running behind the recipe.
# A hangup is passed on the same way: the terminal closing signals only its foreground
# group, which the command is no longer in.
# The watchdog goes with it: left behind, it would wake at the cap and signal a group id
# that may by then belong to something else.
# The traps are set before the launch, so no signal can land between the command starting
# and the script being ready to pass it on.
child=""
dog=""
# shellcheck disable=SC2317,SC2329  # invoked by the traps below
stop() {
    [ -n "$child" ] && kill -TERM -- "-$child" 2>/dev/null
    [ -n "$dog" ] && kill "$dog" 2>/dev/null
}
trap 'stop; exit 130' INT TERM
trap 'stop; exit 129' HUP

# Job control, for this one launch, puts the command in a process group of its own with
# its pid as the group id, so one signal to `-$child` reaches every generation beneath it.
# macOS ships no setsid; `set -m` is the portable way to a group. Stdin is /dev/null, as it
# is for any background command when job control is off.
set -m
"$@" < /dev/null &
child=$!
set +m

(
    # Every wait here is on a backgrounded sleep, which a trapped signal interrupts at
    # once; a foreground sleep would hold the trap — and the script — for its whole length.
    nap=""
    trap 'kill "$nap" 2>/dev/null; exit 0' TERM
    sleep "$cap" & nap=$!
    wait "$nap"
    kill -0 "$child" 2>/dev/null || exit 0
    : > "$marker"
    kill -TERM -- "-$child" 2>/dev/null
    sleep "$grace" & nap=$!
    wait "$nap"
    kill -KILL -- "-$child" 2>/dev/null
    exit 0
) &
dog=$!

wait "$child"
rc=$?
kill "$dog" 2>/dev/null
wait "$dog" 2>/dev/null
[ -e "$marker" ] && exit 124
exit "$rc"
