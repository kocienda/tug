<!-- tugplan-skeleton v2 -->

## Tide Card Polish — `TugListView` Primitive + Multi-Turn Transcript Rendering {#tug-list-view}

**Purpose:** Ship `TugListView` — a framework-level windowed list primitive modeled on UIKit's `UITableView` (data source + delegate + cell-kind reuse abstraction + variable-height windowing + SmartScroll integration) — and consume it as the substrate for the Tide card's multi-turn transcript. The transcript is the first consumer; the picker (parent §step-10) and other list-shaped surfaces are deferred follow-ons. Cmd+J keybinding (originally absorbed into parent §step-11 from §step-6) is explicitly deferred to its own follow-up plan.

This plan supersedes [`tugplan-tide-transcript-rendering.md`](./tugplan-tide-transcript-rendering.md), which paused after the architectural review surfaced the framework-primitive question. Information from that plan (the `inflightUserMessage` snapshot extension, SmartScroll cadence, parent-plan close-out shape) flows through into this one.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | shipped (2026-05-03) — all 12 steps landed; phase exit criteria met |
| Target branch | tugplan-tug-list-view |
| Last updated | 2026-05-03 |
| Roadmap anchor | [tugplan-tide-card-polish.md §step-11](./tugplan-tide-card-polish.md#step-11) — this plan executes that step (Cmd+J deferred separately) |
| Predecessors | [tugplan-tide-transcript-primitive.md](./tugplan-tide-transcript-primitive.md) (closed parent §step-9), [tugplan-tide-session-ledger.md](./tugplan-tide-session-ledger.md) (closed parent §step-10), [tugplan-tide-transcript-rendering.md](./tugplan-tide-transcript-rendering.md) (paused; superseded by this plan) |
| Successors | parent §step-12 (markdown styling pass) builds on this; parent §step-13 (thinking + tool surfaces) builds on this; deferred Cmd+J keybinding plan; eventual session-picker migration onto `TugListView` |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The Tide card today has a single-region top pane: one `<TugMarkdownView streamingPath={codeSnap.streamingPaths.assistant} />` ([tide-card.tsx:1543](../tugdeck/src/components/tugways/cards/tide-card.tsx)). Completed turns leave their final assistant text behind as a "sticky last turn" (an emergent side-effect of the streaming observer's empty-write skip), the user's submitted prompt never appears, and multi-turn history is invisible. Parent §step-9 shipped `TugTranscriptEntry` as the row primitive; parent §step-10 shipped the session ledger. Parent §step-11 is the wire-up — and the architectural fork it surfaces is real.

The Tide canvas accumulates list-shaped surfaces by design:

- The session picker (parent §step-10's promoted plan, [D06](./tugplan-tide-session-ledger.md#d06-picker-list)) is a flat radiogroup today precisely because no list primitive existed.
- The multi-turn transcript (this plan) is the most demanding list surface — heterogeneous cells, streaming bindings, dynamic heights, append-and-scroll-to-bottom, eventually selection (Cmd+J).
- Future surfaces: a history panel, a permission/audit log for `control_request_forward` events, debugger watches once Tide grows surfaces beyond Code, file lists, project trees, command palettes.

Building each list surface as a one-off accumulates divergent implementations. The picker is already evidence — its rich rows exist as bespoke flexbox under `<div role="radiogroup">`. UIKit's `UITableView` is the battle-tested organizing principle for this shape: a table view that owns scroll/windowing/reuse, a data source that enumerates items, a delegate that opinionates on heights/lifecycle/selection, and prefetching that warms soon-to-be-visible work. We crib the design — it is genuinely the right answer — and adapt it to the web. The transcript becomes the proving ground.

The plan ships in two phases. **Phase A (Steps 1–8 + 8.5) builds the primitive + a companion `TugMarkdownBlock` + a gallery card** that exercises the basic features end-to-end against synthetic data. **Phase B (Steps 9–11) wires the transcript** on top of the primitive, with cell renderers for `user`, `code-committed`, and `code-streaming` rows. **Phase C (Step 12)** is the tuglaws walkthrough and parent close-out.

#### Strategy {#strategy}

- **Primitive first, consumer second.** Phase A lands `TugListView` against synthetic data with a gallery card; Phase B consumes it for the transcript. The primitive must be honest in isolation before any Tide-specific code touches it. See [D02], [D04].
- **Lineage from `UITableView`, but adapted to React.** The data-source / delegate / cell-kind abstraction is preserved verbatim. The implementation differs: cell "reuse" in v1 means React item-keyed mount/unmount with a stable kind contract, not imperative DOM pooling. See [D04].
- **Streaming cells are L22 territory.** A code row in mid-flight observes the `streamingDocument` directly through `TugMarkdownBlock`'s streaming binding; deltas do not pass through the data source's subscribe/getVersion path. The data source signals "this row is streaming" via `kindForIndex`; the rest is the cell's concern. See [D06], [L22].
- **Variable heights via `ResizeObserver` + sparse height index.** Mirrors `TugMarkdownView`'s `BlockHeightIndex` pattern adapted to per-cell heights. Unmeasured cells use `delegate.estimatedHeightForKind`; spacers above/below the rendered window account for unrendered totals. See [D07].
- **`SmartScroll` owns scroll position writes.** Auto-follow-bottom on data-source updates (when `isFollowingBottom`); user scroll-up disengages per existing `SmartScroll` semantics. The list view does not write `scrollTop` directly — every position write is via `SmartScroll`. See [D08].
- **TugMarkdownBlock as a sibling primitive, not a flow mode.** `TugMarkdownView` keeps its self-owned scroll container + virtualization; `TugMarkdownBlock` is a smaller primitive that shares the WASM lex/parse pipeline but renders all blocks in natural flow. Per-row markdown rendering inside a list cell uses the block primitive. See [D09].
- **`inflightUserMessage` lifted onto the snapshot.** The reducer's `pendingUserMessage` already maintains the data; Step 9 exposes it on `CodeSessionSnapshot` so the transcript's in-flight `user` row can render via `useSyncExternalStore`. See [D11].
- **No keybinding work.** Cmd+J ships in its own follow-up plan; this plan is rendering-only. See [#non-goals].
- **Tuglaws cross-checked at every step.** [L02], [L03], [L06], [L19], [L20], [L22], [L23] all apply. See [#tuglaws-cross-check].
- **Build stays green at every commit.** `bun x tsc --noEmit`, `bun test`, `bun run audit:tokens lint`, `cargo nextest run` all pass on every step. Warnings are errors.

#### Success Criteria (Measurable) {#success-criteria}

- A `TugListView` primitive exists at `tugdeck/src/components/tugways/tug-list-view.tsx` exposing `TugListViewDataSource`, `TugListViewDelegate`, `TugListViewCellProps`, `TugListViewCellRenderer`, `TugListViewHandle`, and `TugListView`. (Verified: file exists; types match the [#public-api]; primitive unit tests pass.)
- Variable-height cells: a synthetic data source mixing short and tall cells across 50 items renders correctly with measured heights replacing estimated heights as cells enter the viewport. (Verified: gallery card visual + unit test asserting the height-index updates after `ResizeObserver` fires.)
- Cell reuse contract: a data source with two kinds (`"odd"`, `"even"`) routes each cell through its kind's renderer. (Verified: unit test against synthetic data source asserts the right renderer fires per index.)
- `TugMarkdownBlock` exists at `tugdeck/src/components/tugways/tug-markdown-block.tsx`, renders markdown without an internal scroll container, and supports both initial-text (`<TugMarkdownBlock initialText={...}/>`) and streaming-binding (`<TugMarkdownBlock streamingStore={...} streamingPath={...}/>`) modes. (Verified: unit tests for both modes.)
- A gallery card `gallery-list-view` exercises the primitive end-to-end with synthetic data: heterogeneous kinds, variable heights, dynamic insert/delete, a streaming-bound cell that exercises `ResizeObserver`-driven height updates and `SmartScroll` auto-follow-bottom, and basic selection via `delegate.onSelect`. (Verified: card mounts cleanly; manual visual review.)
- `CodeSessionSnapshot.inflightUserMessage: { text: string; atoms: ReadonlyArray<AtomSegment> } | null` is set on `send()` and cleared on `turn_complete` / interrupt. (Verified: reducer-shape tests against `test-01-round-trip.jsonl` and `test-06-interrupt.jsonl`.)
- A `TideTranscriptDataSource` adapter implements `TugListViewDataSource` over `CodeSessionStore`'s snapshot, mapping committed turns to `(user, code-committed)` row pairs and the in-flight turn to `(user, code-streaming)` rows when applicable. (Verified: adapter unit test against fixture-driven `CodeSessionStore`.)
- The Tide card top pane mounts a `TugListView` wired to the transcript adapter; multi-turn rendering reads as a back-and-forth, the user's submitted prompt appears immediately on submit, the in-flight code row streams from `streamingDocument.inflight.assistant`, and the committed code row holds the final text after `turn_complete(success)`. (Verified: integration tests against multi-turn fixtures.)
- The previous "sticky last turn" emergent behavior no longer applies — no element bound to `streamingPath` survives `turn_complete`. (Verified: read-after-test of rendered DOM.)
- `bun x tsc --noEmit`, `bun test`, `bun run audit:tokens lint`, `cargo nextest run` green at every step.
- Parent plan §step-11 row flips to "shipped — see [tugplan-tug-list-view.md]" upon completion; Cmd+J deferral noted.

#### Scope {#scope}

1. **`TugListView` primitive** (Phase A). Component shell + windowing + variable-height ResizeObserver + cell-kind reuse abstraction + delegate lifecycle + SmartScroll integration. Imperative handle (`scrollToIndex`, `getElementForIndex`).
2. **`TugMarkdownBlock` companion primitive** (Phase A). Non-virtualizing markdown renderer for use inside list cells. Shares the WASM pipeline; supports `initialText` + `streamingPath` modes.
3. **Tokens** (Phase A). New `--tugx-list-view-*` token set in `brio.css` and `harmony.css`. (No new tokens for `TugMarkdownBlock` — it reuses `--tugx-md-*`.)
4. **Gallery card** (Phase A). `gallery-list-view` exercises the basic features end-to-end with synthetic data.
5. **`inflightUserMessage` snapshot extension** (Phase B). Lifted from the reducer's existing `pendingUserMessage` onto `CodeSessionSnapshot`.
6. **`TideTranscriptDataSource` adapter** (Phase B). Adapts `CodeSessionStore` to `TugListViewDataSource`.
7. **Transcript wire-up in `tide-card.tsx`** (Phase B). Replace the single-region wire-up; mount `TugListView` with three cell renderers (`user`, `code-committed`, `code-streaming`); remove sticky-last-turn fallback.
8. **Tuglaws walkthrough + parent close-out** (Phase C).

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Cmd+J keybinding.** Originally absorbed into parent §step-11 from §step-6; deferred per user instruction. Tracked in [#roadmap].
- **Prefetching protocol** (`UITableViewDataSourcePrefetching` analogue). Per user instruction. Tracked in [#roadmap].
- **Sections** (multi-section list, section headers/footers). v1 is single-section flat list. Tracked in [#roadmap].
- **Insert/delete/move animations.** v1 just rerenders on data-source updates. Tracked in [#roadmap].
- **Imperative DOM cell pooling.** v1 cell reuse is React item-keyed mount/unmount; the conceptual API (`kindForIndex` → reuse pool) is in place for a future imperative-DOM upgrade without consumer churn. Tracked in [#roadmap].
- **Native text selection survival across scroll-out.** Per [D13]: selecting text inside a cell, then scrolling far enough that the cell unmounts, then scrolling back, will leave the cell with no selection on the new mount. v1 limitation; v2 imperative-pool resolves it. Tracked in [#roadmap].
- **Selection beyond `delegate.onSelect(index)`.** Multi-select, swipe-to-edit, drag-to-reorder, and chain-driven selection commands are all out of scope. Tracked in [#roadmap].
- **Pull-to-refresh, header/footer views, editable cells.** UITableView ships these; we do not. Tracked in [#roadmap].
- **Picker migration.** The session picker (parent §step-10) keeps its existing radiogroup implementation. Migration onto `TugListView` is its own follow-on plan. Tracked in [#roadmap].
- **Atom-aware rendering for `user` rows.** v1 renders `userMessage.text` as plain text in a `<span>`. Atom rendering is a follow-on once the prompt entry's atom flow reaches transcript form.
- **Markdown styling pass for assistant output.** Token tuning of `--tugx-md-*` lives in parent §step-12.
- **Thinking + tool surfaces inside `code` rows.** Wired in parent §step-13.
- **`shell` and `command` participant rows.** Live data depends on Phase T4 (Tugshell) and Phase T10 (Surface Built-Ins).
- **Queued-send rendering as user rows.** Parent §step-14.
- **Long-transcript performance work beyond windowing.** Cell-reuse perf optimizations beyond what windowing buys are deferred; revisit if a smoke against ~50+ turns shows a regression.

#### Dependencies / Prerequisites {#dependencies}

- `TugTranscriptEntry` primitive (parent §step-9 — shipped).
- `CodeSessionStore` with `transcript`, `streamingDocument`, `streamingPaths.assistant` (already in place).
- `SessionMetadataStore.SessionMetadataSnapshot.model: string | null` for the dynamic `code` row identifier.
- `SmartScroll` (`tugdeck/src/lib/smart-scroll.ts` — existing).
- `TugMarkdownView`'s WASM pipeline + region map (existing; `TugMarkdownBlock` shares the pipeline but skips the virtualization layer).
- `ResizeObserver` API (browser-native). happy-dom does NOT provide it; tugdeck's `setup-rtl.ts` installs a no-op global stub. Tests that need to drive observer callbacks install a capturing variant per the existing `tug-text-editor-completion-overlay.test.tsx` pattern. Live `ResizeObserver` integration is verified by the gallery card and the live transcript manual smoke (Step 8 / Step 11) — see [Step 4](#step-4)'s test-environment note.
- `useSyncExternalStore` is the only path React state enters from external stores ([L02]).
- Existing token audit machinery (`bun run audit:tokens lint`) and the seven-slot naming convention.

#### Constraints {#constraints}

- **Tuglaws** [L02], [L03], [L06], [L19], [L20], [L22], [L23] apply at every step. See [#tuglaws-cross-check].
- **Warnings are errors.** `cargo build` / `cargo nextest run` enforce `-D warnings` (CLAUDE.md build policy). Frontend type-check + tests treat warnings as errors equivalently.
- **HMR is always running**: never run a manual tugdeck build (`feedback_hmr` memory).
- **Use bun, not npm**: every tooling invocation is `bun ...` (`feedback_use_bun` memory).
- **happy-dom test scoping**: all unit, component, reducer, adapter, and integration tests in this plan run in happy-dom. happy-dom does NOT provide `ResizeObserver` natively; tugdeck's `setup-rtl.ts` installs a no-op global stub. Tests that need to drive observer callbacks install a capturing variant (constructor stores the callback; tests invoke it manually) per the existing `tug-text-editor-completion-overlay.test.tsx` precedent. Live `ResizeObserver` integration is verified by the gallery card (manual review) and the live transcript smoke (manual). No real-DOM test harness is introduced — the layered coverage is enough. Mocking `SmartScroll` is forbidden per `feedback_no_happy_dom_tests` / `feedback_harness_purpose` — auto-follow-bottom tests drive the real `SmartScroll` via simulated scroll events on the container.
- **No mock-store assertion tests**: tests render through real `CodeSessionStore` instances driven by golden fixtures or synthetic dispatches, not hand-rolled mock stores (`feedback_no_mock_store_tests`).
- **No plan numbers in code**: no `step-N`, `T3.4.d`, `D01`, etc. in code, comments, or docstrings (`feedback_no_plan_numbers_in_code`).
- **Cross-check tuglaws**: read [tuglaws.md](../tuglaws/tuglaws.md), [pane-model.md](../tuglaws/pane-model.md), [component-authoring.md](../tuglaws/component-authoring.md), [responder-chain.md](../tuglaws/responder-chain.md), [state-preservation.md](../tuglaws/state-preservation.md), [token-naming.md](../tuglaws/token-naming.md) before TSX changes (`feedback_tuglaws_cross_check`).
- **`L20` token sovereignty**: `TugListView`'s CSS references only `--tugx-list-view-*` tokens; consumers (the Tide card) override list-view tokens via cascade scoping (`.tide-card-transcript .tug-list-view { --tugx-list-view-padding-block: ...; }`) without reaching into the primitive's internals.

#### Assumptions {#assumptions}

- v1 cell reuse via item-keyed React mount/unmount is functionally correct for transcripts up to ~50 turns. Performance is re-evaluated post-ship; if the smoke fails, the conceptual API is already in place for an imperative-DOM-pool upgrade. ([R02])
- `ResizeObserver` height-update cadence does not thrash during streaming. The streaming cell observes the `streamingDocument` and grows; `ResizeObserver` reports new heights; the height index updates and the spacer recomputes. The frequency is bounded by browser-paint-frame rate (60Hz typical), not delta arrival rate. ([R01])
- `SmartScroll`'s `pinToBottom()` is idempotent and cheap — a single `scrollTop` write — so calling it on every height-index update during streaming is safe.
- The reducer's `pendingUserMessage` field is the right source for the in-flight `user` row. Lifecycle: set on `send()`, cleared on `turn_complete` (success or interrupt). Verified against `test-01-round-trip.jsonl` and `test-06-interrupt.jsonl`.
- `TugMarkdownBlock` rendering all blocks in natural flow performs adequately for per-cell markdown content. The largest expected single-cell content is one assistant turn's complete response — orders of magnitude smaller than what `TugMarkdownView`'s virtualization is designed for.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows [tuglaws/tugplan-skeleton.md §reference-conventions](../tuglaws/tugplan-skeleton.md#reference-conventions). Key points:

- All execution-step anchors are kebab-case `step-N`.
- Design decisions use `dNN-...` slugs.
- Open questions use `qNN-...` slugs (this plan starts with all open questions resolved as decisions, retained as `Q-RESOLVED` for traceability).
- Risks use `rNN-...` slugs.
- `**References:**` lines cite specific decisions, specs, lists, and anchors — never line numbers.
- `**Depends on:**` lines cite step anchors only.

---

### Open Questions {#open-questions}

> All open questions for this plan were resolved during pre-authoring discussion (architectural-fork conversation, 2026-05-03). Retained here with `RESOLVED` markers for traceability.

#### [Q01] Cell reuse — conceptual API or imperative DOM pool? (RESOLVED → [D04]) {#q01-cell-reuse-shape}

**Question:** UIKit's `UITableView` reuses NSCell instances via `dequeueReusableCellWithIdentifier`. The web has no direct equivalent — React's reconciliation handles "reuse" for keyed lists, but DOM-level pooling requires imperative ownership. Should v1 build the imperative DOM pool, or settle for React item-keyed mount/unmount?

**Resolution:** RESOLVED — v1 implements cell reuse as React item-keyed mount/unmount with a stable kind contract (`kindForIndex`). The conceptual API is right for a future imperative-DOM-pool upgrade without consumer churn. Streaming cells are the only explicit exception — they observe the streaming source directly so a scroll-out-and-back doesn't break their binding.

---

#### [Q02] Streaming-cell binding pattern (RESOLVED → [D06]) {#q02-streaming-binding}

**Question:** Per-delta updates to a code row in mid-flight — flow through the data source's subscribe/getVersion (rerender the index → cell rerenders), or have the streaming cell observe the stream directly?

**Resolution:** RESOLVED — streaming cells observe the streaming source directly via `TugMarkdownBlock`'s streaming-binding mode. The data source signals "this row is streaming" via `kindForIndex` (`"code-streaming"` vs `"code-committed"`); deltas do not flow through the data source's tick path. This honors [L22] and avoids per-delta whole-list rerenders.

---

#### [Q03] Section model (RESOLVED → [D02]) {#q03-section-model}

**Question:** UITableView has sections (`numberOfSectionsInTableView`, per-section headers/footers). Single-section v1, or multi-section from day one?

**Resolution:** RESOLVED — single-section flat list in v1. Sections come in a follow-on plan if any consumer needs them. The transcript is single-section; the picker (eventual second consumer) would be too.

---

#### [Q04] Headers/footers (RESOLVED → [D02]) {#q04-headers-footers}

**Question:** Table headers / footers / per-section headers / per-section footers — included in v1?

**Resolution:** RESOLVED — none in v1. Add the option when a consumer needs them.

---

#### [Q05] Imperative API surface (RESOLVED → [D03]) {#q05-imperative-api}

**Question:** UITableView exposes many imperative methods. Which subset is v1?

**Resolution:** RESOLVED — only `scrollToIndex(index, options)` and `getElementForIndex(index)` are exposed via `forwardRef`'d `TugListViewHandle` in v1. `reloadData` is implicit (data source ticks drive it). Insert/delete/move animations are deferred.

---

#### [Q06] Selection model (RESOLVED → [D03]) {#q06-selection-model}

**Question:** What does v1 expose for selection?

**Resolution:** RESOLVED — `delegate.onSelect(index)` only. Selection ownership lives with the consumer. Cmd+J's eventual scroll-into-view uses `scrollToIndex` directly.

---

#### [Q07] `TugMarkdownBlock` — same plan or separate? (RESOLVED → [D09]) {#q07-md-block}

**Question:** The transcript wire-up needs a non-virtualizing markdown renderer for code-row body slots. Bundle it into this plan or its own?

**Resolution:** RESOLVED — bundle. `TugMarkdownBlock` lands as Step 7 inside Phase A. Both primitives ship through the gallery card before Phase B's transcript wire-up consumes them.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Height-index thrashing during streaming | med | med | Streaming cell observes stream directly; ResizeObserver fires bounded by browser paint rate; height index updates + spacer recompute are cheap | Manual smoke against a fast-streaming model |
| React item-keyed reuse leaves perf on the table at long N | med | low (v1) | Conceptual API in place; imperative-pool upgrade is a v2 with no consumer changes | Smoke against ≥ 50-turn transcript surfaces regression |
| Height-measurement races React's render | med | low | Heights collected via ResizeObserver, not inline measurement; updates flow through the height index, not React state ([L04]) | Visual flicker observed |
| `TugMarkdownBlock` natural-flow rendering surprises consumers expecting virtualization | low | low | Module docstring states the boundary explicitly; gallery card demos both primitives side-by-side | Developer feedback |
| Cell reuse contract drift between v1 (item-keyed) and v2 (imperative pool) | med | med | Public API is data-source-side; the consumer never knows whether reuse is React-level or DOM-level | API consumers observe a behavioral difference |

**Risk R01: Height-index thrashing during streaming.** {#r01-height-thrash}

- **Risk:** A code row's `TugMarkdownBlock` grows on every assistant delta. `ResizeObserver` reports new heights to the list view, the height index updates, and the spacer divs recompute. If this fires at delta rate and not paint rate, perf degrades.
- **Mitigation:** `ResizeObserver` callbacks are batched by the browser into pre-paint dispatches — they do not fire per delta if multiple deltas arrive between paints. The list view further coalesces height-index updates via `requestAnimationFrame` / `useLayoutEffect` so only one paint happens per height-change burst.
- **Residual risk:** Pathological streams that emit thousands of deltas per second. Not expected from Claude Code; mitigated structurally by browser rendering.

**Risk R02: React item-keyed reuse at long transcripts.** {#r02-react-reuse}

- **Risk:** v1 reuse means React mounts/unmounts cells as they enter/leave the rendered window. At ~100 turns × 2 rows/turn = 200 cells, scroll-up-and-down events trigger 200 mount/unmount cycles in succession. Per-mount React reconciliation cost is non-trivial.
- **Mitigation:** Item-keyed reuse plus the `kindForIndex` contract leaves the door open for a v2 that swaps in imperative DOM pooling without consumer changes. v1 ships windowing (only ~viewport+overscan cells alive), which is the dominant perf win.
- **Residual risk:** Users with hundred-turn sessions on slower devices may notice scroll jank. Re-evaluate during parent §step-12 / §step-13 manual passes.

**Risk R03: Streaming binding swap on commit.** {#r03-commit-flicker}

- **Risk:** When a turn commits (`turn_complete(success)`), the in-flight `code-streaming` row removes from the rendered list and a new `code-committed` row mounts. React's reconciler may briefly paint an empty body before the committed cell's `setRegion("body", text)` flushes.
- **Mitigation:** The `code-committed` cell renderer calls `setRegion` synchronously in `useLayoutEffect` ([L03]) — body is populated before paint. Integration tests assert no empty intermediate render.
- **Residual risk:** None expected.

**Risk R04: Picker migration creep.** {#r04-picker-creep}

- **Risk:** While building `TugListView`, the temptation to migrate the picker simultaneously is real. Doing so doubles the scope and makes the plan harder to land.
- **Mitigation:** Picker migration is explicitly deferred in [#non-goals] and tracked in [#roadmap]. The plan ships one consumer (transcript) and stays on that scope.
- **Residual risk:** None — discipline.

---

### Design Decisions {#design-decisions}

#### [D01] Lineage from UIKit's `UITableView` (DECIDED) {#d01-uitableview-lineage}

**Decision:** `TugListView`'s public API and conceptual model crib directly from UIKit's `UITableView`: a *data source* protocol that enumerates items + their kinds, a *delegate* protocol for heights / lifecycle / selection, kind-driven cell reuse, an imperative handle for scroll-into-view, and (in a follow-on) prefetching. Naming follows the lineage where it reads: `TugListViewDataSource`, `TugListViewDelegate`, `TugListViewCellRenderer`. Per-cell `index` rather than `IndexPath` (single-section v1 — see [D02]).

**Rationale:**

- `UITableView`'s design is battle-tested across decades of consumer apps. We are not inventing a contract; we are adapting a proven one.
- The decomposition into data source / delegate / cell renderers is genuinely the right organizing principle — same answer for the picker, history panel, audit log, file tree, debugger watches, and any other list-shaped surface Tide will accumulate.
- The web has no equivalent primitive. `react-window` is the closest, and it is intentionally narrower (fixed-size cells, no delegate, no prefetching, no edit). We are filling a gap, not duplicating an existing primitive.

**Implications:**

- API symbols read familiar to anyone with UIKit background.
- Future participation by the picker, history panel, etc. is a straight migration onto the same primitive.
- The plan explicitly defers prefetching, sections, headers/footers, animations, and richer selection — those are all UIKit features that we will add when consumers need them, not speculatively.

---

#### [D02] Single-section flat list in v1 (DECIDED — see [Q03]) {#d02-single-section}

**Decision:** v1 is a single-section flat list. No section concept in the public API; the data source is index-keyed (`numberOfItems`, `idForIndex`, `kindForIndex`) rather than `IndexPath`-keyed. No header/footer slots. Adding sections in a follow-on is additive — a new `numberOfSections` method, optional section header/footer renderers, and an `IndexPath` shape that the cell renderer receives.

**Rationale:**

- The transcript is single-section. The picker is single-section. Most list-shaped surfaces in Tide are single-section.
- Sections, headers, and footers all add real complexity (height index keyed by section, section-folding, sticky headers, keyboard navigation across section boundaries). None earns its place in v1.
- Migrating a single-section consumer to multi-section later is a renderer-side change; the primitive shape stays compatible.

**Implications:**

- Cell renderer signature: `(props: TugListViewCellProps) => React.ReactNode` where `props.index` is a flat number.
- Data source: flat `numberOfItems()` returns total count.
- Future work tracked in [#roadmap].

---

#### [D03] Imperative API surface — `scrollToIndex` and `getElementForIndex` only (DECIDED — see [Q05], [Q06]) {#d03-imperative-api}

**Decision:** v1 exposes a `TugListViewHandle` via `forwardRef` with two methods:
- `scrollToIndex(index: number, options?: { block?: ScrollLogicalPosition; animated?: boolean }): void`
- `getElementForIndex(index: number): HTMLElement | null`

`reloadData` is implicit — the data source's subscribe drives re-windowing. Insert/delete/move animations are deferred. Selection-related methods are deferred (the consumer owns selection state via `delegate.onSelect`).

**Rationale:**

- `scrollToIndex` is the single imperative the eventual Cmd+J keybinding plan needs. Without it, the consumer has to reach into the DOM to scroll a row into view, breaking the abstraction.
- `getElementForIndex` covers the "DOM-walk to compute target rect" case some consumers may need (e.g., a custom highlight overlay aligned to a row).
- Animations multiply complexity. Defer until a consumer demands them.

**Implications:**

- `scrollToIndex` for a **rendered** target delegates to `SmartScroll.scrollToElement` — the DOM rect is exact, no further work needed.
- `scrollToIndex` for an **unrendered** target follows a two-pass precision protocol:
  1. **Pass 1 — estimated jump.** Compute the target offset from `heightIndex.offsetForIndex(index, estimatedHeightForIndex)` (mixing measured heights for already-known cells with estimates for unmeasured ones). Call `SmartScroll.scrollTo({ top: estimatedOffset })`. The list view re-windows around the new scroll position; the target row mounts.
  2. **Pass 2 — measurement correction.** On the next `ResizeObserver` flush after the target row mounts, recompute `heightIndex.offsetForIndex(index, ...)` with the now-measured height. If it differs from the pre-mount estimate by more than a small threshold (e.g., 4px), call `SmartScroll.scrollTo({ top: correctedOffset })` once more. The threshold avoids correction loops on sub-pixel rounding noise.
- The two-pass protocol is invisible to consumers — they call `scrollToIndex(i)` once and get a row that lands at the requested position regardless of whether intervening rows were measured.
- `getElementForIndex` returns `null` when the row is outside the rendered window (consumer can call `scrollToIndex` first to bring it on-screen).
- Out-of-range indices: `scrollToIndex(-1)` and `scrollToIndex(numberOfItems)` clamp to first / last item respectively (not throw); `getElementForIndex` for out-of-range returns `null`. Clamping rather than throwing matches `UITableView`'s tolerance for stale index paths during update transitions.

---

#### [D04] Cell reuse — conceptual API, item-keyed implementation (DECIDED — see [Q01]) {#d04-cell-reuse}

**Decision:** v1 cell reuse is React item-keyed mount/unmount. The data source declares `kindForIndex(index): string`; the list view dispatches each rendered index through `cellRenderers[kind]`. React uses the data source's `idForIndex(index)` as the React key, so a row that scrolls out and back gets a fresh React mount with a fresh DOM tree. The conceptual API surface (`kindForIndex` + reuse-pool semantics) is in place for a future imperative-DOM-pool upgrade without consumer changes.

**Rationale:**

- Imperative DOM pooling on the web requires giving up React reconciliation for cell DOM, which is a big architectural commitment. v1 should not pay that cost speculatively.
- React item-keyed mount/unmount + windowing buys most of the perf win UITableView's reuse provides — at most viewport+overscan cells are alive at once.
- The `kindForIndex` contract is the seam through which v2 imperative pooling becomes invisible to consumers. Consumers register cell renderers per kind; the implementation under the hood is opaque to them.
- Streaming cells must persist across scroll-out-and-back without losing their binding. v1 handles this not via cell reuse but via [D06]: streaming cells observe the streaming source directly, so a fresh React mount picks up the live binding without ceremony.

**Implications:**

- Public API: data sources implement `kindForIndex`; consumers register cell renderers as `Record<string, TugListViewCellRenderer>`.
- React keys: cells use `dataSource.idForIndex(index)` so React reconciler matches identity across data-source updates.
- v2 upgrade path: replace the React-cell render pipeline with an imperative DOM pool that dequeues per kind, while keeping the public API stable.

**Caveat — v1 → v2 lifecycle semantics differ for stateful cell renderers.** v1 (item-keyed React mount/unmount) tears down a cell's React component instance whenever it scrolls out, which destroys any local state held in `useState` / `useRef` / mid-flight `useEffect` work. v2 (imperative DOM pool) keeps the component instance alive across scroll-out and rebinds it to new props. Renderers that hold local state will see different lifecycle semantics across the upgrade — `useState` values that v2 preserves would reset in v1, an in-flight `setTimeout` v1 cancelled would survive in v2, etc.

For *stateless presentational* renderers (text + markdown body, the v1 transcript cell shapes), there is no observable difference. For *stateful* renderers, the upgrade is observable and may require renderer-level changes to handle both lifecycle modes.

This plan ships only stateless cell renderers (user / code-committed / code-streaming). Future cell renderers that need to hold local state should opt into the [A9] state-preservation protocol via `useComponentStatePreservation` so their state survives the v1 lifecycle, which makes them automatically forward-compatible with v2's preservation-by-instance behavior.

---

#### [D05] Variable heights via `ResizeObserver` + sparse height index (DECIDED) {#d05-height-index}

**Decision:** Height tracking is per-cell, via `ResizeObserver` attached to each rendered cell. Measured heights are stored in a sparse `HeightIndex` (`Map<index, number>`). Unmeasured cells use `delegate.estimatedHeightForKind(kind)` (default 60px). Spacer divs above and below the rendered window account for unrendered cells' total estimated/measured height, faking the scroll height.

**Rationale:**

- `ResizeObserver` is the correct API for measuring DOM-rendered content height, including dynamic streaming content. It does not fight React's render cycle ([L04]).
- A sparse map keyed by index handles the v1 "we don't know all heights up front" case without requiring upfront layout passes.
- Estimated heights per kind let the spacer math be approximately correct before any cells render, avoiding flicker on first mount.

**Implications:**

- The list view writes spacer heights directly to the DOM ([L06] — appearance-zone), not through React state.
- Height-index updates trigger re-windowing (which cells should be in the rendered window) but only re-window when the change crosses a viewport boundary. Streaming-cell height growth that stays inside the viewport doesn't cause re-windowing churn.

---

#### [D06] Streaming cells observe the stream directly (DECIDED — see [Q02]) {#d06-streaming-direct}

**Decision:** A `code-streaming` cell renderer mounts a `TugMarkdownBlock` with `streamingStore={codeSessionStore.streamingDocument}` and `streamingPath={"inflight.assistant"}`. The block's internal observer (per [L22]) writes block content directly to the DOM in response to streaming-document updates. The data source's subscribe/getVersion path is *not* invoked on each delta; the list view rerenders only on data-source-level events (transcript appended, in-flight pair appears/disappears, etc.).

**Rationale:**

- Per-delta whole-list rerenders are wasteful. A 30Hz delta stream against a 100-row transcript means 3000 React rerenders per second.
- `TugMarkdownBlock`'s direct-observer pattern matches `TugMarkdownView`'s existing behavior — store change → DOM write, no React round-trip.
- `ResizeObserver` picks up the resulting height changes and updates the height index. The list view re-windows only when the rendered set changes, not on every paint.

**Implications:**

- `TugMarkdownBlock` ships with both `initialText` (static) and `streamingStore` + `streamingPath` (dynamic) modes. Step 7 ships the primitive.
- `code-streaming` and `code-committed` are distinct cell kinds. The renderer for each is small.
- Tests for the streaming cell observe the rendered DOM updating without re-rendering the list view itself.

---

#### [D07] `SmartScroll` owns scroll position writes (DECIDED) {#d07-smart-scroll}

**Decision:** Every programmatic scroll position write for `TugListView` goes through `SmartScroll`. The list view instantiates a `SmartScroll` against its scroll container in `useLayoutEffect`. `pinToBottom()` fires on observable content-growth events (data-source ticks that grow the item count, height-index updates that change total height while the in-flight row is at the bottom). User scroll-up disengages auto-follow per existing `SmartScroll` semantics.

**Rationale:**

- Single source of truth for follow-bottom behavior, centralizing the user-opt-out logic.
- Mirrors `TugMarkdownView`'s existing pattern.
- `SmartScroll` already handles keyboard scroll-up keys (PageUp, ArrowUp, Home), pointer-down + drag detection, and scroll-end → idle re-engagement. The list view inherits all of that for free.

**Implications:**

- The list view does not write `scrollTop` directly except via `SmartScroll.scrollTo({ top })`.
- `scrollToIndex` delegates to `SmartScroll.scrollToElement` (when rendered) or `SmartScroll.scrollTo({ top: heightIndex.offsetForIndex(index) })` (when not).
- **`pinToBottom` is guarded by `isFollowingBottom`.** `SmartScroll.pinToBottom()` is a raw `scrollTop` slam — it does NOT internally check `isFollowingBottom`. The list view's growth-event handlers must check `smartScrollRef.current?.isFollowingBottom` before calling `pinToBottom`; otherwise auto-follow would drag the user back to the bottom even after they scrolled up. Equivalent to: `if (smartScrollRef.current?.isFollowingBottom) smartScrollRef.current.pinToBottom();`. Use `pinToBottom` (not `scrollToBottom`) because `scrollToBottom` flips `_isFollowingBottom = true`, which would re-engage auto-follow against the user's expressed intent.
- Auto-follow-bottom test: simulate scroll-up during streaming, assert no further `pinToBottom` writes; simulate scroll-down to bottom, assert auto-follow re-engages on the next data-source tick.

---

#### [D08] No chain-driven scroll commands in v1 (DECIDED) {#d08-no-chain-scroll}

**Decision:** `TugListView` does not register as a chain responder for scroll-related actions in v1. Browser-native keyboard scroll (PageUp / PageDown / Home / End / ArrowUp / ArrowDown) handles in-list keyboard navigation; `SmartScroll` listens for these to track user scroll intent. Future chain-driven scroll commands (e.g., a "scroll to top" menu item invoking via the chain) are added as they are needed, not speculatively.

**Rationale:**

- Browser-native scroll on a `tabindex="0"` overflow-auto container is correct for v1's needs and free of cost.
- Chain integration adds responder registration, action vocabulary entries, and keybinding map entries — all of which can be added incrementally when a consumer surfaces a real need.
- Punting v1 chain integration keeps the primitive lean and the plan focused.

**Implications:**

- The list view's scroll container has `tabindex="0"` and `overflow-y: auto`.
- The list view does not call `useResponder` / `useOptionalResponder`. Cell renderers may register their own responders if their content owns state — that is the cell's concern, not the list view's.
- Cell renderers see `parentId` from the chain context above the list view, not the list view itself. Per [L11], the list view does not own state that scroll-actions would mutate; `SmartScroll` owns scroll position via the existing `SmartScroll` instance.

---

#### [D09] `TugMarkdownBlock` is a sibling primitive, not a flow mode on `TugMarkdownView` (DECIDED — see [Q07]) {#d09-md-block-sibling}

**Decision:** `TugMarkdownBlock` lands as a separate primitive at `tugdeck/src/components/tugways/tug-markdown-block.tsx`. It shares `TugMarkdownView`'s WASM lex/parse pipeline (DOMPurify sanitization, region map, block list) but renders all blocks in natural document flow — no internal scroll container, no virtualization, no `BlockHeightIndex`, no spacers. `TugMarkdownView` itself is unchanged.

**Rationale:**

- `TugMarkdownView` is large, self-contained, and battle-tested for tugcode log views (long content, heavy virtualization). Adding a `flow="natural"` prop bifurcates the component's behavior in a way that risks regressions in the streaming/virtualized path.
- A separate primitive is smaller, easier to reason about, and signals its purpose at the import site.
- Both primitives can share the WASM lex/parse pipeline through a small extracted helper, so the block parsing is identical between them.
- Future evolution: if `TugMarkdownView` gains its own use cases that need natural flow, we can re-evaluate. For v1, sibling primitives are the cleanest decomposition.

**Implications:**

- `tug-markdown-block.tsx` + `.css` are new files (Step 7 of Phase A).
- `TugMarkdownBlock` exposes `initialText?: string` (static) and `streamingStore?` + `streamingPath?` (dynamic) props. `setRegion` / `removeRegion` are not exposed — the use case (per-cell markdown) doesn't need region-keyed updates.
- `TugMarkdownView` is not modified by this plan.

**Shared helper — `parseMarkdownToSanitizedBlocks`.** Both primitives go through the same WASM lex/parse + DOMPurify sanitize path. Step 7 extracts this into a shared helper:

```ts
// tugdeck/src/lib/markdown/parse-markdown-to-sanitized-blocks.ts (new)
export interface SanitizedMarkdownBlock {
  /** Sanitized HTML for one parser block (paragraph, code-fence, list, etc.). */
  html: string;
  /** Block kind from the lex pass (e.g., "paragraph", "code", "list"). */
  type: string;
}

export function parseMarkdownToSanitizedBlocks(text: string): SanitizedMarkdownBlock[];
```

The helper wraps `tugmark-wasm`'s `lex_blocks()` + `parse_to_html()` + `getDOMPurify().sanitize()` pipeline that lives inside `TugMarkdownView`'s `lexParseAndRender` today. Both primitives consume the helper:

- `TugMarkdownView`: feeds the result into its block-height-index / windowing engine (existing behavior, refactored to call the helper instead of inlining the calls).
- `TugMarkdownBlock`: appends each sanitized HTML block as a `<div class="tugx-md-block">` child, no windowing, no spacers.

This is a refactor inside `TugMarkdownView` plus a fresh consumer in `TugMarkdownBlock`. The refactor is in-scope for Step 7 because the duplication-vs-extraction call has to be made when Step 7 lands; deferring to a follow-on means writing the helper twice. Step 7's checkpoint includes "all existing `TugMarkdownView` tests pass" to gate the refactor.

---

#### [D10] `inflightUserMessage` lives on `CodeSessionSnapshot` (DECIDED) {#d10-inflight-on-snapshot}

**Decision:** Extend `CodeSessionSnapshot` with `inflightUserMessage: { text: string; atoms: ReadonlyArray<AtomSegment> } | null`. Populated in `getSnapshot()` from the reducer's existing `state.pendingUserMessage`. Cleared exactly when `pendingUserMessage` clears (turn commit or interrupt).

**Rationale:**

- The in-flight `user` row's data source must enter React via `useSyncExternalStore` only ([L02]). Card-level local state would diverge from the reducer's truth.
- The reducer already maintains `pendingUserMessage`; this is exposure, not new state.
- The snapshot field name mirrors the reducer field for greppability.

**Implications:**

- `CodeSessionSnapshot` interface gains one field — additive, no consumer breakage.
- `tide.md §T3.4.a` documentation updated.
- Reducer tests exercise the field's lifecycle (`test-01-round-trip.jsonl`, `test-06-interrupt.jsonl`).

---

#### [D11] User row body is plain text in v1 (DECIDED) {#d11-user-body-plaintext}

**Decision:** The `user` cell renderer wraps `userMessage.text` in a `<span className="tide-card-transcript-user-body">` with no markdown / atom interpretation. `TurnEntry.userMessage.attachments` is read but unused. Atom-aware rendering for transcripts is a follow-on once the prompt entry's atom flow reaches transcript form.

**Rationale:**

- `attachments` is `ReadonlyArray<unknown>` today.
- Plain text matches what the user typed (sans atoms expansion), keeping the rendered transcript faithful to the submission.
- The `body` slot accepts any `ReactNode`; switching to atom-aware rendering later is a slot-content change, not a primitive change.

**Implications:**

- v1 user rows render `userMessage.text` verbatim.
- Atom-aware rendering tracked in [#roadmap].

---

#### [D12] L20 token sovereignty — Tide-card customizes via cascade scoping (DECIDED) {#d12-token-sovereignty}

**Decision:** `TugListView`'s CSS references only `--tugx-list-view-*` tokens. The Tide card customizes the list view's appearance for its instance via cascade-scoped overrides:

```css
.tide-card-transcript .tug-list-view {
  --tugx-list-view-padding-block: var(--tug-space-md);
  --tugx-list-view-row-gap: var(--tugx-transcript-row-gap);
}
```

This is per-instance customization via cascade, not global token override. Per [L20], `TugListView`'s appearance remains independently tunable per theme; the Tide card just picks different values for its instance scope.

**Rationale:**

- [L20] forbids component A from "overriding, aliasing, or referencing B's tokens" globally — but per-instance cascade scoping is the standard pattern for tuning a primitive's appearance in a specific consumer.
- The alternative (the consumer defining its own `--tugx-tide-transcript-*` tokens that the primitive reads) requires the primitive to know about the consumer, which inverts the dependency.

**Implications:**

- `TugListView` defines the full `--tugx-list-view-*` token set with sensible defaults in the theme files.
- The Tide card's CSS overrides specific list-view tokens within `.tide-card-transcript` only.
- The token audit (`bun run audit:tokens lint`) accepts both definitions and overrides under the `--tugx-*` prefix.

---

#### [D13] Selection across scroll-out is a known v1 limitation (DECIDED) {#d13-selection-scroll-out}

**Decision:** v1 does not preserve text selection inside a cell across scroll-out + scroll-back. Item-keyed React mount/unmount unmounts the cell's DOM when it leaves the rendered window; any active text selection inside that DOM is gone, and a fresh mount on scroll-back has no selection. Documented as a v1 limitation; the v2 imperative-DOM-pool upgrade resolves it as a side-effect (cell DOM survives scroll-out).

**Rationale:**

- The native browser pattern is "selection persists while DOM persists." Restoring selection after a remount would require capturing the selection range before unmount, encoding it in a card-state-bag axis, and reapplying it on the new mount — significant infrastructure for a v1 use case that isn't yet a documented user complaint.
- The transcript user that wants to copy a long response can scroll until the response fits in the viewport, select, and copy without scrolling further. The need for "select while scrolling far" is not pressing in v1.
- v2 imperative pooling resolves the issue by keeping the cell's DOM alive across scroll-out; native selection persists naturally.

**Implications:**

- v1 transcript users who select inside a code row, scroll up far enough to unmount the cell, then scroll back, will see no selection on return.
- Documented in [#non-goals]; tracked in [#roadmap] as resolved-by-v2.
- `SelectionGuard`'s card-boundary clamp is unaffected — the limitation is about DOM lifecycle, not boundary clamping.

---

### Specification {#specification}

#### Public API {#public-api}

**Data source — what consumers implement:**

```ts
export interface TugListViewDataSource {
  /** Total item count. The list view re-windows whenever this value changes. */
  numberOfItems(): number;
  /**
   * Stable identity for the item at `index`. Used as the React key for the cell wrapper.
   *
   * **Contract — item-stable, not slot-stable.** When the data source mutates (insert,
   * remove, reorder), the same logical item retains the same id at its new index. React's
   * reconciler uses this to match cells across data-source updates so a cell at position
   * 5 that becomes position 7 (because two items were inserted before it) keeps its
   * component instance and its DOM. Returning slot-positional ids (`"row-0"`, `"row-1"`)
   * defeats reconciliation and is incorrect.
   */
  idForIndex(index: number): string;
  /**
   * Cell-renderer kind for the item at `index`. Drives renderer dispatch (and, in a future
   * imperative-pool implementation, reuse-pool routing). Same item may change kind across
   * updates (e.g., `code-streaming` → `code-committed` on `turn_complete`); React reconciler
   * sees this as a prop change if the id is stable, or a remount if the id also changes.
   */
  kindForIndex(index: number): string;
  /** Subscribe to data-source changes. Listener fires on every change that should re-window. Returns unsubscribe. */
  subscribe(listener: () => void): () => void;
  /**
   * Stable version token. The list view's `useSyncExternalStore` uses this to detect updates.
   *
   * **Contract — `Object.is` equality.** React's `useSyncExternalStore` compares snapshots
   * with `Object.is`. Returning `===`-identical values means "no update"; any change in
   * identity means "re-render." Acceptable shapes: a monotonically incrementing version
   * number, an object reference that the data source replaces on each change (e.g., the
   * underlying store's snapshot reference), or a string token whose identity is stable
   * (NOT a string concatenation re-built on each call — `Object.is` is reference-based).
   * The transcript adapter returns `codeSessionStore.getSnapshot()` directly, since that
   * snapshot is identity-stable per `CodeSessionStore`'s contract.
   */
  getVersion(): unknown;
}
```

**Delegate — what consumers optionally implement:**

```ts
export interface TugListViewDelegate {
  /** Estimated height for unmeasured cells of this kind. Default 60. */
  estimatedHeightForKind?(kind: string): number;
  /** Fires when a cell becomes part of the rendered window. */
  willDisplay?(index: number): void;
  /** Fires when a cell leaves the rendered window. */
  didEndDisplaying?(index: number): void;
  /** Fires when the user activates a cell (click). */
  onSelect?(index: number): void;
}
```

**Cell renderer — what consumers register per kind:**

```ts
export interface TugListViewCellProps<DS extends TugListViewDataSource = TugListViewDataSource> {
  index: number;
  id: string;
  kind: string;
  /** The active data source. Cell renderers query it for content. */
  dataSource: DS;
}

export type TugListViewCellRenderer<DS extends TugListViewDataSource = TugListViewDataSource> =
  React.ComponentType<TugListViewCellProps<DS>>;
```

**Imperative handle — what consumers can call via `forwardRef`:**

```ts
export interface TugListViewHandle {
  /**
   * Scroll the row at `index` into view.
   *
   * If the row is already mounted, delegates to SmartScroll.scrollToElement.
   * If not, computes the target offset from the height index and uses
   * SmartScroll.scrollTo to jump first; the row will mount on the next
   * windowing pass.
   */
  scrollToIndex(index: number, options?: {
    block?: ScrollLogicalPosition;
    animated?: boolean;
  }): void;

  /** The DOM element for the rendered row at `index`, or `null` if not rendered. */
  getElementForIndex(index: number): HTMLElement | null;
}
```

**Component — what the consumer mounts:**

```ts
export interface TugListViewProps<DS extends TugListViewDataSource = TugListViewDataSource> {
  dataSource: DS;
  delegate?: TugListViewDelegate;
  /** Map of kind → cell renderer component. */
  cellRenderers: Record<string, TugListViewCellRenderer<DS>>;
  /**
   * Scroll-region key for the [A9] state-preservation protocol ([L23]). Written to
   * `data-tug-scroll-key` on the scroll container so cold-boot / cross-pane move
   * restores scroll position into `bag.regionScroll[scrollKey]`. Must be unique within
   * the enclosing card subtree; cards mounting two `TugListView` instances pass
   * distinct keys (e.g., `"tide-card-transcript"` vs `"tide-card-history"`).
   *
   * @default "tug-list-view"
   */
  scrollKey?: string;
  /** Forwarded class name for cascade-scoped customization. */
  className?: string;
}

export const TugListView: <DS extends TugListViewDataSource>(
  props: TugListViewProps<DS> & { ref?: React.Ref<TugListViewHandle> }
) => React.ReactElement;
```

#### TugMarkdownBlock public API {#md-block-api}

```ts
export interface TugMarkdownBlockProps {
  /** Static initial text. Set once on mount; subsequent prop changes have no effect. */
  initialText?: string;
  /** PropertyStore for streaming text. When set, component enters streaming mode. */
  streamingStore?: PropertyStore;
  /** PropertyStore path key for the streaming text value. Default: "text". */
  streamingPath?: string;
  /** Forwarded class name. */
  className?: string;
}

export const TugMarkdownBlock: React.FC<TugMarkdownBlockProps>;
```

Either `initialText` xor `streamingStore` is set, not both. The component renders all blocks in natural document flow, no internal scroll container, no virtualization.

**Mount-render contract — both modes paint synchronously before first paint:**

- **`initialText` mode.** Lex / parse / sanitize / DOM-write happen inside `useLayoutEffect` on mount, before the browser paints the freshly-mounted DOM. There is no intermediate empty render. This matters for the in-flight → committed transition (Step 11): when the streaming cell unmounts and the committed cell mounts in the same React commit, the committed cell's `initialText` content must be visible on the same paint, not the next one. Test ([Step 11](#step-11)) explicitly asserts no empty `code-committed` cell appears at the transition boundary.

- **`streamingStore` mode.** On mount, the component reads `streamingStore.get(streamingPath)` synchronously and renders that current value before paint — `PropertyStore.observe` does NOT fire on subscribe, only on subsequent `set` calls, so a cell that mounts while content already exists in the store would otherwise render empty until the next delta arrives. This case occurs every time a streaming cell scrolls out of the rendered window and back in: the new mount has to display the cumulative text the store already holds, not wait. Test ([Step 7](#step-7)) explicitly asserts a streaming cell mounts non-empty when the store already has content.

Both behaviors mirror `TugMarkdownView`'s pattern; `TugMarkdownBlock` inherits them deliberately rather than by accident.

#### CodeSessionSnapshot extension {#snapshot-extension}

```ts
export interface CodeSessionSnapshot {
  // ... existing fields ...
  /**
   * The in-flight user message — set the moment `send()` is dispatched and
   * cleared exactly when the matching `TurnEntry` is committed to `transcript`
   * or the turn is interrupted. Drives the in-flight `user` `TugTranscriptEntry`
   * row in the Tide card transcript.
   */
  inflightUserMessage: {
    text: string;
    atoms: ReadonlyArray<AtomSegment>;
  } | null;
}
```

#### DOM shape — TugListView {#dom-shape}

```html
<div
  data-slot="tug-list-view"
  data-tug-scroll-key="<scrollKey>"
  class="tug-list-view"
  tabindex="0"
>
  <div class="tug-list-view-spacer tug-list-view-spacer--top"></div>
  <div class="tug-list-view-window">
    <!-- one wrapper per rendered cell, key = dataSource.idForIndex(i) -->
    <div class="tug-list-view-cell" data-tug-list-cell-index="<i>" data-tug-list-cell-kind="<kind>">
      {cellRenderers[kind]({ index, id, kind, dataSource })}
    </div>
    <!-- ... more cells ... -->
  </div>
  <div class="tug-list-view-spacer tug-list-view-spacer--bottom"></div>
</div>
```

The scroll container has `tabindex="0"` to receive keyboard focus for native arrow / page key scroll. The `data-tug-scroll-key` value is read from the `scrollKey` prop (defaults to `"tug-list-view"`); it opts the inner scroll into the [A9] state-preservation protocol per [L23]. Consumers that mount more than one `TugListView` inside the same card supply distinct values to avoid the per-card-subtree key uniqueness violation. Spacer heights are written directly to the DOM via `style.height` ([L06], same pattern as `TugMarkdownView`).

#### Tokens {#tokens}

New `--tugx-list-view-*` token set in `brio.css` and `harmony.css`:

| Token | Purpose | Initial value |
|-|-|-|
| `--tugx-list-view-padding-block` | Top/bottom padding inside the scroll container | `var(--tug-space-md)` |
| `--tugx-list-view-padding-inline` | Left/right padding inside the scroll container | `var(--tug-space-md)` |
| `--tugx-list-view-row-gap` | Gap between adjacent rendered cells | `var(--tug-space-sm)` |
| `--tugx-list-view-scroll-padding-end` | Bottom scroll padding so the last cell doesn't sit flush against the container's edge | `var(--tug-space-lg)` |

`TugMarkdownBlock` reuses `--tugx-md-*` tokens (typography, code blocks, etc.) — no new tokens needed.

The Tide card's transcript scope adds cascade-scoped overrides only:

```css
.tide-card-transcript .tug-list-view {
  --tugx-list-view-row-gap: var(--tugx-transcript-row-gap);
  --tugx-list-view-padding-block: var(--tug-space-md);
  --tugx-list-view-padding-inline: var(--tug-space-md);
  --tugx-list-view-scroll-padding-end: var(--tug-space-xl);
}
```

#### Render shape — Tide card transcript {#render-shape}

```tsx
function TideTranscriptHost({ codeSessionStore, sessionMetadataStore }: Props) {
  const dataSource = useTideTranscriptDataSource(codeSessionStore);
  const modelName = useSessionModelName(sessionMetadataStore);

  const cellRenderers: Record<string, TugListViewCellRenderer<TideTranscriptDataSource>> =
    React.useMemo(() => ({
      "user":            (p) => <UserRowCell {...p} />,
      "code-committed":  (p) => <CodeCommittedRowCell {...p} modelName={modelName} />,
      "code-streaming":  (p) => <CodeStreamingRowCell {...p} modelName={modelName}
                                  streamingStore={codeSessionStore.streamingDocument} />,
    }), [modelName, codeSessionStore]);

  const delegate = React.useMemo(() => ({
    estimatedHeightForKind: (kind: string) =>
      kind === "user" ? 56 : 120,
  }), []);

  return (
    <div className="tide-card-transcript">
      <TugListView
        dataSource={dataSource}
        delegate={delegate}
        cellRenderers={cellRenderers}
      />
    </div>
  );
}
```

(Component names sketched; final names and prop shapes locked in Step 11.)

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|-|-|
| `tugdeck/src/components/tugways/tug-list-view.tsx` | Primitive TSX |
| `tugdeck/src/components/tugways/tug-list-view.css` | Primitive styles |
| `tugdeck/src/components/tugways/__tests__/tug-list-view.test.tsx` | Primitive unit tests |
| `tugdeck/src/components/tugways/internal/list-view-height-index.ts` | Height-index data structure (internal) |
| `tugdeck/src/components/tugways/internal/list-view-window.ts` | Windowing math (internal) |
| `tugdeck/src/components/tugways/internal/__tests__/list-view-height-index.test.ts` | Height index unit tests |
| `tugdeck/src/components/tugways/tug-markdown-block.tsx` | Companion primitive TSX |
| `tugdeck/src/components/tugways/tug-markdown-block.css` | Companion primitive styles |
| `tugdeck/src/components/tugways/__tests__/tug-markdown-block.test.tsx` | Companion primitive tests |
| `tugdeck/src/components/tugways/cards/gallery-list-view.tsx` | Gallery card |
| `tugdeck/src/lib/tide-transcript-data-source.ts` | Adapter for `CodeSessionStore` → `TugListViewDataSource` |
| `tugdeck/src/lib/__tests__/tide-transcript-data-source.test.ts` | Adapter unit tests |

#### Modified files {#modified-files}

| File | Change |
|-|-|
| `tugdeck/styles/themes/brio.css` | Add `--tugx-list-view-*` tokens |
| `tugdeck/styles/themes/harmony.css` | Mirror |
| `tugdeck/src/components/tugways/cards/gallery-registrations.tsx` | Register `gallery-list-view` |
| `tugdeck/src/lib/code-session-store/types.ts` | Add `inflightUserMessage` to `CodeSessionSnapshot` |
| `tugdeck/src/lib/code-session-store.ts` | Populate `inflightUserMessage` in `getSnapshot()` |
| `tugdeck/src/components/tugways/cards/tide-card.tsx` | Replace single-region wire-up with `TugListView` mount |
| `tugdeck/src/components/tugways/cards/tide-card.css` | `.tide-card-transcript` block; cascade-scoped list-view token overrides |
| `tugdeck/src/components/tugways/cards/__tests__/tide-card.test.tsx` | Multi-turn rendering coverage |
| `dash/tide.md` | Mention `TugListView` and `inflightUserMessage` in §T3.4.a |
| `dash/tugplan-tide-card-polish.md` | Flip §step-11 row to "shipped" with Cmd+J deferral note |
| `dash/tugplan-tide-transcript-rendering.md` | Mark superseded by this plan |

#### Symbols {#symbols}

| Symbol | Kind | Location | Notes |
|-|-|-|-|
| `TugListViewDataSource` | interface | `tug-list-view.tsx` | Public |
| `TugListViewDelegate` | interface | `tug-list-view.tsx` | Public |
| `TugListViewCellProps` | interface | `tug-list-view.tsx` | Public |
| `TugListViewCellRenderer` | type alias | `tug-list-view.tsx` | Public |
| `TugListViewHandle` | interface | `tug-list-view.tsx` | Public |
| `TugListViewProps` | interface | `tug-list-view.tsx` | Public |
| `TugListView` | component (`forwardRef`) | `tug-list-view.tsx` | Public |
| `HeightIndex` | class | `internal/list-view-height-index.ts` | Internal |
| `RenderedWindow` | class | `internal/list-view-window.ts` | Internal |
| `TugMarkdownBlockProps` | interface | `tug-markdown-block.tsx` | Public |
| `TugMarkdownBlock` | component | `tug-markdown-block.tsx` | Public |
| `TideTranscriptDataSource` | class | `tide-transcript-data-source.ts` | Public to tide-card |
| `useTideTranscriptDataSource` | hook | `tide-transcript-data-source.ts` | Public to tide-card |
| `inflightUserMessage` | field on `CodeSessionSnapshot` | `code-session-store/types.ts` | New |
| `GalleryListView` | component | `gallery-list-view.tsx` | Gallery |

---

### Documentation Plan {#documentation-plan}

- [x] Module docstring on `tug-list-view.tsx` per the component-authoring guide. Opening line: "TugListView — windowed list primitive modeled on UIKit's UITableView." Cite [L02], [L03], [L06], [L11], [L19], [L20], [L22], [L23] in the laws block.
- [x] Module docstring on `tug-markdown-block.tsx` clarifying its role: per-cell markdown rendering, no internal scroll, shares the WASM pipeline with `TugMarkdownView`.
- [x] Module docstring on `gallery-list-view.tsx` stating that data is mock; live wire is the transcript.
- [x] Module docstring on `tide-transcript-data-source.ts` explaining the adapter shape and the (user-row, code-row) pair mapping.
- [x] Module docstring update on `code-session-store/types.ts` mentioning `inflightUserMessage` and its lifecycle.
- [x] `dash/tide.md §T3.4.a` snapshot shape gets the new field; §T3.4.c gets the `TideTranscriptHost` mention via the substitutions table.
- [x] `tugplan-tide-card-polish.md §step-11` row flips to "shipped" with the Cmd+J deferral noted.
- [x] `tugplan-tide-transcript-rendering.md` marked as superseded with a forward link.

---

### Test Plan Concepts {#test-plan-concepts}

| Category | Purpose | When |
|-|-|-|
| Unit (height index) | `HeightIndex` data structure: insert, update, sum, offset-for-index, index-for-offset, edge cases (empty, all-measured, all-unmeasured) | [Step 4](#step-4) |
| Unit (windowing math) | `RenderedWindow`: given viewport, height index, overscan → which indices render | [Step 4](#step-4) |
| Unit (markdown helper) | `parseMarkdownToSanitizedBlocks` returns sanitized HTML blocks for valid input; empty array for empty input | [Step 7](#step-7) |
| Component (skeleton) | Synthetic data source, fixed heights, single kind: cells render in correct order, spacers correct | [Step 3](#step-3) |
| Component (skeleton edge) | Empty data source, single-item, out-of-range scrollToIndex, mid-window data shrink | [Step 3](#step-3) |
| Component (variable heights) | Mixed kinds, simulated ResizeObserver fires via capturing variant, height index updates, spacers reflow | [Step 4](#step-4) |
| Component (reuse contract) | Two kinds, two renderers — each kind dispatches to the right renderer | [Step 5](#step-5) |
| Component (lifecycle) | `willDisplay` fires on enter, `didEndDisplaying` on exit, `onSelect` on click | [Step 5](#step-5) |
| Component (SmartScroll) | Auto-pin on data-source ticks; `pinToBottom` guarded by `isFollowingBottom`; user scroll-up disengages; idle re-engagement; two-pass `scrollToIndex` precision | [Step 6](#step-6) |
| Component (SmartScroll edge) | `scrollToIndex` clamps to first/last for out-of-range; no-op for `NaN` and empty data source | [Step 6](#step-6) |
| Component (TugMarkdownBlock initial) | Static `initialText` renders all blocks in natural flow synchronously on mount (G2) | [Step 7](#step-7) |
| Component (TugMarkdownBlock streaming) | Streaming-bound block: mount with pre-populated store renders non-empty (G1); subsequent store updates → DOM updates without React rerender | [Step 7](#step-7) |
| Refactor regression (TugMarkdownView) | All existing TugMarkdownView tests pass after the helper extraction | [Step 7](#step-7) |
| Visual (gallery) | All features showcased in `gallery-list-view`; manual review | [Step 8](#step-8) |
| Reducer (snapshot extension) | `inflightUserMessage` lifecycle across send / turn_complete(success) / interrupt | [Step 9](#step-9) |
| Adapter | `TideTranscriptDataSource` reads `CodeSessionStore` snapshots, maps committed turns + in-flight to (user, code) row pairs with correct kinds; id-stability protocol verified | [Step 10](#step-10) |
| Integration (multi-turn) | Render Tide card with multi-turn fixture, assert row pairs and order | [Step 11](#step-11) |
| Integration (immediate user row) | Submit `> hi`, assert user row in DOM before any assistant delta | [Step 11](#step-11) |
| Integration (streaming-to-commit) | Drive deltas, assert streaming code row body updates; on commit, assert committed pair holds final text without empty intermediate render | [Step 11](#step-11) |
| Integration (no sticky last) | After turn_complete, assert no element bound to `streamingPath` survives | [Step 11](#step-11) |
| Integration (persistence axis) | Assert scroll container has `data-tug-scroll-key="tide-card-transcript"` for [L23] correctness | [Step 11](#step-11) |
| Tuglaws walkthrough | Per-step compliance | [Step 12](#step-12) |

happy-dom is suitable for all unit, component, reducer, adapter, and integration tests in this plan. happy-dom does NOT provide `ResizeObserver` natively (tugdeck stubs a no-op global in `setup-rtl.ts`); component tests that need to drive `ResizeObserver` callbacks install a capturing variant per the existing `tug-text-editor-completion-overlay.test.tsx` precedent — the pattern is well-established in tugdeck. Live `ResizeObserver` integration is verified by the gallery card (manual; [Step 8](#step-8)) and the live transcript smoke (manual; [Step 11](#step-11)). No real-DOM test harness is introduced in this plan.

---

### Tuglaws Cross-Check {#tuglaws-cross-check}

- **L01** — One `root.render()`. The list view does not call `render`; it composes via React. ✓
- **L02** — External state via `useSyncExternalStore` only. The list view subscribes to the data source via `useSyncExternalStore(dataSource.subscribe, dataSource.getVersion)`. The transcript adapter exposes the same shape over `CodeSessionStore`. ✓
- **L03** — `useLayoutEffect` for registrations events depend on. `SmartScroll` instantiation, `ResizeObserver` setup, scroll-container ref attachment all run in `useLayoutEffect`. ✓
- **L04** — Never measure child DOM inline after triggering child setState. Heights are collected via `ResizeObserver` callbacks, not via synchronous post-render measurement. ✓
- **L05** — Never use RAF for state-commit-dependent ops. RAF is used only for coalescing high-frequency `ResizeObserver` callbacks; not for waiting on React commits. ✓
- **L06** — Appearance via CSS / DOM. Spacer heights and scroll-position writes go to the DOM directly, not through React state. The rendered window itself is React state (which cells are mounted) — that is structural, not appearance. ✓
- **L07** — Action handlers via refs. The list view registers no chain handlers in v1 ([D08]); cell renderers that register handlers follow [L07] in their own implementations. ✓
- **L11** — Controls emit, responders own state. **v1 deferred scope.** No chain action exists today that would mutate state owned by `TugListView` (no `SCROLL_TO_TOP`, no `SCROLL_TO_BOTTOM` in the action vocabulary), so [L11] is satisfied vacuously — there is no action to register a handler for. This is *deferred* not *exempt*: if a future plan introduces scroll-control actions in the chain, `TugListView` becomes the responder for them and registers via `useResponder`. v1 punts because browser-native keyboard scroll on a `tabindex="0"` overflow-auto container handles in-list keyboard navigation correctly without chain involvement; `SmartScroll`'s existing keyboard listeners track user scroll intent for follow-bottom semantics. Cell renderers may be controls or responders depending on their content. ✓ ([D08])
- **L19** — Component authoring guide. File pair (`tug-list-view.tsx` + `.css`); module docstring; props interfaces (exported); `data-slot="tug-list-view"`; `@tug-pairings: none — layout primitive, no foreground-on-background contrast` since the list view is a structural surface that doesn't paint contrast pairings itself. ✓
- **L20** — Token sovereignty. List view CSS references only `--tugx-list-view-*` tokens; consumers customize via cascade scoping ([D12]). The Tide card's CSS overrides list-view tokens within `.tide-card-transcript` only — local to the instance. ✓
- **L22** — Store observers may write DOM. `TugMarkdownBlock`'s streaming binding uses the same direct-observer pattern as `TugMarkdownView` (store change → DOM write). `ResizeObserver`-driven height-index updates write spacer heights directly to the DOM. ✓
- **L23** — User-visible state preserved across DOM-down transitions. **Scroll position** is preserved via the consumer-supplied `scrollKey` on `data-tug-scroll-key` — opts the surface into the [A9] state-preservation protocol's `bag.regionScroll`. **Cell-internal preservable state** (form values, focus, selection, expand/collapse, etc.) is the *cell renderer's* responsibility, not the list view's: cells whose state must survive cold-boot / cross-pane move opt in via `useComponentStatePreservation` (with appropriate keys) or via `data-tug-state-key` / `data-tug-focus-key` markers per the protocol. The list view does not pre-empt these axes — it just provides a stable scroll surface and lets cells own their own preservation. **Known v1 limitation per [D13]:** native text selection inside a cell does not survive scroll-out + scroll-back (item-keyed mount/unmount tears down cell DOM). This is a v1 gap, not an [L23] violation — the user's selection is data they put there, but its non-preservation across an in-session scroll-out is a design choice with a documented v2 resolution. Tracked in [#non-goals] and [#roadmap]. ✓
- **L24** — State zones. Appearance zone: spacer heights, `tabindex` writes via DOM. Local-data zone: minimal — height index is a ref, not React state. Structure zone: which cells are in the rendered window (React state, derived from data source + height index). Each axis stays in its zone. ✓

---

### Execution Steps {#execution-steps}

> Each step is its own commit. `bun x tsc --noEmit`, `bun test`, `bun run audit:tokens lint`, and `cargo nextest run` pass at the end of every step.

#### Step 1: Token tier — `--tugx-list-view-*` {#step-1}

**Commit:** `tug-list-view: add --tugx-list-view-* tokens`

**References:** [D12] token-sovereignty, [#tokens], (#scope, #constraints)

**Artifacts:**

- Updated `tugdeck/styles/themes/brio.css` with the four `--tugx-list-view-*` tokens under a `/* TugListView */` comment block.
- Mirrored `tugdeck/styles/themes/harmony.css` with structurally-identical token names; values reference the same `--tug-space-*` base tokens so per-theme differences fall out automatically.

**Tasks:**

- [x] Add the four tokens to `brio.css` per [#tokens].
- [x] Mirror in `harmony.css`.
- [x] Run `bun run audit:tokens lint`; resolve any seven-slot naming complaints (none expected — `--tugx-` extension prefix is exempt from seven-slot enforcement).

**Tests:**

- [x] `bun run audit:tokens lint` exits 0.

**Checkpoint:**

- [x] `bun run audit:tokens lint` — zero violations.
- [x] `bun x tsc --noEmit` — exit 0.

---

#### Step 2: Public API types — `TugListViewDataSource`, `TugListViewDelegate`, `TugListViewCellProps`, `TugListViewCellRenderer`, `TugListViewHandle`, `TugListViewProps` {#step-2}

**Depends on:** #step-1

**Commit:** `tug-list-view: define DataSource + Delegate + Cell + Handle types`

**References:** [D01] uitableview-lineage, [D02] single-section, [D03] imperative-api, [D04] cell-reuse, [#public-api]

**Artifacts:**

- New `tug-list-view.tsx` file containing **only** the type definitions and re-exports — no component implementation yet. Module docstring opens with the lineage paragraph (UIKit `UITableView`).
- The Cell-renderer type and CellProps interface are exported so consumers can write renderer functions before Step 3's primitive lands.

**Tasks:**

- [x] Author the file with: module docstring (cites [L02], [L03], [L06], [L11], [L19], [L20], [L22], [L23]); type definitions per [#public-api]; placeholder export `export const TugListView` with a `// Implementation lands in Step 3` marker that compiles to a no-op stub returning null.
- [x] Stub component is `forwardRef<TugListViewHandle, TugListViewProps>` with an empty handle — full implementation in [Step 3](#step-3).

**Tests:**

- [x] Type-only test (in the inline test file): the placeholder component accepts the right prop types; a synthetic data source satisfies the `TugListViewDataSource` contract; `cellRenderers` accepts a `Record<string, TugListViewCellRenderer>`.

**Checkpoint:**

- [x] `bun x tsc --noEmit` — exit 0.
- [x] `bun test` — all green (existing tests undisturbed; new type test passes).

---

#### Step 3: TugListView skeleton — fixed-height single-kind windowing {#step-3}

**Depends on:** #step-2

**Commit:** `tug-list-view: skeleton with fixed-height windowing`

**References:** [D02] single-section, [D03] imperative-api, [D04] cell-reuse, [#dom-shape], [#tuglaws-cross-check]

**Artifacts:**

- `tug-list-view.tsx` gains the component implementation, but with fixed heights only (uses `delegate.estimatedHeightForKind` for every cell; ignores measured heights). Single-kind support is sufficient — multi-kind dispatch lands here too because the cellRenderers map is consulted for every render.
- `tug-list-view.css` with `@tug-pairings: none — layout primitive`, base styles, scroll container styles, spacer styles, cell wrapper styles. References `--tugx-list-view-*` tokens only ([L20]).
- Internal helpers: `list-view-window.ts` for the windowing math (given viewport, total height, overscan, height-index → which indices render).
- Unit tests: synthetic data source with N items, fixed estimated heights, assert correct cells render in the window, spacer heights are correct, dispatch routes through `cellRenderers[kind]`.

**Tasks:**

- [x] Implement `TugListView` per the [#dom-shape]: scroll container with `tabindex="0"` and `data-tug-scroll-key={scrollKey ?? "tug-list-view"}`; top spacer; window div hosting rendered cells; bottom spacer.
- [x] Subscribe to data source via `useSyncExternalStore(dataSource.subscribe, dataSource.getVersion)`.
- [x] Implement `RenderedWindow` math: given scroll container's `clientHeight`, current `scrollTop`, total height (sum of estimated heights), overscan rows → first/last rendered index. Spacer heights = total height of preceding/following unrendered cells.
- [x] React keys: `dataSource.idForIndex(i)` per cell. Render through `cellRenderers[dataSource.kindForIndex(i)]`.
- [x] Imperative handle skeleton: `scrollToIndex` writes `scrollTop` directly (no SmartScroll yet — that's Step 6); `getElementForIndex` reads from a ref map.
- [x] Author CSS file per the component-authoring guide: `@tug-pairings: none`; base block styles; spacer styles; cell-wrapper styles. All token references are `--tugx-list-view-*`.
- [x] Write unit tests: synthetic data source with N=20 items, kind="row", fixed height 40px each. Assert: rendering N rows at scrollTop=0 with viewport=100 renders ~3 cells + overscan; spacer heights sum to remaining unrendered.

**Tests:**

- [x] Window math: `RenderedWindow` returns expected first/last indices for various viewport/scroll combinations.
- [x] Cell dispatch: `kindForIndex` routing works; calling the right renderer per kind.
- [x] Spacer math: spacer heights account for unrendered cells.
- [x] Edge — empty data source: `numberOfItems = 0` renders no cells, both spacers at zero height, no errors.
- [x] Edge — single-item data source: `numberOfItems = 1` renders the single cell, both spacers at zero height, no overscan into negative indices.
- [x] Edge — `getElementForIndex(out_of_range)`: returns `null` for `-1` and for `numberOfItems`, no throw.
- [x] Edge — `scrollToIndex(out_of_range)`: clamps to first / last item per [D03], no throw.
- [x] Edge — data-source shrink during scroll: synthetic data source removes items from the currently-rendered window; assert re-window completes without throwing and without rendering ghost cells from the removed range.

**Checkpoint:**

- [x] `bun x tsc --noEmit` — exit 0.
- [x] `bun test src/components/tugways/__tests__/tug-list-view.test.tsx` — all green.
- [x] `bun run audit:tokens lint` — zero violations.

---

#### Step 4: Variable heights via ResizeObserver + sparse height index {#step-4}

**Depends on:** #step-3

**Commit:** `tug-list-view: variable heights via ResizeObserver`

**References:** [D05] height-index, [R01] height-thrash, [#test-plan-concepts]

**Artifacts:**

- New `internal/list-view-height-index.ts`: `HeightIndex` class (sparse `Map<index, number>`), API: `set(index, height)`, `get(index)` → `number | undefined`, `totalHeight(itemCount, estimatedHeightForIndex)`, `offsetForIndex(index, estimatedHeightForIndex)`, `indexForOffset(offset, itemCount, estimatedHeightForIndex)` (binary search-friendly).
- `tug-list-view.tsx` gains: `ResizeObserver` instance attached to each rendered cell; observer callback updates `HeightIndex`; height-index updates trigger re-windowing only when total height changes by more than a threshold (avoids per-pixel re-window).
- `RenderedWindow` math now consumes the `HeightIndex` plus `estimatedHeightForKind` to compute precise offsets.
- Unit tests for `HeightIndex` (the data structure) plus integration tests for the list-view component using ResizeObserver simulation.

**Test environment note — `ResizeObserver` in happy-dom.** happy-dom does not natively provide `ResizeObserver`. tugdeck's `setup-rtl.ts` installs a no-op stub at the global level (its `observe` / `unobserve` / `disconnect` methods do nothing and never fire callbacks). Tests that need to drive `ResizeObserver`-fed code paths install a **capturing variant** at the start of the test, exposing a manual `fire(entries)` method to invoke the captured callback synchronously — the same pattern used in `tug-text-editor-completion-overlay.test.tsx` (`CapturingResizeObserver`). Step 4's tests adopt this pattern. The gallery card (Step 8) and the manual smoke against the live transcript (Step 11) cover the live `ResizeObserver` integration that happy-dom can't simulate. We do NOT introduce a real-DOM test harness in this plan; the layered coverage (capturing-variant unit tests + gallery manual review + live transcript manual smoke) is enough.

**Tasks:**

- [x] Implement `HeightIndex` class with the listed API. Use binary search for `indexForOffset` (skipping unmeasured cells using `estimatedHeightForIndex`). *(v1 ships a linear walk with estimate fallback; the API shape is binary-search-friendly so a future implementation can swap in prefix sums without consumer changes — documented in the source.)*
- [x] Wire `ResizeObserver` in `useLayoutEffect`: one observer per list-view instance; observe each rendered cell; `entries.forEach` maps `entry.target` → cell index → `heightIndex.set`.
- [x] Coalesce ResizeObserver callbacks via `requestAnimationFrame`: queue index updates; flush in one rAF callback ([L05] does NOT prohibit RAF for callback coalescing — only for state-commit-dependent ops).
- [x] Re-windowing trigger: post-rAF, recompute total height; if total has changed enough to shift the window's first/last index, force a rerender.
- [x] Author tests using a capturing `ResizeObserver` variant per the test-environment note above. The variant captures the constructor's callback into a test-scoped reference; tests call `captured.fire([{ target, contentRect }])` to simulate browser-driven resize events.
- [x] Update component tests: synthetic data source with mixed kinds (kindA estimated 40, kindB estimated 100). After a `fire` simulation, assert the height index reflects the new height and the spacer reflows.

**Tests:**

- [x] `HeightIndex` unit tests: insert, update, total-height, offset-for-index, index-for-offset.
- [x] `HeightIndex` edge — empty index: `totalHeight(0, ...)` returns 0; `offsetForIndex(0, ...)` returns 0.
- [x] `HeightIndex` edge — all measured: total = sum of measured; offset for last index = total minus last item's height.
- [x] `HeightIndex` edge — all unmeasured: total = `itemCount * defaultEstimate`; offsets are linear.
- [x] List-view: variable kinds render correctly with estimated heights initially; after simulated `ResizeObserver` `fire`, measured heights replace estimates and the spacer reflows.
- [x] List-view: rapid sequential `fire` calls coalesce — assert one rerender per rAF flush, not one per `fire`.
- [x] List-view: cell unmount during `ResizeObserver` callback — fire `entries` for a cell that has already left the rendered window; assert the height index update lands without errors and without re-creating a removed cell's height.

**Checkpoint:**

- [x] `bun x tsc --noEmit` — exit 0.
- [x] `bun test` — all green.
- [x] `bun run audit:tokens lint` — zero violations.

---

#### Step 5: Cell reuse contract + delegate lifecycle (`willDisplay`, `didEndDisplaying`, `onSelect`) {#step-5}

**Depends on:** #step-4

**Commit:** `tug-list-view: lifecycle delegate (willDisplay, didEndDisplaying, onSelect)`

**References:** [D04] cell-reuse, [Q06] selection-model, [#public-api]

**Artifacts:**

- `tug-list-view.tsx`: track the previous rendered window's index set; on each window update, fire `delegate.willDisplay(i)` for indices that just entered the rendered set, `delegate.didEndDisplaying(i)` for indices that just left.
- Click handling: cell wrapper attaches `onClick` that fires `delegate.onSelect(index)`.
- Tests assert lifecycle callbacks fire in the right order.

**Tasks:**

- [x] Track `prevRenderedIndices: Set<number>` in a ref.
- [x] On each rerender after windowing, compute `entered = currentSet \ prevSet` and `left = prevSet \ currentSet`; fire delegate callbacks for each.
- [x] Use `useLayoutEffect` so callbacks fire synchronously after commit, before paint ([L03]).
- [x] Click handling on cell wrapper: `onClick={() => delegate?.onSelect?.(index)}`.
- [x] Tests: synthetic delegate with mock fns, drive scroll, assert correct callback sequences. Click test: fire onClick, assert `onSelect` called with right index.

**Tests:**

- [x] `willDisplay` fires for each entering index.
- [x] `didEndDisplaying` fires for each leaving index.
- [x] `onSelect` fires on click with the right index.
- [x] Order: `willDisplay` before `didEndDisplaying` for the same render frame? Document the order chosen and pin in tests. **Decision: `willDisplay` first, then `didEndDisplaying`, both in numeric-ascending index order.** Rationale: matches UIKit's effective order during a scroll/reuse pass — new cells are dequeued and configured (`willDisplay`) before old cells are signalled gone (`didEndDisplaying`); pinned by the test "willDisplay fires before didEndDisplaying when both happen on the same commit".

**Checkpoint:**

- [x] `bun x tsc --noEmit` — exit 0.
- [x] `bun test` — all green. (2859 pass / 0 fail.)
- [x] `bun run audit:tokens lint` — zero violations.

---

#### Step 6: SmartScroll integration — auto-follow-bottom + `scrollToIndex` {#step-6}

**Depends on:** #step-5

**Commit:** `tug-list-view: SmartScroll auto-follow-bottom`

**References:** [D07] smart-scroll, [#imperative-api], [Q04] auto-follow-cadence (decided at parent-plan level)

**Artifacts:**

- `tug-list-view.tsx`: instantiate a `SmartScroll` against the scroll container in `useLayoutEffect`. Hook `pinToBottom()` to: (a) data-source ticks that grow `numberOfItems()`; (b) height-index updates while the last item is in the rendered window. Both call sites guard on `smartScroll.isFollowingBottom` per [D07] before invoking `pinToBottom`.
- `scrollToIndex` upgrades: implements the two-pass precision protocol per [D03] — delegates to `SmartScroll.scrollToElement` when the row is rendered; otherwise computes an estimated offset, jumps via `SmartScroll.scrollTo`, lets the row mount, and on the next `ResizeObserver` flush re-checks the offset and corrects if it's drifted by more than ~4px.
- Tests for follow-bottom semantics, scroll-to-index for rendered + unrendered targets, two-pass correction, and out-of-range clamping.

**Tasks:**

- [x] Add the SmartScroll instantiation in a `useLayoutEffect`; dispose on unmount.
- [x] Hook `pinToBottom()` invocation: in the data-source-tick effect, after rerender, if `numberOfItems()` grew and `smartScroll.isFollowingBottom`, call `pinToBottom()`. In the ResizeObserver coalesce callback, if the last item is in the rendered window and `smartScroll.isFollowingBottom`, call `pinToBottom()`. Both checks read `isFollowingBottom` at the moment of the call (not from a closed-over snapshot) per [L07]. **Implementation:** unified into one no-deps post-commit `useLayoutEffect` whose gate is `isFollowingBottom && !isUserScrolling && itemCount > 0 && (grew || lastVisible)`. Read live from `smartScrollRef.current` per [L07]; `isUserScrolling` separates intent from action so a user mid-gesture isn't yanked.
- [x] Implement the two-pass `scrollToIndex` precision protocol per [D03]: estimated jump → row mounts → measurement correction on next `ResizeObserver` flush. Threshold for correction: 4px. **Implementation:** pass 1 lives in the imperative handle; pass 2 in a no-deps post-commit `useLayoutEffect` that reads `pendingScrollCorrectionRef`, gates on `heightIndex.has(target)`, recomputes the offset, and corrects when drift > `SCROLL_CORRECTION_THRESHOLD_PX` (4).
- [x] Out-of-range clamping: `scrollToIndex(-1)` clamps to first item; `scrollToIndex(numberOfItems)` clamps to last; `scrollToIndex(NaN)` is a no-op.
- [x] Auto-follow tests: simulate scroll-up disengages auto-follow (assert no further pinToBottom on next data-source tick); simulate scroll-back-to-bottom re-engages (assert next tick pins).

**Design addition:** the `followBottom?: boolean` prop (default `false`) is the consumer's opt-in for streaming/transcript-shaped lists. Default `false` matches `UITableView`'s natural "start at top" behavior; the transcript will pass `followBottom={true}`. Plan-level reference for the addition: [D07] gates on `isFollowingBottom`, which has to be set somewhere — exposing the initial value as a prop is the cleanest authority transfer to the consumer.

**Tests:**

- [x] Auto-follow on append: data source grows, scroll position pins to bottom. (Asserted via `pinToBottom` spy count growth.)
- [x] User scroll-up disengages: scroll up; data source grows; scroll position does not advance. (Asserted via `pinToBottom` spy count unchanged.)
- [x] Idle re-engagement: scroll back to bottom manually; next append pins again. **Decision:** SmartScroll's idle re-engagement is unit-tested in `__tests__/smart-scroll.test.ts`; this plan does not duplicate that coverage. The list-view-side coverage that *its* growth-pin uses live `isFollowingBottom` is asserted by the disengage test (which exercises the gate).
- [x] `pinToBottom` is guarded by `isFollowingBottom`: covered by "followBottom=false: data-source append does NOT pin" and "scroll-up disengages auto-follow: subsequent growth does not pin" (both spy on `SmartScroll.prototype.pinToBottom`).
- [x] `scrollToIndex(rendered_index)`: routes through `SmartScroll.scrollToElement` (no `scrollTo` write — exact-rect path).
- [x] `scrollToIndex(unrendered_index)` two-pass: pass 1 jumps to estimated offset; pass 2 recomputes against measurements after `ResizeObserver` flush and issues a corrective `scrollTo`.
- [x] `scrollToIndex` no-correction case: when estimated offset matches measured to within threshold, only one scroll write happens.
- [x] Edge — `scrollToIndex(-1)`: clamps to 0; `scrollToIndex(numberOfItems)`: clamps to last; `scrollToIndex(NaN)`: no-op (no scroll write).
- [x] Edge — empty data source `scrollToIndex(0)`: no-op (no scroll write, no throw).

**Checkpoint:**

- [x] `bun x tsc --noEmit` — exit 0.
- [x] `bun test` — all green. (2871 pass / 0 fail.)
- [x] `bun run audit:tokens lint` — zero violations.

---

#### Step 7: `TugMarkdownBlock` companion primitive {#step-7}

**Depends on:** #step-6

**Commit:** `tug-list-view: add TugMarkdownBlock companion primitive`

**References:** [D09] md-block-sibling, [Q07] md-block, [L19], [L22], [#md-block-api]

**Artifacts:**

- New `tugdeck/src/lib/markdown/parse-markdown-to-sanitized-blocks.ts` exporting the shared helper per [D09]. Contains the WASM lex/parse + DOMPurify sanitize pipeline that previously lived inline inside `TugMarkdownView`'s `lexParseAndRender`.
- Refactored `TugMarkdownView` to call `parseMarkdownToSanitizedBlocks` instead of inlining the WASM/DOMPurify calls. All existing `TugMarkdownView` tests must pass post-refactor — this is the gate that catches the extraction breaking the virtualized renderer.
- New `tug-markdown-block.tsx` + `.css` + tests per the component-authoring guide.
- No internal scroll container, no virtualization, no `BlockHeightIndex`, no spacers. All blocks render in document flow.
- `initialText` prop sets content once on mount per the [#md-block-api] mount-render contract; subsequent prop changes don't re-render content (consumers don't update initialText after mount).
- `streamingStore` + `streamingPath` props attach a store observer in `useLayoutEffect` ([L22]); observer writes new content directly to the DOM (re-runs the helper on each emission). Mount-render reads `streamingStore.get(streamingPath)` synchronously per [#md-block-api].
- Tests cover both modes plus the mount-render contract.

**Tasks:**

- [x] Extract `parseMarkdownToSanitizedBlocks(text)` from `TugMarkdownView`'s `lexParseAndRender`. The helper: calls `tugmark-wasm`'s `lex_blocks(text)` + `parse_to_html(...)` per block, sanitizes each block's HTML via `getDOMPurify().sanitize(...)`, returns `SanitizedMarkdownBlock[]`. **Implementation:** new `tugdeck/src/lib/markdown/parse-markdown-to-sanitized-blocks.ts`. The returned `SanitizedMarkdownBlock` shape carries the lex metadata (`type`, `startChar`, `endChar`, `depth`, `itemCount`, `rowCount`) alongside `html` so `TugMarkdownView` can compute heights without re-lexing — the [D09] example interface is a simplification of the real shape, not a constraint.
- [x] Refactor `TugMarkdownView` to call the helper. Run `bun test src/components/tugways/__tests__/tug-markdown-view.*.test.tsx` and confirm all existing tests pass — this is the regression gate. **Note:** there are no direct `tug-markdown-view.test.tsx` tests; the regression gate is the full `bun test` suite (2894 pass / 0 fail) plus the helper-shared decoders (`decodeBlocks`, `buildByteToCharMap`) being exported so the existing `incremental-tail-update`, `region-block-ranges`, and `fence-propagation` tests continue to pass against the same byte-decoding logic.
- [x] Cache contract change: `htmlCache` now stores SANITIZED HTML on every code path (full-rebuild via the helper, incremental updates via inline `getDOMPurify().sanitize(parse_to_html(raw), SANITIZE_CONFIG)`). `addBlockNode` writes `el.innerHTML = cachedHtml` directly with no second sanitize pass. This reverses the prior "DOMPurify at render time only" pattern in favor of uniform sanitize-on-cache.
- [x] Author `tug-markdown-block.tsx` per the component-authoring guide: docstring (cites [L03], [L06], [L19], [L20], [L22]); props interface; functional component with `data-slot="tug-markdown-block"`.
- [x] Author `tug-markdown-block.css`: `@tug-pairings` block; references `--tugx-md-*` tokens. No internal scroll; no spacer; just block rendering.
- [x] Implement static `initialText` mode in `useLayoutEffect`: call the helper synchronously, render the block list to the DOM before paint per [#md-block-api]. Subsequent `initialText` prop changes are ignored (mount-once semantics).
- [x] Implement streaming mode in `useLayoutEffect`: read the **current** `streamingStore.get(streamingPath)` value synchronously and render before paint (G1); then subscribe to `streamingStore.observe(streamingPath, ...)` for subsequent updates; on each emission, re-parse and re-render via the helper. Coalesce updates via rAF.
- [x] Tests cover the four mount-render and streaming behaviors below.

**Design addition:** new shared module `lib/markdown/dompurify-instance.ts` exports `getDOMPurify()` and `SANITIZE_CONFIG`. `TugMarkdownView`, `TugMarkdownBlock`, and the `parseMarkdownToSanitizedBlocks` helper all consume from it so the allowlist / blocklist is one piece of code. The strategy mirrors `lib/markdown.ts` — same allowlist, same jsdom fallback in Bun/Node test environments where happy-dom's DOMPurify interaction has known divergences. `lib/markdown.ts` itself is left in place (not refactored to use the new module) to limit Step 7 scope; a follow-on can converge the two getDOMPurify implementations.

**Tests:**

- [x] Static — basic markdown: `<TugMarkdownBlock initialText="**bold** and *italic*" />` renders strong + em DOM.
- [x] Static — synchronous mount render (G2): render, immediately query for the rendered block content, assert non-empty.
- [x] Streaming — initial value on mount (G1): pre-populate a `PropertyStore` with content, then mount `<TugMarkdownBlock streamingStore={store} streamingPath="text" />`; assert the cell mounts non-empty.
- [x] Streaming — subsequent updates: dispatch updates to the store; the block's DOM updates (re-parses via the helper).
- [x] Streaming — rapid emissions coalesce into one rAF flush.
- [x] No internal scroll: querying for `[data-slot="tug-markdown-block"]` does not find a `tugx-md-scroll-container`.
- [x] Helper unit tests: `parseMarkdownToSanitizedBlocks("# h\n\npara")` returns two blocks with sanitized HTML; `parseMarkdownToSanitizedBlocks("")` returns empty array; dangerous markup is sanitized; char offsets line up.
- [x] Refactor regression: full bun suite passes (2894 / 0).

**Checkpoint:**

- [x] `bun x tsc --noEmit` — exit 0.
- [x] `bun test` — all green (2894 pass / 0 fail).
- [x] `bun run audit:tokens lint` — zero violations.

---

#### Step 8: Gallery card — `gallery-list-view` {#step-8}

**Depends on:** #step-7

**Commit:** `tug-list-view: gallery showcase`

**References:** [D02] single-section, [D04] cell-reuse, [D06] streaming-direct, [#test-plan-concepts]

**Artifacts:**

- New `gallery-list-view.tsx` exercising:
  - A synthetic data source with ~50 items, two kinds (`"short"` 40px estimated; `"tall"` 200px estimated), heterogeneously interleaved.
  - A "streaming" demo cell kind that observes a fake `PropertyStore` updated on a `setInterval` (text grows over ~10 seconds; `ResizeObserver` picks up the height changes; `SmartScroll` auto-follows).
  - A "TugMarkdownBlock initialText" demo cell kind (static markdown content).
  - A "TugMarkdownBlock streaming" demo cell kind (driven by the same fake `PropertyStore` as the streaming demo).
  - Buttons in a header bar to: insert a row at top; insert at bottom; remove the last row; reset.
  - A delegate that logs `willDisplay` / `didEndDisplaying` / `onSelect` to the console for visual inspection.
- Registered in `gallery-registrations.tsx` with `componentId: "gallery-list-view"`, `family: "developer"`, etc., mirroring `gallery-transcript-entry`.
- A render-only smoke test that mounts the gallery card without throwing.

**Tasks:**

- [x] Author the gallery card. Module docstring states data is mock; live wire is the transcript.
- [x] Wire the synthetic data source as a class with subscribe/getVersion + numberOfItems/idForIndex/kindForIndex.
- [x] Implement the cell renderers per kind. **Five kinds shipped:** `short` / `tall` (40 / 200px estimated, plain text), `streaming-text` (uses `useSyncExternalStore` against the shared store — React-render-cycle binding is fine for the small text payload), `markdown-static` (`<TugMarkdownBlock initialText={...} />`), `markdown-streaming` (`<TugMarkdownBlock streamingStore streamingPath />`, [L22] direct-DOM internally). All five kinds intermixed across the 50-item seed via a sparse "specials" map; the gallery shows every shape without burying it in identical rows.
- [x] Implement the streaming-document tick (setInterval, dispose on unmount). 200ms tick × 50 ticks per ~10s cycle; resets and replays for continuous demo.
- [x] Add the registration entry to `gallery-registrations.tsx`. `componentId: "gallery-list-view"`, `family: "developer"`, `GALLERY_COMPLEX_SIZE`, `category: textInput`.
- [x] Render-only smoke test. Three assertions: documented `data-slot` shape, at least one rendered cell, four mutator buttons present.
- [ ] Manual visual review: open `gallery-list-view` in tugdeck; verify all five kinds, scroll behavior, follow-bottom, insert/remove buttons, console logs. **(User-driven.)**

**Tests:**

- [x] Render-only smoke: gallery card mounts without throwing in happy-dom and produces the expected `data-slot="tug-list-view"` root.

**Checkpoint:**

- [x] `bun x tsc --noEmit` — exit 0.
- [x] `bun test` — all green (2907 pass / 0 fail).
- [x] `bun run audit:tokens lint` — zero violations.
- [ ] Manual: open `gallery-list-view` in tugdeck and visually review. **(User-driven; HMR picks up the changes.)**

---

#### Step 8.5: TugListView v1 polish — keyboard activation, scroll-block default, focusable-child guard {#step-8-5}

**Depends on:** #step-8

**Commit:** `tug-list-view: keyboard activation + a11y + scrollToIndex polish`

**References:** [D03] imperative-api, [Q06] selection-model, [#dom-shape]

**Artifacts:**

- `tug-list-view.tsx`: cell wrapper gains a `keydown` handler that fires `delegate.onSelect(index)` on `Enter` / `Space` when the wrapper is `document.activeElement`. The list-view scroll container's `keydown` is already handled by `SmartScroll`; cell-level keydown coexists by checking `event.target` is the cell wrapper itself, not a descendant.
- `tug-list-view.tsx`: cell wrappers gain `role="listitem"` and the scroll container gains `role="list"` (or `role="grid"` / `row` if a future variant needs tabular semantics — leave at `list` for v1). Cells also get `tabIndex={0}` so keyboard focus traversal includes them.
- SmartScroll-side: skip the keydown handler when `event.target` is a focusable descendant of the scroll container (an `<input>`, `<textarea>`, `[contenteditable]`, etc.). Today, arrow-key presses inside a cell's editable child bubble up and disengage `followBottom`. Either gate `SmartScroll`'s handler on `event.target === scrollContainer` or have `TugListView` install a capture-phase keydown that calls `event.stopPropagation()` for keys originating in editable descendants.
- `scrollToIndex(index, options)` default: change `block` default from `"nearest"` to `"start"` so the row lands aligned to the viewport top — matches `UITableView.scrollToRow(at:atScrollPosition: .top)` and is the more useful default for "scroll this specific row into focus" use cases. `"nearest"` stays available via the explicit option.
- Tests pinning each behavior: keyboard `Enter` / `Space` on a focused cell fires `onSelect`; arrow keys inside an `<input>` descendant don't disengage `followBottom`; `scrollToIndex(N)` with no `block` lands the row at the viewport top.

**Tasks:**

- [x] Cell wrapper keydown handler. Guard on `event.target === currentTarget` so a child input's keydown doesn't double-fire. Implementation: cached per-index in the existing `cellCallbacksRef` registry. Enter / Space call `preventDefault` (stop native scroll on Space) AND `stopPropagation` (so SmartScroll's keydown — which treats Space as a scroll key — doesn't also see the event), then fire `delegate.onSelect(index)`.
- [x] `role="list"` / `role="listitem"` and per-cell `tabIndex`. Scroll container keeps its existing `tabIndex={0}` for native scroll (focusable lists are valid ARIA); cells gain both `role="listitem"` and `tabIndex={0}`.
- [x] Editable-descendant guard for SmartScroll keydown. **Chose option B (gate inside SmartScroll itself).** New module-private `_isEditableEventTarget(target)` helper checks `INPUT` / `TEXTAREA` / `SELECT` tags and `isContentEditable`; `_handleKeyDown` early-returns when the target is editable. Less invasive than a capture-phase listener in TugListView; benefits every SmartScroll consumer (TugMarkdownView, TugListView, future) the same way. Non-editable focusable descendants (a tabbable cell wrapper, a button) are explicitly NOT gated — keys from a focused cell still register as scroll intent the way keys from the container do.
- [x] Default `block` change in `scrollToIndex` from `"nearest"` to `"start"`. Explicit `block: "nearest"` still works.
- [ ] Plan note in `tugways/component-authoring.md`. **Skipped** — `component-authoring.md` is a general primitive-authoring guide, not a list-pattern reference. Cell-level keyboard activation is documented in `tug-list-view.tsx`'s docstring + the keydown comment block; downstream consumers see it via the `delegate.onSelect` JSDoc.

**Tests:**

- [x] `Enter` on a focused cell fires `onSelect(index)`; `Space` does the same; other keys don't (`ArrowUp`, `ArrowDown`, `Tab`, `Escape`, `a` all asserted as no-ops).
- [x] Keydown on an interactive child does NOT fire `onSelect` (`event.target` guard exercised via a cell renderer with an `<input>` descendant).
- [x] Arrow-key keydown inside an `<input>` descendant of a cell does not disengage `followBottom` (spies on `SmartScroll.prototype.pinToBottom`; asserts `pinToBottom` count grows on a subsequent data-source append).
- [x] `scrollToIndex(rendered_index)` with no `block` option calls `SmartScroll.scrollToElement` with `block: "start"`. Explicit `block: "nearest"` still wins.
- [x] `getElementForIndex(index)` returns an element with `role="listitem"`.
- [x] Scroll container carries `role="list"`; every cell carries `role="listitem"` + `tabindex="0"`.
- [x] SmartScroll-layer tests (`smart-scroll.test.ts`): keydown from `<input>` / `<textarea>` / `<contenteditable>` does NOT enter dragging or disengage follow-bottom. Keydown from the container or a tabbable non-editable child still does.

**Checkpoint:**

- [x] `bun x tsc --noEmit` — exit 0.
- [x] `bun test` — all green (2925 pass / 0 fail).
- [x] `bun run audit:tokens lint` — zero violations.

**Origin:** these items were called out during the post-Step-8 audit as deferred follow-ups — accessibility (no `role` / no keyboard activation), the SmartScroll-keydown / focusable-child interaction, and the `scrollToIndex` default. None block the transcript wire-up (Steps 9–11), but all three are paper-cuts that should be cleared before any v1.x consumer outside the transcript ships against the primitive.

---

#### Step 9: Expose `inflightUserMessage` on `CodeSessionSnapshot` {#step-9}

**Depends on:** #step-8

**Commit:** `tide(transcript): expose inflightUserMessage on CodeSessionSnapshot`

**References:** [D10] inflight-on-snapshot, [#snapshot-extension]

**Artifacts:**

- `tugdeck/src/lib/code-session-store/types.ts` — `inflightUserMessage` field added to `CodeSessionSnapshot`.
- `tugdeck/src/lib/code-session-store.ts` — `getSnapshot()` populates the new field from `state.pendingUserMessage`.
- New reducer-shape tests asserting the lifecycle.

**Tasks:**

- [x] Add the field to `CodeSessionSnapshot` per [#snapshot-extension]. Imports `AtomSegment` from `../tug-atom-img`. Field shape `{ text: string; atoms: ReadonlyArray<AtomSegment> } | null` matches the reducer's `pendingUserMessage` exactly so the snapshot can pass the reference through.
- [x] Populate in `getSnapshot()`. **Pass-through assignment** (`inflightUserMessage: this.state.pendingUserMessage`) so the reference stays identity-stable across snapshot rebuilds while the same pending message is in flight — `useSyncExternalStore` consumers ([L02]) get `Object.is` stability.
- [x] Module docstring update. `types.ts` header now cites [D10]; the field's JSDoc explains the reducer-mirror semantics, the in-flight transcript role (Step 10's `transcript.length * 2 + 2` accounting), and the identity-stability contract.
- [x] New tests against `test-01-round-trip.jsonl` (in `code-session-store.round-trip.test.ts`): `inflightUserMessage` is null on idle, non-null after `send`, identity-stable across same-state snapshot reads, and back to null after `turn_complete(success)`.
- [x] New tests against `test-06-interrupt-mid-stream.jsonl` (in `code-session-store.interrupt.test.ts`): pending message survives mid-stream `interrupt()` until `turn_complete(error)` commits the interrupted entry, then clears.
- [x] Update existing scaffold snapshot test (`code-session-store.scaffold.test.ts`) to assert `inflightUserMessage` defaults to `null` on a fresh store. The `tug-prompt-entry.test.tsx`'s `defaultSnapshot()` factory was also extended with the new field so the existing TugPromptEntry tests still typecheck.

**Tests:**

- [x] Reducer lifecycle tests pass (the existing reducer tests already exercised `state.pendingUserMessage` directly; the new tests pin the SNAPSHOT-level mirror).
- [x] Existing snapshot tests still pass (125 / 0 in `code-session-store/__tests__`; full bun suite 2927 / 0).

**Checkpoint:**

- [x] `bun x tsc --noEmit` — exit 0.
- [x] `bun test` — all green (2927 pass / 0 fail).
- [x] `cargo nextest run` — all green (1200 passed / 9 skipped).

---

#### Step 10: `TideTranscriptDataSource` adapter {#step-10}

**Depends on:** #step-9

**Commit:** `tide(transcript): TideTranscriptDataSource adapter`

**References:** [D02] single-section, [D04] cell-reuse, [D06] streaming-direct, [D10] inflight-on-snapshot

**Artifacts:**

- New `tugdeck/src/lib/tide-transcript-data-source.ts` exporting `TideTranscriptDataSource` (class implementing `TugListViewDataSource`) and `useTideTranscriptDataSource(codeSessionStore)` (hook that constructs and disposes the adapter).
- The adapter:
  - Subscribes to `codeSessionStore` for snapshot updates.
  - `numberOfItems()` returns `transcript.length * 2 + (inflightUserMessage ? 2 : 0)`.
  - `idForIndex(index)` returns a stable id per the **id-stability protocol** below.
  - `kindForIndex(index)` returns `"user"` for even indices in the committed range, `"code-committed"` for odd; for the in-flight pair, returns `"user"` and `"code-streaming"`.
  - Exposes `rowAt(index)` returning a typed descriptor (`{ kind, turn?, inflight? }`) so cell renderers can read content without round-tripping back through the snapshot.
  - `subscribe(listener)` proxies to `codeSessionStore.subscribe`.
  - `getVersion()` returns the `codeSessionStore` snapshot reference (changes on every reducer dispatch). The reference is `Object.is`-stable across non-mutating dispatches per `CodeSessionStore`'s contract, satisfying `TugListViewDataSource.getVersion`'s equality requirement.
- New `__tests__/tide-transcript-data-source.test.ts` covering the adapter.

**Id-stability protocol (G8 in plan-review).** The naïve approach mints `"inflight-user"` / `"inflight-code"` for the in-flight pair and `${msgId}-user` / `${msgId}-code` for committed pairs. The id changes at the in-flight → committed transition, forcing React to unmount the streaming cell and mount a fresh committed cell — which destroys the streaming cell's `TugMarkdownBlock` instance and forces a fresh lex/parse from `initialText`. The cleaner protocol uses `activeMsgId` from the moment the reducer assigns it:

```ts
function idForIndex(index: number): string {
  const inflight = snap.inflightUserMessage;
  const committedCount = snap.transcript.length;

  // In-flight pair (when present, occupies the last two positions).
  if (inflight !== null && index >= committedCount * 2) {
    // `activeMsgId` is null between submit and first delta; fall back to a
    // stable sentinel so the React mount survives the transition where it
    // becomes set. Once `activeMsgId` is set, the id is stable through commit.
    const seed = snap.activeMsgId ?? "inflight";
    return index === committedCount * 2 ? `${seed}-user` : `${seed}-code`;
  }

  // Committed pair.
  const turn = snap.transcript[Math.floor(index / 2)];
  return index % 2 === 0 ? `${turn.msgId}-user` : `${turn.msgId}-code`;
}
```

The transition flow:

1. `send("hi")` → `inflightUserMessage` set, `activeMsgId = null`. Pair ids: `"inflight-user"`, `"inflight-code"`.
2. First delta → `activeMsgId = "msg-42"`. Pair ids change to `"msg-42-user"`, `"msg-42-code"`. **One remount** here (the seed transition); a future optimization could maintain a sticky id across this gap, but a single remount during the awaiting-first-token → streaming transition is acceptable.
3. Streaming continues → ids stable, `TugMarkdownBlock` instance survives, observer-driven content updates.
4. `turn_complete(success)` → `inflightUserMessage` cleared, transcript appends. Pair ids `"msg-42-user"`, `"msg-42-code"` are now derived from `transcript[N-1].msgId` instead of `activeMsgId` — same value. **Kind changes** from `code-streaming` to `code-committed` (a prop change, not a remount).

The kind change at commit is a prop change to the cell wrapper, which rerenders the wrapper with a different cell renderer. React reconciliation: same wrapper key, different renderer component → new mount of the renderer (the wrapper component is `<div data-tug-list-cell-index>` etc., a stable host; the renderer underneath is the part that swaps). This is acceptable — the `code-committed` cell mounts with `initialText` and renders synchronously per the [#md-block-api] mount-render contract, no flicker.

**Tasks:**

- [x] Author the adapter class with the id-stability protocol above.
- [x] Author the hook that constructs/disposes against a `codeSessionStore`.
- [x] Tests against fixture-driven `CodeSessionStore`: empty transcript + idle → `numberOfItems = 0`; submit "hi" → `numberOfItems = 2`, kinds `["user", "code-streaming"]`, ids start with seed `"inflight"`; first delta → ids transition to `${activeMsgId}-...`; `turn_complete(success)` → kinds `["user", "code-committed"]`, ids stable through commit; second submit during idle → grows to 4, etc.
- [x] Test ids are stable across snapshot ticks for committed turns (so React reconciler matches).
- [x] Test the seed → activeMsgId id transition: assert exactly one id change per turn (at first-delta), zero at commit.

**Tests:**

- [x] Empty state: `numberOfItems = 0`.
- [x] In-flight pair appears on `send`, kind transitions on commit.
- [x] Id stability: `idForIndex(i)` for committed turns is stable across snapshot ticks.
- [x] Id transition: in-flight pair's id changes once when `activeMsgId` becomes set; stable through commit.
- [x] Multi-turn: kinds and ids are correct across N committed turns.
- [x] Subscribe fires on snapshot ticks.
- [ ] Edge: data source removes a row mid-window (e.g., a future "forget turn" flow) — the adapter handles a mid-array transcript shrink without throwing; current rendered cells re-key correctly. *Deferred: the underlying `CodeSessionStore` exposes no transcript-shrink path today, so a faithful test would require a hand-rolled `CodeSessionStore` mock — out of scope per the test-reality / no-mock-store guidance. Earned when the forget-turn flow lands; tracked in [#roadmap].*

**Checkpoint:**

- [x] `bun x tsc --noEmit` — exit 0.
- [x] `bun test` — all green.
- [x] `cargo nextest run` — all green.

---

#### Step 11: Wire `TugListView` into the Tide card {#step-11}

**Depends on:** #step-10

**Commit:** `tide(transcript): wire TugListView with multi-turn rendering`

**References:** [D04] cell-reuse, [D06] streaming-direct, [D11] user-body-plaintext, [D12] token-sovereignty, [#render-shape]

**Artifacts:**

- `tide-card.tsx` — replace `<TugMarkdownView streamingPath=... />` at the top pane with `<TugListView dataSource={dataSource} cellRenderers={cellRenderers} delegate={delegate} scrollKey="tide-card-transcript" />`. The explicit `scrollKey` makes the [A9] persistence axis self-documenting and avoids future card-level conflicts if a second list view ever lands inside the Tide card ([L23], per [#public-api]).
- Cell renderers (in `tide-card.tsx` or a small co-located `tide-card-transcript-cells.tsx`):
  - `UserRowCell` — `<TugTranscriptEntry participant="user" identifier="You" body={<span>{text}</span>} />`
  - `CodeCommittedRowCell` — `<TugTranscriptEntry participant="code" identifier={modelName ?? "Code"} body={<TugMarkdownBlock initialText={entry.assistant} />} />`
  - `CodeStreamingRowCell` — `<TugTranscriptEntry participant="code" identifier={modelName ?? "Code"} body={<TugMarkdownBlock streamingStore={...} streamingPath={"inflight.assistant"} />} />`
- `tide-card.css` — `.tide-card-transcript` block with cascade-scoped list-view token overrides ([D12]).
- Helper hook `useSessionModelName(sessionMetadataStore)` reading `model` via `useSyncExternalStore`.
- Helper `formatTranscriptTimestamp(ms)` returning a short display string.
- Tests in `__tests__/tide-card.test.tsx`.

**Tasks:**

- [x] Add `.tide-card-transcript` to `tide-card.css` with cascade-scoped token overrides.
- [x] Replace the single `<TugMarkdownView>` at the top pane with the new render-shape per [#render-shape], passing `scrollKey="tide-card-transcript"`.
- [x] Implement cell renderer components.
- [x] Implement `useSessionModelName` and `formatTranscriptTimestamp`.
- [x] Author multi-turn integration tests using the existing golden-catalog fixtures: assert `(user, code)` row pair count and order; in-flight user row appears immediately; streaming code row body reflects deltas; on commit, committed pair holds final text without empty intermediate render; no element bound to `streamingPath` survives `turn_complete`.
- [x] Update the section comment / module docstring on `tide-card.tsx`'s top-pane rendering to describe the new structure.

**Tests:**

- [x] Multi-turn rendering: load a multi-turn fixture, assert N `(user, code)` row pairs in correct order.
- [x] Immediate user row: `submit("hi")`, assert user row in DOM before any assistant delta dispatch.
- [x] Streaming-to-commit: drive deltas, assert in-flight code row body updates; on `turn_complete(success)`, assert committed pair holds final text and no in-flight pair survives.
- [x] Streaming-to-commit — no empty intermediate render: at the transition, query the rendered DOM for the committed `code` cell and assert its body content is non-empty in the same paint as the streaming cell's removal (the [#md-block-api] mount-render contract).
- [x] Identifier source: when `SessionMetadataStore.model` is set, `code` row identifier matches; when null, identifier is `"Code"`.
- [x] No sticky last: query for any element bound via `streamingPath` after `turn_complete`; assert empty.
- [x] User body plain text: assert `<span>` children equal `userMessage.text` verbatim.
- [x] Persistence axis: assert the rendered scroll container has `data-tug-scroll-key="tide-card-transcript"` for [L23] correctness.

**Checkpoint:**

- [x] `bun x tsc --noEmit` — exit 0.
- [x] `bun test` — all green.
- [x] `bun run audit:tokens lint` — zero violations.
- [x] `cargo nextest run` — all green.

---

#### Step 12: Tuglaws walkthrough + parent close-out {#step-12}

**Depends on:** #step-11

**Commit:** `tide(transcript): tuglaws walkthrough; close out parent §step-11`

**References:** (#tuglaws-cross-check, #success-criteria), parent §step-11 anchor

**Artifacts:**

- Per-step compliance review against [tuglaws.md](../tuglaws/tuglaws.md), [pane-model.md](../tuglaws/pane-model.md), [component-authoring.md](../tuglaws/component-authoring.md), [responder-chain.md](../tuglaws/responder-chain.md), [state-preservation.md](../tuglaws/state-preservation.md), [token-naming.md](../tuglaws/token-naming.md). Findings either land as small fixes in this commit or are explicitly logged.
- `tide.md §T3.4.a` updated to mention `TugListView` and `inflightUserMessage`.
- `tugplan-tide-card-polish.md §step-11` row flipped to "shipped — see [tugplan-tug-list-view.md]"; body trimmed to a 3-line marker mirroring the §step-10 close-out pattern.
- `tugplan-tide-transcript-rendering.md` marked as superseded with a forward link to this plan.
- Note in this plan's [#roadmap]: Cmd+J keybinding deferred to its own follow-up plan; picker migration onto `TugListView` deferred; prefetching deferred; sections / headers / footers / animations deferred.

**Tasks:**

- [x] Walk each tuglaw against this plan's diff. For any flagged item, either fix in this commit or document why deferred.
- [x] Update `tide.md §T3.4.a`. *(landed in Step 11's commit alongside the Tide card wire-up.)*
- [x] Update parent plan's `§step-11` row + body.
- [x] Add the supersede marker to `tugplan-tide-transcript-rendering.md`.

**Tests:**

- [x] Full-suite green: `bun x tsc --noEmit`, `bun test`, `bun run audit:tokens lint`, `cargo nextest run`.

**Checkpoint:**

- [x] All commands above exit clean.

**Tuglaws walkthrough findings.** Per-step compliance ran against [tuglaws.md], [pane-model.md], [component-authoring.md], [responder-chain.md], [state-preservation.md], [token-naming.md]. The §[#tuglaws-cross-check] table covers L01–L24 in detail; Step 12's pass surfaced two small fix-in-place items, both landed in this commit:

1. **Step 11's "no sticky last" test was checking a non-existent attribute** (`data-streaming-path`, which `TugMarkdownBlock` does not write). Strengthened to assert against `data-tug-list-cell-kind="code-streaming"` — an attribute the list view actually writes — and added a positive assertion that a `code-committed` cell exists post-commit.
2. **`TideTranscriptHost` was reading `streamingPath` via `codeSessionStore.getSnapshot().streamingPaths.assistant` on every render.** Stabilized via `useMemo([codeSessionStore])` so the value participates in the `cellRenderers` memo without churning identity on snapshot ticks.

No deferred-with-rationale findings; the [#non-goals] (D13 native-selection-across-scroll-out) and [#roadmap] entries (Cmd+J, picker migration, prefetching, sections, animations, imperative DOM pooling, atom-aware user rows) were already explicitly logged in earlier steps.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** `TugListView` framework primitive (data source + delegate + variable-height windowing + cell-kind reuse abstraction + lifecycle + SmartScroll auto-follow-bottom + imperative `scrollToIndex`), plus `TugMarkdownBlock` companion primitive, plus a gallery card showcasing the basic features end-to-end. The Tide card's top pane consumes the primitive via `TideTranscriptDataSource`, rendering committed turns from `snap.transcript` and the in-flight pair from `snap.inflightUserMessage` + streaming binding. Cmd+J explicitly deferred.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [x] `TugListView` primitive exists at the listed file path and exports the public API.
- [x] `TugMarkdownBlock` companion primitive exists.
- [x] Gallery card mounts and visually exercises: heterogeneous kinds, variable heights, dynamic insert/delete, streaming-bound cell with auto-follow, selection.
- [x] `CodeSessionSnapshot.inflightUserMessage` exists and tests cover its lifecycle.
- [x] `TideTranscriptDataSource` adapter exists and tests cover its mapping shape.
- [x] The Tide card top pane renders `(user, code)` row pairs via `TugListView`.
- [x] In-flight user row appears immediately on `send()`.
- [x] In-flight code row body streams from `streamingDocument.inflight.assistant`; on `turn_complete`, the committed pair holds the final text without an intermediate empty render.
- [x] No element bound to `streamingPath` survives `turn_complete` — sticky last is gone.
- [x] Auto-follow-bottom honors `SmartScroll` user-opt-out.
- [x] Tuglaws cross-check passes per-step.
- [x] Parent plan §step-11 row flipped to "shipped"; Cmd+J explicitly logged as deferred follow-on.
- [x] All check commands green: `bun x tsc --noEmit`, `bun test`, `bun run audit:tokens lint`, `cargo nextest run`.

**Acceptance tests:**

- [x] `HeightIndex` unit tests (Step 4).
- [x] List-view component tests across windowing, heights, reuse, lifecycle, SmartScroll (Steps 3–6).
- [x] `TugMarkdownBlock` tests for static and streaming modes (Step 7).
- [x] Gallery render-only smoke (Step 8).
- [x] `inflightUserMessage` reducer-lifecycle tests (Step 9).
- [x] `TideTranscriptDataSource` adapter tests (Step 10).
- [x] Tide card multi-turn integration tests (Step 11).

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] **Cmd+J keybinding plan.** Originally absorbed into parent §step-11 from §step-6. Deferred per user instruction. Authored as its own plan when scheduled. Exposes `getSelectedHistoryEntryId(): string | null` on the prompt-entry / text-editor delegate; adds a card-level Cmd+J handler that calls `tugListViewRef.current.scrollToIndex(index)` to scroll the matching row into view, or scrolls to bottom if no selection.
- [ ] **Prefetching protocol** (`UITableViewDataSourcePrefetching` analogue). Adds `delegate.prefetchForIndices(indices)` and `delegate.cancelPrefetchForIndices(indices)` plus a viewport-prediction window. Earned once a real consumer has perf data showing it matters.
- [ ] **Sections.** `numberOfSections`, `numberOfItemsInSection`, `IndexPath`-shaped data source, optional `sectionHeaderRenderer` / `sectionFooterRenderer`. Earned when a consumer needs section semantics.
- [ ] **Insert/delete/move animations.** Data-source ticks tag the delta (added / removed / moved); list view animates the affected cells. Earned when a consumer surfaces a real animation requirement.
- [ ] **Imperative DOM cell pooling.** Replace React item-keyed mount/unmount with imperative DOM ownership + per-kind pools. Public API unchanged. Earned when long-N transcripts / lists show React reconcile cost dominating. **Resolves [D13]'s native-text-selection-across-scroll-out limitation as a side effect** — preserving cell DOM keeps the browser's native selection alive.
- [ ] **Native-selection survival across scroll-out** — explicitly resolved by the imperative-DOM-pool upgrade above. v1 documented limitation per [D13] and [#non-goals].
- [ ] **Stable in-flight ↔ committed id** — the adapter's id-stability protocol ([Step 10](#step-10)) accepts one remount per turn at the awaiting-first-token transition (when `activeMsgId` becomes set). A future optimization could mint a synthetic stable seed and patch it to match `activeMsgId` once known, eliminating the remount entirely. Earned when the gallery / live smoke shows the remount produces user-visible flicker.
- [ ] **Picker migration onto `TugListView`.** The session picker (parent §step-10) keeps its existing radiogroup implementation. Migration becomes meaningful once we want richer behaviors (variable-height session rows with previews, prefetched detail views, animated insert/delete on session creation). Authored as its own plan.
- [ ] **Atom-aware rendering for `user` rows.** Once `userMessage.attachments` evolves into `AtomSegment[]` and the prompt entry's atom flow reaches transcript form, replace the plain-text `<span>` body with an atom-aware renderer.
- [ ] **Markdown styling pass for assistant output** (parent §step-12).
- [ ] **Thinking + tool surfaces inside `code` rows** (parent §step-13).
- [ ] **Queued-send rendering as `user` rows** (parent §step-14).
- [ ] **Long-transcript performance review.** Smoke against ≥ 50-turn sessions during parent §step-12 / §step-13 manual passes; revisit cell-reuse implementation if needed.
- [ ] **Selection beyond `onSelect`.** Multi-select, swipe-to-edit, drag-to-reorder, chain-driven selection commands.
- [ ] **Header / footer views.** Table headers / footers / per-section headers / per-section footers.
- [ ] **Pull-to-refresh, editable cells.**

| Checkpoint | Verification |
|-|-|
| Tokens lint clean | `bun run audit:tokens lint` |
| Height index unit tests | `bun test src/components/tugways/internal/__tests__/list-view-height-index.test.ts` |
| List view tests | `bun test src/components/tugways/__tests__/tug-list-view.test.tsx` |
| Markdown block tests | `bun test src/components/tugways/__tests__/tug-markdown-block.test.tsx` |
| Gallery card mounts | Manual: open `gallery-list-view` in tugdeck |
| Reducer lifecycle | `bun test src/lib/__tests__/code-session-store.*.test.ts` |
| Adapter tests | `bun test src/lib/__tests__/tide-transcript-data-source.test.ts` |
| Tide card integration | `bun test src/components/tugways/cards/__tests__/tide-card.test.tsx` |
| TS clean | `bun x tsc --noEmit` |
| Workspace tests | `cargo nextest run` |
