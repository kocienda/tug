#!/usr/bin/env bash
# Resolve the PRODUCT_NAME (and therefore the built `.app` filename and
# executable name) for the current working directory's Tug build
# identity. Parallel to `bundle-id-from-cwd.sh`: that script names the
# CFBundleIdentifier (which keys the AX/TCC grant by designated
# requirement); this one names the bundle *file* so each build variant
# is a distinct `.app` that never clobbers or re-signs another:
#
#   (release, main)       → Tug                  (Tug.app)
#   (debug, main)         → Tug-debug            (Tug-debug.app)
#   (debug, <other>)      → Tug-debug-<slug>     (Tug-debug-<slug>.app)
#   (release, <other>)    → Tug-release-<slug>   (Tug-release-<slug>.app)
#   TUG_FORCE_BUNDLE_ID=…  → Tug-<suffix>         (e.g. …apptest → Tug-apptest.app)
#
# Each worktree gets its own profile+slug-keyed `.app` (and, via
# derived-data-path.sh, its own DerivedData) so two arc worktrees never
# build into — and clobber, or re-sign under a live mmap — the one
# bundle the other's app is running. This matches the per-(profile,slug)
# CFBundleIdentifier that assign-bundle-id.sh / bundle-id-from-cwd.sh
# already assign, so each worktree variant is a fully independent app.
#
# Usage:
#   product-name-from-cwd.sh <profile>    # debug | release
#
# Output: a PRODUCT_NAME string (no `.app` suffix).
#
# The matching display name (CFBundleDisplayName, what System Settings →
# Accessibility lists by) is stamped from PRODUCT_NAME in
# `assign-bundle-id.sh`, so each variant shows as its own row.

set -euo pipefail

PROFILE="${1:-}"
if [ -z "$PROFILE" ]; then
    echo "usage: $0 <profile>" >&2
    exit 1
fi

# Forced-identity path (app-test / unattended builds): mirror
# bundle-id-from-cwd.sh's override hook. Derive the product name from
# the forced id's last component so the apptest bundle is `Tug-apptest`.
if [ -n "${TUG_FORCE_BUNDLE_ID:-}" ]; then
    echo "Tug-${TUG_FORCE_BUNDLE_ID##*.}"
    exit 0
fi

if BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" && [ "$BRANCH" != "HEAD" ]; then
    :
else
    SHA="$(git rev-parse HEAD 2>/dev/null | cut -c1-8)"
    BRANCH="detached-${SHA:-unknown}"
fi

case "${PROFILE}-${BRANCH}" in
    release-main)
        echo "Tug"
        ;;
    debug-main)
        echo "Tug-debug"
        ;;
    *)
        REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
        SLUG="$(bash "$REPO_ROOT/tugrust/scripts/branch-slug.sh" "$BRANCH")"
        echo "Tug-${PROFILE}-${SLUG}"
        ;;
esac
