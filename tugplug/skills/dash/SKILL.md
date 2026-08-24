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
| Plan arc | `plan-devise` → review → `dash-implement` | Work with enough parts that the order matters |
| Brief first | `tuglaws/brief-skeleton.md`, then the plan arc | Work whose *decisions* are the hard part, and want settling before any step is written |

**This skill sequences; it does not restate.** At each hand-off it reads the sibling's own `SKILL.md` and carries out that contract in-thread. The expert skills remain the single source of truth for their own mechanics — an edit to `plan-devise` is picked up here with no second file to keep in step. What `/dash` owns, and no sibling does, is the connective narration: saying where the arc stands at each boundary, so the user never has to hold the sequence in their head.

**You are the orchestrator, in-thread.** Do not spawn sub-agents (`Task`). The plugin is agentless by charter.

**`/dash` itself never creates a worktree, never commits, and never joins.** While a delegated contract runs, that contract's guardrails govern — including `dash-implement`'s and `dash-on`'s sanctioned `tugutil dash create` / `tugutil dash commit`. The shared discipline is [`tuglaws/dash-work-doctrine.md`](../../../tuglaws/dash-work-doctrine.md), and the stop-before-join obligation is unchanged: landing is the user's act.

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

Then look for an arc mid-flight. Glob `<docs>/*.md`, run `tugutil plan status <path> --json` over the candidates, and read `data.review`. A plan that is `reviewed` and whose steps are all `pending` is a reviewed-but-unadopted plan — the arc's most common resting place, because the review is a turn boundary ([the review gate](#5-stop-at-the-review-gate)). Name it and offer to carry it into `dash-implement`.

**A lone argument that names an existing dash is a continuation, not a new idea.** `/dash <name>` was the retired spelling of `/dash-bind` for long enough to be muscle memory, and what a user types there — a bare slug, no verb, no sentence — is exactly what an existing dash is called. So before reading a short argument as an idea, check it against `tugutil dash list`. On a hit, say which dash it is and offer to continue it: resume its plan through `dash-implement`, or bind this card to it with `/dash-bind` when the binding is all they wanted. Guessing "new idea" here starts a second dash beside the one they meant.

Invoked bare with nothing in flight, ask what to work on. That is the whole of the empty case — no menu, no roster of commands.

### 2. Sharpen

Converse about the idea until it is concrete enough to route. This is a conversation, not an intake form: a few sharp questions beat a checklist, and an already-specific idea passes straight through to the routing gate without a single question.

What is worth asking is bounded by the doctrine's [never-ask list](../../../tuglaws/dash-work-doctrine.md#what-never-gets-asked): design questions, never process ones, and nothing with a conventional default. Where that document is absent, that sentence is the boundary.

Read enough code to ask a good question. An idea sharpened against the real files ("this touches the store or the card — which did you mean?") is worth three rounds of sharpening it in the abstract.

### 3. Route

One `AskUserQuestion`, four options, the recommended one first:

- **Quick dash** — `dash-on`. Small and concrete; the work is clear and the plan would be ceremony.
- **Plan arc** — `plan-devise` → review → `dash-implement`. Enough parts that the order matters.
- **Brief first, then plan** — the decisions are the hard part and want settling before any step is written.
- **Design spike** — `spike-card`. Visual or exploratory; the answer is something to look at.

Recommend from the sharpened idea rather than from a rule: small and concrete leans quick, visual leans spike, decision-heavy leans brief-first, many-moving-parts leans plan. The user chooses; the recommendation is a reading, not a verdict.

**Skip the question when the invocation already names the shape.** "spike this", "quick fix:", "plan this out", "write me a brief" are answers already given, and asking anyway is the ceremony this skill exists to remove.

### 4. Delegate

Read the chosen sibling's `SKILL.md` — relative to this skill's own base directory — and carry out its contract in-thread:

| Route | Read |
|---|---|
| Quick dash | `../dash-on/SKILL.md` |
| Design spike | `../spike-card/SKILL.md` |
| Plan arc | `../plan-devise/SKILL.md` |
| Brief first | `tuglaws/brief-skeleton.md`, then `../plan-devise/SKILL.md` |

**The brief-first route writes the brief before the plan.** It goes in the docs directory resolved in stage 1, against the brief skeleton — findings as `[F##]`, decisions as `[B##]` — and it is a brief, not a small plan: no execution steps, no ledger, no checkpoints. The boundary is mechanical rather than conventional, because `tugutil plan lint` detects a plan *positively* by its `{#execution-steps}` section and exits 2 on anything else. Then continue into `plan-devise`, with the plan citing the brief's `[B##]` decisions rather than re-deciding them.

Say which contract you are entering as you enter it. The hand-off is the moment the user would otherwise lose the thread, and naming it is most of what the narration is for.

### 5. Stop at the review gate

A plan is not ready when it is written; it is ready when it has been reviewed. Which happens next is `plan-devise` §5's fork, inherited whole:

- **On Opus** — the review runs inline, in the same turn, because the model that would be handed the job is already the one holding it. Lint, judge against `tuglaws/plan-review-rubric.md` and the real code, apply the fixups, append the Review Record, and stamp with `tugutil plan stamp` as the last edit.
- **On anything else** — stop. Say the plan is written and **unreviewed**, print `` `/tugplug:plan-review <path>` `` on its own line inside backticks, and say plainly that clicking it reviews the plan on whatever model is selected at that moment — so switching first is the user's call and their opportunity to make it.

**Never switch the user's model, in either direction, and never schedule a turn on their behalf.** The arc spanning turns here is the design, not a gap in it: the review is where judgment lands, and the model choice belongs to the user.

### 6. Continue

After the review, the arc has two doors and both are already built: `plan-review` prints the `/tugplug:dash-implement <path>` chip, and a bare `/dash` orients ([stage 1](#1-orient)), finds the reviewed plan, and offers to carry it.

Either way, continuing means reading `../dash-implement/SKILL.md` and carrying the plan through that contract — its setup gate, its ledger walk, its per-step checkpoints and rounds, its ending. Nothing about the run changes for having arrived through `/dash`.

The run ends where every dash run ends: the fit verified, the join draft written, and the arc armed. **Do not print a `/join <name>` chip.** The Changes shade reveals itself on the bound card and says what the join would land; a chip beside it teaches the user that nothing happens until they type, which is the belief this whole arc exists to retire.

## Guardrails

- **No sub-agents.** Orchestrate, delegate, and work in-thread.
- **Delegate by reading, never by restating.** A stage's mechanics live in the sibling's `SKILL.md`; reproducing them here creates a second copy to drift.
- **Own the narration, not the machinery.** `/dash` creates no worktree, commits nothing, and joins nothing. The delegated contract's guardrails govern while it runs.
- **Ask about the design, never the process.** The routing question is one question. Everything else is bounded by the doctrine's never-ask list — nothing with a conventional default, and never "should I continue?".
- **Resolve the paperwork home; never assume one.** `tugutil dash docs-dir`, asked once per project and recorded with `--set`. There is no blessed directory name.
- **The review gate is a turn boundary off Opus.** Print the chip and stop; do not review on a model that is not the review model.
- **Landing is the user's act.** Stop before the join, every time.

## When to reach for something else

Nothing here is exclusive. A user who knows exactly what they want should type it: `/tugplug:plan-devise`, `/tugplug:dash-on`, `/tugplug:spike-card`, `/tugplug:plan-review`, `/tugplug:dash-implement`. `/dash` exists so that knowing the roster is not the price of starting — it is the door for people who do not yet know which room they want, and it stops being needed the moment they do.
