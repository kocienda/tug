# The Tug Multi-Agent Coordination Problem

Tug has a multi-agent coordination problem. The goal of the Tug backend is to provide support for: taking an idea for how to change software and then giving that idea off to agents to deliver that software. Repeat. This process is interactive with a human developer, but at a high level, reducing the developer's TUG WORKFLOW to three phases:

## Phases and Implications
- *PLAN*: making a plan for a code change
- *IMPLEMENT*: kicking off the implementation for code changes described in a PLAN
- *MERGE*: merging code changes from an IMPLEMENT phase back into main

This last point in the merge step implies `git`, and it also carries along a couple other implications about the use of `git` and the WORKFLOW in general:
- [I-01]: each plan refers to one and only one `git` repo
- [I-03]: each PLAN refers to a base revision in git
- [I-02]: each PLAN phase is committed on the `main` branch when it completes, and must have a PLAN-REVISION that is a child of its base revision
- [I-04]: each PLAN has a one or more STEPS that describe the required work
- [I-04]: each PLAN STEP has a number of subsections that break down its work, including: Depends on, Commit, References, Artifacts, Tasks, Tests, Checkpoint, and Rollback information. In particular, the Tasks, Tests, and Checkpoint have CHECKLISTS to enumerate the required work in detail.
- [I-05]: each IMPLEMENT phase must have an associated PLAN
- [I-06]: each PLAN must be VALIDATED before an IMPLEMENT phase against it can begin, which includes determining the PLAN/STEP DEPENDENCY CHAIN between the STEPs it contains
- [I-07]: each IMPLEMENT phase is done on a `git worktree`, which must be the same base revision as its associated PLAN
- [I-08]: each IMPLEMENT phase must be able to *atomically* fetch the next PLAN STEP to work on, honoring the PLAN/STEP DEPENDENCY CHAIN
- [I-09]: each IMPLEMENT phase must be able to *atomically* mark PLAN STEPS as it completes them
- [I-10]: each MERGE operation must only be done against a completed PLAN, i.e. a PLAN which has had all its STEPS completed in a IMPLEMENT phase
- [I-11]: each `git worktree` for an IMPLEMENT phase can be deleted once it has been MERGED

## Phases and Skills
Each of these phases is orchestrated by a SKILL, which can call on SUBAGENTS to accomplish work, as follows:
- *PLAN*:
    Skill: turns an idea into a validated, implementation-ready tugplan with explicit steps
    Subagents:
    - clarifier-agent: asks targeted questions to resolve ambiguities before plan writing starts
    - author-agent: drafts and revises the tugplan document from clarified requirements
    - critic-agent: reviews plan quality, completeness, and implementability before approval
- *IMPLEMENT*:
    Skill: executes the validated tugplan in a worktree and tracks step-by-step completion
    Subagents:
    - architect-agent: defines per-step implementation strategy and expected file touch scope
    - coder-agent: executes plan steps and writes code while monitoring for drift
    - reviewer-agent: checks code quality and verifies conformance to the approved plan
    - committer-agent: performs the required git commits for completed implementation work
    - auditor-agent: runs end-to-end quality gates including fresh build and test verification
    - integrator-agent: pushes the branch, opens a PR, and confirms CI/check status
- *MERGE*:
    Skill: mechanically integrates completed IMPLEMENT changes back to `main` and cleans up worktree state

## Phases and Requirements
There are a number of requirements for running through the PLAN, IMPLEMENT, and MERGE phases of the TUG WORKFLOW. It must by *easy* for a human developer to:
- [R-01]: start a new PLAN phase at will at any time
- [R-02]: stop a working PLAN phase at will at any time
- [R-03]: resume a previously-started PLAN phase at will at any time
- [R-04]: start an IMPLEMENT phase for a VALIDATED PLAN at will at any time
- [R-05]: stop a working IMPLEMENT phase at will at any time
- [R-06]: start a MERGE of a completed PLAN at any time
- [R-07]: stop an in-progress MERGE at any time, provided it hasn't completed
- [R-08]: track the progress of a PLAN, IMPLEMENT, and MERGE phase as it proceeds, getting detailed information about:
    - which PLAN, IMPLEMENT, and MERGE phases are running
    - what any running SUBAGENT is doing at any moment
    - which STEP in a PLAN an IMPLEMENT phase is operating on at any time
    - the state of individual items in the PLAN STEP CHECKLISTS, where each one should be in one of three states: open/in-progress/completed
- [R-09]: be informed when they have made a logically-inconsistent request, e.g.:
    - IMPLEMENT work that has no VALIDATED PLAN
    - MERGE a PLAN that has not been completed
    - re-MERGE a completed PLAN

## Skill <=> Subagent Communication
Subagents need to communicate with each other, as follows:
- [C-01]: clarifier-agent -> author-agent (via PLAN skill): emits structured clarification (`questions`, `assumptions`, ambiguity analysis) from the raw idea, then PLAN skill combines that output with user answers and passes it forward as authoring context.
- [C-02]: author-agent -> critic-agent (via PLAN skill): writes/updates the tugplan document and returns plan metadata (`plan_path`, section/skeleton status), then PLAN skill sends the current plan artifact to critic-agent for validation and quality review.
- [C-03]: critic-agent -> author-agent (revision loop via PLAN skill): emits `issues` and a `recommendation` gate (approve/revise/reject), then PLAN skill either finalizes the plan or loops the critic feedback back into author-agent for another revision pass.
- [C-04]: architect-agent -> coder-agent (via IMPLEMENT skill + beads design): emits per-step strategy (`approach`, `expected_touch_set`, implementation steps, test plan, risks), IMPLEMENT skill persists it as step design data, and coder-agent reads that strategy as its implementation contract.
- [C-05]: coder-agent -> reviewer-agent (via IMPLEMENT skill + beads notes): emits concrete code changes plus execution evidence (`files_modified`, build/test report, drift assessment), IMPLEMENT skill persists the notes, and reviewer-agent consumes those notes to evaluate plan conformance and quality.
- [C-06]: reviewer-agent -> coder-agent (revision loop via IMPLEMENT skill): emits review findings (`issues`, conformance checks, `recommendation`), then IMPLEMENT skill either proceeds to commit on approval or routes findings back to coder-agent for targeted fixes.
- [C-07]: committer-agent -> IMPLEMENT skill state/progress: consumes approved step context and performs commit operations (`tugcode commit` / `git commit` paths), then returns commit and close metadata used by IMPLEMENT skill for progress tracking and step closure.
- [C-08]: auditor-agent -> coder-agent/integrator-agent (via IMPLEMENT skill gate): emits post-loop quality-gate results (`issues`, deliverable checks, `recommendation`) after fresh verification; IMPLEMENT skill routes failures back to coder-agent or allows publish handoff to integrator-agent.
- [C-09]: integrator-agent -> coder-agent/user completion path (via IMPLEMENT skill gate): emits publication outputs (`pr_url`, `ci_status`, check details) after push/PR/checks; IMPLEMENT skill treats this as final integration status and either closes successfully or loops CI failures back for fixes.

## PROBLEMS: As the code stands now, we have some big problems

### Beads and Skill <=> Subagent Communication

Beads URL: https://github.com/steveyegge/beads

Beads strongly prefers to keep a central database on the `git` main branch, which raises persistent problems when attempting to work to do work on during the IMPLEMENT phase on a `git worktree`. The MERGE phase struggles mightily trying to messy conflicts since both the main branch and the git worktree will have changed. We should be able to avoid these conflicts since the TUG WORKFLOW is known upfront. PROPOSED SOLUTION: We should *keep the main branch free of changes* from any IMPLEMENT phase.

Operationally, the Skill <=> Subagent Communication is orchestrator-mediated rather than direct agent-to-agent messaging: skills pass structured JSON between agents, persist step artifacts for downstream reads, and enforce handoff gates through each agent's `recommendation` output. All of this information is passed through Beads. Beads has design and notes fields that have been pressed into service to hold this information (with awkward impedence mismatches). Just getting this information written into beads resulted in a ridiculously long series of changes, which resulted in using the file system to write all the information we're storing in beads anyway, which defeats much of the purpose of using beads at all.
    - 2ba6c10 Reduce orchestrator overthinking in implement
    - 07b048d Move bead-write from agents to orchestrator
    - 372c249 Remove positional content args from bead CLIs
    - 4e24be1 Show explicit tool calls in bead-write instructions
    - c23504d Fix terminal hang from heredoc in agents
    - a5af8e4 Stop init from deleting .beads directories
    - 1878990 Bypass bd init worktree guard
    - 5d06f88 Fix bd init failure in git worktrees
    - 55a9493 Clean up stale beads-at-root artifacts
    - 76f3023 Clean up stale beads-at-root artifacts
    - 4d7ec4f Beads Improvements (#43)
    - dad5ab5 Add beads improvements plan and proposal

The IMPLEMENT phase must conform to [I-08], which mostly works, since bead opening and closing is simple and straightforward. However, the attempt to use beads for [I-09] as a single source of truth to store the progress of PLAN STEPs has failed. While it is being used as an essential part of the the Skill <=> Subagent Communication flow, this information is not sufficient enough to track the full richness of the PLAN and its STEPs. The result is that we have no way to offer the user [R-08], i.e. there is no way to visualize the open/in-progress/completed state of the CHECKLISTS for any PLAN STEP.

It has proven to be surprisingly difficult to get information from subagent to subagent. As described above, the thought was to use beads for this, allowing each subagent to interact with the beads system, but... to do so requires the use of the `bd` program, which Tug *always* mediates through `tugcode beads ...` (since I have been doubting beads for some time, I acted to isolate its use). Unfortunately, this involves the shell, or heredocs, or the filesystem. Again, refer back to that long list of git commits above.

## NEXT STEPS

All this means that while beads aims to be a "Distributed, git-backed graph issue tracker for AI agents," the effort to use it for Tug has failed. We need another solution. Maybe we roll something on our own? Maybe we use Dolt? https://github.com/dolthub/dolt

We must deliver on [I-01] through [I-11], [R-01] through [R-09], while maintaining [C-01] through [C-09]. What do we do?


## CONVERSATION

After writing the content above, I began a conversation with Claude Code (Opus 4.6) to discuss it.

Me: ❯ OK. We have some design work to do. Read over @dash/multi-agent-coordination.md. Dig in. Read the document. Read the code. Investigate. Ask clarifying questions. Start making some proposals about what we might do to improve this project to deliver on its goals and requirements. Let's solve this information flow problem with rock-solid solutions!
  ⎿  Read dash/multi-agent-coordination.md (113 lines)

Claude: Both agents are done. I now have a thorough understanding of the entire system. Let me lay out what I've found and my proposals.

  ---
Diagnosis: What's Actually Happening

After reading the roadmap, the skills, agents, Rust CLI commands, and core library, here's my understanding of the problem:

What Beads Does Today

Beads serves four roles in the IMPLEMENT phase:

1. Step state machine: open → closed (via bd close)
2. Dependency-aware ready queries: bd ready --parent <root> returns steps whose deps are all closed
3. Inter-agent data store: architect writes to design, coder writes to notes, reviewer appends to notes
4. Step identity: bead_mapping gives each step anchor a unique bead ID

Where Beads Fails

Reading the code tells the story clearly:

The temp file dance (SKILL.md:310-318): After every agent call, the orchestrator must:
1. Agent writes temp file _tmp_{bead_id}_strategy.md
2. Orchestrator runs tugcode beads append-design {bead_id} --content-file {path}
3. Orchestrator deletes temp file
4. If CLI fails, warn and continue (because "the agent's JSON output already contains all data needed")

That last point is damning — the beads write is acknowledged as redundant. The orchestrator already has the data in memory. It's writing to beads for persistence, but then telling itself it's OK if that persistence fails.

Checklist blindness (roadmap line 97): Beads tracks step open/closed, but each step has tasks, tests, and checkpoints — fine-grained checklists that beads can't model. There's no way to tell the user "Step 2: 4/7 tasks done, 2/3 tests passing, 1/1 checkpoint verified."

Worktree friction (beads.rs:229-234): Beads' bd init refuses to run in git worktrees. The code manually creates .beads/, bootstraps SQLite via bd --db <path> config set, then passes --db on every command. This was a multi-commit struggle.

Main branch pollution (roadmap line 81): Beads wants data on main. The IMPLEMENT phase works on a worktree branch. Merge creates conflicts on data that should have stayed local.

What's Actually Working Fine

- The plan phase — pure in-memory JSON between agents, no persistence needed
- The orchestration pattern — sequential agent spawning with persistent agent IDs works well
- The tugcode worktree create flow — creates worktree, branch, validates plan, returns structured JSON
- The tugcode commit command — atomic log-rotate + git-commit + bead-close

---
Proposal: Replace Beads with Tugstate

I'm proposing a JSON-file-based state system that lives entirely in the worktree. Here's the design:

Core Design

A single file: .tugtool/state.json in the worktree.

```text
.tugtree/tugplan__my-plan-20260223/
├── .tugtool/
│   ├── state.json          ← NEW: all coordination state
│   ├── tugplan-my-plan.md
│   ├── tugplan-skeleton.md
│   ├── log.md
│   └── config.toml
├── .beads/                  ← REMOVED
│   └── beads.db
└── (source code)
```

The state file tracks everything the orchestrator and user need:

```json
{
"version": 1,
"plan_path": ".tugtool/tugplan-my-plan.md",
"phase": "implement",
"created_at": "2026-02-23T10:00:00Z",
"updated_at": "2026-02-23T10:45:00Z",
"steps": [
  {
    "anchor": "step-0",
    "title": "Create API client",
    "status": "completed",
    "depends_on": [],
    "started_at": "2026-02-23T10:05:00Z",
    "completed_at": "2026-02-23T10:30:00Z",
    "commit_hash": "abc123d",
    "tasks": [
      { "text": "Create HTTP client struct", "status": "completed" },
      { "text": "Add retry logic", "status": "completed" }
    ],
    "tests": [
      { "text": "Unit test: retry backoff", "status": "completed" }
    ],
    "checkpoints": [
      { "text": "cargo test passes", "status": "completed" },
      { "text": "cargo clippy clean", "status": "completed" }
    ]
  },
  {
    "anchor": "step-1",
    "title": "Add caching layer",
    "status": "in_progress",
    "depends_on": ["step-0"],
    "started_at": "2026-02-23T10:31:00Z",
    "tasks": [
      { "text": "Implement cache store", "status": "completed" },
      { "text": "Add cache invalidation", "status": "in_progress" },
      { "text": "Wire up to API client", "status": "open" }
    ],
    "tests": [
      { "text": "Cache hit/miss test", "status": "open" }
    ],
    "checkpoints": [
      { "text": "cargo test passes", "status": "open" }
    ]
  }
]
}
```

Why This Works

Single orchestrator, sequential execution. There's one orchestrator process running agents one at a time. No concurrent writes means no need for SQLite locking or database transactions. A JSON file is perfectly atomic for this use case.

Delivers [R-08] completely. The state file tracks every checklist item at open/in_progress/completed granularity. tugcode status can render:

```text
  Step 0: Create API client [completed]
    Tasks:    2/2  ████████████ 100%
    Tests:    1/1  ████████████ 100%
    Checks:   2/2  ████████████ 100%

  Step 1: Add caching layer [in_progress]
    Tasks:    1/3  ████░░░░░░░░  33%
    Tests:    0/1  ░░░░░░░░░░░░   0%
    Checks:   0/1  ░░░░░░░░░░░░   0%
```

Eliminates the temp file dance. The orchestrator writes state directly after parsing agent JSON output. No temp files, no CLI calls, no filesystem intermediaries.

Worktree-local, main stays clean. The state file lives in .tugtool/ inside the worktree. When the branch is merged, the state file can be dropped (or kept as a record). No conflicts.

Debuggable. cat .tugtool/state.json | jq .steps[1].tasks instantly shows you what's happening.

New CLI Commands

```shell
tugcode state init <plan_path>     # Initialize state.json from plan's steps/checklists
tugcode state show [--json]        # Show progress (replaces `tugcode beads status`)
tugcode state next                 # Return next ready step (replaces `bd ready`)
tugcode state start <step-anchor>  # Mark step in_progress
tugcode state update <step-anchor> # Update checklist items for a step
tugcode state complete <step>      # Mark step completed with commit hash
```

What Changes in the Orchestrator

The implement skill (SKILL.md) changes minimally:
```text
┌────────────────────────────────────────────────────────────┬──────────────────────────────────────────────────────────────────┐
│                      Current (Beads)                       │                          New (Tugstate)                          │
├────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────┤
│ tugcode worktree create syncs beads                        │ tugcode worktree create calls tugcode state init                 │
├────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────┤
│ Returns bead_mapping, root_bead_id                         │ Returns all_steps, ready_steps (computed from state.json)        │
├────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────┤
│ After architect: tugcode beads append-design + delete temp │ After architect: tugcode state update step-0 --architect-done    │
├────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────┤
│ After coder: tugcode beads update-notes + delete temp      │ After coder: tugcode state update step-0 --tasks-completed t1,t2 │
├────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────┤
│ After reviewer: tugcode beads append-notes + delete temp   │ After reviewer: tugcode state update step-0 --tests-completed    │
├────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────┤
│ tugcode commit closes bead                                 │ tugcode commit calls tugcode state complete step-0               │
└────────────────────────────────────────────────────────────┴──────────────────────────────────────────────────────────────────┘
```

What About Inter-Agent Data?

Here's the key insight: the persistent agent pattern already solves this. The architect, coder, reviewer, and committer are each spawned once and resumed. They retain their full context. The coder doesn't read the architect's strategy from beads — the orchestrator passes it in the resume prompt.

The state file doesn't need to store agent outputs (approach, expected_touch_set, etc.). It stores progress state — what's done, what's in flight, what's next. Agent-to-agent data flows through the orchestrator's memory + the Task resume mechanism.

Migration Path

This can be done incrementally:

1. Phase 1: Add tugcode state commands + state.json schema. Keep beads working.
2. Phase 2: Update implement skill to write to state.json alongside beads. tugcode status reads state.json.
3. Phase 3: Remove beads writes from implement skill. tugcode worktree create stops syncing beads.
4. Phase 4: Remove beads code from tugcode CLI and tugtool-core.


Me: ❯ OK. This is a great analysis. I love how simple it is. The main limitation with this approach is that it isolates the IMPLEMENT phase to a single git worktree on a single machine. Does that make sense? There would never be any possibility of [R-04]: start an IMPLEMENT phase for a VALIDATED PLAN at will at any time. There is nothing in this requirement which says "... only if there are no other IMPLEMMENT phases running for that PLAN". We simply don't say that, and if we ever want to allow multiple IMPLEMENT phases to run at once that don't duplicate work, we would need a solution for [I-08] and [I-09], right? What do we do? There is no way in your proposal to do concurrent IMPLEMENT phases. What are your ideas for dealing with this?


Claude: ⏺ You're absolutely right, and this is the critical design question. Let me think through it.

The Concurrency Problem

With a JSON file in the worktree, there's no shared state. Two IMPLEMENT phases for the same plan can't coordinate:

Orchestrator A: reads state.json → sees step-0 ready → starts step-0
Orchestrator B: reads state.json → sees step-0 ready → starts step-0  ← DUPLICATE WORK

For [I-08] and [I-09] to work with concurrent IMPLEMENT phases, you need two things:
1. Shared state — visible to all orchestrators
2. Atomic claim — only one orchestrator can grab a step

Where the Shared State Lives

The state can't live in the worktree — each IMPLEMENT phase gets its own. It has to live in the repo root, where all worktrees can reach it:

```code
repo/
├── .tugtool/
│   ├── tugplan-foo.md
│   └── state.db              ← shared across all worktrees
├── .tugtree/
│   ├── worktree-A/           ← orchestrator A (claimed step-0, step-2)
│   └── worktree-B/           ← orchestrator B (claimed step-1, step-3)
```
 
Revised Proposal: Embedded SQLite

This changes my answer from JSON to SQLite — but not beads. A self-owned, embedded SQLite database with a schema designed for exactly what Tug needs.

Why SQLite instead of JSON:
- BEGIN EXCLUSIVE transaction = atomic claim. Two orchestrators racing for the same step: one wins, one retries.
- Concurrent reads are free (WAL mode).
- Still a single file (.tugtool/state.db), still debuggable (sqlite3 .tugtool/state.db "SELECT * FROM steps").
- No external binary — rusqlite compiles SQLite into the tugcode binary itself.

Why not beads:
- We own the schema. No impedance mismatch.
- No bd binary dependency.
- No worktree friction (beads refuses bd init in worktrees; we don't need to init per-worktree).
- Checklist items are first-class rows, not jammed into a text field.

Schema (draft)

```sql
-- One row per plan
CREATE TABLE plans (
  plan_path  TEXT PRIMARY KEY,
  status     TEXT NOT NULL DEFAULT 'active',  -- draft/active/done
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One row per step
CREATE TABLE steps (
  plan_path   TEXT NOT NULL REFERENCES plans(plan_path),
  anchor      TEXT NOT NULL,           -- "step-0", "step-1"
  title       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending/claimed/in_progress/completed
  claimed_by  TEXT,                     -- worktree_path of the claimer
  started_at  TEXT,
  completed_at TEXT,
  commit_hash TEXT,
  PRIMARY KEY (plan_path, anchor)
);

-- One row per dependency edge
CREATE TABLE step_deps (
  plan_path   TEXT NOT NULL,
  step_anchor TEXT NOT NULL,
  depends_on  TEXT NOT NULL,
  PRIMARY KEY (plan_path, step_anchor, depends_on),
  FOREIGN KEY (plan_path, step_anchor) REFERENCES steps(plan_path, anchor),
  FOREIGN KEY (plan_path, depends_on)  REFERENCES steps(plan_path, anchor)
);

-- One row per checklist item (task, test, or checkpoint)
CREATE TABLE checklist_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_path   TEXT NOT NULL,
  step_anchor TEXT NOT NULL,
  kind        TEXT NOT NULL,           -- 'task'/'test'/'checkpoint'
  text        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',  -- open/in_progress/completed
  updated_at  TEXT,
  FOREIGN KEY (plan_path, step_anchor) REFERENCES steps(plan_path, anchor)
);
```

The Atomic Claim Operation

This is the heart of [I-08]:

```sql
BEGIN EXCLUSIVE;

-- Find next ready step: pending, all dependencies completed
SELECT s.anchor FROM steps s
WHERE s.plan_path = ?
AND s.status = 'pending'
AND NOT EXISTS (
  SELECT 1 FROM step_deps d
  JOIN steps dep ON dep.plan_path = d.plan_path AND dep.anchor = d.depends_on
  WHERE d.plan_path = s.plan_path
    AND d.step_anchor = s.anchor
    AND dep.status != 'completed'
)
ORDER BY s.anchor
LIMIT 1;

-- Claim it
UPDATE steps SET status = 'claimed', claimed_by = ?, started_at = ?
WHERE plan_path = ? AND anchor = ? AND status = 'pending';

COMMIT;
```

Two orchestrators hitting this simultaneously: one gets the lock, claims the step, releases. The other gets the lock, finds no pending step (or a different one), claims that instead. No duplicate work.

CLI Commands

```shell
tugcode state init <plan_path>          # Parse plan, populate steps + deps + checklist_items
tugcode state next <plan_path>          # Atomic claim: returns next ready step or "none"
tugcode state start <plan> <step>       # Mark step in_progress (after claim)
tugcode state update <plan> <step>      # Update checklist items
tugcode state complete <plan> <step>    # Mark step completed + record commit hash
tugcode state show [plan] [--json]      # Progress view (replaces beads status)
```

What Changes for worktree create

Currently worktree create does beads init + sync + commit annotations. It would instead:

1. Call tugcode state init <plan> if the plan isn't already in the DB (idempotent)
2. Call tugcode state next <plan> to claim the first ready step
3. Return the step info to the orchestrator

No beads. No .beads/ directory. No bd binary. No SQLite in the worktree — the DB is in the repo root where all worktrees can see it.

Future: Multi-Machine

Right now this handles multiple orchestrators on one machine (multiple terminals, multiple worktrees). For multi-machine coordination later, the path is clear:

- tugcast already exists as a WebSocket server in the codebase
- Wrap the SQLite operations behind a thin API: POST /state/claim-step, POST /state/complete-step
- Remote orchestrators call tugcast instead of SQLite directly
- Same schema, same semantics, just networked

Or if the scale demands it, swap SQLite for Postgres — the schema and queries translate directly.

Summary of the Shift
```text
┌──────────────────────┬──────────────────────┬──────────────────────────┬─────────────────────────────┐
│                      │   Beads (current)    │ JSON (my first proposal) │      SQLite (revised)       │
├──────────────────────┼──────────────────────┼──────────────────────────┼─────────────────────────────┤
│ External binary      │ bd required          │ None                     │ None (rusqlite embedded)    │
├──────────────────────┼──────────────────────┼──────────────────────────┼─────────────────────────────┤
│ Concurrent IMPLEMENT │ Partially (bd ready) │ Impossible               │ Full atomic claims          │
├──────────────────────┼──────────────────────┼──────────────────────────┼─────────────────────────────┤
│ Checklist tracking   │ No                   │ Yes                      │ Yes (first-class rows)      │
├──────────────────────┼──────────────────────┼──────────────────────────┼─────────────────────────────┤
│ Lives in             │ Worktree .beads/     │ Worktree .tugtool/       │ Repo root .tugtool/         │
├──────────────────────┼──────────────────────┼──────────────────────────┼─────────────────────────────┤
│ Main branch clean    │ No                   │ Yes                      │ Yes (.gitignore the DB)     │
├──────────────────────┼──────────────────────┼──────────────────────────┼─────────────────────────────┤
│ Debuggable           │ bd show CLI          │ cat | jq                 │ sqlite3 CLI                 │
├──────────────────────┼──────────────────────┼──────────────────────────┼─────────────────────────────┤
│ Multi-machine path   │ None                 │ None                     │ tugcast wrapper or Postgres │
└──────────────────────┴──────────────────────┴──────────────────────────┴─────────────────────────────┘
```

The core insight you're pushing on is right: the coordination state must be shared and atomic. A JSON file can't give you that. SQLite can, without the pain of beads.

What do you think? Does this address the concurrency concern while staying simple enough?


Me: ❯ OK. If we are going to use a central database in the repo root, then:
    - How do we merge? How do we avoid all the messy merge mechanics we were able to eliminate in .tugtool/tugplan-beads-improvements.md and 4d7ec4f?
    - Why SQLite? Why not Dolt? https://github.com/dolthub/dolt. What would Dolt give us that SQLite doesn't? Anything worth having?

Claude: Two sharp questions. Let me address both.

Merge: How Do We Avoid the Mess?

The beads merge problem was: beads kept its SQLite DB committed to git on both the main branch and the worktree branch. Both sides changed the DB. Git can't merge binary files. Conflict every time.

The solution is straightforward: never commit the state DB to git.

```gitignore
# .gitignore
.tugtool/state.db
.tugtool/state.db-wal
.tugtool/state.db-shm
```

The state DB is an operational artifact, not source code. It's like a build cache or a .env file — present on disk, not tracked by git. Here's why this works:

What gets committed to git (on the worktree branch):
- Source code changes (the actual implementation)
- The plan file (.tugtool/tugplan-foo.md) — unchanged during IMPLEMENT
- The implementation log (.tugtool/log.md)

What stays out of git (repo-root only):
- .tugtool/state.db — coordination state

When you merge the worktree branch back to main, there's no state DB on either side. No binary merge conflict. The merge is purely about source code, which is what git merge is good at.

What about the state after merge? Once all steps are completed and merged, tugcode state complete-plan marks the plan as done in the DB. The DB remains in the repo root as a record of what happened. If you want to clean it up, tugcode state prune --done can remove completed plan data.

What about the plan file checkboxes? Currently beads-pull writes checkbox state back into the plan markdown. With tugstate, the plan file stays clean — it's the specification. The state DB is the execution record. If you want to see progress, you ask tugcode state show, not cat tugplan.md | grep checkbox. This is actually cleaner — the plan is immutable during implementation, which eliminates another class of merge conflict.

Why SQLite? Why Not Dolt?

Let me look at what Dolt actually offers.

⏺ Fetch(https://github.com/dolthub/dolt)
  ⎿  Received 488.6KB (200 OK)

⏺ OK, now I can give you a proper comparison.

Dolt: What It Gives You

Dolt is genuinely interesting for this problem space. Its pitch maps almost directly to Tug's world:

- Branch/merge for data: Each worktree could have its own Dolt branch. Step claims, checklist updates, agent data — all versioned per-branch, mergeable.
- SQL + version control: SELECT * FROM steps AS OF 'main' — query the state as it was on any branch.
- Conflict resolution for data: If two branches both update steps row for step-3, Dolt gives you a merge conflict in SQL that you resolve with SQL, not by hand-editing binary files.
- Audit trail for free: Every state change is a Dolt commit with a timestamp and message. dolt log shows the full history of step claims and completions.

Dolt: Why I'd Avoid It

103MB binary. That's the Dolt executable. tugcode is probably a few MB. Adding a 103MB dependency that must be installed separately is a huge ask.

External server process. Dolt runs dolt sql-server on port 3306. You'd need to start it, manage it, handle crashes, deal with port conflicts. Beads had a lighter version of this problem (the daemon that you disabled with BEADS_NO_DAEMON=1). Dolt's is worse — it's a full MySQL-compatible server.

Cannot be embedded. Unlike SQLite (which compiles into your binary via rusqlite), Dolt is a standalone Go binary. You can't link it into tugcode. Every operation requires spawning a subprocess or connecting over TCP. This is the exact same friction class as beads: shell out to external binary, parse output, handle failures.

Overkill for the data model. Tug's state is small. A plan has maybe 5-15 steps, each with 3-10 checklist items. That's ~100 rows total. Dolt's branching/merging superpowers shine for tables with millions of rows where you need to reconcile divergent edits. For 100 rows managed by a known orchestration pattern, it's bringing a tank to a knife fight.

The branching model doesn't match. Dolt branches data. Git branches code. You'd now have two branching systems to keep in sync. When orchestrator A works on worktree branch tugplan/foo-A, does it also need a Dolt branch foo-A? When do you merge the Dolt branch? Before or after the git merge? This adds coordination complexity rather than removing it.

SQLite: What It Actually Gives You

Zero deployment friction. rusqlite compiles SQLite directly into the tugcode binary. No external install. No server process. No port. No daemon. Just tugcode state next and it opens the file, runs the query, closes it.

Proven concurrent access. WAL mode handles multiple readers + one writer. BEGIN EXCLUSIVE serializes claims. This is battle-tested — SQLite handles more concurrent access daily than any other database engine on Earth.

Atomic operations without networking. The claim operation is a local filesystem transaction. Sub-millisecond. No TCP connection, no server round-trip.

Tiny. SQLite adds ~1MB to the binary. The state DB for a plan will be a few KB.

Inspectable. sqlite3 .tugtool/state.db "SELECT anchor, status FROM steps" — any developer can poke at it. Or we provide tugcode state show for the pretty version.

The Multi-Machine Question

The one thing Dolt genuinely offers that SQLite doesn't: push/pull data between machines. But:

1. You don't need this today.
2. When you do, tugcast already exists as a WebSocket server in the codebase. Wrapping tugcode state claim behind a tugcast endpoint is a much lighter path to multi-machine than adopting Dolt.
3. Or if you truly need a shared database, Postgres is a more standard, better-supported choice than Dolt for that role.

My Recommendation

Stick with embedded SQLite (via rusqlite). It's:
- Zero external dependencies (compiled into tugcode)
- No server, no daemon, no port, no process management
- Atomic concurrent access for multiple IMPLEMENT phases on one machine
- A clear upgrade path (tugcast wrapper or Postgres) when multi-machine is needed
- The state DB lives in the repo root, never committed to git, no merge conflicts

Dolt is a fascinating project, but it solves a harder problem than Tug has. The cost of adopting it (103MB binary, external server, subprocess friction) repeats many of the same pain points that made beads fail.

What's your take?


Me: ❯ I hear you about Dolt. "Dolt is a fascinating project, but it solves a harder problem than Tug has." Agreed.

I think a gitignored SQLite DB in the repo root hits the sweet spot. Basically, I'm willing to say that for [I-08] and [I-09] in @dash/multi-agent-coordination.md that *atomically* is revised to mean *atomically on one machine*. Right now, we don't have a multi-machine/multi-developer requirement for Tug. If we do someday, we'll cross that bridge when we come to it.

So, write a complete proposal to the @dash/ directory to implement the SQLite idea. Base your work on @dash/multi-agent-coordination.md and @dash/multi-agent-coordination-chat.md. Dig in. Cover all the bases. Think of potential problems we haven't thought of yet (if any). Write the proposal in such a way that we can add this work in one phase, then remove the dependence on beads in a second step. Basically, we avoid the chicken-and-egg problem by using the current beads-based infrastructure to add this new SQLite-based mechanism, then use it for the first time to remove the beads-based infrastructure. Does that make sense? I should be able to write two tugplans that we run one after the other to accomplish this. Make sense?


