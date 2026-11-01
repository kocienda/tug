#!/usr/bin/env python3
"""Redraft the notes of versions already released, from what each one shipped.

The release script drafts one version, the next one, from the commits since the
last release. This drafts any version already out, over the range its release
actually covers: from the commit the previous release was built from to the
commit this one was built from, both read from the `Built from commit` line in
the release bodies, because a tag is not always the commit its run checked out
(see previous_release in release.py). The prompt and the call are release.py's,
so the model is tool-less here too and the script writes every file.

The drafts go to --out, never over release-notes/ unasked: a redraft is compared
against what the file already says before any of it lands.

Usage: redraft-release-notes.py --out <dir> [--dry-run] <version>...
"""

import argparse
import re
import sys
from pathlib import Path

# release.py is imported from beside this file, and importing it must not leave
# a __pycache__ behind in the tree.
sys.dont_write_bytecode = True

import release  # noqa: E402

# Past this many bytes of log, one call gets each commit's opening instead of
# all of it. A join message opens with its summary, so that is the part worth
# keeping, and the limit is set so only a very large release is ever cut.
LOG_LIMIT = 250_000

TRAILER = re.compile(r"^(Tug-Session|Tug-Session-Id|Tug-Arc|Co-Authored-By): ", re.I)


def strip_trailers(commit):
    """One commit's text without the lines that only say which session wrote it."""
    lines = [line for line in commit.splitlines() if not TRAILER.match(line)]
    return "\n".join(lines).strip()


def opening(commit):
    """The subject and the first paragraph of the body."""
    subject, _, body = commit.partition("\n")
    first = body.strip().split("\n\n")[0]
    return f"{subject}\n{first}".strip()


def fit_log(commits, limit=LOG_LIMIT):
    """The log for one call, and how much of each commit it kept: whole commits
    if they fit, else openings, else subjects."""
    for shape, cut in (
        ("whole", lambda c: c),
        ("openings", opening),
        ("subjects", lambda c: c.partition("\n")[0]),
    ):
        log = "\n\n".join(cut(c) for c in commits)
        if len(log.encode()) <= limit:
            return log, shape
    return log, shape


def built_sha(tag):
    sha = release.built_from(tag)
    if sha is None:
        release.refuse(f"{tag} has no 'Built from commit' in its body that this checkout holds")
    return sha


def commits_between(start, end):
    """The commits in start..end, each its subject and body, trailers gone."""
    out = release.read(["git", "log", "--format=%s%n%b%x00", f"{start}..{end}"])
    if out is None:
        release.refuse(f"could not read the log for {start[:9]}..{end[:9]}")
    return [c for c in (strip_trailers(part) for part in out.split("\0")) if c]


def redraft(version, previous_tag, out_dir, dry_run):
    tag = f"v{version}"
    start, end = built_sha(previous_tag), built_sha(tag)
    commits = commits_between(start, end)
    if not commits:
        release.refuse(f"nothing in {previous_tag}..{tag} ({start[:9]}..{end[:9]})")
    log, shape = fit_log(commits)
    release.say(f"{version}: {len(commits)} commits in {previous_tag}..{tag} "
                f"({start[:9]}..{end[:9]}), {len(log.encode()):,} bytes of log, {shape}")
    if dry_run:
        return

    prompt = release.compose_prompt(version, [], f"{previous_tag}..{tag}", log)
    proc = release.ask_for_notes(prompt)
    if proc.returncode != 0:
        release.refuse(f"claude exited {proc.returncode} on {version}: {proc.stderr.strip()[:400]}")
    draft = proc.stdout.strip()
    if not draft:
        release.refuse(f"the model returned nothing for {version}")
    path = out_dir / f"{version}.md"
    path.write_text(f"# Tug {version}\n\n{draft}\n")
    release.say(f"  Wrote {path}")


def main():
    parser = argparse.ArgumentParser(description="Redraft the notes of released versions.")
    parser.add_argument("--out", type=Path, required=True, help="directory the drafts are written to")
    parser.add_argument("--dry-run", action="store_true", help="print each range and ask no model")
    parser.add_argument("versions", nargs="+", metavar="version")
    args = parser.parse_args()

    tags = release.release_tags()
    if not tags:
        release.refuse("no v<version> tags on origin")
    order = sorted(tags, key=release.tag_order)

    args.out.mkdir(parents=True, exist_ok=True)
    for version in args.versions:
        tag = f"v{version}"
        if tag not in order:
            release.refuse(f"{tag} is not a release on origin")
        at = order.index(tag)
        if at == 0:
            release.refuse(f"{tag} is the first release, so it has no range to read")
        redraft(version, order[at - 1], args.out, args.dry_run)
    return 0


if __name__ == "__main__":
    sys.exit(main())
