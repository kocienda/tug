#!/usr/bin/env bash
# Resolve the CFBundleIdentifier for the current working directory's
# Tug build identity, applying the same [D10] / [D19] mapping that
# `assign-bundle-id.sh` uses at xcodebuild time:
#
#   (release, main)       → dev.tugapp.app
#   (debug, main)         → dev.tugapp.app.debug
#   (debug, <other>)      → dev.tugapp.app.debug-<slug>
#   (release, <other>)    → dev.tugapp.app.release-<slug>
#
# Usage:
#   bundle-id-from-cwd.sh <profile>   # debug | release
#
# Output: a CFBundleIdentifier string.

set -euo pipefail

PROFILE="${1:-}"
if [ -z "$PROFILE" ]; then
    echo "usage: $0 <profile>" >&2
    exit 1
fi

# Override hook — mirrors assign-bundle-id.sh. When TUG_FORCE_BUNDLE_ID
# is set, the build phase stamps that ID verbatim, so every consumer
# that needs to know "what bundle ID will this build have" (quit /
# launch / instance bookkeeping) must agree. Returning it here keeps
# those paths aligned with the forced identity. See
# tuglaws/code-signing-mac.md ("The app-test identity").
if [ -n "${TUG_FORCE_BUNDLE_ID:-}" ]; then
    echo "$TUG_FORCE_BUNDLE_ID"
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
        echo "dev.tugapp.app"
        ;;
    debug-main)
        echo "dev.tugapp.app.debug"
        ;;
    *)
        REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
        SLUG="$(bash "$REPO_ROOT/tugrust/scripts/branch-slug.sh" "$BRANCH")"
        echo "dev.tugapp.app.${PROFILE}-${SLUG}"
        ;;
esac
