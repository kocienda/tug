---
name: tripwire
description: Lay, revise, and shake down a tripwire — a standing condition on sessions that fires when a fact of the kind it names is recorded, runs your brief in a disposable checkout at HEAD, and raises its hand only when it has something a person should see. Never joins anything.
argument-hint: "[what to watch for, in a sentence]"
disable-model-invocation: true
allowed-tools: Bash, Read, Glob, Grep, AskUserQuestion
disallowed-tools: Task
---

## What this is

A **tripwire** is a standing condition on what sessions do. It sits on the machine doing nothing until a session records a **fact** of the kind it names — a shell command that failed, a refused edit, a test run that went red, a commit, a prompt. Then it fires: a **trip**. The trip runs the tripwire's probe if it has one, asks an AI only about what the probe could not settle, and either goes quiet or raises its hand with one line the user should read.

**Only facts the ledger records fire a tripwire — a `git commit` typed in a terminal records none.** The session ledger is the one place that knows what happened, which session it happened in, and which checkout that session was working in, so it is the one place a firing can be built from without guessing. Work done outside a Tug session is invisible to the whole facility, and that is the design rather than an oversight.

Your job here is to turn a sentence into a tripwire that will still be right in a month, and then to prove it fires. Everything rides `tugtool tripwire`; you author nothing else.

**Two things a tripwire never does, and they are not preferences.**

- **A tripwire never joins.** It may author work on an arc and it may say so. Joining that work onto the base is the user's act, always. `arc join --resolve` is never a tripwire's to run, and never yours on a tripwire's behalf.
- **A tripwire never widens its own scope.** Where a tripwire watches is a decision somebody made, and quietly extending it is how a tripwire starts firing on work nobody meant it to see.

## The shape of a tripwire

```
tugtool tripwire lay <name> --on <trigger> --brief <text|@file>
                 --description <one sentence>
                 [--where <clause>]... [--scope <path>] [--probe <cmd>]
                 [--model <m>] [--permission-mode <mode>] [--preview]
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

**`--brief`** is the whole of what the tripwire will be asked when it fires. **Write it as a question, not an instruction**, because the session that answers it cannot act: it runs read-only, and the only thing it can do with "fix the retry logic" is describe having wanted to. "Say whether this failure is the tool's fault or the program's, and name the file" earns a useful headline; "look at edit failures" earns a paraphrase of the event; "fix the parser" earns a session explaining that it could not.

If the change is worth making, the brief can say so — the session has a verb for asking that work be authored, and a second session with hands is spawned for it. What the brief must not do is assume the first one has them.

**A brief that says nothing is refused, at the lay and at the `--preview`.** A tripwire with no probe summons a model on every firing, so a placeholder brief is not merely useless — it is a model run per fact, answered by a paraphrase of the fact and nothing else. If the refusal fires, the repair is to write the question, never to pad the words.

**`--description` is the one sentence a person reads, and it is required.** The brief is addressed to the model and runs to hundreds of words; the description is addressed to whoever opens the Tripwires card and says what this tripwire does and when it will speak — "Says whether a refused edit was the tool's fault or the caller's". **It is the only thing about the tripwire the card shows**: the brief is not rendered there at all, behind no clamp and no tooltip, so a tripwire whose description merely restates its name is a row nobody can read. An empty or placeholder description is refused on the same footing as a placeholder brief. Write it in the third person, about the tripwire, and keep it to one sentence.

**`--scope`** confines the tripwire to facts recorded by sessions working in one checkout. Unscoped, it watches the whole machine — and `trip`, the shake-down gesture, **refuses an unscoped tripwire**, because a hand-fired trip has no checkout to stand in. A tripwire you intend to shake down wants a scope.

**`--probe`** is a command run before any model is summoned. **Exit 0 settles the trip for free** — no tokens, no session, nothing said. This is the single most valuable field on a tripwire: a probe turns "ask an AI every time" into "ask an AI about the residue", and an armed tripwire with a good probe is cheap enough to leave armed forever. It runs in the trip's **disposable checkout at `HEAD`**, never in the user's working checkout and never in an arc worktree, so it can touch nothing that outlives the trip.

**`--model`** is the model a trip runs on; absent, the session default. **`--permission-mode`** is the mode for the *authoring* session only — the diagnosing one is read-only whatever you pass, enforced by the runtime rather than asked for in prose.

## How a trip runs

Worth knowing, because a brief is written against it:

1. **The probe**, in a disposable checkout of the fact's repository at `HEAD` — the last commit the user made when the fact arrived. Green settles the trip and nothing else happens.
2. **Diagnosis** — one session in that same disposable checkout, read-only, handed everything it needs: the fact itself, the tree it is standing in, a file holding whatever was uncommitted in the user's checkout at that moment, the probe's output when the probe failed, and the transcript of the session that recorded the fact. It answers the brief and ends by resolving.
3. **Authoring**, only if the diagnosis asked for it — a second session on an arc worktree of its own, with the tripwire's permission mode, which can write and commit. The user joins that arc or discards it; the tripwire never does.

The tree is cut at `HEAD` and the uncommitted work travels **beside** it as a diff file rather than in it, so the checkout the trip stands in is always a commit that exists, and the half the user had not committed is still there to read.

Two of a trip's three endings are verbs:

```
tugtool tripwire resolve <name> --quiet
tugtool tripwire resolve <name> --awaiting --headline "<one line>" [--author "<what to change>"]
tugtool tripwire dismiss <name>
```

`--quiet` is "nothing here anybody needs to see" and is the ordinary outcome — a tripwire fires on a pattern, and the pattern occurring is usually not news. `--awaiting` is the tripwire raising its hand: the headline is the one line the Tripwires row shows, and the trip **holds** — it keeps the tripwire's one-run slot and stays on the surface — until the user has seen it. `dismiss` settles an awaiting trip by hand and discards the arc it was holding.

**The third ending is not a verb: adoption.** Open a running trip's session from the card and the deck takes it over — the engine stops watching, the trip reads `adopted`, and the session is still alive and may still run the resolution verb, which settles the trip from there. An adopted trip deliberately does **not** hold the tripwire's one-run slot, so the tripwire may fire again while the user works in the session it handed over.

**An awaiting trip is held until it is answered, and nothing on a clock answers it.** A trip that authored an arc is released by that arc's fate: joining or discarding it answers the question the tripwire asked, and the engine notices on its own. A trip that authored none is released by a **Seen** act on the card, which runs `dismiss` with nothing to discard. Those are the two releases, and a question a timeout retired would be a question nobody was asked.

**Raising a hand posts once, and quiet posts nothing.** An awaiting resolution drops a single pointer post in the Overview naming the tripwire and its headline; a quiet one says nothing anywhere except in the trip log. There is no knob for this and no "post everything while I shake it down" mode — the log is where a tripwire under test is read.

## The guards

Three, and they are the whole of what keeps a tripwire from firing on itself or on everything:

- **One live trip per tripwire.** A second matching fact while a trip is running is a `skipped` row whose reason says `busy`, written into the log so it is visible rather than mysterious.
- **A tripwire never fires on a fact its own trip's session recorded.** The diagnosis and authoring sessions run shell commands and write files like any other session, and every one of those is a fact; a tripwire that read its own session's facts would fire forever. The skip is silent, because a trip's own noise is not news.
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

`trip` fires the tripwire by hand, in a disposable checkout at the scope's `HEAD`. It goes past the guards by construction, because a bench test that could be skipped as `busy` would test nothing. It needs **a running Tug** — the engine that runs trips lives in the app, and the verb posts to it rather than writing a row nothing would pick up — and **a `--scope`**, because a trip has to stand somewhere. It refuses by naming whichever is missing. It is the only way to find out what the tripwire actually does, since `--preview` only ever read the syntax. Run it, then read the log:

```
tugtool tripwire log <name>
```

The log carries every firing, including the ones that said nothing. Six words, and no others: `running` while it works, `quiet` when it found nothing to report, `awaiting` when it is holding a headline for the user, `adopted` when somebody took its session over, `failed` when it could not finish, and `skipped` with a reason when it never ran. That is the whole value of the log: a tripwire that fires ten times and raises its hand once is working correctly, and this is the only place the other nine are visible. Read the headline the tripwire produced and judge it as the user will: does it name the thing, or does it describe the tripwire?

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

The **Tripwires card** shows the same roster — each tripwire, a fixed-width mark for what it is doing, and its definition and trip log behind a fold that opens in place over the row. The fold leads with the description and never shows the brief. Its collapsed band carries the counts — armed, trips, running, awaiting, paused — so the standing watches read at a glance without opening anything. The card carries the verbs as well as the knobs: Pause and Resume, Trip now, **Open session**, which opens the session of the newest trip that had one — quiet trips included, so a finished trip's work stays reachable — Release for one that is awaiting, and Delete behind a confirm on the row's `⋯` menu, alongside the model knob. Deleting there is the same guarded removal `rm` performs, refused the same way while a trip runs. Authoring stays here, because those are the fields where a wrong value makes a tripwire silently useless rather than visibly wrong.

## Judgement

**A tripwire is only worth laying if a person would want to be told.** The test is not "could an AI say something about this" — it always could. It is "would somebody stop what they are doing to hear it". A tripwire that raises its hand on every fact is a tripwire that gets ignored, and an ignored tripwire is worse than no tripwire because it costs tokens to be ignored.

**Prefer a probe to a brief wherever a command can answer the question.** A probe is free and deterministic; a session is neither.

**Name a tripwire for what it watches, not what it does.** `edits` and `ci` are addresses somebody will still recognize in a month; `check-for-problems` is not.

**Write the brief for the reader of the headline.** One sentence, naming the file or the command or the commit exactly. The person reading it saw none of what the tripwire saw.

## What this skill does not do

It does not join, land, merge, or resolve anything — a tripwire's authored work is the user's to accept or discard through the ordinary arc gestures. It does not author project configuration. It does not decide that a tripwire ought to exist: the user asked for one, or they did not.
