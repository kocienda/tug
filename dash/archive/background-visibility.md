<!-- devise-skeleton v4 -->

## Background-Work Visibility & Control {#background-visibility}

**Purpose:** Make the assistant's long-running, time-deferred background work — scheduled wakeups and crons — visible and controllable in the Z2 `JOBS` cell, the same way backgrounded Bash/Agent/Monitor jobs already are, so a watcher set up between turns is never again invisible, un-monitorable, and un-stoppable.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-06-24 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

In session `7772e2d5` the user asked the assistant to "set up a watcher that will notify me when the app-test suite finishes." The assistant scheduled itself with `ScheduleWakeup`. The UI then went dark for just over an hour — no count, no row, no countdown, no stop button — until a "stale scheduled-wakeup firing" turn reported results long after they were useful.

The Dev card already tracks two of three background-work mechanisms. Backgrounded **Bash/Agent** (`run_in_background: true`) and **Monitor** watchers both land in the session-lifetime `jobs` ledger behind the Z2 `JOBS` cell, with a per-row Stop button and a Clear action (`select-jobs.ts`, `reducer.ts` `handleTaskStarted` / `handleTaskUpdated`, `dev-card-telemetry-popovers.tsx`). The third mechanism — **`ScheduleWakeup` / `CronCreate`**, fired by claude's harness re-emitting `system/init` between turns — touches no ledger. Its only state is `wakeTrigger` on the snapshot, which is explicitly "Slice 1 has no React consumers" (`types.ts`), populated for the brief `waking` phase and cleared at `turn_complete`. The `ScheduleWakeup` tool call is also `visibility: "hidden"` in `dev-tool-visibility-policy.ts`, so it leaves no transcript ink either. The work is real and pending but structurally invisible.

This plan closes that gap in three prongs: (1) **surface** scheduled work as first-class rows in the existing `JOBS` ledger, captured from the tool-call stream at schedule time with a live fires-at countdown; (2) **control** it with a Cancel affordance, honest about the harness-ownership seam; (3) **steer** future tool choice by making the timer/duration mismatch visible and marking late fires as stale.

#### Strategy {#strategy}

- Fold scheduled work into the **existing** `jobs` ledger rather than minting a 7th Z2 cell — one mental model ("background & scheduled work"), one popover, reuse of `insertJob` / `clearTerminalJobs` / `countJobs` and the per-row Stop/Clear scaffolding.
- Register scheduled rows **incrementally in the reducer** from the `ScheduleWakeup` / `CronCreate` / `CronDelete` `tool_use` events — the `select-task-list.ts` precedent for reading tool calls, but folded into accumulated state like `handleTaskStarted` rather than re-derived each render.
- Introduce an honest **`"scheduled"`** `JobStatus` (nothing is executing — work is promised for later) instead of overloading `"running"`.
- Drive the row's life by **time**: `firesAtMs` gives a derived countdown (display only); the row stays `scheduled` until the id-less wake re-init flips the earliest elapsed row, or the reaper stops a never-fired one. This sidesteps the hard constraint that a fired wake carries no `task_id` to correlate by.
- Be **truthful about cancellation**: the harness owns the schedule and tugcode is a passive detector. Ship a real soft-cancel (inject a user message so the assistant drops the timer) now; defer a wire-level cancel frame behind an SDK-capability question.
- Use the new countdown to **self-correct tool choice**: a row reading "fires in 52:00" against an 8-minute suite makes the mismatch obvious, and a "fired late" badge names the staleness the user hit.

#### Success Criteria (Measurable) {#success-criteria}

> Make these falsifiable. Avoid "works well".

- After the assistant calls `ScheduleWakeup`, the Z2 `JOBS` cell pulses and a popover row appears within one render, showing the wakeup's reason and a fires-in countdown that ticks down each second. (Reducer fixture test + on-demand real-claude app-test.)
- A scheduled row leaves the "scheduled" group when its **wake fires** (flipped to `completed`, "fired late" if the fire lands more than `STALE_THRESHOLD_MS` past target) or when the **reaper** stops it (`firesAtMs + REAP_GRACE_MS` past, never fired); the displayed countdown reaching zero alone does **not** change status — the row reads "firing…" while still `scheduled`. (`select-scheduled-work.ts` unit tests + reducer fixture test.)
- The popover's Cancel button drops the timer for the cases the harness permits: a **cron** is `CronDelete`d (no further fires), a **re-arming loop** ends after at most one more fire; for a **lone one-shot wakeup** Cancel is disabled (the harness-owned fire is unavoidable until [Q01]). (On-demand real-claude app-test.)
- `countJobs` reports a `scheduled` sub-count and `composeJobsSummary` renders "N scheduled"; `clearTerminalJobs` never drops a scheduled row. (`select-jobs.ts` unit tests.)
- A session respawn (`session_init`) sweeps stale scheduled rows to `stopped`, matching the existing running-job sweep. (Reducer test.)

#### Scope {#scope}

1. Extend the `jobs` data model + pure helpers in `select-jobs.ts` for a `"scheduled"` status and `"wakeup"` / `"cron"` kinds with a `firesAtMs` target.
2. New `select-scheduled-work.ts`: narrow `ScheduleWakeup` / `CronCreate` / `CronDelete` `tool_use.input`, build scheduled rows, and the elapse/late/flip helpers.
3. Reducer hooks: insert/remove scheduled rows from tool calls (at the `handleToolResult` completion branch); flip the earliest elapsed scheduled row on an id-less `WakeStarted`; reap long-elapsed rows; sweep on `session_init`.
4. Popover + cell: a Scheduled group with live countdown, a Cancel affordance, and `JOBS`-cell pulse/count covering scheduled rows.
5. Soft-cancel store method (`cancelScheduledWork`) on the existing user-message submission path, wired to the Cancel button.
6. Staleness ("fired late") badge plus a short best-practice note steering "notify me when X finishes" toward a tracked background-job + Monitor.

#### Non-goals (Explicitly out of scope) {#non-goals}

- A wire-level `cancel_wakeup` CODE_INPUT frame (gated on [Q01]; soft-cancel ships instead).
- A precise client-computed next-occurrence countdown for recurring crons (gated on [Q02]; v1 labels crons "recurring (<expr>)").
- Un-hiding the `ScheduleWakeup` transcript row — the `JOBS` row is the visible surface; the transcript stays clean ([P06]).
- A new Z2 cell — scheduled work folds into `JOBS` ([P01]).
- Changing how the harness schedules or fires wakeups (entirely upstream/passive-detector territory).

#### Dependencies / Prerequisites {#dependencies}

- Existing `jobs` ledger + Z2 `JOBS` cell (`select-jobs.ts`, `use-jobs-state.ts`, `dev-card-telemetry-renderers.tsx`, `dev-card-telemetry-popovers.tsx`).
- Existing wake plumbing: `WakeStartedEvent` (`events.ts`), `handleWakeStarted` and the `wakeTrigger` field (`reducer.ts`, `types.ts`), captured wake fixtures under `tugcode/src/__tests__/` and the jobs-spike fixtures.
- The existing user-message submission path on `CodeSessionStore` (the prompt composer's send), reused by `cancelScheduledWork`.

#### Constraints {#constraints}

- **Tuglaws**: ledger rows are store state read via `useSyncExternalStore` ([L02]); the per-second countdown "now" is read via the **exported `useLiveTick()` hook** (a `useSyncExternalStore` over the shared 1 Hz tick store, already used by `JobElapsedValue`) ([L02]) — no new local interval, no `useState` tick; cell pulse is appearance via the existing `TugProgressIndicator` pose, not React-driven styling ([L06]).
- **Warnings are errors** across the workspace; ts/lint must stay clean.
- The fired wake re-init (`ScheduleWakeup`/`CronCreate` cohort) carries **empty `task_id` / `tool_use_id`** — no id to correlate the fire to a specific row ([P04], Risk R01).
- tugcode is a **passive wake detector** — it does not schedule, persist, or cancel; cancellation cannot bypass the harness ([P05], [Q01]).
- Use real code paths on real/captured data — no mock-store assertions, no jsdom render tests (project memory).

#### Assumptions {#assumptions}

- **Keystone (validate first, #step-3):** `ScheduleWakeup` / `CronCreate` / `CronDelete` surface a `tool_use` + `tool_result` pair that reaches the reducer's scratch (so `handleToolResult` fires for them). Strong evidence: `dev-tool-visibility-policy.ts` classifies `schedulewakeup`, and that policy only sees tool calls the deck ingests; the reducer mints all tool calls into scratch regardless of later transcript visibility ([P06]). Pinned by a captured fixture before building on it.
- The `ScheduleWakeup` `tool_use.input` carries `delaySeconds`, `reason`, and `prompt`; `CronCreate` carries a cron expression and `reason`; `CronDelete` carries the cron id. (Narrowers are defensive per [P03] precedent — a drifted shape is dropped, not guessed.)
- **`CronCreate`'s `tool_result` echoes a parseable cron id** (the `Task #N` / monitor-task-id precedent) — *assumed, not verified*. If the echo carries no id, the cron row still displays and Cancel falls back to a soft-message naming the expression rather than matching by `jobId` (#step-2 validates and picks the path).
- The reducer may stamp `firesAtMs` from `Date.now()` at the tool call's completion, consistent with `handleTaskStarted`'s `Date.now()` start stamp.
- One-shot wakeups fire roughly in scheduled order, making "flip the earliest elapsed scheduled row" a sound correlation heuristic ([P04]).
- Scheduled rows do **not** survive Developer ▸ Reload: the `handleToolResult` ledger fold is `!isReplaying`-gated, so a re-resume from JSONL starts the jobs ledger empty — consistent with existing background-job behavior, and benign since the harness does not re-fire a pending wake after `--resume`.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan uses explicit anchors and rich `References:` lines as defined in the skeleton.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Is there a client-reachable verb to cancel a pending wakeup/cron? (OPEN) {#q01-cancel-verb}

**Question:** Does the claude SDK / tugcode bridge expose any control message that cancels a harness-scheduled `ScheduleWakeup` or `CronCreate` from the client, the way `stop_task` kills a background job?

**Why it matters:** It decides whether prong-2 can ever be a truthful wire-level Stop (row flips on confirmation) or is permanently capped at soft-cancel (inject a user message and let the assistant `CronDelete` / not re-arm). Guessing wrong means either building a frame the harness ignores or under-delivering control.

**Options (if known):**
- A `cancel_wakeup` / `cancel_cron` CODE_INPUT frame, if the SDK supports it.
- Soft-cancel via injected user message only (assistant calls `CronDelete` or stops re-arming).

**Plan to resolve:** Read `tugcode/src/session.ts` wake handling + the SDK's scheduler surface for any cancel/delete control verb; check the wake-investigation findings.

**Resolution:** DEFERRED — ship soft-cancel ([P05]); spike the wire-cancel verb in a follow-on. The Cancel affordance lands now via the user-message path so control exists day one regardless of the answer.

#### [Q02] Countdown for recurring crons (OPEN) {#q02-cron-next-fire}

**Question:** Do we compute a cron's next occurrence client-side for a live countdown, or label it "recurring (<expr>)" without one in v1?

**Why it matters:** A correct next-fire needs a cron parser and timezone handling; getting it subtly wrong shows a misleading countdown.

**Plan to resolve:** Ship the label in v1; revisit a parser if crons become common.

**Resolution:** DEFERRED to follow-on (#roadmap). v1: one-shot wakeups get the precise `firesAtMs` countdown; crons get a recurring label.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Id-less wake flips the wrong scheduled row | med | low | Flip earliest-elapsed; reaper + wake reconcile status | Multiple concurrent wakeups become common |
| Shared-tick subscription over-renders popover | low | med | Subtree-only re-render via `useSyncExternalStore`; ledger identity stable via [L02] | Popover render cost shows in profiling |
| Soft-cancel injects an unexpected user turn | med | low | Enable only when idle; explicit button; clear message | Users report surprise turns |
| Respawn leaves stale scheduled rows | low | med | Sweep scheduled → stopped on `session_init` | — |

**Risk R01: Id-less wake mis-correlation** {#r01-idless-wake}

- **Risk:** The fired wake re-init carries no `task_id`, so flipping "the earliest elapsed scheduled row" can mislabel which wakeup fired when several are pending at once.
- **Mitigation:** Flip earliest-elapsed (one-shot wakeups fire roughly in order); the displayed countdown resolves to "firing…" at zero while status stays `scheduled`, and the wake flip or reaper reconciles status, so a missed or mis-targeted flip is eventually corrected (within `REAP_GRACE_MS`).
- **Residual risk:** With multiple simultaneous wakeups a row may be briefly mislabeled before the flip/reaper reconciles it.

**Risk R02: Countdown re-render cost** {#r02-countdown-render}

- **Risk:** Reading the shared 1 Hz `tickValue` store re-renders the subscribed popover subtree every second.
- **Mitigation:** The countdown subscribes via `useSyncExternalStore` ([L02]), so only the open popover's subtree re-renders; the existing `tickValue` interval already runs for the TIME cell (no new timer is added), and the `jobs` ledger reference stays stable across quiescent rebuilds so nothing downstream churns. The cell-level pulse derives from the ledger pose, not the tick, so it needs no per-second value.
- **Residual risk:** One 1 Hz re-render of the open popover subtree only.

**Risk R03: Soft-cancel creates a turn** {#r03-softcancel-turn}

- **Risk:** Cancel injects a user message the user didn't type, which could interleave with in-flight work.
- **Mitigation:** Gate the Cancel button to idle; label the injected message clearly; it is an explicit user click.
- **Residual risk:** Cancellation costs one assistant turn until a wire-level verb exists ([Q01]).

---

### Design Decisions {#design-decisions}

#### [P01] Fold scheduled work into the existing JOBS ledger (DECIDED) {#p01-fold-into-jobs}

**Decision:** Scheduled wakeups and crons become rows in the existing `jobs` ledger behind the Z2 `JOBS` cell — not a new 7th cell.

**Rationale:**
- The user already reads `JOBS` as "background work"; monitors there are themselves non-CPU "waiting" rows, so a time-deferred wakeup is a natural sibling.
- Reuses `insertJob`, `clearTerminalJobs`, `countJobs`, the popover, and the per-row Stop/Clear scaffolding instead of building a parallel cell + popover.
- Z2 is already six cells wide; a seventh crowds the row.

**Implications:**
- `JobStatus` and `JobItem.kind` gain members; every pure helper that switches on them must learn the new cases.
- The `JOBS` cell label/scope reads as "background & scheduled work"; the popover groups Running / Scheduled / Finished.

#### [P02] Register scheduled rows incrementally in the reducer from tool calls (DECIDED) {#p02-reducer-registration}

**Decision:** Insert/remove scheduled rows from the `ScheduleWakeup` / `CronCreate` / `CronDelete` `tool_use` events inside the reducer, folding into accumulated `state.jobs`, at the **`handleToolResult` tool-completion branch** — the same `!isReplaying && mutated.status === "done"` site where the background-job launch-echo insert (`parseBackgroundLaunchResult`) already runs — rather than re-deriving a selector over the whole tool-call stream each render.

**Rationale:**
- The `jobs` ledger is accumulated state, not a per-render derivation; a re-derived selector (the `select-task-list.ts` shape) would diverge from how jobs already accumulate.
- The hook point is concrete and precedented: `handleToolResult` already inserts a job row when a backgrounded launch's result lands (its `status === "done"` branch parses the echo for a job id). Scheduled-row registration is the same shape on the same branch — keyed off the launching `tool_use`'s name and input, not a separate frame (no `task_started` exists for wakeups).

**Implications:**
- Narrowing of the three tool inputs is pure and unit-testable in `select-scheduled-work.ts`; the reducer calls it from the `handleToolResult` `done` branch.
- **No supersede on re-arm.** A re-armed wakeup (the `/loop` pattern) issues a *new* `ScheduleWakeup` each turn with a *distinct* `tool_use_id`, so there is no stable key to dedupe on — and none is needed: by the time the next wakeup is scheduled, the prior one has already fired (that is why a new turn exists), so its row is already terminal (flipped by that wake, or reaped if the flip mis-targeted). Each scheduled row is keyed by its own `tool_use_id` and lives independently; accumulation is bounded by `clearTerminalJobs` + the elapsed-row reaper (#p04-time-driven).

#### [P03] Honest "scheduled" status, not overloaded "running" (DECIDED) {#p03-scheduled-status}

**Decision:** Add `JobStatus` `"scheduled"` for rows whose work is promised for a future time and is not executing now; treat it as pulse-worthy (work pending) but split out from `running` in summaries, the way `watching` is split today.

**Rationale:**
- A wakeup is not running — labeling it `"running"` would lie about live activity; the countdown distinguishes "later" from "now".
- `composeJobsSummary` already models a split-out bucket (`watching`), so "N scheduled" fits the existing idiom.

**Implications:**
- `isTerminalJobStatus` stays false for `"scheduled"`; a new `isScheduledJobStatus` guard; `clearTerminalJobs` preserves scheduled rows alongside running ones; `jobsCellPose` pulses on scheduled.

#### [P04] Time-driven life, id-less fire flips earliest elapsed (DECIDED) {#p04-time-driven}

**Decision:** A scheduled wakeup carries `firesAtMs`; the countdown and elapse are derived from time. When the fired wake re-init is the **id-less cohort** (`wake_trigger.task_id === ""` — the `ScheduleWakeup`/`CronCreate` re-init, as opposed to a background-job/Monitor completion which carries a real id), `handleWakeStarted` flips the **earliest elapsed scheduled** row to terminal (marking it late past the staleness threshold). A reaper folds long-elapsed-but-never-flipped scheduled rows to `stopped` so they cannot linger un-clearable.

**Rationale:**
- We cannot correlate an id-less wake to a specific row, but we can register precisely at schedule time and reconcile by time.
- Time-derived elapse means the row resolves correctly even if the wake-flip targets imperfectly (Risk R01).
- The cohort guard is required for correctness: without it, a background-job completion wake (Cohort A, real `task_id`) would *also* flip an unrelated scheduled row. The existing fold (by `trigger.taskId`) already no-ops on the empty id; the new scheduled-flip is the complementary branch gated on `taskId === ""`.

**Implications:**
- `firesAtMs` is stamped from `Date.now()` at tool completion; `flipEarliestElapsedScheduled`, `isWakeLate`, and `reapElapsedScheduled` live in `select-scheduled-work.ts`.
- The scheduled-flip must be threaded through **every** return branch of `handleWakeStarted` (nested-wake, mid-turn-refused, replaying, idle-mint), the same way the `jobs` fold is threaded today — a watch-item for the build.
- **Reaper:** the reducer has no clock of its own, so on any subsequent event it folds scheduled rows whose `firesAtMs` is more than `REAP_GRACE_MS` past `Date.now()` (and that never received a flip) to `stopped`. This bounds accumulation and guarantees `clearTerminalJobs` can eventually reclaim a mis-targeted row (Risk R01 residual).
- **Threshold ordering:** `STALE_THRESHOLD_MS` (late-badge boundary for a row that *did* fire) and `REAP_GRACE_MS` (GC boundary for a row that *never* fired) serve different purposes; `REAP_GRACE_MS` must be comfortably **larger** than `STALE_THRESHOLD_MS` so the "fired late" window always has room to show before a never-fired row is reaped.
- The popover renders the countdown via the **exported `useLiveTick()` hook** (`dev-card-telemetry-renderers.tsx`) — already consumed by the Jobs popover's `JobElapsedValue` leaf for live per-row time — deriving `firesAtMs − tick` at render. The hook's interval is **subscription-driven, not turn-gated**, so the countdown updates while the session is idle between turns (exactly when a wakeup lives) and costs nothing until the popover mounts. No new interval, no `useState` tick; the ledger itself does not tick.

#### [P05] Cancellation is soft now, wire-level deferred (DECIDED) {#p05-soft-cancel}

**Decision:** The Cancel affordance sends a user message instructing the assistant to drop the named timer. Its reach is bounded by what the harness actually permits, and the UI is honest about that boundary:

- **Cron** (`kind:"cron"`): the assistant `CronDelete`s it — a genuine cancellation, no further fires.
- **Re-arming loop** (`/loop`): the assistant stops re-arming — the loop ends after **at most one more fire** (the already-pending wakeup still lands; the assistant then declines to schedule the next).
- **Lone one-shot `ScheduleWakeup`**: it is fire-once and harness-owned — neither `CronDelete` nor "stop re-arming" applies, so **nothing can cancel it short of the harness firing it**. The fire still lands. Cancel is therefore disabled (or labeled "will still fire once") for a lone one-shot row; the value already delivered is that the row is *visible and labeled*, not silently pending.

No local-only row removal in any case.

**Rationale:**
- The harness owns the schedule and tugcode is a passive detector — a local dismiss would hide a row while the wake still fires, reproducing the exact "stale surprise" we are fixing.
- Soft-cancel is real, truthful control for crons and loops today; true one-shot cancellation needs a wire-level verb and depends on [Q01].

**Implications:**
- New `cancelScheduledWork(jobId)` on `CodeSessionStore` built on the `send(text, atoms, opts)` user-message path; gated to idle (Risk R03). The injected message names the timer (cron id / loop reason) specifically.
- The Cancel button is enabled for cron and loop rows; for a lone one-shot wakeup it is disabled with a tooltip explaining the fire is unavoidable until [Q01] lands.
- The row clears when the assistant acts (`CronDelete` → remove/stop) or when the wake fires/elapses, never optimistically.

#### [P06] Keep ScheduleWakeup transcript-hidden; the JOBS row is the surface (DECIDED) {#p06-keep-hidden}

**Decision:** Do not change `dev-tool-visibility-policy.ts` — the `ScheduleWakeup` call stays `visibility: "hidden"`; the new `JOBS` row is the user-visible representation.

**Rationale:**
- The visibility policy's own rationale is "the wakeup itself is the user-visible event, not the scheduling call" — the `JOBS` row now *is* that user-visible surface, so the policy is satisfied without transcript ink.

**Implications:**
- Registration reads the `tool_use` regardless of transcript visibility; no transcript-renderer change.

#### [P07] Surface staleness to steer tool choice (DECIDED) {#p07-staleness-steer}

**Decision:** Mark a wake that fires well past its target as "fired late," and document the best practice that "notify me when X finishes" should prefer a backgrounded job + Monitor (event-driven, already tracked) over a bare timed wakeup.

**Rationale:**
- The countdown makes a duration mismatch ("fires in 52:00" vs an 8-minute suite) self-evident; a late badge names the staleness the user hit and invites redirection.

**Implications:**
- The badge is **derived at render** via `isWakeLate(firesAtMs, endedAtMs)` — no stored `late` field on `JobItem` (#inputs-outputs); a short note added to an existing doc surface, not a freestanding dropfile (project memory).

---

### Specification {#specification}

#### Inputs and Outputs {#inputs-outputs}

**Extended `JobItem`** (`select-jobs.ts`):

- `kind: "bash" | "agent" | "monitor" | "unknown" | "wakeup" | "cron"`
- `status: "running" | "scheduled" | "completed" | "failed" | "stopped"`
- `firesAtMs?: number | null` — target fire time for one-shot wakeups; `null`/absent for crons (recurring) and non-scheduled rows.
- `scheduleLabel?: string` — human label for recurring crons (e.g. `"recurring (*/5 * * * *)"`).
- Existing fields unchanged (`jobId`, `source`, `toolUseId`, `description`, `outputFile?`, `startedAtMs`, `endedAtMs`).

**Semantics:**

- A `ScheduleWakeup` completion (`handleToolResult` `status === "done"` branch) inserts a `kind:"wakeup"`, `status:"scheduled"` row keyed by its own `tool_use_id`, `firesAtMs = Date.now() + delaySeconds*1000`, `description = reason`. No supersede — each call is its own row (#p02-reducer-registration).
- A `CronCreate` completion inserts a `kind:"cron"`, `status:"scheduled"` row, `scheduleLabel` from the expression, `firesAtMs = null`, and captures the **cron id from the `CronCreate` `tool_result` echo** (the `Task #N` / monitor-task-id precedent) as `jobId` so a later `CronDelete` can match it.
- A `CronDelete` completion removes (or flips to `stopped`) the cron row whose `jobId` matches the deleted cron id.
- `handleWakeStarted` flips a scheduled row **only when `wake_trigger.task_id === ""`** (the id-less `ScheduleWakeup`/`CronCreate` cohort): the earliest scheduled row whose `firesAtMs <= now` (one-shot), else the earliest scheduled cron, to `completed` with `endedAtMs = now`. A wake with a real `task_id` (background-job/Monitor completion) never touches scheduled rows.
- **"Fired late" is derived, not a stored field.** No `late` flag is added to `JobItem`; the badge derives at render via `isWakeLate(firesAtMs, endedAtMs)` (`endedAtMs - firesAtMs > STALE_THRESHOLD_MS`) for a `completed` row. A reaper-stopped row (`status:"stopped"`, `firesAtMs` in the past) renders "never fired" — also derived from existing fields. The only new `JobItem` fields are `firesAtMs` / `scheduleLabel`.
- A row stays `status:"scheduled"` from `firesAtMs` onward; the displayed countdown is purely derived. While `now < firesAtMs` it reads "fires in MM:SS"; at/after `firesAtMs` (unflipped, un-reaped) it reads "firing…" — the status does not change on the countdown reaching zero, only on a wake flip or the reaper.
- On any event, `reapElapsedScheduled` folds scheduled rows whose `firesAtMs` is more than `REAP_GRACE_MS` past `Date.now()` (and unflipped) to `stopped`, so a mis-targeted row cannot linger un-clearable. `REAP_GRACE_MS` > `STALE_THRESHOLD_MS` (#p04-time-driven).
- `session_init` sweeps any remaining `scheduled` rows to `stopped` (a respawned claude does not re-fire harness wakeups).
- `clearTerminalJobs` preserves `running` **and** `scheduled` rows.

**Display derivation:**

- `countJobs` adds a `scheduled` sub-count to `JobCounts`; `running` continues to exclude it.
- **The compact cell `finished/total` reading excludes scheduled rows from both numerator and denominator** — a time-deferred promise is not an in-flight work unit, so a lone pending wakeup must not read "0/1". `total` for the cell numerator counts only non-scheduled rows; scheduled work surfaces via the pulse + the "N scheduled" summary, not the fraction. (When a wakeup fires it becomes `completed`, a real work unit, and enters the fraction then.)
- `jobsCellPose` returns `running` (pulse) when any row is `running` **or** `scheduled`.
- `composeJobsSummary` appends `"N scheduled"` (zero-drop, same idiom as `watching`).

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| Scheduled rows in `jobs` ledger | structure (store) | reducer fold + `useJobsState` / `useSyncExternalStore` | [L02] |
| Per-second countdown "now" | structure (shared tick store) | exported `useLiveTick()` (already used by `JobElapsedValue`); countdown = `firesAtMs − tick` derived at render; subscription-driven, ticks while idle — no new interval, no `useState` tick | [L02] |
| `JOBS` cell pulse pose | appearance | `TugProgressIndicator` pose derived from ledger; CSS/DOM, no React styling | [L06] |
| Cancel → user message | structure | `cancelScheduledWork` → `send(text, atoms, opts)` → CODE_INPUT | [L02] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/lib/code-session-store/select-scheduled-work.ts` | Narrow `ScheduleWakeup`/`CronCreate`/`CronDelete` inputs; build scheduled rows; `flipEarliestElapsedScheduled`, `reapElapsedScheduled`, `isWakeLate`, `STALE_THRESHOLD_MS`, `REAP_GRACE_MS`. |
| `tugdeck/src/lib/code-session-store/__tests__/select-scheduled-work.test.ts` | Unit tests for narrowing, row construction, elapse/late, earliest-flip. |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `JobStatus` | type | `select-jobs.ts` | add `"scheduled"` |
| `JobItem.kind` | type | `select-jobs.ts` | add `"wakeup" \| "cron"` |
| `JobItem.firesAtMs` / `scheduleLabel` | field | `select-jobs.ts` | new optional fields |
| `isScheduledJobStatus` | fn | `select-jobs.ts` | new guard |
| `isTerminalJobStatus`, `countJobs`, `jobsCellPose`, `composeJobsSummary`, `clearTerminalJobs`, `markRunningJobsStopped` | fn | `select-jobs.ts` | learn `"scheduled"` |
| `JobCounts.scheduled` | field | `select-jobs.ts` | new sub-count |
| `narrowScheduleWakeupInput` / `narrowCronCreateInput` / `narrowCronDeleteInput` | fn | `select-scheduled-work.ts` | defensive narrowers |
| `scheduledRowFromWakeup` / `scheduledRowFromCron` | fn | `select-scheduled-work.ts` | build `JobItem`; cron captures id from `CronCreate` result echo |
| `flipEarliestElapsedScheduled` / `reapElapsedScheduled` / `isWakeLate` / `sweepScheduledStopped` | fn | `select-scheduled-work.ts` | terminal/reaper/sweep helpers |
| scheduled-row registration | reducer branch | `reducer.ts` | `handleToolResult` `status === "done"` branch (alongside the launch-echo insert) |
| `handleWakeStarted` | fn | `reducer.ts` | flip earliest elapsed scheduled when `task_id === ""`; thread through all return branches |
| `reapElapsedScheduled` call | reducer | `reducer.ts` | fold long-elapsed scheduled rows to `stopped` on any event |
| `session_init` sweep | reducer branch | `reducer.ts` | scheduled → stopped on respawn |
| `cancelScheduledWork` | method | `code-session-store.ts` | soft-cancel via `send(...)`; cron/loop only |
| Scheduled group + countdown + Cancel | component | `dev-card-telemetry-popovers.tsx` | extend `JobsPopoverContent` / `JobRow`; Cancel disabled for lone one-shot |
| `JOBS` cell pose/count | component | `dev-card-telemetry-renderers.tsx` | scheduled pulses + counts; `finished/total` excludes scheduled; countdown via exported `useLiveTick()` |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** | Pure helpers in `select-jobs.ts` / `select-scheduled-work.ts` | Narrowing, counts, pose, summary, elapse/late/flip |
| **Integration (reducer)** | Reducer folding real/captured frames | Register, cohort-guarded wake-flip, reaper, respawn sweep |
| **App-test (on-demand, real-claude)** | Real `ScheduleWakeup` through the Dev card | End-to-end appearance, countdown, cancel |

#### What stays out of tests {#test-non-goals}

- No mock-store assertion tests and no jsdom render tests of the countdown — banned patterns; test the pure time math (`isWakeLate`, `flipEarliestElapsedScheduled`) and the reducer fold on real frames instead (project memory).
- No test of the harness's own firing/jitter — upstream and out of our control.

---

### Execution Steps {#execution-steps}

> Commit after all checkpoints pass.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Extend jobs data model + pure helpers | done | 42677c4df |
| #step-2 | Scheduled-work narrowing + row builders | done | 43faa36f7 |
| #step-3 | Reducer registration of scheduled rows | done | 65832b56d |
| #step-4 | Wake-flip + respawn sweep | done | 33f6af582 |
| #step-5 | Popover Scheduled group + countdown | done | 42f3ce0d9 |
| #step-6 | Cell pulse/count + soft-cancel wiring | done | f0cbfd9c0 |
| #step-7 | Staleness badge + steering note | done | dd5f77048 |
| #step-8 | Integration checkpoint | done | N/A (verification only) |

#### Step 1: Extend jobs data model + pure helpers {#step-1}

**Commit:** `feat(tugdeck): add scheduled job status and wakeup/cron kinds to jobs ledger`

**References:** [P01] Fold into jobs, [P03] Scheduled status, Spec (#inputs-outputs), (#symbols)

**Artifacts:**
- `select-jobs.ts`: `JobStatus += "scheduled"`; `JobItem.kind += "wakeup"|"cron"`; new `firesAtMs?` / `scheduleLabel?` fields; `isScheduledJobStatus`; `JobCounts.scheduled`; updated `isTerminalJobStatus`, `countJobs`, `jobsCellPose`, `composeJobsSummary`, `clearTerminalJobs`, `markRunningJobsStopped`.

**Tasks:**
- [ ] Add status/kind/fields and the new guard.
- [ ] Teach every switch/branch the `"scheduled"` case (preserve in clear, pulse in pose, split in summary).

**Tests:**
- [ ] Unit: `countJobs` reports `scheduled` and **excludes it from the `finished/total` fraction** (a lone scheduled row does not read "0/1"); `composeJobsSummary` renders "N scheduled"; `clearTerminalJobs` keeps scheduled; `jobsCellPose` pulses on scheduled-only.

**Checkpoint:**
- [ ] `cd tugdeck && bun test select-jobs`
- [ ] `cd tugdeck && bun run typecheck`

---

#### Step 2: Scheduled-work narrowing + row builders {#step-2}

**Depends on:** #step-1

**Commit:** `feat(tugdeck): narrow ScheduleWakeup/Cron tool inputs into scheduled jobs`

**References:** [P02] Reducer registration, [P04] Time-driven, [Q02] Cron countdown, (#new-files, #inputs-outputs)

**Artifacts:**
- New `select-scheduled-work.ts`: `narrowScheduleWakeupInput` / `narrowCronCreateInput` / `narrowCronDeleteInput`; `scheduledRowFromWakeup` / `scheduledRowFromCron`; `flipEarliestElapsedScheduled`; `reapElapsedScheduled`; `isWakeLate`; `sweepScheduledStopped`; `STALE_THRESHOLD_MS`; `REAP_GRACE_MS`; cron-id parse from the `CronCreate` result echo.

**Tasks:**
- [ ] Defensive narrowers (drop drifted shapes, `select-task-list.ts` posture).
- [ ] Build wakeup row (`firesAtMs = completionMs + delaySeconds*1000`, `description = reason`) and cron row (`scheduleLabel`, `firesAtMs = null`, `jobId` = cron id parsed from the result echo).
- [ ] Earliest-elapsed flip + late detection + elapsed-row reaper.

**Tests:**
- [ ] Unit: narrowing happy/drifted paths; `firesAtMs` math; cron-id parse; `isWakeLate` boundary; `flipEarliestElapsedScheduled` picks earliest elapsed and is a no-op on none; `reapElapsedScheduled` stops only rows past `REAP_GRACE_MS`.

**Checkpoint:**
- [ ] `cd tugdeck && bun test select-scheduled-work`

---

#### Step 3: Reducer registration of scheduled rows {#step-3}

**Depends on:** #step-2

**Commit:** `feat(tugdeck): register scheduled wakeups/crons in the jobs reducer`

**References:** [P02] Reducer registration, [P06] Keep hidden, (#semantics, #symbols)

**Artifacts:**
- `reducer.ts`: in the `handleToolResult` `!isReplaying && status === "done"` branch (where the launch-echo job insert already lives), on `ScheduleWakeup` completion insert a scheduled wakeup row keyed by its own `tool_use_id`; `CronCreate` inserts a cron row (id from result echo); `CronDelete` removes/stops the matching cron — folding into `state.jobs` via `insertJob`.

**Tasks:**
- [ ] **First, pin the keystone (#assumptions):** capture a real `ScheduleWakeup` (and `CronCreate`) `tool_use`+`tool_result` pair and confirm it reaches `handleToolResult` (scratch `toolCallIndex` hit). If it does not surface, stop — the registration approach must be reconsidered before any further step.
- [ ] Confirm `CronCreate`'s result echo: parse a `jobId` if present, else mark the cron row for the soft-message-by-expression fallback ([P05]).
- [ ] Hook the `handleToolResult` `done` branch; stamp `firesAtMs` from `Date.now()`.
- [ ] No supersede — each `ScheduleWakeup` call is its own row (distinct `tool_use_id`); verify a `/loop` re-arm where the prior row is already terminal does not collide.

**Tests:**
- [ ] Reducer: a `ScheduleWakeup` result yields one scheduled row with the right `firesAtMs`/description; a second call adds a distinct row; `CronCreate` adds a cron row whose `jobId` (when echoed) a later `CronDelete` removes.

**Checkpoint:**
- [ ] `cd tugdeck && bun test code-session-store`

---

#### Step 4: Wake-flip + respawn sweep {#step-4}

**Depends on:** #step-3

**Commit:** `feat(tugdeck): flip scheduled rows on wake fire, reap, and sweep on respawn`

**References:** [P04] Time-driven, Risk R01 (#r01-idless-wake), (#semantics)

**Artifacts:**
- `reducer.ts`: extend `handleWakeStarted` to flip the earliest elapsed scheduled row **only when `wake_trigger.task_id === ""`** (id-less cohort), late-marking past threshold, threaded through every return branch (nested-wake, mid-turn-refused, replaying, idle-mint) the way the existing `jobs` fold is; call `reapElapsedScheduled` to stop long-elapsed unflipped rows; extend the `session_init` sweep to move remaining `scheduled` rows to `stopped`.

**Tasks:**
- [ ] Flip earliest-elapsed scheduled on the id-less wake re-init; leave scheduled rows untouched when the wake carries a real `task_id`.
- [ ] Thread the scheduled-flip result through all `handleWakeStarted` return points.
- [ ] Reap elapsed-beyond-`REAP_GRACE_MS` scheduled rows; sweep scheduled → stopped on respawn alongside the running sweep.

**Tests:**
- [ ] Reducer (captured wake fixtures): an id-less wake flips the earliest elapsed scheduled row; a wake with a real `task_id` flips a background job but **not** a scheduled row; a late fire records the late marker; the reaper stops a long-elapsed row; `session_init` sweeps scheduled rows.

**Checkpoint:**
- [ ] `cd tugdeck && bun test code-session-store`

---

#### Step 5: Popover Scheduled group + countdown {#step-5}

**Depends on:** #step-4

**Commit:** `feat(tugdeck): show scheduled work with a live countdown in the JOBS popover`

**References:** [P01] Fold into jobs, [P04] Time-driven, Risk R02 (#r02-countdown-render), (#state-zone-mapping)

**Artifacts:**
- `dev-card-telemetry-popovers.tsx`: a Scheduled group between Running and Finished; per-row "fires in MM:SS" (one-shot, `now < firesAtMs`), "firing…" (one-shot, elapsed but still `scheduled`), or recurring label (cron). The countdown consumes the exported **`useLiveTick()`** hook (already used by `JobElapsedValue`) and derives `firesAtMs − tick` at render — no new interval, no `useState` tick.

**Tasks:**
- [ ] Group rows by Running / Scheduled / Finished.
- [ ] Render countdown as `firesAtMs − useLiveTick()` (one-shot), "firing…" at/after zero, recurring label for crons — reusing the exported tick hook.

**Tests:**
- [ ] Unit: countdown formatter over `(firesAtMs, now)` pairs incl. the elapsed "firing…" case (pure formatter, not DOM).

**Checkpoint:**
- [ ] `cd tugdeck && bun run typecheck`
- [ ] `just app-test` (popover renders scheduled group)

---

#### Step 6: Cell pulse/count + soft-cancel wiring {#step-6}

**Depends on:** #step-5

**Commit:** `feat(tugdeck): pulse JOBS for scheduled work and add soft-cancel`

**References:** [P03] Scheduled status, [P05] Soft-cancel, [Q01] Cancel verb, Risk R03, (#symbols)

**Artifacts:**
- `dev-card-telemetry-renderers.tsx`: `JOBS` cell pulses and counts scheduled rows.
- `code-session-store.ts`: `cancelScheduledWork(jobId)` built on `send(text, atoms, opts)`; wired to the Cancel button (idle-gated). Cancel is enabled for cron and re-arming-loop rows; **disabled for a lone one-shot wakeup** with a tooltip explaining the fire is unavoidable until [Q01] lands.

**Tasks:**
- [ ] Cell pose/count include scheduled.
- [ ] `cancelScheduledWork` composes a message naming the timer (cron id / loop reason); gate the button per row kind.

**Tests:**
- [ ] Unit: cell pose/count reflect scheduled rows; Cancel enablement predicate (cron/loop enabled, lone one-shot disabled).

**Checkpoint:**
- [ ] `cd tugdeck && bun run typecheck`
- [ ] `just app-test`

---

#### Step 7: Staleness badge + steering note {#step-7}

**Depends on:** #step-4, #step-5

**Commit:** `feat(tugdeck): mark late wake fires and document the watcher best practice`

**References:** [P07] Staleness steer, (#context)

**Artifacts:**
- "fired late" badge on flipped rows past `STALE_THRESHOLD_MS`.
- A short best-practice note (prefer backgrounded job + Monitor over bare timed wakeup) added to an existing doc surface — no freestanding dropfile.

**Tasks:**
- [ ] Render the late badge.
- [ ] Add the steering note to the chosen existing doc.

**Tests:**
- [ ] Unit: badge predicate matches `isWakeLate`.

**Checkpoint:**
- [ ] `cd tugdeck && bun run typecheck`

---

#### Step 8: Integration Checkpoint {#step-8}

**Depends on:** #step-1, #step-2, #step-3, #step-4, #step-5, #step-6, #step-7

**Commit:** `N/A (verification only)`

**References:** (#success-criteria), [P04] Time-driven, [P05] Soft-cancel

**Tasks:**
- [ ] On-demand real-claude app-test: ask the assistant to schedule a wakeup; confirm a `JOBS` row with a ticking countdown appears, the cell pulses, and the row flips on fire (late-badged if late). Separately confirm Cancel on a **cron** row issues `CronDelete` (no further fires) and Cancel on a **loop** ends it after at most one more fire; verify the lone-one-shot Cancel is disabled with the explanatory tooltip.

**Tests:**
- [ ] On-demand real-claude app-test covering schedule → countdown → fire, plus cron/loop cancel.

**Checkpoint:**
- [ ] `just app-test` (full suite green)
- [ ] On-demand real-claude scenario passes.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Scheduled wakeups and crons appear as first-class, countdown-bearing, cancellable rows in the Z2 `JOBS` cell — closing the invisible-pending-work gap from session `7772e2d5`.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] A scheduled wakeup is visible within one render with reason + live countdown (reducer test + app-test).
- [ ] Scheduled rows pulse the `JOBS` cell, count as "N scheduled", and survive Clear (unit tests).
- [ ] An id-less fired wake flips the earliest elapsed row (late-badged past threshold) and does not flip on a real-`task_id` wake; the reaper stops long-elapsed rows; respawn sweeps stale rows (reducer tests).
- [ ] Cancel `CronDelete`s a cron (no further fires) and ends a loop after at most one more fire; the lone-one-shot Cancel is disabled with its tooltip — true one-shot cancellation is deferred to [Q01] (app-test).
- [ ] `bun run typecheck` and the app-test suite are green.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Wire-level `cancel_wakeup` CODE_INPUT frame, if [Q01] finds an SDK verb.
- [ ] Client-computed next-occurrence countdown for recurring crons ([Q02]).
- [ ] Assistant-side guidance/system-prompt nudge toward background-job + Monitor for "notify me when X finishes".

| Checkpoint | Verification |
|------------|--------------|
| Scheduled row + countdown | reducer fixture test + on-demand app-test |
| Cell pulse/count/clear | `bun test select-jobs` |
| Wake-flip + sweep | `bun test code-session-store` |
| Soft-cancel | on-demand real-claude app-test |
