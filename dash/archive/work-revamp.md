## WORK Tracking Revamp — accurate Z2 summary, no-flicker task list, RemoteTrigger coverage {#work-revamp}

**Purpose:** Make the Z2 `WORK` cell honestly reflect *all* live work as a single active-work count (with a 5-minute linger so it never snaps abruptly to "None"), stop the task list from momentarily dropping to zero across turn boundaries, extend coverage to claude.ai `RemoteTrigger` routines, and rename the popover's invented "Checklist" label to "Tasks".

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-07-10 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The `WORK` cell in the Z2 status row is the unified surface over every trackable unit of session work: the task checklist (`TaskCreate`/`TaskUpdate` calls), the background-jobs ledger (background `Bash`, async `Agent`, `Monitor`, scheduled `ScheduleWakeup`/`CronCreate` rows), and the `/goal`. The surface unifies but the storage stays split across three sources, and `WORK` is a pure projection over them (`select-work.ts`). Four defects motivate this phase:

1. **The Z2 summary does not reflect all work.** `workCellLabel` (`#work-cell-label-current`) is a single-category priority cascade — it shows the goal, *or* the jobs fraction, *or* the scheduled count, *or* the tasks fraction, *or* "None". When several categories are active at once, the cell shows only the top-priority one and hides the rest. A session with running jobs *and* a checklist reads as jobs-only.
2. **The count would snap abruptly to zero.** Replacing the cascade with an active-work count risks a jarring drop: the instant the last item completes, the cell would read "None" — even though the user has not yet looked at what just finished, and the indicator dot is still painting the "completed" (green) pose. A hard snap makes the just-finished work vanish and leaves a green dot next to "None" (incoherent). The fix is a **5-minute linger** ([P07]/[P08]): the count holds recently-completed work for `WORK_LINGER_MS` after the last completion, then quietly settles to "None" with a quiet dot.
3. **The task list flickers to zero and restores.** Observed in session `16f90a80` (screenshots: the cell reads "6/7", then "None" a moment later, mid-turn, then restores). Root cause is the turn-scoped visibility gate in `useTaskListState` (`#flicker-root-cause`): when a new turn opens with an empty `activeTurn.messages`, the gate returns the empty state until that turn streams its first `TaskCreate`/`TaskUpdate`, collapsing the whole checklist in the gap.
4. **The popup invents terminology and misses a source.** The popover labels the task group "Checklist" (`#popover-groups-current`) — the items are `Task*` tool calls, so the honest label is "Tasks". Separately, `RemoteTrigger` (claude.ai scheduled cloud routines) is render-only today (`RemoteTriggerToolBlock`) and never enters the jobs ledger, so scheduled cloud work is invisible to `WORK`.

#### Strategy {#strategy}

- Replace the single-category cascade with **one aggregate active-work count** ([P01]/[P02]); keep `composeWorkSummary` as the accessible per-category breakdown and the popover as the full grouped ledger.
- Wrap the count in a **5-minute linger** ([P07]) so a completing item does not snap the cell to "None" — it holds the recently-completed count for `WORK_LINGER_MS`, then settles. Keep the indicator pose coherent with the label ([P08]): green "completed" while lingering, quiet once settled. Use per-item completion timestamps (`settledAtMs`/`endedAtMs`) and a single bounded `setTimeout` for the settle — no per-second ticker (the area is deliberately tick-free, `#linger-and-clock`).
- Fix the flicker by **dropping the turn-scoped empty gate** ([P03]) in `useTaskListState`, so the last non-empty fold persists across the turn-open gap. The reducer's existing batch-boundary supersede (`#reducer-batch-boundary`) remains the only mechanism that clears a list. Verify every hook consumer (`#task-list-hook-consumers`).
- Rename the popover group label "Checklist" → "Tasks" ([P04]); leave the internal `WorkGroup` type value untouched (non-goal).
- Add `RemoteTrigger` coverage as a `"remote"` scheduled job row ([P05]) folded deck-side in the reducer — no tugcode/binary change needed, since `RemoteTrigger` rides the transcript as an ordinary `tool_use`/`tool_result` the reducer already sees. Guard the id-less local-wake reconciliation so a local wake never flips a remote row ([P06]).
- Ship as flat, independently-committable steps.

#### Success Criteria (Measurable) {#success-criteria}

- With a checklist (some tasks incomplete) **and** ≥1 running job **and** ≥1 scheduled row present at once, the Z2 `WORK` cell reads a single number equal to (incomplete tasks + running jobs + scheduled rows + active-goal), not any one category's fraction. (Unit test over `workActiveCount`; app-test asserting the rendered cell text.)
- When the last active item completes, the cell holds a non-zero count (the recently-completed batch size) and does **not** read "None" until `WORK_LINGER_MS` has elapsed since that completion; the indicator dot reads "completed" during the linger and quiet after. (Unit test over `countRecentlyDone` / `workDisplayCount` / the pose gate with an injected `nowMs`; app-test observing the held count.)
- Opening a new turn over a pre-existing, still-incomplete checklist never drops the `WORK` cell to "None" before the turn's first `Task*` frame. (Unit test on the hook fold; app-test driving a turn boundary.)
- The popover's task group header reads "Tasks" (rendered uppercase "TASKS"), never "Checklist". (DOM/app-test assertion.)
- A `RemoteTrigger` `create` call produces one `"remote"` scheduled row in the ledger, visible in the popover's Scheduled group and counted by `WORK`; `list`/`get`/`run` produce no row; `update` re-labels an existing row. (Unit test on the fold; app-test over a synthesized `RemoteTrigger` tool result.)
- `bunx vite build` succeeds; `bun test` (tugdeck) passes; `just app-test` passes.

#### Scope {#scope}

1. Aggregate active-work count for the Z2 `WORK` cell (`select-work.ts`, renderer wiring).
2. 5-minute completion linger over the count + coherent indicator pose (`select-work.ts`, `select-task-list.ts` per-item timestamp, renderer settle timer).
3. Turn-boundary flicker fix (`useTaskListState`) with a full consumer audit.
4. Popover label rename Checklist → Tasks (`dev-card-telemetry-popovers.tsx`).
5. `RemoteTrigger` `create`/`update` coverage as a `"remote"` scheduled ledger row (data model + narrowing + reducer dispatch).

#### Non-goals (Explicitly out of scope) {#non-goals}

- Renaming the internal `WorkGroup` union value `"checklist"` (and `selectWorkItems`' internal group key) — display-label-only change this phase.
- A live per-second countdown anywhere in `WORK` — the linger settles via one bounded timeout, not a ticker (matches the existing no-tick scheduled badge).
- tugcode-side changes: the pulse narration (`voice.ts`), `pendingScheduledTriggers` (`session.ts`), or any inbound-message allowlist. The `WORK` fold is entirely deck-side, so no binary rebuild is needed.
- Agent-team teammates (`SendMessage` / named background agents) as work rows — deferred (user chose RemoteTrigger only).
- `PushNotification`, `CronList`, `TaskList`/`TaskGet`/`TaskOutput`, and `RemoteTrigger` `list`/`get`/`run` as ledger rows — notifications or read-only queries, correctly excluded.
- Changing the "aborted" (failed-job) pose — a failed job's red dot deliberately holds until Clear ([D102]); it is not linger-gated (`#linger-and-clock`).

#### Dependencies / Prerequisites {#dependencies}

- None external. All touched files are in `tugdeck/` and edited under live HMR; no tugcast/tugutil/tugcode rebuild.

#### Constraints {#constraints}

- **Warnings are errors** across the workspace; `bunx tsc --noEmit` (`bun run check`) must stay clean.
- **Verify with `bunx vite build`** before declaring any tugdeck change done — the debug app loads the production rollup bundle, so a dev-only-passing import can hang the app at splash.
- Tuglaws: external state enters React through `useSyncExternalStore` only ([L02]); appearance changes go through CSS/DOM, never React state ([L06]). The linger's settle timer is a view-local `useState`/`useEffect` nudge that only forces a re-read of store-derived data — no external state bypasses the store, no appearance is stored in React state (the pose still rides `TugProgressIndicator`'s `state` prop). No new persistence.
- The Z2 status row is a fixed-width flex group — every cell reserves a stable width so the group never reflows; the `WORK` indicator's `phaseLabels.max` token drives that reservation (`#phaselabels-width`).

#### Assumptions {#assumptions}

- `RemoteTrigger` rides the transcript as a normal `tool_use` with a landed `tool_result` (confirmed: `RemoteTriggerToolBlock` renders it, dispatched as `remotetrigger`), so `handleToolResult`'s scheduled-work `else` branch (`#reducer-scheduled-dispatch`) sees it exactly like `CronCreate`.
- The `RemoteTrigger` input shape is `{ action, trigger_id?, body? }` with actions `list`/`get`/`create`/`update`/`run` (pinned by `narrowRemoteTriggerInput` and its tests). The `create`/`update` result is API JSON with an appended summary line carrying a server-parsed run time + routine URL; its exact field names for a trigger id / next run time are not pinned by a captured fixture (see [Q01]).
- `ToolUseMessage` carries `settledAtMs: number | null` (`#toolusemessage-timestamps`) — the terminal result-landed time — so a completing `TaskUpdate` has a real completion timestamp for the linger without threading a clock through the pure fold. `JobItem.endedAtMs` provides the same for jobs.
- The `WORK`/scheduled area has **no idle ticker** by design (`#linger-and-clock`); the linger settle therefore uses one bounded `setTimeout`, not an interval.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

Anchors are explicit and kebab-case; steps cite decisions/specs/anchors, never line numbers.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] RemoteTrigger result id + next-run-time parsing (OPEN) {#q01-remote-result-parse}

**Question:** What are the exact field names in a `RemoteTrigger` `create`/`update` result JSON for (a) the trigger/routine id and (b) the next scheduled run time?

**Why it matters:** The id keys the ledger row (so a later `update` re-labels the same row); a parseable future run time would let a one-shot remote row carry a real `firesAtMs`. Guessing wrong only degrades gracefully — the row still appears keyed by `tool_use_id` — but a wrong `firesAtMs` could cause premature reaping.

**Options (if known):**
- Parse `id` / `trigger_id` from the top-level JSON; parse an ISO run-time from the appended summary line.
- Skip run-time parsing entirely — treat every remote row like a cron (`firesAtMs: null`, never time-reaped).

**Plan to resolve:** Defensive default now. `parseRemoteTriggerCreateId` tries `JSON.parse(result)` and reads the first non-empty string among `id` / `trigger_id`, falling back to the call's `tool_use_id`. `firesAtMs` is left `null` this phase (remote rows read by `scheduleLabel`, like crons), so no time-reaping mis-fires.

**Resolution:** DECIDED for this phase (see [P05]) — id parsed defensively with `tool_use_id` fallback; `firesAtMs: null`. Run-time-driven countdown DEFERRED to a follow-on once a fixture exists.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Dropping the turn-gate lingers a completed checklist in the popover | low | med | Reducer batch-supersede keeps only the current batch; completed tasks contribute 0 to the active count | Popover shows stale batches across many turns |
| Abandoned incomplete checklist merges into a new batch | med | low | Pre-existing reducer behavior; documented as residual ([R04]) | New checklists inherit zombie pending items |
| A local wake flips a remote row to completed | med | low | Exclude `kind === "remote"` from `flipEarliestElapsedScheduled` ([P06]) | A remote row disappears when a local wakeup fires |
| Linger settle timer leaks / fires stale | low | low | `useEffect` clears the timeout on every re-run; guard on `activeCount === 0 && recentlyDone > 0` | Duplicate/late re-renders observed |
| `phaseLabels.max` width change shifts the Z2 row | low | low | Deliberately choose the reservation ([P07]/`#phaselabels-width`) and eyeball the row in-app | Counts routinely exceed 2 digits |

**Risk R01: Completed checklist lingers in the popover after the gate is removed** {#r01-linger}

- **Risk:** Without the turn-scoped empty gate, an all-completed checklist stays visible in the popover's Tasks group until a fresh `TaskCreate` supersedes it.
- **Mitigation:** The reducer collapses history to the current batch (`#reducer-batch-boundary`), so at most one completed batch lingers; the aggregate count reads 0 active for it (and past the linger window, "None").
- **Residual risk:** A finished session's last checklist remains struck-through in the popover — acceptable and strictly better than the flicker.

**Risk R02: Remote row flipped by an unrelated local wake** {#r02-remote-flip}

- **Risk:** `flipEarliestElapsedScheduled` flips the earliest elapsed scheduled row on any id-less local wake; a remote row could be wrongly completed.
- **Mitigation:** [P06] excludes `kind === "remote"` from the flip candidate scan.
- **Residual risk:** Remote rows never auto-complete locally — they persist as scheduled until cleared. Accepted: their execution is external (claude.ai) and unobservable locally.

**Risk R04: Abandoned incomplete checklist absorbs a new batch** {#r04-abandoned-batch}

- **Risk:** `reduceTaskListState`'s batch-supersede only fires when the prior batch is *fully completed* (`#reducer-batch-boundary`). Persisting the fold (no gate) means a stale *incomplete* checklist lingers, and a later `TaskCreate` appends to it rather than starting a fresh batch — inflating the active count with zombie pending items.
- **Mitigation:** Pre-existing behavior — the gate only hid it, never fixed it. Out of scope to change the supersede rule this phase; documented so the implementer/tester expects it.
- **Residual risk:** Rare (assistants seldom abandon a checklist mid-way then start a new one same session). Revisit with a "supersede on any new create after N idle turns" rule if it bites.

---

### Design Decisions {#design-decisions}

#### [P01] The Z2 WORK cell shows one aggregate active-work count (DECIDED) {#p01-aggregate-count}

**Decision:** Replace `workCellLabel`'s single-category priority cascade with a single integer — the count of active work items across every category — rendered as the cell's label (subject to the [P07] linger; `"None"` when zero and settled).

**Rationale:**
- The user chose "Total active count": one honest number reflecting every live category, not a fraction that hides the others.
- A fraction (`done/total`) mixes semantics across categories; a count sidesteps that.
- The full picture stays reachable — `composeWorkSummary` remains the cell's `aria-label` and the popover carries the grouped detail.

**Implications:**
- `workCellPose` keeps its structure; only the terminal/"completed"-quiet branch becomes linger-aware ([P08]).
- The renderer's `phaseLabels.max` reservation changes from `"00/00"` to `"00"` (`#phaselabels-width`).

#### [P02] Active work = incomplete tasks + running jobs + scheduled rows + active goal (DECIDED) {#p02-active-definition}

**Decision:** `workActiveCount = (taskCounts.total − taskCounts.completed) + jobCounts.running + jobCounts.scheduled + (goalIsActive(goal) ? 1 : 0)`.

**Rationale:**
- "Active" means work still pending or in flight: incomplete tasks (`pending` + `in_progress`), `running` jobs, `scheduled` promised work, one active goal.
- Terminal jobs are history — excluded from *active* (they feed the linger and the popover's Finished group instead).
- Uses existing `JobCounts` (`#job-counts`) and `TaskCounts` (`#task-counts`) fields verbatim.

**Implications:**
- New pure helper `workActiveCount` in `select-work.ts`.
- `hasWork` (renderer, `#renderer-work-wiring`) already gates the empty state and is unaffected.

#### [P07] The count lingers for 5 minutes after the last completion (DECIDED) {#p07-linger}

**Decision:** The cell's displayed number is `workDisplayCount(activeCount, recentlyDone)` where `recentlyDone = countRecentlyDone(tasks, jobs, nowMs, WORK_LINGER_MS)` and `workDisplayCount = activeCount > 0 ? activeCount : recentlyDone`. The label is `"None"` only when `workDisplayCount === 0`. `WORK_LINGER_MS = 300_000`.

**Rationale:**
- A hard snap to "None" the moment the last item completes is jarring and hides just-finished work before the user notices it. Holding the recently-completed count for 5 minutes is more accommodating (the user's explicit request).
- The linger applies **only when nothing is active** (`activeCount > 0` short-circuits it) — so a live count is never inflated by history; the linger only softens the 0-transition.
- `recentlyDone` is per-item and precise: a task counts while `status === "completed"` and `now − completedAtMs < WORK_LINGER_MS`; a job counts while terminal and `now − endedAtMs < WORK_LINGER_MS`. Completion times come from `settledAtMs` (tasks) and `endedAtMs` (jobs) — already on the wire (`#toolusemessage-timestamps`), so no clock threads through the pure fold.
- For the cell to settle to "None" with no further wire event, one bounded `setTimeout` is scheduled at the earliest `(completion + WORK_LINGER_MS)` still in the future — not a per-second ticker, matching the area's deliberate no-tick design (`#linger-and-clock`).

**Implications:**
- `TaskItem` gains `completedAtMs?: number`, stamped in `reduceTaskListState` from the completing `TaskUpdate`'s `settledAtMs` (`#reducer-batch-boundary`). Absent (older/resumed folds without a settle time) ⇒ treated as not-recent (no false linger).
- New pure helpers in `select-work.ts`: `WORK_LINGER_MS`, `countRecentlyDone(tasks, jobs, nowMs, lingerMs)`, `workDisplayCount(activeCount, recentlyDone)`, `nextLingerExpiryMs(tasks, jobs, lingerMs)` (earliest future settle time, or `null`). All take `nowMs`/`lingerMs` as params for deterministic tests.
- The renderer reads `nowMs = Date.now()` at render, computes the display count, and a `useEffect` schedules a single `setTimeout(bumpTick, nextExpiry − nowMs)` when `activeCount === 0 && recentlyDone > 0`, cleared on every re-run. `bumpTick` is a `useState` counter that forces one recompute.

#### [P08] The indicator pose is coherent with the lingered label (DECIDED) {#p08-pose-coherence}

**Decision:** `workCellPose` gains a `recentlyCompleted: boolean` input. Its terminal/"completed"-quiet outcomes return `"completed"` only while `recentlyCompleted` is true; once the linger has settled (`recentlyCompleted === false` and nothing active), they return `"stopped"` (quiet). The `"running"` (active work / scheduled / active goal) and `"aborted"` (failed job, holds until Clear) outcomes are unchanged.

**Rationale:**
- Without this, a settled checklist paints a green "completed" dot next to the label "None" — contradictory. Gating the done-pose on the same linger window the label uses keeps them in lockstep: green "N done" during the linger, quiet "None" after.
- "aborted" is intentionally *not* linger-gated: a failed job should keep nagging (red) until the user clears it ([D102]).

**Implications:**
- `recentlyCompleted = recentlyDone > 0` is computed once in the renderer and passed to both the label path and `workCellPose`.
- The existing `workCellPose` truth-table tests gain the `recentlyCompleted` axis.

#### [P03] The task list persists across turn boundaries; the turn-scoped empty gate is removed (DECIDED) {#p03-drop-gate}

**Decision:** `useTaskListState` always folds the whole transcript's `Task*` calls and returns that state; it no longer returns `EMPTY_TASK_LIST_STATE` when the latest turn has not yet emitted a `Task*` event.

**Rationale:**
- The gate (`#flicker-root-cause`) is the sole cause of the zero-then-restore flicker.
- The reducer already collapses accumulated history to the current batch (`#reducer-batch-boundary`), so folding the full transcript yields the current checklist, not every historical batch. The gate was a redundant second clearing layer.
- Persisting the last fold is exactly the "don't vanish" behavior the user wants; the [P07] linger governs the graceful settle instead.

**Implications:**
- The `useMemo` body in `useTaskListState` drops the `if (latest === null || !hasTaskEvent(latest)) return EMPTY_TASK_LIST_STATE` branch and folds unconditionally.
- `hasTaskEvent` and `selectLatestTurnMessages` become unused by the hook (only its own test consumes them, `#gate-helper-consumers`). Remove both exports and their tests; rewrite the module docstring's "turn-scoped visibility" section to describe persistence.
- All hook consumers are audited (`#task-list-hook-consumers`): the WORK renderer, `use-work-state.ts`, and `blocks/task-inline-tool-block.tsx` (inline subject resolution) / `gallery-transcript-registers.tsx`. Persistence is neutral-to-positive for the inline block (it can always resolve a subject).
- Behavior change accepted under [R01]/[R04].

#### [P04] The popover task group is labelled "Tasks" (DECIDED) {#p04-tasks-label}

**Decision:** Change the popover group label string from `"Checklist"` to `"Tasks"` at the `group("Checklist", taskRows, !hasTasks)` call (`#popover-groups-current`).

**Rationale:**
- The rows are `TaskCreate`/`TaskUpdate` items — "Tasks" is what they are; "Checklist" is invented terminology.
- Minimal, no ripple into the `WorkGroup` type (non-goal).

**Implications:**
- One string literal changes; CSS uppercases it to "TASKS". No other rename this phase.

#### [P05] RemoteTrigger create/update folds into the ledger as a "remote" scheduled row (DECIDED) {#p05-remote-row}

**Decision:** Add `"remote"` to `WorkKind` and `JobItem["kind"]`. In the reducer's scheduled-work `else` branch, a `remotetrigger` tool result with `action === "create"` inserts one scheduled `"remote"` row (keyed by parsed trigger id, fallback `tool_use_id`); `action === "update"` re-labels the matching row via a new `relabelScheduledRow` helper if present (no-op if unknown); `list`/`get`/`run` produce no row.

**Rationale:**
- `create` schedules future cloud work — genuine scheduled work to surface.
- `run` fires an immediate external run with no local completion signal — not a trackable local row; `list`/`get` are read-only (consistent with excluding `CronList`).
- Modeled on the cron row (`scheduledRowFromCron`): `firesAtMs: null`, reads by `scheduleLabel`.

**Implications:**
- New helpers in `select-scheduled-work.ts`: `parseRemoteTriggerCreateId`, `scheduledRowFromRemoteTrigger`, `relabelScheduledRow`, plus a local `narrowRemoteTriggerToolInput` (mirror the block's shape locally to avoid a lib→component import, `#import-layering`).
- `jobGroup` (`#select-work-jobgroup`) already routes any `scheduled` status to the Scheduled group regardless of kind. `jobActions` must return `[]` for a `"remote"` scheduled row (no local cancel — `RemoteTrigger` has no `delete` action).
- Popover Scheduled group and the aggregate count pick up remote rows automatically (both kind-agnostic over `status === "scheduled"`).

#### [P06] Remote rows are excluded from id-less local-wake reconciliation (DECIDED) {#p06-remote-no-flip}

**Decision:** `flipEarliestElapsedScheduled` skips rows with `kind === "remote"` when choosing the earliest elapsed scheduled row to flip on an id-less local wake.

**Rationale:**
- A fired local `ScheduleWakeup`/`CronCreate` wake carries no `task_id`; the current heuristic flips the earliest elapsed scheduled row. A remote row (external execution) must never be completed by a *local* wake.
- Remote rows have `firesAtMs: null`, so they can only be picked as the cron-fallback candidate; the guard removes them from that fallback.

**Implications:**
- One `continue` guard in the `flipEarliestElapsedScheduled` scan. `reapElapsedScheduled` already ignores rows without a numeric `firesAtMs`, so remote rows are never time-reaped either (they persist as scheduled until Clear).

---

### Deep Dives (Optional) {#deep-dives}

#### Current WORK label cascade (the accuracy defect) {#work-cell-label-current}

`workCellLabel` in `select-work.ts` returns the first matching category and stops: goal → `"goal"`; `jobCounts.total > 0` → `finished/total`; `jobCounts.scheduled > 0` → bare scheduled count; `taskCounts.total > 0` → `completed/total`; else `"None"`. So a session with running jobs and a checklist reads jobs-only. [P01]/[P02]/[P07] replace this with the lingered aggregate; `composeWorkSummary` (`"N running, N scheduled, C/T tasks, N finished"`) is retained as the `aria-label` and popover footer.

#### The 5-minute linger and the clock {#linger-and-clock}

The scheduled countdown badge (`dev-card-telemetry-popovers.tsx`) is computed **once** from `firesAtMs − startedAtMs` — the file's own comment: *"No tick, no drift — a live per-second countdown would be false precision."* There is therefore **no idle ticker** in the WORK area. The linger honors that: while a turn streams, the row re-renders anyway (the TIME cell runs a live clock), so the display count updates for free; only when the session goes idle with `activeCount === 0 && recentlyDone > 0` does the renderer schedule **one** `setTimeout` at the earliest `(completion + WORK_LINGER_MS)`. When it fires, a `useState` bump forces a single recompute; `nowMs` has advanced past the window, `recentlyDone` drops, and the label settles to "None" with a quiet dot ([P08]). No interval, no drift.

#### ToolUseMessage timestamps {#toolusemessage-timestamps}

`ToolUseMessage` (`types.ts`) carries `startedAtMs: number` and `settledAtMs: number | null` — the latter is the terminal (result-landed) time. `reduceTaskListState` folds only `call.status === "done"` calls, so a completing `TaskUpdate` has a non-null `settledAtMs` to stamp as `TaskItem.completedAtMs`. Jobs already carry `endedAtMs`. Both feed `countRecentlyDone` without any clock in the pure fold.

#### The flicker root cause {#flicker-root-cause}

`useTaskListState`'s `useMemo` computes `latest = selectLatestTurnMessages(transcript, inflightMessages)` and returns `EMPTY_TASK_LIST_STATE` unless `hasTaskEvent(latest)`. When `handleSend` opens a new turn, `activeTurn.messages` is `[]`, so `hasTaskEvent([])` is false and the whole checklist collapses to "None" until the turn streams its first `Task*` frame. [P03] removes this gate.

#### The reducer batch-boundary rule (why full-transcript folding is safe) {#reducer-batch-boundary}

`reduceTaskListState` folds every `Task*` call in order but applies one cross-batch rule: a `TaskCreate` arriving over a **non-empty, fully-completed** list starts a fresh batch (`tasks = []`), so the assembled state is always the *current* batch. This is what makes unconditional full-transcript folding ([P03]) correct. The completion stamp ([P07]) is applied here: when a `taskupdate` sets `status: "completed"`, set `completedAtMs = call.settledAtMs ?? undefined` on the mutated item. Note the limitation feeding [R04]: an *incomplete* prior batch is not superseded, so a new create appends to it.

#### RemoteTrigger current touchpoints {#remote-trigger-touchpoints}

`RemoteTrigger` is dispatched as `remotetrigger` → `RemoteTriggerToolBlock`, which narrows input via `narrowRemoteTriggerInput` (`{ action, trigger_id?, body? }`). No ledger fold today. The reducer's `handleToolResult` scheduled-work `else` branch (`#reducer-scheduled-dispatch`) folds `schedulewakeup`/`croncreate`/`crondelete`; `remotetrigger` is added there ([P05]).

#### Import layering {#import-layering}

`remote-trigger-tool-block.tsx` imports React and `TugTooltip`. Importing its `narrowRemoteTriggerInput` into `select-scheduled-work.ts` (a store-layer module) would drag a component into the store layer. Step 4 therefore adds a local `narrowRemoteTriggerToolInput` mirroring the `{ action, trigger_id?, body? }` shape.

#### phaseLabels width reservation {#phaselabels-width}

`TugProgressIndicator` width-stabilizes by rendering a hidden ghost of each `phaseLabels` entry; the cell reserves the widest. Today `{ none: "None", max: "00/00" }` reserves 5ch ("00/00"). Switching to `{ none: "None", max: "00" }` reserves 4ch (floored by "None"), so the WORK cell gets ~1ch narrower and the fixed-width Z2 row re-centers once — a deliberate, one-time change. 2-digit counts fit; a rare 3-digit active count (100+) would overflow the ghost. Chosen consciously ([P07]); revisit only if counts routinely exceed 2 digits.

---

### Specification {#specification}

#### State Zone Mapping (tugdeck/tugways) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| `workActiveCount` / `workDisplayCount` (Z2 cell label) | local-data (derived) | pure fns over `useSyncExternalStore` snapshot | [L02] |
| `TaskItem.completedAtMs` (per-item completion time) | local-data (derived fold) | stamped in `reduceTaskListState` from `settledAtMs`; no new persistence | [L02] |
| linger settle re-render | appearance/local timer | `useState` tick + `useEffect`/`setTimeout` (single bounded), forces re-read only | [L06] |
| `Date.now()` linger comparison | local-data (clock read) | read at render; not persisted | — |
| Task list persistence across turns | local-data (derived) | `useTaskListState` fold over snapshot | [L02] |
| Popover "Tasks" label | structure (static text) | JSX string + CSS uppercase | [L06] |
| `"remote"` scheduled job rows | structure (session ledger) | reducer fold into `snapshot.jobs`, read via `useSyncExternalStore` | [L02] |

#### Key symbols (current) {#current-symbols}

Each bold label below is an anchor cited by the execution steps.

- **`#select-work-jobgroup`** {#select-work-jobgroup} — `workCellLabel`, `composeWorkSummary`, `workCellPose`, `selectWorkItems`, `WorkKind`, `jobGroup`, `jobActions` in `select-work.ts`. `jobGroup` routes any `status === "scheduled"` row to the Scheduled group regardless of `kind`; `jobActions` returns `["stop"]` (running), `["cancel"]` (cron scheduled), `["stop-loop"]` (other scheduled), `[]` (terminal).
- **`#job-counts`** {#job-counts} — `countJobs` / `JobCounts` in `select-jobs.ts`. Fields: `total` (= `jobs.length − scheduled`), `running`, `watching`, `scheduled`, `completed`, `failed`, `stopped`, `finished` (= `completed + failed + stopped`). Also here: `JobItem` (with `endedAtMs`, `kind`), `insertJob` (keys on `jobId`, idempotent, only fills an *empty* description), `flipEarliestElapsedScheduled`, `reapElapsedScheduled`, `clearTerminalJobs`, `isTerminalJobStatus`.
- **`#task-counts`** {#task-counts} — `countTasks` / `TaskCounts` in `body-kinds/todo-list-block.tsx`. Fields: `total`, `pending`, `inProgress`, `completed`. Incomplete = `total − completed`.
- **`#toolusemessage-timestamps`** {#toolusemessage-timestamps-sym} — `ToolUseMessage.startedAtMs` / `settledAtMs` in `types.ts` (see the deep dive `#toolusemessage-timestamps`).
- **`#scheduled-work-symbols`** {#scheduled-work-symbols} — `narrowCronCreateInput`, `scheduledRowFromCron`, `parseCronCreateResultId`, `flipEarliestElapsedScheduled`, `reapElapsedScheduled`, `stopScheduledRow` in `select-scheduled-work.ts`.
- **`#task-list-hook`** {#task-list-hook} — `useTaskListState`, `hasTaskEvent`, `selectLatestTurnMessages`, `iterateAllTaskCalls` in `hooks/use-task-list-state.ts`; `reduceTaskListState`, `taskListIsActive`, `EMPTY_TASK_LIST_STATE`, `TaskItem` in `select-task-list.ts`. (`taskListIsActive` currently has **no production consumer** — only its test — so it does not gate any live surface.)
- **`#task-list-hook-consumers`** {#task-list-hook-consumers} — production consumers of `useTaskListState`: `dev-card-telemetry-renderers.tsx` (WORK cell), `hooks/use-work-state.ts` (`useWorkState`), `blocks/task-inline-tool-block.tsx` (inline Task* subject resolution), and `gallery-transcript-registers.tsx`. Step 3 must confirm the persistence change is safe for each.
- **`#renderer-work-wiring`** {#renderer-work-wiring} — the WORK block in `dev-card-telemetry-renderers.tsx`: `taskCounts = countTasks(...)`, `jobCounts = countJobs(...)`, `workLabelText = workCellLabel(...)`, `workIndicatorState = workCellPose(...)`, `workSummary = composeWorkSummary(...)`, and the `<TugStatusCell priority="work">` block whose `<TugProgressIndicator>` carries `label`, `aria-label`, and `phaseLabels={{ none: "None", max: "00/00" }}`.
- **`#popover-groups-current`** {#popover-groups-current} — `WorkPopoverContent` in `dev-card-telemetry-popovers.tsx`; the `group("Goal"/"Running"/"Scheduled"/"Checklist"/"Finished", …)` calls, the footer `composeWorkSummary` + Clear button, and the static (no-tick) scheduled countdown badge.
- **`#reducer-scheduled-dispatch`** {#reducer-scheduled-dispatch} — the scheduled-work `else` block in `handleToolResult` (`reducer.ts`): the `schedulewakeup` / `croncreate` / `crondelete` branches, guarded by `!isReplaying && mutated.status === "done"`, followed by `jobs = reapElapsedScheduled(jobs, now)`. The `remotetrigger` branch is added here ([P05]).
- **`#gate-helper-consumers`** {#gate-helper-consumers} — `hasTaskEvent` / `selectLatestTurnMessages` are consumed only by `hooks/__tests__/use-task-list-state.test.ts` (verified: no non-test importer), so removing them touches only the hook and that test.
- `narrowRemoteTriggerInput`, `RemoteTriggerInput` (`{ action, trigger_id?, body? }`) — `blocks/remote-trigger-tool-block.tsx` (`#remote-trigger-touchpoints`, `#import-layering`).
- Existing tests to extend (all pure `bun:test`, none banned): `__tests__/select-work.test.ts` (already pins `workCellLabel`/`workCellPose`/`selectWorkItems` — its `workCellLabel` assertions encode the old cascade and must be **rewritten**), `__tests__/select-scheduled-work.test.ts`, `__tests__/select-jobs.test.ts`, `__tests__/select-task-list.test.ts`, `__tests__/reducer.scheduled-work.test.ts`, `hooks/__tests__/use-task-list-state.test.ts`.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** | Pure fns: `workActiveCount`, `countRecentlyDone`/`workDisplayCount`/`nextLingerExpiryMs` (inject `nowMs`), pose gate, hook fold, remote-row narrowing/fold, `flipEarliestElapsedScheduled` guard | Every step's core logic |
| **Integration (app-test)** | Real app via `just app-test`: cell text, held count, popover labels, no-zero across a turn boundary, remote row appears, inline task block resolves | Per behavior-visible step + integration checkpoint |
| **Build/Contract** | `bunx vite build` + `bun run check` clean | Every step |

#### What stays out of tests {#test-non-goals}

- No jsdom render tests or mock-store assertions — pure fns directly; UI via the real app under `just app-test`. Banned per project convention.
- No wall-clock-dependent unit tests — the linger helpers take `nowMs`/`lingerMs` params so time is injected, never read from the real clock in a test.
- tugcode/pulse narration — out of scope this phase.

---

### Execution Steps {#execution-steps}

> Commit after all checkpoints pass. Every tugdeck step runs `bunx vite build` and `bun run check` before commit.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Aggregate active-work count (pure) | done | dd756a14f |
| #step-2 | 5-minute completion linger + coherent pose | done | c478bf271 |
| #step-3 | Drop the turn-scoped gate (flicker fix) | done | f5a0c37f8 |
| #step-4 | Rename popover group Checklist → Tasks | done | a17e8bac8 |
| #step-5 | RemoteTrigger data model + narrowing (pure) | done | 9486d34f7 |
| #step-6 | RemoteTrigger reducer fold + wake guard | done | c27148ca4 |
| #step-7 | Integration checkpoint | done | 3f89cda03 |

---

#### Step 1: Aggregate active-work count (pure) {#step-1}

**Commit:** `tugdeck(work): aggregate active-work count for the Z2 WORK cell`

**References:** [P01] aggregate count, [P02] active definition, (#work-cell-label-current, #renderer-work-wiring, #job-counts, #task-counts, #success-criteria)

**Artifacts:**
- `workActiveCount` helper + rewritten `workCellLabel` in `select-work.ts`.
- Rewritten `workCellLabel` assertions in `__tests__/select-work.test.ts`.

**Tasks:**
- [ ] Add `export function workActiveCount(taskCounts, jobCounts, goal)` returning `(taskCounts.total − taskCounts.completed) + jobCounts.running + jobCounts.scheduled + (goalIsActive(goal) ? 1 : 0)` ([P02]).
- [ ] Rewrite `workCellLabel(taskCounts, jobCounts, goal)` to `const n = workActiveCount(...); return n === 0 ? "None" : String(n)` (the [P07] linger layers on in Step 2; this step ships the pure active count). Keep the signature so the renderer call is unchanged.
- [ ] Update the `workCellLabel` docstring (drop the "cascade / live work first" prose).
- [ ] **Rewrite** the existing `workCellLabel` assertions in `select-work.test.ts` (they currently expect `"1/2"`, `"1"`, `"1/3"`, `"None"` — the old cascade) to the aggregate-count outputs.

**Tests:**
- [ ] Unit: `workActiveCount` over tasks-only, jobs-only, scheduled-only, goal-only, and all-together (asserts the sum).
- [ ] Unit: `workCellLabel` → `"None"` at zero, aggregate string otherwise.

**Checkpoint:**
- [ ] `bun test tugdeck/src/lib/code-session-store` green
- [ ] `bun run check` && `bunx vite build`

---

#### Step 2: 5-minute completion linger + coherent pose {#step-2}

**Depends on:** #step-1

**Commit:** `tugdeck(work): linger the WORK count 5 min after the last completion`

**References:** [P07] linger, [P08] pose coherence, (#linger-and-clock, #toolusemessage-timestamps, #reducer-batch-boundary, #phaselabels-width, #renderer-work-wiring)

**Artifacts:**
- `completedAtMs` on `TaskItem` + stamping in `reduceTaskListState` (`select-task-list.ts`).
- `WORK_LINGER_MS`, `countRecentlyDone`, `workDisplayCount`, `nextLingerExpiryMs`, and a `recentlyCompleted`-aware `workCellPose` in `select-work.ts`.
- Renderer: `nowMs`, display-count wiring, the settle `useEffect`/`setTimeout`, and the `phaseLabels.max` change.

**Tasks:**
- [ ] Add `completedAtMs?: number` to `TaskItem` (`select-task-list.ts`); in `reduceTaskListState`'s `taskupdate` branch, when `status === "completed"`, set `completedAtMs = call.settledAtMs ?? undefined` on the mutated item ([P07], `#reducer-batch-boundary`).
- [ ] In `select-work.ts` add `export const WORK_LINGER_MS = 300_000`; `countRecentlyDone(tasks, jobs, nowMs, lingerMs)` (tasks: `status==="completed" && completedAtMs!=null && nowMs−completedAtMs<lingerMs`; jobs: `isTerminalJobStatus(status) && endedAtMs!=null && nowMs−endedAtMs<lingerMs`); `workDisplayCount(activeCount, recentlyDone) = activeCount>0 ? activeCount : recentlyDone`; `nextLingerExpiryMs(tasks, jobs, lingerMs)` → earliest `(completion+lingerMs)` still `> `the max seen completion, else `null`.
- [ ] Extend `workCellPose` with a `recentlyCompleted: boolean` param ([P08]): its "completed"-quiet outcomes return `"completed"` only when `recentlyCompleted`, else `"stopped"`; leave `"running"`/`"aborted"` unchanged.
- [ ] In the renderer (`#renderer-work-wiring`): compute `nowMs = Date.now()`, `recentlyDone = countRecentlyDone(taskListState.tasks, jobsLedger, nowMs, WORK_LINGER_MS)`, `activeCount = workActiveCount(...)`, `displayCount = workDisplayCount(activeCount, recentlyDone)`; feed `workCellLabel` semantics via `displayCount` (label = `displayCount===0 ? "None" : String(displayCount)`) and pass `recentlyCompleted = recentlyDone>0` to `workCellPose`. Add a `useState` tick + `useEffect` that, when `activeCount===0 && recentlyDone>0`, schedules `setTimeout` at `nextLingerExpiryMs(...) − nowMs` and clears it on re-run.
- [ ] Change the indicator `phaseLabels` to `{ none: "None", max: "00" }` (`#phaselabels-width`).

**Tests:**
- [ ] Unit: `countRecentlyDone` with injected `nowMs` — counts a task/job completed 1 min ago, drops it at 5+ min; ignores `completedAtMs`/`endedAtMs` absent.
- [ ] Unit: `workDisplayCount` — returns `activeCount` when >0, else `recentlyDone`; `nextLingerExpiryMs` returns the earliest future expiry or `null`.
- [ ] Unit: `workCellPose` truth table extended with `recentlyCompleted` — all-complete checklist → `"completed"` when recent, `"stopped"` when settled; running/aborted unchanged.
- [ ] Unit: `reduceTaskListState` stamps `completedAtMs` from `settledAtMs` on a completing `TaskUpdate`.

**Checkpoint:**
- [ ] `bun test tugdeck/src/lib/code-session-store` green
- [ ] `bun run check` && `bunx vite build`
- [ ] `just app-test` — complete the last active item; the cell holds the finished count (dot "completed"), not "None"; after the window the count settles and the dot goes quiet. (App-test may assert the held value immediately post-completion; the 5-min settle is validated by unit tests over the helpers.)

---

#### Step 3: Drop the turn-scoped gate (flicker fix) {#step-3}

**Depends on:** #step-1

**Commit:** `tugdeck(work): persist task list across turns; kill the zero-flicker`

**References:** [P03] drop gate, (#flicker-root-cause, #reducer-batch-boundary, #gate-helper-consumers, #task-list-hook-consumers)

**Artifacts:**
- Simplified `useTaskListState` fold; removed `hasTaskEvent` / `selectLatestTurnMessages` exports; rewritten module docstring; updated hook test.

**Tasks:**
- [ ] Replace the `useMemo` body with an unconditional fold: `return reduceTaskListState(iterateAllTaskCalls(snapshot.transcript, inflightMessages ?? []))` ([P03]).
- [ ] Remove `hasTaskEvent` and `selectLatestTurnMessages` (unused after the change, `#gate-helper-consumers`); keep `iterateAllTaskCalls`.
- [ ] Rewrite the module docstring's "turn-scoped visibility" section to state the persistence contract (current batch per the supersede rule; clears only when a fresh `TaskCreate` supersedes a fully-completed batch).
- [ ] **Audit consumers** (`#task-list-hook-consumers`): confirm `task-inline-tool-block.tsx` and `gallery-transcript-registers.tsx` behave correctly with an always-folded list (expected: neutral-to-positive). Note findings in the commit body.
- [ ] Update `use-task-list-state.test.ts`: drop the `hasTaskEvent`/`selectLatestTurnMessages` describe blocks; add a test folding a committed incomplete checklist + an empty in-flight turn → tasks still present.

**Tests:**
- [ ] Unit: incomplete committed checklist + empty active turn → non-empty fold (no collapse).
- [ ] Unit: `TaskCreate` over a fully-completed batch still starts a fresh batch (`#reducer-batch-boundary` regression guard).

**Checkpoint:**
- [ ] `bun test tugdeck/src/lib/code-session-store/hooks` green
- [ ] `bun run check` && `bunx vite build`
- [ ] `just app-test` — drive a checklist, open a new turn whose first block is non-`Task*`; the WORK cell count never reads `None`/`0` in the gap; the inline task block still renders its subjects.

---

#### Step 4: Rename popover group Checklist → Tasks {#step-4}

**Depends on:** #step-1

**Commit:** `tugdeck(work): label the popover task group "Tasks", not "Checklist"`

**References:** [P04] Tasks label, (#popover-groups-current)

**Artifacts:**
- One string change in `WorkPopoverContent`.

**Tasks:**
- [ ] Change `group("Checklist", taskRows, !hasTasks)` to `group("Tasks", taskRows, !hasTasks)`.
- [ ] Confirm no other user-visible "Checklist" string in the popover (the `WorkGroup` value `"checklist"` is internal, non-goal).

**Tests:**
- [ ] App-test/DOM: the rendered group header reads "TASKS"; "Checklist" appears nowhere in the popover.

**Checkpoint:**
- [ ] `bun run check` && `bunx vite build`
- [ ] `just app-test` — open the WORK popover with tasks present; the section header reads "TASKS".

---

#### Step 5: RemoteTrigger data model + narrowing (pure) {#step-5}

**Depends on:** #step-1

**Commit:** `tugdeck(work): model RemoteTrigger routines as "remote" scheduled rows`

**References:** [P05] remote row, [P06] no local flip, [Q01] result parsing, (#remote-trigger-touchpoints, #import-layering, #select-work-jobgroup, #scheduled-work-symbols)

**Artifacts:**
- `"remote"` added to `WorkKind` (`select-work.ts`) and `JobItem["kind"]` (`select-jobs.ts`).
- `parseRemoteTriggerCreateId`, `scheduledRowFromRemoteTrigger`, `relabelScheduledRow`, `narrowRemoteTriggerToolInput` in `select-scheduled-work.ts`.
- `jobActions` `[]` for a remote scheduled row; `flipEarliestElapsedScheduled` skips remote rows.

**Tasks:**
- [ ] Add `"remote"` to the `WorkKind` union and `JobItem["kind"]`; fix any exhaustiveness switches the compiler flags.
- [ ] In `jobActions`, a `scheduled` row of `kind === "remote"` returns `[]` (cron → `["cancel"]`, other scheduled → `["stop-loop"]` unchanged).
- [ ] Add `narrowRemoteTriggerToolInput(value)` in `select-scheduled-work.ts` mirroring `{ action, trigger_id?, body? }` (local, to avoid a lib→component import, `#import-layering`).
- [ ] Add `parseRemoteTriggerCreateId(result)`: `JSON.parse` (guard non-string/throw), return the first non-empty string among `id` / `trigger_id`, else `undefined` ([Q01]).
- [ ] Add `scheduledRowFromRemoteTrigger(toolUseId, input, result, nowMs)`: `kind: "remote"`, `status: "scheduled"`, `jobId: parseRemoteTriggerCreateId(result) ?? toolUseId`, `firesAtMs: null`, `scheduleLabel` from a `schedule`/`cron`/`when` string in `input.body` (else the id), `description` from `input.body`'s prompt/name (else the id).
- [ ] Add `relabelScheduledRow(jobs, jobId, description?, scheduleLabel?)` — updates an existing scheduled row's label fields by id; no-op if absent or non-scheduled (for `update`).
- [ ] In `flipEarliestElapsedScheduled`, `if (j.kind === "remote") continue;` in the candidate scan ([P06]).

**Tests:**
- [ ] Unit: `parseRemoteTriggerCreateId` parses `id`/`trigger_id`, `undefined` on non-JSON/missing.
- [ ] Unit: `scheduledRowFromRemoteTrigger` — keyed by parsed id, `firesAtMs: null`, `scheduleLabel` from body, `kind: "remote"`, `status: "scheduled"`.
- [ ] Unit: `relabelScheduledRow` updates an existing scheduled row, no-ops on unknown id.
- [ ] Unit: `flipEarliestElapsedScheduled` never flips a `"remote"` row even as the only/earliest scheduled row; `jobActions` returns `[]` for a remote scheduled row.

**Checkpoint:**
- [ ] `bun test tugdeck/src/lib/code-session-store` green
- [ ] `bun run check` && `bunx vite build`

---

#### Step 6: RemoteTrigger reducer fold + integration into the ledger {#step-6}

**Depends on:** #step-5

**Commit:** `tugdeck(work): fold RemoteTrigger create/update into the jobs ledger`

**References:** [P05] remote row, (#reducer-scheduled-dispatch, #remote-trigger-touchpoints)

**Artifacts:**
- A `remotetrigger` branch in `handleToolResult`'s scheduled-work `else` block (`reducer.ts`).

**Tasks:**
- [ ] In the `else` block after `crondelete` (`#reducer-scheduled-dispatch`), add `else if (toolName === "remotetrigger")`: narrow via `narrowRemoteTriggerToolInput`, read `action`; `"create"` → `insertJob(jobs, scheduledRowFromRemoteTrigger(mutated.toolUseId, input, mutated.result, now))`; `"update"` → `relabelScheduledRow(...)` by parsed id; `"run"`/`"list"`/`"get"` → no row ([P05]).
- [ ] Confirm `insertJob` idempotency on `jobId` (`#job-counts`) so a re-folded transcript (resume/replay) does not duplicate the row.
- [ ] Confirm no `task_started`/`task_updated` frame path exists for `remotetrigger` (there is none — tool-call-only), so the tool-result fold is the sole insert path.

**Tests:**
- [ ] Unit (in `reducer.scheduled-work.test.ts`): a `remotetrigger` `create` result inserts one `"remote"` scheduled row; `list`/`get`/`run` insert none; a second identical `create` fold does not duplicate; `update` relabels.

**Checkpoint:**
- [ ] `bun test tugdeck/src/lib/code-session-store` green
- [ ] `bun run check` && `bunx vite build`

---

#### Step 7: Integration checkpoint {#step-7}

**Depends on:** #step-2, #step-3, #step-4, #step-6

**Commit:** `N/A (verification only)`

**References:** [P01], [P02], [P03], [P04], [P05], [P06], [P07], [P08], (#success-criteria)

**Tasks:**
- [ ] Verify composition: the aggregate count includes remote scheduled rows; completing the last item holds the count for the linger window then settles; the popover shows "Running"/"Scheduled" (with the remote row)/"TASKS"; the checklist does not flicker across a turn.

**Tests:**
- [ ] App-test end-to-end (`just app-test`): synthesize an incomplete checklist + a running job + a `RemoteTrigger` `create` result; assert (a) the WORK cell reads the summed active count, (b) the popover has "Running", "Scheduled" (remote row), and "TASKS" groups, (c) a new turn does not drop the count to `None`, (d) completing the last item holds a non-zero count immediately after completion.

**Checkpoint:**
- [ ] `bun run check` && `bunx vite build`
- [ ] `just app-test` full sweep green

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** The Z2 `WORK` cell reports one honest aggregate active-work count across tasks, jobs, scheduled rows (including claude.ai `RemoteTrigger` routines), and goal — lingering 5 minutes after the last completion instead of snapping to "None", with a coherent indicator dot; the task list no longer flickers to zero across turns; and the popover names its task group "Tasks".

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] `workActiveCount` sums every active category; the cell renders the lingered `workDisplayCount` (or "None" once settled), dot coherent with the label. (Unit + app-test)
- [ ] No zero-flicker on a turn boundary over an incomplete checklist; all `useTaskListState` consumers verified. (Unit + app-test)
- [ ] Popover task group reads "TASKS". (App-test/DOM)
- [ ] `RemoteTrigger` `create` → one `"remote"` scheduled row in the popover + count; `update` relabels; `run`/`list`/`get` → none; no local wake flips it. (Unit + app-test)
- [ ] `bun run check`, `bunx vite build`, `just app-test` all green.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Parse a real next-run-time from `RemoteTrigger` results for a live remote-row countdown ([Q01]).
- [ ] Supersede an *incomplete* abandoned checklist after N idle turns ([R04]).
- [ ] Agent-team teammates (`SendMessage` / named agents) as running work rows.
- [ ] tugcode-side pulse narration for remote routines.
- [ ] Rename the internal `WorkGroup` `"checklist"` value to `"tasks"`.

| Checkpoint | Verification |
|------------|--------------|
| Aggregate count | `bun test` on `workActiveCount` + app-test cell text |
| 5-min linger | `bun test` on `countRecentlyDone`/`workDisplayCount`/pose gate + app-test held count |
| No flicker | `bun test` hook fold + app-test turn boundary |
| Tasks label | app-test popover header |
| RemoteTrigger row | `bun test` fold + app-test popover Scheduled group |
| Build/typecheck | `bun run check` && `bunx vite build` && `just app-test` |
