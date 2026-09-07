---
name: brief
description: Write the conversation's settled findings and decisions as a brief — the document that says what was found and what was decided before an implementable one exists. Triggered by "write a brief", "brief this", "make a brief of this". Sharpens nothing and opens nothing.
argument-hint: "[path]"
allowed-tools: Bash, Read, Write, Glob, Grep, AskUserQuestion
disallowed-tools: Task, Edit
---

## What this is

A **brief** is the first document of a piece of work: a formal statement of what was found and what was decided, written *before* an implementable document exists. It carries findings and decisions and no execution steps — the test of a brief is whether somebody could plan from it, not whether somebody could build from it.

This skill does **one** thing: it writes the conversation you are already in as a brief, against the skeleton beside it, to one path, and ends. The sharpening — the back and forth that settled what the work is — already happened in this conversation, and it is not this skill's to do again. What is yours is the writing down.

**Read the skeleton before writing.** It is `${CLAUDE_PLUGIN_ROOT}/skills/brief/brief-skeleton.md`, read with `Read`. It is the format contract, it says which sections may be omitted when they have nothing to say, and it is deliberately unlinted — nothing will catch a brief that ignores it, which is exactly why it gets read rather than remembered.

Carry this conversation's settled calls into the document: the decisions as `[B01]…`, the observations as `[F01]…`. A brief that restates the user's opening sentence has thrown away the thing it exists to preserve.

## Where it goes

Three addresses, in order. Take the first that applies.

1. **An explicit path** — in the invocation (`/tugplug:brief docs/the-thing-brief.md`) or named in the user's prose. It wins outright, and no setting is consulted. Somebody who names a path has already answered the question.
2. **An arc's own brief**, when the user says the brief is for a named arc: `tugtool arc documents <name> --ensure` prints a `brief` address, and that is the path.
3. **Otherwise the briefs directory**, which is a setting rather than a convention:

   ```bash
   tugtool brief dir --json
   ```

   Read `dir` and `exists`. When `exists` is true, write there — no dialog.

   When `exists` is **false**, ask once, with one `AskUserQuestion`: two options, **Create it** (naming the directory) and **Use a different directory** (the user types the path in the free-text row). On *Create it*, `tugtool brief dir --ensure`; on a path, write there. This is the only question this skill ever asks, and it is gated on the directory being absent, so it happens at most once per project.

**The filename** is a short kebab-case slug of the subject plus `.md` — `atom-copy-paste-fidelity-brief.md`, not `brief.md`. If that file already exists, say so and write `<slug>-2.md`; never overwrite a brief somebody already has.

## What it does not do

No sharpening of its own. No plan, no task list, no arc, no worktree, no commit. No second dialog, and no question about the format, the filename, or whether to go ahead. A brief is a document, and writing one is not a decision that needs confirming.

`tugtool plan lint` exits 2 on a brief — "not a plan document" — and that is correct rather than a failure: a brief is detected as a non-plan by having no execution-steps section.

## Hand off

Name the path you wrote and stop. What happens to the brief next — an arc opened on it by `/arc`, a spike, or nothing at all — is the user's call, and the document is what makes it theirs to make. Whether that arc walks a task list or devises a plan first is the door's decision, made from the brief's content when it is handed over; this skill does not pre-empt it, and the brief's Exit section names an arc rather than a plan for that reason.
