---
name: dash-implement
description: The implementing stage of a dash course — walk the dash's ledger one step per turn on an isolated worktree, committing per step, and stop before the join
argument-hint: "[dash-name] [Step N | Steps N-M]"
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
disallowed-tools: Task, AskUserQuestion
---

## What this is

`dash-implement` is the **implementing stage** of a dash course, and both courses have one: the plan course reaches it after devise and review, the dash course opens straight at it. It carries the dash's ledger — a devised `plan.md` or a `/dash` door's `tasks.md` — to a tested build on the dash's own git worktree, closing one step per turn and committing each. The worktree lifecycle rides the `tugtool dash` CLI; the ledger is the checklist.

**It is a stage of a course, not a standalone command.** The wheel seats it, paces it a turn at a time, compacts it when its context grows, and rotates it onto a fresh session when compaction is not enough. Run outside a course there is no wheel and nothing prompts the next step, so [the course check](#0-confirm-the-course-that-runs-you) is the first thing this skill does.

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

**If the plan has no Step Status Ledger** (an older or hand-written plan), the step verbs cannot drive it. Fall back gracefully: with no selector, walk from Step 1, and infer which steps are already done from `tugtool dash show <name>`, which reads the dash's rounds back — their commits *and* the instruction git cannot see. Offer to add a ledger to the plan (on the worktree) so future runs resume, and so the verbs can drive it.

If no ledger exists yet, start at a door. `/dash` sharpens the idea into a brief and a task list and opens a course straight at this stage; `/dash-plan` writes the brief and its course devises a plan and reads it cold before any step is walked. Which door the user typed is the routing decision, and neither is this skill's to make.

## The five phases

### 0. Confirm the course that runs you

```bash
printenv TUG_DASH_COURSE
```

It names the dash whose course you are the implement stage of. (A bundle older than the rename set `TUG_DASH_ARC` instead, and both are written today, so read either — they carry the same name.)

**With neither in the environment, stop and say so.** This skill is a stage of a course rather than a standalone command, and the doors are what start one: `/dash` sharpens an idea into a brief and a task list and opens a course straight at this stage, `/dash-plan` writes the brief and its course devises a plan and reads it cold first. There is no path from here that ends anywhere else, because the discipline this stage runs under — one step per turn — is only safe when something is pacing it. Without a wheel, a turn that ends at a step boundary abandons the dash: the ledger reads `in progress`, every face says somebody is working it, and nobody is.

**Then confirm the course can still find you.**

```bash
tugtool dash bind <name> --dry-run
tugtool dash status <name> --json
```

The first writes nothing. It resolves which session this shell actually belongs to — the live segment of its line, not the id the shell was born holding — and says `(this shell holds …, which has rotated)` when the two differ. **That line is ordinary and is not a problem**: a rotation is what a course does, the resolver is what makes the stale id harmless, and every `tugtool` verb takes the same path.

What is a problem is a resolved session the dash is not bound to. `dash status --json` names the dash's `bound_sessions`; if the id the dry run resolved is not among them, the binding did not ride the rotation, and nothing downstream will find this run — not the join offer, not the card's own faces.

**The repair is `tugtool dash doctor <name>`.** It compares all four of a dash's records — the ledger table, the dash-log's declarations, the sqlite binding, and the arc record — and names each disagreement in a sentence, offering the reconciling append where one exists (`--repair` takes it). Reach for it before anything else, because it is the only gesture that tells you *which* record disagrees. Do not reach for `/dash-bind`: it writes one of the four and answers nothing about the other three, so a bind that exits 0 over a desynced ledger is a success that changed nothing.

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

   On **`stale`** or **`never-reviewed`**, **say so in a sentence and walk the plan anyway.** Name which verdict it is, and on `stale` quote `data.last_round`'s date and model, so the fact is on the transcript where the user can act on it.

   **Raise no dialog and print no chip.** This stage runs under a course, often unattended, and a question here stops the course in front of nobody — the doctrine's *questions belong to the door* rule, met at the one place a gate used to survive it. A `/tugplug:dash-review` chip is worse than the dialog: on a plan course the review stage already ran and a second one is not this stage's to ask for; on a dash course there is no review stage at all, so the chip names a stage the course does not have.

   What the fact is *for* is the audit. A plan the review did not cover is exactly the kind of thing the audit stage reads the diff against, and saying it here puts it in the transcript the audit and the user both read. Implementing a plan nobody reviewed is worse than implementing one whose review predates an edit, and neither is worse than a course that sat still waiting for an answer.

   The gate reads the one copy there is, and needs no comparison against another: the plan has one home, and moving a ledger row does not move a plan's content stamp, so a `reviewed` plan stays `reviewed` for the length of a run.
4. **Establish a green baseline, and write it down.** Run the project's own test commands — the ones the ledger's step checkpoints name — so you know what "still green" means. When the ledger names none and the project has no test command to run, say the baseline is unestablished and proceed on that footing; never invent one.

   A baseline held in one session's head is lost at the first rotation, and the session that inherits the run then reads a red it has no way to know was already red. So write it into the dash's own documents, which is the one place that survives every rotation and stales nothing:

   ```bash
   tugtool dash documents <name> --ensure --json
   ```

   Write `baseline.md` beside the ledger in the `dir` it prints — the commands you ran, and **exactly which of them were already red**, named as a file or a test rather than counted, because a count cannot be checked against later. Not into the plan or the task list: the plan's review stamp reads its content, so a note added there turns a `reviewed` plan `stale` for the length of the run.

   Where the project's own test tooling keeps a history of past runs, read it rather than trusting your memory of this one — `tugtool apptest history` answers for a project whose checks run through it, and a project with no such record simply has none. Say which reds the history already knew about; those are the ones this run did not cause.

   **A run that inherits a recorded baseline does not re-establish one.** Read `baseline.md`, say what it says, and carry on — re-running a whole suite at every rotation is the cost the record exists to remove.
5. **The Step Status Ledger is the progress surface.** `dash step start`, `dash step done` and `dash step withdraw` move its rows, and the Lens, the Changes card, and the Z2 placard all read from it. There is no second list to keep: the ledger is the record of where the run is, and the verbs are what move it.

### 2. Implement (walk the steps)

**The run reaches `--through <m>`, one step per turn.** Resolve the selection exactly as Setup says and declare `--through <m>` with the selection's last step — `m` never shrinks to the one step you are walking, because `m` is the run's end and that is what arms the join. Then walk **one** step: the first row that is neither `done` nor `withdrawn`. Close it with `done` or `withdraw`, report the ledger state, and end your turn. The course reads the boundary and prompts this same session with `Steps N-M` for the next one, so the run still reaches `m`; the turn is only the unit the course paces it in.

The reason is the wheel's: every act it takes on the seated session — a compaction above the project's threshold, and the rotation that follows one the compaction could not bring back under it — is sent at a turn's end, because a prompt sent into an open turn would queue behind a model still working. So a step boundary has to be a turn boundary.

**The turn ends at the step boundary and nowhere else.** Not to report a round, not to describe the next step, not to ask whether to keep going. The one stop short of a boundary is a blocker you name and cannot resolve. Questions were for the door; a mid-step unknown is answered by the code, the conventional default, or the documents this stage was handed, and the run keeps going.

**A turn that ends closing no step is counted.** The course watches for it: two such turns and it stops with a receipt reading `implement idle`, naming the resume. That stop is a hand-back with a sentence rather than a re-prompt, so it does not rescue a stage that is wandering — it ends one. If a step genuinely cannot be closed this turn, say why in the turn rather than ending quietly, and if the work is done but the step is not, run `dash step done` before the turn ends.

**A course that goes silent is stopped by the clock.** Ending no turn at all is not a way to avoid the horizon: the course carries an idle deadline, and a stage that stops working — or a turn that never finishes — stops with a receipt reading `stalled` once it runs out. The deadline is generous enough that a turn doing real work will never meet it, so meeting it means the work stopped. The answer is the same as for `implement idle`: close the step, or say in the turn what is in the way.

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
- **Withdraw a step the run decided not to walk. Withdraw is not a park.**
  ```bash
  tugtool dash step <name> withdraw <n>
  ```
  The row goes `withdrawn` and the commit cell stays empty, because no round was made. **It closes the step and counts toward the run's completion exactly as a `done` does** — so withdrawing the run's final declared step arms the join. That is the right behavior for the case it is for and the wrong one for the case it is often reached for: withdraw says *this step will not be walked*, and a resume skips the row. It does not say "come back to this."

  Reach for it when a step turns out to be unnecessary, already absorbed, or wrong. The alternative — saying so in the plan's prose — is what stales the plan's review, since the review stamp reads the plan's content and elides the ledger's status cells.

  **To park an opened step instead, reset it:**
  ```bash
  tugtool dash step <name> reset <n>
  ```
  The row goes back to `pending` and its commit cell is cleared, with a paired log line saying so — the state a step was in before anybody opened it, which is what "come back to this" actually means. A resume walks a reset row again; it skips a withdrawn one. Reset is refused on a `done` row, because a finished step is a different question.

  **And to reopen a step that was finished and turns out not to be** — the audit-rejected case, most often:
  ```bash
  tugtool dash step <name> reopen <n> --why "<what the re-walk is answering>"
  ```
  `done` back to `in progress`, commit kept. `--why` is required, and that is the design: a reopen with no reason is the hand-edit these verbs exist to replace, wearing a verb's clothes. It **un-arms the join** until the step closes again, which is the point — a run with rejected work still in it is not a run that has finished, and the offer should not stand over one.

**Three spellings are house rules, not taste.** A round's commit subject is `tugdash(<name>): <imperative summary>` — the same scope-colon form the engine's own dash commits (`remap round ids`) carry, so `tugtool dash show <name>` reads the branch back as one voice. And when you *name* a landed commit in the transcript, write the **bare sha in backticks** — `` `63de5762a` ``, never `commit 63de5762a` — because the app supplies the word itself: a confirmed sha displays as `commit:63de5762a`, and a sentence that already said "commit" makes the app yield its word and show the hash alone, which costs the reader the standard form. And **a file path goes in backticks every time you write one** — `src/parser/plan.rs`, never bare — because backticked and bare are one reference wearing two faces, and a reader who sees both in a paragraph has to work out that the difference means nothing. See `tuglaws/entity-presentation.md`.

Pragmatics:

- **A refused `dash step` is telling you about the document, not the tool.** It exits 1, names the ledger and the row, and leaves the file untouched — a document that does not strictly parse, a missing ledger row, an anchor that is not `#step-<n>`, a `pending` row you tried to close without opening, a `done` row you tried to `start` or `reset`, or a `withdrawn` row you tried to finish (a withdrawn step that is now to be walked goes through `start` first, the same path every other step takes).

  **Every one of those has a verb behind it, so reach for the verb rather than for a dialog or a hand-edit.** A `done` row that must move is `step reopen <n> --why …`; an opened row to put down is `step reset <n>`; a refusal you cannot place at all is `tugtool dash doctor <name>`, which compares the ledger table against the dash-log, the binding, and the arc record and names which of them disagrees — very often the answer is that they already did, before this turn.

  **Never hand-edit the ledger table.** That was the old repair and it is what the reset/reopen/doctor triple replaced: a hand-edit moves the table without the paired log line, and the two records then disagree about a run's frontier — status and join-arming derive from the log, while the resume pointer derives from the table. Nothing notices, and the run resumes somewhere the surfaces do not say it is. If a document genuinely cannot be made to parse, fix the document; that is a repair with a receipt.

  And ask nothing here. This stage runs under a course, so a dialog stops it in front of nobody. Say what the verb said, take the verb that answers it, and if none does, let the course's own stop carry the sentence.
- **A long run does not pause to ask whether to keep going, and does not end the turn as a silent way of asking.** One step per turn, and the course supplies the next; the selection *is* the answer to "how far", and asking again at some interior step re-opens a decision already made. The ledger is the progress surface, and it says where the run is without anybody being interrupted for it.
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

Read a good one before writing yours — `git log` on the base shows the project's recent joins. A good one says what the project can now do, which boundary was held, and how it was proven, with no round list and nothing that requires having watched the run.

Write it even on a run that stops mid-plan: the draft is what the shade shows the user, and a dash with no draft offers to land its branch description — or, with neither, the words `Dash work`. The fold says which of the three it is, so a missing draft is visible rather than silent, but visible-and-wrong is still wrong.

**Then say what happened and stop.** The ending narration is three things: what was built, that the fit is verified (or that the replay reported `Current`, so it was already), and that the draft is written. At most add *"the Changes shade will reveal itself momentarily."* **Do not print a `/dash-join <name>` chip.** The dash is bound and armed; the shade summons itself on this card, and a chip alongside it teaches the user that nothing happens until they type — which is the belief this whole arc exists to retire ([D147], [D152]).

**What the course does at the boundaries your turns end on.** Above the project's compaction threshold it **compacts** the seated session in place — same session, same lineage, same stage label, only the context comes down. A context the compaction could not bring back under the line gets the second and last answer: the stage rotates to a fresh session. So a mid-run rotation is the rarer of the two, and neither is a failure.

**A rotated-in session is not a session with nothing to do.** It inherits a run that is partly walked and has never seen a line of it, so its first acts are the ones this skill opens with: read the ledger, read the dash's `baseline.md`, run the [course check](#0-confirm-the-course-that-runs-you). The check is the load-bearing one — a binding that did not ride the rotation leaves this run invisible to the join offer and to the card's own faces, and `tugtool dash doctor <name>` is what names it. Then resume at the first row that is neither `done` nor `withdrawn`, which is the ordinary resume above.

The ending itself is unchanged by a rotation, and that is the finding rather than an oversight: closing the final step arms the join, the shade summons itself, and the course adds only its own receipt on top of what the join pilot already reads ([P12]). The turn that closes the run's final declared step is still the one that writes the draft before closing it and still verifies the fit — whichever session that turn happens to be running on.

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

**This is not yours.** The run's last step ending rotates the course to its audit stage — a fresh session that reads the whole branch cold against the ledger and the brief. Both courses end that way. Do nothing about it: end the turn as usual and the wheel seats it.

**Print no `/tugplug:dash-audit` chip.** The audit is the next stage of a course that is already running, and a chip beside it teaches the user that nothing happens until they type — the belief the wheel exists to retire.

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
- **The verbs own the bookkeeping, and there is one for every move.** `start`, `done`, `withdraw`, `reset` to park, `reopen --why` to un-finish — never a hand-edited table. The log line each verb writes is what the dash surfaces derive `implementing (i/N)` from and what arms the join, and a hand-edit leaves the two records disagreeing with nothing to notice. A step you decided not to walk has its own verb; recording that decision in the plan's prose instead is what stales the plan's review.
- **When the records disagree, `tugtool dash doctor <name>` is the gesture.** It is the only one that reads all four and says which. `/dash-bind` writes one of them and answers nothing about the rest.
- **Ask nothing.** This stage runs under a course, often unattended, so a dialog stops the course in front of nobody — the doctrine's [never-ask list](../../../tuglaws/dash-work-doctrine.md#what-never-gets-asked) at its strictest. The stale plan is said in a sentence; a refused verb is answered by the verb that fits; a long run is not a fork.
- **Run only under a course.** With no course in the environment, say what this is a stage of and which doors start one, and stop.

## When to reach for something else

This skill is a stage, so what to reach for instead is a **door**. For a change whose shape is already clear, `/dash` sharpens it into a brief and a task list and opens a course straight at this stage. For work whose decisions want settling first, `/dash-plan` writes the brief and its course devises a plan and reads it cold before any step is walked. Both hand off by ending their turn, and the course paces the walk from there.

A ledger with a great many steps is not a reason to invoke this skill in batches by hand — the course already walks it one step per turn, compacting between them and rotating when compaction is not enough, which is exactly what batching was for. A ledger that is genuinely too large is a sign the *work* wanted splitting at the door.
