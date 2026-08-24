# State Complete-Checklist: CLI Simplification

## Problem

The `tugcode state update` command is a Rube Goldberg machine. Its primary production use case — "reviewer approved, mark the step's checklist done" — requires this incantation:

```
echo '[]' | tugcode state update <plan> <step> --worktree <path> --batch --complete-remaining
```

This is fragile and confusing because:

1. **`--batch` forces stdin reading.** Even when there's nothing to send, you must pipe valid JSON. Forget the `echo '[]'` and the command hangs waiting on stdin, then fails.
2. **`--complete-remaining` requires `--batch`.** The flag that does the actual work can't be used without the flag that forces the stdin ceremony.
3. **Dead per-item flags.** `--task`, `--test`, `--checkpoint`, `--all-tasks`, `--all-tests`, `--all-checkpoints`, `--all` exist in the CLI but are never used in production. They were designed for incremental agent updates that never materialized — and shouldn't, because the state system is a *completion ledger*, not a progress tracker. The reviewer is the verification gate; agents self-reporting would just add unverified claims.
4. **Two library APIs for the same thing.** `update_checklist` (per-item) and `batch_update_checklist` (batch) in tugtool-core serve the same purpose with different interfaces. Only the batch path is used.

## Design Decision

The state system is a completion ledger. Agents do work; the reviewer verifies; the orchestrator records the result. This means:

- The orchestrator needs exactly one operation: "mark this step's checklist done, with optional deferrals"
- Per-item granular updates from agents are not needed and would add complexity without trustworthiness
- Manual recovery is handled by `state reconcile`, not by granular `state update` flags

## Proposal

### Add `tugcode state complete-checklist` subcommand

A new subcommand that does exactly one thing: finalize a step's checklist after reviewer approval.

```
# Happy path: everything approved, no deferrals
tugcode state complete-checklist <plan> <step> --worktree <path>

# With deferrals: pipe only the exceptions
echo '<deferred_json>' | tugcode state complete-checklist <plan> <step> --worktree <path>
```

Behavior:
- If stdin is piped (not a TTY), read it as JSON array of deferral entries: `[{"kind": "checkpoint", "ordinal": N, "status": "deferred", "reason": "..."}]`
- If stdin is a TTY (no pipe), treat as empty array — no deferrals
- After applying any explicit deferrals, mark all remaining open items as completed
- Check plan drift (fail unless `--allow-drift` is passed)
- Check worktree ownership
- Transactional (all-or-nothing)

This is the same logic as today's `--batch --complete-remaining` path, but with the intent expressed in the subcommand name rather than flag combinations.

### Remove dead per-item flags from `state update`

Delete from the `Update` variant in `StateCommands`:
- `--task ORDINAL:STATUS`
- `--test ORDINAL:STATUS`
- `--checkpoint ORDINAL:STATUS`
- `--all-tasks STATUS`
- `--all-tests STATUS`
- `--all-checkpoints STATUS`
- `--all STATUS`
- `--allow-reopen`

These have zero production callers. The only test using them (`--task 1:completed`) should be rewritten to use the batch path or `complete-checklist`.

### Remove dead library code from tugtool-core

- Delete `ChecklistUpdate` enum (Individual, BulkByKind, AllItems variants)
- Delete `update_checklist` method on `StateDb`
- Keep `batch_update_checklist` — it's the implementation behind `complete-checklist`

### Simplify `state update` to batch-only

After removing per-item flags, `state update` becomes a thin wrapper around `batch_update_checklist` with mandatory stdin. But at that point, its functionality is a subset of `complete-checklist` (batch without `complete_remaining`). Consider whether `state update` should be kept at all, or if `complete-checklist` (which handles both cases — with and without deferrals — via optional stdin) fully replaces it.

**Recommendation:** Remove `state update` entirely. Its two remaining use cases are:
- Batch with `--complete-remaining` → replaced by `complete-checklist`
- Batch without `--complete-remaining` → no production caller exists; if one emerges, `complete-checklist` without the auto-complete behavior could be a separate flag, but YAGNI

### Update orchestrator (implement skill)

In `tugplug/skills/implement/SKILL.md`:

**Section 3e (after APPROVE):**
```
# Was:
echo '[]' | tugcode state update {plan_path} {step_anchor} --worktree {worktree_path} --batch --complete-remaining

# Becomes (no deferrals):
tugcode state complete-checklist {plan_path} {step_anchor} --worktree {worktree_path}

# Becomes (with deferrals):
echo '<deferred_json>' | tugcode state complete-checklist {plan_path} {step_anchor} --worktree {worktree_path}
```

**All manual recovery messages:** Replace the `echo '[]' | tugcode state update ... --batch --complete-remaining` incantation with `tugcode state complete-checklist ...`.

**Tugstate Protocol reference section:** Update to show the simplified command.

### Update reviewer instructions

No change needed to the reviewer-agent prompt itself — the reviewer already reports checkpoint verdicts in its structured output. The orchestrator translates non-PASS verdicts into deferral entries. This boundary is correct.

However, reinforce in the implement skill (section 3e) that the reviewer's `plan_conformance.checkpoints[]` is the sole source of deferral decisions. The coder's `checklist_status` is for progress display only — never for state updates.

## Scope

### In scope
- New `complete-checklist` subcommand in `state.rs`
- TTY detection for optional stdin (`atty` crate or `std::io::IsTerminal`)
- Remove `Update` variant from `StateCommands` (or strip it to nothing)
- Remove `ChecklistUpdate` enum and `update_checklist` from tugtool-core
- Update integration tests
- Update implement skill (SKILL.md)
- Update Tugstate Protocol reference section

### Out of scope
- Changes to reviewer-agent or coder-agent prompts
- Changes to `state complete` (step completion, called by `tugcode commit`)
- Changes to `state reconcile`
- Changes to `batch_update_checklist` internals (the library method is sound)

## Migration

This is not a breaking change for any production workflow. The only callers of `state update` are:
1. The implement skill orchestrator → updated in this proposal
2. Manual recovery instructions in SKILL.md → updated in this proposal
3. One integration test using `--task 1:completed` → rewritten

No external consumers exist.
