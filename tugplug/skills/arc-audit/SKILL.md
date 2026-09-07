---
name: arc-audit
description: The audit stage of an arc — read the branch's whole diff cold against the ledger it was written from, fix what does not match as ordinary rounds, and mark the arc audited
argument-hint: "[name]"
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
disallowed-tools: Task, AskUserQuestion
---

## What this is

`arc-audit` is the **post-implementation** pass: read the code an arc actually landed, judge it against the plan it was written from, and **fix what does not match**. It is the arc's last stage, and it runs on a session that has never seen the work it is reading.

That coldness is the whole design. The session that wrote the code is the weakest possible reader of it — it knows what it meant, so it sees what it meant, and the gap between the plan's promise and the bytes on the branch is exactly the thing a defending reader cannot see. A fresh session opening on the plan and the diff has nothing to defend.

It is the sibling of `arc-review`, at the other end of the arc. Review reads a plan against the code that exists and fixes the plan; audit reads the code against the plan that was reviewed and fixes the code. Neither reports; both do the work they find.

**You are the auditor, in-thread.** Do not spawn sub-agents (`Task`).

**Read [`tuglaws/arc-work-doctrine.md`](../../../tuglaws/arc-work-doctrine.md) before you start.** The discipline every arc run works under is stated there and is not repeated here: the one-and-only-working-root rule, the verification bar, test discipline and the banned test shapes, law discipline, round mechanics, and the stop-before-join obligation. **When the project has no `tuglaws/`,** that document is absent and cannot be read; the rules that survive its absence are the ones carried inline below — one working root, verify before every commit, never commit red, rounds through `tugtool arc commit`, stop before the join. Say so once, at the start, and do not invent the rest of the doctrine from memory.

## Input

`/tugplug:arc-audit <name>` — an arc name, which is an exact address rather than a guess. There is no default and no search: invoked with nothing, say so and stop.

## The pass

### 0. Read the `where` line

The prompt that seated you carries one: `where: worktree <abs path> · session <id> bound · stage audit`. That is the arc's worktree — **the one working root, and the absolute path every read, write and check below is addressed by** — and the seat the arc is bound to. Read it and start reading the code. The runner made the worktree before it composed the line — idempotently, since the implement stage already worked in it — then ran `arc doctor`'s comparison across the ledger table, the arc log, the binding, the arc record, and the seat itself immediately before sending it, so there is nothing here to probe for, nothing to confirm, and nothing to say about having done either.

**The session id on the line is the card's tug session id** — the one `printenv TUG_SESSION_ID` prints in your shell. Claude's own session id never appears on a stage-facing line, so a mismatch between the two is not a finding; there is no comparison to make here, and none is asked of you. The dispatch's binding is what the join offer reads, so this stage claims nothing and needs no `arc create` for the claim it once made.

**Two things stop this stage before it reads a line, and both stop it through the arc rather than in prose.** With no `where` line at all, or with a `where` line whose worktree is still not a directory after [the fallback below](#1-read-what-the-arc-said-it-would-do), do not end the turn on a sentence — a turn that ends in prose reads to the wheel as a quiet turn, and the arc dies of silence at the clock with a receipt that says the opposite of what happened. Stop it instead:

```bash
tugtool arc ask <name> "<what you found, in one sentence>"
```

That writes the sentence as the arc's last note and stops the arc as `needs a decision`, with a Resume on the receipt the user sees in seconds.

**With no `where` line above, that is the sentence to stop on.** This skill is a stage of an arc rather than a standalone command, and it is the last stage of **every** arc: `/arc` is the one door, and the shape it settles on decides only where the arc *starts* — a plain arc at implement, a planned one at devise. Each reaches here when its final declared step closes. There is no path from here that ends anywhere else — the mark this stage writes is read by a runner, and with no runner reading it the mark declares an arc finished that nothing was running.

### 1. Read what the arc said it would do

```bash
tugtool arc documents <name> --json
tugtool plan status <name> --json
```

**The worktree on the `where` line was made by the dispatch.** If it is not a directory, run the idempotent verb once, take `worktree` from the response as the working root, and say in one sentence that the dispatch had not made it:

```bash
tugtool arc create <name> --json
```

A present branch and worktree return as-is (`created: false`), so on a healthy run this runs nothing and changes nothing. A path that is still not a directory afterwards is the second stop case above.

**Read the ledger and the brief, both, in full.** They are the audit's standard of comparison and they answer different halves of it ([B06]):

- **The ledger** — a devised `plan.md`, or an `/arc` door's `tasks.md`, whichever the arc has — says what the work was *supposed to do*, step by step. Read its step titles as the promises they are. A task list is shorter, has no decisions and no checkpoints, and is the standard all the same.
- **The brief** at the same address says *why*, and it is the only document that does. It carries the settling the door did before any arc opened — the decisions as `[B##]`, the findings as `[F##]` — which is the user's stated intent in the one form a cold session can read. A plan can implement its own steps faithfully and still miss what the brief asked for, and that gap is invisible to a reader who only has the plan.

`arc documents --json` names all three paths and says which exist. Read the brief even when a plan exists — especially then, since the plan is one session's reading of the brief and this stage's job is not to trust a reading.

**Read the arc's `baseline.md` too if the implement stage left one.** It records what was already red before the first step, which is the difference between a defect this arc introduced and one it inherited.

### 2. Read the whole diff, cold

```bash
tugtool arc show <name>
```

Then the diff itself, from the worktree — every commit the branch carries against its base, as one range, and then file by file for anything the range read past too quickly. The rounds' own commit messages say what each claimed to do; the arc log holds the instruction git cannot see. Read both, and read them *after* the code, so the code is judged rather than the claim.

**Read the code, not the summary of it.** An audit that could have been written from the commit messages has not happened.

### 3. Judge it

Five questions, in this order. The first three are the audit's own; the last two are the bar every arc round was already held to, asked once more by somebody with no stake in the answer.

- **Does the code do what the ledger said?** Step by step, promise by promise. A step marked `done` whose behaviour is not in the tree is the finding this whole stage exists to catch — including the honest version of it, where the step did something adjacent and nobody noticed the difference.
- **Does it answer what the brief asked for?** The ledger is one session's reading of the brief, and an arc can walk every step of it faithfully and still leave the brief's `[B##]` decisions unhonoured or its `[F##]` findings unaddressed. This is the question only the brief can ask, and it is why the brief is in the reading list ([B06]).
- **Does it do anything neither document said?** Scope that arrived without a decision behind it. Not every unplanned line is wrong — work discovers things — but an unplanned line that changes a contract, a default, or a surface is a decision somebody made silently.
- **Is it right?** Real defects, in the ordinary sense: the unhandled case, the wrong boundary, the state that can be reached and is not handled, the check that passes for the wrong reason.
- **Does it fit?** The laws the change touches, the conventions of the files it sits in, the tests at the layer that can actually see the behaviour. For work under a project's law documents, name the specific laws — mimicry of neighbouring code proves nothing about which invariant that code was upholding.

**Ground every finding in the tree.** Name the file, the symbol, the line. A finding you could have written without opening the file is not a finding.

### 4. Fix what you find

Fix it. That is the whole of what to do with a finding, and the reason this stage edits code at all: an audit that could only report would hand its findings to nobody, because the stage that would have acted on them is over.

The fixes are **ordinary rounds** on the arc, under the doctrine's round mechanics and its verification bar. Verify before every commit — the checks the project declares for what you moved — and never commit red:

```bash
tugtool arc commit <name> --message "tugarc(<name>): <imperative summary, under 50 chars>" --json <<'EOF'
{"instruction":"audit: <what the finding was>","summary":"<what you changed + how verified>"}
EOF
```

The plan's ledger is already walked and stays walked: an audit opens no step and closes none. Its rounds are the record of what it changed, and the mark at the end is the record that it ran.

**What not to fix.** Anything you merely would have done differently. An arc is not wrong for not being yours, and a stage that rewrites working code to its own taste at the end of somebody else's is the most expensive kind of noise. Style, naming that is merely not your preference, a structure that works — leave them.

**A finding you cannot settle is written down, not asked.** This stage raises no dialog: it runs cold, often unattended, and a question here would stop the arc in front of nobody. When the work leaves a genuine judgment call — a scope decision, a trade-off with no technically correct answer — say so plainly in the report and in the join draft, and leave the code as the implement stage left it. The user reads it at the join, which is where that decision was always theirs to make.

### 5. Verify the fit

Whether or not you changed anything, the tree that lands is the arc's work replayed onto the live base, and nothing has tested that:

```bash
tugtool arc replay <name>
```

On **`Replayed`** / **`Recorded`** the tree moved — verify it with `tugtool arc verify <name>` from the worktree, which resolves every path the replay moved to a surface the project declared and runs what those surfaces declare. A refusal (exit 2) names paths no surface claims and runs nothing: declare a surface for them rather than working around it. Red (exit 1) is ordinary work — fix it as a round. A project that declares no surfaces says so and exits 0; check what the replay moved with the commands the arc's own checkpoints already used, never one you invent, and say so. On **`Current`** the base never moved and the checks that just passed covered these exact bytes, so run nothing and say so. On **`Conflicted`** the replay names the round it stopped at: resolve it in the worktree, commit the fix as a round, then verify.

### 6. Write the join draft

The draft is the squash message the user's join will land, and it is the only durable prose the base will ever carry about this arc. **The audit is its author of record.** The implement stage left a provisional one, and it is the starting text rather than the message: this stage has read the whole diff cold and is the last to touch the tree, so its account is the one that describes what lands — whether or not the audit changed a byte. Rewrite it, always, and do not leave it standing on the grounds that nothing moved:

```bash
tugtool draft set --owner arc:<name> --message "<subject + durable body>"
```

An **imperative subject** in the repository's recent-commit style, bare — no `tugarc(<name>): ` prefix, because the join adds the scope itself. Then a **summary paragraph**, one to three sentences of plain prose a reader can stop at, saying what the base is about to receive and why. Then the body: what the change does and the argument it rests on, for a reader who never saw the arc.

**Never a narration of the arc, and that includes your own part in it.** No round-by-round digest, no step numbers, no "the audit found and fixed" archaeology. What the audit repaired is part of what the change *is* — describe the change, not its history. Every line unbroken to its end (**no hard wrapping**), and no AI or agent attribution, ever.

Read a good one before writing yours: `git log` on the base shows the project's recent joins.

### 7. Mark it, and stop

```bash
tugtool arc mark <name> audited --note "<one line: what was checked, and what was fixed>"
```

**The mark is the stage's whole product**, exactly as the stamp is the review's. It is the one fact that says the audit ran, it is read from the arc's own record rather than from anything you say about yourself, and an audit that ends without it has answered nothing — the wheel stops the arc there and says the audit did not mark. So it is the last thing you do, after every round is committed and the fit is verified.

Then report what you found and what you changed, in a few lines, and **stop. Do not join.** Landing is the user's act, always.

### 8. The join is the user's gesture

**The shade is the door**, and this stage is the only one that speaks of it — the offer arms on the arc's own record, and this is the stage standing at the end of it. The Changes shade reveals itself on the bound card in the first quiet moment, showing the arc's row, the message the join would land, and where those words came from. Entering the landing mode and pressing the composer's ⬆ squash-lands the arc with the draft you wrote in stage 6, narrating the beats and settling on the outcome. The user does that; you do not. Your part ended at the mark.

Closing the shade costs nothing and answers nothing — the row is still in there, and new work on the arc reveals it again. There is no "not yet" to record and nothing that can lock the offer out.

**`/arc-join <name>` in the Session card is the escape hatch**, the same join by hand, previewing the merge in memory before anything is touched. Reach for it only in the two cases below.

**The escapes.** Print the chip in exactly two situations, because in both of them the shade genuinely has nothing to reveal:

- **The arc is unbound by choice.** The offer only reaches a card bound to the arc, and an unbound arc is never even reconciled. If the user has declined to bind one, `/arc-join <name>` is their only path.
- **A legacy arc** with no declared selection and no mark — nothing arms it, so no offer ever stands.

Everywhere else the chip is noise at best and misinformation at worst: it reads as "nothing will happen until you type this" beside a room that is about to open on its own. If the user reports the join blocked on base dirt, the preflight is intersection-aware — only base changes overlapping the arc's files block, and unrelated base dirt is committed or stashed first.

## Guardrails

Everything in [`tuglaws/arc-work-doctrine.md`](../../../tuglaws/arc-work-doctrine.md), plus:

- **No sub-agents.** Read, judge, and fix in-thread.
- **Read the code before the claims.** The commit messages and the arc log are read after the diff, so the code is judged rather than the account of it.
- **Fix, never report-and-defer.** The stage that would have acted on a report is over. What you cannot settle is written into the report and the draft, not asked.
- **No dialogs.** This stage runs cold and often unattended; a question here stops the arc in front of nobody.
- **Judge against both documents.** The ledger says what, the brief says why, and an arc can satisfy one without the other.
- **Run only under an arc.** With no `where` line in the prompt that seated you, say what this is the last stage of and that `/arc` is the door that starts one, and stop.
- **Never open or close a step.** The ledger is walked; an audit's work is rounds.
- **Leave alone what is merely not yours.** An arc is not wrong for not being yours.
- **Verify before every commit, and never commit red.**
- **The mark is last, and it is the product.** Every round committed, the fit verified, then `arc mark audited`.
- **Stop before the join.** Landing is the user's act.
