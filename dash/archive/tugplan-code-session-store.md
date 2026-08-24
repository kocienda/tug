<!-- tugplan-skeleton v2 -->

## T3.4.a — CodeSessionStore (turn state machine) {#code-session-store}

**Purpose:** Land `CodeSessionStore` in tugdeck — a per-Tide-card L02 store that owns Claude Code turn state, observes filtered CODE_OUTPUT / SESSION_STATE frames, dispatches CODE_INPUT messages through `encodeCodeInput`, and exposes an append-only transcript plus an in-flight streaming document that `TugMarkdownView` can render. Nothing about turn state lives in React components after this phase.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-04-15 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

[T3.0.W1](./tugplan-workspace-registry-w1.md), [W2](./tugplan-workspace-registry-w2.md), and [W3.a](./tugplan-workspace-registry-w3a.md) together replaced tugcast's single-bootstrap-workspace model with per-session workspace binding. `spawn_session` now carries `project_dir`, `WorkspaceRegistry` reference-counts feed bundles per canonical project path, `LedgerEntry.workspace_key` binds each session to its workspace, and tugdeck's `CardSessionBindingStore` + `useCardWorkspaceKey` hook resolve card identity into a `{ tugSessionId, projectDir, workspaceKey }` tuple. The wire contract is stable, the router demuxes sessions by `tug_session_id` in the payload, the drift test ([§P2 follow-up](./tide.md#p2-followup-golden-catalog)) pins `claude 2.1.105` stream-json shapes as machine-readable golden fixtures, and `FeedStore` has a per-instance filter API for per-card subscriptions. Everything below the store is ready.

What's still missing is the store itself. Today there is no place for turn state to live: the gallery prompt-input spike runs against ad-hoc mock frames, `tug-prompt-entry` (T3.4.b) cannot be written without a store to consume, and the Tide card (T3.4.c) has no L02 component to subscribe to. T3.4.a fills that gap by shipping `CodeSessionStore` as a pure TypeScript L02 store with no React dependencies, a filtered `FeedStore` built from a raw `TugConnection` and `tug_session_id`, an append-only `transcript`, an in-flight `streamingDocument` PropertyStore, and an explicit turn-state machine derived from the `v2.1.105/` golden fixtures. After this phase, T3.4.b can compose the store into `tug-prompt-entry`, T3.4.c can mount both inside a Tide card, and T3.4.d can close out Phase T3 with a real end-to-end round-trip.

#### Strategy {#strategy}

- **Store owns the filter, card owns the lifecycle.** The store constructs its own filtered `FeedStore` from a raw `TugConnection` and a `tug_session_id` — consumers never build a mis-keyed feed by accident. The Tide card (T3.4.c) owns `spawn_session` / `close_session` CONTROL frames and the `CardSessionBindingStore` binding; the store handles what happens on an already-claimed session.
- **Post-W2 wire contract, no fallbacks.** There is no single-session mode, no "first card gets the default session," no conflation of `sessionKey` with `tug_session_id`. Routing is by `tug_session_id` (UUID minted per card); `claude_session_id` is observed from `session_init` and exposed on the snapshot for downstream display; `project_dir` is the card's business. A human-readable `displayLabel` is optional and has zero wire footprint.
- **Append-only transcript + in-flight streaming document.** Tide cards are long-lived chat threads, so the class wrapper maintains an append-only `_transcript: TurnEntry[]` (one entry per completed turn, surfaced on the snapshot as `ReadonlyArray<TurnEntry>`) plus a single `streamingDocument: PropertyStore` with stable path keys (`inflight.assistant`, `inflight.thinking`, `inflight.tools`). This collapses the former `streamingStore / streamingPath / streamRegionKey` triplet into one store-owned instance plus path strings on the snapshot. **Transcript lives on the class wrapper, not inside the reducer's state** — this keeps the reducer a pure `(state, event) => { state, effects }` function ([D11]).
- **Pure reducer, explicit effect list ([D11]).** The internal reducer is a pure function `reduce(state, event) => { state, effects: Effect[] }`. Effects are a discriminated union (`WriteInflight`, `ClearInflight`, `SendFrame`, `AppendTranscript`) that the class wrapper processes after every dispatch. This makes side effects first-class and grep-able, keeps the reducer testable without a live connection, and matches L22: streaming document writes fire directly through the wrapper's effect handler, never round-tripped through React.
- **Fixtures are ground truth; `bun test` reads them in-place with occurrence-aware substitution.** Unit tests load `tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/v2.1.105/test-NN-*.jsonl` via a `loadGoldenProbe(version, probeName)` helper that substitutes `{{uuid}}` placeholders **based on the JSON field name AND the logical occurrence** within the event stream. The v2.1.105 catalog uses only five placeholder tokens (`{{uuid}}`, `{{cwd}}`, `{{f64}}`, `{{i64}}`, `{{text:len=N}}`), and crucially uses `{{uuid}}` for `session_id`, `tug_session_id`, `msg_id`, `tool_use_id`, and `request_id` — a naive global substitution collapses these into one value, and a field-aware substitution that assigns one constant per field collapses multiple distinct occurrences of the same field (e.g., two concurrent `tool_use_id`s in `test-07-multiple-tool-calls`). Occurrence-aware substitution walks the event stream once, groups tool_use/tool_result pairs using streaming-protocol heuristics, and assigns distinct values only where the source capture had distinct values. No copy/export step between the Rust-owned golden directory and the tugdeck-side tests — the [drift test](./tide.md#p2-followup-golden-catalog) already guards divergence on the Rust side.
- **Sequenced reducer build-up, one state per commit.** Each execution step lands one coherent slice of the state machine behind a compile-clean commit with fixture-driven tests: scaffolding, then the basic round-trip reducer, then streaming deltas, then tools, then permission/question flows, then interrupt, then `errored` triggers, then queue semantics, then dispose/filter. Integration checkpoint at the end verifies all slices cooperate.
- **Warnings are errors across the build.** Every intermediate commit must survive `-D warnings` on Rust (unchanged by this plan) and whatever strictness `bun run check` + `tsconfig` imposes on tugdeck. No `any` escapes, no `@ts-expect-error` in committed code, no new `react` imports inside `code-session-store.ts`.
- **No React, no DOM, no IndexedDB.** `code-session-store.ts` is pure TypeScript + L02. Any persistence (not in this phase) goes through tugbank per D-T3-10. React coupling belongs in T3.4.b / T3.4.c.

#### Success Criteria (Measurable) {#success-criteria}

- `tugdeck/src/lib/code-session-store.ts` exists and exports `CodeSessionStore` + `CodeSessionSnapshot`. (verification: file exists; `tsc --noEmit` clean)
- `rg 'from "react"' tugdeck/src/lib/code-session-store.ts` returns zero matches. (verification: grep in Step 10)
- `rg 'IDBDatabase\|indexedDB' tugdeck/src/lib/code-session-store.ts tugdeck/src/lib/code-session-store/` returns zero matches. (verification: grep in Step 10)
- Replaying `v2.1.105/test-01-basic-round-trip.jsonl` drives the store `idle → submitting → awaiting_first_token → streaming → complete → idle` with exactly one `TurnEntry` appended to `transcript`. (verification: `code-session-store.round-trip.test.ts`)
- Replaying `v2.1.105/test-02-longer-response-streaming.jsonl` accumulates deltas at `inflight.assistant` in arrival order; on the `complete` event, the buffer equals the event's `text` field byte-for-byte. (verification: `code-session-store.deltas.test.ts`)
- Replaying `v2.1.105/test-06-interrupt-mid-stream.jsonl` after a `store.interrupt()` call drives `streaming → interrupted → idle`, commits a `TurnEntry` with `result: "interrupted"` and the accumulated text preserved. (verification: `code-session-store.interrupt.test.ts`)
- Three `send()` calls during `streaming` leave `queuedSends === 3`; after `interrupt()` + `turn_complete(error)`, `queuedSends === 0` and no `user_message` frames were written for the queued sends. (verification: `code-session-store.interrupt.test.ts`)
- Three `send()` calls during `streaming` leave `queuedSends === 3`; after `turn_complete(success)`, exactly one queued `user_message` frame is written and the store transitions `complete → idle → submitting` in a single dispatch tick. (verification: `code-session-store.queue.test.ts`)
- Replaying `v2.1.105/test-05-tool-use-read.jsonl` flips `phase` to `tool_work` on first `tool_use` partial and back to `streaming` on matching `tool_use_structured` / `tool_result`; `inflight.tools` carries a `ToolCallState` with the fixture's tool name. (verification: `code-session-store.tools.test.ts`)
- Replaying `v2.1.105/test-07-multiple-tool-calls.jsonl` keeps multiple overlapping `tool_use_id`s simultaneously resident in `inflight.tools` and keeps `phase === "tool_work"` until all resolve. (verification: `code-session-store.tools.test.ts`)
- Synthetic `control_request_forward { is_question: false }` replay populates `pendingApproval`; `respondApproval(requestId, { decision: "allow" })` writes a `tool_approval` CODE_INPUT frame with the correct `request_id` and `decision`. **v2.1.105 has no permission-allow golden fixture; the approval path is exercised with a synthetic event** (v2.1.105 only ships `test-11-permission-deny-roundtrip.jsonl` and `test-09-bash-auto-approved.jsonl`; neither is a user-gated allow). (verification: `code-session-store.control-forward.test.ts`)
- Replaying `v2.1.105/test-11-permission-deny-roundtrip.jsonl` produces a `tool_approval` frame with `decision: "deny"`. (verification: same file)
- **Synthetic** `control_request_forward { is_question: true }` replay populates `pendingQuestion`; `respondQuestion(requestId, { answers })` writes a `question_answer` CODE_INPUT frame with the correct shape. **v2.1.105 has no AskUserQuestion golden fixture** — `test-35-askuserquestion-flow.jsonl` is marked `status: "skipped"` in the manifest with `event_count: 0` ("first-run flake at stability>=2 — probe returns 0 events intermittently"). The question path is exercised synthetically, parallel to permission-allow. (verification: `code-session-store.control-forward.test.ts`)
- Synthetic `SESSION_STATE { state: "errored", detail: "crash_budget_exhausted" }` frame during `streaming` transitions `phase → errored`, `lastError.cause === "session_state_errored"`, `lastError.message` contains `"crash_budget_exhausted"`, transcript preserved. (verification: `code-session-store.errored.test.ts`)
- Synthetic `conn.onClose()` fired while `phase === "submitting"` transitions `phase → errored` with `lastError.cause === "transport_closed"`. (verification: same file)
- From `phase === "errored"`, `send("retry", [])` transitions to `submitting`; after a subsequent `turn_complete(success)`, `lastError === null`. (verification: same file)
- Two `CodeSessionStore` instances with distinct `tugSessionId`s against a shared mock connection receive only their own frames; replaying a stream tagged with store A's id leaves store B's snapshot unchanged. (verification: `code-session-store.filter.test.ts`)
- After `dispose()`, new frames on the connection do not update the snapshot; `inflight.*` paths are cleared; **`transcript` is preserved unchanged** (per [L23]); no `close_session` frame was written. (verification: `code-session-store.dispose.test.ts`)
- `cd tugdeck && bun test` is green on every step commit and on the integration checkpoint. (verification: Step 10)

#### Scope {#scope}

1. New file `tugdeck/src/lib/code-session-store.ts` implementing `CodeSessionStore` (class), `CodeSessionStoreOptions` (constructor options), `CodeSessionSnapshot` (snapshot type), `TurnEntry` (immutable transcript entry), `ToolCallState` (per-call state), and the internal reducer.
2. New file `tugdeck/src/lib/code-session-store/testing/golden-catalog.ts` exporting `loadGoldenProbe(version, probeName)` plus the placeholder substitution and typed-event parsing helpers.
3. New file `tugdeck/src/lib/code-session-store/testing/mock-feed-store.ts` — a test-only in-memory `FeedStore` double + `MockTugConnection` that together replay parsed golden events to the store's subscription handler, record outbound CODE_INPUT frames with decoded JSON views, and support bounded/index-gated replay for tests that need to interleave store actions with fixture events.
4. New test suite `tugdeck/src/lib/code-session-store/__tests__/` covering: round-trip, streaming deltas, tool lifecycle, concurrent tools, control request forward (approval, deny, question), interrupt (including queue clearing), queue flush on success, errored triggers (SESSION_STATE, transport close, CONTROL errors), recovery from errored, filter correctness, dispose teardown, react-import negative check.
5. Public exports from `tugdeck/src/lib/index.ts` (or the equivalent barrel): `CodeSessionStore`, `CodeSessionSnapshot`, `TurnEntry`. The `golden-catalog` and `mock-feed-store` helpers are test-only and not re-exported.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **`spawn_session` / `close_session` / `reset_session` lifecycle.** The card owns CONTROL frames via `CardSessionBindingStore` and `encodeSpawnSession` / `encodeCloseSession`. T3.4.a does not build the picker UI, does not call these encoders, and does not mint `tug_session_id`. The store accepts a `tugSessionId` that is already known to be persisted.
- **`session_command: "new" | "continue" | "fork"` routing.** `v2.1.105/test-13-*.jsonl`, `test-17-*.jsonl`, `test-20-*.jsonl` are skipped in the current manifest pending [P16](./tide.md#p16-session-command-continue). T3.4.a is single-session-per-store; `session_command` handling re-enables when P16 closes.
- **React components / hooks.** No `useSyncExternalStore`, no JSX, no `.tsx` files in scope. `tug-prompt-entry` is T3.4.b; Tide card registration is T3.4.c.
- **Persistence of transcript / snapshot.** The transcript lives in memory for the card's lifetime. Rehydration on reload is [P14](./tide.md#p14-claude-resume) (Claude `--resume`) territory; this plan leaves the hook points clean but writes no tugbank code.
- **SESSION_METADATA consumption.** `SessionMetadataStore` owns `SESSION_METADATA`; the Tide card holds references to both stores. `CodeSessionStore` does not subscribe to `SESSION_METADATA` at all.
- **`system_metadata.version` capture / version-adaptive reducer.** That scaffold is [P15](./tide.md#p15-stream-json-version-gate), which lands after T3.4.a so the version-branching is informed by what fields the store actually depends on.
- **P13 spawn cap / rate limit surfacing.** P13 adds `concurrent_session_cap_exceeded` and `spawn_rate_limited` as `SESSION_STATE { state: "errored", detail: ... }` details. T3.4.a's `errored` handling routes *any* `SESSION_STATE errored` frame to `phase → errored` with the detail copied into `lastError.message`, so P13 works with zero store changes when it lands — but no P13-specific code exists yet.
- **Local slash-command registry.** `/status`, `/model`, `/cost`, etc. are Phase T10 work. T3.4.a treats all user messages as opaque — the store writes whatever text the caller hands it to `CODE_INPUT`.
- **Bootstrap workspace retirement.** The W1 bootstrap stays alive per [W3.a](./tugplan-workspace-registry-w3a.md) non-goals; retirement rides with T3.4.c + W3.b. T3.4.a is orthogonal to the bootstrap — it operates entirely via the post-W2 session-scoped wire path.

#### Dependencies / Prerequisites {#dependencies}

- [T3.0.W2](./tugplan-workspace-registry-w2.md) — shipped. Provides `spawn_session { project_dir }` CONTROL shape, `LedgerEntry.workspace_key`, `SessionKeyRecord` persisted shape, tugdeck's `CardSessionBindingStore` + `useCardWorkspaceKey`.
- [T3.0.W3.a](./tugplan-workspace-registry-w3a.md) — draft / in-flight. Not a hard dependency for T3.4.a reducer code, but W3.a lands before T3.4.a per the [Execution Order table](./tide.md#execution-order-table). The store's reducer is unaffected by W3.a's CLI renames.
- [§P2 integration reference](./tide.md#p2-integration-reference) in `dash/tide.md` — the stabilized wire contract this plan is built against. Covers FeedId slots, frame payload shapes, the lifecycle order, `encodeSpawnSession` / `encodeCloseSession` / `encodeCodeInput` signatures, the `FeedStore` per-instance filter API, and server-side entry-point table.
- [§P2 follow-up golden catalog](./tide.md#p2-followup-golden-catalog) — shipped. Provides `tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/v2.1.105/` as machine-readable ground truth with placeholder normalization; provides `stream_json_catalog_drift.rs` as the Rust-side regression test.
- Existing `tugdeck/src/lib/feed-store.ts` with the 4-argument constructor `new FeedStore(conn, feedIds, decode?, filter?)`. Exists per [Phase T0.5 P2](./tide.md#protocol-hardening).
- Existing `tugdeck/src/protocol.ts` with `FeedId`, `encodeCodeInput(msg, tugSessionId)`. Exists per P2.
- Existing `tugdeck/src/connection.ts` `TugConnection` with `.send(feedId, payload)` and `onClose(callback: () => void): () => void` at line 297 (returns an unsubscribe function — exactly the shape this plan needs; no connection-module changes in scope).
- Existing `PropertyStore` primitive used by `TugMarkdownView`'s streaming API. Exists per [Phase 3A.5 Region Model + API](./tide.md#foundation) (DONE).
- `bun` ≥ `1.x` with its built-in test runner (`bun test`) as configured in `tugdeck/package.json`. **Tugdeck does not use Vitest** — the `"test"` script is `bun test`. Tests use bun's Jest-like surface (`describe`, `test`, `expect`, `mock`). This plan sometimes uses the word "test" generically; there are no Vitest-specific APIs in scope.

#### Constraints {#constraints}

- **Warnings are errors.** Tugdeck's `tsc --noEmit` runs under strict mode; no `any` escapes, no `@ts-expect-error`, no `@ts-ignore` in committed code. Rust-side touched crates (none in this plan) would follow `-D warnings` but this plan is tugdeck-only.
- **bun, not npm.** All commands run under `bun`. `bun test`, `bun run audit:tokens` (not touched here), `bun install`. Never `npm` / `npx`. (Memory: `feedback_use_bun`.)
- **No React, no DOM, no IndexedDB.** `code-session-store.ts` must not import from `react`, `react-dom`, `window.indexedDB`, or any DOM global. All persistence goes through tugbank when it lands later (D-T3-10). T3.4.a writes no persistence code.
- **No mock-only scaffolding leaking into production bundle.** `testing/golden-catalog.ts` and `testing/mock-feed-store.ts` are test-only and must not be importable from production paths. Validate via `tsconfig.json`'s `exclude` list or a path convention (e.g., the `testing/` subdirectory is excluded from the production build).
- **Golden fixture path is a relative path, not a symlink or a copy.** The test helper reads `../../../tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/<version>/<probe>.jsonl` from `tugdeck/src/lib/code-session-store/testing/`. The repo root layout is stable; any future reshuffling of tugrust or tugdeck will break the path loudly and can be repaired in a follow-up.
- **No `--no-verify`, no amend, no squash on committed steps.** Each execution step lands as a fresh commit. (CLAUDE.md commit discipline.)
- **Store must be pure-function reducer under the hood.** The outer `CodeSessionStore` class is mutable (holds the `FeedStore`, the `PropertyStore`, the subscriber list), but the inner reducer is a pure `(state, event) => state` function exported from an internal module so tests can exercise reducer logic without constructing a live store.

#### Assumptions {#assumptions}

- `FeedStore`'s 4th-argument filter runs on decoded payloads with `tug_session_id` visible as a top-level field. (Confirmed in §P2 integration reference.)
- `encodeCodeInput(msg, tugSessionId)` returns an already-encoded `ArrayBuffer` and injects `tug_session_id` as the first field of the payload. (Confirmed in §P2 integration reference.)
- A single `TugConnection` can carry frames for multiple `CodeSessionStore` instances concurrently without cross-contamination, provided each store's filter is correctly keyed. (Confirmed by the router's demux + client-side filter design in P2.)
- `PropertyStore.set(path, value)` triggers observer notifications synchronously (or at least before the next task tick), compatible with `TugMarkdownView`'s observe path. (Inherited assumption from Phase 3A.5.)
- Golden fixture filenames under `v2.1.105/` are stable for the lifetime of this plan. If Anthropic ships `claude 2.1.106` during implementation and the drift test flags it, follow the recovery workflow in [§P2 follow-up](./tide.md#p2-followup-golden-catalog) before continuing — do not hand-patch events to keep tests green.
- Under `bun test` (ESM), `import.meta.dir` resolves to the directory of the current module — the bun equivalent of Node's `__dirname`. The fixture loader uses this, not `__dirname`, to stay ESM-clean. `fs.readFileSync` with an `import.meta.dir`-relative path works under bun's fs API the same way it does under Node.
- `TugConnection.onClose(callback: () => void): () => void` already exists at `tugdeck/src/connection.ts:297` with the exact unsubscribe-returning shape the store needs. Step 8 subscribes to it directly; no connection-module changes.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Transcript rehydration on reload (DEFERRED to P14) {#q01-transcript-rehydration}

**Question:** When a user reloads the browser, the current plan loses all prior `TurnEntry` history — `transcript` starts empty. Is this acceptable for T3.4.a, or must the store rehydrate from persisted state on construction?

**Why it matters:** If users lose conversation history on reload, the Tide card feels broken even though the state machine is correct. If we add persistence now, we're duplicating work that [P14](./tide.md#p14-claude-resume) will do properly via Claude `--resume`.

**Options (if known):**
- Accept the loss for T3.4.a; rehydration ships with P14.
- Add a thin tugbank-backed transcript cache to `CodeSessionStore` now.
- Stream-reconstruct the transcript from CODE_OUTPUT replay on reconnect (requires a per-session replay channel that doesn't exist).

**Plan to resolve:** DEFERRED. T3.4.a ships with an empty `transcript` on construction. P14 lands Claude `--resume` + tugbank persistence of `claude_session_id`, and rehydration can hang off the same hook.

**Resolution:** DEFERRED to P14. T3.4.a's snapshot shape carries `transcript: ReadonlyArray<TurnEntry>` as a field, not a method, so P14 can repopulate it at construction without a shape change.

#### [Q02] TurnEntry shape for tool calls (DECIDED) {#q02-turn-entry-tool-shape}

**Question:** When committing a completed turn to `transcript`, should `TurnEntry.toolCalls` be a `Map<tool_use_id, ToolCallState>` (matching the in-flight shape) or a `ReadonlyArray<ToolCallState>` in arrival order?

**Why it matters:** The in-flight shape is a Map for O(1) `tool_use_id` lookup on interleaved events. But downstream rendering in `TugMarkdownView` will want to display tool calls in arrival order, which an array gives naturally but a Map does not guarantee (though JS Maps preserve insertion order). The snapshot shape is part of the public API and changing it later is painful.

**Options considered:**
- `ReadonlyArray<ToolCallState>` in arrival order. Downstream rendering is simpler; the in-flight Map is converted on commit.
- `ReadonlyMap<string, ToolCallState>`. Preserves in-flight shape; downstream must `Array.from(map.values())` to render.
- Both — a `toolCallOrder: string[]` + `toolCalls: ReadonlyMap<string, ToolCallState>`.

**Resolution:** DECIDED — `ReadonlyArray<ToolCallState>` in insertion order. Rationale: the consumer is a markdown renderer, not an event-correlation engine; the in-flight Map is converted on commit via `Array.from(map.values())`. Pinned in Spec S02 and enforced in Step 5.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Stream-json shape drift between `v2.1.105` and live Claude during implementation | high | low | Rely on the golden catalog + drift test; if a new Claude ships, follow the §P2 follow-up recovery workflow before continuing | Drift test fails on a `claude` version bump during T3.4.a work |
| Fixture relative-path brittleness across repo moves | medium | low | The path is hardcoded as `../../../tugrust/.../fixtures/`; any repo root restructure breaks the helper loudly with a readable error | Future repo move or monorepo split |
| Concurrent tool-call state machine miscorrelation | high | medium | Key every tool event on `tool_use_id` in a `Map`; add `test-07-multiple-tool-calls.jsonl` as a required exit criterion with assertion on multiple overlapping ids | Fixture replay fails or tool state leaks across turns |
| Interrupt vs `turn_complete(error)` race | medium | low | The state machine does not require `interrupt()` and `turn_complete(error)` to arrive in any particular order — `interrupt()` writes the frame and stays in the current phase; the `error` turn_complete is the only driver of `interrupted → idle` | Synthetic test reorders events |
| PropertyStore synchronous-notification assumption wrong | medium | low | Every `inflight.*` write is immediately followed by an assertion-compatible read in tests; if async, tests will flake and we'll add `flushSync` or equivalent | Tests flake on delta assertions |

**Risk R01: Interleaved tool call miscorrelation** {#r01-tool-call-interleave}

- **Risk:** Two concurrent tool calls with different `tool_use_id`s arrive interleaved (`tool_use(A)` → `tool_use(B)` → `tool_result(A)` → `tool_result(B)`). If the reducer assumes sequential ordering, the state for B gets overwritten by A's result and `inflight.tools` reports a corrupt state.
- **Mitigation:**
  - Key every tool event on `tool_use_id` in a `Map<string, ToolCallState>`.
  - The `tool_work ↔ streaming` transition fires only when **all** pending `tool_use_id`s have resolved (all Map entries have `status: "done"`).
  - Exit criterion requires `test-07-multiple-tool-calls.jsonl` (the real multi-tool fixture in `v2.1.105/`) to pass with multiple ids observable in `inflight.tools` simultaneously.
- **Residual risk:** If Claude emits a `tool_result` for a `tool_use_id` the store never saw (driver bug, router dedup gap), the reducer logs and drops the event without transitioning. Acceptable for T3.4.a.

**Risk R02: Golden fixture path coupling** {#r02-fixture-path-coupling}

- **Risk:** The `loadGoldenProbe` helper reads `.jsonl` files via `../../../tugrust/.../fixtures/stream-json-catalog/<version>/<probe>.jsonl` resolved through `import.meta.dir`. A future repo restructure (monorepo split, directory rename) silently breaks every test.
- **Mitigation:**
  - The helper throws a readable `Error` containing the absolute resolved path when a file is missing — not a cryptic ENOENT.
  - The relative path is documented inline in `golden-catalog.ts` with a one-line comment pointing at the upstream directory.
  - A single top-of-file constant holds the relative prefix; the test helper is the only callsite.
- **Residual risk:** A repo move still requires a one-line fix. Acceptable for T3.4.a.

**Risk R03: `errored` vs `interrupted` confusion** {#r03-errored-vs-interrupted}

- **Risk:** Both paths surface as a "something went wrong" turn, and it's tempting to collapse them. But `turn_complete(error)` is user-initiated (Stop button) and preserves text; `SESSION_STATE errored` is infrastructure-level and preserves transcript but not the in-flight turn. Conflating them corrupts the `lastError` surface and misleads the UI.
- **Mitigation:**
  - The transition table has two distinct rows for these events; they route to different phases (`interrupted` vs `errored`).
  - Exit criteria include separate tests for each path.
  - The `errored` triggers table lists exhaustively what *does* route there; `turn_complete(error)` is explicitly listed under "Not in scope for `errored`".
- **Residual risk:** If a future reducer change inadvertently routes `turn_complete(error)` to `errored`, the interrupt exit-criteria test catches it.

---

### Design Decisions {#design-decisions}

#### [D01] Store owns the filtered FeedStore (DECIDED) {#d01-store-owns-feedstore}

**Decision:** `CodeSessionStore` constructs its own filtered `FeedStore` internally from a raw `TugConnection` + `tug_session_id`. The Tide card does not pre-build a `FeedStore` and pass it in.

**Rationale:**
- Encapsulates the filter shape — consumers cannot construct a mis-keyed filter by accident.
- The store already owns `tug_session_id`, so building the filter from it is natural.
- Reduces the constructor surface to three conceptual inputs: connection, session id, optional display label.
- Matches the §P2 integration reference "typical client flow" pattern.

**Implications:**
- The store depends on `FeedStore` (not injected) — slightly harder to unit-test, mitigated by the `mock-feed-store.ts` helper.
- Any future change to `FeedStore`'s constructor shape touches `CodeSessionStore`. Acceptable.

#### [D02] Card owns CONTROL lifecycle, not the store (DECIDED) {#d02-card-owns-lifecycle}

**Decision:** The Tide card (T3.4.c) sends `encodeSpawnSession` / `encodeCloseSession` / `encodeResetSession` CONTROL frames and updates `CardSessionBindingStore`. `CodeSessionStore` sends none of these and only subscribes to SESSION_STATE to observe the result.

**Rationale:**
- Keeps the store's single responsibility tight: turn state on an already-claimed session.
- Matches W2's layering — `CardSessionBindingStore` is the source of truth for card ↔ session binding, not the turn-state store.
- Allows the card to construct the store while SESSION_STATE is still `pending` (lazy spawn); the store tracks state transitions internally.
- `dispose()` is a local teardown (unsubscribe, clear listeners), not a session shutdown — the card's unmount logic drives `close_session` separately.

**Implications:**
- The store's construction is deferred in the Tide card until after `encodeSpawnSession` has been sent (but not necessarily acked).
- Tests must simulate the pre-live pending window for the `idle → submitting` transition over a lazy-spawn session.

#### [D03] Three-identifier model with displayLabel as UI-only (DECIDED) {#d03-three-identifier-model}

**Decision:** The store operates on a clean separation of four values: `tug_session_id` (wire routing), `claude_session_id` (observed from `session_init`, for `--resume`), `project_dir` (card concern, never seen by store), and `displayLabel` (UI chrome only, zero wire footprint).

**Rationale:**
- After W2, each identifier has a single purpose; conflating them is the primary source of bugs in the pre-W2 draft.
- Removing `displayLabel` from identity-critical paths means future UI changes (renaming a tab) cannot break wire routing.
- `claude_session_id` exposure on the snapshot is the hook point P14 will populate; no shape change needed when P14 lands.

**Implications:**
- The constructor takes `tugSessionId` as required and `displayLabel` as optional (defaults to `tugSessionId.slice(0, 8)`).
- `project_dir` is not a constructor parameter and is not accessible from the store.

#### [D04] Append-only transcript + in-flight PropertyStore (DECIDED) {#d04-transcript-plus-streaming}

**Decision:** The class wrapper owns `_transcript: TurnEntry[]` (immutable from the outside, appended on every `turn_complete`) — surfaced on the snapshot as `ReadonlyArray<TurnEntry>` — plus a single `streamingDocument: PropertyStore` with three stable path keys (`inflight.assistant`, `inflight.thinking`, `inflight.tools`). On `turn_complete`, in-flight content is committed to `_transcript` and `inflight.*` is cleared. **Transcript does not live in the reducer's state** — it's maintained by the class wrapper in response to `AppendTranscript` effects ([D11]).

**Rationale:**
- Tide cards are long-lived chat threads, not ephemeral panes — the transcript must grow monotonically.
- Keeping transcript outside reducer state lets the reducer stay a pure `(state, event) => { state, effects }` function ([D11]) — the transcript would otherwise bloat `state` on every dispatch and complicate diffing.
- Separating transcript (snapshot-level, exposed as ReadonlyArray) from streaming document (reference on the store, mutable) gives the renderer two distinct subscription surfaces without blurring them.
- Collapsing the pre-rewrite `streamingStore / streamingPath / streamRegionKey` triplet into one store-owned instance eliminates three different names for the same concept.
- The PropertyStore instance lives as a public property on the store (`store.streamingDocument`), not in the React snapshot, because PropertyStores aren't plain data.

**Implications:**
- `TugMarkdownView` in T3.4.c subscribes to `store.streamingDocument` directly (via its existing observe API), not through `useSyncExternalStore` — L22 (external state driving direct DOM updates goes through a store observer, not a React round-trip).
- Consumers that need path strings thread `snapshot.streamingPaths.assistant` etc. through props; the strings are constants.
- The snapshot shape carries path strings as literal string types for TS clarity.
- `getSnapshot()` builds a fresh object that merges reducer state with `_transcript`, `claudeSessionId`, and the constant `streamingPaths` literals.

#### [D05] Interrupt clears the queue (DECIDED) {#d05-interrupt-clears-queue}

**Decision:** `interrupt()` dispatches an `{ type: "interrupt" }` frame and **clears** the local queued-sends buffer. Queued messages are discarded, not flushed on the next idle tick.

**Rationale:**
- The user pressed Stop; queued messages were typed with the expectation the current turn would complete. After an interrupt, sending those queued messages is usually not what the user wants.
- Preserving them would require the UI to expose "cancel queued messages" as a separate affordance, which bloats the interface.
- If a user genuinely wants to send a mid-interrupt queue, they can retype.
- Matches the simpler mental model of "Stop means stop everything."

**Implications:**
- Exit criterion pins this with a synthetic test: three queued sends + interrupt → `queuedSends === 0` and no queued `user_message` frames written.
- The `turn_complete(success)` path flushes one queued send per idle tick (distinct from the interrupt path).
- Future UX feedback might warrant reopening — if users complain they lose work on Stop, reconsider in a follow-up.

#### [D06] `respondApproval` and `respondQuestion` stay split (DECIDED) {#d06-respond-split}

**Decision:** The store exposes two separate actions — `respondApproval(requestId, { decision, updatedInput?, message? })` and `respondQuestion(requestId, { answers })` — not a unified `respond(requestId, payload)` that dispatches on `is_question`.

**Rationale:**
- The wire shapes are distinct: `tool_approval` carries `decision` and optional `updatedInput` / `message`; `question_answer` carries `answers`. A unified action would need a union type that muddles both.
- Component call sites are clearer: a permission dialog calls `respondApproval`; a question dialog calls `respondQuestion`. The mismatch (calling `respondApproval` on a question) fails at compile time with distinct types, not at runtime.
- The cost is two action names instead of one — trivial.

**Implications:**
- Component code in T3.4.b dispatches to the matching action based on which of `pendingApproval` / `pendingQuestion` is non-null in the snapshot.
- Both actions write to CODE_INPUT with `encodeCodeInput`.

#### [D07] Golden fixtures read in-place, no export step (DECIDED) {#d07-vitest-reads-in-place}

**Decision:** The tugdeck test helper `loadGoldenProbe(version, probeName)` reads `.jsonl` files directly from `tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/<version>/<probeName>.jsonl` via an `import.meta.dir`-relative path (bun's ESM equivalent of Node's `__dirname`). No copy, no symlink, no Rust-side export step.

**Rationale:**
- Both `tugrust/` and `tugdeck/` live in the same repo root; the relative path is stable.
- Eliminates the duplication hazard — the Rust drift test and the tugdeck reducer test see exactly the same bytes.
- Avoids a build step and a bidirectional coupling for zero benefit.
- Windows symlink fragility is a non-issue because we don't symlink.

**Implications:**
- A future repo restructure (moving `tugdeck/` out of the root, monorepo split) breaks the helper loudly — acceptable, easy to repair.
- The helper throws a readable error including the resolved absolute path on missing fixtures.
- The relative prefix is stored as a top-of-file constant in `golden-catalog.ts`; grep-friendly if it ever needs to move.

#### [D08] `errored` and `interrupted` are distinct transitions (DECIDED) {#d08-errored-vs-interrupted}

**Decision:** `turn_complete(result: "error")` routes to `interrupted → idle` (preserves text, commits to transcript). Infrastructure errors — **`SESSION_STATE errored` and transport close for T3.4.a** — route to `errored → idle` (populates `lastError`, transcript preserved but no new `TurnEntry` appended). CONTROL-error triggers (`session_not_owned`, `session_unknown`) are deferred out of T3.4.a scope; see Roadmap.

**Rationale:**
- `turn_complete(error)` is user-initiated (Stop button, typically) and carries valid in-flight content that should be saved.
- Infrastructure errors are out-of-band and usually mean the in-flight turn is lost or ambiguous.
- Conflating them would muddle the `lastError` snapshot field (what goes in `message`?) and mislead the UI.

**Implications:**
- The transition table has distinct rows for these events; the reducer dispatches on the event source, not on a generic "went wrong" predicate.
- `lastError.cause` enumerates only the `errored` causes T3.4.a actually produces: `"session_state_errored" | "transport_closed"`. CONTROL-error causes would extend this union when a future phase wires the CONTROL subscription.
- Exit criteria cover both paths separately.

#### [D09] `SessionMetadataStore` is independent (DECIDED) {#d09-metadata-store-independent}

**Decision:** `CodeSessionStore` does not subscribe to `SESSION_METADATA` and does not read `system_metadata` events from CODE_OUTPUT. `SessionMetadataStore` owns that feed independently. The Tide card holds references to both stores.

**Rationale:**
- `system_metadata` is chrome (model name, permission mode, slash commands, skills, plugins). It is not turn state.
- Separating concerns keeps both stores small and testable.
- `SessionMetadataStore` can cache the latest snapshot for display; `CodeSessionStore` doesn't need to know about it.

**Implications:**
- `CodeSessionStore`'s `FeedStore` subscribes to `[CODE_OUTPUT, SESSION_STATE]` only.
- `system_metadata` events that arrive on CODE_OUTPUT are ignored by the reducer (explicitly dropped, not crashed on).
- The card composes both stores at mount time.

#### [D10] `session_command` routing is out of scope (DECIDED) {#d10-session-command-out-of-scope}

**Decision:** T3.4.a does not handle `session_command: "new" | "continue" | "fork"`. The store treats one `CodeSessionStore` instance as bound to one Claude subprocess; multi-turn continuation within a single store is the only supported model.

**Rationale:**
- The `test-13 / test-17 / test-20` fixtures are skipped in the `v2.1.105/` manifest pending [P16](./tide.md#p16-session-command-continue).
- Shipping `session_command` handling before the router bug is fixed would mean writing code against a known-broken surface.
- Single-session-per-store is the cleanest default and covers the 95% case.

**Implications:**
- Multi-session-within-a-card is a follow-up — either by opening multiple Tide cards (T3.4.c) or by P16 + a later `CodeSessionStore` revision.
- The reducer does not handle the `pending-fork` / `pending-new` `session_init` variants; fixtures `test-13/17/20` remain skipped.

#### [D11] Effect-list reducer return type (DECIDED) {#d11-effect-list-reducer}

**Decision:** The internal reducer is a pure function with signature `reduce(state: CodeSessionState, event: CodeSessionEvent) => { state: CodeSessionState; effects: Effect[] }`. `Effect` is a discriminated union: `WriteInflight`, `ClearInflight`, `SendFrame`, `AppendTranscript`. The class wrapper processes the returned `effects[]` after each dispatch; the reducer itself touches no store, no connection, no PropertyStore, no clock.

**Rationale:**
- A pure `(state, event) => state` signature cannot carry side-effect intent, and the pre-revision plan left this unspecified across Steps 3–8 (every step said "the reducer emits a side-effect signal" with no defined channel).
- State-diff observation (the alternative — wrapper diffs old→new state to infer effects) is harder to reason about, brittle to extend, and loses the benefit of explicit intent per dispatch.
- An effect list makes every side effect first-class and grep-able. Tests can assert both state and effects on a single reducer call without any live-store setup.
- Matches L22 (external state drives DOM updates via store observers, not React round-trips): `WriteInflight` effects are processed synchronously by the class wrapper and land on the PropertyStore before the next tick.
- Matches L02 (external state enters React through `useSyncExternalStore` only): the class wrapper is the L02 store; its `subscribe` / `getSnapshot` surface the *result* of processing effects, not the effects themselves.

**Implications:**
- `CodeSessionState` holds only reducer-internal state: `phase`, `activeMsgId`, `scratch: Map<msgId, {assistant, thinking}>`, `toolCallMap: Map<tool_use_id, ToolCallState>`, `pendingApproval`, `pendingQuestion`, `prevPhase`, `queuedSends`, `lastCostUsd`, `claudeSessionId`, `lastError`. **Not** `transcript`, **not** `streamingDocument`.
- The class wrapper holds `_transcript: TurnEntry[]`, the `streamingDocument: PropertyStore` instance, the live `FeedStore` subscription, the `conn.onClose` unsubscribe, and the subscriber list.
- After every `reduce()` call, the wrapper walks `effects[]` in order and executes each:
  - `WriteInflight { path, value }` → `streamingDocument.set(path, value)`
  - `ClearInflight` → sets all three `inflight.*` paths to `""` (or `"[]"` for tools)
  - `SendFrame { msg }` → encodes via `encodeCodeInput(msg, tugSessionId)` and calls `conn.send(FeedId.CODE_INPUT, payloadBytes)`
  - `AppendTranscript { entry }` → pushes to `_transcript`; schedules a snapshot revision and `notifyListeners()`
- Reducer unit tests call `reduce(state, event)` directly and assert `{ state, effects }` — no class, no connection, no PropertyStore, no timers.
- Class integration tests drive events through `MockTugConnection` + `MockFeedStore` and assert against `getSnapshot()` and the recorded effect side effects.
- **`getSnapshot()` must return a stable reference between dispatches that produce no state change or transcript append.** `useSyncExternalStore` (T3.4.b) requires this — if the snapshot is rebuilt on every call, React will tear or infinite-loop. The class wrapper caches the last-built snapshot in a `_cachedSnapshot: CodeSessionSnapshot | null` field. The cache is invalidated (set to `null`) after any `processEffects` call that changed reducer state, appended to `_transcript`, or advanced `claudeSessionId`. `getSnapshot()` returns the cached object if present, otherwise rebuilds and caches. T3.4.a is React-free but the public surface it defines traps T3.4.b without this memoization.

---

### Deep Dives {#deep-dives}

#### Turn-state machine walkthrough {#turn-state-walkthrough}

The reducer is a pure function with signature `reduce(state: CodeSessionState, event: CodeSessionEvent) => { state: CodeSessionState; effects: Effect[] }` ([D11]), where `CodeSessionEvent` is a discriminated union over:
- Decoded stream-json events from CODE_OUTPUT (`assistant_text`, `thinking_text`, `tool_use`, `tool_result`, `tool_use_structured`, `control_request_forward`, `turn_complete`, `cost_update`, plus a passthrough for `session_init` and an explicit drop for `system_metadata`).
- Decoded SESSION_STATE frames (`pending`, `spawning`, `live`, `errored`, `closed`).
- Internal action events (`send`, `interrupt`, `respondApproval`, `respondQuestion`) — fed into the reducer synchronously from the public class methods.
- Transport events (`transportClose`).

`CodeSessionState` carries the reducer's working state: `phase`, `activeMsgId`, scratch buffers (`Map<msgId, {assistant, thinking}>`), `toolCallMap: Map<tool_use_id, ToolCallState>`, `pendingApproval`, `pendingQuestion`, `prevPhase`, `queuedSends: SendArgs[]`, `lastError`, `lastCostUsd`, `claudeSessionId`. **`transcript` is NOT in this state** — the class wrapper owns `_transcript: TurnEntry[]` and appends to it in response to `AppendTranscript` effects.

`Effect` is a discriminated union ([D11], Spec S07):
- `WriteInflight { path: InflightPath; value: string }` — write to `streamingDocument` at a stable path.
- `ClearInflight` — clear all three `inflight.*` paths to their empty state.
- `SendFrame { msg: InboundMessage }` — encode via `encodeCodeInput(msg, tugSessionId)` and write to CODE_INPUT.
- `AppendTranscript { entry: TurnEntry }` — append to the wrapper's `_transcript`.

**`idle → submitting` on `send()`:** The reducer receives an internal `send` event carrying `{ text, atoms }` (no `route` — [D03]; route is a leading atom in `atoms` if present). If `phase === "idle"`, the reducer returns the new state (`submitting`) and `effects: [SendFrame { msg: { type: "user_message", text, attachments } }]`. If `phase !== "idle"`, it appends to `queuedSends` and returns the unchanged phase with `effects: []`. From `errored`, the send is treated as a manual retry — `lastError` stays non-null until the next `turn_complete(success)` lands.

**`submitting → awaiting_first_token → streaming`:** The first `thinking_text` or `assistant_text` partial with a fresh `msg_id` drives `submitting → awaiting_first_token`. The `awaiting_first_token` phase is **always emitted as a distinct subscriber notification** for text-first turns (per OQ3 resolution) so T3.4.b's `tug-prompt-entry` has a clean phase to render a "connecting…" affordance distinct from the streaming spinner. The reducer applies the phase transition on the first partial event and emits one `WriteInflight` effect; `processEffects` calls `notifyListeners()` once with `phase === "awaiting_first_token"`. On the **next** partial event (the second delta), the reducer transitions to `phase: "streaming"` and emits another `WriteInflight` effect; `notifyListeners()` fires again with the new phase. Observers see two distinct notifications between `submitting` and `streaming` — a small cost (one extra notify per turn) for a clean UI hook.

**Tool-first turns skip `awaiting_first_token`.** When the first post-`send` CODE_OUTPUT event is a `tool_use` (e.g. `v2.1.105/test-05`, `test-07`), the reducer transitions `submitting → tool_work` in one notify. There is no text token to react to, and forcing a synthetic pass through `awaiting_first_token` would require the reducer to fabricate a notification with no effect payload. `tug-prompt-entry` (T3.4.b) compensates by treating `phase ∈ { submitting, awaiting_first_token }` as the "connecting…" window — tool-first flows stay in `submitting` until the first `tool_use` flips straight to `tool_work`, and the UI renders the same affordance throughout. See the transition table in [tide.md §Turn-state machine](./tide.md#) for the canonical statement.

**`streaming` delta accumulation:** Each `assistant_text` partial (`is_partial: true`) appends `text` to the scratch buffer keyed by `msg_id` inside the reducer's state. The reducer returns `effects: [WriteInflight { path: "inflight.assistant", value: newBuffer }]`. On `is_partial: false` (the `complete` event), the scratch buffer is replaced with the authoritative full text, and the same effect is emitted. **`turn_complete` is a separate event** — the reducer does not commit to transcript on `is_partial: false`; it waits for `turn_complete`.

**`streaming ↔ tool_work`:** A `tool_use` partial upserts a `ToolCallState` in `toolCallMap` and transitions to `tool_work`. A `tool_result` or `tool_use_structured` matching an existing `tool_use_id` marks that entry `done` (or `error`). The phase returns to `streaming` only when all entries are `done` (covers interleaved concurrent calls). Additional `tool_use` partials arriving while already in `tool_work` add more map entries without a phase change. Every tool event emits `WriteInflight { path: "inflight.tools", value: JSON.stringify(Array.from(toolCallMap.values())) }`.

**`streaming / tool_work → awaiting_approval`:** A `control_request_forward` event populates `pendingApproval` (if `is_question === false`) or `pendingQuestion` (if `is_question === true`) and transitions to `awaiting_approval`, stashing the current phase in `prevPhase`. `canInterrupt` remains true — the user can still Stop during an approval wait. `respondApproval` / `respondQuestion` return `effects: [SendFrame { msg: { type: "tool_approval", ... } }]` (or `question_answer`) and transition back to `prevPhase`.

**`turn_complete(success) → complete → idle`:** The reducer builds a `TurnEntry` from the scratch state for `activeMsgId`, returns effects `[AppendTranscript { entry }, ClearInflight]`, transitions through `complete` to `idle`, and — if `queuedSends` is non-empty — **immediately dispatches** an internal `send` event for the next queued entry in the same reducer tick, which drives `idle → submitting` with an additional `SendFrame` effect appended to the effect list. The class wrapper notifies subscribers once after all effects are processed; observers see a direct `... → idle → submitting` transition when the queue is non-empty (the intermediate `complete`/`idle` phases are real but collapsed into a single notify tick).

**`turn_complete(error) → interrupted → idle`:** Same structure, except the committed `TurnEntry` has `result: "interrupted"` (with the preserved accumulated text), and `queuedSends` is **cleared** on the transition to `idle` (per [D05]) — no queued `send` re-dispatch.

**`errored` transitions:** Either of the two triggers for T3.4.a (SESSION_STATE errored, transport close — CONTROL-error triggers are deferred per [OF11] and live in Roadmap) route to `errored` with `lastError` populated. Transcript is preserved as-is — no new entry is appended. The next `send()` from `errored` re-enters `submitting`; `lastError` clears after the next `turn_complete(success)`.

#### Reducer split for testability {#reducer-split}

`CodeSessionStore` is the public class, but the reducer logic lives in a separate internal module:

```
tugdeck/src/lib/code-session-store.ts          — public class, owns FeedStore + PropertyStore + _transcript
tugdeck/src/lib/code-session-store/reducer.ts  — pure (state, event) => { state, effects } function
tugdeck/src/lib/code-session-store/events.ts   — decoded event type definitions
tugdeck/src/lib/code-session-store/effects.ts  — Effect discriminated union + effect type guards
tugdeck/src/lib/code-session-store/types.ts    — snapshot + TurnEntry + ToolCallState types
tugdeck/src/lib/code-session-store/testing/golden-catalog.ts     — fixture loader
tugdeck/src/lib/code-session-store/testing/mock-feed-store.ts    — in-memory FeedStore double + outbound frame decoder
```

Reducer tests exercise `reducer.ts` directly: call `reduce(state, event)`, assert on the returned `{ state, effects }` tuple. No class, no connection, no PropertyStore. Class integration tests (via `mock-feed-store.ts`) drive the full subscribe-decode-dispatch loop against a `MockTugConnection` that records every outbound frame with a decoded JSON view for assertions. Both levels run under `bun test`.

---

### Specification {#specification}

#### Spec S01: `CodeSessionStore` public surface {#s01-public-surface}

```ts
// tugdeck/src/lib/code-session-store.ts

export interface CodeSessionStoreOptions {
  conn: TugConnection;
  tugSessionId: string;
  displayLabel?: string;
}

export class CodeSessionStore {
  readonly streamingDocument: PropertyStore;

  constructor(options: CodeSessionStoreOptions);

  // L02 store protocol.
  subscribe(listener: () => void): () => void;
  getSnapshot(): CodeSessionSnapshot;

  // Actions.
  // The route (>, $, :) — when present — is the leading atom in `atoms`.
  // T3.4.b's tug-prompt-entry owns route extraction; the store is route-oblivious.
  send(text: string, atoms: AtomSegment[]): void;
  interrupt(): void;
  respondApproval(
    requestId: string,
    payload: {
      decision: "allow" | "deny";
      updatedInput?: unknown;
      message?: string;
    },
  ): void;
  respondQuestion(
    requestId: string,
    payload: { answers: Record<string, unknown> },
  ): void;

  dispose(): void;
}
```

#### Spec S02: `CodeSessionSnapshot` shape {#s02-snapshot}

```ts
export type CodeSessionPhase =
  | "idle"
  | "submitting"
  | "awaiting_first_token"
  | "streaming"
  | "tool_work"
  | "awaiting_approval"
  | "complete"
  | "interrupted"
  | "errored";

export interface CodeSessionSnapshot {
  phase: CodeSessionPhase;

  tugSessionId: string;
  claudeSessionId: string | null;
  displayLabel: string;

  activeMsgId: string | null;
  canSubmit: boolean;
  canInterrupt: boolean;
  pendingApproval: ControlRequestForward | null;
  pendingQuestion: ControlRequestForward | null;
  queuedSends: number;

  transcript: ReadonlyArray<TurnEntry>;

  streamingPaths: {
    readonly assistant: "inflight.assistant";
    readonly thinking: "inflight.thinking";
    readonly tools: "inflight.tools";
  };

  lastCostUsd: number | null;
  lastError: {
    cause: "session_state_errored" | "transport_closed";
    message: string;
    at: number;
  } | null;
}

export interface TurnEntry {
  msgId: string;
  userMessage: { text: string; attachments: ReadonlyArray<unknown> };
  thinking: string;
  assistant: string;
  toolCalls: ReadonlyArray<ToolCallState>;
  result: "success" | "interrupted";
  endedAt: number;
}

export interface ToolCallState {
  toolUseId: string;
  toolName: string;
  input: unknown;
  status: "pending" | "done" | "error";
  result: unknown | null;
  structuredResult: unknown | null;
}
```

#### Spec S03: Turn-state transition table {#s03-transitions}

| From | Event | To | Side effects |
|------|-------|----|---|
| `idle` | internal `send` | `submitting` | Write `user_message` to CODE_INPUT via `encodeCodeInput` |
| `submitting` | first `thinking_text` / `assistant_text` partial (new `msg_id`) | `awaiting_first_token` → `streaming` | Initialize scratch buffers; set `activeMsgId` |
| `streaming` | `assistant_text` partial (`is_partial: true`) | `streaming` | Append delta; write `inflight.assistant` |
| `streaming` | `assistant_text` partial (`is_partial: false`) | `streaming` | Replace scratch with authoritative `text` |
| `streaming` | `thinking_text` partial | `streaming` | Append delta; write `inflight.thinking` |
| `streaming` | `tool_use` partial/complete | `tool_work` | Upsert `ToolCallState` in tool map; write `inflight.tools` |
| `tool_work` | `tool_use_structured` / `tool_result` (matching `tool_use_id`) | `streaming` (if all tools done) / `tool_work` (otherwise) | Mark entry `done`; update `inflight.tools` |
| `streaming` / `tool_work` | `control_request_forward` (`is_question: false`) | `awaiting_approval` | Populate `pendingApproval`; stash `prevPhase` |
| `streaming` / `tool_work` | `control_request_forward` (`is_question: true`) | `awaiting_approval` | Populate `pendingQuestion`; stash `prevPhase` |
| `awaiting_approval` | `respondApproval(...)` | `prevPhase` | Write `tool_approval` to CODE_INPUT; clear `pendingApproval` |
| `awaiting_approval` | `respondQuestion(...)` | `prevPhase` | Write `question_answer` to CODE_INPUT; clear `pendingQuestion` |
| any non-idle | `turn_complete(result: "success")` AND `queuedSends` empty | `complete` → `idle` | Commit `TurnEntry(result: "success")`; clear `inflight.*`. Subscribers notified once; observers see `… → idle`. |
| any non-idle | `turn_complete(result: "success")` AND `queuedSends` non-empty | `complete` → `idle` → `submitting` | Commit `TurnEntry`; clear `inflight.*`; shift one entry off `queuedSends`; dispatch an internal `send` event in the same reducer tick. Subscribers notified **once** at the end of the tick; observers see a direct `… → submitting` transition without an intermediate `idle` notification. |
| any non-idle | `turn_complete(result: "error")` | `interrupted` → `idle` | Commit `TurnEntry(result: "interrupted")` with preserved text; clear `inflight.*`; **clear queue** (per [D05]). No queued re-dispatch. |
| any non-idle | `SESSION_STATE = errored` | `errored` → `idle` | Populate `lastError.cause = "session_state_errored"` |
| any non-idle | `transportClose` | `errored` → `idle` | Populate `lastError.cause = "transport_closed"` |
| `errored` | internal `send` | `submitting` | Same as `idle → submitting`; `lastError` stays set until next `turn_complete(success)` |

#### Spec S04: `errored` trigger table {#s04-errored-triggers}

T3.4.a ships with two `errored` triggers. CONTROL-error triggers (`session_not_owned`, `session_unknown`) are deferred to a follow-on — see Roadmap.

| Trigger | Source | `lastError.cause` | Detection |
|---------|--------|-------------------|-----------|
| `SESSION_STATE = errored` frame | Supervisor (crash budget, future P13 caps) | `"session_state_errored"` | Filter-matched SESSION_STATE with `state === "errored"`; `detail` copied into `message` |
| WebSocket close during non-idle phase | Transport | `"transport_closed"` | `TugConnection.onClose(callback)` at `tugdeck/src/connection.ts:297`; the store subscribes at construction and unsubscribes in `dispose()`, and the reducer only transitions to `errored` when the close event arrives while `phase !== "idle"` |

Not in scope for `errored`:
- `turn_complete(result: "error")` — interrupt path, routes to `interrupted`.
- Malformed stream-json events — logged via `console.warn` and dropped; phase unchanged. Version drift is P15 territory.
- CONTROL error frames (`session_not_owned`, `session_unknown`) — deferred. The shape is understood per [§P2 integration reference](./tide.md#p2-integration-reference) but the tugdeck-side CONTROL subscription + dispatch path is beyond T3.4.a scope. An unauthorized or orphaned session will surface as a `SESSION_STATE = errored` or a transport close in practice; if neither fires, the store stays non-idle until the user intervenes or a later phase adds explicit CONTROL error handling.

#### Spec S05: Streaming document paths and schema {#s05-streaming-paths}

`streamingDocument` is a `PropertyStore` (`tugdeck/src/components/tugways/property-store.ts`). Verified against source: `PropertyStoreOptions` has `schema: PropertyDescriptor[]` as a **flat array** (not nested under `paths`) and `initialValues: Record<string, unknown>` as a **required** field that seeds every path in one shot. `set(path, value, source)` is 3-arg and throws on paths not in the schema. Every write from this store passes `source: "code-session-store"`.

**Constructor shape:**

```ts
const descriptors: PropertyDescriptor[] = [
  { path: "inflight.assistant", type: "string", label: "In-flight assistant text" },
  { path: "inflight.thinking",  type: "string", label: "In-flight thinking text"  },
  { path: "inflight.tools",     type: "string", label: "In-flight tool calls (JSON string)" },
];

const streamingDocument = new PropertyStore({
  schema: descriptors,
  initialValues: {
    "inflight.assistant": "",
    "inflight.thinking":  "",
    "inflight.tools":     "[]",
  },
});
```

The PropertyStore constructor walks `options.schema` and pulls each descriptor's initial value from `options.initialValues[descriptor.path]` (source: `property-store.ts:163-167`). There is **no need** to follow the construction with three `set()` calls to seed values — `initialValues` handles it in one shot. Listeners are not yet registered at construction time, so no `PropertyChange` record is emitted for the initial seeding.

**Path lifecycle:**

| Path | Initial value | Rationale |
|------|---------------|-----------|
| `inflight.assistant` | `""` | Empty string; `TugMarkdownView` renders nothing. |
| `inflight.thinking` | `""` | Same. |
| `inflight.tools` | `"[]"` | Empty JSON array so consumers can `JSON.parse` without branching. |

**Writers and lifecycles:**

| Path | Content | Writer | Clear on |
|------|---------|--------|----------|
| `inflight.assistant` | Accumulated `assistant_text` delta buffer for the current turn | `WriteInflight` effect (Spec S07) | `turn_complete` (any result) |
| `inflight.thinking` | Accumulated `thinking_text` delta buffer | same | same |
| `inflight.tools` | Serialized `ToolCallState[]` (JSON string via `JSON.stringify(Array.from(toolCallMap.values()))`) | same | same |

**Why `type: "string"` for `inflight.tools` instead of a richer structured type:** PropertyStore's schema types are `string | number | boolean | color | point | enum` — there is no `json` or `object` type. Serializing the tool map to a JSON string on write and letting consumers `JSON.parse` on read is the narrowest-impact way to ship this without expanding PropertyStore's type system. T3.4.c's `TugMarkdownView` tool-call renderer parses the string when the path changes.

The three path strings are exposed on the snapshot as `streamingPaths` literal types (`"inflight.assistant"` etc.) for TS consumers threading them through props.

#### Spec S06: `loadGoldenProbe` test helper {#s06-golden-loader}

```ts
// tugdeck/src/lib/code-session-store/testing/golden-catalog.ts

// import.meta.dir resolves to the current module's directory under bun's
// ESM runtime — this is bun's equivalent of Node's CommonJS __dirname and
// the correct primitive for fixture-path resolution in bun test.
const FIXTURE_ROOT_RELATIVE =
  "../../../../tugrust/crates/tugcast/tests/fixtures/stream-json-catalog";

// Canonical pinned values for identity classes. Used directly when the fixture
// has exactly one occurrence of a given ID field, and as the base name for
// occurrence-indexed IDs when a fixture has multiple distinct occurrences.
export const FIXTURE_IDS = {
  TUG_SESSION_ID:    "tug00000-0000-4000-8000-000000000001",
  CLAUDE_SESSION_ID: "cla00000-0000-4000-8000-000000000001",
  MSG_ID:            "msg00000-0000-4000-8000-000000000001",
  TOOL_USE_ID:       "tool0000-0000-4000-8000-000000000001",
  REQUEST_ID:        "req00000-0000-4000-8000-000000000001",
  TASK_ID:           "task0000-0000-4000-8000-000000000001",
  CWD:               "/tmp/fixture-cwd",
  // Occurrence-indexed variants for fields that appear multiple distinct times.
  // The loader assigns these in walk order — see "Occurrence-aware substitution".
  MSG_ID_N:          (n: number) => `msg00000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  TOOL_USE_ID_N:     (n: number) => `tool0000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  REQUEST_ID_N:      (n: number) => `req00000-0000-4000-8000-${String(n).padStart(12, "0")}`,
} as const;

export interface GoldenProbe {
  version: string;
  probeName: string;
  events: ReadonlyArray<DecodedCodeOutputEvent>;
}

export function loadGoldenProbe(
  version: string,
  probeName: string,
): GoldenProbe;
```

The helper resolves `<FIXTURE_ROOT_RELATIVE>/<version>/<probeName>.jsonl` via `import.meta.dir` (bun's ESM equivalent of `__dirname`), parses one event per line, substitutes placeholders using the occurrence-aware strategy below, and returns the event list. Throws a readable `Error` naming the resolved absolute path when the file is missing.

**Placeholder vocabulary actually used in `v2.1.105/` fixtures** (verified by `grep -o '{{[^}]*}}' v2.1.105/*.jsonl | sort -u`):

| Token | Where it appears | Substitution |
|-------|------------------|--------------|
| `{{uuid}}` | `session_id`, `tug_session_id`, `msg_id`, `tool_use_id`, `request_id` | **Field + occurrence aware** — see below. |
| `{{cwd}}` | `system_metadata.cwd`, plugin/path strings | Replace with `FIXTURE_IDS.CWD`. Preserve the suffix path (e.g. `{{cwd}}/Mounts/u/src/tugtool` → `/tmp/fixture-cwd/Mounts/u/src/tugtool`). |
| `{{f64}}` | `total_cost_usd`, cost fields | Replace with `0.0` (raw numeric literal). |
| `{{i64}}` | Token counts, `duration_ms`, etc. | Replace with `0` (raw numeric). |
| `{{text:len=N}}` | `assistant_text.text`, `thinking_text.text`, `tool_result.output` | Replace with `"x"` repeated N times (pinned length). |

**Occurrence-aware `{{uuid}}` substitution — the load-bearing detail.** The Rust catalog normalizer at `tugrust/crates/tugcast/tests/common/catalog.rs:100-112` collapses every value in the `LEAF_ID_KEYS` set (`session_id`, `tug_session_id`, `msg_id`, `tool_use_id`, `request_id`) to the literal token `"{{uuid}}"`, **regardless of source distinctness**. So `test-07-multiple-tool-calls.jsonl` — which has four real distinct `tool_use_id` values at capture time — serializes all four as `"tool_use_id": "{{uuid}}"`. A naive one-constant-per-field substitution collapses all four into `FIXTURE_IDS.TOOL_USE_ID`, which makes any "multiple overlapping ids" assertion physically unsatisfiable.

The loader addresses this by:

1. **Walk the entire event list once** before substituting anything. Build a per-field occurrence map: for each `(fieldName, eventIndex)` pair where the value is `"{{uuid}}"`, assign an **occurrence counter** scoped to that field name. Distinct logical occurrences bump the counter; repeated mentions of the same logical occurrence (e.g. a `tool_result.tool_use_id` referencing a prior `tool_use.tool_use_id`) reuse the counter via event-grouping heuristics.

2. **Grouping heuristics for ID reuse within a probe.** These are derived from inspection of `v2.1.105/test-01`, `test-05-tool-use-read`, and `test-07-multiple-tool-calls` — the heuristics below are verified to produce the correct idMap against those fixtures.

   - **`tug_session_id`:** always one value across the whole probe → `FIXTURE_IDS.TUG_SESSION_ID`.
   - **`session_id`** (Claude's id, in `session_init` and `system_metadata`): always one value → `FIXTURE_IDS.CLAUDE_SESSION_ID`.
   - **`msg_id`:** one value per logical turn. A new `assistant_text` partial with `rev: 0, seq: 0` (and no prior open turn) starts a new msg_id; subsequent partials with the same msg_id in the fixture (now all `{{uuid}}`) and the final `is_partial: false` reuse it. Most v2.1.105 probes have one turn → `FIXTURE_IDS.MSG_ID`. Multi-turn probes get `FIXTURE_IDS.MSG_ID_N(1)`, `MSG_ID_N(2)`, ... in stream order. **Caveat:** `tool_use` events also carry `msg_id` — treat them as belonging to the current open turn (no new msg_id bump).
   - **`tool_use_id` — the load-bearing case.** Claude streams `tool_use` incrementally per the essential wire-level invariants: an initial event with `input: {}` opens a logical call, and a subsequent `tool_use` event with the **same `tool_name`** and non-empty `input` completes it. Multiple calls to the same tool can be in flight concurrently. The loader groups logical calls as follows:

     a. Walk events in order, maintaining two stacks: `pendingInput[]` (calls whose `input` field is still `{}`) and `completeInput[]` (calls whose `input` has been filled in and which are waiting for a result).

     b. On `tool_use` with **empty `input`** (`Object.keys(input).length === 0`): push a **new logical call** onto `pendingInput` with a fresh counter value (`TOOL_USE_ID_N(k)` where `k` is the next counter index). This is a **new** logical id.

     c. On `tool_use` with **non-empty `input`**: pop the **most recent** entry from `pendingInput` whose `tool_name` matches (LIFO within a tool_name), mark it complete-input, push onto `completeInput`. This is a **continuation** (same logical id as the pending entry). If no matching pending entry exists, fall back to treating it as a new id with a warning (should not happen for v2.1.105 probes).

     d. On `tool_result`: pop the **oldest** entry from `completeInput` (FIFO across tool_names) — this matches Claude's observed order where results come back in submission order. Bind this id to the `tool_result` event.

     e. On `tool_use_structured`: bind to the most recently resolved `tool_result` (they arrive in tight pairs per the essential wire-level invariants; `tool_use_structured.tool_name` is sometimes empty in the fixture normalizer output so matching on tool_name is not reliable).

     **Concrete expectations** (implementer must verify these on first loader run):

     | Fixture | Distinct logical tool_use_ids | Events per logical id |
     |---------|-------------------------------|----------------------|
     | `test-05-tool-use-read.jsonl` | **1** | `tool_use(input={})` → `tool_use(input=full)` → `tool_result` → `tool_use_structured` (all four events share `id_1`) |
     | `test-07-multiple-tool-calls.jsonl` | **2** | Group A: `tool_use(input={})` line 3 + `tool_use(input=full)` line 4 + `tool_result` line 6 + `tool_use_structured` line 7 = `id_1`. Group B: `tool_use(input={})` line 5 + `tool_use(input=full)` line 8 + `tool_result` line 9 + `tool_use_structured` line 10 = `id_2`. (Group B opens on line 5 while Group A is complete-input-not-resolved; line 6's result matches A, not B, because A is older in `completeInput`.) |

     The Step 2 loader test asserts `probe.idMap.toolUseIds.length === 1` for test-05 and `=== 2` for test-07, plus the per-event id assignments match the table above.

   - **`request_id`:** one value per `control_request_forward` event. Multiple forwards in one probe (none in v2.1.105) → `REQUEST_ID_N`.

3. **Expose the grouping via a per-probe `idMap`** on the returned `GoldenProbe`: `{ msgIds: string[], toolUseIds: string[], requestIds: string[] }`. Tests can assert on exact values without re-deriving the walk. For single-occurrence probes, `toolUseIds` has length 1 and `toolUseIds[0] === FIXTURE_IDS.TOOL_USE_ID`.

4. **Falsification check.** The loader throws if a `{{uuid}}` value is found in a field not in the known list (`session_id`, `tug_session_id`, `msg_id`, `tool_use_id`, `request_id`, `task_id`, plus `claude_session_id` for the P14-reserved field). The `task_id` entry is included because the Rust catalog normalizer's `LEAF_ID_KEYS` set at `tugrust/crates/tugcast/tests/common/catalog.rs:100-112` includes it — no current v2.1.105 fixture uses it, but a future capture covering `system:task_started` events would trip the falsification throw without this entry. For `task_id`, substitute with `FIXTURE_IDS.TASK_ID` (a pinned value added to the `FIXTURE_IDS` constants alongside the others).

**Why field-aware alone is not enough:** a field-aware strategy that assigned one constant per field name would work for `tug_session_id` (always one value per probe) but fail for `tool_use_id` in `test-07` (four distinct captured values, all normalized to the same token). Occurrence-aware substitution walks the event stream once, groups by logical occurrence, and assigns distinct values only where the source fixture had distinct values. This preserves the reducer-testability property: a store processing a golden probe sees the same correlation structure it would see from a live capture.

**Tokens the plan does NOT need** (the fixtures do not use them): `{{iso}}`, `{{msg_id}}`, `{{tool_use_id}}`. IDs are always `{{uuid}}` under the Rust normalizer; timestamps appear as raw numeric placeholders under `{{i64}}` or plain unsubstituted strings where the event type does not emit timestamps.

#### Spec S07: Effect discriminated union {#s07-effect-union}

T3.4.a adds two new exports to `tugdeck/src/protocol.ts` — `InboundMessage` (a discriminated union) and `encodeCodeInputPayload` (a payload-only encoder) — because the existing `protocol.ts` only ships `encodeCodeInput`, which returns a fully-framed `ArrayBuffer`, and uses `msg: object` as an untyped parameter. Both additions land in Step 1 (Scaffolding) as protocol-module additions, not as internal code-session-store types.

```ts
// tugdeck/src/protocol.ts — NEW exports added in Step 1

/**
 * Client-to-server message shapes for the CODE_INPUT feed. The union mirrors
 * the stream-json inbound messages tugcode accepts (see tugcode/src/types.ts).
 * T3.4.a only emits the first four; the rest are listed for completeness so
 * T3.4.b / T3.4.c can extend without re-opening the union.
 */
export type InboundMessage =
  | { type: "user_message"; text: string; attachments: unknown[] }
  | { type: "interrupt" }
  | {
      type: "tool_approval";
      request_id: string;
      decision: "allow" | "deny";
      updatedInput?: unknown;
      message?: string;
    }
  | { type: "question_answer"; request_id: string; answers: Record<string, unknown> }
  | { type: "permission_mode"; mode: string }
  | { type: "model_change"; model: string }
  | { type: "session_command"; command: "new" | "continue" | "fork" }
  | { type: "stop_task"; task_id: string };

/**
 * Encode an InboundMessage as the raw JSON payload bytes (no frame header).
 * Paired with TugConnection.send(FeedId.CODE_INPUT, payload), which wraps the
 * payload in a frame at the connection layer. This is the inverse-ready helper
 * — MockTugConnection's decodeCodeInputPayload reverses it for test assertions.
 *
 * This is distinct from the existing encodeCodeInput, which returns a fully
 * framed ArrayBuffer. encodeCodeInput stays for callers that want one-shot
 * framing; encodeCodeInputPayload is for the TugConnection.send pathway.
 */
export function encodeCodeInputPayload(
  msg: InboundMessage,
  tugSessionId: string,
): Uint8Array;

/**
 * Inverse of encodeCodeInputPayload — used by MockTugConnection in tests to
 * decode outbound frame payloads into structured InboundMessage objects for
 * assertion. Not called from production code paths.
 */
export function decodeCodeInputPayload(payload: Uint8Array): InboundMessage & {
  tug_session_id: string;
};
```

```ts
// tugdeck/src/lib/code-session-store/effects.ts

import type { InboundMessage } from "@/protocol";
import type { TurnEntry } from "./types";

export type InflightPath =
  | "inflight.assistant"
  | "inflight.thinking"
  | "inflight.tools";

export type Effect =
  | { kind: "write-inflight"; path: InflightPath; value: string }
  | { kind: "clear-inflight" }
  | { kind: "send-frame"; msg: InboundMessage }
  | { kind: "append-transcript"; entry: TurnEntry };

// Effect type guards (used by the class wrapper's processEffects switch).
export function isWriteInflight(e: Effect): e is Extract<Effect, { kind: "write-inflight" }>;
export function isClearInflight(e: Effect): e is Extract<Effect, { kind: "clear-inflight" }>;
export function isSendFrame(e: Effect): e is Extract<Effect, { kind: "send-frame" }>;
export function isAppendTranscript(e: Effect): e is Extract<Effect, { kind: "append-transcript" }>;
```

The class wrapper's `processEffects(effects: Effect[])` method walks the array in order and dispatches each:

- **`write-inflight`** → `this.streamingDocument.set(e.path, e.value, "code-session-store")`. The third argument is the `source` tag required by `PropertyStore.set(path, value, source)` (see Spec S05); using a constant store name satisfies the signature and makes changes traceable in observer records.
- **`clear-inflight`** → three `set` calls with the store source tag: `inflight.assistant → ""`, `inflight.thinking → ""`, `inflight.tools → "[]"`.
- **`send-frame`** → `this.conn.send(FeedId.CODE_INPUT, encodeCodeInputPayload(e.msg, this.tugSessionId))`. The payload helper is the Step 1 addition to `protocol.ts`; `conn.send` wraps it in a frame at the connection layer.
- **`append-transcript`** → pushes `e.entry` onto `this._transcript`.

At the **end** of `processEffects()` (after all effects in the batch are applied), the wrapper calls `notifyListeners()` **once** — not per effect. This makes the queue-collapse behavior from [S03] observable as a single notification with a final `submitting` phase, rather than as a flicker through intermediate phases.

**Ordering within one reduce() call:** effects are processed in array order. For a `turn_complete(success)` with a non-empty queue, the effect list is `[append-transcript, clear-inflight, send-frame(next-queued)]` and the reducer returns state with `phase: "submitting"`. Observers see: one `notifyListeners()` call, final `phase === "submitting"`, transcript has the completed turn, inflight cleared, next frame sent.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

> **Note:** `tugdeck/src/protocol.ts` is an **existing** file, not new. T3.4.a adds three new exports to it (`InboundMessage`, `encodeCodeInputPayload`, `decodeCodeInputPayload`) in Step 1. Listed below under "Symbols to add / modify".

| File | Purpose |
|------|---------|
| `tugdeck/src/lib/code-session-store.ts` | Public `CodeSessionStore` class, owns `FeedStore` + `streamingDocument` + `_transcript` + `onClose` unsubscribe; re-exports of snapshot + TurnEntry types |
| `tugdeck/src/lib/code-session-store/reducer.ts` | Pure reducer function `reduce(state, event) => { state, effects }` + `CodeSessionState` shape + initial-state factory |
| `tugdeck/src/lib/code-session-store/events.ts` | Discriminated union of decoded events the reducer accepts |
| `tugdeck/src/lib/code-session-store/effects.ts` | `Effect` discriminated union (Spec S07) + type guards + `processEffects` helper (invoked by the class wrapper) |
| `tugdeck/src/lib/code-session-store/types.ts` | `CodeSessionSnapshot`, `CodeSessionPhase`, `TurnEntry`, `ToolCallState`, `ControlRequestForward` (re-export) |
| `tugdeck/src/lib/code-session-store/testing/golden-catalog.ts` | `loadGoldenProbe`, `FIXTURE_IDS` constants, field-aware placeholder substitution (test-only) |
| `tugdeck/src/lib/code-session-store/testing/mock-feed-store.ts` | `MockTugConnection` (records outbound frames with decoded JSON view) + `MockFeedStore` double (test-only) |
| `tugdeck/src/lib/code-session-store/__tests__/code-session-store.scaffold.test.ts` | Step 1 scaffold sanity: construct a store, call `getSnapshot`, assert initial shape |
| `tugdeck/src/lib/code-session-store/__tests__/code-session-store.round-trip.test.ts` | Basic round-trip exit-criteria test |
| `tugdeck/src/lib/code-session-store/__tests__/code-session-store.deltas.test.ts` | Streaming delta accumulation details |
| `tugdeck/src/lib/code-session-store/__tests__/code-session-store.tools.test.ts` | Tool lifecycle + concurrent tool tests |
| `tugdeck/src/lib/code-session-store/__tests__/code-session-store.control-forward.test.ts` | Permission approval (synthetic) + deny (`test-11-permission-deny-roundtrip`) + AskUserQuestion (synthetic — `test-35` is empty/skipped upstream) |
| `tugdeck/src/lib/code-session-store/__tests__/code-session-store.interrupt.test.ts` | Interrupt + queue-clearing tests |
| `tugdeck/src/lib/code-session-store/__tests__/code-session-store.queue.test.ts` | Queue flush on success |
| `tugdeck/src/lib/code-session-store/__tests__/code-session-store.errored.test.ts` | Errored triggers (SESSION_STATE, transport close) + recovery tests |
| `tugdeck/src/lib/code-session-store/__tests__/code-session-store.filter.test.ts` | Filter correctness across multi-instance |
| `tugdeck/src/lib/code-session-store/__tests__/code-session-store.dispose.test.ts` | Dispose teardown + no-react-imports negative check |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `CodeSessionStore` | class | `tugdeck/src/lib/code-session-store.ts` | Public L02 store |
| `CodeSessionStoreOptions` | interface | same | Constructor options |
| `CodeSessionSnapshot` | interface | `types.ts` | Public snapshot shape per [S02] |
| `CodeSessionPhase` | type | `types.ts` | Phase enum |
| `TurnEntry` | interface | `types.ts` | Immutable transcript entry |
| `ToolCallState` | interface | `types.ts` | Per-call state |
| `InboundMessage` | type (union) | `tugdeck/src/protocol.ts` | **New** per Spec S07 — eight-variant client-to-server message union. Added in Step 1. |
| `encodeCodeInputPayload` | function | `tugdeck/src/protocol.ts` | **New** — returns raw JSON-bytes payload (not framed), paired with `conn.send(FeedId.CODE_INPUT, payload)`. Added in Step 1. |
| `decodeCodeInputPayload` | function | `tugdeck/src/protocol.ts` | **New** — inverse of `encodeCodeInputPayload`, used by `MockTugConnection` for test assertions. Added in Step 1. |
| `CodeSessionState` | interface | `reducer.ts` | Reducer-internal state — does NOT include transcript or PropertyStore |
| `CodeSessionEvent` | type (union) | `events.ts` | Discriminated union of decoded events |
| `Effect` | type (union) | `effects.ts` | Per Spec S07 — `write-inflight` / `clear-inflight` / `send-frame` / `append-transcript` |
| `reduce` | function | `reducer.ts` | Pure `(state, event) => { state, effects }` |
| `processEffects` | function | `effects.ts` or inlined on class | Walks `effects[]` in order; dispatches writes to `streamingDocument` (3-arg `set` with `source: "code-session-store"`) / `conn.send` / `_transcript`; calls `notifyListeners()` once at end |
| `loadGoldenProbe` | function | `testing/golden-catalog.ts` | Test-only; occurrence-aware `{{uuid}}` substitution per Spec S06 |
| `FIXTURE_IDS` | const | `testing/golden-catalog.ts` | Test-only identity constants including occurrence-indexed helpers (`MSG_ID_N`, `TOOL_USE_ID_N`, `REQUEST_ID_N`) |
| `MockFeedStore` / `MockTugConnection` | class | `testing/mock-feed-store.ts` | Test-only doubles; `MockTugConnection` decodes outbound frames via `decodeCodeInputPayload`; `replayRange(frames, start, end)` for Step 7 interleave |
| `codeSessionStore` re-export | barrel | `tugdeck/src/lib/index.ts` | Add `CodeSessionStore`, `CodeSessionSnapshot`, `TurnEntry` |
| `PropertyStore` | existing class | `tugdeck/src/components/tugways/property-store.ts` | **Already exists** — constructor requires `{ schema: PropertySchema }`; `set(path, value, source)` is 3-arg and throws on unknown paths. No changes to PropertyStore itself. |
| `TugConnection.onClose` | existing method | `tugdeck/src/connection.ts:297` | **Already exists** — `onClose(callback: () => void): () => void`. Store subscribes at construction, unsubscribes in `dispose()`. No connection-module changes. |

---

### Documentation Plan {#documentation-plan}

- [ ] One-paragraph JSDoc on `CodeSessionStore` class summarizing: per-card lifetime, identity model, transcript + streaming model, relationship to `CardSessionBindingStore`.
- [ ] One-line JSDoc on every public method (`send`, `interrupt`, `respondApproval`, `respondQuestion`, `dispose`, `subscribe`, `getSnapshot`).
- [ ] Inline comments on reducer transitions only where the wire behavior is non-obvious from the event name (interrupt path, concurrent tool correlation, approval `prevPhase` stashing). Default: no comments.
- [ ] Update [tide.md #t3-4-a-code-session-store](./tide.md#t3-4-a-code-session-store) to link this plan at the top with a "See [tugplan-code-session-store.md](./tugplan-code-session-store.md) for the implementation plan" pointer once this plan is approved.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Reducer unit** | Test `reduce(state, event) => state` in isolation against hand-built or fixture-loaded event sequences | Phase transitions, edge cases, error paths |
| **Store integration** | Test the full `CodeSessionStore` class with `MockFeedStore` driving events through subscribe/decode/dispatch | Subscription lifecycle, filter correctness, dispose teardown |
| **Fixture replay** | Test reducer + side-effect handler against `loadGoldenProbe(v2.1.105, ...)` JSONL streams | Exit-criteria tests aligned with fixture filenames |
| **Drift guard (inherited)** | Rust-side `stream_json_catalog_drift.rs` already exists and validates the fixture directory against live Claude | Runs out-of-band per [§P2 follow-up](./tide.md#p2-followup-golden-catalog) |

Every exit-criterion maps to a fixture replay test where the fixture exists, or to a reducer-unit test with synthetic events where the trigger is not in the golden catalog (e.g., `SESSION_STATE errored` synthetic frames, `transportClose` simulation).

---

### Execution Steps {#execution-steps}

> Every step commits after all checkpoints pass. Each step's `**References:**` line cites the [Dnn] decisions and [Snn] specs it implements.

#### Step 1: Scaffolding and types {#step-1}

**Commit:** `feat(tugdeck): scaffold code-session-store module + public types`

**References:** [D03] three-identifier model, [D04] transcript + streaming, [D09] metadata store independent, [D11] effect-list reducer, Spec S01, Spec S02, Spec S07, (#symbol-inventory, #turn-state-walkthrough, #reducer-split)

**Artifacts:**
- `tugdeck/src/protocol.ts` — **additions** (new exports): `InboundMessage` discriminated union, `encodeCodeInputPayload(msg, tugSessionId): Uint8Array`, `decodeCodeInputPayload(payload): InboundMessage & { tug_session_id: string }`. The existing `encodeCodeInput` function is left untouched for backward compat with any other caller that already uses it; T3.4.a's store uses the new payload helpers.
- `tugdeck/src/lib/code-session-store.ts` — skeleton class; constructor builds `streamingDocument: PropertyStore` with the Spec S05 schema, initializes all three paths to their empty values with `source: "code-session-store"`, initializes `_transcript: TurnEntry[] = []`, throws `"not implemented"` on every action method
- `tugdeck/src/lib/code-session-store/types.ts` — `CodeSessionSnapshot`, `CodeSessionPhase`, `TurnEntry`, `ToolCallState`, `ControlRequestForward` re-export
- `tugdeck/src/lib/code-session-store/events.ts` — empty `CodeSessionEvent` union placeholder
- `tugdeck/src/lib/code-session-store/effects.ts` — `Effect` union per Spec S07 + four type guards; `processEffects(effects, ctx)` stub (imports `InboundMessage` from `@/protocol`)
- `tugdeck/src/lib/code-session-store/reducer.ts` — `CodeSessionState` interface (**without** transcript), `createInitialState(tugSessionId, displayLabel)`, identity `reduce` stub returning `{ state, effects: [] }`
- `tugdeck/src/lib/index.ts` — add barrel re-exports for `CodeSessionStore`, `CodeSessionSnapshot`, `TurnEntry`

**Tasks:**
- [ ] **Add to `protocol.ts`:** define `InboundMessage` union (eight variants per Spec S07 — only the first four are emitted by T3.4.a, rest are forward-compat placeholders for T3.4.b/c). Define `encodeCodeInputPayload(msg, tugSessionId): Uint8Array` — returns `new TextEncoder().encode(JSON.stringify({ tug_session_id: tugSessionId, ...msg }))`, the same JSON bytes that `encodeCodeInput` wraps in a frame, minus the frame header. Define `decodeCodeInputPayload(payload): InboundMessage & { tug_session_id: string }` as the symmetric inverse (`JSON.parse(new TextDecoder().decode(payload))` + type assertion). Round-trip test: `decodeCodeInputPayload(encodeCodeInputPayload(msg, id))` equals `{ ...msg, tug_session_id: id }`.
- [ ] Declare the class, constructor, and all public methods (throwing `"not implemented"` except for `subscribe`/`getSnapshot`/`dispose`).
- [ ] Define all types in `types.ts` exactly per Spec S02. Import `AtomSegment` from `@/lib/tug-text-engine` (re-export of `@/lib/tug-atom-img`).
- [ ] Define `CodeSessionState` shape in `reducer.ts`: `phase`, `activeMsgId`, `scratch: Map<string, { assistant: string; thinking: string }>`, `toolCallMap: Map<string, ToolCallState>`, `pendingApproval`, `pendingQuestion`, `prevPhase: CodeSessionPhase | null`, `queuedSends: Array<{ text: string; atoms: AtomSegment[] }>`, `lastError`, `lastCostUsd`, `claudeSessionId`. **Do NOT include `transcript` — that lives on the class wrapper per [D04].**
- [ ] Implement `createInitialState(tugSessionId, displayLabel)` and a trivial `reduce(state, event) => { state, effects: [] }` that returns state unchanged.
- [ ] Define `Effect` union in `effects.ts` per Spec S07; export type guards; import `InboundMessage` from `@/protocol`.
- [ ] Implement `CodeSessionStore.subscribe` and `getSnapshot` against the initial state — `getSnapshot` merges reducer state + `_transcript` (as `ReadonlyArray<TurnEntry>`) + `claudeSessionId` + the `streamingPaths` literal constants. **Memoize the result in `_cachedSnapshot`** per [D11] so repeated calls return a stable reference; invalidate on any dispatch that produces a state change, a transcript append, or a `claudeSessionId` update. T3.4.b's `useSyncExternalStore` requires this — without memoization, React tears.
- [ ] Constructor: build `streamingDocument = new PropertyStore({ schema: descriptors, initialValues: { "inflight.assistant": "", "inflight.thinking": "", "inflight.tools": "[]" } })` per Spec S05. `initialValues` seeds every path in one shot — no follow-up `set()` calls needed. Expose the instance as `readonly streamingDocument: PropertyStore`.
- [ ] `dispose()` clears subscriber listeners, clears `queuedSends`, clears `inflight.*` paths back to their empty values. **Does NOT clear `_transcript`** — transcript is user-visible state and clearing it on dispose would violate [L23]. Does NOT send `close_session` (card's responsibility per [D02]).

**Tests:**
- [ ] `code-session-store.scaffold.test.ts`: construct a store with a `MockTugConnection`; assert `getSnapshot()` returns the initial snapshot shape with `phase === "idle"`, `transcript.length === 0`, `streamingPaths.assistant === "inflight.assistant"`, `tugSessionId === FIXTURE_IDS.TUG_SESSION_ID`, `lastError === null`, `claudeSessionId === null`.
- [ ] `code-session-store.scaffold.test.ts`: construct a store, assert `streamingDocument.get("inflight.assistant") === ""`, `streamingDocument.get("inflight.thinking") === ""`, `streamingDocument.get("inflight.tools") === "[]"` — seeds applied via `initialValues`.
- [ ] `code-session-store.scaffold.test.ts`: call `store.getSnapshot()` twice without any intervening dispatch; assert `snap1 === snap2` (reference equality). This pins the memoization contract per [D11]/[F5] — without it, T3.4.b's `useSyncExternalStore` will tear.
- [ ] `protocol.test.ts` (or a new `protocol-code-input-payload.test.ts`): round-trip `encodeCodeInputPayload` / `decodeCodeInputPayload` for each of the four emitted `InboundMessage` shapes.

**Checkpoint:**
- [ ] `cd tugdeck && bun run check` (or `tsc --noEmit`)
- [ ] `cd tugdeck && bun test src/lib/code-session-store`

---

#### Step 2: Golden fixture loader + mock FeedStore + outbound decoder {#step-2}

**Depends on:** #step-1

**Commit:** `feat(tugdeck): add golden-catalog loader and mock FeedStore for code-session-store tests`

**References:** [D07] Golden fixtures read in-place, Spec S06, (#r02-fixture-path-coupling)

**Artifacts:**
- `tugdeck/src/lib/code-session-store/testing/golden-catalog.ts` — `loadGoldenProbe(version, probeName)`, `FIXTURE_IDS`, field-aware placeholder substitution, typed parse
- `tugdeck/src/lib/code-session-store/testing/mock-feed-store.ts` — `MockFeedStore` (4-arg constructor mirroring the real `FeedStore`), `MockTugConnection` with an outbound frame recorder that **decodes** CODE_INPUT payloads back to structured JSON for assertions, and an `onClose()`-triggering helper for Step 8's transport-close test
- `tugdeck/src/lib/code-session-store/__tests__/golden-catalog.test.ts`
- `tugdeck/src/lib/code-session-store/__tests__/mock-feed-store.test.ts`

**Tasks:**
- [ ] Implement `FIXTURE_ROOT_RELATIVE` as a top-of-file constant and resolve paths via `import.meta.dir` + `path.resolve` (not `__dirname` — bun uses ESM).
- [ ] Implement **occurrence-aware placeholder substitution** per Spec S06: two-pass walk. Pass 1 builds a per-field occurrence map (`session_id → 1`, `tug_session_id → 1`, `msg_id → N`, `tool_use_id → N`, `request_id → N`) using the grouping heuristics from Spec S06 (turn boundaries for msg_id; `tool_use` → `tool_result`/`tool_use_structured` matching for tool_use_id; one request_id per control_request_forward). Pass 2 walks again and substitutes each `{{uuid}}` leaf with the assigned value. `{{cwd}}` → `FIXTURE_IDS.CWD` with path-suffix preservation. `{{f64}}`/`{{i64}}` → numeric literals. `{{text:len=N}}` → `"x"` repeated N times.
- [ ] Return `GoldenProbe` with `{ version, probeName, events, idMap: { msgIds, toolUseIds, requestIds } }` so tests can assert on exact IDs without re-deriving the walk.
- [ ] Throw a readable `Error` on missing fixtures including the resolved absolute path.
- [ ] Throw if `{{uuid}}` is found in a field not in the known ID set (forward-compat guard against new ID fields in future captures).
- [ ] Throw if the fixture file is empty (guards against test-35-style skipped probes being cited by name).
- [ ] `MockFeedStore` implements the same subscribe/filter interface as the real `FeedStore` — accepts the 4-argument constructor signature (`conn`, `feedIds`, `decode?`, `filter?`) and exposes a `replay(frames: DecodedEvent[])` method plus an index-bounded `replayRange(frames, start, end)` method for tests that interleave store actions with fixture events (Step 7 uses this).
- [ ] `MockTugConnection` exposes `recordedFrames: Array<{ feedId: number; decoded: unknown }>` — every `conn.send(feedId, payload)` call decodes the payload back to structured JSON via `decodeCodeInputPayload(bytes): InboundMessage` (a new symmetric inverse of `encodeCodeInputPayload` added to `protocol.ts` as part of this step — see Step 3 for the pairing with `encodeCodeInputPayload`).
- [ ] `MockTugConnection.onClose(cb: () => void): () => void` matches the real `TugConnection.onClose` surface, and `MockTugConnection.triggerClose()` fires registered callbacks synchronously so Step 8's transport-close test can drive it.

**Tests:**
- [ ] `golden-catalog.test.ts`: load `v2.1.105/test-01-basic-round-trip.jsonl`, assert the parsed events include a `session_init` with `session_id === FIXTURE_IDS.CLAUDE_SESSION_ID` AND `tug_session_id === FIXTURE_IDS.TUG_SESSION_ID` (these are distinct — field grouping assigns them different constants).
- [ ] `golden-catalog.test.ts`: load the same fixture, assert an `assistant_text` event has `msg_id === FIXTURE_IDS.MSG_ID` (distinct from both session ids).
- [ ] `golden-catalog.test.ts`: load `v2.1.105/test-07-multiple-tool-calls.jsonl`, assert `probe.idMap.toolUseIds.length >= 2` and each element is a distinct value (occurrence counter bumped once per new `tool_use` event). Assert the corresponding `tool_result` events reference the correct entry by their positional grouping.
- [ ] `golden-catalog.test.ts`: load `v2.1.105/does-not-exist.jsonl`, assert the error message includes the resolved absolute path and the word "fixture".
- [ ] `golden-catalog.test.ts`: attempt to load `v2.1.105/test-35-askuserquestion-flow.jsonl`, assert the loader throws with an "empty fixture" error (file is 0 bytes; the loader's empty-file guard catches this).
- [ ] `mock-feed-store.test.ts`: subscribe a listener, replay three synthetic events, assert the listener saw them in order and the filter was applied.
- [ ] `mock-feed-store.test.ts`: `replayRange(frames, 0, 2)` plays only the first two events; a subsequent `replayRange(frames, 2, frames.length)` plays the rest (pause/resume semantics for Step 7's interleave).
- [ ] `mock-feed-store.test.ts`: call `conn.send(FeedId.CODE_INPUT, encodeCodeInputPayload({ type: "user_message", text: "hi", attachments: [] }, FIXTURE_IDS.TUG_SESSION_ID))`; assert `recordedFrames[0].decoded` equals `{ type: "user_message", text: "hi", attachments: [], tug_session_id: FIXTURE_IDS.TUG_SESSION_ID }` (the decode is provided by `decodeCodeInputPayload`, the inverse of `encodeCodeInputPayload`).

**Checkpoint:**
- [ ] `cd tugdeck && bun run check`
- [ ] `cd tugdeck && bun test src/lib/code-session-store`

---

#### Step 3: Reducer core — basic round-trip {#step-3}

**Depends on:** #step-2

**Commit:** `feat(tugdeck): code-session-store reducer — basic round-trip`

**References:** [D01] store owns FeedStore, [D02] card owns lifecycle, [D11] effect-list reducer, Spec S01, Spec S03, Spec S05, Spec S07, (#turn-state-walkthrough)

**Artifacts:**
- `code-session-store/events.ts` — populate event union for `session_init`, `assistant_text`, `turn_complete`, `send` (internal action), `errored_state` (placeholder for Step 8), `transport_close` (placeholder for Step 8), `system_metadata` (explicit-drop variant)
- `code-session-store/reducer.ts` — implement `idle → submitting → awaiting_first_token → streaming → complete → idle` path with effect-list return; emit an observable `awaiting_first_token` notification before collapsing to `streaming`
- `code-session-store.ts` — wire up the real `FeedStore` construction with the `tug_session_id` filter (subscribing to `[CODE_OUTPUT, SESSION_STATE]`); wire up `send()` to inject an internal `send` event through the reducer; `processEffects` handles `send-frame` by calling `conn.send(FeedId.CODE_INPUT, encodeCodeInputPayload(msg, tugSessionId))` (the Step 1 helper); `AppendTranscript` pushes to `_transcript`; `notifyListeners()` fires **once** at the end of every `processEffects` batch

**Tasks:**
- [ ] Implement `idle → submitting` in the reducer on `send` action: return `{ state: { ...state, phase: "submitting" }, effects: [{ kind: "send-frame", msg: { type: "user_message", text, attachments } }] }`.
- [ ] Implement `submitting → awaiting_first_token` on first `assistant_text` / `thinking_text` partial with a fresh `msg_id`: return state with `phase: "awaiting_first_token"` and `activeMsgId: msgId`, plus a `WriteInflight` effect that starts populating the scratch buffer. The class wrapper notifies subscribers once — observers see the `awaiting_first_token` phase. On the **same or immediately next** partial, the reducer transitions to `streaming`. (Per [OF11] resolution: `awaiting_first_token` is always observable, not compile-only.)
- [ ] Implement minimal `streaming → complete → idle` on `turn_complete(success)` — return an `AppendTranscript` effect building a `TurnEntry` from current scratch state and a `ClearInflight` effect.
- [ ] `CodeSessionStore` constructor: call `new FeedStore(conn, [FeedId.CODE_OUTPUT, FeedId.SESSION_STATE], undefined, (_, decoded) => (decoded as { tug_session_id?: string }).tug_session_id === this.tugSessionId)`. Subscribe to the FeedStore's change notifications; on every frame decode + dispatch to `reduce`; pass returned effects to `processEffects`. `notifyListeners()` fires once per dispatch, after effects are applied.
- [ ] Implement `getSnapshot()` to return a new frozen object merging reducer state with `_transcript` and the `streamingPaths` literal constants. `streamingPaths` is a constant object, not per-call allocated, so consumers can reference-compare in `React.memo`.

**Tests:**
- [ ] `code-session-store.round-trip.test.ts`: load `v2.1.105/test-01-basic-round-trip.jsonl`, construct a store with `MockTugConnection` + `tugSessionId: FIXTURE_IDS.TUG_SESSION_ID`. Record all phase transitions via a subscriber listener. Call `store.send("hello", [])`. Assert `MockTugConnection.recordedFrames` contains a `{ feedId: FeedId.CODE_INPUT, decoded: { type: "user_message", text: "hello", attachments: [], tug_session_id: FIXTURE_IDS.TUG_SESSION_ID } }` entry — the decoded view is provided by `MockTugConnection`'s `decodeCodeInputPayload`, so no manual ArrayBuffer decoding in the test. Replay the fixture through `MockFeedStore`. Assert the recorded phase sequence is `["submitting", "awaiting_first_token", "streaming", "idle"]` (one notification per phase — `awaiting_first_token` is always observable per [OF11]). Assert `transcript.length === 1`, `transcript[0].result === "success"`, and the final `phase === "idle"`.

**Checkpoint:**
- [ ] `cd tugdeck && bun run check`
- [ ] `cd tugdeck && bun test src/lib/code-session-store/__tests__/code-session-store.round-trip.test.ts`

---

#### Step 4: Streaming delta accumulation (assistant_text, thinking_text) {#step-4}

**Depends on:** #step-3

**Commit:** `feat(tugdeck): code-session-store streaming delta accumulation`

**References:** [D04] transcript + streaming, Spec S05, (#turn-state-walkthrough)

**Artifacts:**
- `reducer.ts` — implement scratch-buffer accumulation keyed by `msg_id` for `assistant_text` and `thinking_text` partials; handle `is_partial: false` (authoritative text replacement); emit `WriteInflight` effects carrying the new buffer
- `events.ts` — add `thinking_text` event variant
- `code-session-store.ts` — `processEffects` handles `write-inflight` by calling `streamingDocument.set(path, value)`; `clear-inflight` by setting all three `inflight.*` paths to their empty state

**Tasks:**
- [ ] Track `scratch: Map<msg_id, { assistant: string; thinking: string }>` in reducer state.
- [ ] On `assistant_text` partial with `is_partial: true`, append `text` to the matching scratch entry and return `effects: [{ kind: "write-inflight", path: "inflight.assistant", value: newBuffer }]`.
- [ ] On `assistant_text` partial with `is_partial: false`, replace the scratch buffer with the authoritative `text` field and emit the same effect with the authoritative value.
- [ ] Same pattern for `thinking_text`.
- [ ] On `turn_complete(success)`, build the `TurnEntry` from the scratch entry for `activeMsgId`, return `effects: [{ kind: "append-transcript", entry }, { kind: "clear-inflight" }]`.

**Tests:**
- [ ] `code-session-store.deltas.test.ts`: replay `v2.1.105/test-02-longer-response-streaming.jsonl`, assert `streamingDocument.get("inflight.assistant")` grows monotonically in arrival order, then equals the `complete` event's `text` byte-for-byte (which is a `"x"`-repeated string of the length declared in the fixture's `{{text:len=N}}` placeholder). Assert `TurnEntry.assistant` in the final transcript matches.
- [ ] `code-session-store.deltas.test.ts`: same fixture, assert `inflight.assistant === ""` after `turn_complete` (ClearInflight effect).
- [ ] `code-session-store.deltas.test.ts` (synthetic): build events for two `thinking_text` deltas and one final, assert `inflight.thinking` accumulates correctly.

**Checkpoint:**
- [ ] `cd tugdeck && bun run check`
- [ ] `cd tugdeck && bun test src/lib/code-session-store/__tests__/code-session-store.deltas.test.ts`

---

#### Step 5: Tool call lifecycle {#step-5}

**Depends on:** #step-4

**Commit:** `feat(tugdeck): code-session-store tool call tracking`

**References:** [D04] transcript + streaming, [D11] effect-list reducer, Spec S02 (ToolCallState), Spec S03, [Q02] decided, Risk R01, (#r01-tool-call-interleave)

**Artifacts:**
- `reducer.ts` — implement `Map<tool_use_id, ToolCallState>` tracking; transitions `streaming → tool_work` and `tool_work → streaming` based on map-all-done predicate; emit `WriteInflight { path: "inflight.tools", value: JSON.stringify(Array.from(map.values())) }` effects on every tool event
- `events.ts` — add `tool_use`, `tool_result`, `tool_use_structured` event variants
- `code-session-store.ts` — no wrapper-side code changes (the existing `write-inflight` effect handler covers `inflight.tools`)

**Tasks:**
- [ ] Add `toolCallMap: Map<string, ToolCallState>` to `CodeSessionState`.
- [ ] On `tool_use` partial/complete, upsert the map entry with `status: "pending"`; transition to `tool_work`.
- [ ] On `tool_result` / `tool_use_structured` matching `tool_use_id`, update the map entry to `status: "done"` with `result` / `structuredResult` populated.
- [ ] After each tool event, if every map entry is `done`, transition back to `streaming`.
- [ ] On `turn_complete`, commit `Array.from(toolCallMap.values())` into `TurnEntry.toolCalls` (preserving insertion order per [Q02] resolution in Spec S02).
- [ ] Every tool event emits `WriteInflight { path: "inflight.tools", value: JSON.stringify(Array.from(map.values())) }`.

**Tests:**
- [ ] `code-session-store.tools.test.ts`: replay `v2.1.105/test-05-tool-use-read.jsonl`, assert `phase === "tool_work"` after first `tool_use` partial, `phase === "streaming"` after matching `tool_result`, `inflight.tools` contains a serialized entry with the fixture's tool name (Read).
- [ ] `code-session-store.tools.test.ts`: replay `v2.1.105/test-07-multiple-tool-calls.jsonl` — the real multi-tool fixture. Assert multiple distinct `tool_use_id`s appear in `inflight.tools` simultaneously while any are still pending, and assert `phase === "tool_work"` until all resolve. (Count expected tool-use ids by inspecting the fixture at Step 5 start.)
- [ ] `code-session-store.tools.test.ts`: assert `TurnEntry.toolCalls` on the committed turn is an array in insertion order.

**Checkpoint:**
- [ ] `cd tugdeck && bun run check`
- [ ] `cd tugdeck && bun test src/lib/code-session-store/__tests__/code-session-store.tools.test.ts`

---

#### Step 6: Control request forward (permission + question) + cost_update {#step-6}

**Depends on:** #step-5

**Commit:** `feat(tugdeck): code-session-store permission + question control forward`

**References:** [D06] split respond actions, [D11] effect-list reducer, Spec S01, Spec S03, (#turn-state-walkthrough)

**Artifacts:**
- `reducer.ts` — `streaming / tool_work → awaiting_approval` on `control_request_forward`, dispatching on `is_question`; `awaiting_approval → prevPhase` on `respondApproval` / `respondQuestion` actions; emit `SendFrame` effects for the outbound response; `cost_update` handler capturing `total_cost_usd` into `state.lastCostUsd` (no phase transition, no effect — pure state update)
- `events.ts` — add `control_request_forward` event variant, `respondApproval` / `respondQuestion` internal action variants, and `CostUpdateEvent` with `total_cost_usd: number`
- `code-session-store.ts` — implement `respondApproval` and `respondQuestion` public methods that synthesize the internal action events and dispatch through `reduce`; add `cost_update` to `KNOWN_CODE_OUTPUT_TYPES`

**Tasks:**
- [ ] Add `prevPhase: CodeSessionPhase | null` to state; stash when entering `awaiting_approval`; restore on respond.
- [ ] On `control_request_forward` with `is_question: false`, populate `pendingApproval` with the decoded event.
- [ ] On `control_request_forward` with `is_question: true`, populate `pendingQuestion`.
- [ ] `respondApproval(requestId, { decision, updatedInput?, message? })` injects an internal action; reducer returns `effects: [{ kind: "send-frame", msg: { type: "tool_approval", request_id: requestId, decision, updatedInput, message } }]` and clears `pendingApproval`, restoring `prevPhase`.
- [ ] `respondQuestion(requestId, { answers })` injects an internal action; reducer returns `effects: [{ kind: "send-frame", msg: { type: "question_answer", request_id: requestId, answers } }]` and clears `pendingQuestion`, restoring `prevPhase`.
- [ ] `handleCostUpdate`: on `cost_update` event, read `total_cost_usd` (fixtures emit it as a number thanks to the golden loader's `"{{f64}}"` → `0` preprocessing — values beyond `0` are possible from real captures or synthetic tests). Return state with `lastCostUsd: event.total_cost_usd`, empty `effects`. No phase transition. The reducer is tolerant of phase — `cost_update` is surfaced as telemetry and can land at any time.

**Tests:**
- [ ] `code-session-store.control-forward.test.ts` (**synthetic** approval — v2.1.105 has no permission-allow golden fixture; `test-08` is a tool-error probe, `test-09` is bash-auto-approved, neither is a user-gated allow flow): replay a hand-built `control_request_forward { is_question: false, request_id: FIXTURE_IDS.REQUEST_ID, tool_name: "Bash", input: { command: "ls" } }` event while `phase === "streaming"`. Assert `phase === "awaiting_approval"`, assert `pendingApproval` is populated. Call `respondApproval(FIXTURE_IDS.REQUEST_ID, { decision: "allow" })`. Assert `MockTugConnection.recordedFrames` contains a `{ feedId: FeedId.CODE_INPUT, decoded: { type: "tool_approval", request_id: FIXTURE_IDS.REQUEST_ID, decision: "allow", ... } }` entry. Assert `pendingApproval === null` and `phase === "streaming"`.
- [ ] `code-session-store.control-forward.test.ts`: replay `v2.1.105/test-11-permission-deny-roundtrip.jsonl` through the normal subscription path; when the `control_request_forward` event lands, call `respondApproval(requestId, { decision: "deny" })` and assert the resulting `tool_approval` frame carries `decision: "deny"`. Then replay the remainder of the fixture (which includes the denied tool's downstream events) and assert the phase returns to the end of the turn correctly.
- [ ] `code-session-store.control-forward.test.ts` (**synthetic** AskUserQuestion — `test-35-askuserquestion-flow.jsonl` is empty/skipped in the v2.1.105 manifest and cannot be replayed): replay a hand-built `control_request_forward { is_question: true, request_id: FIXTURE_IDS.REQUEST_ID, question: "pick one", options: [{ key: "a", label: "Option A" }, { key: "b", label: "Option B" }] }` event while `phase === "streaming"`. Assert `phase === "awaiting_approval"`, assert `pendingQuestion` populated. Call `respondQuestion(FIXTURE_IDS.REQUEST_ID, { answers: { pick: "a" } })`. Assert `MockTugConnection.recordedFrames` contains a `{ decoded: { type: "question_answer", request_id: FIXTURE_IDS.REQUEST_ID, answers: { pick: "a" }, tug_session_id: FIXTURE_IDS.TUG_SESSION_ID } }` entry. Assert `pendingQuestion === null` and `phase === "streaming"`.
- [ ] `code-session-store.cost-update.test.ts` (synthetic — loader preprocessing forces fixture `total_cost_usd` to `0`, so a real fixture can't drive a non-zero assertion): dispatch a synthetic `cost_update { total_cost_usd: 0.01337 }` event while `phase === "streaming"`, assert `snapshot.lastCostUsd === 0.01337` and `phase === "streaming"` (unchanged). Dispatch a second `cost_update { total_cost_usd: 0.042 }` and assert `lastCostUsd` overwrites to the new value. Optional spot-check: replay `v2.1.105/test-01-basic-round-trip.jsonl` and assert that the final snapshot has `lastCostUsd === 0` (the placeholder-substituted zero survives round-trip).

**Checkpoint:**
- [ ] `cd tugdeck && bun run check`
- [ ] `cd tugdeck && bun test src/lib/code-session-store/__tests__/code-session-store.control-forward.test.ts`

---

#### Step 7: Interrupt + queue semantics {#step-7}

**Depends on:** #step-6

**Commit:** `feat(tugdeck): code-session-store interrupt + queue behavior`

**References:** [D05] interrupt clears queue, [D11] effect-list reducer, Spec S01, Spec S03, (#d05-interrupt-clears-queue)

**Artifacts:**
- `reducer.ts` — queued sends array, enqueue on non-idle `send`, flush one on `turn_complete(success) → idle` (single-tick collapse per S03), clear on `turn_complete(error) → idle`
- `events.ts` — add internal `interrupt` action variant
- `code-session-store.ts` — implement `interrupt()` public method that injects the internal action

**Tasks:**
- [ ] On `send` action with `phase !== "idle"`, enqueue `{ text, atoms }` onto `queuedSends` and return `effects: []` (no frame write yet).
- [ ] On `turn_complete(success)`: if `queuedSends` is non-empty, shift one entry off, transition straight through `idle` into `submitting`, and emit both `AppendTranscript { entry }`, `ClearInflight`, AND `SendFrame { msg: user_message(shifted) }` in a single effect list. The wrapper notifies subscribers **once** — observers see a final phase of `submitting`, not `idle`. (Per S03.)
- [ ] `interrupt()` injects an internal action; reducer returns `effects: [{ kind: "send-frame", msg: { type: "interrupt" } }]` and clears `queuedSends` in the returned state.
- [ ] On `turn_complete(error)`, commit `TurnEntry(result: "interrupted")` with preserved text, emit `AppendTranscript` + `ClearInflight`. `queuedSends` is already empty from `interrupt()`.
- [ ] Update the transcript commit logic to build `TurnEntry.result` based on the `turn_complete` variant.

**Tests:**
- [ ] `code-session-store.interrupt.test.ts`: load `v2.1.105/test-06-interrupt-mid-stream.jsonl`, construct the store, call `store.send("please run forever", [])`. The fixture has N events; the probe captures a `session_init`, `system_metadata`, a first `assistant_text` partial, a second `assistant_text` partial, then a `turn_complete(error)`. Use `MockFeedStore.replayRange(frames, 0, K)` where K is the index of the second `assistant_text` partial **inclusive** — this leaves the store in `phase === "streaming"` with at least one delta accumulated. Assert `phase === "streaming"` at this point. Call `store.interrupt()`. Assert `MockTugConnection.recordedFrames` now contains a `{ decoded: { type: "interrupt", tug_session_id: FIXTURE_IDS.TUG_SESSION_ID } }` entry. Capture `store.streamingDocument.get("inflight.assistant")` — the preserved text. Call `replayRange(frames, K, frames.length)` to play the remaining events (including the fixture's `turn_complete(error)` that lands *after* our interrupt was written). Assert `phase === "idle"`, `transcript[0].result === "interrupted"`, `transcript[0].assistant` equals the captured preserved text (not the post-interrupt bytes — the interrupt path commits the in-flight buffer at the moment of `turn_complete(error)` arrival). K is determined by inspecting the fixture at test-write time; name it as a constant in the test with a comment pointing at the fixture line number.
- [ ] `code-session-store.interrupt.test.ts` (**synthetic queue-clear**): three `store.send` calls during `streaming`, assert `queuedSends === 3`. Call `store.interrupt()`. Replay a synthetic `turn_complete(error)`. Assert `queuedSends === 0` and that **exactly one** `user_message` frame was written to the mock connection (the original submit; the three queued sends were discarded and the `interrupt` frame is not a `user_message`). Total `recordedFrames` should be **two**: one `user_message` and one `interrupt`.
- [ ] `code-session-store.queue.test.ts`: three `store.send` calls during `streaming`, assert `queuedSends === 3`. Replay `turn_complete(success)`. Assert the store wrote one queued `user_message` frame (total `user_message` frames so far: 2 — original + one flushed). Assert the snapshot's final phase is `submitting`, not `idle`, and that subscribers were notified exactly once during the collapse. Replay another `turn_complete(success)`, assert a second queued send fires, and so on until `queuedSends === 0`.

**Checkpoint:**
- [ ] `cd tugdeck && bun run check`
- [ ] `cd tugdeck && bun test src/lib/code-session-store/__tests__/code-session-store.interrupt.test.ts src/lib/code-session-store/__tests__/code-session-store.queue.test.ts`

---

#### Step 8: Errored phase triggers {#step-8}

**Depends on:** #step-7

**Commit:** `feat(tugdeck): code-session-store errored phase triggers + recovery`

**References:** [D08] errored vs interrupted distinct, Spec S03, Spec S04, (#s04-errored-triggers)

**Artifacts:**
- `reducer.ts` — handle `SESSION_STATE = errored` (already in the subscription from Step 3) and `transportClose` (new internal event); populate `lastError` with cause tag
- `events.ts` — add `session_state` variant and `transport_close` internal event variant
- `code-session-store.ts` — subscribe to `TugConnection.onClose` (already exists at `tugdeck/src/connection.ts:297` — no connection-module changes); on close, inject a `transport_close` event; handle `send()` from `errored` as a manual retry; clear `lastError` on next `turn_complete(success)`

**Tasks:**
- [ ] Confirm the filtered `FeedStore` from Step 3 already subscribes to `[CODE_OUTPUT, SESSION_STATE]` and delivers SESSION_STATE frames to the dispatcher.
- [ ] Subscribe to `conn.onClose` unconditionally at construction (not just during non-idle windows — it's cheap), store the returned unsubscribe function, and call it in `dispose()`. The reducer itself decides whether the close matters: close events arriving while `phase === "idle"` are dropped; while non-idle, they route to `errored`.
- [ ] Implement reducer transitions for the two triggers per Spec S04 (SESSION_STATE errored, transport_close). **CONTROL-error triggers (`session_not_owned`, `session_unknown`) are explicitly out of scope for T3.4.a** — they belong to a follow-on that wires a CONTROL subscription with per-card filtering.
- [ ] Implement `send()` from `errored`: transitions to `submitting` and emits a `SendFrame` effect; `lastError` stays set until the next `turn_complete(success)`.
- [ ] On `turn_complete(success)` while the incoming state had `lastError !== null`, clear `lastError` in the returned state alongside the normal transcript commit.

**Tests:**
- [ ] `code-session-store.errored.test.ts` (synthetic): inject a `SESSION_STATE { state: "errored", detail: "crash_budget_exhausted" }` during `streaming`, assert `phase === "errored"`, `lastError.cause === "session_state_errored"`, `lastError.message` contains `"crash_budget_exhausted"`, `transcript` unchanged.
- [ ] `code-session-store.errored.test.ts`: call `conn.triggerClose()` while `phase === "submitting"`, assert `phase === "errored"`, `lastError.cause === "transport_closed"`.
- [ ] `code-session-store.errored.test.ts`: call `conn.triggerClose()` while `phase === "idle"`, assert `phase === "idle"` (unchanged); transport close only routes to errored during active turns.
- [ ] `code-session-store.errored.test.ts`: from `errored`, call `store.send("retry", [])`, assert `phase === "submitting"`, `lastError` still set. Replay a synthetic `turn_complete(success)`, assert `lastError === null` and `phase === "idle"`.

**Checkpoint:**
- [ ] `cd tugdeck && bun run check`
- [ ] `cd tugdeck && bun test src/lib/code-session-store/__tests__/code-session-store.errored.test.ts`

---

#### Step 9: Filter correctness + dispose teardown {#step-9}

**Depends on:** #step-8

**Commit:** `feat(tugdeck): code-session-store filter isolation + dispose teardown`

**References:** [D01] store owns FeedStore, [D02] card owns lifecycle, Spec S01, (#d01-store-owns-feedstore, #d02-card-owns-lifecycle)

**Artifacts:**
- Verification tests that validate multi-instance isolation and dispose cleanup (no code changes beyond ensuring `dispose` is wired correctly)

**Tasks:**
- [ ] Audit `dispose()`: unsubscribe `FeedStore`, call the `onClose` unsubscribe from Step 8, clear subscriber list, clear `queuedSends`, clear `inflight.*` paths (back to `""` / `""` / `"[]"`). **Does NOT clear `_transcript`** — transcript is user-visible state per [L23] (tuglaws: internal implementation operations must never lose, destroy, or cease to apply user-visible state). Does NOT send `close_session` (card's responsibility per [D02]).
- [ ] Verify `MockFeedStore` + `MockTugConnection` support constructing two stores against one connection.

**Tests:**
- [ ] `code-session-store.filter.test.ts`: construct `storeA` with `tugSessionId: "aaaa..."` and `storeB` with `tugSessionId: "bbbb..."` on a shared `MockTugConnection`. Replay frames tagged with storeA's id. Assert storeA's snapshot reflects the events; storeB's snapshot is unchanged from initial.
- [ ] `code-session-store.dispose.test.ts`: construct a store, subscribe a listener, replay a full round-trip (`test-01-basic-round-trip.jsonl`) so `transcript.length === 1`. Call `store.dispose()`. Replay another frame, assert the listener did not fire and `getSnapshot().phase` is unchanged. Assert `streamingDocument.get("inflight.assistant") === ""` (cleared by dispose). **Assert `getSnapshot().transcript.length === 1` — dispose does NOT clear the transcript** (preserving user-visible state per [L23]). Assert no `close_session` frame was written to the connection.

**Checkpoint:**
- [ ] `cd tugdeck && bun run check`
- [ ] `cd tugdeck && bun test src/lib/code-session-store/__tests__/code-session-store.filter.test.ts src/lib/code-session-store/__tests__/code-session-store.dispose.test.ts`

---

#### Step 10: Integration checkpoint {#step-10}

**Depends on:** #step-3, #step-4, #step-5, #step-6, #step-7, #step-8, #step-9

**Commit:** `N/A (verification only)`

**References:** [D01]–[D10], all specs, (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Re-verify every exit criterion in the `#success-criteria` list; check the box.
- [ ] Run the full tugdeck test suite to catch regressions in other stores.
- [ ] Grep-verify: zero React imports in store files, zero IndexedDB references, public barrel re-exports present.
- [ ] Update [tide.md §T3.4.a](./tide.md#t3-4-a-code-session-store) with a one-line pointer to this plan and a "✓ LANDED" note on the T3.4.a section header.

**Tests:**
- [ ] Full tugdeck test run is green.

**Checkpoint:**
- [ ] `cd tugdeck && bun run check`
- [ ] `cd tugdeck && bun test`
- [ ] `rg 'from "react"' tugdeck/src/lib/code-session-store.ts tugdeck/src/lib/code-session-store/reducer.ts tugdeck/src/lib/code-session-store/events.ts tugdeck/src/lib/code-session-store/effects.ts tugdeck/src/lib/code-session-store/types.ts` — zero matches
- [ ] `rg 'IDBDatabase|indexedDB' tugdeck/src/lib/code-session-store.ts tugdeck/src/lib/code-session-store/reducer.ts tugdeck/src/lib/code-session-store/events.ts tugdeck/src/lib/code-session-store/effects.ts tugdeck/src/lib/code-session-store/types.ts` — zero matches (excluding `testing/`)
- [ ] Manual spot: import `CodeSessionStore` from `tugdeck/src/lib` (the barrel) and call `new CodeSessionStore(...)` in a REPL/scratch file; verify types resolve cleanly.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** `CodeSessionStore` — a per-Tide-card L02 TypeScript store owning Claude Code turn state, fully tested against the `v2.1.105/` golden fixture catalog, ready to be consumed by [T3.4.b](./tide.md#t3-4-b-prompt-entry) (`tug-prompt-entry`) and [T3.4.c](./tide.md#t3-4-c-tide-card) (Tide card registration).

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] `tugdeck/src/lib/code-session-store.ts` exists and exports `CodeSessionStore` + `CodeSessionSnapshot` + `TurnEntry`. (`ls` + barrel grep)
- [ ] `cd tugdeck && bun run check` clean.
- [ ] `cd tugdeck && bun test` green across the full tugdeck suite.
- [ ] Every exit criterion in [Success Criteria](#success-criteria) has a passing test cited by name.
- [ ] Zero `react` / `react-dom` imports in `code-session-store.ts` and its `code-session-store/` siblings.
- [ ] Zero `IDBDatabase` / `indexedDB` references in the same files.
- [ ] All fixture-replay tests load from `tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/v2.1.105/` via `loadGoldenProbe`.
- [ ] `tide.md §T3.4.a` updated with a pointer to this plan and a ✓ status.

**Acceptance tests:**
- [ ] `code-session-store.round-trip.test.ts` passes against `v2.1.105/test-01-basic-round-trip.jsonl`.
- [ ] `code-session-store.deltas.test.ts` passes against `v2.1.105/test-02-longer-response-streaming.jsonl` + the synthetic thinking_text scenario.
- [ ] `code-session-store.tools.test.ts` passes against `v2.1.105/test-05-tool-use-read.jsonl` and `v2.1.105/test-07-multiple-tool-calls.jsonl`.
- [ ] `code-session-store.control-forward.test.ts` passes: synthetic permission-allow, `v2.1.105/test-11-permission-deny-roundtrip.jsonl`, synthetic AskUserQuestion (test-35 is empty/skipped upstream).
- [ ] `code-session-store.interrupt.test.ts` passes against `v2.1.105/test-06-interrupt-mid-stream.jsonl` and the synthetic queue-clear scenario.
- [ ] `code-session-store.queue.test.ts` passes the multi-flush scenario with single-tick collapse.
- [ ] `code-session-store.errored.test.ts` passes both trigger scenarios (SESSION_STATE errored, transport close) + recovery.
- [ ] `code-session-store.filter.test.ts` passes the multi-instance isolation scenario.
- [ ] `code-session-store.dispose.test.ts` passes the teardown scenario and the negative-imports check.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] **[T3.4.a.1] CONTROL error routing (`session_unknown`, `session_not_owned`)** — scheduled in [tide.md §execution-order-table](./tide.md#execution-order-table) as item 3a, running parallel with P13 / T3.4.b and gating T3.4.d. Finishes the `lastError.cause` surface Spec S04 promised (tide.md:2480 already lists the four-member cause union) but that T3.4.a shipped with only three members. The existing per-card filtered `FeedStore` handles the subscription cleanly — add `FeedId.CONTROL` to its feed-id list, extend `frameToEvent` for `{type: "error", detail: "session_unknown" | "session_not_owned"}`, widen the cause union, add two synthetic reducer tests. `action-dispatch.ts`'s global CONTROL handler stays untouched because the per-card `tug_session_id` filter drops app-level CONTROL frames (no `tug_session_id` → filter returns `false`). Covers the stale-session-after-reconnect failure mode that neither SESSION_STATE errored nor transport close catch.
- [ ] [P14](./tide.md#p14-claude-resume) — Claude `--resume` + tugbank persistence of `claude_session_id`. Unlocks transcript rehydration on reload per [Q01]. Schedules after T3.4.c.
- [ ] [P15](./tide.md#p15-stream-json-version-gate) — version gate + divergence telemetry + version-adaptive reducer scaffold. Informed by the store's actual field dependencies, so must land after T3.4.a.
- [ ] [P16](./tide.md#p16-session-command-continue) — `session_command: new/continue/fork` through the multi-session router. Unblocks multi-session-within-a-card and re-enables `test-13/17/20` fixtures. Parallelizable.
- [ ] [T3.4.b](./tide.md#t3-4-b-prompt-entry) — `tug-prompt-entry` component consumes `CodeSessionStore` via `useSyncExternalStore`. Next step on the critical path.
- [ ] [T3.4.c](./tide.md#t3-4-c-tide-card) — Tide card registration; wires `CodeSessionStore` + `SessionMetadataStore` + `CardSessionBindingStore` together with `TugSplitPane`. Rides with [W3.b](./tide.md#t3-workspace-registry-w3b) bootstrap removal.

| Checkpoint | Verification |
|------------|--------------|
| Store scaffolding + types | Step 1 checkpoint (`bun run check` + scaffold test) |
| Golden fixture loader | Step 2 checkpoint (`golden-catalog.test.ts` + `mock-feed-store.test.ts`) |
| Basic round-trip reducer | Step 3 checkpoint (`code-session-store.round-trip.test.ts`) |
| Streaming delta accumulation | Step 4 checkpoint (`code-session-store.deltas.test.ts`) |
| Tool call lifecycle | Step 5 checkpoint (`code-session-store.tools.test.ts`) |
| Control request forward | Step 6 checkpoint (`code-session-store.control-forward.test.ts`) |
| Interrupt + queue semantics | Step 7 checkpoint (`code-session-store.interrupt.test.ts`, `code-session-store.queue.test.ts`) |
| Errored triggers + recovery | Step 8 checkpoint (`code-session-store.errored.test.ts`) |
| Filter correctness + dispose | Step 9 checkpoint (`code-session-store.filter.test.ts`, `code-session-store.dispose.test.ts`) |
| Negative import checks | Step 10 integration checkpoint (shell `rg` in the full-suite grep) |
| Phase integration | Step 10 (`bun test` full suite, all exit criteria boxed) |
