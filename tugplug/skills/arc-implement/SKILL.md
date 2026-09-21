---
name: arc-implement
description: The implement stage of every arc — walk the arc's ledger one step per turn on an isolated worktree, committing per step, and stop before the join
argument-hint: "[arc-name] [Step N | Steps N-M]"
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
disallowed-tools: Task, AskUserQuestion
---

## What this is

`arc-implement` is the **implement stage** of an arc, and every arc has one: a planned arc reaches it after devise and review, a plain arc opens straight at it. It carries the arc's ledger — a devised `plan.md` or an `/arc` door's `tasks.md` — to a tested build on the arc's own git worktree, closing one step per turn and committing each. The worktree lifecycle rides the `tugtool arc` CLI; the ledger is the checklist.

**It is a stage of an arc, not a standalone command.** The wheel seats it, paces it a turn at a time, compacts it when its context grows, and rotates it onto a fresh session when compaction is not enough. Run outside an arc there is no wheel and nothing prompts the next step, so [the `where` line](#0-read-the-where-line) is the first thing this skill does.

**Read [`tuglaws/arc-work-doctrine.md`](../../../tuglaws/arc-work-doctrine.md) before you start.** It is the discipline every arc works under — the one-and-only-working-root rule, the verification bar, test discipline and the banned test shapes, law discipline, round mechanics, the stop-before-join obligation, and no plan numbers in durable artifacts. This skill states the flow; the doctrine states the rules, and it is not repeated here.

**When the project has no `tuglaws/`,** the doctrine document is absent and cannot be read. The rules that survive its absence are the ones this skill carries inline — one working root, verify before every commit, never commit red, rounds through `tugtool arc commit`, stop before the join — and they are the discipline for the arc. Say so once, at the start, so the user knows which fidelity they are getting; do not invent the rest of the doctrine from memory.

## Input

`/tugplug:arc-implement <name> [step-selector]`

- `<name>` — the **arc** whose plan to walk. Its plan lives at `.tug/arcs/<name>/plan.md`, which `tugtool arc documents <name>` prints and every `plan` verb resolves from the name alone. A path is accepted for a plan outside any arc, but the name is the address.
- `[step-selector]` (optional) — **which steps to walk this invocation**:
  - *(omitted)* — walk the **whole plan** from the first unfinished step to the end.
  - `Step N` — walk a **single** step (e.g. `Step 3`).
  - `Steps N-M` — walk a **range/batch** of steps, inclusive (e.g. `Steps 3-5`).

Under an arc, the wheel's ask reads `implement Step N and end the turn; Steps N-M remain on this arc` (or `…; it is the arc's last step`). Read it exactly as it parses: `Step N` is **this turn's one step**, and `Steps N-M` is the selection's *remainder* — a fact about how far the declared selection reaches, never a batch instruction. The selection was declared at the arc's start, and `--through` never shrinks to the step you are walking.

The **Step Status Ledger** at the top of the plan's Execution Steps is the source of truth for "where are we?". Read it first:

- With no selector, resume at the **first row that is neither `done` nor `withdrawn`** — including a row left `in progress` by a turn that was interrupted, which `arc step start` re-enters idempotently — and continue to the end. A `withdrawn` row is a step somebody decided not to walk; resuming at one would re-open a decision the arc already made.
- With a selector, honor it — but if an earlier step a selected step `**Depends on:**` is not yet `done`, say so and stop rather than building on an unfinished base.

**If the plan has no Step Status Ledger** (an older or hand-written plan), the step verbs cannot drive it. Fall back gracefully: with no selector, walk from Step 1, and infer which steps are already done from `tugtool arc show <name>`, which reads the arc's rounds back — their commits *and* the instruction git cannot see. Offer to add a ledger to the plan (on the worktree) so a later session resumes, and so the verbs can drive it.

If no ledger exists yet, start at the door. `/arc` sharpens the idea into a brief and decides the arc's shape there: a plain arc gets a task list and opens straight at this stage, a planned one gets the brief alone and its arc devises a plan and reads it cold before any step is walked. That decision belongs to the door and is not this skill's to make.

## The phases

### 0. Read the `where` line

The prompt that seated you carries one: `where: worktree <abs path> · session <id> bound · stage implement · Step N in hand, through M`. That is the arc's worktree — **the one working root, and the absolute path every read, write and check below is addressed by** — the seat the arc is bound to, and the step this turn owes against the selection's end. Read it and start working. The runner made the worktree before it composed the line, then ran `arc doctor`'s comparison — the ledger table, the arc log, the binding, the arc record, and the seat itself — immediately before sending it, so there is nothing here to probe for, nothing to confirm, and nothing to say about having done either.

**The session id on the line is the card's tug session id** — the one `printenv TUG_SESSION_ID` prints in your shell. Claude's own session id never appears on a stage-facing line, so a mismatch between the two is not a finding; there is no comparison to make here, and none is asked of you.

**Two things stop this stage before any step, and both stop it through the arc rather than in prose.** With no `where` line at all, or with a `where` line whose worktree is still not a directory after [Setup's fallback](#1-setup), do not end the turn on a sentence — a turn that ends in prose reads to the wheel as a quiet turn, and the arc it was carrying dies of silence half an hour later, with a receipt that says the opposite of what happened. Stop it instead:

```bash
tugtool arc ask <name> "<what you found, in one sentence>"
```

That writes the sentence as the arc's last note and stops the arc as `needs a decision`, with a Resume on the receipt the user sees in seconds. It is the one gesture by which a stage's refusal becomes a stop rather than a stall, and it is the doctrine's rule that a stop recording a person's decision is never reversed by the machine.

**With no `where` line above, that is the sentence to stop on.** This skill is a stage of an arc rather than a standalone command, and `/arc` is the one door that starts one: it sharpens an idea into a brief and decides the arc's shape there, opening a plain arc straight at this stage and a planned one at devise. There is no path from here that ends anywhere else, because the discipline this stage runs under — one step per turn — is only safe when something is pacing it. Without a wheel, a turn that ends at a step boundary abandons the arc: the ledger reads `in progress`, every face says somebody is working it, and nobody is.

### 1. Setup

1. Read the **Step Status Ledger** and resolve the step selector into a concrete list of steps to walk.
2. **The worktree is the `where` line's, made by the dispatch, already hydrated and already yours.** Whatever the project declared in `[tugtool.arc].post_create` ran when the worktree was made, so it arrives ready — never install dependencies by hand; a project that needs none declares none.

   **If the path on the line is not a directory, make it yourself, once, and say so.** The dispatch makes the seat before it names it, so on a healthy run this verb runs nothing. It is here as the fallback: the plugin ships beside the tugcast that composes the line, and a stage that can repair a missing seat in one idempotent verb is cheaper than an arc that stops for it.

   ```bash
   tugtool arc create <name> --json
   ```

   It is idempotent — a present branch and worktree return as-is, `created: false`, and nothing is re-hydrated. Take `worktree` from the response as the working root from here on, and say in one sentence that the dispatch had not made it, so the fact is on the transcript the audit reads. A line whose path *is* a directory runs nothing. If the path is still not a directory afterwards, that is the [second stop case](#0-read-the-where-line): `tugtool arc ask`, not prose.

   The plan lives at `.tug/arcs/<name>/plan.md` and nothing copies it anywhere ([D139]). `tugtool arc documents <name>` prints that path; **never copy a plan file by hand**, and never write one into the worktree. An arc whose door wrote a **task list** instead has its ledger at `tasks.md`, which the same verb prints and every `plan` verb resolves from the name alone — everything below reads "the plan" as "whichever of the two this arc has".
3. **Check that the ledger is one you can walk: a plan's review covers it, or a task list rests on decisions the brief makes.**

   ```bash
   tugtool plan status <name> --json
   ```

   **A task list has no review to check, so this stage is its cold read.** The `/arc` door settled its steps before the arc opened, and that arc has no devise stage and no review stage — which means you, a session that did not write the brief or the task list, are the first reader of either with nothing to defend. So when the arc's ledger is `tasks.md`, do not read `plan status`; read the task list against the brief and against the code, before opening step 1:

   - For each step, find the files it moves and the `[B##]` decision it rests on. A step you can carry out from the brief's decisions and the code as it is needs nothing said.
   - **A step that rests on a decision the brief does not make** — one where writing the code would mean choosing between two designs the brief did not choose between, or where the brief's `(verified)` finding is not what the file says — is the one thing this read exists to catch. Stop, before any step opens:

     ```bash
     tugtool arc ask <name> "<the decision the task list assumes and the brief does not make, in one sentence>"
     ```

     That writes the question as the arc's last note and stops the arc as `needs a decision`, with a Resume on the receipt. The user answers in their own conversation, and the arc picks up here. A brief that overreached is answered in one exchange rather than built on.

   This is the plain arc's equivalent of the review stage, and the bar is the same never-ask list: a *design* decision the documents do not settle, never a step you would have ordered differently, never a detail the code or the conventional default answers, never "are you sure". On a task list whose steps all follow from the brief — the ordinary case — this read costs the reading of documents you had to read anyway, and you say nothing about having done it.

   Read `data.review`. On `reviewed`, say nothing and carry on.

   On **`stale`** or **`never-reviewed`**, **say so in a sentence and walk the plan anyway.** Name which verdict it is, and on `stale` quote `data.last_round`'s date and model, so the fact is on the transcript where the user can act on it.

   **Raise no dialog and print no chip.** This stage runs under an arc, often unattended, and a question here stops the arc in front of nobody — the doctrine's *questions belong to the door* rule, met at the one place a gate used to survive it. A `/tugplug:arc-review` chip is worse than the dialog: on a planned arc the review stage already ran and a second one is not this stage's to ask for; on a plain arc there is no review stage at all, so the chip names a stage the arc does not have.

   What the fact is *for* is the audit. A plan the review did not cover is exactly the kind of thing the audit stage reads the diff against, and saying it here puts it in the transcript the audit and the user both read. Implementing a plan nobody reviewed is worse than implementing one whose review predates an edit, and neither is worse than an arc that sat still waiting for an answer.

   The gate reads the one copy there is, and needs no comparison against another: the plan has one home, and moving a ledger row does not move a plan's content stamp, so a `reviewed` plan stays `reviewed` for the length of an arc.
4. **Establish a green baseline, and write it down.** Run the project's own test commands — the ones the ledger's step checkpoints name — so you know what "still green" means. When the ledger names none and the project has no test command to run, say the baseline is unestablished and proceed on that footing; never invent one.

   A baseline held in one session's head is lost at the first rotation, and the session that inherits the arc then reads a red it has no way to know was already red. So write it into the arc's own documents, which is the one place that survives every rotation and stales nothing:

   ```bash
   tugtool arc documents <name> --ensure --json
   ```

   Write `baseline.md` beside the ledger in the `dir` it prints — the commands you ran, and **exactly which of them were already red**, named as a file or a test rather than counted, because a count cannot be checked against later. Not into the plan or the task list: the plan's review stamp reads its content, so a note added there turns a `reviewed` plan `stale` for the length of the arc.

   Where the project's own test tooling keeps a history of past runs, read it rather than trusting your memory of this one — `tugtool apptest history` answers for a project whose checks run through it, and a project with no such record simply has none. Say which reds the history already knew about; those are the ones this arc did not cause.

   **A session that inherits a recorded baseline does not re-establish one.** Read `baseline.md`, say what it says, and carry on — re-running a whole suite at every rotation is the cost the record exists to remove.
5. **The Step Status Ledger is the progress surface.** `arc step start`, `arc step done` and `arc step withdraw` move its rows, and the Arcs card, the Changes card, and the Z2 placard all read from it. There is no second list to keep: the ledger is the record of where the arc is, and the verbs are what move it.

### 2. Implement (walk the steps)

**The arc reaches `--through <m>`, one step per turn.** Resolve the selection exactly as Setup says and declare `--through <m>` with the selection's last step — `m` never shrinks to the one step you are walking, because `m` is the selection's end and that is what arms the join. Then walk **one** step: the first row that is neither `done` nor `withdrawn`. Close it with `done` or `withdraw`, report the ledger state, and end your turn. The wheel reads the boundary and prompts this same session with the next step's ask, so the arc still reaches `m`; the turn is only the unit it paces the walk in.

The reason is the wheel's: every act it takes on the seated session — a compaction above the project's threshold, and the rotation that follows one the compaction could not bring back under it — is sent at a turn's end, because a prompt sent into an open turn would queue behind a model still working. So a step boundary has to be a turn boundary.

**The turn ends at the step boundary and nowhere else.** Not to report a round, not to describe the next step, not to ask whether to keep going. The one stop short of a boundary is a blocker you name and cannot resolve. Questions were for the door; a mid-step unknown is answered by the code, the conventional default, or the documents this stage was handed, and the arc keeps going.

**And the boundary is machinery, not only these words.** It was only words once, and on the wheel machinery's first live run a stage walked step 1 correctly — open, work, commit, close — and then kept going straight into step 2 in the same turn, through this paragraph and the wheel's own opening prompt alike. So two things now hold it up. Every step verb's output ends with the sentence naming what the discipline demands next: a close says *End your turn now — the arc prompts Steps N+1–M*, an open says *This turn closes step N and nothing else*. And the PreToolUse gate refuses the overrun outright — once a turn has closed a step, a repo write or an `arc step start` from that same turn is denied, naming the step that closed and the one act that unblocks everything.

**If you meet that refusal, the answer is to end the turn.** It is never to find a spelling the gate does not read: the gate is the discipline, and a stage that routes around it is the incident. Reads, `arc status`, `arc doctor`, `arc commit` and the draft verb all stay open, because reporting the step you just closed is not the next step's work.

**Every ledger gesture draws itself on the card, and it is not yours to draw.** An arc created, a selection declared, a step started, closed, withdrawn, parked or reopened, a `mark`, each round — every one lands a one-line row on the card the moment the record moves. The server *watches* the **arc log** — the record the verbs already write and every surface already reads — so the line is a view of the record rather than an act anybody performs. That is the point: it is skippable only by not writing the record, at which point the gesture did not happen. Do not narrate them again in prose — the card already has the line, and a second copy in your reply is the same fact twice.

**A turn that ends closing no step is counted.** The wheel watches for it: two such turns and it stops with a receipt reading `implement idle`, naming the resume. That stop is a hand-back with a sentence rather than a re-prompt, so it does not rescue a stage that is wandering — it ends one. If a step genuinely cannot be closed this turn, say why in the turn rather than ending quietly, and if the work is done but the step is not, run `arc step done` before the turn ends.

**An arc that goes silent is stopped by the clock.** Ending no turn at all is not a way to avoid the horizon: the arc carries an idle deadline, and a stage that stops working — or a turn that never finishes — stops with a receipt reading `stalled` once it runs out. The deadline is generous enough that a turn doing real work will never meet it, so meeting it means the work stopped. The answer is the same as for `implement idle`: close the step, or say in the turn what is in the way.

Walk the resolved steps in dependency order. For each step:

- **Open the step.**
  ```bash
  tugtool arc step <name> start <n> --through <m>
  ```
  This moves the ledger row to `in progress` and records the step in the arc log, which is what makes the arc read as `implementing (i/N)` on the Arcs card and the Changes card while you work.

  **`--through <m>` is the last step of the selection you resolved in Setup**, and it is required. It is how the machine can tell an arc that finished from one that stopped early: when step `m` goes `done`, the arc is finished, the join arms itself, and the user is offered the join without anybody having to remember to say so. An arc that never declared where its selection ends can only ever look like one still in progress. Pass the same `m` on every step — re-declaring the same value is a no-op.
- Read the step's Tasks / References / Checkpoint.
- Do the work yourself, in the worktree.
- Run **that step's checkpoint** before committing. The bar is in the doctrine; the step names the specific commands.
- Commit the round:
  ```bash
  tugtool arc commit <name> --message "tugarc(<name>): <imperative summary, under 50 chars>" --json <<'EOF'
  {"instruction":"Step N: <title>","summary":"<what landed + how verified>"}
  EOF
  ```
- **On the final declared step — and only there — write the join draft before closing it.** The draft is **provisional**: the audit stage is the author of record for the join message and rewrites it after reading the whole diff cold, so what this stage writes is the audit's starting text, and the arming event is the audit's mark rather than this step's `done`. It is written all the same, and before the close, because an arc that stops short of its audit still needs a message on the shade, and this session is the one that knows the argument the work rests on. Compose it per phase 3's rules — a durable commit message describing the change, never a narration of the walk — and write it now:
  ```bash
  tugtool draft set --owner arc:<name> --message "<subject + durable body>"
  ```
- **Close the step** with the commit the round produced:
  ```bash
  tugtool arc step <name> done <n> --commit <sha>
  ```
  This writes the ledger row's status *and* its commit cell and appends the paired log line. Omit `--commit` to record the arc branch's tip. Ledger and commit move together, and the verb is what keeps them together.

  **A step that was never opened cannot be closed.** `pending` to `done` is refused, so a round that turns out to carry two steps opens and closes each in its turn rather than closing both at the end — otherwise the second row reads finished for the whole time somebody is working it, and every surface that shows the fraction says so. The same sha in two commit cells is the correct record of one round that carried two steps.
- **Withdraw a step the arc decided not to walk. Withdraw is not a park.**
  ```bash
  tugtool arc step <name> withdraw <n>
  ```
  The row goes `withdrawn` and the commit cell stays empty, because no round was made. **It closes the step and counts toward the selection's completion exactly as a `done` does** — so withdrawing the final declared step arms the join. That is the right behavior for the case it is for and the wrong one for the case it is often reached for: withdraw says *this step will not be walked*, and a resume skips the row. It does not say "come back to this."

  Reach for it when a step turns out to be unnecessary, already absorbed, or wrong. The alternative — saying so in the plan's prose — is what stales the plan's review, since the review stamp reads the plan's content and elides the ledger's status cells.

  **To park an opened step instead, reset it:**
  ```bash
  tugtool arc step <name> reset <n>
  ```
  The row goes back to `pending` and its commit cell is cleared, with a paired log line saying so — the state a step was in before anybody opened it, which is what "come back to this" actually means. A resume walks a reset row again; it skips a withdrawn one. Reset is refused on a `done` row, because a finished step is a different question.

  **And to reopen a step that was finished and turns out not to be** — the audit-rejected case, most often:
  ```bash
  tugtool arc step <name> reopen <n> --why "<what the re-walk is answering>"
  ```
  `done` back to `in progress`, commit kept. `--why` is required, and that is the design: a reopen with no reason is the hand-edit these verbs exist to replace, wearing a verb's clothes. It **un-arms the join** until the step closes again, which is the point — an arc with rejected work still in it is not an arc that has finished, and the offer should not stand over one.

**Three spellings are house rules, not taste.** A round's commit subject is `tugarc(<name>): <imperative summary>` — the same scope-colon form the engine's own arc commits (`remap round ids`) carry, so `tugtool arc show <name>` reads the branch back as one voice. And when you *name* a landed commit in the transcript, write the **bare sha in backticks** — `` `63de5762a` ``, never `commit 63de5762a` — because the app supplies the word itself: a confirmed sha displays as `commit:63de5762a`, and a sentence that already said "commit" makes the app yield its word and show the hash alone, which costs the reader the standard form. And **a file path goes in backticks every time you write one** — `src/parser/plan.rs`, never bare — because backticked and bare are one reference wearing two faces, and a reader who sees both in a paragraph has to work out that the difference means nothing. See `tuglaws/entity-presentation.md`.

Pragmatics:

- **A refused `arc step` is telling you about the document, not the tool.** It exits 1, names the ledger and the row, and leaves the file untouched — a document that does not strictly parse, a missing ledger row, an anchor that is not `#step-<n>`, a `pending` row you tried to close without opening, a `done` row you tried to `start` or `reset`, or a `withdrawn` row you tried to finish (a withdrawn step that is now to be walked goes through `start` first, the same path every other step takes).

  **Every one of those has a verb behind it, so reach for the verb rather than for a dialog or a hand-edit.** A `done` row that must move is `step reopen <n> --why …`; an opened row to put down is `step reset <n>`; a refusal you cannot place at all is `tugtool arc doctor <name>`, which compares the ledger table against the arc log, the binding, and the arc record and names which of them disagrees — very often the answer is that they already did, before this turn.

  **Never hand-edit the ledger table.** That was the old repair and it is what the reset/reopen/doctor triple replaced: a hand-edit moves the table without the paired log line, and the two records then disagree about the arc's frontier — status and join-arming derive from the log, while the resume pointer derives from the table. Nothing notices, and the arc resumes somewhere the surfaces do not say it is. If a document genuinely cannot be made to parse, fix the document; that is a repair with a receipt.

  And ask nothing here. This stage runs under an arc, so a dialog stops it in front of nobody. Say what the verb said, take the verb that answers it, and if none does, let the arc's own stop carry the sentence.
- **A long selection does not pause to ask whether to keep going, and does not end the turn as a silent way of asking.** One step per turn, and the wheel supplies the next; the selection *is* the answer to "how far", and asking again at some interior step re-opens a decision already made. The ledger is the progress surface, and it says where the arc is without anybody being interrupted for it.
- Folding trivial or already-absorbed steps into a neighbor is fine — the join squashes at the end, so per-step commit granularity is for *your* visibility while you walk. When you fold a step, still run its `done` verb (pointing at the neighbor's commit) — no step is left dangling `in progress`.
- If a step's verification fails, fix it before committing. Never commit red.
- When you reach the end of the requested selection, stop walking and report the ledger state — which steps are `done` and which remain.

### 3. Write the join draft, and stop

**The last step closes and this stage is over.** The audit is the next stage and it is the one that speaks of the join: it reads the branch cold, verifies the fit against the live base, rewrites this draft as the author of record, and marks the arc. So there is no replay here, no verify, no build, and no `arc mark built` — the tree this stage hands on is the tree the audit reads, and duplicating its checks would only mean checking bytes that are about to move.

**What is yours is a provisional draft**, written **before** the final declared step's `done` lands. The audit is the author of record for the join message: it reads the whole diff cold, touches the tree last, and rewrites the draft whether or not it changed anything, and the join arms on the audit's mark rather than on this step's close. So this draft is the audit's starting text and the message an arc carries if it stops before its audit — which is why it is written now rather than skipped, and why it is held to the same standard as the one that lands. The one case that reopens it here is an arc that stopped before its final declared step, where no draft was ever written:

```bash
tugtool draft set --owner arc:<name> --message "<subject + durable body>"
```

**The draft is a commit message, held to the same standard as every other commit on the base.** A join squashes to one commit and this draft is its message, so it is the only durable prose the base will ever carry about this arc. Write an **imperative subject** in the repository's recent-commit style; then, as the **second paragraph, a summary** — one to three sentences of plain prose, no bullets, saying what the base is about to receive and why, that a reader can stop at; then the body — what the change does, and the argument the work rests on — for a reader who never saw the arc. The Changes shade fronts the subject and the summary and folds the body, so the summary is the message most readers will read. Never a narration of the arc: no round-by-round digest, no step numbers, no "it did X and then Y", and no archaeology about defects found and fixed along the way. The round count is the receipt's fact rather than the message's — the join receipt shows it and the `Tug-Arc:` trailer names the branch and base. State the argument the work actually rests on and do not append an inferred benefit to make the change sound worthier. Every line runs unbroken to its end (**no hard wrapping**), and no AI or agent attribution, ever.

**Write the subject bare — no `tugarc(<name>): ` prefix.** The join adds the scope itself, so one written here is redundant; a scope naming a *different* arc is stripped at the join rather than preserved, so writing one at best changes nothing and at worst hides what you meant.

Read a good one before writing yours — `git log` on the base shows the project's recent joins. A good one says what the project can now do, which boundary was held, and how it was proven, with no round list and nothing that requires having watched the arc.

Write it even on an arc that stops mid-plan: the draft is what the shade shows the user, and an arc with no draft offers to land its branch description — or, with neither, a generic fallback phrase. The fold says which of the three it is, so a missing draft is visible rather than silent, but visible-and-wrong is still wrong.

**Then say one sentence and stop.** *Step N closed: what it built.* That is the ending under the wheel — the step that closed and what the project can now do — and nothing else belongs in it. Not the join, not the shade, not the audit, not a chip: each of those is a stage after this one speaking for itself, and a stage that announces the next one teaches the user that the arc waits on them. It does not.

**What the wheel does at the boundaries your turns end on.** Above the project's compaction threshold it **compacts** the seated session in place — same session, same lineage, same stage label, only the context comes down. A context the compaction could not bring back under the line gets the second and last answer: the stage rotates to a fresh session. So a rotation mid-arc is the rarer of the two, and neither is a failure.

**A rotated-in session is not a session with nothing to do.** It inherits an arc that is partly walked and has never seen a line of it, so its first acts are the ones this skill opens with: read the [`where` line](#0-read-the-where-line), read the ledger, read the arc's `baseline.md`. Then resume at the first row that is neither `done` nor `withdrawn`, which is the ordinary resume above.

The ending is unchanged by a rotation, and that is the finding rather than an oversight: the turn that closes the arc's final declared step is still the one that writes the draft before closing it — whichever session that turn happens to be running on.

### 4. Iterate (interactive)

The user tests and reports issues. Fix them on the worktree, run the relevant checkpoint, and commit each fix as its own round. The round commits are the record of the fixes. (Fix rounds are not plan steps — they get no `arc step` call.)

**Know your build surface.** The general rule is one line: re-run the declared build when the surface you changed needs it to be seen. Which surfaces hot-reload and which need the rebuild is knowledge that belongs to the project's own docs (its `CLAUDE.md`, typically), not to this skill. On a project whose docs say nothing, re-run the declared build when in doubt, and say that is why.

Loop until the user is satisfied. A follow-up "now do Steps 6-8" is just another `arc-implement` invocation against the same plan and arc.

### 4b. The audit

**This is not yours.** The arc's last step ending rotates it to its audit stage — a fresh session that reads the whole branch cold against the ledger and the brief, verifies the fit, rewrites the draft, and marks the arc. Every arc ends that way. Do nothing about it: end the turn as usual and the wheel seats it.

**Print no `/tugplug:arc-audit` chip.** The audit is the next stage of an arc that is already running, and a chip beside it teaches the user that nothing happens until they type — the belief the wheel exists to retire.

## Guardrails

Everything in [`tuglaws/arc-work-doctrine.md`](../../../tuglaws/arc-work-doctrine.md), plus:

- **Honor the selector and the ledger.** Walk exactly the requested steps; resume from the first row that is neither `done` nor `withdrawn`; never rebuild a `done` step or build on an unfinished dependency.
- **The verbs own the bookkeeping, and there is one for every move.** `start`, `done`, `withdraw`, `reset` to park, `reopen --why` to un-finish — never a hand-edited table. The log line each verb writes is what the arc surfaces derive `implementing (i/N)` from and what arms the join, and a hand-edit leaves the two records disagreeing with nothing to notice. A step you decided not to walk has its own verb; recording that decision in the plan's prose instead is what stales the plan's review.
- **When a step verb refuses and no verb answers it, `tugtool arc doctor <name>` is the gesture.** It is the only one that reads all five records — and the base checkout beside them — and says which disagrees. `/arc-bind` writes one of them and answers nothing about the rest.
- **Ask nothing, and say nothing about yourself.** This stage runs under an arc, often unattended, so a dialog stops the arc in front of nobody — the doctrine's [never-ask list](../../../tuglaws/arc-work-doctrine.md#what-never-gets-asked) and its [never-say list](../../../tuglaws/arc-work-doctrine.md#what-never-gets-said) at their strictest. The stale plan is said in a sentence; a refused verb is answered by the verb that fits; a long selection is not a fork; and a stage's first words are about the work rather than about having found its arc.
- **Speak of no stage after this one.** The join and the audit belong to the audit stage, which is where the shade and its escapes are written down. The ending here is one sentence about the step that closed.
- **Run only under an arc, in a seat that exists.** With no `where` line in the prompt that seated you, or with a worktree that is still not a directory after the one idempotent `tugtool arc create`, say what you found through `tugtool arc ask <name>` and stop — never on a sentence alone.

## When to reach for something else

This skill is a stage, so what to reach for instead is the **door**. `/arc` sharpens the work into a brief and settles its shape: a change whose shape is already clear gets a task list and opens straight at this stage, and work whose decisions want settling first gets the brief alone and a plan devised and read cold before any step is walked. Either way the door hands off by ending its turn, and the wheel paces the walk from there.

A ledger with a great many steps is not a reason to invoke this skill in batches by hand — the wheel already walks it one step per turn, compacting between them and rotating when compaction is not enough, which is exactly what batching was for. A ledger that is genuinely too large is a sign the *work* wanted splitting at the door.
