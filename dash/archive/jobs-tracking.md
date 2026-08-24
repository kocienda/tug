<!-- devise-skeleton v4 -->

## Jobs Tracking — Z2 JOBS Cell for AI-Initiated Background Jobs {#jobs-tracking}

**Purpose:** Add a `JOBS` cell to the dev-card's Z2 status row that tracks background
jobs Claude launches (`Bash` / `Agent` with `run_in_background: true`) — live status at
a glance, a popover with per-job detail, a stop control for running jobs, and a clear
control for finished ones.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-06-11 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Claude Code's TUI surfaces background shells ("1 shell still running") with a detail
screen and an x-to-stop affordance. Tide has nothing equivalent: a background `Bash`
or `Agent` launched by Claude is visible only as a transcript tool block at launch
time, and its later completion, failure, or continued existence is invisible. The Z2
status row ([D97]) already solved the analogous problem for the task list with the
`TASKS` cell ([D100]) — a reducer-derived count + pose cell with a popover — so the
surface grammar, the component primitives (`TugStatusCell`, `TugProgressIndicator`,
the popover frame), and the store discipline are all established.

Three findings make this cheap to build (settled in the design conversation archived
at `dash/tug-session-08250a7c.md`):

1. The installed claude (2.1.173) emits `system/task_started`, `system/task_updated`,
   and `system/task_notification` frames. tugcode currently drops the first two — its
   system-subtype routing handles only `init` / `compact_boundary` / `api_retry`
   in-turn, and inter-turn consumes `task_notification` solely as the wake-bracket
   trigger (forwarded as `wake_started`).
2. The job-creating events are ordinary tool calls the deck already receives:
   `Bash` / `Agent` with `input.run_in_background === true`, whose `tool_result`
   echoes the task id and output file.
3. Stop plumbing already exists end-to-end in tugcode: `stop_task` is in the tugproto
   inbound allowlist, routed by `inbound-dispatch.ts` to `handleStopTask`, which sends
   the `{subtype: "stop_task", task_id}` control request to claude. Nothing in tugdeck
   sends it yet — the stop button is one outbound message away.

#### Strategy {#strategy}

- **Capture first.** Pin the exact wire shapes (`task_started` / `task_updated`
  fields, the background-launch `tool_result` echo text) with a live capture before
  writing any narrowing function — binary strings confirm vocabulary, not shape.
- **Bottom-up by layer.** tugcode forwarding → deck wire narrowing → store ledger →
  Z2 cell → popover. Each layer lands with its own tests and commit.
- **Mirror TASKS, don't invent.** The JOBS cell reuses the TASKS visual grammar
  exactly (`N/M` + `TugProgressIndicator` poses, `None` dimmed when empty) so the row
  reads as one instrument.
- **Ledger, not fold.** Unlike tasks, job lifecycle events are not all tool calls
  (terminal status arrives as system frames), and Clear must *forget* rows — so the
  reducer holds a session-lifetime `jobs` ledger in state rather than deriving from a
  pure fold over `toolCalls`.
- **Reuse the existing control path.** Stop rides the already-complete `stop_task`
  inbound verb; Clear is deck-local and touches no wire.

#### Success Criteria (Measurable) {#success-criteria}

- A live session in which Claude runs `Bash(run_in_background: true)` flips the JOBS
  cell from dimmed `None` to `0/1` with the `running` pose when the launch
  `tool_result` lands, and the popover lists the job with a live elapsed readout.
  (Verify by driving the real app; fixture-replay test pins the store-level behavior.)
- The popover's stop button on a running job causes claude to stop the task — a
  subsequent terminal frame flips the row to `stopped` and the cell to `N/M`.
- A failed job paints the cell in the `aborted` (danger) pose, and the pose persists
  until the user clears it, a new job starts, or the session clears. (Pure-logic test
  on the pose-derivation function.)
- Clear removes only terminal rows; running rows survive; the button is disabled when
  no terminal rows exist. (Pure-logic test on the ledger clear function.)
- A running job's dot keeps pulsing while the session is `idle` — no idle demotion.
  (Code-level assertion: the JOBS pose function takes no idle input.)
- `cd tugdeck && bun test`, `cd tugcode && bun test`, and `cd tugdeck && bun run
  check` all pass at every step boundary.

#### Scope {#scope}

1. tugcode: forward `task_started` / `task_updated` as new outbound IPC frames.
2. tugdeck store: wire narrowing, a session-lifetime `jobs` ledger in
   `CodeSessionState` / `CodeSessionSnapshot`, `stopJob` / `clearJobs` store methods,
   and a `useJobsState` hook.
3. Z2: a sixth `JOBS` cell (TASKS grammar), TIME / TOKENS width narrowing, and a
   four-rung container-query collapse order.
4. A `JobsPopoverContent` popover: per-job rows, stop button on running rows, summary
   footer, Clear button gated to terminal rows.
5. Captured wire fixtures + pure-logic and fixture-replay tests.
6. `tuglaws/design-decisions.md` update (zone table + new decision entry).

#### Non-goals (Explicitly out of scope) {#non-goals}

- The `$` shell route (tugexec) — different lifecycle, different animal. The ledger
  shape stays source-agnostic so it *could* join later, but nothing tugexec ships now.
- A second-level "shell details" output-tail view (the TUI's per-shell screen). The
  output lives in an `output_file` on tugcode's host; tailing it needs a new inbound
  fetch verb — real, separable work.
- Ledger reconstruction across app reload / session replay. The ledger is in-memory
  store state; after a reload it starts empty — replayed launches are deliberately
  suppressed ([P11]) — see [Q03].
- Any persistence of job history (no tugbank, no SQLite).

#### Dependencies / Prerequisites {#dependencies}

- claude ≥ 2.1.173 (the installed version) — carries the `task_started` /
  `task_updated` / `task_notification` wire vocabulary.
- Existing `stop_task` plumbing: `tugproto/src/inbound.ts` (type + allowlist),
  `tugcode/src/inbound-dispatch.ts`, `SessionManager.handleStopTask`.
- Existing Z2 primitives: `TugStatusCell`, `TugProgressIndicator`,
  `PerAreaPopoverFrame`, the shared 1Hz tick in `dev-card-telemetry-renderers.tsx`.

#### Constraints {#constraints}

- tugcode is a compiled binary — edits take effect only after `just build`; no HMR.
  tugdeck is HMR — never run manual builds for it.
- bun only (never npm/npx); tests via `bun test`; typecheck via `bun run check`.
- No localStorage / sessionStorage / IndexedDB anywhere.
- Tuglaws apply throughout: [L02] external state via `useSyncExternalStore`, [L06]
  appearance via CSS/DOM, [L19] component file pairs, [L20] token sovereignty, [L26]
  mount identity across state transitions.
- No fake-DOM render tests; no mock-store call-count tests. Pure-logic bun:test +
  fixture-replay through the real store only.

#### Assumptions {#assumptions}

- `task_started` / `task_updated` frame shapes are stable enough across claude
  versions that defensive narrowing (the codebase's existing habit) absorbs drift.
- The background-launch `tool_result` echo carries a parseable task id (the TUI
  surfaces ids like `bash_1`); the exact text is pinned in Step 1.
- A 14ch JOBS cell accommodates the `N/M` label + indicator dot at realistic counts.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Exact wire shapes of `task_started` / `task_updated` and the launch echo (OPEN) {#q01-wire-shapes}

**Question:** Field-for-field, what do the `system/task_started` and
`system/task_updated` frames carry, and what is the exact `tool_result` echo text for
a background `Bash` / `Agent` launch? In particular: does `task_started` also fire
for **foreground** subagents (binary strings place it adjacent to `agentType` /
`workflowName`), and if so, what discriminant (`is_backgrounded` is the candidate)
separates background jobs from foreground spawns?

**Why it matters:** The narrowing functions and the result-echo parser must be written
against captured reality, not inferred shape — the `parseTaskCreateResultId` precedent.
Binary strings show candidate fields (`task_id`, `output_file`, `is_backgrounded`,
`end_time`, `total_paused_ms`) but not structure. And if `task_started` fires for
foreground subagents, an ungated upsert (Spec S01 point 2) would pollute JOBS with
every `Agent` call.

**Plan to resolve:** Step 1 live capture (#step-1).

**Resolution:** DECIDED — pinned by the #step-1 capture
(`v2.1.173-jobs-spike/test-jobs-lifecycle-raw.jsonl`). `task_started` carries
`task_id` / `tool_use_id` / `description` / `task_type: "local_bash" | "local_agent"`
(+ `subagent_type`, `prompt` for agents) and **no backgrounded discriminant** — a
foreground Agent emits a shape-identical frame. The gate is the frame's
`tool_use_id` → launching tool call's `input.run_in_background === true`.
`task_updated` is patch-based: `patch.status ∈ {completed, failed, killed}` +
`patch.end_time`. Bash launch echo: `tool_use_result.backgroundTaskId` + "Command
running in background with ID: <id>" text; Agent launch echo:
`tool_use_result.{isAsync: true, agentId, outputFile}`.

#### [Q02] Which path delivers terminal status between turns (OPEN) {#q02-terminal-path}

**Question:** When a background job finishes *between* turns, does claude emit an
inter-turn `task_updated`, only a `task_notification` (the wake trigger), or both?

**Why it matters:** Decides whether the deck ledger's terminal flip listens to the new
`task_updated` event, the existing `wake_started` event's `wake_trigger` payload, or
both — and whether tugcode must forward task frames from the inter-turn drain
(`handleInterTurnEvent`) in addition to the in-turn router.

**Plan to resolve:** Step 1 capture includes a job that outlives its turn (#step-1).

**Resolution:** DECIDED — **both, on both tiers** (#step-1 capture). `task_updated`
is the canonical terminal flip and arrives mid-turn for a fast failure and
inter-turn for an idle completion; `task_notification` follows inter-turn as the
wake trigger (and does not fire a wake for `stopped`). [P05]'s both-tiers
forwarding is confirmed necessary.

#### [Q03] Ledger reconstruction on replay / resume (DEFERRED) {#q03-replay-reconstruction}

**Question:** After an app reload (session replay) or a claude respawn (model/effort
change), should the ledger reconstruct running jobs, and from what?

**Why it matters:** A respawn kills background tasks (the claude binary carries
"The container was restarted. The following background tasks were running and are now
stopped" handling); a reload loses the in-memory ledger. Stale `running` rows would
show a pulsing dot for a dead job.

**Resolution:** DEFERRED — out of scope per #non-goals. Mitigations shipping now:
Risk R03's stale-marking rule (a fresh `session_init` flips any `running` row to
`stopped`) and [P11]'s replay suppression (no stale resurrections after a reload —
the ledger starts empty). Revisit when the output-tail view (which needs host-side
job state anyway) is planned.

#### [Q04] Does a control-request `stop_task` emit a confirmation frame? (OPEN) {#q04-stop-confirmation}

**Question:** When the deck stops a job via the `{subtype: "stop_task", task_id}`
control request (the popover's path — distinct from claude calling its own `TaskStop`
tool), does claude emit a `task_updated` / `task_notification` confirming the stop?

**Why it matters:** [P06] forbids an optimistic flip; with no confirmation frame the
row would stay `running` forever after a successful stop. The answer selects between
wire-confirmed and optimistic flip ([P06]'s contingency).

**Plan to resolve:** Step 1 capture exercises the control-request stop by writing the
control request to a persistent session's stdin, exactly as tugcode does (#step-1).

**Resolution:** DECIDED — **yes** (#step-1 capture): a control-request stop produces
`task_updated{status:"killed"}` + `task_notification{status:"stopped"}` (plus a
`control_response` ack). The wire-confirmed rule stands; no optimistic flip.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Wire-shape drift across claude versions | med | med | Capture-pinned fixtures + defensive narrowing returning `undefined` on mismatch | Any claude upgrade that breaks the fixture-replay test |
| Z2 row overflow after adding a sixth cell | low | med | TIME/TOKENS narrowed 16ch→12ch; collapse rungs retuned (Spec S03) | Visual squeeze at common card widths |
| Stale `running` rows after claude respawn | med | med | R03 stale-marking rule | Output-tail / job-detail work |

**Risk R01: Wire-shape drift** {#r01-wire-drift}

- **Risk:** A future claude changes `task_started` / `task_updated` fields or the
  launch echo text, silently breaking the ledger.
- **Mitigation:**
  - Narrowing functions are total: malformed frames narrow to `undefined` and are
    dropped, never crash.
  - The fixture-replay test (#step-4) fails loudly when re-captured fixtures change
    shape.
- **Residual risk:** A drifted echo means new jobs stop appearing until re-pinned —
  degraded, not broken.

**Risk R02: Row width squeeze** {#r02-row-width}

- **Risk:** Six cells overflow the Z2 row at widths where five fit today.
- **Mitigation:** Narrow TIME and TOKENS to 12ch (worst realistic content
  `4h 30m 00s` = 10ch, `−208.3K` = 8ch — both clear 12ch); JOBS at 14ch; retune the
  container-query rungs empirically (#step-5).
- **Residual risk:** Very narrow cards show fewer cells sooner — by design (collapse
  order keeps JOBS longest among the collapsibles).

**Risk R03: Stale running rows** {#r03-stale-running}

- **Risk:** A claude respawn (effort change, crash recovery) kills background tasks;
  ledger rows stay `running` forever.
- **Mitigation:** The reducer flips every `running` row to `stopped` when a
  `session_init` arrives while jobs are running — a respawned claude cannot have
  carried jobs across.
- **Residual risk:** A job that dies without any frame (kill -9 on the child) stays
  `running` until session clear or user Clear — acceptable for now ([Q03]).

---

### Design Decisions {#design-decisions}

#### [P01] JOBS is a sixth Z2 cell that mirrors the TASKS grammar (DECIDED) {#p01-mirror-tasks}

**Decision:** The JOBS cell renders exactly as TASKS does — a `TugProgressIndicator`
(pulsing-dot, `glyphPosition="both"`) with an `N/M` label (finished/total this
session), dimmed `None` when the ledger is empty, poses `running` / `completed` /
`aborted` — placed after TASKS in the row.

**Rationale:**
- Settled in discussion: "mirror what TASKS does now, rather than invent yet another
  visual semantic."
- The `aborted` pose, reserved by [D100] "for future error surfacing," gets its first
  consumer: a failed job paints the cell danger-toned.

**Implications:**
- `TugStatusCell` gains a `data-priority="jobs"` width entry; no new primitive.
- Pose derivation (Spec S02) is a pure exported function, unit-tested.

#### [P02] No idle demotion for the JOBS dot (DECIDED) {#p02-no-idle-demotion}

**Decision:** A `running` JOBS pose is **not** demoted when the session phase is
`idle` — the one deliberate divergence from TASKS semantics.

**Rationale:**
- Tasks only advance while Claude works; a background shell genuinely runs *between*
  turns — that is its whole point. Motion must keep implying ongoing work.

**Implications:**
- The JOBS pose function takes no `idle` input (unlike `taskRowState`).

#### [P03] Reducer-held session-lifetime jobs ledger, not a pure fold (DECIDED) {#p03-ledger}

**Decision:** The reducer keeps a `jobs: readonly JobItem[]` ledger in
`CodeSessionState`, mirrored onto `CodeSessionSnapshot` — like `wakeTrigger`, but
durable for the session. It is not derived per-render from `toolCalls`.

**Rationale:**
- Job lifecycle events are not all tool calls: terminal status arrives as system
  frames, and `wakeTrigger` is deliberately transient (cleared at `turn_complete`).
- Clear ([P04]) must *forget* rows; a pure fold can't forget without tombstone state.
- Elapsed display needs an absolute `startedAtMs`, which `ToolUseMessage` doesn't
  carry.

**Implications:**
- New state field + snapshot exposure + `createInitialState` entry (session clear
  resets it for free, matching [D100]'s `/clear` behavior).
- Ledger update points (Spec S01): background launch `tool_result`, `task_started`,
  `task_updated`, `wake_started` fold, terminal `TaskStop` tool calls, `session_init`
  stale-marking (R03), `clear_jobs_action`.

#### [P04] Clear is a deck-local wipe of terminal rows only (DECIDED) {#p04-clear-semantics}

**Decision:** The popover's Clear button removes `completed` / `failed` / `stopped`
rows from the ledger; `running` rows always survive; the button is disabled when no
terminal rows exist. Clear touches no wire.

**Rationale:**
- Clearing a running job would orphan it from the UI with no way to stop it from Z2.
- Gives failed-job persistence its tidy rule: the danger pose holds for the session
  *or until the user clears it*, whichever comes first.

**Implications:**
- A `clear_jobs_action` reducer event filtered on terminal status; a `clearJobs()`
  named store method (the `interrupt()` precedent: keep `dispatch` private).

#### [P05] tugcode forwards `task_started` / `task_updated` from both routing tiers (DECIDED) {#p05-forward-both-tiers}

**Decision:** tugcode adds `TaskStarted` / `TaskUpdated` outbound IPC frames
(`ipc_version: 2`), emitted from the in-turn system-subtype router *and* the
inter-turn drain (`handleInterTurnEvent`). `task_notification` keeps its existing
single forwarding as `wake_started` — no duplicate frame; the deck folds
`wake_started.wake_trigger` as a job status flip.

**Rationale:**
- `task_started` fires mid-turn (when the launching tool call runs); `task_updated`
  may fire either side of a turn boundary ([Q02]) — forwarding from both tiers is
  cheap and makes the deck independent of the answer.
- Reusing `wake_started` for the notification payload avoids two frames for one wire
  event and leaves the wake bracket untouched.

**Implications:**
- `tugcode/src/types.ts`: two new outbound interfaces + union entries.
- `tugcode/src/session.ts`: emission in the system switch and the inter-turn drain;
  pure `buildTaskStartedMessage` / `buildTaskUpdatedMessage` factories (the
  `buildWakeStartedMessage` precedent) for testability.

#### [P06] Stop rides the existing `stop_task` verb via a named store method (DECIDED) {#p06-stop-task}

**Decision:** `CodeSessionStore.stopJob(taskId)` direct-sends a
`{type: "stop_task", task_id}` CODE_INPUT frame (the `addDirectory` direct-send
precedent at the store facade). No reducer event, no optimistic ledger flip — the row
flips when the wire confirms — **contingent on the Step 1 capture showing a
confirmation frame for the control-request stop path**. If the capture shows claude
emits nothing on a control-request stop ([Q04]), `stopJob` instead dispatches an
optimistic `stopped` flip alongside the send, so the row cannot stay `running`
forever after a successful stop.

**Rationale:**
- The entire tugcode path (allowlist → dispatch → `handleStopTask` → control request)
  already exists; the deck just needs to emit the verb.
- Truthful UI: the row keeps `running` until claude actually reports the stop, same
  honesty rule as the permission-mode chip — but truthfulness loses to a permanently
  wrong `running` pose if no confirmation ever arrives, hence the capture-gated
  fallback.

**Implications:**
- One new facade method; the popover's stop button is a fire-and-forget control-style
  action (no popover-local state).
- Step 1 must exercise the control-request stop path explicitly, not just the
  `TaskStop` tool path.

#### [P07] Row layout: 12ch TIME/TOKENS, 14ch JOBS, collapse TIME → TOKENS → TASKS → JOBS (DECIDED) {#p07-row-layout}

**Decision:** TIME and TOKENS narrow from 16ch to 12ch; JOBS enters at 14ch after
TASKS; the container-query collapse order becomes TIME first, then TOKENS, then
TASKS, with JOBS the last collapsible (STATE / CONTEXT persist).

**Rationale:**
- Worst realistic TIME content `4h 30m 00s` (10ch) and TOKENS `−208.3K` (8ch) clear
  12ch comfortably; the narrowing mostly pays for the new cell.
- A running job is live "something is happening" signal; a task list is recoverable
  from the transcript — so JOBS outlives TASKS under squeeze.

**Implications:**
- `tug-status-cell.css` width table + new collapse rung; breakpoints retuned
  empirically (Spec S03).

#### [P08] Wire narrowing is authored against captured fixtures (DECIDED) {#p08-capture-pinned}

**Decision:** No narrowing function or echo parser is written before the Step 1
capture lands in `tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/`; the
fixture-replay test feeds the captured frames through the real store.

**Rationale:**
- Binary strings confirm vocabulary, not field-for-field shape.
- Precedent: the wake bracket ([D02] of the session-wake plan) and
  `session-wake-fixture-replay.test.ts`.

**Implications:**
- Step 1 blocks Steps 2–4; the fixture is the contract Q01/Q02 resolve against.

#### [P09] Ledger shape is source-agnostic; only `claude` ships (DECIDED) {#p09-source-agnostic}

**Decision:** `JobItem` carries a `source` discriminant (only `"claude"` today) so a
future tugexec integration extends the ledger without reshaping it. No tugexec code
ships in this plan.

**Rationale:**
- Settled in discussion: "this feature is all about tracking the background jobs
  kicked off by the AI"; the shape stays open for the `$` route later.

**Implications:**
- One extra literal field; consumers switch on `status`, never on `source`.

#### [P10] Timestamps stamp in the reducer; live elapsed ticks in a popover leaf (DECIDED) {#p10-timestamps-and-tick}

**Decision:** `startedAtMs` / `endedAtMs` are stamped with `Date.now()` directly in
the reducer's job handlers — the `toolUseStartedAt` precedent — never during replay
([P11]). Live elapsed display subscribes to the shared 1Hz tick inside a leaf
component that mounts only while the popover is open.

**Rationale:**
- The reducer already stamps wall-clock anchors directly (`submitAt`,
  `toolUseStartedAt`) with a replay guard; threading timestamps through the
  `frameToEvent` wrapper would add event plumbing for no purity gain.
- Subscribing the whole status row to the 1Hz tick for a popover-only readout would
  tick the row forever; a leaf `JobElapsedValue` inside the popover pays the
  subscription only while open. The cell itself shows `N/M` (no clock), and its
  pulse is CSS animation — no tick needed ([L06]).

**Implications:**
- No timestamp fields on the wire events; Step 3 is pure narrowing.
- The module-private `useLiveTick` in `dev-card-telemetry-renderers.tsx` is exported
  (or lifted to a hooks module) for the popover leaf component.
- Documented one-line deviation from the popovers module's "no external state" note:
  the tick is presentation clockwork, not session state; the popover remains a pure
  function of session inputs.

#### [P11] Replay never populates the ledger (DECIDED) {#p11-replay-suppression}

**Decision:** During session replay (`phase === "replaying"`), background-launch
`tool_result`s do **not** insert ledger rows; after an app reload the JOBS cell
starts at `None`.

**Rationale:**
- Replay re-delivers tool events but never the task lifecycle frames, so a replayed
  insert would sit at `running` forever — a permanently pulsing dot for a dead job.
- Inserting replayed launches as `stopped` would resurrect stale rows with
  meaningless timestamps; an empty ledger is honest.
- Precedent: `toolWallMs` is computed only when not replaying.

**Implications:**
- The launch-insert handler gates on the reducer's replay context; a fixture-replay
  test asserts the ledger stays empty across a replayed launch.
- True reconstruction stays deferred ([Q03]).

---

### Deep Dives {#deep-dives}

#### Wire reality and event flow {#wire-reality}

Confirmed against the current tree and the installed claude 2.1.173:

- **In-turn router** — `tugcode/src/session.ts` `routeTopLevelEvent`'s `system` case
  handles `init` / `compact_boundary` / `api_retry`; `task_started` / `task_updated`
  currently fall through unhandled.
- **Inter-turn drain** — `handleInterTurnEvent` handles `system/init` (re-init = wake
  fire elsewhere) and `system/task_notification` (→ `wake_started` via
  `buildWakeStartedMessage`, payload: `task_id`, `tool_use_id`, `status:
  "completed" | "failed" | "stopped"`, `summary`, `output_file`).
- **SDK contract** — `SDKTaskNotificationMessage` is typed in the agent SDK;
  active-polling tools (`Bash` / `Agent` with `run_in_background`) emit
  `task_started` / `task_updated` instead of (or in addition to) notifications; binary
  strings show fields `is_backgrounded`, `end_time`, `total_paused_ms` near
  `task_updated`. Exact shapes: [Q01].
- **Deck ingestion** — the store facade keeps an allowlist set of reducer-relevant
  frame types and a `frameToEvent` normalizer (snake_case wire → camelCase events,
  impure stamps like `turnKey` / `deadline` minted there). `wake_started` is already
  allowlisted and dispatched; the reducer holds its payload transiently as
  `wakeTrigger`.
- **Stop path** — `tugproto/src/inbound.ts` declares `StopTask { type: "stop_task";
  task_id: string }` and allowlists the verb; `tugcode/src/inbound-dispatch.ts` routes
  it to `SessionManager.handleStopTask`, which sends the
  `{subtype: "stop_task", task_id}` control request. Complete; unexercised by tugdeck.

#### Terminology guard — Tasks vs Jobs {#terminology-guard}

Two unrelated "task" vocabularies are now in play; this plan's vocabulary is **jobs**:

| Wire / tool name | What it is | Tide feature |
|---|---|---|
| `TaskCreate` / `TaskUpdate` (tool calls) | The todo-list CRUD family | TASKS cell ([D100]) — untouched |
| `system/task_started`, `system/task_updated`, `system/task_notification` (frames) | Background-job lifecycle | JOBS cell (this plan) |
| `TaskStop` / `TaskOutput` / `TaskList` / `TaskGet` (tool calls) | Background-job management tools Claude calls | Fold `TaskStop` into the ledger; transcript blocks already exist |

Deck-side modules, types, and hooks all use the job vocabulary (`JobItem`,
`select-jobs.ts`, `useJobsState`) — only wire-frame names keep claude's `task_*`
spelling.

---

### Specification {#specification}

**Spec S01: Jobs ledger semantics** {#s01-ledger}

```ts
type JobStatus = "running" | "completed" | "failed" | "stopped";

interface JobItem {
  jobId: string;            // claude's task_id (shape pinned by Q01 capture)
  source: "claude";         // [P09]
  kind: "bash" | "agent" | "unknown";
  toolUseId: string;        // the launching tool call
  description: string;      // command text / agent description (preview source)
  outputFile?: string;
  status: JobStatus;
  startedAtMs: number;      // stamped per [P10]
  endedAtMs: number | null;
}
```

Ledger update points (all idempotent upserts keyed by `jobId`; exact field mapping
pinned by the Step 1 capture):

1. **Launch** — a terminal (`status: "done"`) `tool_result` for a `Bash` / `Agent`
   call whose `input.run_in_background === true`: insert `running` row (parse
   `jobId` / `outputFile` from the echo; fall back defensively on parse miss).
   **Suppressed during replay** ([P11]) — replay re-delivers tool events but never
   the task lifecycle frames, so a replayed insert would pulse forever. This is the
   only update point reachable during replay; the guard here keeps the ledger empty
   across reloads.
2. **`task_started` event** — insert-or-confirm, **gated on the frame's
   backgrounded discriminant** (`is_backgrounded` is the candidate field; pinned by
   [Q01]). The frame may also fire for foreground subagents, which must never enter
   the ledger.
3. **`task_updated` event** — status flip + `endedAtMs`.
4. **`wake_started` event** — fold `wake_trigger.{task_id, status}` as a terminal
   flip when a matching `running` row exists ([P05]).
5. **Terminal `TaskStop` tool call** — flip the referenced job to `stopped`.
6. **`session_init` while rows are `running`** — flip them to `stopped` (R03).
7. **`clear_jobs_action`** — drop terminal rows ([P04]).

Unknown `jobId` on a flip event: ignore (defensive). The ledger is order-preserving
(insertion order).

**Spec S02: Cell reading and pose** {#s02-cell-pose}

- Label: `finished/total` where `finished` = terminal rows, `total` = all rows;
  dimmed `None` when the ledger is empty (`valueEmpty`, exactly as TASKS).
- Pose (pure function of the ledger only — no phase input, per [P02]):
  - empty → `stopped` (quiet)
  - any `running` → `running`
  - else any `failed` → `aborted` (danger; holds per [P04])
  - else → `completed`
- aria-label: "`N` of `M` jobs finished" / "No background jobs".

**Spec S03: Row layout and collapse** {#s03-row-collapse}

- Widths (`--tugx-dev-status-cell-width` by `data-priority`): `state` 20ch ·
  `time` **12ch** · `tokens` **12ch** · `context` 20ch · `tasks` 16ch · `jobs`
  **14ch**.
- DOM/focus order: STATE, TIME, TOKENS, CONTEXT, TASKS, JOBS — `cellOrder` offsets
  0…5 (`focusOrderBase` doc comment updated).
- Collapse rungs (container `dev-status`): TIME hides first, then TOKENS, then
  TASKS, then JOBS; STATE / CONTEXT persist. Breakpoint px values retuned
  empirically against the new cell-width sum (old rungs 430px / 260px were tuned for
  the five-cell 88ch row).
- Mount identity ([L26]): the six-cell row and every cell are unconditionally
  mounted; only values and poses change.

**Spec S04: Jobs popover** {#s04-popover}

`JobsPopoverContent` (sibling of `TasksPopoverContent`, same `PerAreaPopoverFrame`
rhythm, title "Jobs"):

- One row per ledger entry, insertion order: status `TugProgressIndicator`
  (pulsing-dot, left glyph; running → `running`, completed → `completed`, failed →
  `aborted`/danger, stopped → `stopped`), end-truncated mono `description` preview
  (full text in a `TugTooltip`, the task-description precedent), elapsed as the
  right-aligned value (`endedAtMs − startedAtMs` for terminal rows; live
  `JobElapsedValue` per [P10] for running rows), and a stop button on `running` rows
  only (fires `onStopJob(jobId)`, fire-and-forget).
- Footer: composed summary with zero-bucket drop ("1 running, 2 done, 1 failed") +
  a Clear button, disabled when no terminal rows ([P04]).
- Empty ledger → standard popover empty message ("No background jobs this session.").
- Content is a function of inputs (`jobs`, `onStopJob`, `onClearJobs`) — the status
  row owns the store subscription; the only external read is the [P10] tick leaf.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| `jobs` ledger | external session state | reducer state + snapshot, read via `useJobsState` (`useSyncExternalStore`) | [L02] |
| cell pose / danger tone | appearance | `TugProgressIndicator` state→role + CSS data-attributes | [L06] |
| dot pulse animation | appearance | CSS animation (no tick, no React state) | [L06] |
| live elapsed (running rows) | external clock | shared 1Hz tick store via `useSyncExternalStore` in a popover-mounted leaf | [L02], [P10] |
| popover open/closed | structure | `TugPopover` (Radix-owned) | — |
| collapse rungs | appearance | CSS container queries on `dev-status` | [L06] |
| stop / clear actions | — (events, not state) | named store methods → CODE_INPUT frame / reducer action | [L02] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/<background-jobs capture>` | Step 1 raw stream-json capture (background Bash + Agent lifecycle) |
| `tugdeck/src/lib/code-session-store/select-jobs.ts` | `JobItem` types, wire narrowing, echo parser, ledger update + pose + summary pure functions |
| `tugdeck/src/lib/code-session-store/hooks/use-jobs-state.ts` | `useJobsState(store)` — [L02] snapshot read of the ledger |
| `tugdeck/src/lib/code-session-store/__tests__/select-jobs.test.ts` | Pure-logic tests for narrowing / parsing / ledger / pose / summary |
| `tugdeck/src/__tests__/jobs-fixture-replay.test.ts` | Captured frames through the real store (`session-wake-fixture-replay` precedent) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `TaskStarted`, `TaskUpdated` | interface | `tugcode/src/types.ts` | outbound IPC frames, `ipc_version: 2`, union entries |
| `buildTaskStartedMessage`, `buildTaskUpdatedMessage` | fn | `tugcode/src/session.ts` | pure factories (the `buildWakeStartedMessage` precedent); emission wired into the system switch + `handleInterTurnEvent` |
| `JobStatus`, `JobItem` | type | `select-jobs.ts` | Spec S01 |
| `narrowTaskStartedFrame`, `narrowTaskUpdatedFrame`, `parseBackgroundLaunchResult` | fn | `select-jobs.ts` | defensive; authored against the Step 1 fixture |
| `insertJob`, `applyJobFlip`, `markRunningJobsStopped`, `clearTerminalJobs`, `jobsCellPose`, `composeJobsSummary` | fn | `select-jobs.ts` | pure ledger/display helpers, all exported for tests |
| `TaskStartedEvent`, `TaskUpdatedEvent`, `ClearJobsActionEvent` | interface | `events.ts` | union entries |
| `jobs` | field | `reducer.ts` state + snapshot + `createInitialState` | [P03]; handlers per Spec S01 |
| frame allowlist + `frameToEvent` cases | edit | `code-session-store.ts` | add `task_started` / `task_updated`; pure narrowing (timestamps stamp in the reducer, [P10]) |
| `stopJob`, `clearJobs` | method | `code-session-store.ts` | [P06] / [P04] |
| `useJobsState` | hook | `hooks/use-jobs-state.ts` | [L02] |
| JOBS cell + `cellOrder(5)` | edit | `dev-card-telemetry-renderers.tsx` | Spec S02; `useLiveTick` exported per [P10] |
| `JobsPopoverContent`, `JobElapsedValue` | component | `dev-card-telemetry-popovers.tsx` (+ `.css`) | Spec S04 |
| `data-priority="jobs"` width + collapse rungs | edit | `tug-status-cell.css` | Spec S03 |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/design-decisions.md`: update the [D97] zone table (Z2 row contents) and
  add a global decision entry for the JOBS cell (grammar mirror, no-idle-demotion,
  ledger, clear semantics) — the [D100] precedent.
- [ ] Module docstrings for `select-jobs.ts` / `use-jobs-state.ts` carrying the
  terminology guard (#terminology-guard).

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (pure-logic bun:test)** | Narrowing, echo parsing, ledger updates, pose, summary, formatters | `select-jobs.test.ts`; every Spec S01/S02 rule |
| **Fixture-replay (real store)** | Captured wire frames through `CodeSessionStore._ingestFrameForTest` → assert snapshot ledger | `jobs-fixture-replay.test.ts`; pins Q01/Q02 empirically |
| **tugcode unit** | `buildTaskStartedMessage` / `buildTaskUpdatedMessage` factories + routing emission | `tugcode/src/__tests__` |

#### What stays out of tests {#test-non-goals}

- Fake-DOM render tests of the cell / popover — banned pattern (no happy-dom /
  jsdom); visual behavior is verified in the running app.
- Mock-store call-count tests (e.g. "stopJob sends one frame") — banned pattern; the
  stop path is asserted at the fixture/store level and exercised live.
- The tugcode → claude control-request round trip for `stop_task` — pre-existing,
  already plumbed; not re-tested here.
- Container-query breakpoint values — hand-tuned appearance, verified visually.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** This rule applies to every step below.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Capture background-job wire fixtures | done | f728bfcc |
| #step-2 | tugcode forwards task frames | done | c9906be7 |
| #step-3 | Deck wire layer | done | 7dc8d8e1 |
| #step-4 | Jobs ledger in the deck store | done | 5bbcfe2d |
| #step-5 | JOBS cell in the Z2 row | done | 970d5008 |
| #step-6 | Jobs popover with stop and clear | done | 6746013a |
| #step-7 | Document the JOBS cell | done | 3f339688 |
| #step-8 | Integration checkpoint | in progress (suites + build green; live walk pending) | — |

#### Step 1: Capture background-job wire fixtures {#step-1}

**Commit:** `Capture background-job stream-json fixtures`

**References:** [P06] stop contingency, [P08] capture-pinned narrowing, [Q01],
[Q02], [Q04], (#wire-reality)

**Artifacts:**
- Raw stream-json capture(s) under a new
  `tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/v2.1.173/` directory
  (the catalog's per-version convention) covering: a background `Bash` launch
  (`tool_result` echo + `task_started`), a clean completion (`task_updated` and/or
  `task_notification`), a failure, a `TaskStop`-tool stop, a **control-request
  `stop_task` stop** (the popover's actual path, [Q04]), a **foreground `Agent`
  call** (control case for the backgrounded discriminant, [Q01]), and a job that
  outlives its turn.
- A short shape-notes companion (fixture-adjacent README or header comment) recording
  the observed field-for-field shapes and which path answered [Q02] / [Q04].

**Tasks:**
- [ ] Drive a **persistent** claude session — `--input-format stream-json
      --output-format stream-json --verbose` with stdin held open (as tugcode drives
      it), or tugcode itself — and prompt it to launch background `Bash` (and, if
      claude obliges, a background `Agent`); record raw stdout lines verbatim. A
      one-shot `--print` run exits at the result and kills the job with it, so it
      cannot produce the outlives-turn or control-request variants.
- [ ] Produce the failure and stop variants: a command that exits non-zero; a prompt
      asking claude to stop the job via `TaskStop`; and a
      `{subtype: "stop_task", task_id}` control request written to the session's
      stdin while a job runs ([Q04]).
- [ ] Capture a foreground `Agent` call in the same session and record whether
      `task_started` fires for it, and which field discriminates ([Q01]).
- [ ] Trim captures to the relevant frame sequences; commit under
      `v2.1.173/` with names matching the catalog's conventions.
- [ ] Record resolutions for [Q01] / [Q02] / [Q04] in the shape notes.

**Tests:**
- [ ] N/A — fixture-only step; the fixtures become test inputs in #step-2 / #step-4.

**Checkpoint:**
- [ ] `grep -rl "task_started" tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/v2.1.173/` returns the new fixture(s)
- [ ] Shape notes answer Q01 (including the foreground discriminant), Q02, and Q04
      explicitly

---

#### Step 2: tugcode forwards task frames {#step-2}

**Depends on:** #step-1

**Commit:** `Forward task_started and task_updated frames from tugcode`

**References:** [P05] forward both tiers, [P08], Spec S01, (#wire-reality)

**Artifacts:**
- `TaskStarted` / `TaskUpdated` outbound IPC frames in `tugcode/src/types.ts`
  (+ outbound union entries).
- `buildTaskStartedMessage` / `buildTaskUpdatedMessage` pure factories in
  `tugcode/src/session.ts`; emission wired into the in-turn system-subtype switch and
  `handleInterTurnEvent`.

**Tasks:**
- [ ] Define the two frames against the Step 1 shapes (forward claude's payload
      fields verbatim minus the `type/subtype` envelope, the `wake_started`
      precedent; `ipc_version: 2`).
- [ ] Add factory functions returning `null` for non-matching / malformed events.
- [ ] Emit from both routing tiers; leave `task_notification` → `wake_started`
      untouched.

**Tests:**
- [ ] tugcode unit tests: factories accept the captured fixture lines and produce the
      expected frames; malformed inputs return `null`.
- [ ] Routing test: a fixture `task_started` line through the dispatcher emits the
      IPC frame (existing session-test harness patterns).

**Checkpoint:**
- [ ] `cd tugcode && bun test`
- [ ] `just build` (compiled-binary rebuild; binary refreshed for later live checks)

---

#### Step 3: Deck wire layer {#step-3}

**Depends on:** #step-2

**Commit:** `Narrow background-job frames into code-session-store events`

**References:** [P08], [P10] reducer-stamped timestamps, Spec S01,
(#terminology-guard)

**Artifacts:**
- `TaskStartedEvent` / `TaskUpdatedEvent` in `events.ts` (+ union entries).
- Frame-type allowlist entries + `frameToEvent` narrowing cases in
  `code-session-store.ts` (pure narrowing — no timestamp stamping; the reducer
  stamps per [P10]).

**Tasks:**
- [ ] Add `"task_started"` / `"task_updated"` to the reducer-relevant frame set.
- [ ] Narrow wire snake_case → camelCase event fields; carry the wire payload only —
      `startedAtMs` / `endedAtMs` are stamped in the reducer ([P10]).
- [ ] Event docstrings carry the Tasks-vs-Jobs terminology guard.

**Tests:**
- [ ] Pure-logic test: captured fixture frames through `_ingestFrameForTest` dispatch
      the expected events (no reducer behavior asserted yet — that is #step-4).

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bun run check`

---

#### Step 4: Jobs ledger in the deck store {#step-4}

**Depends on:** #step-3

**Commit:** `Add session-lifetime jobs ledger to the deck store`

**References:** [P03] ledger, [P04] clear, [P06] stop, [P09] source-agnostic,
[P10], [P11] replay suppression, Spec S01, Risk R01, Risk R03, (#s01-ledger)

**Artifacts:**
- `select-jobs.ts`: `JobStatus` / `JobItem`, `narrowTaskStartedFrame` /
  `narrowTaskUpdatedFrame` / `parseBackgroundLaunchResult`, `insertJob` /
  `applyJobFlip` / `markRunningJobsStopped` / `clearTerminalJobs`, `jobsCellPose`,
  `composeJobsSummary`.
- `reducer.ts`: `jobs` state field + snapshot exposure + `createInitialState` entry;
  handlers for all seven Spec S01 update points.
- `code-session-store.ts`: `stopJob(taskId)` (direct CODE_INPUT send) and
  `clearJobs()` (dispatches `clear_jobs_action`).
- `hooks/use-jobs-state.ts`: `useJobsState`.
- `select-jobs.test.ts` + `jobs-fixture-replay.test.ts`.

**Tasks:**
- [ ] Implement `select-jobs.ts` against the Step 1 shapes; every helper pure and
      exported.
- [ ] Wire the reducer: launch insert (terminal background `tool_result`,
      suppressed during replay per [P11]), `task_started` upsert (gated on the
      backgrounded discriminant), `task_updated` flip, `wake_started` fold, terminal
      `TaskStop` flip, `session_init` stale-marking (R03), `clear_jobs_action`.
      Stamp `startedAtMs` / `endedAtMs` with `Date.now()` in the handlers, the
      `toolUseStartedAt` precedent ([P10]).
- [ ] R03 makes `handleSessionInit` mutate state for the first time — update its
      "No state mutation" docstring to reflect the new contract.
- [ ] Snapshot identity: the `jobs` array reference is stable across unrelated
      dispatches ([L02] quiescent-rebuild rule, the `wakeTrigger` precedent).
- [ ] Add the two facade methods (named-method precedent: `interrupt` /
      `setPermissionMode`; `stopJob` mirrors the `addDirectory` direct send).
- [ ] Implement `useJobsState` (memoized on snapshot field identity, the
      `useTaskListState` shape).

**Tests:**
- [ ] Pure-logic: every Spec S01 rule, pose table (Spec S02) including
      no-idle-demotion (pose function has no phase parameter), clear-preserves-running,
      unknown-id flips ignored, parse-miss fallbacks, foreground-`task_started`
      frames rejected by the gate.
- [ ] Fixture-replay: the Step 1 captures through the real store produce the expected
      ledger at each stage (launch → running; terminal frame → flipped; respawn init
      → stopped).
- [ ] Replay suppression ([P11]): running the launch fixture through the store in
      replay context (`replay_started` … `replay_complete`) leaves the ledger empty.

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bun run check`

---

#### Step 5: JOBS cell in the Z2 row {#step-5}

**Depends on:** #step-4

**Commit:** `Add JOBS cell to the Z2 status row`

**References:** [P01] mirror TASKS, [P02] no idle demotion, [P07] row layout,
Spec S02, Spec S03, Risk R02, (#state-zone-mapping)

**Artifacts:**
- JOBS `TugStatusCell` in `DevTelemetryStatusRow` (`dev-card-telemetry-renderers.tsx`),
  fed by `useJobsState` + `jobsCellPose`; `cellOrder(5)`; `focusOrderBase` doc comment
  updated to base + 0…5.
- `tug-status-cell.css`: `time` / `tokens` 12ch, `jobs` 14ch width entries; collapse
  rungs TIME → TOKENS → TASKS → JOBS with retuned breakpoints.

**Tasks:**
- [ ] Render the cell with the exact TASKS markup grammar (`TugProgressIndicator`
      pulsing-dot, `glyphPosition="both"`, `N/M` label, `valueEmpty` when empty,
      `phaseLabels` for width stabilization).
- [ ] Narrow TIME / TOKENS widths; add the JOBS width; retune the four collapse
      breakpoints against the new row sum (verify visually at narrow card widths).
- [ ] Verify the popover placeholder (empty popover body until #step-6) or land the
      cell with a minimal "No background jobs" popover frame.
- [ ] Cross-check tuglaws (pane-model / component-authoring) before the edit; name
      the laws touched in the commit message.

**Tests:**
- [ ] Pure-logic only (pose / label derivation already covered in #step-4); no
      fake-DOM render tests per #test-non-goals.

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bun run check`
- [ ] Visual check in the running app (HMR): six cells render; TIME / TOKENS narrowed;
      collapse order correct when the card narrows

---

#### Step 6: Jobs popover with stop and clear {#step-6}

**Depends on:** #step-5

**Commit:** `Add Jobs popover with stop and clear actions`

**References:** [P04] clear, [P06] stop, [P10] tick leaf, Spec S04,
(#s04-popover, #terminology-guard)

**Artifacts:**
- `JobsPopoverContent` + `JobElapsedValue` in `dev-card-telemetry-popovers.tsx`
  (+ `.css` additions), wired into the JOBS cell with `onStopJob` / `onClearJobs`
  callbacks threaded from `DevTelemetryStatusRow` (which owns the store).
- `useLiveTick` exported (or lifted) for the popover leaf.

**Tasks:**
- [ ] Build the popover per Spec S04: rows (indicator · mono preview + tooltip ·
      elapsed · stop button on running rows), summary footer, Clear button disabled
      without terminal rows.
- [ ] Thread `codeSessionStore.stopJob` / `.clearJobs` from the status row as
      callbacks; the popover stays a function of inputs.
- [ ] `JobElapsedValue` subscribes to the shared 1Hz tick; mounts only inside the
      popover ([P10]).

**Tests:**
- [ ] Pure-logic: `composeJobsSummary` zero-bucket drop; elapsed formatting for
      terminal vs running rows (formatter-level).

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bun run check`
- [ ] Live check in the running app: launch a background job, watch the cell flip,
      open the popover, stop the job from the stop button, clear the terminal row

---

#### Step 7: Document the JOBS cell {#step-7}

**Depends on:** #step-6

**Commit:** `Document the JOBS cell in design-decisions`

**References:** [P01]–[P09], (#documentation-plan)

**Artifacts:**
- `tuglaws/design-decisions.md`: [D97] zone table updated (Z2 row contents include
  JOBS); a new global decision entry recording the shipped JOBS design (grammar
  mirror, no idle demotion, session-lifetime ledger, clear semantics, stop path).

**Tasks:**
- [ ] Update the zone table and write the decision entry in the established [D100]
      register (what shipped + why, history if anything was reshaped en route).

**Tests:**
- [ ] N/A — documentation only.

**Checkpoint:**
- [ ] [D97] zone table and the new decision entry render correctly and cite this
      plan's path

---

#### Step 8: Integration checkpoint {#step-8}

**Depends on:** #step-2, #step-4, #step-6, #step-7

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Verify all artifacts from Steps 2–7 work together end-to-end against a live
      session: launch → running pose at idle → stop from popover → terminal flip →
      clear → dimmed `None`; failed job → `aborted` pose held until clear.
- [ ] Confirm the wake bracket is unaffected (a deferred-completion wake still opens
      and closes normally with the new frames in play).

**Tests:**
- [ ] Full suites: `cd tugdeck && bun test`, `cd tugcode && bun test`.

**Checkpoint:**
- [ ] `cd tugdeck && bun test && cd ../tugcode && bun test`
- [ ] `cd tugdeck && bun run check`
- [ ] `just build` then live end-to-end walk per the Tasks above

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A shipped Z2 `JOBS` cell tracking AI-initiated background jobs —
live count + pose, popover with per-job rows, stop for running jobs, clear for
finished ones — fed by tugcode-forwarded task frames into a session-lifetime deck
ledger.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Every #success-criteria item verified (live walk + tests).
- [ ] Q01 / Q02 / Q04 resolved by committed fixtures; Q03 explicitly deferred.
- [ ] `tuglaws/design-decisions.md` reflects the shipped Z2 row.

**Acceptance tests:**
- [ ] `jobs-fixture-replay.test.ts` — captured lifecycle through the real store.
- [ ] `select-jobs.test.ts` — Spec S01 / S02 rules exhaustively.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Output-tail "job details" view (needs a new inbound fetch verb for
      `output_file` content).
- [ ] Ledger reconstruction across replay / resume ([Q03]).
- [ ] tugexec (`$` route) jobs joining the source-agnostic ledger ([P09]).

| Checkpoint | Verification |
|------------|--------------|
| Store behavior pinned | `cd tugdeck && bun test` (fixture-replay + pure-logic suites) |
| Bridge forwarding pinned | `cd tugcode && bun test` |
| Types clean | `cd tugdeck && bun run check` |
| Real-app behavior | Live end-to-end walk (#step-8) |
