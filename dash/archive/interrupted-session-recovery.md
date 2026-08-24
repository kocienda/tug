# Interrupted Session Recovery

## Problem

When an implementation session is interrupted (crash, user abort, network failure), the in-progress step retains its lease for the full 2-hour default duration. Re-running `/tugplug:implement` on the same plan hits `NoReadySteps` because `state claim` refuses to claim a step with an unexpired lease — even when the claiming worktree is the same one that already owns it.

The worktree is reused automatically (idempotent `worktree create`), so the new session has the same worktree path. But the claim query doesn't consider ownership identity — it only checks lease expiry:

```sql
AND (s.status = 'pending'
     OR (s.status IN ('claimed', 'in_progress') AND s.lease_expires_at < ?2))
```

Result: user must wait up to 2 hours before retrying, or manually edit state.db.

## Three Fixes

All three are needed. They serve different scenarios and have no overlap.

### 1. Same-Worktree Auto-Reclaim

**What:** If the worktree requesting `state claim` matches the `claimed_by` on an in-progress step, skip the lease check and return that step immediately.

**Where:** `claim_step()` in `tugtool-core/src/state.rs`, the claimability query (line ~462).

**Change:** Add a condition to the WHERE clause:

```sql
AND (
    s.status = 'pending'
    OR (s.status IN ('claimed', 'in_progress') AND s.lease_expires_at < ?2)
    OR (s.status IN ('claimed', 'in_progress') AND s.claimed_by = ?3)
)
```

**Why this is safe:** You already own the step. Re-claiming it just refreshes the lease and lets you continue. The `reclaimed` flag in `ClaimResult` already signals this case downstream, and the checklist reset logic already handles it.

**Scenario:** User interrupts session, re-runs implement immediately. Same worktree, same step, no wait.

### 2. `state release` Command

**What:** A new CLI command that explicitly releases a step's claim, returning it to `pending` status.

**CLI:**
```
tugcode state release <plan> <step> --worktree <path>
```

**Behavior:**
- Verify `claimed_by` matches the provided `--worktree` (ownership check)
- Reset step status to `pending`
- Clear `claimed_by`, `claimed_at`, `lease_expires_at`, `heartbeat_at`
- Reset non-completed substeps to `pending`
- Reset checklist items to `open` for affected substeps
- Refuse to release a `completed` step (error)

**Without `--worktree` (force variant):**
```
tugcode state release <plan> <step> --force
```
Skips ownership check. For when the original worktree is gone or you want to reassign.

**Where:** New function `release_step()` in `tugtool-core/src/state.rs`, new subcommand in `tugcode/src/commands/state.rs`.

**Scenario:** User wants to abandon a step, start fresh with a different worktree, or clean up after a worktree was manually deleted.

### 3. `--force` Flag on `state claim`

**What:** A flag that ignores lease expiry when claiming, taking over any non-completed step.

**CLI:**
```
tugcode state claim <plan> --worktree <path> --force --json
```

**Behavior:** The claimability query becomes:

```sql
AND (
    s.status = 'pending'
    OR s.status IN ('claimed', 'in_progress')  -- no lease check when --force
)
```

Still respects dependency ordering (won't claim step-2 if step-1 isn't done). Still sets `reclaimed = true` when appropriate.

**Where:** Add `force: bool` parameter to `claim_step()` in `tugtool-core/src/state.rs`. Pass through from CLI.

**Scenario:** Lease is unexpired, original worktree is gone (deleted, different machine), user wants to take over from a new worktree without waiting.

## Implementation Order

1. **Same-worktree auto-reclaim** — highest impact, lowest risk, fixes the common case silently
2. **`state release`** — manual escape hatch, needed for cleanup workflows
3. **`--force` on claim** — nuclear option, needed for multi-machine or worktree-gone scenarios

## Orchestrator Changes

The implement skill (SKILL.md) needs no changes for fix 1 — it already calls `state claim` with the correct worktree path, and `reclaimed` steps already work.

For fix 2, the skill could optionally call `state release` as part of error recovery, but this is a future enhancement. The primary use case is manual invocation by the user.

Fix 3 could be wired into the orchestrator as a retry: if `state claim` returns `NoReadySteps` and `blocked > 0`, retry with `--force`. But this is aggressive and should probably remain a manual user action.

## Testing

- Claim a step, don't heartbeat, re-claim from same worktree → should succeed (fix 1)
- Claim a step, release it, re-claim from different worktree → should succeed (fix 2)
- Claim a step (lease active), force-claim from different worktree → should succeed (fix 3)
- Release a completed step → should fail
- Force-claim should still respect step dependency ordering
- Reclaimed steps should have checklist items reset
