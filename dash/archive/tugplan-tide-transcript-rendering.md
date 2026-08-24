<!-- tugplan-skeleton v2 -->

## Tide Card Polish — Multi-Turn Transcript Rendering {#tide-transcript-rendering}

> **Status: SUPERSEDED — see [tugplan-tug-list-view.md](./tugplan-tug-list-view.md).** The transcript wire-up was reframed mid-design when the missing windowed-list primitive surfaced as the architectural blocker. The successor plan ships `TugListView` first (Phase A) and consumes it for the Tide card transcript (Phase B) — the rendering shape this plan describes is preserved verbatim there as the Phase B target. The original draft below is retained as historical context only; do not execute it.

**Purpose:** Replace the single-region `TugMarkdownView` wire-up at the top pane of a Tide card with a transcript-aware rendering path that mounts one `TugTranscriptEntry` row per participant per turn. Committed turns from `CodeSessionStore.snap.transcript` render as `(user, code)` pairs; the in-flight turn renders the user row immediately on submit and streams the code row's body from `streamingDocument.inflight.assistant`. Auto-scroll-to-bottom flows through `SmartScroll`, honoring user scroll-up. Cmd+J is **deferred** to a follow-up plan; this plan is rendering-only.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | superseded — see [tugplan-tug-list-view.md](./tugplan-tug-list-view.md) |
| Target branch | tugplan-tide-transcript-rendering |
| Last updated | 2026-05-03 |
| Roadmap anchor | [tugplan-tide-card-polish.md §step-11](./tugplan-tide-card-polish.md#step-11) — this plan executes that step (Cmd+J deferred) |
| Predecessors | [tugplan-tide-transcript-primitive.md](./tugplan-tide-transcript-primitive.md) (closed parent §step-9), [tugplan-tide-session-ledger.md](./tugplan-tide-session-ledger.md) (closed parent §step-10; independent) |
| Successors | parent §step-12 (markdown styling pass) builds on this; parent §step-13 (thinking + tool surfaces) builds on this; the deferred Cmd+J keybinding will be its own plan |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Today the Tide card's top pane is a single `<TugMarkdownView streamingStore={codeSessionStore.streamingDocument} streamingPath={codeSnap.streamingPaths.assistant} />` ([tide-card.tsx:1543](../tugdeck/src/components/tugways/cards/tide-card.tsx)). The user's submitted prompt never appears in the pane — it leaves the prompt entry and shows up only as part of the assistant's response context. Completed turns leave the final assistant text visible until the next turn overwrites the streaming document (the so-called "sticky last turn" — emergent behavior from `TugMarkdownView`'s streaming observer skipping empty writes; not deliberate UI). Multi-turn history is invisible.

[Step 9](./tugplan-tide-transcript-primitive.md) shipped `TugTranscriptEntry` as a slot-based primitive with four participants (`user`, `code`, `shell`, `command`) and no live wiring. [Step 10](./tugplan-tide-session-ledger.md) shipped the session ledger and the rich resume UX. Step 11 is the wire-up: read `snap.transcript` from `CodeSessionStore`, mint one `(user, code)` pair per turn, mint the in-flight pair from the in-flight reducer state, and bind the in-flight `code` row's body to the streaming document.

The architectural call about *how* to render markdown inside a per-row body slot is [Q01] in [Step 9](./tugplan-tide-transcript-primitive.md#q01-body-slot-ownership), resolved as "per-row MV". This plan operationalizes that resolution and surfaces an unsettled implication ([Q01] below) about how the per-row MV coexists with `TugMarkdownView`'s self-owned scroll container.

#### Strategy {#strategy}

- **Snapshot before rendering.** The in-flight `user` row needs a data source. Today the reducer carries `pendingUserMessage: { text, atoms } | null` internally but doesn't expose it on the snapshot. Step 1 lifts it onto `CodeSessionSnapshot.inflightUserMessage` so the rendering layer can read it through the same `useSyncExternalStore` path it already uses for `transcript`. See [D01].
- **Decide MV embedding before wiring.** Per-row `<TugMarkdownView>` is a self-owned scroll container (`overflow-y: auto`, internal block windowing) and won't compose cleanly inside an outer transcript-level scroll container. Step 2 commits the embedding strategy — either a new `flow="natural"` mode on `TugMarkdownView` or a sibling `TugMarkdownBlock` primitive — and lands the chosen artifact independently of the wire-up. See [Q01], [D02].
- **Wire transcript-aware rendering in one focused commit.** Step 3 swaps the single `TugMarkdownView` for a transcript scroll container that maps `snap.transcript` to `(user, code)` pairs and the in-flight state to the in-flight pair. Identifier sources, timestamp formatting, and the in-flight `code` row's streaming binding all land here. See [D03].
- **SmartScroll auto-follow-bottom.** Step 4 wraps the transcript scroll container with `SmartScroll`. New rows and streaming deltas pin to the bottom while `isFollowingBottom`; user scroll-up disengages auto-follow per the existing SmartScroll semantics. See [D04].
- **No keybinding work.** Cmd+J (originally rolled into parent §step-11 from [§step-6](./tugplan-tide-card-polish.md#step-6)) is explicitly **deferred** to a follow-up plan. The user's instruction: rendering and interaction are orthogonal; the plan should ship the multi-turn transcript on its own. See [#non-goals].
- **Tuglaws cross-checked at every step.** [L02] (snapshot read via `useSyncExternalStore` only), [L06] (appearance via CSS / DOM), [L20] (component-token sovereignty), [L22] (store observers may write DOM directly — applies to the in-flight code row's streaming binding). See [#tuglaws-cross-check].
- **Build stays green at every commit.** `bun x tsc --noEmit`, `bun test`, `bun run audit:tokens lint`, and `cargo nextest run` pass on every step. Warnings are errors.

#### Success Criteria (Measurable) {#success-criteria}

- `CodeSessionSnapshot.inflightUserMessage: { text: string; atoms: ReadonlyArray<AtomSegment> } | null` is set the instant `send()` is dispatched (before any wire round-trip) and cleared exactly when the matching `TurnEntry` is committed to `transcript`. (Verified: reducer test against the existing `test-01-round-trip.jsonl` fixture, plus the interrupt fixture `test-06-interrupt.jsonl`.)
- The Tide card top pane renders one `TugTranscriptEntry` row pair (`user`, then `code`) for each entry in `snap.transcript`, in chronological order. (Verified: integration test that loads a multi-turn fixture into `CodeSessionStore` and asserts the rendered DOM has the expected pair count and order.)
- The in-flight `user` row appears in the transcript before any assistant token arrives — a `> hi` submission shows up the instant `send()` is called. (Verified: integration test that submits and asserts the in-flight `user` row is present prior to dispatching any assistant deltas.)
- The in-flight `code` row's body streams from `streamingDocument.inflight.assistant` while the turn is in flight; on `turn_complete(success)`, that row is removed from the DOM and a committed `code` row mounts with the final text via the chosen embedding strategy from [Q01]. (Verified: integration test against `test-02-streaming-deltas.jsonl`.)
- The transcript scroll container auto-pins to the bottom on new content while `SmartScroll.isFollowingBottom`; user scroll-up disengages auto-follow per existing `SmartScroll` semantics. (Verified: integration test that simulates scroll-up during streaming and asserts no further auto-pin.)
- The "sticky last turn" emergent behavior from the previous wire-up no longer applies — there is no single `inflight.assistant`-bound region to be sticky. The committed `code` row holds the final text via the snapshot. (Verified: read-after-test of the rendered DOM; no element bound to `streamingPath` survives a successful `turn_complete`.)
- `bun x tsc --noEmit`, `bun test`, `bun run audit:tokens lint`, `cargo nextest run` green at every step.
- Parent plan §step-11 row flips to "shipped" upon completion with a note that Cmd+J is the deferred follow-up.

#### Scope {#scope}

1. **Snapshot extension.** `inflightUserMessage` lifted from reducer state onto `CodeSessionSnapshot`.
2. **Embedding primitive for per-row markdown.** Either a `flow="natural"` mode on `TugMarkdownView` or a new `TugMarkdownBlock`. Resolved at [Q01].
3. **Transcript-aware rendering in `tide-card.tsx`.** Replace single-region wire-up; map `snap.transcript` → row pairs; render in-flight pair from `inflightUserMessage` + streaming binding.
4. **Identifier and timestamp helpers.** `"You"` for `user`; dynamic model name from `SessionMetadataStore` (fallback `"Code"`) for `code`. Timestamps from `TurnEntry.endedAt` for committed; submit-time for in-flight.
5. **SmartScroll-driven auto-follow-bottom.** Wrap the transcript container.
6. **Tuglaws walkthrough + parent close-out.** Per-step compliance plus the parent-plan row flip.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Cmd+J keybinding.** Originally absorbed into parent §step-11 from §step-6, now explicitly deferred to its own follow-up plan. Rationale: rendering and interaction are orthogonal — the keybinding's value depends on a rendered transcript, but the rendered transcript ships fine without the keybinding. Tracking this as a roadmap item under [#roadmap].
- **Atom rendering for `user` rows.** `TurnEntry.userMessage.attachments` is `ReadonlyArray<unknown>` today and will be `AtomSegment[]` once the prompt entry's atom flow lands in transcript form. v1 of this plan renders the user row body as plain text; atom-aware rendering is a follow-up. See [D05].
- **Markdown styling pass for assistant output.** Token tuning of `--tugx-md-*` lives in parent §step-12.
- **Thinking + tool surfaces inside `code` rows.** Wired in parent §step-13.
- **`shell` and `command` participant rows.** Live data for these depends on Phase T4 (Tugshell) and Phase T10 (Surface Built-Ins). Step 9's gallery already showcases the variants; live wire is gated on those phases.
- **Queued-send rendering as user rows.** Parent §step-14 covers queued-send UX end-to-end. v1 renders only the current in-flight user row (one), not the queue depth (`snap.queuedSends`).
- **Cost / model badge controls on `code` rows.** Step 9's primitive accepts a `controls` slot for these; this plan leaves the slot unused. Parent §step-13 or a follow-on can populate it.
- **Performance work on long transcripts.** N rows × per-row MV is functionally fine for v1. Re-evaluate if a smoke against ~50+ turns surfaces a regression. See [#risks].

#### Dependencies / Prerequisites {#dependencies}

- `TugTranscriptEntry` primitive (parent §step-9 — shipped).
- `CodeSessionStore` with `transcript`, `streamingDocument`, and the existing `streamingPaths.assistant` path (already in place).
- `SessionMetadataStore.SessionMetadataSnapshot.model: string | null` for the dynamic `code` row identifier.
- `SmartScroll` library (`tugdeck/src/lib/smart-scroll.ts` — existing).
- `useSyncExternalStore` is the only path React state enters from external stores ([L02]).

#### Constraints {#constraints}

- **Tuglaws** [L02], [L06], [L20], [L22] apply at every step. See [#tuglaws-cross-check].
- **Warnings are errors.** `cargo build` / `cargo nextest run` enforce `-D warnings` (CLAUDE.md build policy). Frontend type-check + tests treat warnings as errors equivalently.
- **HMR is always running**: never run a manual tugdeck build (`feedback_hmr` memory).
- **Use bun, not npm**: every tooling invocation is `bun ...` (`feedback_use_bun` memory).
- **happy-dom test scoping**: most tests in this plan exercise rendered DOM shape and snapshot-driven row counts — happy-dom is suitable. The auto-follow-bottom test in Step 4 inspects scroll position; if happy-dom's scroll model is insufficient there, the test moves to a real DOM-bearing harness rather than fudging with mocks (`feedback_no_happy_dom_tests`).
- **No mock-store assertion tests**: tests render through real `CodeSessionStore` instances driven by golden fixtures or synthetic dispatches, not hand-rolled mock stores (`feedback_no_mock_store_tests`).
- **No plan numbers in code**: no `step-N`, `T3.4.d`, `D01`, etc. in code, comments, or docstrings (`feedback_no_plan_numbers_in_code`).
- **Cross-check tuglaws**: read [tuglaws.md](../tuglaws/tuglaws.md), [pane-model.md](../tuglaws/pane-model.md), [component-authoring.md](../tuglaws/component-authoring.md) before TSX changes (`feedback_tuglaws_cross_check`).

#### Assumptions {#assumptions}

- The in-flight `user` row's data source is `inflightUserMessage` on the snapshot, written from the reducer's existing `pendingUserMessage` state. Lifecycle: set on `send()`, cleared on `turn_complete` or `interrupt`. Verified by [Step 1](#step-1)'s reducer tests.
- Per-row markdown rendering does not require the full virtualization that `TugMarkdownView` provides for tugcode log views. Per-turn assistant output is bounded enough that flat block rendering performs adequately for v1. Re-visit if [#risks] R01 fires.
- `SessionMetadataStore.model` is the right source for the `code` row identifier. If unset, fall back to the literal `"Code"`. The fallback case is exercised by tests that bypass session-init.
- The existing `TugMarkdownView` streaming observer's "skip empty writes" behavior is the only thing keeping the previous wire-up's "sticky last turn" alive. Once Step 3 removes the single-region wire-up, that behavior naturally goes away — there is no separate sticky-fallback code path to delete. Verified by inspection in [Step 3](#step-3).

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows [tuglaws/tugplan-skeleton.md §reference-conventions](../tuglaws/tugplan-skeleton.md#reference-conventions). Key points:

- All execution-step anchors are kebab-case `step-N`.
- Design decisions use `dNN-...` slugs.
- Open questions use `qNN-...` slugs.
- Risks use `rNN-...` slugs.
- `**References:**` lines cite specific decisions, specs, lists, and anchors — never line numbers.
- `**Depends on:**` lines cite step anchors only.

---

### Open Questions {#open-questions}

> Open questions are tracked work. If a question remains open at phase-end, explicitly defer it with a rationale and a follow-up plan.

#### [Q01] Per-row MV embedding strategy (OPEN — needs user resolution before [Step 2](#step-2)) {#q01-mv-embedding}

**Question:** [Step 9](./tugplan-tide-transcript-primitive.md#q01-body-slot-ownership) resolved `code` row body ownership as "per-row MV" — each completed `code` row owns one `TugMarkdownView` bound by `setRegion("body", text)`; the in-flight row binds to `streamingDocument` via `streamingPath`. But `TugMarkdownView` is a self-contained scroll container (`tugx-md-scroll-container { overflow-y: auto }`) with internal block-windowing virtualization that depends on its own `scrollTop`. A per-row MV inside an outer transcript-level scroll container creates a mismatch: the inner MV's virtualization keys off scroll events that fire on the outer container, not the inner. How should per-row markdown rendering compose with the transcript-level scroll surface?

**Why it matters:** Determines whether [Step 2](#step-2) modifies `TugMarkdownView` (adds a flow mode), introduces a new sibling primitive, or revisits Step 9's [Q01] resolution. The integration shape of [Step 3](#step-3)'s wire-up depends on this answer.

**Options:**

- **(A) Add a `flow?: "scroll" | "natural"` prop to `TugMarkdownView`.** In `natural`, virtualization is bypassed and all blocks render at the row's natural content height. The transcript-level scroll wraps the row stack. *Largest change to MV; cleanest at the call site.*
- **(B) New `TugMarkdownBlock` primitive.** Same WASM lex/parse pipeline, no virtualization, no internal scroll. Used per `code` row body. Streaming binding works the same way (`setRegion('body', text)` driven by a streamingPath observer) but without windowing. *Smaller MV change; one new primitive to maintain. **Recommended.***
- **(C) Revisit Step 9's [Q01] to single transcript-wide MV.** One `TugMarkdownView` at the top pane; each `code` row gets `setRegion(\`code-${msgId}\`, text)`. User rows render outside the MV, layered or interleaved — fights MV's virtualization. *Architecturally awkward; not recommended.*

**Plan to resolve:** User decision before [Step 2](#step-2). Author recommends (B).

**Resolution:** OPEN — see [D02] when resolved.

---

#### [Q02] Snapshot extension shape for in-flight user message (OPEN — needs user resolution before [Step 1](#step-1)) {#q02-snapshot-extension}

**Question:** The reducer carries `pendingUserMessage: { text, atoms } | null` internally; the snapshot does not expose it. The in-flight `user` row needs a data source visible to React via `useSyncExternalStore`. What field name and shape on `CodeSessionSnapshot`?

**Why it matters:** Public API surface — tide.md §T3.4.a documents `CodeSessionSnapshot` as a contract. Changes must be coherent with the rest of the snapshot. A poor name leaks into [Step 3](#step-3)'s render path and the test surface.

**Options:**

- **(A) `inflightUserMessage: { text: string; atoms: ReadonlyArray<AtomSegment> } | null`** — mirrors the reducer's internal field name. Sets on `send()`, clears when the turn commits or interrupts. **Recommended.**
- **(B) `inflightTurn: { userMessage: { text, atoms }; msgId: string | null } | null`** — broader struct that could absorb future in-flight state. Bigger shape change up front; future-proofs less obviously.
- **(C) Reuse `transcript` somehow.** Synthesize an in-flight `TurnEntry` and prepend. Requires `TurnEntry` to express in-flight (`result` is `"success" | "interrupted"` today, not nullable). Conflates committed and in-flight semantics. Not recommended.

**Plan to resolve:** User decision before [Step 1](#step-1). Author recommends (A).

**Resolution:** OPEN — see [D01] when resolved.

---

#### [Q03] User-row body content type (DECIDED, plain text v1) {#q03-user-body}

**Question:** How does the `user` row's `body` slot render the submitted prompt? Plain text? Atom-aware (route prefix `>`, file references)?

**Resolution:** DECIDED — plain text for v1. `TurnEntry.userMessage.attachments` is typed as `ReadonlyArray<unknown>` today; an atom-aware renderer is meaningful only after the prompt entry's atom data flows into transcript form. v1 renders `userMessage.text` verbatim inside a `<span>` with no markdown / atom interpretation. Atom rendering tracked under [#roadmap].

---

#### [Q04] Auto-follow-bottom cadence (DECIDED, lean on SmartScroll) {#q04-auto-follow-cadence}

**Question:** When does the transcript pin to the bottom? Every assistant delta? Only on commit? Only on submit?

**Resolution:** DECIDED — lean on existing `SmartScroll` semantics. While `SmartScroll.isFollowingBottom`, `pinToBottom()` is called on every observable content-growth event (assistant delta during streaming, in-flight user-row mount on submit, committed-pair mount on `turn_complete`). User scroll-up disengages auto-follow via `SmartScroll`'s built-in handling; the next idle re-engagement happens through `SmartScroll`'s existing logic, not custom code in the card. See [D04].

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Per-row MV count regresses scroll perf at long transcripts | med | med | Insulated by [D02]; perf evaluated post-ship in a smoke against ~50+ turns | Smoke against ≥ 50-turn fixture in §step-12 / §step-13 |
| Streaming binding swap on `turn_complete` flickers | med | low | The in-flight row unmounts and a committed row mounts with the final text in the same React commit. Test asserts no intermediate empty render | Visual review during manual smoke |
| `SmartScroll` auto-follow fights the streaming observer's own scroll behavior | med | med | The streaming observer in [Q01]'s embedding primitive does not slam scrollTop — it only writes block content. SmartScroll owns scroll position writes | If `pinToBottom` is observed to bounce mid-stream |
| Snapshot extension breaks downstream consumers | low | low | `inflightUserMessage` is a new optional field — additive. Existing consumers ignore it | Type-check + test surface |

**Risk R01: Per-row MV at long transcripts.** {#r01-perf-long}

- **Risk:** Each per-row MV pulls in a WASM lex/parse pipeline per turn. A 100-turn session mounts 100 such pipelines.
- **Mitigation:** [Q01] resolution governs the embedding primitive's footprint. (B) `TugMarkdownBlock` is intentionally lighter than full `TugMarkdownView`; (A) `flow="natural"` on `TugMarkdownView` shares the existing pipeline.
- **Residual risk:** Memory and parse-time at extreme N. Re-evaluate during parent §step-12 / §step-13 manual smokes against representative transcripts.

**Risk R02: In-flight code-row remount on `turn_complete` flickers.** {#r02-commit-flicker}

- **Risk:** When a turn commits, the in-flight `code` row unmounts and a new committed `code` row mounts. React's reconciler may briefly paint an empty body before the committed row's `setRegion` call flushes.
- **Mitigation:** [Step 3](#step-3) renders the in-flight pair conditional on `phase !== "idle" && inflightUserMessage !== null`. The committed `code` row's MV calls `setRegion("body", entry.assistant)` synchronously in `useLayoutEffect` ([L03]) so the body is populated before paint.
- **Residual risk:** None expected. Verified by the multi-turn integration test asserting no empty `code` row in the rendered DOM after a successful turn.

**Risk R03: Removal of "sticky last turn" leaves users surprised.** {#r03-sticky-removal}

- **Risk:** Users accustomed to the prior wire-up may notice the visual change — the assistant's final text now lives in a committed `code` row rather than persisting in a single streaming view.
- **Mitigation:** The committed `code` row holds the same final text. Visual treatment is governed by Step 9's tokens; behavior is preserved (final assistant text remains visible after `turn_complete`).
- **Residual risk:** None — the user experience strictly improves (multi-turn history is now visible).

---

### Design Decisions {#design-decisions}

#### [D01] `inflightUserMessage` lives on the snapshot (DECIDED pending [Q02] resolution) {#d01-inflight-on-snapshot}

**Decision:** Extend `CodeSessionSnapshot` with `inflightUserMessage: { text: string; atoms: ReadonlyArray<AtomSegment> } | null`. Set in `getSnapshot()` from the reducer's existing `state.pendingUserMessage` field. Cleared exactly when `pendingUserMessage` clears (turn commit or interrupt).

**Rationale:**

- The in-flight `user` row's data source must enter React through `useSyncExternalStore` only ([L02]). Card-level local state would diverge from the reducer's truth.
- The reducer already maintains `pendingUserMessage`; this is purely an exposure change, not new state.
- The snapshot field name mirrors the reducer field for greppability.
- Pending [Q02]'s final resolution; (A) is the recommended shape.

**Implications:**

- `CodeSessionSnapshot` interface gains one optional-by-shape field. Additive; no consumer breakage.
- `tide.md §T3.4.a` documentation must mention the new field — included in [Step 5](#step-5)'s documentation pass.
- Reducer tests exercise the field's lifecycle (`test-01-round-trip.jsonl`, `test-06-interrupt.jsonl`).

---

#### [D02] Embedding primitive is its own commit before wire-up (DECIDED — strategy; see [Q01] for option) {#d02-embedding-first}

**Decision:** The chosen embedding primitive (`flow="natural"` mode on `TugMarkdownView` or new `TugMarkdownBlock`) lands in [Step 2](#step-2) as its own commit, with its own tests, before [Step 3](#step-3)'s wire-up consumes it. The actual primitive choice is [Q01].

**Rationale:**

- Decouples the architectural change from the wire-up commit. If [Step 3](#step-3) needs to revise how it consumes the primitive, the revision is a single-file edit, not a multi-file unwind.
- Tests for the embedding primitive verify it in isolation — no `CodeSessionStore` plumbing required.
- Mirrors the Step 9 pattern (primitive first, consumer later).

**Implications:**

- [Step 2](#step-2) ships a primitive plus tests; [Step 3](#step-3) consumes it.
- If [Q01] resolves to (C) (single transcript-wide MV), [Step 2](#step-2) has nothing to add — it becomes a no-op step that documents the decision in a code comment. The plan would re-shape: [Step 3](#step-3) wires the single MV directly.

---

#### [D03] Transcript scroll container is a new top-pane wrapper, not part of the primitive (DECIDED) {#d03-transcript-scroll-container}

**Decision:** The transcript-level scroll container is a `<div className="tide-card-transcript">` inside the existing `TugSplitPanel id="tide-card-top"`. Token-driven. Owns `overflow-y: auto`, the row stack flex layout, and the SmartScroll instance. The `TugTranscriptEntry` primitive does not change — it is layout-only per Step 9.

**Rationale:**

- Keeps `TugTranscriptEntry` decoupled from scroll mechanics ([L02] / Step 9 [D02]).
- Token names live under `--tugx-tide-transcript-*` (Tide-specific), not under the primitive's `--tugx-transcript-*` namespace, because they govern the transcript surface's host-level scroll/layout, not the row primitive.
- Single ownership of scroll position by `SmartScroll` for the surface.

**Implications:**

- `tide-card.css` gains a `.tide-card-transcript` block with the new tokens.
- `brio.css` and `harmony.css` gain `--tugx-tide-transcript-*` tokens (height behavior, row gap, padding).
- The single `<TugMarkdownView>` at the top pane is replaced by the new `<div className="tide-card-transcript">` with row children.

---

#### [D04] SmartScroll governs scroll position writes (DECIDED) {#d04-smart-scroll-owns-position}

**Decision:** All programmatic scroll position writes for the transcript surface go through `SmartScroll`. The card calls `smartScrollRef.current?.pinToBottom()` on observable content-growth events (assistant delta, in-flight user-row mount, committed-pair mount). The card does not write `scrollTop` directly.

**Rationale:**

- Single source of truth for follow-bottom behavior; centralizes the user-opt-out logic.
- Mirrors the existing `TugMarkdownView` pattern where SmartScroll owns the position writes.
- Streaming deltas are the highest-frequency growth event; `pinToBottom()` is cheap (a single `scrollTop` write) and idempotent.

**Implications:**

- The card observes `streamingDocument.inflight.assistant` writes via the same observe API the in-flight code row's MV uses, but only to invoke `pinToBottom`. The actual content rendering flows through the embedding primitive's own observer.
- Or — depending on [Q01] — the embedding primitive emits a `onContentGrew` callback that the card hooks for `pinToBottom`. [Step 4](#step-4) chooses the cleaner of the two patterns.

---

#### [D05] User row body is plain text in v1 (DECIDED — see [Q03]) {#d05-user-body-plaintext}

**Decision:** The `user` row's `body` slot renders `userMessage.text` inside a `<span>` with no markdown or atom interpretation. `TurnEntry.userMessage.attachments` is read but unused.

**Rationale:**

- `attachments` is `ReadonlyArray<unknown>` today. Atom-aware rendering depends on the prompt entry's atom flow reaching transcript form, which is not in scope for this plan.
- Plain text matches what the user typed (sans atoms expansion), keeping the rendered transcript faithful to the submission.
- Atom rendering for transcripts becomes its own follow-on plan once the data shape stabilizes.

**Implications:**

- `TurnEntry.userMessage.attachments` is rendered as nothing in v1.
- The `body` slot accepts a `ReactNode`; switching to atom-aware rendering later is a slot-content change, not a primitive change.

---

### Specification {#specification}

#### Public API additions {#public-api}

```ts
// tugdeck/src/lib/code-session-store/types.ts

export interface CodeSessionSnapshot {
  // ... existing fields ...
  /**
   * The in-flight user message — set the moment `send()` is dispatched
   * and cleared exactly when the matching `TurnEntry` is committed to
   * `transcript` or the turn is interrupted. Drives the in-flight `user`
   * `TugTranscriptEntry` row in the Tide card transcript.
   */
  inflightUserMessage: {
    text: string;
    atoms: ReadonlyArray<AtomSegment>;
  } | null;
}
```

#### Render shape {#render-shape}

The Tide card top pane (`TugSplitPanel id="tide-card-top"`) hosts:

```tsx
<div ref={scrollContainerRef} className="tide-card-transcript">
  {snap.transcript.map((entry) => (
    <React.Fragment key={entry.msgId}>
      <TugTranscriptEntry
        participant="user"
        identifier="You"
        timestamp={formatTimestamp(entry.endedAt)}
        body={<span className="tide-card-transcript-user-body">{entry.userMessage.text}</span>}
      />
      <TugTranscriptEntry
        participant="code"
        identifier={modelDisplayName ?? "Code"}
        timestamp={formatTimestamp(entry.endedAt)}
        body={<TugMarkdownBlock initialText={entry.assistant} />}
      />
    </React.Fragment>
  ))}
  {snap.phase !== "idle" && snap.inflightUserMessage !== null && (
    <>
      <TugTranscriptEntry
        participant="user"
        identifier="You"
        body={<span className="tide-card-transcript-user-body">{snap.inflightUserMessage.text}</span>}
      />
      <TugTranscriptEntry
        participant="code"
        identifier={modelDisplayName ?? "Code"}
        body={
          <TugMarkdownBlock
            streamingStore={codeSessionStore.streamingDocument}
            streamingPath={snap.streamingPaths.assistant}
          />
        }
      />
    </>
  )}
</div>
```

(The exact shape of the embedding primitive — `TugMarkdownBlock` vs `TugMarkdownView flow="natural"` — is [Q01].)

#### Tokens {#tokens}

New `--tugx-tide-transcript-*` token set in `brio.css` and `harmony.css` for the transcript scroll surface. Distinct from `--tugx-transcript-*` (Step 9 primitive namespace).

| Token | Purpose | Initial value (brio) |
|-|-|-|
| `--tugx-tide-transcript-padding-block` | Top/bottom padding inside the scroll container | `var(--tug-space-md)` |
| `--tugx-tide-transcript-padding-inline` | Left/right padding inside the scroll container | `var(--tug-space-md)` |
| `--tugx-tide-transcript-row-gap` | Gap between adjacent `TugTranscriptEntry` rows | `var(--tugx-transcript-row-gap)` |
| `--tugx-tide-transcript-scroll-padding-end` | Bottom scroll padding so the last row clears the entry pane edge | `var(--tug-space-lg)` |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|-|-|
| `tugdeck/src/components/tugways/tug-markdown-block.tsx` | (If [Q01] = (B)) New embedding primitive |
| `tugdeck/src/components/tugways/tug-markdown-block.css` | (If [Q01] = (B)) New primitive styles |
| `tugdeck/src/components/tugways/__tests__/tug-markdown-block.test.tsx` | (If [Q01] = (B)) Primitive unit tests |

#### Modified files {#modified-files}

| File | Change |
|-|-|
| `tugdeck/src/lib/code-session-store/types.ts` | Add `inflightUserMessage` to `CodeSessionSnapshot` |
| `tugdeck/src/lib/code-session-store.ts` | Populate `inflightUserMessage` in `getSnapshot()` |
| `tugdeck/src/components/tugways/tug-markdown-view.tsx` | (If [Q01] = (A)) Add `flow` prop, gate virtualization |
| `tugdeck/src/components/tugways/cards/tide-card.tsx` | Replace single-region wire-up; transcript-aware rendering; SmartScroll wiring |
| `tugdeck/src/components/tugways/cards/tide-card.css` | Add `.tide-card-transcript` block |
| `tugdeck/styles/themes/brio.css` | Add `--tugx-tide-transcript-*` tokens |
| `tugdeck/styles/themes/harmony.css` | Mirror tokens |
| `tugdeck/src/components/tugways/cards/__tests__/tide-card.test.tsx` | Multi-turn rendering coverage |
| `dash/tide.md` | Update §T3.4.a to mention `inflightUserMessage` |
| `dash/tugplan-tide-card-polish.md` | Flip §step-11 row to "shipped" with the Cmd+J deferral note |

#### Symbols {#symbols}

| Symbol | Kind | Location | Notes |
|-|-|-|-|
| `inflightUserMessage` | field on `CodeSessionSnapshot` | `code-session-store/types.ts` | New |
| `TugMarkdownBlock` | component | (if [Q01] = (B)) `tug-markdown-block.tsx` | New |
| `formatTranscriptTimestamp` | helper fn | `tide-card.tsx` (private) | Maps a `Date.now()`-style ms value to a short display string |
| `useTranscriptModelName` | helper hook | `tide-card.tsx` (private) | Reads `SessionMetadataStore.model` via `useSyncExternalStore` |

---

### Documentation Plan {#documentation-plan}

- [ ] Module docstring on `code-session-store/types.ts` notes `inflightUserMessage` lifecycle (set on `send()`, cleared on commit/interrupt).
- [ ] Module docstring on the new embedding primitive (if [Q01] = (B)) clarifies its role: per-row markdown rendering inside a transcript scroll container, no internal scroll.
- [ ] `dash/tide.md §T3.4.a` snapshot shape gets the new field.
- [ ] `tugplan-tide-card-polish.md §step-11` row flips to "shipped" with the Cmd+J deferral noted.
- [ ] Module docstring on `tide-card.tsx` (or section comment) documenting the transcript rendering structure: committed `(user, code)` pairs from `snap.transcript` plus the in-flight pair from `snap.inflightUserMessage` + streaming binding.

---

### Test Plan Concepts {#test-plan-concepts}

| Category | Purpose | When |
|-|-|-|
| Reducer unit | `inflightUserMessage` lifecycle across send / turn_complete / interrupt | [Step 1](#step-1) |
| Embedding primitive unit | Renders markdown without internal scroll; streaming binding observer attaches | [Step 2](#step-2) |
| Tide card integration | Multi-turn fixture renders N `(user, code)` row pairs in order | [Step 3](#step-3) |
| Tide card integration | In-flight `user` row appears immediately on submit | [Step 3](#step-3) |
| Tide card integration | In-flight `code` row body streams from `inflight.assistant`; on commit, switches to committed `code` row with final text, no empty intermediate | [Step 3](#step-3) |
| Tide card integration | Auto-follow-bottom: scroll-up disengages, no further pin during streaming; idle re-engagement at bottom | [Step 4](#step-4) |
| Tuglaws walkthrough | Per-step compliance review against `tuglaws.md`, `pane-model.md`, `component-authoring.md` | [Step 5](#step-5) |

happy-dom is suitable for the rendering-shape tests. The auto-follow-bottom test (Step 4) inspects scroll position; if happy-dom's scroll model is too thin, the test moves to a real-DOM harness rather than mocking `SmartScroll`.

---

### Tuglaws Cross-Check {#tuglaws-cross-check}

- **L02** — `inflightUserMessage` enters React via `useSyncExternalStore` only. The card's snapshot read is the existing path; no new local state mirrors transcript or in-flight data.
- **L03** — committed `code` row's MV `setRegion("body", text)` runs in `useLayoutEffect` so the body is populated before paint.
- **L06** — appearance changes flow through CSS / DOM. Transcript scroll container is a CSS class with token-driven layout. SmartScroll writes `scrollTop` directly (DOM, not React state).
- **L07** — n/a (no event-handler closures with stale-deps risk in this plan).
- **L19** — the (potential) new `TugMarkdownBlock` follows the component-authoring guide: file pair, module docstring, exported props interface, `data-slot`.
- **L20** — component-token sovereignty: `--tugx-tide-transcript-*` for the surface; `--tugx-transcript-*` (Step 9 primitive) for the rows; base `--tug-*` referenced via `var()`, never redefined.
- **L22** — store observers may write DOM directly. The in-flight `code` row's streaming observer writes block content into the DOM without round-tripping through React state — this is the existing pattern.
- **L23** — n/a (transcript content is durable via the snapshot; no ephemeral state to round-trip).
- **L24** — n/a (no new state-zone classifications).

---

### Execution Steps {#execution-steps}

> Each step is its own commit. `bun x tsc --noEmit`, `bun test`, `bun run audit:tokens lint`, and `cargo nextest run` pass at the end of every step.

#### Step 1: Expose `inflightUserMessage` on the snapshot {#step-1}

**Commit:** `tide(transcript): expose inflightUserMessage on CodeSessionSnapshot`

**References:** [D01] inflight-on-snapshot, [Q02] snapshot-extension, (#public-api, #strategy)

**Artifacts:**

- `tugdeck/src/lib/code-session-store/types.ts` — `inflightUserMessage` field added to `CodeSessionSnapshot` interface.
- `tugdeck/src/lib/code-session-store.ts` — `getSnapshot()` populates the new field from `state.pendingUserMessage`.
- New reducer-shape tests asserting the lifecycle (set on `send()`, cleared on commit / interrupt).

**Tasks:**

- [ ] Resolve [Q02] (user decision: shape (A) `inflightUserMessage` vs (B) `inflightTurn` struct). Author recommends (A).
- [ ] Add the field to `CodeSessionSnapshot` per the chosen shape.
- [ ] Populate the field in `getSnapshot()` by mapping from `state.pendingUserMessage`.
- [ ] Update existing snapshot-shape tests in the store to assert the new field's default (`null`) is present.
- [ ] Add new tests against `test-01-round-trip.jsonl`: assert `inflightUserMessage` is non-null after `send("hello", [])` and null after `turn_complete(success)`.
- [ ] Add new tests against `test-06-interrupt.jsonl`: assert the field is cleared when the turn moves to `interrupted → idle`.
- [ ] Update the module docstring on `code-session-store/types.ts` to mention the new field.

**Tests:**

- [ ] `bun test src/lib/__tests__/code-session-store.*.test.ts` — existing snapshot tests pass with the new field present; new lifecycle tests pass.

**Checkpoint:**

- [ ] `bun x tsc --noEmit` — exit 0.
- [ ] `bun test` — all green.
- [ ] `cargo nextest run` — all green (no Rust touched, but verify nothing slipped).

---

#### Step 2: Land the embedding primitive {#step-2}

**Depends on:** #step-1

**Commit:** *(depends on [Q01] resolution)*
- (A) `tide(transcript): add flow=natural mode to TugMarkdownView`
- (B) `tide(transcript): add TugMarkdownBlock primitive`
- (C) (no commit; documented decision in a code comment in [Step 3](#step-3))

**References:** [D02] embedding-first, [Q01] mv-embedding, [#tuglaws-cross-check]

**Artifacts:** *(depends on [Q01])*

- (A) `TugMarkdownView` gains a `flow?: "scroll" | "natural"` prop. CSS gates `overflow-y` / `position` / `scroll-container` behavior on the prop. Tests assert `natural` mode renders all blocks at natural height.
- (B) New `tug-markdown-block.tsx` + `tug-markdown-block.css` + tests. Shares the WASM lex/parse pipeline. Exposes a `setRegion`-equivalent and a streaming-binding hook. Tests assert no internal scroll container, content height equals total block height.
- (C) No artifacts.

**Tasks:**

- [ ] Resolve [Q01] (user decision: (A) / (B) / (C)).
- [ ] Implement the chosen primitive per the component-authoring guide. Module docstring; props interface; `data-slot`.
- [ ] Tests cover: rendering, streaming binding (when applicable), no internal scroll, content height behavior.
- [ ] No consumer wire-up in this step — [Step 3](#step-3) consumes.

**Tests:**

- [ ] Unit tests for the chosen primitive (or skip for option C).
- [ ] `bun run audit:tokens lint` exits 0.

**Checkpoint:**

- [ ] `bun x tsc --noEmit` — exit 0.
- [ ] `bun test` — all green.
- [ ] `bun run audit:tokens lint` — zero violations.

---

#### Step 3: Wire transcript-aware rendering into the Tide card {#step-3}

**Depends on:** #step-2

**Commit:** `tide(transcript): wire multi-turn rendering with TugTranscriptEntry`

**References:** [D01] inflight-on-snapshot, [D03] transcript-scroll-container, [D05] user-body-plaintext, [Q03] user-body, [#render-shape], [#tokens], [#tuglaws-cross-check]

**Artifacts:**

- `tide-card.tsx` — replace `<TugMarkdownView streamingPath=... />` at the top pane with a `<div className="tide-card-transcript">` rendering `(user, code)` pairs from `snap.transcript` plus the in-flight pair from `snap.inflightUserMessage` + streaming binding.
- `tide-card.css` — `.tide-card-transcript` block consuming the new `--tugx-tide-transcript-*` tokens.
- `brio.css` and `harmony.css` — `--tugx-tide-transcript-*` tokens.
- Helper `useTranscriptModelName(sessionMetadataStore)` reading `model` via `useSyncExternalStore`, fallback `"Code"`.
- Helper `formatTranscriptTimestamp(ms)` returning a short display string.
- Tests in `__tests__/tide-card.test.tsx` covering: multi-turn fixture renders the expected row pairs in order; in-flight user row appears immediately on submit; in-flight code row body reflects streaming deltas; on `turn_complete(success)`, the committed pair carries the final text and no empty `code` row is intermediate.

**Tasks:**

- [ ] Add the `--tugx-tide-transcript-*` token set to `brio.css` and `harmony.css`.
- [ ] Add the `.tide-card-transcript` CSS block to `tide-card.css`.
- [ ] Replace the single `<TugMarkdownView>` at `tide-card.tsx`'s top pane with the transcript scroll container per [#render-shape].
- [ ] Implement the helper hooks (`useTranscriptModelName`, `formatTranscriptTimestamp`).
- [ ] Author multi-turn integration tests using the existing golden-catalog fixtures.
- [ ] Inspect for the "sticky last turn" behavior — confirm by inspection that no separate code path needs deletion (the behavior was emergent from the streaming observer's empty-write skip; once the streaming-bound element is gone, so is the stickiness).
- [ ] Update the section comment / module docstring on `tide-card.tsx`'s top-pane rendering to describe the new structure.

**Tests:**

- [ ] Multi-turn rendering: load `test-02-streaming-deltas.jsonl` (or a multi-turn synthetic), assert N `(user, code)` row pairs render in correct order.
- [ ] Immediate user row: simulate `submit("hi")`, assert a `user` row carrying `hi` is in the DOM before any assistant delta dispatch.
- [ ] Streaming-to-commit: drive the in-flight code row through deltas, assert the body reflects the deltas; on `turn_complete(success)`, assert the committed `code` row holds the final text and the in-flight pair is no longer in the DOM.
- [ ] Identifier: when `SessionMetadataStore.model` is set, `code` row identifier matches; when null, identifier is `"Code"`.
- [ ] User row body is plain text (not markdown / atom-rendered): assert `<span>` children equal `userMessage.text` verbatim.

**Checkpoint:**

- [ ] `bun x tsc --noEmit` — exit 0.
- [ ] `bun test` — all green.
- [ ] `bun run audit:tokens lint` — zero violations.
- [ ] `cargo nextest run` — all green.

---

#### Step 4: SmartScroll auto-follow-bottom {#step-4}

**Depends on:** #step-3

**Commit:** `tide(transcript): SmartScroll auto-follow-bottom`

**References:** [D04] smart-scroll-owns-position, [Q04] auto-follow-cadence, [R03] sticky-removal

**Artifacts:**

- `tide-card.tsx` — instantiate a `SmartScroll` against the transcript scroll container's element. Hook `pinToBottom` to: (a) the streaming-document observer for `inflight.assistant`, (b) the snapshot tick that mounts the in-flight pair on submit, (c) the snapshot tick that mounts a committed pair on `turn_complete`.
- A new test asserting auto-follow disengages on user scroll-up and re-engages at idle per `SmartScroll`'s existing semantics.

**Tasks:**

- [ ] Add a `useLayoutEffect` that creates a `SmartScroll` instance bound to the transcript scroll container ref. Dispose on unmount.
- [ ] Hook `pinToBottom()` to the three growth sources listed above. The implementation choice between observe-streaming-doc-directly vs primitive-emits-onContentGrew depends on the [Q01] resolution.
- [ ] Write the auto-follow test. If happy-dom's scroll model is insufficient, move the test to a real-DOM harness rather than mocking `SmartScroll`.
- [ ] Tuglaws check: confirm SmartScroll-driven scroll position writes go through the SmartScroll instance only ([D04] / [L06]).

**Tests:**

- [ ] Streaming-driven auto-follow: drive deltas, assert `scrollTop` tracks the bottom.
- [ ] User scroll-up disengages: simulate scroll-up, drive deltas, assert `scrollTop` does not advance.
- [ ] Idle re-engagement at bottom: after manual scroll-down to the bottom, drive a new `turn_complete`, assert auto-follow re-engages.

**Checkpoint:**

- [ ] `bun x tsc --noEmit` — exit 0.
- [ ] `bun test` — all green.
- [ ] `bun run audit:tokens lint` — zero violations.
- [ ] `cargo nextest run` — all green.

---

#### Step 5: Tuglaws walkthrough + parent close-out {#step-5}

**Depends on:** #step-3, #step-4

**Commit:** `tide(transcript): tuglaws walkthrough; close out parent §step-11`

**References:** (#tuglaws-cross-check, #success-criteria), parent §step-11 anchor

**Artifacts:**

- Per-step compliance review against [tuglaws.md](../tuglaws/tuglaws.md), [pane-model.md](../tuglaws/pane-model.md), [component-authoring.md](../tuglaws/component-authoring.md). Findings either land as small fixes in this commit or are explicitly logged.
- `tide.md §T3.4.a` updated to mention `inflightUserMessage` on the snapshot shape.
- `tugplan-tide-card-polish.md §step-11` row flipped to "shipped — see [tugplan-tide-transcript-rendering.md]"; the body trimmed to a 3-line marker mirroring the Step 10 close-out pattern.
- Note in the parent plan and in this plan's [#roadmap]: Cmd+J keybinding deferred to its own follow-up plan.

**Tasks:**

- [ ] Walk each tuglaw against this plan's diff. For any flagged item, either fix in this commit or document why deferred.
- [ ] Update `tide.md §T3.4.a` snapshot shape.
- [ ] Update parent plan's `§step-11` row + body.
- [ ] Add a roadmap entry for the deferred Cmd+J keybinding plan.

**Tests:**

- [ ] Full-suite green: `bun x tsc --noEmit`, `bun test`, `bun run audit:tokens lint`, `cargo nextest run`.

**Checkpoint:**

- [ ] All commands above exit clean.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Multi-turn transcript rendering in the Tide card top pane via `TugTranscriptEntry`. Committed turns from `snap.transcript` render as `(user, code)` pairs; the in-flight turn renders the user row on submit and streams the code row's body. SmartScroll auto-follow-bottom honors user opt-out. Cmd+J deferred to a follow-up plan.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] `CodeSessionSnapshot.inflightUserMessage` exists and tests cover its lifecycle.
- [ ] The Tide card top pane renders `(user, code)` row pairs from `snap.transcript` plus the in-flight pair when applicable.
- [ ] In-flight user row appears immediately on `send()`.
- [ ] In-flight code row's body streams from `streamingDocument.inflight.assistant`; on `turn_complete`, the committed pair holds the final text without an intermediate empty render.
- [ ] Auto-follow-bottom honors `SmartScroll`'s user-opt-out semantics.
- [ ] No "sticky last turn" survives; the committed row holds the final text via the snapshot.
- [ ] Tuglaws cross-check passes per-step.
- [ ] Parent plan §step-11 row flipped to "shipped"; Cmd+J explicitly logged as deferred follow-on.
- [ ] All check commands green: `bun x tsc --noEmit`, `bun test`, `bun run audit:tokens lint`, `cargo nextest run`.

**Acceptance tests:**

- [ ] Reducer lifecycle tests for `inflightUserMessage` (Step 1).
- [ ] Embedding-primitive unit tests (Step 2; skipped if [Q01] = (C)).
- [ ] Multi-turn rendering integration test (Step 3).
- [ ] Immediate-user-row integration test (Step 3).
- [ ] Streaming-to-commit transition test (Step 3).
- [ ] Auto-follow-bottom integration test (Step 4).

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] **Cmd+J keybinding plan.** Originally rolled into parent §step-11 from §step-6; deferred per user instruction (rendering and interaction are orthogonal). Authored as its own plan when scheduled. Exposes `getSelectedHistoryEntryId(): string | null` on the prompt-entry / text-editor delegate; adds a card-level Cmd+J handler that scrolls the matching `TugTranscriptEntry` into view, or to bottom if no selection.
- [ ] **Atom-aware rendering for `user` rows.** Once `userMessage.attachments` evolves into `AtomSegment[]` and the prompt entry's atom flow reaches transcript form, replace the plain-text `<span>` body with an atom-aware renderer.
- [ ] **Markdown styling pass for assistant output.** Parent §step-12.
- [ ] **Thinking + tool surfaces inside `code` rows.** Parent §step-13.
- [ ] **Queued-send rendering as `user` rows.** Parent §step-14.
- [ ] **Long-transcript performance review.** Smoke against ≥ 50-turn sessions during parent §step-12 / §step-13 manual passes; revisit [Q01] embedding choice if needed.

| Checkpoint | Verification |
|-|-|
| Reducer lifecycle | `bun test src/lib/__tests__/code-session-store.*.test.ts` |
| Embedding primitive | `bun test src/components/tugways/__tests__/tug-markdown-block.test.tsx` (if [Q01] = (B)) |
| Tide card integration | `bun test src/components/tugways/cards/__tests__/tide-card.test.tsx` |
| TS clean | `bun x tsc --noEmit` |
| Token audit | `bun run audit:tokens lint` |
| Workspace tests | `cargo nextest run` |
