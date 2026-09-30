#!/bin/bash
set -euo pipefail

# xcodebuild-quiet.sh — run xcodebuild and report only what a human needs.
#
# xcodebuild writes ~800 lines for a build that has nothing to say: a
# phase header plus the full indented invocation for every SwiftDriver /
# SwiftCompile / CompileC / Ld / CodeSign step. None of it is signal
# unless something failed, and all of it buries the warnings that are.
#
# So: capture the stream, and on success print only the lines that carry
# information — warnings, errors, linker complaints, and the BUILD
# banner. On failure, print the whole log, because that is exactly when
# every one of those 800 lines might matter.
#
# TUG_BUILD_STREAM=1 passes the raw stream through untouched, the same
# escape hatch TUG_APPTEST_STREAM gives the app-test harness.
#
# Usage:
#   xcodebuild-quiet.sh <label> <xcodebuild args...>
#
# <label> names the build in the summary line (e.g. "Tug-debug.app").

if [ "$#" -lt 2 ]; then
    echo "usage: $(basename "$0") <label> <xcodebuild args...>" >&2
    exit 2
fi

LABEL="$1"
shift

if [ -n "${TUG_BUILD_STREAM:-}" ]; then
    exec xcodebuild "$@"
fi

LOG="$(mktemp -t tugapp-xcode.XXXX.log)"
trap 'rm -f "$LOG"' EXIT

START=$SECONDS
# The status is captured from xcodebuild itself, not from inside an `if !`
# branch: `! cmd` *is* the negation, so `$?` there is the inverted 0 and the
# failure exits 0 — which lets a BUILD FAILED sail on into signing.
status=0
xcodebuild "$@" > "$LOG" 2>&1 || status=$?
if [ "$status" -ne 0 ]; then
    echo "==> xcodebuild failed for ${LABEL} (status ${status}) — full log:" >&2
    cat "$LOG" >&2
    exit "$status"
fi
ELAPSED=$((SECONDS - START))

# Surface diagnostics even on a successful build: a warning that only
# ever appears inside a suppressed log is a warning nobody will fix.
#
# The one exclusion is appintentsmetadataprocessor announcing it found no
# AppIntents.framework dependency. Tug has no App Intents and is not
# getting any, so that line is a fact about the target's design rather
# than a defect — and it prints on every build, which is exactly how a
# diagnostics section trains people to stop reading it.
DIAGS="$(grep -E 'warning:|error:|^ld: |^clang: |^Undefined' "$LOG" \
    | grep -v 'appintentsmetadataprocessor.*No AppIntents.framework dependency found' \
    || true)"
if [ -n "$DIAGS" ]; then
    printf '%s\n' "$DIAGS"
    COUNT="$(printf '%s\n' "$DIAGS" | grep -c 'warning:' || true)"
    [ "$COUNT" = 1 ] && NOUN=warning || NOUN=warnings
    echo "    ${LABEL}: built in ${ELAPSED}s (${COUNT} ${NOUN})"
else
    echo "    ${LABEL}: built in ${ELAPSED}s"
fi
