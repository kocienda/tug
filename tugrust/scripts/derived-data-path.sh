#!/usr/bin/env bash
# Resolve the per-variant Xcode DerivedData path for the current working
# directory's Tug build identity. Parallel to `product-name-from-cwd.sh`
# and `bundle-id-from-cwd.sh`.
#
# Xcode's *default* DerivedData location is keyed on the `.xcodeproj`
# path, so every build variant of the same project shares one build
# directory — and since they are all the same `Tug` target, building one
# `PRODUCT_NAME` (e.g. `Tug-apptest`) evicts the previously-built product
# of another (`Tug-debug.app`), and vice-versa. Giving each variant its
# own `-derivedDataPath` keeps their build outputs disjoint so an
# app-test build never clobbers a live `app-debug` bundle.
#
# The path is keyed on PRODUCT_NAME (which already encodes the variant
# and honors `TUG_FORCE_BUNDLE_ID`). Forced-identity builds (app-test)
# additionally key on the worktree's branch slug: every worktree builds
# `Tug-apptest.app` under the SAME bundle id (so the one AX/TCC grant —
# keyed on the path-independent designated requirement — covers them
# all), but each worktree gets its own build directory so a build or
# re-sign in one worktree can never clobber the bundle another
# worktree's app-test run is executing.
#
#   (release, main)        → …/DerivedData/Tug
#   (debug, main)          → …/DerivedData/Tug-debug
#   (debug, <other>)       → …/DerivedData/Tug-debug-<slug>
#   (release, <other>)     → …/DerivedData/Tug-release-<slug>
#   TUG_FORCE_BUNDLE_ID=…   → …/DerivedData/Tug-<suffix>-<wtslug>
#                             (e.g. Tug-apptest-main, Tug-apptest-tugarc-foo)
#
# Usage:
#   derived-data-path.sh <profile>    # debug | release
#
# Output: an absolute DerivedData path (no trailing slash). xcodebuild
# writes products to `<path>/Build/Products/<Configuration>/`.

set -euo pipefail

PROFILE="${1:-}"
if [ -z "$PROFILE" ]; then
    echo "usage: $0 <profile>" >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRODUCT_NAME="$(bash "$SCRIPT_DIR/product-name-from-cwd.sh" "$PROFILE")"

LEAF="$PRODUCT_NAME"
if [ -n "${TUG_FORCE_BUNDLE_ID:-}" ]; then
    # Same branch → slug derivation as bundle-id-from-cwd.sh.
    if BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" && [ "$BRANCH" != "HEAD" ]; then
        :
    else
        SHA="$(git rev-parse HEAD 2>/dev/null | cut -c1-8)"
        BRANCH="detached-${SHA:-unknown}"
    fi
    WTSLUG="$(bash "$SCRIPT_DIR/branch-slug.sh" "$BRANCH")"
    LEAF="${PRODUCT_NAME}-${WTSLUG}"
fi

# Match Xcode's default base so standard tooling (and `clean-*`) find it;
# only the leaf name is per-variant instead of the shared project hash.
BASE="${HOME}/Library/Developer/Xcode/DerivedData"
echo "${BASE}/${LEAF}"
