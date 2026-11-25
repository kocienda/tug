#!/usr/bin/env bash
#
# Approve or reject a Stable Release run that is paused before `publish`.
#
# release.yml's `publish` job runs in the `release` environment, which has a
# required reviewer, so a green run stops there and waits. That pause is where
# the build that would ship is checked (`just lab-update-rehearsal <os> --run
# <id>`); this is the answer to it, from the terminal the check ran in rather
# than the Actions page's Review deployments dialog. Approving ships the
# release; rejecting fails `publish` and the build is thrown away, as with a
# red full lane, so running `just release` again re-dispatches on the same tag.
#
# Usage: release-gate.sh approve|reject <run-id> [comment]

set -euo pipefail

usage() { echo "usage: release-gate.sh approve|reject <run-id> [comment]" >&2; exit 2; }
[ $# -ge 2 ] || usage
case "$1" in
    approve) STATE=approved ;;
    reject) STATE=rejected ;;
    *) usage ;;
esac
RUN_ID="$2"
COMMENT="${3:-$1d from release-gate.sh}"

# The deployments this run is waiting on. Only `release` is expected, but every
# pending one the caller can review is answered, so a second gated job added
# later is not left waiting with nothing to say why.
IDS="$(gh api "repos/{owner}/{repo}/actions/runs/$RUN_ID/pending_deployments" \
    --jq '[.[] | select(.current_user_can_approve) | .environment.id] | map(tostring) | join(" ")')"
if [ -z "$IDS" ]; then
    echo "error: run $RUN_ID is not waiting on a deployment you can review." >&2
    echo "       It may not have reached publish yet, or it was already answered:" >&2
    echo "       gh run view $RUN_ID" >&2
    exit 1
fi

ARGS=()
for id in $IDS; do ARGS+=(-F "environment_ids[]=$id"); done
gh api --method POST "repos/{owner}/{repo}/actions/runs/$RUN_ID/pending_deployments" \
    "${ARGS[@]}" -f state="$STATE" -f comment="$COMMENT" >/dev/null
echo "==> run $RUN_ID: publish $STATE"
