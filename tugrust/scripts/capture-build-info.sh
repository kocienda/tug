#!/bin/bash
set -euo pipefail

# capture-build-info.sh — xcodebuild build-phase script
#
# Bakes build-time identity into the built bundle's Info.plist so the
# running app can read its own identity without any runtime git lookup
# or shared bootstrap state. See dash/tug-multi-instance.md [D01]
# [D02] [D03] for the design rationale.
#
# Writes (always):
#   BuildProfile      "debug" (Debug) or "release" (Release), OR the
#                     forced bundle id's last component when
#                     TUG_FORCE_BUNDLE_ID is set (e.g. "apptest") — see
#                     the profile block below for why the app-test build
#                     needs a distinct profile
#   BuildBranch       git branch at build time, or "detached-<sha8>"
#                     if HEAD is detached
#   BuildCommit       full SHA-1 of HEAD at build time (diagnostic)
#
# Writes (Debug-configuration builds only — debug AND the forced apptest
# build; release omits per [D03] [D19]):
#   BuildSourceTree   absolute path to the repo root the bundle was
#                     built from
#
# Required env (set by Xcode at build time):
#   CONFIGURATION             Debug | Release
#   TUG_FORCE_BUNDLE_ID       (optional) forces bundle id + profile for
#                             the app-test / unattended build path
#   SRCROOT                   path to tugapp/ (containing the .xcodeproj)
#   TARGET_BUILD_DIR          parent directory of the built bundle
#   CONTENTS_FOLDER_PATH      e.g. "Tug.app/Contents"
#
# Marked alwaysOutOfDate in the Xcode build phase so it re-runs on
# every build — BUILD_BRANCH can change between builds with no other
# source-file changes, and a stale cache would lie about identity.

PLIST="${TARGET_BUILD_DIR}/${CONTENTS_FOLDER_PATH}/Info.plist"

if [ ! -f "$PLIST" ]; then
    echo "error: $PLIST does not exist" >&2
    echo "       capture-build-info.sh must run after the Resources" >&2
    echo "       phase that copies Info.plist into the bundle." >&2
    exit 1
fi

# The app-test / unattended build path forces a stable bundle id
# (`TUG_FORCE_BUNDLE_ID`, e.g. dev.tugtool.app.apptest). Give that build
# a DISTINCT profile — the forced id's last component, "apptest" — so its
# per-instance identity (`<profile>-<branch>` = "apptest-main") never
# collides with the developer's debug instance ("debug-main"). Without a
# distinct profile, the app-test bundle shared the debug instance's
# ports, control socket, registry entry, and data dir, so a standalone
# app-test launch (or a rebuild's re-sign of the running bundle) knocked
# the running debug instance off its connection. The other forced-id
# consumers (assign-bundle-id.sh, product-name-from-cwd.sh,
# bundle-id-from-cwd.sh) already key off this same env var, so identity
# stays consistent across the build phases and the CLI helpers.
if [ -n "${TUG_FORCE_BUNDLE_ID:-}" ]; then
    BUILD_PROFILE="${TUG_FORCE_BUNDLE_ID##*.}"
else
    case "${CONFIGURATION:-}" in
        Debug)
            BUILD_PROFILE="debug"
            ;;
        Release)
            BUILD_PROFILE="release"
            ;;
        *)
            echo "error: unknown CONFIGURATION '${CONFIGURATION:-}' (expected Debug or Release)" >&2
            exit 1
            ;;
    esac
fi

if ! BUILD_BRANCH="$(git -C "$SRCROOT" rev-parse --abbrev-ref HEAD 2>/dev/null)"; then
    echo "error: git rev-parse --abbrev-ref HEAD failed in $SRCROOT" >&2
    echo "       the multi-instance identity scheme requires git at build time" >&2
    exit 1
fi
if [ "$BUILD_BRANCH" = "HEAD" ]; then
    SHORT_SHA="$(git -C "$SRCROOT" rev-parse HEAD | cut -c1-8)"
    BUILD_BRANCH="detached-${SHORT_SHA}"
fi

BUILD_COMMIT="$(git -C "$SRCROOT" rev-parse HEAD)"

# $SRCROOT is the directory containing the .xcodeproj (tugapp/).
# The "source tree" for multi-instance purposes is the repo root,
# matching what tugbank's dev.tugexec.app/source-tree-path used to
# carry under the single-instance scheme.
BUILD_SOURCE_TREE="$(cd "$SRCROOT/.." && pwd)"

# `plutil -replace` adds the key if absent, sets it if present.
plutil -replace BuildProfile -string "$BUILD_PROFILE" "$PLIST"
plutil -replace BuildBranch  -string "$BUILD_BRANCH"  "$PLIST"
plutil -replace BuildCommit  -string "$BUILD_COMMIT"  "$PLIST"

# Source-tree is for dev-style builds that serve tugdeck from the repo:
# debug HMR, AND the app-test bundle (which serves the prebuilt dist out
# of the source tree under TUGAPP_APP_TEST). Both are Debug-configuration
# builds, so key this on CONFIGURATION, not the profile string — the
# forced "apptest" profile is still a Debug build and MUST carry the
# source tree (the app reads it profile-independently to resolve
# TUGCAST_RESOURCE_ROOT). Release omits it per [D03]/[D19].
if [ "${CONFIGURATION:-}" = "Debug" ]; then
    plutil -replace BuildSourceTree -string "$BUILD_SOURCE_TREE" "$PLIST"
else
    # Defensive: strip the key if a prior debug build's cached plist
    # leaked into this configuration's products. `plutil -remove`
    # exits 1 and writes "No value to remove..." to stdout (not
    # stderr) when the key is absent — discard both since absence
    # is the expected case for clean release builds.
    if plutil -extract BuildSourceTree raw "$PLIST" >/dev/null 2>&1; then
        plutil -remove BuildSourceTree "$PLIST"
    fi
fi

echo "==> capture-build-info: profile=$BUILD_PROFILE branch=$BUILD_BRANCH commit=${BUILD_COMMIT:0:8}"
