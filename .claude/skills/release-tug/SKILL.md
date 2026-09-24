---
name: release-tug
description: Cut a Tug release from one command — bump the version, draft the release notes, author the landing draft; then land, push and ship from the window
argument-hint: "[major|minor|patch] [anything to emphasise or leave out]"
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
disallowed-tools: Task
---

## What this is

Cutting a release used to be seven typed things in a row: `just version-bump patch`, `/write-release-notes`, `just release-notes` to edit them, `git add` and `git commit`, `git push`, `just bless`, `just release`. `/release-tug` folds the mechanical ones into this skill — the bump, the notes draft, and the landing draft that names what the release is — and stops there. What remains is the four acts that are actually yours, and each is a gesture in the window rather than a line in a shell: `/commit` to land, `/push` to send it, the notes editor in the Changes shade to say it better, and `/release` to ship. Nothing after this skill is typed into a terminal.

This skill is Tug's alone. It reads `tugrust/scripts/version.sh`, `release-notes/`, and this repository's remote, none of which exists in a project Tug.app is merely opened on — so it lives here in `.claude/skills/` and is never plugin material.

## Arguments

`/release-tug [major|minor|patch] [anything to emphasise or leave out]`

The first word, when it is exactly `major`, `minor` or `patch`, is the component to bump; the default is `patch`. Everything else is the notes emphasis and is passed through to the notes step verbatim — `/release-tug minor emphasise the release sheet`, `/release-tug leave out the arc changes`.

## Preconditions

A release is cut from `main`: the Release sheet dispatches `release.yml --ref main`, and `just bless` fails any other branch. So `git rev-parse --abbrev-ref HEAD` must print `main`; if it prints anything else, say which branch it is on and that a release is cut from `main`, and stop. Do nothing else.

A dirty tree is fine and expected — the landing draft's default selection is the files the bump receipts, so other work in the tree is simply not elected.

## The state

Before anything is written, find out where the last release got to. Run this probe verbatim:

```bash
VERSION="$(tugrust/scripts/version.sh show)"
NOTES="release-notes/$VERSION.md"
TAG_ERR="$(gh api "repos/{owner}/{repo}/git/ref/tags/v$VERSION" 2>&1 >/dev/null)"; TAG_RC=$?
if [ "$TAG_RC" -eq 0 ]; then TAG=present
elif printf '%s' "$TAG_ERR" | grep -q "HTTP 404"; then TAG=absent
else echo "cannot reach origin: $TAG_ERR" >&2; exit 2; fi
if [ "$TAG" = present ]; then echo shipped
elif [ ! -f "$NOTES" ] || grep -q "Delete this comment" "$NOTES"; then echo bump-abandoned
else echo in-flight; fi
```

It prints exactly one word, and that word decides the rest:

- **`shipped`** — the current version has a `v<version>` tag on origin, so the last release went out. Bump, then write the notes, then write the draft.
- **`bump-abandoned`** — no tag, and the notes file is missing or still carries `version.sh`'s seed comment. A bump happened and was abandoned. **Do not bump again.** Write the notes for the version that is already set, then the draft.
- **`in-flight`** — no tag, notes written. The release is in flight. Say so, name the gestures that finish it (`/commit` if the tree still holds it, then `/push`, then `/release`), and **do nothing at all**.

A probe that exits 2 could not reach origin. Say "cannot reach origin" with what `gh` reported, and stop. An unreachable remote means the tag state is *unknown*, and a skill that guessed "absent" there would bump a version that had never shipped.

## The bump

Only on `shipped`. The component is the argument's first word, `patch` by default.

```bash
tugtool file run -- tugrust/scripts/version.sh bump patch
```

`file run` is what makes the bump attributable: the script rewrites files it did not name on its command line, so nothing could read which ones moved, and `file run` fingerprints the tracked tree before and after and receipts exactly what did. Read the `TUG-FILE-RECEIPT` line and confirm six paths:

- `tugrust/Cargo.toml`
- `tugcode/package.json`
- `tugdeck/package.json`
- `tugapp/Info.plist`
- `tugrust/Cargo.lock`
- `release-notes/<new version>.md` (seeded)

If the receipt reports no session, say the bump landed **unattributed** and that `/commit` will need those six files elected by hand — the draft's default selection is the receipted set, and there is no receipted set without a session.

On **`bump-abandoned` with a missing notes file**, there is no bump to do but there is a file to seed, and it should be receipted like any other:

```bash
tugtool file run -- tugrust/scripts/version.sh set "$VERSION"
```

That rewrites the same version — no diff in the five — and seeds the notes file, so the seed is attributed.

## The notes

The notes doctrine lives in one place and is read rather than invoked, so the two doors cannot drift.

`Read` `.claude/skills/write-release-notes/SKILL.md` and follow it as a document: its **The reader** section in full, and **The flow** steps 2, 3 and 4. Two substitutions:

- Its step 1 is already done — the probe above found the file and decided the state, which is the same question asked better.
- Its step 2 finds the previous tag with `git ls-remote`. Use `gh` instead, for the same reason the probe does:

  ```bash
  gh api 'repos/{owner}/{repo}/git/matching-refs/tags/v' --jq '.[].ref' | sed 's|refs/tags/||' | sort -V | tail -1
  ```

Apply the emphasis argument when there is one, exactly as that skill's step 3 describes. Both of its guardrails hold here unchanged: **never overwrite written notes** unless the arguments say `rewrite`, and **never invent a change** for an empty or unreadable range — say so instead.

## The draft

The landing draft is what the Changes shade offers when `/commit` is typed, so it is the release's commit message. Write it in the subject style the last bumps used — `tugarc(<version>): <what this release is>`, the subject drawn from the notes' first sentence — with a two-line body drawn from the notes:

```bash
tugtool draft set --owner session --message "$(printf 'tugarc(%s): %s\n\n%s' "$NEW" "$SUBJECT" "$BODY")"
```

No `--include`. The selection is the six files the bump receipted, which is exactly the release and nothing else in the tree.

## Hand-off

End the turn here, on these lines:

- The six files are in the Changes shade — review them there.
- Edit the notes in the shade if you want to say it better.
- `/commit` to land them.
- `/push` to send `main` to origin.
- `/release` to ship.

## Guardrails

- **Never commit and never push.** Landing is the user's act, through `/commit` and `/push`.
- **Never run `just bless` or `just release`, and never dispatch anything.** The Release sheet checks and dispatches, behind `/release`.
- **Never write a notes file that is already written** without `rewrite` in the arguments.
- **Never guess at origin.** A tag read that is neither a clean answer nor an HTTP 404 is unknown, and the skill stops.
- **Never touch `tugplug/`.** This skill is project-scoped and the plugin is not where anything Tug-specific goes.
