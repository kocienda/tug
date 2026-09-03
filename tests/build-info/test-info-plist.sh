#!/bin/bash
set -euo pipefail

# test-info-plist.sh — integration test for the build phases that
# bake identity into the bundle's Info.plist (capture-build-info.sh +
# assign-bundle-id.sh). Builds a Debug bundle, inspects the Info.plist,
# and verifies:
#   - BuildProfile      == "debug"        (Debug → debug, per [D19])
#   - BuildBranch       == current git branch (or detached-<sha8>)
#   - BuildCommit       == current HEAD sha
#   - BuildSourceTree   == repo root      (debug builds include it)
#   - CFBundleIdentifier matches the [D10] / [D19] mapping for the
#     cwd's (profile, branch) tuple, computed via
#     tugrust/scripts/branch-slug.sh
#
# Reports the expected BuildInfo.instanceId for a Swift consumer.
#
# Use `--no-build` to skip xcodebuild and verify whatever bundle is
# already built (faster iteration).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TUGAPP_DIR="$REPO_ROOT/tugapp"

NO_BUILD=false
for arg in "$@"; do
    case "$arg" in
        --no-build) NO_BUILD=true ;;
        *) echo "error: unknown arg '$arg' (use --no-build to skip xcodebuild)" >&2; exit 2 ;;
    esac
done

if [ "$NO_BUILD" = false ]; then
    echo "==> building Debug bundle"
    xcodebuild \
        -project "$TUGAPP_DIR/Tug.xcodeproj" \
        -scheme Tug \
        -configuration Debug \
        -destination 'platform=macOS,arch=arm64' \
        build >/dev/null
fi

BUILT_PRODUCTS_DIR="$(
    xcodebuild \
        -project "$TUGAPP_DIR/Tug.xcodeproj" \
        -scheme Tug \
        -configuration Debug \
        -destination 'platform=macOS,arch=arm64' \
        -showBuildSettings 2>/dev/null \
    | awk '/^[[:space:]]*BUILT_PRODUCTS_DIR =/ {print $3; exit}'
)"
APP="$BUILT_PRODUCTS_DIR/Tug.app"
PLIST="$APP/Contents/Info.plist"

if [ ! -f "$PLIST" ]; then
    echo "error: $PLIST not found — bundle was not built" >&2
    exit 1
fi

read_key() {
    plutil -extract "$1" raw -o - "$PLIST" 2>/dev/null || true
}

PROFILE="$(read_key BuildProfile)"
BRANCH="$(read_key BuildBranch)"
COMMIT="$(read_key BuildCommit)"
SOURCE_TREE="$(read_key BuildSourceTree)"
BUNDLE_ID="$(read_key CFBundleIdentifier)"

GIT_HEAD="$(git -C "$TUGAPP_DIR" rev-parse HEAD)"
GIT_BRANCH="$(git -C "$TUGAPP_DIR" rev-parse --abbrev-ref HEAD)"
if [ "$GIT_BRANCH" = "HEAD" ]; then
    GIT_BRANCH="detached-$(echo "$GIT_HEAD" | cut -c1-8)"
fi
REPO_ROOT_REAL="$(cd "$TUGAPP_DIR/.." && pwd)"

# Expected bundle ID per [D10], using the canonical bash slugifier so
# any divergence between Swift's BranchSlug.compute and bash's
# branch-slug.sh surfaces here. Parity is also independently checked
# by test-slug-parity.sh.
BRANCH_SLUG="$(bash "$REPO_ROOT/tugrust/scripts/branch-slug.sh" "$GIT_BRANCH")"
case "debug-$GIT_BRANCH" in
    debug-main)
        EXPECTED_BUNDLE_ID="dev.tugapp.app.debug"
        ;;
    *)
        EXPECTED_BUNDLE_ID="dev.tugapp.app.debug-$BRANCH_SLUG"
        ;;
esac

fail=0
check() {
    local name="$1"
    local actual="$2"
    local expected="$3"
    if [ "$actual" = "$expected" ]; then
        printf '  ok   %-22s = %s\n' "$name" "$actual"
    else
        printf '  FAIL %-22s = %s  (expected %s)\n' "$name" "$actual" "$expected"
        fail=$((fail + 1))
    fi
}

echo "==> verifying $PLIST"
check BuildProfile       "$PROFILE"     "debug"
check BuildBranch        "$BRANCH"      "$GIT_BRANCH"
check BuildCommit        "$COMMIT"      "$GIT_HEAD"
check BuildSourceTree    "$SOURCE_TREE" "$REPO_ROOT_REAL"
check CFBundleIdentifier "$BUNDLE_ID"   "$EXPECTED_BUNDLE_ID"

EXPECTED_INSTANCE_ID="debug-$BRANCH_SLUG"
echo "==> expected BuildInfo.instanceId for a Swift consumer: $EXPECTED_INSTANCE_ID"

# Codesign DR drift check. When the bundle is signed with a real
# identity (Developer ID Application — lands in Step 3), the DR is a
# structured requirement expression of the form:
#     identifier "dev.tugapp.app.debug" and anchor apple generic and ...
# and we can assert the identifier matches CFBundleIdentifier.
#
# Pre-Step-3, the build uses ad-hoc signing whose DR is just
# `cdhash H"..."` with no identifier field. In that case we surface the
# raw DR informationally — no assertion, no failure. The drift gate
# turns on automatically once Step 3 produces structured DRs.
DR_LINE="$(codesign -d -r- "$APP" 2>&1 | sed -nE 's/^#?[[:space:]]*designated[[:space:]]+=>[[:space:]]+(.*)$/\1/p' | head -1)"
DR_ID="$(printf '%s\n' "$DR_LINE" \
    | sed -nE 's/.*identifier[[:space:]]+"([^"]+)".*/\1/p; s/.*identifier[[:space:]]+([^[:space:]]+).*/\1/p' \
    | head -1)"
if [ -z "$DR_LINE" ]; then
    printf '  FAIL %-22s = <could not extract>\n' "DR (raw)"
    fail=$((fail + 1))
elif [ -z "$DR_ID" ]; then
    printf '  info %-22s = %s\n' "DR (ad-hoc)" "$DR_LINE"
    printf '       %-22s   (identifier check turns on with Step 3 Developer ID signing)\n' ""
elif [ "$DR_ID" = "$BUNDLE_ID" ]; then
    printf '  ok   %-22s = %s\n' "DR identifier" "$DR_ID"
else
    printf '  FAIL %-22s = %s  (expected %s)\n' "DR identifier" "$DR_ID" "$BUNDLE_ID"
    fail=$((fail + 1))
fi

if [ "$fail" -ne 0 ]; then
    echo "FAIL: $fail key(s) did not match expected values" >&2
    exit 1
fi
echo "ok: Info.plist has all four build-time identity keys with expected values"
