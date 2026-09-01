---
name: dash
description: Dash — sharpen an idea into a brief and a task list, then hand it to the wheel, which walks the steps and audits the landed code on fresh sessions of its own
argument-hint: "[name] [instruction…]"
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, AskUserQuestion
disallowed-tools: Task
---

## What this is

A **dash** is work that leaves the base on an isolated worktree and comes back through a **join**. This skill is one of the two **doors** onto that lane, and a door's whole job is to settle what the work is and hand it over. The **wheel** does the rest: it rotates the stages on fresh sessions of its own, on this same card, one step per turn, and reads the landed code cold at the end.

The two doors differ by **settling time**, and by nothing else:

- **`/dash`** — the brief and the **task list** are written here, in this conversation, and the wheel opens straight at implement. Brief → implement → audit.
- **`/dash-plan`** — the brief is written here and a **plan** is devised and cold-reviewed before the first step is walked. Brief → devise → review → implement → audit.

Everything downstream of the ledger is identical in the two: one step per turn, compaction between steps, an audit of the whole diff by a session that never saw the run, the join offered through the Changes shade. `/dash` is not a lesser lane; it is the same lane entered by a door that has already answered what devise and review would have asked.

**Which door they typed is the routing decision**, and it was made before you read this. Nothing here asks the user to choose a route.

**The wheel is a hand-off, not a sequence you run.** A running model cannot drive it — it cannot end its own turn to start the next stage, and each stage wants a session that has never seen the last one's context. So this skill writes two documents, runs `tugtool dash run`, and ends the turn. **This door creates no worktree, commits nothing, implements nothing, and joins nothing.**

**You are the orchestrator, in-thread.** Do not spawn sub-agents (`Task`).

**Read [`tuglaws/dash-work-doctrine.md`](../../../tuglaws/dash-work-doctrine.md)** for the discipline the run works under. This skill states the door; the doctrine states the rules. **When the project has no `tuglaws/`,** those documents are absent and cannot be read — there is no brief format and no linter standing in for one. Write the six beats below and say plainly that the judgment half of the format is missing; do not reconstruct it from memory.

## Input grammar

`/dash <name> <instruction…>` — settle the dash `<name>` from `<instruction>` and hand it to the wheel.

`<name>` is alphanumeric + hyphens, 2+ chars, and everything after it is the instruction. There are no sub-verbs: joining is the `/dash-join` card verb, the readouts are `tugtool dash status|show|list`, and discard is a bare CLI call the user makes.

**A bare `/dash <name>` that names an existing dash is a continuation.** Read what the dash already knows — `tugtool dash documents <name> --json` for its documents, `tugtool dash arc <name> --json` for where its course stands — say where it is, and offer to resume it with `tugtool dash run <name>`. Guessing "new idea" here starts a second dash beside the one they meant.

## The door

### 1. Orient

Before asking the user anything, find out what is already in flight:

```bash
tugtool dash status              # what this card is bound to, if anything
tugtool dash list --json         # what dashes exist
tugtool dash documents <name> --json   # which documents a dash has
```

A dash with no documents directory is a **state, not an error**: the verb exits 0 saying every document is absent, which is where every new dash starts.

**A stopped course is the one thing that will never announce itself.** `tugtool dash arc <name> --json` reports it; `data.arc.stopped` names the stage and the reason. Say both and offer the resume, which is the same verb — `tugtool dash run <name>` — because the documents hold the progress and a stage never re-runs work that landed.

**A lone argument that names an existing dash is a continuation, not a new idea.** Check a short argument against `tugtool dash list` before reading it as an instruction.

### 2. Sharpen

Converse until the work is concrete. This is a conversation, not an intake form: a few sharp questions beat a checklist, and an already-specific instruction passes straight through without a single question.

What is worth asking is bounded by the doctrine's [never-ask list](../../../tuglaws/dash-work-doctrine.md#what-never-gets-asked): design questions, never process ones, and nothing with a conventional default. Where that document is absent, that sentence is the boundary. **A question the code can answer is not a question for the user** — read the code and write the answer into the brief as a `[B##]`.

**This is the last place a question can be asked.** Once the hand-off happens, the run answers its own unknowns and finishes.

### 3. Write the brief

Both doors open on a brief, and the brief is what carries this conversation's settling to sessions that will never see it. Settle the dash's name first, then:

```bash
tugtool dash documents <name> --ensure --json
```

Write the brief to the `brief` path it prints, against [`tuglaws/brief-skeleton.md`](../../../tuglaws/brief-skeleton.md). Its six beats: the **purpose** in the user's own terms, the **evidence** actually observed, the **decisions** already settled, what is **out of scope**, the **open questions** that remain, and the **shape** the work is expected to take. A brief opens at `#` and carries no execution steps.

**Carry the sharpening conversation's settled calls into it** — the decisions as `[B##]`, the observations as `[F##]`. This is the whole reason the door writes a document at all: the fresh session that reads it cold must lose nothing this conversation decided.

**When the project has no `tuglaws/`**, write those six beats from this description and say the format document is absent.

`tugtool plan lint` exits 2 on a brief — "not a plan document" — and that is correct rather than a failure. A brief is detected as a non-plan by having no `{#execution-steps}` section, which is the same mechanism that routes it.

### 4. Write the task list

This is what makes this door the `/dash` door: the steps are settled here rather than by a devise stage, and their existence is what tells the wheel to open at implement.

Write **this document** to the `tasks` path `dash documents` printed — the whole of it, and nothing more:

```markdown
# <What the work is, in a phrase> {#tasks}

<One or two sentences: the instruction restated as what will be true when this is done.>

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | <title> | pending | — |
| #step-2 | <title> | pending | — |

#### Step 1: <Title> {#step-1}

<A sentence or two on what this step does, and how it will be checked.>

#### Step 2: <Title> {#step-2}

<A sentence or two.>
```

**Every row `pending`, and no commits.** The other cells belong to the run, and `tugtool dash step` writes them.

**Size it to the work.** A one-line fix is one step and reads `1/1` when it lands — a task list of one is the form telling the truth. Something with three distinct pieces is three.

**This is deliberately not a plan.** No metadata, no phase overview, no success criteria, no review record — those are the devise stage's contract, and `tugtool plan lint` is the check for it, which a task list does not aim to pass. What it must do is **parse**: an `{#execution-steps}` section, a `{#step-status-ledger}` table whose first cell is each step's anchor, and a `#### Step N: … {#step-N}` heading per row. That is what the step verbs read, and a document that does not parse is refused rather than guessed at.

**The advisory, when the work reads plan-shaped.** If what you have sharpened has many interdependent parts, or its *order* is itself the problem, or its decisions want settling before any step is written — say so in **one sentence** and offer `/dash-plan <name>`, then do what the user says. Never an `AskUserQuestion`: offering a menu of routes to somebody who already typed one is the ceremony these two doors exist to remove.

### 5. Hand off

```bash
tugtool dash run <name> --course dash
```

`--course dash` is what makes this the dash course: implement → audit, no devise stage and no review stage, because this door answered what both of them ask. The flag records the kind in the course's own durable record, so the runner reads it rather than guessing from which documents happen to be on disk. Omitted, it defaults to `plan` — the other door's course — so it is not optional here.

The verb otherwise takes no document: it opens on what the dash has.

It refuses without a calling session, because a course runs *on a card* and there would otherwise be nowhere for a stage to rotate. It records the course, binds this session to the dash, and returns — **and the first rotation happens when this turn ends, not on arrival.** That ordering is not incidental: the request is issued from inside your own turn, and rotating on receipt would kill the session mid-sentence.

**Read the receipt before you end the turn.** That is not polling and it is not waiting: the verb has already returned, and its own words are the one place the anchor is visible. Confirm two things in them — that the arc opened or resumed, and that the session it names is a **live** one. `--json` says both directly: `started` or `resumed` is true, and `tug_session_id` is the server's answer rather than the id this shell was born holding.

A run whose receipt names no live session has bound the course to nothing, and every stage it seats will rotate onto a card that is not there. **If the receipt is not what it should be, say so and run `tugtool dash doctor <name>`** — it compares the course record against the binding and the ledger and names which disagrees. This is the one session that can see the anchor being set; a stage that finds it wrong later has to recover from it instead.

With the receipt confirmed, issuing that command was the last thing you do. Say what happens next, and end the turn. **Ending the turn is the hand-off.** Do not wait for a rotation, do not poll `dash arc`, and do not print a command for the user to click.

### 6. Say what happens next

Nothing else will speak until the run is over, so tell the user what they are about to watch, in a few sentences:

- **One card, one scroll.** Every stage runs on *this* card, on a fresh claude session, and the transcript is not cleared between them. A labelled divider marks each boundary, naming the stage, its model, and the document it opened on.
- **Two stages, then a stop.** Implement walks the task list — one step per turn, a commit per step — and audit reads the whole landed diff cold against the task list and the brief, fixing what does not match. A stage that fails writes why and stops rather than retrying; `tugtool dash run <name>` resumes exactly there.
- **The ending is the join offer.** When the audit marks the dash, the Changes shade reveals itself on this card carrying the message the join would land.
- **Nothing needs typing in between.**

**Do not print a `/dash-join <name>` chip.** The shade summons itself; a chip beside it teaches the user that nothing happens until they type, which is the belief the wheel exists to retire.

## Guardrails

- **This door writes documents and ends its turn.** No worktree, no commits, no implementation, no audit, no join. Every one of those belongs to a stage of the course.
- **Both documents, before the hand-off.** A brief with no task list opens the wrong course; a task list with no brief hands the audit nothing to judge intent against.
- **Never lint the task list, and never grow it into a plan.** A task list that wants a plan's frame wanted the other door.
- **Ask about the design, never the process.** Bounded by the doctrine's never-ask list — nothing with a conventional default, nothing the code can answer, never "should I continue?".
- **The advisory is a sentence, never a dialog.** One offer of `/dash-plan`, then do what the user says.
- **`--course dash`, always.** The flag is what records this door's progression; without it the course defaults to the other door's and opens at devise over a brief this door already settled.
- **Read the receipt, then end the turn.** The first rotation happens at *this* turn's end, so `dash run` is the last thing you do — but its receipt is a returned value, not a thing to wait for, and confirming it names a live session is this session's one chance to see the anchor set. Never wait on the rotation, never poll `dash arc`.
- **Landing is the user's act.** The course stops before the join, every time.
- **Never discard on your own initiative.** `tugtool dash discard` destroys work; it is named here only so that rule has somewhere to live.

## When to reach for something else

The other door is `/dash-plan`, for work whose decisions want settling before any step is written. Something the user mostly wants to *look at* belongs at `/tugplug:spike-card`.

**The stage skills are not among the alternatives.** `dash-devise`, `dash-review`, `dash-implement`, and `dash-audit` are stages of a course, and each refuses to run outside one — they are internal machinery rather than doors, and there is no one-stage course for a typed invocation to land in. A plan that exists and wants reviewing, or a ledger that exists and wants walking, is a dash whose course is resumed with `tugtool dash run <name>`.
