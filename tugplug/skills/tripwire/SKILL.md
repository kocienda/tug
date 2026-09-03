---
name: tripwire
description: Lay, revise, and shake down a tripwire — a standing watch that fires when a landing gesture commits onto its branch, answers a brief you wrote, and raises its hand only when it has something a person should see. Never joins anything.
argument-hint: "[what to watch for, in a sentence]"
disable-model-invocation: true
allowed-tools: Bash, Read, Glob, Grep, AskUserQuestion
disallowed-tools: Task
---

## What this is

A **tripwire** is a post-commit inspector. It sits on the machine doing nothing until a **landing gesture** — the commit gesture in the Session card, or an arc join — puts a commit on the branch the tripwire names. Then it fires: a **trip**. The trip runs the tripwire's probe if it has one, asks an AI only about what the probe could not settle, and either goes quiet or raises its hand with one line the user should read.

**Only Tug's own landing gestures fire a tripwire.** A `git commit` typed in a terminal, or a commit made by any tool outside Tug, is invisible to the whole facility — not an oversight but the design: the landing gesture is the one place that knows the branch, the commit, and the sessions whose work went into it, so it is the one place a firing can be built from without guessing.

Your job here is to turn a sentence into a tripwire that will still be right in a month, and then to prove it fires. Everything rides `tugtool tripwire`; you author nothing else.

**Two things a tripwire never does, and they are not preferences.**

- **A tripwire never joins.** It may author work on an arc and it may say so. Landing that work is the user's act, always. `arc join --resolve` is never a tripwire's to run, and never yours on a tripwire's behalf.
- **A tripwire never widens its own scope.** Where a tripwire watches is a decision somebody made, and quietly extending it is how a tripwire starts firing on landings nobody meant it to see.

## The shape of a tripwire

```
tugtool tripwire lay <name> --on <trigger> --brief <text|@file> --branch <branch>
                 [--where <clause>]... [--scope <path>] [--probe <cmd>]
                 [--model <m>] [--permission-mode <mode>] [--preview]
```

**`--branch`** is the base branch a landing has to be onto for this tripwire to fire. It is stored on the tripwire, not buried in the trigger, because it is the first thing a reader of the roster wants: the same watch on two branches is two different watches. Absent, it reads the default branch of `--scope`, or of the current directory for a machine-wide tripwire — sugar for the common case, and the stored value is what fires.

**`--on`** is the fact condition the landing has to carry: `fact:<kind>`, where the kind is something the app recorded. `fact:edit_failed` is an edit program that would not resolve. The tripwire fires when a landing onto its branch carries a matching fact in the work behind it — the branch is *when*, the fact is *what*.

**`--where`** narrows a fact by its payload, and repeats. `field=value` is exact, `field~=substr` is contains, `field^=prefix` is a prefix. A field the payload does not carry never matches — a clause you cannot spell is a tripwire that never fires, not a tripwire that fires on everything.

**`--brief`** is the whole of what the tripwire will be asked when it fires. **Write it as a question, not an instruction**, because the session that answers it cannot act: it runs read-only, and the only thing it can do with "fix the retry logic" is describe having wanted to. "Say whether this failure is the tool's fault or the program's, and name the file" earns a useful headline; "look at edit failures" earns a paraphrase of the event; "fix the parser" earns a session explaining that it could not.

If the change is worth making, the brief can say so — the session has a verb for asking that work be authored, and a second session with hands is spawned for it. What the brief must not do is assume the first one has them.

**A brief that says nothing is refused, at the lay and at the `--preview`.** A tripwire with no probe summons a model on every firing, so a placeholder brief is not merely useless — it is a model run per landing, answered by a paraphrase of the landing and nothing else. If the refusal fires, the repair is to write the question, never to pad the words.

**`--scope`** confines the tripwire to landings in one checkout, and it is where the trip's disposable copy of the commit is cut from. Unscoped, it watches the whole machine — and a hand-fired trip on an unscoped tripwire has no repository to stand in, so a tripwire you intend to shake down wants a scope.

**`--probe`** is a command run before any model is summoned. **Exit 0 settles the trip for free** — no tokens, no session, nothing said. This is the single most valuable field on a tripwire: a probe turns "ask an AI every time" into "ask an AI about the residue", and an armed tripwire with a good probe is cheap enough to leave armed forever. It runs in a **disposable checkout of the commit that just landed**, not in the user's working checkout and not in an arc worktree, so it sees exactly the tree that landed and can touch nothing that outlives the trip.

**`--model`** is the model a trip runs on; absent, the session default. **`--permission-mode`** is the mode for the *authoring* session only — the diagnosing one is read-only whatever you pass, enforced by the runtime rather than asked for in prose.

## How a trip runs

Worth knowing, because a brief is written against it:

1. **The probe**, in a disposable checkout of the landed commit. Green settles the trip and nothing else happens.
2. **Diagnosis** — one session in that same disposable checkout, read-only, handed everything it needs: the landing and its diff stat, the probe's output when the probe failed, the matching facts, and the transcripts of the sessions whose work landed. It answers the brief and ends by resolving.
3. **Authoring**, only if the diagnosis asked for it — a second session on an arc worktree of its own, with the tripwire's permission mode, which can write and commit. The user joins that arc or discards it; the tripwire never does.

The trip settles one of two ways, through a verb the session runs:

```
tugtool tripwire resolve <name> --quiet
tugtool tripwire resolve <name> --awaiting --headline "<one line>" [--author "<what to change>"]
tugtool tripwire dismiss <name>
```

`--quiet` is "nothing here anybody needs to see" and is the ordinary outcome — a tripwire fires on a pattern, and the pattern occurring is usually not news. `--awaiting` is the tripwire raising its hand: the headline is the one line the Tripwires row shows, and the trip **holds** — it keeps the tripwire's one-run slot and stays on the surface — until the user has seen it. `dismiss` settles an awaiting trip by hand and discards the arc it was holding.

An awaiting trip is also resolved by the arc disappearing: joining or discarding it answers the question the tripwire asked. There is no timeout, on purpose — a question that evaporates overnight is a question nobody was asked.

**Raising a hand posts once, and quiet posts nothing.** An awaiting resolution drops a single pointer post in the Overview naming the tripwire and its headline; a quiet one says nothing anywhere except in the trip log. There is no knob for this and no "post everything while I shake it down" mode — the log is where a tripwire under test is read.

## The scope rule

**A tripwire never fires on the landing of its own arc.** The join that lands a tripwire's authored work is a landing like any other, and the tripwire that authored it is skipped for that landing by name — exactly, not heuristically, and the skip is written into the trip log so it is visible rather than mysterious. That plus **one live run per tripwire** — a tripwire with a trip running or awaiting is not evaluated, and the skip is a row saying `busy` — is the whole anti-loop defense.

So the scope is a decision about coverage, not a defense: it says which checkout's landings this tripwire watches. Say what a scope covers and what it does not, and let the user choose it. Never widen one to make something fire.

## The flow

**1. Read the sentence for the fields.** Branch, trigger, scope, probe, brief. Most sentences name two or three; the rest have defaults that are usually right. Do not interrogate — pick the conventional default, say which defaults you took, and let the user correct one.

The one thing worth asking about is the **probe**, and only when the user's sentence implies a check that a command could make. "Tell me when the build breaks" has a probe in it; "tell me when someone touches the auth code" does not. Asking "is there a command that answers this?" once is worth it, because it is the difference between a tripwire that costs nothing at rest and one that spends a session on every landing.

**2. Validate before you write.**

```
tugtool tripwire lay <name> … --preview
```

`--preview` parses everything and writes nothing: the normalized trigger, the branch it resolved, the scope as a canonical path, the probe, the permission mode. It is a **syntax** check, not a rehearsal — it cannot tell you whether any landing on this machine would ever match. Read what it echoes back and confirm the branch it resolved is the branch you meant: a tripwire laid from the wrong directory can pick up a default branch nobody intended.

**3. Lay it, and report the receipt.**

```
tugtool tripwire lay <name> … --json
```

Report what came back — the name, the normalized trigger, the branch, the scope, the probe, the permission mode — not a paraphrase. The receipt is the tripwire.

**4. Shake it down. This is not optional.**

```
tugtool tripwire trip <name>
```

`trip` fires the tripwire by hand, standing in a landing of the tripwire's own branch at whatever its scope's `HEAD` names. It goes past the guards by construction, because a bench test that could be swallowed as `busy` would test nothing. It is the only way to find out what the tripwire actually does, since `--preview` only ever read the syntax. Run it, then read the log:

```
tugtool tripwire log <name>
```

The log carries every firing, including the ones that said nothing — the swallowed, the quiet, the failed. That is the whole value of it: a tripwire that fires ten times and raises its hand once is working correctly, and this is the only place the other nine are visible. Read the headline the tripwire produced and judge it as the user will: does it name the thing, or does it describe the tripwire?

**5. Revise in place.**

```
tugtool tripwire edit <name> [same flags] [--clear scope|probe|model]
```

Every flag is optional and what you do not name is left alone; `--clear` removes a field rather than setting it. A brief that earned a vague headline is the usual repair, and it is one `edit` and one `trip` away. The tripwire's log survives the edit, so the before and after sit next to each other.

## The rest of the verbs

```
tugtool tripwire list [--json]        every tripwire on this machine
tugtool tripwire log <name> [--json]  one tripwire's trip log, the full workings
tugtool tripwire pause <name>         out of service, keeping the tripwire and its log
tugtool tripwire resume <name>        back into service
tugtool tripwire rm <name>            gone, with its log
```

`pause` rather than `rm` for a tripwire that is misbehaving: the log is the evidence for the repair, and removing the tripwire throws it away.

The **Tripwires card** shows the same things — the roster with each tripwire's branch, a dot while a trip is live and a held one while a trip is awaiting, and the trip log behind each row — with two knobs: pause and model. Its collapsed band carries the live count, so the standing watches read at a glance without opening anything. Authoring stays here, because those are the fields where a wrong value makes a tripwire silently useless rather than visibly wrong.

## Judgement

**A tripwire is only worth laying if a person would want to be told.** The test is not "could an AI say something about this" — it always could. It is "would somebody stop what they are doing to hear it". A tripwire that raises its hand on every landing is a tripwire that gets ignored, and an ignored tripwire is worse than no tripwire because it costs tokens to be ignored.

**Prefer a probe to a brief wherever a command can answer the question.** A probe is free and deterministic; a session is neither.

**Name a tripwire for what it watches, not what it does.** `edits` and `ci` are addresses somebody will still recognize in a month; `check-for-problems` is not.

**Write the brief for the reader of the headline.** One sentence, naming the file or the command or the commit exactly. The person reading it saw none of what the tripwire saw.

## What this skill does not do

It does not join, land, merge, or resolve anything — a tripwire's authored work is the user's to accept or discard through the ordinary arc gestures. It does not author project configuration. It does not decide that a tripwire ought to exist: the user asked for one, or they did not.
