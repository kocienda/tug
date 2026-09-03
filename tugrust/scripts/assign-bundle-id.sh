#!/bin/bash
set -euo pipefail

# assign-bundle-id.sh — xcodebuild build-phase script
#
# Assigns the bundle's CFBundleIdentifier per (BuildProfile, BuildBranch)
# according to [D10] of the multi-instance design record (suffix scheme as
# amended by [D19]):
#
#   (release, main)       → dev.tugtool.app
#   (debug, main)         → dev.tugtool.app.debug
#   (debug, <other>)      → dev.tugtool.app.debug-<slug>
#   (release, <other>)    → dev.tugtool.app.release-<slug>
#
# Where <slug> is the BuildBranch normalized via
# `tugrust/scripts/branch-slug.sh` (the canonical bash implementation
# of the slug algorithm). Parity with the Swift `BranchSlug.compute`
# is verified by `tests/build-info/test-slug-parity.sh`.
#
# Per [D19]: the rename from production/development → release/debug
# invalidates the user's existing AX (Accessibility) TCC grant on the
# old `(development, main)` shorthand `dev.tugtool.app.dev`. The new
# `(debug, main)` bundle ID `dev.tugtool.app.debug` prompts for AX on
# first launch — one-time cost, accepted. The orphan TCC entry on
# `dev.tugtool.app.dev` is harmless and can be cleared manually via
# `tccutil reset Accessibility dev.tugtool.app.dev`. The
# `(release, main)` bundle ID `dev.tugtool.app` is unchanged, so its
# AX grant survives.
#
# Required env (set by Xcode at build time):
#   TARGET_BUILD_DIR          parent directory of the built bundle
#   CONTENTS_FOLDER_PATH      e.g. "Tug.app/Contents"
#
# Preconditions: capture-build-info.sh has already run and populated
# BuildProfile + BuildBranch in the bundle's Info.plist.
#
# Postcondition: the bundle's CFBundleIdentifier reflects the
# (BuildProfile, BuildBranch) tuple per [D10]. Code-signing (which
# happens after this phase) reads CFBundleIdentifier from the bundle's
# Info.plist directly, so the dynamic value propagates to the signed
# binary's designated requirement automatically.
#
# Note on PRODUCT_BUNDLE_IDENTIFIER: the xcconfig setting in
# project.pbxproj stays at the legacy `dev.tugtool.app` value. It is
# no longer the source of truth — this script is. Xcode IDE Build runs
# the same build phases as `xcodebuild`, so the dynamic override
# applies in both paths. The pbxproj value is the fallback that
# Xcode's `application-identifier` xcent generation uses; for our
# bundle (no sandbox, no app groups, no keychain access groups) a
# stale `application-identifier` in the xcent is cosmetic only.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SLUG_CMD="$SCRIPT_DIR/branch-slug.sh"

PLIST="${TARGET_BUILD_DIR}/${CONTENTS_FOLDER_PATH}/Info.plist"

if [ ! -f "$PLIST" ]; then
    echo "error: $PLIST does not exist" >&2
    echo "       assign-bundle-id.sh must run after the Resources" >&2
    echo "       phase that copies Info.plist into the bundle." >&2
    exit 1
fi

# Override hook for the app-test / unattended-build path.
#
# When TUG_FORCE_BUNDLE_ID is set, stamp it verbatim and skip the
# (profile, branch) mapping entirely. A worktree on a non-main branch
# would otherwise get a fresh per-branch CFBundleIdentifier
# (dev.tugtool.app.debug-<slug>) — a brand-new designated requirement
# and therefore a brand-new TCC Accessibility entry that has never been
# granted. Forcing a single stable bundle ID gives every worktree the
# same DR, so an AX grant given once carries across all of them, which
# is what makes unattended app-test runs (e.g. inside `tugplug:implement`)
# possible. See tuglaws/code-signing-mac.md ("The app-test identity").
#
# Code-signing runs after this phase and reads CFBundleIdentifier from
# the bundle's Info.plist directly, so the forced value propagates into
# the signed binary's designated requirement automatically.
if [ -n "${TUG_FORCE_BUNDLE_ID:-}" ]; then
    plutil -replace CFBundleIdentifier -string "$TUG_FORCE_BUNDLE_ID" "$PLIST"
    # System Settings → Privacy & Security → Accessibility lists apps by
    # display name, not bundle id (CFBundleName here is the literal
    # "Tug"). Without a distinct CFBundleDisplayName every variant shows
    # up as an identical "Tug" row — invisible by collision, the "I
    # granted it but nothing appeared" trap. Stamp the PRODUCT_NAME the
    # build was invoked with (e.g. Tug-apptest), so the row matches the
    # `.app` filename. Falls back to the forced suffix if PRODUCT_NAME
    # is somehow unset.
    DISPLAY_NAME="${PRODUCT_NAME:-Tug-${TUG_FORCE_BUNDLE_ID##*.}}"
    # Stamp BOTH name keys: System Settings → Accessibility lists by
    # CFBundleName (the menu-bar name, literal "Tug" by default), and
    # falls back to it when CFBundleDisplayName is absent — so the row
    # only de-collides when CFBundleName itself is per-variant.
    plutil -replace CFBundleName -string "$DISPLAY_NAME" "$PLIST"
    plutil -replace CFBundleDisplayName -string "$DISPLAY_NAME" "$PLIST"
    echo "==> assign-bundle-id: $TUG_FORCE_BUNDLE_ID (forced) — name '$DISPLAY_NAME'"
    exit 0
fi

read_key() {
    local key="$1"
    local value
    if ! value="$(plutil -extract "$key" raw "$PLIST" 2>/dev/null)"; then
        echo "error: Info.plist key '$key' is missing" >&2
        echo "       assign-bundle-id.sh must run after capture-build-info.sh." >&2
        exit 1
    fi
    if [ "$value" = "UNSET-AT-BUILD-TIME" ]; then
        echo "error: Info.plist key '$key' still has its placeholder value" >&2
        echo "       capture-build-info.sh did not run before this phase." >&2
        exit 1
    fi
    printf '%s' "$value"
}

BUILD_PROFILE="$(read_key BuildProfile)"
BUILD_BRANCH="$(read_key BuildBranch)"

case "${BUILD_PROFILE}-${BUILD_BRANCH}" in
    release-main)
        BUNDLE_ID="dev.tugtool.app"
        ;;
    debug-main)
        BUNDLE_ID="dev.tugtool.app.debug"
        ;;
    *)
        BRANCH_SLUG="$(bash "$SLUG_CMD" "$BUILD_BRANCH")"
        if [ -z "$BRANCH_SLUG" ]; then
            echo "error: BuildBranch '$BUILD_BRANCH' slugifies to the empty string" >&2
            echo "       a branch name composed entirely of non-slug characters" >&2
            echo "       cannot produce a valid bundle ID suffix" >&2
            exit 1
        fi
        BUNDLE_ID="dev.tugtool.app.${BUILD_PROFILE}-${BRANCH_SLUG}"
        ;;
esac

plutil -replace CFBundleIdentifier -string "$BUNDLE_ID" "$PLIST"

# Stamp BOTH name keys to match PRODUCT_NAME (Tug / Tug-debug /
# Tug-<profile>-<slug>) so each variant is its own legible row in System
# Settings → Accessibility, instead of identical "Tug" rows. The list
# reads CFBundleName (the literal "Tug" by default); CFBundleDisplayName
# alone does not de-collide it.
DISPLAY_NAME="${PRODUCT_NAME:-Tug}"
plutil -replace CFBundleName -string "$DISPLAY_NAME" "$PLIST"
plutil -replace CFBundleDisplayName -string "$DISPLAY_NAME" "$PLIST"

echo "==> assign-bundle-id: $BUNDLE_ID — name '$DISPLAY_NAME'"
