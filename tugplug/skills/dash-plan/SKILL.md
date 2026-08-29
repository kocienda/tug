---
name: dash-plan
description: Plan a dash — settle the idea into a brief and hand it to the arc, which rotates devise, review, and implement on fresh sessions of its own
argument-hint: "[idea…]"
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch, AskUserQuestion
disallowed-tools: Task
---

## What this is

`/dash-plan` is the planned route through the dash lane. The user says what they want — or says nothing — and this skill orients on what is already in flight, sharpens the idea into a **brief**, and hands that document to the **arc**, which rotates devise → review → implement on fresh sessions of its own.

It is one of two doors into the lane, and the other is the plain `/dash` — the direct dash, worked in the conversation the user is already in, against a task list rather than a reviewed plan. **Which door they typed is the routing decision**, and it has already been made by the time you are reading this: nothing here asks the user to choose a route, and no dialog offers one.

What earns this door is a plan. Work with enough parts that their order is itself a problem, or work whose *decisions* are the hard part and want settling before any step is written — the arc handles both, and the difference is only how much of the opening turn goes into the brief. Small and concrete belongs at `/dash`, and something you mostly want to look at belongs at `/tugplug:spike-card`; [Size it](#3-size-it) is where to say so if the idea turns out to be one of those.

**The arc is a hand-off, not a sequence you run.** A running model cannot drive its own arc — it cannot end its own turn to start the next stage, and each stage wants a session that has never seen the last one's context. So this skill writes the brief, hands the document to `tugutil dash run`, and ends the turn. The server rotates the stages from there, on this same card. Everything below is written for that, because there is no other way through: `dash-devise` is a stage of this arc and stops when it is run outside one.

**You are the orchestrator, in-thread.** Do not spawn sub-agents (`Task`). The plugin is agentless by charter.

**`/dash-plan` itself never creates a worktree, never commits, and never joins.** The arc's implement stage *is* `dash-implement`, run by a session the server started, under that skill's own guardrails — including its sanctioned `tugutil dash create` and `tugutil dash commit`. The shared discipline is [`tuglaws/dash-work-doctrine.md`](../../../tuglaws/dash-work-doctrine.md), and the stop-before-join obligation is unchanged: landing is the user's act. Handing work to the arc does not hand over the join.

**When the project has no `tuglaws/`,** the doctrine and the skeletons are absent. What survives is what the delegated skills carry inline — one working root, verify before every commit, never commit red, rounds through `tugutil dash commit`, stop before the join — plus `tugutil plan lint`, which ships with the product and is what the plan format actually means. Say so once, at the start, so the user knows which fidelity they are getting; do not reconstruct the missing documents from memory.

## Input

`/dash-plan [idea…]`

Free text. A sentence, a paragraph, a pasted error, or nothing at all — each is a valid opening, and each is handled below.

## The stages

### 1. Orient

Before asking the user anything, find out what is already in flight. Three cheap reads answer it:

```bash
tugutil dash status              # what this card is bound to, if anything
tugutil dash list --json         # what dashes exist
```

There is no paperwork home to resolve: a dash's documents live at `.tug/dashes/<name>/`, and `tugutil dash documents <name> --json` says which of them exist. A dash with no directory is a **state, not an error** — the verb exits 0 with both absent, which is where every new dash starts.

Then look for an arc mid-flight. For each name `dash list` reports, and each directory under `.tug/dashes/`, `tugutil plan status <name> --json` reads its plan; `data.review` is the answer. A plan that is `reviewed` and whose steps are all `pending` is a reviewed plan nobody has started — a hand-driven arc's most common resting place, because off Opus the review is a turn boundary ([the review gate](#5-stop-at-the-review-gate)). Name it and offer to carry it into `dash-implement`.

**A stopped arc is the one thing here that will never announce itself.** A server-driven arc rotates on a tick, so when one stops there is no gesture nobody made to explain the stillness — the card's faces say so, but only to somebody looking at them. So read it:

```bash
tugutil dash arc <name> --json     # per dash from `dash list`; no arc exits 0 with `arc: null`
```

`data.arc.stopped` names the stage and the reason. Say both, and offer the resume — which is the *same verb*, because the documents hold the progress:

```bash
tugutil dash run <name>
```

That re-rotates the stopped stage and nothing earlier ([P11]). A stage never re-runs work that already landed; the plan's own ledger is what it resumes against.

**Find what is already written.** The arc opens on a *document*, so before asking the user for anything, find out whether one exists. Documents are not tracked and so never appear in `tugutil changes` — the filesystem is the record, and `tugutil dash documents <name>` reads it. Run it for each name `dash list` reports and each directory under `.tug/dashes/`; a dash whose brief exists is the arc's input, and naming it is usually the entire Orient stage: *"`foo` already has a brief — hand it to the arc?"*

**A lone argument that names an existing dash is a continuation, not a new idea.** What a user types there — a bare slug, no verb, no sentence — is exactly what an existing dash is called. So before reading a short argument as an idea, check it against `tugutil dash list`. On a hit, say which dash it is and offer to continue it: resume its plan through `dash-implement`, or bind this card to it with `/dash-bind` when the binding is all they wanted. Guessing "new idea" here starts a second dash beside the one they meant.

Invoked bare with nothing in flight, ask what to work on. That is the whole of the empty case — no menu, no roster of commands.

### 2. Sharpen

Converse about the idea until it is concrete enough to route. This is a conversation, not an intake form: a few sharp questions beat a checklist, and an already-specific idea passes straight through to routing without a single question. **An idea is already specific when this session already holds its design** — a spike card the user had you read, a brief or plan they pointed at, a thread of decisions made in this conversation. The invocation then names what to do with that design, and the design itself is the sharpened idea; nothing about it is asked again.

What is worth asking is bounded by the doctrine's [never-ask list](../../../tuglaws/dash-work-doctrine.md#what-never-gets-asked): design questions, never process ones, and nothing with a conventional default. Where that document is absent, that sentence is the boundary. **A question the code can answer is not a question for the user** — a wire field that is missing, a hook that skips a case, a component with no remaining mount. Read the code and write the answer into the brief as a `[B##]`; that is what the brief is for, and a dialog that asks the user to choose between two readings of the codebase is the brief's work handed back to them.

Read enough code to ask a good question. An idea sharpened against the real files ("this touches the store or the card — which did you mean?") is worth three rounds of sharpening it in the abstract.

**Sharpening ends in a document, and for the arc route that is not optional.** An arc opens on a file, never on an idea string — the whole design rests on each stage being startable cold from what the last one wrote ([B14]), and a sentence in a conversation is not something a fresh session can read. So when the arc route is chosen and this session has written nothing, **write the brief here, in this conversation, on the user's own model, as an ordinary interactive turn**: against `tuglaws/brief-skeleton.md`, into the dash's own `.tug/dashes/<name>/brief.md`, before any hand-off. That turn is the one place in the whole arc where the user's judgment and the model they chose are both in the room, and spending it is the point rather than a delay.

Then hand off. Never `tugutil dash run` a dash with no brief and no plan — the verb refuses, and inventing a document to satisfy it is inventing the decisions it was supposed to carry.

### 3. Size it

The route is already chosen — the user typed this door. What is left is the one honest check: **is the sharpened idea actually plan-shaped?** Most of the time it is, and there is nothing to do here but go on to the hand-off without saying a word about routing.

Two shapes are worth naming when you see them, because the arc would cost the user three sessions to arrive where one turn could have:

- **One clear change**, where the work is obvious and a devise stage would write a plan nobody needs to read — say so and offer `/dash <name> <the instruction>`.
- **Something to look at** — a layout, a treatment, a shape whose answer is visual — say so and offer `/tugplug:spike-card`.

Say it in a sentence, as a reading rather than a verdict, and take the user's answer. **Never an `AskUserQuestion` here** — offering a menu of routes to somebody who already typed one is the ceremony these two doors exist to remove. When they say plan anyway, plan.

### 4. Hand off

This is the whole of the route, and its whole difficulty: **you do not run the arc, you hand it to something that does.**

**The brief comes first.** When the decisions are the hard part it is the point of the turn; otherwise it is the input the arc needs and cannot invent. Either way it is written here. Settle the dash's name first, then `tugutil dash documents <name> --ensure --json` and write the brief to the `brief` path it prints, against `tuglaws/brief-skeleton.md` — findings as `[F##]`, decisions as `[B##]` — and keep it a brief rather than a small plan: no execution steps, no ledger, no checkpoints. The boundary is mechanical rather than conventional, because `tugutil plan lint` detects a plan *positively* by its `{#execution-steps}` section and exits 2 on anything else. An input that already lints as a plan is fine and skips the arc's devise stage; the arc reads that for itself.

**Then hand it over.** The dash name is whatever Orient and Sharpen already settled on — a short slug from the work, the same one `dash create` would have taken. It is the arc's key, it is the address its documents live at, and it is valid before any branch exists ([B16]), so nothing needs creating first:

```bash
tugutil dash run <name>
```

The verb takes no document: it opens on the dash's own brief, or on its plan when only that exists, and refuses by name when there is neither.

The verb refuses without a calling session, because an arc runs *on a card* and there would otherwise be nowhere for a stage to rotate. It records the arc, binds this session to the dash, and returns — **and the first rotation happens when this turn ends, not on arrival** ([P05]). That ordering is not incidental: the request is issued from inside your own turn, and rotating on receipt would kill the session mid-sentence.

So issuing that command is the last thing you do. Say what happens next (stage 6), and end the turn. **Ending the turn is the hand-off.** Do not wait, do not poll `dash arc`, and do not print a command for the user to click — there is nothing for them to do, which is the entire point of the arc.

Say which contract you are entering as you enter it. The hand-off is the moment the user would otherwise lose the thread, and naming it is most of what the narration is for.

### 5. The review — a stage, not a gate

A plan is not ready when it is written; it is ready when it has been reviewed. **Under an arc, that is a stage rather than a gate**, so there is nothing here for you to hold.

The runner rotates devise → review → implement itself, each on a fresh session, each on the model the project declared for it in `[tugtool.dash]` — and the review's model is a declaration, not a habit: a project that wants its reviews on Opus says `review_model = "opus"` there (this repository does), and a review that ran on anything else is a config fact to fix, never something a skill can promise. The review reads the plan **cold**, which is the thing a gate could never buy: an inline review is handed the author's own context, and the reader you actually want is one who has never seen it. So there is no chip to print, nothing to hand back, and no turn boundary to stop at — you handed the document over in stage 4 and the arc is already running.

What the devise stage does when it finishes is `dash-devise` §5's, and it is stated there rather than restated here — one home per rule, because a second copy is how the first one drifted.

### 6. Say what happens next

This is the stage this skill owns outright, because nothing else in the arc will speak until it is over. Under an arc, tell the user what they are about to watch — in a few sentences, before the turn ends:

- **One card, one scroll.** Every stage runs on *this* card, on a fresh claude session, and the transcript is not cleared between them. A labelled divider marks each boundary, naming the stage, its model, and the document it opened on.
- **Three stages, then a stop.** Devise writes the plan, review reads it cold and stamps it, implement walks the ledger. A stage that fails writes why and stops rather than retrying — the card's faces say which stage and the reason, and `tugutil dash run <name>` resumes exactly there.
- **The ending is the join offer.** When the run's last step lands, the Changes shade reveals itself on this card, carrying the message the join would land. Plus one receipt row saying which stages ran, on which sessions.
- **Nothing needs typing in between.** That is the claim the whole arc rests on, and it is worth stating plainly.

**Do not print a `/dash-join <name>` chip**, here or anywhere. The shade summons itself; a chip beside it teaches the user that nothing happens until they type, which is the belief this whole arc exists to retire ([D147], [D152]).

**On the hand-driven path**, continuing has two doors and both are already built: `dash-review` prints the `/tugplug:dash-implement <path>` chip, and a bare `/dash-plan` orients ([stage 1](#1-orient)), finds the reviewed plan, and offers to carry it. Either way, continuing means reading `../dash-implement/SKILL.md` and carrying the plan through that contract — its setup gate, its ledger walk, its per-step checkpoints and rounds, its ending. Nothing about the run changes for having arrived through `/dash-plan`, and its ending is the same one the arc reaches: the fit verified, the join draft written, the arc armed, no chip.

## Guardrails

- **No sub-agents.** Orchestrate, delegate, and work in-thread.
- **Delegate by reading, never by restating.** A stage's mechanics live in the sibling's `SKILL.md`; reproducing them here creates a second copy to drift.
- **Own the narration, not the machinery.** `/dash-plan` creates no worktree, commits nothing, and joins nothing. The arc's own stages run under their skills' guardrails.
- **Ask about the design, never the process.** The route came in with the verb and is never asked about. Everything else is bounded by the doctrine's never-ask list — nothing with a conventional default, nothing the code can answer, and never "should I continue?".
- **A dash's documents live at its own address.** `.tug/dashes/<name>/`, never in the working tree, and `tugutil dash documents <name>` is what reports them. Nothing is declared and nothing is asked.
- **An arc opens on a document, never on an idea.** Write the brief in this conversation first, on the user's model. `tugutil dash run <name>` needs one to exist.
- **Hand off by ending the turn.** The first rotation happens at *this* turn's end, so issuing `dash run` is the last thing you do — never wait on it, never poll it, never print a command to start it.
- **Under an arc there is no review gate.** The review is a stage on its own fresh session, reading the plan cold. Off the arc, the fork below still stands: print the chip and stop; do not review on a model that is not the review model.
- **Landing is the user's act.** Stop before the join, every time.

## When to reach for something else

The other door is `/dash` — the direct dash, worked in this conversation against a task list, for the change whose shape is already clear. Beyond the two doors, a user who knows exactly which room they want should type it: `/tugplug:spike-card`, `/tugplug:dash-review`, `/tugplug:dash-implement`. (`/tugplug:dash-devise` is not among them — it is a stage of this arc and stops when it is run outside one.)
