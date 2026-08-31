#!/usr/bin/env bash
# Resolve a dmgbuild executable, bootstrapping a pinned, isolated venv on
# first use. dmgbuild writes the disk image's .DS_Store directly (via
# ds_store/mac_alias) with no Finder/AppleScript/GUI session, so the styled
# DMG build stays deterministic and headless.
#
# Prints the absolute path to the dmgbuild binary on stdout. All progress
# goes to stderr so the stdout capture stays clean.
#
# Resolution order:
#   1. $DMGBUILD if set and executable (operator override / CI cache).
#   2. dmgbuild on PATH (e.g. a pipx install).
#   3. A repo-local venv at $REPO_ROOT/.build-tools/dmgbuild-venv (gitignored),
#      created once and reused across builds. System python is never touched.
set -euo pipefail

DMGBUILD_VERSION="1.6.7"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

if [ -n "${DMGBUILD:-}" ] && [ -x "${DMGBUILD}" ]; then
    echo "$DMGBUILD"
    exit 0
fi

if command -v dmgbuild >/dev/null 2>&1; then
    command -v dmgbuild
    exit 0
fi

VENV="$REPO_ROOT/.build-tools/dmgbuild-venv"
VENV_DMGBUILD="$VENV/bin/dmgbuild"

# A venv is not relocatable: pip writes the absolute path of the creating
# interpreter into each console script's shebang. A venv restored from a CI
# cache into a checkout at a different path — or one whose base python has
# since moved — leaves an executable file whose shebang resolves to nothing,
# and the failure lands as exec 126 at DMG time rather than here. So the gate
# is "does it run", not "does it exist", and a venv that fails it is rebuilt.
if ! "$VENV_DMGBUILD" --help >/dev/null 2>&1; then
    if [ -e "$VENV" ]; then
        echo "==> Rebuilding unusable dmgbuild venv at $VENV" >&2
        rm -rf "$VENV"
    else
        echo "==> Bootstrapping dmgbuild $DMGBUILD_VERSION venv at $VENV" >&2
    fi
    python3 -m venv "$VENV" >&2
    "$VENV/bin/pip" install --quiet --upgrade pip >&2
    "$VENV/bin/pip" install --quiet "dmgbuild==$DMGBUILD_VERSION" >&2
fi

echo "$VENV_DMGBUILD"
