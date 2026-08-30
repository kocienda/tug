#!/usr/bin/env bash
# Quit a running Tug.app by bundle ID and wait for it to actually
# exit, then send a final teardown to the matching tugcast in the
# registry as a safety net.
#
# Used by `just app-dev`, `just app-prod`, `just launch-dev`,
# `just launch-prod`, `just stop-dev`, `just stop-prod` so each
# (profile, branch) launch starts from a clean slate — no stale GUI
# process kept alive by macOS LaunchServices when `open` is called.
#
# Usage:
#   quit-tug-bundle.sh <bundle-id> <instance-id> [--timeout SECONDS]
#
# The Tug.app process responds to `osascript ... quit` by invoking
# its `applicationShouldTerminate` handler, which signals tugcast
# over the control socket and kills its process group. The registry
# `instance stop` call is the belt-and-suspenders for the case where
# the GUI process is unresponsive (panic, hung WebView, etc.).

set -uo pipefail

BUNDLE_ID="${1:-}"
INSTANCE_ID="${2:-}"
TIMEOUT="${3:-5}"

if [ -z "$BUNDLE_ID" ] || [ -z "$INSTANCE_ID" ]; then
    echo "usage: $0 <bundle-id> <instance-id> [timeout-seconds]" >&2
    exit 2
fi

# 1. Ask the GUI app to quit. AppleScript's `quit` sends a graceful
#    NSApp shutdown via Apple Events; the app's
#    `applicationShouldTerminate` runs and the bundle exits when
#    teardown completes. If the app isn't running, osascript returns
#    a non-zero error which we suppress.
osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true

# 2. Poll until no process for this bundle remains. `pgrep -f` looks
#    in each process's full command line; Tug.app processes carry
#    the bundle path there. We match the bundle ID inside the path
#    (e.g. "...Tug.app/Contents/MacOS/Tug" + the bundle id appears
#    in `lsappinfo`-style metadata that pgrep doesn't see, so we
#    use `lsappinfo find` which IS reliable per bundle id).
deadline=$(( $(date +%s) + TIMEOUT ))
while [ "$(date +%s)" -lt "$deadline" ]; do
    if ! lsappinfo info -only pid "$BUNDLE_ID" 2>/dev/null | grep -q '"pid"='; then
        break
    fi
    sleep 0.1
done

# 3. Belt-and-suspenders: if a registry entry still exists for this
#    instance ID, send a direct SIGTERM via tug. Either tugcast
#    is the straggler (GUI died before reaching ProcessManager.stop),
#    or `tugtool host instance stop` is a no-op (no registry entry).
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
TUGTOOL="$REPO_ROOT/tugrust/target/debug/tugtool"
if [ -x "$TUGTOOL" ]; then
    "$TUGTOOL" host instance stop "$INSTANCE_ID" --timeout "$TIMEOUT" >/dev/null 2>&1 || true
fi
