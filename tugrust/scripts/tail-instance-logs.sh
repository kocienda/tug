#!/usr/bin/env bash
#
# Tail one instance's newest logs — tugcast's and, when it exists, the app's.
#
# The newest file is picked by modification time rather than by computing
# today's date. Both writers name their files for the UTC day
# (`tracing_appender::rolling::daily` on the Rust side, `TugLog` on the Swift
# side), so an evening run west of Greenwich that computed a local date opened
# a name nothing was writing to and reported no log against a running instance.
# Sorting by mtime removes the timezone question entirely.
#
# The app log is optional: a bundle built before `TugLog` landed writes only
# the tugcast half, and that still tails.

set -euo pipefail

INSTANCE_ID="${1:?usage: tail-instance-logs.sh <instance-id>}"
LOGS="$HOME/Library/Application Support/Tug/instances/$INSTANCE_ID/Logs"

newest() {
    # shellcheck disable=SC2012  # newest by mtime; log names are tug-made
    ls -t "$LOGS/$1".* 2>/dev/null | head -1
}

CAST="$(newest tugcast || true)"
APP="$(newest tugapp || true)"

if [ -z "$CAST" ]; then
    echo "no log for $INSTANCE_ID in $LOGS — has the instance ever run?"
    exit 1
fi

if [ -n "$APP" ]; then
    exec tail -F "$CAST" "$APP"
fi
exec tail -F "$CAST"
