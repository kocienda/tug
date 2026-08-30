---
name: dash
description: Dash directly — work an idea on an isolated worktree in this very conversation, against a task list you write; no brief, no plan review, no arc; committing per round and stopping before the join
argument-hint: "[name] [instruction…]"
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, AskUserQuestion
disallowed-tools: Task
---

## What this is

A **dash** is work that leaves the base on an isolated worktree and comes back through a **join**. This skill runs one **directly**: **you — the main conversation — do the work yourself**, in this thread, on the dash's worktree, riding the `tugtool dash` verbs, committing each round and stopping before the merge. A bug fix, a small feature, a prototype, a refactor whose shape is already clear. *Give me a worktree and let me work* is the whole of it.

Directly does not mean blind. Before the first round you write the dash's **task list** — the steps the work breaks into, in the dash's own plan file. It is not the arc's plan: no brief, no phase overview, no review, no linting. It is the ledger that every dash face counts its fraction from, and the memory a session that has never seen this conversation reads when the dash is picked up tomorrow. [The task list](#the-task-list) says what to write and how much.

(When the *decisions* are the hard part, or the parts are many enough that their order is itself a problem, the other route is the arc: `/dash-plan` settles the idea into a plan and hands it to the wheel, which rotates review → implement → audit on fresh sessions of its own. This skill's work is yours; that one's is delegated.)

**Read [`tuglaws/dash-work-doctrine.md`](../../../tuglaws/dash-work-doctrine.md) before you start.** It is the discipline every dash run works under — the one-and-only-working-root rule, the verification bar, test discipline and the banned test shapes, law discipline, round mechanics, the stop-before-join obligation, and no plan numbers in durable artifacts. This skill states the flow; the doctrine states the rules, and it is not repeated here.

**When the project has no `tuglaws/`,** the doctrine document is absent and cannot be read. The rules that survive its absence are the ones this skill carries inline — one working root, verify before every commit, never commit red, rounds through `tugtool dash commit`, stop before the join — and they are the discipline for the run. Say so once, at the start; do not invent the rest of the doctrine from memory.

## Input grammar

`/dash <name> <instruction…>` — create the dash `<name>` if new (or continue it), then carry out `<instruction>`.

That is the whole grammar. `<name>` is alphanumeric + hyphens, 2+ chars, and everything after it is the instruction — there are no reserved words, because there are no sub-verbs to collide with. Joining belongs to the `/dash-join` card verb, the readouts are `tugtool dash status|show|list`, and discard is a bare CLI call the user makes.

**A bare `/dash <name>` that names an existing dash is a continuation.** No instruction means there is nothing new to do, so read what the dash already knows — `tugtool dash documents <name> --json` for its task list, `tugtool plan status <name> --json` for where the ledger stopped — say which step is next, and go on from there. Guessing "new idea" here starts a second dash beside the one they meant.

## Lifecycle

### Create / continue

```bash
tugtool dash create <name> --description "<first ~100 chars of the instruction>" --json
```

Idempotent — returns the existing active dash if `<name>` already exists. **Capture the absolute `worktree` path** and `branch` from the response; that path is the working root for everything that follows. `create` hydrates the fresh worktree itself, running whatever the project declared in `[tugtool.dash].post_create` (dependency installs, generated files) so it arrives ready.

`create` records that this session is working the dash — every time, including the idempotent call that resumes one — so there is no bind to remember. Boundness is what the server reads to decide whether to work the join at all — an unbound dash is never reconciled, never checked, and never offered.

### The task list

Write it before the first round, into the dash's own plan path:

```bash
tugtool dash documents <name> --ensure --json
```

That prints a `plan` path under `.tug/dashes/<name>/`. Write **this document** there — the whole of it, and nothing more:

```markdown
## <What the work is, in a phrase> {#dash-<name>}

<One or two sentences: the instruction restated as what will be true when this is done.>

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | <title> | pending | — |
| #step-2 | <title> | pending | — |

#### Step 1: <Title> {#step-1}

<A sentence or two on what this step does.>

#### Step 2: <Title> {#step-2}

<A sentence or two.>
```

**Every row `pending`, and no commits.** The other cells belong to the run, and the step verbs write them.

**Size it to the work.** A one-line fix is one step and reads `1/1` when it lands — a task list of one is not a failure of the form, it is the form telling the truth. Something with three distinct pieces is three. If you find yourself writing ten, the work wanted `/dash-plan`; say so and offer it rather than authoring an arc's plan by hand here.

**This is deliberately not the arc's plan.** No brief, no phase overview, no success criteria, no references, no review record, no `[P##]` decisions — those are the devise stage's contract and `tugtool plan lint` is the check for it, which this document does not aim to pass and is never run against. What it must do is *parse*: an `{#execution-steps}` section, a `{#step-status-ledger}` table whose first cell is the step's anchor, and a `#### Step N: … {#step-N}` heading per row. That is what `tugtool dash step` reads, and a document that does not parse is refused rather than guessed at.

Then walk it. Each step, in order:

```bash
tugtool dash step <name> start <n> --through <last>
tugtool dash step <name> done <n>
```

`start` before the work, `done` after the round's commit — it records the branch's tip, which is that round, so there is no sha to pass. **One `start` per step, and a step is only `done` when its checks have run.** A `done` on a step nobody opened is refused outright, because a run that batches two steps into one round and closes both at the end leaves the second reading finished while it is being worked: the strip's live mark never lands on it and the fraction jumps by two. A round that carries two steps opens and closes each in its turn, and the same sha in both commit cells is the honest record of that. `--through` names the last step this run means to reach and is required, because the join arms from it: a run that walks the whole list says `--through <total>`, and one you are deliberately stopping partway says where. A step the work made unnecessary is `tugtool dash step <name> withdraw <n>` — it counts as walked and records no commit, because none was made. The fraction on every dash face is this ledger and nothing else, so a run that skips these verbs is a run whose faces read `0/3` while it finishes.

**The list is not a contract with the past.** Work that turns out to need a step nobody foresaw gets one: add its row and its heading, and go on. Rewriting the list mid-run is ordinary, and it is a better record than a list kept accurate by refusing to learn anything.

**The task list is the last place a question can be asked.** If the instruction leaves a design decision the code cannot settle and no conventional default covers, raise it now, while the list is being written, as an `AskUserQuestion` — and only when you are genuinely at your wits' end, never as a reflex. Once the first step is opened with `start`, that door closes: from there the run answers its own unknowns and finishes.

### Work (in-thread, per round)

**Walk the whole list in this turn, and do not end the turn before the step named by `--through` is `done` or `withdrawn`.** A direct dash has no arc behind it: nothing prompts the next step, so a turn that ends at a step boundary ends the dash, with a row reading `in progress` and nobody working it. A round's commit is a checkpoint inside the run, not a place to report back — commit, close the step, open the next, and keep going. Never ask whether to continue, never ask a clarifying question mid-step, and never narrate the next step in place of doing it. The only stop short of the declared end is a blocker you name, in a sentence, with what it blocks.

Closing the last step is not the end of the turn either: the audit and the ending below are part of the same run, and nothing will prompt them.

Carry out the instruction yourself in the worktree. Run the checks the doctrine names. **Before the commit, write the dash's join draft** — committing the round is the arming event, so the prompt can raise and the user can join the moment the commit lands, and whatever draft exists at that instant is the message they land with:

```bash
tugtool draft set --owner dash:<name> --message "<subject + durable body>"
```

Compose it per the rules under "Stop" below — a durable commit message describing the change, never a narration of the rounds; on a follow-up round, refresh it the same way. Then commit:

```bash
tugtool dash commit <name> --message "tugdash(<name>): <imperative summary, under 50 chars>" --json <<'EOF'
{"instruction":"<the instruction>","summary":"<what you did + how verified>"}
EOF
```

One command: git commit + a line in the per-project dash-log (the verbatim instruction; `tug log` on the dash branch reads the commits back). A follow-up instruction for the same dash is just another round — do it and commit again.

**Three spellings are house rules, not taste.** The round's subject is `tugdash(<name>): <imperative summary>` — the scope-colon form the engine's own dash commits carry, so `tug log` on the branch reads as one voice. And when you *name* a round's commit in the transcript, write the **bare sha in backticks** — `` `63de5762a` ``, never `commit 63de5762a` — because the app supplies the word: a confirmed sha displays as `commit:63de5762a`, and a sentence that already said "commit" makes the app yield its word and show the hash alone. And **a file path goes in backticks every time you write one** — `src/parser/plan.rs`, never bare — because backticked and bare are one reference wearing two faces, and a reader who sees both in a paragraph has to work out that the difference means nothing. See `tuglaws/entity-presentation.md`.

**Each committed round makes the dash offerable.** A round that lands on a clean worktree is all the server needs to derive that this dash could be joined: it reconciles it with its base and offers the join on the bound card without waiting to be told the work is over. It runs no build and no tests — the verification belongs to the run, not to the join ([D149]). Nothing below is what arms that, and nothing you skip below disarms it.

### Build (when there's something to see)

For a change the user should look at, run the project's **declared build command** from the worktree — the one `tugtool dash config` reports. Relay what it actually says rather than describing a build you did not watch. When `build` is `null` the project declares none, so no build is offered: say so, and say the work is inspectable at the worktree path.

`tugtool dash mark <name> built` is available and purely optional — it stamps the stage word `built` on the dash's faces in place of the derived `ready`, which is worth doing when you did build, and gates nothing when you didn't.

### Audit, before the run is over

When the last step is closed, read the branch's **whole diff** in one pass and judge it against the task list. Not the rounds one at a time — you already read those as you wrote them, and each looked right on its own. What has never been read is the change entire: the second round's fix to the first round's shape, the helper added in step two that step three duplicated, the step that closed on something adjacent to what its title promised.

```bash
tugtool dash show <name>
```

Then the diff itself, from the worktree, as one range against the base. Four questions, in this order:

- **Does the code do what the task list said?** Row by row. A step marked `done` whose behaviour is not in the tree is what this pass exists to catch — including the honest version, where the step did something adjacent and nobody noticed the difference.
- **Does it do anything the list did not say?** Scope that arrived without a decision behind it. Not every unplanned line is wrong — work discovers things — but an unplanned line that changes a contract, a default, or a surface is a decision made silently.
- **Is it right?** The unhandled case, the wrong boundary, the state that can be reached and is not handled, the check that passes for the wrong reason.
- **Does it fit?** The laws the change touches, the conventions of the files it sits in, the tests at the layer that can actually see the behaviour.

**Fix what you find, as ordinary rounds** — verified before the commit, like every other round. Findings here are usually small; a finding that is not is still a round, not a reason to stop.

**Know what this pass is and is not.** It is your own re-read, not a cold one: the arc hands its audit to a session that has never seen the run, and that reader is strictly better, because a session cannot be surprised by code it remembers writing. What a direct dash buys instead is cheapness and immediacy — one pass over the whole diff, in the room, before anybody is asked to look. Take it for what it is, and be harder on the code than you were while writing it.

**Never lint the task list here**, and never grow it to accommodate a finding. A fix is a round; the list stays what the run walked.

### Stop, with the fit verified, the audit declared, and a draft on file

**Verify the fit first** ([D149]). What you checked as you worked was the dash's own tree; what a join lands is that work replayed onto the live base, and nothing has tested it:

```bash
tugtool dash replay <name>
```

On **`Replayed`** / **`Recorded`** the tree moved — verify it with `tugtool dash verify <name>`, from the worktree. It resolves every path the replay moved to a surface the project declared and runs what those surfaces declare; nothing is substituted by hand. A refusal (exit 2) names paths no surface claims and runs nothing — declare a surface for them rather than working around it. Red (exit 1) is ordinary work. A project that declares no surfaces says so and exits 0: check what the replay moved with the commands you already ran as you worked — never one you invent — and say so. On **`Current`** the base never moved and the checks you already ran covered these exact bytes, so run nothing and say so. On **`Conflicted`** the replay names the round it stopped at: resolve it in the worktree, commit the fix as a round, then verify. Do not re-run what already passed.

Then check the dash's **join draft** — the squash message their join will land — still tells the truth. You wrote it before each round's commit; if the ending added a round (a `Conflicted` replay resolved as new work), refresh it now:

```bash
tugtool draft set --owner dash:<name> --message "<subject + durable body>"
```

**The draft is a commit message, held to the same standard as every other commit on the base.** A join squashes to one commit and this draft is its message, so it is the only durable prose the base will ever carry about this dash. Write an **imperative subject** in the repository's recent-commit style; then, as the **second paragraph, a summary** — one to three sentences of plain prose, no bullets, saying what the base is about to receive and why, that a reader can stop at; then the body — what the change does, and the argument the work rests on — for a reader who never saw the run. The Changes shade fronts the subject and the summary and folds the body, so the summary is the message most readers will read. Never a narration of the run: no round-by-round digest, no step numbers, no "the run did X and then Y", and no archaeology about defects the run found and fixed along the way. The round count is the receipt's fact rather than the message's — the join receipt shows it and the `Tug-Dash:` trailer names the branch and base. State the argument the work actually rests on and do not append an inferred benefit to make the change sound worthier. **The subject is bare — no `tugdash(<name>): ` prefix**, because the join adds the scope itself and a scope naming a different dash is stripped there rather than preserved. Every line unbroken to its end (**no hard wrapping**), no AI or agent attribution, ever. The join gesture lands this message and does not compose one — a dash that reaches it draftless stops there.

Read a good one before writing yours — `tug log` on the base shows the project's recent joins. A good one says what the project can now do, which boundary was held, and how it was proven, with no round list and nothing that requires having watched the run.

Write the draft whether or not you built anything: the Changes shade shows it, and a draftless dash offers to land its branch description — or, with neither, the words `Dash work`.

Then declare the audit — **after** the fit is verified and every round is committed, because the mark is a claim about the tree as it now stands, and a round landed after it would make it a lie:

```bash
tugtool dash mark <name> audited --note "<one line: what was checked, and what was fixed>"
```

It stamps the stage word `audited` on the dash's faces in place of the derived `ready`. Unlike `built` it is not optional: the audit is part of the run, and the mark is what says the run had one.

Then **stop.** Don't merge.

### Join (only on the user's word)

The join is the user's, and the **Changes shade** is how it reaches them: the shade reveals itself on the bound card in the first quiet moment, showing the dash's row and the message the join would land, and the composer's ⬆ lands the squash with the draft you left. Say the draft is written and stop — do not print a `/dash-join <name>` chip, which reads as "nothing will happen until you type this" beside a room that is about to open on its own.

The chip belongs only where the prompt cannot raise: a dash the user has left unbound, or a legacy dash with no declared run and no mark.

### Discard

`tugtool dash discard <name>` deletes the dash (worktree + branch) without merging. It is the one irreversible act in the lane, this skill has no verb for it, and you never reach for it on your own initiative — it is named here only so that rule has somewhere to live.

## Guardrails

Everything in [`tuglaws/dash-work-doctrine.md`](../../../tuglaws/dash-work-doctrine.md), plus:

- **Write the task list before the first round, and walk it with the step verbs.** A dash whose ledger never moves shows a dead fraction on every face it appears on, and leaves a session picking it up tomorrow nothing to read.
- **Once a step is open, the run finishes the list.** No turn ends with a step `in progress` unless a named blocker ends it. Questions were for the task list; a mid-step unknown is answered by the code or the conventional default, and the run keeps going.
- **Never lint the task list, and never grow it into a plan.** Ten steps means the work wanted `/dash-plan`.
- **Audit before you stop, and mark it.** The whole diff read at once against the task list, findings fixed as rounds, `dash mark audited` last. A run that skipped it offers a join nobody has read.
- **Leave the draft behind.** Stopping without one hands the user a join gesture that cannot join.
- **Never discard on your own initiative.** Discard destroys work.
