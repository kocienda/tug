# Tugplug Plan-ID Migration

## Context

The state DB now uses `plan_id` (format: `slug-hash7-gen`) as the primary identifier for all state commands. Plan content is stored in the DB as snapshots at init and completion time. The `state gc` command has been removed and replaced by `state archive`. All `tugcode state` CLI commands accept plan_id or slug prefix instead of file paths.

The tugplug agents and skills still reference `plan_path` everywhere — for reading plan content from disk and for identifying plans in state commands. Both uses can now go through `plan_id` and the state DB.

## The Shift: DB as Source of Truth

Previously, agents read plan content by constructing a file path (`{worktree_path}/{plan_path}`) and reading from disk. This created a dependency on file location — if the file moved, agents broke.

The new model: agents get plan content from the state DB via `tugcode state show <plan_id> --json`. The response includes the full plan markdown in `data.plan.content` (from the init snapshot). Agents never need to know where the file lives.

This means `plan_path` drops out of agent contracts entirely. Agents only need:
- `plan_id` — to identify the plan and call state commands
- `worktree_path` — to read/write implementation files (source code, not the plan itself)

The only place that touches a file path is `state init` — the ingestion point where a plan file is read from disk and stored in the DB.

### Plan content integrity

The snapshot IS the plan-of-record for a given plan_id. If the plan file changes after init, that's drift — already detected by the system. If a plan needs updating, `reinit` archives the old plan_id and creates a new one with the updated content. The snapshot for each plan_id is immutable.

## Prerequisite: Rust change

`state show` currently only returns `content` for archived plans. One small change: return content for all plans (from the most recent snapshot). This enables agents to get plan content via `state show` regardless of plan status.

## Scope

129 `plan_path` references across 14 files. The migration replaces `plan_path` with `plan_id` in agent/skill contracts and switches plan content access from file reads to `state show`.

### Category 1: Implement skill — state commands and orchestration

**`skills/implement/SKILL.md`** (50 references):

State command invocations (25 references):
- `tugcode state claim {plan_path}` → `{plan_id}`
- `tugcode state start {plan_path}` → `{plan_id}`
- `tugcode state heartbeat {plan_path}` → `{plan_id}`
- `tugcode state artifact {plan_path}` → `{plan_id}`
- `tugcode state complete-checklist {plan_path}` → `{plan_id}`

Orchestration changes:
- `tugcode worktree setup` still takes a file path (it's the entry point that triggers `state init`)
- Capture `plan_id` from the `state claim` JSON response (field already present)
- Thread `plan_id` (not `plan_path`) through all agent spawn prompts
- Agent spawn JSON changes from `{"plan_path": "...", "worktree_path": "..."}` to `{"plan_id": "...", "worktree_path": "..."}`
- Remove `plan_path` from agent spawn data — agents get plan content via `state show`

### Category 2: Implement-workflow agents — replace plan_path with plan_id

These 6 agents participate in the implement workflow and need `plan_path` replaced with `plan_id`:

| Agent | References | Change |
|-------|-----------|--------|
| `architect-agent.md` | 5 | Replace `plan_path` with `plan_id` in input contract. Get plan content via `tugcode state show {plan_id} --json` instead of reading `{worktree_path}/{plan_path}` |
| `coder-agent.md` | 6 | Same pattern. Coder reads plan content from `state show` to understand step tasks |
| `reviewer-agent.md` | 8 | Same pattern. Reviewer reads plan content from `state show` to verify task completion |
| `auditor-agent.md` | 5 | Same pattern. Auditor reads plan content from `state show` to check deliverables |
| `committer-agent.md` | 4 | Replace `plan_path` with `plan_id` in input contract. Used in commit trailers and state calls |
| `integrator-agent.md` | 4 | Replace `plan_path` with `plan_id`. PR metadata uses plan_id |

For each agent:
- Input contract: `plan_path` → `plan_id`
- Plan content access: `read {worktree_path}/{plan_path}` → `tugcode state show {plan_id} --json` then parse `data.plan.content`
- State commands: already use `plan_id` (from orchestrator)

### Category 3: Plan-workflow agents — no changes needed

These 5 agents only run during plan creation (before state init). They read/write plan files directly. No state DB involvement:

- `author-agent.md` (12 refs) — writes the plan file, returns its path. This is pre-init.
- `clarifier-agent.md` (4 refs) — analyzes the idea, may read existing plan file
- `critic-agent.md` (4 refs) — reads plan file for review
- `conformance-agent.md` (7 refs) — runs `tugcode validate <file_path>` (not a state command)
- `overviewer-agent.md` (2 refs) — reads plan file for review

These agents operate before the plan enters the state DB. They work with file paths and that's correct.

### Category 4: Plan skill — no changes needed

**`skills/plan/SKILL.md`** (12 references):
- Orchestrates plan creation. Passes `plan_path` to author/critic/conformance agents for file access.
- No state commands. No plan_id involvement.
- The plan skill's output (`plan_path`) feeds into `tugcode worktree setup` which triggers `state init`.

### Category 5: Merge skill — state gc removal

**`skills/merge/SKILL.md`** (6 references):
- References `state gc` for cleanup → change to `state archive`
- `plan_path` in merge commands: `tugcode merge <plan_path>` — this is the merge CLI, not a state command. Check if it should also move to plan_id or if it legitimately needs the file path.

### Category 6: Dash skill — no changes needed

**`skills/dash/SKILL.md`** — dashes don't use plans or state commands. No changes.

## Implementation Plan

### Step 0: Rust change (prerequisite)

Make `state show` return plan content for all plans (not just archived). Small change in `state.rs` — remove the `if status == "archived"` guard on the content query. One dash.

### Step 1: Implement skill + implement-workflow agents

The core migration. Update `skills/implement/SKILL.md` and all 6 implement-workflow agent files:

- Replace `plan_path` with `plan_id` in all state command templates
- Replace file-based plan reading with `state show` content access
- Update agent input/output contracts
- Thread `plan_id` from `state claim` response through all agent spawns

This is the bulk of the work — ~80 references across 7 files.

### Step 2: Merge skill

Update `skills/merge/SKILL.md`:
- Replace `state gc` with `state archive`
- Evaluate whether merge commands should use plan_id

### Verification

After each step:
- Review the changed files for consistency
- Run a test plan/implement cycle to verify end-to-end flow
- Confirm agents receive plan content via `state show` and no file path resolution occurs
