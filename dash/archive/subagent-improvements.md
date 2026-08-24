<!-- devise-skeleton v4 -->

## Live + reload subagent content under the Agent block {#subagent-improvements}

**Purpose:** Make a background `Agent`'s child tool calls and final answer render as
real, broken-out blocks **under** the launching Agent block — streaming in **live** as
the agent runs, and reconstructed **identically** on reload/resume from JSONL — instead
of the current one-line summary (live) and inconsistent, grows-each-reload snapshot
(reload).

---

### Kickoff for a fresh session (read this first) {#kickoff}

> Orientation notes from the author to whoever implements this. The design is below;
> this is how to get your bearings fast and avoid re-doing the investigation.

**What's already landed on `main` (do NOT rebuild it):** the reducer child-routing
foundation and the resume splice. Commit `a8ce58e28` added the reducer routing
(`applyJobChildToolUse` / `applyJobChildResult` / `applyJobAgentStructured`,
`jobExistsForParent`, `jobIdForChild`, `isAsyncLaunchEcho`) + `select-jobs.ts` +
`live-subagent-children.test.ts` (4 pass). The resume splice
(`synthesizeSubagentChildFrames`, `spliceSubagentChildren`,
`composeAgentStructuredResult`, `readSubagentTranscripts`) is on `main` too. Note
`a8ce58e28`'s commit *message* says "live-tail" but it did **not** touch tugcode — the
tailer does not exist yet. `grep -rl subagentTail tugcode/src` returns nothing; that's
your Step 3/4.

**Read, in this order, to get oriented:** (1) this plan end-to-end; (2)
[`live-subagent-content-handoff.md`](live-subagent-content-handoff.md) — the prior
investigation, still accurate on the symptoms + the two traps; (3) the code anchors
below. Then start at [#step-1].

**Verified code anchors (grep the symbol — line numbers drift):**
- Live async echo → `session.ts` `routeTopLevelEvent` `case "user"`: reads
  `event.tool_use_result` (**snake_case** — the JSONL uses camelCase `toolUseResult`);
  the real echo carries `agentId`, `outputFile` (= `…/tasks/<agentId>.output`, the live
  file per [P02]), `isAsync`/`status: "async_launched"`, and the linked parent
  `tool_use_id`. This is your tailer start-trigger ([#step-4]).
- Live job insert → `reducer.ts` `handleToolResult`, via
  `parseBackgroundLaunchResult(mutated.result)` matching the `tool_result` **output
  string** `"Async agent launched successfully.\nagentId: …"`. Gated `!isReplaying` —
  which is exactly why reload starts with an empty ledger and why [P08] exists.
- Inter-turn child routing → `reducer.ts` `handleToolUse` / `handleToolResult` /
  `handleToolUseStructured`, each routing to the job *before* the content-bearing bail.
- The [P08] re-hydration seam → `reducer.ts` `handleTaskProgress` (phase-independent) +
  `select-jobs.ts` `applyJobProgress`. `TaskProgressEvent` carries `taskId` (= `jobId`)
  + `toolUseId` (the launching Agent call).
- Block → `blocks/task-tool-block.tsx` (currently reads only `childToolCallsByParent`
  and renders `AgentWorkingBody`; that's [#step-2]).
- The cycle → `dev-assistant-renderer-dispatch.ts` imports all ~20 block components at
  module-eval and runs the registration loop at bottom-of-file; `agent-transcript-block`
  imports `dispatchToolCallState` from it → the cycle removing `AgentWorkingBody`
  detonates ([P03], [#step-1]).

**Three traps that will cost you a day if you miss them:**
1. **Do [#step-1] (cycle fix) first, standalone, green in isolation.** Canary:
   `cd tugdeck && bun test task-tool-block.test.ts` must pass **run alone** (the full
   suite masks the cycle because another file loads dispatch first).
2. **Verify with a REAL running background agent** (`just app-debug`, launch one, watch),
   never a completed fixture — the live-streaming and reload-mid-run symptoms only exist
   while an agent is actually running. Fixtures can't reveal them.
3. **Reload-mid-run is the sharp edge** ([Q03] → [P08]/[P09], Risk [R03]). The job
   ledger is empty after replay, so a still-running tailer's children get dropped until
   the job re-hydrates. This is decided, not open — but it's the thing most likely to be
   subtly wrong. Test it explicitly.

**Commands:** deck — `cd tugdeck && bun test` + `bunx vite build` (memory: the debug app
loads the rollup bundle, so `vite build` before declaring a deck change done); tugcode
(compiled binary — rebuild for any live check) — `cd tugcode && bun test`, then
`just app-debug`; workspace — `cd tugrust && cargo nextest run`. Warnings are errors.

**Scope discipline:** two `.tsx` files (`dev-card.tsx`, `tug-prompt-entry.tsx`) were
already dirty in the tree when this plan was committed (unrelated inflight work) — leave
them alone.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-07-01 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

When Claude Code runs an `Agent` **in the background** (`run_in_background: true`), the
agent's child tool calls (Bash/Read/…) and its final answer are persisted **out of
band** — in a live-growing `tasks/<agentId>.output` JSONL file (and, on/after
completion, a durable `subagents/agent-<agentId>.jsonl` + `.meta.json` copy). They are
**never** in the parent session's stream or main JSONL. Three symptoms follow from that
one fact, all grounded in session `3dd6f61a-ad0d-47e3-85f8-0448e96aa5b2` (see
[`live-subagent-content-handoff.md`](live-subagent-content-handoff.md)):

1. **Live shows a one-line summary** (`Bash · 9 tools · 35.7K tokens`) because the deck
   only receives `task_progress` counts — never the child detail. The user never wants
   the summary; they want the streamed blocks.
2. **Reload ≠ live, and "fills in more" each reload.** The resume splice (already on
   `main`) reads the durable `subagents/` file and reconstructs children, so reload
   shows blocks — but a still-running agent's file keeps growing, so each reload shows a
   longer snapshot.
3. **A dangling "final answer" fragment.** For a still-running agent,
   `composeAgentStructuredResult` picks the *last text-only assistant entry* — an
   intermediate `Excellent! Now let me…:` line — and shows it as the answer.

The **deck-side foundation is already landed** (reducer routes inter-turn children onto
the job ledger; resume splice reconstructs children on reload). What remains is the
live wire path (tugcode tailer) and the block rendering — plus a standalone
circular-import fix that the rendering change would otherwise detonate.

#### Strategy {#strategy}

- **Fix the latent dispatch circular import first, standalone.** Removing the
  `AgentWorkingBody` import from `TaskToolBlock` reorders module init and exposes a
  latent cycle (`task-tool-block → agent-transcript-block → dev-assistant-renderer-dispatch
  → TaskToolBlock`). Split registration wiring out of the dispatch mechanism as its own
  green commit before touching the feature.
- **Render `job.childCalls` + `job.agentStructuredResult`**, then delete the one-liner.
  The reducer already accumulates both; the block just has to read them.
- **Tail the live file in tugcode** using the `outputFile` path the async echo hands us
  — reusing the exact `synthesizeSubagentChildFrames` the resume splice emits, so live
  and reload produce byte-identical frame shapes and converge on one job ledger.
- **Compose the final answer only on genuine completion**, tied to the same completion
  signal tugcode already forwards (`task_updated{completed}` / `wake_started`).
- **Verify against a real running background agent**, never a completed fixture — the
  live-streaming and still-running symptoms only surface live.

#### Success Criteria (Measurable) {#success-criteria}

- Launching a real background agent shows its child tool calls (Bash/Read/…) appearing
  **incrementally** under the Agent block **without any reload**, each as a real
  broken-out block (verify: `just app-debug`, launch a bg agent, watch blocks stream).
- The Agent block **never** renders the `AgentWorkingBody` one-line summary in any state
  (verify: `grep -c AgentWorkingBody task-tool-block.tsx` → 0; the symbol/file is gone).
- After the agent finishes, `Maker ▸ Reload` (and a fresh load from the session picker)
  reconstructs the **same** child blocks + final answer the live run showed — no
  grows-each-reload, no dangling `…:` fragment (verify: reload twice, diff the rendered
  block count + final answer text; identical).
- Reloading **while the agent is still running** keeps live streaming alive: children
  continue to appear after the reload with no further reload needed, no dupes (verify:
  launch a bg agent, reload mid-run, watch new child blocks arrive under the Agent block).
- A still-running agent's Agent block shows **no** "final answer" until it genuinely
  completes (verify: mid-run, the body has child blocks but no answer paragraph/footer).
- `task-tool-block.test.ts` passes **in isolation** (`bun test task-tool-block.test.ts`)
  and in the full deck suite — proving the cycle is gone.
- `cd tugrust && cargo nextest run`, `bun test` (tugcode + tugdeck), and
  `bunx vite build` (tugdeck) all pass with zero warnings.

#### Scope {#scope}

1. Standalone dispatch circular-import fix (split registrations from mechanism).
2. `TaskToolBlock` renders `job.childCalls` + prefers `job.agentStructuredResult`;
   `AgentWorkingBody` one-liner removed.
3. New tugcode `subagent-tail` module: poll-tail the agent's live `outputFile`, reuse
   `synthesizeSubagentChildFrames`, emit `parent_tool_use_id` child frames live.
4. Wire the tailer into the session loop: start on async-launch echo, stop + final-flush
   on genuine completion or claude exit.
5. Live verification with a real background agent, plus a wire-level tugcast probe.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Changing the **resume splice** (`replay.ts` / `readSubagentTranscripts`) — it stays as
  the reload authority; the tailer reuses its helpers, it does not replace them.
- Mutating committed turns to carry children (rejected in favor of the job ledger — see
  [P01]). The transcript stays append-only.
- Persisting anything to disk from tugcode — Claude Code owns writing both the
  `tasks/*.output` and `subagents/*` files; the tailer only reads.
- Foreground (synchronous) agents — their children already stream inline on the turn and
  attach to the live turn unchanged; no job, no tailer.
- `task_progress` count ticks — they keep flowing for the JOBS cell; they are simply no
  longer the Agent block's only content.

#### Dependencies / Prerequisites {#dependencies}

- Landed foundation on `main`: reducer child-routing (`applyJobChildToolUse` /
  `applyJobChildResult` / `applyJobAgentStructured`, `jobExistsForParent`,
  `jobIdForChild`, `isAsyncLaunchEcho`) and the resume splice
  (`synthesizeSubagentChildFrames`, `spliceSubagentChildren`,
  `composeAgentStructuredResult`, `collectAsyncAgentToolUseIds`, `readSubagentTranscripts`,
  `subagentsDirFor`).
- tugcode is a **compiled binary** — the debug app must be rebuilt (`just app-debug`)
  to pick up tailer changes; HMR does not cover it.

#### Constraints {#constraints}

- **Warnings are errors** (Rust `-D warnings`; tugcode/tugdeck TS strict).
- **Tuglaws** for the deck change — appearance via CSS/DOM not React state [L06];
  external state through `useSyncExternalStore` only [L02]; no `root.render` churn [L01].
- `fs.watch` is unreliable for file *appends* on macOS — the tailer must **poll** from a
  byte offset, not watch.
- Reading the live `outputFile` via the shell is explicitly forbidden by Claude Code (it
  overflows the agent's context); tugcode reading it out-of-band from disk is fine and is
  exactly what the resume path already does with the durable copy.
- The tailer must never throw into the stdout drain (an unhandled error there kills the
  session loop) — best-effort, guarded, same posture as `readSubagentTranscripts`.

#### Assumptions {#assumptions}

- The async-launch echo (`user` entry, `toolUseResult.isAsync === true` /
  `status: "async_launched"`) carries `agentId` + `outputFile` + a linked
  `tool_result.tool_use_id` (the parent Agent call) — verified against the raw
  `subagent-resume/main.jsonl` fixture.
- `tasks/<agentId>.output` is valid JSONL in the same per-entry shape as
  `subagents/agent-<agentId>.jsonl` (same `message.content` blocks) — so
  `synthesizeSubagentChildFrames` consumes it unchanged. (Confirmed structurally from
  the durable copies on disk; the live growth is confirmed in [#step-6].)
- The tugcode session **persists across a deck reload** (reconnect via `--resume`), so a
  running tailer survives a `Maker ▸ Reload` and continues from its byte offset.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

Anchors are explicit and kebab-case; step anchors are `#step-N`; plan-local decisions
are `[P01]`+ (`#pNN-…`); questions `[Q01]`+ (`#qNN-…`); risks `Risk R01`+ (`#rNN-…`).

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Which on-disk file grows live, and is it the same JSONL shape? (OPEN) {#q01-live-file}

**Question:** Does the agent's `tasks/<agentId>.output` file (the echo's `outputFile`)
grow **incrementally** during the run and parse as the same per-entry JSONL as the
durable `subagents/agent-<agentId>.jsonl`? And is the durable `subagents/` pair
(`.jsonl` + `.meta.json`) present **mid-run**, or only at/after completion?

**Why it matters:** It decides which path the tailer polls. If `outputFile` is the live
one (as the echo's own documentation states) the tailer tails it directly from the echo
— no dir-scan, no `.meta.json`. If instead `subagents/` is written live, the report's
original suggestion holds. Getting it wrong means the tailer polls a file that never
grows and live stays broken.

**Options (if known):**
- Tail `outputFile` from the echo (authoritative path, no meta needed — leaning).
- Tail `subagentsDirFor(...)/agent-<agentId>.jsonl` (report's original suggestion).

**Plan to resolve:** Spike in [#step-6] with a real running background agent — `ls -la`
both paths while the agent runs, `tail -f` the growing one, confirm JSONL shape. On this
machine the `tasks/` dirs are present-but-empty post-run and `subagents/` persists,
which already points at `outputFile` as the live file.

**Resolution:** RESOLVED in [#step-6]. `tasks/<agentId>.output` is a **symlink** to the
durable `subagents/agent-<agentId>.jsonl` — one live-growing file, two paths, identical
JSONL shape (verified live on claude 2.1.198: both present from launch, the jsonl grows
during the run, the symlink persists after completion). Tailing the echo's `outputFile`
([P02]) is correct and equivalent to tailing the durable copy; the resume path keeps
reading `subagents/` unchanged. Live verification: child frames streamed inter-turn,
frames byte-identical to the resume splice's (same synthesizer).

#### [Q02] Completion signal for "genuinely finished" (OPEN) {#q02-completion-signal}

**Question:** What is the authoritative wire signal that a background agent has genuinely
completed (so the tailer composes + emits the final answer)? Candidates:
`task_updated{status: completed}` for the agent's task id, the completion `wake_started`
(idle-completion), or a terminal entry in the `.output` JSONL.

**Why it matters:** Composing too early reproduces symptom #3 (dangling `…:` fragment);
never composing leaves the block answer-less after completion. It also decides the
tailer's stop trigger.

**Options (if known):**
- `task_updated{completed}` keyed by agent/task id (deck already flips the job on this).
- Completion `wake_started` carrying the agent's `output_file` (seen in the bg-agent
  fixture at the tail).
- File-stable-at-EOF heuristic (fallback only).

**Plan to resolve:** Inspect the bg-agent fixture + a live run in [#step-6]; pick the
earliest reliable frame tugcode already sees inter-turn. Provisionally [P05]:
stop+compose on `task_updated{completed}` OR completion `wake_started` for the agent,
whichever lands first; claude exit forces a final flush.

**Resolution:** RESOLVED in [#step-6]. For a background agent the earliest reliable
signal tugcode sees is the **`task_notification`** (forwarded as `wake_started`); the
sibling terminal `task_updated` lands after it. The tailer stops+composes on whichever
arrives first ([P05]), which live verification showed is the notification. One
verification-surfaced wrinkle, fixed in `13b93541c`: Claude Code appends the agent's
final answer entry to the transcript file a beat AFTER the notification lands, so the
final flush must **settle** (re-poll until the file is quiet for two consecutive reads)
before composing — a single read at the signal composes an intermediate line. With the
settle, the composed answer matched the agent's true final text (`done`), emitted
exactly once, only after completion.

#### [Q03] Reload-mid-run reconciliation (DECIDED) {#q03-reload-midrun}

**Question:** When the user reloads **while** a background agent is still running, the
jobs ledger is rebuilt **empty** (replay never populates it), so the persisted tailer's
subsequent children arrive with no job to own them and are dropped in a non-content
phase. How is the live stream restored after reload?

**Why it matters:** Without a fix this reintroduces symptom #2 (live dead until the next
reload) precisely in the mid-run case the plan targets. It is knowable from the code —
`handleToolResult`'s job insert is `!isReplaying`-gated and bails on phase inter-turn —
so it is decided here, not deferred to a spike.

**Resolution:** DECIDED. Two coupled mechanisms:
- **[P08]** — the reducer re-hydrates the `running` agent job from the first post-reload
  `task_progress` tick (phase-independent, carries `taskId` + parent `toolUseId`),
  restoring `jobExistsForParent`.
- **[P09]** — tugcode resets active tailers to offset 0 on reconnect so they re-stream
  the full child set into the re-hydrated job; the block's id-dedup ([P06]) fuses that
  with the replay's turn-attached children.

The narrow ordering window (re-streamed children arriving before the first re-hydrating
tick) is Risk [R03](#r03-reload-rehydrate-ordering); confirmed acceptable in [#step-6] —
live verification showed the reset tailer re-streams the full child set after
`replay_complete`, each child re-emitted once (2 wire emissions total per child across
the run), converging with no loss; the deck's id-dedup ([P06]) makes them one list.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Cycle fix repoints ~19 importers; a miss breaks a test import | med | med | Mechanical grep-driven repoint; run full suite + isolation | any red import in CI |
| Tailer polls the wrong file → live stays broken | high | low | [Q01] spike confirms `outputFile` before wiring | live shows no children |
| Duplicate children on reload-mid-run | med | low | Reducer dedups by `toolUseId` ([P06]); verify in [#step-6] | dupes visible after reload |
| Live stream dead after reload-mid-run | high | med | Re-hydrate job from `task_progress` ([P08]) + reset tailer ([P09]) | no new children after reload |
| Early final-answer fragment persists | med | low | Compose only on completion signal ([P05]) | `…:` fragment appears |
| Tailer throws into stdout drain, kills session | high | low | Guarded best-effort; try/catch per poll, never rethrow | session dies on bg agent |

**Risk R01: Circular-import fix touches many files** {#r01-cycle-fix-blast-radius}

- **Risk:** Splitting the dispatch module and repointing ~19 importers is broad; a
  missed import or a wrong path fails a test file's module load.
- **Mitigation:** Do it as a pure, standalone refactor commit; grep every
  `BESPOKE_*` / `hasBespokeWrapper` importer; verify `task-tool-block.test.ts` green
  **in isolation** (the canary) and the full suite.
- **Residual risk:** A runtime registration-order bug (registrations must run before the
  first `resolveToolBlock`); mitigated by the side-effect import at the render root.

**Risk R02: Live/reload frame divergence** {#r02-live-reload-divergence}

- **Risk:** If the tailer synthesized frames differently from the resume splice, live and
  reload would render differently.
- **Mitigation:** The tailer calls the **same** `synthesizeSubagentChildFrames` /
  `composeAgentStructuredResult`; no parallel synthesis.
- **Residual risk:** Ordering/seq differences; children are keyed by id (not seq) at
  merge, so order is stable by producer arrival and dedup is id-based.

**Risk R03: Reload re-hydration ordering window** {#r03-reload-rehydrate-ordering}

- **Risk:** After a reload-mid-run, a child re-streamed by the reset tailer ([P09]) that
  arrives **before** the first re-hydrating `task_progress` tick ([P08]) has no job to
  land on and is dropped from `job.childCalls`.
- **Mitigation:** The replay's turn-attached set (`childToolCallsByParent`) already holds
  every child flushed to `subagents/` before the reload, so the block still shows them;
  only children written in the sub-second `[reload, first-tick]` window could transiently
  miss the job, and the tailer's continued emission plus the next reconnect reconcile
  them. `task_progress` ticks are frequent relative to a full re-stream.
- **Residual risk:** A visual lag of at most one `task_progress` interval on a small tail
  of children in the mid-run reload case; no permanent loss and no dupes. Confirmed
  acceptable in [#step-6]; if it bites, gate the tailer re-stream to fire only after the
  job re-hydrates (a small ordering handshake) as a follow-on.

---

### Design Decisions {#design-decisions}

#### [P01] Background children flow through the job ledger, not committed turns (DECIDED) {#p01-job-ledger}

**Decision:** Inter-turn background-agent children ride `JobItem.childCalls` /
`JobItem.agentStructuredResult` (the ledger the Agent block subscribes to via
`useJobForToolUse`), never by mutating already-committed turns.

**Rationale:**
- A backgrounded agent runs **after** its launching turn commits, so children arrive
  inter-turn; committed turns are append-only + effect-driven and mutating them
  inter-turn risks mount-identity/windowing bugs.
- This is the landed foundation; this plan builds on it, it does not re-decide it.

**Implications:** The block must read the job (already wired); the tailer must emit
frames that the reducer routes to the job (same frames the resume splice emits).

#### [P02] The live tailer tails the echo's `outputFile`, not the `subagents/` dir (DECIDED) {#p02-tail-output-file}

**Decision:** On async-launch detection, tail the `outputFile` path carried in the
echo's `toolUseResult` (`tasks/<agentId>.output`), building the `SubagentTranscript`
meta in-process from the known parent `tool_use_id`. Do **not** scan `subagents/` or read
`.meta.json` for the live path.

**Rationale:**
- The echo hands tugcode the authoritative live path + `agentId` + parent id in-turn;
  no directory scan or sidecar parse is needed.
- On disk, `tasks/<id>.output` is the live-growing transcript (present during the run,
  cleaned after); `subagents/*` is the durable post-hoc copy the **resume** path already
  owns. Using `outputFile` keeps live and reload on separate, non-racing sources.
- The tailer already knows the parent `toolUseId` (it is why it is tailing), so it
  constructs `{ meta: { toolUseId: parentId }, entries }` itself — `.meta.json` is a
  resume-only concern.

**Implications:** `synthesizeSubagentChildFrames` is reused verbatim on entries parsed
from `outputFile`. If [Q01] disproves this, fall back to `subagents/agent-<id>.jsonl`.

#### [P03] The dispatch cycle fix is a standalone prerequisite commit (DECIDED) {#p03-cycle-fix-standalone}

**Decision:** Split `dev-assistant-renderer-dispatch.ts` into a registrations module
(imports the block components, holds `BESPOKE_*`, runs the registration loop) and a
mechanism module (registry, `registerToolBlock`, `resolveToolBlock`,
`dispatchToolCallState`, `TOOL_ALIASES`, `DefaultToolBlock`) that imports **no** block
components — as its own commit, before the `TaskToolBlock` change.

**Rationale:**
- `task-tool-block → agent-transcript-block → dev-assistant-renderer-dispatch` and
  dispatch imports all block components (incl. `TaskToolBlock`) at module-eval, so the
  cycle already exists; removing the `AgentWorkingBody` import reorders init and turns it
  into a hard TDZ `ReferenceError` in isolation.
- Fixing it mixed into the feature was attempted and correctly abandoned as too
  entangled; a clean refactor commit is reviewable and independently green.

**Implications:** ~19 importers of `BESPOKE_*` / `hasBespokeWrapper` repoint to the new
registrations module; a side-effect `import "./dev-assistant-renderer-registrations"` at
the render root (`dev-card-transcript.tsx`) runs the loop.

#### [P04] Poll-tail from a byte offset, ~250 ms (DECIDED) {#p04-poll-tail}

**Decision:** The tailer reads `outputFile` from a persisted byte offset on a ~250 ms
interval, parsing only **complete** newline-terminated lines and carrying a partial-line
remainder across polls.

**Rationale:** `fs.watch` is unreliable for appends on macOS; polling a byte offset is
robust and cheap. A byte offset (not a line count) survives a deck reload within the same
tugcode process so the tailer resumes exactly where it left off.

**Implications:** Partial trailing lines are buffered, never emitted half-parsed; the
offset advances only past fully consumed lines.

#### [P05] Compose the final answer only on a genuine-completion signal (DECIDED) {#p05-compose-on-completion}

**Decision:** The tailer emits child frames continuously but composes + emits the agent's
`structured_result` (via `composeAgentStructuredResult`) **only** when it observes a
genuine-completion signal — `task_updated{completed}` or the completion `wake_started`
for the agent (whichever first) — or a forced final flush on claude exit. It never emits
an intermediate "final answer".

**Rationale:** Fixes symptom #3 (the dangling `…:` fragment) at the source — the compose
helper picks the last text-only entry, which is only the true answer once the agent has
stopped producing.

**Implications:** The tailer tracks the launching agent's task/agent id so it can match
the completion frame; the composed structured frame routes to `job.agentStructuredResult`
via the reducer's `jobExistsForParent && !isAsyncLaunchEcho` branch.

#### [P06] The block merges two child sources and dedups by `toolUseId` (DECIDED) {#p06-dedup-convergence}

**Decision:** `TaskToolBlock` merges its two possible child sources — the **live**
`job.childCalls` (populated inter-turn by the tailer via the reducer's
`applyJobChildToolUse`) and the **turn-attached** `childToolCallsByParent.get(toolUseId)`
(populated on reload by the resume splice) — deduping by `toolUseId` at render time. For
the final answer it prefers `job.agentStructuredResult` (live) over the launch call's
`structuredResult` prop (reload). No new dedup machinery in the reducer.

**Rationale — the two paths are NOT the same mechanism:**
- **Live (no reload):** the async agent's job exists (created in-turn from the
  launch echo), so tailed children route to `job.childCalls` and the composed answer to
  `job.agentStructuredResult` (the reducer foundation, `jobExistsForParent`).
- **Reload:** replay is suppressed from populating the jobs ledger, so the resume
  splice's children instead **attach to the committed turn** (mid-turn during
  `replaying`, via `handleToolUse`'s fall-through) and surface through
  `childToolCallsByParent`; the composed answer lands on the Agent call's **turn
  `structuredResult`** (via `handleToolUseStructured`'s `replaying` branch), NOT on the
  job. This is the existing landed resume behavior.
- Reload-**mid-run** is the one case both fire: post-reload, [P08] re-hydrates the job so
  the still-running tailer resumes feeding `job.childCalls` while the turn-attached set
  holds the pre-reload children. The render-time id-dedup makes them one list.

**Implications:** The block builds `children = dedupById([...(childToolCallsByParent?.get(
toolUseId) ?? []), ...(job?.childCalls ?? [])])`, and `structured = job?.agentStructuredResult
?? structuredResult`. Neither the reducer's turn-attach path nor the resume splice is
touched.

#### [P07] Remove the `AgentWorkingBody` one-liner entirely (DECIDED) {#p07-remove-working-body}

**Decision:** Delete the `AgentWorkingBody` import + render branch from `TaskToolBlock`;
key the body **only** on `hasEntries`. Zero entries → an empty body (header only), never
a summary. Remove the now-orphaned `AgentWorkingBody` component + CSS if nothing else
imports it.

**Rationale:** The user never wants the one-line summary; with `job.childCalls` feeding
the block, real child blocks fill the previously-empty window.

**Implications:** Body branches collapse to `error → null`, `hasEntries → transcript`,
`else → null`. The `job?.progress` dependency for the one-liner is dropped (progress
still drives the JOBS cell elsewhere).

#### [P08] Re-hydrate the agent job from an orphan `task_progress` after reload (DECIDED) {#p08-rehydrate-from-progress}

**Decision:** When a `task_progress` frame arrives whose `taskId` matches no ledger row
and the store is **not** replaying, the reducer inserts a `running` `agent` job
(`jobId = taskId`, `toolUseId = event.toolUseId`, `kind = "agent"`). This is the
post-reload re-hydration seam that restores `jobExistsForParent` for a still-running
background agent whose original job insert was thrown away by the deliberate
replay-suppression of the jobs ledger.

**Rationale:**
- Replay never populates the jobs ledger (reducer's `handleToolResult` insert is gated
  `!isReplaying`; `handleTaskStarted` bails on `replaying`), so after a `Maker ▸ Reload`
  the ledger starts **empty** — a still-running agent has **no** job. Its persisted
  tugcode tailer keeps emitting children inter-turn, which then hit
  `jobExistsForParent === false` in a non-content-bearing phase and are **dropped**.
- `handleTaskProgress` is already phase-independent and dispatched inter-turn, and the
  `task_progress` frame carries both the agent's `taskId` (= the ledger `jobId`) and the
  launching Agent call's `toolUseId` — everything an insert needs, with no access to
  committed turns required. A running agent emits ticks periodically, so its job
  re-appears within one tick of the reload.
- `task_progress` only fires for a **running** agent, so an orphan tick is unambiguous
  evidence the agent is live — no risk of resurrecting a finished row (a completed
  agent's `task_updated{completed}` still flips it terminal as usual).

**Implications:** The insert lands in the `task_progress` fold (`applyJobProgress` /
`handleTaskProgress`), gated on `!isReplaying`. It is idempotent with the launch-echo /
`task_started` inserts (`insertJob` composes by `jobId`). A `bash`/`monitor` progress
tick could in principle be orphaned too, but only agents emit `task_progress`, so the
synthesized kind is `"agent"`.

#### [P09] Reset active tailers to offset 0 on deck reconnect (DECIDED) {#p09-reset-tailer-on-reconnect}

**Decision:** When tugcode services a resume/replay request from a reconnecting deck
(`runReplay`), it resets every **active** subagent tailer's byte offset to 0 so the
tailer re-streams the agent's children from the start after replay finishes. The deck's
id-keyed dedup ([P06]) absorbs the overlap with the replay's turn-attached children.

**Rationale:**
- The tugcode session (and its tailers) persist across a deck reconnect, so a tailer
  would otherwise resume from its mid-file offset and the freshly-rebuilt deck would
  miss every child written before the reload that the replay's partial `subagents/` copy
  didn't yet contain.
- Re-streaming from 0 after replay, combined with [P08]'s job re-hydration and the
  block's id-dedup, converges the reloaded transcript on the full child set with no
  duplicates and no permanent loss.

**Implications:** Ordering matters — the re-streamed children must arrive after the job
is re-hydrated (see [P08]) or they are dropped. This residual window is Risk
[R03](#r03-reload-rehydrate-ordering), mitigated because the replay's turn-attached set
already covers everything flushed to `subagents/` before the reload, and verified in
[#step-6].

---

### Deep Dives (Optional) {#deep-dives}

#### End-to-end live flow {#flow-live}

1. Claude emits the async-launch echo (`user` entry, `toolUseResult.isAsync`) for the
   launching Agent call — **in the launching turn**. `handleClaudeLine` →
   `dispatchEventToTurn` sees it; tugcode already forwards a `tool_result` +
   `tool_use_structured` (the async echo) for the parent Agent id.
2. tugcode extracts `{ parentToolUseId, agentId, outputFile }` from the echo and
   **starts a tailer** ([#step-4], [#step-5]).
3. The deck reducer, seeing the async echo, inserts the `agent` job
   (`parseBackgroundLaunchResult`) — `jobExistsForParent` is now true for the parent id.
4. The tailer polls `outputFile`, parses new complete lines, and for each new entry emits
   `synthesizeSubagentChildFrames` output (`tool_use` + `tool_result` +
   `tool_use_structured`, all stamped `parent_tool_use_id`). tugcode `writeLine`s them.
5. The reducer routes each child onto `job.childCalls` / results (the landed foundation).
6. `TaskToolBlock` merges `job.childCalls` into its transcript entries and renders them —
   **live, no reload** ([#step-3]).
7. On the completion signal ([P05]), the tailer composes `composeAgentStructuredResult`
   and emits it as the parent's `tool_use_structured`; the reducer folds it onto
   `job.agentStructuredResult`; the block shows the final answer + footer stats. Tailer
   stops.

#### End-to-end reload flow {#flow-reload}

- **After completion:** deck reconnects → replay reads main JSONL + `subagents/` splice.
  Because the jobs ledger is **not** populated during replay, the spliced
  `synthesizeSubagentChildFrames` children **attach to the committed Agent turn** (via
  `handleToolUse`'s fall-through in the `replaying` phase) and surface through
  `childToolCallsByParent`; `composeAgentStructuredResult` lands on the Agent call's
  **turn `structuredResult`** (via `handleToolUseStructured`'s `replaying` branch). The
  Step 2 block change renders from those turn-linked sources exactly as it renders the
  live `job.*` sources — so reload matches live. (Resume path is unchanged.)
- **Mid-run:** replay attaches whatever `subagents/` holds so far to the turn (possibly
  nothing if the durable copy lags). The jobs ledger starts empty, so [P08] re-hydrates
  the agent job from the next `task_progress` tick, and [P09] resets the persisted tailer
  to offset 0 so it re-streams the children into the re-hydrated `job.childCalls`. The
  block's id-dedup ([P06]) fuses the turn-attached and job-fed children into one list.
  See Risk [R03](#r03-reload-rehydrate-ordering) for the ordering window.

#### Cycle-fix module split {#cycle-fix-split}

- **New** `dev-assistant-renderer-registrations.ts`: imports the block components +
  `registerToolBlock`; holds `BESPOKE_REGISTRATIONS`, `BESPOKE_TOOL_NAMES`,
  `BESPOKE_FACTORY_BY_NAME`, `hasBespokeWrapper`; runs the registration loop.
- **Trimmed** `dev-assistant-renderer-dispatch.ts`: registry, `registerToolBlock`,
  `resolveToolBlock`, `dispatchToolCallState`, `TOOL_ALIASES` (export it), drift
  detection, `DefaultToolBlock` — imports **no** block component.
- **Render root** `dev-card-transcript.tsx`: side-effect
  `import "./…/dev-assistant-renderer-registrations"` so registration runs at mount.
- **Repoint** the ~19 importers of `BESPOKE_*` / `hasBespokeWrapper`
  (`dev-tool-visibility-policy.ts`, `dev-permission-dialog.tsx`, the ~17 block/policy
  test files) to the registrations module.

---

### Specification {#specification}

- **Inputs (tailer):** `{ parentToolUseId: string, agentId: string, outputFile: string }`
  from the async echo; the completion signal (`task_updated{completed}` / `wake_started`
  for the agent); claude-exit.
- **Outputs (tailer):** `OutboundMessage[]` — `tool_use` / `tool_result` /
  `tool_use_structured` child frames (stamped `parent_tool_use_id`), then one composed
  `tool_use_structured` for the parent on completion. Written via `writeLine`.
- **Semantics:** poll from byte offset; only complete lines; buffer partial tail; dedup is
  the reducer's job (id-keyed). Never throw into the drain.
- **Terminology:** *live file* = `tasks/<agentId>.output`; *durable copy* =
  `subagents/agent-<agentId>.jsonl` (+ `.meta.json`); *async echo* = the launching Agent
  `tool_result` with `toolUseResult.isAsync`.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| `job.childCalls` (read in block) | local-data (session store) | `useJobForToolUse` → `useSyncExternalStore` | [L02] |
| `job.agentStructuredResult` (read in block) | local-data | `useJobForToolUse` → `useSyncExternalStore` | [L02] |
| merged transcript entries | derived (pure) | `React.useMemo` over inputs | [L06] |
| body selection (`hasEntries`) | appearance | pure render branch, no React state | [L06] |
| tool-block registry population | structure/init | side-effect import at render root | [L01] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugcode/src/subagent-tail.ts` | Poll-tail an agent's `outputFile`, emit child + composed frames |
| `tugcode/src/__tests__/subagent-tail.test.ts` | Unit tests for the tailer (offset parsing, dedup-safe frames, compose-on-completion) |
| `tugdeck/src/components/tugways/cards/dev-assistant-renderer-registrations.ts` | Block-component imports + `BESPOKE_*` + registration loop |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `SubagentTailer` (or `startSubagentTail`) | class/fn | `tugcode/src/subagent-tail.ts` | Owns offset, interval, buffer; `stop()` + final flush |
| `extractAsyncLaunch` | fn | `tugcode/src/session.ts` | Narrow echo → `{ parentToolUseId, agentId, outputFile }` |
| `SessionManager.subagentTailers` | field | `tugcode/src/session.ts` | `Map<agentId, SubagentTailer>`; started/stopped in the loop; reset to offset 0 in `runReplay` ([P09]) |
| `applyJobProgress` / `handleTaskProgress` | fn | `select-jobs.ts` / `reducer.ts` | Insert a running `agent` job for an orphan tick when `!isReplaying` ([P08]) |
| `dispatchToolCallState` etc. (mechanism) | fns | `dev-assistant-renderer-dispatch.ts` | Keep; drop block-component imports |
| `BESPOKE_REGISTRATIONS` / `BESPOKE_TOOL_NAMES` / `BESPOKE_FACTORY_BY_NAME` / `hasBespokeWrapper` | consts/fn | `dev-assistant-renderer-registrations.ts` | Moved out of dispatch |
| `TaskToolBlock` body composition | component | `blocks/task-tool-block.tsx` | Merge `job.childCalls`, prefer `job.agentStructuredResult`, drop `AgentWorkingBody` |
| `AgentWorkingBody` | component | `body-kinds/agent-working-body.tsx` | Removed if unreferenced ([P07]) |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** | Tailer offset/parse/compose logic; block composition helpers | pure fns in `subagent-tail.ts`, `task-tool-block.tsx` |
| **Integration (real store)** | Frames → reducer → job ledger → rendered entries | extend `live-subagent-children.test.ts` |
| **Contract (fixture)** | Tailer over a captured `outputFile` matches resume-splice frames | reuse `subagent-resume` fixtures |
| **Live (real claude)** | Real background agent streams + reload converges | on-demand `TUG_REAL_CLAUDE=1`, [#step-6] |

#### What stays out of tests {#test-non-goals}

- No jsdom render-tree assertions or mock-store tests — drive the **real** store with
  real frame shapes (per repo policy).
- No synthetic hand-authored `outputFile` that doesn't match a real capture — the
  tailer contract test consumes a real captured transcript.
- The live-streaming + still-running symptoms are **not** asserted by a completed
  fixture — they only surface with a real running agent ([#step-6]).

---

### Execution Steps {#execution-steps}

> Commit after all checkpoints pass. tugcode is compiled — rebuild the debug app for any
> live check.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Split dispatch registrations from mechanism (cycle fix) | done | ab575e9de |
| #step-2 | Render `job.childCalls` + drop the one-liner | done | 9ed05521a |
| #step-3 | tugcode `subagent-tail` module | done | f7807d04f |
| #step-4 | Wire the tailer + survive reconnect | done | 5aa202b72 |
| #step-5 | Deck integration test: live children + final answer | done | 43d62f3f8 |
| #step-6 | Live verify with a real background agent | done | 13b93541c |

#### Step 1: Split dispatch registrations from mechanism (cycle fix) {#step-1}

**Commit:** `refactor(tugdeck): split tool-block registrations from dispatch mechanism`

**References:** [P03] Cycle fix standalone, Risk R01, (#cycle-fix-split)

**Artifacts:**
- New `dev-assistant-renderer-registrations.ts` (block imports + `BESPOKE_*` + loop).
- Trimmed `dev-assistant-renderer-dispatch.ts` (mechanism only; export `TOOL_ALIASES`).
- Side-effect import at `dev-card-transcript.tsx`.
- ~19 importers repointed to the registrations module.

**Tasks:**
- [ ] Move `BESPOKE_REGISTRATIONS`, `BESPOKE_TOOL_NAMES`, `BESPOKE_FACTORY_BY_NAME`,
  `hasBespokeWrapper`, the block-component imports, and the registration loop into the
  new registrations module; import `registerToolBlock` + `TOOL_ALIASES` from dispatch.
- [ ] Strip all block-component imports from dispatch; export `TOOL_ALIASES`.
- [ ] Add `import "./dev-assistant-renderer-registrations"` (side-effect) at the render
  root so the loop runs at mount.
- [ ] Repoint every `BESPOKE_*` / `hasBespokeWrapper` importer (grep-driven).

**Tests:**
- [ ] `bun test task-tool-block.test.ts` (the canary) passes **in isolation**.
- [ ] `bun test dev-assistant-renderer-dispatch.test.ts` + `dev-tool-visibility-policy.test.ts` pass.

**Checkpoint:**
- [ ] `cd tugdeck && bun test` (full suite green).
- [ ] `cd tugdeck && bunx vite build` (no cycle / init error).

#### Step 2: Render `job.childCalls` + drop the one-liner {#step-2}

**Depends on:** #step-1

**Commit:** `feat(tugdeck): render live background-agent children under the Agent block`

**References:** [P01] Job ledger, [P06] Dedup convergence, [P07] Remove working body,
Spec (#state-zone-mapping), (#flow-live)

**Artifacts:**
- `TaskToolBlock` merges `job.childCalls` (deduped vs `childToolCallsByParent.get(id)`)
  into `composeAgentTranscriptData`; prefers `job.agentStructuredResult` over the launch
  echo's `structuredResult`.
- `AgentWorkingBody` import + render branch removed; body keyed on `hasEntries`.
- `AgentWorkingBody` component + CSS removed if unreferenced.

**Tasks:**
- [ ] In `TaskToolBlock`, build merged children = dedup-by-`toolUseId`(
  `childToolCallsByParent?.get(toolUseId)` ++ `job?.childCalls`); feed to
  `composeAgentTranscriptData`.
- [ ] Prefer `job?.agentStructuredResult ?? structuredResult` for the narrowed structured
  result (final answer + footer stats).
- [ ] Delete the `AgentWorkingBody` branch; body = `error → null`,
  `hasEntries → AgentTranscriptBlock`, `else → null`.
- [ ] Remove the now-unused `AgentWorkingBody` file/CSS if grep shows no other importer.

**Tests:**
- [ ] Unit: a `composeAgentTranscriptData` call with overlapping turn-linked + job
  children yields one entry per `toolUseId` (no dupes).
- [ ] `grep -c AgentWorkingBody tugdeck/src` → 0.

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx vite build`

#### Step 3: tugcode `subagent-tail` module {#step-3}

**Depends on:** #step-1

**Commit:** `feat(tugcode): poll-tail a background agent's live transcript`

**References:** [P02] Tail `outputFile`, [P04] Poll from byte offset, [P05] Compose on
completion, [Q01] Live file, (#flow-live)

**Artifacts:**
- `tugcode/src/subagent-tail.ts` — a tailer that owns `{ outputFile, offset, buffer,
  parentToolUseId }`, exposes `poll()`/`start()`/`stop(finalFlush)`, reuses
  `synthesizeSubagentChildFrames` + `composeAgentStructuredResult`.
- `tugcode/src/__tests__/subagent-tail.test.ts`.

**Tasks:**
- [ ] Implement byte-offset read of `outputFile`; split complete lines, buffer the
  partial tail, parse via the same `parseSubagentEntries` shape.
- [ ] For newly-parsed entries, build `SubagentTranscript { meta: { toolUseId:
  parentToolUseId }, entries }` and emit `synthesizeSubagentChildFrames` output.
- [ ] `stop(finalFlush)`: on genuine completion drain any remaining lines, then compose +
  emit the parent's `tool_use_structured` via `composeAgentStructuredResult`.
- [ ] Guard everything best-effort (missing file → no-op; parse error → skip line; never
  throw).

**Tests:**
- [ ] Contract: feed the tailer the `subagent-resume` fixture body in growing chunks;
  assert the emitted child frames equal the resume splice's `synthesizeSubagentChildFrames`
  output (same tool_use ids + parent stamping).
- [ ] Unit: a partial trailing line is buffered, not emitted, until its newline arrives.
- [ ] Unit: compose is emitted only on `stop(finalFlush=true)`, never mid-stream.

**Checkpoint:**
- [ ] `cd tugcode && bun test subagent-tail.test.ts`

#### Step 4: Wire the tailer + survive reconnect {#step-4}

**Depends on:** #step-2, #step-3

**Commit:** `feat: stream background-agent children live and across reload`

**References:** [P02] Tail `outputFile`, [P05] Compose on completion, [P08] Re-hydrate
from `task_progress`, [P09] Reset tailer on reconnect, [Q02] Completion signal,
[Q03] Reload-mid-run, Risk R03, (#flow-live, #flow-reload)

**Artifacts:**
- tugcode: `extractAsyncLaunch` narrows the async echo →
  `{ parentToolUseId, agentId, outputFile }`; `SessionManager.subagentTailers:
  Map<agentId, SubagentTailer>`; start on echo, stop on completion / claude exit; reset
  to offset 0 in `runReplay`.
- tugdeck reducer: `handleTaskProgress` / `applyJobProgress` insert a `running` agent job
  for an orphan tick when `!isReplaying`.

**Tasks:**
- [ ] tugcode: in the launching-turn `case "user"` path, read the **live** key
  `event.tool_use_result` (snake_case — the JSONL's `toolUseResult` is the replay path;
  session.ts `routeTopLevelEvent`), detect `isAsync` / `status: "async_launched"`,
  extract `{ agentId, outputFile }` + the linked parent `tool_use_id`, and `start` a
  tailer keyed by `agentId`.
- [ ] tugcode: drive the poll on the `~250 ms` interval ([P04]); `writeLine` its frames.
- [ ] tugcode: stop + final-flush on the completion signal for that agent
  (`task_updated{completed}` / `wake_started`, per [Q02]) and on claude exit
  (`killAndCleanup` / drain EOF).
- [ ] tugcode: in `runReplay`, reset every active tailer's byte offset to 0 so it
  re-streams after a reconnecting deck's replay ([P09]).
- [ ] tugdeck: extend `applyJobProgress` (or `handleTaskProgress`) so an orphan
  `task_progress` (no matching `jobId`, `!isReplaying`) inserts a `running` `agent` job
  keyed `jobId = taskId`, `toolUseId = event.toolUseId` ([P08]); keep it idempotent with
  the launch-echo / `task_started` inserts via `insertJob`.

**Tests:**
- [ ] Unit: `extractAsyncLaunch` returns the trio for the real echo shape (read from
  `tool_use_result`), `undefined` for a foreground/non-async result.
- [ ] Unit: a completion frame for the agent triggers `stop(finalFlush=true)` exactly once.
- [ ] Real-store (tugdeck): an orphan `task_progress` with no prior job inserts a running
  agent job; a subsequent `task_updated{completed}` flips it terminal; a `replaying`-phase
  orphan tick inserts nothing.

**Checkpoint:**
- [ ] `cd tugcode && bun test`
- [ ] `cd tugdeck && bun test` (re-hydration test green)

#### Step 5: Deck integration test — live children + final answer {#step-5}

**Depends on:** #step-2, #step-4

**Commit:** `test(tugdeck): live subagent children render + final answer folds onto job`

**References:** [P01] Job ledger, [P06] Dedup convergence, [P07] Remove working body,
(#success-criteria)

**Artifacts:**
- Extend `live-subagent-children.test.ts` (real store) to assert the rendered/derived
  transcript, not just the ledger.

**Tasks:**
- [ ] Emit a launch echo + streamed child `tool_use`/`tool_result` frames + a composed
  agent `tool_use_structured`; assert `composeAgentTranscriptData` over `job.childCalls`
  yields the child entries **and** the final answer (from `job.agentStructuredResult`).
- [ ] Assert a redelivered child (live/resume overlap) does not duplicate an entry.

**Tests:**
- [ ] Real-store test green; no `AgentWorkingBody` reachable in any branch.

**Checkpoint:**
- [ ] `cd tugdeck && bun test live-subagent-children.test.ts`
- [ ] `cd tugrust && cargo nextest run` (tugcast probe suite unaffected)

#### Step 6: Live verify with a real background agent {#step-6}

**Depends on:** #step-5

**Commit:** `N/A (verification only)`

**References:** [Q01] Live file, [Q02] Completion signal, [Q03] Reload-mid-run,
(#success-criteria, #flow-live, #flow-reload)

**Tasks:**
- [ ] `just app-debug` from the worktree (rebuilds the compiled tugcode binary).
- [ ] Launch a real background agent; confirm child blocks **stream in live** under the
  Agent block, no one-liner. Resolve [Q01] by `ls -la` + `tail -f` both
  `tasks/<id>.output` and `subagents/agent-<id>.jsonl` during the run.
- [ ] Confirm no "final answer" appears until the agent genuinely completes; resolve
  [Q02] by noting which frame precedes the composed answer.
- [ ] Reload **mid-run**: confirm the job re-hydrates from the next `task_progress`
  ([P08]) and the reset tailer ([P09]) resumes streaming children with no dupes; measure
  the Risk [R03](#r03-reload-rehydrate-ordering) window (any transiently-missing tail
  children) and confirm it self-heals. Reload **after completion**: confirm identical
  blocks + answer, no grows-each-reload.
- [ ] Optional wire check: `TUG_REAL_CLAUDE=1 TUG_PROBE_FILTER=… just app-test
  test-42-bg-agent-progress` (inspection-only) to see child frames on the wire.

**Tests:**
- [ ] Manual live acceptance recorded against [#success-criteria].

**Checkpoint:**
- [ ] Live: child blocks stream without reload; reload (both timings) matches live.
- [ ] [Q01]/[Q02]/[Q03] marked resolved in this plan with the observed answer.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A background `Agent`'s children and final answer render as real
broken-out blocks under the Agent block — live as it runs and identically on
reload/resume — with the one-line summary gone and no dangling final-answer fragment.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [x] Live child blocks stream under the Agent block with no reload ([#step-6] —
  verified at the wire against a real background agent: parent-stamped child frames
  arrive inter-turn; the deck renders them from `job.childCalls`).
- [x] `AgentWorkingBody` one-liner is gone in every state ([#step-2], `grep` → 0).
- [x] Reload (mid-run and post-completion) reconstructs the same content; no
  grows-each-reload, no `…:` fragment; mid-run reload keeps streaming via [P08]/[P09]
  ([#step-6] — mid-run `request_replay` re-streamed the full child set; the
  post-completion replay spliced the identical child ids + one composed answer).
- [x] `cd tugrust && cargo nextest run` (1060 pass), `bun test` (tugcode 697 +
  tugdeck 3812), and `bunx vite build` all green, zero warnings.
- [x] `task-tool-block.test.ts` green **in isolation** ([#step-1]).

**Acceptance tests:**
- [x] `subagent-tail.test.ts` contract test matches resume-splice frames.
- [x] `live-subagent-children.test.ts` asserts rendered children + final answer.

**Live acceptance record ([#step-6], real background agent, claude 2.1.198):** launched
via the rebuilt debug tugcode; child `tool_use`/`tool_result` frames streamed inter-turn
(parent-stamped, ids matching the on-disk transcript); no composed answer mid-run;
mid-run `request_replay` → tailer reset re-streamed both children post-bracket; the
completion `wake_started` triggered exactly one composed `tool_use_structured` whose
content was the agent's true final text (`done`) with correct footer stats; a
post-completion replay spliced the same 2 children + 1 answer. Two defects surfaced and
fixed during verification (`13b93541c`): the claude project-dir encoding drift (dots /
underscores) that made replays report `jsonl_missing` for this worktree's path, and the
final-flush race that composed an intermediate line as the answer. The in-deck visual
pass (blocks under the Agent block in the running Dev card) is the user's to vet on the
`(debug, tugdash/subagent-improvements)` instance.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Nested background agents (an agent that itself backgrounds an agent) — the resume
  splice recurses; confirm the live tailer handles a nested async launch.
- [ ] Collapse `tasks/*.output` cleanup races (if the file is removed before final flush).

| Checkpoint | Verification |
|------------|--------------|
| Live streaming | `just app-debug`; launch bg agent; blocks stream, no one-liner |
| Live==reload | reload twice; identical block count + final answer |
| Cycle gone | `bun test task-tool-block.test.ts` in isolation |
| No regressions | `cargo nextest run` + `bun test` + `bunx vite build`, zero warnings |
