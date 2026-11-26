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

No sharpening of its own. No plan, no task list, no arc, no worktree, and no file beside the brief: the sketch and the cycle it writes live in the app's own store, outside the project. No second dialog, and no question about the format, the filename, or whether to go ahead. A brief is a document, and writing one is not a decision that needs confirming — and neither is landing it, which is why the commit below asks nothing either.

`tugtool plan lint` exits 2 on a brief — "not a plan document" — and that is correct rather than a failure: a brief is detected as a non-plan by having no execution-steps section.

## Put it on a cycle

A **cycle** is the record of a run of related work: lettered **sketches**, which say where it came from, and numbered **entries**, one brief each, which an arc carries once it opens. Every brief this skill writes is an entry on a cycle. The record lives in the app's own store, outside the project, so none of this touches the working tree, and the brief's commit below still carries the brief alone.

Do it after the brief is written and before it is committed, in three moves.

### 1. Record the conversation's sketch

The sketch is the conversation's converged shape, in the user's words. Read *The record of where the work came from* in `${CLAUDE_PLUGIN_ROOT}/doctrine/arc-work-doctrine.md` before writing one: it gives the shape exactly — the `# Sketch` heading, the want in one or two plain sentences, the approach and its three to six bullets, and a last `Source:` line naming this session's full uuid (`printenv TUG_SESSION_ID`) and the turns it came from, as `tugtool session show <uuid>` numbers them — and the list of things a sketch never carries.

Pipe it to the store on stdin. It is never written to a file in the project:

```bash
tugtool sketch record --json <<'SKETCH'
# Sketch

<the want>

<the approach>

- <a part, and what it does>

Source: session <uuid>, turns <a>–<b>
SKETCH
```

`data.id` is the sketch's id. On a later brief in the same conversation, record nothing new while the direction holds: the brief comes from the sketch already on the cycle. Where the shape of that same direction has grown, keep the rewrite as a new version under the same id with `tugtool sketch record --id <sketch> --json`. Where the conversation has turned in a new direction since that sketch, record a fresh one with no `--id`; it becomes the cycle's next letter.

### 2. Choose the cycle

Take the first that applies:

1. **A cycle the user named**, by its id, in this conversation.
2. **This session's most recent cycle in this checkout**: the first row of `tugtool cycle list --mine --json`.
3. **A new cycle**, named by the rule below from the sketch just recorded:

   ```bash
   tugtool cycle create --name "<name>" --json
   ```

   `data.id` is the cycle's id.

Then put the sketch on it, which on a new cycle makes it sketch A:

```bash
tugtool cycle add-sketch <cycle> <sketch> --json
```

`data.letter` is the sketch's letter. A sketch already on the cycle keeps the letter it has, so this is safe to run every time.

**The naming rule.** A cycle is named once, when it is created, from the opening sentence of its sketch A. The name is the thing the work changes, as a noun phrase of two to four words in sentence case. It has no verb, uses the sketch's own plain words, and keeps proper nouns. It never carries an arc name, kebab-case, an id, a date, the project's name, or the words "cycle" or "work". It is what a header and a sidebar row show, so it has to read at a glance as the subject.

| Sketch A opens… | Name | What it shows |
|---|---|---|
| "Set the words Liven draws in its pictures and movies in IBM Plex instead of Apple's system typeface…" | IBM Plex typeface | The subject is kept and the verb dropped |
| "Make dockets carry a whole run of work, from one conversation to many briefs landed in order…" | Dockets of many briefs | A later sketch B leaves the name alone |
| "Stop the end-of-arc check from re-running test suites over code that has not changed…" | Remembered test runs | The name comes from the sketch, not from an arc's name such as `verify-memo` |

**A later sketch never renames a cycle**: a name that moves while the cycle is on screen stops being the thing the user recognises. A cycle is renamed only by hand, when the user asks, with the name the user gave — `tugtool cycle rename <cycle> --name "<name>"` — and never on this skill's own judgment.

### 3. Add the entry

```bash
tugtool cycle add-entry <cycle> --brief <path> --from <letter> [--wait <n>]… [--note "<gate>"] --json
```

`<path>` is the brief you wrote, relative to the project root; `--from` is the letter of the sketch it came from. `data.n` is the entry's number.

Add a `--wait` for each earlier entry whose work must land before this one's, and a `--note` for a gate that is not an entry ("after you approve the spike") — **only when the conversation or the brief states it**. Never infer a wait from the files two briefs touch: a wait changes whether an entry reads as ready, and the order of the work is the user's statement to make.

**Cycle writes are bookkeeping, and they never stop the work.** If `tugtool sketch record` or any `tugtool cycle` verb refuses, say so in one sentence with its output and carry on: the brief is still committed and handed off. A brief without its cycle line can be put right by hand; a skill that stopped on one would lose the document the user asked for.

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

Name the path you wrote, the sha it landed as — the bare sha in backticks, `` `63de5762a` ``, never `commit 63de5762a` — and the entry it became, by number and cycle name ("entry 3 of *Dockets of many briefs*"), then print the command below, and stop. When a cycle write refused, say that instead of the entry. What happens to the brief next — an arc opened on it by `/arc`, a spike, or nothing at all — is the user's call, and the document is what makes it theirs to make. Whether that arc walks a task list or devises a plan first is the door's decision, made from the brief's content when it is handed over; this skill does not pre-empt it, and the brief's Exit section names an arc rather than a plan for that reason.

**The command goes last, on its own line, written as inline code:**

> `/arc <slug> @<path>`

where `<path>` is the file you just wrote and `<slug>` is that filename's stem with a trailing `-brief` removed — `briefs/one-door-brief.md` gives `one-door`. That is exactly the name `/arc` would derive from the path on its own, so printing it changes nothing about what the command does; what it buys is that the proposed name is **visible and editable before anything runs**, rather than something the door picks after the user has committed to the gesture.

**The backticks are load-bearing.** A command line inside them is one object — a thing to do, which a surface reading your reply can offer to run, copy, or hand somewhere else. The same characters in a fenced block are a sample of text being quoted, and the same characters bare are prose. Write one inline-code span holding the whole line and nothing else: no fence, no leading prompt character, no trailing punctuation inside the span.

Printing a line is not running one. The command is text in your reply until somebody sends it, which is the same promise the rest of this skill makes: the brief is written and landed, and what becomes of it is still the user's call.
