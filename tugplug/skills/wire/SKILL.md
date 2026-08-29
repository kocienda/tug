---
name: wire
description: Lay, revise, and shake down a tripwire — a standing watch that fires on a fact or a commit, answers a brief you wrote, and reports itself in the Overview. Never joins anything.
argument-hint: "[what to watch for, in a sentence]"
disable-model-invocation: true
allowed-tools: Bash, Read, Glob, Grep, AskUserQuestion
disallowed-tools: Task
---

## What this is

A **wire** is a standing watch. It sits on the machine doing nothing until something it is watching for happens — an edit program going stale, a commit landing on a branch — and then it fires: a **trip**. The trip runs a probe if the wire has one, asks an AI only about what the probe could not settle, and reports what it found as a post in the Overview, in the Tripwire's own voice.

Your job here is to turn a sentence into a wire that will still be right in a month, and then to prove it fires. Everything rides `tugutil wire`; you author nothing else.

**Two things a wire never does, and they are not preferences.**

- **A wire never joins.** It may stage work on a dash and it may say so. Landing that work is the user's act, always. `dash join --resolve` is never a wire's to run, and never yours on a wire's behalf.
- **A wire never widens its own scope.** See the scope rule below. Where a wire watches is a decision somebody made, and quietly extending it is how a wire starts firing on its own work.

## The shape of a wire

```
tugutil wire lay <name> --on <trigger> --brief <text|@file>
                 [--where <clause>]... [--scope <path>] [--probe <cmd>]
                 [--model <m>] [--tier auto|verdict|work]
                 [--permission-mode <mode>] [--post auto|always|never]
                 [--cooldown <secs>] [--preview]
```

**`--on`** is what trips it, and there are two sources:

- `fact:<kind>` — something the app recorded. `fact:edit_failed` is an edit program that would not resolve.
- `commit` or `commit:<branch>` — a commit landing. Bare `commit` is any branch; `commit:main` is that branch only.

**`--where`** narrows a fact by its payload, and repeats. `field=value` is exact, `field~=substr` is contains, `field^=prefix` is a prefix. A field the payload does not carry never matches — a clause you cannot spell is a wire that never fires, not a wire that fires on everything.

**`--brief`** is the whole of what the wire will be asked when it fires. Write it as a question with a decision in it, not a topic. "Say whether this failure is the tool's fault or the program's, and name the file" earns a useful headline; "look at edit failures" earns a paraphrase of the event.

**`--scope`** confines the wire to events under one path. Unscoped, it watches the whole machine.

**`--probe`** is a command run before any model is summoned. **Exit 0 settles the trip for free** — no tokens, no session, nothing posted unless the wire's policy is `always`. This is the single most valuable field on a wire: a probe turns "ask an AI every time" into "ask an AI about the residue", and an armed wire with a good probe is cheap enough to leave armed forever.

**`--tier`** is what the trip runs as, and `auto` reads the probe: a probe may write, so a wire that has one gets the **work** tier, which stages on its own dash worktree. No probe means the **verdict** tier — one pooled turn, no hands, no worktree. Override only to force a wire with a probe down to `verdict` (deliberately hands-off) or a wire without one up to `work`.

**`--post`** is when the outcome reaches the Overview. `auto` is the default and the right one: it posts what the trip called *interesting*, and always posts a failure, and stays quiet about the routine. That last part is the point — a wire fires on a pattern, and the pattern occurring is ordinary. `always` is for a wire you are still shaking down. `never` keeps the trip log and says nothing.

**`--cooldown`** is the seconds before the wire will fire again. The default swallows a flapping trigger — the same edit program failing in a retry loop — and every swallow is written to the trip log rather than dropped.

## The scope rule

**A work-tier wire commits on its own dash worktree, and scope matching does not fold a worktree into the checkout it came from.** That is what stops a wire re-tripping on its own commits, and it is structural rather than a heuristic.

The consequence is a decision the user has to make rather than one you make for them: **a wire meant to watch a checkout *and* the dash worktrees cut from it needs a scope broad enough to contain both** — the directory above them, typically. Never widen a scope to get this silently. Say what the scope covers, say what it does not, and let the user choose. A wire whose scope was quietly widened to include its own workspace is the one failure mode of this whole facility.

## The flow

**1. Read the sentence for the six fields.** Trigger, scope, probe, brief, tier, post policy. Most sentences name two or three of them; the rest have defaults that are usually right. Do not interrogate — pick the conventional default, say which defaults you took, and let the user correct one.

The one thing worth asking about is the **probe**, and only when the user's sentence implies a check that a command could make. "Tell me when the build breaks" has a probe in it; "tell me when someone touches the auth code" does not. Asking "is there a command that answers this?" once is worth it, because it is the difference between a wire that costs nothing at rest and one that spends a turn on every firing.

**2. Validate before you write.**

```
tugutil wire lay <name> … --preview
```

`--preview` parses everything and writes nothing: the normalized trigger, the resolved tier, the scope as a canonical path, the post policy. It is a **syntax** check, not a rehearsal — it cannot tell you whether any event on this machine would ever match. Read what it echoes back and confirm the trigger it normalized is the trigger you meant, especially the tier: a probe you added quietly promoted the wire to `work`.

**3. Lay it, and report the receipt.**

```
tugutil wire lay <name> … --json
```

Report what came back — the name, the normalized trigger, the resolved tier, the scope, the post policy — not a paraphrase. The receipt is the wire.

**4. Shake it down. This is not optional.**

```
tugutil wire trip <name>
```

`trip` fires the wire by hand, whatever it is watching for. It is the only way to find out what the wire actually does, because `--preview` only ever read the syntax. Run it, then read the log:

```
tugutil wire log <name>
```

The log carries every firing including the ones that produced no post — the swallowed, the routine, the failed. That is the whole value of it: a wire that fires ten times and posts once is working correctly, and this is the only place the other nine are visible. Read the headline the wire produced and judge it as the user will: does it name the thing, or does it describe the wire?

**5. Revise in place.**

```
tugutil wire edit <name> [same flags]
```

Every flag is optional and what you do not name is left alone. A brief that earned a vague headline is the usual repair, and it is one `edit` and one `trip` away. The wire's log survives the edit, so the before and after sit next to each other.

## The rest of the verbs

```
tugutil wire list [--json]        every wire on this machine
tugutil wire log <name> [--json]  one wire's trip log, the full workings
tugutil wire pause <name>         out of service, keeping the wire and its log
tugutil wire resume <name>        back into service
tugutil wire rm <name>            gone, with its log
```

`pause` rather than `rm` for a wire that is misbehaving: the log is the evidence for the repair, and removing the wire throws it away.

The **Wires card** shows the same things — the roster, each wire's live state, and the trip log behind each row — with three small knobs: pause, model, and post policy. Authoring stays here, because those are the fields where a wrong value makes a wire silently useless rather than visibly wrong.

## Judgement

**A wire is only worth laying if a person would want to be told.** The test is not "could an AI say something about this" — it always could. It is "would somebody stop what they are doing to hear it". A wire that reports every commit is a wire that gets ignored, and an ignored wire is worse than no wire because it costs tokens to be ignored.

**Prefer a probe to a brief wherever a command can answer the question.** A probe is free and deterministic; a turn is neither.

**Name a wire for what it watches, not what it does.** `tugedit` and `ci` are addresses somebody will still recognize in a month; `check-for-problems` is not.

**Write the brief for the reader of the headline.** One sentence, naming the file or the command or the sha exactly. The person reading it saw none of what the wire saw.

## What this skill does not do

It does not join, land, merge, or resolve anything — a wire's staged work is the user's to accept or discard through the ordinary dash gestures. It does not author project configuration. It does not decide that a wire ought to exist: the user asked for one, or they did not.
