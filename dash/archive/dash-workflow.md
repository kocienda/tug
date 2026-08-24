# Dash Workflow

Lightweight, worktree-isolated project workflow that runs alongside the full plan/implement pipeline.

## Motivation

The plan/implement pipeline (`tugplug:plan` → `tugplug:implement` → `tugplug:merge`) is designed for structured, multi-step projects with formal plans, step tracking, drift detection, and multi-agent review. This is the right tool for significant features and complex changes.

But many projects are quick: fix a bug, spike an idea, add a small feature, prototype something. For these, the full pipeline adds unnecessary ceremony. You want to dash off the work in isolation, keep main clean, and either fold the results back in or throw them away.

The **dash workflow** provides this. It creates a git worktree, puts a single coding agent in it, and lets you direct work with natural language. When you're done, you either join the results back to main (squash merge) or release the worktree (discard everything). No plans, no steps, no drift budgets, no review loops.

## Design Principles

**Feels light, built solid.** The user interface is minimal — `/tugplug:dash <name> <instruction>`, repeat, then `join` or `release`. Under the covers, dash reuses tugtool infrastructure: the TugState SQLite database for state tracking, `tugcode dash` CLI subcommands for git operations with proper error handling and recovery. The user never sees this machinery.

**Separate workflows, shared foundation.** Dash and plan/implement are distinct workflows with different agents, different lifecycles, and different user-facing commands. But they share the same database, the same worktree directory structure, and the same CLI patterns. A dash never uses plan steps or drift detection. A plan never uses the dash-agent. They coexist cleanly.

**Worktree-native.** Each dash lives in its own git worktree with its own branch. Main stays clean. Multiple dashes can run in parallel with each other and with plan/implement worktrees.

**Session-aware, session-independent.** Within a single Claude Code session, the dash-agent is persistent (resumed across invocations, accumulating context). Across sessions, a fresh agent is spawned, but the worktree provides full continuity — all files and git history are there.

## User Experience

The user interacts with dashes through a single skill:

```
/tugplug:dash <name> <instruction>     Start new dash or continue existing one
/tugplug:dash <name> join              Squash-merge to main and clean up
/tugplug:dash <name> join <message>    Same, with custom commit message
/tugplug:dash <name> release           Discard worktree and branch
/tugplug:dash <name> status            Show dash info
/tugplug:dash status                   List all active dashes
```

That's it. Everything else happens under the covers.

### Examples

```
/tugplug:dash login-page add a login page with email and password fields
/tugplug:dash login-page now add a "forgot password" link that sends a reset email
/tugplug:dash login-page the password field should have a show/hide toggle
/tugplug:dash login-page join
```

```
/tugplug:dash spike-websockets prototype a websocket connection for live updates
/tugplug:dash spike-websockets release
```

### Parsing Rules

1. First token is always the dash name (e.g., `login-page`)
2. If the second token is a reserved word (`release`, `join`, `status`), treat as lifecycle command
3. If the name is `status` with no further args, list all dashes
4. Otherwise, everything after the name is the instruction to the dash-agent

**Reserved words:** `release`, `join`, `status`

## Components

### Skill: `tugplug:dash`

File: `tugplug/skills/dash/SKILL.md`

The skill is a lightweight orchestrator. It:

- Parses the dash name and instruction from user input
- Calls `tugcode dash` CLI commands for worktree and state management
- Spawns or resumes the dash-agent for implementation work
- Auto-commits via `tugcode dash commit` after each agent round
- Handles lifecycle commands (`join`, `release`, `status`) by calling the appropriate `tugcode dash` subcommands

**Allowed tools:** `Task`, `AskUserQuestion`, `Bash`

**Bash restriction:** Like the implement skill, the dash skill restricts Bash to `tugcode` commands only. All git operations are encapsulated in `tugcode dash` subcommands.

### Agent: `tugplug:dash-agent`

File: `tugplug/agents/dash-agent.md`

A coding agent derived from `coder-agent` but stripped to essentials:

| Feature | coder-agent | dash-agent |
|---------|-------------|------------|
| Model | sonnet | sonnet |
| Tools | Read, Grep, Glob, Write, Edit, Bash, WebFetch, WebSearch | Same |
| Plan/step context | Required (plan_path, step_anchor) | None |
| Architect strategy | Required (expected_touch_set, implementation_steps) | None |
| Drift detection | Full (green/yellow/red budgets, halt on threshold) | None |
| Instructions | Structured JSON from orchestrator | Natural language from user |
| Output | Structured JSON with drift_assessment | Structured JSON (simpler) |
| Commits | Forbidden (committer-agent handles) | Forbidden (skill handles) |
| Persistent | Yes (resumed across steps) | Yes (resumed across invocations within session) |
| File tracking | Yes (files_created, files_modified) | Yes |
| Build/test | Yes (after each step) | Yes (when relevant) |

The dash-agent is told:

- The worktree path (all file operations use absolute paths)
- The user's instruction in natural language
- On resume: the new instruction, with full prior context intact

It returns:

```json
{
  "summary": "Added login page with email/password form and basic validation",
  "files_created": ["src/pages/login.tsx", "src/pages/login.test.tsx"],
  "files_modified": ["src/router.tsx"],
  "build_passed": true,
  "tests_passed": true,
  "notes": "Used existing auth hook pattern from src/hooks/useAuth.ts"
}
```

### dash-agent Behavioral Rules

1. **All file operations use absolute paths** prefixed with `worktree_path`
2. **All output paths are relative** to the worktree root
3. **Never commit** — the skill handles commits after the agent returns
4. **Run build/test when appropriate** — after implementation work, not for pure exploration
5. **Stay within the worktree** — no files outside the worktree directory
6. **No plan or step context** — work from natural language instructions only
7. **Persistent knowledge** — accumulate understanding across invocations within a session

### Differences from coder-agent

The dash-agent prompt is NOT a fork of coder-agent. It's a fresh, shorter document that specifies the simpler contract. This avoids accumulating dead weight from plan/step/drift concepts that don't apply.

The key structural similarities (file path handling, build/test detection, persistent agent pattern) are re-specified directly in the dash-agent prompt rather than shared via inheritance. Duplication here is intentional — it keeps the two agents fully independent and avoids coupling.

## Tugcode CLI: `tugcode dash` Subcommands

All git operations and state management are encapsulated in `tugcode dash` subcommands. The skill calls these via Bash; the user never runs them directly.

| Subcommand | Does |
|-----------|------|
| `tugcode dash create <name> --description "..."` | Create branch + worktree, init state.db entry |
| `tugcode dash commit <name> --message "..."` | Stage + commit in worktree, record round in state.db |
| `tugcode dash join <name> [--message "..."]` | Squash-merge to main, cleanup worktree+branch, update state |
| `tugcode dash release <name>` | Delete worktree+branch, update state |
| `tugcode dash list` | List active dashes from state.db |
| `tugcode dash show <name>` | Show dash details + round history |

All commands output JSON (with `--json` flag or by default) for the skill to parse. Error handling, rollback on partial failure, and idempotency follow the same patterns as existing `tugcode worktree` and `tugcode merge` commands.

### `tugcode dash create <name> --description "..."`

1. Validate the name (alphanumeric + hyphens, no reserved words)
2. Check if dash already exists (idempotent — return existing if found)
3. Create branch `tugdash/<name>` from main
4. Create worktree at `.tugtree/tugdash__<name>/`
5. Insert row into `dashes` table in state.db
6. Return JSON: `{ "name", "branch", "worktree_path", "created": true|false }`

Rollback: if worktree creation fails after branch creation, delete the branch.

### `tugcode dash commit <name> --message "..."`

1. Locate worktree for the named dash
2. Stage all changes: `git -C <worktree> add -A`
3. Check if there are changes to commit (skip if clean)
4. Commit: `git -C <worktree> commit -m "<message>"`
5. Insert row into `dash_rounds` table with commit hash
6. Return JSON: `{ "commit_hash", "files_staged", "skipped": true|false }`

### `tugcode dash join <name> [--message "..."]`

1. Commit any outstanding changes in the dash worktree (call commit logic internally)
2. Preflight: check main is clean (no uncommitted changes — blocker)
3. Squash-merge: `git merge --squash tugdash/<name>`
4. Commit on main: `git commit -m "tugdash(<name>): <message or description>"`
5. Remove worktree: `git worktree remove <path>`
6. Delete branch: `git branch -D tugdash/<name>`
7. Update state: set dash status to `joined`
8. Return JSON: `{ "squash_commit", "worktree_cleaned", "branch_deleted" }`

Partial failure recovery: if merge fails, working tree is restored. If cleanup fails after successful merge, report but don't fail.

### `tugcode dash release <name>`

1. Remove worktree: `git worktree remove <path> --force`
2. Delete branch: `git branch -D tugdash/<name>`
3. Update state: set dash status to `released`
4. Return JSON: `{ "worktree_removed", "branch_deleted" }`

### `tugcode dash list`

1. Query `dashes` table for active dashes
2. For each, verify worktree still exists on disk
3. Return JSON array: `[{ "name", "description", "branch", "created_at", "round_count" }]`

### `tugcode dash show <name>`

1. Query dash metadata from `dashes` table
2. Query all rounds from `dash_rounds` table
3. Check worktree for uncommitted changes
4. Return JSON: `{ "name", "description", "branch", "worktree_path", "status", "rounds": [...], "has_uncommitted_changes" }`

## TugState Schema Extension

Dash state lives in the same `state.db` SQLite database as plan state, in new tables.

```sql
-- Schema version bump (existing mechanism handles migration)

CREATE TABLE dashes (
  name        TEXT PRIMARY KEY,
  description TEXT,
  branch      TEXT NOT NULL,
  worktree    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',  -- active | joined | released
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE dash_rounds (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  dash_name      TEXT NOT NULL REFERENCES dashes(name),
  instruction    TEXT NOT NULL,
  summary        TEXT,
  files_created  TEXT,   -- JSON array
  files_modified TEXT,   -- JSON array
  commit_hash    TEXT,
  started_at     TEXT NOT NULL,
  completed_at   TEXT
);

CREATE INDEX idx_dash_rounds_name ON dash_rounds(dash_name);
```

The `dashes` table tracks lifecycle. The `dash_rounds` table is an audit trail — each time the dash-agent runs, a round is recorded with what was asked, what was done, and which commit captured it. This is the dash equivalent of steps+artifacts in the plan model, shaped for the dash workflow.

## Naming Conventions

| Item | Pattern | Example |
|------|---------|---------|
| Branch | `tugdash/<name>` | `tugdash/login-page` |
| Worktree dir | `.tugtree/tugdash__<name>/` | `.tugtree/tugdash__login-page/` |
| CLI namespace | `tugcode dash <subcommand>` | `tugcode dash create login-page` |
| Commit prefix | `tugdash(<name>):` | `tugdash(login-page): add login form` |

The `tugdash/` branch prefix is distinct from the `tugplan/` prefix used by plan/implement worktrees. Both use `.tugtree/` for worktree directories (already in `.gitignore`).

## Lifecycle Detail

### New Dash (first invocation with a new name)

```
User: /tugplug:dash login-page add a login page with email and password

Skill:
  1. tugcode dash create login-page --description "add a login page with email and password" --json
     → Parses JSON: worktree_path, branch, created
  2. Spawn dash-agent with { worktree_path, instruction }
     → Agent implements, returns { summary, files_created, files_modified, ... }
  3. tugcode dash commit login-page --message "tugdash(login-page): <summary>" --json
     → Parses JSON: commit_hash
  4. Report to user: summary, files, commit
```

### Continue Dash (subsequent invocation)

```
User: /tugplug:dash login-page add forgot-password flow

Skill:
  1. tugcode dash show login-page --json
     → Parses JSON: confirms dash exists, gets worktree_path
  2. Resume dash-agent (same session) or spawn fresh (new session) with instruction
     → Agent implements, returns result
  3. tugcode dash commit login-page --message "tugdash(login-page): <summary>" --json
  4. Report to user
```

### Join

```
User: /tugplug:dash login-page join

Skill:
  1. tugcode dash show login-page --json
     → Get round count, description for confirmation message
  2. AskUserQuestion: "Join dash 'login-page' to main? This squash-merges N rounds of work."
  3. tugcode dash join login-page --json
     → Parses JSON: squash_commit, cleanup status
  4. Report: "Dash 'login-page' joined to main. Commit: <hash>"
```

### Release

```
User: /tugplug:dash login-page release

Skill:
  1. AskUserQuestion: "Release dash 'login-page'? This deletes the worktree and all work. Cannot be undone."
  2. tugcode dash release login-page --json
  3. Report: "Dash 'login-page' released."
```

### Status

```
User: /tugplug:dash login-page status

Skill:
  1. tugcode dash show login-page --json
  2. Report: branch, worktree, round count, recent rounds, uncommitted changes
```

```
User: /tugplug:dash status

Skill:
  1. tugcode dash list --json
  2. Report: table of active dashes with name, description, round count
```

## Hooks

### Auto-approve

The existing `auto-approve-tug.sh` hook already handles `tugplug:*` patterns for both Skill and Task tool calls, and auto-approves `tugcode` Bash commands. No changes needed — `tugplug:dash` (skill), `tugplug:dash-agent` (Task subagent), and `tugcode dash *` (Bash) all match existing patterns.

### Bash restriction

Like the implement skill, the dash skill restricts Bash to `tugcode` commands via a PreToolUse hook in the skill frontmatter. All git operations go through `tugcode dash` subcommands.

### Ensure-init

The `ensure-init.sh` hook fires on Task calls. It ensures tugcode is initialized before spawning the dash-agent. This is fine — it's a no-op if already initialized.

## Interaction with Plan/Implement

Dash and plan/implement are distinct workflows that share infrastructure:

| Concern | Plan/Implement | Dash |
|---------|---------------|------|
| Worktree creation | `tugcode worktree create` | `tugcode dash create` |
| Branch prefix | `tugplan/` | `tugdash/` |
| State tracking | `plans`, `steps`, `checklist_items` tables | `dashes`, `dash_rounds` tables |
| Database | state.db | state.db (same DB) |
| Agent orchestration | 6 agents (architect → coder → reviewer → committer → auditor → integrator) | 1 agent (dash-agent) |
| Merge to main | `tugcode merge` / `tugplug:merge` | `tugcode dash join` / `tugplug:dash <name> join` |
| Plan file | Required | None |
| Commit strategy | Per-step via committer-agent | Per-round auto-commit by skill |

A dash cannot be "promoted" to a plan/implement project or vice versa. They are separate tracks. If you start a dash and realize you need the full pipeline, you join (or release) the dash and start a plan from scratch.

## Implementation Plan

### Tugcode Changes (Rust)

1. **Schema migration** — Add `dashes` and `dash_rounds` tables to state.db, bump schema version
2. **`tugcode dash` subcommand group** — New command module with `create`, `commit`, `join`, `release`, `list`, `show` subcommands
3. **Dash state functions** — Core library functions for dash CRUD, round recording, worktree operations (reusing existing `GitCli` and worktree utilities from `worktree.rs`)

### Tugplug Changes (Plugin)

4. **`tugplug/agents/dash-agent.md`** — Agent definition with input/output contracts and behavioral rules
5. **`tugplug/skills/dash/SKILL.md`** — Skill definition with parsing, lifecycle orchestration, and agent management

### Implementation Order

1. Schema migration + core dash state functions (foundation)
2. `tugcode dash create` + `tugcode dash list` + `tugcode dash show` (can test worktree creation)
3. `tugcode dash commit` (can test the commit-after-work flow)
4. `tugcode dash join` + `tugcode dash release` (lifecycle completion)
5. `dash-agent.md` (agent is independent, can be tested with manual Task calls)
6. `dash/SKILL.md` (skill ties everything together)
7. End-to-end test: create, work, commit, join, verify main

### Testing

Manual testing workflow:

```
# Create and work on a dash
/tugplug:dash test-feature add a hello world endpoint

# Verify worktree and branch exist
tugcode dash list --json
tugcode dash show test-feature --json
git worktree list

# Continue working
/tugplug:dash test-feature add a test for the endpoint

# Check status
/tugplug:dash test-feature status

# Join back to main
/tugplug:dash test-feature join

# Verify main has the changes and worktree is cleaned up
git log --oneline -1
tugcode dash list --json
git worktree list
git branch --list tugdash/*
```
