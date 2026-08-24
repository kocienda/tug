# Accurate State Tracking

Granular, truthful progress tracking for plan steps — replacing bulk force-completion with incremental status updates that reflect what actually happened.

## Problem

Today, plan step progress tracking is a fiction. Here's the actual flow:

1. **Coder-agent** implements the step. It never calls any `tugcode state` commands. It returns a JSON blob with `tests_passed: true/false` and a summary.
2. **Reviewer-agent** reads the coder's output. It never calls any `tugcode state` commands either.
3. **Implement skill** (orchestrator), after reviewer approval, runs a single bulk operation: `tugcode state update {plan} {step} --all completed`. Every task, test, and checkpoint for the step is marked completed in one shot — regardless of which items were actually verified.
4. **`tugcode commit`** calls `complete_step(force=true)`, which auto-completes any remaining incomplete items and records `complete_reason = "committed via tugcode commit"`.

The result: `tugcode state show` displays 100% completion with a "Force-completed" annotation. The numbers are correct by construction but meaningless as a record of what happened. We don't know which tasks were actually done, which tests actually ran and passed, or which checkpoints were actually verified. The state DB is a rubber stamp.

### What the user sees

```
✓ step-0 - Schema Migration and Core Dash State Functions
  Tasks: 13/13  ████████████  100%
  Tests: 12/12  ████████████  100%
  Checkpoints: 2/2  ████████████  100%
  Force-completed: committed via tugcode commit
```

This looks complete, but "Force-completed" contradicts the 100% — it means the items were bulk-set, not individually verified. Confusing and untrustworthy.

### The deeper issue

The state system has the machinery for granular tracking (individual checklist items with separate statuses), but the agent workflow never uses it. The `state update` command supports per-item updates (`--kind task --ordinal 0 --status completed`), but nobody calls it that way.

## Source of Truth

The plan document and the state database serve different roles at different times. This needs to be explicit.

**During planning, the plan document is the source of truth.** The planner skill, author-agent, and critic-agent collaborate to produce a tugplan markdown file. The plan defines steps, tasks, tests, checkpoints, and dependencies. It's a human-readable specification. Nothing has been executed yet; the plan is the complete picture.

**During implementation, the state database is the source of truth.** When `tugcode state init` runs, it snapshots the plan into SQLite — every step, substep, task, test, and checkpoint becomes a row with a status. From that point forward, the state DB tracks what's been claimed, started, completed, and deferred. The plan document is frozen. It becomes a reference specification, not a live tracker.

This transition is already how the system works, but it's implicit. Making it explicit resolves several confusions and clarifies what we should and shouldn't do.

### The plan document is never edited during implementation

This is the right choice. The plan is a specification that was authored, reviewed, and approved. Editing it during implementation would create ambiguity: did the plan change because requirements changed, or because someone was tracking progress? Keeping the plan immutable during implementation means the `plan_hash` recorded at `init_plan` time remains valid.

This does mean the checkboxes in the plan markdown (`- [ ]`) are never checked. Someone reading the plan file after implementation sees a document that looks like nothing was done. This is cosmetically misleading but practically correct — the plan's job was to specify, and it did that. The state DB's job is to track execution.

### The state database has all the detail

The `checklist_items` table stores the full text of every item (`plan_path`, `step_anchor`, `kind`, `ordinal`, `text`, `status`). The data needed to reconstruct the plan's checklist view — item by item, with statuses — already lives in the DB. But `tugcode state show` only queries aggregate counts via `ChecklistSummary` (tasks_total, tasks_completed, etc.). The item-level text is in the DB but never displayed back to the user.

This is a display gap, not a data gap. The state DB can fully reconstruct the plan's checklist detail with statuses. We just need to query and present it.

### Plan hash as a contract

`init_plan` stores a SHA-256 `plan_hash` of the plan file content. If someone edits the plan document after initialization, the hash breaks. Currently nothing checks this — there's no validation on read that the plan hasn't drifted from what was loaded into state.

If we're making the source-of-truth transition explicit, we should detect and surface plan-file drift. When `tugcode state show` runs, it can compare the current file hash against the stored hash and warn if they diverge. This keeps the contract honest: the DB tracks execution of a specific plan, and we know if that plan was altered after the fact.

## Design Principles

**Track what actually happened.** If a test ran and passed, mark that specific test completed. If a task was implemented, mark that specific task. If a checkpoint wasn't verified, leave it open. The state DB should be a truthful audit trail.

**Don't block the agent flow.** Agents can't pause for manual verification. The tracking system must accommodate items that require human judgment without holding up automated work.

**Eliminate force-completion for normal operation.** Force-complete should be an escape hatch for error recovery, not the standard path. A well-tracked step should complete in strict mode because all items were genuinely ticked off.

**Incremental, not batch.** Items are completed as they're accomplished, not in a bulk sweep at the end. This gives meaningful progress visibility mid-step, not just a binary pending/done.

## Proposal

### 1. Coder-agent reports per-item status

The coder-agent already knows which tasks it implemented and which tests it ran. Its output JSON should map results back to checklist items.

**Current coder output:**
```json
{
  "tests_passed": true,
  "build_passed": true,
  "summary": "Implemented schema migration and core functions"
}
```

**Proposed coder output (additions):**
```json
{
  "tests_passed": true,
  "build_passed": true,
  "summary": "Implemented schema migration and core functions",
  "checklist_status": {
    "tasks": [
      { "ordinal": 0, "status": "completed" },
      { "ordinal": 1, "status": "completed" },
      { "ordinal": 2, "status": "completed" }
    ],
    "tests": [
      { "ordinal": 0, "status": "completed" },
      { "ordinal": 1, "status": "completed" },
      { "ordinal": 2, "status": "skipped", "reason": "manual verification required" }
    ],
    "checkpoints": [
      { "ordinal": 0, "status": "completed" },
      { "ordinal": 1, "status": "skipped", "reason": "manual verification required" }
    ]
  }
}
```

The coder sees the step's checklist items (they're already passed in context via the architect strategy). It reports what it accomplished and what it couldn't verify.

### 2. Implement skill ticks items individually

Replace the bulk `--all completed` with per-item updates based on the coder's report.

**Current (line 560 of implement SKILL.md):**
```
tugcode state update {plan} {step} --all completed --worktree {wt}
```

**Proposed:**
```
# After coder returns, tick each item the coder reported as completed:
tugcode state update {plan} {step} --kind task --ordinal 0 --status completed --worktree {wt}
tugcode state update {plan} {step} --kind task --ordinal 1 --status completed --worktree {wt}
tugcode state update {plan} {step} --kind test --ordinal 0 --status completed --worktree {wt}
# Items reported as "skipped" get a distinct status:
tugcode state update {plan} {step} --kind test --ordinal 2 --status deferred --worktree {wt}
...

# After reviewer approval, tick checkpoints the reviewer confirmed:
tugcode state update {plan} {step} --kind checkpoint --ordinal 0 --status completed --worktree {wt}
```

This is more verbose, but each state transition is individually meaningful. The orchestrator can batch these into a single `tugcode state update` call if we add batch support (see below).

### 3. Introduce a `deferred` status for items that need human verification

Some checklist items genuinely can't be verified by agents:

- "Manual: verify the UI renders correctly in Chrome"
- "Checkpoint: user confirms the API response format is acceptable"

These should not block automated completion and should not be silently marked "completed" either.

**New status value: `deferred`**

- Meaning: "This item was intentionally left for human verification."
- `complete_step(force=false)` treats `deferred` items as non-blocking — a step can complete in strict mode if all items are either `completed` or `deferred`.
- `tugcode state show` displays deferred items distinctly so the user can see what still needs human review.

### 4. Batch update command

To avoid N separate CLI invocations, add a batch mode to `tugcode state update`:

```bash
tugcode state update {plan} {step} --worktree {wt} --batch --json <<'EOF'
[
  {"kind": "task", "ordinal": 0, "status": "completed"},
  {"kind": "task", "ordinal": 1, "status": "completed"},
  {"kind": "test", "ordinal": 0, "status": "completed"},
  {"kind": "test", "ordinal": 2, "status": "deferred"},
  {"kind": "checkpoint", "ordinal": 0, "status": "completed"}
]
EOF
```

Single CLI call, single DB transaction, multiple items updated. The orchestrator constructs this from the coder's `checklist_status` output.

### 5. Strict completion becomes the default path

With granular tracking and `deferred` status, the normal flow no longer needs force-completion:

1. Coder reports per-item status.
2. Orchestrator ticks items via batch update.
3. Reviewer approval ticks checkpoint items.
4. `tugcode commit` calls `complete_step(force=false)`.
5. All items are `completed` or `deferred` — strict mode succeeds.

Force-complete remains available for error recovery (`tugcode state complete --force --reason "manual recovery"`), but it's no longer the happy path.

### 6. Update `tugcode commit` to use strict mode by default

**Current:** `commit.rs` hardcodes `force=true`.

**Proposed:** `commit.rs` attempts strict completion first. If strict fails (incomplete items that aren't `deferred`), it reports which items are still open and fails the state update (the git commit still succeeds — it already happened). The user or orchestrator can then decide whether to force-complete or fix the gap.

This means `tugcode commit` no longer silently papers over tracking gaps. If the orchestrator forgot to tick something, the commit still works but the state discrepancy is surfaced.

### 7. Display modes for `tugcode state show`

The current `tugcode state show` has two modes: default (human-readable summary) and `--json` (full DB dump). The global `--quiet` flag suppresses non-error output. There are also global `--verbose` and `--quiet` flags used across all commands — these are vague and tell the user nothing about what to expect.

**Remove `--verbose` and `--quiet` as global flags.** Replace the display behavior of `state show` with three explicit, named modes:

#### `--summary` (default)

What `state show` does today with no flags. Aggregate counts per step:

```
✓ step-0 - Schema Migration
  Tasks: 13/13  ████████████  100%
  Tests: 12/12  ████████████  100%
  Checkpoints: 2/2  ████████████  100%

→ step-1 - CLI Skeleton
  Tasks: 3/9  ███░░░░░░░░░  33%
  Tests: 0/8  ░░░░░░░░░░░░  0%
  Checkpoints: 1/4  ██░░░░░░░░░░  25%
```

Adding `--summary` as an explicit flag is for completeness — bare `tugcode state show` continues to behave this way.

#### `--checklist`

New mode. Displays every checklist item with its status, organized by step and kind. This is the "plan view" of the state database — the full detail that the plan document's checkboxes would show if they were checked during implementation.

```
✓ step-0 - Schema Migration

  Tasks:
    [x] Add dash table creation DDL (CREATE TABLE IF NOT EXISTS dashes ...)
    [x] Bump schema version from 1 to 2 in StateDb::open()
    [x] Create tugcode/crates/tugtool-core/src/dash.rs with types

  Tests:
    [x] Unit test: validate_dash_name accepts valid names and rejects invalid
    [x] Unit test: create_dash idempotent behavior
    [x] Integration test: full lifecycle end-to-end (create -> commit -> join)

  Checkpoints:
    [x] cd tugcode && cargo nextest run -- all tests pass, no warnings
    [x] New unit tests for dash state functions all pass

→ step-1 - CLI Skeleton

  Tasks:
    [x] Implement tugcode dash create subcommand
    [x] Implement tugcode dash list subcommand
    [ ] Implement tugcode dash show subcommand
    [ ] Wire up subcommand routing in main.rs

  Tests:
    [~] Manual: verify dash create output format    (deferred)
    [ ] Unit test: create validates name format
    [ ] Integration test: create + list round-trip

  Checkpoints:
    [x] cargo build succeeds with no warnings
    [ ] tugcode dash create --help shows expected usage
```

Status markers:
- `[x]` — completed
- `[ ]` — open
- `[~]` — deferred (with annotation)

This is the display mode for users who want to see exactly where implementation stands against the plan's specification. It answers "what's done, what's left, and what needs my attention?" without opening the plan file.

#### `--json`

Unchanged. Full machine-readable dump of everything in the DB. Should already include all item-level detail (kind, ordinal, text, status). If it doesn't currently include per-item text and status in the JSON output, add it — `--json` should expose everything the DB knows.

#### Removing `--verbose` and `--quiet`

The global `--verbose` and `--quiet` flags are removed from the CLI struct. They're used today as:

- `--quiet`: suppresses human-readable output across all commands (the `if !quiet { ... }` pattern). Commands that need silent operation for machine consumption should use `--json` instead. Agent-facing commands (claim, start, heartbeat, update, artifact, complete) should always produce JSON output when called by the orchestrator.
- `--verbose`: used on `tugcode status` (the non-state status command) and `tugcode version`. For `status`, the behavior moves to an explicit flag on that subcommand. For `version`, extended info becomes the default or gets its own `--build-info` flag.

This is a breaking change to the CLI surface. Plan the migration:
1. Add `--summary` and `--checklist` to `state show`.
2. Deprecate `--verbose` and `--quiet` (warn on use, still function).
3. Remove in a subsequent release.

### 8. Plan hash drift detection

When `tugcode state show` runs, compare the plan file's current SHA-256 hash against the `plan_hash` stored at `init_plan` time. If they differ, display a warning:

```
⚠ Plan file has been modified since state was initialized.
  State tracks execution of the original plan (hash: abc123...).
  Current file hash: def456...
```

This doesn't block anything — it's informational. But it makes the source-of-truth contract visible. If the plan was edited, the user knows the state DB may not reflect the current plan.

## Changes Required

### Tugcode (Rust)

| Change | File(s) | Scope |
|--------|---------|-------|
| Add `deferred` as recognized status in strict completion check | `state.rs` | Small — modify `complete_step` WHERE clause |
| Add batch update mode to `update_checklist` | `state.rs`, `commands/state.rs` | Medium — new function + CLI flag |
| Change `commit.rs` default from `force=true` to `force=false` | `commit.rs` | Small — one-line change + error handling |
| Add `--checklist` display mode to `state show` | `state.rs`, `commands/state.rs` | Medium — new query + display logic |
| Add `--summary` flag (alias for current default) | `commands/state.rs` | Small — flag only |
| Ensure `--json` includes per-item text and status | `state.rs` | Small — verify/extend serialization |
| Add plan hash drift detection to `state show` | `commands/state.rs` | Small — hash comparison + warning |
| Remove global `--verbose` and `--quiet` flags | `cli.rs`, all command functions | Medium — remove flag, update all callers |

### Tugplug (Agents/Skills)

| Change | File(s) | Scope |
|--------|---------|-------|
| Add `checklist_status` to coder-agent output contract | `coder-agent.md` | Medium — new output field, instructions to report per-item |
| Update implement skill to use batch update instead of `--all` | `implement/SKILL.md` | Medium — replace bulk update with batch construction |
| Update implement skill to use coder's checklist_status | `implement/SKILL.md` | Medium — parse and relay coder output |
| Update reviewer-agent to report per-checkpoint verdicts | `reviewer-agent.md` | Small — structured output addition |

### Migration

- **Backward compatible.** Old plans already completed with force-complete are unaffected — their `complete_reason` field still records what happened.
- **No schema migration needed.** The `deferred` status is just a string value in the existing `status` column. The batch update uses existing tables.
- **Rollout:** Deploy tugcode changes first (batch update, deferred status recognition, display modes). Then update agent prompts. The implement skill change ties them together. Deprecate `--verbose`/`--quiet` last.

## What This Doesn't Address

- **Automated test execution by the state system itself.** The state system tracks what agents report — it doesn't run tests. If the coder says a test passed, we record that. Verification is the reviewer's job.
- **Manual checkpoint workflows.** This proposal handles `deferred` items by surfacing them, not by building a manual review queue. A future enhancement could add `tugcode state review` for human sign-off on deferred items.
- **Dash workflow.** Dash uses different tables (`dashes`, `dash_rounds`) and doesn't have checklist items. This proposal only affects the plan/implement pipeline.
