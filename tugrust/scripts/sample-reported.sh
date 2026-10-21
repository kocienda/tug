#!/usr/bin/env bash
#
# sample-reported.sh — `/usr/bin/sample`, with its seconds on the Bash block.
#
#   bash tugrust/scripts/sample-reported.sh <label> <pid> <seconds> <out-file>
#
# A sample runs for a fixed number of seconds and prints nothing until it is
# done, so a call that runs one sits dark for its whole length. This runs the
# sample and, once a second while it does, hands `tugtool report count` how
# many of its seconds have passed — rung 4, a count with a known total — so
# the block draws a bar that fills as the sample does. Exits with the
# sample's own status; its output goes to <out-file>, as `sample -file` puts
# it, and nothing else is printed.
#
# The workspace's own tugtool is used, else PATH's; with neither the sample
# still runs and only the report is missing. Reporting is telemetry: it never
# prints and never fails the sample.
set -uo pipefail

if [ $# -ne 4 ]; then
    sed -n '5p' "$0" | sed 's/^# //' >&2
    exit 2
fi
label="$1"
pid="$2"
seconds="$3"
out="$4"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TUGTOOL_BIN="$REPO_ROOT/tugrust/target/debug/tugtool"
[ -x "$TUGTOOL_BIN" ] || TUGTOOL_BIN="$(command -v tugtool 2>/dev/null || true)"

report() {
    [ -n "$TUGTOOL_BIN" ] || return 0
    "$TUGTOOL_BIN" report count --label "$label" --unit second \
        --done "$1" --total "$seconds" "$2" >/dev/null 2>&1 || true
}

/usr/bin/sample "$pid" "$seconds" -file "$out" >/dev/null 2>&1 &
sampler=$!
elapsed=0
report 0 "sampling pid $pid · 0/${seconds}s"
while kill -0 "$sampler" 2>/dev/null; do
    sleep 1
    elapsed=$((elapsed + 1))
    [ "$elapsed" -le "$seconds" ] && report "$elapsed" "sampling pid $pid · $elapsed/${seconds}s"
done
wait "$sampler"
status=$?
if [ "$status" -eq 0 ]; then
    report "$seconds" "sampled pid $pid · ${seconds}s"
fi
exit "$status"
