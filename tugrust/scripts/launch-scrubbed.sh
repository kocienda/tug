#!/usr/bin/env bash
#
# Launch a Tug bundle with the launching instance's environment scrubbed.
#
# `open` — and a direct launch of the binary — propagates the caller's
# environment, so a launch from inside a Dev card hands the new bundle the
# host instance's identity, its resource root, and the absolute paths of the
# host's own ledgers. The identity variables make the new bundle answer as
# the old one; the ledger variables are worse, because they are silent: a
# second tugcast that inherits TUG_SESSIONS_DB opens another instance's
# session ledger and demotes its live rows on startup. tugcast now refuses
# that override outright, so an unscrubbed launch would fail at the door
# rather than corrupt anything — this script is what keeps a developer
# launch from ever meeting that refusal.
#
# The list lives here, once, because it was four copies in the justfile and
# copies drift: the three identity variables were scrubbed by all four
# launch recipes and the ledger variables by none of them.
#
# Usage: launch-scrubbed.sh <command> [args...]
set -euo pipefail

SCRUB=(
    TUG_INSTANCE_ID
    TUG_BUNDLE_PATH
    TUGCAST_RESOURCE_ROOT
    TUG_SESSIONS_DB
    TUG_CHANGES_DB
    TUG_PROMPT_HISTORY_DB
    TUG_SESSION_INDEX_DB
    TUG_DATA_DIR
    TUG_SESSION_ID
)

unset_args=()
for var in "${SCRUB[@]}"; do
    unset_args+=(-u "$var")
done

exec env "${unset_args[@]}" "$@"
