---
name: dash-implement
description: Implement a plan into a tested build on an isolated dash worktree — walk a single step, a step range, or the whole plan; agentless, in-thread, committing per step, stopping for review before merge
argument-hint: "[dash-name] [Step N | Steps N-M]"
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, AskUserQuestion
disallowed-tools: Task
---

## What this is

`dash-implement` carries a plan document from start to a launchable, tested build, on its own git worktree, **driven by you — the main conversation — directly**. You read the plan, you do the work, you run the checkpoints, you commit each step. The worktree lifecycle rides the `tugtool dash` CLI; the plan is your checklist.

**Read [`tuglaws/dash-work-doctrine.md`](../../../tuglaws/dash-work-doctrine.md) before you start.** It is the discipline every dash run works under — the one-and-only-working-root rule, the verification bar, test discipline and the banned test shapes, law discipline, round mechanics, the stop-before-join obligation, and no plan numbers in durable artifacts. This skill states the flow; the doctrine states the rules, and it is not repeated here.

**When the project has no `tuglaws/`,** the doctrine document is absent and cannot be read. The rules that survive its absence are the ones this skill carries inline — one working root, verify before every commit, never commit red, rounds through `tugtool dash commit`, stop before the join — and they are the discipline for the run. Say so once, at the start, so the user knows which fidelity they are getting; do not invent the rest of the doctrine from memory.

## Input

`/tugplug:dash-implement <name> [step-selector]`

- `<name>` — the **dash** whose plan to walk. Its plan lives at `.tug/dashes/<name>/plan.md`, which `tugtool dash documents <name>` prints and every `plan` verb resolves from the name alone. A path is accepted for a plan outside any dash, but the name is the address.
- `[step-selector]` (optional) — **which steps to walk this invocation**:
  - *(omitted)* — walk the **whole plan** from the first unfinished step to the end.
  - `Step N` — walk a **single** step (e.g. `Step 3`).
  - `Steps N-M` — walk a **range/batch** of steps, inclusive (e.g. `Steps 3-5`).

The **Step Status Ledger** at the top of the plan's Execution Steps is the source of truth for "where are we?". Read it first:

- With no selector, resume at the **first row that is neither `done` nor `withdrawn`** — including a row left `in progress` by an interrupted run, which `dash step start` re-enters idempotently — and continue to the end. A `withdrawn` row is a step somebody decided not to walk; resuming at one would re-open a decision the run already made.
- With a selector, honor it — but if an earlier step a selected step `**Depends on:**` is not yet `done`, say so and stop rather than building on an unfinished base.

**If the plan has no Step Status Ledger** (an older or hand-written plan), the step verbs cannot drive it. Fall back gracefully: with no selector, walk from Step 1; infer which steps are already done from `tug log` on the dash branch if the dash exists, and confirm with the user before skipping any. Offer to add a ledger to the plan (on the worktree) so future runs resume — and so the verbs can drive it.

If no plan exists yet, start at `/dash`: it sizes the idea, writes the brief, and carries the arc through devise and review to here.

## The five phases

### 1. Setup

1. Read the **Step Status Ledger** and resolve the step selector into a concrete list of steps to walk this run.
2. `tugtool dash create <name> --description "<one line>" --json`. **Capture the absolute `worktree` path** and `branch` from the response. If the dash already exists (resuming a later step range), `create` is idempotent and returns it.

   The plan lives at `.tug/dashes/<name>/plan.md` and nothing copies it anywhere ([D139]). `tugtool dash documents <name>` prints that path; **never copy a plan file by hand**, and never write one into the worktree. A dash whose course carries a **task list** instead has its ledger at `tasks.md`, which the same verb prints and every `plan` verb resolves from the name alone — everything below reads "the plan" as "whichever of the two this dash has".

   `create` also hydrates the fresh worktree itself, running whatever the project declared in `[tugtool.dash].post_create` (dependency installs, generated files) so it arrives ready. Never install dependencies by hand; a project that needs none declares none.

   You do not bind the dash to this session, and there is nothing to remember here: `create` and `dash step start` each record the claim themselves, so both starting a plan and resuming one mid-way are covered. That matters because boundness is what the server reads to decide whether to work the join at all — an unbound dash is never reconciled, never checked, and never offered — and a rule that load-bearing does not belong in prose a run can skip.
3. **Check that the plan's review covers the plan.**

   ```bash
   tugtool plan status <name> --json
   ```

   **A task list has no review to check** — the `/dash` door settled its steps before the course opened, and that course has no devise stage and no review stage. When the dash's ledger is `tasks.md`, skip this whole step and say nothing about it: a review gate on a document no review stage was ever going to read is a question with no answer behind it.

   Read `data.review`. On `reviewed`, say nothing and carry on.

   On **`stale`** or **`never-reviewed`**, raise an `AskUserQuestion` — never a hard refusal, because the plan is the user's:

   - *"Review now (Recommended)"* — print `` `/tugplug:dash-review <name>` `` as its own backticked chip and **stop**. You do not review inline; the review is its own turn on its own model.
   - *"Proceed as-is"* — carry on and say nothing further about it.

   The message names which verdict it is, and on `stale` quotes `data.last_round`'s date and model, so the user is deciding against a fact rather than a warning. Implementing a plan nobody reviewed is strictly worse than implementing one whose review predates an edit, so both raise the same gate.

   The gate reads the one copy there is, and needs no comparison against another: the plan has one home, and moving a ledger row does not move a plan's content stamp, so a `reviewed` plan stays `reviewed` for the length of a run.
4. Establish a green baseline with the project's own test commands — the ones the plan's step checkpoints name — so you know what "still green" means. When the plan names none and the project has no test command to run, say the baseline is unestablished and proceed on that footing — never invent one.
5. **The Step Status Ledger is the progress surface.** `dash step start`, `dash step done` and `dash step withdraw` move its rows, and the Lens, the Changes card, and the Z2 placard all read from it. There is no second list to keep: the ledger is the record of where the run is, and the verbs are what move it.

### 2. Implement (walk the steps)

**The run walks its whole selection and ends only at `--through <m>`.** Once the first step is opened, the run finishes the range it declared: a step boundary is a place to close one row and open the next, never a place to report back and end the turn. The one stop short of `m` is a blocker you name. Questions were for the brief and the plan; a mid-step unknown is answered by the code, the conventional default, or the plan's own decisions, and the run keeps going.

**Under an arc, and only under an arc, one step per turn.** When `printenv TUG_DASH_ARC` names a dash, resolve the selection exactly as Setup says and declare `--through <m>` with the selection's last step — `m` never shrinks to the one step you are walking, because `m` is the run's end and that is what arms the join. Then walk **one** step: the first row that is neither `done` nor `withdrawn`. Close it with `done` or `withdraw`, report the ledger state, and end your turn. The arc reads the boundary and prompts the same session with `Steps N-M` for the next one, so the run still reaches `m`; the turn is only the unit the arc paces it in. The reason is that every act the wheel takes on this session — a compaction, a rotation — happens between turns, so a step boundary has to be one. **Run by hand, with no `TUG_DASH_ARC`, there is no wheel and nothing prompts the next step: ending the turn at a step boundary abandons the dash. Walk the whole selection in this turn.**

Walk the resolved steps in dependency order. For each step:

- **Open the step.**
  ```bash
  tugtool dash step <name> start <n> --through <m>
  ```
  This moves the ledger row to `in progress` and records the step in the dash-log, which is what makes the dash read as `implementing (i/N)` in the Lens and the Changes card while you work.

  **`--through <m>` is the last step of the selection you resolved in Setup**, and it is required. It is how the machine can tell a run that finished from a run that stopped early: when step `m` goes `done`, the dash is finished, the join arms itself, and the user is offered the join without anybody having to remember to say so. A run that never declared where it ends can only ever look like a run still in progress. Pass the same `m` on every step of the run — re-declaring the same value is a no-op.
- Read the step's Tasks / References / Checkpoint.
- Do the work yourself, in the worktree.
- Run **that step's checkpoint** before committing. The bar is in the doctrine; the step names the specific commands.
- Commit the round:
  ```bash
  tugtool dash commit <name> --message "tugdash(<name>): <imperative summary, under 50 chars>" --json <<'EOF'
  {"instruction":"Step N: <title>","summary":"<what landed + how verified>"}
  EOF
  ```
- **On the final declared step — and only there — write the join draft before closing it.** Closing step `m` is the arming event: the instant its `done` lands, the server may raise the join offer, and whatever draft exists at that moment is the squash message the user lands with. A draft written afterwards is a draft racing the user's finger. Compose it per phase 3's rules — a durable commit message describing the change, never a narration of the run — and write it now:
  ```bash
  tugtool draft set --owner dash:<name> --message "<subject + durable body>"
  ```
- **Close the step** with the commit the round produced:
  ```bash
  tugtool dash step <name> done <n> --commit <sha>
  ```
  This writes the ledger row's status *and* its commit cell and appends the paired log line. Omit `--commit` to record the dash branch's tip. Ledger and commit move together, and the verb is what keeps them together.

  **A step that was never opened cannot be closed.** `pending` to `done` is refused, so a round that turns out to carry two steps opens and closes each in its turn rather than closing both at the end — otherwise the second row reads finished for the whole time somebody is working it, and every surface that shows the fraction says so. The same sha in two commit cells is the correct record of one round that carried two steps.
- **Withdraw a step the run decided not to walk.**
  ```bash
  tugtool dash step <name> withdraw <n>
  ```
  The row goes `withdrawn` and the commit cell stays empty, because no round was made. It closes the step and counts toward the run's completion exactly as a `done` does — so withdrawing the run's final declared step arms the join, rather than leaving the dash permanently un-joinable. It is reversible: `start` re-opens a withdrawn row. Reach for it whenever a step turns out to be unnecessary, already absorbed, or wrong; the alternative — saying so in the plan's prose — is what stales the plan's review, since the review stamp reads the plan's content and elides the ledger's status cells.

**Three spellings are house rules, not taste.** A round's commit subject is `tugdash(<name>): <imperative summary>` — the same scope-colon form the engine's own dash commits (`remap round ids`) carry, so `tug log` on the branch reads as one voice. And when you *name* a landed commit in the transcript, write the **bare sha in backticks** — `` `63de5762a` ``, never `commit 63de5762a` — because the app supplies the word itself: a confirmed sha displays as `commit:63de5762a`, and a sentence that already said "commit" makes the app yield its word and show the hash alone, which costs the reader the standard form. And **a file path goes in backticks every time you write one** — `src/parser/plan.rs`, never bare — because backticked and bare are one reference wearing two faces, and a reader who sees both in a paragraph has to work out that the difference means nothing. See `tuglaws/entity-presentation.md`.

Pragmatics:

- **A refused `dash step` is telling you about the document, not the tool.** It exits 1, names the plan and the row, and leaves the file untouched — a plan that does not strictly parse, a missing ledger row, an anchor that is not `#step-<n>`, a `pending` row you tried to close without opening, a `done` row you tried to reopen, or a `withdrawn` row you tried to finish (a withdrawn step that is now to be walked goes through `start` first, the same path every other step takes).

  Raise the refusal as an `AskUserQuestion` rather than picking a repair yourself, because the wrong guess corrupts the durable record: *"Fix the plan and retry"* / *"Hand-edit the ledger this run"*. Quote what the verb said. A malformed document usually wants fixing; a document that genuinely cannot be made to parse wants the hand-edit — and which one this is depends on what the plan is *for*, which is the user's to know.
- **A long run does not pause to ask whether to keep going, and does not end the turn as a silent way of asking.** However many steps the selector resolved to, walk them all in this turn (under an arc, one per turn, and the arc supplies the next). The selection *is* the answer to "how far": the user made it when they invoked the skill, and asking again at some interior step re-opens a decision they already made — the ledger is the progress surface, and it says where the run is without anybody being interrupted for it.
- Folding trivial or already-absorbed steps into a neighbor is fine — the join squashes at the end, so per-step commit granularity is for *your* visibility during the run. When you fold a step, still run its `done` verb (pointing at the neighbor's commit) — no step is left dangling `in progress`.
- If a step's verification fails, fix it before committing. Never commit red.
- When you reach the end of the requested selection, stop walking and report the ledger state — which steps are `done` and which remain.

### 3. Verify the fit, draft the join, offer a build

**The join has already armed itself.** When the run's final declared step went `done` — or, on a plan-less dash, when the round committed onto a clean worktree — the server derived that this dash is joinable and started reconciling it with its base. Nothing in this phase is what makes that happen, and nothing you forget to do here can stop it. That is the point: an endgame that depended on a skill remembering a chore was an endgame that went dark the first time a run ended early.

**First, verify the fit** ([D149]). Every step's checkpoint ran against the dash's own tree — the sandbox it forked from. The tree a join actually lands is the dash *replayed onto the live base*, and nothing has tested that yet:

```bash
tugtool dash replay <name>
```

- **`Replayed`** / **`Recorded`** — the tree moved, so verify it: `tugtool dash verify <name>`, from the worktree. The verb resolves every path the replay moved to a surface the project declared in its own `.tugtool/config.toml` and runs what those surfaces declare, so there is nothing to substitute and nothing to assemble. Three answers are worth knowing before you see one. A **refusal** (exit 2) names paths no surface claims and runs no check at all — the project's table has fallen behind its tree, and the repair is to declare a surface for them, never to work around it. **Red** (exit 1) is ordinary work: fix it in the warm worktree, commit the fix as a round, re-run. And a project that declares **no surfaces** gets a report saying so and exit 0 — then verify with **the plan's own checkpoint commands** over what the replay moved, the commands the plan already names, never one you invent, and say so.
- **`Current`** — the base never moved. The last step's checkpoint already verified these exact bytes, so **run nothing** and say so. This is the common case and it costs seconds.
- **`Conflicted`** — the replay names the round it stopped at. Resolve it in the worktree as ordinary work, commit the fix as a round, then verify as above.

Do not re-run the sweep. A checkpoint that passed is spent; the ending's job is the fit, not a second reading of the steps.

**Then check the dash's join draft still tells the truth.** You wrote it before closing the final step — that ordering is what made the words current at the instant the arc armed. Two cases reopen it: the ending added rounds the draft does not account for (a `Conflicted` replay resolved as new work), or the run stopped before its final declared step and no draft was ever written. In either case write it:

```bash
tugtool draft set --owner dash:<name> --message "<subject + durable body>"
```

**The draft is a commit message, held to the same standard as every other commit on the base.** A join squashes to one commit and this draft is its message, so it is the only durable prose the base will ever carry about this dash. Write an **imperative subject** in the repository's recent-commit style; then, as the **second paragraph, a summary** — one to three sentences of plain prose, no bullets, saying what the base is about to receive and why, that a reader can stop at; then the body — what the change does, and the argument the work rests on — for a reader who never saw the run. The Changes shade fronts the subject and the summary and folds the body, so the summary is the message most readers will read. Never a narration of the run: no round-by-round digest, no step numbers, no "the run did X and then Y", and no archaeology about defects the run found and fixed along the way. The round count is the receipt's fact rather than the message's — the join receipt shows it and the `Tug-Dash:` trailer names the branch and base. State the argument the work actually rests on and do not append an inferred benefit to make the change sound worthier. Every line runs unbroken to its end (**no hard wrapping**), and no AI or agent attribution, ever.

**Write the subject bare — no `tugdash(<name>): ` prefix.** The join adds the scope itself, so one written here is redundant; a scope naming a *different* dash is stripped at the join rather than preserved, so writing one at best changes nothing and at worst hides what you meant.

Read a good one before writing yours — `tug log` on the base shows the project's recent joins. A good one says what the project can now do, which boundary was held, and how it was proven, with no round list and nothing that requires having watched the run.

Write it even on a run that stops mid-plan: the draft is what the shade shows the user, and a dash with no draft offers to land its branch description — or, with neither, the words `Dash work`. The fold says which of the three it is, so a missing draft is visible rather than silent, but visible-and-wrong is still wrong.

**Then say what happened and stop.** The ending narration is three things: what was built, that the fit is verified (or that the replay reported `Current`, so it was already), and that the draft is written. At most add *"the Changes shade will reveal itself momentarily."* **Do not print a `/dash-join <name>` chip.** The dash is bound and armed; the shade summons itself on this card, and a chip alongside it teaches the user that nothing happens until they type — which is the belief this whole arc exists to retire ([D147], [D152]).

**Under an arc, this ending is unchanged** — and that is the finding, not an oversight. When `printenv TUG_DASH_ARC` names a dash, this turn is that arc's **implement stage**, and everything above still applies verbatim: verify the fit, write the draft before closing the final declared step, narrate the three things, print no chip. The reason nothing changes is that the ending was already server-driven — closing the final step arms the join, the shade summons itself, and the arc adds only its own receipt on top of what the join pilot already reads ([P12]). A stage that ended differently would be a second endgame competing with the one that works.

The one thing worth knowing is what the arc does at the step boundaries your turns now end on. Above `implement_compact_tokens` it **compacts** the seated session in place, and only a context a compaction failed to bring back under that line costs a rotation — so a mid-plan rotation is the rarer of the two. A fresh session then resumes at the first row that is neither `done` nor `withdrawn`, which is the ordinary resume this skill already describes, and needs nothing from you beyond keeping the ledger truthful with `dash step start|done|withdraw`. You walk one step and end the turn; the arc prompts the next. The turn that closes the run's final declared step is still the one that writes the draft before closing it and still verifies the fit.

**Offer a build when the work wants one.** A change the user will want to *see* — a surface with a face — is worth building and vetting before the join. What to run is the project's to say: the `build` command `tugtool dash config` reports. Run it from the worktree root, read what it says, and relay that to the user rather than describing a build you did not watch.

When `build` is `null` the project declares none, so **no build is offered** — say so, and say the work is inspectable at the worktree path.

A purely internal change — a refactor, a doctrine edit, a backend fix already covered by its checkpoint — does not need a build even where one is declared, and a debug instance nobody looks at is cost with no reader. Offer, do not assume.

```bash
tugtool dash mark <name> built
```

Optional telemetry, and nothing gates on it. It stamps the stage word `built` on the dash's faces in place of the derived `ready`, which is worth doing when you *did* build so the Lens says what happened. Skipping it changes nothing about whether the join is offered.

**Stop here either way.** Do not merge. The join is the user's.

### 4. Iterate (interactive)

The user tests and reports issues. Fix them on the worktree, run the relevant checkpoint, and commit each fix as its own round. The round commits are the record of the fixes. (Fix rounds are not plan steps — they get no `dash step` call.)

**Know your build surface.** The general rule is one line: re-run the declared build when the surface you changed needs it to be seen. Which surfaces hot-reload and which need the rebuild is knowledge that belongs to the project's own docs (its `CLAUDE.md`, typically), not to this skill. On a project whose docs say nothing, re-run the declared build when in doubt, and say that is why.

Loop until the user is satisfied. A follow-up "now do Steps 6-8" is just another `dash-implement` run against the same plan and dash.

### 4b. The audit

**Under an arc, this is not yours.** When `TUG_DASH_ARC` names a dash, the run's last step ending rotates the arc to its audit stage — a fresh session that reads the whole branch cold against the plan. Do nothing about it: end the turn as usual and the wheel seats it.

**Off an arc there is nobody to rotate**, so the audit is a turn the user opens. Say the run is finished and name it as the next stage, as its own backticked chip:

`` `/tugplug:dash-audit my-dash` ``

That is one of the few chips this skill prints, and it is not the join chip: it names the stage that has not run yet, not a landing the shade will offer on its own.

### 5. Join (the user's join gesture)

**The shade is the door.** The Changes shade reveals itself on the bound card in the first quiet moment, showing the dash's row, the message the join would land, and where those words came from. Entering the landing mode and pressing the composer's ⬆ squash-lands the dash with the draft you wrote in phase 3, narrating the beats and settling on the outcome. The user does that; you do not. Your part ended at the draft.

Closing the shade costs nothing and answers nothing — the row is still in there, and new work on the dash reveals it again. There is no "not yet" to record and nothing that can lock the offer out.

**`/dash-join <name>` in the Session card is the escape hatch**, the same join by hand, previewing the merge in memory before anything is touched. Reach for it only in the cases below.

**The escapes.** Print the chip in exactly two situations, because in both of them the shade genuinely has nothing to reveal:

- **The dash is unbound by choice.** The offer only reaches a card bound to the dash, and an unbound dash is never even reconciled. If the user has declined to bind one, `/dash-join <name>` is their only path.
- **A legacy dash** with no declared run and no mark — nothing arms it, so no offer ever stands.

Everywhere else the chip is noise at best and misinformation at worst. If the user reports the join blocked on base dirt, the preflight is intersection-aware: only base changes overlapping the dash's files block; unrelated base dirt should be committed or stashed first.

## Guardrails

Everything in [`tuglaws/dash-work-doctrine.md`](../../../tuglaws/dash-work-doctrine.md), plus:

- **Honor the selector and the ledger.** Walk exactly the requested steps; resume from the first row that is neither `done` nor `withdrawn`; never rebuild a `done` step or build on an unfinished dependency.
- **The verbs own the bookkeeping.** Drive the ledger with `dash step start|done|withdraw`, not by hand-editing the table — the log line the verb writes is what the dash surfaces derive `implementing (i/N)` from, and a hand-edit leaves them blind. A step you decided not to walk has its own verb; recording that decision in the plan's prose instead is what stales the plan's review.
- **Ask at the two forks, and nowhere else.** The stale gate and a refused `dash step` are the whole set. A long run is not a fork: the selector already said how far to walk. Everything outside it is covered by the doctrine's [never-ask list](../../../tuglaws/dash-work-doctrine.md#what-never-gets-asked) — a run that asks about everything trains the user to click through the dialog that mattered.

## When to reach for something else

This skill holds the plan's context in one conversation, which fits small-to-medium plans well (a dozen steps is healthy). For a very large plan, walk it in batches — `/tugplug:dash-implement <plan> Steps 1-4`, review, then `Steps 5-8` — or author smaller plans. For a change whose shape is already clear, the direct dash — the plain `/dash` — does the work in one conversation against a task list instead.
