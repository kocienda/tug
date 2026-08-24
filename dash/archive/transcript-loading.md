<!-- devise-skeleton v4 -->

## Batch-the-wire transcript loading {#phase-batch-wire}

**Purpose:** Make cold transcript loads (resume + load-previous) fast by shipping the replay through the IPC pipe in coarse batches instead of one tiny delta frame at a time, and by dropping the 8ms live-streaming pacing on the cold path — without touching the reducer, the live-streaming path, or the rendered result.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-06-16 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The IPC pipe between tugcode and tugdeck was built for **live streaming**: a remote model dribbles tokens, each delta becomes a discrete IPC frame that propagates immediately for live feel. On a **cold load** we already have the whole session on disk, yet `translateJsonlSession` re-atomizes it into the *same* per-delta frames a live model would have produced, paces them at 8ms (`DEFAULT_TIME_SLICE_MS`), and pushes each one through four process boundaries individually: a serialized `Bun.write` syscall (tugcode `ipc.ts`), a `read_line`/splice/`Frame::new`/broadcast hop (tugcast), one WebSocket message, and one browser decode+dispatch.

Instrumentation on session `c53db98c` (added in the measurement pass, `perf.replay_ingest`) settled where the cost actually is:

```
ms: 278   frames: 2084   dispatchMs: 3   reduceMs: 2   waitMs: 275
```

The browser folded all **2084 deltas in 2ms**. The reducer is essentially free; **99% of the ingest window (275ms of 278ms) is the browser sitting idle waiting for frames to trickle in.** The waste is entirely in *moving* the frames one-at-a-time and the pacing — not in the delta representation. This plan attacks exactly that: collapse the per-frame transport, drop the cold-path pacing. The rendered transcript and the reducer logic are untouched.

#### Strategy {#strategy}

- **Batch the wire, not the semantics.** The translator still produces the identical frame sequence; we only change *how many wire lines* carry it. A `replay_batch` envelope packs N frames into one IPC line.
- **tugcast needs zero changes.** `splice_tug_session_id` stamps the *outer* object's first field, and the CODE_OUTPUT relay forwards lines transparently — a batch envelope rides through unmodified.
- **The batch is a transport wrapper, not a reducer event.** It is unwrapped at the browser's FeedStore ingest boundary; each inner frame flows through the existing `frameToEvent` + `dispatch` path exactly as today. The reducer never learns batching exists.
- **Land the browser unwrap first** (backward-compatible), *then* the tugcode batching — so no version-skew window where a `replay_batch` frame reaches a browser that can't unwrap it.
- **De-pace the cold path only — and only if the measurement demands it.** Batching collapses the per-frame transport multiplicity that dominates the 275ms; the 8ms pacing plausibly adds little. Measure after batching ([P07]); if `waitMs` is already under target, skip de-pacing and its abort/timeout-test reconciliation entirely. If kept, drop the generator's yields for `inflight === null` and let the consumer pace at batch granularity.
- **Verify against the existing perf instrumentation.** Success is `waitMs` collapsing and tugcode's emitted wire-frame count dropping ~2084 → ~10, with the browser's dispatched-frame count unchanged (no semantic loss).

#### Success Criteria (Measurable) {#success-criteria}

- On reload of a real ≥50-turn session (e.g. `c53db98c`), `perf.replay_ingest.waitMs` drops from ~275ms to **< 50ms** (dev-panel, source `perf`).
- tugcode `perf.replay_translate.batches` (wire lines emitted) is **≈ ⌈content-frames / REPLAY_BATCH_SIZE⌉ + brackets** (~10 for this session), down from ~2084 individual `writeLine` calls.
- Browser `perf.replay_ingest.frames` (dispatched reducer events) is **unchanged** (~2084) — proves the batch carries every frame, no loss.
- The rendered transcript is byte-identical: turn count and content match the per-frame path (golden/contract replay tests stay green).
- Cancelling a load mid-flight still closes the bracket cleanly (`replay_complete{aborted:true}`) — no abort regression.

#### Scope {#scope}

1. A `replay_batch` outbound wire type in tugcode and the emit-loop refactor that buffers replay frames and flushes them as batches.
2. Cold-path de-pacing (`disableYield` for `inflight === null && replayTimeSliceMs === undefined`) with batch-granular cooperative yielding — **conditional**, implemented only if batching alone misses the target ([P07]).
3. The browser-side unwrap at the FeedStore ingest boundary (`onFeedStoreChange` + `_ingestFrameForTest`), routing inner frames through the existing dispatch.
4. Perf-line additions so the win is measurable (tugcode `batches`/`frames`; the browser side already reports `waitMs`).

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Render cost.** The ~665ms `perf.replay_render` for 46 rich rows is downstream of the store and identical under this change; it is a separate investigation.
- **The live-streaming path.** Live deltas are inherently incremental and are never batched; this plan only touches the JSONL replay loop.
- **Approach C (hydrate-don't-replay).** Forking restore onto a finished-turn data path is explicitly *not* this plan; the 2ms reduce number shows delta-folding isn't the cost, so replay stays.
- **Mid-stream-reload de-pacing.** Batching applies to all replays, but de-pacing is gated to cold (`inflight === null`); the live-tail interleaving case keeps today's pacing.

#### Dependencies / Prerequisites {#dependencies}

- The `perf.replay_ingest` (browser) and `perf.replay_translate` (tugcode) instrumentation from the measurement pass — already on main.
- tugcode is a bun-compiled binary (no HMR): batching steps require `bun build --compile … --outfile tugrust/target/debug/tugcode` before they take effect in a running app.

#### Constraints {#constraints}

- **Warnings are errors** across the Rust workspace; tugdeck must pass `bunx tsc --noEmit` clean.
- tugdeck laws apply to `code-session-store.ts`: external state still enters React through the store's `useSyncExternalStore` contract ([L02]); the change is in the store's wire-ingest routing, adds no new React state.
- The `writeTail` serialization in `ipc.ts` must remain the single ordering authority — a batch is one large line and must not interleave with other writes.

#### Assumptions {#assumptions}

- The FeedStore delivers CODE_OUTPUT frames **per-frame, synchronously** (`feed-store.ts`: each `onFrame` sets the map and notifies listeners inline) — so unwrapping a batch into N synchronous dispatches preserves ordering and loses nothing.
- `splice_tug_session_id` stamps only the outer object; inner frames of a batch carry no `tug_session_id` and don't need one (the session filter runs on the outer envelope at the feed boundary, before unwrap).
- BATCH_SIZE in the low hundreds keeps any single batch line well-bounded; the existing `writeTail` already handles >64KiB lines without interleave.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

Anchors are explicit, kebab-case, no phase numbers. Plan-local decisions are `[P01]`+ (never `[D01]`). Steps cite decisions/specs/anchors, never line numbers.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Single-frame flush: raw frame or 1-element envelope? (DECIDED) {#q01-single-frame-flush}

**Question:** When the buffer holds exactly one frame at a flush point (notably the bracket frames `replay_started` / `replay_complete`), do we emit it as a raw frame or wrap it in a 1-element `replay_batch`?

**Why it matters:** The browser mounts the replay paint gate on `replay_started` and flushes the fold on `replay_complete`; burying either inside a batch (or behind bulk content) delays the gate. Raw brackets also keep the wire shape for the common bracket frames identical to today, narrowing the blast radius.

**Resolution:** DECIDED (see [P03]). Flush emits a raw frame when the buffer holds one frame, and a `replay_batch` envelope only for ≥2 frames. Brackets are flushed standalone, so they always go raw.

#### [Q02] De-pacing mechanism: `disableYield` vs. large `timeSliceMs`? (DECIDED) {#q02-depace-mechanism}

**Question:** To drop the 8ms macrotask yields on the cold path, pass `disableYield: true` to `translateJsonlSession`, or pass a large `timeSliceMs`?

**Why it matters:** `disableYield: true` removes the generator's internal `await yieldToEventLoop()` entirely. The consumer's per-frame `Promise.race` resolves on microtasks, which do **not** let the macrotask-scheduled `timeout`/`abort` promises win — so the consumer's per-batch macrotask yield becomes the load-bearing abort/timeout point (and drains writes). A large `timeSliceMs` keeps the same machinery but rarely fires — strictly weaker and less explicit. The scoping clause (`replayTimeSliceMs === undefined`, see [P05]) is what keeps the calibrated tests on per-message yields.

**Resolution:** DECIDED (see [P05]). Use `disableYield: inflight === null && this.replayTimeSliceMs === undefined`; the consumer owns pacing at batch granularity. The `replayTimeSliceMs === undefined` clause keeps the calibrated tests (which set it to `0`) on per-message yields, so they need no rewrite.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Version skew: new binary emits `replay_batch` to a browser without unwrap | high | med | Land browser unwrap first; unwrap is backward-compatible | Any deploy where the binary is newer than the frontend |
| Bracket/fold timing: gate mounts late if `replay_started` is batched | med | low | Flush brackets as raw standalone frames ([P03]) | Replay paint gate visibly delayed |
| Abort/timeout responsiveness + calibrated tests under de-pacing | med | med | Per-batch macrotask yield as the load-bearing yield; reconcile the two calibrated tests; gate de-pacing on measurement ([P07]) | A mid-load cancel hangs; timeout/abort test flips |
| Session-level frame assertions break under batching | high | high | Capture-helper unwrap ([P08]) applied in the same step as batching | Any session-level stdout test fails to find an inner frame |
| Oversized batch line | low | low | Bound batch by frame count (REPLAY_BATCH_SIZE); `writeTail` already serializes >64KiB | Wire corruption / latency spike on image-heavy replays |

**Risk R01: version skew between binary and frontend** {#r01-version-skew}

- **Risk:** tugcode (new) emits `replay_batch`; tugdeck (old) has no unwrap → `frameToEvent` rejects the unknown `type`, the frame is dropped, the transcript loads empty.
- **Mitigation:** Step ordering — the browser unwrap ([#step-1]) lands before tugcode batching ([#step-2]). The unwrap is purely additive: single frames still take the existing path, so an old binary against a new frontend also works.
- **Residual risk:** None within this repo's ship model (frontend HMR updates first; binary requires an explicit rebuild that the implement flow performs after Step 1).

**Risk R02: bracket and fold timing** {#r02-bracket-timing}

- **Risk:** The browser mounts the paint gate on `replay_started` and flushes deferred notifications on `replay_complete`; packing either into a bulk batch delays first paint or the final flush.
- **Mitigation:** [P03] — brackets flush standalone as raw frames; only the bulk content between them batches.
- **Residual risk:** The gate now mounts when the first wire line arrives, which is already near-instant on a fast load.

**Risk R03: abort/timeout granularity and the calibrated tests** {#r03-abort-granularity}

- **Risk:** With `disableYield`, the generator stops yielding, so the `timeout`/`abort` promises can only win the `Promise.race` at the consumer's per-batch macrotask yield. The two `runReplay` tests (`replayTimeoutMs:1` + `replayTimeSliceMs:0`; `cancel_replay` over a 200-turn fixture) are calibrated to per-message yields; a naive `disableYield: inflight === null` would override their `replayTimeSliceMs:0` and break them.
- **Mitigation (primary):** Scope the guard to `inflight === null && this.replayTimeSliceMs === undefined` ([P05]). Production (slice undefined) is de-paced; the calibrated tests (slice `0`) keep per-message yields and **pass unchanged**. Make the per-batch macrotask yield explicitly load-bearing for production abort/timeout, and update the abort-invariant comment to "≤ one batch". Gate the whole step on [P07] so this risk is only taken if batching alone misses the target.
- **Mitigation (fallback):** Only if the scoped guard proves insufficient, rewrite both tests to assert batch-boundary interruption over a multi-batch fixture — accepting the timing-dependence that makes that the less-preferred path.
- **Residual risk:** Production abort/timeout is observed at batch boundaries (~`REPLAY_BATCH_SIZE` frames) rather than every 8ms — acceptable because the whole replay completes in tens of ms.

---

### Design Decisions {#design-decisions}

#### [P01] The batch is a transport envelope, not a reducer event (DECIDED) {#p01-transport-envelope}

**Decision:** `replay_batch` is unwrapped at the browser's FeedStore ingest boundary; each inner frame is routed through the unchanged `frameToEvent` + `dispatch` path. The reducer, the event union, and `KNOWN_CODE_OUTPUT_TYPES` (which gates *single-frame* reducer events) are not extended with a batch event.

**Rationale:**
- The measurement (`reduceMs: 2` for 2084 frames) proves delta-folding is free; there is no reason to change reducer semantics.
- Keeping the unwrap at the wire boundary means restore stays the single unified delta path that live streaming also uses — batching is invisible above the FeedStore.

**Implications:**
- The unwrap lives in `onFeedStoreChange` and `_ingestFrameForTest` (a shared `routeFrame` helper), not in `frameToEvent`.
- The reducer's replay fold and phase guards operate on dispatched inner events exactly as today.

#### [P02] tugcast is unchanged (DECIDED) {#p02-tugcast-unchanged}

**Decision:** No Rust changes. The batch envelope `{"type":"replay_batch","frames":[…]}` is relayed as an ordinary CODE_OUTPUT line.

**Rationale:**
- `splice_tug_session_id` scans for the first `{` and stamps `tug_session_id` as the outer object's first field — it operates on whatever JSON line tugcode emits, batch or not.
- The CODE_OUTPUT relay forwards lines verbatim; it never inspects `type`.

**Implications:**
- Fewer wire frames also reduces broadcast-channel lag pressure (`LagPolicy::Replay`) on slow clients — a free side benefit, not a goal.

#### [P03] Brackets flush raw; only bulk content batches (DECIDED) {#p03-brackets-raw}

**Decision:** `replay_started`, `replay_complete`, and any single-frame flush go out as raw frames; a `replay_batch` envelope is emitted only for ≥2 buffered frames.

**Rationale:** Preserves the browser's paint-gate mount on `replay_started` and the fold flush on `replay_complete`, and keeps the bracket wire shape identical to today.

**Implications:** The emit helper checks buffer length at flush; pending-row synthetics (injected right after `replay_started`) buffer with the following content rather than forcing the bracket into a batch.

#### [P04] Browser unwrap ships before tugcode batching (DECIDED) {#p04-order-unwrap-first}

**Decision:** Implement and land the browser unwrap ([#step-1]) before the tugcode emit batching ([#step-2]).

**Rationale:** Eliminates any window where a `replay_batch` frame reaches a browser that drops unknown types (R01). The unwrap is backward-compatible with the current per-frame emitter.

**Implications:** No feature flag or IPC-version gate is needed for the batch type.

#### [P05] De-pace cold replay only, consumer-driven (DECIDED) {#p05-depace-cold}

**Decision:** When de-pacing runs (gated by [P07]), pass `disableYield: inflight === null && this.replayTimeSliceMs === undefined` to `translateJsonlSession`; the consumer's per-batch macrotask yield becomes the sole cold-path yield point. Mid-stream reload (`inflight !== null`) keeps today's pacing.

**Rationale:**
- The cold path is the measured case and has no live-drain interleaving.
- The `&& this.replayTimeSliceMs === undefined` clause is the key reconciliation: `replayTimeSliceMs` is `number | undefined`, **undefined in production** (`session.ts` sets it only from options) and set to `0` only by the calibrated timeout/abort tests, whose sole documented purpose is test-determinism. Scoping de-pacing to "no explicit slice override" leaves those tests on their per-message yields — **they pass unchanged** — while production cold replay gets fully de-paced.

**Implications:**
- Pacing authority moves from the generator's 8ms timer to the consumer's batch cadence (production only).
- The per-batch `await yieldToEventLoop()` is **load-bearing for abort/timeout** in production, not just write-drain: with `disableYield` the generator never yields, so the `timeout`/`abort` promises can only win the `Promise.race` at a batch boundary. The `session.ts` abort-race invariant comment changes from "≤ one translator time-slice" to "≤ one batch".
- Because the calibrated tests set `replayTimeSliceMs: 0`, the guard leaves `disableYield` **false** in those tests — no test rewrite needed. A batch-boundary-interruption rewrite is the fallback only if the scoped guard proves insufficient (see #step-4).

#### [P06] REPLAY_BATCH_SIZE = 256 frames, count-thresholded (DECIDED) {#p06-batch-size}

**Decision:** Flush when the buffer reaches `REPLAY_BATCH_SIZE` (256) frames or at a bracket. The constant is a single named value, tunable later against real sessions.

**Rationale:** 256 collapses this session's ~2084 frames into ~8 batches + brackets while keeping each batch line bounded.

**Implications:** A follow-on may add a byte-size cap if image-heavy batches prove large; not needed for phase close.

#### [P07] De-pacing is gated on a batching-only measurement (DECIDED) {#p07-depace-gated}

**Decision:** Measure `waitMs` after batching alone (#step-3). Implement de-pacing (#step-4) only if `waitMs` is still materially above the <50ms target.

**Rationale:**
- The measured 275ms is per-frame transport multiplicity — 2084 separate WS messages + tugcast relay hops + browser tasks — which batching collapses directly to ~10 wire frames.
- The 8ms pacing is a handful of macrotask yields on the emit side and plausibly contributes little; de-pacing carries the abort/timeout test reconciliation ([P05], R03). Don't pay that risk unless the measurement says we must.

**Implications:** #step-4 is conditional; if skipped, the ledger records the #step-3 `waitMs` as the rationale and no abort/timeout test changes are needed.

#### [P08] Capture helper unwraps `replay_batch` (DECIDED) {#p08-capture-unwrap}

**Decision:** The `captureIpc` stdout-capture test helper unwraps a `replay_batch` line into its inner `frames` before pushing to the captured-frame list, mirroring the production browser unwrap ([P01]). The helper — currently duplicated across `replay-spawn.test.ts`, `session.test.ts`, and `rewind-bridge.test.ts` — is extracted to one shared test module and the unwrap applied once.

**Rationale:**
- Session-level tests assert on individual frames (`add_user_message`, `turn_complete`, …) parsed one-per-stdout-line. Batching makes intermediate content arrive as envelopes; without an unwrap those assertions break.
- Generator-level tests (iterating `translateJsonlSession`) are unaffected — batching lives in the consumer — so only the stdout-capture path needs this.

**Implications:** One shared helper change keeps the whole session-level suite green; the duplication is retired in the same step.

---

### Deep Dives (Optional) {#deep-dives}

#### Emit-side batching flow (tugcode) {#emit-flow}

The replay consumer loop in `SessionManager` (the `while (true)` racing `iter.next()` against timeout/abort/exit) currently calls `writeLine(msg)` per frame. The refactor introduces a frame buffer and a `flushBatch` closure:

- **Buffer + flush.** `flushBatch()` is a no-op on an empty buffer; emits the lone frame raw when length === 1; otherwise emits `{ type: "replay_batch", frames: <buffered>, ipc_version: <IPC_VERSION> }` and clears the buffer ([P03], [P06]).
- **Content frames.** Replace the per-frame `writeLine(msg)` with `buffer.push(msg)`; call `flushBatch()` when `buffer.length >= REPLAY_BATCH_SIZE`, then `await yieldToEventLoop()`. Under de-pacing this per-batch macrotask yield is the **only** point at which the `timeout`/`abort` promises can win the `Promise.race` — load-bearing, not just write-drain ([P05], [R03]).
- **`ipc_version`.** The `replay_batch` envelope uses the literal `2` (`IPC_VERSION` is not imported in `session.ts`).
- **`replay_started`.** Buffer is empty at this point (it's the first frame); push it and `flushBatch()` immediately so the gate mounts raw, *then* run the pending-row injection.
- **Pending-row synthetics.** `injectPendingRowSynthetics` currently writes directly; thread the buffer's emit through it (accept an emit callback, or push into the shared buffer) so synthetics land in order, batched with the content that follows.
- **`replay_complete`.** Flush the buffer first, then `writeLine` the buffered `replay_complete` raw — it stays the last line and triggers the browser fold flush.
- **Loop exit / finally.** Flush any remainder before the `perf.replay_translate` log.

`perf.replay_translate` **keeps `messages`** (asserted by `perf-instrumentation.test.ts`) and **adds** `batches` (wire lines emitted) and `frames` (inner frames) so the wire-frame collapse is directly measurable; `drain_ms` (added in the measurement pass) already reports flush time.

#### Browser unwrap flow (tugdeck) {#unwrap-flow}

`CodeSessionStore.onFeedStoreChange` iterates changed feeds and calls `frameToEvent` + `dispatch` per feed value. Introduce a private `routeFrame(feedId, value)` used by both `onFeedStoreChange` and `_ingestFrameForTest`:

```
private routeFrame(feedId, value) {
  if (feedId === FeedId.CODE_OUTPUT &&
      (value as { type?: string }).type === "replay_batch") {
    const frames = (value as { frames?: unknown }).frames;
    if (Array.isArray(frames)) {
      for (const inner of frames) {
        const event = this.frameToEvent(feedId, inner);
        if (event !== null) this.dispatch(event, "wire");
      }
      return;
    }
  }
  const event = this.frameToEvent(feedId, value);
  if (event !== null) this.dispatch(event, "wire");
}
```

The outer envelope already passed the session filter (it carries the spliced `tug_session_id`); inner frames are dispatched post-filter and need no tsid. Every inner frame still goes through `frameToEvent` (so `KNOWN_CODE_OUTPUT_TYPES`, the `session_init` divergence check, etc. all apply unchanged) and `dispatch` (so the replay fold and perf counters tick per inner frame exactly as today).

#### Test capture-helper unwrap (tugcode tests) {#capture-helper}

The two test layers are affected differently — this is what bounds the blast radius:

- **Generator-level tests** (`replay-*.test.ts` iterating `translateJsonlSession` via `for await (const msg of …)`) assert on the generator's yielded frames. Batching is in the **consumer** (`session.ts`), not the generator, so these are **untouched**.
- **Session-level tests** (`runReplay` with stdout capture) parse each stdout line as one `OutboundMessage`. The `captureIpc` helper (`replay-spawn.test.ts`: `JSON.parse(trimmed)` per line into an `emitted` array) feeds frame-level assertions. Once content arrives as `replay_batch` envelopes, those assertions break.

The fix mirrors the production unwrap ([P01]): when a captured line is a `replay_batch`, push its `frames` individually instead of the envelope. `captureIpc` is **duplicated** in `replay-spawn.test.ts`, `session.test.ts`, and `rewind-bridge.test.ts`; extract it to one shared test module and apply the unwrap once. Brackets stay raw ([P03]), so `replay_started` / `replay_complete` (and `replay_complete{aborted}` / `{error}`) remain directly findable; only intermediate content needs unwrapping. Order is preserved (`replay_started` raw → batch[synthetics…content]), so pending-row-injection ordering assertions hold.

---

### Specification {#specification}

#### Wire format — `replay_batch` (contract) {#s01-replay-batch} 

**Spec S01: `replay_batch` envelope** {#s01-spec}

```jsonc
{
  "type": "replay_batch",
  "frames": [ /* OutboundMessage, in emission order */ ],
  "ipc_version": 2,
  "tug_session_id": "<spliced by tugcast on the outer object>"
}
```

- `ipc_version` is the literal `2` — matching the existing `ReplayComplete` emits in `session.ts`. `IPC_VERSION` is not imported in `session.ts`; do not introduce it for this.
- `frames` is a non-empty, ordered array of the exact `OutboundMessage` objects the per-frame path would have emitted. Inner frames carry no `tug_session_id`.
- Only emitted for ≥2 buffered frames; single frames and brackets are raw ([P03]).
- Unwrapped entirely at the browser ingest boundary; never reaches the reducer as a unit ([P01]).

#### State Zone Mapping (tugdeck/tugways) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| Unwrapped inner frames → reducer events | structure | existing store `dispatch` → `reduce`; observed via `useSyncExternalStore` | [L02], [L22] |
| (none new) batch is transport-only, no React state | — | — | — |

No new React state is introduced. The change is in the store's wire-ingest routing, which already feeds the reducer through the established external-store path.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `ReplayBatch` | interface | `tugcode/src/types.ts` | `{ type:"replay_batch"; frames: OutboundMessage[]; ipc_version: number }`; add to `OutboundMessage` union |
| `REPLAY_BATCH_SIZE` | const | `tugcode/src/session.ts` (or replay consts) | 256, [P06] |
| replay emit loop | modify | `tugcode/src/session.ts` (#emit-flow) | buffer + `flushBatch`; bracket-raw; per-batch yield |
| `injectPendingRowSynthetics` | modify | `tugcode/src/session.ts` | emit through the shared buffer |
| `perf.replay_translate` fields | modify | `tugcode/src/session.ts` | add `batches` + `frames`; keep `messages` (see row below) |
| `disableYield` threading | modify | `tugcode/src/session.ts` | pass `disableYield: inflight === null && this.replayTimeSliceMs === undefined` to `translateJsonlSession` ([P05]) |
| `perf.replay_translate` `messages` | keep | `tugcode/src/session.ts` | retain field (`perf-instrumentation.test.ts` asserts `> 2`); add `batches`/`frames` beside it |
| `routeFrame` | add | `tugdeck/src/lib/code-session-store.ts` (#unwrap-flow) | unwrap `replay_batch`; used by `onFeedStoreChange` + `_ingestFrameForTest` |
| `captureIpc` | extract + modify | tugcode test module (shared) (#capture-helper) | unwrap `replay_batch`; retire the 3 duplicate copies |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (bun:test, tugdeck)** | Real-store unwrap via `_ingestFrameForTest` | Step 1 — a `replay_batch` dispatches each inner frame; transcript identical to per-frame ingest |
| **Unit (bun:test, tugcode)** | Capture stdout, assert framing | Step 2 — brackets raw, bulk batched, decoded inner sequence equals the unbatched sequence; capture helper unwraps `replay_batch` ([P08], #capture-helper) |
| **Contract / golden** | Replay output equivalence | Step 2 — generator-level tests untouched; session-level tests green via the unwrapped helper |
| **Integration (real app)** | Perf capture on reload | Steps 3 & 5 — `waitMs` (gate + final) and tugcode `batches`, via dev-panel on a real session |
| **Calibrated timing tests** | Abort/timeout unchanged | Step 4 (if run) — scoped guard keeps `cancel_replay` + `replayTimeoutMs:1` on per-message yields; they stay green untouched ([R03]) |

#### What stays out of tests {#test-non-goals}

- Render cost (`perf.replay_render`) — out of scope for this plan; not a regression surface here.
- Mock-store call-count tests and fake-DOM/RTL render tests — banned; the unwrap is exercised through the **real** store + reducer via `_ingestFrameForTest` (the same path `perf-counters.test.ts` uses).
- tugcast Rust changes — none ([P02]); no new Rust tests needed beyond the workspace staying green.

---

### Execution Steps {#execution-steps}

> Commit after all checkpoints pass. tugcode steps require a binary rebuild to take effect; tugdeck is HMR-live.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Browser-side `replay_batch` unwrap | done | 30b353a3 |
| #step-2 | tugcode emit batching + wire type + capture-helper unwrap | pending | — |
| #step-3 | Batching-only measurement gate | pending | — |
| #step-4 | Cold-path de-pacing (conditional on #step-3) | pending | — |
| #step-5 | Final integration checkpoint | pending | — |

#### Step 1: Browser-side `replay_batch` unwrap {#step-1}

**Commit:** `tugdeck: unwrap replay_batch at the ingest boundary`

**References:** [P01] transport envelope, [P04] order unwrap-first, Spec S01, (#unwrap-flow, #state-zone-mapping)

**Artifacts:**
- `routeFrame(feedId, value)` helper in `code-session-store.ts`, used by `onFeedStoreChange` and `_ingestFrameForTest`.
- bun:test exercising a `replay_batch` through the real store.

**Tasks:**
- [ ] Add `routeFrame`: when CODE_OUTPUT value `type === "replay_batch"` and `frames` is an array, dispatch each inner frame via `frameToEvent` + `dispatch`; otherwise the existing single path.
- [ ] Route both `onFeedStoreChange` and `_ingestFrameForTest` through `routeFrame` (no behavior change for non-batch frames).
- [ ] Name the laws upheld in the commit body: [L02] (store remains the single external source feeding `useSyncExternalStore`), [L22] (direct store observation) — no new React state.

**Tests:**
- [ ] A `replay_batch` containing one full replayed turn dispatches the same events and produces the identical transcript as feeding those frames individually (assert via `getSnapshot().transcript`). To read `_getPerfForDevPanel().lastReplay.frames`, wrap the batch in raw `replay_started` … `replay_complete` brackets so the ingest perf window opens and closes (the window only closes on `replay_complete`).
- [ ] A non-batch frame still routes unchanged (regression guard).

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit`
- [ ] `cd tugdeck && bun test src/lib/code-session-store/__tests__/`

---

#### Step 2: tugcode emit batching + wire type + capture-helper unwrap {#step-2}

**Depends on:** #step-1

**Commit:** `tugcode: batch replay frames over the wire`

**References:** [P01] transport envelope, [P02] tugcast unchanged, [P03] brackets raw, [P06] batch size, [P08] test-helper unwrap, Spec S01, (#emit-flow, #capture-helper, #symbol-inventory)

**Artifacts:**
- `ReplayBatch` interface added to `types.ts` and the `OutboundMessage` union.
- `REPLAY_BATCH_SIZE` constant; buffered emit + `flushBatch` in the replay consumer loop.
- `injectPendingRowSynthetics` routed through the buffer.
- `perf.replay_translate` reports `batches` and inner `frames`.
- A shared `captureIpc` test helper that unwraps `replay_batch` so frame-level assertions hold.

**Tasks:**
- [ ] Define `ReplayBatch` and add it to `OutboundMessage`. The envelope's `ipc_version` uses the literal `2`, matching the existing `ReplayComplete` emits in `session.ts` (`IPC_VERSION` is **not** imported there — do not reach for it).
- [ ] Refactor the replay consumer loop to buffer content frames and `flushBatch` on threshold / brackets per [#emit-flow]; flush `replay_started` and `replay_complete` raw.
- [ ] Thread the buffer's emit through `injectPendingRowSynthetics`, preserving order (`replay_started` raw → batch containing synthetics then content).
- [ ] Extend `perf.replay_translate`: **keep the existing `messages` field** (`perf-instrumentation.test.ts` asserts `Number(translate.messages) > 2`) and **add** `batches` (wire lines) plus `frames` (inner frames). Do not rename `messages` away. `messagesEmitted` feeds only this log — no control-flow dependency.
- [ ] **Capture-helper unwrap ([P08], #capture-helper):** teach the `captureIpc` stdout-capture helper to unwrap a `replay_batch` line into its `frames` so session-level frame assertions keep working. `captureIpc` is currently **duplicated** in `replay-spawn.test.ts`, `session.test.ts`, and `rewind-bridge.test.ts`; extract it to one shared test module and apply the unwrap once. Confirm the other session-level stdout consumers (`replay-spawn-drain.test.ts`, `replay-pending-row-injection.test.ts`, `perf-instrumentation.test.ts`, `replay-hmr-mid-stream.test.ts`) route through the shared helper.
- [ ] Rebuild the binary: `bun build --compile tugcode/src/main.ts --outfile tugrust/target/debug/tugcode`.

**Tests:**
- [ ] bun:test capturing replay stdout: brackets are raw frames; >`REPLAY_BATCH_SIZE` content yields `replay_batch` envelope(s); concatenating all `frames` arrays (and raw frames) reconstructs the exact unbatched frame sequence.
- [ ] Generator-level replay tests (`replay-*.test.ts` that iterate `translateJsonlSession`) stay green untouched — batching is in the consumer, not the generator.
- [ ] Session-level frame assertions (`replay-spawn`, `replay-pending-row-injection`, etc.) stay green via the unwrapped capture helper; pending-row synthetics keep their post-`replay_started` order.

**Checkpoint:**
- [ ] `cd tugcode && bunx tsc --noEmit`
- [ ] `cd tugcode && bun test`

---

#### Step 3: Batching-only measurement gate {#step-3}

**Depends on:** #step-2

**Commit:** `N/A (verification only)`

**References:** [P07] de-pacing gated on measurement, (#success-criteria), `perf.replay_ingest`

**Tasks:**
- [ ] Build + launch the worktree debug app (`just app-debug`); load `c53db98c` with **batching alone** (no de-pacing yet).
- [ ] Capture `perf.replay_ingest.waitMs` and tugcode `perf.replay_translate.batches`.
- [ ] **Gate decision ([P07]):** if `waitMs < 50`, batching alone met the target — mark #step-4 `skipped` in the ledger and proceed to #step-5. If `waitMs` is still materially above target, proceed to #step-4.

**Tests:**
- [ ] `batches ≈ 10` (wire-frame collapse confirmed regardless of the gate outcome).
- [ ] Browser `frames ≈ 2084` (no semantic loss).

**Checkpoint:**
- [ ] `waitMs` and `batches` captured; ledger records the gate decision for #step-4.

---

#### Step 4: Cold-path de-pacing (conditional on #step-3) {#step-4}

**Depends on:** #step-3

> **Conditional.** Implement only if #step-3 found `waitMs` still above target. The
> 275ms is dominated by per-frame transport multiplicity, which #step-2 collapses
> directly; the 8ms pacing plausibly contributes little ([P07]). If skipped, mark
> `skipped` in the ledger with the #step-3 `waitMs` as the rationale.

**Commit:** `tugcode: drop 8ms pacing on cold replay`

**References:** [P05] de-pace cold, [P07] gated on measurement, [Q02] mechanism, Risk R03, (#emit-flow)

**Artifacts:**
- `disableYield: inflight === null && this.replayTimeSliceMs === undefined` threaded into the `translateJsonlSession` options.
- Per-batch `await yieldToEventLoop()` in the consumer as the load-bearing abort/timeout yield (production).
- Updated abort-invariant comment.

**Tasks:**
- [ ] Pass `disableYield: inflight === null && this.replayTimeSliceMs === undefined` to the translator ([P05], [Q02]); leave mid-stream (`inflight !== null`) and explicit-slice (test) paths on today's pacing.
- [ ] Make the consumer's per-batch `await yieldToEventLoop()` (a macrotask) the **only** remaining yield on the production cold path — load-bearing: with `disableYield`, the generator no longer yields, so this is the sole point at which the `timeout`/`abort` promises can win the `Promise.race` ([R03], [#emit-flow]).
- [ ] Update the abort-race invariant comment in `session.ts` from "≤ one translator time-slice later" to "≤ one batch later".
- [ ] **Calibrated tests pass unchanged** because they set `replayTimeSliceMs: 0` → the scoped guard leaves `disableYield` false → per-message yields intact. Only fall back to a batch-boundary rewrite (multi-batch fixture) if the scoped guard proves insufficient; if so, state the choice in the commit body ([R03] fallback).
- [ ] Rebuild the binary.

**Tests:**
- [ ] Existing `runReplay` timeout (`replayTimeoutMs:1`) and `cancel_replay` abort tests stay green untouched (scoped guard keeps their per-message yields).
- [ ] A new test confirms production-shaped de-pacing: with `replayTimeSliceMs` undefined and `inflight === null`, the translator is invoked with `disableYield: true` (assert the threaded option, not wall-clock timing).

**Checkpoint:**
- [ ] `cd tugcode && bunx tsc --noEmit`
- [ ] `cd tugcode && bun test`

---

#### Step 5: Final integration checkpoint {#step-5}

**Depends on:** #step-1, #step-2, #step-3

> Step 4 is **not** a hard dependency: it may be `skipped` per [P07], and a `skipped`
> status would otherwise read as "not done" and block resume. Step 5 folds in Step 4's
> changes only if it ran; the gate (#step-3) is the real prerequisite.

**Commit:** `N/A (verification only)`

**References:** (#success-criteria), `perf.replay_ingest`, `perf.replay_translate`

**Tasks:**
- [ ] With the final build (batching, plus de-pacing if #step-4 ran), load a real ≥50-turn session (`c53db98c`).
- [ ] Capture `perf.replay_ingest` and the tugcode `perf.replay_translate` line.

**Tests:**
- [ ] `waitMs < 50` (down from ~275).
- [ ] tugcode `batches ≈ 10`, inner `frames ≈ 2084`; browser `frames ≈ 2084` (no loss).
- [ ] Transcript renders identically (turn count, content) to the pre-change load.

**Checkpoint:**
- [ ] Both perf lines captured and meet the success criteria; transcript visually identical.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Cold transcript loads ship the replay in ~10 batched wire lines with no cold-path pacing, cutting ingest wait from ~275ms to sub-50ms, with the reducer, live path, and rendered transcript unchanged.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Browser unwraps `replay_batch` transparently; single-frame path still works (#step-1 tests).
- [ ] tugcode emits batches with raw brackets; inner sequence equals the unbatched sequence; session-level tests green via the unwrapped capture helper (#step-2 tests).
- [ ] Batching-only measurement captured and the #step-4 gate decision recorded (#step-3).
- [ ] If #step-4 ran: cold replay runs without 8ms pacing; abort/timeout reconciled and green. If skipped: ledger records the rationale.
- [ ] `waitMs < 50` and tugcode `batches ≈ 10` on a real session (#step-5).

**Acceptance tests:**
- [ ] `cd tugdeck && bun test src/lib/code-session-store/__tests__/`
- [ ] `cd tugcode && bun test`
- [ ] Real-app reload perf capture (#step-3 gate, #step-5 final).

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Render-cost investigation (`perf.replay_render` ~665ms for 46 rows) — separate plan.
- [ ] De-pace the mid-stream-reload replay (`inflight !== null`) once the live-tail interleaving is re-verified.
- [ ] Optional byte-size cap on batches if image-heavy sessions produce large batch lines.

| Checkpoint | Verification |
|------------|--------------|
| Browser unwrap (#step-1) | `bun test` over `code-session-store/__tests__/` |
| Emit batching + capture unwrap (#step-2) | tugcode `bun test` framing + session-level assertions |
| Batching-only gate (#step-3) | dev-panel `perf.replay_ingest.waitMs` + `batches`; #step-4 decision recorded |
| De-pacing (#step-4, if run) | reconciled abort/timeout tests green |
| End-to-end win (#step-5) | dev-panel `perf.replay_ingest.waitMs` < 50 on `c53db98c` |
