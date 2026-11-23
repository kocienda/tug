#!/bin/bash
set -euo pipefail

# stamp-distribution-identity.sh — pin a distributed bundle's identity.
#
# Usage:
#   stamp-distribution-identity.sh <Info.plist> <bundle-id>
#   stamp-distribution-identity.sh --check <Info.plist> <bundle-id>
#
# capture-build-info.sh and assign-bundle-id.sh derive a bundle's identity
# from the git ref it was built on: BuildBranch is the branch (or
# `detached-<sha8>`), the instance id is `<BuildProfile>-<branch slug>`, and
# the bundle id follows the pair. That is right for a developer's build,
# where each worktree is its own instance, and wrong for a build that is
# shipped: the instance id names the per-instance data dir
# (`~/Library/Application Support/Tug/instances/<id>/`), so an identity that
# moves with the ref gives every user an empty data dir on update, and a new
# bundle id with it (preferences, privacy grants).
#
# v0.9.5 shipped that way. It was the first release dispatched on its tag, so
# the runner's HEAD was detached and the app came out as
# `release-detached-3937df43` / `dev.tugapp.app.release-detached-3937df43`
# where every release before it was `release-main` / `dev.tugapp.app`.
#
# So build-app.sh, which makes every bundle that leaves the machine, calls
# this after the Xcode build and before signing. The identity it stamps is
# constant: BuildBranch `main` (instance id `release-main`) and the bundle id
# it is handed. It refuses a plist that is not a release build.
#
# `--check` writes nothing: it reads the identity back and exits 1 unless it
# is the pinned one. build-app.sh runs it on the signed bundle, the one that
# goes into the disk image, so a later step that moved the identity, or this
# stamp being dropped from the script, fails the build instead of shipping.

CHECK=false
if [ "${1:-}" = "--check" ]; then
    CHECK=true
    shift
fi

if [ "$#" -ne 2 ]; then
    echo "usage: $0 [--check] <Info.plist> <bundle-id>" >&2
    exit 1
fi

PLIST="$1"
BUNDLE_ID="$2"

if [ ! -f "$PLIST" ]; then
    echo "error: $PLIST does not exist" >&2
    exit 1
fi

PROFILE="$(plutil -extract BuildProfile raw -o - "$PLIST" 2>/dev/null || true)"
if [ "$PROFILE" != "release" ]; then
    echo "error: $PLIST has BuildProfile '${PROFILE:-<missing>}', expected 'release'" >&2
    echo "       a distributed bundle is a Release build with capture-build-info.sh run." >&2
    exit 1
fi

WAS_BRANCH="$(plutil -extract BuildBranch raw -o - "$PLIST" 2>/dev/null || true)"
WAS_ID="$(plutil -extract CFBundleIdentifier raw -o - "$PLIST" 2>/dev/null || true)"

if [ "$CHECK" = true ]; then
    if [ "$WAS_BRANCH" != "main" ] || [ "$WAS_ID" != "$BUNDLE_ID" ]; then
        echo "error: $PLIST would ship as instance 'release-${WAS_BRANCH:-<missing>}'," \
             "bundle id '${WAS_ID:-<missing>}'" >&2
        echo "       a distributed bundle is instance 'release-main', bundle id '$BUNDLE_ID'." >&2
        echo "       any other identity gives every user an empty data dir on update." >&2
        exit 1
    fi
    echo "==> stamp-distribution-identity: verified instance release-main, bundle id $BUNDLE_ID"
    exit 0
fi

plutil -replace BuildBranch -string "main" "$PLIST"
plutil -replace CFBundleIdentifier -string "$BUNDLE_ID" "$PLIST"

echo "==> stamp-distribution-identity: instance release-main, bundle id $BUNDLE_ID" \
     "(built as branch '${WAS_BRANCH:-<missing>}', bundle id '${WAS_ID:-<missing>}')"
