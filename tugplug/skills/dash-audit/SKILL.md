---
name: dash-audit
description: Audit a dash's implemented code against the plan it was written from — read the branch's whole diff cold, fix what does not match as ordinary rounds, and mark the dash audited
argument-hint: "[name]"
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
disallowed-tools: Task, AskUserQuestion
---

## What this is

`dash-audit` is the **post-implementation** pass: read the code a dash actually landed, judge it against the plan it was written from, and **fix what does not match**. It is the arc's last stage, and it runs on a session that has never seen the run it is reading.

That coldness is the whole design. The session that wrote the code is the weakest possible reader of it — it knows what it meant, so it sees what it meant, and the gap between the plan's promise and the bytes on the branch is exactly the thing a defending reader cannot see. A fresh session opening on the plan and the diff has nothing to defend.

It is the sibling of `dash-review`, at the other end of the run. Review reads a plan against the code that exists and fixes the plan; audit reads the code against the plan that was reviewed and fixes the code. Neither reports; both do the work they find.

**You are the auditor, in-thread.** Do not spawn sub-agents (`Task`).

**Read [`tuglaws/dash-work-doctrine.md`](../../../tuglaws/dash-work-doctrine.md) before you start.** The discipline every dash run works under is stated there and is not repeated here: the one-and-only-working-root rule, the verification bar, test discipline and the banned test shapes, law discipline, round mechanics, and the stop-before-join obligation. **When the project has no `tuglaws/`,** that document is absent and cannot be read; the rules that survive its absence are the ones carried inline below — one working root, verify before every commit, never commit red, rounds through `tugutil dash commit`, stop before the join. Say so once, at the start, and do not invent the rest of the doctrine from memory.

## Input

`/tugplug:dash-audit <name>` — a dash name, which is an exact address rather than a guess. There is no default and no search: invoked with nothing, say so and stop.

## The pass

### 1. Take the worktree, and read what the run said it would do

```bash
tugutil dash create <name> --json
```

Idempotent — it returns the existing dash and records that this session is working it. **Capture the absolute `worktree` path**; from here it is the only working root, and every read, write, and check is addressed by absolute path into it.

```bash
tugutil dash documents <name> --json
tugutil plan status <name> --json
```

Read the plan in full. It is the audit's standard of comparison, and it is the only one: what the work was *supposed* to do is what the plan says, not what the diff looks like it was trying to do. A dash worked directly has a task list rather than a devised plan — shorter, no decisions, no checkpoints — and it is the standard all the same. Read the ledger's step titles as the promises they are.

### 2. Read the whole diff, cold

```bash
tugutil dash show <name>
```

Then the diff itself, from the worktree — every commit the branch carries against its base, as one range, and then file by file for anything the range read past too quickly. The rounds' own commit messages say what each claimed to do; the dash-log holds the instruction git cannot see. Read both, and read them *after* the code, so the code is judged rather than the claim.

**Read the code, not the summary of it.** An audit that could have been written from the commit messages has not happened.

### 3. Judge it

Four questions, in this order. The first two are the audit's own; the last two are the bar every dash round was already held to, asked once more by somebody with no stake in the answer.

- **Does the code do what the plan said?** Step by step, promise by promise. A step marked `done` whose behaviour is not in the tree is the finding this whole stage exists to catch — including the honest version of it, where the step did something adjacent and nobody noticed the difference.
- **Does it do anything the plan did not say?** Scope that arrived without a decision behind it. Not every unplanned line is wrong — work discovers things — but an unplanned line that changes a contract, a default, or a surface is a decision somebody made silently.
- **Is it right?** Real defects, in the ordinary sense: the unhandled case, the wrong boundary, the state that can be reached and is not handled, the check that passes for the wrong reason.
- **Does it fit?** The laws the change touches, the conventions of the files it sits in, the tests at the layer that can actually see the behaviour. For work under a project's law documents, name the specific laws — mimicry of neighbouring code proves nothing about which invariant that code was upholding.

**Ground every finding in the tree.** Name the file, the symbol, the line. A finding you could have written without opening the file is not a finding.

### 4. Fix what you find

Fix it. That is the whole of what to do with a finding, and the reason this stage edits code at all: an audit that could only report would hand its findings to nobody, because the run that would have acted on them is over.

The fixes are **ordinary rounds** on the dash, under the doctrine's round mechanics and its verification bar. Verify before every commit — the checks the project declares for what you moved — and never commit red:

```bash
tugutil dash commit <name> --message "tugdash(<name>): <imperative summary, under 50 chars>" --json <<'EOF'
{"instruction":"audit: <what the finding was>","summary":"<what you changed + how verified>"}
EOF
```

The plan's ledger is already walked and stays walked: an audit opens no step and closes none. Its rounds are the record of what it changed, and the mark at the end is the record that it ran.

**What not to fix.** Anything you merely would have done differently. A run is not wrong for not being yours, and a stage that rewrites working code to its own taste at the end of somebody else's run is the most expensive kind of noise. Style, naming that is merely not your preference, a structure that works — leave them.

**A finding you cannot settle is written down, not asked.** This stage raises no dialog: it runs cold, often unattended, and a question here would stop the arc in front of nobody. When the work leaves a genuine judgment call — a scope decision, a trade-off with no technically correct answer — say so plainly in the report and in the join draft, and leave the code as the run left it. The user reads it at the join, which is where that decision was always theirs to make.

### 5. Verify the fit

Whether or not you changed anything, the tree that lands is the run's work replayed onto the live base, and nothing has tested that:

```bash
tugutil dash replay <name>
```

On **`Replayed`** / **`Recorded`** the tree moved — verify it with `tugutil dash verify <name>` from the worktree, which resolves every path the replay moved to a surface the project declared and runs what those surfaces declare. A refusal (exit 2) names paths no surface claims and runs nothing: declare a surface for them rather than working around it. Red (exit 1) is ordinary work — fix it as a round. A project that declares no surfaces says so and exits 0; check what the replay moved with the commands the run already used, never one you invent, and say so. On **`Current`** the base never moved and the checks that just passed covered these exact bytes, so run nothing and say so. On **`Conflicted`** the replay names the round it stopped at: resolve it in the worktree, commit the fix as a round, then verify.

### 6. Refresh the join draft

The draft is the squash message the user's join will land, and it is the only durable prose the base will ever carry about this dash. The run left one; if the audit changed anything, it is now describing a tree that has moved:

```bash
tugutil draft set --owner dash:<name> --message "<subject + durable body>"
```

An **imperative subject** in the repository's recent-commit style, bare — no `tugdash(<name>): ` prefix, because the join adds the scope itself. Then a **summary paragraph**, one to three sentences of plain prose a reader can stop at, saying what the base is about to receive and why. Then the body: what the change does and the argument it rests on, for a reader who never saw the run.

**Never a narration of the run, and that includes yours.** No round-by-round digest, no step numbers, no "the audit found and fixed" archaeology. What the audit repaired is part of what the change *is* — describe the change, not its history. Every line unbroken to its end (**no hard wrapping**), and no AI or agent attribution, ever.

Read a good one before writing yours: `tug log` on the base shows the project's recent joins.

### 7. Mark it, and stop

```bash
tugutil dash mark <name> audited --note "<one line: what was checked, and what was fixed>"
```

**The mark is the stage's whole product**, exactly as the stamp is the review's. It is the one fact that says the audit ran, it is read from the dash's own record rather than from anything you say about yourself, and an audit that ends without it has answered nothing — the arc stops there and says the audit did not mark. So it is the last thing you do, after every round is committed and the fit is verified.

Then report what you found and what you changed, in a few lines, and **stop. Do not join.** Landing is the user's act, always.

The Changes shade is how the join reaches them: it reveals itself on the bound card in the first quiet moment, carrying the dash's row and the message the join would land. **Print no `/dash-join <name>` chip** — it reads as "nothing will happen until you type this" beside a room that is about to open on its own.

## Guardrails

Everything in [`tuglaws/dash-work-doctrine.md`](../../../tuglaws/dash-work-doctrine.md), plus:

- **No sub-agents.** Read, judge, and fix in-thread.
- **Read the code before the claims.** The commit messages and the dash-log are read after the diff, so the code is judged rather than the account of it.
- **Fix, never report-and-defer.** The run that would have acted on a report is over. What you cannot settle is written into the report and the draft, not asked.
- **No dialogs.** This stage runs cold and often unattended; a question here stops the arc in front of nobody.
- **Never open or close a step.** The ledger is walked; an audit's work is rounds.
- **Leave alone what is merely not yours.** A run is not wrong for not being your run.
- **Verify before every commit, and never commit red.**
- **The mark is last, and it is the product.** Every round committed, the fit verified, then `dash mark audited`.
- **Stop before the join.** Landing is the user's act.
