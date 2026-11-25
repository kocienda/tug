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

No sharpening of its own. No plan, no task list, no arc, no worktree. No second dialog, and no question about the format, the filename, or whether to go ahead. A brief is a document, and writing one is not a decision that needs confirming — and neither is landing it, which is why the commit below asks nothing either.

`tugtool plan lint` exits 2 on a brief — "not a plan document" — and that is correct rather than a failure: a brief is detected as a non-plan by having no execution-steps section.

## Land it

**Commit the brief before you present it.** This is the last act before the hand-off, and it is not optional: a brief left uncommitted straggles in the working tree, and an arc opened on it forks from the base's last commit — so the worktree the arc walks on does not have the document the arc was opened on. The user forgets this step far more often than they mean to, which is why the skill does it rather than reminding them.

The commit is one command, scoped to exactly the file you wrote and nothing else:

```bash
tugtool commit --paths <path> --message "briefs(<slug>): Add brief for <what it decides, imperative, under 50 chars>"
```

where `<slug>` is the filename's stem with a trailing `-brief` removed — the same slug the hand-off command below prints. The subject is the whole message; `tugtool commit` adds the session trailers itself, and there is no body, no `Co-Authored-By`, and no mention of AI or agents. `--paths` is what keeps this honest: the user's own inflight edits in the tree are never swept into a brief's commit, and nothing here runs raw `git`.

This works in **any** project, not only one that has arranged for it. The command is the bundle's own verb, the plugin's hook approves it, and an explicit `--paths` commit consults no session ledger — so a project with no `CLAUDE.md`, no settings, and no live session lands the brief exactly the same way. Nothing in a project's instructions is needed to permit it, and a project instruction saying the model never commits is about the project's code; the brief the user just asked for is the one file this skill is trusted to land.

**Two cases skip the commit, and you say which in the report.** An arc's own brief (address 2) lives under `.tug/arcs/<name>/`, which is never tracked, so there is nothing to commit. And an explicit path that lands outside the project's checkout cannot be committed to it. In every other case — the briefs directory, or an explicit path inside the checkout — the commit runs.

If `tugtool commit` fails, say so with its output and still hand off; a written brief with a failed commit is a brief the user can land by hand, and a swallowed failure is the straggler this section exists to prevent.

## Hand off

Name the path you wrote and the sha it landed as — the bare sha in backticks, `` `63de5762a` ``, never `commit 63de5762a` — print the command below, and stop. What happens to the brief next — an arc opened on it by `/arc`, a spike, or nothing at all — is the user's call, and the document is what makes it theirs to make. Whether that arc walks a task list or devises a plan first is the door's decision, made from the brief's content when it is handed over; this skill does not pre-empt it, and the brief's Exit section names an arc rather than a plan for that reason.

**The command goes last, on its own line, written as inline code:**

> `/arc <slug> @<path>`

where `<path>` is the file you just wrote and `<slug>` is that filename's stem with a trailing `-brief` removed — `briefs/one-door-brief.md` gives `one-door`. That is exactly the name `/arc` would derive from the path on its own, so printing it changes nothing about what the command does; what it buys is that the proposed name is **visible and editable before anything runs**, rather than something the door picks after the user has committed to the gesture.

**The backticks are load-bearing.** A command line inside them is one object — a thing to do, which a surface reading your reply can offer to run, copy, or hand somewhere else. The same characters in a fenced block are a sample of text being quoted, and the same characters bare are prose. Write one inline-code span holding the whole line and nothing else: no fence, no leading prompt character, no trailing punctuation inside the span.

Printing a line is not running one. The command is text in your reply until somebody sends it, which is the same promise the rest of this skill makes: the brief is written and landed, and what becomes of it is still the user's call.
