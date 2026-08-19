---
name: dash-implement
description: Implement a plan into a tested build on an isolated dash worktree — walk a single step, a step range, or the whole plan; agentless, in-thread, committing per step, stopping for review before merge
argument-hint: "[plan-path] [Step N | Steps N-M]"
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, AskUserQuestion, TaskCreate, TaskUpdate
disallowed-tools: Task
---

## What this is

`dash-implement` carries a plan document from start to a launchable, tested build, on its own git worktree, **driven by you — the main conversation — directly**. You read the plan, you do the work, you run the checkpoints, you commit each step. The worktree lifecycle rides the `tugutil dash` CLI; the plan is your checklist.

**Read [`tuglaws/dash-work-doctrine.md`](../../../tuglaws/dash-work-doctrine.md) before you start.** It is the discipline every dash run works under — the one-and-only-working-root rule, the verification bar, test discipline and the banned test shapes, law discipline, round mechanics, the stop-before-join obligation, and no plan numbers in durable artifacts. This skill states the flow; the doctrine states the rules, and it is not repeated here.

## Input

`/tugplug:dash-implement <plan-path> [step-selector]`

- `<plan-path>` — an **explicit path** to a plan written against the devise skeleton. There is no default location — the path is always given.
- `[step-selector]` (optional) — **which steps to walk this invocation**:
  - *(omitted)* — walk the **whole plan** from the first unfinished step to the end.
  - `Step N` — walk a **single** step (e.g. `Step 3`).
  - `Steps N-M` — walk a **range/batch** of steps, inclusive (e.g. `Steps 3-5`).

The **Step Status Ledger** at the top of the plan's Execution Steps is the source of truth for "where are we?". Read it first:

- With no selector, resume at the **first row that is not `done`** — including a row left `in progress` by an interrupted run, which `dash step start` re-enters idempotently — and continue to the end.
- With a selector, honor it — but if an earlier step a selected step `**Depends on:**` is not yet `done`, say so and stop rather than building on an unfinished base.

**If the plan has no Step Status Ledger** (an older or hand-written plan), the step verbs cannot drive it. Fall back gracefully: with no selector, walk from Step 1; infer which steps are already done from `tug log` on the dash branch if the dash exists, and confirm with the user before skipping any. Offer to add a ledger to the plan (on the worktree) so future runs resume — and so the verbs can drive it.

If no plan exists yet, author one first with `/tugplug:plan-devise`, or write it inline — then point this skill at it.

## The five phases

### 1. Setup

1. Read the **Step Status Ledger** and resolve the step selector into a concrete list of steps to walk this run.
2. Derive a short dash name from the plan slug. `tugutil dash create <name> --description "<one line>" --plan <plan-path> --json`. **Capture the absolute `worktree` path** and `branch` from the response. If the dash already exists (resuming a later step range), `create` is idempotent and returns it — and `--plan` on a live dash is the repair path, not an error, so pass it every time.

   `--plan` is what puts the plan **inside the worktree**, and it is the only thing that may: the dash adopts the document ([D139]), committing its bytes on the branch and cleaning the base copy, so there is one live copy from second zero. **Never copy a plan file by hand.** A hand-copy leaves two live copies with no receipt and no divergence detection, which is the failure this verb exists to make impossible. The receipt names the adoption commit and what happened to the base copy; from here you drive the worktree copy only.

   `create` also hydrates the fresh worktree itself (its `[tugtool.dash].post_create` hook runs `bun install`), so it arrives ready — no manual dependency install.
3. **Check that the plan's review covers the plan.** Against the **worktree** copy — the one you are about to drive:

   ```bash
   tugutil plan status <worktree-plan-path> --json
   ```

   Read `data.review`. On `reviewed`, say nothing and carry on.

   On **`stale`** or **`never-reviewed`**, raise an `AskUserQuestion` — never a hard refusal, because the plan is the user's:

   - *"Review now (Recommended)"* — print `` `/tugplug:plan-review <path>` `` as its own backticked chip and **stop**. You do not review inline; the review is its own turn on its own model.
   - *"Proceed as-is"* — carry on and say nothing further about it.

   The message names which verdict it is, and on `stale` quotes `data.last_round`'s date and model, so the user is deciding against a fact rather than a warning. Implementing a plan nobody reviewed is strictly worse than implementing one whose review predates an edit, so both raise the same gate.

   The gate reads the worktree copy and needs no comparison against a base one: adoption left exactly one live copy, and replaying ledger progress does not move a plan's content stamp, so a `reviewed` plan is still `reviewed` after the transplant.
4. Establish a green baseline (`bun test`, and for Rust changes `cd tugrust && cargo nextest run`) so you know what "still green" means.
5. Make progress visible with one task per step. **This is not optional and not best-effort** — the task list is the user's live progress surface for the run, and it must mirror the resolved step list exactly: **every step selected this run gets a task, before you start walking.** `TaskCreate`/`TaskUpdate` are deferred tools — their schemas are not in the prompt until you load them, and listing them under `allowed-tools` does **not** load them. First call `ToolSearch` with query `select:TaskCreate,TaskUpdate`, then call `TaskCreate` **once per step** (it creates a single task — it has no `tasks`/`todos` batch parameter), passing top-level string `subject` (the step title) and `description` (what the step does).

### 2. Implement (walk the steps)

Walk the resolved steps in dependency order. For each step:

- **Open the step.** Flip its task to in-progress (`TaskUpdate`), then:
  ```bash
  tugutil dash step <name> start <n> [--plan <path>]
  ```
  This moves the ledger row to `in progress` and records the step in the dash-log, which is what makes the dash read as `implementing (i/N)` in the Lens and the Changes card while you work. `create --plan` already recorded which plan this dash drives, so `--plan` here is only for a dash that never adopted one.
- Read the step's Tasks / References / Checkpoint.
- Do the work yourself, in the worktree.
- Run **that step's checkpoint** before committing. The bar is in the doctrine; the step names the specific commands.
- Commit the round:
  ```bash
  tugutil dash commit <name> --message "<conventional commit>" --json <<'EOF'
  {"instruction":"Step N: <title>","summary":"<what landed + how verified>"}
  EOF
  ```
- **Close the step** with the commit the round produced:
  ```bash
  tugutil dash step <name> done <n> --commit <sha>
  ```
  This writes the ledger row's status *and* its commit cell and appends the paired log line. Omit `--commit` to record the dash branch's tip. Then mark the step's task complete — task, ledger, and commit move together, and the verb is what keeps them together.

Pragmatics:

- **`dash step` refusing over a diverging base plan copy has exactly one right answer, so it is not an ask-fork.** The message names it: run `tugutil dash adopt-plan <name>` and retry the step. It means the user edited the base checkout's copy of the plan mid-run; the transplant folds their edits in, replays your ledger progress onto them, and cleans base. Do it and carry on.
- **A refused `dash step` is telling you about the document, not the tool.** It exits 1, names the plan and the row, and leaves the file untouched — a plan that does not strictly parse, a missing ledger row, an anchor that is not `#step-<n>`, or a `done` row you tried to reopen.

  Raise the refusal as an `AskUserQuestion` rather than picking a repair yourself, because the wrong guess corrupts the durable record: *"Fix the plan and retry"* / *"Hand-edit the ledger this run"*. Quote what the verb said. A malformed document usually wants fixing; a document that genuinely cannot be made to parse wants the hand-edit — and which one this is depends on what the plan is *for*, which is the user's to know.
- **A long run asks once, at its midpoint.** When a single invocation is walking **more than six** steps, stop at the halfway step and ask: *"Continue"* / *"Stop here and report"*. Once per run, at that one boundary — never per step, and never on a run of six or fewer. The threshold is stated so it is not re-invented each time.
- Folding trivial or already-absorbed steps into a neighbor is fine — the join squashes at the end, so per-step commit granularity is for *your* visibility during the run. When you fold a step, still run its `done` verb (pointing at the neighbor's commit) and close its task — no step is left dangling `in progress`.
- If a step's verification fails, fix it before committing. Never commit red.
- When you reach the end of the requested selection, stop walking and report the ledger state — which steps are `done` and which remain.

### 3. Build

From the worktree directory:

```bash
just app-debug
```

This builds + signs + launches a separate `(debug, <branch>)` instance derived from the worktree's cwd — independent of the user's main instance. Confirm it's live (`just instances`), and report the instance id plus `just launch-debug` / `just logs-debug` / `just stop-debug`. Then declare it:

```bash
tugutil dash mark <name> built
```

**Stop here.** Do not merge. The build is the user's to vet and test.

Before you stop, write the dash's **join draft** — the squash message the user's join lands with. Compose it from the run's rounds (a subject line naming the plan's deliverable, then a terse digest of what the rounds landed), and write it:

```bash
tugutil draft set --owner dash:<name> --message "<subject + rounds digest>"
```

**Write the subject bare — no `tugdash(<name>): ` prefix.** The join adds the scope itself, so one written here is redundant; a scope naming a *different* dash is stripped at the join rather than preserved, so writing one at best changes nothing and at worst hides what you meant.

Then point the user at the join gesture: **`/join <name>`** in the Session card previews the merge and lands the squash with that draft as its message.

### 4. Iterate (interactive)

The user tests and reports issues. Fix them on the worktree, run the relevant checkpoint, and commit each fix as its own round. Track fixes the same way as steps: `TaskCreate` a task per reported issue, flip it in-progress while you work it, complete it when its fix commits. (Fix rounds are not plan steps — they get no `dash step` call.) Know your build surface:

- **tugdeck (frontend)** changes are live via Vite HMR — no rebuild; tell the user to hard-reload the card if Fast Refresh doesn't repaint a row.
- **Rust / tugcode / Swift** changes need a rebuild — `just app-debug` again (tugcode is bun-compiled; it has no HMR).

Loop until the user is satisfied. A follow-up "now do Steps 6-8" is just another `dash-implement` run against the same plan and dash.

### 5. Join (the user's join gesture)

The join is the user's: **`/join <name>`** in the Session card previews the merge (in-memory `git merge-tree` — nothing is touched until it's clean) and squash-lands the dash into its base with the join draft you wrote in phase 3 as the message. Conflicts route into the shade's resolve flow. Do not run the join yourself, and do not merge on the user's behalf — your part ends at the draft. If the user reports the join blocked on base dirt, the preflight is intersection-aware: only base changes overlapping the dash's files block; unrelated base dirt should be committed or stashed first.

## Guardrails

Everything in [`tuglaws/dash-work-doctrine.md`](../../../tuglaws/dash-work-doctrine.md), plus:

- **Honor the selector and the ledger.** Walk exactly the requested steps; resume from the first row that is not `done`; never rebuild a `done` step or build on an unfinished dependency.
- **The verbs own the bookkeeping.** Drive the ledger with `dash step start|done`, not by hand-editing the table — the log line the verb writes is what the dash surfaces derive `implementing (i/N)` from, and a hand-edit leaves them blind.
- **Keep the task list in lockstep.** One task per selected step, created up front; in-progress when you `start`, complete when you `done`. A run whose tasks don't match the ledger is an unfinished run.
- **Ask at the three forks, and nowhere else.** The stale gate, a refused `dash step`, and the midpoint of a long run are the whole set. Everything outside it is covered by the doctrine's [never-ask list](../../../tuglaws/dash-work-doctrine.md#what-never-gets-asked) — a run that asks about everything trains the user to click through the dialog that mattered.

## When to reach for something else

This skill holds the plan's context in one conversation, which fits small-to-medium plans well (a dozen steps is healthy). For a very large plan, walk it in batches — `/tugplug:dash-implement <plan> Steps 1-4`, review, then `Steps 5-8` — or author smaller plans. For a quick, plan-less change, use `/tugplug:dash-on` instead.
