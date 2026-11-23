---
name: keep-sketch
description: Keep the conversation an idea was sketched in as that idea's sketch — the short record of what is wanted and the shape the work will take — so a brief can be written from it later. Opened by the Docket card's Keep sketch gesture. Writes no file in the project and commits nothing.
argument-hint: "<idea-id>"
disable-model-invocation: true
allowed-tools: Bash, Read, Write
disallowed-tools: Task, Edit
---

## What this is

An **idea** is one line on a docket, with an optional body. When the user sketches it — talks it through with the model in a session — that conversation converges on a shape, and the shape lives in the transcript only. This skill keeps it: it writes the converged shape as the idea's **sketch**, in the one shape every sketch has, and keeps it as a version with `tugtool sketch keep`. The first keep mints the sketch's id; every keep after adds a version.

It is opened by the Docket card's **Keep sketch** gesture, usually in a fresh session that holds none of the conversation. So the conversation is read from disk, never remembered.

**Read the shape before writing.** It is in the arc doctrine, under *The record of where the work came from*: `${CLAUDE_PLUGIN_ROOT}/doctrine/arc-work-doctrine.md`, read with `Read`. The sketch is exactly that record — what is wanted in one or two plain sentences, then the shape of the work in one sentence and three to six short bullets, then a last `Source:` line — and the doctrine's test for reading it back is this skill's test too.

## Input

`/tugplug:keep-sketch <idea-id>` — the idea's id, eight hex characters.

## The flow

1. **Read the idea.**

   ```bash
   tugtool idea show <idea-id> --json
   ```

   Read `text` (its line), `body` when present, `sketch` (the sketch already kept from it, with its latest `version`, when there is one) and `sessions` (each `{uuid, at}` the idea was sketched in). It exits 3 when the idea is not on this machine: say so and stop.

2. **Find the source.** The source is the **newest** entry of `sessions` by `at`. With no sessions, say that the idea has not been sketched in any session, so there is no conversation to keep a sketch from, and stop: write nothing and keep nothing. A sketch is never composed from the idea's line alone.

3. **Read the source's turns.** When `printenv TUG_SESSION_ID` is the source's uuid, this session is the conversation, and you write from it. Otherwise read it from disk, read-only:

   ```bash
   tugtool session show <uuid>
   ```

   Read the header first for the turn count, then narrow with `--last`, `--turn` or `--grep` rather than pulling the whole transcript. `show` exits 3 when the session is not on this machine: say so and stop. Take the turn numbers for the `Source:` line from what `show` prints.

4. **Write the sketch** to `${TMPDIR:-/tmp}/keep-sketch-<idea-id>.md`, in the doctrine's shape, for the user to read on a panel: in their words, with no paths, identifiers or labels, and no mention of the conversation. Its last line is `Source: session <uuid>, turns <n–m>` with the full uuid. When the idea already has a sketch, read its latest text with `tugtool sketch show <id>` first and keep what the conversation did not change. Read it back against the doctrine's test, and rewrite it rather than trim it if it fails.

5. **Keep it.**

   ```bash
   tugtool sketch keep --idea <idea-id> --file "${TMPDIR:-/tmp}/keep-sketch-<idea-id>.md" --json
   ```

   It refuses a text with no `Source:` line, and it keeps nothing when the text is byte-identical to the latest version. A sketch an open arc holds has its `sketch.md` rewritten to match.

6. **Report** the sketch's id and the version kept, in one sentence, and stop. What happens next — Edit Sketch, Write brief — is the user's gesture on the card.

## What it does not do

No brief, no arc, no file in the project, no commit, and no question. A sketch is a record, and keeping one is not a decision that needs confirming. Every version stays kept, so a version the user wrote by hand is never lost: the user pressed Keep sketch, and the new version is kept above theirs. When the latest version's author is `user` (`tugtool sketch show <id> --json`, the latest entry of `versions`), start from their text and change only what the conversation since changed, and say in the report that their version is the one before it.
