#!/usr/bin/env bash
# Read a running instance's host app without touching it.
#
# Usage:
#   app-inspect.sh log <instance-id> [--last 5m] [--grep PATTERN]
#   app-inspect.sh sample <instance-id> [seconds]
#   app-inspect.sh state <instance-id>
#
# `log` is the system log for the app's pid — AppKit's own lines, the
# Apple Event traffic, anything `NSLog` wrote — which `tugapp.log` does not
# carry. `sample` is a `sample` of the app's main thread and every other.
# `state` is the host's run-loop snapshot from tugcast's `/api/host/state`:
# the current mode, any stretch outside the default mode and the modal
# window holding it, and the Apple Events dispatched in the last minute.
# All three resolve the pid or port from the instance registry, so they
# read the instance named and never another app with the same name.

set -euo pipefail

VERB="${1:-}"
INSTANCE_ID="${2:-}"
if [ -z "$VERB" ] || [ -z "$INSTANCE_ID" ]; then
    sed -n '4,7p' "$0" | sed 's/^# //' >&2
    exit 2
fi
shift 2

TUGTOOL="$(bash "$(dirname "$0")/tugtool-bin.sh")"

# One registry field of the named instance, or a refusal naming it.
field() {
    local value
    value="$("$TUGTOOL" --json host instance list \
        | jq -r --arg id "$INSTANCE_ID" --arg f "$1" \
            '.data.instances[] | select(.instance_id == $id) | .[$f]')"
    if [ -z "$value" ] || [ "$value" = "null" ] || [ "$value" = "0" ]; then
        echo "error: instance '$INSTANCE_ID' is not running (no $1 in the registry); 'just instances' lists those that are." >&2
        exit 1
    fi
    echo "$value"
}

case "$VERB" in
    log)
        LAST="5m"
        GREP=""
        while [ $# -gt 0 ]; do
            case "$1" in
                --last) LAST="$2"; shift 2 ;;
                --grep) GREP="$2"; shift 2 ;;
                *) echo "error: unknown option '$1' (takes --last and --grep)" >&2; exit 2 ;;
            esac
        done
        PID="$(field host_pid)"
        # `/usr/bin/log`, by path: `log` is a shell builtin in some shells.
        if [ -n "$GREP" ]; then
            /usr/bin/log show --last "$LAST" --info --debug --style compact \
                --predicate "processID == $PID" | grep -E -- "$GREP" || true
        else
            /usr/bin/log show --last "$LAST" --info --debug --style compact \
                --predicate "processID == $PID"
        fi
        ;;
    sample)
        SECONDS_TO_SAMPLE="${1:-3}"
        PID="$(field host_pid)"
        OUT="${TMPDIR:-/tmp}/tug-sample-$INSTANCE_ID-$(date +%Y%m%d-%H%M%S).txt"
        /usr/bin/sample "$PID" "$SECONDS_TO_SAMPLE" -file "$OUT" >/dev/null 2>&1
        echo "$OUT"
        ;;
    state)
        PORT="$(field tugcast_port)"
        curl -sS --max-time 4 "http://127.0.0.1:$PORT/api/host/state"
        echo
        ;;
    *)
        echo "error: unknown verb '$VERB' (log, sample or state)" >&2
        exit 2
        ;;
esac
