# Robust Checklist Reconciliation

## Problem Statement

Three related issues surfaced during the plan-quality-split implementation run:

### 1. Fragile Batch Update Construction

The implement skill manually constructs batch JSON for `tugcode state update --batch` by combining the coder's `checklist_status.tasks[]` and `checklist_status.tests[]` with the reviewer's `plan_conformance.checkpoints[]`. This is fragile because:

- The coder may under-report items (e.g., reporting ordinals 0-18 when there are 20 tasks 0-19)
- The reviewer tallies checkpoints independently but may also miscount
- The orchestrator has no way to verify coverage before submitting the batch
- The batch update validates each item that IS present but makes no assertion about exhaustiveness
- Under-reported items silently remain "open" in the database

**Observed failure:** Step-1 had 20 tasks but the orchestrator sent only 19 in the batch update. `tugcode commit` then failed `state complete` because 1 checklist item was still open.

### 2. Hard Halt on state_update_failed

When `tugcode commit` returns `state_update_failed: true`, the implement skill halts immediately with no recovery path. This is too draconian because:

- The git commit already succeeded (state updates are deliberately non-fatal in the CLI)
- The reviewer confirmed all work was done — the problem is in state tracking, not implementation
- The reviewer REVISE loop already has a proven retry pattern (coder fix → re-review, up to 3 attempts), but there's no analogous recovery for state failures
- `tugcode state complete --force` exists as a force-completion mechanism but is never used

### 3. Coder-Agent Multi-Line Bash Prompts

The coder-agent produces multi-line Bash commands (using `\` continuations or newlines) that trigger Claude Code's "Command contains newlines" confirmation prompt, requiring user intervention. Root causes:

- No guidance in coder-agent.md to prefer Grep/Read/Glob over Bash grep/cat/find
- Multi-line command patterns are normalized in the codebase (committer-agent examples)
- `permissionMode: dontAsk` doesn't suppress Claude Code's built-in newline validation
- The coder-agent has Grep, Read, Glob tools but no instructions to prefer them

## Investigation Findings

### Tugstate Checklist Architecture

- **Checklist items** are parsed from plan markdown at `tugcode state init` time and stored in `checklist_items` table with status "open"
- **Counts are dynamic** — computed via SQL aggregation on demand, not pre-stored
- **`tugcode state show --checklist --json`** returns all items with step_anchor, kind, ordinal, text, status, reason
- **`tugcode state show --json`** returns per-step summary: tasks_total, tasks_completed, tests_total, etc.
- **`state complete --force`** auto-completes all remaining open items in one atomic operation
- **Batch update** validates each submitted item but does NOT check that the batch is exhaustive

### Key Insight: The Agents Should NOT Count

The coder-agent and reviewer-agent should not be responsible for enumerating checklist ordinals. They don't have access to the tugstate database. Their job is to implement and verify — the orchestrator should handle state bookkeeping using the CLI.

## Proposed Changes

### A. CLI: Add `tugcode state complete-all` (or `--mark-all` flag on batch)

Add a command that marks all checklist items for a step as completed in one shot:

```bash
tugcode state complete-all <plan> <step> --worktree <path>
```

Or alternatively, add a flag to the existing batch update:

```bash
echo '[]' | tugcode state update <plan> <step> --worktree <path> --batch --complete-remaining
```

This eliminates the counting problem entirely. After the reviewer approves, the orchestrator simply says "mark everything done" rather than constructing an itemized list.

**For deferred items:** The reviewer could report specific items to defer (with reasons), and only those go in the batch. Everything else gets auto-completed:

```bash
echo '[{"kind":"task","ordinal":5,"status":"deferred","reason":"manual verification required"}]' \
  | tugcode state update <plan> <step> --worktree <path> --batch --complete-remaining
```

### B. Implement Skill: Recovery Loop for state_update_failed

Replace the hard halt with a recovery loop:

1. **Committer returns `state_update_failed: true`** with the specific error message
2. **Orchestrator queries** `tugcode state show <plan> --json` to find which items are still open
3. **If all items can be auto-completed** (reviewer already approved): use `state complete --force` or the new `--complete-remaining` flag
4. **If there are genuine issues** (items that should be deferred): resume coder with the details
5. **Escalate after max attempts** (3) to user with AskUserQuestion

This mirrors the reviewer REVISE retry pattern already proven in the implement skill.

### C. Simplify Orchestrator Batch Construction

Instead of having the orchestrator manually assemble batch JSON from coder/reviewer output:

**Current flow (fragile):**
1. Coder reports `checklist_status.tasks[0..N]` — may miss items
2. Reviewer reports `plan_conformance.checkpoints[0..M]` — may miss items
3. Orchestrator manually constructs batch JSON by iterating both arrays
4. Orchestrator sends batch, hopes it's exhaustive
5. `state complete` fails if anything was missed

**Proposed flow (robust):**
1. Reviewer APPROVEs the step
2. Orchestrator sends any deferred items (from reviewer's non-PASS verdicts) via batch
3. Orchestrator runs `tugcode state complete-all` (or `state complete --force`) to mark everything else completed
4. No counting required — the CLI handles it

### D. Coder-Agent Tool Preference Guidance

Add a section to `tugplug/agents/coder-agent.md`:

```markdown
## Tool Usage

- For reading files, use **Read** (not `cat`, `head`, or `tail`)
- For searching code content, use **Grep** (not `bash grep` or `rg`)
- For finding files by pattern, use **Glob** (not `bash find` or `ls`)
- Use **Bash** only for: build commands, test commands, checkpoint verification commands, and `cd {worktree_path} && <cmd>` chains
- **Single-line Bash commands only** — do not use `\` line continuations or heredocs in Bash calls
- If a verification needs multiple commands, make separate tool calls
```

This aligns with Claude Code's built-in guidance and eliminates the newline confirmation prompts.

### E. Remove Counting from Agent Contracts

The coder-agent's `checklist_status` and the reviewer-agent's tally-based reporting become informational only — not used for state updates. The orchestrator uses them for progress reporting messages but NOT for constructing batch updates.

This removes the agents from the critical path of state tracking entirely.

## Implementation Scope

| Change | Component | Complexity |
|--------|-----------|------------|
| `state complete-all` or `--complete-remaining` | tugcode CLI (Rust) | Medium — new command or flag on existing batch path |
| Recovery loop for state_update_failed | implement skill (SKILL.md) | Medium — follows reviewer REVISE pattern |
| Simplify batch construction | implement skill (SKILL.md) | Low — remove manual batch assembly, use new CLI command |
| Tool preference guidance | coder-agent.md | Low — add documentation section |
| Remove counting from agent contracts | coder-agent.md, reviewer-agent.md, implement skill | Medium — changes to output contracts and orchestrator parsing |

## Relationship to tugplan-accurate-state-tracking

The accurate-state-tracking plan established the tugstate infrastructure (checklist items, batch updates, state complete validation). That foundation is sound. This proposal addresses the **orchestration layer** that sits on top of it — specifically, how the implement skill uses the CLI to manage state transitions. The CLI's strict validation (requiring all items completed before `state complete`) is correct; the problem is that the orchestrator's method of getting items into the "completed" state is fragile.

## Open Questions

1. Should `state complete --force` be the default path (after reviewer approval), or should we preserve the itemized batch as a validation checkpoint?
2. Should deferred items require explicit reviewer identification, or should the orchestrator be able to defer items autonomously?
3. Should the coder-agent stop reporting `checklist_status` entirely, or should it remain as informational output for progress reporting?
