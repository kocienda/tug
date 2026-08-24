<!-- devise-skeleton v4 -->

## Monitors in JOBS — Watchers Join the Background-Jobs Ledger {#monitors-in-jobs}

**Purpose:** Extend the Z2 `JOBS` cell ([D102]) to track `Monitor` watchers alongside
background `Bash` / `Agent` jobs — an armed monitor is currently invisible for its
entire lifetime until it fires, and has no kill switch in the UI.

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

The shipped JOBS cell (`dash/jobs-tracking.md`, [D102]) tracks "things Claude has
running in the background" — but its insert gate is the *mechanism* (`input.
run_in_background === true` on the launching tool call), not the *meaning*. `Monitor`
watchers are genuine long-lived background activity riding the **same task registry
and the same wire frames** — the v2.1.150 wake capture shows a monitor firing
`task_started` (with `task_type: "local_bash"`, since its script is a shell command),
a terminal `task_updated{status:"killed"}` at timeout, and `task_notification`s — yet
they fail the gate and never appear. The wake bracket surfaces the *firing moment*;
nothing surfaces the hours-long *watching*, and there is no UI way to kill a runaway
watcher.

One wire fact makes this more than a one-line gate change. The monitor launch echo
reads *"Monitor started (task `<id>`, timeout 5000ms). **You will be notified on each
event.**"* — a recurring monitor fires notifications **while still running**. The
shipped ledger flips a row to terminal when the wake trigger carries its `task_id`
([D102]'s wake fold); applied to a monitor, the first event would mark a live watcher
"completed". Monitor rows therefore need their own flip rule: only `task_updated`
(the genuine terminal — timeout, script exit, or kill) finishes them.

tugcode needs no changes: `buildTaskStartedMessage` / `buildTaskUpdatedMessage`
forward every `task_started` / `task_updated` verbatim regardless of task type — the
monitor frames already arrive at the deck and are dropped by the reducer's gate.

#### Strategy {#strategy}

- **Capture first, again.** The jobs plan's capture discipline paid off; this plan's
  unknowns (per-event notification shape, natural-exit status, control-request kill
  on a watcher) get the same treatment before any narrowing changes.
- **Deck-only.** The wire layer, IPC frames, and tugcode are untouched; every change
  lives in `select-jobs.ts`, the reducer's two job handlers, and the popover summary.
- **Meaning over mechanism.** The gate becomes "backgrounded OR a Monitor launch";
  `kind: "monitor"` is derived from the launching tool's name (the frame's
  `task_type` reads `local_bash` for monitors and cannot discriminate).
- **One instrument, disambiguated in the popover.** Monitors count in the cell's
  `N/M` and pose like any row (a pulsing dot for a live watcher is honest); the
  popover summary separates them ("1 watching") so finite work and watchers read
  distinctly where there is room to say so.

#### Success Criteria (Measurable) {#success-criteria}

- Arming a Monitor in a live session flips the JOBS cell to `0/1` `running` and the
  popover shows the watcher with live elapsed and a stop button. (Live walk;
  fixture-replay test pins the store level.)
- A recurring monitor event (notification + wake) does **not** flip the watcher's row
  — it stays `running` through any number of events. (Fixture-replay test fed the
  captured event sequence.)
- The terminal `task_updated` (timeout / exit / kill) flips the row exactly once,
  to the captured status mapping. (Pure-logic + fixture-replay tests.)
- The popover stop button kills a live watcher via the existing `stop_task` verb,
  wire-confirmed. (Live walk; capture pins the confirmation frames.)
- Foreground subagents and async-subagent-internal monitors still never enter the
  ledger. (Existing fixture-replay test stays green; gate logic unit-tested.)
- `cd tugdeck && bun test` and `cd tugdeck && bun run check` pass at every step
  boundary.

#### Scope {#scope}

1. Capture: monitor lifecycle fixtures on the installed claude (arm → recurring
   events → natural exit; timeout; persistent watcher + control-request stop).
2. `select-jobs.ts`: `kind: "monitor"`, launch-gate/kind helpers, the monitor echo
   parse family, the notification-flip exemption, a `watching` summary bucket.
3. Reducer: relaxed `task_started` gate; monitor-exempt wake fold.
4. Popover summary wording + [D102] amendment.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Any change to the wake bracket itself — monitor events keep waking claude exactly
  as today; this plan only stops those wakes from corrupting the ledger row.
- Surfacing monitor *events* (the per-event payloads) in the popover — the wake turns
  already carry them in the transcript.
- `ScheduleWakeup` / `CronCreate` — captured as inert in Tide's spawn mode (Cohort B,
  `v2.1.150-spike/README.md`); nothing runs, nothing to track.
- tugcode / wire changes of any kind.

#### Dependencies / Prerequisites {#dependencies}

- The shipped jobs feature (`dash/jobs-tracking.md`, all steps done; [D102]).
- Captured monitor baseline: `v2.1.150-spike/test-monitor-wake-raw.jsonl` (frame
  vocabulary) — superseded for shapes by this plan's Step 1 capture on the current
  claude.
- The `stop_task` path (already exercised by the jobs feature).

#### Constraints {#constraints}

- Same as the jobs plan: bun only; tugdeck HMR (no manual builds); no
  localStorage-family storage; warnings are errors; tuglaws throughout ([L02],
  [L06], [L19], [L20], [L26]); no fake-DOM or mock-store tests.

#### Assumptions {#assumptions}

- Monitor lifecycle frames on the current claude keep the captured 2.1.150 grammar
  (`task_started` + terminal `task_updated`); Step 1 re-pins on the installed
  version.
- A monitor's launching `Monitor` tool call is visible in the deck stream whenever
  the watcher should be tracked (true for top-level calls; async-subagent-internal
  ones are correctly invisible).

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Per-event notification shape for a still-running monitor (OPEN) {#q01-event-notification}

**Question:** When a recurring monitor emits an event (script prints a line, watcher
keeps running), what exactly fires — a `task_notification` with what `status`, and
does any `task_updated` accompany it?

**Why it matters:** This is the frame the flip-exemption rule defends against. If a
mid-life notification carried, say, `status:"completed"`, the shipped fold would
wrongly finish the row; the exemption must be pinned against the real sequence, and
the fixture-replay test needs the real frames.

**Plan to resolve:** Step 1 capture — a monitor whose script emits two events before
exiting (#step-1).

**Resolution:** DECIDED — pinned by `test-monitor-lifecycle-raw.jsonl`. Mid-life
events do **not** fire `task_notification` at all: each event wakes claude via a
`system/init` re-init (the scheduled-wake mechanism), which tugcode forwards as a
synthetic `wake_started` with an **empty `task_id`** — structurally unable to flip
any row. A monitor's only `task_notification` is terminal, fired alongside the
terminal `task_updated`, with agreeing statuses. [P02]'s exemption is therefore
defense-in-depth against future wire drift rather than a fix for a live corruption
path; it ships anyway (cheap, and pins the invariant structurally).

#### [Q02] Terminal status vocabulary for monitors (OPEN) {#q02-terminal-vocabulary}

**Question:** What `task_updated.patch.status` does each monitor ending produce —
natural script exit, timeout (2.1.150 captured `"killed"`), and a control-request
`stop_task`?

**Why it matters:** `terminalJobStatusFromWire` must cover the full vocabulary or a
monitor ending is silently dropped and the row pulses forever (the exact failure the
ledger exists to prevent).

**Plan to resolve:** Step 1 captures all three endings (#step-1).

**Resolution:** DECIDED — natural script exit → `task_updated{status:"completed"}`
(+ terminal `notification{completed, "stream ended"}`); timeout → `killed` (+
`notification{stopped}`); control-request `stop_task` → `killed` (+
`notification{stopped}`). All inside `terminalJobStatusFromWire`'s existing
vocabulary — no additions needed.

#### [Q03] Does `stop_task` kill a live watcher? (OPEN) {#q03-stop-kills-watcher}

**Question:** The jobs capture confirmed the control-request stop on a background
Bash; monitors live in the same registry, so it should work identically — verify.

**Why it matters:** The stop button on watcher rows is half the point of this plan.

**Plan to resolve:** Step 1's persistent-watcher phase sends the control request
(#step-1).

**Resolution:** DECIDED — **yes.** The capture's persistent watcher died on the
control request with `task_updated{killed}` + `notification{stopped}` and a
`control_response` ack — identical to the background-Bash stop.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Mid-life notification flips a watcher row | med | high without R01 | The kind-aware flip exemption ([P02]), pinned by the Q01 capture | Fixture-replay test failure on a claude upgrade |
| Unknown terminal status leaves a row pulsing forever | med | low | Q02 pins the vocabulary; unknown statuses are already dropped defensively — the session-init stale-marking and user stop remain backstops | A watcher row that outlives its process |
| A chatty persistent monitor dominates the cell | low | med | By design: `running` pose is honest. The popover's `watching` bucket and per-row stop give the user the read and the remedy | User feedback that JOBS reads as noise |

**Risk R01: Event-flip corruption** {#r01-event-flip}

- **Risk:** A recurring monitor's first event marks the live watcher terminal,
  freezing its elapsed and hiding its stop button while it still runs.
- **Mitigation:**
  - [P02]'s rule: `wake_started` triggers never flip `kind: "monitor"` rows; only
    `task_updated` does.
  - The fixture-replay test feeds the captured arm → event → event → exit sequence
    and asserts the row stays `running` until the terminal frame.
- **Residual risk:** A future claude that stops emitting terminal `task_updated` for
  monitors would strand rows at `running` — caught by the drift posture (re-run the
  Step 1 probe on upgrades), bounded by stale-marking and manual stop.

---

### Design Decisions {#design-decisions}

#### [P01] The insert gate becomes "backgrounded OR a Monitor launch" (DECIDED) {#p01-gate-extension}

**Decision:** `handleTaskStarted` inserts when the launching tool call satisfies
`input.run_in_background === true` **or** `toolName === "Monitor"`. The job's `kind`
derives from the launching tool name first (`Monitor` → `"monitor"`), falling back to
the frame's `task_type` mapping for bash/agent.

**Rationale:**
- The cell's contract is "things Claude has running in the background" — meaning,
  not mechanism. A watcher is background activity with a lifetime and a kill switch.
- The frame cannot discriminate: a monitor's `task_type` reads `"local_bash"`
  (captured), so the launching call — which the gate already looks up by
  `tool_use_id` — is the only honest source for `kind`.

**Implications:**
- The existing foreground-subagent and async-internal exclusions hold unchanged
  (both rely on the launching call's visibility, not on the flag).
- `JobItem["kind"]` gains `"monitor"`; `jobKindFromTaskType` stays as the fallback.

#### [P02] Notifications never flip monitor rows; only `task_updated` does (DECIDED) {#p02-monitor-flip-rule}

**Decision:** The `wake_started` trigger fold skips rows whose `kind` is
`"monitor"`. Monitor rows reach terminal exclusively via `task_updated` (plus the
existing `TaskStop` fold, `session_init` stale-marking, and Clear-immunity rules,
which apply unchanged).

**Rationale:**
- The captured echo promises notification **per event**; for finite jobs a
  notification means "done", for watchers it means "something happened". Flipping on
  it would mark a live watcher finished on its first event (Risk R01).
- `task_updated` is the registry's genuine terminal for monitors too (2.1.150
  captured `killed` at timeout).

**Implications:**
- The fold needs the row's `kind` — a kind-aware variant of the flip (or an inline
  check in `handleWakeStarted`) rather than the bare `applyJobFlip`.
- First-terminal-wins semantics are unchanged for all kinds.

#### [P03] Monitors count in `N/M` and pose like any row; the popover summary separates them (DECIDED) {#p03-counting}

**Decision:** The cell label and pose treat monitor rows identically to jobs (a live
watcher keeps the dot `running`; a killed one counts toward `finished`). The popover
summary gains a `watching` bucket: running monitors read "1 watching", running
finite jobs keep "1 running".

**Rationale:**
- One instrument: a special-cased cell (excluding watchers) would make `N/M` lie
  about the pulsing dot next to it.
- The popover is where there's room to disambiguate — settled in the design
  discussion ("counting monitors separately in the popover summary").

**Implications:**
- `countJobs` gains `watching` (running ∧ monitor); `running` then counts only
  finite jobs in the summary composition. `finished` is unchanged (status-based).

#### [P04] The monitor launch echo joins the secondary insert path (DECIDED) {#p04-monitor-echo}

**Decision:** `parseBackgroundLaunchResult` learns the third echo family —
`"Monitor started (task <id>, timeout <n>ms)"` — returning `kind: "monitor"` (no
output file; the captured echo carries none).

**Rationale:**
- Symmetry with bash/agent: the echo path exists as the fallback when a
  `task_started` frame is missed; monitors deserve the same robustness.
- The launch-insert call site in `handleToolResult` keys off
  `input.run_in_background` today and must also admit Monitor calls — same gate
  predicate as [P01], extracted once and shared.

**Implications:**
- One new regex branch + the shared gate predicate (`isJobLaunch(toolName, input)`)
  used by both `handleTaskStarted` and `handleToolResult`.

#### [P05] tugcode and the wire are untouched (DECIDED) {#p05-no-wire-changes}

**Decision:** No new frames, no forwarding changes, no tugproto changes.

**Rationale:**
- `buildTaskStartedMessage` / `buildTaskUpdatedMessage` already forward every task
  frame verbatim regardless of `task_type`; the monitor frames reach the deck today
  and die at the reducer's gate — the gate is the whole feature.

**Implications:**
- This plan runs entirely under tugdeck HMR; no binary rebuilds during iteration
  (the integration walk still uses a debug build).

#### [P06] Amend [D102] rather than minting a new global decision (DECIDED) {#p06-amend-d102}

**Decision:** The global record of this change is an amendment to [D102] (gate
wording, the monitor flip rule, the `watching` bucket), not a new `[D###]` entry.

**Rationale:**
- Same surface, same ledger, same cell — a reader of [D102] must see the watcher
  semantics inline, not chase a second entry.

**Implications:**
- The [D102] paragraph's "gate on `input.run_in_background === true`" sentence and
  the popover description are revised in place; a History note records the
  extension and cites this plan.

---

### Specification {#specification}

**Spec S01: Gate and kind derivation** {#s01-gate-kind}

```ts
// select-jobs.ts — shared by handleTaskStarted and handleToolResult
function isJobLaunch(toolName: string, input: Record<string, unknown> | null): boolean
// true iff input?.run_in_background === true || toolName === "Monitor"

function jobKindForLaunch(toolName: string, taskType: string): JobItem["kind"]
// "Monitor" → "monitor"; else jobKindFromTaskType(taskType)
```

`JobStatus` is unchanged; `JobItem["kind"]` becomes
`"bash" | "agent" | "monitor" | "unknown"`. Any additional terminal vocabulary Q02
surfaces extends `terminalJobStatusFromWire`'s switch.

**Spec S02: Flip semantics by source** {#s02-flip-semantics}

| Flip source | bash / agent / unknown rows | monitor rows |
|---|---|---|
| `task_updated` (terminal map) | flips | flips |
| `wake_started` trigger fold | flips | **never** ([P02]) |
| terminal `TaskStop` fold | flips | flips |
| `session_init` stale-marking | flips running → stopped | flips running → stopped |
| `clear_jobs_action` | terminal rows dropped; running survive | same (a live watcher is unclearable) |

First terminal flip wins, all kinds.

**Spec S03: Summary buckets** {#s03-summary}

`countJobs` adds `watching` (status `running` ∧ kind `monitor`); the summary's
running bucket becomes `running − watching`. Composition order:
`"N running, N watching, N done, N failed, N stopped"`, zero buckets dropped, empty
ledger reads `"no jobs"`. Cell label (`finished/total`) and `jobsCellPose` are
untouched.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| `kind: "monitor"` rows in the `jobs` ledger | external session state | existing reducer field + `useJobsState` — no new subscription surface | [L02] |
| `watching` bucket | derived display data | pure `countJobs` / `composeJobsSummary` over props | [L02] (derivation stays out of React state) |
| watcher row pose | appearance | existing `TugProgressIndicator` state mapping | [L06] |

No new state zones — the feature is a derivation/gating change over the shipped
ledger.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/v2.1.173-jobs-spike/test-monitor-lifecycle-raw.jsonl` | Step 1 capture (same spike dir as the jobs fixtures; README table extended) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `isJobLaunch`, `jobKindForLaunch` | fn | `select-jobs.ts` | Spec S01; shared gate predicate |
| `JobItem["kind"]` | type | `select-jobs.ts` | + `"monitor"` |
| `parseBackgroundLaunchResult` | edit | `select-jobs.ts` | + monitor echo family ([P04]) |
| `countJobs`, `JobCounts`, `composeJobsSummary` | edit | `select-jobs.ts` | + `watching` bucket (Spec S03) |
| `handleTaskStarted` | edit | `reducer.ts` | gate via `isJobLaunch`; kind via `jobKindForLaunch` |
| `handleToolResult` launch branch | edit | `reducer.ts` | gate via `isJobLaunch` |
| `handleWakeStarted` fold | edit | `reducer.ts` | monitor exemption ([P02]) |
| `probe-jobs-lifecycle.mjs` | edit | `v2.1.173-jobs-spike/probes/` | + monitor phases (or a sibling probe file) |
| [D102] | edit | `tuglaws/design-decisions.md` | [P06] amendment |

---

### Documentation Plan {#documentation-plan}

- [ ] [D102] amendment per [P06].
- [ ] `v2.1.173-jobs-spike/README.md`: new fixture row + Q01–Q03 resolutions.
- [ ] `select-jobs.ts` module docstring: the gate is meaning-based; monitor flip
      rule noted beside the wake-fold mention.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (pure-logic bun:test)** | Gate predicate, kind derivation, monitor echo parse, `watching` bucket, summary composition | `select-jobs.test.ts` extensions |
| **Fixture-replay (real store)** | Captured monitor lifecycle through `CodeSessionStore`: arm → insert; event notification → no flip; terminal `task_updated` → flip; stop path | `jobs-fixture-replay.test.ts` extensions |

#### What stays out of tests {#test-non-goals}

- Fake-DOM render tests and mock-store call-count tests — banned, as before.
- The wake bracket's own behavior on monitor events — pre-existing, covered by the
  wake suites; this plan only asserts the *ledger* is untouched by those wakes.
- Popover visuals — verified in the running app.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** This rule applies to every step below.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Capture monitor lifecycle fixtures | done | e41be1ca |
| #step-2 | Gate, kind, echo, and summary helpers | done | dab23ce6 |
| #step-3 | Reducer gate + monitor flip rule | done | 04a5a989 |
| #step-4 | Docs: [D102] amendment + fixture README | done | 82d35e0b |
| #step-5 | Integration checkpoint | pending | — |

#### Step 1: Capture monitor lifecycle fixtures {#step-1}

**Commit:** `Capture monitor lifecycle stream-json fixtures`

**References:** [Q01], [Q02], [Q03], Risk R01, (#context, #q01-event-notification)

**Artifacts:**
- `test-monitor-lifecycle-raw.jsonl` in `v2.1.173-jobs-spike/`, covering: a monitor
  whose script emits **two events then exits naturally** (Q01 + Q02 natural exit), a
  short-timeout monitor (Q02 timeout), and a **persistent monitor stopped via the
  `stop_task` control request** (Q02 kill + Q03).
- README table row + shape notes recording the per-event notification status, the
  terminal vocabulary, and the stop confirmation.

**Tasks:**
- [ ] Extend `probe-jobs-lifecycle.mjs` with the three monitor phases (or add a
      sibling `probe-monitor-lifecycle.mjs`), reusing the persistent stream-json
      session driver and the stdin control-request helper.
- [ ] Run against the installed claude; trim and commit the capture.
- [ ] Record [Q01]/[Q02]/[Q03] resolutions in the README shape notes.

**Tests:**
- [ ] N/A — fixture-only; the frames become Step 2/3 test inputs.

**Checkpoint:**
- [ ] `grep -l "Monitor started" tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/v2.1.173-jobs-spike/test-monitor-lifecycle-raw.jsonl`
- [ ] Shape notes answer Q01, Q02 (all three endings), and Q03 explicitly

---

#### Step 2: Gate, kind, echo, and summary helpers {#step-2}

**Depends on:** #step-1

**Commit:** `Teach select-jobs the monitor kind and launch gate`

**References:** [P01], [P03], [P04], Spec S01, Spec S03, (#s01-gate-kind, #s03-summary)

**Artifacts:**
- `isJobLaunch` / `jobKindForLaunch` in `select-jobs.ts`; `"monitor"` in
  `JobItem["kind"]`; the monitor echo family in `parseBackgroundLaunchResult`;
  `watching` in `JobCounts` / `countJobs` / `composeJobsSummary`; any Q02 vocabulary
  additions in `terminalJobStatusFromWire`.
- `select-jobs.test.ts` extensions.

**Tasks:**
- [ ] Implement the helpers against the Step 1 shapes; module docstring updated per
      the documentation plan.
- [ ] Keep `jobKindFromTaskType` as the non-monitor fallback.

**Tests:**
- [ ] Gate predicate: backgrounded Bash/Agent true; Monitor true regardless of
      flag; foreground Agent false; null input false.
- [ ] Kind: Monitor launch → `"monitor"` even with `task_type: "local_bash"` (the
      captured ambiguity).
- [ ] Echo: captured monitor echo parses to `{jobId, kind: "monitor"}`; bash/agent
      echoes unchanged.
- [ ] Summary: `watching` bucket separates running monitors; zero-drop holds;
      `finished`/pose unchanged.

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/lib/code-session-store/__tests__/select-jobs.test.ts`
- [ ] `cd tugdeck && bun run check`

---

#### Step 3: Reducer gate + monitor flip rule {#step-3}

**Depends on:** #step-2

**Commit:** `Track monitors in the jobs ledger with notification-proof flips`

**References:** [P01], [P02], Spec S02, Risk R01, (#s02-flip-semantics)

**Artifacts:**
- `handleTaskStarted` + `handleToolResult` using `isJobLaunch` / `jobKindForLaunch`.
- `handleWakeStarted`'s fold exempting `kind: "monitor"` rows ([P02]).
- `jobs-fixture-replay.test.ts` extensions fed by the Step 1 capture.

**Tasks:**
- [ ] Swap the inline gate for the shared predicate at both call sites; derive kind
      from the launching call's `toolName`.
- [ ] Add the kind check to the wake fold (inline or a kind-aware flip helper);
      comment cites the per-event-notification capture.
- [ ] Confirm replay suppression and `session_init` stale-marking apply to monitor
      rows with no further changes (they are kind-agnostic).

**Tests:**
- [ ] Fixture-replay: arm → one `running` monitor row (kind `"monitor"`); event
      notification (as `wake_started`) → row still `running`; second event → still
      `running`; terminal `task_updated` → flipped to the captured status.
- [ ] Fixture-replay: persistent watcher + `stopJob` payload pin + captured
      kill confirmation → `stopped`.
- [ ] Existing suites stay green (foreground-agent gate, bash/agent lifecycles,
      replay suppression).

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bun run check`

---

#### Step 4: Docs — [D102] amendment + fixture README {#step-4}

**Depends on:** #step-3

**Commit:** `Document monitor tracking in the JOBS decision record`

**References:** [P06], [P02], [P03], (#documentation-plan)

**Artifacts:**
- [D102] revised in place: gate wording ("backgrounded or a `Monitor` launch"),
  the monitor flip rule, the `watching` summary bucket, History note citing this
  plan.
- `v2.1.173-jobs-spike/README.md` already extended in Step 1 — verify the Q
  resolutions read correctly against the landed behavior.

**Tasks:**
- [ ] Amend [D102]; keep the paragraph's register and cross-references.

**Tests:**
- [ ] N/A — documentation only.

**Checkpoint:**
- [ ] [D102] names the monitor rule and cites `dash/monitors-in-jobs.md`

---

#### Step 5: Integration checkpoint {#step-5}

**Depends on:** #step-3, #step-4

**Commit:** `N/A (verification only)`

**References:** (#success-criteria)

**Tasks:**
- [ ] Live walk in a debug build: arm a recurring monitor → JOBS flips to `0/1`
      running, popover shows "1 watching" with live elapsed; trigger events → row
      survives the wakes; stop from the popover → row flips `stopped`; let a
      short-timeout monitor expire → terminal flip without user action.
- [ ] Confirm bash/agent jobs behave exactly as before alongside a watcher.

**Tests:**
- [ ] Full suite: `cd tugdeck && bun test`.

**Checkpoint:**
- [ ] `cd tugdeck && bun test && cd tugdeck && bun run check` green
- [ ] Live walk per the Tasks above

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Monitor watchers appear in the Z2 JOBS cell with honest lifetimes —
visible while armed, immune to per-event notification flips, killable from the
popover, and disambiguated as "watching" in the summary.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Every #success-criteria item verified (live walk + tests).
- [ ] Q01–Q03 resolved by committed fixtures.
- [ ] [D102] amended.

**Acceptance tests:**
- [ ] `jobs-fixture-replay.test.ts` monitor scenarios (no-flip-on-event being the
      load-bearing one).
- [ ] `select-jobs.test.ts` gate/kind/echo/summary extensions.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Surfacing monitor event payloads (beyond the wake turns) — e.g. an event count
      on the watcher row.
- [ ] The output-tail job-details view (carried over from the jobs plan).

| Checkpoint | Verification |
|------------|--------------|
| No-flip-on-event pinned | fixture-replay monitor scenario |
| Gate/kind/echo pinned | `select-jobs.test.ts` |
| Real-app behavior | Step 5 live walk |
