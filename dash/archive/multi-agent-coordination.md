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

- Beads URL: https://github.com/steveyegge/beads

- Beads strongly prefers to keep a central database on the `git` main branch, which raises persistent problems when attempting to work to do work on during the IMPLEMENT phase on a `git worktree`. The MERGE phase struggles mightily trying to messy conflicts since both the main branch and the git worktree will have changed. We should be able to avoid these conflicts since the TUG WORKFLOW is known upfront. PROPOSED SOLUTION: We should *keep the main branch free of changes* from any IMPLEMENT phase.

- Operationally, the Skill <=> Subagent Communication is orchestrator-mediated rather than direct agent-to-agent messaging: skills pass structured JSON between agents, persist step artifacts for downstream reads, and enforce handoff gates through each agent's `recommendation` output. All of this information is passed through Beads. Beads has design and notes fields that have been pressed into service to hold this information (with awkward impedence mismatches). Just getting this information written into beads resulted in a ridiculously long series of changes, which resulted in using the file system to write all the information we're storing in beads anyway, which defeats much of the purpose of using beads at all.
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

- The IMPLEMENT phase must conform to [I-08], which mostly works, since bead opening and closing is simple and straightforward. However, the attempt to use beads for [I-09] as a single source of truth to store the progress of PLAN STEPs has failed. While it is being used as an essential part of the the Skill <=> Subagent Communication flow, this information is not sufficient enough to track the full richness of the PLAN and its STEPs. The result is that we have no way to offer the user [R-08], i.e. there is no way to visualize the open/in-progress/completed state of the CHECKLISTS for any PLAN STEP.

- It has proven to be surprisingly difficult to get information from subagent to subagent. As described above, the thought was to use beads for this, allowing each subagent to interact with the beads system, but... to do so requires the use of the `bd` program, which Tug *always* mediates through `tugcode beads ...` (since I have been doubting beads for some time, I acted to isolate its use). Unfortunately, this involves the shell, or heredocs, or the filesystem. Again, refer back to that long list of git commits above.

## NEXT STEPS

All this means that while beads aims to be a "Distributed, git-backed graph issue tracker for AI agents," the effort to use it for Tug has failed. We need another solution. Maybe we roll something on our own? Maybe we use Dolt? https://github.com/dolthub/dolt

We must deliver on [I-01] through [I-11], [R-01] through [R-09], while maintaining [C-01] through [C-09]. What do we do?







