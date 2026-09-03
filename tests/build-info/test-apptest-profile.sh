#!/bin/bash
set -euo pipefail

# test-apptest-profile.sh — unit test for the app-test build's DISTINCT
# per-instance identity.
#
# The app-test / unattended build path sets TUG_FORCE_BUNDLE_ID
# (dev.tugapp.app.apptest). capture-build-info.sh must then stamp a
# DISTINCT BuildProfile ("apptest", the forced id's last component) so
# the bundle's per-instance identity is `apptest-<branch>`, NOT
# `debug-<branch>`. Sharing "debug-main" with the developer's
# Tug-debug.app made the app-test bundle collide with it on ports,
# control socket, registry, and data dir — launching/rebuilding app-test
# then knocked the running debug instance off.
#
# It must ALSO still write BuildSourceTree (the app-test bundle serves
# tugdeck's dist out of the source tree), even though the profile is no
# longer literally "debug" — that key is gated on the Debug
# *configuration*, not the profile string.
#
# Runs capture-build-info.sh directly against a synthetic plist (no
# xcodebuild) so it is fast and hermetic. Mirrors test-bundle-id-mapping.sh.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CAPTURE="$REPO_ROOT/tugrust/scripts/capture-build-info.sh"
ASSIGN="$REPO_ROOT/tugrust/scripts/assign-bundle-id.sh"

PASS=0
FAIL=0
check() {
    local label="$1" actual="$2" expected="$3"
    if [ "$actual" = "$expected" ]; then
        printf '  ok    %-22s = %s\n' "$label" "$actual"
        PASS=$((PASS + 1))
    else
        printf '  FAIL  %-22s = %s (expected %s)\n' "$label" "$actual" "$expected"
        FAIL=$((FAIL + 1))
    fi
}
check_present() {
    local label="$1" actual="$2"
    if [ -n "$actual" ]; then
        printf '  ok    %-22s = %s\n' "$label" "$actual"
        PASS=$((PASS + 1))
    else
        printf '  FAIL  %-22s is empty (expected a value)\n' "$label"
        FAIL=$((FAIL + 1))
    fi
}

# Synthetic bundle plist. capture-build-info / assign-bundle-id locate
# it via TARGET_BUILD_DIR + CONTENTS_FOLDER_PATH.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
CONTENTS="Tug-apptest.app/Contents"
mkdir -p "$WORK/$CONTENTS"
PLIST="$WORK/$CONTENTS/Info.plist"
cat >"$PLIST" <<'EOF'
{ "CFBundleIdentifier": "dev.tugapp.app" }
EOF
plutil -convert binary1 "$PLIST" 2>/dev/null || true

read_key() { plutil -extract "$1" raw -o - "$PLIST" 2>/dev/null || true; }

echo "==> capture-build-info with TUG_FORCE_BUNDLE_ID (Debug config)"
env \
    CONFIGURATION="Debug" \
    SRCROOT="$REPO_ROOT/tugapp" \
    TARGET_BUILD_DIR="$WORK" \
    CONTENTS_FOLDER_PATH="$CONTENTS" \
    TUG_FORCE_BUNDLE_ID="dev.tugapp.app.apptest" \
    PRODUCT_NAME="Tug-apptest" \
    bash "$CAPTURE" >/dev/null

PROFILE="$(read_key BuildProfile)"
SOURCE_TREE="$(read_key BuildSourceTree)"
BRANCH="$(read_key BuildBranch)"

check        BuildProfile     "$PROFILE"     "apptest"
check        BuildSourceTree  "$SOURCE_TREE" "$REPO_ROOT"
check_present BuildBranch     "$BRANCH"

# The Swift consumer composes instanceId as `<profile>-<branchSlug>`.
# With a distinct "apptest" profile it is apptest-<branch>, never
# debug-<branch> — the whole point of this change.
SLUG="$(bash "$REPO_ROOT/tugrust/scripts/branch-slug.sh" "$BRANCH")"
INSTANCE_ID="${PROFILE}-${SLUG}"
echo "==> derived BuildInfo.instanceId for a Swift consumer: $INSTANCE_ID"
case "$INSTANCE_ID" in
    debug-*) printf '  FAIL  %-22s = %s (must NOT share the debug identity)\n' "instanceId" "$INSTANCE_ID"; FAIL=$((FAIL + 1)) ;;
    apptest-*) printf '  ok    %-22s = %s\n' "instanceId" "$INSTANCE_ID"; PASS=$((PASS + 1)) ;;
    *) printf '  FAIL  %-22s = %s (unexpected prefix)\n' "instanceId" "$INSTANCE_ID"; FAIL=$((FAIL + 1)) ;;
esac

echo "==> assign-bundle-id still stamps the forced id verbatim"
env \
    TARGET_BUILD_DIR="$WORK" \
    CONTENTS_FOLDER_PATH="$CONTENTS" \
    TUG_FORCE_BUNDLE_ID="dev.tugapp.app.apptest" \
    PRODUCT_NAME="Tug-apptest" \
    bash "$ASSIGN" >/dev/null
check CFBundleIdentifier "$(read_key CFBundleIdentifier)" "dev.tugapp.app.apptest"

echo
if [ "$FAIL" -eq 0 ]; then
    echo "ok: app-test build gets a distinct 'apptest' identity ($PASS checks)"
    exit 0
else
    echo "FAILED: $FAIL check(s) failed, $PASS passed"
    exit 1
fi
