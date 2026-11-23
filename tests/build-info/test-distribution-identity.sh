#!/bin/bash
set -euo pipefail

# test-distribution-identity.sh — a shipped bundle's identity does not move
# with the ref it was built on.
#
# The instance id `<BuildProfile>-<branch slug>` names the user's data dir,
# so a release built on a tag (detached HEAD) or a branch must still come
# out as `release-main` with the bundle id build-app.sh asked for. v0.9.5
# shipped as `release-detached-3937df43` and every setting reset on update.
#
# Runs assign-bundle-id.sh and stamp-distribution-identity.sh against a
# synthetic plist for each ref shape (no xcodebuild), so it is fast and
# hermetic. Mirrors test-bundle-id-mapping.sh.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ASSIGN="$REPO_ROOT/tugrust/scripts/assign-bundle-id.sh"
STAMP="$REPO_ROOT/tugrust/scripts/stamp-distribution-identity.sh"
BUILD_APP="$REPO_ROOT/tugrust/scripts/build-app.sh"

PASS=0
FAIL=0
check() {
    local label="$1" actual="$2" expected="$3"
    if [ "$actual" = "$expected" ]; then
        printf '  ok    %-34s = %s\n' "$label" "$actual"
        PASS=$((PASS + 1))
    else
        printf '  FAIL  %-34s = %s (expected %s)\n' "$label" "$actual" "$expected"
        FAIL=$((FAIL + 1))
    fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
CONTENTS="Tug.app/Contents"
mkdir -p "$WORK/$CONTENTS"
PLIST="$WORK/$CONTENTS/Info.plist"

read_key() {
    plutil -extract "$1" raw -o - "$PLIST" 2>/dev/null || true
}

# A plist as the Xcode build phases leave it for a Release build on `ref`.
built_on() {
    local profile="$1" ref="$2"
    cat >"$PLIST" <<EOF
{ "CFBundleIdentifier": "dev.tugapp.app", "BuildProfile": "$profile", "BuildBranch": "$ref" }
EOF
    plutil -convert xml1 "$PLIST"
    TARGET_BUILD_DIR="$WORK" CONTENTS_FOLDER_PATH="$CONTENTS" PRODUCT_NAME="Tug" \
        bash "$ASSIGN" >/dev/null
}

echo "==> a release keeps one identity whatever ref it was built on"
for ref in main detached-3937df43 tugarc/some-arc; do
    built_on release "$ref"
    bash "$STAMP" "$PLIST" dev.tugapp.app >/dev/null
    check "BuildBranch ($ref)"        "$(read_key BuildBranch)"        "main"
    check "CFBundleIdentifier ($ref)" "$(read_key CFBundleIdentifier)" "dev.tugapp.app"
    check "BuildProfile ($ref)"       "$(read_key BuildProfile)"       "release"
done

echo "==> the nightly keeps its own bundle id"
built_on release detached-3937df43
bash "$STAMP" "$PLIST" dev.tugapp.nightly >/dev/null
check "BuildBranch (nightly)"        "$(read_key BuildBranch)"        "main"
check "CFBundleIdentifier (nightly)" "$(read_key CFBundleIdentifier)" "dev.tugapp.nightly"

echo "==> a build that is not a release is refused, untouched"
built_on debug main
if bash "$STAMP" "$PLIST" dev.tugapp.app >/dev/null 2>&1; then
    check "debug plist refused" "accepted" "refused"
else
    check "debug plist refused" "refused" "refused"
fi
check "CFBundleIdentifier (debug)" "$(read_key CFBundleIdentifier)" "dev.tugapp.app.debug"

echo "==> build-app.sh stamps before it signs"
STAMP_LINE="$(grep -n 'stamp-distribution-identity.sh" "\$PLIST" "\$BUNDLE_ID"' "$BUILD_APP" | head -1 | cut -d: -f1)"
SIGN_LINE="$(grep -n '^ *bash "\$SCRIPT_DIR/sign-bundle.sh"' "$BUILD_APP" | head -1 | cut -d: -f1)"
if [ -n "$STAMP_LINE" ] && [ -n "$SIGN_LINE" ] && [ "$STAMP_LINE" -lt "$SIGN_LINE" ]; then
    check "stamp precedes sign" "yes" "yes"
else
    check "stamp precedes sign" "no (stamp:${STAMP_LINE:-none} sign:${SIGN_LINE:-none})" "yes"
fi

echo
echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" -eq 0 ]
