#!/usr/bin/env python3
"""Compose a GitHub release's body from a version's release notes.

One composer, so the release workflow and the backfill of older releases cannot
drift: the notes without their `# Tug x.y` heading (the release title says it),
a rule, the install lines, and the `Built from commit <sha>` line that
built_from() in release.py reads back. Missing or still-seeded notes yield the
body without them, because a missing changelog never blocks a release.

Usage: release_body.py <version> <sha>
"""

import sys
from pathlib import Path

# release.py is imported from beside this file, and importing it must not leave
# a __pycache__ behind in the tree.
sys.dont_write_bytecode = True

import release  # noqa: E402

NOTES_DIR = release.REPO_ROOT / "release-notes"

INSTALL_LINES = """\
To install, download `Tug.dmg`, open it, and drag Tug into your Applications folder.

Tug has an update feature built into the app, so there’s no need to come back here for new versions."""


def notes_for(version, notes_dir=NOTES_DIR):
    """The version's notes without their heading, or "" when there are none."""
    path = Path(notes_dir) / f"{version}.md"
    if not path.is_file():
        return ""
    text = path.read_text()
    if any(marker in text for marker in release.SEED_MARKERS):
        return ""
    return release.notes_prose(text)


def compose(version, sha, notes_dir=NOTES_DIR):
    tail = f"{INSTALL_LINES}\n\nBuilt from commit {sha}.\n"
    notes = notes_for(version, notes_dir)
    return f"{notes}\n\n---\n\n{tail}" if notes else tail


def main(argv):
    if len(argv) != 2:
        release.refuse("usage: release_body.py <version> <sha>")
    sys.stdout.write(compose(argv[0], argv[1]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
