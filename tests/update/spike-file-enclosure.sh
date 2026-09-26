#!/usr/bin/env bash
set -euo pipefail

# spike-file-enclosure.sh — does Sparkle accept a `file:` enclosure?
#
# **No.** Run on 2026-09-26 against Sparkle's own sources as vendored here,
# in both downloader modes, on a Release bundle: the rewrite is refused with
#
#     SUSparkleErrorDomain (2001): The download request URL must use http or
#     https (file:///…/Tug-0.8.14-local.zip)
#
# The guard is explicit and it is in the shared class — `SPUDownloader.m`'s
# `startDownloadWithRequest:`, under the comment "Prevent any unwanted URL
# schemes (e.g. file://)". Both modes reach it: the XPC service's `main.m`
# instantiates the same `SPUDownloader`, and the `--mode xpc` run below
# fails with the identical error. The control (`--mode plain`) reaches
# `readyToInstall` on the same rig, so the refusal is the scheme and not the
# harness.
#
# The script is kept because the question will be asked again — of a new
# Sparkle, or of a loopback server serving the local file over http, which
# is the shape the refusal leaves standing.
#
# The question this answers is the one the pause-and-resume work rests on: if
# Tug downloads the update archive itself, can it then hand the bytes to
# Sparkle by rewriting the request URL in
# `updater(_:willDownloadUpdate:withRequest:)` to a file on disk — and does
# that reach `readyToInstall`, signature verified and archive extracted, on a
# Release-configuration bundle? On paper yes: Sparkle's status-code check
# treats a non-HTTP response as 200 and `NSURLSession` download tasks handle
# `file:` URLs. On paper is not an answer, so this runs it.
#
# The pass is scripted rather than watched because its verdict is one line in
# a log, not something a person has to see happen:
#
#   1. Stand up the local signed feed (local-appcast.sh), throttled.
#   2. Fetch the enclosure to a local file with curl — standing in for the
#      host-owned download that [B10] will write.
#   3. Launch the Release bundle under TUG_SPARKLE_FEED with the enclosure
#      path in TUG_SPARKLE_LOCAL_ENCLOSURE and TUG_SPARKLE_AUTOPILOT=install,
#      which answers Sparkle's one question and nothing else.
#   4. Watch the app's own "UpdateController: <stage>" lines for
#      `readyToInstall`.
#
# Nothing is ever installed: the autopilot answers `install` at `available`
# and stops there. `readyToInstall` means the archive was verified and
# unpacked, which is the whole of what the spike asks.
#
# One exception, and it is Sparkle's design rather than this script's: an
# update that reached `readyToInstall` is installed when the app quits. So a
# `--mode plain` run *does* leave the Release bundle in DerivedData replaced
# by the staged copy it just served itself. Run `just app-release` after one.
#
# Usage:
#   tests/update/spike-file-enclosure.sh [--mode file|plain|xpc] [--rate KBPS]
#                                        [--port PORT] [--timeout SECONDS]
#
#   --mode file   rewrite the enclosure to the local file (the spike)
#   --mode plain  no rewrite — the control, Sparkle downloads from the feed
#   --mode xpc    the rewrite, with SUEnableDownloaderService set, so the
#                 download runs in Sparkle's Downloader.xpc rather than
#                 in-process. The key is written into the built bundle's
#                 Info.plist and the bundle re-signed, then restored.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

MODE="file"
RATE="4000"
PORT="8765"
TIMEOUT="180"

while [ $# -gt 0 ]; do
    case "$1" in
        --mode) MODE="$2"; shift 2 ;;
        --rate) RATE="$2"; shift 2 ;;
        --port) PORT="$2"; shift 2 ;;
        --timeout) TIMEOUT="$2"; shift 2 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done
case "$MODE" in
    file|plain|xpc) ;;
    *) echo "--mode must be one of file, plain, xpc" >&2; exit 2 ;;
esac

cd "$REPO_ROOT"
unset TUG_FORCE_BUNDLE_ID
PRODUCT_NAME="$(bash tugrust/scripts/product-name-from-cwd.sh release)"
export TUG_PRODUCT_NAME="$PRODUCT_NAME"
APP_DIR="$(bash tugrust/scripts/derived-data-path.sh release)/Build/Products/Release/${PRODUCT_NAME}.app"
if [ ! -d "$APP_DIR" ]; then
    echo "error: no Release bundle at $APP_DIR — run 'just app-release' first" >&2
    exit 1
fi
INSTANCE_ID="$(bash tugrust/scripts/instance-id-from-cwd.sh release)"
BUNDLE_ID="$(bash tugrust/scripts/bundle-id-from-cwd.sh release)"

WORK_DIR="$(mktemp -d)"
FEED_PID=""
APP_PID=""
PLIST_TOUCHED=""

cleanup() {
    [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null || true
    [ -n "$FEED_PID" ] && kill "$FEED_PID" 2>/dev/null || true
    bash tugrust/scripts/quit-tug-bundle.sh "$BUNDLE_ID" "$INSTANCE_ID" >/dev/null 2>&1 || true
    if [ -n "$PLIST_TOUCHED" ]; then
        echo "==> Restoring $PRODUCT_NAME's Info.plist and re-signing"
        /usr/libexec/PlistBuddy -c "Delete :SUEnableDownloaderService" \
            "$APP_DIR/Contents/Info.plist" >/dev/null 2>&1 || true
        bash tugrust/scripts/sign-bundle.sh "$APP_DIR" >/dev/null 2>&1 || true
    fi
    rm -rf "$WORK_DIR"
}
trap cleanup EXIT

echo "==> Spike: mode=$MODE rate=${RATE}kB/s port=$PORT"
if /usr/sbin/lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "error: something is already listening on port $PORT — a feed from a" >&2
    echo "       previous run, most likely. Stop it, or pass --port." >&2
    exit 1
fi
echo "==> Quitting $INSTANCE_ID, if running"
bash tugrust/scripts/quit-tug-bundle.sh "$BUNDLE_ID" "$INSTANCE_ID" || true

FEED_URL="http://127.0.0.1:$PORT/appcast.xml"
bash tests/update/local-appcast.sh "$APP_DIR" "$PORT" "$RATE" >"$WORK_DIR/feed.log" 2>&1 &
FEED_PID=$!
echo "==> Standing up the feed (staging, re-signing and archiving ~90 MB)"
for _ in $(seq 1 600); do
    if /usr/bin/curl -fsS "$FEED_URL" >/dev/null 2>&1; then break; fi
    if ! kill -0 "$FEED_PID" 2>/dev/null; then
        echo "error: the feed exited before it came up:" >&2
        cat "$WORK_DIR/feed.log" >&2
        exit 1
    fi
    sleep 1
done
if ! /usr/bin/curl -fsS "$FEED_URL" >/dev/null 2>&1; then
    echo "error: $FEED_URL never came up" >&2
    exit 1
fi
echo "==> Feed up: $FEED_URL"

ENCLOSURE_URL="$(/usr/bin/curl -fsS "$FEED_URL" \
    | /usr/bin/sed -n 's/.*url="\(http:\/\/127\.0\.0\.1[^"]*\)".*/\1/p' | head -1)"
if [ -z "$ENCLOSURE_URL" ]; then
    echo "error: no enclosure URL in the appcast" >&2
    exit 1
fi

LOCAL_ENCLOSURE="$WORK_DIR/$(basename "$ENCLOSURE_URL")"
if [ "$MODE" != "plain" ]; then
    echo "==> Fetching the enclosure to $LOCAL_ENCLOSURE (this is the throttled leg)"
    START="$(date +%s)"
    /usr/bin/curl -fsS -o "$LOCAL_ENCLOSURE" "$ENCLOSURE_URL"
    echo "    $(/usr/bin/stat -f%z "$LOCAL_ENCLOSURE") bytes in $(( $(date +%s) - START ))s"
fi

if [ "$MODE" = "xpc" ]; then
    echo "==> Setting SUEnableDownloaderService in the built bundle and re-signing"
    PLIST_TOUCHED="yes"
    /usr/libexec/PlistBuddy -c "Delete :SUEnableDownloaderService" \
        "$APP_DIR/Contents/Info.plist" >/dev/null 2>&1 || true
    /usr/libexec/PlistBuddy -c "Add :SUEnableDownloaderService bool true" \
        "$APP_DIR/Contents/Info.plist"
    bash tugrust/scripts/sign-bundle.sh "$APP_DIR" >/dev/null
fi

APP_LOG="$WORK_DIR/app.log"
echo "==> Launching $INSTANCE_ID on autopilot"
if [ "$MODE" = "plain" ]; then
    TUG_SPARKLE_FEED="$FEED_URL" TUG_SPARKLE_AUTOPILOT="install" \
        env -u TUG_INSTANCE_ID -u TUG_BUNDLE_PATH -u TUGCAST_RESOURCE_ROOT \
        "$APP_DIR/Contents/MacOS/$PRODUCT_NAME" >"$APP_LOG" 2>&1 &
else
    TUG_SPARKLE_FEED="$FEED_URL" TUG_SPARKLE_AUTOPILOT="install" \
        TUG_SPARKLE_LOCAL_ENCLOSURE="$LOCAL_ENCLOSURE" \
        env -u TUG_INSTANCE_ID -u TUG_BUNDLE_PATH -u TUGCAST_RESOURCE_ROOT \
        "$APP_DIR/Contents/MacOS/$PRODUCT_NAME" >"$APP_LOG" 2>&1 &
fi
APP_PID=$!

VERDICT="timed out"
for _ in $(seq 1 "$TIMEOUT"); do
    if /usr/bin/grep -q "UpdateController: readyToInstall" "$APP_LOG" 2>/dev/null; then
        VERDICT="reached readyToInstall"
        break
    fi
    if /usr/bin/grep -q "UpdateController: error" "$APP_LOG" 2>/dev/null; then
        VERDICT="failed — the updater reported an error"
        break
    fi
    if ! kill -0 "$APP_PID" 2>/dev/null; then
        VERDICT="failed — the app exited"
        break
    fi
    sleep 1
done

echo
echo "==> UpdateController lines"
/usr/bin/grep "UpdateController\|TugUpdateDriver" "$APP_LOG" 2>/dev/null || echo "    (none)"
echo
echo "==> VERDICT (mode=$MODE): $VERDICT"
[ "$VERDICT" = "reached readyToInstall" ]
