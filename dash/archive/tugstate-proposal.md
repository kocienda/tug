# Tugstate: Replacing Beads with Embedded SQLite

## Background

See [multi-agent-coordination.md](multi-agent-coordination.md) for the problem statement and [multi-agent-coordination-chat.md](multi-agent-coordination-chat.md) for the design discussion that led to this proposal.

**Summary:** Beads has failed as the coordination layer for Tug's multi-agent workflow. It can't track checklist items at the granularity users need ([R-08]), requires a painful temp-file dance for agent data passing, causes merge conflicts when worktree branches return to main, depends on an external `bd` binary that refuses to run in git worktrees, and has consumed a disproportionate amount of development effort (12+ commits just to get basic data flow working).

**Decision:** Replace beads with Tugstate — an embedded SQLite database in the repo root, managed entirely by `tugcode` via `rusqlite`. No external binary. No server process. No daemon. The database is never committed to git.

**Scope:** v1 explicitly targets **single-host, multi-worktree** coordination. Multi-machine coordination is a future concern to be addressed via tugcast WebSocket endpoints when needed.

## Core Design

### Where It Lives

```
repo/
├── .tugtool/
│   ├── state.db              ← NEW: Tugstate database (gitignored)
│   ├── state.db-wal          ← SQLite WAL file (gitignored)
│   ├── state.db-shm          ← SQLite shared memory (gitignored)
│   ├── tugplan-foo.md
│   ├── tugplan-skeleton.md
│   ├── config.toml
│   └── ...
├── .tugtree/
│   ├── tugplan__foo-20260223/ ← worktree A (can read state.db)
│   └── tugplan__foo-20260223-2/ ← worktree B (can also read state.db)
└── (source code)
```

The state.db lives in the **repo root** `.tugtool/` directory, accessible from all worktrees. Every worktree can reach it because `tugcode` already resolves the project root via `find_project_root()`.

### Why Repo Root Works for Worktrees

Git worktrees share the same `.git` directory as the main worktree. However, the `.tugtool/` directory at the repo root is **not** inside any worktree's working tree — it's in the original repo. This means:

1. `tugcode` running in any worktree can locate the repo root (it already does this via `find_project_root()` / `resolve_worktree()`)
2. SQLite in WAL mode handles concurrent readers + exclusive writer
3. No need to copy or sync state between worktrees

**Critical detail:** `find_project_root()` walks up from the current directory looking for `.tugtool/`. In a worktree, this finds the worktree's own `.tugtool/` directory (which has `config.toml`, the plan file, and the implementation log). To find the **repo root** `.tugtool/` (where `state.db` lives), we need to unify repo-root resolution into `tugtool-core` — see [Worktree-to-Repo-Root Resolution](#worktree-to-repo-root-resolution).

### .gitignore Additions

```gitignore
# Tugstate database (operational artifact, not source)
.tugtool/state.db
.tugtool/state.db-wal
.tugtool/state.db-shm
```

The database is never committed to git. When a plan's implementation is merged, the source code changes go into git; the state data stays in the DB as an operational record. This eliminates the entire class of merge conflicts that beads caused.

### Platform Support Boundaries

SQLite file locking depends on POSIX `fcntl` or Windows lock APIs on a local filesystem. This works reliably on local disks and standard mount points. Network filesystems (NFS, SMB, SSHFS) may not support SQLite locking correctly. This is a known SQLite limitation. If users mount repos remotely, they should use `tugcast` endpoints (future work) rather than direct file access.

## Schema

```sql
-- Tugstate schema v1

-- Track schema version for forward compatibility
CREATE TABLE schema_version (
    version INTEGER NOT NULL
);
INSERT INTO schema_version (version) VALUES (1);

-- One row per plan
CREATE TABLE plans (
    plan_path    TEXT PRIMARY KEY,          -- e.g. ".tugtool/tugplan-foo.md"
    plan_hash    TEXT NOT NULL,             -- SHA-256 of plan file at init time
    phase_title  TEXT,                      -- from plan metadata
    status       TEXT NOT NULL DEFAULT 'active',  -- active/done
    created_at   TEXT NOT NULL,             -- ISO 8601
    updated_at   TEXT NOT NULL              -- ISO 8601
);

-- One row per execution step or substep
CREATE TABLE steps (
    plan_path        TEXT NOT NULL REFERENCES plans(plan_path),
    anchor           TEXT NOT NULL,           -- "step-0", "step-2-1"
    parent_anchor    TEXT,                    -- NULL for top-level steps; parent anchor for substeps
    step_index       INTEGER NOT NULL,        -- parse order (0-indexed), for deterministic scheduling
    title            TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'pending',
        -- pending: not started
        -- claimed: atomically reserved by an orchestrator
        -- in_progress: work underway
        -- completed: done, committed
    claimed_by       TEXT,                    -- worktree_path of the claimer (NULL if unclaimed)
    claimed_at       TEXT,                    -- ISO 8601, when claim was acquired
    lease_expires_at TEXT,                    -- ISO 8601, claim expires if not heartbeated
    heartbeat_at     TEXT,                    -- ISO 8601, last heartbeat from claimer
    started_at       TEXT,                    -- ISO 8601
    completed_at     TEXT,                    -- ISO 8601
    commit_hash      TEXT,                    -- git commit hash when completed
    complete_reason  TEXT,                    -- NULL for normal completion; set when --force used
    PRIMARY KEY (plan_path, anchor),
    FOREIGN KEY (plan_path, parent_anchor) REFERENCES steps(plan_path, anchor)
);

-- Dependency edges between steps
CREATE TABLE step_deps (
    plan_path    TEXT NOT NULL,
    step_anchor  TEXT NOT NULL,
    depends_on   TEXT NOT NULL,
    PRIMARY KEY (plan_path, step_anchor, depends_on),
    FOREIGN KEY (plan_path, step_anchor) REFERENCES steps(plan_path, anchor),
    FOREIGN KEY (plan_path, depends_on) REFERENCES steps(plan_path, anchor)
);

-- Individual checklist items (tasks, tests, checkpoints)
CREATE TABLE checklist_items (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_path    TEXT NOT NULL,
    step_anchor  TEXT NOT NULL,
    kind         TEXT NOT NULL,            -- 'task' / 'test' / 'checkpoint'
    ordinal      INTEGER NOT NULL,         -- position within its kind group (0-indexed)
    text         TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'open',
        -- open: not started
        -- in_progress: work underway
        -- completed: done
    updated_at   TEXT,                     -- ISO 8601, NULL until first update
    FOREIGN KEY (plan_path, step_anchor) REFERENCES steps(plan_path, anchor)
);

-- Minimal per-step artifact audit trail
CREATE TABLE step_artifacts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_path    TEXT NOT NULL,
    step_anchor  TEXT NOT NULL,
    kind         TEXT NOT NULL,            -- 'architect_strategy' / 'reviewer_verdict' / 'auditor_summary'
    summary      TEXT NOT NULL,            -- brief description (first ~200 chars of approach, verdict, etc.)
    recorded_at  TEXT NOT NULL,            -- ISO 8601
    FOREIGN KEY (plan_path, step_anchor) REFERENCES steps(plan_path, anchor)
);

-- Index for fast ready-step queries (top-level steps only)
CREATE INDEX idx_steps_status ON steps(plan_path, status) WHERE parent_anchor IS NULL;

-- Index for substep queries by parent
CREATE INDEX idx_steps_parent ON steps(plan_path, parent_anchor) WHERE parent_anchor IS NOT NULL;

-- Index for lease expiry queries
CREATE INDEX idx_steps_lease ON steps(plan_path, status, lease_expires_at);

-- Index for fast checklist queries by step
CREATE INDEX idx_checklist_step ON checklist_items(plan_path, step_anchor);

-- Index for artifact queries by step
CREATE INDEX idx_artifacts_step ON step_artifacts(plan_path, step_anchor);
```

### Schema Notes

- **`parent_anchor` column.** Enables substep tracking in the same table as steps. Top-level steps have `parent_anchor = NULL`. Substeps (e.g., "step-2-1", "step-2-2") have `parent_anchor = "step-2"`. This mirrors the plan parser's `Step.substeps: Vec<Substep>` structure. Substeps have their own checklist items, dependencies, and status — full parallel tracking to steps. The **claim unit** is the top-level step (the `claim` query filters on `parent_anchor IS NULL`), but substep progress is tracked individually for [R-08] display granularity. When a top-level step is claimed, its substeps inherit the claim. When a substep's checklist items are all completed, its status updates to `completed`. A top-level step's `state complete` requires all its substeps to be completed (or `--force`).
- **`step_index` column.** Determines scheduling order. `ORDER BY step_index` avoids lexical sort surprises (`step-10` before `step-2`). Assigned in **interleaved declaration order**: each top-level step is followed immediately by its substeps before the next top-level step. This matches how a human reads the plan top-to-bottom. Example: step-0 (index 0), step-1 (index 1), step-1-1 (index 2), step-1-2 (index 3), step-2 (index 4).
- **`plan_hash` column.** SHA-256 of the plan file contents at `state init` time. Mutating state commands compare the current file hash against this value and fail fast if the plan has drifted. Enforces the plan-immutable-during-IMPLEMENT policy at the DB level.
- **Lease columns.** `claimed_at`, `lease_expires_at`, `heartbeat_at` support claim expiry and reclaim semantics. See [Lease-Based Claims](#lease-based-claims).
- **`complete_reason` column.** NULL for normal completion (all checklist items verified complete). Non-NULL when `--force` was used, recording the override reason for audit trail.
- **`step_artifacts` table.** Stores minimal per-step audit data — not full agent outputs, but enough to reconstruct what happened if the orchestrator dies. The persistent agent pattern handles data flow in-memory; this table provides crash-recovery breadcrumbs and [R-08] auditability.
- **`ordinal` column.** Preserves the order of checklist items as they appear in the plan file. This matters for display (`tugcode state show`) and for targeted updates ("mark task 2 as completed").

## Lease-Based Claims

### The Problem

If an orchestrator claims a step then crashes (process kill, machine sleep, terminal closed), the step stays `claimed` forever. No other orchestrator can pick it up. Manual `reset` works but requires human intervention.

### The Solution

Claims have a **lease** that expires after a configurable duration (default: 2 hours). Claimers must **heartbeat** to keep their lease alive. Expired claims can be reclaimed automatically.

**Claim flow:**
1. `tugcode state claim` sets `claimed_at = now`, `lease_expires_at = now + 2h`
2. The orchestrator periodically calls `tugcode state heartbeat <plan> <step>` which updates `heartbeat_at = now`, `lease_expires_at = now + 2h`
3. If no heartbeat arrives before `lease_expires_at`, the claim is considered expired

**Reclaim semantics:**
The `claim` query also considers expired claims as reclaimable:
```sql
BEGIN EXCLUSIVE;

-- Only top-level steps are claimable (substeps inherit their parent's claim)
SELECT s.anchor, s.step_index FROM steps s
WHERE s.plan_path = ?
  AND s.parent_anchor IS NULL
  AND (
    s.status = 'pending'
    OR (s.status = 'claimed' AND s.lease_expires_at < ?)  -- expired lease
  )
  AND NOT EXISTS (
    SELECT 1 FROM step_deps d
    JOIN steps dep ON dep.plan_path = d.plan_path AND dep.anchor = d.depends_on
    WHERE d.plan_path = s.plan_path
      AND d.step_anchor = s.anchor
      AND dep.status != 'completed'
  )
ORDER BY s.step_index
LIMIT 1;

-- If a step was found, claim it:
UPDATE steps SET
  status = 'claimed',
  claimed_by = ?,
  claimed_at = ?,
  lease_expires_at = ?,
  heartbeat_at = NULL,
  started_at = NULL
WHERE plan_path = ? AND anchor = ?;

-- Also claim/reclaim all non-completed substeps of this step
UPDATE steps SET
  status = 'claimed',
  claimed_by = ?,
  claimed_at = ?,
  lease_expires_at = ?,
  heartbeat_at = NULL,
  started_at = NULL
WHERE plan_path = ? AND parent_anchor = ? AND status != 'completed';

-- Reset checklist items for non-completed substeps (fresh start)
UPDATE checklist_items SET status = 'open', updated_at = ?
WHERE plan_path = ? AND step_anchor IN (
  SELECT anchor FROM steps
  WHERE plan_path = ? AND parent_anchor = ? AND status = 'claimed'
) AND status != 'completed';

COMMIT;
```

When reclaiming an expired step, `claimed_by` is overwritten with the new claimer for the parent and **all non-completed substeps**. Substeps that were `claimed` or `in_progress` by the old claimer are forcibly reclaimed. Their non-completed checklist items are reset to `open`. Substeps that were already `completed` are left alone — that work is committed and safe.

**Heartbeat command:**
```
tugcode state heartbeat <plan_path> <step_anchor> [--lease-duration <seconds>]
```
Default lease duration: 7200 seconds (2 hours). The orchestrator should heartbeat at least once per hour (half the lease duration) to avoid races.

**Manual reset still works.** `tugcode state reset` immediately resets a step to `pending` regardless of lease state. This is the escape hatch when an orchestrator needs to be forcibly removed.

## Ownership Model

All mutating commands that operate on a claimed step enforce **ownership**: the caller must pass `--worktree <path>` and it must match the step's `claimed_by` value. This prevents one orchestrator from mutating another's work in multi-worktree scenarios.

| Command | Ownership required? | Notes |
|---------|-------------------|-------|
| `init` | No | Creates plan state, no step claims involved |
| `claim` | No | Creates ownership (sets `claimed_by`) |
| `start` | **Yes** | Only the claimer can transition to `in_progress` |
| `heartbeat` | **Yes** | Only the claimer can renew the lease |
| `update` | **Yes** | Only the claimer can update checklist items |
| `artifact` | **Yes** | Only the claimer can record artifacts |
| `complete` | **Yes** | Only the claimer can mark a step done |
| `show` | No | Read-only |
| `ready` | No | Read-only |
| `reset` | No | Admin operation — intentionally unguarded so any operator can unstick a step |
| `reconcile` | No | Admin recovery tool |

For substeps, ownership is checked against the **parent step's** `claimed_by`. Substeps inherit their parent's claim.

### Ownership Resolution

All ownership-requiring commands use the same resolution algorithm. This is implemented once in `state.rs` and called by `start`, `heartbeat`, `update`, `artifact`, and `complete`:

```sql
-- Resolve the owner row: parent if substep, self if top-level
SELECT claimed_by FROM steps
WHERE plan_path = ?
  AND anchor = COALESCE(
    (SELECT parent_anchor FROM steps WHERE plan_path = ? AND anchor = ?),
    ?  -- anchor itself, for top-level steps where parent_anchor IS NULL
  )
  AND status IN ('claimed', 'in_progress');
```

If `claimed_by` is NULL or does not match the caller's `--worktree`, the command fails immediately. This single query handles both top-level steps (self-lookup) and substeps (parent-lookup) uniformly.

## Plan Hash Enforcement Policy

Mutating commands that depend on the plan's structure being stable check the plan file hash against `plans.plan_hash`. Commands that only update runtime state (timestamps, ownership) skip the check.

| Command | Hash check? | Rationale |
|---------|------------|-----------|
| `init` | No | Computes and stores the hash |
| `claim` | **Yes** | Step identity depends on plan structure |
| `start` | No | Only changes runtime status |
| `heartbeat` | No | Only changes lease timestamp |
| `update` | **Yes** | Checklist ordinals depend on plan structure |
| `artifact` | No | Appends audit data, structure-independent |
| `complete` | **Yes** | Checklist verification depends on plan structure |
| `reset` | No | Admin operation, structure-independent |
| `reconcile` | No | Recovery tool, works from git log |

## CLI Commands

All commands live under `tugcode state`. They all operate on the repo-root `state.db`.

### `tugcode state init <plan_path>`

Parse the plan file, populate the database with steps, dependencies, and checklist items.

- **Idempotent**: If the plan already exists in the DB, skip (no error). This allows `tugcode worktree create` to call it safely on re-entry.
- Reads the plan using the existing `TugPlan` parser.
- Computes SHA-256 of the plan file and stores it as `plan_hash`.
- Creates one `plans` row, one `steps` row per step and per substep (substeps have `parent_anchor` set to their parent step's anchor), one `step_deps` row per dependency edge (for both steps and substeps), one `checklist_items` row per task/test/checkpoint (for both steps and substeps).
- `step_index` is assigned in interleaved declaration order (see Schema Notes). E.g., step-0 (index 0), step-1 (index 1), step-1-1 (index 2), step-1-2 (index 3), step-2 (index 4).
- All writes happen in a single transaction.

**JSON output:**
```json
{
  "plan_path": ".tugtool/tugplan-foo.md",
  "plan_hash": "a1b2c3d4...",
  "steps_created": 5,
  "checklist_items_created": 23,
  "already_initialized": false
}
```

### `tugcode state claim <plan_path>`

Atomically find the next ready step and claim it. This is the heart of [I-08].

The query finds steps that are either `pending` or have an expired lease (see [Lease-Based Claims](#lease-based-claims)), respects the dependency graph, and orders by `step_index` (plan parse order). Any ready step is claimable — the dependency graph determines readiness, not hardcoded ordering.

**Plan hash check** (see [Plan Hash Enforcement Policy](#plan-hash-enforcement-policy)): Before claiming, the command reads the current plan file, computes its hash, and compares to `plans.plan_hash`. If they differ, the command fails with an error directing the user to re-initialize or investigate.

**Arguments:**
- `<plan_path>`: The plan to claim from
- `--worktree <path>`: Worktree path recorded as `claimed_by`
- `--lease-duration <seconds>`: Override default lease (default: 7200)

**JSON output (step found):**
```json
{
  "claimed": true,
  "step_anchor": "step-0",
  "step_title": "Create API client",
  "step_index": 0,
  "remaining_ready": 2,
  "total_remaining": 4,
  "lease_expires_at": "2026-02-23T12:00:00Z",
  "reclaimed_from_expired": false
}
```

**JSON output (no steps ready):**
```json
{
  "claimed": false,
  "reason": "no_ready_steps",
  "all_completed": false,
  "blocked_steps": ["step-2", "step-3"]
}
```

**JSON output (all done):**
```json
{
  "claimed": false,
  "reason": "all_completed"
}
```

### `tugcode state start <plan_path> <step_anchor>`

Transition a claimed step to `in_progress`. This is a separate operation from `claim` because the orchestrator may want to do setup work between claiming and starting.

**Arguments:**
- `--worktree <path>`: Must match `claimed_by` (ownership check)

```sql
UPDATE steps SET status = 'in_progress', started_at = ?
WHERE plan_path = ? AND anchor = ? AND status = 'claimed'
  AND claimed_by = ?;
```

Returns error if the step is not in `claimed` status or if `claimed_by` doesn't match the caller.

### `tugcode state heartbeat <plan_path> <step_anchor>`

Renew the lease on a claimed or in-progress step.

```sql
UPDATE steps SET heartbeat_at = ?, lease_expires_at = ?
WHERE plan_path = ? AND anchor = ? AND status IN ('claimed', 'in_progress')
  AND claimed_by = ?;
```

Returns error if the step is not claimed by the caller.

**Arguments:**
- `--worktree <path>`: Must match `claimed_by` (prevents heartbeating someone else's claim)
- `--lease-duration <seconds>`: Override default lease (default: 7200)

**JSON output:**
```json
{
  "renewed": true,
  "step_anchor": "step-0",
  "lease_expires_at": "2026-02-23T14:00:00Z"
}
```

### `tugcode state update <plan_path> <step_anchor> [OPTIONS]`

Update checklist item statuses for a step or substep. This delivers [I-09] and [R-08]. The `<step_anchor>` can be a top-level step (e.g., `step-1`) or a substep (e.g., `step-1-2`).

**Ownership check:** The step (or its parent, for substeps) must be claimed by the caller. Verifies `claimed_by` matches `--worktree`.

**Plan hash check** (see [Plan Hash Enforcement Policy](#plan-hash-enforcement-policy)): Fails if plan file has drifted from `plans.plan_hash`.

**Options:**
- `--worktree <path>`: Must match `claimed_by` on the step or its parent (ownership check)
- `--task <ordinal> <status>`: Update a specific task (e.g., `--task 0 completed`)
- `--test <ordinal> <status>`: Update a specific test
- `--checkpoint <ordinal> <status>`: Update a specific checkpoint
- `--all-tasks <status>`: Set all tasks to a status
- `--all-tests <status>`: Set all tests to a status
- `--all-checkpoints <status>`: Set all checkpoints to a status
- `--all <status>`: Set all checklist items to a status

**JSON output:**
```json
{
  "updated": 3,
  "step_anchor": "step-0",
  "tasks": { "open": 0, "in_progress": 0, "completed": 3 },
  "tests": { "open": 1, "in_progress": 0, "completed": 0 },
  "checkpoints": { "open": 2, "in_progress": 0, "completed": 0 }
}
```

### `tugcode state artifact <plan_path> <step_anchor> --kind <kind> --summary <text>`

Record a minimal artifact breadcrumb for crash recovery and auditability.

**Ownership check:** The step (or its parent, for substeps) must be claimed by the caller.

**Kinds:** `architect_strategy`, `reviewer_verdict`, `auditor_summary`

**Arguments:**
- `--worktree <path>`: Must match `claimed_by` on the step or its parent (ownership check)

The orchestrator calls this after each relevant agent completes. The summary is a brief description (truncated to 500 chars) — not the full agent output, just enough to know what happened.

**JSON output:**
```json
{
  "recorded": true,
  "step_anchor": "step-0",
  "kind": "architect_strategy",
  "artifact_id": 1
}
```

### `tugcode state complete <plan_path> <step_anchor>`

Mark a step as completed with a commit hash.

**Strict by default:** Before marking the step complete, the command checks that:
1. All checklist items for the step are in `completed` status.
2. All substeps of this step (if any) are in `completed` status.

If any items or substeps are incomplete, the command **fails** with an error listing what's missing.

**Force-complete with reason:** The `--force <reason>` flag bypasses both checks. The reason is recorded in `steps.complete_reason` for audit trail. This allows agents flexibility during implementation while maintaining trust in [R-08] — force-completions are visible in `tugcode state show`.

**Substep completion:** Substeps can be individually completed via `tugcode state complete <plan> <substep-anchor>`. A substep's completion only requires its own checklist items to be done (strict) or `--force`. Completing all substeps does not auto-complete the parent — the parent step has its own checklist items that must also be satisfied.

**Ownership check:** The step (or its parent, for substeps) must be claimed by the caller.

**Options:**
- `--worktree <path>`: Must match `claimed_by` on the step or its parent (ownership check)
- `--commit <hash>`: Record the commit hash
- `--force <reason>`: Override incomplete checklist check (reason recorded for audit)

```sql
BEGIN EXCLUSIVE;

-- Resolve ownership (see Ownership Resolution below)
-- For substeps, check parent's claimed_by; for top-level steps, check self.
-- FAIL if claimed_by != caller.

-- Strict mode (default): verify all checklist items complete for this step
SELECT COUNT(*) FROM checklist_items
WHERE plan_path = ? AND step_anchor = ? AND status != 'completed';
-- If count > 0 and --force not provided: ROLLBACK + FAIL with list of incomplete items

-- For top-level steps: also verify all substeps are completed
SELECT COUNT(*) FROM steps
WHERE plan_path = ? AND parent_anchor = ? AND status != 'completed';
-- If count > 0 and --force not provided: ROLLBACK + FAIL with list of incomplete substeps

-- Complete the step (claimed_by in predicate closes the race window)
UPDATE steps SET status = 'completed', completed_at = ?, commit_hash = ?,
  complete_reason = ?  -- NULL for strict, reason text for --force
WHERE plan_path = ? AND anchor = ? AND status IN ('claimed', 'in_progress')
  AND claimed_by = ?;
-- If rows_affected == 0: ROLLBACK + FAIL (ownership lost or status changed)

-- Only with --force: auto-complete remaining checklist items and substeps
UPDATE checklist_items SET status = 'completed', updated_at = ?
WHERE plan_path = ? AND step_anchor = ? AND status != 'completed';
UPDATE steps SET status = 'completed', completed_at = ?, complete_reason = ?
WHERE plan_path = ? AND parent_anchor = ? AND status != 'completed';

COMMIT;
```

**JSON output:**
```json
{
  "completed": true,
  "step_anchor": "step-0",
  "commit_hash": "abc123d",
  "forced": false,
  "force_reason": null,
  "incomplete_items_auto_completed": 0,
  "plan_completed": false,
  "remaining_steps": 3
}
```

When the last step is completed, set `plans.status = 'done'` and return `"plan_completed": true`.

### `tugcode state show [plan_path] [--json]`

Display progress for a plan (or all plans). This is the primary user-facing progress view that replaces `tugcode beads status` and delivers [R-08].

**Text output (default):**
```
Plan: .tugtool/tugplan-foo.md [active]

Step 0: Create API client [completed]
  Tasks:       2/2  ████████████ 100%
  Tests:       1/1  ████████████ 100%
  Checkpoints: 2/2  ████████████ 100%
  Commit: abc123d

Step 1: Add caching layer [in_progress] (claimed by worktree-A)
  Tasks:       1/3  ████░░░░░░░░  33%
    [x] Implement cache store
    [ ] Add cache invalidation    ← in_progress
    [ ] Wire up to API client
  Tests:       0/1  ░░░░░░░░░░░░   0%
  Checkpoints: 0/1  ░░░░░░░░░░░░   0%
  Lease: expires in 1h 45m

  Step 1.1: Cache store implementation [completed]
    Tasks:       2/2  ████████████ 100%
    Tests:       1/1  ████████████ 100%

  Step 1.2: Cache invalidation [in_progress]
    Tasks:       0/2  ░░░░░░░░░░░░   0%
    Tests:       0/1  ░░░░░░░░░░░░   0%

Step 2: Add monitoring [pending] (blocked by: step-1)
  Tasks:       0/2  ░░░░░░░░░░░░   0%
  Tests:       0/1  ░░░░░░░░░░░░   0%
  Checkpoints: 0/1  ░░░░░░░░░░░░   0%

Overall: 1/3 steps complete (33%)
```

Substeps are displayed indented under their parent step. Their checklist items roll up into the parent's totals for the summary line, but are also shown individually for granular tracking.

Steps completed with `--force` are annotated:
```
Step 3: Cleanup [completed] (forced: "reviewer approved with minor caveats")
```

**JSON output** mirrors the text output as structured data. This is what the orchestrator and future tugdeck UI consume.

### `tugcode state ready <plan_path>`

List all steps that are ready for claiming (pending with all deps completed, or expired lease). This is a read-only query, unlike `claim` which is atomic read-then-write.

**JSON output:**
```json
{
  "ready_steps": ["step-1", "step-3"],
  "all_steps": ["step-0", "step-1", "step-2", "step-3"],
  "completed_steps": ["step-0"],
  "blocked_steps": ["step-2"],
  "expired_claims": ["step-4"]
}
```

### `tugcode state reset <plan_path> <step_anchor>`

Reset a step back to `pending` (e.g., if a worktree is removed mid-implementation, or to manually reclaim an expired step). This is the manual escape hatch.

```sql
BEGIN EXCLUSIVE;
-- Reset the step itself
UPDATE steps SET status = 'pending', claimed_by = NULL, claimed_at = NULL,
  lease_expires_at = NULL, heartbeat_at = NULL, started_at = NULL
WHERE plan_path = ? AND anchor = ? AND status IN ('claimed', 'in_progress');

-- Reset the step's non-completed checklist items
UPDATE checklist_items SET status = 'open', updated_at = ?
WHERE plan_path = ? AND step_anchor = ? AND status != 'completed';

-- For top-level steps: also reset all non-completed substeps
UPDATE steps SET status = 'pending', claimed_by = NULL, claimed_at = NULL,
  lease_expires_at = NULL, heartbeat_at = NULL, started_at = NULL
WHERE plan_path = ? AND parent_anchor = ? AND status IN ('claimed', 'in_progress');

-- Reset non-completed checklist items for those substeps too
UPDATE checklist_items SET status = 'open', updated_at = ?
WHERE plan_path = ? AND step_anchor IN (
  SELECT anchor FROM steps
  WHERE plan_path = ? AND parent_anchor = ? AND status = 'pending'
) AND status != 'completed';
COMMIT;
```

Does not reset `completed` steps, substeps, or checklist items (that would require resetting the git commit too). No ownership check — `reset` is an admin operation that any operator can use to unstick a stranded step.

## Worktree-to-Repo-Root Resolution

### The Problem

When `tugcode state claim` runs inside a worktree at `.tugtree/tugplan__foo-20260223/`, it needs to find `state.db` in the **repo root's** `.tugtool/` directory. But `find_project_root()` finds the *worktree's* `.tugtool/` directory first.

### The Solution

Move the existing `resolve_main_repo_root()` from `tugcode/src/commands/worktree.rs` (line 140) into `tugtool-core` as `find_repo_root()`. This avoids duplicating the strategy — the worktree command already solves this exact problem with the same `git rev-parse --path-format=absolute --git-common-dir` approach.

```rust
/// Find the repo root (original working tree, not a linked worktree).
///
/// If CWD is in the main repo (.git is a directory), returns CWD.
/// If CWD is in a linked worktree (.git is a file), resolves to the
/// main repository root via git's common directory.
///
/// This is the canonical way to find state.db — call this, not
/// find_project_root(), when you need the repo-root .tugtool/.
pub fn find_repo_root() -> Result<PathBuf, TugError> {
    let cwd = std::env::current_dir()
        .map_err(|e| TugError::Config(format!("failed to get current directory: {}", e)))?;
    find_repo_root_from(&cwd)
}

pub fn find_repo_root_from(start: &Path) -> Result<PathBuf, TugError> {
    let git_path = start.join(".git");

    // If .git is a directory, we're in the main repo
    if git_path.is_dir() {
        return Ok(start.to_path_buf());
    }

    // If .git is a file, we're in a linked worktree — resolve to main repo
    if git_path.is_file() {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(start)
            .args(["rev-parse", "--path-format=absolute", "--git-common-dir"])
            .output()
            .map_err(|e| TugError::Config(format!("git not found: {}", e)))?;

        if output.status.success() {
            let common_dir = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let repo_root = PathBuf::from(&common_dir)
                .parent()
                .ok_or_else(|| TugError::Config("cannot derive repo root".into()))?
                .to_path_buf();
            return Ok(repo_root);
        }
    }

    Err(TugError::NotAGitRepository)
}
```

The existing `resolve_main_repo_root()` in `worktree.rs` is then replaced with a call to `find_repo_root()`. One implementation, one place.

All `tugcode state` commands use `find_repo_root()` to locate `state.db`. This works identically whether called from the main worktree or any linked worktree.

**Note:** `resolve_worktree()` already exists in `tugtool-core` (added in `b35c91d`). The new `find_repo_root()` complements it — `resolve_worktree()` maps a plan to its worktree; `find_repo_root()` maps any working directory back to the repo root.

## Cross-System Atomicity: Git Commit vs DB Update

### The Problem

`tugcode commit` performs a git commit and then a state update. These are two separate operations that cannot be made atomically. If the process dies between them, you have a committed step that the DB doesn't know about.

### The Design

This is the same pattern already in use with beads: `commit.rs` today does `git commit → bead close` and tolerates bead close failure (exit 0, `bead_close_failed: true`). The same approach applies to Tugstate:

1. `git commit` is the **source of truth** for "did the code actually land?"
2. `state complete` is the **coordination record** for "does the orchestrator know?"
3. If `state complete` fails after a successful git commit, the command exits 0 with `state_update_failed: true`

**Commit trailer for deterministic recovery:** `tugcode commit` appends a mandatory git trailer to every step commit:

```
feat(api): add client module

Tug-Step: step-0
Tug-Plan: .tugtool/tugplan-foo.md
```

This is a structured `git interpret-trailers`-compatible format. The `Tug-Step` and `Tug-Plan` trailers are appended by `tugcode commit` — the committer agent provides the human-readable message, and `tugcode commit` adds the machine-readable trailers before calling `git commit`.

**Recovery:** `tugcode state reconcile <plan_path>` scans the git log in the worktree, extracts `Tug-Step` and `Tug-Plan` trailers from commits, and marks the corresponding steps as `completed` in the DB with the commit hash. This is deterministic — no heuristic message parsing. It is a recovery tool, not a hot path.

**Conflict precedence:** If the DB already shows a step as `completed` with commit hash X, and reconcile finds a trailer pointing to a different commit hash Y for the same step, reconcile **warns** and skips that step (DB wins). The rationale: the DB was updated by the normal `tugcode commit` path, so it reflects the intended state. A hash mismatch likely means the step was re-implemented after a reset, and the git log contains both the old and new commits. The `--force` flag overrides this: `tugcode state reconcile <plan_path> --force` overwrites DB hashes with trailer-derived hashes, for cases where the DB is known to be stale or corrupt.

## Integration Points

### `tugcode worktree create`

Currently: creates worktree, runs `beads init` + `beads sync`, commits annotations, returns `bead_mapping` and `root_bead_id`.

**Phase 1 (alongside beads):** After the existing beads sync, also call `tugcode state init <plan_path>`. The CreateData output gains new fields:

```rust
pub struct CreateData {
    // ... existing fields ...
    pub bead_mapping: Option<HashMap<String, String>>,  // kept for now
    pub root_bead_id: Option<String>,                    // kept for now
    pub all_steps: Option<Vec<String>>,
    pub ready_steps: Option<Vec<String>>,
    // NEW:
    pub state_initialized: bool,
}
```

**Phase 2 (beads removed):** The beads fields (`bead_mapping`, `root_bead_id`) are removed. `all_steps` and `ready_steps` are computed from `state.db` instead of `bd ready`.

### `tugcode commit`

Currently: `log_rotate → log_prepend → git add -A → git commit → bead close`.

**Phase 1:** After `bead close`, also call the equivalent of `tugcode state complete <plan> <step> --commit <hash>`. If the state update fails, set `state_update_failed: true` in output (mirrors existing `bead_close_failed` pattern). Exit 0 — the git commit succeeded.

**Phase 2:** Remove `bead close`. The sequence becomes: `log_rotate → log_prepend → git add -A → git commit → state complete`. Same partial-failure tolerance.

### Implement Skill (SKILL.md)

Currently: the orchestrator runs `tugcode beads append-design`, `tugcode beads update-notes`, `tugcode beads append-notes` after each agent call (the "Bead Write Protocol"), then deletes temp files. SKILL.md itself acknowledges this is redundant.

**Phase 1:** After each agent call, the orchestrator also runs:
- `tugcode state update` to mark checklist items
- `tugcode state artifact` to record audit breadcrumbs (architect strategy summary, reviewer verdict)
- `tugcode state heartbeat` to renew the lease

Both beads writes and state updates happen. **Beads is the source of truth** until Phase 2. If a state write fails during Phase 1, warn and continue — beads still has the data.

**Phase 2:** Remove the Bead Write Protocol entirely. The orchestrator just runs `tugcode state update`, `tugcode state artifact`, and `tugcode state heartbeat` after each agent call. No temp files. No `tugcode beads` commands. **Tugstate is the sole source of truth.**

### Agent Files

Currently: agents receive `bead_id` in their input contracts and some write temp files for the orchestrator.

**Phase 1:** Agents continue receiving `bead_id` (ignored in phase 2). No agent changes needed in phase 1.

**Phase 2:** Remove `bead_id` from agent input contracts. Agents don't need step identity — the orchestrator manages that.

### `tugcode status`

Currently: shows plan progress from checkboxes, with optional `--full` that enriches with bead data.

**Phase 1:** Add a new flag `--state` (or just enhance the default) that reads from `state.db`. When state data exists, prefer it. Fall back to checkbox-based progress when no state data.

**Phase 2:** Always use state data. The `--full` bead enrichment and `bead_mapping` are removed.

## Potential Problems and Mitigations

### 1. SQLite File Locking in Worktrees

**Risk:** Multiple worktrees running `tugcode state` commands concurrently could hit lock contention.

**Mitigation:** SQLite WAL mode supports concurrent readers. Only `claim` and `complete` need exclusive locks, and they're sub-millisecond operations. The BUSY_TIMEOUT pragma (e.g., 5 seconds) handles brief contention:
```rust
conn.pragma_update(None, "journal_mode", "wal")?;
conn.pragma_update(None, "busy_timeout", 5000)?;
```

### 2. State.db Corruption

**Risk:** Power loss or process kill mid-write could corrupt the database.

**Mitigation:** SQLite WAL mode is crash-safe by design. On next open, SQLite replays the WAL to recover. Additionally, `state.db` is reconstructable — `tugcode state init` can re-derive step/checklist structure from the plan file. Only runtime state (claimed_by, status, timestamps) would be lost, and that's recoverable by inspection or `tugcode state reconcile`.

### 3. Plan File Changes After Init

**Risk:** User edits the plan file (adds tasks, renames steps) after `tugcode state init` has been called.

**Mitigation:**
- The plan file is the **specification**; `state.db` is the **execution record**.
- **Hard enforcement:** Every mutating state command (`claim`, `update`, `complete`) computes the current plan file hash and compares against `plans.plan_hash`. Mismatch = immediate failure with a clear error message.
- During IMPLEMENT, the plan is immutable (this is already the policy). The hash check makes it machine-enforced, not just policy.
- If a plan truly needs modification, `tugcode state init --force` re-initializes (resetting all non-completed steps) and updates the hash.

### 4. Orphaned State Data

**Risk:** A plan is deleted or renamed, leaving orphaned rows in `state.db`.

**Mitigation:** Add `tugcode state prune` command that removes entries for plans that no longer exist on disk. The `tugcode doctor` command can warn about orphaned state.

### 5. Repo Root Discovery Failure

**Risk:** `find_repo_root()` fails if git is not available or the user is not in a git repo.

**Mitigation:** This is already a precondition for all Tug operations (see `TugError::NotAGitRepository`). The new function uses the same git plumbing that worktree operations already depend on.

### 6. State.db Accessible from Worktree

**Risk:** The worktree is on a different filesystem (e.g., a different mount point), and the relative path back to the repo root doesn't work.

**Mitigation:** `find_repo_root()` uses `git rev-parse --git-common-dir` which returns an absolute path. We always use absolute paths to `state.db`. Cross-filesystem worktrees are a known git limitation regardless.

### 7. Multiple Plans Active Simultaneously

**Risk:** Two different plans are being implemented at the same time in different worktrees.

**Mitigation:** Each plan is a separate set of rows keyed by `plan_path`. They're completely independent in the database. The `claim` query scopes to `WHERE plan_path = ?`.

### 8. Stranded Claims (Process Death)

**Risk:** Orchestrator crashes after claiming a step. Step stays `claimed` forever.

**Mitigation:** Lease-based claims with 2-hour default expiry. The `claim` query considers expired leases as reclaimable. Manual `reset` is the immediate escape hatch. See [Lease-Based Claims](#lease-based-claims).

### 9. Dual-Write Failure in Phase 1

**Risk:** During Phase 1, beads write succeeds but state write fails (or vice versa).

**Mitigation:** **Beads is the source of truth until Phase 2.** If a state write fails during Phase 1, warn and continue — the orchestrator still has the data in memory, and beads has the persistence. State data is best-effort during Phase 1, becoming authoritative only in Phase 2 after validation.

## Two-Phase Migration Strategy

The migration avoids a chicken-and-egg problem by using the current beads infrastructure to implement Tugstate, then using Tugstate to remove beads.

### Phase 1: "Add Tugstate" (tugplan-add-tugstate)

**Goal:** Implement the full Tugstate system alongside beads. When this phase completes, both systems are running in parallel, and `tugcode state show` works.

**What gets built:**
1. Add `rusqlite` dependency to `tugtool-core`
2. New module: `tugtool-core/src/state.rs` — database connection, schema creation, all query functions
3. Unify `find_repo_root()` into `tugtool-core` (refactor out of `worktree.rs`)
4. New CLI commands: `tugcode state init`, `claim`, `start`, `heartbeat`, `update`, `artifact`, `complete`, `show`, `ready`, `reset`, `reconcile`
5. Update `tugcode worktree create` to call `state init` after beads sync
6. Update `tugcode commit` to call `state complete` after bead close
7. Update `.gitignore` with state.db patterns
8. Integration tests for all state commands
9. Update `tugcode doctor` to check state.db health

**What does NOT change yet:**
- Beads code stays. All beads commands still work.
- Agent files are untouched.
- The implement skill (SKILL.md) is untouched — it still runs the Bead Write Protocol.
- `tugcode beads` commands remain functional.
- **Beads is the source of truth** — state writes are best-effort alongside.

**Why this order:** Everything here is *additive*. No existing functionality is removed or broken. You can `tugcode state show` to see progress while beads continues to operate normally. This is safe to ship and validate before proceeding.

### Phase 2: "Remove Beads" (tugplan-remove-beads)

**Goal:** Remove all beads dependencies. Tugstate is the sole coordination mechanism.

**What gets removed:**
1. `tugtool-core/src/beads.rs` (1369 lines)
2. `tugcode/src/commands/beads/` directory (sync, status, close, pull, link, update, inspect — ~8 files)
3. All beads-related types from `tugtool-core/src/lib.rs` exports
4. `BeadsConfig` from `config.rs` and `config.toml`
5. Beads error variants from `error.rs` (E012-E015, E035-E036, BeadsNotInstalled, BeadsCommand)
6. Bead-related fields from `types.rs` (`bead_id`, `beads_hints`, `BeadsHints`, `beads_root_id`)
7. Beads sync/init/commit from `worktree.rs`
8. Bead close from `commit.rs`
9. `bead_mapping`, `root_bead_id` from `CreateData`, `StatusData`
10. `BeadStepStatus`, `BeadsCloseData` from `output.rs`
11. Beads integration tests and `bd-fake` mock
12. `beads_hints` parsing from `parser.rs`
13. Bead ID validation from `validator.rs`
14. `.beads/` from `.gitignore` (no longer needed)
15. `AGENTS.md` ignore from `.gitignore` (bd init artifact)

**What gets updated:**
1. SKILL.md: Remove the Bead Write Protocol. Replace `bead_mapping` references with `tugcode state` commands. Orchestrator calls `tugcode state update` + `tugcode state artifact` + `tugcode state heartbeat` instead of temp-file + beads CLI.
2. Agent markdown files: Remove `bead_id` from input contracts. Remove temp file writing instructions.
3. `tugplug/CLAUDE.md`: Remove Beads Policy section.
4. `tugcode commit`: Sequence becomes `log_rotate → log_prepend → git add → git commit → state complete`.
5. `tugcode worktree create`: Remove beads init/sync. Call `state init` + `state claim` to get the first ready step.
6. `tugcode status`: Remove `--full` bead enrichment. Use state.db for step status.

**Why this order:** Phase 2 is a large, breaking change, but by this point Tugstate has been validated in Phase 1. The implement skill uses Tugstate to execute Phase 2, proving the new system works by using it to remove the old one.

## Dependency: rusqlite

Add to `tugtool-core/Cargo.toml`:

```toml
[dependencies]
rusqlite = { version = "0.33", features = ["bundled"] }
```

The `bundled` feature compiles SQLite from source into the binary. No external SQLite library needed. This adds ~1MB to the tugcode binary.

**Note:** `rusqlite` with `bundled` requires a C compiler at build time. This is already a requirement for Rust toolchains on all platforms Tug targets (macOS, Linux). No new system dependency.

## Delivering on Requirements

| Requirement | How Tugstate Delivers |
|------------|----------------------|
| [I-08] atomic step fetch | `tugcode state claim` with `BEGIN EXCLUSIVE` + lease-based reclaim |
| [I-09] atomic step completion | `tugcode state complete` in a transaction (strict or forced) |
| [R-04] start IMPLEMENT at any time | Multiple worktrees claim different steps from the same state.db |
| [R-08] track progress | `tugcode state show` renders tasks/tests/checkpoints with open/in_progress/completed; `step_artifacts` table provides audit trail |
| [C-01]–[C-09] agent communication | Unchanged — persistent agents + orchestrator memory. State.db tracks *progress* and *audit breadcrumbs*, not full artifacts. |
| Merge clean | state.db is gitignored. Plan file is immutable during IMPLEMENT (hash-enforced). Only source code merges. |
| No external deps | rusqlite embeds SQLite into the binary. No `bd` binary, no daemon, no server. |
| Debuggable | `sqlite3 .tugtool/state.db "SELECT * FROM steps"` or `tugcode state show` |
| Crash recovery | Lease expiry reclaims stranded steps. `reconcile` command syncs DB from git log. `step_artifacts` table preserves agent audit trail. |
| Future multi-machine | Wrap state operations behind tugcast WebSocket endpoints. Same schema, same queries, just networked. |

## Resolved Design Questions

### Q1: Should `tugcode state init` run automatically on `tugcode worktree create`?

**Answer: Yes.** The worktree create command already does setup work (beads sync, commit annotations). Adding `state init` is natural and keeps the user's workflow unchanged.

### Q2: Should state.db survive `tugcode worktree remove`?

**Answer: Yes.** The state data is about the *plan*, not the *worktree*. If a worktree is removed, the step it was working on stays `claimed` (lease will expire) or can be manually reset to `pending`. The plan's overall state persists.

### Q3: Should `tugcode state show` be the default for `tugcode status`?

**Answer: In Phase 2, yes.** During Phase 1, `tugcode status` continues using checkbox-based progress. In Phase 2, it switches to state.db when available.

### Q4: Should `state complete` be strict (all checklist items complete) or allow force-complete?

**Answer: Strict by default, with `--force <reason>` override.** This gives agents freedom during implementation while maintaining trust in [R-08]. Force-completions are visible in `state show` and recorded in the `complete_reason` column.

### Q5: Should claims have leases?

**Answer: Yes.** 2-hour default lease with heartbeat renewal. Manual reset is also supported. Expired claims are automatically reclaimable by `claim`.

### Q6: What is the source of truth during Phase 1 dual-write?

**Answer: Beads.** State writes are best-effort during Phase 1. If a state write fails, warn and continue. Tugstate becomes the sole source of truth only in Phase 2.

### Q7: For step scheduling, what determines order?

**Answer: Any ready step, ordered by `step_index`.** The dependency graph determines which steps are ready. Among ready steps, `step_index` (plan parse order) provides deterministic tie-breaking. This is not hardcoded ordering — it's dependency-graph-first, plan-order-second.
