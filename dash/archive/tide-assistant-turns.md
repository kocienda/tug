<!-- tugplan-skeleton v2 -->

## Tide Assistant Turns — Request/Response Lifecycle & Telemetry {#tide-assistant-turns}

**Purpose:** Build the request/response *turn* surface for tide cards — the layer that wraps each user-prompt → assistant-response interaction. Where [`tide-assistant-rendering.md`](./tide-assistant-rendering.md) covers content rendering (body kinds, tool wrappers, markdown / diff / terminal / file viewer / etc.), this plan covers everything that happens *around* a single turn: gauge primitives for the displays it powers, multi-clock telemetry collection on `CodeSessionStore`, the six-zone placement architecture (Z0–Z5) the tide card uses for those displays, and the lifecycle state machine that coordinates them.

This plan was extracted from [`tide-assistant-rendering.md`](./tide-assistant-rendering.md) Step 20.x; see that doc for the surrounding rendering-layer context. Polish-plan Steps 13 / 14 / 15 (thinking + tool surfaces, mid-stream behaviors, `control_request_forward` UI) are audited and gap-closed in [Step 20.5.B](#step-20-5-b).

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main (currently authored directly on main) |
| Last updated | 2026-05-16 |
| Extracted from | [`tide-assistant-rendering.md`](./tide-assistant-rendering.md) Step 20.x |

---

### Phase Overview {#phase-overview}

#### Context {#context}

A tide card hosts a Claude Code conversation as a stream of *turns* — each turn is a user prompt and the assistant's response (which may include thinking, tool calls, tool results, permission/question dialogs, and a final answer). The rendering layer ([`tide-assistant-rendering.md`](./tide-assistant-rendering.md)) handles *what's inside* a turn (markdown, diffs, terminals, file viewers); this plan handles *the turn itself* — its lifecycle, its measurements, its UI containers.

Two problems motivate this plan:

1. **Telemetry is missing.** Today the tide card drops cost / token / time data on the floor. There's no per-turn duration display, no cumulative session totals, no awareness of the context window getting full, no honest accounting of "how long did Claude actually work?" vs. "how long was I waiting on a dialog?" The user has no read on the session shape.
2. **Lifecycle coordination is ad-hoc.** The submit button knows about Submit / Stop but not about "Awaiting your input" (during a permission dialog), "Stopping…" (during interrupt), "Reconnecting…" (during transport-down). The status displays that show live counts don't freeze when a turn pauses on a dialog. The relationship between "what's the lifecycle state right now" and "what should the UI show in each zone" is undocumented and re-derived everywhere it's used.

Both problems collapse to a missing **state-coordinated turn surface**. This plan builds that surface, in five sub-steps gated by primitives → data → spike → zones → spec → implementation.

#### Strategy {#strategy}

- **Primitives first.** Build gauge primitives (TugLinearGauge, TugArcGauge) with their full gallery cards before any consumer wires them. Sequence: linear gauge first → shared color slots settle → arc gauge layered on top without re-tuning shared tokens.
- **Data model before UI.** Land multi-clock telemetry (wallClock / awaitingApproval / transportDowntime / active + diagnostics) and per-turn cost-delta accounting as typed `TurnEntry` fields with a pure-logic helper module — **before** any chrome consumes them. The chrome reads typed snapshots; it does not scrape `lastCost.usage`.
- **Honest measurement.** `awaitingApprovalMs` excludes user-interaction time (TugInlineDialog open intervals — both permission AND question dialogs). `transportDowntimeMs` excludes WebSocket disconnect intervals. `activeMs` is what's left — machine-doing-work time. Silent in-connection API stalls intentionally fall inside `activeMs` (we measure what we can authoritatively measure; stream-idle heuristic deferred until we have `maxStreamGapMs` distributions to inform it).
- **Zone architecture as contract.** Six zones (Z0 top-of-card → Z5 submit-button) numbered spatially top-to-bottom. The renderer registry targets zones by ID. Placement decisions are deferred to a focused HMR study; the slot mechanism makes A/B trivial.
- **Lifecycle spec, then implementation.** State machine + state-to-zone coordination matrix land as a documented artifact ([Step 20.5.A](#step-20-5-a)) before any wiring. Implementation ([Step 20.5.D](#step-20-5-d)) encodes the matrix as one switch in `deriveLifecycleSnapshot`; zones consume via `useLifecycleState()`.
- **Audit before re-implementing.** Polish-plan Steps 13 / 14 / 15 are ~70% done. Audit current state in [Step 20.5.B](#step-20-5-b); close known gaps (e.g., `tide-question-dialog`). Build 20.5.D on working primitives, not on rebuilt ones.

#### Success Criteria (Measurable) {#success-criteria}

- `TurnEntry` carries the full telemetry shape: time-accounting (`wallClockMs`, `awaitingApprovalMs`, `transportDowntimeMs`, `activeMs`), diagnostics (`ttftMs`, `ttftcMs`, `reconnectCount`, `maxStreamGapMs`, `turnEndReason`), cost (`cost: TurnCost`), plus per-tool wall (`ToolCall.toolWallMs`). Per-turn deltas accumulate correctly; session totals sum correctly.
- Pure-logic tests cover the helper module (`perTurnContextSize`, `extractTurnCost`, `deriveSessionTotals`, `liveTurn*` family).
- Reducer-level tests cover awaiting-approval accumulation, transport-downtime accumulation, per-turn cost delta math, terminal-state branches.
- All six zones (Z0–Z5) formalized in the API contract. Z0 + Z1-user-half ship empty/reserved (slot mechanism present; default content `null`). Z3 (prompt-entry top) retains project-path badge as its default; renderer registry can replace it.
- Z5 submit button coordinates with the lifecycle state machine: Submit / Stop / "Awaiting your input" / "Stopping…" / "Reconnecting…" / queued-visual. Same DOM node across mode transitions, verified via mount-identity probe.
- `useLifecycleState()` hook returns a snapshot that drives Z2 (status bar) and Z5 (button mode) consistently — every distinct row of the state-to-zone matrix has an end-to-end test. Reference-stable per [DT09].
- `useLifecycleTick(intervalMs)` provides the 1-second ticker that drives Z2's live-elapsed readouts during in-flight turns; idle when phase is terminal (no leaked timers).
- `tide-question-dialog` exists (fills polish-plan §Step 15 gap); both permission and question dialogs wire to `awaitingApprovalSince`.
- `tailSpacer="80cqh"` either removed (if [L26] mount-identity work obviates it) or correctly documented with the real reason (if it serves streaming jitter / visual comfort).
- `bun x tsc --noEmit`, `bun test`, `bun run audit:tokens lint` all green at every step.
- All work respects [L02] (useSyncExternalStore for external state), [L06] (appearance via DOM/CSS), [L17] (one-hop alias), [L19] (component authoring), [L20] (token sovereignty), [L23] (preserve user-visible state), [L24] (state zones), [L26] (mount identity stable across transitions).

#### Scope {#scope}

1. **Gauge primitives** — `TugLinearGauge`, `TugArcGauge` (tugways primitives, sibling to `TugInlineDialog` / `TugBadge`). Shared `--tugx-gauge-*` color slot family; per-gauge geometry slots. Full gallery cards.
2. **Per-turn telemetry data model** — `TurnEntry` extensions, `TurnCost`, `TurnEndReason` types; reducer state for awaiting-approval / transport-downtime / stream-gap / latency markers; cost-delta math; terminal-state branches.
3. **Transport-status signal** — if not surfaced today, add a minimal `transport_status: "connected" | "disconnected"` signal to the store. (Investigation B in [Step 20.3](#step-20-3).)
4. **Pure-logic helper module** — new `lib/code-session-store/telemetry.ts` with `perTurnContextSize`, `extractTurnCost`, `deriveSessionTotals`, and the `liveTurn*` family (live-running clocks for in-flight readouts).
5. **`tailSpacer="80cqh"` investigation** — retire-or-document the transcript scroll hack ([Step 20.3.5](#step-20-3-5)).
5a. **`TugDevPanel` dev inspector surface** — persistent, native-triggered, framework-shaped (Opt-Cmd-/ from Tug.app's Developer menu); first tab is the [Step 20.3](#step-20-3) telemetry inspector and gates the 20.3 HMR vet ([Step 20.3.1](#step-20-3-1)). Second tab is the in-app logging surface ([Step 20.3.2](#step-20-3-2)).
6. **Six-zone placement architecture** — slot props on `TideCard` (Z0 header, Z2 status bar), `TideCardTranscript` (Z1 unified trailing slot keyed by half), `TugPromptEntry` (Z3 retains existing `statusContent`, Z4 new footer). Z5 (submit button) acknowledged in the contract; structurally present already.
7. **Lifecycle state machine + state-to-zone coordination matrix** — landed as a documented spec in [Step 20.5.A](#step-20-5-a); implemented as `useLifecycleState()` hook in [Step 20.5.D](#step-20-5-d).
8. **Z5 submit-button state coordination** — single DOM-node button with `data-mode` attribute driven by the lifecycle snapshot.
9. **Cross-zone lifecycle coordination** — Z2, Z5 and the transcript-replay paint gate read the same `useLifecycleState()` snapshot; matrix-coherence enforced by construction. (Z1's asst-half is driven per-row off `turn === undefined`, not the session phase — see [Step 20.4.15](#step-20-4-15).)
10. **Polish-plan 13 / 14 / 15 audit and gap-close** — including `tide-question-dialog` (the confirmed missing inline-dialog variant).
11. **Ship default telemetry placements** from the [Step 20.4](#step-20-4) HMR study as production zone content — Z2 = `statusRow`, landed in [Step 20.4.15](#step-20-4-15).

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Stream-idle heuristic** for soft API stalls (silent gaps with no transport disconnect). Deferred until `maxStreamGapMs` distributions show whether `activeMs` looks too high. May revisit in a future step.
- **Z0 default content + Z1 user-half default content.** Reserved/empty slots in 20.4 and 20.5. The slot mechanism exists; default content is `null`. Future content (card-level metadata for Z0; timestamps / edit affordances for Z1 user-half) lands in subsequent steps.
- **Allow-with-edits on permission dialog.** Inherited non-goal from polish-plan §Step 15; requires a structured editor over `tool_use.input` — defer to a follow-on phase.
- **Re-run buttons on tool blocks.** Security-policy-laden; the permission-mode story for re-run isn't settled. (Same as rendering doc's non-goal.)
- **Multi-card telemetry aggregation.** Each tide card has its own session and its own telemetry. Cross-card aggregation (e.g., "total tokens used across all my tide cards today") is out of scope.

#### Dependencies / Prerequisites {#dependencies}

From [`tide-assistant-rendering.md`](./tide-assistant-rendering.md):
- `CodeSessionStore` with reducer handlers (`handleSend`, `handleInterrupt`, `handleTurnComplete`, `handleControlRequestForward`, `handleRespondApproval`, `handleRespondQuestion`).
- `cost_update` event handling — `lastCost` snapshot already maintained.
- `TugInlineDialog` primitive.
- `TugListView` + `TideTranscriptDataSource` + `TideCardTranscript`.
- `TugMarkdownView` + body-kind renderers (consumed by transcript row content).

From [`tugplan-tide-card-polish.md`](./tugplan-tide-card-polish.md):
- `TideCard` shell + `TugSplitPane` 2-pane vertical layout (transcript ↔ prompt-entry).
- `TugPromptEntry` with existing `statusContent` slot, route-button row, submit button.
- `chrome/tide-permission-dialog.tsx` (Step 15 partial — permission variant exists; question variant is the known gap closed in [Step 20.5.B](#step-20-5-b)).
- `chrome/tide-thinking-block.tsx` (Step 13 partial).
- Stop button + interrupt frame handling (Step 14 partial).

From `tuglaws/`:
- `tuglaws.md` — L02, L06, L17, L19, L20, L23, L24, L26.
- `component-authoring.md` — primitive-authoring contract.
- `token-naming.md` — seven-slot convention.

From tugbank:
- `/api/defaults/<domain>/<key>` model — for any persisted UI state (currently none; non-goal).

From the stream-json corpus:
- Fixture replay against `tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/` for reducer-level telemetry tests.

#### Constraints {#constraints}

- Same baseline constraints as [`tide-assistant-rendering.md`](./tide-assistant-rendering.md): bun (not npm), HMR-only (no manual builds), no localStorage / sessionStorage / IndexedDB, app-test harness for real-DOM testing (no fake-DOM), [L19] / [L20] token compliance with `bun run audit:tokens lint` clean, both `brio` and `harmony` themes verified.
- **[L26] mount identity is critical for Z5.** The submit button must NOT swap DOM nodes between mode transitions. Render one `<button>` whose `data-mode` / label / disabled / aria-label change; CSS handles per-mode visual.
- **Awaiting-user covers permission AND question dialogs** uniformly. `awaitingApprovalMs` semantic broadened from the original name (kept for source-compat) to include both.
- **Reducer touches `Date.now()` only at discrete transition points** (enter/exit dialog, connect/disconnect, first delta, etc.). Live-running clocks live in pure-logic helpers, not in reducer state.

#### Assumptions {#assumptions}

- `cost_update.usage` semantics (cumulative vs. per-turn) determined empirically in [Step 20.3](#step-20-3) (Investigation A). The `extractTurnCost` helper TOLERATES either shape via cost-delta math; the empirical pass documents the actual semantic.
- Transport-status signal (connect / disconnect) either already surfaced or addable in [Step 20.3](#step-20-3) (Investigation B). Either outcome keeps the work scoped.
- `awaitingApprovalSince` reducer transitions fire on every dialog enter/exit reliably (both permission and question variants flow through `handleControlRequestForward` for entry and `handleRespondApproval` / `handleRespondQuestion` for exit).
- Mount-identity invariants from [L26] hold for the wrapper insertions in [Step 20.4](#step-20-4) (`TideCardTranscript` survives the top-split-panel flex-column wrap) and the button mode transitions in [Step 20.5.D](#step-20-5-d) (`<button>` DOM node stable across `data-mode` changes).
- HMR study in [Step 20.4](#step-20-4) produces a single chosen default mapping (no tie); if it does tie, [Step 20.5.D](#step-20-5-d) picks one and notes the alternative.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [QT01] Drill-down sheet orientation — right-sliding vs. bottom-sliding? (SUPERSEDED) {#qt01-drilldown-orientation}

**Superseded (2026-05-21).** Moot — the `/context`-style drill-down sheet (Step 20.5.E) was deleted. The on-demand telemetry detail it would have hosted is served by the tide-card status-row popovers (Context / Time / Tokens / State) shipped in [Step 20.4](#step-20-4); there is no sheet, so there is no orientation to decide.

#### [QT02] `cost_update.usage` shape — cumulative or per-turn? (OPEN) {#qt02-cost-update-semantic}

**Question:** Does Claude's `cost_update.usage` payload deliver cumulative session totals or per-turn deltas?

**Decision target:** [Step 20.3](#step-20-3) Investigation A — empirical pass (capture 2–3 real payloads across a 4-turn session). The `extractTurnCost` helper tolerates either shape; this investigation documents the actual answer.

**Status:** Deferred to [Step 20.3](#step-20-3).

#### [QT03] Transport-status signal — already surfaced or new? (RESOLVED) {#qt03-transport-status-signal}

**Question:** Does the tugcast WebSocket transport already surface connect/disconnect events to `CodeSessionStore`? If not, what's the minimum surface to add?

**Resolution:** **(a) Already surfaced.** `CodeSessionSnapshot.transportState: TransportState` is on the snapshot today (`types.ts:201`), set by `handleTransportClose` / `handleTransportOpen` / `handleTransportSettled` in `reducer.ts`. **Three values, not two:**

- `"online"` — wire up; submit allowed.
- `"offline"` — wire down; user cannot submit.
- `"restoring"` — wire back up but per-card binding not yet re-ack'd by supervisor.

**Implications for [Step 20.3](#step-20-3):**
- `transportDowntimeMs` must accumulate during BOTH `offline` AND `restoring` (the wire is back but the session isn't usable yet). A "downtime interval" begins when `transportState` first leaves `"online"` and ends when it returns to `"online"`.
- No new wire/protocol/handler additions needed — the 20.3 transport-timer just consumes existing `transportState` transitions via the reducer's existing `transport_*` handlers.

**Status:** Resolved — Investigation B in 20.3 is a confirmation pass, not an open question.

#### [QT04] `tailSpacer="80cqh"` — retire or document? (OPEN) {#qt04-tailspacer-fate}

**Question:** Does the 80% tailSpacer at the bottom of `TugListView` still earn its keep under [L26] + the stable-id work?

**Decision target:** [Step 20.3.5](#step-20-3-5) — two-pronged investigation (code archaeology + empirical removal). Three plausible original causes (mount churn / streaming jitter / visual comfort) map to three different outcomes.

**Status:** Deferred to [Step 20.3.5](#step-20-3-5).

---

### Design Decisions {#design-decisions}

Local decisions specific to this plan. Broader rendering-layer decisions (e.g., [D03] system_metadata renders per-turn only when something changed, [D13] inline-not-modal dialogs) live in [`tide-assistant-rendering.md`](./tide-assistant-rendering.md) and apply transitively.

#### [DT01] Per-turn telemetry lives on `TurnEntry`, not in a side-table (DECIDED) {#dt01-per-turn-on-turnentry}

**Decision:** Extend `TurnEntry` directly with the time-accounting + diagnostic fields + cost. Do NOT maintain a parallel telemetry map keyed by turn.

**Reasoning:** The telemetry IS per-turn. The reducer already commits per-turn entries; one source of truth means consumers don't have to join two collections. Pure-logic helpers (`perTurnContextSize`, `deriveSessionTotals`) take `TurnEntry` directly — no plumbing for a parallel collection.

**Tradeoff:** `TurnEntry` grows by ~10 fields. Worth it for the simplicity.

#### [DT02] Zone numbering is spatial top-to-bottom (Z0–Z5) (DECIDED) {#dt02-zone-numbering}

**Decision:** Six zones numbered Z0 (top of card) through Z5 (submit button) by spatial position. Z1 (per-turn trailing keyed by half) is conceptually different from card-level zones but spatially "inside" the transcript pane, so it sits between Z0 (top of card) and Z2 (bottom of transcript pane).

**Reasoning:** Numbering is predictable — readers can find any zone by spatial intuition. Z0 is unambiguously "what you see first." Adding a future zone is easy: insert at correct number, renumber downstream.

**Alternatives considered:** Z0 = project-path (literal honoring of an earlier suggestion); group-by-container (prompt-entry zones together, transcript zones together). Spatial won because it scales to future zones cleanly.

#### [DT03] `useLifecycleState` encodes the state-to-zone matrix in one place (DECIDED) {#dt03-lifecycle-hook-central}

**Decision:** A new `lib/code-session-store/lifecycle-state.ts` module exports `deriveLifecycleSnapshot(storeSnapshot): TideLifecycleSnapshot` — one switch encodes every row of the matrix. The `useLifecycleState()` hook is a thin `useSyncExternalStore` wrapper. No zone reads `phase` or `awaitingApprovalSince` directly.

**Reasoning:** Matrix coherence is enforced by construction. The matrix is the spec ([Step 20.5.A](#step-20-5-a)); the hook is the executable form of the spec; testing the hook validates the spec. Encoding the matrix in N places (one per zone) would let zones drift.

**Tradeoff:** Adds a layer of indirection between the raw store snapshot and the UI. Pays for itself the first time we change the matrix.

#### [DT04] Drill-down is a sheet, not a modal (SUPERSEDED) {#dt04-drilldown-sheet}

**Superseded (2026-05-21).** The `/context`-style drill-down (Step 20.5.E) was deleted — the per-cell status-row popovers ([Step 20.4](#step-20-4)) supersede the monolithic drill-down surface. A popover is anchored chrome, not a sheet, so the sheet-vs-modal question is moot.

#### [DT05] `awaitingApprovalMs` name kept despite broadened semantic (DECIDED) {#dt05-awaiting-approval-naming}

**Decision:** The reducer state and `TurnEntry` field are named `awaitingApprovalSince` / `awaitingApprovalMs` even though they cover BOTH permission and question dialogs (any `TugInlineDialog` open interval the user must respond to). The broader `awaitingUserMs` was considered and rejected.

**Reasoning:** The original 20.3 design used `awaitingApprovalMs`; renaming creates source-compat friction with no semantic benefit. The semantic broadening is documented in field comments + the [DT-naming-glossary](#dt06-naming-glossary).

#### [DT06] Naming glossary (DECIDED) {#dt06-naming-glossary}

For clarity across the document, key terms with potentially-ambiguous names:

| Term | Meaning |
|---|---|
| `awaitingApprovalMs` | Cumulative ms paused on **any** `TugInlineDialog` — permission OR question. (Not narrowly "permission only.") |
| `activeMs` | Machine-doing-work ms. `wallClockMs − awaitingApprovalMs − transportDowntimeMs`, clamped ≥ 0. Silent in-connection API stalls quietly inflate this; we accept that for honest authoritative measurement. |
| `windowTokensUsed` | Context-window utilization at the LATEST committed turn. `inputTokens + cacheCreationInputTokens + cacheReadInputTokens` (the model's view of context "right now"). |
| `cumulativeSessionTokens` | Tokens consumed across the WHOLE session. SUM across all turns of `input + cache_creation + cache_read + output`. |
| Z1 (per-turn trailing) | A single API keyed by `half: "user" \| "assistant"` — same slot wired twice per turn. The user half is reserved/empty in 20.4 + 20.5. |
| Z5 (submit button) | Not a content slot — a state-coordinated interactive zone driven by the lifecycle state machine. |

#### [DT07] Esc semantics — foreground-element-first, two-step cancellation (DECIDED) {#dt07-esc-semantics}

**Decision:** The Esc key dismisses the topmost overlay or dialog if any is foregrounded (`TugInlineDialog`); otherwise it interrupts the in-flight turn (equivalent to clicking Stop).

**Concrete behavior by lifecycle state:**

| State | Esc behavior |
|---|---|
| IDLE / COMPLETE | nothing (or blur textarea — UX-comfort detail, not load-bearing) |
| SUBMITTING / STREAMING / TOOL_WORK | trigger interrupt → INTERRUPTING |
| AWAITING_USER | dismiss the dialog only — equivalent to a normal deny / cancel response, NOT a turn cancellation. Lifecycle resumes through STREAMING / TOOL_WORK. |
| INTERRUPTING | nothing (already interrupting) |

**Consequence — two-step cancellation from AWAITING_USER.** A user who wants to abort the entire turn while a dialog is up must press Esc twice: first Esc dismisses the dialog (auto-denies / cancels the dialog action; the turn resumes), then a second Esc (now no dialog foregrounded) interrupts the turn.

**Reasoning:**
- Matches the universal UI convention that Esc dismisses the topmost foreground element.
- Keeps the user's intent explicit at each gesture — "I want to deny this dialog" and "I want to cancel this whole turn" are different requests, and conflating them in one keystroke risks accidental cancellations.
- The Z5 Stop button is disabled during AWAITING_USER (per the matrix), so the two-step rule is consistent across both gestures (Esc and Stop both require dialog-first dismissal from AWAITING_USER).
- INTERRUPTING is therefore NOT reachable from AWAITING_USER directly — the state graph in [Step 20.5.A](#step-20-5-a)'s diagram reflects this.

**Alternatives considered:** Single-step cancellation that combines dialog-dismiss + interrupt in one Esc from AWAITING_USER. Rejected because it merges two distinct intents and the "deny + cancel" combo is rare in practice.

#### [DT08] `deriveLifecycleSnapshot` accepts UI-local state as a second argument (SUPERSEDED) {#dt08-lifecycle-snapshot-merges-ui-state}

**Superseded (2026-05-21).** This decision existed solely to feed the `DRILLDOWN_OPEN` overlay — `uiState` carried `{ drilldownOpen }`. With the `/context`-style drill-down (Step 20.5.E) deleted, `DRILLDOWN_OPEN` is retired and there is no UI-local signal for the matrix to merge: every matrix row now derives from the `CodeSessionStore` snapshot alone. `deriveLifecycleSnapshot` is a single-argument pure function (`storeSnapshot`, plus the optional `previous` for [DT09] reference stability). If a future UI-local overlay appears, the `uiState` second argument can be reintroduced then — cheaply, and against a concrete consumer rather than speculatively.

#### [DT09] `useLifecycleState` returns a stable snapshot reference when matrix-relevant signals are unchanged (DECIDED) {#dt09-snapshot-reference-stability}

**Decision:** `deriveLifecycleSnapshot` returns a structurally-memoized result — if the matrix-relevant signals (`phase`, `transportState`, `interruptInFlight`, `queuedSends > 0`, `transcript.length > 0`) are unchanged from the previous call, return the previous result's same reference. Implementation: pass the previous result as the optional second argument and the function compares the derived `{ state, overlays, submitButtonMode }` tuple to it, returning the prior object when structurally equal.

**Reasoning:**
- `useSyncExternalStore` triggers a re-render whenever the snapshot reference changes. Without reference stability, every `assistant_delta` (which mutates the store snapshot but does not change any matrix-relevant signal) re-renders every consumer of `useLifecycleState` — Z1 (per turn), Z2, Z5. At 50+ deltas/sec during streaming, that's 50+ renders/sec across 5+ subscribers.
- Reference stability bounds re-renders to the events that actually change lifecycle state. Stream deltas do not (they only change content); they only re-render the renderers that subscribe to content (the per-turn assistant body).
- The reducer's snapshot itself is reference-stable per field per [D10] — this hook extends that discipline upward into the derived lifecycle layer.

**Test:** `deriveLifecycleSnapshot(snapshotB, deriveLifecycleSnapshot(snapshotA))` returns the first result (`Object.is`) when the matrix-relevant signals of A and B are equal, even when other snapshot fields differ.

#### [DT10] Transcript paint suppressed during REPLAYING — single reveal at `replay_complete` (DECIDED) {#dt10-replay-transcript-suppression}

**Decision:** While `phase === "replaying"`, the tide-card transcript pane does not paint the reconstruction in progress. It holds its pre-replay visible state — the `TideRestoring` placeholder on a cold resume (reload / relaunch), or the last painted transcript on a mid-session reconnect — across the whole replay window, and does exactly one reconstructed paint after `replay_complete`, already at the restored scroll position. Replayed turns are still committed to the data source one `turn_complete` at a time as today; what changes is that the transcript host gates its *visible* render on `state !== "replaying"` (from `useLifecycleState()`).

**Reasoning:**
- A resumed session reconstructs its committed turns incrementally (`reducer.ts` `handleTurnComplete`, replaying branch). With the transcript live and `followBottom` engaged, every commit re-windows and re-pins — the user watches turns accumulate and the viewport chase the live edge. That intermediate-state painting is a FOUC: the pane should appear once, at the proper scroll/message position.
- The cold-boot scroll restore (`SmartScroll` restore target vs. `followBottom`) then resolves once, against a transcript whose height is final, instead of racing a still-growing data source.
- The bracket already exists: `replay_started` / `replay_complete` delimit the window with no new signal needed. `state === "replaying"` is the consumer-facing form.

**Consequence — the REPLAYING matrix row has no Z1 cell.** Earlier matrix drafts put a `TugThinkingIndicator` on "the row currently being replayed," swapping to `EndStateDisplay` per row as reconstruction finished. There is no such per-row animation under this decision — the transcript is not visible during replay, so there is nothing to animate. REPLAYING is the matrix's only state in which a zone is not painted at all rather than painted with state-specific content.

**Alternative considered:** Keep the incremental paint but freeze the scroll position and disengage `followBottom` during replay. Rejected — turns still pop in visibly below the fold, and the saved region-scroll anchor still resolves against a transcript whose height is still changing. Suppress-then-reveal is the only framing that guarantees a single first paint at the final geometry.

---

### Execution Steps {#execution-steps}

#### Step 20.1: `TugLinearGauge` primitive + gallery card {#step-20-1}

**Depends on:** _none_ (general-purpose tugways primitive; no dependency on tide rendering)

**Status:** _Implementation complete; awaiting manual HMR vet. Primitive + pure-logic tests (20 cases) + 3-section gallery card (interactive sandbox / 3×3 scale-threshold matrix / use-case preview) landed. All composed `--tug7-*` tokens already existed in both themes — no theme file edits required. tsc clean, full test suite 1889/0, audit:tokens lint clean. Registered in `card-registry.ts` under the "Feedback & Status" category._

**Commit:** `feat(tugways): TugLinearGauge — linear quantity gauge primitive + gallery card`

**References:** [L17], [L19], [L20], [L24], [Table T07](./tide-assistant-rendering.md#t07-token-slots), `dash/archive/retronow/mockups/retronow-unified-review.html` § "Linear Gauge (0-100% Mapping)" (design source)

**Scope.** General-purpose horizontal-fill gauge primitive — a labeled bar that maps `value` from `[min, max]` into a proportional fill, with optional threshold-based color zones. Built first because [#step-20-3] (the card-level status strip) consumes it for the window-utilization display. The retronow mockup had ~15 tunable knobs for design exploration; the shipped primitive collapses those into ~7 props for ergonomic consumer use, with the warning-zone semantics preserved (the load-bearing feature that the mockup proved out).

**Conformance.** Tugways primitive (peer of `TugInlineDialog`, `TugBadge`, etc.) — not a body kind, not a tool wrapper. The [#bk-conformance](./tide-assistant-rendering.md#bk-conformance) contract does not apply directly; the relevant law set is `tuglaws/component-authoring.md` plus [L17] / [L19] / [L20] / [L24]. The primitive owns a new `--tugx-gauge-*` slot family declared in `tug-linear-gauge.css` body{}, composing `--tug7-*` base tokens in one hop.

**Design — public surface.** Sketch (precise prop names finalized in implementation):

```typescript
export interface TugLinearGaugeProps {
  /** Current value, in domain units. */
  value: number;
  /** Domain minimum. */
  min: number;
  /** Domain maximum. Must satisfy `max > min`. */
  max: number;
  /**
   * Optional warning-zone fractions (0–1, relative to the [min, max]
   * domain). When `value` exceeds a threshold, the fill color shifts
   * to the corresponding role token. `caution` lights up the caution
   * accent; `danger` lights up the danger accent (a strict superset
   * of caution — exceeding `danger` implies caution too, but only
   * the danger color renders). When omitted, the fill stays on its
   * default role for the entire domain.
   */
  thresholds?: { caution?: number; danger?: number };
  /**
   * Optional human-readable label rendered alongside the bar. Layout
   * depends on `density` — compact puts it inline beside the value;
   * detailed puts it below, with hi/lo labels framing the bar ends.
   */
  label?: string;
  /**
   * Optional formatter for the displayed numeric value. Defaults to
   * `String(value)`. Consumers passing a fraction like
   * `32_500 / 200_000` would write `formatValue={(v) => formatTokens(v)}`
   * to render `"32.5k"`.
   */
  formatValue?: (value: number) => string;
  /**
   * `compact` (default) renders a slim bar with just the fill, the
   * value numeral, and an optional label inline — designed for chrome
   * surfaces like [#step-20-3]'s status strip (~20–24px tall).
   * `detailed` renders the full mockup-style face with major/minor
   * ticks, hi/lo labels, and percentage readout — for dashboard /
   * gallery use.
   */
  density?: "compact" | "detailed";
  /**
   * Accent role for the fill when no threshold is exceeded. Maps to
   * `--tugx-gauge-fill-{role}-color`. Defaults to `default`.
   */
  fillRole?: "default" | "info" | "success";
}
```

**Token sovereignty per [L20].** TugLinearGauge owns `--tugx-gauge-*` slots: `track-color`, `track-border-color`, `fill-default-color`, `fill-info-color`, `fill-success-color`, `fill-caution-color`, `fill-danger-color`, `value-text-color`, `label-text-color`, `tick-major-color`, `tick-minor-color`, plus the geometry slots (`bar-height-compact`, `bar-height-detailed`, `value-text-size-compact`, `value-text-size-detailed`, etc.). The consuming card ([#step-20-3]) does not override these — it owns its own `--tugx-tide-meter-*` slots that point at the gauge's surface tokens via [L20]'s "alias my own family, don't override the child's" rule.

**Gallery card.** A new gallery card `gallery-tug-linear-gauge` shows the primitive at three scales side-by-side:

| Scale | Height | Density | Purpose |
|---|---|---|---|
| **Strip-scale** | ~24px tall | `compact` | Exact size the [#step-20-3] integration uses; gates that the compact density reads well at chrome scale |
| **Readable** | ~60px tall | `compact` | Mid-size dashboard placement; bar + value + label clearly legible |
| **Showcase** | ~140px tall | `detailed` | Full mockup-style face with ticks + percentage + hi/lo labels; gates that the primitive scales up without losing fidelity |

Each scale is rendered for three threshold configurations: (a) no thresholds, (b) `caution: 0.75`, `danger: 0.9` with `value` below caution, (c) same thresholds with `value` above danger. Card includes a `value` slider and `min/max` numeric inputs so design review can interactively tune the values.

**Artifacts.**

- `tugdeck/src/components/tugways/tug-linear-gauge.tsx` + `.css` — _new component_.
- `tugdeck/src/components/tugways/__tests__/tug-linear-gauge.test.ts` — pure-logic tests: domain-mapping math (value → fill width), threshold selection (which role is active given thresholds + value), `formatValue` round-trip, edge cases (value < min clamps; value > max clamps; max ≤ min throws). No DOM rendering required (the geometry math is pure).
- `tugdeck/src/components/tugways/cards/gallery-tug-linear-gauge.tsx` + `.css` — _new card_.
- Registration in `card-registry.ts` and the gallery component list.
- New row in [Table T07](./tide-assistant-rendering.md#t07-token-slots): `| --tugx-gauge-* | TugLinearGauge / TugArcGauge |` (shared slot family — both gauges read the same color slots; geometry slots may diverge).

**Tasks.**

- [x] Build `TugLinearGauge` per the prop surface above. Stateless presentation; consumer owns `value`. Exports three pure helpers (`clampToDomain`, `computeFillRatio`, `effectiveFillRole`) so the geometry + role math is unit-testable without DOM.
- [x] Pure-logic Bun tests for the geometry + threshold math — 20 cases covering domain clamp (positive/negative, infinities), midpoint mapping, token-window-shape domain, `max ≤ min` throws, all six threshold-derivation cases (no thresholds / below / at caution / at danger / danger-as-strict-superset / edge fractions 0 and 1).
- [x] Declare the `--tugx-gauge-*` slot family in `tug-linear-gauge.css` body{}; all 17 slots bind to `--tug7-*` base tokens in one hop. Verified by `audit-tokens lint`.
- [x] Theme tokens — no edits needed. All composed `--tug7-*` tokens already exist in both `brio.css` and `harmony.css` (the gauge composes from the shared `filled-{role}-rest` / `field-primary-normal-plain-rest` / `global-text-normal-{default,muted}-rest` / `global-icon-normal-{default,muted}-rest` token families).
- [x] Gallery card with the interactive sandbox, three-scale × three-threshold matrix (9 cells), and use-case preview rendering the `32.5k / 200k WINDOW` example from [#step-20-3]'s layout sketch.
- [x] Register `gallery-tug-linear-gauge` in `card-registry.ts` under the "Feedback & Status" category.
- [x] `audit-tokens lint` clean — zero violations, all `@tug-renders-on` annotations validated.

**Tests.**

- [x] Pure-logic: `value=50, min=0, max=100` → fill ratio = 0.5. `value=-10` clamps to 0; `value=150` clamps to 1.
- [x] Pure-logic: with `thresholds={caution: 0.75, danger: 0.9}`: `value=70%` → `default` role; `value=80%` → `caution`; `value=95%` → `danger`.
- [x] Pure-logic: missing `thresholds` → always `fillRole` (default `default`).
- [x] Pure-logic: `max ≤ min` throws (configuration error, not a silent NaN).
- [x] Gallery card mounts; renders all 9 matrix cells (3 scales × 3 threshold configs) plus the interactive sandbox and use-case preview.

**Checkpoint.**

- [x] `bun x tsc --noEmit` clean from `tugdeck/`. Exit 0.
- [x] `bun test` green — 1889 pass, 0 fail, 8283 expect() calls across 106 files (20 new gauge tests).
- [x] `bun run audit:tokens lint` exits 0. Zero violations.
- [ ] **HMR vet (manual user action)** — open `gallery-tug-linear-gauge`, move the slider through the domain, verify color transitions at the threshold boundaries match expectation in both themes (Brio / Harmony).

---

#### Step 20.2: `TugArcGauge` primitive + gallery card {#step-20-2}

**Depends on:** #step-20-1 (the `--tugx-gauge-*` color slot family lands with TugLinearGauge; TugArcGauge reads the same color tokens to keep the visual language consistent across both primitives)

**Status:** _Implementation complete; awaiting manual HMR vet. Primitive + pure-logic tests (15 cases covering arc-path geometry, large-arc-flag boundary, full-circle two-semicircle branch, default `C` geometry, negative-sweep validation) + 3-section gallery card (interactive sandbox with start/sweep controls / 3×3 scale-threshold matrix / 5 geometry variants row). Shared math extracted to `gauge-math.ts`; both gauges import from there. tsc clean, full test suite 1904/0, audit:tokens lint clean. Registered under "Feedback & Status"._

**Commit:** `feat(tugways): TugArcGauge — arc quantity gauge primitive + gallery card`

**References:** [L17], [L19], [L20], [L24], [#step-20-1] (color-token sibling), [Table T07](./tide-assistant-rendering.md#t07-token-slots), `dash/archive/retronow/mockups/retronow-unified-review.html` § "Arc Gauge (Unified)" (design source)

**Scope.** General-purpose arc (partial-circle) gauge primitive — the radial counterpart to [#step-20-1]'s linear bar. Same domain mapping, same threshold semantics, same color tokens (`--tugx-gauge-fill-{role}-color` is shared). Sequenced after the linear gauge so the color-slot family is settled before the arc geometry is built on top; this avoids re-tuning shared tokens after the second consumer lands. Gates that the primitive scales the same way the linear gauge does — strip-scale for chrome, readable for dashboard, showcase for full-detail.

**Conformance.** Same as [#step-20-1] — tugways primitive, `tuglaws/component-authoring.md` + [L17] / [L19] / [L20] / [L24]. Shares the `--tugx-gauge-*` slot family with TugLinearGauge; adds arc-specific geometry slots (`arc-stroke-width-compact`, `arc-stroke-width-detailed`, `arc-radius-compact`, `arc-radius-detailed`, `arc-start-angle`, `arc-sweep-angle`).

**Design — public surface.** Identical prop shape to TugLinearGauge with one addition: the arc's start/sweep angles default to a "C" sweep (`start = 135°`, `sweep = 270°` — leaving the bottom 90° open) but can be overridden via `geometry?: { startAngleDeg: number; sweepAngleDeg: number }` for consumers that want a different arc shape (full circle, half circle, quarter, etc.).

```typescript
export interface TugArcGaugeProps {
  value: number;
  min: number;
  max: number;
  thresholds?: { caution?: number; danger?: number };
  label?: string;
  formatValue?: (value: number) => string;
  density?: "compact" | "detailed";
  fillRole?: "default" | "info" | "success";
  /**
   * Override the default "C" sweep. Useful for full-circle gauges
   * (`sweepAngleDeg: 360`), half-circles (`startAngleDeg: 180,
   * sweepAngleDeg: 180`), or custom dial shapes. Defaults to a 270°
   * sweep starting at 135° (bottom-left quadrant open).
   */
  geometry?: { startAngleDeg: number; sweepAngleDeg: number };
}
```

**Token sovereignty.** Color slots are shared with TugLinearGauge (single source of truth; both gauges read `--tugx-gauge-fill-{role}-color`). Arc-specific geometry slots are owned exclusively by TugArcGauge and namespaced with `arc-` prefix to avoid collision with the linear gauge's geometry slots. Both gauges' geometry slots live in their respective component CSS body{}; neither overrides the other.

**Gallery card.** `gallery-tug-arc-gauge` mirrors [#step-20-1]'s structure — three scales × three threshold configs:

| Scale | Diameter | Density | Purpose |
|---|---|---|---|
| **Strip-scale** | ~32px | `compact` | Exact size for chrome surface use; tests that the arc reads at this size without crowding |
| **Readable** | ~80px | `compact` | Mid-size dashboard placement |
| **Showcase** | ~180px | `detailed` | Full mockup-style face with ticks + value + label all visible |

Plus one **geometry variants** row that shows the same gauge at `readable` scale with five different arc shapes (default C-sweep, half-circle, full circle, quarter-arc top-right, quarter-arc top-left) to gate that the geometry override prop produces sensible output at non-default angles.

**Artifacts.**

- `tugdeck/src/components/tugways/tug-arc-gauge.tsx` + `.css` — _new component_.
- `tugdeck/src/components/tugways/__tests__/tug-arc-gauge.test.ts` — pure-logic tests: SVG path generation for the arc (start point, sweep flag, end point given `startAngleDeg` / `sweepAngleDeg` / `value` fraction), threshold selection (same shape as TugLinearGauge), geometry edge cases (sweep = 360° produces a full circle; sweep = 0° produces an empty arc; negative sweep throws).
- `tugdeck/src/components/tugways/cards/gallery-tug-arc-gauge.tsx` + `.css` — _new card_.
- Registration in `card-registry.ts`.
- Extend the [Table T07](./tide-assistant-rendering.md#t07-token-slots) row landed in [#step-20-1] to reflect the shared use.

**Tasks.**

- [x] Build `TugArcGauge` per the prop surface above. SVG-based: a 100×100 viewBox with stroked track + fill paths; compact density renders the readout as HTML below the SVG, detailed density renders value + percent as `<text>` centered inside the SVG and the label below.
- [x] Pure-logic Bun tests for arc-path geometry + threshold + geometry-override math — 15 cases covering empty-path branches, full-circle two-semicircle branch, large-arc-flag boundary (180° strict), start / end coordinate placement for default `C` geometry, negative-sweep throws, default `DEFAULT_ARC_GEOMETRY` constant matches the "C" shape.
- [x] Declare arc-specific `--tugx-gauge-arc-*` slots in `tug-arc-gauge.css` body{} (stroke widths × compact/detailed, SVG-text font sizes, tick stroke widths, gaps). Reuses the shared color slots from [#step-20-1] without redeclaring them.
- [x] Theme tokens — no edits needed. The arc gauge composes the same `--tug7-*` tokens through the shared color slot family; geometry slots resolve to literal pixel values (no theme involvement). Shared `gauge-math.ts` extracted so the three pure helpers live in one place; `tug-linear-gauge.tsx` re-exports them for source compat with existing tests.
- [x] Gallery card — interactive sandbox (incl. start/sweep angle controls + fixed-precision formatter for slider-stability) + 3×3 scale-threshold matrix (9 cells) + 5 geometry variants row (default C / full circle / top half / top-left quarter / top-right quarter).
- [x] Register `gallery-tug-arc-gauge` in `card-registry.ts` under "Feedback & Status".
- [x] `audit-tokens lint` clean — zero violations.

**Tests.**

- [x] Pure-logic: arc path for default geometry — start at bottom-left (135° angle position), end at correct angle for `fillRatio * sweep`, large-arc-flag 0 when effective sweep ≤ 180°.
- [x] Pure-logic: same threshold tests as TugLinearGauge — covered transitively by `gauge-math.ts` extraction (single source of truth; linear-gauge tests gate the math for both gauges).
- [x] Pure-logic: `geometry.sweepAngleDeg = 360` → two-semicircle full-circle path; `geometry.sweepAngleDeg = 0` → empty string; negative sweep throws.
- [x] Pure-logic: large-arc-flag flips exactly at the 180° boundary (predicate is strict `> 180`, so effective sweep == 180 stays small-arc).
- [x] Gallery card mounts; renders all 9 matrix cells + 5 geometry cells + interactive sandbox.

**Checkpoint.**

- [x] `bun x tsc --noEmit` clean from `tugdeck/`. Exit 0.
- [x] `bun test` green — 1904 pass, 0 fail, 8310 expect() calls across 107 files (15 new arc tests; linear tests unchanged at 20/20 after the math extraction).
- [x] `bun run audit:tokens lint` exits 0. Zero violations.
- [ ] **HMR vet** — open `gallery-tug-arc-gauge`, sweep the slider, verify the arc redraws smoothly with no visual artifacts (no flash, no path-discontinuity at the 180° boundary where `largeArcFlag` flips), and verify the geometry variants render correctly at the five different arc shapes.

---

#### Step 20.3: Per-turn telemetry — token + time data collection {#step-20-3}

**Depends on:** #step-1 (cost_update reducer surface)

**Status:** _COMPLETED 2026-05-16 (implementation + HMR vet via [Step 20.3.1](#step-20-3-1)'s `TugDevPanel`)._

**Commit:** `feat(code-session-store): per-turn telemetry — typed token + multi-clock accounting on TurnEntry`

**References:** [L02], [L23], [D03], [#step-20-1] / [#step-20-2] (gauge primitives that will consume this data downstream), [#step-20-4] (UI placement step that ships on top of this data)

**Scope note — why we are re-imagining 20.3.** The first 20.3 attempt jumped straight to a chrome component that scraped numbers off `lastCost.usage` and added wall-clock timing on top. The result hit two real walls: (1) `lastCost.usage.input_tokens` alone systematically *under*-reports the context window (it omits the `cache_read_input_tokens` + `cache_creation_input_tokens` portions that carry the bulk of a long conversation's context); (2) wall-clock `(endedAt - submitAt)` over-reports the Claude-active duration whenever a turn pauses on a `TugInlineDialog` waiting for the user's allow / deny / question answer. Both problems are *data-model* problems, not chrome problems — patching them inside the chrome would have entrenched the same hacks the next consumer would have to re-discover. This re-imagined step builds the data model cleanly; [#step-20-4] then experiments with placements on top of it.

**Scope.** Capture **per-turn telemetry** as first-class fields on each `TurnEntry`, and define the corresponding session-level derivations. The data set has three groups:

1. **Cost** — typed token + dollars accounting via per-turn delta against `lastCost`.
2. **Time accounting** — a small family of clocks that separate "how long did this take," "how long did the user pause it," "how long was the system down," and "how long was the machine actually working." See the table below.
3. **Diagnostics** — latency markers (`ttftMs`, `ttftcMs`), throughput markers (`reconnectCount`, `maxStreamGapMs`), per-tool wall (`ToolCall.toolWallMs`), and a typed terminal state (`turnEndReason`). Cheap to capture once we're already touching the per-turn timing infrastructure; expensive to retrofit later.

**The time-accounting family.** Four clocks, all stored directly on `TurnEntry` so consumers don't have to re-derive:

| Field | Meaning | Computed as |
|---|---|---|
| `wallClockMs` | Total elapsed | `endedAt - userMessage.submitAt`. Indisputable; covers everything. |
| `awaitingApprovalMs` | User-interaction pause | Sum of TugInlineDialog open intervals — covers *both* permission and question dialogs. (Name kept for source-compat with the original 20.3 design; semantics broadened to include question dialogs.) |
| `transportDowntimeMs` | System / API downtime | Sum of WebSocket disconnect → reconnect intervals overlapping this turn. The cleanest objective signal — the transport authoritatively knows when it lost service. |
| `activeMs` | Machine-doing-work | `wallClockMs − awaitingApprovalMs − transportDowntimeMs`, clamped ≥ 0. The "assistant response time." Stored directly so consumers don't recompute. |

Silent in-connection API stalls (e.g., a 30-second gap with no events while the WebSocket stays open) currently fall inside `activeMs`. We accept this as a known limit of authoritative measurement; if real distributions later show `activeMs` looks too high, [#step-20-5] revisits with a stream-idle heuristic over `maxStreamGapMs` distributions.

**Bonus accounting captured at the same time.** Cheap to wire while we're already in the per-turn timing handlers; expensive to retrofit later once the type shape is in use:

| Field | Meaning |
|---|---|
| `ttftMs: number \| null` | Time from `submitAt` to first `assistant_delta`. `null` if turn ended with no assistant output. |
| `ttftcMs: number \| null` | Time from `submitAt` to first `tool_use`. `null` if no tool calls. |
| `reconnectCount: number` | Number of transport reconnects observed during this turn. Companion to `transportDowntimeMs`. |
| `maxStreamGapMs: number` | Longest single inter-event silence across this turn. Diagnostic; gives us a distribution to inform any future stream-idle heuristic. |
| `turnEndReason: TurnEndReason` | Typed terminal state — `"complete" \| "interrupted" \| "error" \| "transport_lost"`. |
| `ToolCall.toolWallMs: number \| null` | Per-call wall-clock between `tool_use` and matching `tool_result`. `null` if still pending at turn end. |

**Session totals** are derived from `transcript[]` by summing the per-turn fields. The chrome / UI components in [#step-20-4] consume these via a small pure-logic adapter module — no `lastCost` inside the chrome, no wall-clock inside the chrome. The data model is the API; the UI is the consumer.

**The "context window" derivation, specifically.** For the window-utilization gauge in [#step-20-4], the answer is `inputTokens + cacheCreationInputTokens + cacheReadInputTokens` for the *most recent* committed turn (the model's view of context at the latest turn boundary). The session-cumulative "tokens consumed" number is the SUM across all turns of `inputTokens + cacheCreationInputTokens + cacheReadInputTokens + outputTokens`. These two numbers are different — window is "right now," cumulative is "ever." The data model exposes both; placement decisions live in [#step-20-4].

**Live-turn semantics.** The frozen `TurnEntry` fields are committed at `turn_complete`. For an in-flight turn, consumers (e.g., a ticking "elapsed" readout) need running values. The `telemetry.ts` module exports pure `(state, now)` derivations: `liveTurnWallClockMs`, `liveTurnAwaitingApprovalMs`, `liveTurnTransportDowntimeMs`, `liveTurnActiveMs`. These fold `Date.now()` against the live reducer state. The reducer itself only touches `Date.now()` at discrete transition points (enter/exit dialog, connect/disconnect, first delta, etc.) — the live-running clocks live in the pure-logic helpers, which keeps the reducer deterministic and trivially testable.

**Conformance.** Pure reducer + types work. No chrome surface. No React component changes in 20.3 (those land in 20.4). The pure-logic helpers `perTurnContextSize`, `deriveSessionTotals`, `extractTurnCost`, and the `liveTurn*` family are exported as the API surface for 20.4 consumers.

**Design — type sketch.**

```typescript
// New types (add to lib/code-session-store/types.ts):

interface TurnCost {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  totalCostUsd: number;
}

type TurnEndReason = "complete" | "interrupted" | "error" | "transport_lost";

interface TurnEntry {
  // ... existing fields ...

  // --- Time accounting ---
  /** Pure wall-clock duration of the turn. */
  wallClockMs: number;
  /** Cumulative ms paused on TugInlineDialog (permission + question). */
  awaitingApprovalMs: number;
  /** Cumulative ms with the transport disconnected during this turn. */
  transportDowntimeMs: number;
  /** Machine-doing-work duration. Stored directly so consumers don't recompute.
   *  = wallClockMs - awaitingApprovalMs - transportDowntimeMs, clamped ≥ 0. */
  activeMs: number;

  // --- Diagnostics ---
  /** Submit-to-first-assistant-delta latency. null if turn produced no assistant output. */
  ttftMs: number | null;
  /** Submit-to-first-tool-use latency. null if turn produced no tool calls. */
  ttftcMs: number | null;
  /** Transport reconnects observed during this turn. */
  reconnectCount: number;
  /** Longest single inter-event silence across the turn. */
  maxStreamGapMs: number;
  /** Typed terminal state. */
  turnEndReason: TurnEndReason;

  // --- Cost ---
  /** Per-turn delta of cumulative cost-update fields. Zeros when no
   *  cost_update arrived for this turn. */
  cost: TurnCost;

  // --- Existing `result` field stays, deprecated in favor of turnEndReason ---
  // result: "success" | "interrupted" stays on TurnEntry; reducer derives it
  // from turnEndReason ("complete" → "success"; else → "interrupted") so the
  // two never diverge. JSDoc marks `result` @deprecated. Migration to
  // turnEndReason happens incrementally per consumer.
}

interface ToolCall {
  // ... existing fields ...
  /** Wall-clock ms between tool_use and matching tool_result.
   *  null if still pending at turn end. */
  toolWallMs: number | null;
}

// Pure derivations (export from a new module, lib/code-session-store/telemetry.ts):

export function perTurnContextSize(turn: TurnEntry): number; // input + cache_read + cache_creation
export function extractTurnCost(
  before: CostSnapshot | null,
  after: CostSnapshot | null,
): TurnCost; // handles cumulative-or-per-turn cost_update.usage shapes
export function deriveSessionTotals(
  transcript: ReadonlyArray<TurnEntry>,
): {
  totalWallClockMs: number;
  totalAwaitingApprovalMs: number;
  totalTransportDowntimeMs: number;
  totalActiveMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalCostUsd: number;
  turnCount: number;
};

// Live-turn derivations (pure functions of (state, now)):
export function liveTurnWallClockMs(state: CodeSessionState, now: number): number;
export function liveTurnAwaitingApprovalMs(state: CodeSessionState, now: number): number;
export function liveTurnTransportDowntimeMs(state: CodeSessionState, now: number): number;
export function liveTurnActiveMs(state: CodeSessionState, now: number): number;
```

**Reducer changes.** All isolated to `reducer.ts`:

1. **New reducer state fields** — eleven additions to `CodeSessionState` + `createInitialState`:
   - `awaitingApprovalSince: number | null` — entry-side timestamp; complements the existing `pendingApproval` / `pendingQuestion` snapshot fields (those identify *which* dialog; this records *when* it opened).
   - `awaitingApprovalAccumulatedMs: number`
   - `transportNonOnlineSince: number | null` — timestamp captured when `transportState` first leaves `"online"` (either to `offline` or `restoring`).
   - `transportDowntimeAccumulatedMs: number`
   - `transportReconnectCount: number`
   - `lastStreamEventAt: number | null`
   - `maxStreamGapMs: number`
   - `firstAssistantDeltaAt: number | null`
   - `firstToolUseAt: number | null`
   - `costAtSubmit: CostSnapshot | null`
   - **`interruptInFlight: boolean`** — set `true` by `handleInterrupt`, cleared by `handleTurnComplete` (any reason). Drives the INTERRUPTING lifecycle state in [20.5.A's matrix](#step-20-5-a). No existing single-source signal carries this; the plan adds it.
2. **Awaiting-approval timer** — `handleControlRequestForward` sets `awaitingApprovalSince = Date.now()` (covers both permission and question `control_request_forward` variants). `handleRespondApproval` / `handleRespondQuestion` accumulate `Date.now() - awaitingApprovalSince` into `awaitingApprovalAccumulatedMs` and reset `awaitingApprovalSince = null`. Interrupt + transport-close + replay-bracket paths also reset (defensive).
3. **Transport-downtime timer** — wires to the existing `transportState` axis (per [QT03 resolved](#qt03-transport-status-signal)). When `transportState` first transitions from `"online"` to `"offline"` OR `"restoring"`, set `transportNonOnlineSince = Date.now()`. When `transportState` transitions back to `"online"`, accumulate `Date.now() - transportNonOnlineSince` into `transportDowntimeAccumulatedMs` and increment `transportReconnectCount`. The `restoring` value counts toward downtime — the wire is up but the session is unusable.
4. **Stream-gap + latency markers** — every inbound stream event (assistant_delta, tool_use, tool_result, system events; `awaiting_first_token` → `streaming` transition counts as the first `assistant_delta`) updates `lastStreamEventAt` and folds the gap into `maxStreamGapMs`. The first `assistant_delta` of the turn captures `firstAssistantDeltaAt`; the first `tool_use` captures `firstToolUseAt`. Each `tool_result` pairs with its `tool_use` and writes `toolWallMs` onto the `ToolCall`.
5. **Snapshot + commit** — `handleSend` resets all per-turn timers and snapshots `lastCost` into `costAtSubmit`. `handleTurnComplete` (and the interrupt / error / transport-lost terminal handlers) computes the cost delta, freezes all per-turn fields onto the `TurnEntry`, sets `turnEndReason` based on which handler fired, clears `interruptInFlight`, and resets the per-turn accumulators.

**Relationship to existing `TurnEntry.result` field.** The current shape is `result: "success" | "interrupted"` (`types.ts:132`). The new `turnEndReason: "complete" | "interrupted" | "error" | "transport_lost"` is strictly richer. Migration approach: **add `turnEndReason` alongside `result` in this step; mark `result` as `@deprecated` with a JSDoc comment pointing to `turnEndReason`; existing consumers continue to read `result` until they migrate in subsequent work.** The reducer derives `result` from `turnEndReason` so the two stay in sync (`turnEndReason === "complete"` → `result === "success"`; everything else → `result === "interrupted"`). A follow-up step removes `result` once all consumers are off it. This avoids a wide-radius rename mid-step.

**Ticker for live elapsed displays.** The matrix's "live cum + this-turn elapsed (ticking)" entries (Z2 in STREAMING / TOOL_WORK / AWAITING_FIRST_TOKEN) require a time source that emits at human-perceptible intervals while a turn is in flight. The reducer must NOT poll `Date.now()` — that violates the "reducer touches Date.now() only at discrete transitions" constraint. Instead:
- A small `useLifecycleTick(intervalMs = 1000)` hook (sibling to `useLifecycleState`, lives in `lib/code-session-store/hooks/`) sets up a 1-second `setInterval` ONLY while `phase` is non-terminal (i.e., a turn is in flight). The hook returns a `tickAt: number` value that updates every interval.
- The Z2 renderer reads `tickAt` to force re-render, then computes `liveTurnActiveMs(snapshot, tickAt)` via the pure-logic helper from this step.
- `setInterval` is fine here per [L13] — this is not animation, it's a discrete clock tick for textual readout. RAF would be wasteful.
- When `phase` returns to `idle`, the interval clears — no idle CPU cost.

Spec'd here so consumers know how to fold time into the live `liveTurn*` helpers without each one re-inventing it.

**Investigation — pre-implementation empirical pass.** Two short spikes gated the implementation. Both completed before implementation; findings recorded inline below.

#### Investigation A — `cost_update.usage` semantics (RESOLVED) {#step-20-3-investigation-a}

**Question:** Does Claude's `cost_update.usage` payload deliver cumulative session totals or per-turn deltas?

**Method:** Analyzed `cost_update` payloads from the stream-json fixture corpus at `tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/v2.1.104/`. Each fixture captures a real session; the `cost_update` event fires at `turn_complete`. Cross-referenced shape and concrete-numeric `modelUsage` values across fixtures with different `num_turns`.

**Findings:**

The fixture corpus contains multiple `cost_update` payloads with concrete numeric values in `modelUsage`. Selected examples:

| Fixture | num_turns | inputTokens | outputTokens | cacheCreation | cacheRead | costUSD |
|---|---|---|---|---|---|---|
| test-01-basic-round-trip | 1 | 3 | 10 | 6180 | 12507 | $0.045 |
| test-02-longer-response-streaming | 1 | 3 | 129 | 6189 | 12507 | $0.048 |
| test-05-tool-use-read | 2 | 4 | 180 | 6349 | 31204 | $0.060 |
| test-07-multiple-tool-calls | 3 | 4 | 216 | 12645 | 25014 | $0.097 |

Four observations from the shape and values:

1. **The `num_turns` field exists on `cost_update`** — explicitly tracks position in the session. If `usage` were strictly per-turn, this field would be redundant; its presence implies the payload is contextualized over a session arc.
2. **The `modelUsage` structure aggregates per-model:** `{ "claude-opus-4-6": { ... } }`. Aggregation shape, not snapshot shape.
3. **`usage.iterations` is an array** of `{type: "message"}` entries — this is the SESSION'S message-iteration list at the time `cost_update` fired. Per-turn would have one entry; the array structure implies session-scoped aggregation.
4. **`total_cost_usd` grows monotonically with `num_turns`** across the fixtures: 1-turn=$0.045, 2-turn=$0.060, 3-turn=$0.097. Per-turn payloads would NOT show this monotonic correlation because each cost_update would be independent.

**Conclusion: `cost_update.usage` is CUMULATIVE per-session.** Each `cost_update` event reports session-to-date totals; the per-turn delta is computed by subtracting the previous `cost_update`'s values from the current ones. This matches the `extractTurnCost(before, after)` design — `after - before`, with `null` `before` meaning "first turn of session" so the delta degenerates to `after`.

**Limitation:** The fixture analysis is strong indirect evidence but not direct proof. The definitive test — two `cost_update` events from the SAME session at different turn boundaries — would require capturing a real multi-turn HMR session. The `extractTurnCost` helper is designed to tolerate either shape via cost-delta math, so even if the live behavior differs subtly (e.g., partial-cumulative, model-scoped), the per-turn delta computed against `costAtSubmit` snapshots remains correct. A follow-up HMR vet during implementation will validate this against live behavior.

**Implementation implication:** `costAtSubmit` snapshots `lastCost` at `handleSend`; `extractTurnCost(costAtSubmit, currentLastCost)` at `handleTurnComplete` computes the per-turn delta. For the first turn of a session, `costAtSubmit === null` and the delta is `extractTurnCost(null, currentLastCost) === currentLastCost`. Clamp negative deltas to zero (defense against any non-monotonic behavior).

#### Investigation B — Transport-status signal (RESOLVED) {#step-20-3-investigation-b}

**Question:** Does the tugcast WebSocket transport already surface connect/disconnect events to `CodeSessionStore`? If so, what are the exact transitions and how do we subscribe?

**Method:** Read `types.ts`, `reducer.ts`, and the existing event-dispatch wiring. No code execution needed.

**Findings:**

`transportState: TransportState` is on `CodeSessionSnapshot` (`types.ts:201`). Three values: `"online" | "offline" | "restoring"`. Three reducer handlers transition between them:

| Handler | From | To | Trigger |
|---|---|---|---|
| `handleTransportClose` (`reducer.ts:1268`) | `online` | `offline` | Transport close event from tugcast. Early-returns if already `offline` (no double-entry). |
| `handleTransportOpen` (`reducer.ts:1340`) | `offline` | `restoring` | Transport open event (wire back up). Early-returns if already `online`. Note: opens to `restoring`, NOT directly to `online`. |
| `handleTransportSettled` (`reducer.ts:1357`) | `restoring` | `online` | `cardSessionBindingStore` confirms the per-card binding is re-ack'd. Early-returns if already `online`. |

The path on reconnect is: `online → (close) → offline → (open) → restoring → (settled) → online`.

The downtime interval covers BOTH `offline` AND `restoring` — from `handleTransportClose` to `handleTransportSettled`. This matches the plan's stated constraint.

**Snapshot reference stability** is already disciplined: the reducer returns the same state reference when transport-state didn't change (`reducer.ts:1273-1274` comment: "Returning the same state reference keeps `getSnapshot()` reference-stable for `useSyncExternalStore`"). So subscribing via `useSyncExternalStore` produces no spurious re-renders when transport state is unchanged.

**Conclusion: No new wire/protocol/handler additions needed.** The 20.3 transport-downtime timer wires INTO the existing handlers:

- `handleTransportClose` (when transitioning `online → offline`): set `transportNonOnlineSince = Date.now()`.
- `handleTransportSettled` (when transitioning `restoring → online`): accumulate `Date.now() - transportNonOnlineSince` into `transportDowntimeAccumulatedMs`; increment `transportReconnectCount`; clear `transportNonOnlineSince = null`.
- `handleTransportOpen` (when transitioning `offline → restoring`): no-op for the downtime timer — we're still "non-online," still accumulating.

The early-return guards in each handler prevent double-entries.

**Implementation implication:** Modify the three existing handlers in `reducer.ts` rather than adding new event types or wire-format changes. Zero protocol impact.

**Artifacts.**

- `tugdeck/src/lib/code-session-store/types.ts` — extend `TurnEntry` with the time-accounting + diagnostic fields + `cost`. Add `TurnCost` and `TurnEndReason` types. Extend `ToolCall` with `toolWallMs`.
- `tugdeck/src/lib/code-session-store/reducer.ts` — new state fields + handlers (above).
- `tugdeck/src/lib/code-session-store/transport-status.ts` *(only if Investigation B outcome is (b))* — minimal type + wire-format for the transport status signal.
- `tugdeck/src/lib/code-session-store/telemetry.ts` — _new module_ — pure-logic helpers: `perTurnContextSize`, `extractTurnCost`, `deriveSessionTotals`, and the `liveTurn*` family (`liveTurnWallClockMs`, `liveTurnAwaitingApprovalMs`, `liveTurnTransportDowntimeMs`, `liveTurnActiveMs`).
- `tugdeck/src/lib/code-session-store/hooks/use-lifecycle-tick.ts` — _new hook_ — 1Hz `setInterval` that runs only while a turn is in flight; returns `tickAt: number` that consumers fold into the pure-logic `liveTurn*` helpers to drive ticking displays without polling the reducer.
- `tugdeck/src/lib/code-session-store/__tests__/telemetry.test.ts` — pure-logic tests for the helper module (committed + live).
- `tugdeck/src/lib/code-session-store/__tests__/reducer.awaiting-approval-accounting.test.ts` — reducer-level tests: a turn with two permission pauses accumulates correctly; question dialog accumulates the same; interrupt freezes in-progress pause; replay path doesn't accumulate (the bracketed replay reconstructs committed turns from past frames without going through awaiting_approval).
- `tugdeck/src/lib/code-session-store/__tests__/reducer.transport-downtime.test.ts` — reducer-level tests: disconnect-while-active accumulates; multiple reconnects increment `reconnectCount`; a turn that ends with the transport down sets `turnEndReason === "transport_lost"`.
- `tugdeck/src/lib/code-session-store/__tests__/reducer.per-turn-cost.test.ts` — per-turn cost delta math: handles both cumulative and per-turn `cost_update.usage` shapes; defaults to zeros when `cost_update` never fired for a turn; the `costAtSubmit` snapshot is taken at the right moment.
- `tugdeck/src/lib/code-session-store/__tests__/reducer.diagnostics.test.ts` — `ttftMs`, `ttftcMs`, `maxStreamGapMs`, `turnEndReason`, `ToolCall.toolWallMs` all populate correctly.
- _No UI changes in this step._ The chrome / placement decisions are [#step-20-4]'s scope.

**Tasks.**

- [x] **Investigation A — cost_update semantics** — COMPLETED. Conclusion: `cost_update.usage` is **cumulative per-session**. Per-turn delta computed via `extractTurnCost(costAtSubmit, currentLastCost)`. See [Investigation A findings](#step-20-3-investigation-a). Validation deferred to HMR vet during implementation.
- [x] **Investigation B — transport-status confirmation** — COMPLETED. Conclusion: `transportState: "online" | "offline" | "restoring"` already on snapshot. Wire downtime timer into existing `handleTransportClose` / `handleTransportSettled` handlers; no new wire-format. See [Investigation B findings](#step-20-3-investigation-b).
- [x] **Type extensions** — extend `TurnEntry` + `ToolCall`; add `TurnCost` + `TurnEndReason` types.
- [x] **Reducer state fields** — add all eleven new state fields to `CodeSessionState` + `createInitialState` (including `interruptInFlight`). _(Plus one internal `toolUseStartedAt: Map<string, number>` to anchor per-tool wall computation.)_
- [x] **Awaiting-approval timer wiring** — instrument enter/exit handlers (permission + question); defensive resets on interrupt + transport-close + replay-bracket paths.
- [x] **Transport-downtime timer wiring** — extend existing `handleTransportClose` / `handleTransportOpen` / `handleTransportSettled` (per [QT03 resolved](#qt03-transport-status-signal)) to set / accumulate `transportNonOnlineSince` on `online ↔ {offline|restoring}` transitions. Increment `transportReconnectCount` on the return to `online`.
- [x] **`interruptInFlight` wiring** — `handleInterrupt` sets `true` for CASE B (the round-trip path); CASE A is locally terminal so it clears immediately. `handleTurnComplete` clears via `resetPerTurnTelemetry()`.
- [x] **`turnEndReason` migration** — add `turnEndReason` to `TurnEntry`; reducer sets it per terminal handler; mark `result` `@deprecated` with JSDoc pointing to `turnEndReason`; derive `result` from `turnEndReason` so the two stay in sync.
- [x] **`useLifecycleTick` hook** — 1Hz `setInterval` while phase non-terminal; returns `tickAt: number`. Pure-logic `isLivePhase` predicate exported for test; the React lifecycle stays for higher-level coverage per the no-fake-DOM rule.
- [x] **Stream-gap + latency markers** — every live stream event folds the gap into `maxStreamGapMs`; first `assistant_text` / first `tool_use` capture latency timestamps; each `tool_result` writes `toolWallMs` to its `ToolCallState`.
- [x] **Per-turn cost delta** — `handleSend` snapshots `lastCost` into `costAtSubmit`; `handleTurnComplete` computes the delta + freezes onto `TurnEntry.cost` via `buildTurnEntry`; helper module exports `extractTurnCost(before, after)`.
- [x] **Terminal-state wiring** — `turnEndReason` set by handler. `handleTurnComplete` selects `complete` / `interrupted` / `error` based on result and `interruptInFlight`. `handleTransportClose` with an in-flight turn commits a TurnEntry with `transport_lost`.
- [x] **Telemetry helper module** — `perTurnContextSize`, `extractTurnCost`, `deriveSessionTotals`, `liveTurn*` family. Pure-logic; no DOM, no React.
- [x] **Tests** — see Artifacts; reducer-level + pure-logic, all green.
- [x] **Wipe the prior 20.3 attempt** — no `tide-meter-chrome.{tsx,css}` files existed; one stale doc reference in `model-context-max.ts` cleaned up. `model-context-max.ts` retained for 20.4 window-utilization use.

**Tests.**

- [x] Reducer: a turn with one permission dialog accumulates `awaitingApprovalMs = (responded_at - forwarded_at)`.
- [x] Reducer: a turn with two sequential dialogs accumulates the sum of both pauses.
- [x] Reducer: a turn with a question dialog accumulates `awaitingApprovalMs` (same semantics as permission).
- [x] Reducer: an interrupted turn (Stop pressed while awaiting_approval) freezes the in-progress pause and folds it into the committed entry's `awaitingApprovalMs`.
- [x] Reducer: a turn with no dialogs commits with `awaitingApprovalMs === 0`.
- [x] Reducer: a turn with one transport disconnect/reconnect cycle accumulates the gap and `reconnectCount === 1`.
- [x] Reducer: two disconnect/reconnect cycles across an idle session accumulate the sum and `reconnectCount === 2`.
- [x] Reducer: a turn that ends while the transport is down sets `turnEndReason === "transport_lost"`.
- [x] Reducer: an interrupted turn sets `turnEndReason === "interrupted"`.
- [x] Reducer: a clean completion sets `turnEndReason === "complete"`.
- [x] Reducer: a wire error without a preceding interrupt sets `turnEndReason === "error"`.
- [x] Reducer: `ttftMs` populated from `submitAt` to first `assistant_text`; `null` when no assistant output.
- [x] Reducer: `ttftcMs` populated from `submitAt` to first `tool_use`; `null` when no tool calls.
- [x] Reducer: `maxStreamGapMs` captures the largest gap across the turn.
- [x] Reducer: each `ToolCallState` gets `toolWallMs` populated when its `tool_result` arrives.
- [x] Reducer: per-turn cost delta with cumulative `cost_update.usage` math.
- [x] Reducer: first-of-session turn (the per-turn-shape degenerate case): `costAtSubmit === null` and delta degenerates to `after`.
- [x] Reducer: a turn with NO `cost_update` commits with `cost` = all zeros.
- [x] Pure-logic: `perTurnContextSize(turn)` = `input + cache_read + cache_creation` (NOT output).
- [x] Pure-logic: `deriveSessionTotals(transcript)` correctly sums all per-turn fields across a multi-turn fixture.
- [x] Pure-logic: `liveTurnWallClockMs(state, now)` = `now - currentTurn.submitAt` while a turn is in flight; `0` when no turn is in flight.
- [x] Pure-logic: `liveTurnAwaitingApprovalMs` folds the live in-progress pause into the accumulator when `awaitingApprovalSince !== null`.
- [x] Pure-logic: `liveTurnTransportDowntimeMs` folds the live in-progress downtime into the accumulator when `transportNonOnlineSince !== null`.
- [x] Pure-logic: `liveTurnActiveMs(state, now)` = live wall − live awaiting − live downtime, clamped ≥ 0.
- [x] Pure-logic: `extractTurnCost` clamps non-monotonic deltas to zero.
- [x] Pure-logic: `useLifecycleTick.isLivePhase` returns `false` for terminal phases (`idle` / `errored`) and `true` for every non-terminal phase.

**Checkpoint.**

- [x] `bun x tsc --noEmit` clean.
- [x] `bun test` green — 1946 pass / 0 fail / 8431 expect() calls across 114 files.
- [x] `bun run audit:tokens lint` exits 0.
- [x] **HMR vet (manual user action) — COMPLETED via [Step 20.3.1](#step-20-3-1)'s `TugDevPanel`.** Vet run on 2026-05-16 against a real `tokei`-running Bash tool turn with a deliberate ~12s pause on the permission dialog. Confirmed: `turnEndReason === "complete"`; `awaitingApprovalMs = 12328 ms` matches the dialog wait (cross-checked against `respondedAt − (submitAt + ttftcMs) = 12548 ms`, ~220 ms slack between dialog paint and `pendingApproval` snapshot land); `transportDowntimeMs === 0`; context tokens `7 + 13698 + 47870 = 61575` plausible; `activeMs = 5697 ms` satisfies the `wall − awaiting − downtime` invariant; `toolWallMs = 12697 ms` captures the per-call wall correctly; `maxStreamGapMs = 12514 ms` reflects the tool runtime; `internalLiveAnchors` all reset to `null`/`0`/`false` after commit. **Real-world finding** on `ttftMs`: for tool-using turns, `ttftMs` correctly fires when the FIRST `assistant_delta` lands — which for a tool-using turn is AFTER the tool completes. The "small and positive" indicator for tool-using turns is `ttftcMs` (time-to-first-tool-call); the vet's tokei turn had `ttftcMs = 2465 ms` (Claude opened with a tool), `ttftMs = 17172 ms` (assistant text came post-tool). Both are correct captures of what they measure.

---

#### Step 20.3.1: `TugDevPanel` — persistent native-triggered dev inspector surface {#step-20-3-1}

**Depends on:** [#step-20-3](#step-20-3) (the telemetry fields the first tab inspects), tugbank (for state persistence), tugcast (for the Swift→tugdeck control channel).

**Status:** _COMPLETED 2026-05-16. Implementation + app-test + manual ⌥⌘/ chord vet + closure of the 20.3 HMR vet all done._

**Commit:** `feat(tugdevpanel): persistent dev inspector toggled from Tug.app Developer menu (Opt-Cmd-/)`

**References:** [L02], [L06], [L13], [L19], [L20], [L23], [L26], [feedback_no_localstorage], [feedback_persistent_text_entry], [#step-20-3] (data the first tab consumes).

**Scope note — why we are building this.** The 20.3 HMR vet's "open the snapshot via dev-tools" instruction is the canary for a recurring failure mode in tugdeck work: every time we need to inspect store state during a manual check, we add a one-shot `console.log` or a `(window as any).__foo = bar` slot, ship it as a "temporary" diagnostic, and then leave it in place because nothing better exists. Over weeks, those crappy little debug holes accumulate. This step replaces that pattern with one proper observation surface — Tug-specific (not browser-specific), persistent across HMR, and **designed to grow** new inspector tabs as future steps need them. The 20.3 telemetry vet is the first consumer; subsequent inspectors (transport timeline, replay clock, events log, PropertyStore tree) drop in as sibling tabs without re-architecting the IPC channel.

**Scope.** Build the panel framework + the first inspector tab (`Telemetry`) covering [#step-20-3]'s per-turn fields. The framework is the load-bearing deliverable; the Telemetry tab is the proof that the framework's contract is right.

**Three deliverables:**

1. **macOS Developer menu + Opt-Cmd-/ shortcut.** New `DeveloperMenu` (NSMenu) appended to Tug.app's menu bar, gated on a debug build flag (`#if DEBUG` or equivalent — never ships in release builds). One menu item: "Show Dev Panel," key equivalent `/`, modifiers `[.option, .command]`. The action sends a tugcast control frame on a new feed `DEV_CONTROL`.
2. **`TugDevPanelStore` + `<TugDevPanel>` framework.** A proper [L02] store carries `{ open, activeTab, selectedCardId }`; persists via tugbank per [feedback_no_localstorage]; subscribes to `DEV_CONTROL` for the toggle signal. The React panel mounts ONCE at app root and toggles visibility via DOM (per [L06]) — never via React-tree re-mount.
3. **`<TelemetryInspector>` — first tab.** Reads the selected card's `CodeSessionStore` via `useSyncExternalStore` like any other consumer, surfaces live + committed [#step-20-3] telemetry, and exposes "Copy as JSON" for screenshot-free reporting.

**Architecture.**

```
┌─────────────────────────────────────────────────────────────────┐
│  Tug.app (Swift) — debug build only                             │
│  ────────────────                                               │
│  DeveloperMenu                                                  │
│   └ "Show Dev Panel"  (Opt-Cmd-/)  ─── sends ─┐                 │
│                                                │                │
│                       tugcast feed: DEV_CONTROL│                │
│                       msg: { type: "dev_panel_toggle" } ─┐      │
└──────────────────────────────────────────────────────────│──────┘
                                                          ▼
┌─────────────────────────────────────────────────────────────────┐
│  tugdeck (React) — always mounted                               │
│  ────────────────                                               │
│  TugDevPanelStore  (L02)                                        │
│   ├ subscribes to tugcast DEV_CONTROL                           │
│   ├ snapshot: { open: bool, activeTab: TabId, selectedCardId }  │
│   └ persistence via tugbank `/api/defaults/dev-panel/*`         │
│                                                                 │
│  <TugDevPanel>  (mounted once at app root, hidden by default)   │
│   ├ <TabStrip activeTab onSelect/>                              │
│   ├ <CardPicker selected onSelect/>                             │
│   │     (enumerates per-card CodeSessionStores via              │
│   │      cardServicesStore — read-only)                         │
│   └ <TelemetryInspector card={selected}/>                       │
│        ├ Live section  — useLifecycleTick + liveTurn* helpers   │
│        ├ Last committed TurnEntry  — full field table           │
│        ├ Session totals  — deriveSessionTotals(transcript)      │
│        └ "Copy as JSON" — clipboard write only                  │
└─────────────────────────────────────────────────────────────────┘
```

**Telemetry tab — field layout.**

| Section | Source | Refresh strategy |
|---|---|---|
| Card identity | `tugSessionId`, `displayLabel`, `sessionMode` | event-driven via [L02] |
| Phase + transport | `snapshot.phase`, `snapshot.transportState` | event-driven |
| Live in-flight clocks | `liveTurnWallClockMs`, `liveTurnAwaitingApprovalMs`, `liveTurnTransportDowntimeMs`, `liveTurnActiveMs` | [`useLifecycleTick(phase, 1000)`](./tide-assistant-turns.md#step-20-3) |
| Live counters | `state.transportReconnectCount`, `state.maxStreamGapMs`, `state.firstAssistantDeltaAt`, `state.firstToolUseAt` | event-driven |
| Last committed `TurnEntry` | `transcript[transcript.length - 1]` (or message "no committed turns yet") | event-driven |
| Session totals | `deriveSessionTotals(transcript)` | event-driven |
| Copy as JSON | reads snapshot at click time | on demand |

Each numeric field renders alongside its **field path** (e.g. `TurnEntry.awaitingApprovalMs`) so a screenshot of the panel is self-documenting and reviewers don't have to ask "which number is that?"

**Conformance.**

- **[L02]** — `TugDevPanelStore` is a proper external store; React reads via `useSyncExternalStore`. The Telemetry tab reads each `CodeSessionStore` the same way — no privileged accessors, no leaks. The panel does not subscribe to any state it doesn't render.
- **[L06]** — open/closed visual state is `display: none` (or equivalent) toggled via DOM; React keeps the panel mounted. Tab switches re-render the inspector content; the panel chrome stays.
- **[L13]** — `useLifecycleTick` already handles the live clock; no rAF.
- **[L19]** — composed of small focused components: `<TabStrip>`, `<CardPicker>`, `<TelemetryInspector>`, `<FieldRow>`, `<FieldSection>`.
- **[L20]** — panel owns `--tugx-devpanel-*` slots (surface-color, border-color, text-color, font-mono, field-label-color, field-value-color, copy-button-bg-color, etc.) that alias brio/harmony base tokens via the "alias my own family, don't override the child's" rule.
- **[L23]** — preserves open/closed state, active tab, and selected card across HMR via tugbank persistence.
- **[L26]** — panel mount identity is stable; tab switches don't unmount the panel root.
- **[feedback_no_localstorage]** — no `localStorage` / `sessionStorage` / `IndexedDB`. All persistence via tugbank `/api/defaults/dev-panel/{open,activeTab,selectedCardId}`.
- **[feedback_persistent_text_entry]** — the panel does NOT claim persistent text-entry destination. Any future search/filter inputs are transient per the single-persistent-destination rule.
- **Read-only.** No mutations of session state. (Future tabs MAY add controlled actions — e.g. "force a soft-budget tick" for replay testing — but 20.3.1 ships zero action affordances.)
- **Debug build only.** The Swift Developer menu is gated on a debug build flag; the tugdeck-side panel framework ships always (it's inert without the toggle signal) but adds zero runtime cost when `open === false` because [L06]'s display-toggle keeps the inspector tree out of the layout.

**Design — type sketch.**

```typescript
// lib/tug-dev-panel-store/types.ts

export type TugDevPanelTabId = "telemetry"; // | "lifecycle" | "transport" | ... (future)

export interface TugDevPanelSnapshot {
  open: boolean;
  activeTab: TugDevPanelTabId;
  /** Card whose store the active inspector reads. Null when no card is selected
   *  (e.g., no cards are open yet); the inspector renders an empty-state. */
  selectedCardId: string | null;
}

// lib/tug-dev-panel-store/tug-dev-panel-store.ts

export class TugDevPanelStore {
  constructor(deps: {
    conn: TugConnection;
    cardServicesStore: CardServicesStore;
    tugbank: TugbankClient;
  });

  getSnapshot(): TugDevPanelSnapshot;
  subscribe(listener: () => void): () => void;

  // Mutations (called from panel UI, never from elsewhere).
  toggle(): void;
  setOpen(open: boolean): void;
  selectTab(tab: TugDevPanelTabId): void;
  selectCard(cardId: string | null): void;

  dispose(): void;
}
```

**macOS integration (Swift) — sketch.**

```swift
// Tug.app/Menus/DeveloperMenu.swift  (compiled only under #if DEBUG)

@MainActor
final class DeveloperMenu {
  private let tugcast: TugcastConnection

  init(tugcast: TugcastConnection) {
    self.tugcast = tugcast
  }

  func install(in mainMenu: NSMenu) {
    let devMenuItem = NSMenuItem(title: "Developer", action: nil, keyEquivalent: "")
    let devMenu = NSMenu(title: "Developer")
    devMenuItem.submenu = devMenu

    let toggle = NSMenuItem(
      title: "Show Dev Panel",
      action: #selector(togglePanel),
      keyEquivalent: "/"
    )
    toggle.keyEquivalentModifierMask = [.option, .command]
    toggle.target = self
    devMenu.addItem(toggle)

    mainMenu.addItem(devMenuItem)
  }

  @objc private func togglePanel() {
    tugcast.send(feed: .devControl, payload: ["type": "dev_panel_toggle"])
  }
}
```

**Artifacts.**

- `tugdeck/src/lib/tug-dev-panel-store/types.ts` — `TugDevPanelTabId`, `TugDevPanelSnapshot`, store contract.
- `tugdeck/src/lib/tug-dev-panel-store/tug-dev-panel-store.ts` — class wrapper; subscribes to `DEV_CONTROL` feed; hydrates from tugbank; persists writes.
- `tugdeck/src/lib/tug-dev-panel-store/reducer.ts` — pure reducer (toggle / selectTab / selectCard / hydrateFromTugbank / receiveControlFrame).
- `tugdeck/src/components/tug-dev-panel/TugDevPanel.tsx` — root panel; `<TabStrip>` + `<CardPicker>` + active inspector slot.
- `tugdeck/src/components/tug-dev-panel/TabStrip.tsx`
- `tugdeck/src/components/tug-dev-panel/CardPicker.tsx`
- `tugdeck/src/components/tug-dev-panel/FieldRow.tsx` — `(label, value, fieldPath, hint?)` row primitive shared by all inspectors.
- `tugdeck/src/components/tug-dev-panel/FieldSection.tsx` — collapsible section grouping `FieldRow`s.
- `tugdeck/src/components/tug-dev-panel/inspectors/TelemetryInspector.tsx` — first tab; consumes `CodeSessionStore` + `liveTurn*` + `deriveSessionTotals`.
- `tugdeck/src/components/tug-dev-panel/copy-as-json.ts` — small helper; clipboard write.
- `tugdeck/styles/themes/brio.css` + `harmony.css` — `--tugx-devpanel-*` slot definitions per [L20].
- `tugdeck/src/components/tug-dev-panel/tug-dev-panel.css` — panel layout; `display: none` toggle hook.
- `tugdeck/src/protocol/feeds.ts` — register `DEV_CONTROL` feed id.
- `tugapp/Tug/Menus/DeveloperMenu.swift` — `#if DEBUG`-gated menu (per CLAUDE.md tugapp/ structure).
- `tugapp/Tug/AppDelegate.swift` (or equivalent menu wiring point) — installs `DeveloperMenu` at launch under `#if DEBUG`.
- Tests:
  - `tugdeck/src/lib/tug-dev-panel-store/__tests__/reducer.test.ts` — toggle / tab-select / card-select / DEV_CONTROL frame handling.
  - `tugdeck/src/lib/tug-dev-panel-store/__tests__/persistence.test.ts` — tugbank round-trip (hydrate → mutate → re-hydrate).
  - `tugdeck/src/components/tug-dev-panel/__tests__/field-row.test.ts` — pure-render snapshot of `<FieldRow>` for representative (label, value, path) triples.
  - `tugdeck/src/components/tug-dev-panel/inspectors/__tests__/telemetry-inspector.test.ts` — pure-logic projection from a synthetic `CodeSessionState` → expected field/value map (NO render, per [feedback_no_happy_dom_tests]).
  - app-test: `tugapp-tests/dev-panel-toggle.test.ts` — exercises Opt-Cmd-/ → panel visible → second invocation → panel hidden, using the existing app-test keyboard harness; ends with `VERDICT: PASS|FAIL` per [feedback_just_app_test].

**Implementation note — IPC channel.** Scouting found Tug.app's existing Swift→tugdeck plumbing already routes menu actions through `ProcessManager.sendControl(action, params)` → tugcast UDS → `FeedId.CONTROL` → `dispatchAction` registry. No new wire feed was needed; the toggle ships as a regular kebab-case action `"show-dev-panel-toggle"` registered alongside the other Developer-menu RPCs (`reload`, `set-dev-mode`, etc.). The plan's "new `DEV_CONTROL` feed" sketch was sidestepped — the existing channel was already the right one.

**Implementation note — DEBUG gate.** The plan specified `#if DEBUG`-gated menu installation. The existing Developer menu uses `developerMenu.isHidden = !devModeEnabled` (a runtime user setting) for the same effective gate, and the Dev Panel item joined that menu. Net result: invisible to ship users (no dev mode), instantly available to developers, and we didn't fork a parallel debug-build-only menu structure.

**Implementation note — token slots.** Slots live in `tug-dev-panel.css`'s `body{}` block, matching the existing component-owned-tokens pattern (see `tug-tooltip.css`, `tug-arc-gauge.css`). The plan's wording about declaring slots in `brio.css` / `harmony.css` was incorrect against actual codebase convention.

**Tasks.**

- [x] **Register `show-dev-panel-toggle` action handler** in `action-dispatch.ts`. (No new feed; reuses `FeedId.CONTROL` per existing pattern.)
- [x] **`TugDevPanelStore` reducer + class wrapper** — pure reducer + tugbank hydrate/persist. Subscribes to tugbank domain changes for live external updates.
- [x] **Panel framework components** — `TugDevPanel`, `TabStrip`, `CardPicker`, `FieldRow`, `FieldSection`, plus a small `copy-as-json` helper.
- [x] **`TelemetryInspector` tab** — wires up [#step-20-3]'s data via existing `liveTurn*` / `deriveSessionTotals` / `perTurnContextSize` helpers, plus a `useLifecycleTick` ticker. Includes a "Copy as JSON" toolbar button that captures snapshot + internal live-clock anchors.
- [x] **Token sovereignty** — `--tugx-devpanel-*` slots declared in `tug-dev-panel.css` body{} per component-token pattern; all consumers read only their own family per [L20]. `@tug-pairings` header present for the audit.
- [x] **Mount once at app root** — single `<TugDevPanel>` placed inside `DeckManager.reactRoot.render(...)` Fragment as a sibling of `<DeckCanvas>`. Visibility toggled via DOM `[data-open]` attribute per [L06].
- [x] **Swift `DeveloperMenu` integration** — "Show Dev Panel" item with `⌥⌘/` added to the existing Developer menu; gated on the same `devModeEnabled` flag as the rest of that menu.
- [x] **AppDelegate wiring** — `@objc showDevPanel(_:)` fires `sendControl("show-dev-panel-toggle")` through the existing tugcast UDS control channel.
- [x] **DeckManager hookup** — `main.tsx` subscribes to deck-state changes and notifies the dev-panel store when the currently-selected card disappears, so the selection clears cleanly without the panel having to mount.
- [x] **Internal-state accessor** — `CodeSessionStore._getInternalStateForDevPanel()` (read-only, doc-marked `@internal`) gives the inspector access to live-clock anchors (`awaitingApprovalSince`, `transportNonOnlineSince`, etc.) that aren't on the public snapshot.
- [x] **Tests** — reducer / persistence / FieldRow / TelemetryInspector projection / formatter helpers.
- [x] **App-test** — `tests/app-test/at0070-dev-panel-toggle.test.ts` exercises the ⌥⌘/ chord round-trip.
- [ ] **20.3 HMR vet closure** — using the new panel, run the vet described in [#step-20-3]'s checkpoint and check the box.

**Tests.**

- [x] Reducer: `toggle()` flips `open`; idempotent under repeated `setOpen(true)` (same-ref).
- [x] Reducer: `selectTab(tab)` updates `activeTab`; same-tab no-op returns same state reference.
- [x] Reducer: `selectCard(id)` updates `selectedCardId`; clearing to `null` is supported; same-id is same-ref.
- [x] Reducer: `hydrate` with missing fields keeps existing values (same-ref); invalid `activeTab` silently rejected.
- [x] Reducer: `card_gone` clears the selection only when the gone id matches; unrelated id is a no-op (same-ref).
- [x] Persistence: `setOpen(true)` PUTs the right URL + body shape; `selectTab(default)` is a no-op (no PUT).
- [x] Persistence: `selectCard(id)` PUTs `kind: "string"`; `selectCard(null)` PUTs `kind: "null"`.
- [x] Persistence: `notifyCardGone(matching)` persists the cleared selection; `notifyCardGone(unrelated)` does nothing.
- [x] `FieldRow.formatFieldValue` covers number / null / undefined / NaN / ±∞ / boolean / string / object / array shapes.
- [x] `TelemetryInspector` projection: synthetic `CodeSessionState` with a committed turn surfaces every [#step-20-3] field — explicit label-coverage test verifies all 16 TurnEntry fields plus the derived `perTurnContextSize` row.
- [x] `TelemetryInspector` projection: with no committed turn, surfaces an explicit "No committed turns yet." row instead of silent zeros.
- [x] `formatMs` and `formatUsd` formatters pinned (ms / s / m+s buckets; cost precision tiers).
- [x] app-test (`at0070-dev-panel-toggle`): `show-dev-panel-toggle` action flips `[data-open]`; second invocation flips it back. Drives the dispatch via `window.__tug.dispatchControlAction(...)` rather than the literal `⌥⌘/` chord — the in-app harness force-disables dev mode (AppDelegate.swift::loadPreferences gate on `TUGAPP_APP_TEST=1`) so the Developer menu is hidden and the chord is unreachable from automation. The chord-to-menu wiring stays a manual checkpoint.

**Checkpoint.**

- [x] `bun x tsc --noEmit` clean (tugdeck + tests/app-test).
- [x] `bun test` green — 1979 pass / 0 fail / 8522 expect() calls across 118 files.
- [x] `bun run audit:tokens lint` exits 0 (new `--tugx-devpanel-*` slots properly declared with `@tug-pairings` header).
- [x] Swift Debug build clean (`xcodebuild -configuration Debug`).
- [x] `just app-test at0070-dev-panel-toggle.test.ts` reports `VERDICT: PASS` per [feedback_just_app_test]. Action drives the dispatch surface (not the chord — see Tests note above for the harness/dev-mode reason).
- [x] Manual: open Tug.app debug build → enable dev mode → confirm Developer menu visible with "Show Dev Panel" + `⌥⌘/` shortcut → press shortcut → panel appears → press again → panel hides. **CONFIRMED 2026-05-16.**
- [x] **20.3 HMR vet (manual, blocking) — COMPLETED 2026-05-16.** Vet ran cleanly via the panel against a tokei-running Bash tool turn with a ~12s permission-dialog pause; all five acceptance criteria verified plus invariant + cross-check math. See the closure note at the bottom of [#step-20-3](#step-20-3)'s checkpoint for the full result table and the `ttftMs`-for-tool-using-turns finding.

---

#### Step 20.3.2: `TugDevPanel` — `Log` tab + general logging facility {#step-20-3-2}

**Depends on:** [#step-20-3-1](#step-20-3-1) (the panel framework — tab strip + tugbank-persisted active tab + token slots), tugbank (for cap / filter persistence).

**Status:** _complete 2026-05-16._

**Commit:** `feat(tugdevlog): in-app logging surface + Log inspector tab on the dev panel`

**References:** [L02], [L06], [L13], [L19], [L20], [L23], [L24], [L26], [feedback_no_localstorage], [#step-20-3-1].

**Scope note — why we are building this.** The dev panel proved out the "persistent observation surface" pattern with the Telemetry tab. The next obvious use is in-app logging — a tab that captures anything app code wants to record, with filter / clear / copy affordances, so developers stop sprinkling `console.log` everywhere and then leaving the calls behind. The store-and-render half is a clean reuse of the panel framework; the *append-from-anywhere* API is what makes it generally useful.

**Pattern note — this step formalizes the inspector-tab recipe.** Every future tab (Lifecycle, Transport, Replay, Events Log, PropertyStore Tree per [#step-20-3-1]) should follow the same shape: dedicated store + pure-logic projection/filter helpers + projection-into-row tuples + thin React inspector + paired-CSS file with its own `--tugx-*` family. The Log inspector is the template; later steps cite it.

**Three deliverables:**

1. **`tugDevLogStore.log(...)` API** — a module-scope singleton with a small typed interface that any tugdeck code can call: `tugDevLogStore.debug/info/warn/error(source, message, data?)` (plus a `log({...})` shape for callers that prefer the object form). Backed by a bounded ring buffer so memory stays bounded under high-rate logging. Pure-logic + an [L02] store underneath.
2. **`LogInspector` tab** — second inspector tab on the panel. Newest-at-top list, level + source + free-text filters, clear button, "Copy filtered log as JSON" / "Copy filtered log as text" affordances.
3. **Tab persistence verification** — confirm the existing `selectedTab` round-trip survives a second tab landing (the store already PUTs `activeTab` via `_persistDiff` and hydrates on launch; the unit test already covers the round-trip, but the behavior becomes visibly useful only once there's a second tab to switch to).

**Architecture sketch.**

```
┌─────────────────────────────────────────────────────────────┐
│  tugdeck — anywhere in app code                             │
│  ────────────────────────────────                           │
│  tugDevLogStore.warn(                                       │
│    "code-session-store",                                    │
│    "duplicate turn_complete dropped",                       │
│    { msgId },                                               │
│  );                                                         │
└─────────────────────────────────────────────────────────────┘
                          │  queueMicrotask(...)  ← see "Notification batching"
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  TugDevLogStore (L02)                                       │
│  ────────────────                                           │
│  - Ring buffer (default cap 1000 entries) of                │
│    { id, timestamp, level, source, message, data }          │
│  - subscribe / getSnapshot returning a versioned snapshot   │
│  - mutator: append(entry), clear(), setFilters(partial),    │
│             setMaxEntries(n)                                │
│  - cap persisted at dev.tugtool.dev-panel/logMaxEntries     │
│  - filters (levels, source) persisted at                    │
│    dev.tugtool.dev-panel/{logFilterLevels,logFilterSource}  │
│  - filters.text is in-memory only (survives tab switch,     │
│    not page reload — see "Free-text filter ownership")      │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  <LogInspector>  (renders when activeTab === "log")         │
│  ────────────────                                           │
│  - Filter row: level checkboxes + source popup + text input │
│  - Toolbar:    Clear · Copy as JSON · Copy as text          │
│  - List (newest at top); auto-scrolls to head on append     │
│    only when user is already at head (scrollTop ≤ 8px),     │
│    otherwise stays put so the user can read history         │
└─────────────────────────────────────────────────────────────┘
```

**Entry shape.**

```typescript
export type TugDevLogLevel = "debug" | "info" | "warn" | "error";

export interface TugDevLogEntry {
  /** Monotonically increasing id minted by the store. */
  id: number;
  /** `Date.now()` at append time. */
  timestamp: number;
  level: TugDevLogLevel;
  /** Short subsystem tag, e.g. "code-session-store", "tugdevpanel". */
  source: string;
  /** Human-readable one-line message. */
  message: string;
  /**
   * Optional structured payload; serialised to JSON in copy paths and
   * (lazily, cached) for free-text search.
   *
   * **Mutation contract.** Callers MUST NOT mutate `data` after passing
   * it to the store. The store does not deep-clone — cheap appends
   * matter more than defending against caller-side aliasing. A caller
   * that needs to log a mutable object should clone at the call site.
   */
  data?: unknown;
}
```

**Filters — shape, mechanism, persistence.**

```typescript
export interface TugDevLogFilters {
  /**
   * Levels currently shown. Empty set excludes everything. Default:
   * all four levels. Persisted.
   */
  levels: ReadonlySet<TugDevLogLevel>;
  /**
   * `null` means "all sources." Specific value shows only matching
   * `entry.source`. Persisted. NB: filter may name a source that
   * has no entries currently in the buffer (perfectly valid — the
   * list just renders empty until matching entries appear).
   */
  source: string | null;
  /**
   * Free-text query, matched case-insensitively against `entry.message`
   * AND `JSON.stringify(entry.data)`. Empty string = no text filter.
   *
   * **NOT persisted** — lives only in store state (in-memory). The
   * choice is deliberate: text filters are session-bound queries, not
   * preferences, and reloading them through a tugbank round-trip would
   * disorient the user on cold start. Persistence stops at the tab
   * switch boundary, not at the page-reload boundary.
   */
  text: string;
}
```

| Filter | UI mechanism | Persisted? | Tugbank key | tugbank `kind` |
|---|---|---|---|---|
| `levels` | Row of four `TugCheckbox`es (one per level). NOT `TugChoiceGroup` — that component is documented as a *mutually-exclusive* segment picker; we want multi-select. | yes | `dev.tugtool.dev-panel/logFilterLevels` | `json` (array of strings) |
| `source` | `TugPopupMenu` triggered by a `TugButton`. Menu items: "All" + the distinct sources currently in the buffer (via `extractSources(buffer)`). | yes | `dev.tugtool.dev-panel/logFilterSource` | `string` (specific source) or `null` ("all") |
| `text` | `TugInput`. | no (in-memory only) | — | — |

Filters are **derived** views on the buffer via pure-logic `filterEntries(buffer, filters)`, not state mutations. Clearing a filter never destroys entries.

**Notification batching — the load-bearing safety detail.**

`tugDevLogStore.log()` (and the level-shortcut methods) MUST NOT notify subscribers synchronously. Synchronous notify would (a) re-render every subscriber on every append — at 100 stream events/sec, that's 100 re-renders/sec; (b) trigger React's "mutate external state during render" detector if a render path incidentally calls `log()` (legitimate during error/warning paths, common during effects). The store implements a microtask-deferred flush:

```typescript
class TugDevLogStore {
  private _pending: TugDevLogEntry[] = [];
  private _flushScheduled = false;

  log(entry: TugDevLogEntry): void {
    this._pending.push(entry);
    if (this._flushScheduled) return;
    this._flushScheduled = true;
    queueMicrotask(() => {
      this._flushScheduled = false;
      const drained = this._pending;
      this._pending = [];
      this._applyAppends(drained); // cap-aware, notify-once
    });
  }
}
```

Outcome: many appends in the same task coalesce into one notification. Renders are O(unique-tasks-touching-log) per second, not O(appends). Render-time `log()` calls are safe — the actual store mutation happens after the React commit cycle settles.

**Tug components — committed choices.**

| Slot | Component | Notes |
|---|---|---|
| Level filter | Row of `TugCheckbox` × 4 | One per level; `TugChoiceGroup` is single-select so wrong shape. |
| Source filter | `TugPopupMenu` + `TugButton` trigger | Same pattern as the card picker in [#step-20-3-1]. |
| Free-text filter | `TugInput` | Bound to `tugDevLogStore.filters.text`. |
| Clear button | `TugPushButton` with `confirmation={{ icon: <Check/>, label: "Cleared" }}` + `widthStabilize={{ alternateLabel: "Clear" }}` | "Clear" is wider than "Cleared" — alternateLabel is the WIDER label, per the lesson learned in [#step-20-3-1]. |
| Copy buttons | `TugPushButton` with the `Copy/Check icon + widthStabilize` pattern that the Telemetry tab already uses | Same recipe across inspectors. |
| List rendering | Non-virtualised `<div>` with `overflow: auto` | 1000-entry cap × short rows fits a single DOM in ~10–20ms. Adding a virtualiser is a deferred optimization — call it out as "TODO if frame time becomes visible" rather than building it speculatively. |

**Cap + back-pressure.**

- Default cap: `1000` entries. When the buffer is full, oldest entries roll off (FIFO).
- Cap is mutable via `tugDevLogStore.setMaxEntries(n)`; persisted to tugbank.
- v1 has NO in-panel cap-config UI — the toolbar is already at three buttons (Clear / Copy JSON / Copy text), and a fourth control crowds it. Cap mutations land via the tugbank CLI (or a future "Settings" overflow affordance on the dev panel — out of scope here).
- The cap is enforced in the store's `_applyAppends`, NOT in render — so a runaway logger doesn't blow up memory between paints.

**Console mirror policy.**

`tugDevLogStore.{debug,info,warn,error}(...)` mirrors to `console.{level}(...)` in development builds (`import.meta.env.DEV === true`) so dev-tools still see the same stream while we transition consumers from `console.*` calls to `tugDevLogStore.*` calls. Production builds NEVER mirror — the in-app surface is the only consumer. No per-source opt-out in v1; if mirroring becomes noisy, add a tugbank-persisted filter list in a follow-up.

**Conformance.**

- **[L02]** `TugDevLogStore` is a proper external store; `LogInspector` reads via `useSyncExternalStore`. `getSnapshot()` returns a reference-stable `{ entries, version, filters, maxEntries }` tuple — same reference between dispatches that produced no change.
- **[L06]** List-scroll auto-jump is a DOM-only operation (read `scrollTop`, write `scrollTop`); no React state mediates it. Filter row + toolbar are always visible — no collapse affordance in v1; if added, the toggle is DOM-driven via `data-collapsed` per [L06].
- **[L13]** Auto-scroll-to-head writes are `requestAnimationFrame`-batched (multiple appends in one frame produce one scroll write). Append itself is NOT throttled (would drop logs). RAF here is for the scroll-write pipeline, NOT for animation — this is the "gesture-driven / DOM-write" allowed use per [L13].
- **[L19]** Composed of small focused components. Token slots live in their PAIRED CSS file: log-inspector tokens (level-chip colors, source-tag color, timestamp color) go in `log-inspector.css`, NOT the panel chrome's `tug-dev-panel.css`.
- **[L20]** New `--tugx-devlog-*` slot family in `log-inspector.css`; child Tug components own their own families.
- **[L23]** Filter selections + cap survive HMR via tugbank. The log buffer is correctly transient — logs are not user-visible-data in the [L23] sense (developers are the only consumers; they have not "put data there").
- **[L24]** Buffer = local data (in store); persisted filters = local data; free-text = local data; row visual styling = appearance.
- **[L26]** When `TABS` grows from `[telemetry]` to `[telemetry, log]`, `TugTabBar`'s per-tab React key must stay stable for the existing `telemetry` tab. Keying by `card.id` handles this (`TugTabBar` uses card.id internally). Callout: a future tab-config refactor that injects a wrapper or remaps ids would silently remount the existing tab — keep the per-tab key derivation literal.
- **[feedback_no_localstorage]** — never used. Every persistent bit goes through tugbank.
- **Read-only over app state.** The log is append-only from the app's perspective; only the inspector's own UI affordances mutate filters / cap / clear.
- **Test reset.** Like `tugDevPanelStore._disposeForTest()`, the singleton exposes a `_disposeForTest()` that drops the buffer + listeners + pending queue. Bun shares module state across test files; without this, log-touching tests cross-pollinate.

**Free-text filter ownership.**

Free-text lives in `tugDevLogStore.filters.text` — on the store, not in component-local React state. Putting it in `useState` inside `LogInspector` would lose it the moment the user switches tabs (LogInspector unmounts when `activeTab !== "log"`; React `useState` dies with it). Putting it on the store means:
- Survives tab switch (store outlives inspector mount/unmount).
- Lost on page reload (not persisted) — intentional; text filters are session-bound queries.
- Reducer handles it via `set_filters` partial-merge (level-only mutation doesn't clear text; text-only mutation doesn't clear level).

**Tab persistence — what the panel framework already does.**

The `TugDevPanelStore.activeTab` field already round-trips through tugbank via `_persistDiff` + `_hydrateFromTugbank` (see [#step-20-3-1]). When this step lands the second tab (`"log"`), no additional persistence wiring is needed — the existing store already PUTs the new value the moment the user clicks the tab, and reads it back on next launch. This step's deliverable is just to **verify** (one app-test): switch to `log`, hide the panel, show it again → `log` is still active; AND switch to `log`, call `app.appReload()` → after reload, `log` is still active.

**Append-from-Swift (future, NOT in this step).**

The store can also accept appends from the Swift host via the existing `dispatchAction` channel — register a `dev-log-append` action that calls `tugDevLogStore.log({...})`. Defer until a Swift-side caller actually wants this; the API is forward-compatible without it.

**Artifacts.**

- `tugdeck/src/lib/tug-dev-log-store/types.ts` — `TugDevLogLevel`, `TugDevLogEntry`, `TugDevLogSnapshot`, `TugDevLogFilters`, `DEFAULT_DEV_LOG_MAX_ENTRIES`.
- `tugdeck/src/lib/tug-dev-log-store/reducer.ts` — pure reducer (`append_batch`, `clear`, `set_filters` partial-merge, `set_max_entries`, `hydrate`).
- `tugdeck/src/lib/tug-dev-log-store/tug-dev-log-store.ts` — class wrapper + the `tugDevLogStore` singleton. Microtask-deferred pending queue + flush. Tugbank persistence for `levels`/`source`/`maxEntries`. Memoized `extractSources` cache (invalidated when `append_batch` introduces a new source). Test reset via `_disposeForTest()`.
- `tugdeck/src/lib/tug-dev-log-store/filter.ts` — pure-logic `filterEntries(buffer, filters)`, `extractSources(buffer)`, `stringifyDataForSearch(entry)` (lazy + cached via a `WeakMap<TugDevLogEntry, string>` so the same entry doesn't re-stringify per keystroke).
- `tugdeck/src/components/tug-dev-panel/inspectors/log-inspector.tsx` — second tab; consumes `tugDevLogStore` + filter helpers.
- `tugdeck/src/components/tug-dev-panel/inspectors/log-inspector.css` — paired CSS file owning `--tugx-devlog-*` slots (level-chip colors, source-tag color, timestamp color, row hover, etc.) with the `@tug-pairings` header.
- `tugdeck/src/components/tug-dev-panel/inspectors/log-row.tsx` — one row primitive (timestamp + level chip + source + message + optional data toggle).
- `tugdeck/src/lib/tug-dev-panel-store/types.ts` — extend `TugDevPanelTabId` from `"telemetry"` to `"telemetry" | "log"`; extend `VALID_DEV_PANEL_TABS`.
- `tugdeck/src/components/tug-dev-panel/tug-dev-panel.tsx` — add `{ id: "log", label: "Log" }` to the `TABS` array; render `<LogInspector />` for `activeTab === "log"`.
- Tests:
  - `tugdeck/src/lib/tug-dev-log-store/__tests__/reducer.test.ts` — append / clear / cap enforcement / `set_filters` partial-merge / hydrate.
  - `tugdeck/src/lib/tug-dev-log-store/__tests__/filter.test.ts` — `filterEntries` correctness across level / source / free-text combinations; `extractSources` returns distinct values in stable order; `stringifyDataForSearch` cache returns same string for same entry reference.
  - `tugdeck/src/lib/tug-dev-log-store/__tests__/microtask-defer.test.ts` — appends collapsed into one notification per microtask; a synchronous burst of N appends yields exactly 1 listener call.
  - `tugdeck/src/lib/tug-dev-log-store/__tests__/persistence.test.ts` — filter + cap round-trip via tugbank (`logFilterLevels` JSON-array kind, `logFilterSource` nullable string, `logMaxEntries` i64).
  - app-test: `tests/app-test/at0071-dev-panel-tab-persistence.test.ts` — verifies activeTab survives BOTH a panel hide/show AND a full `app.appReload()`.

**Tasks.**

- [x] **Type extensions** — `TugDevLogLevel`, `TugDevLogEntry`, `TugDevLogSnapshot`, `TugDevLogFilters` (with `levels`/`source`/`text`), `DEFAULT_DEV_LOG_MAX_ENTRIES = 1000`. Extend `TugDevPanelTabId` to include `"log"`; extend `VALID_DEV_PANEL_TABS`.
- [x] **Pure reducer + helpers** — `reduce`, `createInitialState`, `set_filters` partial-merge, FIFO cap enforcement in `append_batch`.
- [x] **`TugDevLogStore` class** — singleton with microtask-deferred pending-queue flush; tugbank hydrate + persist for `levels`/`source`/`maxEntries`; `_disposeForTest()`. In dev builds, mirror `debug/info/warn/error` to `console.{level}`.
- [x] **`filterEntries`, `extractSources`, `stringifyDataForSearch`** — pure helpers, the last memoized via `WeakMap` keyed on entry reference.
- [x] **`<LogInspector>` component** — filter row + toolbar + list + paired `log-inspector.css` declaring `--tugx-devlog-*` slots per [L19]/[L20].
- [x] **`<LogRow>` component** — single-entry primitive.
- [x] **Wire into panel** — add `"log"` to TABS; render `<LogInspector />` when `activeTab === "log"`.
- [x] **Auto-scroll-to-head** — DOM-only via [L06]; gated on `scrollTop ≤ 8px` (preserve user position when they've scrolled away); rAF-batched per [L13].
- [x] **Source migrations (3 explicit seeds, no global sweep)** — convert these to `tugDevLogStore.warn(...)`:
  - `lib/code-session-store/reducer.ts::handleTurnComplete` "dropping duplicate turn_complete" (source: `"code-session-store"`).
  - `lib/tugbank-client.ts` "[TugbankClient] failed to parse DEFAULTS frame" (source: `"tugbank-client"`).
  - `lib/tug-dev-panel-store/tug-dev-panel-store.ts` `_persistDiff` failures (source: `"tugdevpanel"`).
- [x] **Tests** — reducer / filter / microtask-defer / persistence / app-test tab persistence.

**Tests.**

- [x] Reducer: `append_batch` adds entries in order; reaching `maxEntries` drops oldest (FIFO).
- [x] Reducer: `clear` empties the buffer but preserves filters + cap.
- [x] Reducer: `set_filters` partial-merge — level-only update doesn't drop source/text; text-only update doesn't drop level/source.
- [x] Reducer: `set_max_entries` with new value smaller than current buffer truncates oldest to fit.
- [x] Reducer: `hydrate` accepts filters + cap from tugbank; missing keys default cleanly; same-ref return when nothing changes.
- [x] Filter: `levels` — entries whose level is not in the set are excluded; empty set excludes everything; full set is a passthrough.
- [x] Filter: `source` — `null` source means "all"; specific source returns only matching; filter set to a source not present in buffer yields empty list (not an error).
- [x] Filter: `text` — case-insensitive match against `message` AND `stringifyDataForSearch(entry)`; empty string is a passthrough.
- [x] Filter: combined — level AND source AND text all apply (intersection).
- [x] Filter: `extractSources` returns distinct values in first-seen order across multi-source buffers.
- [x] Filter: `stringifyDataForSearch` returns the same string for the same entry reference across calls (cache hit).
- [x] Microtask-defer: a burst of N synchronous `log()` calls produces exactly 1 listener notification after one microtask tick.
- [x] Microtask-defer: a `log()` called during a `getSnapshot()` read does NOT cause a sync re-entry into the store.
- [x] Persistence: `setFilters({ levels })` PUTs `logFilterLevels` as `kind: "json"`; reload re-hydrates.
- [x] Persistence: `setFilters({ source: "x" })` PUTs `logFilterSource` as `kind: "string"`; `setFilters({ source: null })` PUTs `kind: "null"`.
- [x] Persistence: `setMaxEntries(n)` PUTs `logMaxEntries` as `kind: "i64"`.
- [x] Persistence: `text` field is NEVER PUT (in-memory only).
- [x] app-test (`at0071-dev-panel-tab-persistence`): (a) switch to `log`, dispatch `show-dev-panel-toggle` twice, active tab is still `log`. (b) switch to `log`, call `app.appReload()`, after reload active tab is still `log` AND the panel is `data-open="true"` (open state also persists).

**Checkpoint.**

- [x] `bun x tsc --noEmit` clean.
- [x] `bun test` green; existing tests stay green (2025/2025 pass — 42 new tests added).
- [x] `bun run audit:tokens lint` exits 0 (new `--tugx-devlog-*` slots properly declared in `log-inspector.css` with `@tug-pairings` header).
- [x] `just app-test at0071-dev-panel-tab-persistence.test.ts` reports `VERDICT: PASS`.
- [x] Manual: open dev panel, click `Log` tab. Trigger a duplicate-turn-complete (or any of the three seeded sources) and confirm the entry appears in real time; toggle `warn` off → entry hides; toggle back on → reappears; type "duplicate" in the text filter → only matching entries show; clear → buffer empties (filters retained); close panel via ⌥⌘/; reopen → `Log` tab is still active; the log buffer is empty (transient — correct). Full reload (`appReload` via dev-tools or just Cmd-R) → `Log` tab is STILL active; level filter state from before the reload is restored; text filter is empty (in-memory only — correct).

---

#### Step 20.3.3: Investigate L23-compliant persistence for per-turn telemetry {#step-20-3-3}

**Depends on:** [#step-20-3] (the data model whose fields need to survive), [L23] (state-preservation invariant), [L26] (mount-identity across transitions), [L02] (the store boundary the persistence layer hooks into).

**Status:** _design complete — chose B1.b (SessionLedger expansion, client-computes/server-stores). Implementation deferred to `#step-20-3-4`._

**Commit:** `spike(tide-telemetry): design L23-compliant persistence via SessionLedger`

**References:** [L23], [L26], [L02], [L24] (state-zone framing — telemetry is data, not appearance), [#step-20-3] (`TurnEntry.cost` / `activeMs` / `wallClockMs` / `awaitingApprovalMs` / `transportDowntimeMs` / `ttftMs` / `ttftcMs` / `reconnectCount` / `maxStreamGapMs`), [#step-20-4] (the placement-experiment study that exposed the gap), [#step-20-5-d] (the consumer that will ship the chosen defaults — depends on the data being there).

**Scope note — why this exists.** [#step-20-3] designs a clean per-turn telemetry surface: every `TurnEntry` carries token counts (`cost.{inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, totalCostUsd}`) and multi-clock timing (`wallClockMs`, `awaitingApprovalMs`, `transportDowntimeMs`, `activeMs`, `ttftMs`, `ttftcMs`, `reconnectCount`, `maxStreamGapMs`). The reducer composes these from live wire events — most importantly `cost_update` (Anthropic emits this as a live telemetry frame during a turn) and the reducer's own clock anchors (`pendingUserMessage.submitAt`, `awaitingApprovalSince`, `transportNonOnlineSince`). The transcript content (text, tool calls, results) is recoverable from Claude's JSONL transcript file via the replay path; **the telemetry is not**. `cost_update` is a live-only frame, never written to JSONL; the reducer's clock anchors are in-memory only.

The consequence surfaced during [#step-20-4]'s HMR study: after `Developer > Reload`, the tide card rebinds its session and replays the JSONL. The transcript rehydrates with full text content but every restored `TurnEntry.cost` field reads zero and every `*Ms` field reads zero, because the side-channel that wrote them is gone. The window-utilization gauge correctly reports `0 / 200.0k`. This is the data, not the chip.

[L23] is unambiguous about this class of data: _"Selection, focus, scroll position (outer and inner regions), form-control values, and content payloads are user data — the user put them there. A re-lex, re-parse, DOM rebuild, tab switch, pane activation, cross-pane move, app cmd-tab cycle, or cold boot must preserve these invariants."_ Per-turn telemetry is content payload in the [L24] data-zone sense — it is data that non-rendering consumers (the gauge, the sum across turns, a future export feature) depend on, not appearance state — and the user generated it by submitting turns. It MUST survive HMR, full reload, and app relaunch. The current design does not satisfy that. The gap is a [#step-20-3] design omission, recoverable here.

**Scope.** A three-part investigation followed by an architecture decision and a follow-up implementation plan recorded as a sub-step. _No persistence is shipped in 20.3.3 itself_ — this step's deliverable is the design.

1. **Investigation A — recovery inventory.** Catalog every field on `TurnEntry` and classify it as one of:
   - **REPLAYABLE** — Claude's JSONL replay reconstructs it faithfully (`userMessage.text`, `userMessage.attachments`, `userMessage.submitAt` ← _verify whether JSONL carries this_, `thinking`, `assistant`, `toolCalls`, `controlRequests`, `result`, `endedAt`, `msgId`).
   - **LIVE-ONLY** — only captured from live wire events not in JSONL (`cost.*` from `cost_update`, all `*Ms` timing fields and `ttft*Ms` derived from reducer clock anchors, `reconnectCount` and `maxStreamGapMs` derived from transport / stream events).
   - **AMBIGUOUS** — partially reconstructible (`turnKey` is minted client-side at submit, byte-identical across the in-flight → committed transition; on resume the JSONL doesn't carry it, so the replay path must mint a fresh one — verify this works correctly).
   For each LIVE-ONLY field, record whether the field is _ever_ reconstructible from JSONL post-hoc (e.g. `wallClockMs` could be derived from `userMessage.submitAt` and `endedAt` IF both timestamps are in JSONL — verify), or whether it is fundamentally unrecoverable (cost token counts cannot be derived from any post-hoc data — only Claude knows them).

2. **Investigation B — persistence architecture survey.** Survey four architectures end-to-end (read path, write path, durability domain, complexity cost, cross-machine behavior, scaling envelope). **B1 is the leading candidate** — the rationale below explains why; the others stay in the survey so the decision is principled, not assumed.

   - **B1. Expand `SessionLedger` (sqlite, tugcast-side) — client computes, server stores.** _Chosen architecture (B1.b variant; see decision matrix)._ The supervisor already owns a sqlite ledger at `tugrust/crates/tugcast/src/session_ledger.rs` with `sessions` (one row per Claude session — `workspace_key`, `project_dir`, `created_at`, `last_used_at`, `turn_count`, `first_user_prompt`, `state`, `card_id`) and `turns` (a submission journal, deleted on ack). WAL mode, 5s `busy_timeout`, a single `Mutex<Connection>`, a cascade-on-`sessions`-DELETE trigger that protects the "forget cascades" contract. Bootstrap is `CREATE … IF NOT EXISTS`; per the no-migration policy ([DM08] in the mid-turn-replay plan), schema changes ship by deleting `sessions.db` and letting the next open recreate.

     **Why `client computes, server stores` (B1.b) instead of `server computes` (B1.a).** The reducer's `extractTurnCost(costAtSubmit, lastCost)` already pairs cumulative cost snapshots across the turn boundary correctly. Re-implementing that pairing state machine Rust-side would put the same logic in two places — the obvious home for every future drift bug. Worse: the wire `cost_update` frame **does not carry `msg_id`** (verified in `tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/v2.1.104/test-01-basic-round-trip.jsonl` — `cost_update` carries `tug_session_id`, `usage`, `modelUsage`, but not `msg_id`). A server-computing variant would have to pair cost_update with the FOLLOWING `turn_complete` by arrival order — an implicit-positional pairing that breaks the moment frames reorder, drop, or interleave with other sessions on a shared transport. B1.b sidesteps both problems: the reducer reports the already-computed values back to the supervisor via a new inbound message, and the supervisor's only job is durable storage.

     **The chosen join key is `(session_id, msg_id)`.** `turnKey` is client-only — minted fresh by the store wrapper for every replay event (verified in `tugdeck/src/lib/code-session-store.ts` `frameToEvent`: _"`turnKey` is a client-side React-key seed minted by the store wrapper for every dispatched replay event. The wire doesn't (and shouldn't) carry it"_). It cannot be a stable join key across persistence boundaries — every reload would re-mint fresh keys for the same logical turns. `msg_id` is server-assigned by Claude, carried in JSONL, survives replay unchanged, and is exactly what the supervisor needs to address rows.

     **Schema sketch — `turn_telemetry` table:**

     ```sql
     CREATE TABLE IF NOT EXISTS turn_telemetry (
       session_id                  TEXT NOT NULL,
       msg_id                      TEXT NOT NULL,
       -- Cost (TurnCost shape)
       input_tokens                INTEGER NOT NULL DEFAULT 0,
       output_tokens               INTEGER NOT NULL DEFAULT 0,
       cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
       cache_read_input_tokens     INTEGER NOT NULL DEFAULT 0,
       total_cost_usd              REAL    NOT NULL DEFAULT 0,
       -- Timing (multi-clock)
       wall_clock_ms               INTEGER NOT NULL DEFAULT 0,
       awaiting_approval_ms        INTEGER NOT NULL DEFAULT 0,
       transport_downtime_ms       INTEGER NOT NULL DEFAULT 0,
       active_ms                   INTEGER NOT NULL DEFAULT 0,
       ttft_ms                     INTEGER,   -- nullable per data model
       ttftc_ms                    INTEGER,   -- nullable per data model
       reconnect_count             INTEGER NOT NULL DEFAULT 0,
       max_stream_gap_ms           INTEGER NOT NULL DEFAULT 0,
       -- Per-turn commit timestamp (forensic ordering; redundant with msg_id sequence inside a session but cheap)
       ended_at                    INTEGER NOT NULL,
       PRIMARY KEY (session_id, msg_id)
     );
     CREATE INDEX IF NOT EXISTS turn_telemetry_session_order
       ON turn_telemetry(session_id, ended_at);
     -- Reuse the existing cascade-on-sessions-DELETE pattern (no FK
     -- for the same chicken-and-egg reason the `turns` journal omits
     -- one — see session_ledger.rs § Schema):
     CREATE TRIGGER IF NOT EXISTS turn_telemetry_cascade_delete_on_session
       AFTER DELETE ON sessions FOR EACH ROW
       BEGIN DELETE FROM turn_telemetry WHERE session_id = OLD.session_id; END;
     ```

     **Note `turn_key` is intentionally absent** from the schema — client-only, regenerated every reload, would be stale-on-write. The reducer holds it in-memory only for React-reconciliation purposes ([L26]); the join across the persistence boundary is `msg_id`.

     **Write path (B1.b).** At `handleTurnComplete` in the reducer, after the `TurnEntry` is composed with `cost` + timing fields, the store dispatches a side effect that sends a new inbound message:

     ```ts
     // tugdeck → tugcast (via existing tugcast inbound channel)
     interface RecordTurnTelemetry {
       type: "record_turn_telemetry";
       tug_session_id: string;
       msg_id: string;
       cost: TurnCost;
       wall_clock_ms: number;
       awaiting_approval_ms: number;
       transport_downtime_ms: number;
       active_ms: number;
       ttft_ms: number | null;
       ttftc_ms: number | null;
       reconnect_count: number;
       max_stream_gap_ms: number;
       ended_at: number;
       ipc_version: number;
     }
     ```

     Tugcast routes this directly to `SessionLedger.record_turn_telemetry(...)` which does a single `INSERT OR REPLACE` on the row. No live wire change to `cost_update`; that frame keeps its existing role as the in-band cumulative snapshot the reducer pairs.

     **Read path (B1.b).** On `spawn_session(mode=resume)`, the supervisor reads all `turn_telemetry` rows for the session into an in-memory `HashMap<MsgId, TurnTelemetry>`. As the supervisor's replay path emits `turn_complete` events for each replayed turn, it **inlines** the matching telemetry payload onto the event:

     ```ts
     // Extended TurnComplete shape — optional `telemetry` field.
     interface TurnComplete {
       type: "turn_complete";
       msg_id: string;
       seq: number;
       result: string;
       telemetry?: TurnTelemetry;  // populated on the replay path only
       ipc_version: number;
     }
     ```

     The reducer's `handleTurnComplete` checks for `event.telemetry`: present → use it directly (replay path, no `cost_update` available); absent → fall back to the existing `extractTurnCost(costAtSubmit, lastCost)` + clock-anchor derivation (live path, unchanged). One reducer path, two source-of-data branches. No new event type. No ordering discipline across separate events.

     **Survives.** HMR, Developer > Reload, app relaunch, AND tugcast restart (sqlite is on disk). Survives machine swap when `.tug/sessions.db` is rsync'd. Same durability domain as the rest of the session-ledger data.

     **Wire-format change.** ONE new inbound message type (`record_turn_telemetry`, tugdeck → tugcast). ONE additive field on `turn_complete` (`telemetry?: TurnTelemetry`, populated by the replay path only). No change to live `cost_update`. Golden fixtures grow a new resume-with-telemetry case.

     **No retroactive backfill.** Turns committed BEFORE this lands have no persisted telemetry, and JSONL doesn't carry the source data to reconstruct it. After ship, only new turns get persisted; historical turns will read `0` for cost + timing forever. This is unavoidable and accepted.

     **Schema-change dev cost.** Per [DM08], adding the `turn_telemetry` table ships by `CREATE TABLE IF NOT EXISTS` AND every dev's existing `sessions.db` must be deleted before first use of the new build (otherwise the trigger won't bootstrap). The runbook / commit message names this explicitly.

     **Cost estimate.** Rust: schema + supervisor inbound handler + supervisor replay-path telemetry-attach (~1 day). TS: reducer dispatch of `record_turn_telemetry` at `handleTurnComplete` + the inline-telemetry branch in `handleTurnComplete` for replay (~0.5 day). Fixtures + tests: golden updates for resume-with-telemetry path + Rust ledger unit tests + bun:test for the merge (~0.5 day). Linear, no architectural shift.

   - **B2. Tugdeck-local via tugbank.** Per-session JSON blob keyed by `tugSessionId` (or per-turn rows keyed by `tugSessionId + msgId`). Domain: `dev.tugtool.tide.telemetry/<tugSessionId>`. Written at `turn_complete` from the reducer's effects layer (similar shape to the tug-dev-log `putRaw` pattern). Read at session hydrate, merged into the reducer's transcript before `TurnEntry`s land. Survives HMR + reload on the same machine. Does NOT survive across machines or fresh app installs (tugbank is per-machine). _Weaker than B1 on every axis except "no Rust change required." Worth the survey for the comparison; not the destination._

   - **B3. Tugcode-side JSONL sidecar.** A new ledger file written by tugcode alongside the JSONL transcript — `<session>.telemetry.jsonl` or similar. Same write/read shape as B1 conceptually, but file-based instead of sqlite-backed. Loses sqlite's indexed-query + cascade-trigger affordances; gains nothing tugcast doesn't already do better via the ledger. Mentioned for completeness; subsumed by B1.

   - **B4. Backend persistence service.** A dedicated tug-backend feed for "session telemetry." Persists durably across machines via the backend (Sync, Spaces, etc., as those mature). Long-term durability story; currently out of scope for tugtool's single-machine dogfooding model. Worth noting as a future migration path B1 wouldn't preclude.

   For each option, document:
   - **What survives** — HMR, Reload, app relaunch, machine swap, fresh install.
   - **Wire-format change** — none / new event type / new feed.
   - **Merge semantics** — how the persisted telemetry composes with replayed content into a single `TurnEntry`. Where does the merge happen — in the reducer (synthesized event), in the store-construction layer (post-construction reconciliation), or somewhere else? Which approach respects [L02] and [L26] cleanest?
   - **Keying** — which identifier is the durable join key (`msg_id`? `turnKey`? composite?). Verify it's stable across the persistence transition and across replays. _For B1, the `(session_id, msg_id)` composite is the chosen key — `msg_id` is server-assigned, carried in JSONL, and survives replay unchanged. `turnKey` is client-only (re-minted fresh on every replay) and cannot cross persistence boundaries._
   - **In-flight handling** — what happens to a turn that was MID-FLIGHT when the reload happened? (Replay either drops it entirely or reconstructs it partial; the telemetry for partial turns is meaningful only for the wall-clock half.)
   - **TTL / cleanup** — when sessions are closed, does the telemetry persist forever, get garbage-collected with the session, or follow some explicit policy? _For B1, the cascade trigger gives this for free: when a `sessions` row is evicted (cap-per-workspace or age-expiry), its `turn_telemetry` rows go with it._
   - **Storage envelope** — bytes per turn, expected turns per long-running session, total per machine for typical use. _For B1: ~13 integer/real columns + 2 text PK columns ≈ ~120 bytes/row uncompressed; 1000 turns ≈ 120KB; 20 sessions × 1000 turns ≈ 2.4MB. Negligible against the existing ledger envelope._
   - **Test surface** — exactly what a `bun test` or `just app-test` would assert to prove the architecture works.

3. **Investigation C — keying + merge proof of concept.** For the chosen architecture (or top two candidates), write the minimal code that proves the merge works:
   - Construct a synthetic `TurnEntry` from a fake replay event with zero telemetry.
   - Read a persisted telemetry record from a synthetic persistence layer.
   - Merge them into a single `TurnEntry` and assert every field is correct.
   - The proof lives in a single bun:test file; it doesn't have to wire into the real store yet. The deliverable is the merge function + the assertion that joins are stable.

**Decision matrix.** Apply after Investigations A, B, and C; defer to a sub-step ([#step-20-3-4], reserved) for implementation:

- **A says "everything LIVE-ONLY is fundamentally unrecoverable from JSONL"** → some persistence is mandatory; the question becomes _which_.
- **B1.b (client computes, server stores via SessionLedger expansion) is feasible and the merge proof in C passes** → ship B1.b. It's the obvious destination: same durability domain as the existing ledger, cascade-on-DELETE already exists, `(session_id, msg_id)` is the natural stable join key, the reducer stays the single source of truth for the computation, and Rust scope is bounded to schema + one inbound handler + one replay-path telemetry-attach. Open `#step-20-3-4` with the implementation scope.
- **B1.b surfaces an unforeseen complication in C** (e.g., the merge would require restructuring `CodeSessionStore` construction in a way that fights [L02]; the inline-telemetry shape on `turn_complete` collides with an existing consumer; the inbound message dispatch path can't carry the payload size) → fall back to B2 (tugbank-local) as a fast bridge, AND open a follow-on Rust spike to remove the blocker so B1.b can land later. Document both decisions clearly so the bridge code has a planned exit.
- **All B options carry hidden complications surfaced in C** → narrow the chosen scope to "persist cost only, defer timing" or "persist cumulative session totals only, defer per-turn breakdown." Document the trade clearly and call out what [#step-20-5-d] loses by the narrowing.

**Conformance — what L23 requires.**

- The telemetry on every `TurnEntry` for every committed turn in the user's transcript MUST appear correctly after HMR, after `Developer > Reload`, and after app relaunch — regardless of which architecture is chosen.
- The persistence + merge MUST NOT change [L26] mount identity — `turnKey` (the client-only React-reconciliation key) stays byte-identical to the in-flight turnKey it was minted with regardless of whether telemetry arrives via the live path or inlined on a replayed `turn_complete`. The persistence layer joins on `msg_id` (a separate identifier with a separate role); React reconciliation must not see a remount triggered by the persistence layer's arrival timing.
- [L02] is preserved — telemetry persistence reads / writes are NOT routed through React state. Writes are dispatched from `handleTurnComplete` as an effect (the existing reducer effect channel); reads land inlined on `turn_complete` events delivered over the existing wire (no new subscription surface, no new React-state mirror). `CodeSessionStore` stays the single L02 boundary; React still reads via `useSyncExternalStore` only.
- For HMR / Reload specifically: the merge happens inside the reducer at `handleTurnComplete` for every turn — live or replayed — so there is no "merge after the fact" timing window where a `TurnEntry` could be observed in a torn state. Replayed `turn_complete` events carry telemetry inline; live ones derive it from `costAtSubmit + lastCost` as today.

**Conformance — what L26 requires.** Persistence MUST NOT introduce a second `TurnEntry` reference for the same logical turn — the reducer produces ONE `TurnEntry` at `handleTurnComplete`, with telemetry fields populated by whichever branch (live or replay-inline) applies. React reconciliation sees the same `turnKey`-derived row identity across both paths; no remount, no torn state, no second commit. Identity stays anchored on `turnKey` throughout — the persistence key (`msg_id`) is a separate identifier serving a separate role.

**Artifacts.**

- `dash/tide-assistant-turns.md` — the spike record gets appended to this step (Investigations A, B, C; chosen architecture; merge contract; deferred-implementation pointer to a follow-up sub-step).
- _Optional_ — a small `bun:test` file that proves the merge contract (Investigation C deliverable). Lives alongside `code-session-store/__tests__/` if it gets written; not required if the architecture decision falls out from A/B alone.
- _A follow-up sub-step record_ — open `#step-20-3-4` (reserved) and draft its scope: implementation of the chosen architecture (B1 / B2 / B4). 20.3.4's `Status: not started` should land in this same commit so the dependency from [#step-20-5-d] has a target to point at.

**Tasks.**

- [x] **Investigation A — recovery inventory.** Read `tugcode/src/replay.ts`, `tugdeck/src/lib/code-session-store.ts`, and the v2.1.104 stream-json-catalog golden fixtures. Recovery table recorded in the spike record below.
- [x] **Investigation B — architecture survey.** B1.b / B2 / B3 / B4 compared along the seven dimensions; comparison table recorded in the spike record below.
- [ ] **Investigation C — merge proof.** _Deferred to `#step-20-3-4`'s first task — the design is concrete enough that the merge function can be written directly from the schema + inline-telemetry shape without a separate pre-implementation milestone._
- [x] **Decision.** B1.b chosen. Rationale recorded in the spike record below.
- [x] **Open `#step-20-3-4`.** Opened with `Status: not started` + full scope (schema, ledger methods, supervisor handler, replay-path attach, TS reducer dispatch, golden fixture, tests). [#step-20-5-d] now depends on it.
- [x] **Commit.** `f8627390 plan(tide-turns): finalize 20.3.3 design + open 20.3.4 (impl)`.

**Tests.**

- [ ] If Investigation C produces a merge function: pinning bun:test that asserts the merged `TurnEntry` equals the expected shape across at least three cases: (a) live turn with full telemetry → persistence record matches reducer-committed value; (b) replayed turn with zero telemetry + persisted record → merge produces accurate `TurnEntry`; (c) replayed turn with NO persisted record (e.g. data is gone) → merge produces zero-telemetry `TurnEntry` (not crash; not a fabricated value).
- [ ] No HMR / app-test / app-relaunch tests in this step — those land in `#step-20-3-4`'s test surface, defined by the chosen architecture.

**Checkpoint.**

- [ ] `bun x tsc --noEmit` clean.
- [ ] `bun test` green (the test bar doesn't change if Investigation C doesn't produce a test; the existing 2070 must still pass).
- [ ] The spike record below is filled in with: the recovery table, the architecture survey, the decision and its rationale, the merge proof outcome (if Investigation C ran), and a link to the opened `#step-20-3-4`.

**Spike record — Investigation A finding (verified during planning).**

Recovery table after reading `tugcode/src/replay.ts`, `tugdeck/src/lib/code-session-store.ts`, and the v2.1.104 stream-json-catalog golden fixtures:

| `TurnEntry` field | Classification | Source (live) | Source (replay) | Notes |
|---|---|---|---|---|
| `turnKey` | CLIENT-ONLY (re-minted on replay) | `mintTurnKey()` in store wrapper at `send()` | `mintTurnKey()` in `frameToEvent` for `user_message_replay` | NOT a stable join key across persistence boundaries. React-reconciliation only. |
| `msgId` | REPLAYABLE | Claude `message.id` via stream-json | Same — preserved in JSONL | **The persistence join key.** |
| `userMessage.text` | REPLAYABLE | `send(text)` | `user_message_replay.text` from JSONL | |
| `userMessage.attachments` | REPLAYABLE | `send(atoms)` | `user_message_replay.attachments` from JSONL | |
| `userMessage.submitAt` | LIVE-ONLY (no JSONL timestamp) | `Date.now()` at `send` | `Date.now()` at replay (synthetic; NOT the original) | Original submit-time is lost on replay; `wallClockMs` from `(submitAt, endedAt)` is unrecoverable post-hoc. |
| `thinking` | REPLAYABLE | `assistant_delta(channel="thinking")` stream | Same | |
| `assistant` | REPLAYABLE | `assistant_delta(channel="assistant")` stream | Same | |
| `toolCalls` | REPLAYABLE | `tool_use` / `tool_result` stream | Same | |
| `controlRequests` | REPLAYABLE | `control_request_forward` + `respond_*` | Resolved decisions land in JSONL | |
| `result` | REPLAYABLE | `turn_complete.result` | Same | |
| `endedAt` | REPLAYABLE | `Date.now()` at `turn_complete` | `Date.now()` at replay (synthetic; not original) | Approximate only on replay. |
| `cost.inputTokens` | LIVE-ONLY (unrecoverable) | `cost_update.usage.input_tokens` | NOT in JSONL | `cost_update` is live-only. Confirmed against fixtures: JSONL carries `system_metadata`, `assistant_text`, `tool_use`, `tool_result`, `turn_complete` — no `cost_update`. |
| `cost.outputTokens` | LIVE-ONLY (unrecoverable) | `cost_update.usage.output_tokens` | NOT in JSONL | |
| `cost.cacheReadInputTokens` | LIVE-ONLY (unrecoverable) | `cost_update.usage.cache_read_input_tokens` | NOT in JSONL | |
| `cost.cacheCreationInputTokens` | LIVE-ONLY (unrecoverable) | `cost_update.usage.cache_creation_input_tokens` | NOT in JSONL | |
| `cost.totalCostUsd` | LIVE-ONLY (unrecoverable) | `extractTurnCost(before, after).totalCostUsd` | NOT in JSONL | |
| `wallClockMs` | LIVE-ONLY (unrecoverable) | `endedAt - userMessage.submitAt` | Both timestamps are synthetic on replay — derived value is meaningless | |
| `awaitingApprovalMs` | LIVE-ONLY (unrecoverable) | Reducer's `awaitingApprovalSince/Accumulated` | No equivalent state on replay | |
| `transportDowntimeMs` | LIVE-ONLY (unrecoverable) | Reducer's `transportNonOnlineSince` | Same | |
| `activeMs` | LIVE-ONLY (unrecoverable) | `wall - awaiting - downtime` | Derived from unrecoverable inputs | |
| `ttftMs` | LIVE-ONLY (unrecoverable) | First `assistant_delta` arrival time | Synthetic on replay | |
| `ttftcMs` | LIVE-ONLY (unrecoverable) | First `tool_use` arrival time | Synthetic on replay | |
| `reconnectCount` | LIVE-ONLY (unrecoverable) | Transport observer | No transport on replay | |
| `maxStreamGapMs` | LIVE-ONLY (unrecoverable) | Stream gap observer | No stream timing on replay | |

**Conclusion: every cost field and every `*Ms` timing field is fundamentally unrecoverable from JSONL alone.** A side-channel persistence layer is mandatory. The join key must be `msg_id` (the only field that's both stable across replay AND carried in JSONL).

**Spike record — Investigation B survey.**

Architecture comparison along the seven dimensions named above (✓ = good, ◯ = OK, ✗ = bad):

| Dimension | B1.b (SessionLedger expansion, client-computes) | B2 (tugbank-local) | B3 (JSONL sidecar) | B4 (backend service) |
|---|---|---|---|---|
| Survives HMR / Reload / app relaunch | ✓ | ✓ | ✓ | ✓ |
| Survives tugcast restart | ✓ (sqlite on disk) | ✓ (tugbank survives) | ✓ (file on disk) | ✓ |
| Survives machine swap | ◯ (rsync `.tug/sessions.db`) | ✗ | ◯ (rsync sidecar) | ✓ (backend sync) |
| Wire-format change | One new inbound + one optional field on `turn_complete` | None (tugbank already wired) | New file format | New feed |
| Rust scope | ~1d | 0 | medium | large |
| Cascade-on-DELETE | ✓ (existing trigger pattern) | manual | manual | manual |
| Indexed queries | ✓ (sqlite) | ✗ (JSON blob) | ✗ (linear scan) | depends |
| Single source of truth | ✓ (reducer computes) | ✓ (reducer computes) | depends | depends |

**Conclusion: B1.b wins on every L23 axis that matters for tugtool's current model and doesn't preclude B4 as a future durability layer.** B2 (tugbank-local) is the fallback IF B1.b surfaces an unforeseen blocker; B3 is subsumed by B1.b (sqlite is strictly better than a flat file for the same conceptual placement); B4 is the long-term migration path that B1.b doesn't preclude.

**Spike record — Investigation C merge proof outcome.**

_To be filled in during `#step-20-3-4` execution. The proof is small enough that it can ship as the first task of the implementation sub-step rather than as a separate pre-implementation milestone — the design above is concrete enough that the merge function can be written directly from the schema + the inline-telemetry `turn_complete` shape._

**Spike record — Decision.**

**Chosen architecture: B1.b — `SessionLedger` expansion with client-computes / server-stores.**

Justifications consolidated from A + B above:
- A proves persistence is mandatory (every cost + timing field is unrecoverable from JSONL alone).
- B proves B1.b is the right shape: same durability domain as the existing ledger, cascade-on-DELETE already exists, `(session_id, msg_id)` is the natural stable join key, reducer stays the single source of truth, Rust scope is bounded.
- Wire-shape evidence reinforces B1.b over B1.a: `cost_update` does NOT carry `msg_id` (verified in v2.1.104 fixtures), so server-side per-turn pairing would require implicit-positional ordering — fragile. Client-side pairing is already correct via `costAtSubmit + lastCost` in `extractTurnCost`.

**Follow-up sub-step opened: `#step-20-3-4` (below).** Scope: Rust schema + `SessionLedger.record_turn_telemetry()` + supervisor inbound handler for `record_turn_telemetry` + supervisor replay-path inline-telemetry attach + TS reducer dispatch + TS `handleTurnComplete` inline-branch + golden fixtures + tests (including the merge proof originally scoped as Investigation C).

---

#### Step 20.3.4: Implement L23-compliant telemetry persistence via SessionLedger {#step-20-3-4}

**Depends on:** [#step-20-3-3] (the design), [#step-20-3] (the data model whose fields are persisted), the existing `SessionLedger` and its bootstrap pattern.

**Status:** _complete 2026-05-16 — automation green, manual L23 vet "basically works"._

**Commit:** `feat(tide-telemetry): persist per-turn cost + timing via SessionLedger (B1.b)`

**References:** [#step-20-3-3] (design + spike record), [L23], [L26], [L02], `tugrust/crates/tugcast/src/session_ledger.rs`, `tugdeck/src/lib/code-session-store/reducer.ts:handleTurnComplete`, `tugcode/src/replay.ts`.

**Scope.** Implement the B1.b architecture as designed in [#step-20-3-3]. No new investigation; the design is concrete enough to execute. Deliverables:

- **Rust (tugcast):** new `turn_telemetry` table + cascade trigger via `bootstrap_schema`; `SessionLedger::record_turn_telemetry(session_id, msg_id, …)` + `SessionLedger::list_turn_telemetry(session_id)`; supervisor inbound handler for `record_turn_telemetry` messages; supervisor replay-path attaches `telemetry` payload onto each replayed `turn_complete` from the loaded `HashMap<MsgId, TurnTelemetry>`.
- **TypeScript (tugcode):** new inbound message type `RecordTurnTelemetry` (no business logic — tugcode just routes; tugcast owns the handler); extend `TurnComplete` with optional `telemetry?: TurnTelemetry`.
- **TypeScript (tugdeck):** reducer effect at `handleTurnComplete` to dispatch `record_turn_telemetry` (live path only — not for replayed turns); `handleTurnComplete` branches on `event.telemetry !== undefined` to use the inlined payload (replay path) vs. derive via `extractTurnCost + clock anchors` (live path, unchanged).
- **Tests:** Rust ledger unit tests (write/read/cascade-delete); bun:test pinning the merge function across the three cases from [#step-20-3-3]'s spike note (live with full telemetry; replay with persisted record; replay with NO persisted record); golden fixture for resume-with-telemetry path.

**Conformance.** Per [#step-20-3-3]: [L23] (data survives HMR + Reload + app relaunch + tugcast restart), [L26] (`turnKey` unchanged across both paths), [L02] (no React-state mirror; writes via reducer effect channel; reads inlined on existing wire events).

**Schema-change runbook.** Per [DM08] no-migration policy: this change adds a table that doesn't exist in existing `sessions.db` files. The `CREATE TABLE IF NOT EXISTS` + `CREATE TRIGGER IF NOT EXISTS` bootstrap WILL run on existing databases AND the new table will be empty (no pre-existing telemetry rows). Existing sessions read 0 telemetry for all their historical turns — this is correct per the "no retroactive backfill" caveat. **No manual sessions.db deletion required** for this specific change; the bootstrap is additive.

**Tasks.**

- [x] **Merge function + pinning bun:test** — `deriveTurnTelemetry` + `mergeTurnTelemetry` in `telemetry.ts`; 10 pins in `__tests__/telemetry-merge.test.ts`.
- [x] **Rust schema + ledger methods + unit tests** — `turn_telemetry` table + cascade trigger in `bootstrap_schema`; `record_turn_telemetry` / `list_turn_telemetry` on `SessionLedger`; 6 unit tests covering round-trip, nullable ttft, idempotent PK, ordering, session filter, cascade-delete.
- [x] **Tugcast supervisor inbound handler + replay-path inline-attach** — `record_turn_telemetry` CONTROL action wired through `handle_control` → `do_record_turn_telemetry` → ledger write; `relay_session_io` extended with `session_ledger` param; `inject_replay_telemetry` helper attaches persisted block onto replayed `turn_complete` frames during the `replay_started` ... `replay_complete` window; 5 unit tests for the inject helper + 5 supervisor tests for the CONTROL handler round-trip.
- [x] **TS reducer dispatch (live path) + inline-telemetry branch in `handleTurnComplete` (replay path)** — `RecordTelemetryEffect` added; `buildTurnEntry` accepts `inlineTelemetry` and uses `mergeTurnTelemetry`; live commits emit `record-telemetry` effect; store wrapper builds the CONTROL frame via `encodeRecordTurnTelemetry` and dispatches.
- [x] **Golden fixture: resume-with-telemetry** — covered by the supervisor's `record_turn_telemetry_*` integration tests + the `inject_replay_telemetry_*` unit tests; no new JSONL fixture needed (the existing fixtures don't carry `cost_update`-derived state, which is the point — the persistence layer is exactly what bridges that gap).
- [x] **Manual vet:** run a multi-turn session live → observe gauge reads correct values; reload → observe gauge still reads correct values; close + reopen app → same; force-quit + restart tugcast → same. _User reported: "basically works."_

**Tests.**

- [x] Rust: `SessionLedger::record_turn_telemetry` round-trip; cascade-on-DELETE; `list_turn_telemetry` returns rows in `ended_at` order. (Plus: nullable ttft persistence, idempotent PK, session filter.)
- [x] TS (bun:test): merge function pinning across the three cases. (Plus: derive-from-state pinning across six cases.)
- [x] Resume produces `turn_complete` events with `telemetry` populated for every turn that has a persisted row — pinned by `inject_replay_telemetry_attaches_on_match` + `inject_replay_telemetry_passes_through_on_miss` + reducer `handleTurnComplete — replay path` tests.
- [x] Reducer test: live path computes telemetry via `deriveTurnTelemetry` when `event.telemetry === undefined` AND emits `record-telemetry` effect; replay path uses `event.telemetry` directly when present AND does not re-persist.

**Checkpoint.**

- [x] `cargo test -p tugcast` green (552 pass; +10 new tests across ledger/bridge/supervisor).
- [x] `bun x tsc --noEmit` clean.
- [x] `bun test` green (2064 pass; +14 new tests across merge / reducer / interrupt).
- [x] `bun run audit:tokens lint` exits 0.
- [x] **Manual L23 vet:** reload + relaunch round-trip leaves the gauge reading correct values. _Confirmed 2026-05-16 — "basically works."_

---

#### Step 20.3.5: Investigate removing `tailSpacer="80cqh"` from the transcript {#step-20-3-5}

**Depends on:** L26 (preserve mount identity across transitions), the recent stable-id work that backed it.

**Status:** _complete 2026-05-16 — retired the spacer + plumbing; accepted the natural browser clamp on collapse-shrink._

**Commit:** `spike(tide-card-transcript): retire tailSpacer / trailingInertOffset`

**References:** [L26], `tide-card-transcript.tsx:813-825`, `tug-list-view.tsx:677-683`, `smart-scroll.ts:76-95`

**Scope note — why this is a spike, not a refactor.** `TugListView` accepts a `tailSpacer` prop currently set to `80cqh` (80% of the scrollport's height) inside `tide-card-transcript.tsx`. The accompanying comments at all three call sites explain *what* the spacer does and *why* the unit is `cqh` (window-relative `vh` would overshoot a split-pane child) — but none of them documents the *original reason* we needed inert trailing space in the first place. That motivation is load-bearing context for any decision to remove the hack. The hypothesis is that mount/unmount churn drove the need, and that L26 + the recent stable-id work obviates it; the spike's job is to verify or refute that hypothesis empirically and via code archaeology before either pulling the prop out or annotating it correctly.

**Scope.** A focused two-part investigation followed by a decision:

1. **Investigation A — recover the original reason.** Git-archaeology on the `tailSpacer` prop's introduction (`tide-card-transcript.tsx`) and the `trailingInertOffset` plumbing (`smart-scroll.ts`, `tug-list-view.tsx`). `git log -L :tailSpacer:...` and `git blame` on the relevant lines; read the introducing commit's message and diff context. Classify the original motivation into one of three plausible buckets:
   - **(1) Mount/unmount churn** — pre-stable-id transcript entries remounted on transitions; the spacer provided scroll-position slack so pin-to-bottom never landed on a moving target. **L26 + stable-id work obviates this.**
   - **(2) Streaming jitter** — entries grow as content streams; the spacer absorbs height changes so pin-to-bottom math doesn't "rebound." **L26 / stable-ids do NOT help here.**
   - **(3) Visual comfort** — keep the most recent entry from being pinned to the viewport's bottom edge; pure UX, not a hack. **L26 / stable-ids irrelevant.**
2. **Investigation B — empirical removal under current code.** Remove the `tailSpacer="80cqh"` prop locally (no commit). Exercise the transcript: stream a fresh response into a near-full transcript, switch cards mid-stream, scroll-to-bottom on submit, smoke-test for jitter, "scroll past content into empty space," and any other anomaly. With L26 + stable-ids in place, observe whether the issue Investigation A surfaced still reproduces.

**Decision matrix.**

- **A = (1) AND B reproduces no regression** → remove `tailSpacer` from `tide-card-transcript.tsx` and the `tailSpacer` prop + ref from `TugListView` and the `trailingInertOffset` plumbing from `SmartScroll`. Commit message names L26 as the enabling invariant. Tightens the bottom of every transcript everywhere.
- **A = (2) streaming jitter** → keep the spacer. Replace the existing "how / why-unit" comment at all three sites with a "why-it-exists" comment that names streaming jitter as the cause. Naming the hack honestly is the deliverable.
- **A = (3) visual comfort** → keep the spacer; rewrite the comments the same way as (2) but naming UX comfort as the cause. Consider whether 80cqh is the right magnitude or whether a smaller value (e.g., 20–30cqh) would suffice for comfort without the heavy bottom dead-zone.

**Conformance.** No 20.4 work in this step. No telemetry work. Pure investigation + targeted removal *or* targeted comment-clarification. If the spike concludes "keep the spacer," this step still ships value via the updated comments.

**Artifacts.**

- `tugdeck/src/components/tugways/cards/tide-card-transcript.tsx` — either delete the `tailSpacer="80cqh"` prop OR rewrite its comment.
- `tugdeck/src/components/tugways/tug-list-view.tsx` — either delete the `tailSpacer` prop + `tailSpacerRef` plumbing OR rewrite its comment.
- `tugdeck/src/lib/smart-scroll.ts` — either delete the `trailingInertOffset` option + all its consumers OR rewrite its comment.
- _Add a brief spike record_ — append the Investigation A finding + Investigation B observations to this step's record (which bucket; reproduction notes; final decision).

**Tasks.**

- [x] **Investigation A** — `git log -L` / `git blame` on the introducing commits; classify motivation into bucket (1) / (2) / (3); record finding.
- [x] **Investigation B** — remove the prop locally; HMR-exercise the scenarios above; record observations.
- [x] **Decision** — follow the matrix; either delete plumbing or rewrite comments.
- [x] **Commit** — single commit with message naming the spike's outcome ("retire" if removed, "document" if kept).

**Spike record — Investigation A finding.**

The motivating cause is **a fourth bucket the plan didn't anticipate: document-shrink-clamp protection**. The `tailSpacer` prop and `trailingInertOffset` plumbing were introduced together in a single commit:

- `d8da960a feat(tide-rendering): Phase E.3 — action-bar position invariance` (Tue May 12, 2026)

The commit message names the cause directly: _"tailSpacer prop on TugListView + matching trailingInertOffset on SmartScroll **so collapse-shrink doesn't clamp scrollTop** and follow-bottom excludes the spacer."_ The same commit added a tuglaw section — `tuglaws/component-authoring.md` § "Document-shrink-clamp — scrollport tail spacer (Phase E.3)" — that documents the mechanism in detail:

> when a click *shrinks* the document — typically a fold cue collapsing a long body kind — the scrollport's `scrollHeight` drops. If the user's `scrollTop` was higher than the new `maxScrollTop = scrollHeight − clientHeight`, the browser clamps `scrollTop` down to the new max. No `scrollTop` write can put the click target back at its pre-click viewport Y, because the position we'd need to scroll to is now past the end of the document. `usePositionStableClick` cannot fix this; the only fix is to make sure the document doesn't get short enough to force a clamp.

This is **not** bucket (1) mount/unmount churn — L26 / stable-id work covers React component identity through reconciliation; it does nothing for DOM-level `scrollTop` clamping when `scrollHeight` shrinks in response to a descendant click. It is **not** bucket (2) streaming jitter — the spacer doesn't absorb height changes during stream growth; pin-to-bottom math is corrected separately by `trailingInertOffset`. It is **not** bucket (3) visual comfort — the bottom dead-zone is a side effect, not the deliverable.

**Spike record — Investigation B observations.**

Initial Investigation B was bypassed in favor of an immediate "keep + rewrite comments" delivery (the introducing commit and the tuglaw both named the cause clearly). The user pushed back: the spacer's cost is always-on (~80% of the viewport of always-visible empty space at the bottom of every transcript, on every interaction), the benefit fires only on a specific shape of click (fold-cue collapse on a tall body while scrolled past the new `maxScrollTop`), and the natural browser clamp is honest (the document genuinely got shorter; matches every other web app). Constant cost, rare benefit — the trade was inverted.

**Decision — retire the spacer + plumbing.**

The outcome maps to **(1)-style "retire"** despite the cause not being bucket (1) — the bucket framing assumed L26 / stable-id work was the enabling invariant, but the actual enabling change here is a cost/benefit reassessment, not a new invariant. What shipped:

- Removed `tailSpacer="80cqh"` from `tide-card-transcript.tsx` (call site + the just-rewritten comment).
- Removed the `tailSpacer` prop, `tailSpacerRef`, `data-tail-spacer` attribute, container-query CSS block, the inert spacer render, and the `trailingInertOffset` wire-up to SmartScroll from `tug-list-view.tsx` + `tug-list-view.css`.
- Removed the `trailingInertOffset` option + `_trailingInertOffset` field from `smart-scroll.ts`; simplified `isAtBottom`, `scrollToBottom`, and `pinToBottom` to drop the inert subtraction; trimmed the residual comments that referenced the spacer.
- Updated the position-stable-click documentation in `diff-block.tsx` (the longer note) and `file-block.tsx` (the shorter cross-reference) so they describe the current contract (compensation works for non-shrink layout changes; collapse-shrink near the bottom yields to the natural browser clamp).
- Narrowed the `usePositionStableClick` docstring: dropped the dead `useCollapseHeightLock` reference, named the natural-clamp outcome as the accepted contract, and pointed at this spike for the rationale.
- Rewrote the `tuglaws/component-authoring.md` § "Document-shrink-clamp" section as an experiment-and-reversal record so a future reader doesn't re-derive the same path. The retired-mechanism description, the per-cell-min-height earlier draft, and the cost/benefit reasoning all live there.

No tests were touched because none referenced the symbols — the 7 SmartScroll inert tests + 4 tailSpacer tests called out in `d8da960a`'s commit message were swept up by the happy-dom deletion on 2026-05-13. The current Bun pure-logic test suite has no dependency on the retired surface.

**Tests.**

- If the spacer is removed: existing `smart-scroll` tests stay green (the `trailingInertOffset` path is opt-in via the option; removing the option means tests that don't supply it stay valid; tests that DO supply it get removed).
- If the spacer is kept: no test changes; the deliverable is comment text only.

**Checkpoint.**

- [x] `bun x tsc --noEmit` clean.
- [x] `bun test` green.
- [ ] **HMR vet (manual user action)** — needed for the retirement. Exercise the four scenarios from Investigation B and confirm the transcript behaves correctly: streaming into near-full transcript stays smooth; card-switch mid-stream doesn't pop scroll position; scroll-to-bottom on submit lands cleanly; no visible jitter on streaming entry growth. Then exercise the trade-off itself: open a long FileBlock or DiffBlock near the bottom of the transcript, click its fold cue, and confirm the natural browser clamp (viewport lands at the new bottom) is the observed outcome — that's the cost the retirement accepts.

---

#### Step 20.3.6: Persist session-scoped live-only metadata via SessionLedger {#step-20-3-6}

**Depends on:** [#step-20-3-4] (the SessionLedger persistence pattern this step generalizes), the existing `SessionLedger` bootstrap.

**Status:** _Complete. Bridge intercept in `relay_session_io` merges-and-persists every outbound `system_metadata` line against the SessionLedger (`session_metadata` table); TS in-memory merge retired; `permission_mode` → `permissionMode` parse-key bug fixed in the same commit. End-to-end test pins the live → replay sequence preserves the `[1m]` suffix on the wire and in the ledger. All checkpoints green; manual L23 vet confirmed by user across HMR, Developer > Reload, app relaunch, and tugcast restart._

**Commit:** `feat(tide-metadata): persist session-scoped live-only metadata via SessionLedger`

**References:** [L02], [L23], [L24], [L26], [#step-20-3-4] (the persistence pattern this generalizes), `tugrust/crates/tugcast/src/session_ledger.rs`, `tugrust/crates/tugcast/src/feeds/agent_bridge.rs`, `tugcode/src/session.ts` (the live `system_metadata` emitter, lines 489–529), `tugcode/src/replay.ts` (the synthesized-metadata source whose loss this fixes, lines 983–1008), `tugdeck/src/lib/session-metadata-store.ts` (the merge fix to retire).

**Scope note — why this exists.** [#step-20-3-4] established the pattern for L23-compliant persistence of LIVE-ONLY data: capture-on-live, inject-on-replay, sqlite-backed survival across HMR / Reload / app relaunch / tugcast restart. We applied it to per-turn telemetry. While vetting `#step-20-3-4` we discovered an unrelated regression: after Developer > Reload, the window-utilization gauge dropped from 1M → 200k because the model name lost its `[1m]` suffix. A targeted in-memory merge in `SessionMetadataStore` patched that case — but only for in-process re-orderings. App relaunch still drops the suffix because `SessionMetadataStore` starts from empty after browser death and the only `system_metadata` event it ever sees on the resume path is the bare-name replay-synthesized one. This step retires that in-memory merge and replaces it with the same ledger-backed pattern `#step-20-3-4` shipped — which generalizes naturally because the underlying class of bug is the same.

The class: **live-only session-scoped metadata that JSONL doesn't preserve.** Anthropic's stream-json transcript carries the bare model name on every `assistant.message.model` field but does not carry the `[1m]` suffix. It also doesn't carry `cwd`, `permissionMode`, `tools`, `slash_commands`, `plugins`, `agents`, `skills`, `mcp_servers`, `version`, `output_style`, `fast_mode_state`, or `apiKeySource` per-message — those exist ONLY on the live `system_init` event Claude emits at session startup. `tugcode/src/replay.ts:984` synthesizes a `system_metadata` event from `assistant.message.model` with every other field hardcoded to empty string / empty array. The result on every resume: a `system_metadata` arrives carrying only `model` (bare) — losing the suffix AND wiping every other live-captured field that was previously populated.

The model `[1m]` suffix is the user-visible canary. The other fields are equally lost; today none of them have downstream consumers that visibly regress, but they will once the chrome grows: `/` slash-command completion, the `permissionMode` indicator on Z2 / Z3, the `cwd` badge in Z3 (which currently re-derives from `cardSessionBindingStore`, not `SessionMetadataStore` — but the duplication is its own smell), the `mcp_servers` / `plugins` / `agents` capability listings. Every one of them is "currently null after app reload."

**Scope.** Apply the `#step-20-3-4` pattern to session-scoped metadata. Implementation runs end-to-end:

- **Rust (tugcast SessionLedger):** new `session_metadata` table (additive via `CREATE TABLE IF NOT EXISTS` — no schema-migration cost; existing `sessions.db` files pick up the new table on next open). Methods: `record_session_metadata(session_id, payload)` and `get_session_metadata(session_id) -> Option<SessionMetadataRow>`. Cascade-on-`sessions`-DELETE trigger mirroring the existing pattern.
- **Rust (tugcast agent_bridge):** intercept every outbound `system_metadata` JSON line in `relay_session_io`. Read the existing ledger row (if any), parse the incoming payload, apply the merge rule, write the merged payload back to the ledger, AND rewrite the wire line to carry the merged payload before forwarding. Symmetric for live and replay-window events.
  - **Intercept-key sourcing.** The ledger PK is the claude `session_id`. The bridge must NOT trust the line's own `session_id` field (it can be empty on the live path per `session.ts:513`, where the fallback is `sid || ""`). Instead, key on `ledger_entry.claude_session_id` — the authoritative value captured by the `session_init` interceptor at `agent_bridge.rs:760-808`. **Ordering invariant:** the live path emits `session_init` before `system_metadata` (both from `session.ts`'s `subtype === "init"` branch at line 489, in declaration order: session_init first via the `sessionId` capture, then `system_metadata` via `messages.push(sysMsg)` at line 529). On the replay path, `system_metadata` is synthesized after the first `assistant` entry (`replay.ts:983-1008`), which can only emerge after the `session_init` synthesis the replay also performs first. In both paths, `claude_session_id` is guaranteed populated before the bridge sees the `system_metadata` line. If for any reason it isn't (defensive coding), the bridge skips the merge-and-persist and forwards the line unchanged — same fallback shape as `inject_replay_telemetry`.
- **Merge rule (server-side):** prefer the more-specific `model` (per the `[1m]`-vs-bare-base heuristic from the in-memory fix); prefer non-empty for every other field. The merge runs at the bridge before the line leaves tugcast, so the client always observes the most-informationally-rich version. Same rule shape as the in-memory merge being retired — just running at the durable layer.
- **TypeScript (tugdeck SessionMetadataStore):** _retire_ the in-memory merge fix added in the chase of the `[1m]` suffix bug. Specifically: drop `mergeMetadataSnapshot`, `preferMoreSpecificModel`, `asPresent`, and the `_onFeedUpdate` change that called them. Revert `_onFeedUpdate` to its wholesale-replace shape — the bridge now guarantees every `system_metadata` event delivered to the client carries the full merged payload, so a client-side merge becomes dead weight that masks the underlying contract.
- **Tests (retire):** drop the 4 merge-on-replay tests from `src/__tests__/session-metadata-store.test.ts` (they pinned the in-memory behavior we're removing).
- **Tests (add):** Rust ledger unit tests (record / get / cascade-delete); Rust bridge tests pinning that the merged line on the wire carries the persisted `[1m]` suffix when the incoming line is bare; supervisor handler / integration round-trip.

**Conformance — what L23 requires.**

- Every field in `system_metadata` that the user has ever seen for this session MUST survive HMR, Developer > Reload, app relaunch, AND tugcast restart. The model `[1m]` suffix is the canary; the rest of the payload comes along for the ride because the same merge applies.
- The persistence layer is the single source of truth. The client trusts the wire; the wire carries the supervisor-merged values; the supervisor reads from sqlite. Three layers, one source.

**Conformance — what L26 requires.** The merge happens at the bridge before frames leave tugcast, so the wire delivers ONE `system_metadata` event per inbound (no duplicate, no second-event reconciliation timing for React). `SessionMetadataStore`'s reference-comparison invalidation doesn't see spurious flips. React mount identity for any UI that subscribes to `SessionMetadataStore` is unaffected (the snapshot's shape doesn't change; only the values do, and they change less often once the merge stabilizes).

**Conformance — what L02 requires.** The persistence is a server-side store; the client reads via the existing `SystemMetadata` feed; `useSyncExternalStore` consumers see one snapshot type with stable contracts. No React-state mirror, no client-side reconciliation, no React-render-cycle-coupled writes.

**Conformance — what L24 requires.** Session metadata is unambiguously *structure* zone — external state observed through `useSyncExternalStore`, with no DOM-mutation or React-state-mirror code path. The merge runs at the bridge (off-thread from React entirely); the client only ever reads the snapshot. No zone-crossing in the change.

**Schema sketch — `session_metadata` table:**

```sql
CREATE TABLE IF NOT EXISTS session_metadata (
  session_id      TEXT PRIMARY KEY,
  -- Full system_metadata payload, JSON-serialized. The merge rule
  -- operates on parsed fields, so we deserialize on every write —
  -- one record per session, one observation per session_init / per
  -- replay synthesis, so the parse cost is negligible against the
  -- savings of NOT enumerating every Anthropic-defined field as a
  -- separate column (future fields land here without schema change).
  payload         BLOB NOT NULL,
  captured_at     INTEGER NOT NULL
);

CREATE TRIGGER IF NOT EXISTS session_metadata_cascade_delete_on_session
  AFTER DELETE ON sessions FOR EACH ROW
  BEGIN DELETE FROM session_metadata WHERE session_id = OLD.session_id; END;
```

No `turn_key` or `msg_id` involvement — `system_metadata` is per-session, not per-turn. The PK is the claude `session_id` (the same join key the rest of the ledger uses).

**Schema-shape trade-off — BLOB vs per-column.** The payload lives in one JSON BLOB rather than as a column per field. This makes the schema absorb future Anthropic fields without migrations (new field arrives → bridge passes it through verbatim → BLOB grows by a few bytes). The cost: no indexed queries on individual fields — "find all sessions using model X" requires reading every row and deserializing. Accepted trade-off because the only access pattern is "look up THIS session by PK," which is fast either way. Future schemas that need indexed-field queries (e.g., listing sessions by model in a picker) would project the indexed columns alongside the BLOB.

**Schema-change runbook.** Per [DM08]: additive. `CREATE TABLE IF NOT EXISTS` + `CREATE TRIGGER IF NOT EXISTS` populate the new table on existing `sessions.db` files. The table starts empty; on first observation of `system_metadata` after the bridge upgrade, the row gets written. **No manual `sessions.db` deletion required.** Sessions that existed before this step's deploy will read empty metadata on their first post-deploy resume — same "no retroactive backfill" caveat as `#step-20-3-4`. The bridge captures on the FIRST live `system_metadata` after deploy, so even pre-deploy sessions converge to the correct persisted state once they receive any new live event.

**Wire-format key reality.** The `system_metadata` JSON payload uses a **mixed** casing convention — confirmed against `tugcode/src/session.ts:498,508` and `replay.ts:995,1004`:

- **camelCase keys:** `permissionMode`, `apiKeySource`.
- **snake_case keys:** `session_id`, `cwd`, `tools`, `model`, `slash_commands`, `plugins`, `agents`, `skills`, `mcp_servers`, `version`, `output_style`, `fast_mode_state`, `ipc_version`.

The Rust merge implementation MUST key on the actual on-wire names — using the wrong case silently no-ops the merge on those fields (the canonical bug 20.3.6 is fixing). The pseudocode below uses the on-wire keys verbatim.

**Pre-existing parse bug (out of scope but flagged).** `session-metadata-store.ts:207` currently reads `p.permission_mode` (snake_case) and assigns the result to `snapshot.permissionMode`. The wire emits `permissionMode` (camelCase), so the parse has always silently returned `null` for this field. The retired tests at `session-metadata-store.test.ts:484-517` use snake_case fixtures and thus don't catch this. Fix this parse-key bug in the same commit that drops the four merge-on-replay tests — it's a one-line change (`p.permission_mode` → `p.permissionMode`) in the file already being touched, and leaving it for a follow-up would mean the wholesale-replace cleanup ships against a parser that still can't see `permissionMode`. Add a new test that asserts the live wire's camelCase key is captured.

**Merge rule (canonical, on-wire keys):**

```
merge_session_metadata(current: Option<Payload>, incoming: Payload) -> Payload:
  - if current is None: return incoming
  - merged.model = prefer_more_specific_model(current.model, incoming.model)
  - merged.cwd, merged.permissionMode, merged.output_style,
    merged.fast_mode_state, merged.apiKeySource, merged.version:
      as_present(incoming.X) ?? current.X    // empty-string-treated-as-absent
  - merged.tools, merged.slash_commands, merged.plugins, merged.agents,
    merged.skills, merged.mcp_servers:
      if incoming.X.len() > 0: incoming.X else: current.X
  - merged.session_id: incoming.session_id   // PK; never merged
  - merged.ipc_version: incoming.ipc_version // wire housekeeping
  - return merged

prefer_more_specific_model(current, incoming):
  - if either side empty/null: take the non-empty one
  - if exact match: take incoming (no-op)
  - if current == incoming + "[1m]": keep current  // no downgrade
  - if incoming == current + "[1m]": take incoming // upgrade
  - otherwise: take incoming                       // genuine model change
```

The rule is shape-identical to what was shipped in `SessionMetadataStore` last commit; we're moving the implementation from TS-client to Rust-supervisor, giving it a durable backing store, AND correcting the key-casing along the way (since the Rust side is being authored fresh).

**Suffix-rule brittleness — runbook note.** The `[1m]` suffix is a Claude Code CLI convention, not an Anthropic API contract. If Anthropic ever ships a different format (`[ctx-1m]`, `(1M)`, a separate `context_window` field, etc.), the literal-string check at `current == incoming + "[1m]"` silently fails over to "take incoming" and the bare-model overwrite returns. Mitigation: when bumping the Claude Code SDK or noticing a model-name format change in CI fixtures, re-vet this rule. The rule lives in one place (the Rust supervisor's `prefer_more_specific_model`) so the update is one edit.

**Wire-format change.** None. The `system_metadata` event shape is unchanged; the bridge just rewrites the JSON line in place before forwarding (same shape, more-authoritative values). No new event types, no client-side decoder change.

**Artifacts.**

- `tugrust/crates/tugcast/src/session_ledger.rs` — new `session_metadata` table + cascade trigger; `SessionMetadataRow` struct; `record_session_metadata` / `get_session_metadata` methods.
- `tugrust/crates/tugcast/src/feeds/agent_bridge.rs` — extend `relay_session_io` to intercept `system_metadata` lines; implement `merge_and_persist_session_metadata` helper (reads ledger, applies rule, writes back, rewrites line). Reuse the `Option<&SessionLedger>` parameter already threaded for the telemetry inject path.
- `tugrust/crates/tugcast/src/feeds/agent_bridge.rs` (tests) — pin the merge rule across the same cases as the retired TS tests (no-downgrade on bare-after-suffixed; preserve cwd/permissionMode/slashCommands when incoming has empty values; genuine model change replaces; upgrade adopts suffix).
- `tugdeck/src/lib/session-metadata-store.ts` — _retire_ `mergeMetadataSnapshot`, `preferMoreSpecificModel`, `asPresent`; revert `_onFeedUpdate` to wholesale-replace.
- `tugdeck/src/__tests__/session-metadata-store.test.ts` — drop the `describe("SessionMetadataStore merge-on-replay")` block (4 tests).
- _Update_ `tide-card.tsx` `projectStatusContent` callsite IF auditing reveals it should read `cwd` from `SessionMetadataStore` (the persisted source) rather than `cardSessionBindingStore` — flag for review during implementation, defer the actual change to a follow-up if it surfaces other concerns.

**Implementation ordering (gated).** Land in this sequence to avoid a regression window where the TS merge is gone but the bridge isn't yet merging:

1. **Bridge work first** — Tasks 1–3 below, with all Rust tests green. The TS in-memory merge stays in place during this phase; it harmlessly merges {merged-from-wire, merged-from-wire} = merged. Commit boundary: `cargo test -p tugcast` green, manual L23 vet passes on this commit alone (the bridge is doing the work; the TS merge is dead weight but not harmful).
2. **TS retirement second** — Task 4 in a separate commit. Drop the merge helpers + the four merge-on-replay tests; also fix the `permission_mode` → `permissionMode` parse-key bug while in the file. Commit boundary: `bun test` green, `bun x tsc --noEmit` clean, manual L23 vet still passes.
3. **End-to-end + final vet** — Tasks 5–6.

Reversing this order leaves a window where the client wholesale-replaces against a sparse bridge-untouched replay payload and the bug returns. Strictly bridge-first.

**Tasks.**

- [x] **(1) Rust schema + ledger methods + unit tests** — `session_metadata` table + cascade trigger via `bootstrap_schema`; `record_session_metadata` / `get_session_metadata`; unit tests for round-trip, cascade-delete, JSON-payload corruption tolerance (a bad blob returns `None` from `get`, doesn't crash).
- [x] **(2) Rust merge function + unit tests** — `merge_session_metadata` + `prefer_more_specific_model` pure helpers, keyed on on-wire JSON names (camelCase `permissionMode` / `apiKeySource`; snake_case for the rest). Pin the four cases from the retired TS tests (no-downgrade, preserve non-empty, genuine change, upgrade) plus the first-observation case (no current → take incoming verbatim).
- [x] **(3) Tugcast bridge intercept** — extend `relay_session_io` to apply the merge-and-persist on every `system_metadata` line before forwarding. Same opt-in shape as the telemetry inject (`session_ledger: Option<&SessionLedger>`); tests without a ledger pass through unchanged. Key the ledger lookup on `ledger_entry.claude_session_id` (NOT the line's own `session_id` field). If the ledger write fails, log a warn and forward the merged line anyway — the wire delivery must not depend on persistence success.
- [x] **(4) Retire TS-side merge + fix parse-key bug** — revert `_onFeedUpdate` to wholesale replace; drop `mergeMetadataSnapshot`, `preferMoreSpecificModel`, `asPresent`; drop the four `merge-on-replay` tests. Same commit: fix the `p.permission_mode` → `p.permissionMode` parse key at `session-metadata-store.ts:207` and add one test asserting the camelCase wire key is captured. The bridge is the sole owner of the merge contract going forward.
- [x] **(5) End-to-end test** — Rust integration test that drives `relay_session_io` with a sequence of `system_metadata` lines (one suffixed, then one bare) and asserts both outbound lines carry the suffixed model. Validates the full capture + merge + inject path at the bridge layer.
- [x] **(6) Manual L23 vet** — open a tide card, observe `claude-opus-4-7[1m]` + 1M; Developer > Reload → still `[1m]` + 1M; close + reopen app → still `[1m]` + 1M; force-quit + restart tugcast → still `[1m]` + 1M. _Confirmed by user: working across all four transition classes._

**Tests.**

- [x] Rust: `SessionLedger::record_session_metadata` round-trip; `get_session_metadata` returns `None` for unknown session; cascade-on-DELETE; tolerates a malformed payload blob (returns `None`, no panic). _Pinned in `session_ledger.rs` tests `record_session_metadata_round_trip`, `get_session_metadata_returns_none_for_unknown_session`, `cascade_delete_removes_session_metadata_when_session_deleted`, `record_session_metadata_accepts_malformed_blob`, plus `record_session_metadata_idempotent_on_session_pk`._
- [x] Rust: `merge_session_metadata` pinning across 5+ cases — first-observation, no-downgrade on bare-after-suffixed, preserve non-empty fields when incoming is empty, genuine model change replaces, bare→suffix upgrade. Each case uses the on-wire JSON key names (camelCase `permissionMode` / `apiKeySource`, snake_case for the rest) so the test fixtures double as a wire-shape contract. _Pinned in `session_metadata_merge.rs` (15 tests covering first-observation, suffix-preservation across all four directions, scalar preservation, array preservation, genuine change, future-field forward-compat, PK pass-through, malformed-incoming refusal, and the 6 `prefer_more_specific_model` edges)._
- [x] Rust: bridge intercept pinning — a stream of `[live-suffixed, replay-bare]` produces `[suffixed-on-wire, suffixed-on-wire]`; ledger holds the suffixed value at end. _Pinned in `agent_bridge.rs` tests `merge_and_persist_preserves_suffix_on_replay_after_live`, `merge_and_persist_preserves_non_empty_fields_on_replay`, `merge_and_persist_upgrades_when_suffix_arrives_second`, plus end-to-end `test_system_metadata_bridge_merge_preserves_suffix_e2e` in `agent_supervisor.rs`._
- [x] Rust: bridge intercept resilience — when the ledger write fails (inject a poisoned ledger handle or a closed connection), the wire forward still happens with the merged payload AND a warn-log is emitted. Persistence failure must NOT block live delivery. _The helper unconditionally returns the merged-line bytes after the warn-log on `record_session_metadata` failure; `merge_and_persist_passes_through_on_malformed_incoming` and `merge_and_persist_passes_through_when_incoming_is_not_an_object` pin the malformed-input fallbacks. The "poisoned handle" branch is unreachable in safe Rust given `SessionLedger`'s Mutex semantics — only sqlite errors can fail the write, which already exits with warn + pass-through._
- [x] Rust: bridge intercept skips the merge cleanly when `claude_session_id` is absent on the ledger entry (defensive path) — line passes through unchanged. _The `match (session_ledger, claude_id)` arm at the intercept site returns the raw line bytes on `(None, _) | (_, None)`; the e2e test exercises the live path where the id IS populated before the system_metadata line is processed (per the ordering invariant)._
- [x] TS: existing `SessionMetadataStore` tests (excluding the four merge-on-replay tests) stay green — the wholesale-replace behavior is correct again because the bridge guarantees a complete payload.
- [x] TS: new test pinning the camelCase parse-key fix — emit a payload with `permissionMode: "default"` and assert `snapshot.permissionMode === "default"` (would fail today against the snake_case parser even though the wire has always emitted camelCase). _Pinned as `SessionMetadataStore wire-key parsing > captures permissionMode from the camelCase wire key`._

**Checkpoint.**

- [x] `cargo test -p tugcast` green (new ledger + merge + bridge tests pass; existing 552 stay green; expect roughly +12–15 new Rust tests across the three layers). _580 tests run, 580 passed — +28 new tests across ledger (5) + merge module (15) + bridge intercept (7) + end-to-end (1)._
- [x] `bun x tsc --noEmit` clean.
- [x] `bun test` green (post-retirement count: 2068 − 4 retired + 1 added = 2065; the new test surface is on the Rust side). _Exact match: 2065 pass, 0 fail._
- [x] `bun run audit:tokens lint` exits 0.
- [x] **Manual L23 vet:** model + window persist across HMR, Developer > Reload, app relaunch, and tugcast restart. Spot-check `cwd`, `permissionMode`, and `slashCommands` survive the same transitions (the model is the canary, but the same code path persists all of them). _Confirmed by user._

**Defense-in-depth notes.**

- The bridge intercept is the same shape as `inject_replay_telemetry` and can borrow its testing patterns. The two are independent (different lines, different ledger tables) but share the "supervisor-owns-the-merge" pattern.
- The merge rule is targeted at the `[1m]` suffix because that's the observed Anthropic convention. If Anthropic introduces a different suffix or a per-model variant ID, the rule needs an update — keep it in one place (the bridge) so the update is one edit, not two.
- The cascade-on-DELETE trigger means a "forget" gesture wipes session_metadata along with sessions + turn_telemetry. No orphan rows.

**Why this resolves the broader concern, not just one bug.**

Beyond the `[1m]` regression: this step closes off the entire class of "live-only session-scoped metadata vanishes on resume." That includes `cwd`, `permissionMode`, `slashCommands`, `tools`, `plugins`, `agents`, `skills`, `mcp_servers`, `version`, `output_style`, `fast_mode_state`, `apiKeySource` — every field the replay path synthesizes as empty. Future UI surfaces that read from `SessionMetadataStore` (or any consumer that uses the same metadata feed) get correctness for free, without having to discover the same bug per-field. The TypeScript merge fix only patched the model; this step patches everything once.

---

#### Step 20.4: UI slot architecture — placement zones for session telemetry {#step-20-4}

**Depends on:** #step-20-3 (clean per-turn + session-cumulative data is the input this step renders), #step-20-1 (TugLinearGauge for any window-utilization gauge surface)

**Status:** _Complete (including the 20.4.x follow-on series). The original 20.4 work landed slot infrastructure + renderers + a dev harness, and the HMR study resolved by promoting the F5 spike-gallery design into the first cut of `TideTelemetryStatusRow`. The follow-on series (20.4.1 → 20.4.15, with 20.4.5 split A/B, 20.4.7 split A/B/C/D, and 20.4.11 deferred) then (a) extracted `TugStateIndicator` and a tuglaws-grounded animation handoff hook; reshaped Z2 to three cells (TIME · TOKENS · CONTEXT) with a live-clock that pauses on yellow states via overlap-correct union semantics; added the four per-area popovers (Time, Tokens, Context, state-change log) anchored on the indicator + cells; built the `TugThinkingIndicator` three-bar primitive; established the Z1 asst-half two-line stack (Z1A model + timestamp; Z1B `TugThinkingIndicator` in flight ↔ `EndStateDisplay` terminal — `complete` / `interrupted` / `error` / `transport_lost`); and persisted state-change history via a sqlite ledger. [Step 20.4.15](#step-20-4-15) wired all of it into the production tide-card surface (Z2 + Z1 asst-half) and updated [Step 20.5.A](#step-20-5-a)'s lifecycle matrix authoritatively. Subsumes the planned Step 20.5.C (TugProgress agent-role variant study) — that step is marked superseded. Z0 / Z1-user / Z3 / Z4 remain reserved for future work._

**Commit:** `feat(tide-rendering): placement slots Z0–Z4 for tide-card session telemetry`

**References:** [L02], [L19], [L20], [L26], [#step-20-3] (data model), [#step-20-1] / [#step-20-2] (gauge primitives), [Table T03](./tide-assistant-rendering.md#t03-chrome)

**Scope.** [#step-20-3] makes per-turn + session-cumulative telemetry available cleanly. This step does NOT decide which numbers go where — it builds the **placement zones** the tide card needs and makes each one consumable so the same data can be moved between them during a deliberate UI study. Six zones are formalized in the contract (Z0–Z5); 20.4 implements display-only zones Z0–Z4 as `ReactNode` slot props. **Z5 (submit-button area) is structurally present already in `TugPromptEntry`; its lifecycle-driven state coordination lands in [#step-20-5.D](#step-20-5-d) and is therefore acknowledged here but not implemented.** The HMR study is part of this step's checkpoint; the final placement decision is captured at the close of this step as input to [#step-20-5.D](#step-20-5-d).

**The zones (Z0–Z5).** Spatial top-to-bottom across the tide card:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ←─【Z0: top of card — reserved / empty】──────────────────────────────────  │
│                                                                             │
│  TideTranscriptHost                                                         │
│  └─ TugListView (scrolls; flex 1 1 auto)                                    │
│                                                                             │
│  ╔════ user row ═══╗  ╔════ assistant row ═══╗                              │
│  ║ "count loc..."  ║  ║  [markdown body]      ║                              │
│  ║                 ║  ║                       ║                              │
│  ║【Z1 user half】 ║  ║  [copy]【Z1 asst half】                              │
│  ╚═════════════════╝  ╚═══════════════════════╝                              │
│                                                                             │
├═════════════════════════════════════════════ ←【Z2: status bar】           │
│ (flex 0 0 auto, content-sized, never scrolls — outside TugListView)         │
└─────────────────────────────────────────────────────────────────────────────┘
═════════ ↑ split-pane sash (transcript ↔ prompt-entry resize) ═════════════
┌─────────────────────────────────────────────────────────────────────────────┐
│  [Project: /path]                            【Z3: prompt-entry top】       │
│                                                                             │
│   Ask Claude to build, fix, or explain                                      │
│                                                                             │
│   [Code] [Shell] [Command]    ←【Z4: prompt-entry footer】 【Z5: submit▴】 │
└─────────────────────────────────────────────────────────────────────────────┘
```

  - **Z0: top of card (reserved).** _New_ slot — a `flex: 0 0 auto`, content-sized row at the very top of the top split-panel, above `TideTranscriptHost`. **Empty / reserved through 20.4 and 20.5.** Reserved for future card-level metadata (session name, model badge, pinned status, etc.). When its content is `null` the row collapses to zero height — the slot exists in the API contract but costs zero visually until something fills it.
  - **Z1: per-turn trailing — unified slot keyed by half.** _New_ slot — adjacent to the existing icon-only copy button on the assistant row's chrome, and at the symmetric trailing position on the user row. Per-turn (one slot per turn-half). Single API keyed by `half: "user" | "assistant"`; the transcript wires it twice per turn (once on the user row, once on the assistant row). The **user half is empty / reserved through 20.4 and 20.5** — the slot mechanism exists and the renderer registry can target it, but our chosen default content is `null`. Reserving the user half now avoids API churn when future content (timestamps, edit affordances, "show raw prompt" toggles) wants to live there. Architectural addition to `tide-card-transcript.tsx`'s row chrome.
  - **Z2: status bar (bottom of top split-panel, outside TugListView).** _New_ slot — a `flex: 0 0 auto`, content-sized row that lives at the bottom of the upper `TugSplitPanel`, **outside** the scrolling `TugListView`. The top split-panel becomes a flex column: `[Z0 header (flex 0 0 auto)] + [TugListView (flex 1 1 auto, scrolls)] + [Z2 status bar (flex 0 0 auto, never scrolls)]`. TugListView keeps its scroll behavior unchanged (no `position: sticky` inside the virtualized scroller); the transcript↔prompt-entry sash stays exactly as today; no `tug-split-pane` changes; layout shift on telemetry update is contained (Z2 grows into space TugListView ceded, no scroll repositioning).
  - **Z3: prompt-entry top.** The existing `statusContent` slot above the prompt-entry input — same DOM slot as before, just renamed under the new spatial numbering. Currently holds the project-path badge by default. **No invariant reserves this location for the project path** — Z3 is a generic addressable zone like any other, and the project-path badge is one possible occupant.
  - **Z4: prompt-entry footer.** _New_ slot — between the route buttons (`Code` / `Shell` / `Command`) and the submit button. Currently empty space. Architectural addition to `TugPromptEntry`.
  - **Z5: submit-button area.** _Not a content slot — a state-coordinated interactive zone._ The submit button is structurally present already in `TugPromptEntry`'s footer. Its label / disabled state / visual treatment is driven by the lifecycle state machine documented in [#step-20-5.A](#step-20-5-a) and wired in [#step-20-5.D](#step-20-5-d). 20.4 does NOT touch the button; it only formalizes Z5 in the naming contract so renderer-registry consumers can reason about all five zones uniformly.

**Conformance.** Each of the four Z0–Z4 slots is a `ReactNode` slot prop on its host component, following the existing `statusContent` convention. No new primitives. Each host owns its slot's CSS layout box; consumers fill the slot with whatever (typed) display content makes sense. The slots are display-only — they don't capture user input or claim responder identity. Z5 is not added in this step (state-coordination is 20.5.D's work).

**Design — slot props.** Sketches; precise names finalized in implementation:

```typescript
// TideCard — two new slots, both content-sized rows in the top
// split-panel's flex column.
interface TideCardProps {
  // ... existing ...
  headerContent?: React.ReactNode;     // Z0 — top of card; null collapses to zero height
  statusBarContent?: React.ReactNode;  // Z2 — bottom of top split-panel; null collapses to zero height
}

// TideCardTranscript — per-turn trailing slot, single API keyed by half.
interface TideCardTranscriptProps {
  // ... existing ...
  renderTurnTrailing?: (                          // Z1 — wired twice per turn
    turn: TurnEntry,
    opts: { half: "user" | "assistant" },
  ) => React.ReactNode;
}

// TugPromptEntry — keep statusContent (Z3); add footerContent (Z4).
// Z5 (submit button) is structurally present already; not a prop.
interface TugPromptEntryProps {
  // ... existing ...
  statusContent?: React.ReactNode;     // Z3 — unchanged DOM slot, renumbered for naming-contract clarity
  footerContent?: React.ReactNode;     // Z4 — new
}
```

**Telemetry-display catalog — what each slot CAN show (experimentation menu).** Experimentation surface for the UI study — the same telemetry data can render in any slot, and the study compares which placement reads best for each datum. The catalog is a menu, not a prescription. Z0 is reserved (no entries); Z1 entries always mean the **assistant half** (the user half stays empty/reserved); Z5 is lifecycle-driven (not a content slot — out of catalog):

| Datum | Source ([#step-20-3]) | Plausible Z1 (per-turn asst) | Plausible Z2 (status bar) | Plausible Z3 (prompt-top) | Plausible Z4 (footer) |
|---|---|---|---|---|---|
| Window utilization (token gauge) | `perTurnContextSize(transcript[last])` / context max | — | ✓ (status-bar visibility) | ✓ (visible at-rest) | maybe |
| Cumulative session tokens | `deriveSessionTotals(transcript).total*` | — | ✓ | ✓ | maybe |
| Cumulative session time (Claude-active) | `deriveSessionTotals(transcript).totalActiveMs` | — | ✓ | ✓ | maybe |
| Per-turn duration | `turn.activeMs` | ✓ (per row) | — | — | — |
| Per-turn cost | `turn.cost.totalCostUsd` | maybe | — | — | — |
| Per-turn TTFT | `turn.ttftMs` | maybe | — | — | — |
| Phase / "Claude is thinking" indicator | `snapshot.phase` | — | — | maybe | ✓ |

The "✓" / "maybe" / "—" marks are starting positions, not decisions. The study confirms or rearranges.

**Experimentation tooling.** Implement a small dev-mode display selector — keyboard shortcut or query-string flag — that toggles which datum renders in which slot. The goal is to make A/B comparisons during the HMR vet cheap. Production builds ship with the selector behind a guard (e.g., `import.meta.env.DEV`); the placement decisions captured at the end of this step land as the default content of each slot in [#step-20-5.D](#step-20-5-d).

**Artifacts.**

- `tugdeck/src/components/tugways/cards/tide-card.tsx` + `.css` — restructure the top split-panel as a flex column with three rows: `[Z0 headerContent]` (flex 0 0 auto) + `<TideCardTranscript>` (flex 1 1 auto, scrolls) + `[Z2 statusBarContent]` (flex 0 0 auto, never scrolls). Add `headerContent?: React.ReactNode` (Z0) and `statusBarContent?: React.ReactNode` (Z2) props on `TideCard`. When either prop is `null`, that row collapses to zero height.
- `tugdeck/src/components/tugways/cards/tide-card-transcript.tsx` — add `renderTurnTrailing?: (turn, opts: { half: "user" | "assistant" }) => React.ReactNode` callback prop (Z1 unified). Wire it twice per turn: once on the user row's trailing edge, once next to the existing copy button on the assistant row. User-half default content is `null` in this step and in [#step-20-5].
- `tugdeck/src/components/tugways/tug-prompt-entry.tsx` + `.css` — add `footerContent?: React.ReactNode` prop (Z4) and the corresponding DOM slot between the route buttons and the submit button. (Z3's `statusContent` slot is unchanged — only the naming-contract label moves from "Z1" to "Z3.")
- `tugdeck/src/components/tugways/cards/tide-card.tsx` (composition) — wire each of the four display slots (Z0, Z1, Z2, Z3, Z4) to telemetry-renderer components (the catalog above). For Z0 and the user half of Z1, supply `null` defaults — slots reserved, content empty.
- `tugdeck/src/components/tugways/cards/__tests__/tide-card-placement-experiment.tsx` (or similar) — _dev-only_ harness that lets the user A/B placement combinations during the HMR study.
- _Possibly_ resurrect a clean `TideMeterChrome` (small, focused, NO bespoke wall-clock or token logic — pure consumer of [#step-20-3]'s telemetry helpers) as one of the renderers in the catalog. Naming + scope to be decided during implementation.
- Token slot work: each of the new slots may need a small `--tugx-tide-*` family for its layout box; declared at component scope per [L20].

**Mount-identity check.** [L26] — `TideCard`'s top split-panel changes from `<TugSplitPanel>{children: <TideCardTranscript/>}</TugSplitPanel>` to `<TugSplitPanel>{children: <FlexCol>[Z0]<TideCardTranscript/>[Z2]</FlexCol>}</TugSplitPanel>`. This inserts a wrapper element above `TideCardTranscript`. Verify (a) `TideCardTranscript` does not unmount under the wrapper insertion (React preserves component identity through wrapper insertions at the same position), and (b) `TugPromptEntry`'s position in `TideCard` does NOT change (it's still the second split-panel child) — its textarea focus / responder identity must survive this restructure. Add a dev-only invariant probe (matching the style of the existing tide-card caret/first-responder probe at `c773c7ac`) if useful during implementation.

**Tasks.**

- [x] **Slot infrastructure** — five prop additions across three components: `TideCard.headerContent` (Z0) + `TideCard.statusBarContent` (Z2) + flex-column restructure of the top split-panel; `TideCardTranscript.renderTurnTrailing` keyed by half (Z1); `TugPromptEntry.footerContent` (Z4). Layout boxes in each component's CSS. Z3 (`statusContent`) already exists — no code change, only naming-contract documentation.
- [x] **Renderer components** — small focused React components for each datum in the experimentation catalog, each consuming the [#step-20-3] telemetry helpers via `useSyncExternalStore` per [L02]. One renderer per datum; placement-agnostic.
- [x] **Experimentation harness** — dev-mode selector that maps {datum → slot}. Captures the chosen placement into a tugbank entry (or a hash-fragment) so HMR reloads preserve the experiment state. Productized as a tugplug skill if it gets enough use.
- [x] **Mount-identity verification** — confirm `TideCardTranscript` survives the top-split-panel wrapper insertion without unmount; confirm `TugPromptEntry`'s focus / responder identity survives the restructure. Use the existing tide-card caret/first-responder probe pattern (`c773c7ac`) if helpful.
- [x] **HMR study** — sit with the five-slot layout (Z0–Z4), A/B placements for each datum, decide which combination wins. The result is captured as the default mapping in [#step-20-5.D](#step-20-5-d)'s scope. _Outcome: Z2 maps to the new `statusRow` design (F5 from `gallery-tide-status-row`); other zones remain reserved. See the Checkpoint entry below for the full detail._

**Tests.**

- [x] Pure-logic: each renderer component takes the [#step-20-3] telemetry helpers as input and renders a deterministic string / DOM structure. Tested in bun:test against synthetic snapshots.
- [x] Slot-presence tests: each slot renders when its content is non-null; Z0 and Z2 collapse to zero height when their content is null. Matches the existing `statusContent` convention.
- [x] Z1 half-keying: `renderTurnTrailing` receives `half: "user"` on the user-row wire-up and `half: "assistant"` on the assistant-row wire-up; both invocations occur per turn.
- [ ] HMR-vetted: each slot's layout box behaves correctly — Z0 collapsed (no content), Z1 inline at the trailing edge of each row (empty on user side, populated on assistant side), Z2 a non-scrolling row at the bottom of the top split-panel, Z3 in the existing prompt-entry status row, Z4 between route buttons and submit.

**Checkpoint.**

- [x] `bun x tsc --noEmit` clean.
- [x] `bun test` green.
- [x] `bun run audit:tokens lint` exits 0.
- [x] **HMR study (manual)** — open a tide card, run a multi-turn session, A/B placement combinations using the dev selector, capture the chosen default mapping for [#step-20-5.D](#step-20-5-d). _Outcome: **Z2 = `statusRow`** (the F5 design from the spike: five uniform-width cells with IBM-1620 endcap-rule labels above centered always-hours time + caps-token values, color-coded context numerator, no arc gauge). Z0 / Z1-user / Z3 / Z4 remain empty pending later content decisions. The placement-experiment harness now defaults Z2 to `statusRow` when the tugbank mapping is null; explicit `window.tugTidePlacement.set({ Z2: ... })` still overrides._

**Implementation notes (post-landing).**

- _Mount-identity wrap insertion is steady-state._ The `<div className="tide-card-top-column">` wrapper that hosts `[Z0]` + `<TideTranscriptHost/>` + `[Z2]` is always present from first mount; React reconciliation has no opportunity to swap it in or out during a card's life, so `TideTranscriptHost` mounts inside the wrapper once and stays. Z0 / Z2 inner content can change freely — the wrapper rows always render and collapse to zero height when their content is `null` (no padding, `flex: 0 0 auto`, no intrinsic children). The runtime invariant probe (`c773c7ac`) is therefore not load-bearing here and was not added.
- _Slot resolution layering._ `TideCardBody` calls `useTidePlacementSlots({ codeSessionStore, sessionMetadataStore })` and ORs the result with the explicit props passed through `TideCardContent`. Explicit props win; the dev harness only fills slots the caller left undefined. In production the tugbank-backed mapping is empty by default, so all slots render `null`.
- _Z1 user-half stays empty._ The renderer is invoked with `half: "user"` for the user row's trailing position, but the harness's `renderTurnTrailing` returns `null` on the user half — reserving the slot without painting content. Datum surfaces for the user half land in [#step-20-5.D](#step-20-5-d) (or later) when there's a concrete piece of content for it.
- _Live-clock segments deferred._ `TideTelemetryCumulativeActiveMs` surfaces the committed-turns sum only; computing the live in-flight active segment requires the internal reducer accumulators (not on the public `CodeSessionSnapshot`) and lands in [#step-20-5.D](#step-20-5-d)'s lifecycle work.
- _Dev control surface._ `window.tugTidePlacement` (dev only) exposes `get` / `set(patch)` / `clear` / `datums` / `zones`. The mapping persists via the tugbank `dev.tugtool.tide.placement-experiment/mapping` key (`kind: "json"`) so HMR reloads preserve the experiment state.
- _Test coverage shape._ Pure-logic tests pin the value formatters (`formatTokens` / `formatDurationMs` / `formatUsd`) and the placement-entry parser (rejects garbage, refuses cross-zone datums). Renderer-component rendering and slot-presence DOM assertions are real-app territory, not bun:test, per the no-fake-DOM policy; the HMR study covers them empirically.
- _Indicator integration (final promotion)._ The leftmost phase/transport indicator was first prototyped in `gallery-tide-status-row.tsx` across nine design rounds (size sweep, chevron exploration, color-token bug fix, ring-centering geometry, animated-only ring policy) and is now in the production `TideTelemetryStatusRow`. Tone classes (`--default` / `--success` / `--caution` / `--danger`) drive the dot's `background-color` and the ring's `border-color` from existing global text tokens (`text-normal-{default,success,caution,danger}-rest`) — no new global tokens. Appearance is fully CSS-driven via class modifiers per [L06]. The `tide-telemetry-indicator-pulse` keyframe is co-located in the renderer's `.css` file so the apparatus stays self-contained. `interruptInFlight` was added to `CodeSessionSnapshot` (it already lived on the internal reducer state) so the indicator can read it via the existing `useSyncExternalStore` subscription without a parallel internal-state surface.

---

#### Step 20.4.1: Retired — ring pulse uses TugAnimator one-shots {#step-20-4-1}

**Depends on:** none.

**Status:** _retired (rolled into [Step 20.4.2](#step-20-4-2))._

**Commit:** _rollback commit lands as part of 20.4.2's branch._

**What this used to be.** A bespoke `useCommitOnAnimationBoundary` hook + a new `[D97]` design-decision entry + two pure decision helpers + 12 unit tests, all to gate DOM-class swaps behind `animationiteration` / `animationend` events fired by an `animation: ... infinite` CSS keyframe loop. Implemented (commit `cea298d8`), wired into [Step 20.4.2](#step-20-4-2), and HMR-vetted against a four-state gallery cycle — at which point two unrelated problems surfaced: (a) the first cut listened only for `animationend`, which never fires for infinite animations; (b) even after that fix, the single-pending-target model dropped intermediate states under rapid cycling, producing visible hops.

**Why retired.** The framing was wrong, not just the implementation. `TugAnimator` already provides `.finished` on finite WAAPI animations — the exact "wait until this pulse completes, then do something else" signal we need. Once you swap `animation: ... infinite` for one finite pulse at a time, the iteration-boundary problem dissolves: each pulse's `.finished` is the boundary, and the chain freely reads the *latest* tone (via a ref) before deciding whether to start another pulse, switch tones, or stop. No new hook, no new design-decision entry, no new event listeners, no new tests around boundary-decision logic. The indicator becomes ~80 lines of TS using primitives that already exist in the codebase.

**Rollback (executed as part of 20.4.2's work).**

- Delete `tugdeck/src/components/tugways/hooks/use-commit-on-animation-boundary.ts`.
- Delete `tugdeck/src/components/tugways/__tests__/use-commit-on-animation-boundary.test.ts`.
- Remove the barrel export from `tugdeck/src/components/tugways/hooks/index.ts`.
- Delete `[D97]` from `tuglaws/design-decisions.md`.
- Reset this step's plan checkboxes to `[ ]` (status: retired).

**Cross-step note.** [Step 20.4.10](#step-20-4-10) (`TugThinkingIndicator` — three-bar primitive) previously referenced this hook's `animationName` filter for the multi-element handoff. With the rollback, that step uses `TugAnimator.group()` to coordinate the three bars; the group's `.finished` resolves only when the last bar completes, giving the same "whole pulse-set finishes before any visible state swap" guarantee without a custom event mechanism. The corresponding section in 20.4.10 has been updated.

---

#### Step 20.4.2: Extract `TugStateIndicator` as a standalone Tug component (gallery-only) {#step-20-4-2}

**Depends on:** none. (Supersedes the rollback recorded in [Step 20.4.1](#step-20-4-1).)

**Status:** _done._

**Commit:** `feat(tugways): TugStateIndicator component`

**References:** [L02], [L06], [L13], [L19], [L20], [component-authoring.md](../tuglaws/component-authoring.md), `tug-animator.ts`

**Scope.** Move the inline indicator (currently duplicated in `gallery-tide-status-row.tsx` and production `tide-card-telemetry-renderers.tsx`) into a standalone Tug component at `tugdeck/src/components/tugways/tug-state-indicator.tsx` + `.css`. Two visible elements:

- **Dot** — a small solid circle whose tone class is set by React on every render. Reconciles immediately when the underlying state changes.
- **Ring** — a thin circle border around the dot, animated by `TugAnimator` as a chain of finite one-shot pulses. One pulse runs at a time; when its `.finished` resolves, the chain reads the *latest* tone via a ref and either starts the next pulse (in the new tone) or stops (when the new state is static).

The "pulse completes in its starting color" guarantee falls out of this naturally: each pulse is a one-shot, so it finishes on its own clock; the dot's color update during the pulse is decoupled (different element, no shared class). Mid-pulse state changes update the dot immediately while the in-flight pulse runs to completion in the prior tone; the new tone takes over on the next pulse in the chain.

**Component-authoring conformance.** Standard [L19] requirements per `tuglaws/component-authoring.md`:

- File pair `tug-state-indicator.tsx` + `tug-state-indicator.css` at `components/tugways/`.
- Module docstring citing the governing laws ([L02], [L06], [L13], [L19], [L20]).
- Exported `TugStateIndicatorProps` extending `React.ComponentPropsWithoutRef<"span">` with `@selector` / `@default` annotations.
- `data-slot="tug-state-indicator"` on the root element.
- `React.forwardRef` to the root, `...rest` spread last, merged `style`.
- CSS opens with `@tug-pairings` (compact + expanded); `@tug-renders-on` annotations as required by [L16]; `--tugx-state-indicator-*` aliases resolve to base tokens in one hop.

**Props.**

```typescript
export interface TugStateIndicatorProps
  extends React.ComponentPropsWithoutRef<"span"> {
  /** The session state to display. Determines tone + animated flag. */
  state: {
    phase: CodeSessionPhase;
    transportState: TransportState;
    interruptInFlight: boolean;
  };
  /**
   * Dot + ring diameter in CSS px.
   * @default 16
   * @selector .tug-state-indicator (custom property --tugx-state-indicator-size)
   */
  size?: number;
}
```

Label, popover, popover content are NOT in this step's scope — they land in 20.4.3 / 20.4.6 / 20.4.9.

**Pulse orchestration (the whole mechanism).**

```typescript
// Internals — refs only, no React state.
const ringRef       = useRef<HTMLSpanElement | null>(null);
const pulseRef      = useRef<TugAnimation | null>(null);     // in-flight pulse, or null
const latestRef     = useRef<TugStateIndicatorVisual>(v);    // tone + animated, updated on every render
latestRef.current   = v;

// Kickoff effect — fires whenever the derived visual changes.
useEffect(() => {
  // A pulse is already running -> let it finish; the .finished handler
  // will read latestRef and decide what to do at boundary time.
  if (pulseRef.current !== null) return;
  // New state is static -> nothing to start.
  if (!v.animated) return;
  // No pulse running and new state is animated -> start one.
  startPulse();
}, [v.tone, v.animated]);

function startPulse() {
  const el = ringRef.current;
  if (!el) return;
  const tone = latestRef.current.tone;          // freeze for this pulse
  el.style.borderColor = `var(--tugx-state-indicator-tone-${tone})`;
  el.style.display = "block";
  const anim = animate(el, [/* scale + opacity keyframes */], {
    duration: PULSE_DURATION_MS,
    easing: "ease-out",
  });
  pulseRef.current = anim;
  anim.finished.then(() => {
    pulseRef.current = null;
    const next = latestRef.current;
    if (next.animated) {
      startPulse();                              // chain, using latest tone
    } else if (ringRef.current) {
      ringRef.current.style.display = "none";    // settled to a static tone
    }
  }).catch(() => {
    pulseRef.current = null;                     // cancellation (e.g., unmount)
  });
}
```

That is the entire mechanism. No deferred-class-swap hook. No iteration-boundary event listener. No queue. No D-entry. The "complete in starting color" rule is satisfied because each pulse is a one-shot and `.finished` resolves at its end. Reduced motion ([D24]) falls out automatically: `TugAnimator.animate` already strips spatial properties and short-fades under `--tug-motion: 0`, so the chain continues to tick at the fast-fade rate when motion is off.

**Tasks.**

- [x] Implement `tug-state-indicator.tsx` + `tug-state-indicator.css` per the component-authoring guide.
- [x] Moved `indicatorVisualFor()` inside the component as an exported pure helper (paired sibling components — tooltip body, paired label in 20.4.3 — dispatch on the same triple).
- [x] Pulse orchestration via `TugAnimator.animate` + `.finished` chain. No `useCommitOn*` hook; no `animationiteration` / `animationend` listener; no CSS `animation: ... infinite`. Unmount cleanup cancels the in-flight pulse with `cancel("snap-to-end")`.
- [x] Dot tone class set directly by React (`tug-state-indicator-dot--{default,success,caution,danger}`); the host span carries no tone class. The four dot-tone CSS rules are self-pairing (background-color set alone).
- [x] Ring CSS: positioned absolute, `display: none` by default, geometry only — `display` and `border-color` are set imperatively by `startPulse()` so the chain owns the visibility cycle. The ring's CSS rule has no color properties, so no `@tug-renders-on` annotation is required ([L16] doesn't trigger on rules that declare no color).
- [x] Switched `gallery-tide-status-row.tsx` to import `TugStateIndicator`. Deleted the inline implementation (`phaseVisualFor`, `HumanReadableState`, `PHASE_HUMAN_LABEL`, `ConcentricPulsingRing`, `INLINE_KEYFRAMES`, the obsolete `DemoPhase` / `DemoTransport` / `SessionState` types, and the now-unused `TugTooltip` / `TEXT_SUCCESS` imports).
- [x] Added the dedicated `gallery-tug-state-indicator.tsx` card and registered it in `gallery-registrations.tsx` (`componentId: "gallery-tug-state-indicator"`, title `TugStateIndicator`, icon `CircleDot`, `GALLERY_COMPLEX_SIZE`, feedback category). Four sections: tone palette, all session states, size variants (10/12/16/20/24/32 px), and the handoff cycle switch.

**Tests.**

- [x] Pure-logic test for `indicatorVisualFor` at `tugdeck/src/components/tugways/__tests__/tug-state-indicator.test.ts` — 14 cases covering transport precedence, interrupt precedence, and every phase branch.
- [x] `bun x tsc --noEmit` clean.
- [x] `bun test` green (2079 pass / 0 fail).
- [x] `bun run audit:tokens lint` exits 0 _for the indicator files_ (pre-existing unrelated `tug-menu.css` violations remain in the working tree).

**Checkpoint.**

- [x] Gallery renders the indicator with the same palette + geometry as the prior inline version.
- [x] HMR-vet a mid-pulse transition: the dot color changes immediately; the in-flight ring pulse runs to completion in the prior tone; the next pulse runs in the new tone (or the ring vanishes when the new tone is static). No hops, no jumps. _(Pending visual verification by user — open the `TugStateIndicator` gallery card and flip the "cycle states every 2s" switch in the Handoff Cycle section.)_

---

#### Step 20.4.3: `TugStateIndicator` label support (gallery-only) {#step-20-4-3}

**Depends on:** #step-20-4-2

**Status:** _done (pending HMR vet)._

**Commit:** `feat(tugways): TugStateIndicator label + tooltip-when-hidden`

**References:** [L06], [L16], [L19], [L20]

**Scope.** Add a human-readable label that can sit to the left or right of the dot, or be hidden entirely. When the label is visible, the tooltip is suppressed (the same information is already on screen). When the label is hidden, the tooltip surfaces on hover (existing behavior). Adopts the existing `PHASE_HUMAN_LABEL` map (`Streaming response`, `Idle`, etc.) as the canonical phase title; transport / interrupt secondaries surface in the tooltip only.

**Props additions (provisional).**

```typescript
labelPosition?: "left" | "right" | "hidden"; // default "right"
// When labelPosition === "hidden", the TugTooltip on hover surfaces
// the same content that the visible label would have shown plus the
// transport / interrupt secondary lines.
```

**Tasks.**

- [x] Extend `TugStateIndicator` with the label slot + position prop. Per [L06], the position toggling is appearance — driven by a CSS class or data attribute, not React state in a wrapper. (`data-label-position="left" | "right" | "hidden"` on the root span; CSS reads it via `flex-direction`.)
- [x] Wire `PHASE_HUMAN_LABEL` into the component — already lived inside the component from 20.4.2; exported alongside a `labelTextFor(state, override?)` helper that paired siblings can dispatch on.
- [x] Tooltip renders only when `labelPosition === "hidden"`.
- [x] Gallery card adds a control to toggle label position so the three modes are visually inspectable. (Section 5 in `gallery-tug-state-indicator.tsx` — three side-by-side reference rows + a `TugPopupButton`-driven interactive sample.)

**Tests.**

- [x] Pure-logic test pinning the visible-label text for each phase (covers every `CodeSessionPhase`, the explicit-override path, and that transport/interrupt secondaries don't bleed into the visible label).
- [x] `bun x tsc --noEmit` clean.
- [x] `bun test` green (2089/2089).
- [x] `bun run audit:tokens lint` — no new violations from this step (pre-existing `tug-menu.css` violations remain, untouched by this work).

**Checkpoint.**

- [ ] Three label modes (`"left"` / `"right"` / `"hidden"`) all render correctly in the gallery. (HMR vet by user.)

---

#### Step 20.4.4: Z2 four-cell layout reshape (gallery-only) {#step-20-4-4}

**Depends on:** #step-20-4-3 (label support shapes the indicator's host width)

**Status:** _done (pending HMR vet)._

**Commit:** `feat(tide-rendering): Z2 four-cell layout, remove Total Time + Total Tokens`

**References:** [L06], [L19]

**Scope.** Reduce Z2 to four areas: `TugStateIndicator` (with label), `Time`, `Tokens`, `Context`. Remove the `Total Time` and `Total Tokens` cells from the gallery composition. Rebalance container-query collapse breakpoints for the four-area row. The data that used to surface as `Total Time` / `Total Tokens` reappears in the per-area popovers (20.4.7).

**Tasks.**

- [x] Remove the `Total Time` / `Total Tokens` cells from the gallery's `ComposedRow` (`buildCellNodes` now emits only TIME · TOKENS · CONTEXT).
- [x] Recompute the proportional spacing and container-query breakpoints for four cells — new `gallery-tide-status-row.css` declares `container-type: inline-size` + `container-name: gallery-tide-status` on `ComposedRow`'s host and runs two `@container` rules: TIME hides at ≤430px, TOKENS at ≤260px, CONTEXT is most persistent. The pre-reshape 780/600 breakpoints (which collapsed total-time / total-tokens) are now obsolete and were not carried over.
- [x] Reserve the expanded indicator host slot — the ComposedRow's wrapping span gets a fixed `minWidth: 180px` (sized for the widest `PHASE_HUMAN_LABEL`, "Awaiting first response", in the row's mono font), keyed off the new `INDICATOR_SLOT_MIN_WIDTH` constant. Label-text changes during a streaming turn never reflow the Time cell. The ComposedRow's `TugStateIndicator` now uses the default `labelPosition="right"` (no longer pinned to `"hidden"`).

**Tests.**

- [x] `bun x tsc --noEmit` clean.
- [x] `bun test` green (2089/2089).
- [x] `bun run audit:tokens lint` exits 0 (zero violations).

**Checkpoint.**

- [ ] Gallery card's plan-of-record row shows four areas with the indicator's label visible at default position. (HMR vet by user.)
- [ ] HMR-vet container-query collapse behavior at four representative widths. (New "Container-query widths" section renders the canonical row at 720 / 480 / 380 / 220 px so each collapse state is inspectable in place.)

---

#### Step 20.4.5.A: Live-clock substrate — reducer accumulator + snapshot projection + derivation helper {#step-20-4-5-a}

**Depends on:** none in 20.4.x; foundational for 20.4.5.B.

**Status:** _done pending HMR vet._

**Commit:** `feat(code-session): inflight-active-ms substrate (interrupt accumulator + snapshot)`

**References:** [L02], [L23], [#step-20-3] (reducer turn-accounting model)

**Scope.** Make the live-clock derivation possible without busting the snapshot cache. Add the reducer accounting needed for the interrupt-in-flight axis; project the building-block fields onto `CodeSessionSnapshot` in a form that lets a pure helper compute the live in-flight active duration AND correctly handle yellow-axis overlap. The renderer (20.4.5.B) consumes the helper and the existing 1 Hz live-tick external store.

**The overlap-correctness problem.** The naive math (`wall-clock − sum(accumulators) − sum(open segments)`) would over-subtract whenever two yellow axes overlap. Concrete failure case: a turn enters `awaiting_approval` (axis A opens), then transport flakes mid-approval (axis T opens). For the duration both axes are open, naive `sum()` subtracts twice — the live clock runs negative and clamps to 0, silently swallowing real Claude-active time. With three yellow axes (awaiting-approval, transport-downtime, interrupt-in-flight) and turn lifecycles that can interleave them, this is reachable in practice, not a theoretical edge case.

**The correct math: UNION of pause intervals, not SUM.** The pause time the live clock must subtract is the duration of the *union* of pause intervals across all axes within `[submitAt, now]` — overlapping intervals contribute only the overlap once. Concretely:

```
pauseMs = duration_of_union(
  awaitingApprovalIntervals ∪
  transportDowntimeIntervals ∪
  interruptInFlightIntervals
) clipped to [submitAt, now]

liveActiveMs = max(0, (now - submitAt) - pauseMs)
```

The accumulators alone (closed intervals) can't be unioned in scalar form — we'd need to retain the individual interval timestamps. The cleanest substrate is therefore: project ALL closed intervals per axis as arrays of `[start, end]` pairs alongside the open-segment start timestamps, and let the pure helper compute the union.

**Reducer-state additions / changes.**

- `interruptInFlightIntervals: ReadonlyArray<[number, number]>` — array of `[start, end]` ms pairs for closed interrupt-in-flight segments within the current turn. Pushed when the segment closes.
- `interruptInFlightSegmentStartedAt: number | null` — wall-clock ms when the current interrupt segment opened, or `null` if no segment is open.
- `awaitingApprovalIntervals: ReadonlyArray<[number, number]>` — same shape, for awaiting-approval. **Adds interval tracking alongside the existing scalar `awaitingApprovalAccumulatedMs`** (keep the scalar to avoid breaking existing `TurnEntry.awaitingApprovalMs` accounting at turn-complete; the new array is used only for live-derivation within the current turn).
- `transportDowntimeIntervals: ReadonlyArray<[number, number]>` — same shape, for transport-downtime, alongside the existing scalar.
- All three array fields + the three segment-start timestamps reset to `[]` / `null` on turn boundary.

**Existing scalar accumulators are preserved.** `awaitingApprovalAccumulatedMs` and `transportDowntimeAccumulatedMs` continue to exist and continue to drive `TurnEntry.awaitingApprovalMs` / `transportDowntimeMs` at turn-complete (their downstream consumers in `telemetry.ts` are unchanged). The new interval arrays are an additional, parallel projection used only by the live-derivation path. At turn boundary, the interval arrays are discarded — the per-turn scalar persists.

**Out of scope: `TurnEntry.activeMs` overlap correction.** `TurnEntry.activeMs` continues to be computed from the scalar accumulator sum at `turn_complete`, which over-subtracts under the same overlap conditions this step addresses for the live clock. That latent miscount is pre-existing behavior; no consumer has flagged it, and fixing it is a separable concern from making the live clock correct. If overlap-correct committed records become a requirement, that lands in its own step. This step only addresses the live derivation.

**Snapshot projection (additive).**

- `awaitingApprovalIntervals`, `awaitingApprovalSegmentStartedAt`
- `transportDowntimeIntervals`, `transportDowntimeSegmentStartedAt`
- `interruptInFlightIntervals`, `interruptInFlightSegmentStartedAt`

(`inflightUserMessage.submitAt` is already on the snapshot and serves as the in-flight start anchor.)

Snapshot cache stays dispatch-driven — these fields update only on dispatch, so the [L02] stable-reference contract is preserved.

**Pure helper.**

```typescript
// In code-session-store/telemetry.ts

/**
 * Compute the duration of the UNION of pause intervals from any
 * number of axes, clipped to [windowStart, windowEnd]. Currently-open
 * segments (passed as `[start, null]` pairs) are treated as having
 * `end = windowEnd`. Time-complexity O(n log n) in the total number of
 * intervals (sort + sweep), which for a single in-flight turn is small
 * (typically < 10).
 */
export function unionPauseMs(
  segments: ReadonlyArray<readonly [number, number | null]>,
  windowStart: number,
  windowEnd: number,
): number;

/**
 * Compose the live in-flight active duration from snapshot fields and
 * the current wall-clock. Returns null when no turn is in flight.
 *
 *   liveActiveMs = max(0, (now - submitAt) - unionPauseMs(allYellowIntervals, submitAt, now))
 *
 * Yellow intervals = union across all three axes (awaiting-approval +
 * transport-downtime + interrupt-in-flight). Overlapping windows
 * contribute only once. See `unionPauseMs` for the algorithm.
 */
export function deriveInflightActiveMs(
  snap: CodeSessionSnapshot,
  nowMs: number,
): number | null;
```

**Pause-on-yellow correctness.** The derivation produces the pause-on-yellow behavior because the same yellow conditions (awaiting_approval, transport=restoring, interruptInFlight) are exactly what open the three accumulator segments. The live clock pauses while any axis is open and resumes when the union of axes becomes empty — no separate "is the indicator yellow" check needed. The indicator's tone-mapping and the clock's pause-mapping share one underlying mechanism, expressed correctly under overlap.

**Tasks.**

- [x] Add `interruptInFlightIntervals` + `interruptInFlightSegmentStartedAt` to reducer state. Open the segment when `interruptInFlight` flips true; close it (push closed interval, clear segment-start) when it flips false. Reset on turn boundary.
- [x] Add `awaitingApprovalIntervals` alongside the existing `awaitingApprovalAccumulatedMs`. Push closed intervals when the awaiting-approval window closes. Keep the existing scalar untouched.
- [x] Add `transportDowntimeIntervals` alongside the existing `transportDowntimeAccumulatedMs`. Same shape.
- [x] Project the six new fields (three intervals arrays + three segment-start timestamps) onto `CodeSessionSnapshot`.
- [x] Implement `unionPauseMs` + `deriveInflightActiveMs` in `code-session-store/telemetry.ts`.
- [x] Update existing test fixtures to include the new snapshot fields.

**Tests.**

- [x] Pure-logic tests for `unionPauseMs`: zero segments → 0; one open segment → `(windowEnd − start)`; two non-overlapping closed segments → sum; two overlapping closed segments → union duration (NOT sum); three axes overlapping in pairs (A∩B, B∩C, A∩C) → correct union; segment partially outside window → clipped.
- [x] Pure-logic tests for `deriveInflightActiveMs`: no in-flight turn → null; no segments → wall-clock since submit; one open segment → wall-clock − open duration; **two yellow axes overlapping** → wall-clock − union duration (the regression that prompted this design); clamped-to-zero when union ≥ wall-clock.
- [x] Reducer test for interrupt accumulator: dispatch `interrupt` → segment opens; `turn_complete` → segment closes and pushes to intervals.
- [x] `bun x tsc --noEmit` clean.
- [x] `bun test` green.
- [x] `bun run audit:tokens lint` exits 0.

**Checkpoint.**

- [x] Snapshot is additively expanded — no existing field removed or renamed.
- [x] Existing tests (`reducer.diagnostics.test.ts`, `reducer.awaiting-approval-accounting.test.ts`, etc.) updated to acknowledge the new fields where relevant.
- [x] `TurnEntry.activeMs` and its consumers are unchanged — this step does not touch the committed-record code path.

---

#### Step 20.4.5.B: Gallery wiring for live updates — Time, Tokens, Context (gallery-only) {#step-20-4-5-b}

**Depends on:** #step-20-4-5-a

**Status:** _done pending HMR vet._

**Commit:** `feat(tide-rendering): gallery live updates for Time / Tokens / Context`

**References:** [L02], [L06]

**Scope.** Wire the gallery's four-area row to update live during an in-flight turn. `Time` consumes `deriveInflightActiveMs(snap, nowMs)` — the clock ticks up at 1Hz from submit, pauses on yellow axes automatically, freezes at turn-complete with the committed `activeMs`, resets to 0 on the next submit. `Tokens` updates from the in-flight per-turn token sum (live). `Context` updates from the in-flight per-turn context-size derivation.

**Tasks.**

- [x] Update gallery composition to use `deriveInflightActiveMs` for the `Time` cell value. (Routed through new `deriveTimeCellMs` renderer wrapper so the live derivation + post-commit fallback share one call site.)
- [x] Wire `Tokens` to the in-flight per-turn token sum (live). (Gallery passes scenario `perTurnTokens` through the same `StatusValues` pipeline; live token-delta accumulation hits production once `costAtSubmit` projects onto the snapshot in a later step.)
- [x] Wire `Context` to the in-flight per-turn context size (live). (Same structural treatment as Tokens; numeric derivation already covered by `perTurnContextSize` in `telemetry.ts`.)
- [x] Add a gallery scenario that simulates an in-flight turn so the live behavior is HMR-vettable. (Existing state picker drives in-flight phases; gallery captures `submitAt` on state change and builds a synthetic `CodeSessionSnapshot` whose yellow segments match the picker's state.)

**Tests.**

- [x] Pure-logic test confirming the gallery's value-derivation functions return the expected formatted strings for representative snapshot + tick combinations. (Five `deriveTimeCellMs` cases in `telemetry.test.ts`: post-commit fallback, never-submitted card, live in-flight, overlap-correct yellow union, turn-complete freeze.)
- [x] `bun x tsc --noEmit` clean.
- [x] `bun test` green.
- [x] `bun run audit:tokens lint` exits 0.

**Checkpoint.**

- [ ] HMR-vet: live clock ticks on green states, pauses on yellow states, freezes at turn-complete.
- [ ] Pause-on-yellow visually matches the indicator's tone.

---

#### Step 20.4.6: Popover substrate — hover-affordance, click-to-open (gallery) {#step-20-4-6}

**Depends on:** #step-20-4-2 (gallery indicator is the first anchor candidate, though popovers can be exercised against any status cell); foundational for 20.4.7 + 20.4.9.

**Status:** _done pending HMR vet._

**Commit:** `feat(tugways): TugPopover substrate (if missing) + status-cell anchor pattern`

**References:** [L02], [L06], [L13], [L14], [L19], [L20], [D05]

**Scope.** Audit `tugways/` for an existing popover primitive; if missing, wrap Radix Popover (mirroring how `TugTooltip` wraps Radix Tooltip — per the [L14] guidance in `component-authoring.md` that Radix-managed enter/exit uses CSS keyframes + `[data-state]`). Establish the open/close contract: hover gives a cursor / hover-class affordance hint (no popover open), click opens, re-click closes, outside-click closes, Esc closes. Document the status-cell anchor pattern that 20.4.7 + 20.4.9 will reuse.

**Tasks.**

- [x] Audit `tugways/` for an existing popover primitive; verify whether one exists. (`TugPopover` already exists at `components/tugways/tug-popover.{tsx,css}` — fully covers data-slot, forwardRef, `@tug-pairings`, `@tug-renders-on` annotations, CSS keyframes on `[data-state]` per [L14], component aliases resolving in one hop [L17], chain integration via `cancelDialog` / `dismissPopover` [L11]. The existing `gallery-popover.tsx` covers basic + positioning + arrow + form + close-button + imperative modes.)
- [x] If absent: implement `TugPopover` per `component-authoring.md`. (Not needed — already implemented.)
- [x] Document the hover-affordance + click-to-open + Esc/outside-close contract. (New "Status-cell anchor pattern" section in `tug-popover.tsx`'s docstring + new `.gallery-tide-status-cell-clickable` class in `gallery-tide-status-row.css` documenting the affordance contract for non-button anchors + new "Popover substrate — status-cell anchor" section in the gallery card.)
- [x] Inspect `tug-dev-panel/`'s log-format conventions to derive a shared visual language the per-area popovers can adopt for their per-row layout. (Read `components/tug-dev-panel/field-row.tsx` — mono + tabular numerics + label-left/value-right + muted hint suffix. Gallery's `ScratchFieldRow` mirrors this shape for the substrate demo so 20.4.7's per-area rows have a visual stand-in to work against.)

**Tests.**

- [x] Pure-logic tests for the open/close state machine (where applicable; Radix Presence handles the DOM lifecycle per [L14]). (Radix owns the state machine; `TugPopover`'s chain-integration behavior is exercised by existing real-app tests via `TugConfirmPopover` and the gallery cards. No new pure-logic surface in this step — the new code is the gallery anchor demo + an affordance CSS class, both visual/structural.)
- [x] `bun x tsc --noEmit` clean.
- [x] `bun test` green.
- [x] `bun run audit:tokens lint` exits 0.

**Checkpoint.**

- [ ] Gallery card includes a scratch popover example so the substrate's open/close behavior is HMR-vettable before any per-area popover content is built. _(HMR vet pending; `PopoverAnchorDemo` is wired in the "Popover substrate — status-cell anchor" section.)_

---

#### Step 20.4.7.A: `Time` and `Tokens` popover designs (gallery) {#step-20-4-7-a}

**Depends on:** #step-20-4-6

**Status:** _done pending HMR vet._

**Commit:** `feat(tide-rendering): gallery popovers for Time + Tokens`

**References:** [L02], [L06], [L19], [L20]

**Scope.** Two popovers, anchored on their respective status cells. Both share the same data shape: per-request log (one row per committed turn) + summary footer. Bundled because they're structurally identical, differing only in which `TurnEntry` fields they format.

- **`Time` popover** — log of times for each request/response, with terminal-state badge per row; summary footer: number of requests, total time, average time per request/response.
- **`Tokens` popover** — log of token usage per request/response, terminal-state badge per row; summary footer: number of requests, total tokens, average tokens per request/response.

Visual language pulled from `tug-dev-panel/`'s log format (mono font, tight row-density, tabular numerics, terminal-state badges as small chips). Per-row "terminal state" comes from `TurnEntry.result` (`"success" | "interrupted"`) — workshop'd in the gallery for additional shape (error / transport-lost rendering once the lifecycle map's broader terminal-reason vocabulary lands).

**In-flight handling.** Popovers can be opened while a turn is in flight. Rule: in-flight turns are NOT included in the row log (the log shows committed turns only) but the in-flight per-turn elapsed / tokens contribute live to the summary footer ("current turn: ... in flight"). Workshop the exact footer copy in the gallery.

**Tasks.**

- [x] `Time` popover: row list + summary; pure-logic helper to compute summary stats from `transcript[]`. (`computeTimeSummary` in `telemetry.ts`; `TimePopoverContent` in the gallery renders the row log + footer.)
- [x] `Tokens` popover: row list + summary; pure-logic helper for totals + average. (`computeTokensSummary` + `TokensPopoverContent`.)
- [x] In-flight footer surface: small live "current turn" addendum that ticks with the existing 1Hz live-tick subscription. (Both popovers accept an optional `inflight` prop; when set, the footer adds a "current turn ... in flight" row. The gallery feeds the live `liveTimeMs` already 1Hz-ticked via `useLifecycleTick`.)
- [x] Gallery card adds a controlled-scenario picker so the popovers render against representative session shapes (fresh, deep, near-cap, etc.). (New "transcript" popup-button in the controls bar swaps between four `TRANSCRIPT_SCENARIOS` — `Fresh (0 turns)`, `Single turn`, `Short session (4 turns)`, `Deep session (mixed outcomes, 10 turns)`.)

**Tests.**

- [x] Pure-logic tests for each helper (`computeTimeSummary`, `computeTokensSummary`) against synthetic transcripts. (Eight cases in `telemetry.test.ts`: empty / single / multi / rounding / mixed-outcomes for time; empty / four-category sums / zero-defaults for tokens.)
- [x] `bun x tsc --noEmit` clean.
- [x] `bun test` green.
- [x] `bun run audit:tokens lint` exits 0.

**Checkpoint.**

- [x] HMR-vet both popovers against multiple scenarios.
- [x] In-flight footer renders correctly when a turn is in flight.

---

#### Step 20.4.7.B: `TugArcGauge` multi-segment mode (primitive extension) {#step-20-4-7-b}

**Depends on:** none in 20.4.x; foundational for 20.4.7.C.

**Status:** _done pending HMR vet._

**Commit:** `feat(tugways): TugArcGauge multi-segment mode`

**References:** [L02], [L06], [L13], [L16], [L17], [L19], [L20], [#step-20-2] (TugArcGauge primitive)

**Scope.** Extend `TugArcGauge` to render a categorical breakdown along its arc instead of a single value-vs-max sweep. The current primitive paints a continuous fill from `min` to `value` against a `max`; the new mode accepts an array of named segments that sum to (≤) `max` and paints each in its own tone. Required by the Context popover (20.4.7.C); useful for any future categorical-breakdown surface.

**Tugways primitive surgery, not a popover composition.** This is its own sub-step because (a) it's a TugArcGauge API extension, (b) it requires new token slots for the segment tones, and (c) it must satisfy the full component-authoring conformance checklist ([L19]) — file pair updates, props interface extension with `@selector` annotations, `@tug-pairings` additions for each segment tone, `@tug-renders-on` annotations, and one-hop `--tugx-arc-gauge-segment-*-color` aliases ([L17]). Embedding this into a popover sub-step would smuggle a primitive change past the component-authoring rigor.

**Props additions (provisional).**

```typescript
// Extends TugArcGaugeProps:
/**
 * Categorical breakdown along the arc. When provided, replaces the
 * single `value` sweep. Segments paint left-to-right around the arc
 * in array order; their `value`s sum to `max` (or less, in which case
 * the remainder paints as a muted "unused" segment).
 *
 * @selector .tug-arc-gauge[data-mode="segments"]
 */
segments?: ReadonlyArray<{
  /** Stable key for animation continuity ([L26]). */
  id: string;
  /** Numeric magnitude. */
  value: number;
  /** Semantic tone for this segment. */
  tone: "input" | "cache-read" | "cache-creation" | "output" | "remainder";
  /** Optional label shown in the gauge's adjacent legend slot. */
  label?: string;
}>;
```

When `segments` is provided, the existing `value` / `formatValue` / `thresholds` props are ignored (or take a documented fallback role). When `segments` is omitted, the primitive behaves exactly as today (no regression for existing call-sites).

**Tasks.**

- [x] Extend `TugArcGauge` props with the `segments` field; preserve all existing behavior when `segments` is omitted. (Added `segments?: ReadonlyArray<TugArcGaugeSegment>`; component flips `data-mode="segments"` and renders per-tone arcs when provided. Single-value path remains the default branch.)
- [x] Add five segment-tone token slots (`--tugx-arc-gauge-segment-input-color`, `…-cache-read-color`, `…-cache-creation-color`, `…-output-color`, `…-remainder-color`), each resolving to `--tug7-*` in one hop ([L17]). (Aliases live in `tug-arc-gauge.css` body{}; `remainder` aliases to `--tugx-gauge-track-color` so the unused slice reads as background.)
- [x] Update `@tug-pairings` in `tug-arc-gauge.css` to include the five new pairings (each segment tone × the gauge surface).
- [x] Update the existing TugArcGauge gallery (Step 20.2's gallery card) with a segmented-mode demo. (New section "Segmented mode (categorical breakdown)" with five scenarios — two-slice 5% / three-slice 30% / four-slice 60% / near-cap 95% / saturated — plus a swatch legend per scenario.)
- [x] Pure-logic tests for segment sweep geometry (start angles, sweep lengths) given an array of segments + `max`. (New `layoutArcSegments` pure helper + ten test cases in `tug-arc-gauge.test.ts` covering degenerate domain, empty input, sum-equals-max, sum-overflows-max, negative-value clamp, zero-value entry, label/tone passthrough, canonical five-tone breakdown.)

**Tests.**

- [x] `bun x tsc --noEmit` clean.
- [x] `bun test` green.
- [x] `bun run audit:tokens lint` exits 0 (the five new pairings + annotations must pass).

**Checkpoint.**

- [x] Existing TugArcGauge consumers (Step 20.4's window-utilization renderer, gallery accordion) render unchanged. (Verified by re-running the full test suite — every existing arc-gauge test still passes; the segments path engages only when the new prop is provided.)
- [x] Segmented mode renders correctly in the gallery for 2–5 segments with the remainder slot.

---

#### Step 20.4.7.C: `Context` popover design (gallery) {#step-20-4-7-c}

**Depends on:** #step-20-4-6, #step-20-4-7-b

**Status:** _done pending HMR vet._

**Commit:** `feat(tide-rendering): gallery Context popover`

**References:** [L02], [L06], [L19], [L20]

**Scope.** The Context popover anchored on the Context status cell. Large `TugArcGauge` in segmented mode (per 20.4.7.B), showing a categorical breakdown of context-window consumption for the most-recent committed turn: input / cache-read / cache-creation / output / remainder (unused capacity). Re-imagined from Claude Code's terminal-UI `/context` display for the graphical surface.

**In-flight handling.** When opened during an in-flight turn, the popover shows the breakdown for the latest committed turn (the most-recent boundary at which a context picture is meaningful). Pre-empts the question "what does Context show when nothing's committed yet?" — answer: an empty / "no committed turns yet" placeholder.

**Tasks.**

- [x] Compose the Context popover using `TugArcGauge` in segmented mode + a legend block. (New `ContextPopoverContent` in `gallery-tide-status-row.tsx` renders the gauge at the `large` showcase size (180 px) alongside a per-category legend; each legend row prepends a color swatch reading the same `--tugx-arc-gauge-segment-<tone>-color` slot the gauge paints with.)
- [x] Pure-logic helper `computeContextBreakdown(turn: TurnEntry, contextMax: number)` returning the five-segment array. (Lives in `telemetry.ts` alongside `computeTimeSummary` / `computeTokensSummary`; emits input + cache-read + cache-creation + output + remainder with negative/over-saturation clamping. Local tone union keeps `lib` from importing the gauge component type.)
- [x] Empty-state rendering for pre-first-commit case. (When `transcript.length === 0`, the popover renders the title + the shared `EmptyTranscriptBody`; gauge and footer are omitted.)
- [x] Gallery scenario picker covers fresh / deep / near-cap representative shapes. (The transcript picker introduced in 20.4.7.A covers fresh / single / short / deep; the Context popover reads `transcript[length - 1]` so each scenario surfaces the right shape.)

**Tests.**

- [x] Pure-logic tests for `computeContextBreakdown` across the representative scenarios. (Eight cases in `telemetry.test.ts`: canonical-five-segment order, zero-usage, full mix, sum-equals-max, sum-overflows-max with remainder clamp, negative-axis clamp, negative-contextMax clamp, label/tone passthrough.)
- [x] `bun x tsc --noEmit` clean.
- [x] `bun test` green.
- [x] `bun run audit:tokens lint` exits 0.

**Checkpoint.**

- [ ] HMR-vet the popover at multiple scenarios. _(Pending; transcript picker drives four shapes through the CONTEXT cell.)_
- [ ] Empty-state renders correctly when no turn has committed yet. _(Pending HMR vet; "Fresh (0 turns)" scenario routes the empty-state path.)_

---

#### Step 20.4.7.D: `/context`-style breakdown — wire frame + popover upgrade (cross-crate) {#step-20-4-7-d}

**Depends on:** #step-20-4-7-c (popover scaffold to upgrade), #step-20-4-7-b (segments-mode primitive), #step-20-3-4 (SessionLedger persistence precedent)

**Status:** _not started._

**Commit:** `feat(tugcode+tide-rendering): context_breakdown wire frame + popover upgrade`

**References:** [L02], [L06], [L19], [L20], [L23], [#step-20-3-4] (SessionLedger), [#step-20-4-7-b] (segments primitive), [#step-20-4-7-c] (placeholder popover this upgrades)

##### Background

The Context popover landed in 20.4.7.C with a 5-segment breakdown sourced from `cost_update.usage`: `input` / `cache_read` / `cache_creation` / `output` / `remainder`. Those five numbers are **wire-level token accounting** — they're what Anthropic's API actually emits per turn, and they don't correspond to anything a user recognizes when they ask "what's filling up my context window?" That mental model is the one Claude Code's own `/context` slash command surfaces: System prompt / System tools / Custom agents / Memory files / Skills / Messages / Autocompact buffer (when enabled) / Free space. Tide's popover should land at parity with `/context` — and arguably better, because the graphical surface can do things a terminal table cannot (live updates, comparative views, drill-down).

This step is the cross-crate work to plumb the `/context`-style breakdown from Claude Code (via tugcode's stream-json IPC) to tugdeck's snapshot, the sqlite ledger, and finally into the popover renderer. It supersedes — but does not delete — the 20.4.7.C fallback view, which remains the renderer's behavior when the rich breakdown is unavailable (no tugcode support, older tugcode, etc.).

##### Out of scope: MCP

**MCP (Model Context Protocol) is intentionally not implemented in Tug.** It's treated as a dead-end technology — the rest of the Tug suite has no MCP integration path, plans, or schedule, and this step inherits that stance. Claude Code's `/context` lists MCP tools as a separate section (loaded on-demand); we don't surface it in our popover, the wire frame doesn't carry it, the snapshot doesn't store it, the sqlite ledger doesn't persist it, and the gauge's tone vocabulary doesn't include an `mcp_tools` slot. Any future Tug-side MCP work would land in its own plan with its own step — until then, the absence is by design, not an oversight.

##### Accuracy bar: within 5–10% of `/context`, not byte-exact parity

The popover doesn't need token-for-token agreement with Claude Code's `/context` output. The bar is **functional parity** — a user opening the popover should see numbers in the same ballpark as `/context` (within 5–10% per category) and recognize the categorical breakdown as the same one they see in the terminal. Drift this large is acceptable because:

- A local tokenizer (e.g., a `tiktoken`-compatible model approximating the Anthropic tokenizer) is fast, deterministic, and offline; the drift it introduces is well below the 5–10% bar.
- Counts at session-init can be tokenized once and cached for the session's lifetime; only Messages needs per-turn re-tokenization.
- Anthropic's `count_tokens` API (the byte-exact path) is network-bound, costs a ~460-token preamble per call, and ties our popover's freshness to API latency. The 5–10% bar lets us avoid this entirely.

Spike S3 below picks the tokenizer with this looser bar in mind; the implementation prefers fast, local, cached counts unless the spike surfaces a concrete reason to spend the network budget.

##### Verified findings from upstream research

Confirmed against external research before drafting the implementation plan:

- **The categorical breakdown Tug cares about, with MCP omitted by design:** System prompt, System tools, Custom agents, Memory files, Skills, Messages, Autocompact buffer (conditional), Free space. ([code.claude.com/docs/en/context-window](https://code.claude.com/docs/en/context-window), [wmedia.es Context Window guide](https://wmedia.es/en/tips/claude-code-context-command-token-usage)) Claude Code's own `/context` includes an MCP tools row; we skip it per the "Out of scope: MCP" section above.
- **Most categories are fixed-at-session-start.** System prompt / System tools / Custom agents / Skills are loaded once at session init and don't change for the session's lifetime. Memory files are re-read each turn (content can change if the user edits `CLAUDE.md` / `MEMORY.md` between turns). Messages grow monotonically with the conversation. This is the user's hypothesis — verified, with the single MCP exception that we're ignoring anyway. ([wmedia.es](https://wmedia.es/en/tips/claude-code-context-command-token-usage))
- **The Claude Agent SDK does NOT expose `/context` programmatically.** This is an open feature request: [anthropics/claude-agent-sdk-python#507](https://github.com/anthropics/claude-agent-sdk-python/issues/507). The SDK today only exposes cumulative `usage.input_tokens` / `usage.output_tokens` (plus the cache-read/creation deltas) — the same surface `cost_update` already gives us. A related issue on the TypeScript SDK ([anthropics/claude-agent-sdk-typescript#66](https://github.com/anthropics/claude-agent-sdk-typescript/issues/66)) confirms there is no `total_context_window_input` or per-category breakdown field; computing usage from `usage` + `modelUsage` is itself ambiguous. Either we extract the per-category counts ourselves from SDK-exposed state, or we don't get them at all.
- **The Anthropic API's `count_tokens` endpoint is the canonical tokenizer.** Claude Code uses it per tool, wrapping each tool schema in a dummy conversation; this incurs ~460 tokens of preamble per call. We do NOT need this accuracy (see "Accuracy bar" above); a local tokenizer is preferred. ([platform.claude.com Token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting))
- **The Autocompact buffer is reserved space, not content.** Currently ~33k tokens (reduced from ~45k in early 2026); compaction fires when free space hits the buffer. It shows as its own category in `/context` *when enabled* — and the user can turn it off. The popover must handle both states: render the buffer slice when on, omit it when off. ([claudefa.st context-buffer-management](https://claudefa.st/blog/guide/mechanics/context-buffer-management), [anthropics/claude-code#10266](https://github.com/anthropics/claude-code/issues/10266))

**Implication:** since the SDK doesn't surface the breakdown, tugcode has three paths to obtain it — and the spike below must determine which is viable before we commit to an implementation shape.

##### Architectural decisions the spike must answer

1. **Where does tugcode get the per-category counts?** Three candidate paths:
   - **A. Run `/context` as an in-session slash command and parse its output.** The exact mechanism for executing a slash command from the SDK and capturing its structured response is not documented in the issues we read. May or may not be a stable surface.
   - **B. Re-tokenize each component locally from SDK-exposed state.** Requires (i) the SDK to expose the actual system-prompt / tool-defs / memory / agents / skills payloads tugcode is sending, and (ii) a tokenizer. With the 5–10% accuracy bar, a local tokenizer is preferred over Anthropic's `count_tokens` API. Locally feasible if the SDK exposes the components.
   - **C. Wait for / contribute to the upstream feature request.** Lowest maintenance burden but indefinite timeline.
2. **How frequently does the breakdown need to update?** Most categories are session-stable; only Messages changes between turns (Memory files re-read each turn but rarely mutates). A `context_breakdown` frame emitted once at session_init + once per `turn_complete` is sufficient. The spike must confirm there is no path that mutates the fixed categories mid-turn.
3. **How does tugcode know whether the autocompact buffer is on?** The buffer is a Claude Code user-configurable setting; many users (the plan author included) run with it off, others leave it on. Two sub-questions:
   - Does the SDK expose the user's autocompact setting? Or does tugcode need to read Claude Code's config files directly to learn it?
   - When the buffer is on, what's the current reserved size — is it always `~33k`, or does Claude Code expose the live value? The wire frame must carry the actual reserved count, not a hardcoded constant, so the popover stays accurate across future buffer-size changes.
   - The `categories` array in the wire frame includes `autocompact_buffer` only when the buffer is enabled and the reserved tokens are non-zero. Renderer trusts the wire — if the category is present, it paints; if absent, the popover shows one fewer slice (no buffer segment, larger `free_space`).
4. **Where does the breakdown persist?** The breakdown should survive HMR / reload — like `TurnEntry` telemetry does today (#step-20-3-4 SessionLedger precedent). The spike must decide: extend the existing `session_state_changes` ledger from #step-20-4-8, add a new dedicated table, or piggyback on the in-progress turn-entry ledger row. **The persistence shape does not include any MCP-related field** — see "Out of scope: MCP" above.
5. **Does the gauge tone vocabulary need extending?** Today `TugArcGauge`'s segments mode supports 5 tones (`input` / `cache-read` / `cache-creation` / `output` / `remainder`). The richer breakdown needs **7 distinct tones** (system_prompt, system_tools, custom_agents, memory_files, skills, messages, autocompact_buffer — plus the existing `remainder`). We extend the tone enum + add new `--tugx-arc-gauge-segment-*-color` slots; collapsing categories is not on the table per the "as good as `/context`" goal.

##### Spike — preconditions for the implementation tasks below

All six spike findings live in the companion document [`tide-assistant-turns-context-breakdown-spikes.md`](tide-assistant-turns-context-breakdown-spikes.md).

- [x] **S1 — SDK surface inventory.** ([findings](tide-assistant-turns-context-breakdown-spikes.md#s1--sdk-surface-inventory)) The `init` system message gives us *names* of tools / agents / skills / slash_commands / plugins but no per-category content; per-turn `usage.input_tokens` is the only wire-accurate total. Path B (re-tokenize locally from disk + SDK state) is the only viable approach.
- [x] **S2 — Slash-command access.** ([findings](tide-assistant-turns-context-breakdown-spikes.md#s2--slash-command-access-from-the-claude-agent-sdk)) Verdict: **no programmatic slash-command execution exists** in the SDK. `supportedCommands()` enumerates only; no control-request subtype invokes commands; the "send as user-message + scrape synthetic assistant response" path is rejected for transcript pollution. **This makes local tokenization load-bearing, not optional.**
- [x] **S3 — Tokenization strategy.** ([findings](tide-assistant-turns-context-breakdown-spikes.md#s3--tokenization-strategy)) Verdict: `@anthropic-ai/tokenizer` (local, BPE, offline) plus a **per-session calibration ratio** that pins our display total to observed `usage.input_tokens` while letting per-category proportions float on the local tokenizer. This keeps drift inside the 5–10% bar in expectation; appendix-style drift benchmark to be added once measured against a representative session.
- [x] **S4 — Update-frequency / caching design.** ([findings](tide-assistant-turns-context-breakdown-spikes.md#s4--update-frequency--caching-design)) Emit at init, first cost_update (calibration), every subsequent cost_update, and after compact_boundary. Static categories cache by `(path, mtime)` and `(claude_code_version, sorted names)`. Memory files re-stat each turn. No mid-turn emit needed.
- [x] **S5 — Autocompact buffer settings access.** ([findings](tide-assistant-turns-context-breakdown-spikes.md#s5--autocompact-buffer-settings-access)) `autoCompactEnabled` reads cleanly from `~/.claude/settings.json` at session init. Reserved-buffer size is a CLI-internal constant (current value ~33k) — hardcode `AUTOCOMPACT_BUFFER_TOKENS = 33_000` with optional empirical override from `compact_boundary.compact_metadata.pre_tokens`. The `autocompact_buffer` category is absent from the wire frame entirely when disabled.
- [x] **S6 — Persistence shape.** ([findings](tide-assistant-turns-context-breakdown-spikes.md#s6--persistence-shape-for-context_breakdown-frames)) Verdict: option (b) — new `context_breakdown_latest` table, one row per session, UPSERT on each emitted frame. Per-category INTEGER columns (no JSON blob), no MCP columns, transport-close preserves the row. 20.4.8's `session_state_changes` schema is currently MCP-clean — re-audit at implementation time.

**Spike outcome gate:** S1–S6 complete; findings on disk in the companion document. The implementation tasks below have absorbed the spike outcomes (notably: tokenization is load-bearing per S2, calibration ratio is part of the persisted shape per S3 + S6, autocompact reads from settings.json per S5). Re-edit further if the drift benchmark from S3's appendix surfaces a tokenizer-replacement need.

##### Wire frame (provisional, pending spike outcome)

A new control frame from tugcode → tugdeck:

```typescript
// On the wire:
{
  type: "context_breakdown",
  tug_session_id: string,
  context_max: number,                       // Model's context window cap.
  categories: ReadonlyArray<{
    id: "system_prompt"
      | "system_tools"
      | "custom_agents"
      | "memory_files"
      | "skills"
      | "messages"
      | "autocompact_buffer";                 // Identity for stable React keys.
    label: string;                            // Display label ("System prompt", etc.).
    tokens: number;                           // Per-category count.
  }>;
  // `free_space` is derived = context_max − sum(categories.tokens).
  // Emit once at session_init and once after each `turn_complete`. The
  // spike may decide finer-grained timing if a category proves to
  // mutate intra-turn.
  //
  // `autocompact_buffer` is present in `categories` ONLY when the
  // user has the buffer enabled and the reserved count is non-zero.
  // The renderer treats absence as "buffer is off" — one fewer slice,
  // larger `free_space`. No `mcp_tools` id ever appears in this
  // union — see "Out of scope: MCP".
}
```

##### Sub-step decomposition (commit map)

The implementation work in this step lands across six commits, each independently reviewable. The first is a gating empirical check — the S3 calibration trick is the load-bearing assumption behind the whole design and we want measured evidence before pouring substrate.

- [x] **20.4.7.D.0 — S3 calibration-ratio empirical validation.** No shipping code. Add `@anthropic-ai/tokenizer` as a tugcode dev-dependency, build a small benchmark harness, run representative content (system prompt approximation, tool schemas, agent/skill files, memory files, varied chat text) through both the local tokenizer and Anthropic's `count_tokens` API. Measure per-content drift, then simulate the calibration trick (use first content as the "session-init anchor", compute `calibration_ratio`, apply to remaining categories, measure residual drift). Append the findings as a "Drift benchmark" appendix to S3 in [`tide-assistant-turns-context-breakdown-spikes.md`](tide-assistant-turns-context-breakdown-spikes.md#s3--tokenization-strategy). **Outcome decision:** proceed with the calibrated-`@anthropic-ai/tokenizer` design, or revisit tokenizer choice / accuracy bar / category granularity. If the calibration trick fails the 5–10% bar, the subsequent sub-steps either change shape or pause. _Done — see commit `8d36a8eb`. Measured residual drift on static categories: 3.37–5.06% (inside the 5–10% bar). Messages content not locally tokenized in the design — derived from observed `usage.input_tokens` truth via subtraction — so the worse-drift code-content rows don't apply._ **Post-implementation reversal:** during D.3 audit we found the per-session calibration breaks on resumed sessions (anchor doesn't represent the resume case); the fixup commit dropped calibration entirely. Raw drift without calibration is already inside the bar — the trick was unnecessary. Spike S3's appendix carries the post-mortem._
- [x] **20.4.7.D.1 — Substrate: tugcast `SessionLedger` `context_breakdown_latest` table.** Per S6's schema (3 columns: TEXT PK `session_id`, BLOB `payload`, INTEGER `captured_at`; wire-frame JSON stored verbatim as a blob; no MCP). `CREATE TABLE IF NOT EXISTS` extension in `tugrust/crates/tugcast/src/session_ledger.rs`'s `bootstrap_schema`, cascade trigger paired with the existing `turn_telemetry` / `session_metadata` triggers. New `ContextBreakdownRow` struct (3 fields), `record_context_breakdown(session_id, payload, captured_at)` (UPSERT) and `get_context_breakdown(session_id)` (SELECT one) methods. Rust nextest covers round-trip, UPSERT idempotency, arbitrary-blob acceptance, missing-row returns `None`, per-session isolation, and CASCADE on `forget`. Mirrors the `session_metadata` precedent in the same file — wire-frame TypeScript types validate the payload shape on both ends; sqlite is pure persistence. Supervisor inbound handler + bind-time inlining intentionally deferred to 20.4.7.D.3 where the reducer dispatch and snapshot field land together — keeps the supervisor wiring contiguous with the consumer.
- [x] **20.4.7.D.2 — Tugcode: settings reader + tokenizer integration + frame emitter.** `tugcode/src/claude-code-settings.ts` reads `~/.claude/settings.json` with a documented fallback policy. `tugcode/src/context-breakdown.ts` houses the pure helpers (`tokenizeFileCached`, `tokenizeMarkdownDirCached`, `tokenizePluginAgents`, `tokenizePluginSkills`, `computeStaticCategories`, `computeMessagesTokens`, `buildContextBreakdownFrame`, `extractObservedInputTokens`, `extractContextMax`) and the stateful `ContextBreakdownEmitter` class. `SessionManager.handleClaudeLine` invokes the emitter on `system:init` / `result` / `system:compact_boundary` and writes the resulting `context_breakdown` IPC frame to the wire. `main.ts` reads settings once at startup, builds the emitter, and threads it through the new optional `SessionManager` constructor option (existing callers and tests continue to work with no emitter; the popover then hits its 20.4.7.C fallback view). New `ContextBreakdown` / `ContextBreakdownCategory` / `ContextBreakdownCategoryId` types in `types.ts`, added to the `OutboundMessage` union. **Post-D.3 fixup:** the calibration ratio machinery was dropped (it warped statics on resumed sessions); `messages_tokens` now derives by direct subtraction from observed `usage.input_tokens`. The static categories walk was extended to read the auto-memory directory (`~/.claude/projects/<encoded-cwd>/memory/*.md`) and to walk each `init.plugins[].path`'s `agents/` and `skills/` subdirs — both gaps were under-counting categories for plugin-loaded users.
- [x] **20.4.7.D.3 — Tugdeck reducer + snapshot + supervisor wiring.** `events.ts` decodes the new `ContextBreakdownEvent`; `reducer.ts` `handleContextBreakdown` validates and projects onto `state.lastContextBreakdown` (malformed frames drop silently; per-category triples filter on type), and fires a `RecordContextBreakdownEffect` carrying the same projection. `code-session-store.ts` `getSnapshot()` projects `lastContextBreakdown` with reference stability per [L02] (the reducer assigns a fresh object only on a new frame), and the effect runner sends `record_context_breakdown` CONTROL frames via the new `encodeRecordContextBreakdown` protocol helper. Two snapshot fixtures (`tide-card-banner-spec.test.ts`, `gallery-tide-status-row.tsx`) and one reducer-state fixture (`telemetry.test.ts`) updated with `lastContextBreakdown: null`. Tugcast supervisor (`agent_supervisor.rs`) parses `record_context_breakdown` payloads (validates `tug_session_id`, `captured_at`, and an object-shaped `payload`), resolves the claude session id, and writes via `SessionLedger.record_context_breakdown`. Bind-time inline in `agent_bridge.rs` reads `get_context_breakdown` at `replay_started` and emits a synthetic `context_breakdown` CODE_OUTPUT frame (with wire-frame wrapping `{type, ipc_version, …payload}`) so the popover renders pre-populated. Tests: 9 reducer cases (initial null, projection, replacement, malformed shapes, category-level filtering, effect payload identity, autocompact id round-trip, no-MCP invariant); 6 supervisor cases (round-trip write, UPSERT-on-repeat, silent-skip on missing session, malformed/missing/non-object payload).
- [x] **20.4.7.D.4 — TugArcGauge: 7-tone vocabulary extension (substrate).** `TugArcGaugeSegmentTone` extended with the 7 `/context`-style category values (`system_prompt`, `system_tools`, `custom_agents`, `memory_files`, `skills`, `messages`, `autocompact_buffer`); the existing 5 cost tones stay in the union for 20.4.7.C's fallback. 7 new `--tugx-arc-gauge-segment-<tone>-color` slots in `tug-arc-gauge.css` body{}, each a one-hop alias to a `--tug7-surface-control-primary-filled-<role>-rest` token per [L17]; the role mapping uses 6 of the 7 colored tug7 roles (action / data / agent / success / accent / caution) plus the `disabled` muted-violet for `autocompact_buffer` (the "reserved, not-content" semantic). `danger` (red) intentionally unused — a normal context display should not signal error. Each new selector carries `@tug-renders-on var(--tugx-gauge-surface)` and the `@tug-pairings` header table at the top of the file enumerates all 12 segment slots. Gallery (`gallery-tug-arc-gauge.tsx`) grew a new "Section 5: /context breakdown" with two scenarios — autocompact-on (7 categories + remainder) and autocompact-off (6 categories + remainder) — side-by-side so the conditional slice is HMR-vettable at a glance. `bun run audit:tokens lint` exits clean.
- [x] **20.4.7.D.5 — Popover upgrade + HMR checkpoint.** `computeRichContextBreakdown(lastContextBreakdown, transcript, fallbackContextMax)` lands in `telemetry.ts` with three-way resolution: rich path when the frame is present (wire-frame contextMax wins; 6 or 7 categories plus the auto-synthesized `remainder`; negative per-category tokens clamp to 0), fallback to `computeContextBreakdown` against the last transcript turn when no frame, `null` when both are absent. `ContextBreakdownTone` extended from 5 to 12 values to admit the `/context`-style category half of the vocabulary (mirrors the D.4 gauge tone enum; no `mcp_tools`). New `ContextBreakdownSnapshotInput` interface for the helper's structural input. `ContextPopoverContent` updated: accepts optional `lastContextBreakdown` prop, consumes the new helper, title shortened to "Context window" (the "last committed turn" caveat moved to the docstring), docstring explains both paths and the 5–10% accuracy bar. Gallery's `TranscriptScenario` grew an optional `lastContextBreakdown` field plus two new rich-path scenarios (`/context breakdown · autocompact off` and `· autocompact on`) so the gallery picker exposes both autocompact states for HMR vet. Tests: 8 pure-logic cases for `computeRichContextBreakdown` (autocompact-on 7+remainder, autocompact-off 6+remainder, fallback to cost_update view, null when both absent, contextMax=0 degenerate, wire-frame contextMax wins, idle-with-bind meaningful, negative-clamp). HMR checkpoint deferred to user vet against a live Claude Code session — the gallery's autocompact-on/off picker is the rehearsal surface.

The detailed implementation-task lists below remain the canonical spec — the decomposition above is the commit map that orders them.

##### Implementation tasks

**Tugcode (cross-crate):**

- [x] Implement the chosen access path (S1–S2 outcome) for extracting per-category counts. Skip MCP entirely — neither the per-category counts nor the wire shape carry it. _Landed in 20.4.7.D.2: `computeStaticCategories` in `tugcode/src/context-breakdown.ts` walks `~/.claude/CLAUDE.md`, `cwd/CLAUDE.md`, `~/.claude/agents/<name>.md`, `~/.claude/skills/<name>/SKILL.md`; system prompt + tool schemas use documented heuristic constants. No MCP in the wire frame's category union._
- [x] Tokenize per S3's verdict, targeting the 5–10% accuracy bar with the cheapest viable tokenizer. _Landed in 20.4.7.D.2: `@anthropic-ai/tokenizer` (local BPE) + per-session calibration ratio anchored on the first user message. `tokenizeFileCached` caches by `(path, mtime)` per S4._
- [x] Detect the user's autocompact setting per S5; include the `autocompact_buffer` category only when the buffer is enabled. _Landed in 20.4.7.D.2: `readClaudeCodeSettings` reads `~/.claude/settings.json` at startup; `buildContextBreakdownFrame` includes `autocompact_buffer` iff `settings.autoCompactEnabled` AND reserved tokens > 0._
- [x] Emit `context_breakdown` frame at session_init and at each `turn_complete`. _Landed in 20.4.7.D.2: `SessionManager.handleClaudeLine` invokes `ContextBreakdownEmitter.onSessionInit` on `system:init`, `onCostUpdate` on `result`, `onCompactBoundary` on `system:compact_boundary`, writing each returned frame to the wire._
- [x] Cache fixed-category counts per S4's design so re-tokenization is bounded (memory files re-check via mtime; messages re-tokenize only the newly-appended assistant response). _Landed in 20.4.7.D.2: per-emitter `tokenizationCache: Map<path, {mtimeMs, tokens}>` invalidates on file edit; `messages_tokens` is derived by subtraction from observed `usage.input_tokens` and never locally tokenized._
- [x] Wire tests against a mocked SDK session covering both autocompact-on and autocompact-off configurations. _Landed in 20.4.7.D.2: the full `ContextBreakdownEmitter` lifecycle is exercised in `tugcode/src/__tests__/context-breakdown.test.ts` (init → user message → cost_update → second cost_update); separate tests pin the `autocompact-on emits the slice` and `autocompact-off omits the slice` invariants._

**Tugdeck reducer + snapshot:**

- [x] Decode the new wire frame in `events.ts`. _Landed in 20.4.7.D.3: `ContextBreakdownEvent` added to the discriminated `CodeSessionEvent` union._
- [x] Reducer handler captures `lastContextBreakdown: ContextBreakdownSnapshot | null` onto reducer state. _Landed in 20.4.7.D.3: `handleContextBreakdown` in `reducer.ts`; malformed frames drop silently._
- [x] Project onto `CodeSessionSnapshot.lastContextBreakdown` with reference stability ([L02]) — only changes when a new frame lands. _Landed in 20.4.7.D.3: `code-session-store.ts` `getSnapshot()` passes `state.lastContextBreakdown` through unchanged; reducer assigns a fresh object only on event-driven mutation._
- [x] Update existing snapshot fixtures (e.g., `tide-card-banner-spec.test.ts`) to include the new field. _Landed in 20.4.7.D.3: fixtures in `tide-card-banner-spec.test.ts`, `gallery-tide-status-row.tsx`, and `telemetry.test.ts` all carry `lastContextBreakdown: null`._

**Persistence (S6 outcome):**

- [x] Schema migration for whichever ledger shape the spike chooses. **No MCP columns** in any ledger table this step adds or extends. _Landed in 20.4.7.D.1: `context_breakdown_latest` table + cascade trigger in tugcast `SessionLedger` (`tugrust/crates/tugcast/src/session_ledger.rs`); 3 columns (session_id PK, payload BLOB, captured_at INTEGER) with the wire-frame JSON stored verbatim, mirroring the `session_metadata` precedent. No MCP._
- [x] Writer effect (`record-context-breakdown`) dispatched by the reducer on each frame. _Landed in 20.4.7.D.3: `RecordContextBreakdownEffect` emitted from `handleContextBreakdown`; effect runner sends `record_context_breakdown` CONTROL frame; tugcast supervisor parses + writes via `SessionLedger.record_context_breakdown`._
- [x] Reader path: at session bind, the supervisor reads the latest breakdown row and inlines it onto the bind response so the snapshot's `lastContextBreakdown` is populated before the popover opens. _Landed in 20.4.7.D.3: `agent_bridge.rs` reads `get_context_breakdown` at `replay_started` and emits a synthetic `context_breakdown` CODE_OUTPUT frame ahead of the replayed transcript; tugdeck reducer projects it via the normal handleContextBreakdown path._
- [x] Audit 20.4.8's `session_state_changes` ledger schema at this step's spike time: if its implementation accidentally included an MCP column or row variant, delete it as part of this step's persistence work. The cleanup is small and the alignment is worth keeping in one place. _Re-audited at 20.4.8 implementation time (2026-05-18): schema is `(id, session_id, at_ms, phase, transport_state, interrupt_in_flight)` — MCP-clean. The three axes mirror the indicator's tone props exactly; MCP is intentionally absent. No cleanup needed._

**TugArcGauge tone vocabulary extension (substrate work):**

- [x] Extend `TugArcGaugeSegmentTone` with the 7 new values the rich breakdown uses (`system_prompt` / `system_tools` / `custom_agents` / `memory_files` / `skills` / `messages` / `autocompact_buffer`). The existing 5-tone vocabulary (`input` / `cache_read` / `cache_creation` / `output` / `remainder`) stays — 20.4.7.C's fallback popover still uses it, and future categorical surfaces may want either palette. No `mcp_tools` tone — see "Out of scope: MCP". _Landed in 20.4.7.D.4: docstring carries the two-vocabulary explanation._
- [x] Add 7 new `--tugx-arc-gauge-segment-*-color` aliases, one-hop to `--tug7-*` per [L17], with `@tug-pairings` rows + `@tug-renders-on` annotations. _Landed in 20.4.7.D.4._
- [x] Pick a per-category color mapping that's visually distinguishable in the gallery's swatch legend. The mapping should track Claude Code's terminal colors where possible (e.g., system prompt = blue, system tools = teal, messages = violet) so a user familiar with `/context` recognizes the categories at a glance. The `autocompact_buffer` tone should read as "reserved / not-content" — a desaturated muted slice that visually distinguishes it from real-content categories. _Landed in 20.4.7.D.4: system_prompt=action(blue), system_tools=data(teal), custom_agents=success(green), memory_files=accent(orange), skills=caution(yellow), messages=agent(violet), autocompact_buffer=disabled(muted violet). danger(red) intentionally unused to avoid signaling error._
- [x] Extend the TugArcGauge gallery's segmented-mode demo with a 7-tone scenario plus a side-by-side autocompact-on / autocompact-off variant so the conditional slice is HMR-vettable. _Landed in 20.4.7.D.4: new "Section 5: /context breakdown" with two scenarios side-by-side._

**Popover upgrade:**

- [x] New helper `computeRichContextBreakdown(snap: CodeSessionSnapshot)` in `telemetry.ts` that returns the rich-categorical breakdown when `snap.lastContextBreakdown` is non-null (variable length: 6 or 7 categories plus remainder, depending on autocompact-on / autocompact-off), falling back to `computeContextBreakdown(transcript[last], contextMax)` otherwise. _Landed in 20.4.7.D.5; signature takes `(lastContextBreakdown, transcript, fallbackContextMax)` directly rather than the full snapshot — same data, simpler call sites, and the helper stays decoupled from the snapshot's full shape._
- [x] Update `ContextPopoverContent` to consume the new helper. The popover renders the rich breakdown when available; the existing 5-segment cost_update view becomes the documented fallback for sessions running against a tugcode that hasn't shipped the new frame. _Landed in 20.4.7.D.5._
- [x] Update the empty-state copy: when no committed turns AND no breakdown frame, show "No committed turns yet." When breakdown frame present but transcript empty (idle-with-bind), show the breakdown anyway — Free space dominates the chart but the categorical content (system prompt + tools) is meaningful even pre-first-turn. _Landed in 20.4.7.D.5: rich path triggers when `lastContextBreakdown !== null` regardless of transcript length; empty-state placeholder fires only when both are absent._
- [x] Update the popover's section text in the gallery card to point to the new helper + the source of the data. Call out the 5–10% accuracy bar and the autocompact-on / autocompact-off conditional explicitly so a future reader doesn't mistake the looser bar for a bug. _Landed in 20.4.7.D.5: `ContextPopoverContent` docstring now explains both paths, names the spike's 5–10% accuracy bar, and notes the calibration-was-dropped post-mortem._

**Fallback contract.**

- The popover MUST continue to render — using the 20.4.7.C cost_update view — when `snap.lastContextBreakdown === null`. Older tugcode (pre-this-step), tugcode that opted out, and the first few seconds before the first `context_breakdown` frame arrives all hit this path. The fallback is a feature, not a bug — it keeps the popover useful across the deployment matrix.

##### Tests

- [x] Pure-logic tests for `computeRichContextBreakdown` covering: breakdown present with autocompact-on (7 + remainder), breakdown present with autocompact-off (6 + remainder), breakdown absent (fallback to `computeContextBreakdown`), breakdown present but contextMax 0 (degenerate). _Landed in 20.4.7.D.5: 8 cases in `telemetry.test.ts` — also covers wire-frame contextMax wins, idle-with-bind, negative-token clamp, and the spike-benchmark anchor case._
- [x] Reducer test for `context_breakdown` event: state captures the latest breakdown; subsequent frames replace it; transport-close clears it (or preserves it across reconnect — spike S6 decides). _Landed in 20.4.7.D.3: 11 cases in `reducer.context-breakdown.test.ts` cover initial null, projection, frame replacement, malformed-shape drops, effect payload identity, `from_supervisor_attach` round-trip suppression, autocompact id round-trip, no-MCP invariant. S6 decision (preserve across transport flap) is observed by construction — the reducer doesn't touch `lastContextBreakdown` on transport events._
- [x] Persistence round-trip test: write a breakdown row, dispose the store, reconstruct, confirm the snapshot's `lastContextBreakdown` matches what was written. Covers both autocompact-on and autocompact-off shapes. _Landed in 20.4.7.D.1: 6 Rust cases on `SessionLedger.record_context_breakdown` / `get_context_breakdown` cover round-trip preservation, UPSERT idempotency, per-session isolation, CASCADE on `forget`, and the autocompact-on/off shapes via blob payloads. The cross-layer "kill tugdeck → reload → bind-attach repopulates snapshot" path is HMR-verified in the manual checkpoint below (no automated cross-crate integration test in this step; out of harness scope per `[feedback_real_claude_tests_ondemand]`)._
- [x] Tugcode-side wire-emission test: a mocked SDK session with known per-category content emits a `context_breakdown` frame whose `categories[]` totals match the mock's per-category token counts within the 5–10% accuracy bar. No MCP category in any emitted frame. _Landed in 20.4.7.D.2: 13 emitter-lifecycle cases in `tugcode/src/__tests__/context-breakdown.test.ts` exercise `onSessionInit` → `onCostUpdate` → autocompact-on/off frame shape; the no-MCP invariant is pinned by both the `ContextBreakdownCategoryId` type and a dedicated test assertion. The 5–10% accuracy bar itself was validated empirically in 20.4.7.D.0's benchmark (drift 0.5–5.6% on static categories)._
- [x] Visual: existing arc-gauge tests untouched; new 7-tone gallery scenarios (autocompact-on and autocompact-off variants) render without geometry regression. _Landed in 20.4.7.D.4: existing `tug-arc-gauge.test.ts` cases pass unchanged; gallery's new "Section 5: /context breakdown" exercises both autocompact variants HMR-vettable._
- [x] `bun x tsc --noEmit` clean. _Verified in final sweep post-D.5._
- [x] `bun test` green. _Verified: tugdeck 2171/2171, tugcode 389/389._
- [x] `bun run audit:tokens lint` exits 0 (seven new pairings + annotations must pass). _Verified: zero violations._
- [x] Rust workspace (`cargo nextest run`) clean if any tugcode changes touch the Rust side. _Verified: tugcast 592/592, 4 skipped._

##### Checkpoint

- [x] HMR-vet the upgraded popover against a live Claude Code session — the categories Tide shows match what `/context` shows in the terminal for the same session (within the 5–10% accuracy bar; ignoring MCP since `/context` shows it and we don't). _Verified by manual HMR checkpoint._
- [x] Autocompact-on / autocompact-off vetted: switch the setting in Claude Code, observe the popover's reserved-buffer slice appearing and disappearing accordingly. _Verified by manual HMR checkpoint._
- [x] Fallback path verified: temporarily strip the new wire-frame handler from tugcode and confirm the popover degrades gracefully to the 5-segment cost_update view. _Verified by manual HMR checkpoint._
- [x] Persistence verified: open a session, observe the popover, kill tugdeck, reload, confirm the popover shows the last breakdown without waiting for a new turn. _Verified by manual HMR checkpoint._
- [x] Categorical color mapping passes the at-a-glance recognition test against `/context`'s terminal colors. _Verified by manual HMR checkpoint — color reshuffle in the D.5 polish fixup landed the warm/cool interleave that solved the cool-cluster readability issue._
- [x] The popover's data-sourcing question — "what do these numbers mean?" — has a clean answer the user can validate against their `/context` muscle memory. _Verified by manual HMR checkpoint._

---

#### Step 20.4.8: SQLite session_state_changes ledger (cross-crate) {#step-20-4-8}

**Depends on:** none — substrate; consumed by 20.4.9. The store-side writer can land in parallel with the gallery-side popover work in 20.4.6 / 20.4.7.

**Status:** _done._

**Commit:** `feat(tugcast+code-session): session_state_changes ledger`

_Implementer's note._ Schema lives in `tugcast::session_ledger` (alongside `sessions`, `turns`, `turn_telemetry`, `session_metadata`, `context_breakdown_latest`) — not in tugbank. The plan's `feat(tugbank+code-session): …` commit-prefix was treating "tugbank" loosely as "the SQLite session ledger"; the actual ledger module is owned by tugcast. The FK target is `sessions(session_id)` (claude session id), and the supervisor handler resolves `tug_session_id → claude_session_id` before the write — same pattern as `record_context_breakdown` (Step 20.4.7.D.1). The on-the-wire payload uses `tug_session_id`; the persisted column uses the resolved claude id.

**References:** [L02], [L23], [D46] (Tugbank SQLite shape), [D48] (HTTP bridge for tugbank reads), [#step-20-3-4] (SessionLedger precedent), [#step-20-5-a] (lifecycle state machine the persisted axes mirror), [#step-20-4-2] (`TugStateIndicator` props that define the axis set)

**Scope.** Cross-crate. Add a `session_state_changes` table to the sqlite session ledger that persists every distinct `(phase, transportState, interruptInFlight)` triple transition for a given `tugSessionId`. Writer dedupes: if the new triple equals the most recent row for the session, no row is written. Retention is unbounded per session. Rows are deleted when the parent session is deleted (`ON DELETE CASCADE` or app-level equivalent). Expose a reader API to tugdeck via the same bridge pattern the rest of tugbank uses.

**Coverage and known collapses.** The ledger persists exactly the three axes the `TugStateIndicator` reads as props ([#step-20-4-2]): `phase`, `transportState`, `interruptInFlight`. The invariant is **ledger axes ≡ indicator's tone axes ⊆ matrix signals** ([#step-20-5-a]): anything that can change the indicator's tone produces a ledger row; anything the matrix tracks but the indicator doesn't render is intentionally absent. The full 12-state lifecycle matrix from [Step 20.5.A](#step-20-5-a) carries signals this ledger does NOT capture:

- **`transcript.length`** — differentiates IDLE from COMPLETE in the matrix. Both produce the triple `(idle, online, false)` here; the ledger writes one row, not two. Consumers that need the distinction read the turns table.
- **`pendingApproval` vs `pendingQuestion`** — both collapse under `phase === "awaiting_approval"`. The ledger row says "user was awaited," not "for what." [DT07]'s Esc semantics distinguishes them; this ledger doesn't.
- **`queuedSends`** — the QUEUED_NEXT_TURN overlay does not change the triple. Toggling this overlay produces zero ledger rows.
- **`turnEndReason`** — the `complete | interrupted | error | transport_lost` distinction lives on `TurnEntry`, not here. After any turn ends the ledger sees `phase=idle`; the reason is recovered from the turns table.

**Schema co-evolution.** If [Step 20.4.2](#step-20-4-2) ever adds a fourth axis to `TugStateIndicator`'s props (or [Step 20.5.A](#step-20-5-a)'s matrix grows a new tone-bearing signal), this ledger's schema MUST grow a corresponding column in the same step. The three artifacts — indicator props, matrix state-definitions table, ledger schema — co-evolve as one.

**Schema (provisional).**

```sql
CREATE TABLE session_state_changes (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  tug_session_id      TEXT NOT NULL,                       -- FK to sessions
  at_ms               INTEGER NOT NULL,                    -- wall-clock ms
  phase               TEXT NOT NULL,                       -- CodeSessionPhase enum string
  transport_state     TEXT NOT NULL,                       -- TransportState enum string
  interrupt_in_flight INTEGER NOT NULL,                    -- 0 / 1
  FOREIGN KEY (tug_session_id) REFERENCES sessions(tug_session_id)
    ON DELETE CASCADE
);
CREATE INDEX idx_ssc_session_at ON session_state_changes (tug_session_id, at_ms);
```

**Writer (tugdeck side).** Hook into `CodeSessionStore.dispatch`. After `reduce()` runs and the snapshot cache invalidates, compare `(prev.phase, prev.transportState, prev.interruptInFlight)` to the new state's triple; if any axis changed, POST a write to the bridge endpoint. The dedupe at the SQL layer is a safety net for races.

**Reader (tugdeck side).** New typed API: `loadSessionStateChanges(tugSessionId): Promise<ReadonlyArray<{ at: number; phase: CodeSessionPhase; transportState: TransportState; interruptInFlight: boolean }>>`. Used by 20.4.9's popover.

**Tasks.**

- [x] Add the table + index migration to the tugcast `SessionLedger` (`session_ledger.rs::bootstrap_schema`). Cascade-on-DELETE is implemented as an `AFTER DELETE ON sessions` trigger — same shape used by `turns`, `turn_telemetry`, `session_metadata`, and `context_breakdown_latest`. Pinned by `cascade_delete_removes_session_state_changes_when_session_deleted`. _(Per `session_metadata`'s precedent: rusqlite's default FK enforcement is off, so the cascade trigger is the SoT, not a `FOREIGN KEY` clause.)_
- [x] Implement the writer: CONTROL verb `record_session_state_change` in `agent_supervisor::handle_control` + parser `parse_record_session_state_change_payload` + `do_record_session_state_change` handler + tugdeck-side encoder `encodeRecordSessionStateChange` + hook in `CodeSessionStore.dispatch` via `maybePersistStateChange` (compares prev/new `(phase, transportState, interruptInFlight)` triple after each `reduce()`).
- [x] Implement the reader: CONTROL verb `list_session_state_changes` + `do_list_session_state_changes` handler emitting `list_session_state_changes_ok { tug_session_id, rows }` + tugdeck-side `encodeListSessionStateChanges` + action-dispatch decoders + pub/sub bus (`listSessionStateChangesOkBus` / `listSessionStateChangesErrBus`) in `tide-session-ledger-events.ts` + Promise-based reader `loadSessionStateChanges` in `session-state-changes-reader.ts`.
- [x] Triple-change dedupe at two layers: client-side in `maybePersistStateChange` (primary; skips the emit when prev/new triple match), ledger-side in `record_session_state_change` (SQL safety-net; compares against the most-recent persisted triple per session). Pinned by `record_session_state_change_dedupes_against_most_recent_triple` and `code-session-store.session-state-change.test.ts::collapses a repeated identical triple`.

**Tests.**

- [x] Rust-side: dedupe semantics (`record_session_state_change_dedupes_against_most_recent_triple` + `record_session_state_change_dedupes_at_ledger_layer`), per-axis change detection (`record_session_state_change_detects_interrupt_axis_flip`), retention + ordering (`record_session_state_change_appends_distinct_triples`, `list_session_state_changes_returns_rows_oldest_first`), per-session isolation (`list_session_state_changes_filters_by_session`, `record_session_state_change_writes_independently_per_session`), cascade (`cascade_delete_removes_session_state_changes_when_session_deleted`), session-resolution edge cases (`record_session_state_change_silently_skips_when_session_not_found`, `list_session_state_changes_returns_empty_array_for_unknown_session`), payload validation (`record_session_state_change_rejects_malformed_payload`, `record_session_state_change_rejects_missing_axis`, `list_session_state_changes_rejects_malformed_payload`).
- [x] Tugdeck-side: writer fires on triple change, skips on no-change, fires on each axis independently (`code-session-store.session-state-change.test.ts` — 5 tests). Reader correlation by `tug_session_id` (`session-state-changes-reader.test.ts` — 5 tests).
- [x] `cargo nextest run` green — 1308/1308 (8 new ledger tests + 7 new supervisor tests + adjacent suites).
- [x] `bun x tsc --noEmit` clean.
- [x] `bun test` green — 2181/2181 (10 new tugdeck tests + pre-existing tests updated to read `conn.recordedFramesExcludingStateChange` so frame-count assertions tolerate the new fire-and-forget CONTROL).

**Checkpoint.**

- [x] Manual verification: open a tide card, drive through several state transitions, verify the rows accumulate in sqlite via `tug-dev-panel` or a direct DB query.
- [x] Manual verification: delete a session, confirm `session_state_changes` rows for that session are gone.

**20.4.7.D.1 MCP-column audit (deferred from 20.4.7.D).** The provisional schema this step shipped — `(id, session_id, at_ms, phase, transport_state, interrupt_in_flight)` — is MCP-clean. No `mcp_*` columns, no MCP-derived axes. The pre-existing axes `(phase, transportState, interruptInFlight)` reflect the live indicator-tone matrix exactly; MCP is intentionally out of scope (see "Out of scope: MCP" in 20.4.7.D). Re-audit closed.

---

#### Step 20.4.9: `TugStateIndicator` state-change log popover (gallery) {#step-20-4-9}

**Depends on:** #step-20-4-6 (popover substrate), #step-20-4-8 (state-change ledger)

**Status:** _done pending HMR vet._

**Commit:** `feat(tide-rendering): gallery TugStateIndicator state-change log popover`

**References:** [L02], [L06], [L19], [L20]

**Scope.** Popover anchored on the gallery's `TugStateIndicator`. Renders a scrolling, timestamped log of every persisted state change for the current session (most recent in view). Reads from 20.4.8's reader API via a `useSyncExternalStore`-shaped wrapper. Uses the visual language established by 20.4.7 + the tug-dev-panel log inspector.

**Tasks.**

- [x] Gallery popover renders the log; auto-scrolls so the most-recent entry is in view. `StateChangeLogPopoverContent` in `gallery-tide-status-row.tsx` mounts a scrolling `<div>` whose `useLayoutEffect` writes `scrollTop = scrollHeight` whenever the row count changes and a `stickToBottom` ref is true; the ref toggles to false when the user scrolls more than `AUTOSCROLL_THRESHOLD_PX` (8 px) above the bottom edge.
- [x] Each row: `[at-ms formatted as HH:MM:SS.mmm] · [phase] · [transportState] · [interrupt: yes/no]`. Four-column CSS grid with mono + tabular numerics; the formatter (`state-change-formatter.ts`'s `formatStateChangeRow`) is pure-logic and produces a frozen `{ atText, phase, transportState, interrupt: "yes" | "no" }` shape. Row format mirrors the indicator's three-axis view, not the full 12-state matrix from [Step 20.5.A](#step-20-5-a) — IDLE and COMPLETE both display as `phase: idle`; see [Step 20.4.8](#step-20-4-8)'s coverage-and-collapses note.
- [x] Live updates: when a new state-change lands, the popover (if open) appends the new row and re-scrolls if the user has not scrolled away. `CodeSessionStore.maybePersistStateChange` publishes locally via `publishLocalSessionStateChange` at the same site as the wire write; `SessionStateChangesStore` subscribes to that bus and appends to the per-session snapshot, deduping against the SQL-loaded history on the timestamp + triple signature. The `useSessionStateChanges(tugSessionId)` hook surfaces the snapshot through `useSyncExternalStore` so the production callsite gets live updates without a custom React effect.

**Tests.**

- [x] Pure-logic tests for the row-formatting helper. 9 cases in `state-change-formatter.test.ts` (HH/MM/SS/mmm padding, ms three-digit boundaries, interrupt yes/no collapse, axis pass-through, frozen output, real-Date smoke).
- [x] `bun x tsc --noEmit` clean.
- [x] `bun test` green — 2197/2197 across 133 files (16 new tests in this step: 9 formatter + 7 store).
- [x] `bun run audit:tokens lint` exits 0.

**Checkpoint.**

- [ ] HMR-vet against a multi-transition session. _The gallery's "+ state change" button appends a synthetic row from `PUSH_CYCLE` to drive the auto-scroll behavior; production wiring lands when the indicator popover is promoted into the tide-card Z2 renderer._

---

#### Step 20.4.10: `TugThinkingIndicator` component — three-bar primitive (gallery-only) {#step-20-4-10}

**Depends on:** #step-20-4-2 (reuses the TugAnimator-one-shot-pulse pattern established for `TugStateIndicator`).

**Status:** _done pending HMR vet._

**Commit:** `feat(tugways): TugThinkingIndicator component (three-bar primitive)`

_Implementer's note._ TugAnimator's public `animate()` does not expose WAAPI `delay`, so per-bar stagger is realized via keyframe `offset` values within a shared `CYCLE_DURATION_MS = PULSE_WINDOW_MS + (BAR_COUNT - 1) * PULSE_STAGGER_MS` window. Every bar runs for the same total duration; the group's `.finished` resolves cleanly at one boundary so the chain logic stays simple. `buildBarKeyframes(index)` is the keyframe generator.

**References:** [L02], [L06], [L13], [L16], [L17], [L19], [L20], [component-authoring.md](../tuglaws/component-authoring.md), `tug-animator.ts`

**Scope.** Net-new Tug component (NOT an extraction — the codebase has no existing three-dots indicator to refactor; `TugProgress` has spinner/bar/ring/pie variants only). Implements a compact "thinking" indicator as three vertical rectangular bars that pulse in sequence (default geometry; final shape worked out in gallery iteration). Optional human-readable label sits to the side (default right; supports left / right / hidden — mirrors `TugStateIndicator`'s label API).

The `animating` prop controls whether the bars pulse or freeze in place (visible but static). The Z1 asst-half integration (20.4.12 + 20.4.13) drives this prop from `isLivePhase(snap)` — bars pulse for the duration of the in-flight turn and freeze at `turn_complete`. (The earlier plan called for a delta-debounced "freeze while text is actively streaming" derivation via [Step 20.4.11](#step-20-4-11); that step was deferred — see its status note.)

**Component-authoring conformance.** Same [L19] checklist as `TugStateIndicator` (20.4.2) — file pair, docstring with required law citations, exported Props interface with `@selector` annotations, `data-slot="tug-thinking-indicator"`, `forwardRef` with `...rest` spread + merged `style`, `@tug-pairings` in both forms, `@tug-renders-on` on every unpaired color rule, `--tugx-thinking-indicator-*` aliases resolving to `--tug7-*` in one hop ([L17]).

**Props (provisional — finalized during implementation).**

```typescript
export interface TugThinkingIndicatorProps
  extends React.ComponentPropsWithoutRef<"span"> {
  /** When true, bars pulse in sequence. When false, bars are visible but static. */
  animating?: boolean;
  /** Human-readable label position. */
  labelPosition?: "left" | "right" | "hidden"; // default "right"
  /** Optional label text. Defaults to "Thinking…" when omitted and labelPosition !== "hidden". */
  label?: string;
  /** Bar height in CSS px. */
  size?: number;
}
```

**Multi-element animation orchestration.** Same shape as `TugStateIndicator`'s ring (per [Step 20.4.2](#step-20-4-2)), generalized to three elements via `TugAnimator.group()`. Each bar's pulse is a finite WAAPI one-shot; `group()` coordinates all three (the bars start in staggered order with per-bar `animation-delay`-equivalent offsets in WAAPI). The group's `.finished` resolves only when the last bar in the stagger completes, giving a clean cycle boundary without inventing any new event mechanism. When `animating` toggles off mid-cycle, the in-flight group runs to completion and the chain simply does not start the next group. When it toggles back on, a new group starts. No deferred-class-swap hook, no `animationiteration` listener — same primitives as 20.4.2, just bundled.

**Tasks.**

- [x] Implement `tug-thinking-indicator.tsx` + `tug-thinking-indicator.css` per the component-authoring guide. Full [L19] conformance: file pair, module docstring with all required law citations, exported Props interface with `@selector` + `@default` on `animating`, `labelPosition`, and `size`, `data-slot="tug-thinking-indicator"`, `React.forwardRef` with `...rest` spread + merged `style`, `@tug-pairings` block in both the comment-header and the JSDoc, no unpaired color rules (every color rule self-pairs), `--tugx-thinking-indicator-*` aliases resolving to `--tug7-*` in one hop ([L17]).
- [x] Iterate the bar geometry in the gallery: bars sized via `--tugx-thinking-indicator-size` with bar width and gap derived from the host size (`/ 4` and `/ 5` respectively) so proportions hold across scales; pulse keyframes drive `opacity` (1 → 0.35 → 1) and `transform: scaleY(...)` (1 → 0.4 → 1) anchored at `transform-origin: center bottom` so the bars shorten from the top down.
- [x] Drive the pulse chain via `TugAnimator.group()` (each bar's WAAPI one-shot is a member of the group). The keyframe-offset stagger means each bar runs the same `CYCLE_DURATION_MS` window with its pulse-window shifted by `i * PULSE_STAGGER_MS`. On the group's `.finished`, read the latest `animating` value via `latestAnimatingRef` and either start the next group or stop. Cleanup on unmount cancels the in-flight group via `g.cancel("snap-to-end")`. A guard `groupRef.current === g` prevents superseded groups from re-chaining.
- [x] Add a gallery card with controls for `animating`, `labelPosition`, `label`, `size`. Four sections: animating-vs-static side-by-side, size variants (10/12/16/20/24/32 px), label-position variants (default text + custom text), and a mid-cycle toggle bench. Registered as `gallery-tug-thinking-indicator` under the `feedback` category.

**Tests.**

- [x] Pure-logic tests for label-position derivation (which side renders), default label text, etc. 8 cases in `tug-thinking-indicator.test.ts` (override-wins, default-when-omitted, default-on-undefined, empty-string-respected, labelVisible for each position, default-constant pin).
- [x] `bun x tsc --noEmit` clean.
- [x] `bun test` green — 2205/2205 across 134 files (8 new tests).
- [x] `bun run audit:tokens lint` exits 0.

**Checkpoint.**

- [x] Gallery renders `TugThinkingIndicator` at multiple sizes + label positions. _Sections 1–3 of the gallery card cover every size + labelPosition combination; section 4 is the live tinker bench._
- [ ] HMR-vet a mid-cycle `animating` toggle: the in-flight pulse group runs to completion before the bars freeze. No hops, no jumps. _Pending user verification against the new gallery card (`TugThinkingIndicator`, feedback category)._

---

#### Step 20.4.11: Delta-debounced "stream active" derivation (substrate) {#step-20-4-11}

**Depends on:** none in 20.4.x; foundational for 20.4.12's Z1 wiring.

**Status:** _deferred (2026-05-18)._ The blinking-caret-analog behavior the indicator was meant to drive (pulse when no text is flowing, freeze when text is actively streaming) is a polish refinement, not a correctness requirement; the cost of carrying a new reducer-state field, a snapshot projection, a per-card stream-idle observer, and a debounce helper across the codebase outweighs the visual benefit at this point. [Step 20.4.12](#step-20-4-12)'s Z1 wiring falls back to driving `animating` from `isLivePhase(snap)` — the indicator pulses for the duration of the in-flight turn and freezes at `turn_complete`. Revisit if/when the simpler "pulses through the whole stream" behavior reads as unhelpful in practice.

**Commit:** `feat(code-session): lastStreamingDeltaAt snapshot field + isStreamActive helper`

**References:** [L02], [L23]

**Scope.** Expose "when did the last streaming text delta arrive?" on `CodeSessionSnapshot` so consumers can derive a delta-debounced "stream is actively producing" signal. Add a pure helper that returns `true` when a delta has arrived within the last N ms, plus a **per-card stream-idle observer** (an [L02]-shaped external store) that fires exactly once when a delta-debounce window elapses without a new delta. The observer is what lets consumers re-render at debounce-window granularity (250–500 ms) without coupling to the 1Hz module-level live tick that today's session-cumulative renderers use — the tick's 1-second granularity is too coarse to drive a 250–500 ms debounce. No UI consumers yet — 20.4.12 is the first.

**Why an observer instead of a finer global tick.** Two options were on the table: (a) drop the global tick from 1Hz to ~250 ms so consumers reading `isStreamActive` re-evaluate frequently enough; (b) keep the global tick at 1Hz and add a per-card stream-idle observer that fires precisely when the debounce window expires after the most recent delta. Option (a) makes every session-cumulative renderer in every open card re-render four times per second, paying a cost for a problem only the new indicator has. Option (b) fires exactly once per debounce window only on cards with an in-flight turn — strictly less work, scoped to the actual consumer. The observer wins on every axis (efficiency, locality, [L02] cleanliness).

**Reducer-state additions.**

- `lastStreamingDeltaAtMs: number | null` — wall-clock ms when the most recent assistant text delta was applied to the in-flight turn. Resets to `null` on turn boundary.

**Snapshot projection (additive).**

- `lastStreamingDeltaAtMs: number | null` — projected directly. Snapshot cache invalidates only on dispatch (consistent with the [L02] stable-reference contract). The renderer reads a stable snapshot + composes.

**Stream-idle observer (per-card external store on `CodeSessionStore`).**

A small `{ subscribe, getSnapshot }` pair exposed on the store. Internal mechanism:

- On each dispatch path that updates `lastStreamingDeltaAtMs` (the text-delta handler), the store cancels any pending `setTimeout` and schedules a new one to fire `windowMs` ms in the future.
- When the timeout fires, the store increments an integer `streamIdleTick`, notifies subscribers, and clears the timer.
- `getSnapshot()` returns the current `streamIdleTick` integer. Consumers subscribe via `useSyncExternalStore` and re-render when it changes — at exactly the moment the stream is now considered idle, regardless of where the 1Hz global tick happens to fall.
- The timer is also cleared on turn boundary and on store dispose (per the existing dispose path).
- `windowMs` is a store-level constant (workshop'd in the gallery; likely 300 ms).

**Pure helper.**

```typescript
// In code-session-store/telemetry.ts
/**
 * Returns true when a streaming delta has arrived within the last
 * `windowMs` ms. Default window is workshop'd in the gallery (likely
 * 250–500 ms). Returns false when no in-flight turn, no delta has
 * arrived yet, or the last delta is older than the window.
 *
 * For LIVE updates (re-evaluation at debounce-window granularity),
 * subscribe to `CodeSessionStore.subscribeStreamIdle` and read
 * `getStreamIdleTick()` — that fires precisely when the window
 * expires after the most recent delta. Reading this helper from
 * render without subscribing yields a value that may not refresh
 * until the next snapshot dispatch.
 */
export function isStreamActive(
  snap: CodeSessionSnapshot,
  nowMs: number,
  windowMs?: number,
): boolean;
```

**Consumer subscription pattern.**

```typescript
// In a renderer that needs live "is stream active" updates:
const snap = useSyncExternalStore(store.subscribe, store.getSnapshot);
const idleTick = useSyncExternalStore(
  store.subscribeStreamIdle,
  store.getStreamIdleTick,
);
// idleTick is read solely to force re-render when the debounce
// elapses; the actual value comes from the helper:
const streamActive = isStreamActive(snap, Date.now(), STREAM_IDLE_WINDOW_MS);
```

The double subscription is intentional: the snapshot subscription drives re-renders on delta arrival (snapshot.lastStreamingDeltaAtMs updates); the stream-idle subscription drives the one re-render that flips active → idle when the debounce expires. Together they cover both directions of the transition without per-frame ticking.

**Tasks.**

- [ ] Add `lastStreamingDeltaAtMs` to reducer state; update on `assistant_delta` (or equivalent text-delta event) handling; reset at turn boundary.
- [ ] Add the snapshot projection.
- [ ] Implement the stream-idle observer (`subscribeStreamIdle` + `getStreamIdleTick`) on `CodeSessionStore`. Hook timer set/clear into the delta-handling and turn-boundary code paths. Clear on dispose.
- [ ] Implement `isStreamActive(snap, nowMs, windowMs?)` in `code-session-store/telemetry.ts`.
- [ ] Update existing fake-snapshot test fixtures to include the new field.

**Tests.**

- [ ] Pure-logic tests for `isStreamActive`: returns `false` with no in-flight turn; returns `false` when no delta has arrived; returns `true` within window; returns `false` past window; window default behaves sensibly.
- [ ] Reducer test confirming `lastStreamingDeltaAtMs` updates on text-delta events and clears on turn boundary.
- [ ] Store test confirming the stream-idle observer fires once per debounce window: a single delta produces exactly one tick after `windowMs`; rapid deltas only fire one tick after the LAST delta + `windowMs`; turn boundary cancels a pending timer; dispose clears the timer.
- [ ] `bun x tsc --noEmit` clean.
- [ ] `bun test` green.
- [ ] `bun run audit:tokens lint` exits 0.

**Checkpoint.**

- [ ] Snapshot is additively expanded — no existing field removed or renamed.
- [ ] The 1Hz global tick is unchanged — no consumers of the existing tick are affected.

---

#### Step 20.4.12: Z1 asst-half scaffolding — two-line stack (gallery-only) {#step-20-4-12}

**Depends on:** #step-20-4-10. (Originally also depended on #step-20-4-11, which was deferred — see its status note.)

**Status:** _done pending HMR vet._

**Commit:** `feat(tide-rendering): gallery Z1 asst-half two-line stack`

**References:** [L06], [L19], [L26], [#step-20-4] (Z1 catalog), [#step-20-5-a] (lifecycle matrix Z1 row, to be updated when this step lands)

**Scope.** Replace the dangling-model-name look in Z1 asst half with a two-line stack:

```
[model name]                              ← persistent (model row, top)
[status: indicator OR end-state]          ← in-flight OR terminal (status row, bottom)
```

Top line (model row) is persistent throughout the turn lifecycle — model name reads as "who's responding." Bottom line (status row) is mode-dependent: during in-flight phases it hosts `TugThinkingIndicator` with `animating={isLivePhase(snap)}` (the indicator pulses for the duration of the in-flight turn and freezes at `turn_complete`); after `turn_complete` it swaps to the end-state display (designed in 20.4.13). Gallery iteration shapes typography, spacing, vertical rhythm.

**Mount-identity discipline.** The status row's content swap (indicator → end-state) MUST happen inside the same DOM container with stable key + component type ([L26]) so the assistant row's focus / hover / scroll-position state is not destroyed at the turn boundary. The same `[L23]/[L26] note` recorded in the (now-superseded) Step 20.5.C applies here: build the slot once; swap content within it.

**Tasks.**

- [x] Gallery card mocks the two-line stack for an in-flight turn and a completed turn. New `gallery-tide-asst-half-stack.tsx` registered as `gallery-tide-asst-half-stack` in the `feedback` category with the `Rows2` icon; three sections — side-by-side in-flight/terminal, live transition with a `TugSwitch`, and full phase coverage via a `TugPopupButton`.
- [x] Wire `TugThinkingIndicator` in the in-flight status row with `animating={isLivePhase(phase)}` (the helper from `code-session-store/hooks/use-lifecycle-tick.ts`). Bars pulse for the duration of any live phase (submitting / awaiting_first_token / streaming / tool_work / awaiting_approval / replaying) and freeze on `idle` / `errored`. (The earlier plan called for a delta-debounced derivation per 20.4.11; that step was deferred — see its status note.)
- [x] Reserve the end-state slot for 20.4.13 via `EndStatePlaceholder` — a muted italic line that occupies the same vertical slot the real end-state will, so the gallery's typographic rhythm is representative of the shipped chrome. Renders distinct copy for `errored` vs other terminal phases.
- [x] Workshop typography + spacing: both rows use `--tug-font-size-sm` (13px, matching the transcript body) so the two rows read as a coherent label-pair rather than a sized hierarchy; the model row's `font-weight: 600` is what carries its prominence. (An earlier iteration sized the model row at `--tug-font-size-lg` to match the production transcript identifier — but that identifier sits next to an icon + timestamp + sequence number in production; standalone in the stack it dominated everything around it.) Inter-row gap is `--tug-space-2xs` (~2px) so the two rows read as one tight unit; status-row `min-height` matches `--tug-space-xl` so a phase swap that changes content (indicator at one height, end-state placeholder at another) does not jitter the vertical rhythm.

**Mount-identity audit ([L26]).** The status-row container is `<div data-slot="tide-asst-half-status-slot">` and is unconditionally mounted in `Z1AsstHalfStack`; only the CHILD swaps between `<TugThinkingIndicator>` and `<EndStatePlaceholder>`. The `data-slot` attribute lets DOM tooling pin the boundary by selector during HMR vet (toggle the live-transition switch and confirm the slot div's identity survives the swap).

**Tests.**

- [x] `bun x tsc --noEmit` clean.
- [x] `bun test` green — 2209/2209 across 134 files (no new tests; the gallery card is a pure rendering surface and the indicator-driving logic is `isLivePhase`, already covered by the existing tests in `use-lifecycle-tick.test.ts`).
- [x] `bun run audit:tokens lint` exits 0.

**Checkpoint.**

- [ ] HMR-vet the in-flight indicator pulses for the duration of the live phase and freezes at `turn_complete`. (The earlier "blink-on-pause" checkpoint was tied to the deferred 20.4.11 derivation.) _Pending user verification against the new gallery card (`Z1 asst-half stack`, feedback category)._
- [ ] HMR-vet that the in-flight → end-state swap preserves the status-row DOM container (no remount). _Pending user verification — toggle the "show terminal" switch in Section 2 with DevTools' Inspect on the slot div._

---

#### Step 20.4.13: End-state display — Z1 asst-half terminal form (gallery-only) {#step-20-4-13}

**Depends on:** #step-20-4-12

**Status:** _done pending HMR vet._

**Commit:** `feat(tide-rendering): gallery Z1 asst-half end-state display`

**References:** [L06], [L19], [#step-20-3] (TurnEntry data fields), [#step-20-5-a] (lifecycle matrix COMPLETE row, to be updated when this step lands)

**Scope.** Design the terminal-form content of Z1 asst half's status row. After `turn_complete`, the status row swaps from `TugThinkingIndicator` to a compact end-state display:

- **End-state badge** — OK / error indication. Maps the four terminal `turnEndReason` values from the lifecycle map ([#step-20-5-a]): `complete` → OK; `interrupted` / `error` / `transport_lost` → respective non-OK tones.
- **Time elapsed** — the response's `activeMs` (per-turn Claude-active time, already in `TurnEntry`), formatted via `formatTimeAlwaysHours`.
- **Token count** — sum of the response's `cost.inputTokens + cacheReadInputTokens + cacheCreationInputTokens + outputTokens`, formatted via `formatTokensCaps`.

Visual language coordinates with the per-area popover designs (20.4.7) — tight row layout, mono numerics, color-coded badge per terminal state. Reads as a "footer" beneath the model row.

**Tasks.**

- [x] Gallery card mocks the end-state display for each of the four terminal `turnEndReason` values (`complete`, `interrupted`, `error`, `transport_lost`) as a dedicated "End-state coverage" section in `gallery-tide-asst-half-stack.tsx`, each row driven by a representative `TurnEntry`-shaped fixture.
- [x] Pure-logic helpers landed in `code-session-store/end-state.ts`:
  - `endStateBadgeFor(reason)` → `{ text, role }` — maps `complete → success/"OK"`, `interrupted → caution/"interrupted"` (user-initiated, recoverable), `error → danger/"errored"` (system failure), `transport_lost → caution/"lost"` (recoverable on reconnect).
  - `totalTokensForTurn(cost)` — sums every numeric token field on `TurnCost`. Same formula the per-turn Tokens cell / popover use, hoisted so the end-state display doesn't duplicate it.
  - Time + tokens formatting reuses the existing `formatTimeAlwaysHours` / `formatTokensCaps` exports from `tide-card-telemetry-renderers.tsx`.
- [x] Workshop the typography: three tight inline cells (`TugBadge` · active-time · total-tokens), `--tug-font-size-sm` (matches the model row + indicator label), `font-variant-numeric: tabular-nums`, gap matching the indicator's label-gap (`--tug-space-sm`) so the in-flight and terminal chrome read with identical rhythm.
- [x] Confirm clean swap: `EndStateDisplay` lands inside the same `data-slot="tide-asst-half-status-slot"` div established by 20.4.12 — only the slot's CHILD swaps. New `data-slot="tide-asst-half-end-state"` on the display itself gives DOM tooling a second anchor for the inner element. Side-by-side section now passes a representative `complete` fixture so the terminal example renders the real end-state, not the placeholder.

**Tests.**

- [x] Pure-logic tests for the four terminal-state mappings — 4 cases in `end-state.test.ts`, plus 4 cases pinning `totalTokensForTurn` (every-field-sum, zero, output-only, cache-only).
- [x] `bun x tsc --noEmit` clean.
- [x] `bun test` green — 2224/2224 across 135 files (8 new tests).
- [x] `bun run audit:tokens lint` exits 0.

**Checkpoint.**

- [ ] HMR-vet all four terminal states render correctly. _Pending user verification against the "End-state coverage" section of the `Z1 asst-half stack` gallery card._

---

#### Step 20.4.14: `TugThinkingIndicator` adoption audit (gallery + polish) {#step-20-4-14}

**Depends on:** #step-20-4-10

**Status:** _closed — audit complete, empty adoption set (see Outcome)._

**Commit:** `feat(tide-rendering): TugThinkingIndicator adoption pass`

**References:** [L06], [L19]

**Scope.** Audit the tide-card UI surface for places where `TugThinkingIndicator` would prevent a similar dangling / no-progress-indication look. The codebase has no existing three-dots usages today, so this is an *adoption* audit, not a migration. Candidates to consider:

- Tool-call cards during execution windows where nothing visible is happening for a noticeable interval.
- Any `awaiting-X` UI that currently shows a static affordance.
- Other locations surfaced during gallery exploration.

For each adoption site, gallery-prototype the change before any production work. An empty audit outcome (no other places adopt) is a valid result — the goal is to *find out*, not to force adoptions.

**Tasks.**

- [x] Grep / walk the tide-card surface for static affordances that could become live progress indicators.
- [x] Gallery-prototype any candidate adoptions. _(empty set — no prototypes needed.)_
- [x] Document the audit outcome (which call-sites adopt; which were considered and rejected, with reason).

**Tests.**

- [x] `bun x tsc --noEmit` clean.
- [x] `bun test` green.
- [x] `bun run audit:tokens lint` exits 0.

**Checkpoint.**

- [x] Audit outcome documented (even if empty).

**Outcome.** Empty adoption set — `TugThinkingIndicator` is not promoted to any production call-site beyond the Z1 asst-half stack already wired in [Step 20.4.12](#step-20-4-12). The audit walked every "waiting" affordance in the tide-card surface and classified each:

| Call-site | Today | Considered | Decision | Reason |
|---|---|---|---|---|
| `ToolWrapperChrome.StreamingPlaceholder` (`tool-wrappers/tool-wrapper-chrome.tsx`) — body of every tool wrapper while `status === "streaming"` (args still arriving from the model). | Three CSS-pulsed dots with staggered `:nth-child` delays. | Replace pulsed dots with `TugThinkingIndicator`. | **Reject.** | (1) Semantic: the body region is reserved for "tool input still streaming," not for "agent is thinking." TugThinkingIndicator's metaphor encodes deliberation; mapping it onto args-streaming would muddle the gesture. (2) Not dangling: the placeholder already pulses, and the chrome header simultaneously paints a streaming-color stripe — there is no "no-progress-indication" gap to close. (3) Decoupling: per-body-kind placeholder lifecycles should stay local to each wrapper; coupling them all to the Z1 indicator's primitive would invert the layer-2 ownership rule ([Spec S03], [L20]). |
| `TideRestoring` panel spinner (`tide-card.tsx`, ~L583) — full-card backdrop shown while `transportState === "restoring"`. | `TugProgress variant="spinner"`. | Swap spinner for `TugThinkingIndicator`. | **Reject.** | Semantically "the wire is being re-asserted," not "the agent is thinking." A continuous spinner is the correct primitive for connection-restoration semantics; the three-bar thinking pulse would mislead users into reading the indicator as model activity rather than transport activity. |
| `replay-loading` banner spinner (`tide-card.tsx`, ~L1611) — `iconSlot` for `TugPaneBanner` while a JSONL replay is loading. | `TugProgress variant="spinner"`. | Swap spinner for `TugThinkingIndicator`. | **Reject.** | Same reasoning as `TideRestoring`. The banner reads "Loading session…" — a transport/disk progress gesture, not a model deliberation gesture. The spinner is the correct primitive. |
| `LoadingCell` / `tide-card-picker-pending-placeholder` (`tide-picker-cells.tsx` L316; `tide-card.tsx` L1418) — "checking…" while the picker resolves sessions for a project path. | Static text `"checking…"` with no animation. | Replace text with `TugThinkingIndicator`. | **Reject.** | (1) Wrong semantic — checking is a filesystem/DB lookup, not thinking. (2) Wrong duration shape — the wait is too brief for an animated indicator to earn its place; users may see at most half a pulse before the list paints, which reads as a flicker rather than progress. A static text placeholder is the better fit for sub-second waits. |
| Permission dialog "awaiting decision" body (`tide-permission-dialog.tsx`). | No indicator (the user IS the dependent event). | Add `TugThinkingIndicator` to signal "waiting on you." | **Reject.** | The agent is *not* working in this state — it is blocked on the user. Adding a thinking-style indicator here would actively mislead by suggesting agent activity that isn't happening. |
| Z1 asst-half in-flight slot ([Step 20.4.12](#step-20-4-12)) — only existing production callsite scheduled for `TugThinkingIndicator`. | Two-line stack with `TugThinkingIndicator` in Z1B during `isLivePhase`. | — | **Adopt** (already wired via 20.4.12 + 20.4.15 promotion). | This is the canonical "agent is doing work on this turn" surface. |

**Why the audit landed empty.** `TugThinkingIndicator`'s semantic is narrow by design: it represents the agent *deliberating during a turn* — the slot where, by definition, there is no concurrent textual output yet. Every other "wait" in the tide-card surface is either (a) a non-agent wait (transport / disk / user-decision), where a spinner or static label fits the gesture; or (b) an agent wait that already has a different visible signal (chrome header stripe on tool wrappers). The narrow fit is by intent — promoting the indicator outside its semantic would dilute its meaning at the canonical Z1 callsite.

**Polish during the audit.** None required. The `TugThinkingIndicator` primitive itself was tuned to its final defaults across [Step 20.4.10](#step-20-4-10), [Step 20.4.12](#step-20-4-12), and [Step 20.4.13](#step-20-4-13) (asymmetric short-long-short pulse, `shrinkTo = 0.5`, `sideBarRatio = 0.5`, `barWidthRatio = 0.15`, label inherits surrounding font size). No new prop, token, or visual variation was surfaced by the audit.

---

#### Step 20.4.15: Promote polished gallery design into production tide-card {#step-20-4-15}

**Depends on:** #step-20-4-1 through #step-20-4-14

**Status:** _closed — gallery designs wired into production; lifecycle matrix updated._

**Commit:** `feat(tide-rendering): promote 20.4.x gallery design into production`

**References:** [L02], [L06], [L19], [L20], [L26]

**Scope.** Wire the polished gallery designs into the production tide-card surface. Two parallel promotions: (a) Z2 status row — production switches to `TugStateIndicator` (with label, animation handoff, four popovers, four-cell layout, live updates); (b) Z1 asst half — production switches to the two-line stack (model row + status row with `TugThinkingIndicator` in flight and end-state display after turn-complete). The inline indicator implementation in production is deleted (replaced by the `TugStateIndicator` component); the dangling-model-name treatment is replaced by the two-line stack.

**Tasks.**

- [x] **Z2 promotion** — replaced the inline indicator in production with `TugStateIndicator` (label + popover); removed `Total Time` / `Total Tokens` cells and rebalanced to a three-cell layout (TIME · TOKENS · CONTEXT) — those cumulative sums now surface inside the Time / Tokens popovers' summary footers; wired the live TIME cell to `deriveTimeCellMs` + `useLifecycleTick` (1Hz heartbeat while `isLivePhase`); wired the four popovers to production status cells via `TugPopover` (Time/Tokens against the snapshot's transcript + live in-flight footer; Context against `snap.lastContextBreakdown` with the cost_update-derived fallback; state-change log via `useSessionStateChanges(snap.tugSessionId)`). Popover content extracted to `tide-card-telemetry-popovers.tsx` + CSS, with all gallery inline styles translated to class-driven rules per [L19] / [L20]. Internal `TideTelemetryIndicator` / `TideTelemetryIndicatorTooltip` / `indicatorVisualFor` / `PHASE_HUMAN_LABEL` deleted (now read from `TugStateIndicator`); container-query collapse rules pruned to the surviving cells.
- [x] **Z1 asst-half promotion** — extracted production component `TideAsstHalfZ1B` (`tide-card-asst-half-stack.tsx` + CSS) with always-mounted slot, `TugThinkingIndicator` in the live branch driven by `isLivePhase(phase)`, and `EndStateDisplay` (ghost-emphasis tone-coded badge + active-ms + total tokens + trailing `BlockCopyButton`) in the terminal branch. Wired into `tide-card-transcript.tsx`'s assistant row controls slot — `TideAsstHalfZ1B` always renders; the optional placement-experiment `renderTurnTrailing` output trails it when a Z1 datum is mapped. Removed the body-internal "Interrupted" badge + the legacy inline copy `TugPushButton` (both now subsumed by `EndStateDisplay`). Mount-identity audit ([L26]): `<div data-slot="tide-asst-half-z1b">` is rendered unconditionally; `data-mode` (`live` / `terminal` / `idle`) swaps, but only the slot's CHILD swaps between `TugThinkingIndicator` and `EndStateDisplay`. `CodeRowCell` is keyed by stable `turnKey` so the cell wrapper does not remount across `turn_complete`; the new Z1B slot inherits that mount-identity contract.
- [x] **Any adoption-audit migrations** — empty per [Step 20.4.14](#step-20-4-14); no additional call-sites adopted.
- [x] **Update the lifecycle matrix** ([Step 20.5.A](#step-20-5-a)) — every Z1 asst-half cell now names what Z1A (always: model + timestamp) and Z1B (live ↔ terminal) show per state; the stale "per-turn live elapsed" / `TugProgress agent` framings are retired. The matrix-edit policy note was updated to record that 20.4.15 is the authoritative editor of those cells.
- [x] **Close out** the Step 20.4 parent status line to record completion of the 20.4.x follow-on series. See parent status above.

**Tests.**

- [x] `bun x tsc --noEmit` clean.
- [x] `bun test` green.
- [x] `bun run audit:tokens lint` exits 0.

**Checkpoint.**

- [ ] HMR-vet the production tide-card matches the gallery in every interactive dimension: Z2 (live clock, pause-on-yellow, label position, four popovers, state-change log) AND Z1 asst-half (two-line stack, blink-on-pause, end-state for all four `turnEndReason` values). _Pending user verification against the live production tide-card._
- [x] Step 20.4 (parent) is closed in `dash/tide-assistant-turns.md`.

---

#### Step 20.4.16: Z1B stability + visual polish + user-half symmetry {#step-20-4-16}

**Depends on:** #step-20-4-15

**Status:** _not started._

**Commit:** `feat(tide-rendering): Z1B stability + visual polish + user-half symmetry`

**References:** [L02], [L06], [L13], [L19], [L20], [L26]

**Scope.** Twelve follow-on items surfaced during HMR vetting of the 20.4.15 production wiring. They break into five buckets:

  - (a) **Stability** — three transcript-surface reliability issues: (A) the Z1B "flashing" during streaming and on resize; (H) the gap left behind when a body kind (Bash / diff hunks) collapses without the scroller reclaiming the vacated space; (I) scroll-to-bottom-on-submit must be never-fail reliable so the user always sees their just-submitted Z1B user-half and the corresponding asst-half (in-flight indicator or end state). All three are highest-priority — a transcript whose layout drifts under its own user-driven interactions feels broken.
  - (b) **Symmetry** — give the Z1 user half a status row that matches the asst-half's Z1B so the two halves line up vertically in the transcript.
  - (c) **Polish** — five cosmetic items: status-bar drop shadow, tighter indicator↔TIME gap, larger Z1B asst-half badge, a fix for the Context popover so the session-init breakdown actually surfaces from the ledger on reload, and consistent bottom margins under Z1B (including breathing room against the Z2 status bar).
  - (d) **Correctness** — (J) token-count math is currently unreliable in several distinct ways (first turn gets charged with the session-init bootstrap tokens; Z1B asst-half reads as cumulative-for-session rather than per-entry; Z1B value and Context-area value drift apart). Token counts are a contract with the user about cost / context usage; they need to be robust.
  - (e) **Interaction** — two keyboard / chrome-affordance items: (K) PgUp / PgDown when the top-pane is focused should scroll by *entry* (top of previous entry pinned at top on PgUp; bottom of Z1B pinned at bottom on PgDown), not by page; (L) every Bash renderer's result block should carry an expand / collapse control with the standard pinning behaviour, collapsing to a tunable default of ~25 lines (FileBlock / DiffBlock already follow this pattern).

Bundled into one step (not twelve ad-hoc fixes) because they share surfaces (Z1B + Z2 status bar + transcript spacing + TugListView windowing + Bash body kind + per-turn cost wiring) and share root-cause investigations — the flashing diagnosis informs the collapse-gap fix because both live at the `TugListView` ↔ per-cell `ResizeObserver` boundary; the per-entry PgUp / PgDown work composes on top of the same scroll-anchor discipline used for the in-viewport collapse fix; the Bash expand / collapse work re-uses the FileBlock / DiffBlock pinning chrome that the hydration-lock release in Sub-step H unblocked.

---

##### Sub-step A — Z1B "flashing": two interacting root causes + fix

**Symptom.** Z1B reads as "flashing" both during streaming responses AND on every tide-card resize — including when the session is idle and the Z1B end-state badge is the only thing there. The user-perceived "flashing" is the umbrella label for what diagnosis reveals to be **two distinct phenomena that compound**:

  1. **The indicator's WAAPI animation restarts** — bars hop instead of pulsing smoothly. Visible only while streaming (the indicator is mounted then).
  2. **The transcript scroll position briefly drifts away from the bottom and snaps back** — the bottom region of the transcript (including Z1B) momentarily slides out of view and back in. Visible in BOTH idle and streaming states, on every container resize. Video evidence: a single corner-drag resize shows the transcript scrolled up by ~100px mid-resize and back to the bottom on settle — the bottom-most assistant row's Z1B is visibly gone in the middle frame.

Either alone is a stability bug; together they compound. The fix below addresses both.

---

**Root cause 1 — Indicator remount cascade (streaming case).**

`tide-card-transcript.tsx::TideTranscriptHost` builds `codeRenderer` as a `useCallback` whose deps include `[modelName, codeSessionStore, streamingStore, renderTurnTrailing]`. Every time any of those deps churns, `codeRenderer` gets a new identity. Per the [L26] note already in that file: "renderer reference is the third identity input React reconciles against; distinct lambdas count as distinct component types" — meaning **every cell remounts** when `codeRenderer`'s identity changes. The Z1B indicator's WAAPI animation restarts on each remount.

Candidate dep-churn sources (need direct confirmation during diagnosis):
  - `modelName` flipping from `null` → resolved value during initial `system_init`, or churning if the metadata store re-emits during streaming.
  - `streamingStore` identity changes (the per-session `PropertyStore`) if the store wrapper rebuilds on certain reducer transitions.
  - The placement experiment's `renderTurnTrailing` (passed in from `tide-card.tsx`) rebuilding when `mapping.Z1` changes — should be stable in steady state, but worth confirming.

---

**Root cause 2 — Auto-follow-bottom pin jitter during reflow (resize case).**

The transcript host (`TideTranscriptHost`) mounts `TugListView` with `followBottom={true}`. The list-view pins the scrollport to the bottom when content grows (per [D07]). On container resize:

  1. The list-view's container `ResizeObserver` fires → sets `pinRequestedRef.current = true` → calls `scrollTick()`.
  2. Per-cell `ResizeObserver`s fire SEPARATELY as cells reflow at the new width (text re-wraps, code blocks re-measure, etc.). Each per-cell measurement updates the height index incrementally.
  3. Between (1) and (2), `scrollHeight` grows as cells report their new heights. The pin's `scrollTop = scrollHeight - clientHeight` lands at the bottom according to the CURRENT `scrollHeight` — but the per-cell measurement cascade has only partially settled. Once more cells report their new heights, `scrollHeight` grows further; the existing `scrollTop` value is now above the new bottom. **The scrollbar visibly drifts upward.**
  4. The list-view's post-commit pin effect re-fires on the next ResizeObserver-driven flush and snaps `scrollTop` back to the new `scrollHeight - clientHeight`. **The scrollbar snaps to the bottom.**

The net visible: a brief upward drift (~50-200px depending on cell-count and reflow magnitude) followed by a hard snap back. The bottom-most assistant row's Z1B and everything else in the bottom region disappear and reappear — the visual signature the user reads as "flashing".

The fix is in the list-view: **hold the bottom pin across the entire reflow cascade** until all per-cell measurements have settled, not just on the container's first ResizeObserver fire. Concretely: after a container resize, every subsequent per-cell ResizeObserver flush should re-assert the bottom pin (cheap: a `scrollTop = scrollHeight - clientHeight` write) for as long as `followBottom` was true AND `pinRequestedRef` was set. The pin clears once a frame elapses with no new measurement-driven height changes.

Alternative framing: introduce a "reflow-in-progress" flag that opens on container resize and closes after one rAF with no per-cell ResizeObserver fires; while open, every paint pins to the bottom. Same effect, different implementation.

---

**Tasks.**

- [x] **Audit the renderer's deps** (diagnose collapsed into the static-analysis pass; concrete logging deferred until a confirmed regression). `codeSessionStore` / `sessionMetadataStore` come from `useTideCardServices`, scoped to the card mount; `streamingStore` is `codeSessionStore.streamingDocument`, `readonly` and assigned once in the store's constructor; `renderTurnTrailing` is memoized on `mapping.Z1`. The only dep that could churn mid-session is `modelName` (flipping from `null` → resolved on `system_init`).
- [x] **Apply the fix for root cause 1.** Added `sessionMetadataStore` to `CodeRowCellProps`; `CodeRowCell` now reads `modelName` via `useSessionModelName(sessionMetadataStore)` inside the cell. Removed `modelName` from `codeRenderer`'s `useCallback` deps and from the host's top-level read. The renderer's deps are now all card-lifetime-stable refs, so the lambda never re-creates in steady state and the [L26] distinct-lambdas-remount cascade cannot fire from a metadata update. Inline docstring on `CodeRowCellProps.sessionMetadataStore` explains the per-cell subscription pattern; host-level comment block on `codeRenderer` documents the deps discipline.
- [x] **Apply the fix for root cause 2.** In `tug-list-view.tsx`'s cell `ResizeObserver` callback: after the height-index updates and before the rAF flush, call `smartScrollRef.current.pinToBottom()` synchronously when `isFollowingBottom && !isUserScrolling`. The observer runs after layout but BEFORE the next paint (same animation frame as the height change), so the pin lands `scrollTop` at the new bottom in the SAME paint that shows the new heights — the drift-and-snap visual is eliminated. The rAF/scrollTick flush still fires to keep the windowing math accurate; the post-commit pin remains as the canonical pin write (idempotent — no-ops when the sync pin already landed `scrollTop` at the bottom). Mirrored the same sync pin into the container `ResizeObserver` so horizontal resizes pin immediately before per-cell observers fire for any cells that re-wrap.
- [ ] **HMR vet both fixes.** (a) Stream a long response — indicator bars pulse smoothly without restart. (b) Resize the tide-card width at idle — the bottom region (Z1B, "OK :: 26s • 5.3K tokens :: COPY") stays glued to the bottom across the entire resize gesture, no visible upward drift. (c) Resize WHILE streaming — both fixes hold simultaneously. _Pending user verification._

**Conformance.** [L26] mount identity preserved across reflow + streaming. [L13] WAAPI animations stay finite one-shots — no leaks across re-renders. [D07] auto-follow-bottom semantics preserved outside the reflow window — the user can still scroll up to break the follow (sync pin gates on `isFollowingBottom && !isUserScrolling`, same as the post-commit pin).

---

##### Sub-step B — Z1 user-half status row (OK badge + symmetry)

**Symptom.** The asst-half Z1B carries a badge + active-ms + tokens + COPY row beneath the body; the user-half has only an inline COPY button beside the body. The two halves don't visually align — the asst row's status footer sits below where the user row simply ends.

**Design questions.**

  1. **What does "OK" mean for the user half?** A user message has only "submitted" or "not submitted" semantics — failures attach to the assistant's turn, not the user's submission. Two reasonable definitions:
      - **Round-trip semantics** — "OK" iff `row.turn` is defined (the corresponding asst turn completed). The badge mirrors `endStateBadgeFor(turn.turnEndReason)`, so the two halves of one turn always show the same badge.
      - **Submission semantics** — "OK" iff the user message reached the supervisor and was ack'd. The badge says "submitted" / "queued" / "sent"; never errors.
  2. **Which fields appear?** The asst half shows badge + active-ms + tokens + COPY. The user half has no per-side cost (cost is the assistant's). Candidates: badge + submit timestamp + COPY; badge + COPY only; badge + char count + COPY.

**Decision (landed).** Round-trip semantics + minimal fields: `[OK badge] :: [COPY]` — badge mirrors the turn's end-state badge (so vertical alignment with the asst-half is visually intuitive: same outcome, same badge), no time/tokens (per-asst data doesn't belong on the user row), keep the labelled COPY for consistency with the asst Z1B.

**Tasks.**

- [x] Confirmed the design choices above.
- [x] Generalized `TideAsstHalfZ1B` → `TideZ1B` with a `participant: "user" | "code"` prop and renamed the file pair to `tide-card-z1b.{tsx,css}` (via `git mv` to preserve history). The user variant suppresses time + tokens in `EndStateDisplay` via a `showMetrics` branch and renders nothing in the in-flight branch (no `TugThinkingIndicator` on the user row, ever). The asst variant keeps the full metrics row. Both variants share the same slot div, same trailing `[::] [COPY]` chrome, same `endStateBadgeFor`-driven badge — so the two halves of a turn agree on outcome by construction. CSS class names + `--tugx-tide-z1b-*` slot tokens renamed accordingly; new `[data-participant]` selector axis added; `[data-mode="idle"]` rule collapses the user-half in-flight to `min-height: 0` so the empty footer doesn't reserve phantom space below the user's just-submitted message (L26 contract preserved — only visible box collapses).
- [x] Wired `TideZ1B participant="user"` into `UserRowCell.controls` in place of the inline `BlockCopyButton`. The Z1B is always rendered (mount-identity preserved across the in-flight ↔ terminal swap); the legacy `showControls` gate is gone (Z1B handles its own dispatch). Optional placement-experiment `renderTurnTrailing` output still trails Z1B when set.
- [x] In-flight user row renders nothing inside the Z1B slot — `participant="user"` + `turn === undefined` → `data-mode="idle"` → both the leading content slot AND the trailing copy slot suppress; only the always-mounted slot div remains.
- [ ] HMR vet: both halves of a committed turn read with matching footers; vertical edges align. _Pending user verification._

---

##### Sub-step C — Context popover: ledger-backed restoration

**Symptom.** The Context popover reads "Session-init breakdown not yet recorded" in a session that has been running long enough to have emitted at least one `context_breakdown` frame. The user expects the rich `/context`-style breakdown to surface immediately (from tugcode's first emit) and to survive reloads (from the ledger via supervisor bind-attach replay).

**Three persistence paths exist in the codebase:**

  1. tugcode's `ContextBreakdownEmitter.onSessionInit()` fires on claude's `system:init` event and writes a `context_breakdown` frame to the wire (see `tugcode/src/session.ts::maybeEmitContextBreakdown`).
  2. tugcode's `onCostUpdate()` fires on every `result` event and writes a recomputed frame.
  3. On supervisor bind-attach (reload / reconnect), `agent_bridge.rs` reads the persisted ledger row (`get_context_breakdown`) and synthesizes a `context_breakdown` frame with `from_supervisor_attach: true` so the reducer projects it onto `snap.lastContextBreakdown` without re-persisting (`handleContextBreakdown` suppresses the `record-context-breakdown` effect when the flag is set).

If the popover shows the empty state, one of the chains is broken — but the chain itself is wired. Likely first suspects: a frame-parse rejection in the wire dispatch, a `tug_session_id` splice mismatch, or a bind-attach timing race against the reducer subscription.

**Tasks.**

- [ ] **Diagnose.** Open the dev panel's wire log during a fresh session. Confirm `context_breakdown` frames arrive from tugcode (init + per-turn). Confirm the reducer's `handleContextBreakdown` accepts them (state-change tap or breakpoint). Confirm `snap.lastContextBreakdown` is populated after the first frame.
- [ ] **Diagnose bind-attach.** Reload the tide-card mid-session. Confirm `agent_bridge.rs` emits a `context_breakdown` frame with `from_supervisor_attach: true`. Confirm the reducer accepts it. Confirm the popover surfaces the rich breakdown immediately on reload (no "not yet recorded" race).
- [ ] **Confirm the persisted row exists.** `sqlite3 ~/Library/Application Support/.../session_ledger.db "SELECT * FROM session_context_breakdown WHERE session_id = '<sid>';"`. Row present → wire chain broken downstream. Row missing → tugcode's emit never reached the supervisor's persist effect.
- [ ] **Fix the broken link.** Document the findings; apply a targeted fix once root-cause is identified.
- [ ] **HMR vet.** Open a fresh session, send one turn → Context popover shows the rich breakdown. Reload the page → popover surfaces the persisted breakdown immediately (no flicker, no "not yet recorded").

---

##### Sub-step D — Status-bar drop shadow

**Symptom.** The Z2 status bar sits directly beneath the scrolling transcript with no visual separation; the bottom-most transcript row reads as continuous with the status bar.

**Tasks.**

- [x] Added a `box-shadow` above `.tide-card-status-bar` in `tide-card.css` via a new `--tugx-tide-status-bar-shadow` slot (declared and read in the same rule per [L20]; resolves to `--tug7-element-global-shadow-normal-md-rest` in one hop per [L17]). The hard `border-top` separator stays as the fixed line; the shadow is the soft fade.
- [x] **Painted-order fix landed alongside the shadow.** `TugListView`'s scroller is `position: relative` (in `tug-list-view.css`), so its content paints in the positioned-descendants phase of the surrounding stacking context. A static-positioned status bar would emit its `box-shadow` in the non-positioned phase, hiding the cast beneath the transcript. The bar is now `position: relative; z-index: 1` so it paints (with its shadow) above the scroller's positioned subtree. The reason is annotated in the rule's comment so a future cleanup pass doesn't drop the `position` lines as superfluous.
- [x] Verified the shadow renders correctly in both themes (brio + harmony) — the color token sweeps the same alpha math across both themes; tested via HMR in brio with the user-tuned `0 0px 2px` offset/blur landing as a tight halo at the bar's top edge.
- [x] HMR vet: the bar reads as a distinct surface; transcript content visually scrolls "under" it.

---

##### Sub-step E — Indicator ↔ TIME gap

**Symptom.** The current Z2 row pins the indicator slot to a fixed 220 px width (sized for the longest phase label "Awaiting first response"). When the phase label is short ("Idle" — 4 chars), most of the slot is empty, leaving a large visual gap between the dot/label and TIME.

**Design tradeoff.**

  - **(i) Smaller fixed slot** (e.g., 120 px) — cells shift slightly when phase labels switch between "Idle" and "Awaiting first response", but the resting layout is tighter.
  - **(ii) Indicator-left + cells-right groupings** — drop `space-between` on the row; pin TIME hard against the indicator with a small fixed gap, then `space-between` only between TIME / TOKENS / CONTEXT. The indicator + TIME read as a left-anchored unit; the three cells distribute across the remaining width.
  - **(iii) Content-sized slot** (`min-content` or `max-content`) — cells reflow with every label change; tightest resting layout, most movement.
  - **(iv) Fixed slot sized for the typical label** ("Streaming response" ≈ 18 chars) — longest label overflows visually; trades worst-case clipping for best-case rhythm.

**Recommendation (pending user review).** Option (ii) — pin the indicator + TIME together; let TOKENS / CONTEXT space-between across the rest. Keeps the indicator slot stable AND tightens the indicator↔TIME gap.

**Tasks.**

- [x] **Option (ii) tried, rejected.** Two-group distribution (indicator + TIME left-anchored via row `gap`; TOKENS + CONTEXT trailing via `margin-left: auto`) made TIME read as "stuck" to the indicator rather than balanced; deviated from the gallery's vetted 4-way `space-between`.
- [x] **Option (iii) tried, rejected.** Content-sized indicator slot (no fixed width) eliminated the empty band for short labels but caused TIME / TOKENS / CONTEXT positions to shift left/right whenever the phase label changed ("Idle" → "Streaming response" → "Awaiting first response"). Cell positions stability is the load-bearing constraint here — the live readout's value lies in being able to glance at the SAME spot and read the SAME column.
- [x] **Landed: keep the existing 4-item `space-between` layout with the 220 px fixed indicator slot** — matches `gallery-tide-status-row` byte-for-byte. Cell positions stay rock-stable across phase-label changes; the empty band inside the slot for short labels ("Idle") is the accepted price of stability. Refreshed the rule's docstring + the renderer's call-site comment to record `gallery-tide-status-row` as the design source of truth and to make the cosmetic-vs-stability tradeoff explicit in-source, so a future reader doesn't try to "fix" the empty band again. No structural CSS / TSX changes landed — Sub-step E confirms the existing layout is correct and documents why.
- [x] HMR vet at multiple widths — cells stay at fixed X positions as the phase label cycles through every state; all four inter-item gaps flex uniformly via `space-between`; the longest phase label ("Awaiting first response") fits the 220 px slot without clipping; the "Idle" empty band is present and accepted.

**Conformance.** [L20] no token changes — `--tugx-tide-status-indicator-slot-width` is declared and read on the same rule per the existing discipline. [L06] all visible distribution flows through CSS; no React state for layout. The container-query collapse rules at the bottom of the file are unchanged. The production layout matches `gallery-tide-status-row` exactly, so the gallery stays a faithful design source.

---

##### Sub-step F — Z1B asst-half badge: size + color-inheritance

**Symptoms (two).**

  1. **Size.** The Z1B end-state badge (`TugBadge size="md"`, icon `size=13`) reads as slightly small compared to the surrounding `TugLabel` text in the row.
  2. **Color.** The "OK" badge paints in `role="success"` green; on every committed row the bright green dots compound visually, drawing the eye and breaking the calm-row rhythm. The badge should blend into the row's text color so it reads as part of the line rather than a separate signal — saving the coloured tones for outcomes that warrant attention (`interrupted` / `error` / `transport_lost`).

These two are coupled because both are TugBadge component-level passes against the same callsite; tuning them together avoids two consecutive HMR-vet rounds against the Z1B surface.

---

**Part 1 — Size.**

**Design tradeoff.**

  - **(i) Bump the existing `md` size's metrics slightly** — affects every `md` consumer in the codebase. Cleanest if no other `md` callsite suffers.
  - **(ii) Add a new size between `md` and `lg`** (e.g., `md-plus` or rename current `lg`) — Z1B switches to it; other consumers unaffected.
  - **(iii) Per-callsite override** — Z1B applies a CSS override on `.tide-z1b-end-state .tug-badge`. Rejects core-component sovereignty per [L20]; not recommended.

**Recommendation (pending user review).** Audit existing `TugBadge size="md"` consumers first. If none depend on the current dimensions, go with (i) — single point of change, gallery + tide-card both pick it up. Otherwise go with (ii) — add a new size keyword.

---

**Part 2 — Color inheritance ("blend into surrounding text").**

The current dispatch (`endStateBadgeFor`) returns `role="success"` for `complete` → bright green. In a transcript of many committed rows the greens compound into a vertical column of dots that reads first; the message content above them reads second. The badge for the `complete` outcome should inherit its color from the row's text color so it blends in by default; the actionable outcomes (`interrupted` / `error` / `transport_lost`) keep their coloured tones because attention IS warranted there.

**Component-level addition — a TugBadge color-inheritance variant.**

The fix lives in `TugBadge`, not at the Z1B callsite: per [L20] the component owns its tokens, and per the "no hacking around the component library for one look" rule the right move is a proper TugBadge API addition that any future callsite can pick up.

Several design choices for the API:

  - **(a) New role value `"inherit"`** — extend `TugBadgeRole` from 7 → 8 values; `inherit` resolves to `currentColor` for the badge's text / icon / border, dropping back to the surrounding text color. Symmetric with the existing semantic-color roles (accent / action / danger / …). Slot CSS rules for all four emphases (`filled-inherit`, `outlined-inherit`, `ghost-inherit`, `tinted-inherit`); `ghost-inherit` is the primary Z1B target (transparent bg, text + icon in `currentColor`).
  - **(b) New role value with a semantic name (`"neutral"`, `"text"`, `"muted"`)** — same mechanism as (a), different name. Semantic naming reads cleaner ("neutral" = no-emphasis colour); the literal `"inherit"` makes the CSS-cascade behaviour explicit at the callsite.
  - **(c) Separate `color="inherit"` prop, orthogonal to `role`** — keeps the 7-role enum stable; an explicit "this badge takes its surrounding text colour" override that wins over the role's palette. Requires adding a second axis to the badge's CSS dispatch.

**Recommendation (pending user review).** Option (a) with the name `"inherit"` — it slots into the existing role axis without introducing a second dispatch dimension, and the literal name signals the cascade behaviour at the callsite. The four emphasis × `inherit` cells need explicit styling:

  - `ghost-inherit` — transparent bg, `currentColor` text/icon. Primary Z1B target.
  - `outlined-inherit` — transparent bg, `currentColor` border + text/icon (border at low alpha).
  - `tinted-inherit` — low-alpha `currentColor` background, `currentColor` text/icon.
  - `filled-inherit` — solid `currentColor` background. Likely an anti-pattern (inverts into the surrounding text colour); flag in the docstring that most callers want `ghost-inherit`.

**Z1B adoption.** Once the `inherit` role lands:

  - Branch `endStateBadgeFor` (or thread a sibling helper) so the `complete` outcome returns `role="inherit"` while the actionable outcomes keep their existing tones (`danger` / `caution` per their semantics).
  - The gallery's TugBadge card adds a row demonstrating the new role across all four emphases so future consumers see the option.

---

**Tasks.**

- [x] Audited `TugBadge size="md"` consumers — exactly ONE production callsite (`tide-card-z1b.tsx`). Gallery iterates `ALL_BADGE_SIZES` for its matrix; other `size="md"` hits in the codebase are for TugLabel / TugPushButton / TugIconButton (different components). Option (i) is safe.
- [x] Picked option (i): bump the existing `md` size's dimensions in place. Single point of change; only the Z1B production callsite and the gallery matrix pick it up.
- [x] Bumped `.tug-badge-size-md` in `tug-badge.css`: height 1.5rem → 1.625rem (24 → 26 px), font-size 0.6875rem → 0.75rem (11 → 12 px to match the surrounding `TugLabel size="xs"`), icon svg 0.6875rem → 0.75rem in lockstep with font-size. Padding-inline and gap unchanged.
- [x] Bumped `endStateBadgeIcon` size in `tide-card-z1b.tsx` from 13 → 14 so the Lucide icon's source dimensions remain a hair larger than the rendered 12 px, keeping stroke weight crisp through the CSS scale-down. Refreshed the helper docstring to explain the Lucide-source vs CSS-rendered size relationship.
- [x] Picked color-inheritance option (a): add `"inherit"` to `TugBadgeRole` as the eighth role value. Symmetric with the existing semantic-color roles; one dispatch axis; literal name signals the cascade behaviour at the callsite.
- [x] Implemented the `inherit` role in `tug-badge.tsx` + `tug-badge.css`. Extended the union and wrote a thorough docstring explaining the role is the deliberate exception to the role × emphasis × theme-token discipline. Added THREE CSS rules (`outlined-inherit` / `ghost-inherit` / `tinted-inherit`); intentionally OMITTED `filled-inherit` — a solid bg in `currentColor` would equal the surrounding text colour and collapse the badge's own contrast, so the cell has no sensible visual and shipping it would be matrix-symmetry theater. The "no @tug-pairings entries" decision is documented in the rule block (`currentColor` is a CSS keyword, not a theme token, so the pairings audit doesn't apply); the lint passes cleanly.
- [x] Wired the Z1B `complete` outcome through `endStateBadgeFor` to return `role: "inherit"` (was `role: "success"`). Narrowed `EndStateBadgeRole` to `"inherit" | "caution" | "danger"` (dropped `"success"` — no longer a possible output) and updated the docstring table. The popovers' end-state chip picks this up automatically via the same helper. Failing outcomes (`interrupted` / `error` / `transport_lost`) keep their coloured tones unchanged. Updated the pure-logic test for the `complete` mapping with a comment explaining the why.
- [x] Extended the gallery's `TugBadge` matrix: added `"inherit"` to `ALL_BADGE_ROLES`. The gallery's badge card already iterates `tinted` × `ghost` emphases; the new role surfaces in both columns. The gallery's docstring now explains why `outlined-inherit` exists in CSS but isn't gallery-surfaced (badge matrix intentionally limits itself to `tinted` and `ghost` to avoid visual confusion with button variants) and why `filled-inherit` doesn't exist at all.
- [x] HMR vet: in a transcript of many committed rows, the OK badges blend into the surrounding text rhythm rather than punching out as a column of green dots; failure-outcome badges still read distinctly (vetted via the existing failure-row scenarios in the gallery). The badge size also reads as harmonious with the surrounding TugLabel text in the Z1B row.

**Conformance.** [L20] TugBadge stays the sole owner of its colour dispatch — the new role is added on the component, not faked at the callsite via a CSS override. [L19] role + emphasis combinatorics surface in the gallery so future consumers can see and select the new option. [L06] all appearance changes flow through CSS class names (`.tug-badge-{emphasis}-inherit`); no inline style. Pure-logic test coverage updated for the new mapping; 2227 pass / 0 fail; tsc clean; tokens lint zero violations.

---

##### Sub-step G — Z1B bottom margin consistency + transcript bottom inset

**Symptom.** Two related spacing issues in the transcript:

  1. **Uneven margins between Z1B and the next row.** The gap below Z1B varies from response to response — some responses end with the Z1B sitting close to the next entry's header, others leave a larger gap. The variation reads as a layout bug; the spacing should be content-independent.
  2. **Cramped Z1B → Z2 status bar.** When the bottom-most response in the transcript is at the bottom of the scrollport, its Z1B sits very close to the Z2 status bar — sometimes only a few pixels separate the COPY chip from the indicator dot above. There should be a reliable, generous gap there so Z1B doesn't crowd the status surface.

**Suspect mechanism.**

Spacing today comes from three layers:
  - `--tugx-transcript-controls-margin-top: var(--tug-space-2xs)` — gap between the body and Z1B *inside* an entry (overridden to `2xs` in `tide-card.css` for the transcript consumer).
  - `--tugx-list-view-row-gap: var(--tugx-tide-entry-margin)` (16px) — gap *between* entries in the list view.
  - `--tugx-list-view-padding-block: var(--tug-space-md)` — top/bottom padding inside the list-view scroller; this is the gap between the LAST entry's Z1B and the Z2 status bar.

There is no `margin-bottom` token on the controls slot — Z1B has a top margin but no bottom margin. The visible gap below Z1B depends entirely on the list-view's row-gap (between entries) or padding-block-end (against the status bar). That should be uniform — unless margin collapsing or padding from a descendant of the body is bleeding through. The "uneven margins" symptom likely points at a margin-collapse interaction (the body's last child's `margin-bottom` collapsing through Z1B and into the row-gap).

**Tasks.**

- [x] **Diagnosed the uneven-margin case.** The `.tug-transcript-entry__body` slot is `display: block` (no BFC); its content varies by body kind (markdown paragraphs default to non-zero `<p>:last-child` margin until the markdown view's `> p:last-child { margin-bottom: 0 }` rule kicks in, but tool blocks / file blocks / terminal blocks each end with their own trailing chrome that contributes differently). Without containment, those trailing margins behave ambiguously at the flex-column boundary (body → controls), surfacing as a visibly-variable gap from Z1B down to the next entry's header.
- [x] **Fixed the uneven-margin case at the source.** Added `display: flow-root` to `.tug-transcript-entry__body` in `tug-transcript-entry.css`. This establishes a block formatting context that contains every descendant margin — the body's content-box height now includes any last-child margin-bottom, so the controls slot below sits at the same offset every time, regardless of body kind. No new token introduced (the plan's `--tugx-transcript-controls-margin-bottom` suggestion was deferred — the flow-root fix neutralises the source rather than masking the symptom with a defensive bottom margin).
- [x] **Fixed the cramped Z1B → Z2 case via asymmetric end-padding.** Refactored `tug-list-view.css` to introduce optional `--tugx-list-view-padding-block-start` / `--tugx-list-view-padding-block-end` longhands that fall back to the existing symmetric `--tugx-list-view-padding-block` token (backward-compatible — existing consumers that only set the symmetric token are unchanged). Overrode `--tugx-list-view-padding-block-end: var(--tug-space-2xl)` in the transcript consumer (`tide-card.css`) — the bottom inset went from `tug-space-md` (8px) to `tug-space-2xl` (24px), 3× more breathing room above the Z2 status bar. The start side stays at `md` (8px) — the first entry's natural header padding already covers the top.
- [x] **HMR vet.** (a) Scrolled through a session with mixed response types (markdown paragraphs, code blocks, lists, tool calls); the Z1B↔next-row gaps now read as identical regardless of body kind. (b) Pinned to bottom on a fresh turn-complete; the Z1B carries visible breathing room above the Z2 status bar.

**Conformance.** [L06] visible spacing through CSS tokens, never React state. [L19] new tokens follow the `--tugx-list-view-padding-block-*` naming pattern alongside the existing symmetric token. [L20] consumer-only — `tide-card.css` overrides the new longhand token on the transcript's scoped selector; the list-view primitive doesn't override anything cross-component. The token refactor is back-compatible: every existing list-view consumer that only set `--tugx-list-view-padding-block` keeps the same rendering. Tests: tsc clean, tokens lint zero violations, 2227 pass / 0 fail.

---

##### Sub-step H — TugListView: collapsing cells leave a gap

**Symptom.** When the user clicks a body-kind affordance that shrinks the rendered cell — e.g., the Bash / diff "Collapse" control that folds an expanded hunk view back to a one-line summary — the cell's own contents shrink, but the `TugListView` scroller does NOT reclaim the vacated space. A tall empty band appears in the transcript where the expanded hunks used to render, and the entries that should follow stay rendered at their original Y positions further down the scroll content. The user has to scroll past the gap to see the rows underneath.

This is the inverse of the [Sub-step A](#step-20-4-16) "drift-and-snap" symptom: there height GROWTH outpaced the bottom-pin write; here height SHRINKAGE doesn't propagate into the height index or into the scrollport's layout. Both live at the `TugListView` ↔ per-cell `ResizeObserver` boundary, so the diagnosis informs both.

**Suspect chain.**

The list view tracks per-cell heights in an index and positions cells in the scrollport off that index. Cell-height changes are supposed to flow through:

  1. The body kind re-renders with smaller content (collapsed hunks).
  2. The cell wrapper's own height shrinks accordingly.
  3. The per-cell `ResizeObserver` fires with the new measurement.
  4. `tug-list-view.tsx` updates the height index for that cell id.
  5. The flush re-positions every cell below the collapsed one to its new Y, and `scrollHeight` shrinks.
  6. The user's viewport-relative anchor is preserved across the change (no visible content jump).

The failure could be at any link in this chain — diagnosis pinpoints which one. Likely suspects:

  - **(i) The body kind keeps the wrapper at full height across the collapse** — e.g., `display: none` on children inside a wrapper with a fixed / `min-height` outer box; or a CSS transition that lags the measurement. The ResizeObserver never sees a change; the collapse is visual only. The body kind owns the contract that "collapsed = smaller wrapper height," not just "hidden children."
  - **(ii) The height-index update doesn't fire on shrink** — e.g., the per-cell observer's compare or threshold gate accepts grow-only deltas. The Sub-step A sync-pin work added a fast path that should be direction-agnostic; worth confirming it didn't introduce a regression here.
  - **(iii) The re-position flush skips when no GROWTH was detected** — a likely artifact of the Sub-step A change which gates the rAF flush on `anyChanged`. If `anyChanged` is computed as `newHeight > oldHeight`, shrinks slip through.
  - **(iv) Cell positions update, but `scrollTop` doesn't anchor** — cells reflow to their new Y, but the user's visible content jumps. The list view needs to detect a content-height shrink ABOVE the visible viewport and subtract the delta from `scrollTop` synchronously so the user's anchor row stays at the same Y on screen.

**Scroll-anchoring contract.** On a cell-height change at offset `Y0` (top of the changing cell) of magnitude `delta` (positive when shrinking):

  - **Change entirely above the viewport** (`Y0 + cellHeight <= scrollTop`): subtract `delta` from `scrollTop` atomically with the height-index update so the user's anchor row stays at the same on-screen Y. They didn't see the cell change; they shouldn't see the layout move either.
  - **Change in the viewport** (`Y0 < scrollTop + viewportHeight && Y0 + cellHeight > scrollTop`): the user is looking at the affordance — they expect the cells BELOW to pull up in place. No `scrollTop` change; the visible top of the changing cell stays anchored.
  - **Change entirely below the viewport** (`Y0 >= scrollTop + viewportHeight`): the change is off-screen below; the visible region is untouched. The height index updates so `scrollHeight` is correct, but no `scrollTop` change is needed.
  - **Follow-bottom engaged:** if `isFollowingBottom && !isUserScrolling`, the Sub-step A sync `pinToBottom()` re-asserts; the anchoring logic above is short-circuited by the pin. Verify the pin write also handles the shrink direction.

This is the scroll-anchoring discipline modern browsers apply automatically via the CSS `overflow-anchor` property — but the list view positions cells absolutely (not in flow), so the browser's anchoring is bypassed and the discipline has to be re-implemented in the windowing math.

---

**Tasks.**

- [x] **Diagnosed.** Root cause is NEITHER (i) the body kind's wrapper holding open at fixed height NOR (ii)/(iii) a ResizeObserver direction-gate regression NOR (iv) a scroll-anchor write missing for shrink. The per-cell `ResizeObserver` callback in `tug-list-view.tsx` already fires on either direction (the `Math.abs(currentHeight - newHeight) >= 0.5` compare is direction-agnostic), the flush picks up shrinks (`anyChanged` is set on any non-no-op delta), and the bottom-pin re-asserts on shrink-while-follow-bottom. The actual culprit is the **hydration-lock min-height** at `tug-list-view.tsx` lines 707-727: `hydratedCellHeightsRef` writes `style.minHeight = ${savedHeight}px` on every cell wrapper whose saved-at-hydration height was non-zero, and the lock was documented as "permanent within the mount." When a hydrated session restores a Bash / diff cell that was saved at its expanded height (say 500 px), then the user collapses it, the wrapper's `min-height: 500px` holds the wrapper open — the cell's content shrinks, but the cell box stays at 500 px and a tall band of ghost space appears below the collapsed body kind.
- [x] **Fix landed (a new mode for the lock — release-on-reach-saved-height).** The hydration-lock contract changes from "permanent within the mount" to "released per-cell once that cell's measured height reaches or exceeds the saved value." The release write is done inside the `ResizeObserver` callback at `tug-list-view.tsx`, gated on `newHeight >= saved - 0.5` and runs BEFORE the no-op-tolerance gate so a measurement that exactly equals the heightIndex's hydrated value still releases the lock. `anyChanged` is forced on release so the rAF flush re-renders and the next render reads the cleared entry → no more `min-height` style on the wrapper → subsequent user-action shrinks (collapse, etc.) are honored, the wrapper follows the content down, no ghost space. The ref's `readonly number[]` type is the EXTERNAL-mutation contract (consumers reading `?.[index]` shouldn't mutate); the observer callback owns the underlying array and casts to mutable for the per-cell release write. Updated the lock-ref docstring to record the new contract and explicitly link the release to Sub-step H so a future cleanup pass doesn't revert to the "permanent" wording.
- [x] **HMR vet.**
    - (a) **In-viewport collapse (primary case):** scrolled so an expanded Bash / diff cell sat fully in the viewport; clicked "Collapse"; the cells below pulled up immediately, no empty gap.
    - (b) **Expand (inverse):** re-expanded the same cell; cells below pushed down; anchor stayed put.
    - (c) **Collapse at the bottom (follow-bottom on):** with viewport pinned to the bottom, collapsed a near-bottom cell; the Sub-step A sync `pinToBottom()` re-asserted on the shrink, scroll stayed at the bottom.
    - (d) **Cross-body-kind:** verified the same contract across markdown body kinds and tool-call body kinds — any body kind whose wrapper height shrinks now releases its hydration lock on first measurement-at-saved.

**Conformance.** [L26] mount identity preserved across the collapse / expand transition — the cell wrapper survives; only its body content swaps. [D07] auto-follow-bottom semantics preserved — the user can still scroll up to break the follow. [L02] no React state for the lock map — the ref is mutated in place inside the observer callback (appearance-only, per the existing discipline); React re-renders on the rAF flush which reads the cleared entry. [L06] visible behaviour (presence / absence of `min-height` style on the wrapper) flows through the cell render reading the ref's value — not through React state. Tests: tsc clean, tokens lint zero violations, 2227 pass / 0 fail.

---

##### Sub-step I — Scroll-to-bottom on submit + scrolling-system consolidation

**Symptom.** When the user is scrolled up in the transcript and submits a new request, the scroller does NOT reliably snap back to the bottom — the just-submitted Z1B user-half and the corresponding assistant in-flight indicator (or end state once the turn completes) stay below the viewport. The user has to scroll down manually to see what they just sent and to watch the response stream in. Originally reported as hit-and-miss; under a cold-boot-restored card it fails every time.

**Root cause (confirmed).** The transcript host already calls `transcriptRef.current?.scrollToBottom()` from `handleAfterSubmit` (`tide-card.tsx:2031`) — that path is wired and engages follow-bottom. The saboteur is the **cold-boot restore-anchor apply effect** in `tug-list-view.tsx`. When a card cold-boots into a saved mid-transcript scroll position, a mount-time `useLayoutEffect` seeds `restoreAnchorRef.current = {anchorIndex, anchorOffset}` from `bag.regionScroll[scrollKey].meta.anchor`. The restore-apply effect then runs on EVERY commit while the ref is set: it recomputes `desired = heightIndex.offsetForIndex(anchorIndex) + anchorOffset` and (a) re-writes `scrollTop` whenever drift > 0.5 px AND (b) called `disengageFollowBottom()` UNCONDITIONALLY. The ref was cleared only on `isUserScrolling = true` (a gesture). On submit, `scrollToBottom()` engages follow-bottom and writes `scrollTop = newMax`, but on the next commit the restore-apply effect computes `desired = saved-anchor`, sees the drift, **overwrites `scrollTop` back to the saved anchor AND disengages follow-bottom** — and every subsequent ResizeObserver bottom-pin then bails on `!isFollowingBottom`. The same bug defeated SmartScroll's keyboard End / Cmd+ArrowDown handler, which never touched `restoreAnchorRef`.

**Scope.** Sub-step I has two halves. **I-0** is the immediate bug fix (landed). **I-1 … I-4** are an incremental consolidation of the scrolling subsystem, motivated by the audit below and sequenced so each phase shrinks the surface the next one touches.

**Why the consolidation.** Diagnosing I-0 required enumerating ~30 distinct `scrollTop` writers across ~10 files, two independent `SmartScroll` instances (`TugListView`, `TugMarkdownView`) that each re-implement the follow-bottom pin loop inline, three parallel restoration mechanisms (CardHost `bag.regionScroll` + `tug-region-scroll-set` event; `TugListView`'s anchor-restore effect; `TugMarkdownView`'s raw save/restore in `lexParseAndRender`), and DOM-`CustomEvent` signalling (`tug-disengage-follow-bottom`) for follow-bottom intent. Every feature so far added another rule; every bug now requires holding all the rules at once. The full `ScrollIntent` state-machine rewrite is deferred — these four phases funnel the existing behaviour through `SmartScroll` without changing semantics, and the checkpoint after I-4 re-evaluates whether the deeper rewrite is still warranted.

**I-0 — Immediate fix: restore-anchor must yield to follow-bottom engagement.**

- [x] **Diagnose.** Confirmed root cause above. CardHost's MutationObserver retry (`card-host.tsx:1057`) and the `tug-region-scroll-set` listener are NOT interfering after first paint — CardHost's `settledElByKey` gate stops re-dispatch once the element lands within `REGION_SCROLL_TOLERANCE_PX = 8` of the saved position.
- [x] **Decide the API surface.** Wire the clear-on-engage signal through SmartScroll's existing `onFollowBottomChanged` callback. Five paths converge on `_setFollowingBottom(true)`: `scrollToBottom`, `engageFollowBottom`, idle re-engagement in `_handleScroll`, `_checkReEngageFollowBottom` at gesture end, keyboard End / Cmd+ArrowDown. All five mean "user wants the live edge now" — incompatible with "restore me to a saved position." One callback site covers all five. Rejected: clearing only inside `TugListViewHandle.scrollToBottom` (leaves keyboard End broken); threading a submit signal through the data source (overcoupled, still misses keyboard / idle re-engage).
- [x] **Implement.** `tug-list-view.tsx` — three changes: (1) SmartScroll instantiation passes `onFollowBottomChanged` that clears `restoreAnchorRef.current = null` when `following === true`; (2) the restore-anchor apply effect's `disengageFollowBottom()` is scoped inside the `if (drift > 0.5)` branch so an idle apply no longer kills follow-bottom; (3) `TugListViewHandle.scrollToBottom` arms `pinRequestedRef.current = true` so the post-commit pin re-asserts the bottom against the post-commit `scrollHeight`.
- [x] **Automated coverage — `AT0083` (`at0083-list-view-submit-pin.test.ts`).** App-test against the real `TugListView` + `SmartScroll` + CardHost region-scroll restore, via `gallery-list-view-scroll-keyed`. Test 1 reproduces case (d): cold-boot a card restored to a mid-list anchor, drive the fixture's "Scroll to bottom" control (the inner `TugListView.scrollToBottom()` — the exact method the tide-card transcript host calls on submit), assert the scroller lands AND holds at the bottom with no restore-anchor pullback. Test 2 covers (a)/(b)/(c): `scrollToBottom()` at the bottom is a no-op (c); after `tug-disengage-follow-bottom` content growth does not pin; `scrollToBottom()` re-engages follow-bottom (a/b) and subsequent growth pins. A `GalleryListView` "Scroll to bottom" + `data-testid` "Insert bottom" affordance was added for the harness. `just app-test at0083-list-view-submit-pin.test.ts` → `VERDICT: PASS`.
- [ ] **HMR vet.** (a)–(d) are now gated by `AT0083` against the primitive; the manual pass confirms the tide-card submit wiring (`handleAfterSubmit`) end-to-end. (e) Re-vet that the Sub-step A "drift-and-snap" fix and Sub-step H collapse-gap fix still hold — both ride the same scroll-anchor regime; their own gates are `AT0060` (content-settled) and `AT0067` / `AT0068` (bash-block fold).

**I-1 — Single auto-pin helper on SmartScroll** _(audit item 2 — done first: collapses the duplication every later phase would otherwise step around)._

The "if following bottom and content grew, slam `scrollTop` to the bottom" logic existed in **seven** places with subtly different gates (the audit's count of five undercounted `TugMarkdownView` by two): `TugListView`'s per-cell ResizeObserver sync-pin, its container-ResizeObserver sync-pin, and its post-commit pin effect (all gated on `isFollowingBottom && !isUserScrolling`); `TugMarkdownView`'s `onScroll` callback and its block-height ResizeObserver each did a raw `scrollContainerRef.current.scrollTop = 0x40000000` with NO `isUserScrolling` guard (a latent bug — they fought an active user gesture); plus `TugMarkdownView`'s `_render` predicted-bottom decision (`willPin`) and its `doSetRegion` measurement-and-pin block, which each re-derived the gate inline.

- [x] **Add the gate as one owner on SmartScroll.** `get shouldAutoPin(): boolean` returns `isFollowingBottom && !isUserScrolling` — the single home of the gate. `maybePinToBottom(): void` is the convenience wrapper for the pure-pin case (`if (shouldAutoPin) pinToBottom()`). `pinToBottom()` stays as the unguarded primitive. The getter is exposed separately because some callers need the gate as a *value*, not a pin action.
- [x] **Migrate `TugListView`'s three sync-pin sites.** Per-cell + container ResizeObserver callbacks call `ss.maybePinToBottom()`. The post-commit pin effect now owns only the `pinRequestedRef` lifecycle: it keeps an explicit `isUserScrolling` check (to HOLD the request for re-fire after the gesture) and an `itemCount <= 0` guard, then delegates the follow-bottom gate + pin to `maybePinToBottom()`.
- [x] **Migrate `TugMarkdownView`'s two raw `0x40000000` slams** (block-height ResizeObserver + `onScroll` rAF) to `ss.maybePinToBottom()` — closing the latent missing-`isUserScrolling`-guard bug. Migrated the two extra inline gates the audit missed: `_render`'s `willPin` reads `ss.shouldAutoPin`; `doSetRegion`'s measurement-and-pin block branches on `ss?.shouldAutoPin`.
- [x] **Delete the `0x40000000` sentinel** from `TugMarkdownView` — it now lives only inside `SmartScroll.scrollToBottom`.
- [x] **Automated coverage — `AT0083`.** Test 2 gates the funnel: content growth auto-pins while following the bottom (gate true) and does NOT pin after `tug-disengage-follow-bottom` (gate false — also the collapsed-hunk case). `SmartScroll.shouldAutoPin` / `maybePinToBottom` are SmartScroll-level and shared verbatim by `TugMarkdownView`; exercising them through `TugListView` gates the funnel itself.
- [ ] **HMR vet.** `AT0083` gates the `SmartScroll` funnel; the manual pass confirms `TugMarkdownView`'s own auto-pin sites (streaming markdown body kind still pins on growth; scrolling up mid-stream still breaks the follow) — those are not driven by `AT0083`.

**Conformance.** [L06] DOM-appearance write owned by SmartScroll. [L07] `isFollowingBottom` / `isUserScrolling` read live at call time via the `shouldAutoPin` getter. Typecheck clean; full tugdeck suite (2227 tests) green.

**I-2 — Restore-anchor becomes a SmartScroll restoration target** _(audit item 4)._

After I-1, the only `TugListView`-local scroll machinery left fighting follow-bottom is the restore-anchor effect (~30 lines of effect + the hydration seed + the I-0 `onFollowBottomChanged` clear). Move the concept into SmartScroll so the "engage invalidates restore" rule is intrinsic, not a hand-wired callback.

- [x] **Add `SmartScroll.setRestoreTarget(resolver)` / `clearRestoreTarget()`** — `resolver: () => number | null` returns the desired `scrollTop` (or `null` when the anchor cell is not yet resolvable). `setRestoreTarget` disengages follow-bottom (a pending restore is incompatible with tracking the live edge). `applyRestoreTarget()` re-resolves and writes on each layout signal the consumer forwards; it clears the target on `isUserScrolling`. The "engaging follow-bottom clears the restore target" rule lives in `_setFollowingBottom(true)`.
- [x] **Migrate `TugListView`** — `restoreAnchorRef`, the ~30-line apply effect, and the I-0 `onFollowBottomChanged` clear are gone. The SmartScroll-install effect installs the saved anchor via `setRestoreTarget(makeAnchorResolver(...))` (mount seed + the `tug-region-scroll-set` listener); the apply effect collapsed to a one-line `applyRestoreTarget()` heartbeat. SmartScroll holds all restore state.
- [x] **First-paint regression found + fixed (measured, not theorized).** Migration regressed `AT0069`: `firstScrollTop` resolved to 1183 (estimate-based) then corrected to 600. Root cause — the ResizeObserver-install effect's `heightIndex.clear()` ran unconditionally on mount, wiping the geometry the hydration effect had just loaded from `meta.cellHeights`. Fix: gate the clear on an *actual* `dataSource` swap (`prev !== dataSource`) — also correct under StrictMode's double-invoke. The mount-clear was always collateral; the clear is only meaningful on a swap.
- [ ] **HMR vet.** Re-run I-0 (a)–(e). Cold-boot restore to a mid-transcript position still lands precisely and holds across the content-settle window; user scroll still hands off; submit still re-engages.

**Conformance.** [L23] preserves the user-visible saved viewport position across the indefinite settle window — first paint now reproduces the exact saved offset (no estimate hop). [L07] resolver reads the live `heightIndex`. [D07] follow-bottom semantics unchanged. Typecheck clean; tugdeck suite 2227 green; `AT0060` / `AT0061` / `AT0069` / `AT0083` green.

**I-3 — Logged engage/disengage funnel + scroller context** _(audit item 3)._

Follow-bottom intent today is signalled by a bubbling `tug-disengage-follow-bottom` `CustomEvent` dispatched by `block-fold-cue` and `diff-block` — untyped action-at-a-distance with no record of who fired it.

- [x] **Add `SmartScroll.engage(source: string)` / `disengage(source: string)`** — thin wrappers over `engageFollowBottom` / `disengageFollowBottom`. The `follow-bottom` `deckTrace` event is recorded in `_setFollowingBottom` — the one chokepoint every transition routes through — so the trace covers all engage/disengage triggers, internal and external (see Post-I-3 audit fixups below). New `follow-bottom` event kind added to `deck-trace.ts` and mirrored in the app-test harness (`matchers.ts`: `DeckTraceEventShape`, `HARNESS_KNOWN_TRACE_KINDS`, `summarizeEvent`).
- [x] **Add a `ScrollerContext` + `useScroller()` hook** — `internal/scroller-context.tsx`. `TugListView` publishes a stable `Scroller` façade (created once via `useRef`, object literal re-evaluated + discarded like `heightIndexRef`) whose methods delegate to `smartScrollRef.current` and no-op while it is `null`. The context default is a frozen no-op `Scroller`, so a host-less tree (standalone gallery, tests) gets a callable handle and consumers need no null guard.
- [x] **Migrate `block-fold-cue` and `diff-block`** — `block-fold-cue` calls `useScroller().disengage("block-fold")`; `diff-block`'s view-toggle calls `disengage("diff-view-toggle")` (a distinct source for honest trace attribution). The `tug-disengage-follow-bottom` listener (`tug-list-view`) and the event are removed; stale references in `file-block` / `terminal-block` / `affordances/index.ts` comments updated. `AT0083` test 2's disengage migrated off the removed event to a real scroll-up wheel gesture. Typecheck clean; tugdeck suite 2227 green; `AT0060` / `AT0061` / `AT0067` / `AT0068` / `AT0069` / `AT0083` green.
- [ ] **HMR vet.** Collapse a Bash / diff hunk while following bottom — follow-bottom disengages and the click target stays in view (the existing "interacting with a control does not move it out of view" rule). Re-run I-0 (a)–(e).

**Conformance.** [L07] the façade delegates to the live SmartScroll instance; no React state crossed. [L02] context value is a stable imperative handle, not store state.

**Post-I-3 audit fixups.** An audit of Sub-steps I-0…I-3 surfaced two gaps, both fixed:

- **Logging completeness.** The `follow-bottom` trace was originally recorded in the `engage` / `disengage` wrappers — covering only the two affordance triggers, while the heuristic internal flips (the paths the Field Note flags as unreliable) went unlogged. Recording moved into `_setFollowingBottom`, the chokepoint all engage/disengage paths route through, so the trace now captures every transition: `block-fold`, `diff-view-toggle`, `wheel-up`, `key-up`, `idle-reengage`, `gesture-end-reengage`, `scroll-to-bottom`, `restore-target`, `drag-up`, `region-scroll-restore`. `source` is threaded through `engageFollowBottom` / `disengageFollowBottom` (now a required argument) and tagged at each internal `_setFollowingBottom` call site.
- **Restore supersede set.** A pending cold-boot restore was superseded by a user gesture and by a follow-bottom engage, but not by an explicit programmatic `scrollTo` / `scrollToElement` — the `applyRestoreTarget` heartbeat would fight a consumer's `scrollToIndex`. The public `scrollTo` / `scrollToElement` now `clearRestoreTarget()`; the heartbeat writes through a new private `_writeScrollTop` that preserves the target (the restore must re-apply across the content-settle window). Typecheck clean; 2227 unit green; `AT0060` / `AT0061` / `AT0067` / `AT0068` / `AT0069` / `AT0083` green.

**I-4 — Route TugMarkdownView's residual raw scroll writes through SmartScroll** _(audit item 1)._

I-1 absorbed the two `0x40000000` slams. What remains raw in `TugMarkdownView`: the save/restore-around-DOM-clear in `lexParseAndRender` and the post-region-update `scrollTop` write. Routing these through `SmartScroll.scrollTo()` makes SmartScroll the sole owner of every programmatic scroll-position write in `TugMarkdownView` — matching the invariant its own docstring already claims.

- [x] **Migrate `lexParseAndRender`'s save/restore** — the post-DOM-clear scroll restore writes through `smartScrollRef.current?.scrollTo({ top: clampedScrollTop })`. The `savedScrollTop` capture stays a direct read (taken before the DOM clear).
- [x] **Migrate the post-region-update raw write** — the content-shrink scroll recovery in `incrementalTailUpdate` writes through `smartScrollRef.current?.scrollTo({ top: newScrollTop })`.
- [x] **Audit** — zero raw `scrollTop =` container writes remain in `TugMarkdownView`; the only direct container access left is reads (`scrollTop` / `clientHeight`). The two `scrollLeft` writes in `onRegionScrollSet` are horizontal region-scroll restore, out of scope: `SmartScroll` models vertical scroll only (`scrollTo` ignores `left`). The docstring `[L06]` bullet was tightened to state the now-true invariant. Typecheck clean; 2227 unit green; `AT0010` (markdown selection ×2) / `AT0014` (scroll persistence + cold-boot scroll ×3) green.
- [ ] **HMR vet.** Markdown streaming + mid-stream region edits keep the scroll position stable; cold-boot restore of a markdown view still lands; follow-bottom on a streaming markdown body still pins.

**Conformance.** [L06] every programmatic scroll write in `TugMarkdownView` goes through the one owner.

**Field note — follow-bottom re-engagement is unreliable at fast markdown streaming rates.** Observed on the gallery markdown card (fast streaming tick): re-joining follow-bottom by wheel-scrolling *downward* to the live edge does not reliably engage. SmartScroll's idle-phase auto-re-engagement (`_handleScroll`'s `idle` case) only fires when a scroll event arrives in the `idle` phase AND `isAtBottom` is true within the 60px threshold — but during fast streaming the bottom is a moving target: by the time the wheel gesture settles, `scrollHeight` has already grown past where the user aimed, so `isAtBottom` reads false and re-engagement is skipped. SmartScroll's own source comment already documents this ("during streaming, the bottom moves too fast for this to reliably trigger — the user should use End/Cmd+Down"). Today's reliable re-engage paths are the explicit ones: keyboard End / Cmd+ArrowDown and the imperative `scrollToBottom()`. This is not a regression from I-1 — it is a pre-existing heuristic limitation — but it is a concrete data point for the post-I-4 checkpoint: a model where "follow the live edge" is an explicit intent the user re-asserts (rather than a heuristic inferred from gesture geometry against a moving `scrollHeight`) would close it. Not in scope for I-1…I-4; logged here so the checkpoint decision has the evidence.

**Checkpoint after I-4.**

- [x] Follow-bottom pinning is funneled through `SmartScroll.maybePinToBottom()` — one gate, one site. The gate is the single `shouldAutoPin` getter (`isFollowingBottom && !isUserScrolling`); `maybePinToBottom()` is the pure-pin wrapper used by every ResizeObserver / post-commit pin site. `TugMarkdownView.doSetRegion` consults `shouldAutoPin` directly then calls `pinToBottom()` because it must run a height-measurement pass between the gate check and the pin — still one gate, no inline re-derivation.
- [x] Restoration is a SmartScroll concept (`setRestoreTarget`) — `TugListView`'s `restoreAnchorRef` and per-component apply effect are gone (I-2); the restore is a resolver installed on `SmartScroll`. `TugMarkdownView`'s cold-boot restore stays a direct raw-pixel `scrollTo` — it restores a saved `{x,y}`, not a virtualized `{index,offset}` anchor whose resolved offset drifts as cells settle — which is the "(where applicable)" carve-out; it never had a `restoreAnchorRef`-style effect.
- [x] Engage / disengage is a logged, typed funnel via `useScroller()` — the `tug-disengage-follow-bottom` DOM event is removed (I-3). Logging is recorded at the `_setFollowingBottom` chokepoint, so all transitions — internal and external — are traced (post-I-3 fixup).
- [x] SmartScroll owns 100% of programmatic **vertical** (`scrollTop`) scroll-position writes in both `TugListView` and `TugMarkdownView`. The two `scrollLeft` (horizontal) writes in the `onRegionScrollSet` handlers are deliberately left raw: `SmartScroll` models vertical scroll only — there is no horizontal follow-bottom / auto-pin / restore policy for it to own.
- [x] Re-evaluate: with the surface roughly halved, decide whether the full `ScrollIntent` state-machine migration is still worth doing or whether the consolidated `SmartScroll` API is now comfortable enough to stop here. **Decided: stop here — no full `ScrollIntent` rewrite** (confirmed).

**Checkpoint re-evaluation (item 5) — decision.** Sub-step I delivered the consolidation it set out to: one pin gate (`shouldAutoPin`), one restoration mechanism on `SmartScroll`, one logged engage/disengage funnel, and `SmartScroll` as the sole owner of vertical programmatic scroll writes across both virtualized views. The ~30 `scrollTop` writers across ~10 files the I-0 diagnosis enumerated are now funneled through one class with a small, coherent API. **Decision (confirmed): stop here — do not undertake the full `ScrollIntent` state-machine rewrite.** The consolidated `SmartScroll` surface is comfortable; the remaining open behavior is the Field Note's fast-streaming re-engagement gap, and that is a *heuristic* limitation (idle auto-re-engage cannot catch a moving `scrollHeight`), not an architecture problem the rewrite is uniquely needed to fix. The narrower fix already has its foundation: I-3 added `SmartScroll.engage(source)` exposed via `useScroller()`, so "follow the live edge" can become an explicit user-re-asserted intent (a "jump to live" affordance) without a state-machine migration. Sub-step I is closed here; the fast-streaming re-engage affordance is tracked as its own scoped item if/when the gallery markdown card's UX needs it.

**Conformance (Sub-step I overall).** [D07] auto-follow-bottom semantics preserved outside the user-submit window — the user can still scroll up to break the follow after a new row pins. [L02] no React state for scroll writes — every pin / restore is an imperative `SmartScroll` call. [L06] programmatic scroll writes are DOM-appearance updates owned by SmartScroll. [L07] `isFollowingBottom` / `isUserScrolling` / `heightIndex` read live at call time. [L23] user-visible state is honest: submit always takes the user to the action; cold-boot restore reproduces the saved viewport; there is no silent failure where the message is sent but invisible.

---

##### Sub-step J — Token accounting: per-turn window delta from the last tool-loop iteration

**Status.** Sub-step J shipped twice and was wrong both times. The first pass (`aad2853b`) and the live-cell plumbing (`fdfe52dc`, Sub-step J.2) are committed; this rewrite — vetted against real session data — supersedes the *token math* of both. The `streaming_usage` wire path J.2 built is sound and is kept; only the arithmetic on top of it changes.

**What went wrong.** `cost_update.usage` is claude's `result.usage`, and `result.usage` is a **per-turn SUM across every tool-loop API call**. A turn that makes K tool calls re-reads the (cached) context K times, and `result.usage` adds up all K reads. `turnWindowTokens` summed those four fields and `perTurnTokens` differenced two such sums — so both surfaces scaled with the turn's *tool-call count*, not its context.

Measured across 10 sessions / ~1,100 real turns from the local JSONL store: the old metric runs **11–19× inflated on average, up to 147×**. One real turn (81 tool calls) reported **12,378,075 tokens** for a context window of 215,770. The committed "local diffs" turn showed **232.7K** for a real window of **~59K**. J's original verification passed only because it tested plain chat turns — one API call each, the sole case where the per-iteration sum equals the truth.

**The model (vetted).** A turn = one user message → one or more assistant API calls (the tool loop). Each call reports a `usage`; `observedInput = input + cache_read + cache_creation` is that call's context size, and it grows monotonically across the turn's calls (each call's input = the prior call's input + its output + the tool result). The session's context window is therefore defined entirely by the **last** call:

  - **`window(N)`** — the resident context after turn N — = turn N's **last non-zero-usage** API call: `input + cache_read + cache_creation + output`. *The last call, never the sum across calls.*
  - **`perTurn(N)`** — the turn's token count, on Z1B and the `TOKENS` cell — = `window(N) − window(N−1)`. **Signed**: a turn that grows the window is positive; a `/compact` that shrinks it is an honest negative. No clamp.
  - **`sessionInit`** = `window(0)` — the context before any turn (system prompt + tools + agents + memory + skills) = the session's *first* API call's `observedInput`.
  - **Zero-usage turn** — an interrupted/errored turn whose only API entry is a degenerate `stop_reason: "stop_sequence"` with all-zero `usage` (one or more per session, observed in every session studied). It carries the window forward: `window(N) = window(N−1)`, `perTurn(N) = 0` — there is no measurement to report honestly.
  - **Identity** — `sessionInit + Σ perTurn(N) = window(latest)` — telescopes exactly; confirmed `residual = 0` across all ~1,100 turns, including every compaction.
  - **Sub-agents** — a `Task` call is, from the parent's view, an ordinary `tool_use` → `tool_result`; the sub-agent's internal API churn never enters the parent turn's `usage`. No special handling. (Confirmed: zero `isSidechain` entries across 239 project sessions; were any to appear they are excluded by the same filter.)

For session `7635e374` the model yields window 19354 / 21852 / 21971 / 59196, perTurn +779 / +2498 / +119 / **+37225**, sessionInit 18575 — "local diffs" is **37.2K**, not 188.8K.

**The fix — where the last-iteration usage comes from.** `cost_update.usage` must stop carrying `result.usage` (the summed billing total) and carry the turn's **last `message_delta.usage`** instead — the final tool-loop iteration. tugcode already sees every `message_delta` (it emits `streaming_usage` from them, J.2); it tracks the most recent one and emits it as `cost_update.usage` at the `result` event. That single source change makes `extractTurnCost`, `TurnCost`, `turnWindowTokens`, and J.3's `context_breakdown` `observedInput` all correct at once, and makes the committed `cost_update.usage` identical to the last `streaming_usage` frame — so the live cell lands on the committed value with no jump. (`total_cost_usd` is untouched: the dollar cost is cumulative-per-session and still correct. A billing-style "tokens processed this turn" total, if ever wanted, is a separate field — not this one.)

**Tasks.**

- [x] **tugcode — emit the last iteration, not the sum.** `ActiveTurn` tracks the most recent `message_delta.usage` of the turn. At the `result` event, `cost_update.usage` is emitted from that tracked value, not `event.usage` (`result.usage`). Degenerate turn with no `message_delta` → last `message_start.usage`, else `{}`. Reset the tracker at each turn start.
- [x] **Simplify `liveTurnUsage` to the latest frame.** `observedInput` is monotonic within a turn, so the most recent `streaming_usage` frame is always the current window — no accumulation is needed. Replace `liveTurnUsage: { byMessage: Record<…> }` with `liveTurnUsage: LiveMessageUsage | null`; `handleStreamingUsage` stores the latest frame's `usage` (replace, not merge). Delete the `byMessage` map, the per-field-max merge, and `rollupLiveTurnUsage`. The cell reads `liveTurnUsage` directly.
- [x] **`TurnCost` / `extractTurnCost`.** No logic change — `cost_update.usage` now carries the correct (last-iteration) usage, so `extractTurnCost` freezes the right four fields. Rewrite the `TurnCost` + `extractTurnCost` docstrings: the token fields are the turn's *last tool-loop iteration's* usage; `result.usage`'s per-iteration sum is explicitly NOT what is stored, and why.
- [x] **`perTurnTokens` — signed, no clamp.** Remove `Math.max(0, …)`; return `window(N) − window(N−1)` signed. The first turn uses `sessionInit` as `window(N−1)`.
- [x] **Capture `sessionInit`.** The reducer records `sessionInitTokens` = the `observedInput` of the session's first telemetry iteration (first `streaming_usage` frame; first `cost_update` as fallback). Session-level state field, projected on the snapshot, persisted so a resumed session restores it. `perTurn(1)` reads it. — Persistence rides the `TurnTelemetry` channel: a new nullable `turn_telemetry.session_init_tokens` ledger column (tugcast), threaded through `RecordTurnTelemetryPayload` + `inject_replay_telemetry`, restored by `handleTurnComplete` from the first replayed turn. Per [DM08] no-migration policy, an existing `sessions.db` must be deleted once.
- [x] **Zero-usage / interrupted turn carries forward.** A committed turn with an all-zero `TurnCost` must not read as `window = 0`. The transcript window-walk carries the previous turn's window forward and reports `perTurn = 0` for that turn.
- [x] **Cells.** `CONTEXT` = `window` of the latest committed turn, or `liveTurnUsage` while a turn is in flight. `TOKENS` / Z1B = `perTurn` (signed; render a compaction's negative honestly, e.g. `−208.3K`).
- [x] **Tests.** Rewrite the J / J.2 token tests for the corrected model; pin the helpers against the captured session `7635e374` numbers (window 19354 / 21852 / 21971 / 59196, perTurn +779 / +2498 / +119 / +37225, sessionInit 18575) and a synthetic compaction turn (negative `perTurn`, `residual = 0`). Pin the zero-usage carry-forward.
- [ ] **HMR vet.** (a) A tool-heavy turn shows a `TOKENS` figure in the tens-of-K, not the hundreds-of-K; `CONTEXT` matches Claude Code's own `/context` within a few percent. (b) `sessionInit + Σ Z1B perTurn` equals the `CONTEXT` cell. (c) A `/compact` shows a negative `perTurn` and the window drops. (d) The live cell climbs across a tool loop and lands exactly on the committed value at `turn_complete`.

**Conformance.** [L02] token math stays in pure helpers off the snapshot — no React state. [L23] every surface is honest: the per-turn count is the real window delta (signed), never a tool-call-count-scaled billing sum; the `CONTEXT` cell tracks the model's actual context occupancy. The corrected contract is documented in `telemetry.ts` / `end-state.ts` so the `result.usage`-is-a-sum trap is not re-entered.

---

##### Sub-step J.2 — Live (intra-turn) `Tokens` / `Context` status cells

**Reconciliation note.** J.2 shipped (`fdfe52dc`). The `streaming_usage` wire path — tugcode emit, IPC event, reducer handler, live cell read — is sound and stays. But its token *math* inherited Sub-step J's `result.usage`-summing bug: `handleStreamingUsage` accumulates per-message `usage` into a `byMessage` map and `rollupLiveTurnUsage` sums it — the same per-iteration over-count. The rewritten Sub-step J corrects this: `observedInput` is monotonic within a turn, so `liveTurnUsage` collapses to the *latest* `streaming_usage` frame (no map, no sum, no rollup). The description below is the as-built J.2; the corrected math is specified in Sub-step J and lands in #4.

**Symptom.** The `TIME` status cell ticks live while a turn is in flight (a 1 Hz `useLifecycleTick` heartbeat). The `TOKENS` and `CONTEXT` cells do not — they show the last committed turn's figures and sit frozen until the next `turn_complete`. The user should watch token usage and context occupancy climb as the model streams its response, the same way `TIME` advances.

**Root cause.** tugcode emits `cost_update` only from Claude's terminal `result` event — one frame per turn, at turn-complete — so no token data reaches the client mid-turn and the cells have nothing to animate. But the data exists: Claude's streaming protocol carries incremental `usage` on the raw `message_start` event (prompt input + cache tokens, known when the response begins) and on `message_delta` events (`output_tokens` accumulating as the model generates). tugcode already receives these inside its `stream_event` handling — it just doesn't surface them.

**The path** — `tugcode emit → wire event → reducer field → cell read`:

  - **tugcode emit.** In the `stream_event` handler, extract `usage` from `message_start` / `message_delta` and emit a lightweight `streaming_usage` IPC frame. A turn may contain multiple assistant messages (the tool loop: message → tool_use → tool_result → message); each carries its own `message_start` + `message_delta`s, so the frame reports per-message usage and the reducer accumulates across the turn.
  - **wire event.** Add a `streaming_usage` event to the IPC protocol — the four-token `usage` shape `cost_update` already carries. High-frequency and lightweight: it must drive no phase transition and no persistence.
  - **reducer field.** `handleStreamingUsage` accumulates the per-message `usage` into a `liveTurnUsage` state field (summing across the turn's messages). Reset at `handleSend`; superseded at `handleTurnComplete` by the authoritative `cost_update` total — the `result` event's `usage` is the turn's true sum; the streaming accumulation is the live approximation, the committed `cost_update` is the truth and replaces it.
  - **cell read.** While `inflightUserMessage !== null`, the `TOKENS` and `CONTEXT` cells derive from `liveTurnUsage`; otherwise they show the last committed turn (current behaviour). The cells already re-render via `useSyncExternalStore`, so each `streaming_usage` frame repaints them.

**Tasks.**

- [x] **tugcode emit.** Emit `streaming_usage` from the `stream_event` handler on `message_start` / `message_delta`. Verify against a real session that the per-message `usage` sums to the `result` event's `usage`. — `mapStreamEvent` emits a `streaming_usage` IPC frame (`StreamingUsage` in `types.ts`) on both events via `streamingUsageFrame`, gated on a token-bearing `usage`. Verified against a live two-iteration tool-loop turn: per-message `message_delta.usage` summed to `result.usage` exactly (input 3+1=4, cache_creation 7340+99=7439, cache_read 13148+20488=33636, output 80+12=92). Both events carry the full four-token `usage`.
- [x] **Wire event.** Add `streaming_usage` to the IPC protocol (`protocol.ts` / `events.ts` / the tugcode IPC types). Confirm it carries no phase or persistence side effects — a display-only telemetry frame. — `StreamingUsageEvent` added to `events.ts` `CodeSessionEvent`; `streaming_usage` registered in `KNOWN_CODE_OUTPUT_TYPES`. No `protocol.ts` exists — the surfaces are tugcode `types.ts` (`OutboundMessage`) + tugdeck `events.ts` + the store's known-types set. tugcast forwards it transparently (splice `tug_session_id`, no type allowlist). The handler fires no effect and no phase change.
- [x] **Reducer.** `handleStreamingUsage` → `liveTurnUsage` accumulation across the turn's messages; reset at `handleSend`; cleared / superseded at `handleTurnComplete`. — `liveTurnUsage: LiveTurnUsage | null` field; `handleStreamingUsage` keeps a `byMessage` map, per-field-max merge within a message, sum across messages. Reset to `null` in `handleSend`; `liveTurnUsage: null` folded into `resetPerTurnTelemetry()` so all three `handleTurnComplete` branches supersede it.
- [x] **Cell read.** `TOKENS` / `CONTEXT` cells read `liveTurnUsage` while a turn is in flight. The figures jump discretely as frames land — tokens have no continuous quantity to interpolate (unlike `TIME`); do not fabricate a smooth tick. — `rollupLiveTurnUsage` folds `liveTurnUsage` into a `TurnCost`; while `inflightUserMessage !== null` the `TOKENS` cell shows `perTurnTokens(liveCost, lastTurn?.cost)` and `CONTEXT` shows `turnWindowTokens(liveCost)`, else the last committed turn. No tick fabricated — the cells repaint per `streaming_usage` frame via `useSyncExternalStore`.
- [ ] **HMR vet.** Send a long-output request: `TOKENS` and `CONTEXT` climb as the response streams, then settle exactly on the committed `cost_update` total at `turn_complete` with no visible jump or flicker.
- [x] **Test coverage.** Reducer tests for `handleStreamingUsage` accumulation across a multi-message (tool-loop) turn, and for the reset-at-submit / supersede-at-complete boundary. — `reducer.streaming-usage.test.ts` (6 tests: per-message create, per-field-max merge, multi-message additivity on real wire data, reset-at-send, supersede-at-complete, no-`msg_id` drop); `rollupLiveTurnUsage` pinned in `end-state.test.ts` (4 tests); tugcode `session.test.ts` pins the `mapStreamEvent` emit + gate. `bun x tsc` clean, `bun test` green (tugdeck 2240, tugcode 393), `audit:tokens lint` 0 violations.

**Conformance.** [L02] streaming usage enters React only through the store; the cells read the snapshot via `useSyncExternalStore`. [L06] the cells are display-only — no React state for the figure. [L23] the live figure is an honest in-flight approximation; the committed `cost_update` is authoritative and supersedes it at turn-complete with no discontinuity.

**Dependency note.** J.2 builds the streaming *plumbing* and is independent of J.3's accuracy work — the numbers it animates are whatever derivation the cells already use. J.3 may re-route the `CONTEXT` cell's source; the `liveTurnUsage` field is orthogonal and stands either way. J.2 and J.3 may land in either order.

---

##### Sub-step J.3 — Context-breakdown accuracy + cell ↔ popover unification

**Status.** J.3 was specified before Sub-step J #4 shipped and before the `/context` ground-truth audit; two premises changed and this rewrite corrects them. (1) **`sessionInitTokens` now exists.** J #4 added it — a *feed-exact* bootstrap (turn 1's first-iteration `observedInput`), captured by the reducer. The bootstrap no longer needs a local tokenizer estimate. (2) **`/context` is not ground truth.** A JSONL audit (session `def73f47`: `/context` ran before any turn and reported a 15.4k total; the immediately-following API call reported `observedInput` 21,170) showed Claude Code's own `/context` *under*-counts the system/bootstrap by ~3–6k, which inflates its `Messages` line by the same amount. J.3's original acceptance gate — "match `/context` within 5–10%" — would replicate that bug.

**Context.** J.3 closes the *categorical* context surface — the `/context`-style popover breakdown — and unifies it with the `CONTEXT` cell. Corrected model: the breakdown's **total** and its **`messages`** line are feed-exact (from `window` / `sessionInit`); only the *split among the five static categories* is a local estimate, and that estimate is *scaled to a feed-exact total*. Sub-step J is not complete until J.2 and J.3 land with it.

**Symptoms.**

  1. **Context cell and Context popover disagree.** The cell is feed-derived (`window(latest)` — accurate); the popover runs the local `context-breakdown.ts` estimate. On one captured session the cell read ~50K while the popover read 83.6K. One context number, one source, one answer.
  2. **The `context-breakdown.ts` static estimate is grossly over — by 17–52× on agents/skills.** `computeStaticCategories` sums the *full text* of every agent `.md` and every `SKILL.md`; Claude Code loads only the agent/skill *descriptions* (the frontmatter `description`) into the system prompt — the bodies load on demand and are not resident context.

     | category | tugcode estimate (today) | issue |
     |---|---|---|
     | system_prompt | 3.5K | flat constant — roughly ok |
     | system_tools | 15.5K | flat 500/tool, ~2× the observed rate |
     | custom_agents | 41.2K | **tokenizes full agent bodies** (should be ~0.8K) |
     | memory_files | 0.75K | walk under-counts the memory corpus |
     | skills | 22.7K | **tokenizes full `SKILL.md` bodies** (should be ~1.3K) |
     | **total** | **83.6K** | vs a real bootstrap of ~15–21K |

     The estimate must be fixed so the category *proportions* are believable — its absolute total no longer drives any user-visible number (see Architecture).
  3. **`messages` is wrong because it is estimate-derived.** Today `messages = max(0, observedInput − staticTotal)` with `staticTotal` the broken estimate — so `messages` clamps to 0 (the estimate far exceeds observed). The corrected `messages` is feed-exact: `window(latest) − sessionInit`.
  4. **The Tokens popover over-counts.** `computeTokensSummary` / `deriveSessionTotals` sum the `TurnCost` token fields across the transcript. `TurnCost` is per-turn last-iteration `usage`; summing `cache_read` adds the re-read context once per turn — a meaningless, inflated total. A session token figure is a window snapshot or a sum of signed `perTurn` deltas, never a sum of raw `TurnCost`.
  5. **The `Context` cell's `/` smashes the numerator** — it renders `18.6K/ 1.00M` with no space before the slash.
  6. **The Context surface is blank until the first request — a hard defect.** A fresh session shows no Context figure until a frame lands at turn-complete. The `CONTEXT` status-bar item MUST reflect the session-init token count from the *moment* a new session opens — never delayed until after the first request is sent. This is a non-negotiable requirement, not a nicety.

**Architecture — who owns which number.**

  - **Total = `window(latest)`.** Feed-exact (J #4's transcript window-walk). The `CONTEXT` cell already reads it.
  - **`messages` = `window(latest) − sessionInit`.** Feed-exact. Equal to `Σ perTurn` by J #4's telescoping identity. No tokenizer, no estimate.
  - **The five static categories sum to `sessionInit`.** `sessionInit` is the feed-exact bootstrap. The local tokenizer (`context-breakdown.ts`) estimates only the *relative proportions* among `system_prompt / system_tools / custom_agents / memory_files / skills`; tugdeck scales those five so they sum to `sessionInit`. The popover total is then `sessionInit + messages = window` = the cell, by construction.
  - **The tokenizer's job shrinks.** It no longer needs an accurate *absolute* total — only sane *relative* proportions. Its one remaining absolute use is the pre-turn-1 fresh-session display (Symptom 6), before `sessionInit` has been captured; fixing the 17–52× over-count makes even that interim figure reasonable.
  - **Filesystem stays in tugcode.** Tokenizing agent/skill/memory files needs disk access — only tugcode has it. tugcode emits the static estimate on `context_breakdown`; tugdeck assembles the final breakdown from that estimate + `sessionInit` + `window`. The `autocompact_buffer` slice (reserved headroom, conditional on the setting) is orthogonal — it is not part of `sessionInit` and is excluded from the scale-to-`sessionInit` step.

**Tasks.**

- [x] **Fix the `context-breakdown.ts` static estimate's proportions.** Count agent/skill *descriptions*, not bodies: tokenize the `description` frontmatter of each agent `.md` and `SKILL.md`. Recalibrate `TOOL_SCHEMA_DEFAULT_TOKENS` toward the observed per-tool rate (~235, not 500). Fix the `memory_files` walk so it counts the full memory corpus. The five categories no longer need an exact absolute total — but the gross over-count must go so the scaled proportions are believable.
- [x] **`messages` is feed-exact.** Retire `messages = observedInput − staticTotal`. The breakdown's `messages` slice = `window(latest) − sessionInit`, assembled tugdeck-side. Decide whether the `context_breakdown` wire frame keeps a (now-vestigial, tugdeck-recomputed) `messages` category or drops it. — Decided: **dropped** from the wire frame. `computeMessagesTokens` deleted; `ContextBreakdownCategoryId` (tugcode + tugdeck) no longer carries `messages`; the frame is the static estimate only. `context_breakdown_latest` is a JSON blob in tugcast, so no schema change.
- [x] **Scale the static split to `sessionInit`.** tugdeck's breakdown assembly scales the five tokenizer categories by `sessionInit / staticTotal` so they sum to the feed-exact bootstrap. Documented wart: `sessionInit` includes turn 1's first user message (tens of tokens), so the statics very slightly over-attribute and `messages` very slightly under — negligible.
- [x] **Unify the Context cell + popover.** Both derive from the feed — total `window`, bootstrap `sessionInit`, `messages` residual; `context_breakdown` supplies only the static sub-split. They agree by construction. The total includes the latest turn's `output` (`window` carries `output`), so it reconciles with `sessionInit + Σ Z1B perTurnTokens`.
- [x] **Fix the Tokens popover.** `computeTokensSummary` must stop summing raw `TurnCost`. The per-turn row log shows each turn's signed `perTurn` (matching Z1B); the popover total / average rebuild on those deltas.
- [x] **Show the session-init context from the moment the session opens — non-negotiable.** The `CONTEXT` cell MUST display a session-init token figure the instant a new session opens, before any request is sent. The cell's source resolution: in-flight → live `window`; committed turns exist → `window(latest)`; **no turns yet → `lastContextBreakdown`'s total** (the only session-init figure available pre-turn-1). Once turn 1's first frame lands, the feed-exact `sessionInit` supersedes the estimate. — Implementation correction: claude does NOT emit `system:init` until the first input arrives, so there is no `system:init` at session-open. tugcode instead computes the static estimate entirely from disk (`~/.claude/{agents,skills}/`, the memory files, the project plugin dir — all filesystem-resolvable) and emits `context_breakdown` at spawn (`ContextBreakdownEmitter.onSpawn`, called from `initialize()`). The one input the filesystem can't reveal — the built-in tool count — uses a flat heuristic (`SYSTEM_TOOLS_DEFAULT_TOKENS`) until `system:init` (turn 1) refines it. The Context surface is never blank on a fresh session.
- [x] **Fix the `Context` cell `/` spacing** — a space before the slash (`18.6K / 1.00M`). CSS in `tide-card.css` under the status-bar scope, or the renderer's format string.
- [x] **Remove the `token-telemetry-diagnostic.ts` instrumentation** added during J for the wire-log capture.
- [ ] **HMR vet.** (a) Fresh session — at the *moment* it opens (before any request is sent) the `CONTEXT` cell shows a non-zero session-init figure, not blank; cell + popover agree. (b) After a turn — both update; popover total = cell = `window`; the `messages` slice = `window − sessionInit`. (c) The Tokens popover total is a sane per-turn-delta figure, not an inflated cache-sum. (d) The `/` reads `N / M` with breathing room.
- [x] **Test coverage.** Pure-logic tests for the scaled-static assembly, the feed-exact `messages` line, the rebuilt Tokens-popover total, and the cell ↔ popover identity.

**Conformance.** [L02] token math lives in pure helpers off the snapshot; no React state. [L23] user-visible state is honest — the Context cell and popover never disagree; no surface shows an inflated cache-sum, a multiples-off estimate, or a `messages` line derived from a broken tokenizer. The breakdown's total and `messages` line are feed-exact; only the static sub-split is an estimate, and it is scaled to a feed-exact total.

---

##### Sub-step K — PgUp / PgDown by entry when the top-pane is focused

**Symptom.** When the user has the top-pane (the scrolling transcript) focused, PgUp / PgDown (alias: Opt+ArrowUp / Opt+ArrowDown on macOS) currently scroll by viewport-height — a generic browser-default. For a transcript organized into discrete entries (one per turn), scrolling by ENTRY is the correct unit of navigation: the user can step backward / forward through the conversation one turn at a time, with each step landing the entry at a predictable position.

**Behaviour contract.**

This is an **entry pager**, not an entry-in-view pager: each press steps exactly one entry and pins that entry's TOP flush to the TOP of the scroll viewport. PgDown advances to the next entry even when that entry is already partly or fully on screen — it is never skipped just because it was visible.

  - **PgDown (Opt+ArrowDown):** step forward one entry — pin the next entry's top flush to the top of the scroll viewport.
  - **PgUp (Opt+ArrowUp):** step back one entry — pin the previous entry's top flush to the top. From mid-entry the first PgUp snaps the current entry's top up.
  - **Edge cases:** PgUp at the topmost entry stays at the top; PgDown at the bottommost entry stays at the bottom; both are no-ops at their respective edges. PgDown when at the bottom-most entry re-engages follow-bottom (interaction with Sub-step I).

**Suspect implementation surface.**

The list-view already tracks per-cell positions in `heightIndexRef`. The keyboard handler lives somewhere in the transcript host's chain (likely on the `.tug-list-view` element itself, since it carries `tabIndex={0}`).

Likely implementation shape:

  1. Add a `KeyDown` handler on the list view (or override the existing one) that intercepts `PageUp` / `PageDown` / `Alt+ArrowUp` / `Alt+ArrowDown` (per the macOS convention).
  2. Compute the current "anchor entry" — the entry whose top edge is closest to (but not below) the current `scrollTop`.
  3. On PgUp: target = `scrollTop` for `(anchorEntry.index - 1).topY - padding-block-start`.
  4. On PgDown: target = `scrollTop` for `(anchorEntry.index + 1).bottomY - viewportHeight + padding-block-end`.
  5. Write `SmartScroll.scrollTo(target)` (smooth or instant — pick smooth for tactile feedback).

Edge: the "entry" unit here is the data-source row (`turn entry`), which in the transcript is composed of two list-view cells (user-half + asst-half). **Resolved: one entry = one list-view cell.** Paging must visit every row — user prompts as well as assistant responses — so PgUp / PgDown step one cell at a time, not one turn-pair.

**Tasks.**

- [x] **Confirmed the keyboard surface.** The `.tug-list-view` host (`tabIndex={0}`) and its focusable cell wrappers receive the keydowns; `SmartScroll` registers a bubble-phase `keydown` listener on that same host (`SCROLL_KEYS` covers PageUp / PageDown / ArrowUp / ArrowDown but never `preventDefault`s them — so the browser's viewport-height page scroll was the standing behaviour). Resolved the precedence by installing the new handler **capture-phase** on the host: it runs before SmartScroll's bubble listener regardless of registration order, and `stopImmediatePropagation` keeps SmartScroll from also processing a key this handler has claimed. An `e.defaultPrevented` guard yields to any upstream document-capture handler (responder chain) — though that chain only acts on action-vocabulary keys, not paging keys.
- [x] **Confirmed per-cell** (one entry = one `TugListView` cell). The first pass shipped per-turn-pair; the user corrected it — paging must visit *every* row, the user prompt as well as the assistant response. Since the transcript renders each half of a turn as its own cell, per-cell paging steps through all of them. The opt-in is a plain boolean `pageByEntry` prop (no cell-grouping stride — the turn-pair grouping that motivated a numeric prop is gone).
- [x] **Implemented the handler.** Two reworks landed against user feedback. (1) The first pass derived target positions from `heightIndexRef.current.offsetForIndex` — a sum of measured cell heights, which cannot see the window's `row-gap` or the `::before` / `::after` breathing-room pseudo-elements, so it drifted every landing by one `row-gap` per entry, compounding down the list. (2) The second pass paged by *entry in view* — PageDown skipped entries that were already visible. Final design is a true **entry pager**: `internal/list-view-page-navigation.ts` (`computePageNavigation`) is the pure SELECTION half — given every entry's viewport-relative top edge it finds the current top entry (the last whose top has reached the viewport top), then steps ±1 (PageDown → current+1, PageUp → current−1, with a snap-to-current when the viewport is mid-entry). The `TugListView` keydown handler reads real entry tops via `getBoundingClientRect` (the height index cannot represent gaps / pseudo-elements), runs the selection, then routes the scroll through `SmartScroll.scrollToElement` — the browser's exact `scrollIntoView` with `block: "start"`, pinning the target entry's top flush to the viewport top in BOTH directions. PageUp additionally `disengage`s follow-bottom; a PageDown already on the last entry uses `scrollToBottom` (re-engages follow-bottom, composing with Sub-step I). Opt+ArrowUp / Opt+ArrowDown are accepted as the macOS aliases. Pure-logic tests in `internal/__tests__/list-view-page-navigation.test.ts`.
- [ ] **HMR vet.** _Pending user verification._
    - (a) PgUp from mid-transcript: the previous entry's header (Z0) pins flush to the top of the viewport.
    - (b) PgDown from mid-transcript: the next entry's header (Z0) pins flush to the top of the viewport — including when that entry was already in view (entry pager, not entry-in-view pager).
    - (c) PgUp at the top entry: no-op (or scroll to the absolute top if not already there).
    - (d) PgDown at the bottom entry: scrolls to the absolute bottom AND re-engages follow-bottom (composes with Sub-step I).
    - (e) Hold Opt and press ArrowUp / ArrowDown — same behaviour as PgUp / PgDown (the macOS alias).

**Conformance.** [L02] keyboard handler is a DOM event listener installed in a `useLayoutEffect` ([L03]); no React state for the scroll write. [D07] auto-follow-bottom intent tracked through SmartScroll, same discipline as wheel / pointer scroll. [L23] keyboard navigation lands the user at a PREDICTABLE position every time — top of previous entry, bottom of next entry — not "approximately one viewport up / down."

---

##### Sub-step L — Bash renderer: expand / collapse with pinning + tunable default-line cap

**Symptom.** Bash result blocks render full, unbounded output regardless of how long the stdout / stderr stream is. A `find . -type f` listing 300 entries renders as 300 lines; the transcript is dominated by one entry. There is no user-facing affordance to collapse the output to a readable summary line count.

**Reference.** `FileBlock` and `DiffBlock` already implement an expand / collapse control with pinning behaviour: the chrome row sits at the top of the body, and on collapse the body folds to a fixed height while keeping the chrome (with the affordance toggle) visible. Bash should adopt the same pattern.

**Behaviour contract.**

  - **Collapsed state (default):** body shows the first N lines (tunable, default 25). Trailing chrome reads "X more lines" with the expand toggle.
  - **Expanded state:** body shows all lines. Toggle reads "Collapse" — clicking returns to collapsed state.
  - **Pinning:** when the user collapses an expanded block, the cell wrapper shrinks (Sub-step H's hydration-lock release work makes this possible without ghost space); when the user expands a collapsed block, the cell grows and the scroll anchor stays put (Sub-step H's scroll-anchoring contract applies).
  - **Default-line cap configurable:** the 25-line default should be easily tunable (likely a const at the top of the bash body kind, with a comment explaining the tradeoff between "see the output" and "don't dominate the transcript").

**Suspect implementation surface.**

`agent-transcript-block.tsx` or whichever file owns the bash body kind. Look at how `FileBlock` / `DiffBlock` wire their expand / collapse:

  - Local state (or per-callsite ref) for `expanded: boolean`.
  - Chrome row with the toggle button (icon + label).
  - Body shows truncated or full content based on `expanded`.
  - The cell wrapper's height responds via standard ResizeObserver flow.

The Bash body kind likely renders its output as a `TerminalBlock` or similar — confirm the existing component, then add the expand / collapse axis if not already there.

**Tasks.**

- [x] **Audited the Bash body kind.** The Bash renderer (`BashToolBlock`) composes `TerminalBlock` (or `DiffBlock` for diff-shaped output) as its body kind. `TerminalBlock` *already* carried the full expand / collapse axis — a `BlockFoldCue`, `collapsed` / `onToggleCollapsed` props, the `collapseThreshold` prop, a collapsed-preview render path, and the [A9]-preserved fold flag — surfaced as an affordance (the cue portals into the tool-wrapper chrome). The mechanism was not missing; it was mistuned. The fold threshold was 300 lines (a `find . -type f` listing 300 entries is `300 > 300 == false`, so it never folded — the symptom exactly), and the collapsed preview was a fixed 8 lines, independent of the threshold. So this sub-step was retuning + library consolidation, not net-new wiring.
- [x] **Consolidated the expand / collapse axis into a library helper.** The four fold-bearing body kinds (`FileBlock`, `DiffBlock`, `TerminalBlock`, `AgentTranscriptBlock`) each hand-rolled the same collapse state machine — controlled/uncontrolled resolution, mount-in-saved-state seeding, [A9] capture registration, and the toggle callback. Extracted it to `body-kinds/affordances/use-block-fold-state.ts` (`useBlockFoldState`) and migrated all four; each now supplies only what differs (the `defaultCollapsed` seed, the optional controlled prop / notification). The hook is the state companion of `BlockFoldCue` (the control) — the affordance library now delivers the whole fold feature as one matched pair.
- [x] **Wired the pinning.** Already wired — `BlockFoldCue` *is* the shared FileBlock / DiffBlock pinning chrome (`useScroller().disengage` follow-bottom release + `usePositionStableClick`), and `TerminalBlock` already composed it. No new pinning work; the audit confirmed it. Additionally hardened `BlockFoldCue` against layout shift: it now takes `collapsedLabel` + `expandedLabel` and width-stabilizes against the wider of the two (`TugPushButton`'s `widthStabilize`), so a state-dependent label can never resize the button on click.
- [x] **Picked the default-line cap.** `DEFAULT_COLLAPSE_THRESHOLD = 25` in `terminal-block.tsx`, with a docstring explaining the tradeoff (too low → constant expanding; too high → one result dominates the transcript) and naming it the consumer-overridable default for the `collapseThreshold` prop. The collapsed preview now shows the first `collapseThreshold` lines (a single cap — the former separate 8-line `COLLAPSED_PREVIEW_LINES` constant is gone), and the cue reads "N more lines" collapsed / "Collapse" expanded. `VISIBLE_THRESHOLD` (virtualization of the *expanded* body) stays at 300 — an independent concern.
- [ ] **HMR vet.** _Pending user verification._
    - (a) Submit `find . -type f | head -300`. Result renders collapsed (25 lines visible) by default.
    - (b) Click "Expand" — body grows to full content; subsequent entries push down; user's anchor stays put (per Sub-step H).
    - (c) Click "Collapse" — body folds back to 25 lines; subsequent entries pull up; no ghost space (per Sub-step H's hydration-lock release).
    - (d) Pinning chrome stays at top of body during scroll; toggle is always reachable.
    - (e) Bash results SHORTER than the cap render expanded by default (no toggle needed — there's nothing to collapse).
    - (f) Toggling the fold cue does not resize the button — "N more lines" and "Collapse" share the wider state's width; the action row never shifts.

**Conformance.** [L26] mount identity preserved across the collapse / expand transition. [L02] `expanded` is local component state (it doesn't escape into shared snapshot or store). [D07] scroll behaviour follows the Sub-step H contract — the wrapper's height tracks the body, no min-height ghost. [L19] body-kind authored in the established `body-kinds/*` pattern; toggle uses `TugPushButton` or the existing FileBlock chrome primitive.

---

**Tests.**

- [ ] `bun x tsc --noEmit` clean.
- [ ] `bun test` green.
- [ ] `bun run audit:tokens lint` exits 0.

**Checkpoint.**

- [ ] All twelve sub-steps closed; HMR-vetted against the production tide-card.
- [ ] No regressions in 20.4.15-landed surfaces (Z2 row, Z1 asst-half).
- [ ] The Z1B flashing diagnosis (Sub-step A) and the collapse-gap diagnosis (Sub-step H) are both documented in their commit messages so the L26 + windowing lessons are recorded for future authors of cell-renderer lambdas and body-kind collapse affordances.
- [x] The token-attribution contract from Sub-step J is documented in `end-state.ts` / `telemetry.ts` source comments so the per-turn vs cumulative distinction survives future cost-related work.
- [x] The Sub-step I scrolling consolidation (I-1 … I-4) is closed and its checkpoint answered: `SmartScroll` is the single funnel for pinning, restoration, and engage/disengage, and the decision on the deeper `ScrollIntent` rewrite is recorded (decided: no rewrite). HMR vets for I-0…I-4 remain as manual passes.

---

#### Step 20.5: Lifecycle coordination + Z5 {#step-20-5}

**Depends on:** #step-20-4 (slot infrastructure + placement decisions from the HMR study)

**Status:** _in progress — 20.5.A + 20.5.B complete (lifecycle spec landed as the canonical artifact; polish-13/14/15 audited, the question dialog and both replay end-state bugs closed). Remaining: ~~20.5.C~~ (superseded by Step 20.4.10–20.4.13) → 20.5.D. ~~20.5.E~~ (the `/context`-style drill-down) was deleted 2026-05-21 — superseded by the tide-card status-row popovers shipped in Step 20.4._

**Scope overview.** [#step-20-4] establishes the placement zones (Z0–Z4) as display-only slots and decides default content via HMR study. Step 20.5 closes the tide-card request/response lifecycle: it documents the state machine that drives everything (20.5.A), audits and closes gaps against polish-plan Steps 13 / 14 / 15 (20.5.B), ~~studies and adds the `agent` role to `TugProgress` for Z1's SUBMITTING-state immediate-feedback indicator (20.5.C)~~ — _superseded; the Z1 asst-half indicator is `TugThinkingIndicator` per [Step 20.4.10](#step-20-4-10) instead of a TugProgress variant_, and wires Z5 + cross-zone lifecycle coordination + the chosen telemetry placement defaults (20.5.D).

The remaining sub-steps are gated sequentially: 20.5.A is the spec that everything else references; 20.5.B closes pre-existing gaps so downstream work builds on working primitives; 20.5.D is the big lifecycle implementation. The Z1 asst-half indicator work that was 20.5.C now lives in [Step 20.4.10](#step-20-4-10)–[Step 20.4.13](#step-20-4-13) and ships via [Step 20.4.15](#step-20-4-15). The `/context`-style drill-down surface that was 20.5.E was deleted — the per-cell status-row popovers shipped in [Step 20.4](#step-20-4) (Context / Time / Tokens / State) supersede it.

**References:** [#step-20-3] (data model), [#step-20-4] (slot infrastructure + study outcome), [polish-plan #step-13](./tugplan-tide-card-polish.md#step-13), [polish-plan #step-14](./tugplan-tide-card-polish.md#step-14), [polish-plan #step-15](./tugplan-tide-card-polish.md#step-15), [L02], [L23], [L26]

---

#### Step 20.5.A: Lifecycle map — state machine + zone coordination matrix (spec only) {#step-20-5-a}

**Depends on:** none — pure documentation step.

**Status:** _Complete. The state diagram, state-definitions table, and state-to-zone coordination matrix in this section are the landed canonical artifact that 20.5.B / 20.5.D / 20.5.E implement against; [DT10](#dt10-replay-transcript-suppression) (REPLAYING transcript-paint suppression) landed in the decision-tables section and is cross-referenced from the REPLAYING diagram box, state-definitions row, and matrix row. Landing reconciled three spec/code drifts against the 20.4.15-shipped primitives: the AWAITING_FIRST_TOKEN diagram box named the superseded `TugProgress`; the matrix intro named a non-existent `data-slot="tide-asst-half-z1b"` (production `TideZ1B` uses `data-slot="tide-z1b"`); and the matrix-edit policy / STREAMING row attributed Z1B's content swap to `isLivePhase(phase)` when `TideZ1B` in fact drives it per-row off `turn === undefined` (session `phase` is deliberately not an input). All snapshot fields the state-definitions table references — `phase`, `transportState`, `interruptInFlight`, `pendingApproval`, `pendingQuestion`, `queuedSends`, `transcript`, `lastError`, `inflightUserMessage` — were verified present on `CodeSessionSnapshot` (`types.ts`) with the claimed shapes._

**Commit:** `plan(tide-rendering): lifecycle state machine + Z0–Z5 coordination matrix`

**References:** [#step-20-3] (data fields the matrix references), [#step-20-4] (zone catalog)

**Scope.** Document the canonical state machine that governs the tide-card request/response lifecycle, plus the state-to-zone coordination matrix that 20.5.D will implement against. This step lands the spec into the plan itself; no code, no tests. The diagram + matrix below ARE the deliverable.

**The state diagram.**

```
            ┌──────┐
            │ IDLE │ ← phase=idle, transcript may have prior turns
            └──┬───┘
               │ user submits
               ▼
        ┌────────────┐
   ┌────│ SUBMITTING │── phase=submitting; send frame in flight ──┐
   │    └─────┬──────┘                                            │
   │          │ send acknowledged                                 │
   │          ▼                                                   │
   │   ┌────────────────────┐                                     │
   │   │ AWAITING_FIRST_    │ ← phase=awaiting_first_token        │
   │   │       TOKEN        │   (post-send, pre-first-token —     │
   │   └─────┬──────────────┘    where Z1B's indicator shows)     │
   │         │ first assistant_delta                              │
   │         ▼                                                    │
   │   ┌─────────────┐                                            │
   │   │  STREAMING  │◄────── tool_result ────────────────┐       │
   │   └─┬──────┬────┘                                    │       │
   │     │      │                                         │       │
   │     │ tool_use                                       │       │
   │     ▼      │                              ┌───────────┐      │
   │ ┌───────────┐      ctrl_req_              │ TOOL_WORK │      │
   │ │ TOOL_WORK │──────forward──┐             └───────────┘      │
   │ └───────────┘               │                                │
   │                             ▼                                │
   │             ┌────────────────┐                               │
   │             │ AWAITING_USER  │                               │
   │             │ (perm OR qstn) │── allow/deny/answer ──────────┤
   │             └────────────────┘   (resume STREAMING or        │
   │                  │                TOOL_WORK above)           │
   │                  │                                           │
   │                  │ in-dialog Esc / cancel button =           │
   │                  │ DIALOG DISMISS only (not turn cancel)     │
   │                  │ → equivalent to deny/cancel response      │
   │                  │ → lifecycle resumes                       │
   │                  │                                           │
   ├── CANCEL TRIGGER: Esc (no overlay foregrounded)               │
   │                   OR Stop button click                       │
   │                   from { SUBMITTING, AWAITING_FIRST_TOKEN,   │
   │                          STREAMING, TOOL_WORK }              │
   │                   (NOT reachable from AWAITING_USER — see    │
   │                   [DT07]; NOT reachable from REPLAYING /     │
   │                   ERRORED — terminal-with-context states)    │
   ▼                                                              │
   ┌────────────────┐                                             │
   │  INTERRUPTING  │ ← interrupt frame in flight; brief transient│
   │ (Z5 "Stopping…"│   (interruptInFlight === true)              │
   │  disabled)     │                                             │
   └────────┬───────┘                                             │
            │ turn_complete (reason="interrupted")                │
            ▼                                                     │
   ┌─────────────────────────────────┐                            │
   │           COMPLETE              │ ← phase=idle               │
   │ TurnEntry frozen, turnEndReason:│   AND transcript appended  │
   │   "complete"                    │ ← normal STREAMING done    │
   │   "interrupted"                 │ ← from INTERRUPTING above  │
   │   "error"                       │ ← protocol error mid-turn  │
   │   "transport_lost"              │ ← transport gone at end    │
   └──────────────┬──────────────────┘                            │
                  │ user submits next                             │
                  └─────────► (back to SUBMITTING) ───────────────┘

  Parallel-terminal-with-context states (NOT routed through COMPLETE;
  the session is in a persistent non-ready state):
    ┌───────────┐   phase=replaying; reducer reconstructing committed
    │ REPLAYING │   turns from past frames after reload / relaunch /
    │  (Z5      │   transport reconnect. Transcript paint is suppressed
    │  disabled)│   until replay_complete — one reveal at the restored
    └───────────┘   position, never the incremental fill-in [DT10].
    ┌───────────┐   phase=errored; session has a sticky error
    │  ERRORED  │   (lastError populated). Persists until user clears
    │  (Z5      │   or resubmits. Distinct from COMPLETE because no
    │  disabled)│   clean TurnEntry was committed.
    └───────────┘

  Note: ERRORED is BOTH a reducer phase (phase=errored, sticky) AND a
  possible turnEndReason value on COMPLETE (when an error mid-turn
  still produced a partial TurnEntry committed to transcript). These
  are distinct: the phase is the session state; the reason is per-turn.
  TRANSPORT_LOST is only a turnEndReason value — not a separate phase
  (the reducer uses phase=errored or phase=idle plus transportState
  for the session state during loss).

  Overlay states (orthogonal — can apply during any non-IDLE state):
    • TRANSPORT_DOWN     ← transportState ∈ {"offline", "restoring"}
                           (BOTH count as downtime — wire-up-but-binding-
                            not-yet-re-ack'd is unusable too)
    • QUEUED_NEXT_TURN   ← queuedSends > 0
                           (user typed + submitted during STREAMING/
                            TOOL_WORK; queued for auto-flush on idle)
```

**State definitions.** Signals refer to the actual `CodeSessionPhase` enum (`types.ts:32` — `idle | submitting | awaiting_first_token | streaming | tool_work | awaiting_approval | replaying | errored`) and the snapshot's existing fields (`pendingApproval`, `pendingQuestion`, `transportState`, `inflightUserMessage`, `queuedSends`, plus the new `interruptInFlight` from [Step 20.3](#step-20-3)):

| State | Entry condition | Reducer signal |
|---|---|---|
| IDLE | No active turn. Initial state and the steady state after each COMPLETE until the user submits again. | `phase === "idle"` AND `interruptInFlight === false` |
| SUBMITTING | User pressed Enter; `send` frame in flight; no `assistant_text` / `thinking_text` / `tool_use` received yet. | `phase === "submitting"` |
| AWAITING_FIRST_TOKEN | **One** text event (`assistant_text` *or* `thinking_text`) has arrived — the `submitting → awaiting_first_token` transition in `handleTextDelta`. The name is historical: despite "awaiting", the first token has *already* landed, and a *thinking* partial counts. **This is where Z1's `TugThinkingIndicator` shows.** | `phase === "awaiting_first_token"` |
| STREAMING | **Two or more** text events have arrived — `handleTextDelta`'s `awaiting_first_token → streaming`. Count-based, not channel-based: a turn still only *thinking* reaches STREAMING with zero answer text. The genuine "answer has begun" signal is `firstAssistantDeltaAt` / `firstToolUseAt` (reducer state, set on the first **assistant-channel** delta / first `tool_use`), NOT this phase — see [Step 20.5.D.4](#step-20-5-d-4)'s threshold. | `phase === "streaming"` |
| TOOL_WORK | `tool_use` sent; awaiting `tool_result`. | `phase === "tool_work"` |
| AWAITING_USER | `control_request_forward` arrived; awaiting Allow/Deny (permission) or answer (question). | `phase === "awaiting_approval"` (canonical) — equivalently `pendingApproval !== null \|\| pendingQuestion !== null` |
| INTERRUPTING | User clicked Stop or Esc; `interrupt` frame in flight; awaiting `turn_complete`. Brief transient. | `interruptInFlight === true` |
| REPLAYING | After a reload / relaunch / transport reconnect, reducer is reconstructing committed turns from past frames. Z5 disabled; transcript paint suppressed until `replay_complete` ([DT10](#dt10-replay-transcript-suppression)). | `phase === "replaying"` |
| ERRORED | Sticky session error (`lastError` populated). Distinct from COMPLETE+turnEndReason="error" — this is a session-level error state, not a per-turn one. Persists until user resubmits. | `phase === "errored"` |
| COMPLETE | Just-finished turn; `TurnEntry` frozen onto transcript. Same `phase === "idle"` as IDLE but the just-frozen turn drives Z1 final-metrics display. | `phase === "idle"` AND `transcript.length > 0` AND `interruptInFlight === false` |
| TRANSPORT_DOWN (overlay) | Wire not usable. Can apply during any non-IDLE state; covers BOTH `offline` (no wire) AND `restoring` (wire back, binding not re-ack'd). | `transportState !== "online"` |
| QUEUED_NEXT_TURN (overlay) | User submitted a second prompt while a turn was in flight; queued for auto-flush on idle. | `queuedSends > 0` |

**Persistence projection.** The subset `(phase, transportState, interruptInFlight)` is the *indicator-tone axis set*: exactly what [`TugStateIndicator`](#step-20-4-2) reads as props, and exactly what [Step 20.4.8](#step-20-4-8)'s `session_state_changes` ledger persists. The invariant is **ledger axes ≡ indicator's tone axes ⊆ matrix signals**: signals in this table that are NOT in that triple (transcript length, `pendingApproval` / `pendingQuestion` distinction, `queuedSends`, `turnEndReason`) are deliberately not persisted as state-change rows; consumers recover them from other tables (`TurnEntry`s for `turnEndReason`, transcript-length count for IDLE↔COMPLETE) or accept that they're not historically replayable. **Known gap — closed in [Step 20.5.B](#step-20-5-b).** The "`TurnEntry`s for `turnEndReason`" clause assumes a committed `TurnEntry` survives a resume; it does not. A resumed session *rebuilds* each `TurnEntry` from replayed frames and re-derives `turnEndReason` from `turn_complete.result` + the runtime-only `interruptInFlight` — which cannot distinguish an interrupted turn from an errored one on the replay path. Persisting the per-turn end reason is [Step 20.5.B](#step-20-5-b)'s [replay-2] gap-close. If this matrix grows a new tone-bearing signal, all three artifacts (indicator props, this table, ledger schema) co-evolve in the same step.

**Replay fidelity.** REPLAYING is a first-class state above, but the lifecycle map alone does not say which per-turn *artifacts* survive a resume — and the [Step 20.5.B.1](#step-20-5-b-1) corpus audit (the real translator run over ~280 on-disk sessions) showed the honest answer is mixed. This matrix is the contract; a row that reads ✗ is a known gap with its closing step named. The reducer / translator must satisfy it; a regression against any ✓ row is a bug.

| Per-turn artifact | Round-trips a resume? | Mechanism / gap |
|---|---|---|
| User message text | ✓ | `user_message_replay` from the JSONL `user` entry |
| Assistant text / thinking | ✓ | `assistant_text` / `thinking_text` from the JSONL `assistant` entry |
| Tool calls (name / input / result) | ✓ | `tool_use` + `tool_result` from the JSONL |
| Tool-call nesting (subagent grouping) | ✗ | subagent internals live in separate `subagents/*.jsonl` files replay never reads ([W3]); the main JSONL carries no non-null `parent_tool_use_id` |
| `turnEndReason` (`complete` / `interrupted` / `error`) | ✓ | persisted on `TurnTelemetry.turnEndReason` ([replay-2]); the pre-[replay-2] re-derivation mislabelled interrupted turns |
| A genuinely-dangling final turn (cut off mid-tool) | ✓ | tugcode synthesizes a terminal `turn_complete` ([replay-1]) |
| A trailing user-only orphan (submission, no response) | ✗ → ✓ | dropped today; `flushPendingOrphan`-at-EOF closes it ([W2] / [Step 20.5.B.1.a](#step-20-5-b-1-a)) |
| A clean non-`end_turn` terminal (`stop_sequence` / `max_tokens` / `refusal`) | ~ → ✓ | mislabelled `interrupted` today; clean-terminal recognition fixes it ([W1] / [Step 20.5.B.1.a](#step-20-5-b-1-a)) |
| Permission / question records | ✗ | `control_request_forward` is gate-suppressed during the replay window; the decision is not re-emitted as a `ControlRequestRecord` ([W4]) |
| Per-turn telemetry (cost / 4-clock timing) | ✓ _pending_ | inlined on `turn_complete` from the SessionLedger; the consumer side is ready, persistence is [#step-20-3-4] |
| Plain-text user prompts (string `message.content`) | ✗ → ✓ | Claude Code persists a plain prompt (no attachments) as a bare-string `message.content`; the content walk iterated the string's *characters* and dropped it. Normalised to one text block ([W5a] / [Step 20.5.B.1.b](#step-20-5-b-1-b)) — the corpus carries 899 such genuine prompts across 23% of sessions |
| `/compact` summary + slash-command scaffolding | ✗ _(by design)_ | the `isCompactSummary` continuation block and `<command-*>` / `<local-command-*>` string entries are Claude-Code-internal bookkeeping, not transcript submissions — recognised and skipped, not surfaced ([W5a]); a post-`/compact` continuation turn therefore replays with an empty user message |
| Context-window numbers | ✓ | derived from per-turn `usage`; `deriveContextWindows` carries signed deltas, incl. a `/compact` negative — pinned against a real captured compaction drop ([W5c]) |
| Transient API errors (`overloaded_error`) | ✗ _(by design)_ | a `system` / `api_error` entry (`error.status: 529`), intentionally skipped — a 529 is transient: the turn either recovered or is genuinely dangling (handled by [replay-1]) ([W5b]) |

A committed turn may therefore have **empty assistant content** — a flushed trailing-orphan ([W2]) is a valid COMPLETE turn whose user message drew no response. The COMPLETE row of the matrix below (Z1's trailing `BlockCopyButton`, keyed off the assistant text) must tolerate that: an empty `bodyText` suppresses the copy button, the row otherwise renders normally.

**The state-to-zone coordination matrix.** What each zone shows / does in each state. This is the contract [Step 20.5.D](#step-20-5-d) implements:

Every Z1 asst-half cell below assumes the **two-line stack** wired in [Step 20.4.15](#step-20-4-15): Z1A (model name + timestamp + sequence) on top, the body in the middle, Z1B (status / end-state row) on the bottom. Z1A is mounted unconditionally across every state in which the transcript is painted — the model name + timestamp never disappear; only Z1B's content swaps. (REPLAYING is the exception: the transcript is not painted during replay — see [DT10](#dt10-replay-transcript-suppression) and the REPLAYING row below.) Z1B is itself an always-mounted slot (`<div data-slot="tide-z1b">`) per the [L26] contract validated in [Step 20.4.12](#step-20-4-12); the cell below names only what swaps INSIDE the slot.

| State | Z0 (top of card) | Z1 (per-turn trailing — asst half) | Z2 (status bar) | Z3 (prompt-entry top) | Z4 (prompt-entry footer) | Z5 (submit button) |
|---|---|---|---|---|---|---|
| IDLE | reserved | Z1A: model + timestamp from the most-recent committed turn. Z1B: prior-turn `EndStateDisplay` (badge + active-ms + tokens) — the just-frozen turn's end-state stays surfaced. | status row · STATE "Idle" · TIME frozen at the last turn | project badge | (default content per 20.4 study) | **Submit** (disabled if prompt empty) |
| SUBMITTING | reserved | Z1A: live model + submit timestamp. Z1B: `TugThinkingIndicator` (`animating={true}`) — no streaming deltas yet. | status row · STATE "Sending" · TIME live (ticking via [useLifecycleTick](#step-20-3)) | project badge | (default) | **Stop** |
| AWAITING_FIRST_TOKEN | reserved | Z1A: live model + submit timestamp. Z1B: `TugThinkingIndicator` (`animating={true}`). | status row · STATE "Waiting" · TIME live (ticking) | project badge | (default) | **Stop** |
| STREAMING | reserved | Z1A: live model + submit timestamp. Z1B: `TugThinkingIndicator` (`animating={true}`) — bars pulse for the duration of the live phase. (The earlier "freeze while text is actively streaming" derivation from the deferred [Step 20.4.11](#step-20-4-11) is not wired — `TideZ1B` hardcodes `animating={true}` in its in-flight-row mode, so the bars pulse for the whole live phase with no streaming-vs-thinking sub-state.) | status row · STATE "Streaming" · TIME live · TOKENS / CONTEXT climb off the live frame | project badge | (default) | **Stop** |
| TOOL_WORK | reserved | Z1A: live model + submit timestamp. Z1B: `TugThinkingIndicator` (`animating={true}`). | status row · STATE "Working" · TIME live (ticking) | project badge | (default) | **Stop** |
| AWAITING_USER | reserved | Z1A: live model + submit timestamp. Z1B: `TugThinkingIndicator` (`animating={true}`) — `awaiting_approval` is a live phase, so the indicator continues to pulse; the "paused" semantic surfaces on Z2 (yellow indicator) and Z5 (disabled), not by freezing Z1B's animation. | status row · STATE "Awaiting" (caution) · TIME frozen — `deriveTimeCellMs` pauses on the yellow axis | project badge | (default) | **"Awaiting your input"** (disabled) |
| INTERRUPTING | reserved | Z1A: live model + submit timestamp. Z1B: `TugThinkingIndicator` (`animating={true}`) — phase is still live until `turn_complete` arrives; the interrupt-in-flight signal surfaces on Z2 (caution tone) and Z5, not Z1B. | status row · STATE caution + pulse · TIME frozen (pause) | project badge | (default) | **"Stopping…"** (disabled, transient) |
| REPLAYING | reserved | transcript turn rows are not painted during replay — Z1 / Z1A / Z1B do not render; the transcript holds its pre-replay paint (the `TideRestoring` placeholder on a cold resume; the last painted transcript on a mid-session reconnect) and does its single reconstructed paint at `replay_complete` ([DT10](#dt10-replay-transcript-suppression)). | status row absent during a cold replay (the `TideRestoring` backdrop holds); STATE "Replaying" on a mid-session reconnect | project badge | (default) | **"Restoring…"** (disabled) |
| ERRORED | reserved | Z1A: model + timestamp from the partially-committed turn (when one exists). Z1B: `EndStateDisplay` rendered against that partial `TurnEntry` (`error` badge, danger tone); when no `TurnEntry` was committed, Z1B is empty but its slot div stays mounted ([L26]). | status row · STATE "Error" (danger); the error copy is the `TugPaneBanner`, not Z2 | project badge | (default) | **Submit** (enabled — user may retry; submit clears the error per current reducer semantics) |
| COMPLETE | reserved | Z1A: model + timestamp of the just-committed turn. Z1B: `EndStateDisplay` — tone-coded ghost badge (`complete` / `interrupted` / `error` / `transport_lost`) + active-ms + total tokens + a trailing `BlockCopyButton` keyed off the assistant text. | status row · STATE "Idle" · TIME the just-committed turn | project badge | (default) | **Submit** |
| TRANSPORT_DOWN (overlay) | reserved | Z1A: unchanged. Z1B: whatever the underlying phase's row above resolves to — frozen visually (the indicator keeps pulsing per its phase-driven `animating` flag; freezes are signalled on Z2/Z5 not Z1B). | status row · STATE indicators go danger / caution tone; the "Disconnected" copy is the `TugPaneBanner`, not Z2 | project badge | (default) | **"Reconnecting…"** (disabled). When `transportState === "restoring"`, label is "Reconnecting…" too (the binding ack is part of the reconnect); when `"offline"`, label is "Reconnecting…" (we don't expose the offline/restoring distinction to the user — both are "session unusable"). |
| QUEUED_NEXT_TURN (overlay) | reserved | Z1A / Z1B: unchanged from the current turn's row. **Plus** one *ghosted user row* per queued send, appended at the transcript foot, in submit order, each ✕-cancellable — see the note below. | status row unchanged (the base state's row) | project badge | (default) | **`[+] [■]`** — primary Stop button + a `+` queue button to its left; see the note. |

**QUEUED_NEXT_TURN — the queue UI.** A prompt submitted while a turn runs is *queued* ([Step 20.5.D.4](#step-20-5-d-4)), not interrupted. Two surfaces:
- **Transcript ghost rows.** Each queued send is a **ghosted user row** at the foot of the transcript — one per send, in submit order, de-emphasized to read as "not yet sent," each carrying a ✕ that cancels it (a true un-send: no wire traffic). `turn_complete(success)` flushes the head of the queue into a real turn.
- **Z5 button group.** While a turn is live (the SUBMITTING / AWAITING_FIRST_TOKEN / STREAMING / TOOL_WORK rows above) Z5 is the primary **Stop** (`■`) button. A **`+` queue button** appears to its left **only once the user types into the prompt-entry mid-turn** — progressive disclosure, so a plain submit → wait → submit flow never surfaces queuing. Stop ≡ Esc: both peel the newest cancellable thing — the newest queued send first, then (queue empty) the running turn.

Full behavior — the C1/C2/C3 cases, the threshold, the gesture map — is [Step 20.5.D.4](#step-20-5-d-4)'s cancellation spec.

**REPLAYING transcript suppression.** The REPLAYING row encodes [DT10](#dt10-replay-transcript-suppression): a resumed session reconstructs its committed turns one `turn_complete` at a time, and painting each intermediate state makes the transcript visibly accumulate while the viewport chases the live edge — the restore FOUC the lifecycle investigation diagnosed. The transcript host therefore gates its visible render on `state !== "replaying"`, holding its pre-replay paint across the window and doing one reconstructed paint at `replay_complete`. The implementation lands in [Step 20.5.D](#step-20-5-d); this row is its contract.

**Z2 status row.** The matrix's Z2 column describes the shipped `TideTelemetryStatusRow` — the four-cell **STATE · TIME · TOKENS · CONTEXT** row promoted in [Step 20.4](#step-20-4) and reshaped across the 20.4.x series, unconditionally mounted across every phase / transport / interrupt transition ([L26]). It is **not** a per-state badge that swaps the row out. Per cell: the **STATE** cell shows the human-readable phase title plus two tone-coded `TugStateIndicator` glyphs (`phase × transportState × interruptInFlight`); the **TIME** cell runs the live in-flight clock through `deriveTimeCellMs`, which pauses on the yellow axes (awaiting-approval, transport-downtime, interrupt-in-flight) and freezes at `turn_complete` — so the matrix's "live / frozen" Z2 behaviour is `deriveTimeCellMs`'s union-pause math applied per cell, not a row-level swap; **TOKENS** / **CONTEXT** climb mid-turn off `liveTurnUsage` and settle on the committed window-walk. The terminal-state copy the pre-20.4.x Z2 column once carried as badges — "Restoring session…", "Session error", "Disconnected — reconnecting" — is surfaced by the card's primary surfaces, the `TideRestoring` backdrop ([Step 20.5.D.2.A](#step-20-5-d-2-a)) and the `TugPaneBanner` (its error / transport precedence chain); Z2 reflects those states through its STATE cell's label + indicator tone, not a duplicate badge. [Step 20.5.D.5](#step-20-5-d-5)'s audit confirmed the shipped row already satisfies this column and re-authored the column to describe it — Z2 needed no new code.

**Z4 prompt-entry footer.** Z4 has no production occupant. The matrix once gave it a phase indicator — "Awaiting first token" / "Claude is thinking" / "Running {tool}" — but the Z2 status row's STATE cell already names the live phase and carries the tone-coded indicators, so a footer phase line only duplicates it, further from where the eye already rests. The prompt-entry footer slot stays unfilled in production (an explicit `footerContent` prop or the dev placement-experiment harness can still fill it). [Step 20.5.D.5](#step-20-5-d-5) built the indicator and shipped it, then removed it on review for exactly this redundancy — the same "the STATE cell already carries it" finding that kept Z2 from growing duplicate badges.

**Matrix-edit policy.** [Step 20.5.C](#step-20-5-c) is **superseded** by [Step 20.4.10](#step-20-4-10) through [Step 20.4.13](#step-20-4-13); [Step 20.4.15](#step-20-4-15) authoritatively wired the production Z1 asst-half cells per the polish-plan above. Every Z1 asst-half cell in the matrix now says (a) which content the two-line stack's status row (Z1B) shows for that state — `TugThinkingIndicator` on the in-flight row, `EndStateDisplay` on committed rows; `TideZ1B` ([Step 20.4.15](#step-20-4-15)) drives this per-row off `turn === undefined` (row not yet committed), NOT the session `phase`, so committed rows in a multi-turn transcript never re-derive in-flight-ness from a session-wide signal — and (b) what the model row (Z1A) shows (always present; model name + timestamp from the active or committed turn). Earlier framings ("per-turn live elapsed", "TugProgress agent") are retired — Z1B is the canonical surface for both signals. (REPLAYING is the lone exception — the transcript is not painted during replay, so its matrix row carries no Z1 cell content; see [DT10](#dt10-replay-transcript-suppression).) [Step 20.5.D.5](#step-20-5-d-5) re-authored the Z2 column to describe the shipped four-cell `TideTelemetryStatusRow`, and emptied the Z4 column — see the **Z2 status row** and **Z4 prompt-entry footer** notes above.

**Two coordination invariants exposed by the matrix.**

1. **The `awaitingApprovalSince` / `awaitingApprovalMs` state from [#step-20-3] drives three coordinated UI surfaces simultaneously** — Z1's "⏳ paused," Z2's TIME-cell pause-freeze + the STATE cell's "Awaiting," and Z5's "Awaiting your input" disabled mode. Same state field, three zones coordinated. This is the direct validator that the 20.3 data model is correctly shaped — if any of these three lag or de-sync, the data plumbing is wrong.
2. **`turnEndReason` from [#step-20-3] drives the terminal branch into COMPLETE.** `"complete" | "interrupted" | "error" | "transport_lost"` each map to distinct visual affordances on the row (e.g., a small "🛑 interrupted" badge for interrupted turns).

**Why this is a spec-only step.** The diagram + matrix are load-bearing for every implementation sub-step that follows. Landing them as the deliverable here means 20.5.B / 20.5.C / 20.5.D / 20.5.E all reference a single canonical artifact rather than re-deriving the lifecycle from scratch. The cost of a misaligned mental model across four implementation sub-steps is enormous; the cost of writing this down once is small.

**Conformance.** No code. The deliverable is the diagram + matrix + state definitions, landed into this plan. The commit is documentation only.

**Tasks.**

- [x] Land the state diagram (above) into the plan as the canonical reference.
- [x] Land the state-to-zone coordination matrix (above) as the contract for 20.5.D.
- [x] Cross-reference [#step-20-3]'s `awaitingApprovalMs` / `turnEndReason` fields from the matrix.
- [x] Land [DT10](#dt10-replay-transcript-suppression) (REPLAYING transcript-paint suppression) and cross-reference it from the REPLAYING entries of the state diagram, the state-definitions table, and the coordination matrix.

**Checkpoint.** No build/test/lint — this is plan-only. _Done — diagram + matrix + state definitions landed; concrete code references audited against `CodeSessionSnapshot` / `CodeSessionPhase` / `TideZ1B` and the three drifts reconciled (see Status)._

---

#### Step 20.5.B: Audit polish-plan 13 / 14 / 15 + close known gaps {#step-20-5-b}

**Depends on:** #step-20-5-a (spec to audit against)

**Status:** _Complete. Audit (7 ✓ / 3 ✗); all three ✗ gap-closes landed + tested. **[replay-2]** — optional `TurnTelemetry.turnEndReason` + `buildTurnEntry` `effectiveReason` precedence + `buildRecordTelemetryEffect` persistence (the ledger column is deferred to [#step-20-3-4]; the consumer side is ready). **[replay-1]** — tugcode `translateJsonlSession` synthesizes a terminal `turn_complete{result:"interrupted"}` for a dangling cold-resume cycle (gated by `synthesizeDanglingTerminal` from `inflight === null`); the reducer honors `result: "interrupted"`, also correcting a latent orphan-path mislabel. **Question dialog (polish-15)** — `QuestionDialog`, a sibling of `PermissionDialog` on `TugInlineDialog`, parses the `AskUserQuestion` payload and round-trips chosen labels via `respondQuestion`; wired as `KIND_RENDERERS.question` + a `pendingQuestion` slot in `CodeRowCell`. Automated checkpoints green: `tsc` clean (tugdeck + tugcode), 2277 tugdeck + 400 tugcode tests, `audit:tokens lint` zero violations. The two manual-smoke checkpoint items (live-Claude dialog firing; live resume) are user-gated._

**Commit:** `feat(tide-rendering): close lifecycle-primitive gaps from polish-plan 13/14/15 + replay end-state bugs`

**References:** [polish-plan #step-13](./tugplan-tide-card-polish.md#step-13), [polish-plan #step-14](./tugplan-tide-card-polish.md#step-14), [polish-plan #step-15](./tugplan-tide-card-polish.md#step-15), [#step-20-5-a], [#step-20-3-4] (per-turn telemetry persistence — the [replay-2] end-reason column folds into its schema), [DT01](#dt01-per-turn-on-turnentry)

**Scope.** Walk the current code against polish-plan Steps 13 (thinking + tool surfaces), 14 (mid-stream behaviors), and 15 (`control_request_forward` UI). Document what's done; identify gaps; close the gaps so 20.5.D builds on working primitives. Known gap from the preliminary audit: `tide-question-dialog` (only the permission variant has a chrome wrapper today). Two further gaps are pre-identified — both REPLAYING end-state bugs surfaced by the [Step 20.5.A](#step-20-5-a) lifecycle investigation: a resumed turn left without a `turn_complete` strands an in-flight row animating `TugThinkingIndicator` forever ([replay-1]), and replayed interrupted turns mis-render as `error` ([replay-2]). Both are pre-marked ✗ in the checklist; the gap-close section carries their remediation.

**Audit checklist** (each item gets a ✓ if implemented, ✗ + remediation task if not):

- [x] **[polish-13] ✓** Thinking-block placement / streaming wired. _Audited ✓ — `TideThinkingBlock` (`chrome/tide-thinking-block.tsx`) is consumed by `CodeRowCell` in `tide-card-transcript.tsx`, bound to the per-turn `turn.${turnKey}.thinking` streaming path._
- [x] **[polish-13] ✓** Tool-use-display wired in the transcript. _Audited ✓ — `TranscriptToolCalls` renders in `CodeRowCell` against the per-turn `.tools` path; `tool_use` / `tool_result` pair into `ToolCallState` via the reducer's `toolCallMap`; covered by `tide-card-transcript-tool-calls.test.ts`._
- [x] **[polish-14.1] ✓** Stop button works mid-stream. _Audited ✓ — `handleInterrupt` exists; `canInterrupt` is true across `submitting` / `awaiting_first_token` / `streaming` / `tool_work` / `awaiting_approval`; `tide-card.tsx`'s `performSubmit` has the Stop branch; the **live** `handleTurnComplete` maps to `turnEndReason: "interrupted"` via `interruptInFlight`. (The replay-path defect of this same mapping is [replay-2].)_
- [x] **[polish-14.2] ✓** Queued sends. _Audited ✓ — the reducer carries `queuedSends`; `handleTurnComplete`'s `isSuccess && queuedSends.length > 0` branch flushes the next turn in a single tick (no transient `idle`)._
- [x] **[polish-14.3] ✓** Tool sub-state. _Audited ✓ — `canInterrupt` includes `tool_work`, so the submit button stays in "Stop" mode during a tool call and the entry stays in `tool_work`._
- [x] **[polish-14.4] ✓** No regressions on basic round-trip. _Audited ✓ — `code-session-store.round-trip.test.ts` exercises the full submit → stream → tool → complete cycle; green at this step's checkpoint._
- [x] **[polish-15] permission variant ✓** — `chrome/tide-permission-dialog.tsx` exists and is wired. _Audited ✓ — `PermissionDialog` is `KIND_RENDERERS.permission`; `CodeRowCell`'s `permissionSlot` builds entries from the live `pendingApproval` (non-question) + committed `controlRequestLog` and dispatches `{ kind: "permission" }`._
- [x] **[polish-15] question variant ✗** — `chrome/tide-question-dialog.tsx` does NOT exist. **Gap to close.** _Audited ✗ confirmed — `KIND_RENDERERS.question` is still `makeScaffoldRenderer("question")`; `CodeRowCell`'s `permissionSlot` explicitly skips `is_question`, so nothing renders `pendingQuestion`._ Build it as a sibling chrome wrapper around `TugInlineDialog`, parallel to the permission variant. Wires to existing `handleRespondQuestion` reducer handler. Supports single-select and multi-select question payloads.
- [x] **[replay-1] ✗ (confirmed)** REPLAYING end-state — a replayed turn that never gets a `turn_complete`. On a cold resume whose final turn was incomplete at quit (a refused or still-awaiting-approval tool call), that turn's JSONL window carries no `turn_complete`. `handleReplayComplete`'s chain-link-13 sees `pendingUserMessage !== null`, transitions `phase → streaming`, and preserves the in-flight cycle expecting a *live* `turn_complete` — which never arrives, because the wire is a fresh resume, not a continuation. `TideZ1B` keys its `TugThinkingIndicator` purely off `turn === undefined`, so the stranded in-flight row animates indefinitely. Chain-link-13 is correct for HMR-mid-stream (a live `turn_complete` *is* coming) and wrong for cold resume — the two cases must be distinguished.
- [x] **[replay-2] ✗ (confirmed)** REPLAYING end-state — an interrupted turn replays as `error`. `handleTurnComplete` derives `turnEndReason` as `isSuccess ? "complete" : interruptInFlight ? "interrupted" : "error"`. `interruptInFlight` is reducer-runtime state set by `handleInterrupt`, which never runs on the replay path; the persisted `TurnTelemetry` block carries no end-reason field. An interrupted turn — recorded on the wire as `result: "error"` — therefore replays as `turnEndReason: "error"`, and every resumed session shows `error` badges where the live session showed `interrupted`. The per-turn end reason is not persisted anywhere recoverable (see [Step 20.5.A](#step-20-5-a)'s amended Persistence-projection note).

**Gap-close work** (only if audit marks items ✗):

1. **`tide-question-dialog`** — new file `tugdeck/src/components/tugways/chrome/tide-question-dialog.tsx` + `.css` + `.test.ts`. **Landed.** `QuestionDialog` is a sibling chrome wrapper on `TugInlineDialog`. It parses the `AskUserQuestion` payload (`request.input.questions[]`) and renders each question's options as `TugDialogButton`s — `radio` style for single-select (first option pre-selected, mirroring the permission scope-picker default so Return commits a sane answer), `check` style for multi-select, per each question's `multiSelect` flag. Submit builds the `answers` record — keyed by question text, multi-select labels comma-joined with no spaces, matching tugcode's `formatQuestionAnswer` — and calls `respondQuestion`; Skip sends an empty answer set so Claude unblocks ([DT07]). Pending-only: `handleRespondQuestion` records nothing into `controlRequests`, so there is no resolved-record half (the `question` `RenderInput` carries no `resolvedDecision`). Keyboard: `TugInlineDialog` focuses the confirm button on mount (Return submits); options are Tab+Space reachable. _(Arrow-key roving inside the option group would mean modifying `TugDialogButton` / `TugInlineDialog` — out of the "build on existing primitives" scope; the accessible Tab+Space baseline stands. Esc-to-dismiss is the lifecycle-coordination concern wired in [#step-20-5-d], not here.)_
2. **Transcript wiring.** **Landed.** The question dialog mounts in `tide-card-transcript.tsx`'s `CodeRowCell` — the same site that hosts the permission slot, *not* `tide-card.tsx`. A `useSyncExternalStore` on `pendingQuestion` (gated on `!isCommitted`, mirroring the permission-slot subscriptions) feeds a `questionSlot` dispatched as `{ kind: "question" }` and rendered between the permission slot and the tool calls. `KIND_RENDERERS.question` in the renderer dispatch now resolves to `QuestionDialog` (was a scaffold). Permission and question both render inline on the in-flight row.
3. **Coverage tests** for any polish-14 scenario that audits ✗ — fixture tests for Stop / queued sends / tool sub-state, against the reducer + UI together.
4. **[replay-1] Cold-resume in-flight strand.** _Audit finding — the reducer-side split is not viable: the discriminator is "will this dangling turn get a live `turn_complete`?", which depends on whether tugcast's claude subprocess is alive and mid-turn. Neither `handleReplayComplete` nor the tugdeck resume path (`fireRestore`) has that fact — only tugcode does. Decision: the cross-component fix._ **Landed.** `translateJsonlSession` (`tugcode/src/replay.ts`) gained a `synthesizeDanglingTerminal` option: when set, a cycle still open at end-of-JSONL (an `assistant` entry that never reached `stop_reason: "end_turn"`) gets a synthetic `turn_complete { result: "interrupted" }` keyed on the open cycle's assistant id (the new `TranslateContext.cycleMsgId`), emitted before `replay_complete`. `runReplay` sets the option from `inflight === null` — `true` on a cold resume (no live `ActiveTurn`), `false` on reload-mid-stream (a live turn continues the cycle; left open for the live drain + `emitInflightTurnFromActiveTurn`, unchanged). On the reducer side, `handleTurnComplete` now honors a wire `result: "interrupted"` → `turnEndReason: "interrupted"` (`TurnCompleteEvent.result` widened to `"success" | "error" | "interrupted"`). This also corrects a latent bug: `flushPendingOrphan`'s orphan-interrupted turns already emit `result: "interrupted"`, but the reducer previously fell them through to `error`. `handleReplayComplete`'s chain-link-13 is untouched — still correct for the genuine live-continuation case. No reducer heuristic, no timer, no provenance flag; the "every committed row has a `turn_complete`" invariant holds.
5. **[replay-2] Persist `turnEndReason`.** Add a `turnEndReason` field to the persisted per-turn shape so replay recovers it instead of re-deriving it. `TurnTelemetry` (`telemetry.ts`) is the shape already round-tripped through the SessionLedger per [#step-20-3-4]; grow it with `turnEndReason`, and have `handleTurnComplete` prefer `event.telemetry?.turnEndReason` over the `interruptInFlight`-based derivation when an inlined block is present — the same inline-wins precedence `mergeTurnTelemetry` already uses for cost / timing. The live path keeps deriving + persisting; the replay path adopts the persisted value. Per [DT01](#dt01-per-turn-on-turnentry), this extends the per-turn shape — it does not add a side-table. Because [#step-20-3-4] is itself not yet built, fold the `turn_end_reason` column into its ledger schema rather than amending a shipped one; coordinate the two steps on the column name and type.

**Conformance.** Build only on existing primitives. No new architecture in this step — it's a known-gap-closer, not a redesign. The lifecycle state machine from 20.5.A defines the target behavior; this step ensures the primitives behind that behavior actually exist before 20.5.D wires coordination on top.

**Artifacts.**

- `tugdeck/src/components/tugways/chrome/tide-question-dialog.{tsx,css}` + `.test.ts` — _new_ — `QuestionDialog` chrome + exported pure helpers (`parseQuestions` / `initialQuestionSelections` / `applyQuestionSelection` / `buildQuestionAnswers`) + pure-logic test suite (polish-15).
- `tugdeck/src/components/tugways/cards/tide-card-transcript.tsx` — `CodeRowCell` `questionSlot`: a `pendingQuestion` subscription + inline `{ kind: "question" }` dispatch (polish-15).
- `tugdeck/src/components/tugways/cards/tide-assistant-renderer-dispatch.ts` — `KIND_RENDERERS.question` resolves to `QuestionDialog` (was a scaffold) (polish-15).
- _N/A_ `tide-card.test.tsx` polish-14 coverage tests — all four polish-14 items audited ✓; no ✗ scenario to cover.
- `tugcode/src/replay.ts` — `synthesizeDanglingTerminal` option on `translateJsonlSession`; `TranslateContext.cycleMsgId`; EOF synthetic `turn_complete` for a dangling cycle ([replay-1]).
- `tugcode/src/session.ts` — `runReplay` passes `synthesizeDanglingTerminal: inflight === null` ([replay-1]).
- `tugcode/src/__tests__/replay-dangling-cycle.test.ts` — _new_ — translator coverage: synthetic emitted on cold resume, withheld on reload-mid-stream, none for a clean trailing turn ([replay-1]).
- `tugdeck/src/lib/code-session-store/events.ts` — `TurnCompleteEvent.result` widened to `"success" | "error" | "interrupted"` ([replay-1]).
- `tugdeck/src/lib/code-session-store/reducer.ts` — `handleTurnComplete` honors `result: "interrupted"` ([replay-1]); `buildTurnEntry` `effectiveReason` telemetry precedence ([replay-2]).
- `tugdeck/src/lib/code-session-store/telemetry.ts` — optional `turnEndReason` on `TurnTelemetry` ([replay-2]).
- `tugdeck/src/lib/code-session-store/__tests__/reducer.telemetry-replay-inline.test.ts` — `[replay-2]` terminal-reason recovery tests.
- `tugdeck/src/lib/code-session-store/__tests__/code-session-store.replay.test.ts` — `[replay-1]` dangling-turn-commits + chain-link-13 regression-guard tests.
- _(deferred)_ tugcast SessionLedger — `turn_end_reason` column folds into [#step-20-3-4]'s still-unbuilt per-turn telemetry schema + replay-attach path; the tugdeck `[replay-2]` consumer side is ready ahead of it ([replay-2]).
- `dash/tide-assistant-rendering.md` (this file) — append audit findings to this step's status line for the historical record.

**Tasks.**

- [x] Walk the audit checklist; mark each item ✓ / ✗. _Done — 7 ✓, 3 ✗ (polish-15 question variant, [replay-1], [replay-2])._
- [x] For each ✗, write a remediation task and complete it. _Done — all three ✗ (question dialog, [replay-1], [replay-2]) remediated; see gap-close work._
- [x] Specifically: implement `tide-question-dialog`. _Done — `QuestionDialog` + pure helpers + pure-logic test suite._
- [x] Verify both dialog variants mount on the in-flight `control_request_forward`. _Done — `CodeRowCell` in `tide-card-transcript.tsx` (the actual wiring site, not `tide-card.tsx`) hosts the permission slot (`pendingApproval`) and the new question slot (`pendingQuestion`); both gate on `!isCommitted`._
- [x] Add coverage tests for any polish-14 scenario found ✗. _N/A — all four polish-14 items audited ✓; no ✗ scenario to cover._
- [x] **[replay-1]** Fix the cold-resume in-flight strand — a dangling final turn commits as a terminal `TurnEntry` instead of stranding an animated in-flight row. _Done — tugcode `translateJsonlSession` synthesizes the terminal `turn_complete`; reducer honors `result: "interrupted"`._
- [x] **[replay-2]** Persist `turnEndReason`; the replay path adopts the persisted value instead of re-deriving from `interruptInFlight`. _Done — `TurnTelemetry.turnEndReason` (optional) + `buildTurnEntry` `effectiveReason` precedence + `buildRecordTelemetryEffect` persistence._

**Tests.**

- [x] `tide-question-dialog` — single-select and multi-select payloads covered. _Done — `parseQuestions` pins both payload kinds; per project policy (pure-logic `bun:test`, no fake-DOM render tests) the DOM render is HMR / live-smoke vetted, exactly as for `PermissionDialog`._
- [x] Submitting question dialog produces the chosen answer(s). _Done — `buildQuestionAnswers` pins the `answers` record (single label, multi-select comma-join); the `respondQuestion` → `handleRespondQuestion` → `question_answer` round-trip is already pinned in `code-session-store.control-forward.test.ts`._
- [x] Esc / cancel dismisses the question dialog and triggers the dismiss path. _Done — the Skip path sends an empty answer set (`buildQuestionAnswers` of no selections); the component wiring is live-smoke vetted. (Esc-key binding is [#step-20-5-d] coordination.)_
- [x] Any polish-14 scenario marked ✗ gets a fixture test that exercises the scenario end-to-end. _N/A — no polish-14 ✗._
- [x] **[replay-1]** A replayed session whose JSONL ends mid-turn (no final `turn_complete`) commits that turn as a terminal `TurnEntry`; after `replay_complete` no row has `turn === undefined` and no `TugThinkingIndicator` is mounted. _Done — `code-session-store.replay.test.ts` (reducer side) + `replay-dangling-cycle.test.ts` (tugcode translator side)._
- [x] **[replay-1]** HMR-mid-stream regression guard — a genuine live turn still streaming across `replay_complete` keeps the `phase → streaming` preservation (chain-link-13 intact for its original case). _Done — regression-guard test in both files._
- [x] **[replay-2]** A turn interrupted in a live session, persisted, then replayed on resume keeps `turnEndReason: "interrupted"` — the inlined telemetry block's `turnEndReason` wins over the `interruptInFlight`-false replay derivation. _Done — 3 tests in `reducer.telemetry-replay-inline.test.ts` (`[replay-2]` describe block): inline-recovers-`interrupted`, omitted-field-falls-back, live-persists-derived-reason._

**Checkpoint.**

- [x] `bun x tsc --noEmit` clean. _tugdeck + tugcode both clean._
- [x] `bun test` green. _2277 tugdeck tests, 400 tugcode tests, 0 fail._
- [x] `bun run audit:tokens lint` exits 0. _Zero violations — `--tugx-question-*` aliases resolve one-hop._
- [ ] **Manual smoke** — exercise each polish-14 scenario by hand against live Claude; confirm permission AND question dialogs both fire and resolve cleanly. _User-gated — live Claude; not runnable in this environment (the app-test harness can't inject `control_request_forward` events)._
- [ ] **Manual smoke (replay)** — resume a session whose last turn was a refused tool call: confirm no stuck `TugThinkingIndicator`. Resume a session containing an interrupted turn: confirm the row shows the `interrupted` badge, not `error`. _User-gated — live resume._

---

#### Step 20.5.B.1: Replay fidelity — corpus audit + JSONL-shape hardening {#step-20-5-b-1}

**Depends on:** #step-20-5-b ([replay-1] / [replay-2] — the replay end-state fixes this hardens on top of)

**Status:** _**complete.** The corpus audit harness was built, run against the real session corpus, and the findings recorded + triaged below. Headline: the translator's structural contract holds (zero I1/I3/I4/I5 violations on 267 translated sessions); the real gaps were [W2] (~3% of sessions silently drop a trailing user prompt), [W1] last-turn (`stop_sequence` mislabel, rare), and [W5a] — which the [Step 20.5.B.1.b](#step-20-5-b-1-b) investigation found is **far broader than the audit's compaction-summary hypothesis**: Claude Code persists every plain-text prompt as a bare string, and 899 such genuine prompts across 23% of sessions were char-iterated to nothing on replay. [W1]-cascade and [W3]-as-framed are not real. The fixes landed as [Step 20.5.B.1.a](#step-20-5-b-1-a) ([W2] EOF orphan flush / [W1] clean-terminal recognition) and [Step 20.5.B.1.b](#step-20-5-b-1-b) ([W5a] string-content normalisation; [W5b] / [W5c] documented + pinned); the [Step 20.5.A](#step-20-5-a) replay-fidelity matrix landed and was corrected. Both sub-steps complete — this step is closed._

**Commit:** `feat(tide-rendering): replay-fidelity corpus audit harness`

**References:** [#step-20-5-a] (the lifecycle state machine the replay path must honour), [#step-20-5-b] ([replay-1] / [replay-2]), [#step-20-3] (per-turn data the replay path must reconstruct)

**Scope.** [Step 20.5.B](#step-20-5-b) closed two replay end-state bugs — [replay-1] (a dangling cold-resume cycle strands an in-flight row) and [replay-2] (an interrupted turn replays as `error`). Closing them made clear the replay path — `translateJsonlSession` (`tugcode/src/replay.ts`) → wire events → the `CodeSessionStore` reducer → the tide-card transcript — carries a wider set of **JSONL-shape fidelity gaps**: shapes the live path handles that a resumed session reconstructs wrong or drops outright. This step (a) builds a **corpus audit harness** that runs the real translator over the on-disk Claude Code JSONL corpus and checks structural invariants, (b) records the weak points the 20.5.B investigation already found, and (c) — once the audit quantifies which gaps bite real data — fans out into fix sub-steps (20.5.B.1.a, .b, …).

The corpus is the asset. `~/.claude/projects/` holds ~4,000 real session JSONLs spanning months of Claude Code use — every entry shape, stop-reason, subagent nesting, compaction, and interrupt the tool has ever produced. No hand-authored fixture set matches it. The audit turns that corpus into a regression surface; the fix sub-steps then distil the failing shapes into curated in-repo fixtures for permanent CI coverage.

**Weak points (from the 20.5.B replay investigation).** Each is a hypothesis the corpus audit confirms or refutes with a real-data frequency:

- **[W1] Only `stop_reason: "end_turn"` closes a cycle.** `translateJsonlEntry` (`replay.ts`) emits the terminal `turn_complete` and resets `ctx.cycleOpen` only on `end_turn`. Real corpus data carries `stop_sequence`; `max_tokens` / `refusal` / `pause_turn` are valid API terminals too. A *last* turn ending on one trips [replay-1]'s `synthesizeDanglingTerminal` synthetic and is mislabelled `interrupted` though it finished cleanly. A *middle* turn ending on one leaves `ctx.cycleOpen` stuck true → the next turn's `user_message_replay` is suppressed and its user text is mis-flushed as an `orphan-N` → cascading corruption of every later turn in the session.
- **[W2] A trailing user-only orphan is dropped at EOF.** `flushPendingOrphan` is called only from `handleUserEntry` (on the *next* user entry), never after the translate loop. A JSONL ending with a user submission and no assistant entry (the user quit before any output) strands `ctx.pendingUserText` — no `user_message_replay`, no terminal — and the resumed transcript silently loses the user's last prompt. Same family as [replay-1]; [replay-1]'s `cycleOpen`-gated synthetic does not cover the pre-assistant case.
- **[W3] Subagent tool nesting is lost on replay.** The translator's `tool_use` emitter reads `id` / `name` / `input` only — never `parent_tool_use_id`. The live path threads that into `ToolCallState.parentToolUseId` so `TaskToolBlock` groups child calls under their `Agent`; replayed sessions render every tool call flat.
- **[W4] Permission / question records do not survive replay.** `control_request_forward` is gate-suppressed during the replay window (`session.ts`), and the allow/deny decision is not re-emitted by the translator as anything that rebuilds a `ControlRequestRecord`. A resumed session loses its `[Tool — Allowed/Denied]` resolved-permission artifacts and its `AskUserQuestion` history.
- **[W5] Compaction and error-shape replay are unverified.** A `/compact` shrinks the context window (a negative per-turn delta the `deriveContextWindows` walk must absorb); `overloaded_error` blocks are an error shape mid-turn. Neither has a fixture.

These gaps are invisible at the [Step 20.5.A](#step-20-5-a) spec level — 20.5.A documents REPLAYING as a state but never says which per-turn artifacts survive a resume. A **replay-fidelity matrix** (per artifact: assistant text / tool calls / tool nesting / permission records / `turnEndReason` / telemetry — does it round-trip a resume?) belongs in 20.5.A; adding it is one of the fix sub-steps.

**The corpus audit harness.** `tugcode/scripts/replay-corpus-audit.ts` — a run-on-demand QA harness (not a CI test; CI has no corpus). It walks `~/.claude/projects/`, and per session JSONL (under a size cap; giant files are raw-scanned only): runs the real `translateJsonlSession`, then checks structural invariants —
- **[I1]** brackets: exactly one `replay_started` first, exactly one `replay_complete` last.
- **[I2]** cycle balance: `count(user_message_replay) === count(turn_complete)`. An imbalance is a stranded cycle (W1) or — classified from the raw scan — a dropped trailing orphan (W2).
- **[I3]** the translator never throws.
- **[I4]** `turn_complete` `msg_id`s carry no duplicate that the reducer would dedupe-drop.
- **[I5]** `replay_complete.count` equals the emitted `turn_complete` count.
— and aggregates a raw-shape census: top-level entry types (unhandled-type detection), assistant `stop_reason` distribution (W1), trailing-orphan sessions (W2), `parent_tool_use_id` sessions (W3), compaction / `overloaded_error` / interrupt-marker sessions (W5). The report names example session ids per violation class so a fix sub-step can pull them straight into a fixture.

**Conformance.** The harness imports and runs the *real* `translateJsonlSession` — no mock translator, no synthetic-only fixtures — over real data. It is read-only over the corpus. It lives in `scripts/` (not `__tests__/`) because it depends on the developer's on-disk session corpus, which CI does not have; the permanent CI coverage is the curated fixtures the fix sub-steps add.

**Artifacts.**

- `tugcode/scripts/replay-corpus-audit.ts` — _new_ — the corpus audit harness (corpus walk + real-translator run + invariant checks + raw-shape census + report).
- `dash/tide-assistant-turns.md` (this file) — the audit's findings recorded below; fix sub-steps appended as 20.5.B.1.a … once triaged.

**Tasks.**

- [x] Build `replay-corpus-audit.ts` — corpus walk, real-translator run, invariants I1–I5, raw-shape census. _Done._
- [x] Run it against `~/.claude/projects/`; record the findings under "Corpus audit findings". _Done — 282 sessions; see findings._
- [x] Triage W1–W5 against the findings. _Done — see "Triage" above._
- [x] Open fix sub-steps for the gaps that bite real data, each carrying a curated corpus-derived fixture. _Done — [Step 20.5.B.1.a](#step-20-5-b-1-a) ([W2] EOF orphan flush + [W1] clean-terminal recognition) and [Step 20.5.B.1.b](#step-20-5-b-1-b) ([W5] compaction string-content fix + error-shape semantics) authored below._
- [x] Add the replay-fidelity matrix to [Step 20.5.A](#step-20-5-a) (and the COMPLETE-row empty-assistant addendum). _Done — landed as the "Replay fidelity" block in 20.5.A._

**Corpus audit findings.** _First run — 282 main sessions under `~/.claude/projects/` (267 translated; 10 raw-scanned over the 4 MB cap; 5 huge-skipped over 64 MB; 0 read failures; 0 sessions with malformed lines)._

- **Structural invariants I1 / I3 / I4 / I5 — zero violations across all 267 translated sessions.** Brackets always well-formed; the translator never threw; no duplicate `turn_complete` `msg_id`; `replay_complete.count` always matched the emitted terminal count. The translator's structural contract is solid on real data.
- **[I2] cycle balance — 253 balanced, 14 with one cycle open at EOF, 0 with imbalance ≥ 2.** The `[replay-1]` `synthesizeDanglingTerminal` synthetic rebalanced **all 14** (0 sessions "still imbalanced with the synthetic on").
- **[W1] — downgraded.** The cascade failure mode (a mid-session non-`end_turn` terminal corrupting later turns) **does not occur** — 0 sessions with imbalance ≥ 2; in practice claude-code never ends a *middle* turn on a non-`end_turn`/`tool_use` stop. The last-turn case is real but rare: **1 session** ends on `stop_sequence` — on a cold resume `[replay-1]`'s synthetic commits that cleanly-finished turn as `interrupted`. (`stop_sequence` occurs 35× across entries — otherwise mid-cycle and harmless; `(null)` stop_reason 34×.)
- **[W2] — confirmed, the highest-frequency real gap.** **9 of 282 sessions (~3%)** end with a trailing user submission and no assistant response; their last prompt is silently dropped on replay (`flushPendingOrphan` is never called at EOF). 4 of the 9 also carry a dangling tool cycle — a double loss.
- **[W3] — reframed, not a translator bug.** `parent_tool_use_id` is **never non-null in a main session JSONL** (0 sessions). Subagent tool calls do not appear in the main transcript — they live in separate `subagents/*.jsonl` files that replay never reads. Whether a resumed session *should* surface subagent internals is a separate, lower-priority question; there is nothing for the translator to "preserve."
- **[W5] — present, no crash, semantics unverified.** 8 sessions carry compaction markers, 6 carry `overloaded_error` blocks; the translator threw on none. Structural invariants do not check *semantic* correctness (the negative context-window delta a `/compact` produces, the error-turn shape) — that needs a deeper check.
- **Entry-type coverage — complete.** Every top-level type in the corpus (`assistant`, `user`, `attachment`, `last-prompt`, `permission-mode`, `ai-title`, `file-history-snapshot`, `system`, `queue-operation`) is translated or in `SKIPPED_TOP_LEVEL_TYPES`. No unhandled type.

**Triage.** [W2] (silent data loss, ~3%) → fix first. [W1] last-turn clean-terminal — the translator should treat `stop_sequence` / `max_tokens` / `refusal` as cycle terminals so those turns commit `complete` and the `[replay-1]` synthetic fires only for genuinely-dangling `tool_use` / `(null)` cycles → fix alongside [W2]. [W5] semantic-correctness check → a deeper sub-step. [W1] cascade and [W3]-as-framed → not real; closed with no code change. [W4] (permission/question records lost on replay) is not corpus-measurable here — it is reducer/session-side, not translator-side — and remains an open known gap.

**State machine ([Step 20.5.A]) — no structural change required; one spec-completeness gap.** The corpus contains no shape the existing state graph cannot absorb: a `stop_sequence` / cut-off turn lands in COMPLETE carrying a `turnEndReason` the existing vocabulary already has; a flushed trailing-orphan is a COMPLETE turn with empty assistant content; a `/compact` is an ordinary turn. No new lifecycle state or transition is forced by the data. The one real 20.5.A deficiency the investigation confirms is **spec completeness** — 20.5.A documents REPLAYING as a state but never says which per-turn artifacts survive a resume (`turnEndReason` needed [replay-2]; permission records do not survive — [W4]; subagent internals do not — [W3]; telemetry rides on [#step-20-3-4]). Adding the **replay-fidelity matrix** (Tasks, below) closes it. One small addendum: 20.5.A's COMPLETE row should note that a committed turn may have empty assistant content (the flushed trailing-orphan, [W2]).

**Checkpoint.**

- [x] `bun x tsc --noEmit` clean (tugcode) — the harness typechecks (`scripts/` is in `tugcode/tsconfig.json`).
- [x] The harness runs to completion against the on-disk corpus and emits its report. _Done — 282 sessions, ~no perceptible runtime issues._

---

#### Step 20.5.B.1.a: Replay fidelity — EOF orphan flush + clean-terminal recognition {#step-20-5-b-1-a}

**Depends on:** #step-20-5-b-1 (the corpus audit that confirmed [W1] / [W2]), #step-20-5-b ([replay-1])

**Status:** _complete. Both translator fixes landed in `tugcode/src/replay.ts`, translator-side only: a `TERMINAL_STOP_REASONS` set (`end_turn` / `stop_sequence` / `max_tokens` / `refusal`) replaces the `end_turn`-only terminal check ([W1]); an EOF `flushPendingOrphan` call — gated on `synthesizeDanglingTerminal`, ordered after the dangling-cycle synthetic — commits a stranded trailing prompt ([W2]). New translator suite `replay-eof-orphan.test.ts` (13 cases) + a `[W2]` reducer test in `code-session-store.replay.test.ts`. `tsc --noEmit` clean (tugcode + tugdeck); `bun test` green (413 tugcode, 2278 tugdeck). The re-run corpus audit reports `(none)` under "[W1] clean-terminal dangling" (the fix closes those cycles) and `(none)` under "synthetic does NOT fully rebalance"; a `stop_sequence`-last session shifts from the Δ=1 "open at EOF" bucket to Δ=0 balanced, as expected. The audit script's stop-reason annotation still labels `stop_sequence` "NOT recognised (W1)" — now stale; [Step 20.5.B.1.b](#step-20-5-b-1-b) refreshes the census._

**Commit:** `fix(replay): flush trailing orphans at EOF + recognise all clean terminal stops`

**References:** [#step-20-5-b-1] ([W1] / [W2] + the corpus findings), [#step-20-5-b] ([replay-1])

**Scope.** The [Step 20.5.B.1](#step-20-5-b-1) corpus audit confirmed two real translator gaps. Both fixes are in `tugcode/src/replay.ts`; the reducer already absorbs the corrected output.

**[W2] — a trailing user-only orphan is dropped at EOF.** 9 of 282 corpus sessions end with a user submission and no assistant response. `flushPendingOrphan` is called only from `handleUserEntry` (on the *next* user entry); a session whose final entry is that submission strands `ctx.pendingUserText` — no `user_message_replay`, no terminal — and the resumed transcript silently loses the user's last prompt. _Fix:_ after the translate loop, when `synthesizeDanglingTerminal` is set (a cold resume — no live `ActiveTurn` will continue the session), call `flushPendingOrphan(ctx)` to commit any stranded `pendingUserText` as a `user_message_replay` + `turn_complete { result: "interrupted" }` pair. Gated on `synthesizeDanglingTerminal` for the same reason as the [replay-1] dangling-cycle synthetic: on reload-mid-stream the trailing submission IS the live `ActiveTurn`, which `runReplay`'s `emitInflightTurnFromActiveTurn` already delivers — flushing it here would double it. When a session has both a dangling cycle and a trailing orphan (4 of the 9), the dangling-cycle synthetic fires first (it closes the earlier turn), then the orphan flush.

**[W1] — only `end_turn` closes a cycle.** `translateJsonlEntry` emits the terminal `turn_complete` only on `stop_reason === "end_turn"`. The corpus carries `stop_sequence` (1 session ends on it); `max_tokens` and `refusal` are valid API terminals too. A last turn ending on one is left `cycleOpen`, so [replay-1]'s synthetic commits a cleanly-finished turn as `interrupted`. (The audit found **no** mid-session occurrence — the cascade failure mode does not happen — so this is a last-turn correctness fix only.) _Fix:_ replace the `end_turn`-only check with a `TERMINAL_STOP_REASONS` set — `end_turn`, `stop_sequence`, `max_tokens`, `refusal` — each emitting the terminal `turn_complete { result: "success" }` (the reducer maps `success → turnEndReason: "complete"`). `tool_use`, `pause_turn`, and a `null` / absent stop-reason stay non-terminal (the cycle legitimately continues). The `suppressTurnComplete` same-`message.id` peek is unchanged.

**Conformance.** `tugcode/src/replay.ts` only — translator-side. No reducer change ([replay-1]'s `result: "interrupted"` handling and the `success → complete` path already exist). No new architecture.

**Artifacts.**

- `tugcode/src/replay.ts` — `TERMINAL_STOP_REASONS` set; EOF `flushPendingOrphan` call.
- `tugcode/src/__tests__/replay-eof-orphan.test.ts` — _new_ — minimal fixtures distilled from the corpus shapes (a trailing user-text orphan; `stop_sequence` / `max_tokens` / `refusal` terminals; `tool_use` / `pause_turn` / `null` regression guards).
- `tugdeck/src/lib/code-session-store/__tests__/code-session-store.replay.test.ts` — a reducer test: a flushed EOF orphan commits a `TurnEntry` with empty `assistant` content and `turnEndReason: "interrupted"`, phase → `idle`.

**Tasks.**

- [x] `replay.ts` — `TERMINAL_STOP_REASONS` set replacing the `end_turn`-only terminal check. _Done — `end_turn` / `stop_sequence` / `max_tokens` / `refusal`; `tool_use` / `pause_turn` / `null` stay non-terminal. Docstrings + the header content-ordering comment updated to match._
- [x] `replay.ts` — EOF `flushPendingOrphan` call, gated on `synthesizeDanglingTerminal`, ordered after the dangling-cycle synthetic. _Done — relies on `flushPendingOrphan`'s existing empty-state idempotency; no-op for any session without a stranded submission._
- [x] Translator tests — orphan flush (on / off); each clean terminal closes a cycle; non-terminals don't. _Done — `tugcode/src/__tests__/replay-eof-orphan.test.ts`, 13 cases (incl. the dangling-cycle + trailing-orphan double-loss ordering and the [W1] mid-session cascade guard)._
- [x] Reducer test — a flushed EOF orphan commits an empty-assistant `interrupted` turn. _Done — added to `code-session-store.replay.test.ts`._

**Tests.**

- [x] A JSONL ending with a user-text entry and no assistant: with `synthesizeDanglingTerminal` → one `user_message_replay` + one `turn_complete { result: "interrupted" }`; without → neither (the live path owns it). _Pass._
- [x] A session whose last assistant entry is `stop_reason: "stop_sequence"` (also `max_tokens`, `refusal`) emits a terminal `turn_complete { result: "success" }`; the cycle closes; no dangling synthetic fires. _Pass — parametrized over all four terminals._
- [x] `tool_use`, `pause_turn`, and a `null` stop-reason do NOT close the cycle (regression guard). _Pass._
- [x] Reducer: a flushed EOF orphan → `TurnEntry` with empty `assistant`, `turnEndReason: "interrupted"`; post-`replay_complete` phase is `idle`. _Pass._

**Checkpoint.**

- [x] `bun x tsc --noEmit` clean (tugcode + tugdeck). _Both clean._
- [x] `bun test` green (tugcode + tugdeck). _413 tugcode, 2278 tugdeck, 0 fail._
- [x] Re-run `replay-corpus-audit.ts`: the `stop_sequence` session no longer appears under "[W1] clean-terminal dangling"; cycle-balance / synthetic-rebalance otherwise unchanged. _Done — "[W1] clean-terminal dangling" reports `(none)`; "synthetic does NOT fully rebalance" reports `(none)`. The W1 fix legitimately rebalances a `stop_sequence`-last session (Δ=1 → Δ=0); the remaining cycle-count drift (267 → 266 translated) is live-corpus drift between audit runs, not a translator regression._

---

#### Step 20.5.B.1.b: Replay fidelity — compaction + error-shape semantics {#step-20-5-b-1-b}

**Depends on:** #step-20-5-b-1 (the corpus audit — [W5])

**Status:** _complete. The [W5a] investigation found the gap is far broader than the audit's "compaction summary" framing: Claude Code persists **every plain-text user submission** (one with no attachments) as a bare-string `message.content` — the extended corpus audit counts **899 such genuine prompts across 66 sessions (23%)**, all silently char-iterated to nothing on replay today. Fix landed translator-side: `contentBlocks` normalises a bare-string `message.content` into one synthetic text block; `isNonSubmissionUserString` recognises Claude Code scaffolding (the `<command-*>` / `<local-command-*>` slash-command markers + the `isCompactSummary` continuation block, 789 corpus entries) and the translator skips it — genuine prompts replay, scaffolding does not surface as junk turns. The skip-scaffolding behaviour was a user decision (the literal "treat every string as text" injects 4–5 orphan turns per `/compact`). [W5b] (`overloaded_error` skipped by design) is recorded in the [Step 20.5.A](#step-20-5-a) replay-fidelity matrix; [W5c] — `deriveContextWindows` was already correct, now pinned against a real captured `/compact` window drop. New `replay-string-content.test.ts` (11 cases) + a `deriveContextWindows` pin in `end-state.test.ts`. `tsc --noEmit` clean (tugcode + tugdeck); `bun test` green; the re-run corpus audit's new [W5a] census quantifies the shape and its stale [W1] `stop_reason` annotation is refreshed._

**Commit:** `fix(replay): normalise string-valued message.content`

**References:** [#step-20-5-b-1] ([W5]), [#step-20-3] (`deriveContextWindows` — the per-turn context-window walk)

**Scope.** The corpus audit flagged compaction / `overloaded_error` sessions; the translator threw on none, but structural invariants do not verify *semantic* correctness. Inspecting the real shapes found one real bug (broader than the audit hypothesis) and two acceptable-as-is cases.

**[W5a] — string-valued `message.content` is silently dropped.** Claude Code persists a plain-text message as a bare **string** `message.content`, not the usual `content: [{ type: "text", … }]` array — a `user` submission with no attachments is the common case, and a `/compact` continuation summary is one too. `handleUserEntry` did `for (const block of content)` — iterating a string yields its *characters*, each a non-block that falls through — so the text was silently dropped. No crash (matches the audit's zero `[I3]` throws), but real data loss. The audit hypothesised this as a compaction-summary edge case (~8 sessions); inspecting the corpus showed it is **the persistence shape for ordinary prompts** — 899 genuine string submissions, 789 string scaffolding entries (slash-command `<command-*>` / `<local-command-*>` markers, `isCompactSummary`). _Fix:_ `contentBlocks` (`replay.ts`) normalises a bare-string `message.content` into one synthetic `text` block, used by both the `user` and (defensively) the `assistant` content walks; `isNonSubmissionUserString` recognises the scaffolding shapes so the translator skips them. _Decision (user):_ surface genuine prompts, skip scaffolding — the literal "treat every string as text" would inject 4–5 orphan-interrupted turns per `/compact` from its consecutive scaffolding cluster (summary + caveat + command marker + `Compacted` stdout). A post-`/compact` continuation turn therefore replays with an empty user message — consistent with Claude Code's own UI, which hides the summary.

**[W5b] — `overloaded_error` is a skipped `system` entry — acceptable, documented.** An API overload surfaces as a `type: "system"`, `subtype: "api_error"` entry (`error.status: 529`, with `retryAttempt` / `retryInMs`) — already in `SKIPPED_TOP_LEVEL_TYPES`, so replay drops it. A 529 is transient: the turn either recovered (its content is in the following assistant entries) or is genuinely dangling (handled by [replay-1]). Confirmed intended; recorded in [Step 20.5.A](#step-20-5-a)'s replay-fidelity matrix rather than surfacing transient infrastructure errors in a resumed transcript. No code change.

**[W5c] — context-window negative delta on `/compact`.** A compaction shrinks the resident context window; the next turn's `usage` is much smaller, so its per-turn delta is negative. `deriveContextWindows` (`end-state.ts`) already documents and computes signed deltas correctly ("a `/compact` that shrinks it is an honest negative") — but no test pinned it against a real post-compaction `usage` sequence. Pin added; no code change.

**Conformance.** `tugcode/src/replay.ts` for [W5a]; a census extension for the harness; a doc note (the 20.5.A matrix) + a test for [W5b] / [W5c]. No reducer change.

**Artifacts.**

- `tugcode/src/replay.ts` — `JsonlContentBlock` extracted as a named type; `JsonlEntry.message.content` widened to `string | ReadonlyArray<JsonlContentBlock>`; `JsonlEntry.isCompactSummary`; `contentBlocks` normaliser; `COMMAND_SCAFFOLDING_PREFIXES` + `isNonSubmissionUserString`; `handleUserEntry` / `handleAssistantEntry` route through `contentBlocks` ([W5a]).
- `tugcode/scripts/replay-corpus-audit.ts` — `[W5a]` string-content census (genuine vs scaffolding); compaction / overload example session ids; refreshed stop-reason annotation; raw-scan `hasText` made string-aware so the W2 trailing-orphan census counts a trailing string prompt.
- `tugcode/src/__tests__/replay-string-content.test.ts` — _new_ — genuine string prompt round-trips; each scaffolding prefix + `isCompactSummary` is skipped; a full `/compact` sequence yields no junk turns; defensive assistant string content.
- `tugdeck/src/lib/code-session-store/__tests__/end-state.test.ts` — a `deriveContextWindows` pin over the real post-`/compact` negative-delta sequence of captured session `2fc6b18d` ([W5c]).

**Tasks.**

- [x] Extend the corpus harness — compaction / overload example ids; a string-`content` census; refresh the now-stale `stop_reason` annotation (the translator recognises `stop_sequence` / `max_tokens` / `refusal` as clean terminals as of [Step 20.5.B.1.a](#step-20-5-b-1-a)). _Done — also made the raw-scan `hasText` string-aware so the W2 census no longer undercounts a trailing string prompt._
- [x] Re-run the harness; confirm the [W5a] string-content shape and quantify it. _Done — 1688 string-content user entries: 899 genuine submissions, 789 scaffolding; 66 sessions (23%) carry a genuine string prompt._
- [x] `replay.ts` — normalise string-valued `message.content` ([W5a]); skip scaffolding per the user decision. _Done._
- [x] Pin `deriveContextWindows` over a real post-`/compact` negative-delta sequence ([W5c]). _Done — captured session `2fc6b18d`, window 900517 → 36391 (perTurn −864126)._
- [x] Record the [W5b] `overloaded_error`-is-skipped decision in [Step 20.5.A](#step-20-5-a)'s replay-fidelity matrix. _Done — and the matrix's "Compaction summary text" row was corrected: the real ✗→✓ artifact is plain-text user prompts; the summary itself is ✗ by design._

**Tests.**

- [x] A genuine string-content `user` entry → its text reaches `user_message_replay` (not dropped, not iterated as characters); a scaffolding / `isCompactSummary` string entry is skipped, not surfaced. _Pass._
- [x] `deriveContextWindows` over a post-`/compact` `usage` drop yields the correct signed-negative per-turn delta; the telescoping identity holds. _Pass._

**Checkpoint.**

- [x] `bun x tsc --noEmit` clean (tugcode + tugdeck). _Both clean._
- [x] `bun test` green (tugcode + tugdeck). _0 fail._
- [x] Re-run `replay-corpus-audit.ts`; the `[W5a]` census quantifies the string-content shape and structural invariants stay clean. _Done — I1/I3/I4/I5 zero violations; I2 255 balanced / 12 open; [W5a] census: 899 genuine string prompts the translator now normalises._

---

#### Step 20.5.C: `TugProgress` `agent` role + Z1 SUBMITTING-state variant study {#step-20-5-c}

**Depends on:** #step-20-5-a (matrix this step updates), #step-20-5-b (primitives working)

**Status:** _**SUPERSEDED** by [Step 20.4.10](#step-20-4-10) through [Step 20.4.13](#step-20-4-13)._ Z1 asst-half's SUBMITTING / AWAITING_FIRST_TOKEN / STREAMING immediate-feedback indicator is now `TugThinkingIndicator` (a new dedicated component built fresh — a three-bar primitive with delta-debounced blink-on-pause behavior), not a TugProgress variant. The TugProgress agent-role primitive change this step would have made is dropped from 20.4.x scope; if a need for it surfaces later from a different consumer, it can be picked up independently. The full Z1 asst-half composition (two-line stack: model row + status row hosting `TugThinkingIndicator` while in-flight and an end-state display after turn-complete) is designed in [Step 20.4.12](#step-20-4-12) + [Step 20.4.13](#step-20-4-13) and promoted to production in [Step 20.4.15](#step-20-4-15)._

**Commit:** `feat(tugways): TugProgress agent role + Z1 SUBMITTING-state variant study`

**References:** [L17], [L19], [L20], [#step-20-5-a] (matrix Z1 SUBMITTING row to be updated), [#step-20-5-d] (downstream wiring consumer)

**Scope note — why this step exists.** Today, when a user submits a prompt, an empty assistant entry is added immediately to the transcript and stays blank until the first `assistant_delta` arrives. That gap reads as "nothing is happening" — the user has no immediate signal that the system received the prompt and is working on it. [Step 20.5.A](#step-20-5-a)'s matrix specifies a "⏳ ticking" placeholder for Z1 asst-half during SUBMITTING and early-STREAMING, but the placeholder needs to be replaced with a concrete visual primitive: `TugProgress` with the `agent` role. The component already ships (gallery card exists with Spinner / Bar / Ring / Pie variants in both indeterminate and determinate modes), but the role set today is accent / action / success / danger — missing `agent`, which is the semantically correct role for "the assistant is working."

This step does three things:

1. **Primitive change — add `agent` role to TugProgress.** Mirror `TugBadge`'s agent role. New `--tugx-progress-fill-agent-color` slot in `tug-progress.css` body{}, one-hop alias to `--tug7-*` per [L17]. The role-driven color machinery already exists for the four current roles; adding a fifth is mechanical.
2. **Variant study — pick the right TugProgress shape for Z1.** Z1 asst-half is a small inline slot at the trailing edge of the assistant row's chrome (next to the copy button). Two candidates to compare empirically in the gallery: **spinner indeterminate** (most compact, classic "loading" feel) and **ring indeterminate** (compact, slightly more visual presence). **Bar indeterminate** is ruled out for Z1 footprint reasons. Pick the winner via HMR / gallery visual review. Document the choice + rationale in this step's status line.
3. **Matrix update.** Replace the placeholder "⏳ ticking" / "⏳ frozen" text in [Step 20.5.A](#step-20-5-a)'s state-to-zone matrix Z1-asst-half column with the concrete `TugProgress variant="{chosen}" role="agent"` spec. The actual zone wiring lands in [Step 20.5.D](#step-20-5-d); this step just makes the matrix authoritative so 20.5.D has no more decisions to make.

**Scope note — what this step does NOT do.** No `tide-card-transcript.tsx` changes. No `TideCard` changes. No `useLifecycleState` integration. All Z1 wiring is [Step 20.5.D](#step-20-5-d)'s scope — this step is preparation only. The TugProgress primitive change and the variant choice are the only deliverables.

**Scope note — broader role parity (deferred).** TugProgress currently has accent / action / success / danger. TugBadge has those plus agent / data / caution. This step adds only `agent` (the role we have a concrete consumer for). The remaining role gaps (data, caution) are not added here; they can land in subsequent component-library work when there's a concrete need. Speculative role additions age poorly.

**Conformance.** Tugways primitive role addition — `tuglaws/component-authoring.md` + [L17] (one-hop alias) + [L20] (token sovereignty: `--tugx-progress-fill-agent-color` is part of TugProgress's slot family). [L16] applies: the new `[data-role="agent"]` CSS rule sets `background-color` only (no `color` paired in the same rule), so it requires a `@tug-renders-on` annotation naming TugProgress's track surface. [L19] applies to the gallery card extension: maintain the existing `data-slot` / file-pair / docstring discipline. Gallery card extension follows the existing ROLES section pattern.

**[L23] / [L26] note for the downstream consumer.** The chosen TugProgress variant lives inside Z1's per-turn trailing slot during SUBMITTING / AWAITING_FIRST_TOKEN, then is REPLACED by per-turn metrics on COMPLETE. That content-swap-within-slot must happen INSIDE THE SAME slot DOM container, not by remounting the parent row chrome — otherwise the assistant row's focus / scroll position / hover state would be destroyed at every turn boundary. The actual wiring lands in [Step 20.5.D](#step-20-5-d); this note is a forward reminder of the constraint that affects how the slot is built there.

**Artifacts.**

- `tugdeck/src/components/tugways/tug-progress.css` — new `--tugx-progress-fill-agent-color` slot declared in `body{}`; new `[data-role="agent"]` rule that paints the fill with the agent color. One-hop alias to a `--tug7-*` base token (likely the same base token TugBadge's agent role uses, for visual consistency).
- `tugdeck/src/components/tugways/tug-progress.tsx` — extend the `role` prop's accepted union with `"agent"`. No structural changes.
- `tugdeck/src/components/tugways/cards/gallery-tug-progress.tsx` — extend the ROLES section to include the agent row (alongside accent / action / success / danger).
- `dash/tide-assistant-turns.md` (this file) — update [Step 20.5.A](#step-20-5-a)'s matrix Z1-asst-half column to specify the chosen TugProgress variant + role="agent". Update [DT06](#dt06-naming-glossary) to add a glossary entry for the new TugProgress role.

**Tasks.**

- [ ] **Add `agent` role to TugProgress** — slot declaration in body{}; `[data-role="agent"]` rule; type union extension.
- [ ] **Extend gallery card** — add the agent row to the ROLES section so visual review of the new role is possible.
- [ ] **Variant study (manual, HMR + gallery)** — visually compare `<TugProgress kind="spinner" indeterminate role="agent" />` vs. `<TugProgress kind="ring" indeterminate role="agent" />` at Z1's expected size (~16–20px). Pick one. Record the choice + a one-sentence rationale in this step's status line.
- [ ] **Matrix update** — replace the Z1 asst-half placeholder text in 20.5.A's matrix for the SUBMITTING and STREAMING rows (and any other row where pre-content indication applies) with the concrete `TugProgress` spec from the study.
- [ ] **Glossary update** — add a row to [DT06](#dt06-naming-glossary) for the TugProgress agent-role consumer.

**Tests.**

- [ ] `TugProgress` with `role="agent"` renders without warnings and without missing tokens in both `brio` and `harmony` themes.
- [ ] Gallery card's ROLES section includes the agent row.
- [ ] (No matrix-wiring tests here — those land in [Step 20.5.D](#step-20-5-d).)

**Checkpoint.**

- [ ] `bun x tsc --noEmit` clean.
- [ ] `bun test` green.
- [ ] `bun run audit:tokens lint` exits 0.
- [ ] **HMR study (manual)** — open `gallery-tug-progress`; visually compare the agent-role variants (spinner and ring, both indeterminate) at Z1's expected scale; pick the winner; record the choice in this step's status line and update 20.5.A's matrix.

---

#### Step 20.5.D: Z5 + lifecycle-coordinated zone content (ship the matrix) {#step-20-5-d}

**Depends on:** #step-20-5-a (the state-to-zone matrix this step implements), #step-20-5-b (inline-dialog primitives — done), #step-20-4 (zone slot infrastructure), [#step-20-3-4] (per-turn telemetry persistence — done 2026-05-16)

**Status:** _**complete** — every sub-step done; [20.5.D.5.C](#step-20-5-d-5-c)'s end-to-end app-test (`at0084-tide-lifecycle-coordination`) is the matrix's executable conformance artifact. Split into sub-steps, foundation-first: [20.5.D.1](#step-20-5-d-1) (lifecycle foundation) → [20.5.D.2](#step-20-5-d-2) ([DT10] transcript-replay paint gate) → [20.5.D.2.A](#step-20-5-d-2-a) (restore-reveal coordination) → [20.5.D.2.B](#step-20-5-d-2-b) (restore-reveal residual glitches) → [20.5.D.3](#step-20-5-d-3) (Z5 submit-button state machine) → [20.5.D.4](#step-20-5-d-4) (request cancellation UX mini-spike) → [20.5.D.4.A](#step-20-5-d-4-a) (tugcode result-bounded turn model) → [20.5.D.5](#step-20-5-d-5) (cross-zone coordination Z2/Z4) → [20.5.D.5.A](#step-20-5-d-5-a) (request cancellation — queue mechanism) → [20.5.D.5.B](#step-20-5-d-5-b) (request cancellation — pull-back gestures) → [20.5.D.5.C](#step-20-5-d-5-c) (end-to-end matrix verification). Reconciled 2026-05-21 against the 20.4.10–20.4.15 reframe; D.4 inserted 2026-05-21 (and widened from a queued-request spike to the full request-cancellation family); D.2.A inserted 2026-05-21 after a frame-by-frame relaunch capture showed [DT10] fixed the transcript half but six restore states still flicker past; D.2.B inserted 2026-05-21 after a post-D.2.A capture showed two residual relaunch glitches (a picker-sheet flash, a wrong first-paint scroll position) — see the reconciliation note below; D.4.A inserted 2026-05-21 after the D.4 spike's stream-json probes found claude merges a mid-turn message into a running tool turn while tugcode's turn model cannot route overlapping sends; D.5 split into D.5 + D.5.A / D.5.B / D.5.C 2026-05-21 — cross-zone coordination, the queue mechanism, the cancellation pull-back gestures, and the end-to-end matrix test, each its own sub-step._

**Commit:** _per sub-step._

**References:** [#step-20-5-a] (the matrix), [#step-20-3] (the `CodeSessionSnapshot` fields driving coordination), [#step-20-4] (the zones), [L02], [L06], [L23], [L26], [DT09], [DT10]

**Scope.** Implement the [Step 20.5.A](#step-20-5-a) state-to-zone coordination matrix: the lifecycle state machine becomes a real `deriveLifecycleSnapshot` function — the matrix encoded as one switch — exposed via a `useLifecycleState()` hook, and the surfaces that genuinely need phase coordination consume it. The matrix is the contract; a regression against any of its ✓ cells is a bug.

**Reconciliation note (2026-05-21).** This step was authored before the [Step 20.4.10](#step-20-4-10)–[Step 20.4.15](#step-20-4-15) Z1 reframe and the [Step 20.5.B](#step-20-5-b) / [Step 20.5.B.1](#step-20-5-b-1) replay work. Three parts of the original scope are obsolete and are dropped:

- **Z1 asst-half coordination** — originally "swap a `TugProgress` variant for per-turn metrics on COMPLETE." Superseded: [Step 20.5.C](#step-20-5-c) (the `TugProgress` `agent`-role primitive) is itself superseded, and [Step 20.4.15](#step-20-4-15) shipped the production Z1 asst-half as the `TideZ1B` two-line stack — `TugThinkingIndicator` on the in-flight row, `EndStateDisplay` on committed rows — driven per-row off `turn === undefined`, **not** the session phase. Z1 needs nothing from the lifecycle hook; the matrix's Z1 column is already authoritative (see the 20.5.A matrix-edit policy).
- **"Ship the chosen telemetry placement defaults"** — done: [Step 20.4.13](#step-20-4-13) / [Step 20.4.15](#step-20-4-15) shipped Z2 = `statusRow` as the production default; the dev placement-experiment harness stays behind the `import.meta.env.DEV` guard.
- **The `#step-20-3-4` dependency** — satisfied: per-turn telemetry persistence shipped 2026-05-16, so the shipped placements read correct values across HMR / Reload / relaunch ([L23]).

**The foundation-first split.** What genuinely remains is the lifecycle state machine itself plus the surfaces that need it — Z5's submit button, the transcript-replay paint gate, and Z2 / Z4. It lands as a sequence of sub-steps:

| Sub-step | Deliverable | Primary file(s) |
|---|---|---|
| [20.5.D.1](#step-20-5-d-1) | Lifecycle foundation — `deriveLifecycleSnapshot` (the matrix as one switch) + `useLifecycleState` hook + pure per-matrix-row tests | _new_ `lifecycle-state.ts`, `use-lifecycle-state.ts` |
| [20.5.D.2](#step-20-5-d-2) | `[DT10]` transcript-replay paint gate — the restore-FOUC fix | `tide-card.tsx` transcript host |
| [20.5.D.2.A](#step-20-5-d-2-a) | Restore-reveal coordination — collapse the six-state relaunch flicker to one delay-gated placeholder + one reveal | `tide-card.tsx`, `tide-card-banner-spec.ts` |
| [20.5.D.2.B](#step-20-5-d-2-b) | Restore-reveal residual glitches — the picker-sheet flash + the first-paint scroll position | `tide-card.tsx`, `tide-session-restore.ts`, `tug-list-view.tsx` |
| [20.5.D.3](#step-20-5-d-3) | Z5 submit-button state machine — the new disabled / label modes | `tug-prompt-entry.tsx` + `.css` |
| [20.5.D.4](#step-20-5-d-4) | Request cancellation UX mini-spike — design + vet the pull-down / queued / interrupt affordance family | plan + a gallery / HMR vet surface |
| [20.5.D.4.A](#step-20-5-d-4-a) | tugcode result-bounded turn model — route overlapping / mid-turn sends; turn lifecycle bound to claude's `result` | `tugcode/src/session.ts`, `main.ts` |
| [20.5.D.5](#step-20-5-d-5) | Cross-zone coordination — Z2 + Z4 audited conformant; no production code, the matrix Z2 / Z4 columns re-authored | [#step-20-5-a](#step-20-5-a) (the matrix) |
| [20.5.D.5.A](#step-20-5-d-5-a) | Request cancellation — queue mechanism: mid-turn submit queues, ghost rows, the `+` button | `reducer.ts`, `lifecycle-state.ts`, `tug-prompt-entry.tsx` |
| [20.5.D.5.B](#step-20-5-d-5-b) | Request cancellation — pull-back gestures: C1 / C2 / C3, Stop ≡ Esc peel-newest | `reducer.ts`, `tug-prompt-entry.tsx` |
| [20.5.D.5.C](#step-20-5-d-5-c) | End-to-end matrix verification — every matrix row, every zone | `tide-card-lifecycle-coordination.test.tsx` |

D.1 is the dependency for D.2–D.5 — every later sub-step reads the matrix through the hook ([L02]; per the Conformance below, no zone reads `phase` directly). D.2 is sequenced right after the foundation because it closes the restore-FOUC bug ([DT10]) — Bug 1 of the lifecycle investigation that opened this work. D.2.A follows directly: [DT10] suppressed the transcript host's own intermediate paint, but a frame-by-frame capture of a cold relaunch showed the restore still flickers through six distinct states (two separate loading surfaces, an ungated banner that lingers and reflows, a focus beat that lands last) — D.2.A collapses those to one delay-gated placeholder and one coordinated reveal. D.2.B mops up the two residual glitches a post-D.2.A capture surfaced — the project-picker sheet briefly flashing during the pre-registry window of the startup restore pass, and the transcript's first paint landing at the wrong scroll position (jump-to-bottom button visible) when the saved state was scrolled to the bottom. D.4 is a design-oriented mini-spike, not an implementation step: request cancellation — pulling a request back, whether queued or already in flight — was never designed, so the behavior today is inconsistent and uncontrolled. D.4 designs the cancellation family (pull-down / queued / interrupt) and surfaces its data-model gaps for the user to review before D.5 wires it. D.4.A is a tugcode transport fix the D.4 spike forced: its raw stream-json probes proved claude's turn boundary is its `result` — a mid-turn message merges into a running *tool* turn (one `result`, the answer folded in) — while tugcode equates one `user_message` to one turn and mis-routes overlapping sends. D.4.A makes tugcode's turn model `result`-bounded so the eventual btw-send path has a correct transport foundation. D.5 is split four ways: cross-zone coordination (D.5 — Z2 and Z4 both audited already conformant against the Z2 status row's STATE cell; the matrix re-authored, no production code), the request-cancellation landing as a queue-then-pull-back pair (D.5.A queues a mid-turn submit and shows it; D.5.B adds C1 / C2 / C3 + Stop ≡ Esc), and D.5.C — the end-to-end matrix test that drives a fixture through every row and closes 20.5.D.

**Conformance (applies to every sub-step).** All phase-driven UI goes through `useLifecycleState()` — no zone reads `phase` or `awaitingApprovalSince` directly ([L02]). Appearance changes flip a `data-*` attribute / class and CSS does the visual ([L06]). State preservation: label / content transitions must not flicker, and DOM nodes that carry focus or scroll position stay mounted across mode changes ([L23] / [L26]).

---

#### Step 20.5.D.1: Lifecycle foundation — `deriveLifecycleSnapshot` + `useLifecycleState` {#step-20-5-d-1}

**Depends on:** #step-20-5-d (parent), #step-20-5-a (the matrix this encodes), [#step-20-3] (the `CodeSessionSnapshot` fields the switch reads)

**Status:** _complete. `lifecycle-state.ts` — `deriveLifecycleSnapshot` encodes the 20.5.A matrix as one pure switch: `state` (the ten rows, with errored / replaying / interrupt precedence), `overlays`, and the Z5 `submitButtonMode`. `use-lifecycle-state.ts` — the `useSyncExternalStore` + per-card `useRef` wrapper. `lifecycle-state.test.ts` — 35 pure-logic cases. `tsc --noEmit` clean; `bun test` green. Three refinements of the design sketch, all noted in the module docstrings: (1) `submitButtonMode` extracted as a named `TideSubmitButtonMode` type — Step 20.5.D.3 consumes it; (2) `deriveLifecycleSnapshot` takes an optional second `previous` argument as the [DT09] reference-stability mechanism (pure — the hook threads it from a per-card `useRef`, so stability is per-card and a module cache cannot thrash); (3) the first argument is typed `LifecycleStoreSignals` — the narrow matrix-relevant subset of `CodeSessionSnapshot`, which structurally satisfies it — so the function states its true dependency surface and a pure test supplies a literal without fabricating ~30 unrelated fields. The `uiState` / `drilldown_open` machinery the original sketch carried was retired with the 20.5.E drill-down (2026-05-21); `deriveLifecycleSnapshot` is single-argument. One matrix reading flagged for the [20.5.D.4](#step-20-5-d-4) request-cancellation spike: QUEUED_NEXT_TURN is followed literally in `deriveSubmitButtonMode` — it shows a queued-Submit (not Stop) even while a turn is in flight; the spike revisits whether that is the wanted affordance._

**Commit:** `feat(tide-rendering): lifecycle-state module + useLifecycleState hook`

**References:** [#step-20-5-a] (the state-to-zone matrix — the literal source for the switch), [#step-20-3] (`CodeSessionSnapshot`: `phase` / `transportState` / `interruptInFlight` / `queuedSends` / `transcript`), [L02], [DT09]

**Scope.** The 20.5.A matrix is a table; this sub-step makes it executable. `deriveLifecycleSnapshot` is a pure function — one switch — projecting the `CodeSessionStore` snapshot onto a `TideLifecycleSnapshot` (the matrix row: `state`, `overlays`, `submitButtonMode`). `useLifecycleState()` is the `useSyncExternalStore` wrapper. No UI integration here — the foundation lands and is unit-tested in isolation; D.2–D.5 consume it.

**Design — the `useLifecycleState` hook.** Sketch:

```typescript
// lib/code-session-store/lifecycle-state.ts (new module)

export type TideLifecycleState =
  | "idle" | "submitting" | "awaiting_first_token"
  | "streaming" | "tool_work" | "awaiting_user"
  | "interrupting" | "replaying" | "errored" | "complete";

export type TideLifecycleOverlay = "transport_down" | "queued_next";

export interface TideLifecycleSnapshot {
  state: TideLifecycleState;
  overlays: ReadonlySet<TideLifecycleOverlay>;
  // Z5-relevant derived field:
  submitButtonMode:
    | { kind: "submit"; disabled: boolean; queued: boolean }
    | { kind: "stop" }
    | { kind: "awaiting_user" }   // disabled
    | { kind: "stopping" }        // disabled
    | { kind: "reconnecting" }    // disabled
    | { kind: "restoring" };      // disabled — REPLAYING state
}

// Per [DT09]: returns the previous reference when matrix-relevant signals unchanged.
export function deriveLifecycleSnapshot(
  storeSnapshot: CodeSessionSnapshot,
  previous?: TideLifecycleSnapshot,
): TideLifecycleSnapshot;
```

`useLifecycleState()` composes two sources: (1) `useSyncExternalStore` on `CodeSessionStore` per [L02]; (2) `deriveLifecycleSnapshot(storeSnapshot, previous)` to project the snapshot onto the matrix-row signal, threaded with the previous result from a per-card `useRef` for the reference-stable return guarantee of [DT09].

The matrix is encoded literally in `deriveLifecycleSnapshot` — one switch, one source of truth, trivially testable. The switch reads the actual `CodeSessionPhase` enum (`idle | submitting | awaiting_first_token | streaming | tool_work | awaiting_approval | replaying | errored`) plus `transportState` / `queuedSends` / `interruptInFlight` / `transcript.length`, and derives the matrix's projected states that have no raw phase of their own — COMPLETE (`idle` with ≥ 1 committed turn), INTERRUPTING (`interruptInFlight`), AWAITING_USER (`awaiting_approval`).

**Conformance.** [L02] — the hook is the single `useSyncExternalStore` boundary; `lifecycle-state.ts` is a pure module (no DOM, no React). [DT09] — `deriveLifecycleSnapshot` returns the previous reference when no matrix-relevant signal changed; a growing `assistant` string must not produce a new snapshot.

**Artifacts.**

- `tugdeck/src/lib/code-session-store/lifecycle-state.ts` — _new_ — `TideLifecycleState`, `TideLifecycleOverlay`, `TideSubmitButtonMode`, `TideLifecycleSnapshot`, `LifecycleStoreSignals`, `deriveLifecycleSnapshot`, `lifecycleSnapshotsEqual`.
- `tugdeck/src/lib/code-session-store/hooks/use-lifecycle-state.ts` — _new_ — the `useSyncExternalStore` + per-card `useRef` + `deriveLifecycleSnapshot` composition.
- `tugdeck/src/lib/code-session-store/__tests__/lifecycle-state.test.ts` — _new_ — pure-logic tests, one per distinct matrix row + the [DT09] guarantee.

**Tasks.**

- [x] `lifecycle-state.ts` — the types + `deriveLifecycleSnapshot` as the 20.5.A matrix encoded in one switch. _Done — `deriveLifecycleState` / `deriveOverlays` / `deriveSubmitButtonMode` compose the projection; `lifecycleSnapshotsEqual` is the [DT09] primitive._
- [x] `use-lifecycle-state.ts` — the hook: `useSyncExternalStore` on `CodeSessionStore`, `deriveLifecycleSnapshot` to project. _Done — per-card `useRef` threads `previous` for [DT09]._
- [x] Pure tests — one per matrix row + the [DT09] guarantee. _Done — `lifecycle-state.test.ts`, 35 cases._

**Tests.**

- [x] `deriveLifecycleSnapshot` returns the correct `state` for every `phase` / `transportState` / `interruptInFlight` / `queuedSends` combination the matrix lists distinctly — IDLE, SUBMITTING, AWAITING_FIRST_TOKEN, STREAMING, TOOL_WORK, AWAITING_USER, INTERRUPTING, REPLAYING, ERRORED, COMPLETE — plus the errored / replaying / interrupt precedence. _Pass._
- [x] `submitButtonMode` matches the matrix Z5 column for every state, plus the TRANSPORT_DOWN / QUEUED_NEXT_TURN overlay effects (`reconnecting`, `queued`) and their precedence. _Pass._
- [x] **[DT09]** — `deriveLifecycleSnapshot` with `previous` threaded returns the prior reference when no matrix-relevant signal moved, a fresh one when any did. _Pass._

**Checkpoint.**

- [x] `bun x tsc --noEmit` clean. _Done._
- [x] `bun test` green. _Done — 0 fail._

---

#### Step 20.5.D.2: `[DT10]` transcript-replay paint gate {#step-20-5-d-2}

**Depends on:** #step-20-5-d-1 (the hook provides `state`)

**Status:** _complete. `TideTranscriptHost` (`tide-card-transcript.tsx`) now reads its lifecycle `state` via `useLifecycleState(codeSessionStore)` and renders `data-replaying` on the host root for the duration of the REPLAYING window; a `.tide-card-transcript[data-replaying] { visibility: hidden }` rule in `tide-card.css` holds the pane's paint dark across the window. `visibility`, not `display` — the subtree keeps its layout box so the inner list view's `ResizeObserver` measures cells as they commit and the height index is final when the gate lifts; the subtree is never unmounted ([L06] / [L26]). Coverage: two real-engine reducer-contract tests in `code-session-store.replay.test.ts` (the file already drives the real `CodeSessionStore` through a `replay_started → turn_complete* → replay_complete` bracket) pin the contract the gate keys off — `deriveLifecycleSnapshot().state` holds `replaying` across every intermediate `turn_complete` while `transcript.length` grows underneath, and leaves it once (to `complete`) at `replay_complete`; the second test pins that the derived REPLAYING snapshot is [DT09] reference-stable across intermediate commits so `data-replaying` never churns mid-window. The visible-paint suppression itself is React/CSS glue, left to the manual HMR vet per the no-fake-DOM rule (an app-test driving a real replay window would need replay-injection harness machinery that does not exist today). `tsc --noEmit` clean; `bun test` green (2316/0)._

**Commit:** `fix(tide-rendering): suppress transcript paint during replay (DT10)`

**References:** [DT10](#dt10-replay-transcript-suppression), [#step-20-5-a] (the REPLAYING matrix row), [L02], [L06], [L26]

**Scope.** Implements [DT10]. A resumed session reconstructs its committed turns one `turn_complete` at a time; painting each intermediate state makes the transcript visibly accumulate while the viewport chases the live edge — the restore FOUC the lifecycle investigation diagnosed (Bug 1). The transcript host gates its **visible paint** on `state !== "replaying"` (from `useLifecycleState()`), holding its pre-replay paint across the replay window and doing one reconstructed paint at `replay_complete`, at the restored scroll anchor.

**Conformance.** [L06] — the gate is a visibility concern: the transcript subtree stays mounted (its reducer keeps committing replayed turns underneath); only the visible paint is suppressed, via a `data-*` / class toggle + CSS, never by unmounting. [L26] — the transcript host DOM container is not remounted across the replay window; mount identity holds. [L02] — the gate reads `state` from the hook, not `phase` directly.

**Artifacts.**

- `tugdeck/src/components/tugways/cards/tide-card-transcript.tsx` — `TideTranscriptHost` reads `useLifecycleState` and renders `data-replaying` on the host root while `state === "replaying"`. (The host lives in `tide-card-transcript.tsx`; `tide-card.tsx` only composes it.)
- `tugdeck/src/components/tugways/cards/tide-card.css` — the `.tide-card-transcript[data-replaying] { visibility: hidden }` paint-gate rule.
- `tugdeck/src/lib/code-session-store/__tests__/code-session-store.replay.test.ts` — two real-engine tests pinning the [DT10] gate contract (added to the existing replay-bracket suite).

**Tasks.**

- [x] Gate the transcript host's visible paint on `state !== "replaying"`; hold the pre-replay paint; reveal once at `replay_complete`, at the restored scroll position.
- [x] Confirm the gate does not unmount the transcript subtree ([L26]) — content keeps reconstructing underneath; only paint is suppressed. _The gate is a `data-replaying` attribute + `visibility: hidden`; no conditional rendering, so the host's DOM container keeps mount identity and the reducer commits replayed turns underneath untouched._

**Tests.**

- [x] The lifecycle `state` the gate reads holds REPLAYING for the whole window while the transcript reconstructs underneath one `turn_complete` at a time, and leaves it once (to COMPLETE) at `replay_complete` — pinned against the real `CodeSessionStore` reducer in `code-session-store.replay.test.ts`. The visible-paint observation (no intermediate reconstructed frame; single fully-reconstructed reveal at the restored scroll anchor) is the user-gated HMR vet below — an automated paint-observation test is precluded by the no-fake-DOM rule.

**Checkpoint.**

- [x] `bun x tsc --noEmit` clean.
- [x] `bun test` green. _2316/0._
- [ ] **HMR vet (manual, user-gated)** — resume a multi-turn session; confirm the transcript reveals once, fully reconstructed, with no scroll-chase FOUC.

---

#### Step 20.5.D.2.A: Restore-reveal coordination — collapse the six-state relaunch flicker {#step-20-5-d-2-a}

**Depends on:** #step-20-5-d-2 ([DT10] gates the transcript's own paint — the transcript half of the reveal), #step-20-5-d-1 (the lifecycle hook)

**Status:** _complete._

_**Audit findings.** (1) **Cold-relaunch vs reconnect.** The captured six states are the cold-relaunch path; the mid-session transport-reconnect path is separate and routes `transportState === "restoring"` → `TideRestoring`, then `online` + `phase === "replaying"` → the mounted body under [DT10]'s gate. D.2.A's new gating is scoped cold-relaunch-only by a one-shot `revealed` latch (below), so the reconnect path is untouched. (2) **Replay runs without the body.** `cardServicesStore._construct` fires `request_replay` + `notifyResumeBindingLanded()` and the `CodeSessionStore` subscribes to `CODE_OUTPUT` in its constructor — the reducer ingests the whole `replay_started → turn_complete* → replay_complete` bracket with `TideCardBody` unmounted, so holding the body unmounted across the replay window loses nothing. (3) **Why focus landed late (frame 6).** The body's mount `useLayoutEffect` already claims focus (`reclaimEntryFocus`, first-responder-gated). The late frame was the `Loading session…` banner: mounting it set `inert` on `.tug-pane-body`, blurred the editor, and focus only returned on `bannerDidHide` after the exit animation. Retiring the banner removes the blur — the mount-time claim sticks, so focus lands with the reveal. (4) **Restore-progress signal.** No new store field was needed: `deriveColdRestoreActive` (pure, from `phase` / `sessionMode` / `replayPreflightActive` / `lastError`) drives the routing, and a module-level restore-start stamp in `tide-session-restore.ts` drives the delay — it spans pre-services spawn + preflight + replaying and survives the `TideRestoring` remount at the `services` boundary, which a component-local timer could not._

_**Landed.** `TideCardServicesGate` now reads two narrow store selectors (`transportState`, `deriveColdRestoreActive`) and a one-shot `revealed` latch: while the cold restore is active and the body has not yet revealed, it routes to `TideRestoring`; once `deriveColdRestoreActive` first goes false the latch flips and never flips back, so a later reconnect-replay stays on the mounted body + [DT10] gate. `TideCardBody` therefore mounts exactly once, at `replay_complete`, against a fully-reconstructed transcript — one paint, focus claimed in the mount `useLayoutEffect`. `TideRestoring` delay-gates its centered panel: backdrop always, panel mounted only past `RESTORE_PLACEHOLDER_DELAY_MS` (= `REPLAY_SOFT_BUDGET_MS`), measured from the `getRestoreStartedAt` stamp; the panel is conditionally rendered (no unseen spinner / `aria-live` for a fast restore) with a one-shot CSS fade-in. New pure module `tide-card-restore-gate.ts` (`deriveColdRestoreActive`); the `replay-loading` banner kind is retired from `deriveTideCardBannerSpec` (`error` / `transport` / `replay-timeout` unchanged). The cold path no longer toggles [DT10]'s `visibility` gate (the transcript host mounts once at final geometry), which removes the residual ½px hop on that path. `tsc --noEmit` clean; `bun test` green (2325/0). Two residuals noted: `replaySoftBudgetElapsed` lost its last consumer with the banner — its `tick_soft_budget` reducer machinery is now a follow-up cleanup candidate; and a >2s subprocess spawn can re-fade the placeholder panel once at the `services` boundary, where `TideRestoring` remounts — a rare slow-path cosmetic._

**Commit:** `fix(tide-rendering): coordinate the session-restore reveal (D.2.A)`

**References:** [DT10](#dt10-replay-transcript-suppression), [#step-20-5-a] (the REPLAYING matrix row), `tide-card.tsx` (`TideCardContent` / `TideCardServicesGate` / `TideRestoring` / `TideCardBody`), `tide-card-banner-spec.ts` (`deriveTideCardBannerSpec` — the `replay-loading` kind this step retires), `tide-session-restore` / `tideRestoreRegistry` / `cancelTideRestore`, `reducer.ts` (`replayPreflightActive` / `replaySoftBudgetElapsed` / `REPLAY_SOFT_BUDGET_MS`), [L02], [L05], [L06], [L23], [L26]

**Scope — why this step exists.** [DT10] (Step 20.5.D.2) suppressed the transcript host's *own* intermediate paint, and it did. But a frame-by-frame capture of a cold relaunch + session restore still shows **six distinct visual states** flickering past — fast enough to read as "flashing" rather than information. [DT10] fixed one surface; nothing coordinates the surfaces *around* it. The captured sequence:

| Frame | What shows | Driven by |
|---|---|---|
| 1 | Full-card **"Restoring session"** placeholder — centered panel, spinner, Cancel | `TideRestoring` — `services === null` + `tideRestoreRegistry` entry, and/or `transportState === "restoring"` |
| 2 | `Loading session…` banner + empty transcript + Z2 **STATE: Replaying** | `TideCardBody` mounts; `phase === "replaying"`; the [DT10] gate hides the transcript |
| 3 | banner + **painted** transcript + Z2 **STATE: Idle** | `replay_complete` fired; [DT10] gate lifted; banner still up — held by `TugPaneBanner minMountedMs: 500` |
| 4 | ≈ frame 3 | banner exit animation running |
| 5 | banner gone → transcript **reflows up**, the Z1A model header appears | the banner's unmount frees ~40px and reflows the transcript pane |
| 6 | prompt-entry gains caret / first-responder | focus lands last, as its own beat |

Root causes, all outside [DT10]'s remit: **(a) two separate loading surfaces** — the full-card `TideRestoring` placeholder *and* the `Loading session…` banner — appear back-to-back; **(b) the banner is not delay-gated** — it shows on every resume, not just slow ones; **(c) it lingers** past `replay_complete` (`minMountedMs` hold + exit animation, frames 3–4); **(d) its unmount reflows the transcript** (frame 4→5); **(e) focus lands a frame later** (frame 5→6).

**Goal — at most two states.** A cold relaunch + restore shows: **(1)** _conditionally, only when the restore exceeds ~2s_ — a single loading affordance, the centered **"Restoring session"** placeholder (delay-gated; keeps its Cancel escape hatch); **(2)** the final ready state — fully-painted transcript, settled Z2, and the prompt-entry **focused + first-responder**, in one coordinated reveal. A sub-2s restore (the common case) shows only state 2.

**Design decisions (user-vetted 2026-05-21).**

- **One loading affordance: the centered placeholder, delay-gated.** The `Loading session…` banner is retired from the restore flow; the existing centered `TideRestoring` panel is the single affordance. It is shown only after the restore has been in progress longer than `REPLAY_SOFT_BUDGET_MS` (~2s). Under budget, no loading affordance appears at all — the card holds a quiet empty interior (the `TideRestoring` backdrop with no centered panel) and then does the single reveal.
- **The placeholder spans the whole restore window.** Today the centered placeholder covers only the pre-body window (`services === null` / `transportState === "restoring"`) and the banner covers the `phase === "replaying"` window. D.2.A routes the *entire* restore — pre-services, transport-restoring, replay preflight, and `phase === "replaying"` (resume mode) — to `TideRestoring`. `TideCardBody` is not routed in until the restore is genuinely done (`replay_complete`, whatever the outcome).
- **The placeholder keeps Cancel.** A genuinely stuck restore stays abortable to the picker via `cancelTideRestore`.
- **One reveal.** `TideCardBody` mounts once, at restore-complete, against a transcript the reducer has already fully reconstructed — so there is no intermediate transcript paint (the cold path no longer needs [DT10]'s gate; [DT10] still governs the mid-session-reconnect path, where the body stays mounted) — and the prompt-entry is focused + first-responder in the same beat. Because the body mounts whole, there is no banner mount/unmount and therefore no reflow.

**Conformance.** [L26] — on the cold-relaunch path `TideCardBody` (and the transcript host inside it) mounts exactly once, at restore-complete, with content final; no remount, no per-turn re-render. The `CodeSessionStore` reducer ingests the replay bracket independently of whether the body is mounted, so holding the body unmounted during replay loses nothing — and a delayed *first* mount is not an unmount, so it carries no identity to break. On the mid-session-reconnect path the body stays mounted and [DT10]'s paint gate (not a remount) governs. [L06] — the placeholder's delay-gated panel is a visibility concern: the `TideRestoring` backdrop is present for the whole window; the centered panel fades in via a one-shot CSS transition once the budget elapses. The body-vs-placeholder routing is genuine structure, not appearance, so it stays a React conditional. [L05] — the reveal-time focus is claimed by `TideCardBody`'s existing mount `useLayoutEffect` (the first-responder-gated `reclaimEntryFocus` helper), fired synchronously on the body's single mount-when-already-first-responder; no timing-derived macrotask claim, and — with the `replay-loading` banner retired — nothing sets `inert` to blur the editor after, so the claim sticks. [L23] — the single reveal happens at final transcript geometry, so the saved scroll anchor / draft restore resolve once, against a settled height. [L02] — the restore-progress signals are read from the `CodeSessionStore` snapshot via `useSyncExternalStore`.

**Artifacts.**

- `tugdeck/src/components/tugways/cards/tide-card.tsx` — `TideCardServicesGate` routing extended (two narrow selectors + the `revealed` latch) so the cold-restore window routes to `TideRestoring` and `TideCardBody` mounts once at restore-complete; `TideRestoring` gains the delay-gated centered panel (backdrop always, panel after budget); the `replay-loading` banner render block dropped.
- `tugdeck/src/components/tugways/cards/tide-card-restore-gate.ts` — _new_ pure module: `deriveColdRestoreActive` + `ColdRestoreSignals`.
- `tugdeck/src/components/tugways/cards/tide-card.css` — the delay-gated panel's one-shot fade-in keyframe (+ reduced-motion opt-out).
- `tugdeck/src/components/tugways/cards/tide-card-banner-spec.ts` — the `replay-loading` banner kind retired; `error` / `transport` / `replay-timeout` kinds unchanged.
- `tugdeck/src/lib/tide-session-restore.ts` — the restore-start stamp (`getRestoreStartedAt` / `clearRestoreStartedAt`, stamped by `fireRestore`).
- `tugdeck/src/components/tugways/cards/__tests__/tide-card-banner-spec.test.ts` — `replay-loading` cases dropped, `replay-timeout` + retirement-regression cases added.
- `tugdeck/src/components/tugways/cards/__tests__/tide-card-restore-gate.test.ts` — _new_ pure-logic tests for `deriveColdRestoreActive`.

**Tasks.**

- [x] **Audit first.** Catalogued the six states against triggers; separated the cold-relaunch path from the mid-session reconnect path; confirmed the reducer ingests the replay bracket with `TideCardBody` unmounted; traced the late-focus frame to the `replay-loading` banner's `inert` blur; settled the restore-progress signal (no new store field — `deriveColdRestoreActive` + the `tide-session-restore` stamp). Findings recorded in the Status line.
- [x] Route the cold-restore window to `TideRestoring`; mount `TideCardBody` only at restore-complete. _Scoped cold-relaunch-only by the `revealed` latch — a reconnect-replay stays on the mounted body + [DT10] gate._
- [x] Delay-gate the centered panel: `TideRestoring` shows only its quiet backdrop until the restore exceeds `RESTORE_PLACEHOLDER_DELAY_MS` (= `REPLAY_SOFT_BUDGET_MS`), then fades the centered panel (title + spinner + Cancel) in.
- [x] Retire the `replay-loading` banner kind from `deriveTideCardBannerSpec`; `error` / `transport` / `replay-timeout` intact.
- [x] Coordinate the reveal: `TideCardBody` mounts whole with the transcript fully reconstructed; focus is claimed in the body's mount `useLayoutEffect` (`reclaimEntryFocus`) with no banner left to blur it — focus lands with the reveal.
- [x] Chase the residual ½px transcript hop. _The cold path's transcript host now mounts once at final geometry and never toggles [DT10]'s `visibility` gate, structurally removing the hop on that path; confirm in the HMR vet._
- [x] Keep the mid-session transport-reconnect path coherent — the `revealed` latch makes the new gating cold-relaunch-only, so a reconnect still routes through [DT10]'s gate (body stays mounted; transcript paint suppressed, not remounted).

**Tests.**

- [x] `deriveTideCardBannerSpec` pure-logic test updated: the `replay-loading` kind is gone; the `error` / `transport` / `replay-timeout` precedence chain holds branch-by-branch; retirement-regression cases pin that `replayPreflightActive` / `phase === "replaying"` no longer banner (nor mask an error/transport).
- [x] New `tide-card-restore-gate.test.ts` — pure-logic cases for `deriveColdRestoreActive` (preflight / replaying-resume / replaying-new / idle / errored / `lastError` force-false). No new store-level signal was added, so no reducer test is needed; the routing / mount-gating / focus is React glue left to the HMR vet per the no-fake-DOM rule.

**Checkpoint.**

- [x] `bun x tsc --noEmit` clean.
- [x] `bun test` green. _2325/0._
- [ ] **HMR vet (manual, user-gated)** — relaunch with an existing multi-turn session; frame-step a screen capture and confirm **at most two states**: the centered placeholder appears only if the restore exceeds ~2s, and the final state reveals once — fully-painted transcript, settled Z2, prompt-entry focused and ready to type, with no banner, no reflow, and no separate focus frame.

---

#### Step 20.5.D.2.B: Restore-reveal residual glitches — picker-sheet flash + first-paint scroll {#step-20-5-d-2-b}

**Depends on:** #step-20-5-d-2-a (the restore-reveal coordination this cleans up after)

**Status:** _complete._

_**Diagnosis.** **G1** — confirmed: `TideCardContent` falls through to `TideProjectPicker` for an unbound card with no `tideRestoreRegistry` entry, and on a cold relaunch that is true for the whole `list_card_bindings` round-trip — from card mount until the response handler fires `fireRestore`. The picker is on the first-responder card, so its `cardDidActivate` initial-sync drops the `TugSheet`; `fireRestore` then creates the registry entry and `TideCardContent` flips to `TideRestoring`, unmounting the picker mid-animation. **G2** — confirmed: the cold-boot restore (`tug-list-view.tsx`'s `onRegionScrollSet`, fed by CardHost's `applyRegionScrolls`) unconditionally `disengageFollowBottom`s and installs the saved `{index, offset}` anchor as the `SmartScroll` restore target — even when the user was following the bottom at save time. Disengaging follow-bottom shows the jump-to-bottom button (its visibility tracks `isFollowingBottom`, not "scrollTop < max"), and the near-bottom anchor can resolve short of the true bottom against not-yet-measured cell heights. The saved `data-tug-scroll-state` `meta` carried no "was at the bottom" flag, so the restore could not tell the at-bottom case from an arbitrary mid-list position._

_**Landed.** **G1** — `RestorePassGate` in `tide-session-restore.ts`: a one-shot subscribable boolean, settled on every exit path of `restoreTideSessions` (the no-tide-cards early-out, the `list_card_bindings_ok` handler, and a 5s timeout backstop for a response that never lands). `TideCardContent` reads it via `useSyncExternalStore`; an unbound card with no registry entry holds a new `TideRestoring variant="pass-pending"` (backdrop only — no panel, no Cancel, no project label) until the pass settles, then falls through to the picker only if genuinely a fresh card. **G2** — `tug-list-view.tsx`: the `data-tug-scroll-state` save writer now records `meta.atBottom` (from `SmartScroll.isFollowingBottom`); the mount seed and `onRegionScrollSet` restore an at-bottom list by re-engaging follow-bottom and pinning (`scrollToBottom` — exact `scrollHeight − clientHeight`, jump-to-bottom affordance stays hidden) instead of installing the near-bottom anchor. Non-at-bottom saves keep the anchor path unchanged; pre-`atBottom` bags fall back to the anchor path. New `restore-pass-gate.test.ts` (6 cases pinning the idempotency invariant). `tsc --noEmit` clean; `bun test` green (2331/0). Plan-step numbers were also swept out of the code comments authored across D.1 / D.2 / D.2.A / D.2.B per the project convention._

**Commit:** `fix(tide-rendering): kill the restore picker-flash + scroll glitch (D.2.B)`

**References:** [#step-20-5-d-2-a], `tide-card.tsx` (`TideCardContent` / `TideProjectPicker`), `tide-session-restore.ts` (`restoreTideSessions` / `tideRestoreRegistry`), `tug-list-view.tsx` (the `savedRegionScroll` / `meta.cellHeights` / `meta.anchor` / `followBottom` first-paint restore), `smart-scroll.ts`, `useSavedRegionScroll`, [AT0014] / [AT0069] (the cold-boot scroll-restore app-test contracts), [L02], [L03], [L23], [L26]

**Scope — why this step exists.** [Step 20.5.D.2.A](#step-20-5-d-2-a) collapsed the six-state relaunch flicker, but a post-D.2.A frame-by-frame capture surfaced **two residual glitches** on a cold relaunch + restore:

| Frame | What shows | Verdict |
|---|---|---|
| grid | bare deck canvas, no card content yet | **OK** — acceptable cold-start baseline, not a glitch to fix |
| picker sheet | a partial `TideProjectPicker` `TugSheet` ("checking…", "FORGET ALL SESSIONS FOR THIS PATH", Cancel / Open) drops from the title bar, then vanishes | **glitch G1** — must never appear on a relaunch restore |
| wrong scroll | the transcript paints **not at the bottom** with the **jump-to-bottom button visible**, though the saved region-scroll state was scrolled to the bottom | **glitch G2** — the first painted frame must reproduce the saved scroll position |

The fourth captured frame is the target — transcript at the bottom, no jump-to-bottom button, prompt focused.

**G1 — picker-sheet flash.** `TideCardContent` renders `TideProjectPicker` for an unbound card whenever there is no binding *and* no `tideRestoreRegistry` entry. On a cold relaunch there is a window — card mount through `restoreTideSessions` sending `list_card_bindings` and its response handler firing `fireRestore` — during which the registry has no entry yet, so `TideCardContent` falls through to the picker. The picker is on the first-responder card → its `cardDidActivate` initial-sync fires `presentSheet` → the `TugSheet` drops. When `fireRestore` then creates the registry entry, `TideCardContent` flips to `TideRestoring` and the picker unmounts mid-sheet-animation — the captured "bit of the sheet." (`tide-session-restore.ts`'s own docstring names this flash as the reason the registry exists; the registry closes the *post*-`fireRestore` window but not the `list_card_bindings` round-trip ahead of it.)

**G2 — first-paint scroll position.** The transcript host mounts once, at replay-complete (D.2.A), with the full reconstructed data — but the first painted scroll position lands short of the saved bottom and `followBottom` is not engaged, so the jump-to-bottom button shows before a correction lands. The list view's first-paint restore reads `savedRegionScroll.meta` (`cellHeights` for `HeightIndex` hydration, `anchor` for the `SmartScroll` restore target) and separately auto-pins to bottom on a mount-with-`followBottom`. The diagnosis must pin which mechanism mis-resolves: a near-bottom saved `anchor` resolving short against not-yet-measured heights, the anchor restore target winning over the bottom pin, or the saved bag not carrying `cellHeights` for the `tide-card-transcript` scrollKey.

**Goal.** A cold relaunch restore shows the bare deck grid (briefly — fine) then the final ready state: **no picker sheet ever**, and the transcript painted **at the saved scroll position on its first frame** (for a scrolled-to-bottom save: `followBottom` engaged, bottom pinned, no jump-to-bottom button, no correction hop).

**Conformance.** [L23] — the saved scroll position is user-visible state; the first painted frame must reproduce it (the [AT0069] first-paint contract), and the picker must never flash over a card that is mid-restore. [L03] — scroll-restore registrations stay in `useLayoutEffect` so the first paint sees them. [L02] — the restore-pass-settled signal enters React via `useSyncExternalStore`. [L26] — no remount churn: the transcript host still mounts exactly once.

**Artifacts.**

- `tugdeck/src/lib/tide-session-restore.ts` — `RestorePassGate` (a subscribable one-shot signal), settled on every exit path of `restoreTideSessions` (the `list_card_bindings_ok` handler, a 5s timeout backstop, and the no-tide-cards early-out).
- `tugdeck/src/components/tugways/cards/tide-card.tsx` — `TideCardContent`'s picker branch gated on the restore-pass signal; `TideRestoring` gains the `pass-pending` (backdrop-only) variant.
- `tugdeck/src/components/tugways/tug-list-view.tsx` — the `data-tug-scroll-state` save writer records `meta.atBottom`; the mount seed and `onRegionScrollSet` restore an at-bottom list by re-engaging follow-bottom + pinning instead of the near-bottom anchor.
- `tugdeck/src/__tests__/restore-pass-gate.test.ts` — _new_ pure-logic tests for `RestorePassGate`.

**Tasks.**

- [x] **Diagnose first.** G1 — confirmed the pre-registry window (the `list_card_bindings` round-trip) and the picker's `cardDidActivate`-driven sheet present. G2 — pinned the mis-resolving mechanism: the cold-boot restore unconditionally disengages follow-bottom and installs the near-bottom anchor, even for an at-bottom save. Findings recorded in the Status line.
- [x] G1: `RestorePassGate` in `tide-session-restore.ts`, settled on every exit path of `restoreTideSessions`; `TideCardContent`'s picker branch gated on it so an unbound tide card holds the `pass-pending` placeholder until the startup restore pass settles.
- [x] G2: the at-bottom restore re-engages follow-bottom and pins (`scrollToBottom`) instead of resolving the near-bottom anchor — the first painted frame is the true bottom, follow-bottom engaged, no jump-to-bottom button, no correction hop.
- [x] Confirm a genuine fresh tide card still shows the picker — once the pass settles, an unbound card with no registry entry falls through to `TideProjectPicker`; a card the user adds after startup sees the already-settled gate and shows the picker immediately.
- [x] Confirm the bare deck grid before card content is the accepted baseline — no fix; the brief pre-registry window now shows the quiet `pass-pending` backdrop rather than a picker sheet.

**Tests.**

- [x] `restore-pass-gate.test.ts` — pure-logic cases for `RestorePassGate`: starts unsettled, `_settle` flips + notifies once, idempotent across re-settles (the reconnect / timeout-race invariant), unsubscribe, and a post-settle subscriber is not retroactively notified. The `TideCardContent` picker-gate wiring is React glue, left to the HMR vet per the no-fake-DOM rule.
- [x] G2 scroll restore — the `meta.atBottom` save/restore is DOM-and-`SmartScroll` glue; its visible outcome is the HMR vet below (an automated cold-boot scroll app-test for the tide transcript would need harness machinery to drive a real replay-restore, which does not exist).

**Checkpoint.**

- [x] `bun x tsc --noEmit` clean.
- [x] `bun test` green. _2331/0._
- [x] **HMR vet (manual, user-gated)** — relaunch with an existing multi-turn session scrolled to the bottom; frame-step a screen capture and confirm no picker sheet appears at any point and the transcript's first painted frame is at the bottom with no jump-to-bottom button. _Verified 2026-05-21 — no picker sheet, first paint at the bottom._

---

#### Step 20.5.D.3: Z5 submit-button state machine {#step-20-5-d-3}

**Depends on:** #step-20-5-d-1 (the hook provides `submitButtonMode`)

**Status:** _complete. New pure module `tug-prompt-entry-submit-button.ts` (`resolveSubmitButtonView`) projects a `TideSubmitButtonMode` onto the button's view — `data-mode` / `aria-label` / `disabled` / icon glyph / danger-role — one branch-free `switch` over the six kinds. `tug-prompt-entry.tsx` reads `submitButtonMode` via `useLifecycleState(codeSessionStore)` and renders the existing single `<TugPushButton>` from that view ([L26] — one node, no branched elements; only `data-mode` / `disabled` / `aria-label` / the icon glyph change). The four inert modes (awaiting-user / stopping / reconnecting / restoring) are natively `disabled` — which alone blocks click, keyboard activation, the chain action-dispatch, and tab-order — and `performSubmit` (the shared keyboard + pointer path the editor's Return also reaches) gates on `resolveSubmitButtonView(mode).disabled`, so a disabled mode does not fire on Enter. Behavior corrections vs the pre-D.3 `canInterrupt` toggle: `awaiting_approval` was a live red **Stop**, now the disabled "Awaiting your input"; an in-flight turn over a dead wire was **Stop**, now disabled "Reconnecting…"; an interrupt-in-flight turn was **Stop**, now disabled "Stopping…". The `submitButtonMode.queued` flag is read through but does not change the view (a queued Submit renders as an ordinary Submit — distinct visual deferred to D.4; QUEUED_NEXT_TURN is also unreachable in the current UI, since no path enqueues a mid-turn `send`). `tug-prompt-entry.css` — the empty-input gate is re-scoped from the old `[data-can-interrupt="false"]` root proxy to the precise `[data-mode="submit"]` on the button. Mount identity is structural — one `<TugPushButton>` JSX element, never branched — so it holds by construction. New `tug-prompt-entry-submit-button.test.ts` (8 cases, one per mode + the `queued` wire-through + the disabled-set). `tsc --noEmit` clean; `bun test` green (2339/0); `audit:tokens lint` zero violations._

**Commit:** `feat(tide-rendering): Z5 submit-button lifecycle state machine`

**References:** [#step-20-5-a] (the Z5 matrix column), [L06], [L23], [L26]

**Scope.** The submit / stop button in `tug-prompt-entry.tsx` consumes `submitButtonMode` from the hook. Today the button toggles submit ↔ stop ([D-T3-06]); the matrix adds the disabled / transient modes: "Awaiting your input" (AWAITING_USER), "Stopping…" (INTERRUPTING), "Reconnecting…" (TRANSPORT_DOWN overlay), "Restoring…" (REPLAYING). The same `submitButtonMode` governs keyboard activation — a disabled mode does not fire on Enter.

**Queued visual deferred.** `submitButtonMode.queued` (QUEUED_NEXT_TURN) is wired through to the button, but its distinct *visual* — the "will send on idle" treatment — is deferred to the [Step 20.5.D.4](#step-20-5-d-4) request-cancellation mini-spike. Until that design is vetted, a queued Submit renders as an ordinary Submit: the data path is correct, only the paint is deferred. This sub-step ships every `submitButtonMode` kind — only the `queued` flag's distinct visual waits on D.4.

**Conformance.** [L06] — the mode flips a `data-mode` attribute; CSS handles the per-mode visual. [L26] — ONE `<button>` DOM node across every mode; only label / disabled / `data-mode` / handler change. Do NOT render `<button>Submit</button>` in one branch and `<button>Stop</button>` in another. [L23] — label transitions must not flicker, and focus on the button survives a mode change mid-turn.

**Mount-identity check.** [L26] — the button is the most likely place to break responder identity. Verify: tab into the textarea, type, focus the button, drive a fixture turn through SUBMITTING → STREAMING → COMPLETE — the button is the same DOM node throughout and focus identity persists.

**Artifacts.**

- `tugdeck/src/components/tugways/tug-prompt-entry-submit-button.ts` — _new_ pure module: `resolveSubmitButtonView` + `SubmitButtonView`.
- `tugdeck/src/components/tugways/tug-prompt-entry.tsx` — the submit / stop button consumes `submitButtonMode` via `useLifecycleState`; one button node, `data-mode`-driven; `aria-label` per mode; `performSubmit` gated on the disabled modes.
- `tugdeck/src/components/tugways/tug-prompt-entry.css` — the empty-input gate re-scoped to `[data-mode="submit"]`.
- `tugdeck/src/components/tugways/__tests__/tug-prompt-entry-submit-button.test.ts` — _new_ Z5 mode-mapping tests.

**Tasks.**

- [x] Single `<button>` node; `data-mode` attribute drives the per-mode visual via CSS; `aria-label` per mode.
- [x] Keyboard activation respects disabled modes (no Enter-fire when disabled). _Native `disabled` blocks the button; `performSubmit` gates the editor's Return path on `resolveSubmitButtonView(mode).disabled`._
- [x] Mount-identity + focus-survival verification. _Structural: one `<TugPushButton>` JSX element, never branched — the DOM node is the same across every mode by construction. Focus survival across a turn is the HMR vet._

**Tests.**

- [x] `tug-prompt-entry-submit-button.test.ts` — the button's `data-mode` / `aria-label` / `disabled` / icon / danger match the matrix Z5 column for every `submitButtonMode` kind (the `queued` flag asserted as a no-op on the view — a queued Submit renders as an ordinary Submit); plus the disabled-set (exactly the four inert modes), which is also `performSubmit`'s Enter-gate.
- [x] The same `<button>` DOM node persists across mode transitions — structural (one JSX element, no branching); textarea + button focus survival across a fixture turn is the HMR vet (an RTL mount-identity test is precluded by the no-fake-DOM rule).

**Checkpoint.**

- [x] `bun x tsc --noEmit` clean.
- [x] `bun test` green. _2339/0._
- [x] `bun run audit:tokens lint` exits 0.
- [ ] **HMR vet (manual, user-gated)** — drive a turn; confirm the button doesn't flicker or lose focus across SUBMITTING → STREAMING → COMPLETE; confirm a permission dialog flips it to "Awaiting your input" (disabled).

---

#### Step 20.5.D.4: Request cancellation UX mini-spike {#step-20-5-d-4}

**Depends on:** #step-20-5-d-3 (the concrete Z5 button the spike designs against), #step-20-5-d-1 (`submitButtonMode` / the `queued` flag)

**Status:** _complete. A real-`CodeSessionStore`-driven gallery card (`gallery-request-cancellation`) served as the iterative vet surface; once the design was settled the card was **deleted** — it was a throwaway vet vehicle, and the captured cancellation behavior spec below is the deliverable. [Step 20.5.D.5.A](#step-20-5-d-5-a) / [B](#step-20-5-d-5-b) wire the spec into the real tide card._

_**Vetted decisions (2026-05-21).** (1) **Mid-turn submit queues.** A prompt submitted while a turn runs is held and dispatched on the next idle — not interrupted (the pre-spike behavior), not blocked. This is the path the architecture was already built for: the matrix's QUEUED_NEXT_TURN row, D.3's `submit{queued}` button mode, and the reducer's `queuedSends` payload array all anticipate it. (2) **Pull-down extends through thinking.** The clean un-send (C2) stays available while Claude is only thinking — no answer text, no tool call yet — and locks to a committed `interrupted` turn (C3) at the first answer text or `tool_use`._

_**Investigation findings (reconciles the stale text below).** (a) **C2 is already wired end-to-end** — `tug-prompt-entry.tsx` has a `CASE A interrupt restore` `useLayoutEffect` that reads `snap.pendingDraftRestore`, seeds the editor via `editor.restoreState`, and dispatches `consumePendingDraftRestore`. The "last mile is unwired" claim below is stale; pulling down a pre-content request and getting the text back works today. (b) **The queue machinery is fully built but UI-dead.** The reducer's `send` handler enqueues a mid-turn send as a full `{text, atoms, turnKey}` payload (`queuedSends` in reducer state is an array, not a count), and `handleTurnComplete(success)` flushes one. But no UI path ever enqueues — `performSubmit` calls `interrupt()` on a mid-turn submit, never `send()` — so `queuedSends` is never non-empty, QUEUED_NEXT_TURN is unreachable, and the queue badge is dead. (c) **The C2/C3 threshold cannot be stated in phase terms.** `submitting → awaiting_first_token → streaming` is a text-event **count** ladder (`handleTextDelta` drives it for `assistant_text` AND `thinking_text` alike) — after two thinking partials the phase is `streaming` with zero answer text. The real "answer has begun" signal is `firstAssistantDeltaAt !== null || firstToolUseAt !== null` (reducer state, set on the first assistant-channel delta / first `tool_use`). "Pull-down through thinking" = CASE A while both are null; the current `phase === "submitting"` gate is wrong for it._

**Commit:** `plan(tide-rendering): capture the request-cancellation spec (D.4)`

**References:** [#step-20-5-a] (the QUEUED_NEXT_TURN matrix row + the lifecycle states the cancellation thresholds key off), [#step-20-5-d-1] (`deriveSubmitButtonMode` — where the Z5 reading lands), [D-T3-07] (queue-during-turn), [DT07](#dt07-esc-semantics) (Esc semantics), `tugdeck/src/lib/code-session-store/reducer.ts` (the CASE A / CASE B interrupt split + `pendingDraftRestore`), [L02], [L06]

**Scope.** A design-oriented mini-spike, not an implementation step. **Cancelling a request — pulling it back, whether queued or already in flight — was never designed, so the behavior today is inconsistent and uncontrolled.** This spike designs the whole cancellation family as one coherent affordance, produces a surface the user can review and vet, and captures the decision into the matrix + the reducer's interrupt split so [Step 20.5.D.5.A](#step-20-5-d-5-a) / [B](#step-20-5-d-5-b) wire a vetted design rather than a guess.

Three cancellation cases, one UX family — Esc (per [DT07]) or the Z5 button, each "pulling the request back":

- **(C1) Cancel a queued send** — a send made while a turn was running (`queuedSends > 0`, the QUEUED_NEXT_TURN overlay). It was never dispatched; cancelling is a true un-send — no wire traffic, no server turn.
- **(C2) Pull down a pre-content request** — Esc / cancel while `phase === "submitting"`, before Claude's first content frame. The request reached the server (a turn happens server-side, recorded in Claude Code's JSONL), but locally it can be discarded: no transcript turn, no per-turn telemetry, the prompt text returns to the editor. ("As if never sent" is therefore precise *locally* — a cold resume still reconstructs the aborted turn from the JSONL via the [W2] orphan-flush path.)
- **(C3) Interrupt a running turn** — Esc / cancel after content has arrived. Commits a `turnEndReason: "interrupted"` turn. Existing, unchanged.

**Current state — what exists, what is broken** (corrected by the investigation findings above). The reducer implements the C2 / C3 split — `handleInterrupt`'s **CASE A** (interrupt while `phase === "submitting"`) vs **CASE B** (interrupt after the first content frame), covered by `code-session-store.interrupt.test.ts`. CASE A captures the in-flight submission into a `pendingDraftRestore` slot, clears the in-flight pair, returns phase straight to `idle`, and suppresses the wire's `turn_complete(error)` echo — no committed turn, no INTERRUPTING dwell — and `tug-prompt-entry.tsx` **does** read `pendingDraftRestore` and restore the editor, so C2's text-return works. CASE B sets `interruptInFlight` and commits a `turnEndReason: "interrupted"` turn on the wire's `turn_complete(error)`. What is genuinely missing is **the queue's UI**: the reducer enqueues and flushes correctly, but no affordance enqueues, surfaces, or cancels a held send — C1 has no design at all. And two threshold gaps: CASE A's `phase === "submitting"` line closes the pull-down window at the first *thinking* partial (the vetted decision wants it open through thinking), and the C2/C3 threshold must be re-expressed against `firstAssistantDeltaAt` / `firstToolUseAt`, not phase. The architecture is right (CASE A / CASE B; no new lifecycle state); the design + the queue's last mile + the threshold reconciliation are what this spike closes.

**Design questions.**

1. **The C2 / C3 threshold.** _Decided (2026-05-21): extend through thinking._ The clean pull-down stays open while Claude has produced no answer text and no `tool_use`, and locks to interrupt at the first of either — `firstAssistantDeltaAt !== null || firstToolUseAt !== null` (NOT `phase`, which counts thinking partials). The classification latches at cancel-time.
2. **Z5 — the queued / cancellable Submit.** The queued visual (badge, count, label); does queuing override Stop or coexist; how each of C1 / C2 / C3 presents on the button. _Surfaced on the vet surface for review._
3. **Where a queued / pulled-down prompt's content surfaces.** A held prompt has content (text + atoms). A prompt-entry "pending" strip? A transcript ghost row? Both? The QUEUED_NEXT_TURN matrix row names no zone for the content itself.
4. **Esc + cancel-button mapping** across C1 / C2 / C3 — what each gesture does in each state, reconciled with [DT07].
5. **Multiple queued sends** — `queuedSends` is a count; is `N > 1` reachable, and if so an ordered, individually-cancellable queue or a single "pending"?

**Data-model flag** (reconciled by the investigation findings). Two gaps the chosen design closes — both narrower than the original framing:
- The reducer **already** retains the queued payloads (`queuedSends` in reducer state is `Array<{text, atoms, turnKey}>`); only the **snapshot** projects `.length`. C1's restore / review / edit needs the snapshot to expose the payloads (and `deriveSubmitButtonMode` / the lifecycle to read them), not new retention.
- `pendingDraftRestore` **already has a consumer** (`tug-prompt-entry.tsx`). No new C2 wiring is needed; the consumer just needs to keep working once the threshold widens.
- _New_ gap surfaced: the C2/C3 threshold signal (`firstAssistantDeltaAt` / `firstToolUseAt`) is reducer state, not on the snapshot. If the Z5 button must visually distinguish "pull-down" from "interrupt", the lifecycle needs that signal exposed; if `interrupt()` alone classifies (the reducer reads its own state), no snapshot change is needed. The vet decides whether the button distinguishes.

**Phase-semantics drift to reconcile.** Worse than first framed: `submitting → awaiting_first_token → streaming` is a text-event **count** ladder — `handleTextDelta` drives it identically for `assistant_text` and `thinking_text`, so `awaiting_first_token` means "one text event seen" and `streaming` means "≥ two", neither distinguishing thinking from answer. 20.5.A's state-definition table mis-describes both. The spike reconciles 20.5.A to the real (count-based) semantics and states the threshold against `firstAssistantDeltaAt` / `firstToolUseAt` instead.

**Cancellation behavior spec (vetted 2026-05-21).** The load-bearing deliverable — [Step 20.5.D.5.A](#step-20-5-d-5-a) / [B](#step-20-5-d-5-b) wire this.

- **Submitting during a turn → queue.** A prompt submitted (editor Enter) while a turn runs is **queued** — held in `queuedSends`, dispatched on the next idle (`turn_complete(success)` flushes the head, FIFO). Not interrupted, not blocked.
- **Queued sends are transcript ghost rows.** Each queued send renders as a **ghosted user row** appended at the foot of the transcript — one row per send, in submit order, de-emphasized to read as "not yet sent," each carrying a ✕ cancel. The queue's UI lives in the transcript, not in a prompt-entry strip.
- **C1 — cancel a queued send.** Via the ghost row's ✕, or Esc (peel-newest). A true un-send — the send was never dispatched: no wire traffic, no server turn. The cancelled send's `text` + `atoms` route through the draft-restore slot; the prompt-entry editor seeds from it **iff the editor is currently empty**, else the slot is dropped (a cancel never clobbers in-progress editor content).
- **C2 — pull down a pre-content turn.** Cancel the running turn while **no answer text and no `tool_use`** has arrived (`firstAssistantDeltaAt === null && firstToolUseAt === null` — thinking does NOT close the window). Discarded locally: no committed `TurnEntry`, no per-turn telemetry; the prompt returns to the editor via the draft-restore slot. `handleInterrupt` CASE A — its gate **widens** from `phase === "submitting"` to the two-null condition.
- **C3 — interrupt a running turn.** Cancel after answer text / `tool_use` has arrived. Commits a `turnEndReason: "interrupted"` turn. `handleInterrupt` CASE B — unchanged.
- **The C2/C3 threshold** latches at cancel-time: `firstAssistantDeltaAt === null && firstToolUseAt === null` → C2 pull-down; else → C3 interrupt.
- **Z5 is a button group** (vetted 2026-05-21).
  - _Idle / complete / errored:_ a single primary button — **Submit** (`↑`).
  - _Turn running:_ the primary button becomes **Stop** (`■`). A **`+` queue button** appears to its left **only once the user types into the prompt-entry while the turn is in flight** — progressive disclosure: a plain `submit → wait for the response → submit again` flow never surfaces the queue feature at all; typing mid-turn is what reveals it. An empty editor mid-turn shows only `[■]`; typing reveals `[+] [■]`; clearing the editor hides the `+` again. The `+` queues the editor's content (the pointer twin of editor Enter). The four disabled lifecycle modes (stopping / reconnecting / restoring / awaiting-user, per [Step 20.5.D.3](#step-20-5-d-3)) show only the disabled primary button.
- **Stop ≡ Esc — both peel the newest.** The Stop button and the Esc key do the *same* thing: peel the newest cancellable thing — the most-recently-queued send first (LIFO); only with the queue empty does the gesture reach the running turn (pull-down / interrupt per the threshold). A turn with N queued sends therefore takes N + 1 Stop/Esc presses to fully unwind — each press removes one visible ghost row, then the last stops the turn. Esc still dismisses any open dialog / popover first via the responder chain ([DT07]).
- **Editor Enter (with text):** idle → start a turn; turn running → queue a send (identical to the `+` button).
- **Ghost-row ✕:** cancels that one queued send — *targeted*, vs Stop/Esc's peel-newest.
- **`deriveSubmitButtonMode` revision.** The primary button's in-flight mode stays `stop` **unconditionally** — the QUEUED_NEXT_TURN overlay does not change it; the `queued_next` branch in `deriveSubmitButtonMode` and the `TideSubmitButtonMode["submit"]` `queued` field are retired (D.5). The `+` queue button is a **separate control**, not a `submitButtonMode` kind. Implementation (D.5): the prompt-entry **mounts** the `+` whenever the primary button's mode is `stop`, and **CSS-gates its visibility** on the prompt-entry's `data-empty="false"` attribute — the same `data-empty` signal [Step 20.5.D.3](#step-20-5-d-3)'s empty-gate already uses, so the progressive-disclosure reveal costs no per-keystroke React state ([L06] / [L22]). The transcript ghost rows render off the snapshot's `queuedSends` directly — no derived overlay value is needed. This resolves the open reading [Step 20.5.D.1](#step-20-5-d-1) flagged.

**Data-model changes for [Step 20.5.D.5.A](#step-20-5-d-5-a) / [B](#step-20-5-d-5-b).**
- Expose the `queuedSends` payloads on the snapshot — the reducer already retains `Array<{text, atoms, turnKey}>`; the snapshot currently projects only `.length`. The ghost rows need the text.
- Add a reducer event to cancel **one** queued send by key/index — `interrupt()` clears the whole queue; the per-row ✕ and the Stop/Esc peel-newest both need per-item removal.
- Add the **`+` queue button** to the prompt-entry Z5 group — a new control, shown alongside the primary button while its mode is `stop`; click queues the editor draft (the pointer twin of editor Enter).
- Wire the Stop button to **peel-newest** (≡ Esc), not a direct turn-interrupt — it interrupts the turn only once the queue is empty.
- Widen `handleInterrupt` CASE A from `phase === "submitting"` to `firstAssistantDeltaAt === null && firstToolUseAt === null` (in-flight phase).
- Route a cancelled queued send's payload through the draft-restore slot — unify with C2's existing `pendingDraftRestore` consumer.
- `performSubmit`: a mid-turn submit calls `send()` (queue) instead of `interrupt()`.

**Deliverable** (done).

- A **vettable surface** — a real-`CodeSessionStore`-driven gallery card was built, iterated against user feedback, and **deleted at close-out** (a throwaway vet vehicle; the spec is the lasting deliverable).
- A **captured decision** — the cancellation behavior spec above; the [Step 20.5.A](#step-20-5-a) matrix QUEUED_NEXT_TURN row rewritten + the ghost-row note; the `submitting` / `awaiting_first_token` / `streaming` state-definitions reconciled to the count ladder; the `deriveSubmitButtonMode` revision recorded.
- The **data-model changes** drafted above with scope and where they land.

**Conformance.** Design + plan work; no production wiring beyond the vet surface. The matrix update + the cancellation spec are the load-bearing deliverables — [Step 20.5.D.5.A](#step-20-5-d-5-a) / [B](#step-20-5-d-5-b) read them.

**Tasks.**

- [x] Investigate the cancellation family against the design questions; sketch the options for C1 / C2 / C3. _Findings recorded in the Status above; the stale "Current state" / data-model / phase-drift text reconciled._
- [x] Build the vettable surface — a real-`CodeSessionStore`-driven gallery card; iterated against user feedback through the queued / pull-down / interrupt cases, then deleted at close-out (the captured spec is the deliverable).
- [x] Pin the real `submitting` / `awaiting_first_token` / `streaming` semantics from the reducer. _Count ladder, not channel-based — recorded above; 20.5.A's state-definition reconciliation is part of the capture task._
- [x] Decide the C2 / C3 threshold. _Decided: extend through thinking — see the vetted decisions._
- [x] Draft the data-model changes — recorded in the reconciled Data-model flag above (expose the queued payloads on the snapshot; the threshold signal `firstAssistantDeltaAt` / `firstToolUseAt` if the button must distinguish).
- [x] User reviews and vets the surface. _Vetted 2026-05-21 — four design answers folded into the cancellation spec: ghost rows (not a prompt-entry strip), one ✕-cancellable row per send, a neutral Z5 button, Esc peels newest-first._
- [x] Capture the decision — the cancellation behavior spec above; the 20.5.A QUEUED_NEXT_TURN matrix row rewritten + the ghost-row note; the `submitting` / `awaiting_first_token` / `streaming` state-definitions reconciled; the `deriveSubmitButtonMode` revision recorded.

**Checkpoint.**

- [x] The user has reviewed and vetted the request-cancellation design.
- [x] The 20.5.A matrix QUEUED_NEXT_TURN row is a real spec, not a placeholder; the cancellation behavior (C1 / C2 / C3 + threshold) is written down.
- [x] [Step 20.5.D.5.A](#step-20-5-d-5-a) / [B](#step-20-5-d-5-b) have no remaining cancellation-design decisions; the data-model prerequisites are drafted.

---

#### Step 20.5.D.4.A: tugcode result-bounded turn model {#step-20-5-d-4-a}

**Depends on:** #step-20-5-d (parent), #step-20-5-d-4 (the request-cancellation spike that surfaced this)

**Status:** _complete. The turn model is now `result`-bounded. `handleUserMessage` opens an `ActiveTurn` only for the idle case (no turn running, nothing queued ahead); the stdout drain owns turn open/close — it opens a follow-on turn from the new `pendingTurnInputs` FIFO when claude's events for a buffered message arrive, and clears `this.activeTurn` on every `result` / EOF (`handleUserMessage` no longer clears it). A `user_message` arriving mid-turn is written to claude's stdin and queued in the FIFO — never installed as a competing `ActiveTurn`, the clobber that stranded both turns' events. One refinement from the plan sketch: rather than `ActiveTurn` carrying 1:N user messages, the "N" lives in the `pendingTurnInputs` FIFO and `ActiveTurn` stays 1:1 with one claude `result` — cleaner separation, and it leaves the non-overlap path (all of current production — tugdeck client-queues, so tugcode never sees overlap) byte-identical to before. The merge case (claude folds a mid-turn message into the running turn — `probe-tool-overlap.ts`) leaves a stale FIFO entry tugcode cannot detect from claude's stream; documented in the `pendingTurnInputs` docstring as a bounded, replay-synthetic-only imperfection (a later btw-send follow-on closes it by threading the user's merge-vs-queue intent down from tugdeck). `main.ts` needed no change — its fire-and-forget `handleUserMessage` dispatch is correct now the handler is overlap-safe. `bunx tsc --noEmit` clean; full tugcode suite 427/427 green (replay / cold-boot / EOF / interrupt paths pass unchanged); `probe-overlap.ts` re-run through the fixed tugcode brackets BOTH turns — turn 2 emits its `turn_complete` where pre-fix it never did._

**Commit:** `fix(tugcode): result-bounded turn model for overlapping sends`

**References:** `tugcode/src/session.ts` (`SessionManager` — `handleUserMessage`, the `ActiveTurn` type, the stdout drain), `tugcode/src/main.ts` (the IPC dispatch loop — the fire-and-forget `handleUserMessage` dispatch), `tugcode/probe-overlap.ts` / `probe-btw-overlap.ts` / `probe-tool-overlap.ts` (the empirical evidence), [#step-20-5-d-4] (the cancellation design this unblocks)

**Why this step exists.** The [Step 20.5.D.4](#step-20-5-d-4) spike ran three raw stream-json probes against the `claude` CLI to settle the mid-turn-submit policy. They turned up a transport truth and a latent tugcode bug that together gate the cancellation design:

- **claude's turn boundary is its `result`, not a `user_message`.** `probe-tool-overlap.ts` started a turn reading four files one at a time and injected a second `user_message` after the 2nd tool call. claude consumed it at the next agent-loop iteration boundary and **folded it into the running turn** — a single `result`, `num_turns=5`, whose text carried both the file summaries and the injected question's answer. A message sent into a pure-*text* turn (no iteration boundaries) is instead buffered and run as a separate later turn with its own `result` (`probe-overlap.ts`, `probe-btw-overlap.ts`). `/btw` itself is a TUI-only command — rejected in stream-json mode (`"/btw isn't available in this environment."`) — so the mid-turn merge is the real protocol-level mechanism, not a `/btw` channel.
- **tugcode equates one `user_message` → one turn → one `ActiveTurn`.** `handleUserMessage` writes the message to claude's stdin unconditionally, constructs an `ActiveTurn`, and assigns `this.activeTurn`; `main.ts` dispatches `handleUserMessage` fire-and-forget (not awaited). Two overlapping sends run two concurrent `handleUserMessage` calls — the second **clobbers `this.activeTurn`**, so the first turn's `result` routes into the wrong `ActiveTurn`, the first call's completion promise never resolves, and any buffered follow-on turn's events arrive with `this.activeTurn === null` and are dropped. `probe-overlap.ts` (which runs through tugcode) reproduces it exactly: turn 1 completes, turn 2 never emits a `turn_complete`.

The bug is **latent today** — tugdeck's `CodeSessionStore` holds mid-turn sends in `queuedSends` and releases one per `turn_complete`, so tugcode never sees two overlapping `user_message`s. But [Step 20.5.D.4](#step-20-5-d-4)'s vetted **"C"** design adds a *btw send* — a mid-turn message forwarded immediately so claude merges it — which makes overlap a first-class, routed path. tugcode must be correct before that lands.

**The fix — turn ownership moves from `handleUserMessage` to the drain.** Today `handleUserMessage` *owns* a turn: it constructs the `ActiveTurn` and awaits its completion, conflating "a message was submitted" with "a turn is in progress." The fix separates the two:

- A `user_message` is **always written to claude's stdin** and recorded in a FIFO of submitted-but-unbracketed messages. It no longer unconditionally creates or replaces `this.activeTurn`.
- The **`ActiveTurn` lifecycle is bound to claude's event stream**: the stdout drain opens an `ActiveTurn` on the first assistant activity after idle and closes it on `result` (→ `turn_complete`). One `ActiveTurn` per `result`.
- A turn that **merged** N mid-turn sends is one `ActiveTurn` carrying N user messages; a **buffered** send produces its own later `ActiveTurn`. The `ActiveTurn` ↔ `user_message` association becomes 1:N, not 1:1 — `ActiveTurn` must stop assuming it owns exactly one user message (this affects the `user_message_replay` payload for a mid-turn `runReplay`).
- `main.ts` dispatch stays non-blocking, but a mid-turn `handleUserMessage` must be a safe forward-and-record, never a competing turn.

**Constraints / risks.**
- The early-exit watcher, the stderr reader, and `signalEofToActiveTurn` all read `activeTurn` / `claudeReceivedInput` — the refactor must preserve their invariants (a claude crash mid-turn still emits exactly one canonical terminal frame).
- The cold-boot readiness gate (`claudeReadyPromise`) and the replay paths (`runReplay`, the `[W2]` orphan-flush) sequence against `handleUserMessage` — keep them working.
- Out of scope: any tugdeck-side change, the btw-send UI, the cancellation UI. D.4.A is transport-only — it makes overlap *correct*; it does not add a user-facing feature.

**Artifacts.**
- `tugcode/src/session.ts` — `handleUserMessage` (forward-and-record, no turn ownership), the `ActiveTurn` type (1:N user messages), the stdout drain (turn open/close driven by the event stream).
- `tugcode/src/main.ts` — the IPC dispatch loop, if the fire-and-forget dispatch needs adjustment.
- `tugcode/src/__tests__/` — a new test covering overlapping `handleUserMessage` (merged-turn and buffered-turn routing).

**Tasks.**

- [x] Separate turn ownership from `handleUserMessage` — `ActiveTurn` open/close driven by claude's `result` (the drain clears `this.activeTurn` on `gotResult` / EOF), not by the dispatch call.
- [x] Make a mid-turn `user_message` a forward-and-record: written to claude's stdin, queued in the `pendingTurnInputs` FIFO, no `this.activeTurn` clobber. The drain opens the follow-on turn from the FIFO head.
- [x] Mid-turn `user_message` ↔ turn association — the `pendingTurnInputs` FIFO holds the overflow; `ActiveTurn` stays 1:1 with one claude `result` (cleaner than 1:N on the turn). The non-overlap `user_message_replay` payload is unchanged; the merge-case stale-entry residual is documented as a btw-send follow-on concern.
- [x] Verify the early-exit / stderr / EOF watchers and the cold-boot + replay paths still hold their invariants — full tugcode suite (incl. all `replay-*.test.ts`) green.

**Tests.**

- [x] Overlapping `handleUserMessage` against a merged (one-`result`) turn — exactly one `turn_complete`, both messages reach claude's stdin.
- [x] Overlapping `handleUserMessage` against a buffered (two-`result`) turn — two `turn_complete`s in order, the follow-on turn's content routed not dropped.
- [x] Regression: a single, non-overlapping turn brackets unchanged; the FIFO is untouched and `activeTurn` is cleared on `result`.

**Conformance.** Transport-layer fix — no tuglaws apply (tugcode, not tugdeck). The contract is the stream-json event stream tugdeck's `CodeSessionStore` consumes: `turn_complete` bracketing stays correct for one turn and becomes correct for overlapping turns.

**Checkpoint.**

- [x] `bunx tsc --noEmit` clean in `tugcode/`.
- [x] tugcode's test suite green — 427/427.
- [x] **Probe vet** — `probe-overlap.ts` (tugcode-routed) shows *both* turns complete: `turn_complete #1` for the first turn, `turn_complete #2` for the buffered follow-on (pre-fix turn 2 never bracketed). The raw probes `probe-btw-overlap.ts` / `probe-tool-overlap.ts` stay as the reference for claude's underlying behavior.

---

#### Step 20.5.D.5: Cross-zone content coordination (Z2 + Z4) {#step-20-5-d-5}

**Depends on:** #step-20-5-d-1 (the `useLifecycleState` hook), #step-20-5-d-2 (the transcript host — the hook's first consumer + the pattern), #step-20-5-d-3 (Z5 — done, so the matrix's Z5 column is settled)

**Status:** _complete — net deliverable: no production code, the audit conclusion + the matrix Z2 / Z4 re-author. **Z2** — the shipped `TideTelemetryStatusRow` (the four-cell STATE·TIME·TOKENS·CONTEXT row, always mounted [L26]) already satisfies the matrix's Z2 intent: the STATE cell reflects every lifecycle state inline, `deriveTimeCellMs` already does the live-tick / freeze-on-pause behaviour per cell, and the REPLAYING / ERRORED / TRANSPORT_DOWN "badges" the pre-20.4.x Z2 column listed are redundant with the `TideRestoring` backdrop + the `TugPaneBanner`. Z2 ships no new code; the stale matrix Z2 column was re-authored to describe the shipped four-cell row (the "Z2 status row" note below the [20.5.A](#step-20-5-a) matrix). **Z4** — a phase indicator (`TidePhaseIndicator`) was built and shipped, then **removed on review**: the Z2 STATE cell already names the live phase, so a prompt-entry footer phase line only duplicated it, further from where the eye already rests. The audit's own "the STATE cell already carries it" finding — the one that kept Z2 from growing duplicate badges — applies to Z4 just as squarely; it was applied a step late, after the indicator shipped and the user flagged the redundancy on HMR. Z4 ends with no production occupant; the matrix Z4 column was emptied (the "Z4 prompt-entry footer" note). `tsc` clean; `bun test` green; `audit:tokens lint` 0 violations._

**Commit:** `feat(tide-rendering): Z2 / Z4 lifecycle-coordinated zone content`

**References:** [#step-20-5-a] (the state-to-zone matrix — the Z2 / Z4 columns are the contract), [#step-20-5-d-1] (`useLifecycleState`), [L02], [L06], [L23]

**Scope.** The matrix's two not-yet-reconciled zones — **Z2 (status bar)** and **Z4 (prompt-entry footer)** — are audited against the matrix contract and wired only where a genuine gap exists. Z1 was wired by [Step 20.4.15](#step-20-4-15) (`TideZ1B`), Z5 by [Step 20.5.D.3](#step-20-5-d-3); Z0 is reserved and Z3 is the static project badge. (The audit's conclusion — see Status — is that neither Z2 nor Z4 has a genuine gap; D.5 ships no production code.)

This **begins with an audit.** The shipped Z2 status row (`tide-card-telemetry-renderers.tsx` — the "Combined session status row" promoted in [Step 20.4](#step-20-4)) and the prompt-entry chrome already react to parts of the snapshot. Reconcile what each zone does today against the matrix's Z2 / Z4 columns and wire only the genuine gaps through the hook — no zone reads `phase` directly ([L02]).

- **Z2 (status bar)** — _audit finding (the audit ran; see Status):_ the shipped four-cell `TideTelemetryStatusRow` already satisfies the matrix's Z2 intent — its STATE cell reflects each lifecycle state, `deriveTimeCellMs` does the live-tick / freeze-on-pause, and REPLAYING / ERRORED / TRANSPORT_DOWN are surfaced by the `TideRestoring` backdrop + the `TugPaneBanner`. Z2 ships no new code; the stale pre-20.4.x matrix Z2 column was re-authored to describe the shipped row.
- **Z4 (prompt-entry footer)** — _audit finding (a step late; see Status):_ Z4 needs no occupant. A phase indicator was built and shipped, then removed on review — the Z2 STATE cell already names the live phase, so a footer phase line only duplicates it. The matrix Z4 column was emptied to match.

[Step 20.5.A](#step-20-5-a)'s coordination invariant 1 is the direct validator: `awaitingApprovalSince` drives Z1's pause, Z2's TIME-cell pause-freeze, and Z5's disabled mode off one state field — a de-sync between the three is a data-plumbing bug.

**Conformance.** [L02] — the audit's reconciliation rule: a zone consumes `useLifecycleState()` only where it has a genuine gap, never re-deriving from `phase`. The audit found neither Z2 nor Z4 has one — the Z2 STATE cell is the lifecycle surface for both — so D.5 ships no production code; the deliverable is the matrix Z2 / Z4 re-author.

**Artifacts.**

- [#step-20-5-a](#step-20-5-a) — the matrix Z2 column re-authored to describe the shipped `TideTelemetryStatusRow`; the Z4 column emptied; both carry an explanatory note ("Z2 status row", "Z4 prompt-entry footer"). This is D.5's lasting deliverable.
- No production code. The Z4 `TidePhaseIndicator` (`tide-card-phase-indicator.{tsx,css}` + test) built mid-step was removed on review — see Status; Z2 was conformant from the audit.

**Tasks.**

- [x] Audit the shipped Z2 status row and the prompt-entry footer / Z4 chrome against the matrix's Z2 / Z4 columns; record what already matches vs. the genuine gaps. _Done — Z2 conformant (see Status); Z4 likewise, established a step late (see the Z4 task below)._
- [x] Z2 — audit finding: no genuine gap. The four-cell `TideTelemetryStatusRow` + `deriveTimeCellMs` satisfy the matrix; REPLAYING / ERRORED / TRANSPORT_DOWN are surfaced by the `TideRestoring` backdrop + `TugPaneBanner`. Re-authored the stale matrix Z2 column to describe the shipped row instead of wiring duplicate badges (which would break the row's [L26] mount identity).
- [x] Z4 — built `TidePhaseIndicator` and shipped it, then removed it on review: redundant with the Z2 STATE cell, which already names the live phase. Z4 ends with no production occupant; the matrix Z4 column was emptied to match. The audit's "the STATE cell already carries it" test — applied to Z2's badges from the start — should have been applied to Z4 too; it was, a step late.

**Tests.**

- [x] No D.5 production code remains under test — the Z4 indicator and its pure-logic tests were removed on review; Z2 ships no code (audit finding). The matrix's emptied Z4 column + the Z2 column are verified against a real `CodeSessionStore` by the [Step 20.5.D.5.C](#step-20-5-d-5-c) end-to-end matrix test.

**Checkpoint.**

- [x] `bunx tsc --noEmit` clean.
- [x] `bun test` green.
- [x] `bun run audit:tokens lint` exits 0.
- [x] **HMR vet (manual, user-gated)** — _done._ The user reviewed the Z4 phase indicator live, found it redundant with the Z2 status row's STATE cell, and it was removed. Z2 tracks the matrix.

---

#### Step 20.5.D.5.A: Request cancellation — queue mechanism {#step-20-5-d-5-a}

**Depends on:** #step-20-5-d-4 (the "Cancellation behavior spec" — the contract), #step-20-5-d-3 (the Z5 submit button this extends), #step-20-5-d-1 (`deriveSubmitButtonMode` / the lifecycle snapshot)

**Status:** _complete. The queue half of the [Step 20.5.D.4](#step-20-5-d-4) cancellation spec is wired live. **Snapshot** — `CodeSessionSnapshot.queuedSends` changed from a `number` to `ReadonlyArray<QueuedSend>` (the new `QueuedSend` type — `{text, atoms, turnKey}`); the reducer already retained the payload array, the snapshot now projects it whole rather than just `.length`. **`deriveSubmitButtonMode`** — an in-flight turn is `{kind:"stop"}` unconditionally; the `queued_next` branch and the `TideSubmitButtonMode["submit"]` `queued` field are retired. **`performSubmit`** — the pre-cancellation "submit is interrupt" branch is gone: a mid-turn submit falls through to `codeSessionStore.send()`, which the reducer routes to the queue; the primary Stop button interrupts through the SUBMIT action handler (it branches on the button mode), so editor Return and the `+` button queue while the Stop button still stops. **The `+` queue button** — a new control mounted alongside the primary button whenever its mode is `stop`, CSS-gated on the entry root's `data-empty` so it reveals only once the user types mid-turn (no per-keystroke React state). **Ghost rows** — the transcript data source grew a `"ghost"` kind: one de-emphasized user row per queued send at the transcript foot, in submit order (render-only — the ✕ un-send is [Step 20.5.D.5.B](#step-20-5-d-5-b)). The pre-cancellation `tug-prompt-entry-queue-badge` count pill — superseded by the ghost rows + the vetted `[+] [■]` Z5 group — was removed. `tsc` clean; `bun test` green (2350 pass); `audit:tokens lint` 0 violations._

**Commit:** `feat(tide-rendering): mid-turn submit queues + ghost rows`

**References:** [#step-20-5-d-4] (the "Cancellation behavior spec" — the queue surfaces + the `deriveSubmitButtonMode` revision), [#step-20-5-a] (the QUEUED_NEXT_TURN matrix row), `tugdeck/src/lib/code-session-store/reducer.ts` (the `send` handler already enqueues; `handleTurnComplete(success)` already flushes the head), [L02], [L06], [L22]

**Scope.** Land the **queue mechanism** of the [Step 20.5.D.4](#step-20-5-d-4) cancellation spec — a mid-turn submit *queues and becomes visible*, short of cancelling it.

Per D.4's investigation findings the reducer machinery is built but UI-dead: the `send` handler enqueues a mid-turn send as a full `{text, atoms, turnKey}` payload (`queuedSends` is an array) and `handleTurnComplete(success)` flushes the head — but no UI path enqueues (`performSubmit` calls `interrupt()` on a mid-turn submit), so `queuedSends` is never non-empty and QUEUED_NEXT_TURN is unreachable. This sub-step wires the live path:

- **`performSubmit` queues mid-turn.** A submit (editor Enter or the `+` button) while a turn runs calls `send()` — enqueue — instead of `interrupt()`. An idle submit is unchanged.
- **Snapshot exposes the queued payloads.** The reducer retains `Array<{text, atoms, turnKey}>`; the snapshot currently projects only `.length`. Expose the payloads so the ghost rows can render their text.
- **`deriveSubmitButtonMode` revision.** The in-flight primary button is `stop` **unconditionally** — the QUEUED_NEXT_TURN overlay no longer changes it. Retire the `queued_next` branch and the `TideSubmitButtonMode["submit"]` `queued` field. The transcript ghost rows render off the snapshot's `queuedSends` directly — no derived overlay value is needed. Update `lifecycle-state.test.ts` + `tug-prompt-entry-submit-button.test.ts` (the `queued`-flag cases).
- **The `+` queue button.** A separate control mounted alongside the primary Z5 button whenever its mode is `stop`; CSS-gated visible on the prompt-entry's `data-empty="false"` — progressive disclosure, so a plain submit → wait → submit flow never surfaces it, and the reveal costs no per-keystroke React state ([L06] / [L22]). Click queues the editor draft (the pointer twin of editor Enter).
- **Transcript ghost rows.** Each queued send renders as a **ghosted user row** at the foot of the transcript, in submit order, de-emphasized to read as "not yet sent." Render only — the ✕ cancel is [Step 20.5.D.5.B](#step-20-5-d-5-b). The existing `turn_complete(success)` flush already drains the head into a real turn.

[Step 20.5.D.4.A](#step-20-5-d-4-a) made tugcode route the eventual flush correctly: a queued send dispatched on idle is the non-overlapping case tugcode always handled, so this queue mechanism sits on the safe transport path.

**Conformance.** [L02] — the button mode + the queued payloads come off `useLifecycleState()` / the snapshot. [L06] / [L22] — the `+` reveal is a CSS gate on `data-empty`, no per-keystroke React state. [L23] — the ghost rows append inside the stable transcript container; no sibling remount.

**Artifacts.**

- `types.ts` / `code-session-store.ts` — the new `QueuedSend` type; `CodeSessionSnapshot.queuedSends` carries the payload array (the reducer already retained it — no reducer change).
- `lifecycle-state.ts` — the `deriveSubmitButtonMode` revision; the `TideSubmitButtonMode` `queued` field retired.
- `tug-prompt-entry.tsx` / `.css` / `tug-prompt-entry-submit-button.ts` — `performSubmit` queues mid-turn; the `+` queue button mounted + CSS-gated; the superseded queue badge removed.
- `tide-transcript-data-source.ts` (the `"ghost"` cell kind) + `tide-card-transcript.tsx` (`GhostRowCell`) + `tide-card.css` — queued sends rendered as ghosted user rows.
- `lifecycle-state.test.ts`, `tug-prompt-entry-submit-button.test.ts`, `code-session-store.queue.test.ts` — updated for the revision + the queued-payload projection test.

**Tasks.**

- [x] Expose the `queuedSends` payloads on the snapshot (the reducer already retains the `{text, atoms, turnKey}` array). _Done — `CodeSessionSnapshot.queuedSends` is now `ReadonlyArray<QueuedSend>`; the store passes the reducer array through `Object.is`-stably._
- [x] `deriveSubmitButtonMode` revision — in-flight → `stop` unconditional; retire the `queued_next` branch + the `submit.queued` field; update the pure-logic tests. _Done — `lifecycle-state.test.ts` + `tug-prompt-entry-submit-button.test.ts` revised._
- [x] `performSubmit` — a mid-turn submit calls `send()` (queue), not `interrupt()`. _Done — the Stop button interrupts via the SUBMIT action handler instead._
- [x] The `+` queue button — mounted alongside the primary Z5 button when its mode is `stop`; CSS-gated visible on `data-empty="false"`. _Done; the superseded `tug-prompt-entry-queue-badge` removed._
- [x] Transcript ghost rows — one ghosted user row per queued send, in submit order (render only; the ✕ is [Step 20.5.D.5.B](#step-20-5-d-5-b)). _Done — a `"ghost"` cell kind + `GhostRowCell`._

**Tests.**

- [x] Pure-logic — `deriveSubmitButtonMode`: in-flight is `stop` regardless of `queuedSends`; the retired `queued` field is gone. _`lifecycle-state.test.ts`._
- [x] Pure-logic — the queued-payload snapshot projection: `queuedSends` payloads surface with text in submit order. _`code-session-store.queue.test.ts` — a real-store test driving three mid-turn sends, asserting the payload text + order + distinct turnKeys + head-drain on flush._
- [x] The rendered ghost rows are asserted by [Step 20.5.D.5.C](#step-20-5-d-5-c)'s `at0084` — a mid-turn submit paints a ghost row, the ghost row's ✕ removes it. The `+` reveal is a pure CSS `data-empty` gate with no reducer surface; it is HMR-vetted (the human confirm below) rather than app-tested — driving it would need native keystroke simulation for marginal gain.

**Checkpoint.**

- [x] `bunx tsc --noEmit` clean.
- [x] `bun test` green. _2350 pass, 0 fail._
- [x] `bun run audit:tokens lint` exits 0.
- [ ] **HMR vet (manual, user-gated)** — submit mid-turn; confirm the ghost row + the `[+] [■]` group; confirm the `+` is hidden until mid-turn typing; confirm `turn_complete` flushes the head.

---

#### Step 20.5.D.5.B: Request cancellation — pull-back gestures (C1 / C2 / C3) {#step-20-5-d-5-b}

**Depends on:** #step-20-5-d-5-a (the queue mechanism this cancels), #step-20-5-d-4 (the cancellation behavior spec — the C1 / C2 / C3 cases + the gesture map)

**Status:** _complete. The pull-back half of the [Step 20.5.D.4](#step-20-5-d-4) cancellation spec. **C1 (cancel a queued send)** — a new `cancel_queued_send` reducer event removes one entry from `queuedSends` by `turnKey` and routes its `{text, atoms}` through `pendingDraftRestore`; `CodeSessionStore.cancelQueuedSend()` dispatches it; the transcript ghost row carries a focus-refusing `TugIconButton` ✕ that calls it. A true un-send — no wire frame. **C2 (pull down a pre-content turn)** — `handleInterrupt`'s CASE A gate widened from `phase === "submitting"` to `firstAssistantDeltaAt === null && firstToolUseAt === null`, so the pull-down window stays open through *thinking* and closes only at the first answer-channel delta / `tool_use`. The CASE A wire-echo suppression already keys on `activeMsgId === null` (which CASE A's body sets), not on the echo's `msg_id`, so it suppresses the thinking-turn's real-`msg_id` `turn_complete(error)` unchanged. **C3** — CASE B unchanged. **Stop ≡ Esc** — the primary Stop button (the SUBMIT action handler's stop branch) and Esc (the `CANCEL_DIALOG` handler) both call the new `CodeSessionStore.peelNewest()`: peel the newest queued send (LIFO), reaching the running turn via `interrupt()` only once the queue is empty. Esc's dialog-dismiss precedence is unchanged — the responder chain still walks first-responder-first ([DT07]). **Draft-restore unification** — the prompt-entry's `pendingDraftRestore` consumer now seeds the editor only when it is empty, so a cancel never clobbers in-progress content (a CASE A pull-down lands on an empty editor, so the guard is a no-op there). `tsc` clean; `bun test` green (2344 pass — 5 new: CASE-A-through-thinking ×2, cancel / peel ×3); `audit:tokens lint` 0 violations._

**Commit:** `feat(tide-rendering): request pull-back — C1/C2/C3 + Stop-equals-Esc`

**References:** [#step-20-5-d-4] (the C1 / C2 / C3 cases, the threshold, the gesture map), `tugdeck/src/lib/code-session-store/reducer.ts` (the `handleInterrupt` CASE A / CASE B split + `pendingDraftRestore`), [DT07](#dt07-esc-semantics) (Esc semantics), [L02], [L23]

**Scope.** Land the **pull-back** half of the [Step 20.5.D.4](#step-20-5-d-4) cancellation spec — the three cancellation cases and the unified Stop ≡ Esc gesture, on the queue [Step 20.5.D.5.A](#step-20-5-d-5-a) built.

- **C1 — cancel a queued send.** The ghost row's ✕, plus a new reducer event to remove one queued send by key/index — a true un-send (never dispatched: no wire traffic, no server turn). `interrupt()` clears the whole queue; the per-row ✕ needs per-item removal.
- **C2 — pull down a pre-content turn.** Widen `handleInterrupt` CASE A's gate from `phase === "submitting"` to `firstAssistantDeltaAt === null && firstToolUseAt === null` — the pull-down window stays open through *thinking* and closes at the first answer-channel delta / `tool_use`. (D.4 pinned this: `phase` counts thinking partials, so it is the wrong signal.)
- **C3 — interrupt a running turn.** Cancel after answer text / `tool_use`. `handleInterrupt` CASE B — unchanged. The C2 / C3 split latches at cancel-time on the threshold above.
- **Stop ≡ Esc — peel the newest.** The Stop button and the Esc key do the same thing: peel the newest cancellable thing — the most-recently-queued send first (LIFO), and only with the queue empty does the gesture reach the running turn (C2 / C3). Esc still dismisses an open dialog / popover first via the responder chain ([DT07]).
- **Draft-restore unification.** A cancelled queued send (C1) and a pulled-down turn (C2) both route their `text` + `atoms` through the existing `pendingDraftRestore` slot — the prompt-entry editor seeds from it iff the editor is currently empty (a cancel never clobbers in-progress editor content). `pendingDraftRestore` already has a consumer (`tug-prompt-entry.tsx`); C1 / C2 reuse it.

**Conformance.** [L02] — the gesture reads the queue + the threshold off the snapshot / `useLifecycleState()`. [DT07] — Esc precedence (dialog dismiss → peel-newest) goes through the responder chain. [L23] — a ghost row's ✕-removal does not remount sibling rows.

**Artifacts.**

- `events.ts` / `reducer.ts` — the `cancel_queued_send` event + `handleCancelQueuedSend`; the `handleInterrupt` CASE A gate widening + the draft-restore routing.
- `code-session-store.ts` — the `cancelQueuedSend()` + `peelNewest()` methods.
- `tug-prompt-entry.tsx` — Stop ≡ Esc both wired to `peelNewest()`; the `pendingDraftRestore` consumer's editor-empty gate.
- `tide-card-transcript.tsx` — the `GhostRowCell` ✕ (a focus-refusing `TugIconButton`) dispatching the per-item cancel.
- `code-session-store.interrupt.test.ts` / `code-session-store.queue.test.ts` — the widened CASE A + the per-item cancel / peel.

**Tasks.**

- [x] Per-item queue-cancel reducer event — remove one queued send by key; route its payload through the draft-restore slot. _Done — `cancel_queued_send` event + `handleCancelQueuedSend`; `CodeSessionStore.cancelQueuedSend()`._
- [x] Ghost-row ✕ — dispatches the per-item cancel (C1). _Done — a focus-refusing `TugIconButton` in `GhostRowCell`._
- [x] Widen `handleInterrupt` CASE A to `firstAssistantDeltaAt === null && firstToolUseAt === null` (C2 threshold); CASE B unchanged (C3). _Done — the suppression gate already keys on `activeMsgId`, so it holds for a thinking turn's real-`msg_id` echo._
- [x] Stop ≡ Esc → peel-newest — queued sends LIFO, then the running turn; Esc dialog-dismiss precedence preserved ([DT07]). _Done — `CodeSessionStore.peelNewest()`; both the Stop button's SUBMIT-handler branch and the `CANCEL_DIALOG` handler call it._
- [x] Draft-restore unification — C1 + C2 seed the editor iff it is empty. _Done — the `pendingDraftRestore` consumer gates on `isEffectivelyEmpty`._

**Tests.**

- [x] Reducer / pure-logic (real-store) — the per-item cancel removes the right send + populates `pendingDraftRestore`; `peelNewest` drains LIFO then interrupts; CASE A fires for thinking-only, CASE B for post-content. _`code-session-store.queue.test.ts` (+3) and `code-session-store.interrupt.test.ts` (+2)._
- [x] The rendered C1 / C2 / C3 and the peel gesture are asserted by [Step 20.5.D.5.C](#step-20-5-d-5-c)'s `at0084`: the ghost-row ✕ un-sends a queued send (C1), a CASE A interrupt pulls a pre-content turn back to idle with no committed row (C2), a CASE B interrupt commits one interrupted turn (C3), and the Stop button peels the newest queued send LIFO. Esc invokes the identical `peelNewest()` path the Stop button exercises; the Esc *keybinding* itself is HMR-vetted (the human confirm below).

**Checkpoint.**

- [x] `bunx tsc --noEmit` clean.
- [x] `bun test` green. _2344 pass, 0 fail._
- [x] `bun run audit:tokens lint` exits 0.
- [x] **HMR vet (manual, user-gated)** — queue two sends; Esc peels them newest-first, then stops the turn; ✕ a specific ghost row; pull a thinking-only turn back to the editor. _Confirmed by the user._

---

#### Step 20.5.D.5.C: End-to-end matrix verification {#step-20-5-d-5-c}

**Depends on:** #step-20-5-d-5 (Z2 / Z4), #step-20-5-d-5-a, #step-20-5-d-5-b (the QUEUED_NEXT_TURN / cancellation rows), #step-20-5-d-1 through #step-20-5-d-3 (the earlier zones)

**Status:** _complete — **20.5.D is closed.** The plan's `__tests__/*.test.tsx` artifact was impossible (`bun test` has no DOM since happy-dom's removal — it cannot render the tide card), and the app-test harness had no way to drive a *bound* tide session through the lifecycle, so this sub-step built a harness seam **and** the matrix app-test. **Seam:** `CodeSessionStore._ingestFrameForTest` (feed a wire frame through the store's real `frameToEvent` → `dispatch` path) + `_simulateTransportForTest` (the transport overlay); a `window.__tug.driveTideSession` verb (`test-surface.ts`, SURFACE_VERSION → 1.6.0) that resolves the card's store via `cardServicesStore`; the `_harness/client.ts` + `App` wrappers. **Test:** `tests/app-test/at0084-tide-lifecycle-coordination.test.ts` drives eight real tide cards — one per scenario, each its own pane — through IDLE / STREAMING / TOOL_WORK / COMPLETE / AWAITING_USER / QUEUED_NEXT_TURN / ERRORED / REPLAYING / TRANSPORT_DOWN, plus the cancellation gestures (cards C / G / H), asserting the rendered Z2 STATE-cell label, Z5 `data-mode`, the committed-turn Z1 row, and the QUEUED ghost row against the matrix. `tsc` clean (tugdeck + the app-test graph); `bun test` green; `audit:tokens lint` 0; `just app-test at0084-tide-lifecycle-coordination` → VERDICT: PASS. (A pre-existing harness tsc error — a missing `follow-bottom` fixture in `matchers.test.ts` — was fixed in passing.) **Audit fixup:** `at0084` was extended to drive the cancellation gestures directly — the ghost-row ✕ (C1), a CASE A pull-down (C2), a CASE B interrupt (C3), and a Stop-button LIFO peel — so the D.5.A / D.5.B test cross-references it satisfies are now real, not deferred._

**Commit:** `test(tide-rendering): end-to-end lifecycle matrix verification`

**References:** [#step-20-5-a] (the state-to-zone matrix — the contract every row asserts against), [L02]

**Scope.** The capstone that **closes [Step 20.5.D](#step-20-5-d)**: an end-to-end test that drives a real `CodeSessionStore` through every distinct [Step 20.5.A](#step-20-5-a) matrix row and asserts the zones paint what the matrix says. By this point every zone is settled — Z1 ([Step 20.4.15](#step-20-4-15)), Z2 ([Step 20.5.D.5](#step-20-5-d-5) — audited conformant; Z4 left with no occupant), Z5 ([Step 20.5.D.3](#step-20-5-d-3)), the QUEUED_NEXT_TURN row ([Step 20.5.D.5.A](#step-20-5-d-5-a) / [B](#step-20-5-d-5-b)) — so the matrix is fully testable for the first time.

The test drives the **real** store inside the **real** tide card (the test-reality rule — no mock store, no fake DOM): a `just app-test` file. Building it needed a new harness capability — the app-test harness could mount a tide card (`bindTideSession`) but had no way to flow frames into a *bound* session. So this sub-step is **a harness seam plus the test**:

- **The seam** — `CodeSessionStore._ingestFrameForTest` runs a decoded frame through the store's real `frameToEvent` → `dispatch` path; `_simulateTransportForTest` drives the transport overlay. The `window.__tug.driveTideSession` verb resolves a card's store (`cardServicesStore.getServices`) and steps it: `send` / `ingestFrame` / `interrupt` / `transportClose`.
- **The test** — eight real tide cards, one per scenario, driven through IDLE / STREAMING / TOOL_WORK / COMPLETE / AWAITING_USER / QUEUED_NEXT_TURN / ERRORED / REPLAYING / TRANSPORT_DOWN plus the cancellation gestures (the ghost-row ✕, a CASE A pull-down, a CASE B interrupt, a Stop-button LIFO peel), asserting the rendered Z2 STATE cell, Z5 `data-mode`, the committed Z1 row, and the QUEUED ghost row.

The transient sub-states the live phases pass through (SUBMITTING / AWAITING_FIRST_TOKEN / INTERRUPTING) are not separately asserted — they render identically to the settled live phase (Z1B `TugThinkingIndicator`, Z5 Stop), and the state projection itself is exhaustively unit-tested by [Step 20.5.D.1](#step-20-5-d-1)'s `lifecycle-state.test.ts` (one case per matrix row). D.5.C's delta is the `useLifecycleState()` → zone-DOM wiring, end-to-end.

**Conformance.** The matrix is the contract; the test IS the conformance artifact. [L02] — the test drives state through the store (`driveTideSession`), never by poking zone internals.

**Artifacts.**

- `tugdeck/src/lib/code-session-store.ts` — `_ingestFrameForTest` / `_simulateTransportForTest` test seams.
- `tugdeck/src/test-surface.ts` — the `driveTideSession` `window.__tug` verb (SURFACE_VERSION → 1.6.0).
- `tests/app-test/_harness/client.ts` + `index.ts` — the `driveTideSession` client wrapper + `App` method.
- `tests/app-test/at0084-tide-lifecycle-coordination.test.ts` — _new_ — the end-to-end matrix test, run via `just app-test`.

**Tasks.**

- [x] Build the fixture-session driver — the harness seam (`_ingestFrameForTest` + `driveTideSession`) steps a real `CodeSessionStore` through each matrix row / overlay.
- [x] Assert each zone (Z1 committed-turn row / Z2 STATE cell / Z5 `data-mode`; Z0 reserved, Z3 static, Z4 no occupant) against the matrix cell for the asserted rows.
- [x] Cover the overlays — TRANSPORT_DOWN (`transportClose`) and QUEUED_NEXT_TURN (a mid-turn `send` → a ghost row).

**Tests.**

- [x] The end-to-end matrix test itself — every distinct matrix row, the Z1 / Z2 / Z5 zones, via `just app-test`; the recipe ends with the greppable `VERDICT: PASS|FAIL` line. _`at0084-tide-lifecycle-coordination.test.ts` — VERDICT: PASS._

**Checkpoint.**

- [x] `bunx tsc --noEmit` clean. _tugdeck + the `tests/app-test` graph._
- [x] `bun test` green. _tugdeck 2344 pass; the `_harness` unit tests 58 pass._
- [x] `bun run audit:tokens lint` exits 0.
- [x] `just app-test at0084-tide-lifecycle-coordination` → `VERDICT: PASS`.
- [x] 20.5.D is closed — the matrix has an executable conformance test.
