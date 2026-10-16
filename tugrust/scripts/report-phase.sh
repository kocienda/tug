#!/usr/bin/env bash
#
# report-phase.sh — a recipe's one line per phase.
#
#   bash tugrust/scripts/report-phase.sh <label> <n> [<name>] [--of <names…>] [--needle <text>…]
#
# Hands the arguments to `tugtool progress phase`, which keeps the run's phase
# state and draws the Bash block's run panel: the landed phases with their
# times, the one running since when, the rest to come. `--needle "just <label>"`
# rides every call, so a recipe run as `just <label>` is matched to its block
# without saying so; a recipe that also runs under another name passes that
# as a further `--needle`.
#
# The workspace's own tugtool is used, else PATH's; with neither there is no
# report. Reporting is telemetry: this never prints, never fails, and never
# slows the recipe it rides — a missing session is a silent exit 0 inside the
# verb itself.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TUGTOOL_BIN="$REPO_ROOT/tugrust/target/debug/tugtool"
[ -x "$TUGTOOL_BIN" ] || TUGTOOL_BIN="$(command -v tugtool 2>/dev/null || true)"
[ -n "$TUGTOOL_BIN" ] || exit 0
[ $# -ge 2 ] || exit 0

label="$1"
"$TUGTOOL_BIN" progress phase "$@" --needle "just $label" >/dev/null 2>&1 || true
exit 0
