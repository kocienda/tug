---
name: arc
description: Arc — sharpen an idea into a brief, decide whether it wants a plan, and hand it to the wheel, which walks the work and audits the landed code on fresh sessions of its own
argument-hint: "[name] [instruction…]"
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch, AskUserQuestion
disallowed-tools: Task
---

## What this is

An **arc** is work that leaves the base on an isolated worktree and comes back through a **join**. `/arc` is the **one door** onto that lane, and a door's whole job is to settle what the work is and hand it over. The **wheel** does the rest: it rotates the stages on fresh sessions of its own, on this same card, one step per turn, and reads the landed code cold at the end.

An arc opens in one of two shapes, and they differ by **settling time** and by nothing else:

- **plain** — the brief and the **task list** are written here, in this conversation, and the wheel opens straight at implement. Brief → implement → audit.
- **planned** — the brief is written here and nothing else; the wheel devises a plan from it and reads that plan **cold** before the first step is walked. Brief → devise → review → implement → audit.

Everything downstream is identical: one step per turn, compaction between steps, an audit of the whole diff by a session that never saw the work, the join offered through the Changes shade. A plain arc is not a lesser lane; it is the same lane entered by a door that has already answered what devise and review would have asked.

**Which shape the arc takes is decided here, by this skill, in step 4.** It is not a route the user picks from a menu and not a flag anybody passes: the two documents this door leaves are what say which shape it is, and the engine reads the shape off them when the arc opens.

**The wheel is a hand-off, not a sequence you run.** A running model cannot drive it — it cannot end its own turn to start the next stage, and each stage wants a session that has never seen the last one's context. So this skill writes the brief, decides the shape, writes the task list when the shape is plain, runs `tugtool arc run`, and ends the turn. **This door creates no worktree, commits nothing, implements nothing, and joins nothing.**

**You are the orchestrator, in-thread.** Do not spawn sub-agents (`Task`). The plugin is agentless by charter.

**Read [`tuglaws/arc-work-doctrine.md`](../../../tuglaws/arc-work-doctrine.md)** for the discipline the arc works under. This skill states the door; the doctrine states the rules. **When the project has no `tuglaws/`,** that document is absent and cannot be read; the discipline that survives is the one the stage skills carry inline — one working root, verify before every commit, never commit red, rounds through `tugtool arc commit`, stop before the join. Say so once, at the start, so the user knows which fidelity they are getting; do not reconstruct the missing document from memory.

## Input grammar

`/arc [name] [instruction…]`

Tokens are the invocation's whitespace-split arguments after the command. These rules apply in order, and the first that matches wins.

1. **A path token anywhere.** A token containing `/` or ending in `.md` that resolves, relative to the project root, to a readable file is a **handed-in brief**. Copy it (step 3). If another token is slug-shaped (rule 3), that is the name; otherwise the name is the file's stem with a trailing `-brief` removed — `briefs/one-door-brief.md` becomes `one-door`. Remaining tokens are instruction. Skip sharpening for whatever the brief already settles: the door settles only the name and the shape.
2. **A lone token** that is a well-formed arc name — ASCII alphanumerics and hyphens, at least two characters, accepted by `tugtool arc list`'s naming rule, and not a reserved word such as `status` — is the arc's name. If `tugtool arc list --json` or `tugtool arc documents <name> --json` shows the arc exists, this is a **continuation**: read its documents and its record, say where it stands, and offer to continue. If it does not exist, open the conversation on a new arc under that name and ask what to work on.
3. **A first token that is slug-shaped** — at least one hyphen, otherwise ASCII alphanumeric, at least two characters — followed by more tokens is the name, and everything after it is the instruction. A single unhyphenated word followed by prose is **prose**, not a name: `/arc make the ring pulse` opens on an idea.
4. **Anything else** is the idea in prose. Settle the name in conversation and state it in the hand-off sentence.
5. **No tokens.** With a stopped or resumable arc in flight (per Orient), name it and offer to continue. Otherwise ask what to work on — no menu, no roster of commands.

There are no sub-verbs: joining is the `/arc-join` card verb, the readouts are `tugtool arc status|show|list`, and discard is a bare CLI call the user makes.

## The door

### 1. Orient

Before asking the user anything, find out what is already in flight:

```bash
tugtool arc status              # what this card is bound to, if anything
tugtool arc list --json         # what arcs exist
```

An arc's documents live at `.tug/arcs/<name>/`, and `tugtool arc documents <name> --json` says which of them exist. An arc with no directory is a **state, not an error** — the verb exits 0 with every document absent, which is where every new arc starts. Documents are not tracked and so never appear in `tugtool changes`; the filesystem is the record, and that verb is what reads it. Run it for each name `arc list` reports.

Then look for an arc mid-flight. `tugtool plan status <name> --json` reads an arc's ledger document — its plan, or its task list when that is all it has; `data.review` is the answer for a plan. A plan that is `reviewed` and whose steps are all `pending` is a settled plan nobody has started. Name it and offer to resume its arc. An arc already carrying a brief and nothing else is this door's own product waiting to be handed over, and naming it is usually the whole of Orient.

**A stopped arc is the one thing that will never announce itself.** The wheel rotates on a tick, so when an arc stops there is no gesture nobody made to explain the stillness. So read it:

```bash
tugtool arc record <name> --json     # per arc from `arc list`; no arc exits 0 with `arc: null`
```

`data.arc.stopped` names the stage and the reason. Say both, and stop there — the resume re-rotates the stopped stage and nothing earlier, a stage never re-runs work that already landed, and the ledger is what it picks up against. There is nothing to warn about.

**Never offer the resume by naming a command.** A stopped arc's receipt carries its own **Resume** button, and a CLI verb typed into the transcript beside it is the implementation the button exists to hide. `tugtool arc run <name>` is the machine's way in and stays exactly that.

**When an arc looks bound to the wrong thing, diagnose before you re-bind.** `tugtool arc doctor <name>` compares all four of an arc's records — the ledger table, the arc log, the sqlite binding, and the arc record — and names each disagreement in a sentence, offering the reconciling append where one exists. `/arc-bind` writes one of those four and answers nothing about the other three, so a bind that exits 0 over a stopped arc or a desynced ledger is a success that changed nothing. Reach for the doctor first, and for `/arc-bind` only when the doctor says the binding is the thing that is wrong.

Invoked bare with nothing in flight, ask what to work on. That is the whole of the empty case.

### 2. Sharpen

Converse until the work is concrete. This is a conversation, not an intake form: a few sharp questions beat a checklist, and an already-specific instruction passes straight through without a single question. **An idea is already specific when this session already holds its design** — a spike card the user had you read, a brief or plan they pointed at, a thread of decisions made in this conversation. The invocation then names what to do with that design, and nothing about it is asked again.

What is worth asking is bounded by the doctrine's [never-ask list](../../../tuglaws/arc-work-doctrine.md#what-never-gets-asked): design questions, never process ones, and nothing with a conventional default. Where that document is absent, that sentence is the boundary. **A question the code can answer is not a question for the user** — a wire field that is missing, a hook that skips a case, a component with no remaining mount. Read the code and write the answer into the brief as a `[B##]` decision or an `[F##]` finding; a dialog that asks the user to choose between two readings of the codebase is the brief's work handed back to them.

Read enough code to ask a good question. An idea sharpened against the real files ("this touches the store or the card — which did you mean?") is worth three rounds of sharpening it in the abstract.

**This is the last place a question about the work can be asked.** Once the hand-off happens, the arc answers its own unknowns and finishes.

### 3. Write the brief

Every arc opens on a brief, and the brief is what carries this conversation's settling to sessions that will never see it. Settle the arc's name first, then:

```bash
tugtool arc documents <name> --ensure --bind --json
```

`--bind` binds this session to the arc in the same act that makes its directory, so the Session card reads `ARC` from the door's first command rather than from its last. It is not optional: an arc the card cannot see is an arc nobody is watching.

Write the brief to the `brief` path it prints, against [the brief skeleton](../brief/brief-skeleton.md). Its six beats: the **purpose** in the user's own terms, the **evidence** actually observed, the **decisions** already settled, what is **out of scope**, the **open questions** that remain, and the **shape** the work is expected to take. Read the skeleton before writing; it is the format contract, and it says which sections may be omitted when they have nothing to say.

**Carry this conversation's settled calls into it** — the decisions as `[B##]`, the observations as `[F##]`. This is the whole reason the door writes a document at all: the fresh session that reads it cold must lose nothing this conversation decided. A brief that merely restates the user's opening sentence has thrown the sharpening away.

**A handed-in brief is copied, never edited in place.** When the invocation carried a path (grammar rule 1), copy its bytes verbatim to the `brief` path the verb printed and leave the source alone:

```bash
cp <the path they handed you> <the brief path>
```

The copy is what makes the arc self-contained — every stage reads the arc's own directory, so the arc survives the source file moving or changing. If the arc already has a `brief.md` whose contents differ from the handed-in file, say so and treat the invocation as a **continuation** of the existing arc rather than overwriting it.

`tugtool plan lint` exits 2 on a brief — "not a plan document" — and that is correct rather than a failure. A brief is detected as a non-plan by having no `{#execution-steps}` section, which is the same mechanism that routes it.

### 4. Decide the kind

One bit, decided here: **plain** (write the task list; the arc opens at implement) or **planned** (leave the brief alone; the wheel devises and reviews a plan before a step is walked). Three deciders, in order, and the first that settles it wins.

1. **Prose decides outright.** In the invocation or in the conversation. "plan this", "devise a plan", "plan it first", "review before walking" → planned. "just go", "no plan", "straight to implement", "small fix" → plain. A handed-in brief that carries its own exit line naming a plan ("Exit: a plan") → planned; one naming steps, or "just do it" → plain.
2. **Your own reading.** With the prose silent, write the task list **when you can write one you would stand behind**: the decisions are settled, the steps are few, and their order is not itself a problem. Leave the brief alone when the decisions are not settled, or when the *order* of the parts is itself the problem, or when a cold review would catch something this conversation cannot.
3. **Ambiguity asks once.** Only when your reading and the prose disagree, or you have no reading you would stand behind: one `AskUserQuestion`, one question, exactly two options — (a) write the task list now and open at implement; (b) write the brief alone and let the wheel devise and review a plan first. No third option, and never re-asked in the same conversation.

**A quarter or fewer of arcs warrant the planned shape.** Plain is the expected answer, and a door that asks on most arcs has the threshold wrong.

### 5. Write the task list — plain arcs only

On a **planned** arc, skip this step entirely: the plan is the devise stage's product, judged by the review stage, and a task list beside the brief is what would make the arc plain instead. **The brief is the whole output of a planned arc's door.**

On a **plain** arc, the steps are settled here rather than by a devise stage, and their existence is what tells the wheel to open at implement. Write **this document** to the `tasks` path `arc documents` printed — the whole of it, and nothing more:

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

**Every row `pending`, and no commits.** The other cells belong to the arc, and `tugtool arc step` writes them.

**Size it to the work.** A one-line fix is one step and reads `1/1` when it lands — a task list of one is the form telling the truth. Something with three distinct pieces is three.

**This is deliberately not a plan.** No metadata, no phase overview, no success criteria, no review record — those are the devise stage's contract, and `tugtool plan lint` is the check for it, which a task list does not aim to pass. What it must do is **parse**: an `{#execution-steps}` section, a `{#step-status-ledger}` table whose first cell is each step's anchor, and a `#### Step N: … {#step-N}` heading per row. That is what the step verbs read, and a document that does not parse is refused rather than guessed at.

### 6. Hand off

```bash
tugtool arc run <name>
```

The verb takes no flag and no document: it opens on what the arc has, and **the documents are what say which shape the arc is**. A task list with no plan beside it opens a plain arc at implement; a brief alone, or a plan, opens a planned one at devise. The engine derives that once, at the opening, and records it — so every stage after reads the record rather than sniffing the directory again, and a plan the devise stage writes later does not re-decide anything.

It refuses without a calling session, because an arc runs *on a card* and there would otherwise be nowhere for a stage to rotate. It records the arc, binds this session to it, and returns — **and the first rotation happens when this turn ends, not on arrival.** That ordering is not incidental: the request is issued from inside your own turn, and rotating on receipt would kill the session mid-sentence.

**Every ledger gesture from here on draws itself on the card**: the arc created, the selection declared, each step opened and closed, each round committed. The server reads them off the **arc log** — the record the verbs already write — so the line is a derived view rather than something a stage is asked to remember. That is what the user watches an arc by, and it is machinery rather than a stage's manners: nothing you do or forget can add or remove one.

**Read the receipt before you end the turn.** That is not polling and it is not waiting: the verb has already returned, and its own words are the one place the anchor is visible. Confirm two things in them — that the arc opened or resumed, and that the session it names is a **live** one. `--json` says both directly: `started` or `resumed` is true, and `tug_session_id` is the server's answer rather than the id this shell was born holding.

An arc whose receipt names no live session is bound to nothing, and every stage it seats will rotate onto a card that is not there. **If the receipt is not what it should be, say so and run `tugtool arc doctor <name>`** — it compares the arc record against the binding and the ledger and names which disagrees. This is the one session that can see the anchor being set; a stage that finds it wrong later has to recover from it instead.

With the receipt confirmed, issuing that command was the last thing you do. Say what happens next, and end the turn. **Ending the turn is the hand-off.** Do not wait for a rotation, do not poll `arc record`, and do not print a command for the user to click.

### 7. Say what happens next

Nothing else will speak until the arc is over, so tell the user what they are about to watch.

**Name the shape, in one sentence, every time.** One of these two forms:

> Opened `<name>` as a plain arc — task list written, opens at implement.

> Opened `<name>` as a planned arc — brief alone, the wheel devises and reviews a plan first.

Then, in a few sentences:

- **One card, one scroll.** Every stage runs on *this* card, on a fresh claude session, and the transcript is not cleared between them. A labelled divider marks each boundary, naming the stage, its model, and the document it opened on.
- **The stages, then a stop.** A plain arc: implement walks the task list — one step per turn, a commit per step — and audit reads the whole landed diff cold against the task list and the brief. A planned arc puts devise and review in front of those two: devise writes the plan from the brief, review reads it cold and stamps it. Either way a stage that fails writes why and stops rather than retrying, and `tugtool arc run <name>` resumes exactly there.
- **The ending is the join offer.** When the audit marks the arc, the Changes shade reveals itself on this card carrying the message the join would land, plus one receipt row saying which stages ran and on which sessions. Until then the arc's own strip says which cell it is in, so an arc still checking its work does not read as one waiting to be joined.
- **Nothing needs typing in between.** That is the claim the whole arc rests on, and it is worth stating plainly.

**Do not print a `/arc-join <name>` chip.** The shade summons itself; a chip beside it teaches the user that nothing happens until they type, which is the belief the wheel exists to retire.

## Guardrails

- **This door writes documents and ends its turn.** No worktree, no commits, no implementation, no audit, no join. Every one of those belongs to a stage of the arc.
- **No sub-agents.** Orchestrate, delegate, and work in-thread.
- **An arc's documents live at its own address.** `.tug/arcs/<name>/`, never in the working tree, and `tugtool arc documents <name>` is what reports them. Nothing is declared and nothing is asked.
- **An arc opens on a document, never on an idea.** Write the brief in this conversation first, on the user's model. `tugtool arc run <name>` needs a document to exist, and inventing one to satisfy it is inventing the decisions it was supposed to carry.
- **The documents are the shape.** A plain arc leaves a brief and a task list; a planned arc leaves the brief alone. Writing a task list beside a brief you meant as planned opens the wrong arc, and so does leaving one out of a plain one.
- **Never write a plan here.** That is the devise stage's product, judged by a stage that reads it cold, and coldness is the whole of what a planned arc buys.
- **Never lint the task list, and never grow it into a plan.** A task list that wants a plan's frame wanted the other shape, and that is step 4's decision, not a document's.
- **Ask about the design, never the process.** Bounded by the doctrine's never-ask list — nothing with a conventional default, nothing the code can answer, never "should I continue?".
- **The kind is asked about at most once**, with exactly two options, and only when step 4's first two deciders both come up empty.
- **Read the receipt, then end the turn.** The first rotation happens at *this* turn's end, so `arc run` is the last thing you do — but its receipt is a returned value, not a thing to wait for, and confirming it names a live session is this session's one chance to see the anchor set. Never wait on the rotation, never poll `arc record`.
- **Diagnose before re-binding.** `tugtool arc doctor <name>` reads all four of an arc's records and says which disagrees; `/arc-bind` writes one and answers nothing about the rest.
- **There is no review gate.** On a planned arc the review is a stage on its own fresh session — there is nothing here to hold and no chip to print.
- **Landing is the user's act.** The arc stops before the join, every time.
- **Never discard on your own initiative.** `tugtool arc discard` destroys work; it is named here only so that rule has somewhere to live.

## When to reach for something else

Something the user mostly wants to *look at* — a layout, a treatment, a shape whose answer is visual — belongs at `/tugplug:spike-card`.

**The stage skills are not among the alternatives.** `arc-devise`, `arc-review`, `arc-implement`, and `arc-audit` are stages of an arc, and each refuses to run outside one — they are internal machinery rather than doors, and there is no one-stage arc for a typed invocation to land in. A plan that exists and wants reviewing, or a ledger that exists and wants walking, is an arc that is resumed with `tugtool arc run <name>`.
