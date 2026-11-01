#!/usr/bin/env python3
"""Put the release notes on the published 0.8.x releases.

Each body is recomposed by release_body.py, the composer the release workflow
uses, keeping the commit line the release already has. Nothing but the body is
edited, so assets, titles and tags stay as they are, and a release whose body
already matches is left alone, which makes a second run safe.

Without --apply it prints what each release would become and writes nothing.
Publishing is a person's act, after reading the notes.

Usage: backfill-release-notes.py [--apply] [version...]
"""

import argparse
import subprocess
import sys

# release.py is imported from beside this file, and importing it must not leave
# a __pycache__ behind in the tree.
sys.dont_write_bytecode = True

import release  # noqa: E402
import release_body  # noqa: E402

SERIES = "v0.8."


def plan(tag):
    """(the body now, the body it should be) for one release."""
    body = release.read(["gh", "release", "view", tag, "--json", "body", "--jq", ".body"])
    if body is None:
        release.refuse(f"could not read the {tag} release")
    built = release.BUILT_FROM.search(body)
    if not built:
        release.refuse(f"{tag} has no 'Built from commit' line, so it cannot keep one")
    composed = release_body.compose(tag[1:], built.group(1))
    found = release.BUILT_FROM.search(composed)
    if not found or found.group(1) != built.group(1):
        release.refuse(f"the body composed for {tag} would lose its commit line")
    return body, composed


def main():
    parser = argparse.ArgumentParser(description="Put the release notes on published releases.")
    parser.add_argument("--apply", action="store_true", help="write to GitHub; without it, a dry run")
    parser.add_argument("versions", nargs="*", metavar="version")
    args = parser.parse_args()

    tags = release.release_tags()
    if not tags:
        release.refuse("no v<version> tags on origin")
    if args.versions:
        chosen = [f"v{version}" for version in args.versions]
    else:
        chosen = sorted((t for t in tags if t.startswith(SERIES)), key=release.tag_order)

    # Every release is read and composed before any is written, so one that
    # cannot be composed stops the run with nothing half done.
    plans = [(tag, *plan(tag)) for tag in chosen]

    changed = 0
    for tag, body, composed in plans:
        if body.strip() == composed.strip():
            release.say(f"=== {tag}: already up to date")
            continue
        changed += 1
        if args.apply:
            release.say(f"=== {tag}: writing")
            subprocess.run(
                ["gh", "release", "edit", tag, "--notes-file", "-"],
                cwd=release.REPO_ROOT, input=composed, text=True, check=True,
            )
        else:
            release.say(f"=== {tag}: would become")
            release.say(composed)
    verb = "written" if args.apply else "would change"
    release.say(f"{len(plans)} releases read, {changed} {verb}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
