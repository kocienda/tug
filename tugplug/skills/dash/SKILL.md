---
name: dash
description: Start or continue dash work from one conversational entry point — size the idea, route to a spike, a quick dash, or the brief/plan arc, and carry the arc through review to implementation
argument-hint: "[idea…]"
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch, AskUserQuestion, TaskCreate, TaskUpdate
disallowed-tools: Task
---

## What this is

`/dash` is the lane's front door. One name, one conversation: the user says what they want — or says nothing — and this skill sizes the idea with them, routes it to whichever path fits, and carries the arc from there through review and into the build.

Everything it routes to already exists as a skill of its own, and each one stays independently invocable as the expert path:

| Path | Skill | For |
|---|---|---|
| Quick dash | `dash-on` | A fix, a small feature, a prototype — work that does not want a plan |
| Design spike | `spike-card` | A layout, a treatment, a shape you want to look at before committing to it |
| Plan arc | a brief, then `tugutil dash run` | Work with enough parts that the order matters — the server rotates devise → review → implement on this card |
| Brief first | `tuglaws/brief-skeleton.md`, then the plan arc | Work whose *decisions* are the hard part, and want settling before any step is written |

**This skill sequences; it does not restate.** At each hand-off it reads the sibling's own `SKILL.md` and carries out that contract in-thread. The expert skills remain the single source of truth for their own mechanics — an edit to `plan-devise` is picked up here with no second file to keep in step. What `/dash` owns, and no sibling does, is the connective narration: saying where the arc stands at each boundary, so the user never has to hold the sequence in their head.

**On the plan route, sequencing means handing off rather than sequencing.** A running model cannot drive its own arc — it cannot end its own turn to start the next stage, and each stage wants a session that has never seen the last one's context. So `/dash` writes the brief, hands the document to `tugutil dash run`, and ends the turn. The server rotates the stages from there, on this same card. Everything below is written for that; the hand-driven path someone gets by invoking `plan-devise` directly is unchanged and still spelled out where it differs.

**You are the orchestrator, in-thread.** Do not spawn sub-agents (`Task`). The plugin is agentless by charter.

**`/dash` itself never creates a worktree, never commits, and never joins.** While a delegated contract runs, that contract's guardrails govern — including `dash-implement`'s and `dash-on`'s sanctioned `tugutil dash create` / `tugutil dash commit`. That holds for an arc too: its implement stage *is* `dash-implement`, run by a session the server started, under exactly those guardrails. The shared discipline is [`tuglaws/dash-work-doctrine.md`](../../../tuglaws/dash-work-doctrine.md), and the stop-before-join obligation is unchanged: landing is the user's act. Handing work to the arc does not hand over the join.

**When the project has no `tuglaws/`,** the doctrine and the skeletons are absent. What survives is what the delegated skills carry inline — one working root, verify before every commit, never commit red, rounds through `tugutil dash commit`, stop before the join — plus `tugutil plan lint`, which ships with the product and is what the plan format actually means. Say so once, at the start, so the user knows which fidelity they are getting; do not reconstruct the missing documents from memory.

## Input

`/dash [idea…]`

Free text. A sentence, a paragraph, a pasted error, or nothing at all — each is a valid opening, and each is handled below.

## The stages

### 1. Orient

Before asking the user anything, find out what is already in flight. Three cheap reads answer it:

```bash
tugutil dash docs-dir --json     # where this project keeps its paperwork
tugutil dash status              # what this card is bound to, if anything
tugutil dash list --json         # what dashes exist
```

On `docs-dir`, `declared: false` is a **state, not an error**: the project has never said where its paperwork lives. Ask once, propose a name, and record the answer with `tugutil dash docs-dir --set <answer>` — the verb writes the key and creates the directory, and nobody is asked again. Never hand-edit the config.

Then look for an arc mid-flight. Glob `<docs>/*.md`, run `tugutil plan status <path> --json` over the candidates, and read `data.review`. A plan that is `reviewed` and whose steps are all `pending` is a reviewed-but-unadopted plan — a hand-driven arc's most common resting place, because off Opus the review is a turn boundary ([the review gate](#5-stop-at-the-review-gate)). Name it and offer to carry it into `dash-implement`.

**A stopped arc is the one thing here that will never announce itself.** A server-driven arc rotates on a tick, so when one stops there is no gesture nobody made to explain the stillness — the card's faces say so, but only to somebody looking at them. So read it:

```bash
tugutil dash arc <name> --json     # per dash from `dash list`; no arc exits 0 with `arc: null`
```

`data.arc.stopped` names the stage and the reason. Say both, and offer the resume — which is the *same verb*, with no `--document`, because the documents hold the progress:

```bash
tugutil dash run <name>
```

That re-rotates the stopped stage and nothing earlier ([P11]). A stage never re-runs work that already landed; the plan's own ledger is what it resumes against.

**Find what this conversation already wrote.** The arc opens on a *document*, so before asking the user for anything, find out whether one exists — this session may already have written the brief that is the whole hand-off:

```bash
tugutil changes --json     # data.files: what this session is attributed with
```

Intersect the attributed paths with the docs directory `docs-dir` reported. A brief or plan there that this session wrote is the arc's input, and naming it is usually the entire Orient stage: *"you wrote `dash/foo-brief.md` this session — hand it to the arc?"*

**A lone argument that names an existing dash is a continuation, not a new idea.** `/dash <name>` was the retired spelling of `/dash-bind` for long enough to be muscle memory, and what a user types there — a bare slug, no verb, no sentence — is exactly what an existing dash is called. So before reading a short argument as an idea, check it against `tugutil dash list`. On a hit, say which dash it is and offer to continue it: resume its plan through `dash-implement`, or bind this card to it with `/dash-bind` when the binding is all they wanted. Guessing "new idea" here starts a second dash beside the one they meant.

Invoked bare with nothing in flight, ask what to work on. That is the whole of the empty case — no menu, no roster of commands.

### 2. Sharpen

Converse about the idea until it is concrete enough to route. This is a conversation, not an intake form: a few sharp questions beat a checklist, and an already-specific idea passes straight through to the routing gate without a single question.

What is worth asking is bounded by the doctrine's [never-ask list](../../../tuglaws/dash-work-doctrine.md#what-never-gets-asked): design questions, never process ones, and nothing with a conventional default. Where that document is absent, that sentence is the boundary.

Read enough code to ask a good question. An idea sharpened against the real files ("this touches the store or the card — which did you mean?") is worth three rounds of sharpening it in the abstract.

**Sharpening ends in a document, and for the arc route that is not optional.** An arc opens on a file, never on an idea string — the whole design rests on each stage being startable cold from what the last one wrote ([B14]), and a sentence in a conversation is not something a fresh session can read. So when the arc route is chosen and this session has written nothing, **write the brief here, in this conversation, on the user's own model, as an ordinary interactive turn**: against `tuglaws/brief-skeleton.md`, into the docs directory, before any hand-off. That turn is the one place in the whole arc where the user's judgment and the model they chose are both in the room, and spending it is the point rather than a delay.

Then hand off. Never `tugutil dash run --document` a path that does not exist yet, and never invent an idea file to satisfy the verb.

### 3. Route

One `AskUserQuestion`, four options, the recommended one first:

- **Quick dash** — `dash-on`. Small and concrete; the work is clear and the plan would be ceremony.
- **Plan arc** — a brief written here, then handed to the arc, which rotates devise → review → implement on this card. Enough parts that the order matters.
- **Brief first, then plan** — the decisions are the hard part and want settling before any step is written. Same hand-off; more of the turn spent on the brief.
- **Design spike** — `spike-card`. Visual or exploratory; the answer is something to look at.

Recommend from the sharpened idea rather than from a rule: small and concrete leans quick, visual leans spike, decision-heavy leans brief-first, many-moving-parts leans plan. The user chooses; the recommendation is a reading, not a verdict.

**Skip the question when the invocation already names the shape.** "spike this", "quick fix:", "plan this out", "write me a brief" are answers already given, and asking anyway is the ceremony this skill exists to remove.

### 4. Hand off, or delegate

Two of the four routes are contracts you carry out yourself. Read the sibling's `SKILL.md` — relative to this skill's own base directory — and carry it out in-thread:

| Route | Read |
|---|---|
| Quick dash | `../dash-on/SKILL.md` |
| Design spike | `../spike-card/SKILL.md` |

The plan routes are different, and the difference is the whole of this stage: **you do not run the plan arc, you hand it to something that does.**

**The brief comes first either way.** For the brief-first route it is the point; for the plan route it is the input the arc needs and cannot invent. Write it in the docs directory resolved in stage 1, against `tuglaws/brief-skeleton.md` — findings as `[F##]`, decisions as `[B##]` — and keep it a brief rather than a small plan: no execution steps, no ledger, no checkpoints. The boundary is mechanical rather than conventional, because `tugutil plan lint` detects a plan *positively* by its `{#execution-steps}` section and exits 2 on anything else. An input that already lints as a plan is fine and skips the arc's devise stage; the arc reads that for itself.

**Then settle the name and hand the document over.** The dash name is whatever Orient and Sharpen already settled on — a short slug from the work, the same one `dash create` would have taken. It is the arc's key and is valid before any branch exists ([B16]), so nothing needs creating first:

```bash
tugutil dash run <name> --document <docs>/<slug>-brief.md
```

The verb refuses without a calling session, because an arc runs *on a card* and there would otherwise be nowhere for a stage to rotate. It records the arc, binds this session to the dash, and returns — **and the first rotation happens when this turn ends, not on arrival** ([P05]). That ordering is not incidental: the request is issued from inside your own turn, and rotating on receipt would kill the session mid-sentence.

So issuing that command is the last thing you do. Say what happens next (stage 6), and end the turn. **Ending the turn is the hand-off.** Do not wait, do not poll `dash arc`, and do not print a command for the user to click — there is nothing for them to do, which is the entire point of the arc.

Say which contract you are entering as you enter it. The hand-off is the moment the user would otherwise lose the thread, and naming it is most of what the narration is for.

### 5. The review gate — which the arc route does not have

A plan is not ready when it is written; it is ready when it has been reviewed. **Under an arc, that is a stage rather than a gate**, and the whole of this section is off.

The runner rotates devise → review → implement itself, each on a fresh session, each on the model the project declared for it in `[tugtool.dash]` — and the review's model is a declaration, not a habit: a project that wants its reviews on Opus says `review_model = "opus"` there (this repository does), and a review that ran on anything else is a config fact to fix, never something a skill can promise. The review reads the plan **cold**, which is the thing a gate could never buy: an inline review is handed the author's own context, and the reader you actually want is one who has never seen it. So there is no chip to print, nothing to hand back, and no turn boundary to stop at — you handed the document over in stage 4 and the arc is already running.

Everything below is the **hand-driven** path, and it reads exactly as it always has for someone who invoked `plan-devise` directly ([B11]). It is not a fallback and it is not deprecated: a user who wants to hold the arc themselves gets the same fork they have always had.

Which happens next is `plan-devise` §5's fork, inherited whole:

- **On Opus** — the review runs inline, in the same turn, because the model that would be handed the job is already the one holding it. Lint, judge against `tuglaws/plan-review-rubric.md` and the real code, apply the fixups, append the Review Record, and stamp with `tugutil plan stamp` as the last edit.
- **On anything else** — stop. Say the plan is written and **unreviewed**, print `` `/tugplug:plan-review <path>` `` on its own line inside backticks, and say plainly that clicking it reviews the plan on whatever model is selected at that moment — so switching first is the user's call and their opportunity to make it.

**Never switch the user's model, in either direction, and never schedule a turn on their behalf.** The arc spanning turns here is the design, not a gap in it: the review is where judgment lands, and the model choice belongs to the user.

### 6. Say what happens next

This is the stage `/dash` owns outright, because nothing else in the arc will speak until it is over. Under an arc, tell the user what they are about to watch — in a few sentences, before the turn ends:

- **One card, one scroll.** Every stage runs on *this* card, on a fresh claude session, and the transcript is not cleared between them. A labelled divider marks each boundary, naming the stage, its model, and the document it opened on.
- **Three stages, then a stop.** Devise writes the plan, review reads it cold and stamps it, implement walks the ledger. A stage that fails writes why and stops rather than retrying — the card's faces say which stage and the reason, and `tugutil dash run <name>` resumes exactly there.
- **The ending is the join offer.** When the run's last step lands, the Changes shade reveals itself on this card, carrying the message the join would land. Plus one receipt row saying which stages ran, on which sessions.
- **Nothing needs typing in between.** That is the claim the whole arc rests on, and it is worth stating plainly.

**Do not print a `/join <name>` chip**, here or anywhere. The shade summons itself; a chip beside it teaches the user that nothing happens until they type, which is the belief this whole arc exists to retire ([D147], [D152]).

**On the hand-driven path**, continuing has two doors and both are already built: `plan-review` prints the `/tugplug:dash-implement <path>` chip, and a bare `/dash` orients ([stage 1](#1-orient)), finds the reviewed plan, and offers to carry it. Either way, continuing means reading `../dash-implement/SKILL.md` and carrying the plan through that contract — its setup gate, its ledger walk, its per-step checkpoints and rounds, its ending. Nothing about the run changes for having arrived through `/dash`, and its ending is the same one the arc reaches: the fit verified, the join draft written, the arc armed, no chip.

## Guardrails

- **No sub-agents.** Orchestrate, delegate, and work in-thread.
- **Delegate by reading, never by restating.** A stage's mechanics live in the sibling's `SKILL.md`; reproducing them here creates a second copy to drift.
- **Own the narration, not the machinery.** `/dash` creates no worktree, commits nothing, and joins nothing. The delegated contract's guardrails govern while it runs.
- **Ask about the design, never the process.** The routing question is one question. Everything else is bounded by the doctrine's never-ask list — nothing with a conventional default, and never "should I continue?".
- **Resolve the paperwork home; never assume one.** `tugutil dash docs-dir`, asked once per project and recorded with `--set`. There is no blessed directory name.
- **An arc opens on a document, never on an idea.** Write the brief in this conversation first, on the user's model. `tugutil dash run --document` takes a path that exists.
- **Hand off by ending the turn.** The first rotation happens at *this* turn's end, so issuing `dash run` is the last thing you do — never wait on it, never poll it, never print a command to start it.
- **Under an arc there is no review gate.** The review is a stage on its own fresh session, reading the plan cold. Off the arc, the fork below still stands: print the chip and stop; do not review on a model that is not the review model.
- **Landing is the user's act.** Stop before the join, every time.

## When to reach for something else

Nothing here is exclusive. A user who knows exactly what they want should type it: `/tugplug:plan-devise`, `/tugplug:dash-on`, `/tugplug:spike-card`, `/tugplug:plan-review`, `/tugplug:dash-implement`. `/dash` exists so that knowing the roster is not the price of starting — it is the door for people who do not yet know which room they want, and it stops being needed the moment they do.
