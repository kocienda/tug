---
name: dash-plan
description: Plan a dash — settle the idea into a brief and hand it to the wheel, which devises a plan, reviews it cold, walks it, and audits the landed code on fresh sessions of its own
argument-hint: "[idea…]"
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch, AskUserQuestion
disallowed-tools: Task
---

## What this is

`/dash-plan` is the settling route through the dash lane. The user says what they want — or says nothing — and this skill orients on what is already in flight, sharpens the idea into a **brief**, and hands that document to the **wheel**, which rotates devise → review → implement → audit on fresh sessions of its own.

It is one of two doors into the lane, and the other is the plain `/dash`. **Both doors run under the wheel and both open on a brief** — they differ by **settling time**, and by nothing else. `/dash` writes the brief and the task list at the door and the wheel opens straight at implement; `/dash-plan` writes the brief and the wheel devises a plan from it and reads that plan **cold** before any step is walked. `/dash-plan` is `/dash` plus that settling. **Which door they typed is the routing decision**, and it has already been made by the time you are reading this: nothing here asks the user to choose a route, and no dialog offers one.

What earns this door is settling. Work with enough parts that their order is itself a problem, or work whose *decisions* are the hard part and want a document written and read before any step exists. Small and concrete belongs at `/dash`, and something you mostly want to look at belongs at `/tugplug:spike-card`; [Size it](#3-size-it) is where to say so if the idea turns out to be one of those.

**Sharpening ends in a brief, and the plan is devised from it.** The route briefly wrote the plan inline instead, so the wheel could open at review. That reversed the wrong thing: a brief is what carries this conversation's settling forward — its decisions as `[B##]`, its findings as `[F##]` — and the devise stage reads it **cold**, which an inline-authored plan never got. The document a fresh session can start from is the whole design ([B14]), and the brief is that document.

What this door buys is two cold readers rather than one: a devise stage that turns the brief into a plan, and a review stage that judges that plan against the real code before a line of it is walked.

**The wheel is a hand-off, not a sequence you run.** A running model cannot drive it — it cannot end its own turn to start the next stage, and each stage wants a session that has never seen the last one's context. So this skill writes the brief, hands it to `tugtool dash run`, and ends the turn. The server rotates the stages from there, on this same card. Everything below is written for that, because there is no other way through: `dash-devise` is a stage of this course and stops when it is run outside one.

**You are the orchestrator, in-thread.** Do not spawn sub-agents (`Task`). The plugin is agentless by charter.

**`/dash-plan` itself never creates a worktree, never commits, and never joins.** The course's implement stage *is* `dash-implement`, run by a session the server started, under that skill's own guardrails — including its sanctioned `tugtool dash create` and `tugtool dash commit`. The shared discipline is [`tuglaws/dash-work-doctrine.md`](../../../tuglaws/dash-work-doctrine.md), and the stop-before-join obligation is unchanged: landing is the user's act. Handing work to the wheel does not hand over the join.

**When the project has no `tuglaws/`,** the doctrine and the skeletons are absent — including the brief skeleton this skill writes against. There is no brief format there and no linter standing in for one, so write the six beats [Hand off](#4-hand-off) names and say plainly that the format document is missing. The delegated skills carry the rest inline — one working root, verify before every commit, never commit red, rounds through `tugtool dash commit`, stop before the join. Say so once, at the start, so the user knows which fidelity they are getting; do not reconstruct the missing documents from memory.

## Input

`/dash-plan [idea…]`

Free text. A sentence, a paragraph, a pasted error, or nothing at all — each is a valid opening, and each is handled below.

## The stages

### 1. Orient

Before asking the user anything, find out what is already in flight. Three cheap reads answer it:

```bash
tugtool dash status              # what this card is bound to, if anything
tugtool dash list --json         # what dashes exist
```

There is no paperwork home to resolve: a dash's documents live at `.tug/dashes/<name>/`, and `tugtool dash documents <name> --json` says which of them exist. A dash with no directory is a **state, not an error** — the verb exits 0 with both absent, which is where every new dash starts.

Then look for a course mid-flight. For each name `dash list` reports, and each directory under `.tug/dashes/`, `tugtool plan status <name> --json` reads its ledger document — its plan, or its task list when that is all it has; `data.review` is the answer for a plan. A plan that is `reviewed` and whose steps are all `pending` is a settled plan nobody has started. Name it and offer to resume its course.

**A stopped course is the one thing here that will never announce itself.** A course rotates on a tick, so when one stops there is no gesture nobody made to explain the stillness — the card's faces say so, but only to somebody looking at them. So read it:

```bash
tugtool dash arc <name> --json     # per dash from `dash list`; no arc exits 0 with `arc: null`
```

`data.arc.stopped` names the stage and the reason. Say both, and offer the resume — which is the *same verb*, because the documents hold the progress:

```bash
tugtool dash run <name>
```

That re-rotates the stopped stage and nothing earlier ([P11]). A stage never re-runs work that already landed; the plan's own ledger is what it resumes against.

**Find what is already written.** The wheel opens on *documents*, so before asking the user for anything, find out which exist. Documents are not tracked and so never appear in `tugtool changes` — the filesystem is the record, and `tugtool dash documents <name>` reads it: the brief, the plan, and the task list, each with its own address. Run it for each name `dash list` reports and each directory under `.tug/dashes/`. A dash already carrying a brief is this door's input and naming it is usually the entire Orient stage: *"`foo` already has a brief — hand it to the wheel?"* A dash carrying a **plan** is one the devise stage already ran on; its course resumes at review or implement, not at devise.

**A lone argument that names an existing dash is a continuation, not a new idea.** What a user types there — a bare slug, no verb, no sentence — is exactly what an existing dash is called. So before reading a short argument as an idea, check it against `tugtool dash list`. On a hit, say which dash it is and offer to continue it: resume its course with `tugtool dash run <name>`, or bind this card to it with `/dash-bind` when the binding is all they wanted. Guessing "new idea" here starts a second dash beside the one they meant.

Invoked bare with nothing in flight, ask what to work on. That is the whole of the empty case — no menu, no roster of commands.

### 2. Sharpen

Converse about the idea until it is concrete enough to route. This is a conversation, not an intake form: a few sharp questions beat a checklist, and an already-specific idea passes straight through to routing without a single question. **An idea is already specific when this session already holds its design** — a spike card the user had you read, a brief or plan they pointed at, a thread of decisions made in this conversation. The invocation then names what to do with that design, and the design itself is the sharpened idea; nothing about it is asked again.

What is worth asking is bounded by the doctrine's [never-ask list](../../../tuglaws/dash-work-doctrine.md#what-never-gets-asked): design questions, never process ones, and nothing with a conventional default. Where that document is absent, that sentence is the boundary. **A question the code can answer is not a question for the user** — a wire field that is missing, a hook that skips a case, a component with no remaining mount. Read the code and write the answer into the brief as a `[B##]` decision or an `[F##]` finding; that is what the brief is for, and a dialog that asks the user to choose between two readings of the codebase is the brief's work handed back to them.

Read enough code to ask a good question. An idea sharpened against the real files ("this touches the store or the card — which did you mean?") is worth three rounds of sharpening it in the abstract.

**Sharpening ends in a document, and that is not optional.** A course opens on a file, never on an idea string — the whole design rests on each stage being startable cold from what the last one wrote ([B14]), and a sentence in a conversation is not something a fresh session can read. So when this session has written nothing, **write the brief here, in this conversation, on the user's own model, as an ordinary interactive turn** — the shape of it is [Hand off](#4-hand-off). That turn is the one place in the whole course where the user's judgment and the model they chose are both in the room, and spending it is the point rather than a delay.

Then hand off. Never `tugtool dash run` a dash with no document at all — the verb refuses, and inventing one to satisfy it is inventing the decisions it was supposed to carry.

### 3. Size it

The route is already chosen — the user typed this door. What is left is the one honest check: **does this work actually want the settling?** Most of the time it does, and there is nothing to do here but go on to the hand-off without saying a word about routing.

Two shapes are worth naming when you see them, because the two extra stages would cost the user two sessions to arrive where the other door arrives directly:

- **One clear change**, where the shape is already settled and a devise stage would write a plan nobody needs to read — say so and offer `/dash <name> <the instruction>`, which writes the task list at the door and opens the course at implement.
- **Something to look at** — a layout, a treatment, a shape whose answer is visual — say so and offer `/tugplug:spike-card`.

Say it in a sentence, as a reading rather than a verdict, and take the user's answer. **Never an `AskUserQuestion` here** — offering a menu of routes to somebody who already typed one is the ceremony these two doors exist to remove. When they say plan anyway, plan.

### 4. Hand off

This is the whole of the route, and its whole difficulty: **you do not run the course, you hand it to something that does.**

**The brief comes first.** When the decisions are the hard part it is the point of the turn; otherwise it is the input the wheel needs and cannot invent. Either way it is written here. Settle the dash's name first, then:

```bash
tugtool dash documents <name> --ensure --json
```

Write the brief to the `brief` path it prints, against [`tuglaws/brief-skeleton.md`](../../../tuglaws/brief-skeleton.md). Its six beats: the **purpose** in the user's own terms, the **evidence** actually observed, the **decisions** already settled, what is **out of scope**, the **open questions** that remain, and the **shape** the work is expected to take. Read the skeleton before writing; it is the format contract, and it says which sections may be omitted when they have nothing to say.

**Carry this conversation's settled calls into it** — the decisions as `[B##]`, the observations as `[F##]`. This is the whole reason the door writes a document at all: the devise session reads it cold and must lose nothing this conversation settled. A brief that merely restates the user's opening sentence has thrown the sharpening away.

**Write no plan and no task list here.** The plan is the devise stage's product, judged by the review stage; authoring one at the door is what this route just stopped doing, and a task list at the door would open the *other* course. A brief carries no execution steps, which is also the mechanism that routes it: `tugtool plan lint` detects a plan positively by its `{#execution-steps}` section, so pointing it at a brief exits 2 with "not a plan document" — correct, and not a failure to fix.

**Then hand it over.** The dash name is whatever Orient and Sharpen already settled on — a short slug from the work, the same one `dash create` would have taken. It is the course's key, it is the address its documents live at, and it is valid before any branch exists ([B16]), so nothing needs creating first:

```bash
tugtool dash run <name>
```

The verb takes no document: it opens on what the dash has. A brief alone opens the course at **devise**, which is this door's whole point. (A brief beside a task list would open at implement — that is the `/dash` door's course, and it is why nothing here writes one.)

The verb refuses without a calling session, because a course runs *on a card* and there would otherwise be nowhere for a stage to rotate. It records the course, binds this session to the dash, and returns — **and the first rotation happens when this turn ends, not on arrival** ([P05]). That ordering is not incidental: the request is issued from inside your own turn, and rotating on receipt would kill the session mid-sentence.

So issuing that command is the last thing you do. Say what happens next (stage 6), and end the turn. **Ending the turn is the hand-off.** Do not wait, do not poll `dash arc`, and do not print a command for the user to click — there is nothing for them to do, which is the entire point of the wheel.

Say which contract you are entering as you enter it. The hand-off is the moment the user would otherwise lose the thread, and naming it is most of what the narration is for.

### 5. Devise and review — stages, not gates

The plan is written by the **devise** stage from the brief you just handed over, and judged by the **review** stage before any step is walked. Both are stages rather than gates, so there is nothing here for you to hold.

The runner rotates devise → review → implement → audit itself, each on a fresh session, each on the model the project declared for it in `[tugtool.dash]` — and each model is a declaration, not a habit: a project that wants its reviews on Opus says `review_model = "opus"` there, and a review that ran on anything else is a config fact to fix, never something a skill can promise. The review reads the plan **cold**, which is the thing a gate could never buy: an inline review is handed the author's own context, and the reader you actually want is one who has never seen it. So there is no chip to print, nothing to hand back, and no turn boundary to stop at — you handed the document over in stage 4 and the course is already running.

What each stage does when it finishes is its own skill's to state — `dash-devise` §5's, and `dash-review`'s — rather than restated here, one home per rule, because a second copy is how the first one drifted.

### 6. Say what happens next

This is the stage this skill owns outright, because nothing else in the course will speak until it is over. Tell the user what they are about to watch — in a few sentences, before the turn ends:

- **One card, one scroll.** Every stage runs on *this* card, on a fresh claude session, and the transcript is not cleared between them. A labelled divider marks each boundary, naming the stage, its model, and the document it opened on.
- **Four stages, then a stop.** Devise writes the plan from the brief, review reads it cold and stamps it, implement walks the ledger one step per turn, audit reads the landed code against the plan and fixes what does not match. A stage that fails writes why and stops rather than retrying — the card's faces say which stage and the reason, and `tugtool dash run <name>` resumes exactly there.
- **The ending is the join offer.** When the audit marks the dash, the Changes shade reveals itself on this card, carrying the message the join would land. Plus one receipt row saying which stages ran, on which sessions. Until then the dash's own strip says which cell it is in, so a run still checking its work does not read as one waiting to be joined.
- **Nothing needs typing in between.** That is the claim the whole arc rests on, and it is worth stating plainly.

**Do not print a `/dash-join <name>` chip**, here or anywhere. The shade summons itself; a chip beside it teaches the user that nothing happens until they type, which is the belief the wheel exists to retire ([D147], [D152]).

## Guardrails

- **No sub-agents.** Orchestrate, delegate, and work in-thread.
- **Delegate by reading, never by restating.** A stage's mechanics live in the sibling's `SKILL.md`; reproducing them here creates a second copy to drift.
- **Own the narration, not the machinery.** `/dash-plan` creates no worktree, commits nothing, and joins nothing. The course's own stages run under their skills' guardrails.
- **Ask about the design, never the process.** The route came in with the verb and is never asked about. Everything else is bounded by the doctrine's never-ask list — nothing with a conventional default, nothing the code can answer, and never "should I continue?".
- **A dash's documents live at its own address.** `.tug/dashes/<name>/`, never in the working tree, and `tugtool dash documents <name>` is what reports them. Nothing is declared and nothing is asked.
- **A course opens on a document, never on an idea.** Write the brief in this conversation first, on the user's model. `tugtool dash run <name>` needs a document to exist.
- **Write the brief and nothing else.** No plan — that is the devise stage's product. No task list — that would open the other course. This door's output is one document.
- **Hand off by ending the turn.** The first rotation happens at *this* turn's end, so issuing `dash run` is the last thing you do — never wait on it, never poll it, never print a command to start it.
- **There is no review gate.** The review is a stage on its own fresh session, reading the plan cold — there is nothing here to hold and no chip to print.
- **Never devise or review here.** Both are stages of the course, on sessions that have never seen this conversation, and that coldness is the whole of what this door buys.
- **Landing is the user's act.** Stop before the join, every time.

## When to reach for something else

The other door is `/dash` — the same wheel entered with the task list already written, for the change whose shape is already clear. Beyond the two doors, a user who knows exactly which room they want should type it: `/tugplug:spike-card`, `/tugplug:dash-review`, `/tugplug:dash-implement`. (`/tugplug:dash-devise` is not among them — it is a stage of a course and stops when it is run outside one.)
