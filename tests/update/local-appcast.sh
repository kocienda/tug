#!/usr/bin/env bash
set -euo pipefail

# local-appcast.sh — stand up a signed, locally-served appcast advertising a
# version newer than the app you are about to run, and print the one command
# that drives an update against it.
#
# This is the setup for the end-to-end pass the update work's checkpoints
# ask for: find, download, install, relaunch, driven from the app menu with
# no deck involved. That pass is manual by design — it ends in the app
# quitting and coming back as a different version, which is the one thing
# only a person watching can confirm.
#
# The archive is the built bundle itself with its version bumped, so the feed
# advertises something real that Sparkle will verify the signature of. Nothing
# here touches products/ or the published feed.
#
# The feed carries the notes fixture beside this script, so the manual pass
# exercises the popover's release-notes rendering rather than only its
# controls. The published path finds its notes by version instead
# (release-notes/<version>.md); here the version is invented, so it is named
# outright.
#
# Usage:
#   tests/update/local-appcast.sh <path/to/Tug.app> [port]
#
# Leaves a server in the foreground; ^C tears it down along with its
# scratch directory.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

APP="${1:-}"
PORT="${2:-8765}"

if [ -z "$APP" ] || [ ! -d "$APP" ]; then
    echo "usage: $(basename "$0") <path/to/Tug.app> [port]" >&2
    exit 2
fi
APP="$(cd "$APP" && pwd)"

PLIST="$APP/Contents/Info.plist"
CURRENT_SHORT="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$PLIST")"
CURRENT_BUILD="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$PLIST")"
NEXT_SHORT="${CURRENT_SHORT}-local"
NEXT_BUILD="$(( CURRENT_BUILD + 1 ))"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

echo "==> Staging $(basename "$APP") $CURRENT_SHORT ($CURRENT_BUILD) as $NEXT_SHORT ($NEXT_BUILD)"
STAGED="$WORK_DIR/stage/$(basename "$APP")"
mkdir -p "$WORK_DIR/stage"
/usr/bin/ditto "$APP" "$STAGED"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $NEXT_SHORT" "$STAGED/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $NEXT_BUILD" "$STAGED/Contents/Info.plist"

# Rewriting Info.plist breaks the seal, so re-sign — inside-out, through the
# repository's own script. `generate_appcast` runs Apple's code-signing checks
# over the whole bundle before it will put an archive in a feed, and a shallow
# re-sign of the wrapper leaves every nested helper failing them. Reusing
# sign-bundle.sh is also the point: this pass should exercise the bundle shape
# a release actually ships.
echo "==> Re-signing the staged bundle (inside-out, Developer ID)"
bash "$REPO_ROOT/tugrust/scripts/sign-bundle.sh" "$STAGED" >/dev/null

ARCHIVE="$WORK_DIR/serve/Tug-$NEXT_SHORT.zip"
mkdir -p "$WORK_DIR/serve"
echo "==> Archiving"
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$STAGED" "$ARCHIVE"

echo "==> Generating the appcast"
bash "$REPO_ROOT/tugrust/scripts/make-appcast.sh" \
    --notes "$SCRIPT_DIR/local-release-notes.md" \
    "$ARCHIVE" "$WORK_DIR/serve/appcast.xml"

# make-appcast.sh writes the published download prefix, which does not exist
# yet. Point the enclosure at this server instead, so the download half of
# the pass reaches the archive beside the feed.
/usr/bin/sed -i '' \
    "s|https://github.com/kocienda/tug/releases/download/updates/|http://127.0.0.1:$PORT/|g" \
    "$WORK_DIR/serve/appcast.xml"

cat <<INFO

==> Feed ready: http://127.0.0.1:$PORT/appcast.xml
    advertising $NEXT_SHORT ($NEXT_BUILD) over $CURRENT_SHORT ($CURRENT_BUILD)

    In another terminal:

      TUG_SPARKLE_FEED=http://127.0.0.1:$PORT/appcast.xml \\
          "$APP/Contents/MacOS/$(basename "$APP" .app)"

    Then drive it from the app menu alone — the item's title tracks the
    flow: "Check for Updates..." → "Update to Tug $NEXT_SHORT..." →
    "Downloading..." → "Install and Relaunch". Every transition is logged
    as "UpdateController: <stage> (...)".

    ^C here when you are done.

INFO

cd "$WORK_DIR/serve"
# Not `exec` — that would replace this shell and take the cleanup trap with
# it, leaving a ~90 MB scratch directory behind on every ^C.
/usr/bin/python3 -m http.server "$PORT" --bind 127.0.0.1
