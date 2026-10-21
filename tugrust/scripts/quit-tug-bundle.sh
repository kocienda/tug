#!/usr/bin/env bash
# Quit a running Tug instance and wait for it to exit.
#
# Used by `just app-debug`, `just app-release`, `just launch-debug`,
# `just launch-release` and the stop recipes so each (profile, branch)
# launch starts from a clean slate — no stale GUI process kept alive by
# macOS LaunchServices when `open` is called.
#
# Usage:
#   quit-tug-bundle.sh <bundle-id> <instance-id> [timeout-seconds]
#
# The quit is `tugtool host instance quit`: the `quit` Apple Event, sent
# to the host app's pid as the OS sends it, which runs the app's
# `applicationShouldTerminate` — the deck's termination pipeline, then
# tugcast's teardown. It never signals the app, because a signal skips the
# pipeline and loses whatever the deck had not saved. A quit that gets no
# reply within seconds writes its evidence (a sample, the host's run-loop
# state, the system log) under the instance's `stalls/` directory, and a
# stalled or refused quit exits non-zero naming it. An instance that is
# not running is already quit.
#
# The bundle id is the last check. If a process still holds it once the
# quit is done, this exits 1: a recipe that carried on would re-sign the
# bundle under the live process and then `open` it, which only activates
# the old instance — a build that looks like it launched and did not. Pass
# an empty bundle id to skip the check.

set -uo pipefail

BUNDLE_ID="${1-}"
INSTANCE_ID="${2:-}"
# The wait covers a late pickup of the event plus the app's own 12 s
# termination-pipeline deadline.
TIMEOUT="${3:-90}"

if [ -z "$INSTANCE_ID" ]; then
    echo "usage: $0 <bundle-id> <instance-id> [timeout-seconds]" >&2
    exit 2
fi

TUGTOOL="$(bash "$(dirname "$0")/tugtool-bin.sh")" || exit 1

if ! "$TUGTOOL" host instance quit "$INSTANCE_ID" --timeout "$TIMEOUT"; then
    echo "error: $INSTANCE_ID did not quit; the reason and any stall evidence are above." >&2
    echo "       Nothing was signalled. 'tugtool host instance quit $INSTANCE_ID --force' kills it, and loses what the deck had not saved." >&2
    exit 1
fi

# `lsappinfo find` prints the app's ASN when a process holds the bundle
# id and nothing when none does. LaunchServices lags the process's exit by
# a moment, so it gets a few seconds to catch up before this counts as a
# second app.
held() {
    [ -n "$BUNDLE_ID" ] && [ -n "$(lsappinfo find "bundleid=$BUNDLE_ID" 2>/dev/null)" ]
}
grace=$(( $(date +%s) + 5 ))
while held && [ "$(date +%s)" -lt "$grace" ]; do
    sleep 0.1
done
if held; then
    echo "error: a process still holds $BUNDLE_ID after $INSTANCE_ID quit — most likely an app the instance registry does not name. Quit it and run the recipe again." >&2
    exit 1
fi