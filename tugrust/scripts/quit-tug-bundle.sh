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
# The app may not take up the quit event at once — on 2026-10-18 it sat
# ~20 s before AppKit logged "Handling Quit AppleEvent", and the app then
# exited 0.6 s later, just after a 20 s wait here had given up. So the
# wait covers a late pickup plus the app's own 12 s termination-pipeline
# deadline, and says it is waiting rather than going quiet.
TIMEOUT="${3:-90}"

if [ -z "$BUNDLE_ID" ] || [ -z "$INSTANCE_ID" ]; then
    echo "usage: $0 <bundle-id> <instance-id> [timeout-seconds]" >&2
    exit 2
fi

# `lsappinfo find` prints the app's ASN when a process holds the bundle
# id and nothing when none does. (`lsappinfo info -only pid` is no test:
# it prints a `pid = N` line for an unresolved name too, and never the
# `"pid"=` shape this once grepped for, so the app always read as gone.)
running() {
    [ -n "$(lsappinfo find "bundleid=$BUNDLE_ID" 2>/dev/null)" ]
}

# 1. Ask the GUI app to quit with the Apple Event. AppleScript's `quit`
#    runs the app's `applicationShouldTerminate` — the deck's termination
#    pipeline, then tugcast's teardown — and the bundle exits when that
#    completes. The quit is always this event, never a signal: a signal
#    skips the pipeline and loses whatever the deck had not saved.
#    AppleScript's own `is running` guards it, so a quit to an app that
#    is not running launches nothing. The error is kept, not discarded —
#    it is the only account of a quit that never arrived (most often
#    -1743, the terminal lacking Automation permission for Tug in System
#    Settings › Privacy & Security › Automation).
QUIT_ERROR="$(osascript \
    -e "if application id \"$BUNDLE_ID\" is running then" \
    -e "tell application id \"$BUNDLE_ID\" to quit" \
    -e "end if" 2>&1 >/dev/null)" || true

# 2. Poll until no process for this bundle remains.
started=$(date +%s)
deadline=$(( started + TIMEOUT ))
next_note=$(( started + 5 ))
captured=0
while [ "$(date +%s)" -lt "$deadline" ] && running; do
    if [ "$(date +%s)" -ge "$next_note" ]; then
        echo "    waiting for $INSTANCE_ID to quit ($(( $(date +%s) - started ))s)"
        next_note=$(( next_note + 5 ))
    fi
    # Diagnostic capture, once, when the app has sat on the quit event for
    # 3 s. The app receives the event at once but has been seen not to
    # dispatch it for 20–146 s (2026-10-18 to 2026-10-21) while its main
    # thread kept running; what state it is in then is not in any log, so
    # take it live: a 2 s sample of every thread, and a no-op Apple Event
    # with its own timeout, which says whether all Apple Events are stuck
    # or only the quit. Read-only; the wait goes on either way.
    if [ "$captured" -eq 0 ] && [ "$(( $(date +%s) - started ))" -ge 3 ]; then
        captured=1
        STALL_DIR="/tmp/tug-quit-stall-$(date +%Y%m%d-%H%M%S)"
        mkdir -p "$STALL_DIR"
        APP_PID="$(lsappinfo info -only pid "$(lsappinfo find "bundleid=$BUNDLE_ID")" 2>/dev/null | sed -n 's/.*pid = \([0-9][0-9]*\).*/\1/p' | head -1)"
        echo "    quit not taken after 3s — capturing to $STALL_DIR (pid ${APP_PID:-?})"
        if [ -n "$APP_PID" ]; then
            sample "$APP_PID" 2 -mayDie -file "$STALL_DIR/sample.txt" >/dev/null 2>&1 || true
        fi
        probe_start=$(date +%s)
        probe_out="$(osascript -e 'with timeout of 5 seconds' -e "tell application id \"$BUNDLE_ID\" to launch" -e 'end timeout' 2>&1)"
        probe_exit=$?
        {
            echo "quit sent at: $(date -r "$started" +%T)  osascript error: ${QUIT_ERROR:-none}"
            echo "noop event: exit=$probe_exit elapsed=$(( $(date +%s) - probe_start ))s output=${probe_out:-none}"
        } > "$STALL_DIR/events.txt"
        cat "$STALL_DIR/events.txt" | sed 's/^/    /'
    fi
    sleep 0.1
done

if running; then
    echo "error: $INSTANCE_ID ($BUNDLE_ID) is still running ${TIMEOUT}s after the quit event; quit it and run the recipe again." >&2
    if [ -n "$QUIT_ERROR" ]; then
        echo "       osascript: $QUIT_ERROR" >&2
    else
        echo "       The quit was delivered and the app did not exit." >&2
    fi
    exit 1
fi

# 3. The app is gone. If a registry entry still names this instance,
#    its tugcast outlived the GUI (the GUI died before reaching
#    ProcessManager.stop); `tugtool host instance stop` reaps it, and is
#    a no-op with no entry. Only ever after the GUI has exited: it
#    signals the host app too, and the host app's quit is the event.
#    `app-release` builds tugtool only in release, so take whichever
#    build the checkout has.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
for candidate in "$REPO_ROOT/tugrust/target/debug/tugtool" "$REPO_ROOT/tugrust/target/release/tugtool"; do
    if [ -x "$candidate" ]; then
        "$candidate" host instance stop "$INSTANCE_ID" --timeout 5 >/dev/null 2>&1 || true
        break
    fi
done
