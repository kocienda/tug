---
name: tripwire
description: Lay, revise, and shake down a tripwire — a standing condition on sessions that fires when a fact of the kind it names is recorded, runs your brief as one bounded session on the tripwire's own arc, and reports what it found. Never joins anything.
argument-hint: "[what to watch for, in a sentence]"
disable-model-invocation: true
allowed-tools: Bash, Read, Glob, Grep, AskUserQuestion
disallowed-tools: Task
---

## What this is

A **tripwire** is a standing condition on what sessions do. It sits on the machine doing nothing until a session records a **fact** of the kind it names — a shell command that failed, a refused edit, a test run that went red, a commit, a prompt. Then it fires: a **trip**. The trip runs the tripwire's probe if it has one, asks an AI only about what the probe could not settle, and ends with a **report** — the last words of the session's turn, kept on the row.

**Only facts the ledger records fire a tripwire — a `git commit` typed in a terminal records none.** The session ledger is the one place that knows what happened, which session it happened in, and which checkout that session was working in, so it is the one place a firing can be built from without guessing. Work done outside a Tug session is invisible to the whole facility, and that is the design rather than an oversight.

Your job here is to turn a sentence into a tripwire that will still be right in a month, and then to prove it fires. Everything rides `tugtool tripwire`; you author nothing else.

**Two things a tripwire never does, and they are not preferences.**

- **A tripwire never joins.** It may commit work on its own arc and it may say so in its report. Joining that work onto the base is the user's act, always. `arc join --resolve` is never a tripwire's to run, and never yours on a tripwire's behalf.
- **A tripwire never widens its own scope.** Where a tripwire watches is a decision somebody made, and quietly extending it is how a tripwire starts firing on work nobody meant it to see.

## The shape of a tripwire

```
tugtool tripwire lay <name> --on <trigger> --brief <text|@file>
                 --description <one sentence>
                 [--where <clause>]... [--scope <path>] [--probe <cmd>]
                 [--model <m>] [--permission-mode <mode>] [--preview]
                 [--max-seconds <n>] [--max-tool-calls <n>]
```

**`--on`** is the fact condition: `fact:<kind>`, where the kind is anything the session ledger records. The tripwire fires the moment a matching fact is written. **No kind is privileged.** A refused edit is one fact among many; the same door watches a red test run, a shell command that failed, a prompt that mentioned a subject, a commit, or a session that compacted.

The kinds the ledger records today, and the payload fields a `--where` can narrow on:

| kind | filed when | narrow on |
|---|---|---|
| `prompt` | the user submitted a prompt | `text` |
| `shell` | the model ran a shell command | `command`, `ok`, `exit_code`, `cwd` |
| `test_run` | a shell command's output read as a test run | `verdict`, `runner`, `passed`, `failed`, `skipped` |
| `edit_failed` | an edit program refused | `class`, `exit`, `files` |
| `commit` | a commit was made through the session | `sha`, `message`, `files`, `branch` |
| `session.spawned`, `session.resumed`, `session.closed`, `session.errored`, `session.reset`, `session.renamed` | the session's own lifecycle | |
| `session.compacted` | the session's context compacted | `trigger` |

**This table is a snapshot, not the vocabulary.** The ledger grows kinds as the product learns to record more, and `lay` refuses a kind it does not record, naming the ones it does — so the refusal is the current list, and it outranks this table. When the user's sentence names a condition none of the kinds can express, say so plainly rather than bending the nearest kind to fit — a tripwire on the wrong fact fires on the wrong things.

Pick the kind by asking what a session would have *recorded* when the thing happened. "Tell me when tests fail" is `fact:test_run --where verdict=failed`. "Tell me when a command dies" is `fact:shell --where ok=false`. "Tell me when something is committed onto main" is `fact:commit --where branch=main`. The cheapest tripwire to shake down is one on `fact:shell` or `fact:prompt`, because nearly every session files those.

**`--where`** narrows a fact by its payload, and repeats. `field=value` is exact, `field~=substr` is contains, `field^=prefix` is a prefix. A field the payload does not carry never matches — a clause you cannot spell is a tripwire that never fires, not a tripwire that fires on everything.

**`--brief`** is the whole of what the tripwire will be asked when it fires, and it is the only thing that tells the trip what to do. The session has hands from its first turn — it stands in the tripwire's own arc worktree and can write and commit there — so a brief may ask for a diagnosis, or for a change, or for both. What it must do is *say which*. "Say whether this failure is the tool's fault or the program's, and name the file. Do not fix anything" earns a report worth reading; "look at edit failures" earns a paraphrase of the event.

**Nothing the engine appends will tell the trip what to decide.** One rule is added after your brief and it is about where the answer goes, not what the answer is: *end your turn with a short report of what you found and what you did.* The brief is the whole of the instruction.

**A brief that says nothing is refused, at the lay and at the `--preview`.** A tripwire with no probe summons a model on every firing, so a placeholder brief is not merely useless — it is a model run per fact, answered by a paraphrase of the fact and nothing else. If the refusal fires, the repair is to write the question, never to pad the words.

**`--description` is the one sentence a person reads, and it is required.** The brief is addressed to the model and runs to hundreds of words; the description is addressed to whoever opens the Tripwires card and says what this tripwire does and when it will speak — "Says whether a refused edit was the tool's fault or the caller's". **It is the only thing about the tripwire the card shows**: the brief is not rendered there at all, behind no clamp and no tooltip, so a tripwire whose description merely restates its name is a row nobody can read. An empty or placeholder description is refused on the same footing as a placeholder brief. Write it in the third person, about the tripwire, and keep it to one sentence.

**`--scope`** confines the tripwire to facts recorded by sessions working in one checkout. Unscoped, it watches the whole machine — and `trip`, the shake-down gesture, **refuses an unscoped tripwire**, because a hand-fired trip has no checkout to stand in. A tripwire you intend to shake down wants a scope.

**`--probe`** is a command run before any model is summoned. **Exit 0 settles the trip for free** — no tokens, no session, nothing said. This is the single most valuable field on a tripwire: a probe turns "ask an AI every time" into "ask an AI about the residue", and an armed tripwire with a good probe is cheap enough to leave armed forever. It runs in the tripwire's own arc worktree, which is where the trip's session will stand, and never in the user's working checkout.

**`--model`** is the model a trip runs on; absent, the session default. **`--permission-mode`** is the mode the trip's one session runs under.

**`--max-seconds` and `--max-tool-calls` are what a trip costs at worst**, and both have defaults — 120 seconds and 30 tool calls — so a tripwire laid without thinking about them is still bounded. Past either, the engine interrupts the session, gives it a few seconds to end its turn, closes it, and fails the trip saying which cap it met. Raise them for a brief that asks for real work; lower them for one that asks a question a sentence answers. A trip with no ceiling was the first thing this facility got wrong: an unbounded session ground for ten minutes, committed nothing, and left no row explaining itself.

## How a trip runs

Worth knowing, because a brief is written against it:

**Every tripwire owns one arc**, named `tripwire-<name>`, made when the tripwire is laid and kept for as long as the tripwire stands. Before each trip the engine replays that arc onto its checkout's `HEAD`, so a trip always starts from the base as it is now and from whatever earlier trips of the same tripwire committed.

1. **The probe**, in that arc worktree, when the tripwire has one. Green settles the trip and nothing else happens.
2. **The session** — *one* session, in the same worktree, under the tripwire's permission mode, with hands from its first turn. It is handed the fact itself, the arc it is standing in, the probe's output when the probe failed, and the transcript of the session that recorded the fact. It answers the brief, commits on the arc if the brief asked for a change, and ends its turn.

**A trip ends by ending, not by running a verb.** There is no `resolve` and no `dismiss`. The report is the last words of the session's turn, read off the transcript by the engine; the rounds count is how many commits *this* trip added to the arc. Both sit on the row, and neither is a word the model chose to describe itself with.

**The four words a trip can stand in, and no others:** `running` while it works, `done` when it finished, `failed` when it could not, and `skipped` with a reason when it never ran. A trip that found nothing and a trip that found something are both `done` — what separates them is the report, which is the thing worth reading.

**A trip is bounded.** Past `max_seconds` or `max_tool_calls` the engine interrupts the session, waits a few seconds for the turn to end, closes it, and the trip is `failed` naming the cap it met. The transcript is kept either way, so a capped trip is still a trip you can open and read.

## The guards

Three, and they are the whole of what keeps a tripwire from firing on itself or on everything:

- **One live trip per tripwire.** A second matching fact while a trip is running is a `skipped` row whose reason says `busy`, written into the log so it is visible rather than mysterious.
- **A tripwire never fires on a fact its own trip's session recorded.** A trip's session runs shell commands and writes files like any other session, and every one of those is a fact; a tripwire that read its own session's facts would fire forever. The skip is silent, because a trip's own noise is not news.
- **Scope and `--where` decide which facts it sees at all.** Scope is a decision about coverage rather than a defense: it says which checkout's sessions this tripwire watches. Say what a scope covers and what it does not, and let the user choose it. Never widen one to make something fire.

## The flow

**1. Read the sentence for the fields.** Trigger, scope, probe, brief. Most sentences name two or three; the rest have defaults that are usually right. Do not interrogate — pick the conventional default, say which defaults you took, and let the user correct one.

The one thing worth asking about is the **probe**, and only when the user's sentence implies a check that a command could make. "Tell me when the build breaks" has a probe in it; "tell me when someone touches the auth code" does not. Asking "is there a command that answers this?" once is worth it, because it is the difference between a tripwire that costs nothing at rest and one that spends a session on every matching fact.

**2. Validate before you write.**

```
tugtool tripwire lay <name> … --preview
```

`--preview` parses everything and writes nothing: the normalized trigger, the scope as a canonical path, the probe, the permission mode. It is a **syntax** check, not a rehearsal — it cannot tell you whether any fact on this machine would ever match. Read what it echoes back and confirm the scope it resolved is the checkout you meant.

**3. Lay it, and report the receipt.**

```
tugtool tripwire lay <name> … --json
```

Report what came back — the name, the normalized trigger, the description, the scope, the probe, the permission mode — not a paraphrase. The receipt is the tripwire.

**4. Shake it down. This is not optional.**

```
tugtool tripwire trip <name>
```

`trip` fires the tripwire by hand, in the tripwire's own arc worktree replayed onto the scope's `HEAD`. It goes past the guards by construction, because a bench test that could be skipped as `busy` would test nothing. It needs **a running Tug** — the engine that runs trips lives in the app, and the verb posts to it rather than writing a row nothing would pick up — and **a `--scope`**, because a trip has to stand somewhere. It refuses by naming whichever is missing. It is the only way to find out what the tripwire actually does, since `--preview` only ever read the syntax. Run it, then read the log:

```
tugtool tripwire log <name>
```

The log carries every firing, including the ones that found nothing, and a `done` row prints its report and its rounds count beside it. That is the whole value of the log: a tripwire that fires ten times and says something worth reading once is working correctly, and this is the only place the other nine are visible. **Read the report and judge it as the user will**: does it name the thing, or does it describe the tripwire? A report that paraphrases the fact is a brief that needs rewriting, and that is one `edit` and one `trip` away.

**5. Revise in place.**

```
tugtool tripwire edit <name> [same flags] [--clear scope|probe|model]
```

Every flag is optional and what you do not name is left alone; `--clear` removes a field rather than setting it. A brief that earned a vague headline is the usual repair, and it is one `edit` and one `trip` away. The tripwire's log survives the edit, so the before and after sit next to each other. `--description` is editable here too, and it is the one field `--clear` refuses: a tripwire with no sentence saying what it does is a row on the card with nothing in it.

## The rest of the verbs

```
tugtool tripwire list [--json]        every tripwire on this machine
tugtool tripwire log <name> [--json]  one tripwire's trip log, the full workings
tugtool tripwire pause <name>         out of service, keeping the tripwire and its log
tugtool tripwire resume <name>        back into service
tugtool tripwire rm <name>            gone, with its log; refused while a trip runs
```

`pause` rather than `rm` for a tripwire that is misbehaving: the log is the evidence for the repair, and removing the tripwire throws it away.

The **Tripwires card** shows the same roster — each tripwire, a fixed-width mark for what it is doing, and its definition and trip log behind a fold that opens in place over the row. The fold leads with the description and never shows the brief. Its collapsed band carries the counts — armed, trips, running, paused — so the standing watches read at a glance without opening anything. **A trip that is running opens its own Session card**, bound to the trip's session, without taking the view from whatever the user is working in; the row's **Open session** raises that card rather than opening a second one. The card carries the rest of the verbs and the knobs too: Pause and Resume, Trip now, and Delete behind a confirm on the row's `⋯` menu, alongside the model knob. Deleting there is the same guarded removal `rm` performs, refused the same way while a trip runs.

## Judgement

**A tripwire is only worth laying if a person would want to be told.** The test is not "could an AI say something about this" — it always could. It is "would somebody stop what they are doing to hear it". A tripwire that raises its hand on every fact is a tripwire that gets ignored, and an ignored tripwire is worse than no tripwire because it costs tokens to be ignored.

**Prefer a probe to a brief wherever a command can answer the question.** A probe is free and deterministic; a session is neither.

**Name a tripwire for what it watches, not what it does.** `edits` and `ci` are addresses somebody will still recognize in a month; `check-for-problems` is not.

**Write the brief for the reader of the headline.** One sentence, naming the file or the command or the commit exactly. The person reading it saw none of what the tripwire saw.

## What this skill does not do

It does not join, land, or merge anything — what a tripwire committed on its arc is the user's to accept or discard through the ordinary arc gestures. It does not author project configuration. It does not decide that a tripwire ought to exist: the user asked for one, or they did not.
