#!/usr/bin/env bash
#
# perf-resize-profile — measure what the deck's renderer does per frame.
#
# Two modes:
#
#   resize (default)  drive a paced window resize while sampling
#   idle              sample a still window
#
# The verdict is main-thread busy share plus the sample counts of the
# frames that matter for motion residency: keyframe blending inside
# style resolution, and the compositing-requirements walk it triggers.
# An animation that cannot be accelerated shows up as nonzero
# applyKeyframeEffects at steady state.
#
# Usage: perf-resize-profile.sh <bundle-id> [idle|resize] [seconds]
#
# The bundle id selects which app's renderer to sample: WebContent runs
# as a launchd-owned XPC service, so it carries no parent link back to
# the app. What it does carry is the app's WebKit cache directory
# (~/Library/Caches/<bundle-id>/WebKit), open for the process's whole
# life — that is the identifying handle this script matches on.

set -euo pipefail

BUNDLE_ID="${1:-}"
MODE="${2:-resize}"
SECONDS_TO_SAMPLE="${3:-6}"

if [ -z "$BUNDLE_ID" ]; then
    echo "usage: perf-resize-profile.sh <bundle-id> [idle|resize] [seconds]" >&2
    exit 2
fi

# ── Find the renderer ────────────────────────────────────────────────

WEBCONTENT_PID=""
for pid in $(pgrep -f "com.apple.WebKit.WebContent" || true); do
    # No `grep -q` here: it exits on the first match, SIGPIPEs lsof, and
    # `pipefail` would then read the whole probe as "not found".
    HITS="$(lsof -p "$pid" 2>/dev/null | grep -c "Library/Caches/${BUNDLE_ID}/" || true)"
    if [ "$HITS" -gt 0 ]; then
        WEBCONTENT_PID="$pid"
        break
    fi
done

if [ -z "$WEBCONTENT_PID" ]; then
    echo "error: no WebContent process found for bundle id '$BUNDLE_ID'." >&2
    echo "       Is the app running? (just instances)" >&2
    exit 1
fi

OUT="/tmp/perf-resize-profile-${MODE}-$(date +%Y%m%d-%H%M%S).txt"
echo "==> sampling WebContent pid $WEBCONTENT_PID for ${SECONDS_TO_SAMPLE}s (mode: $MODE)"

# ── Drive the resize ─────────────────────────────────────────────────
#
# System Events resizes the frontmost window of the target app in
# small steps so the sample sees many live-resize frames rather than
# one jump. Without accessibility permission this fails; the sample
# still runs, so the run degrades to idle mode with a warning.

# macOS stops delivering frames to a fully occluded window, and WebKit
# throttles the renderer with it — a sample taken while the target sits
# behind the terminal reads a flat 0% no matter how bad the page is.
# Raising the window first is what makes the number mean anything.
osascript -e "tell application \"System Events\" to set frontmost of (first process whose bundle identifier is \"$BUNDLE_ID\") to true" >/dev/null 2>&1 ||
    echo "[warn] could not raise the target window — is accessibility granted to this terminal?" >&2
sleep 1

DRIVE_LOG="$(mktemp -t perf-resize-drive)"

# One AX `set size` round-trip costs roughly 30ms on top of the delay,
# so ~9 steps fill a second. Half the steps shrink, half restore, and
# the sample window sees live-resize frames end to end.
HALF_STEPS=$(( (SECONDS_TO_SAMPLE * 9) / 2 ))
[ "$HALF_STEPS" -lt 4 ] && HALF_STEPS=4

drive_resize() {
    osascript <<EOF > "$DRIVE_LOG" 2>&1 || echo "drive failed (accessibility granted to this terminal?)" >> "$DRIVE_LOG"
tell application "System Events"
    set procs to (every process whose bundle identifier is "$BUNDLE_ID")
    if (count of procs) is 0 then error "no process for $BUNDLE_ID"
    set p to item 1 of procs
    set w to window 1 of p
    set originalSize to size of w
    set baseW to item 1 of originalSize
    set baseH to item 2 of originalSize
    repeat with i from 1 to $HALF_STEPS
        set size of w to {baseW - (i * 8), baseH - (i * 4)}
        delay 0.05
    end repeat
    repeat with i from 1 to $HALF_STEPS
        set size of w to {baseW - (($HALF_STEPS - i) * 8), baseH - (($HALF_STEPS - i) * 4)}
        delay 0.05
    end repeat
    set size of w to originalSize
    return "drove " & ($HALF_STEPS * 2) & " steps from " & baseW & "x" & baseH
end tell
EOF
}

if [ "$MODE" = "resize" ]; then
    drive_resize &
    RESIZE_JOB=$!
fi

bash "$(dirname "$0")/../tugrust/scripts/sample-reported.sh" perf-resize-profile "$WEBCONTENT_PID" "$SECONDS_TO_SAMPLE" "$OUT" || {
    echo "error: sample failed (pid $WEBCONTENT_PID gone?)" >&2
    exit 1
}

if [ "$MODE" = "resize" ]; then
    wait "${RESIZE_JOB}" 2>/dev/null || true
fi

# ── Verdict ──────────────────────────────────────────────────────────
#
# `sample` prints one call-graph node per line: an indent prefix, the
# sample count, then the frame. Counting a frame therefore means summing
# its OUTERMOST occurrences — a recursive walk like
# computeCompositingRequirements appears at many depths of one stack,
# and summing every line would multiply-count the same samples.

MAIN_BLOCK="$(mktemp -t perf-resize-main)"
trap 'rm -f "$MAIN_BLOCK" "$DRIVE_LOG"' EXIT
awk '
    /DispatchQueue_1: com.apple.main-thread/ { inmain = 1 }
    inmain && /^ *[0-9]+ Thread_/ && !/main-thread/ { exit }
    inmain { print }
' "$OUT" > "$MAIN_BLOCK"

MAIN_TOTAL="$(awk '/DispatchQueue_1: com.apple.main-thread/{print $1; exit}' "$MAIN_BLOCK")"
: "${MAIN_TOTAL:=0}"

# Samples parked in the run loop's mach_msg wait are the thread doing
# nothing at all — everything else is work. Read this with care in
# resize mode: live resize is synchronised with the UI process, so a
# renderer BLOCKED waiting on the window server also parks in mach_msg
# and reads as idle. Busy share therefore understates a resize; the
# per-frame counts are the comparable signal across runs.
IDLE="$(awk '
    /mach_msg2_trap/ {
        match($0, /[0-9]+/); n = substr($0, RSTART, RLENGTH); total += n
    }
    END { print total + 0 }
' "$MAIN_BLOCK")"

frame_samples() {
    awk -v want="$1" '
        {
            if (match($0, /[0-9]+ /) == 0) next
            indent = RSTART
            n = $0
            sub(/^[^0-9]*/, "", n)
            sub(/ .*/, "", n)
            if (open > 0 && indent <= openIndent) open = 0
            if (index($0, want) > 0 && open == 0) {
                total += n; open = 1; openIndent = indent
            }
        }
        END { print total + 0 }
    ' "$MAIN_BLOCK"
}

UPDATE_RENDERING="$(frame_samples 'updateRendering')"
COMPOSITING="$(frame_samples 'updateCompositingLayersAfterStyleChange')"
OVERLAP="$(frame_samples 'computeCompositingRequirements')"
RESOLVE_STYLE="$(frame_samples 'TreeResolver::resolve')"
KEYFRAMES="$(frame_samples 'applyKeyframeEffects')"

BUSY=$(( MAIN_TOTAL - IDLE ))
if [ "$MAIN_TOTAL" -gt 0 ]; then
    BUSY_PCT="$(awk -v b="$BUSY" -v t="$MAIN_TOTAL" 'BEGIN { printf "%.1f", (b / t) * 100 }')"
else
    BUSY_PCT="0.0"
fi

echo
echo "── perf-resize-profile verdict ──────────────────────────────"
echo "bundle:            $BUNDLE_ID"
echo "WebContent pid:    $WEBCONTENT_PID"
echo "mode:              $MODE (${SECONDS_TO_SAMPLE}s)"
if [ "$MODE" = "resize" ]; then
    echo "resize drive:      $(tr -d '\n' < "$DRIVE_LOG")"
fi
echo "sample file:       $OUT"
echo
echo "main thread:       $BUSY / $MAIN_TOTAL samples busy (${BUSY_PCT}%)"
echo
echo "samples by frame (outermost occurrences, share of busy):"
frame_row() {
    if [ "$BUSY" -gt 0 ]; then
        share="$(awk -v n="$2" -v b="$BUSY" 'BEGIN { printf "%.0f%%", (n / b) * 100 }')"
    else
        share="—"
    fi
    printf '  %-42s %6s  %s\n' "$1" "$2" "$share"
}
frame_row "updateRendering"                         "$UPDATE_RENDERING"
frame_row "updateCompositingLayersAfterStyleChange" "$COMPOSITING"
frame_row "computeCompositingRequirements"          "$OVERLAP"
frame_row "Style::TreeResolver::resolve"            "$RESOLVE_STYLE"
frame_row "applyKeyframeEffects"                    "$KEYFRAMES"
echo
if [ "$KEYFRAMES" -gt 0 ]; then
    echo "VERDICT: keyframe blending runs on the main thread — at least one"
    echo "         long-running animation is not compositor-resident."
else
    echo "VERDICT: no keyframe blending in the frame path."
fi
echo "─────────────────────────────────────────────────────────────"
