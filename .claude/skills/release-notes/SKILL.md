---
name: release-notes
description: Draft release-notes/<current version>.md from the commits since the last release, for the person to edit and confirm — the seed that version-bump leaves is never written from scratch
argument-hint: "[anything to emphasise or leave out]"
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
disallowed-tools: Task
---

## What this is

`release-notes` writes the **first draft** of the current version's release notes. `just version-bump` seeds `release-notes/<version>.md` with a heading and an instructional comment, `just bless` refuses to release while that comment is still there, and this skill is what fills the space between: it reads what landed since the last release and writes the notes a person then edits and confirms with `just release-notes`.

The draft is a draft. The person's edit is the notes.

## The reader

The file is embedded in the Sparkle appcast and rendered in the update popover, in front of someone who **does not read this repository**. Write for them:

- A few sentences or a short list about what changed for *them* — what they can now do, what stopped being annoying, what looks different. Not what was refactored.
- No file paths, no crate names, no arc names, no `[B##]`/`[L##]` citations, no commit shas. If a sentence only makes sense to someone who has seen the code, cut it.
- Plain markdown the deck's renderer handles: paragraphs, a `##` or two if there is enough to group, a list, `inline code` for a command or a key. Nothing clever.
- Short. The popover is a pane, not a page. Ten lines is a lot.

## The flow

1. **Find the file.** `VERSION="$(tugrust/scripts/version.sh show)"`; the target is `release-notes/$VERSION.md`. If it does not exist, say that `just version-bump` seeds it and stop. If it exists and is **not** the seed — no `Delete this comment` line, prose outside the heading — someone has already written it. Leave it alone and say so; `/release-notes rewrite` is the only thing that overwrites written notes.

2. **Find the range.** The previous release is the newest `v*` tag on the remote: `git ls-remote --tags origin 'refs/tags/v*' | sed 's|.*refs/tags/||' | sort -V | tail -1`. The range is `<that tag>..HEAD`. If there is no tag, use the commit that set the previous version — `git log --format=%h -S'version = "<prev>"' -- tugrust/Cargo.toml | tail -1`, where `<prev>` is the newest other file in `release-notes/` — and if there is none of that either, this is the first release: skip the log and write what Tug *is*.

3. **Read the range.** `git log --format='%s%n%b' <range>` — subjects and bodies. The bodies are where the reader-facing sentence usually already is: the join messages on `main` open with a summary paragraph written for someone who never saw the work. Group what you find by what it means to the person using the app; drop everything internal (tests, laws, briefs, refactors, tooling that only this repo uses). If an argument was given, weight it — `/release-notes emphasise the update pill` or `/release-notes leave out the arc changes`.

4. **Write the file.** Keep the `# Tug <version>` heading. Replace the seeded comment with the draft. Nothing else in the file.

5. **Hand it over.** Say, in two lines, that the draft is in place and that `just release-notes` opens it to edit — then `just bless`. Do not run either.

## Guardrails

- **Never overwrite written notes** without `rewrite` in the arguments.
- **Never commit.** The person commits the notes they confirmed.
- **Never invent a change.** If the range is empty or the log is unreadable, say so rather than writing something plausible.
