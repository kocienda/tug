#!/usr/bin/env bash
# Quit a running Tug.app by bundle ID and wait for it to actually
# exit, then send a final teardown to the matching tugcast in the
# registry as a safety net.
#
# Used by `just app-debug`, `just app-release`, `just launch-debug`,
# `just launch-release` and the stop recipes so each (profile, branch)
# launch starts from a clean slate — no stale GUI process kept alive by
# macOS LaunchServices when `open` is called.
#
# Usage:
#   quit-tug-bundle.sh <bundle-id> <instance-id> [timeout-seconds]
#
# The Tug.app process responds to `osascript ... quit` by invoking
# its `applicationShouldTerminate` handler, which runs the deck's
# termination pipeline (bounded at 12 s), signals tugcast over the
# control socket and kills its process group. The registry
# `instance stop` call is the belt-and-suspenders for the case where
# the GUI process is unresponsive (panic, hung WebView, etc.).
#
# If the GUI is still running when this script is done, it exits 1
# with the reason. A recipe that carried on would re-sign the bundle
# under the live process and then `open` it, which only activates the
# old instance — a build that looks like it launched and did not.

set -uo pipefail

BUNDLE_ID="${1:-}"
INSTANCE_ID="${2:-}"
# Longer than the app's own 12 s termination-pipeline deadline, so a
# quit that is merely slow is waited out rather than reported as stuck.
TIMEOUT="${3:-20}"

if [ -z "$BUNDLE_ID" ] || [ -z "$INSTANCE_ID" ]; then
    echo "usage: $0 <bundle-id> <instance-id> [timeout-seconds]" >&2
    exit 2
fi

running() {
    lsappinfo info -only pid "$BUNDLE_ID" 2>/dev/null | grep -q '"pid"='
}

# 1. Ask the GUI app to quit. AppleScript's `quit` sends a graceful
#    NSApp shutdown via Apple Events; the app's
#    `applicationShouldTerminate` runs and the bundle exits when
#    teardown completes. Only when the app is running: an Apple Event
#    to an app that isn't would launch it. The error is kept, not
#    discarded — it is the only account of a quit that never arrived
#    (most often -1743, the terminal lacking Automation permission
#    for Tug in System Settings › Privacy & Security › Automation).
QUIT_ERROR=""
if running; then
    QUIT_ERROR="$(osascript -e "tell application id \"$BUNDLE_ID\" to quit" 2>&1 >/dev/null)" || true
fi

# 2. Poll until no process for this bundle remains. `lsappinfo find`
#    is reliable per bundle id where `pgrep -f` is not.
deadline=$(( $(date +%s) + TIMEOUT ))
while [ "$(date +%s)" -lt "$deadline" ] && running; do
    sleep 0.1
done

# 3. Belt-and-suspenders: if a registry entry still exists for this
#    instance ID, send a direct SIGTERM via tugtool. Either tugcast
#    is the straggler (GUI died before reaching ProcessManager.stop),
#    or `tugtool host instance stop` is a no-op (no registry entry).
#    `app-release` builds tugtool only in release, so take whichever
#    build the checkout has.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
TUGTOOL=""
for candidate in "$REPO_ROOT/tugrust/target/debug/tugtool" "$REPO_ROOT/tugrust/target/release/tugtool"; do
    if [ -x "$candidate" ]; then
        TUGTOOL="$candidate"
        break
    fi
done
if [ -n "$TUGTOOL" ]; then
    "$TUGTOOL" host instance stop "$INSTANCE_ID" --timeout 5 >/dev/null 2>&1 || true
fi

if running; then
    echo "error: $INSTANCE_ID ($BUNDLE_ID) is still running after ${TIMEOUT}s; quit it and run the recipe again." >&2
    if [ -n "$QUIT_ERROR" ]; then
        echo "       osascript: $QUIT_ERROR" >&2
    else
        echo "       The quit was delivered and the app did not exit." >&2
    fi
    exit 1
fi
