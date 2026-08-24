# Handoff: live subagent content in the Agent block

**Status:** partial. The deck-side foundation is landed; the tugcode live-tail
and the TaskToolBlock rendering remain. This doc is a self-contained pickup
for a fresh session.

---

## The problem

When Claude Code runs an **`Agent` in the background** (async), the agent's
child tool calls (Bash/Read/…) and its final answer are persisted **out of
band** — in `~/.claude/projects/<enc>/<sessionId>/subagents/agent-<agentId>.jsonl`
(+ an `agent-<agentId>.meta.json` sidecar carrying the launching
`toolUseId`). They are **never** in the parent session's stream/JSONL. Verify
on session `3dd6f61a-ad0d-47e3-85f8-0448e96aa5b2`: the main JSONL has only the
`Agent` `tool_use` + the async-launch echo (`isAsync: true`,
`agentId: aab9c08ad28ba7eac`); all ~30 child calls live only in the subagent
file. (Also see `1c53fe86-…`.)

Three symptoms the user reported, all from this one fact:

1. **Live = a one-line summary.** Live, the deck only gets `task_progress`
   (counts), so the expanded Agent block falls back to the `AgentWorkingBody`
   one-liner (`Bash · 9 tools · 35.7K tokens`). **The user never wants a
   one-line summary** — they want the real broken-out child blocks streaming
   in. Live simply has no child detail today.
2. **Reload ≠ live, and "fills in more" each reload.** A prior change (already
   on `main`) makes tugcode's **resume** path read the subagent file and
   splice the children in, so `Maker ▸ Reload` shows blocks. But the agent is
   often still running and the file keeps growing, so each reload shows a
   longer snapshot — inconsistent, and you must reload to see progress.
3. **A dangling "final answer" fragment.** For a still-running agent,
   `composeAgentStructuredResult` (tugcode `replay.ts`) picks the *last
   text-only assistant entry* as the "final answer" — which is an
   intermediate `Excellent! Now let me get the test files list:` line, shown
   with a trailing colon as if content were truncated.

### Root cause (the load-bearing one)

A backgrounded agent runs **after its launching turn has committed**, so its
child frames arrive **inter-turn**. The deck reducer's turn handlers
(`handleToolUse` / `handleToolResult` / `handleToolUseStructured`) bail on the
first line when the phase isn't content-bearing (`idle`), so **any child that
arrives after its parent turn committed is dropped.** Even a perfect tugcode
tailer would have its frames thrown on the floor without a reducer change.

---

## Decided architecture (Path B)

Background children flow through the **job ledger** — the inter-turn state
carrier the Agent block already subscribes to via
`useJobForToolUse(session, toolUseId)`. **Not** by mutating committed turns
(the transcript is append-only + effect-driven; mutating it inter-turn risks
[L26] mount identity + windowing). Committed turns stay immutable.

- tugcode emits the **same** `parent_tool_use_id` child frames the resume
  splice already produces (`synthesizeSubagentChildFrames`, `replay.ts`).
- The reducer routes a parent-linked child onto `JobItem.childCalls`
  **iff a job owns the parent** — which is true only for background agents
  (a foreground agent returns its answer and never creates a job, so its
  streamed children still attach to the live turn as before).
- `TaskToolBlock` merges `job.childCalls` into its transcript entries, so
  live children render identically to a resume's, and the two converge.

This is proven — see "What's done."

---

## What's done (this branch, commit `90c492287`, merged to `main`)

Deck reducer foundation — routes inter-turn background children onto the job:

- `tugdeck/src/lib/code-session-store/select-jobs.ts`:
  - `JobItem.childCalls?: readonly ToolUseMessage[]` and
    `JobItem.agentStructuredResult?: unknown`.
  - `jobExistsForParent(jobs, parentToolUseId)` — "is this a tracked
    background agent?"
  - `jobIdForChild(jobs, childToolUseId)` — route a child's later
    `tool_result`/`tool_use_structured` to the job that holds its `tool_use`.
  - `applyJobChildToolUse` / `applyJobChildResult` / `applyJobAgentStructured`
    — fold children + the composed answer onto the job (dedup by id).
- `tugdeck/src/lib/code-session-store/reducer.ts`: `handleToolUse` /
  `handleToolResult` / `handleToolUseStructured` each route to the job (before
  their phase bail) when a job owns the parent; `isAsyncLaunchEcho` keeps the
  async echo from overwriting the composed answer.
- Test (real store, real 2.1.197 frame shapes):
  `tugdeck/src/__tests__/live-subagent-children.test.ts` — 4 pass.

Also already on `main` from prior work — the **resume** splice that makes
reload show children (`replay.ts`: `synthesizeSubagentChildFrames`,
`spliceSubagentChildren`, `composeAgentStructuredResult`,
`collectAsyncAgentToolUseIds`; `session.ts`: `readSubagentTranscripts`,
`subagentsDirFor`, threaded into `ReplayInput.ok.subagents`). Reuse
`synthesizeSubagentChildFrames` for the live tailer.

---

## What's left (the proposed solution)

### A. Deck: render `job.childCalls`, kill the one-liner

In `tugdeck/src/components/tugways/cards/blocks/task-tool-block.tsx`:

- Merge `job.childCalls` into the child calls fed to
  `composeAgentTranscriptData` (dedup by `toolUseId` against the existing
  `childToolCallsByParent.get(toolUseId)`).
- Prefer `job.agentStructuredResult` over the launching call's
  `structuredResult` (which for a bg agent is just the async echo) for the
  final answer + footer stats.
- **Remove the `AgentWorkingBody` one-liner path.** Body should be keyed only
  on `hasEntries`; when there are no entries yet, render an empty body (header
  only), never a summary.

> ⚠️ **GOTCHA — do the cycle fix FIRST, as its own change.** Removing the
> `AgentWorkingBody` *import* reorders module init and exposes a **latent
> circular import** that crashes `task-tool-block.test.ts` in isolation (the
> full suite passes because another file loads the dispatch module first):
>
> `task-tool-block → agent-transcript-block → dev-assistant-renderer-dispatch`
> — and `dispatch` imports *all* block components (incl. `TaskToolBlock`) to
> build `BESPOKE_REGISTRATIONS` at module-eval → **TDZ `ReferenceError:
> Cannot access 'TaskToolBlock' before initialization`**.
>
> **Proper fix (separate, verified change — NOT mixed into the feature):**
> split the registration *wiring* out of the dispatch *mechanism*:
> - New `dev-assistant-renderer-registrations.ts`: imports the 18 block
>   components + `registerToolBlock`, holds `BESPOKE_REGISTRATIONS`,
>   `BESPOKE_TOOL_NAMES`, `BESPOKE_FACTORY_BY_NAME`, `hasBespokeWrapper`, and
>   runs the registration loop.
> - `dev-assistant-renderer-dispatch.ts`: keeps only the mechanism (registry,
>   `registerToolBlock`, `resolveToolBlock`, `dispatchToolCallState`,
>   `TOOL_ALIASES` — export it —, drift detection, `DefaultToolBlock`
>   fallback). Imports **no** block components.
> - Add a side-effect `import "./dev-assistant-renderer-registrations"` at the
>   render root (`dev-card-transcript.tsx`) so registration runs.
> - Repoint the ~14 test files + `dev-tool-visibility-policy.ts` +
>   `dev-permission-dialog.tsx` that import `BESPOKE_*` / `hasBespokeWrapper`
>   to the registrations module.
>
> This kills the cycle permanently. It was attempted inline with the feature
> and correctly abandoned as too entangled to mix — land it standalone,
> green in isolation *and* full suite, then do the one-liner removal.

### B. tugcode: live-tail the subagent file

New module (e.g. `tugcode/src/subagent-tail.ts`): on async-launch detection,
**poll-tail** `subagentsDirFor(...) / agent-<agentId>.jsonl` from a byte
offset (fs.watch is flaky for appends on macOS — poll every ~250ms), parse
new complete lines, reuse `synthesizeSubagentChildFrames` to emit
`parent_tool_use_id`-tagged child frames, and `writeLine` them live. On
completion, compose the final answer **only when the agent has genuinely
finished** (fixes symptom #3 — don't surface an intermediate
`let me do X:` line as the answer).

### C. tugcode: wire the tailer into the live loop

In `session.ts` `handleClaudeLine`: detect the async-launch echo
(`toolUseResult.isAsync === true` / `status: "async_launched"`, giving the
parent `tool_use_id` + `agentId`) → **start** a tailer; on
`wake_started` / `task_updated{completed}` for that agent, or claude exit →
**stop** + final flush.

### D. Live verify with a REAL background agent

Rebuild the debug app (`just app-debug` from the worktree — tugcode is a
compiled binary), launch a real background agent, and watch the child blocks
**stream in live** under the Agent block, no one-liner, matching a reload.
`test-42-bg-agent-progress` (real-claude,
`TUG_REAL_CLAUDE=1 TUG_PROBE_FILTER=… capture_all_probes`, inspection-only) is
a wire-level check. **Do not** validate with a completed fixture — the
live-streaming and still-running bugs only surface with a real running agent.

---

## Lessons (why the prior attempt derailed)

- The resume-only work (on `main`) is **half** the feature. Fixing reload
  without fixing live created the live≠reload contradiction. Ship both.
- **Don't delete `AgentWorkingBody` as part of this feature** — it detonates
  the latent dispatch cycle. Fix the cycle standalone (section A gotcha),
  then remove the one-liner.
- Verify against the **running app with a real background agent**, not a
  completed captured fixture — fixtures can't reveal live-streaming gaps or
  the still-running final-answer fragment.
