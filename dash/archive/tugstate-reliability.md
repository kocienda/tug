# Tugstate Reliability Improvements

## Summary

Four interconnected issues in the tugstate management system cause incorrect progress reporting, unnecessary recovery loops, and confusing error messages during plan implementation. Investigation reveals a deeper design flaw: **substeps are a broken abstraction** that adds complexity to the parser, state machine, validator, and orchestrator while providing no benefit the orchestrator actually uses. Eliminating substeps in favor of flat steps with explicit dependencies resolves Issue 4 (the most serious) and simplifies the entire system.

---

## Issue 1: `state show` Rejects `--worktree` Flag

**Symptom:** When resuming an in-progress plan, the orchestrator runs `tugcode state show .tugtool/plan.md --json --worktree /path/...` and gets `error: unexpected argument '--worktree' found`.

**Root cause:** `state show` is a read-only query — it doesn't do ownership checking and doesn't accept `--worktree`. The implementer skill's SKILL.md doesn't instruct this usage, but agents improvise the flag out of pattern-matching with other state commands that all use `--worktree`.

**Impact:** Low. The agent retries with `cd /worktree && tugcode state show ...` and succeeds. But it wastes a tool call and produces a confusing error in the transcript.

**Fix:** Add `--worktree` as an optional ignored parameter to `state show`, or use it to set the CWD for plan path resolution. This makes the CLI surface consistent — every state command that takes a plan path also accepts `--worktree`. The alternative (training the skill to never use `--worktree` with `show`) is fragile since agents generalize from patterns.

**Files:**
- `tugcode/crates/tugcode/src/commands/state.rs` — `StateShow` variant
- `tugcode/crates/tugcode/src/cli.rs` — CLI definition

---

## Issue 2: Wrong Completion Count on Resume ("14 of 14, 0 already complete")

**Symptom:** When resuming a plan where 8 of 14 steps are already complete, the Setup message says "Steps to implement: 14 of 14 (0 already complete)". The orchestrator then calls `state claim` and discovers the real status.

**Root cause:** `worktree setup` always sets `ready_steps = None` with the comment "ready_steps is computed from tugstate claim operation (orchestrator responsibility)". The SKILL.md rule is: "If `ready_steps` is null → `steps_to_implement = all_steps`, `completed_count = 0`".

So `worktree setup` has the state DB right there (it just initialized/opened it) but deliberately doesn't query it. The orchestrator can't know the real count until it calls `state claim`.

**Impact:** Medium. The user sees a false progress report on every resume. The system self-corrects within one more CLI call, but the initial message is wrong and undermines trust.

**Fix:** After `init_plan`, query the state DB for step statuses. Populate `ready_steps` with the anchors of steps that are ready to claim (pending, dependencies satisfied). This is a ~15-line change in `worktree.rs`.

```
// After state init succeeds:
let ready_steps = db.ready_steps(plan_path)?;  // Vec<String> of ready anchors
```

The `ready_steps` function already exists in the state DB (`state ready` command). Wire it into `worktree setup` output.

**Files:**
- `tugcode/crates/tugcode/src/commands/worktree.rs` — SetupData construction (~line 583)
- `tugcode/crates/tugtool-core/src/state.rs` — may need a public `ready_steps()` method

---

## Issue 3: Mismatched Task Counts Between Coder and Reviewer

**Symptom:** The orchestrator outputs "Coder reported: 9/9 tasks completed" immediately followed by a reviewer verdict artifact saying "APPROVE. All 10 tasks PASS". The numbers don't match.

**Root cause:** Two independent counting systems:
1. **Coder's `checklist_status`**: Best-effort per-item array. The coder doesn't read the plan's authoritative task list — it works from the architect's strategy, which may summarize or group tasks differently. This is explicitly labeled "non-authoritative progress telemetry" in the SKILL.md.
2. **Reviewer's `plan_conformance`**: Reads the actual plan markdown and verifies each task semantically.

The SKILL.md correctly notes that `checklist_status` is "never used for state updates" — the actual state update uses `--complete-remaining` which handles counting server-side. But the progress message displays the coder's count, which is wrong.

**Impact:** Low-medium. The numbers are cosmetic (state updates are correct), but they erode trust and make debugging harder.

**Fix options:**

**Option A (Simple):** Change the progress message to report reviewer counts instead of coder counts. After APPROVE, the reviewer's `plan_conformance.tasks[]` count is authoritative. Display: "Reviewer verified: 10/10 tasks PASS".

**Option B (Better):** Drop the per-item count from the progress message entirely. The `--complete-remaining` flag makes exact counting irrelevant — the CLI handles it. Replace with: "Reviewer approved. Committing step."

**Option C (Best):** After `state update --batch --complete-remaining` succeeds, report the actual count returned by the CLI (`items_updated` field). This is ground truth. Display: "State updated: 15 items completed."

**Files:**
- `tugplug/skills/implement/SKILL.md` — progress message template (~line 571)

---

## Issue 4: Substeps Are a Broken Abstraction

**This is the most serious issue** and the root cause of the recovery loop problem. But the right fix is not a patch — it's removing the substep concept entirely.

### The Problem

After APPROVE, the orchestrator runs:
1. `echo '[]' | tugcode state update plan step-4 --batch --complete-remaining` → succeeds (marks step-4's items done)
2. Committer runs `tugcode commit` → calls `complete_step("step-4")` → **fails with StateIncompleteSubsteps**
3. Recovery loop manually starts, updates, and completes step-4-1, step-4-2, step-4-3 (6+ extra CLI calls per substep)

The failure happens because:
- `batch_update_checklist` uses `WHERE step_anchor = "step-4"` — only completes the parent's items
- `complete_step` then checks substeps and finds step-4-1, step-4-2, step-4-3 still "claimed" with open items
- Nobody manages the substep lifecycle between claiming (auto-inherited from parent) and completion

### Why Substeps Are a Design Flaw

Investigation reveals a fundamental contradiction:

1. **Substeps are structurally identical to steps.** Every substep in every real plan has the full complement: Commit, References, Artifacts, Tasks, Tests, Checkpoint. There are **zero lightweight substeps** in the codebase. The `Substep` struct in types.rs has the same fields as `Step`.

2. **The orchestrator already treats them as individual steps.** The implement skill calls `tugcode state claim` which returns one step at a time — `step-3-1`, then `step-3-2`, etc. Each goes through the full architect → coder → reviewer → committer pipeline individually. The orchestrator makes no distinction between `step-1` and `step-3-1`.

3. **But the state machine treats them as parent-child.** Claiming a parent auto-claims substeps. Completing a parent requires all substeps complete. Ownership is inherited. This hierarchy is what causes the completion failure — the orchestrator doesn't know it needs to individually complete substeps because it never individually started them.

4. **The hierarchy adds complexity everywhere:**
   - **Parser**: Dot-in-number detection, nested `substeps` vec, dual context tracking (`in_step` vs `in_substep`)
   - **Types**: Separate `Substep` struct that duplicates `Step`
   - **State machine**: `parent_anchor` column, 35+ queries referencing it, cascading claim/reset logic, substep completion validation
   - **Validator**: 8+ rules that iterate over substeps separately
   - **Tests**: Dedicated substep lifecycle test fixtures

5. **The grouping benefit is illusory.** Substeps group related work under a parent heading, but the orchestrator doesn't use this grouping for anything. Dependencies between related steps are better expressed explicitly (`Depends on: #step-3`) than implicitly (substep-of-step-3).

### Proposed Fix: Eliminate Substeps, Use Flat Steps

Replace the parent-child substep model with flat steps and explicit dependencies.

**Before (with substeps):**
```markdown
#### Step 3: Theme-Aware Background {#step-3}

##### Step 3.1: Add UserDefaults Key {#step-3-1}
[full step structure: Commit, References, Tasks, Tests, Checkpoint]

##### Step 3.2: Add Bridge Handler {#step-3-2}
**Depends on:** #step-3-1
[full step structure]

##### Step 3.3: Wire Frontend {#step-3-3}
**Depends on:** #step-3-2
[full step structure]

#### Step 3 Summary {#step-3-summary}
**Depends on:** #step-3
[aggregate checkpoint]
```

**After (flat steps):**
```markdown
#### Step 3: Add Theme UserDefaults Key {#step-3}
[full step structure]

#### Step 4: Add Theme Bridge Handler {#step-4}
**Depends on:** #step-3
[full step structure]

#### Step 5: Wire Theme Frontend {#step-5}
**Depends on:** #step-4
[full step structure]

#### Step 6: Theme Integration Checkpoint {#step-6}
**Depends on:** #step-3, #step-4, #step-5
[lightweight checkpoint-only step — verifies the group works together]
```

**What this fixes:**
- **Issue 4 directly**: No parent-child hierarchy means no `StateIncompleteSubsteps` error, no recovery loop
- **State machine simplification**: ~200 lines of parent-child logic removed
- **Parser simplification**: Single step type, no nesting
- **Orchestrator simplification**: Recovery loop for `open_items` can be removed or reduced to a single defensive retry

### Complete File Inventory

Every file that touches the substep concept, organized by phase.

#### Phase 1: Skeleton + Planner (prevent new substeps)

| File | What Changes |
|------|-------------|
| `.tugtool/tugplan-skeleton.md` | Remove `step-N-M` anchor convention (line 81). Remove implicit dependency rule (line 118). Replace "split into substeps" guidance (lines 306-307). Replace `##### Step 3.1 / 3.2` template and `Step 3 Summary` block (lines 361-421) with flat steps + integration checkpoint pattern. |
| `tugplug/agents/author-agent.md` | Add instruction: do not generate `##### Step N.M` substep blocks. Use flat `#### Step N` headings with explicit `Depends on:` lines. Add integration checkpoint step guidance. |

No other skill or agent files reference substeps. The conformance-agent reads the skeleton and will naturally stop expecting the `##### Step N.M` pattern once the skeleton changes.

#### Phase 2: State machine + CLI (remove parent-child hierarchy)

| File | What Changes |
|------|-------------|
| **`tugtool-core/src/state.rs`** | |
| — Schema (lines 129, 142, 177-178) | Drop `parent_anchor` column, self-referential FK, both partial indexes (`idx_steps_status`, `idx_steps_parent`). |
| — `init_plan` (lines 350-464) | Delete three inner `for substep in &step.substeps` loops (step INSERT, dep INSERT, checklist INSERT). Remove `substep_count` variable. Remove `parent_anchor` from INSERT column lists. |
| — `claim_step` (lines 515-664) | Remove 6× `parent_anchor IS NULL` SQL predicates. Delete substep cascade UPDATE block (lines 587-596). Delete reclaim checklist reset subquery (lines 598-610). |
| — `check_ownership` (line 700) | Replace `COALESCE((SELECT parent_anchor ...), ?4)` with plain `?4` — no more parent lookup for substeps. |
| — `complete_step` (lines 1070-1280) | Delete `is_substep` detection query (lines 1092-1113). Delete `StateIncompleteSubsteps` check (lines 1162-1178). Delete force-mode substep auto-complete (lines 1194-1207). Remove `parent_anchor IS NULL` from remaining-steps counts. |
| — `show_plan` (lines 1283-1393) | Remove `parent_anchor IS NULL` filter. Delete `query_substeps()` call (line 1360). Remove `parent_anchor` and `substeps` from `StepState` construction. |
| — `query_substeps` (lines 1478-1551) | Delete entire function. |
| — `ready_steps` (line 1611) | Remove `parent_anchor IS NULL` predicate. |
| — `reset_step` (lines 1684-1777) | Delete `is_substep` detection. Delete substep cascade block (lines 1746-1769). |
| — `release_step` (lines 1784-1909) | Delete `is_substep` detection. Delete substep cascade block (lines 1875-1898). |
| — `StepState` struct (lines 2175-2191) | Remove `parent_anchor: Option<String>` and `substeps: Vec<StepState>` fields. |
| — `InitResult` struct (lines 2098-2110) | Remove `substep_count: usize` field. |
| — Test schema copies (lines 2343, 2420, 2505) | Remove `parent_anchor TEXT` from 3 DDL literals. |
| — Unit tests | Delete `test_reclaim_preserves_completed_substeps`, `test_show_includes_substeps`, `test_reset_cascades_to_substeps`, `test_release_cascades_to_substeps`. Remove `Substep { }` literals from `make_test_plan()`. |
| **`tugtool-core/src/error.rs`** | Remove `StateIncompleteSubsteps` variant (lines 203-208), error code E052 (line 288), exit code 14 (line 368). |
| **`tugcode/src/output.rs`** | Delete `SubstepStatus` struct (lines 273-284). Remove `substeps: Vec<SubstepStatus>` from `StepStatus` (line 268-270). Remove `substep_count` from `StateInitData` (lines 640-641). Update `OpenItems` comment (line 371). |
| **`tugcode/src/commands/state.rs`** | Remove `substep_count` output (lines 296, 311). Delete two substep display loops in `print_step_state` (lines 1172-1174) and `print_step_checklist` (lines 1282-1284). Update `--force` help text (line 187). |
| **`tugcode/src/commands/status.rs`** | Remove `SubstepStatus` import (line 12). Delete substep collection logic (lines 338-354). Delete substep progress display loop (lines 471-483). |
| **`tugcode/src/commands/list.rs`** | Delete inner `for substep in &step.substeps` loop in `count_checkboxes()` (lines 130-134). |
| **`tugcode/src/commands/commit.rs`** | Remove `StateIncompleteSubsteps` match arm in `classify_state_error()` (line 17). Delete unit test `test_classify_state_error_open_items_incomplete_substeps` (lines 465-474). |
| **`tugcode/src/cli.rs`** | Remove "Substep progress if present" from status help text (line 88). |

#### Phase 3: Parser + Types (remove data model)

| File | What Changes |
|------|-------------|
| **`tugtool-core/src/parser.rs`** | Remove `Substep` import (line 12). Simplify `STEP_HEADER` regex to not match `\.\d+` (lines 27-32). Delete `in_substep` state variable (line 112). Delete `if number.contains('.')` branch (lines 347-362). Remove all 6 `if let Some(substep_idx) = in_substep` routing branches (lines 392-395, 407-411, 423-426, 441-445, 467-484, 507-511). Delete `test_parse_substeps` test (lines 799-849). |
| **`tugtool-core/src/types.rs`** | Delete `Substep` struct and its `impl` block (lines 215-313). Remove `substeps: Vec<Substep>` field from `Step` (lines 139-141). Delete inner substep loop in `TugPlan::completion_counts()` (lines 399-402). |
| **`tugtool-core/src/validator.rs`** | Delete 11 `for substep in &step.substeps` loops across rules E004, E010, E011, W006, E005/W007, W009, W010, W011, W012, W013. Delete `.chain(s.substeps.iter()...)` in anchor collection (lines 484-489). Delete `test_w013_substep_references` test (lines 2054-2093). |
| **`tugtool-core/src/lib.rs`** | Remove `Substep` from public re-export (line 58). |

#### Phase 4: Test fixtures + cleanup

| File | What Changes |
|------|-------------|
| **`tugcode/tests/fixtures/valid/with-substeps.md`** | Delete or replace with flat-step equivalent. |
| **`tugcode/tests/state_integration_tests.rs`** | Delete `PLAN_WITH_SUBSTEPS` constant (lines 233-312). Delete `test_substep_tracking`/`test_substep_lifecycle` function (lines 1348-1579). |
| **`tugtool-core/tests/integration_tests.rs`** | Delete or rewrite `test_valid_with_substeps_fixture` (lines 157-188). Remove `"with-substeps"` from `test_full_validation_workflow` fixture list (line 523). |
| **`.tugtool/config.toml`** | Remove `substeps = "none"` config key (lines 31-32). |
| **`tugplug/skills/implement/SKILL.md`** | Simplify recovery loop (lines 688-762): remove `open_items` retry loop, keep single defensive retry for `db_error`. |
| **`tugrelaunch/src/main.rs`** | Update cosmetic comment labels "Substep 5.1/5.2/5.3" (lines 396, 457, 478). |

#### Existing plans with substeps (~15 files)

These plans use the `##### Step N.M` pattern. They don't need to be rewritten for Phase 1 (backward-compatible), but Phase 2's DB migration must handle their state:

| Plan file | Substep blocks |
|-----------|---------------|
| `tugplan-react-shadcn-adoption.md` | Steps 2.1-2.3, 6.1-6.2, 7.1-7.4b, 8.1-8.3 |
| `tugplan-add-tugstate.md` | Steps 4.1-4.3, 5.1-5.3, 6.1-6.4 |
| `tugplan-dev-mode-completeness.md` | Steps 4.1-4.3, 5.1-5.3 |
| `tugplan-accurate-state-tracking.md` | Steps 2.1-2.2, 3.1-3.4 |
| `tugplan-conversation-frontend.md` | Steps 7.1-7.2, 14.1-14.3 |
| `tugplan-tugtalk-protocol.md` | Steps 2.1-2.3 |
| `tugplan-dev-notification-improvements.md` | Steps 4.1-4.2 |
| `tugplan-dev-mode-audit-fixes.md` | Steps 3.1-3.2 |
| `tugplan-dev-mode-port-hardening.md` | Steps 3.1-3.2 |
| `tugplan-dev-mode-notifications.md` | Steps 5.1-5.3 |
| `tugplan-tugtell-external-command.md` | Steps 2.1-2.2 |

**DB migration for Phase 2:** For each plan in `state.db` that has substep rows (`parent_anchor IS NOT NULL`):
1. Set `parent_anchor = NULL` on all substep rows (promoting them to top-level)
2. Renumber `step_index` to maintain declaration order
3. Remove any parent step rows that have no checklist items of their own (they were pure containers)

The parser must continue to accept `##### Step N.M` headings during Phase 2 (backward compat for existing plans). Phase 3 can remove the parsing support once all active plans are converted or archived.

### Integration Checkpoint Steps

The "Step N Summary" pattern transforms into a lightweight **integration checkpoint step**. This preserves the value of aggregate verification while eliminating the parent-child model:

```markdown
#### Step 6: Theme Integration Checkpoint {#step-6}
**Depends on:** #step-3, #step-4, #step-5
**Commit:** `N/A (verification only — no separate commit)`
**References:** [D01], (#theme-color-mapping)
**Tasks:**
- [ ] Verify all theme-related artifacts are committed
**Checkpoint:**
- [ ] Window background matches active theme for all three themes
```

The planner (author-agent) would be instructed: "When breaking a large piece of work into multiple steps, add an integration checkpoint step at the end that depends on all the constituent steps and verifies they work together."

### Migration Strategy

**Phase 1: Prevent new substeps (skeleton + planner)** — 2 files
- Update `tugplan-skeleton.md`: remove `##### Step N.M` pattern, add integration checkpoint pattern
- Update `author-agent.md`: instruct flat steps with explicit deps
- Backward-compatible — existing plans and state DB still work unchanged

**Phase 2: Simplify state machine + CLI** — 9 Rust files
- Add DB schema migration: promote substep rows to top-level (`parent_anchor = NULL`, renumber `step_index`)
- Remove `parent_anchor` column, FK, and indexes from schema
- Remove all parent-child logic from `state.rs` (claim cascade, complete validation, reset cascade, release cascade, ownership COALESCE, `query_substeps()`)
- Remove `StateIncompleteSubsteps` error variant from `error.rs`
- Remove `SubstepStatus` struct and `substep_count` from `output.rs`
- Update `status.rs`, `list.rs`, `state.rs` CLI commands to remove substep display loops
- Remove `StateIncompleteSubsteps` match arm from `commit.rs`
- Update CLI help text in `cli.rs`
- Parser must still accept `##### Step N.M` during this phase for backward compat

**Phase 3: Simplify parser and types** — 4 Rust files
- Remove `Substep` struct and re-export from `types.rs`, `lib.rs`
- Remove dot-in-number parsing and `in_substep` state from `parser.rs`
- Remove 11 substep iteration loops from `validator.rs`
- All `####` and `#####` step headings become regular steps

**Phase 4: Test fixtures and cleanup** — 5 files
- Delete or replace `with-substeps.md` test fixture
- Delete substep integration tests from `state_integration_tests.rs` and `integration_tests.rs`
- Remove `substeps = "none"` from `.tugtool/config.toml`
- Simplify implement skill recovery loop in `SKILL.md`
- Update cosmetic comment labels in `tugrelaunch/src/main.rs`

---

## Implementation Priority (Revised)

| Issue | Severity | Effort | Priority |
|-------|----------|--------|----------|
| 4. Eliminate substeps (Phase 1: skeleton + planner) | High | Small (2 files) | P0 |
| 2. Ready steps on resume | Medium | Small (~15 lines) | P1 |
| 4. Eliminate substeps (Phase 2: state machine + CLI) | High | Medium (9 files) | P2 |
| 4. Eliminate substeps (Phase 3: parser + types) | Medium | Medium (4 files) | P3 |
| 4. Eliminate substeps (Phase 4: tests + cleanup) | Low | Small (5 files) | P4 |
| 3. Task count mismatch | Low-medium | Small (SKILL.md edit) | P5 |
| 1. `--worktree` on show | Low | Small (~5 lines) | P6 |

Phase 1 prevents new plans from creating substeps, stopping the bleeding immediately with 2 file edits. Phases 2-4 progressively remove the complexity from the codebase.

Issue 2 (ready steps on resume) is independent and can be done in parallel with any phase. Note: the `ready_steps` query in `state.rs` (line 1611) currently filters `parent_anchor IS NULL` — this filter will be naturally removed as part of Phase 2.

### Recovery Loop Simplification

Once substeps are eliminated (Phase 2), the recovery loop in the implement skill (SKILL.md lines 688-762) can be simplified:
- Remove the `open_items` retry loop (the root cause — `StateIncompleteSubsteps` — no longer exists)
- Keep single-retry for genuine transient failures (db_error)
- Immediately escalate drift and ownership errors (no change)
- Reduce from 3 retry attempts to 1 defensive retry
