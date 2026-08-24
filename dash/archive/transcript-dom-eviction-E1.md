## Transcript DOM Eviction — E1: measured-height windowing in TugListView {#transcript-dom-eviction-e1}

**Purpose:** Land staging step E1 of [transcript-dom-eviction.md](transcript-dom-eviction.md): settled transcript rows outside the scrollport ± a mount margin unmount to exact-height space (the measured-height ledger), pixel-identically, so a session's mounted DOM is viewport-sized regardless of history length — the S9 footprint fix ([aug01-perf-brief.md §F-D](aug01-perf-brief.md#fd-dom-eviction)).

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-01 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The S9 purge train is driven by WebContent footprint (~1273MB steady: ~730MB WebKit-malloc live core + ~520MB graphics) sitting above WebKit's conservative memory threshold (measured ≤ ~1.27GB on the user's machine); each 30s monitor tick purges style caches and the next recalc pays a cold full-document re-resolve (~270–330ms ×2) — the felt hitch. The dominant addressable share is the mounted transcript representation: **1,372 collapsed tool-block headers = 40,359 of 64,023 transcript nodes** on the live deck, because the restore window is bounded in turns and turns don't bound content (autonomous turns carry up to 250 tool calls). Design and grounding are locked in [transcript-dom-eviction.md](transcript-dom-eviction.md) (invariants I-1..I-5) and the brief's §F-D + "S9 memory attribution 2026-08-01 (second pass)" block. **User-set constraint: the transcript looks identical — footprint optimization, not redesign.**

#### Strategy {#strategy}

- **Reuse the windowed path, don't invent an eviction layer.** `TugListView` already contains everything E1 needs: `computeWindow` + top/bottom spacers (`internal/list-view-window.ts`), a `HeightIndex` populated by the shared cell `ResizeObserver` (`internal/list-view-height-index.ts`), and a selection/focus pin (`pinnedRange`, clamp-outward) wired to `selectionchange`/`focusin`/`focusout`. The transcript abandoned windowing only because unmeasured cells fell back to **estimates** (the relaunch "bounce"). E1 is windowing with estimates structurally banned: eviction activates only when every out-of-window row has a real measured height.
- **The ledger is the `HeightIndex`.** No new store: the same ResizeObserver delivery that stamps `contain-intrinsic-size` (`tug-list-view.tsx`, the offscreen-skip stamp) populates it. E1 adds a completeness predicate and width-epoch invalidation.
- **Placeholders are the existing aggregate spacers,** not per-row placeholder elements — refining the design doc's placeholder sketch (see [P01]). A spacer paints nothing, exactly like today's cv-skipped cell (pixel identity, I-1).
- **Activation is conservative, suspension is the safety net.** Full inline mount during restore/replay (today's path); eviction activates on the settle edge once the ledger is complete; ANY unmeasured row outside the window+pins suspends eviction for that tick (falls back to full inline render). No estimate can ever reach spacer math (I-2).
- **Find needs no pinning:** the Find route searches the store-side `transcript-search-index` (built for windowed rendering — its header documents "almost every row is unmounted at any moment") and paints DOM ranges only for mounted rows; reveal goes through `scrollToIndex`, which is exact under an all-measured accessor.
- Each landing diff passes the typist gate (AT9996_TYPIST_WEIGHT=500, hold q50=7/q90=16/q99=29) and `bunx vite build`; the only success surface is the user's live release instance (footprint, dual ledger, purge-recovery, kb ledger).

#### Success Criteria (Measurable) {#success-criteria}

- Eviction cell (Step 5): at AT9996 weight 500, mounted transcript cells per card within the List L01 margin-derived budget (≈ 25 at the [P05] defaults) while the data source holds 500+ rows; mounted transcript-region nodes ≥ 60% below the same-weight inline baseline (A/B by env knob) and ≤ 25k per card absolute.
- Height fidelity: a scripted full-range scroll (top → bottom → top) changes `scrollHeight` by ≤ 2px and increments the estimate-fallback diagnostic counter by 0 (Spec S04).
- Typist cell at weight 500 holds q50 ≤ 7 / q90 ≤ 16 / q99 ≤ 29 (expected to improve — the I6 mounted-weight term shrinks).
- Live release instance (user relaunch, then reads): steady WebContent footprint < 700MB (`footprint <pid>`); dual ledger (`diag/deck-probes/dual-arm.js`) shows no 30s-metronomic pair over a 5+ minute watch, **or** `notifyutil -p org.WebKit.lowMemory` recovery pairs < 50ms (either exit satisfies §F-D).
- All selective app-tests green (`just app-test-changed` + the Step 6 suite); pixel identity holds (no visible change anywhere).

#### Scope {#scope}

1. `internal/list-view-window.ts`: pixel-margin windowing with mount/retain hysteresis and a prior-window input (pure function + unit tests).
2. `internal/list-view-height-index.ts`: measured-count/completeness API.
3. `tug-list-view.tsx`: new `evictOffscreen` prop (an `inline` sub-mode) — windowed slice + spacers render path, activation predicate, suspension fallback, pin machinery enabled for the mode, width-epoch invalidation of the ledger, prepend-compensation continuity, exact `scrollToIndex`.
4. `session-card-transcript.tsx`: pass `evictOffscreen`; verify find-reveal, jump-to-bottom, `pageByEntry`, load-previous under the mode.
5. at9996 eviction cell + typist A/B gate; new app-test file for scroll/find/selection/prepend fidelity.

#### Non-goals (Explicitly out of scope) {#non-goals}

- E2 intra-entry block-run eviction (whale rows mount whole while in-window).
- F-A(3b) occlusion culling for stacked cards (separate recipe).
- Any visible-surface change whatsoever; any persistence of the ledger (no localStorage/sessionStorage/IndexedDB, no tugbank).
- Changes to `code-session-store`, ingest, or the replay protocol (I-3).
- The restore-churn cap as progressive ingest-staged mounting — deferred behind a live decision gate ([P06]).

#### Dependencies / Prerequisites {#dependencies}

- F-A(1) `contain: layout style` on `.tug-transcript-entry` (landed) and F-A(3a) collapsed-header sticky demotion (landed, may be uncommitted — verify `blocks/block-header.css` carries `.tool-call-header[data-collapsed="true"] { position: relative; top: auto; }` before starting).
- The at9996 lab (`tests/app-test/at9996-anim-island-lab.test.ts`) with the typist cell (`AT9996_TYPIST=1`, trusted non-repeat filter) — the regression meter.

#### Constraints {#constraints}

- Only the user commits on `main`; dash-lane commits per the dash skill are the exception. Motion designs are FIXED. Compose existing Tug components ([L19]). Cross-check tuglaws before tugdeck work and name the laws touched in each commit. `bunx vite build` before declaring any diff done. App-tests selective via just recipes; stall/typist cells need `foreground: true`; at0140/at0175/at0272 fail on `document.hasFocus()` under machine contention — not regressions.
- The harness RPC wedges past ~8KB evalJS payloads (lab standing rule) — keep diagnostic reads small.

#### Assumptions {#assumptions}

- `content-visibility: auto` (offscreenSkip) remains active on mounted cells and composes with windowing — cv affects only mounted cells' rendering; spacers replace unmounted cells. (Verified compatible by mechanism; Step 4 checkpoint re-verifies behaviorally.)
- The a11y tree loses unmounted rows (cv kept them). Accepted trade, same as every windowed list in the app (Risk R02).

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Where does mounted-set state live; what is the placeholder element? (DECIDED) {#q01-mounted-set}

**Question:** Where the mounted-set state lives so mount/evict updates ride the list's existing scheduling without violating [L05], and what the placeholder element actually is so [L26] mount identity and the cv stamp survive.

**Resolution:** DECIDED (see [P01]). The mounted set is the render-time `computeWindow` result — derived in the component body from `scrollTop` + the `HeightIndex`, re-derived when the existing `scrollTick` reducer pokes (scroll events, ResizeObserver rAF flush). No new state class; [L05] is satisfied because nothing awaits a commit inside rAF. The placeholder is the existing **aggregate top/bottom spacer pair** — no per-row placeholder exists. Unmounted rows lose their cv stamps with their elements; on re-mount the shared ResizeObserver re-measures and re-stamps (the stamp path already handles the missing-attribute case).

#### [Q02] Does an IntersectionObserver margin fight content-visibility? (DECIDED) {#q02-io-vs-cv}

**Resolution:** DECIDED — dissolved. There is no IntersectionObserver: the scroll-driven `computeWindow` (already how the windowed path works) replaces it. cv stays on mounted cells only; the two mechanisms never see the same row in conflicting states.

#### [Q03] Selection-suspension mechanism (DECIDED) {#q03-selection}

**Resolution:** DECIDED (see [P04]). The machinery exists in `tug-list-view.tsx`: `document.selectionchange` + container `focusin`/`focusout` recompute `pinnedRangeRef` ([L22]) and poke `scrollTick`; `computeWindow` clamps the window outward to cover the pin ([L23]) — a whole-document selection mounts everything, bounded by user action. Today it is gated OFF for `inline`; E1 enables it when `evictOffscreen` is active. CM6 descend scopes hold DOM focus inside the container, so the `activeElement` pin covers them.

#### [Q04] Restore sweep vs streaming ingest scheduling (DECIDED) {#q04-restore-sweep}

**Resolution:** DECIDED (see [P02], [P06]). E1 has no sweep: restore runs today's full inline mount (`batchLoading` freeze → `onFirstSettle`), which fully populates the `HeightIndex`; eviction activates on the settle edge. Streaming appends land at the bottom — in-window under `followBottom` — and any unmeasured row outside window+pins suspends eviction for the tick (the safety net that makes estimates unreachable). The restore-churn spike therefore still occurs at mount; whether it *persists* as dirty pages after eviction unmounts 90%+ of rows is a live measurement, and progressive restore mounting (E1b) is gated on that reading ([P06]).

#### [Q05] Eviction cell budget numbers (DECIDED) {#q05-budget}

**Resolution:** DECIDED — see Success Criteria and List L01: mounted cells/card within the margin-derived budget formula (≈ 25 at the [P05] defaults; the cell computes it from the live knobs), ≥ 60% node reduction vs same-weight inline A/B, ≤ 25k nodes/card absolute, scrollHeight drift ≤ 2px over a full-range scroll, estimate-fallback counter = 0.

#### [Q06] Whale-row mount cost mid-flick (DEFERRED) {#q06-whale-mount}

**Question:** Mounting an 8k-node whale row as it enters the retain margin during a fast flick could jank the scroll frame.

**Resolution:** DEFERRED to E2 (intra-entry eviction is the real fix for whale rows). E1 mitigates with the pixel mount margin (rows mount a viewport early) and measures via the eviction cell's scripted scroll; if flick jank shows up in real use, E2's priority rises. Not a blocker: today those nodes are *always* mounted — E1 never makes any moment worse than the status quo.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Scroll-churn jank (mount/unmount per scroll tick) | med | med | pixel margins + retain hysteresis ([P05]); unmount only beyond retain margin; eviction cell scripted-scroll assertion | typist/scroll regressions in the cell |
| a11y tree loses unmounted rows | low | certain | accepted trade (parity with every windowed list); find/reveal path unaffected (store-side index) | user report |
| Hidden full-DOM dependency (tests, screenshot probe, reveal paths) | med | med | Step 6 app-test sweep + `just app-test-changed`; find is store-side ([P07]); reveal scrolls clear the stuck header (standing gotcha, asserted) | any red test |
| Heap win smaller than modeled (~300–400MB estimate is arithmetic) | med | low-med | live decision gate after Step 7: footprint read on the user's instance; §F-D's dual exit (train stopped OR recovery < 50ms) holds either way | footprint ≥ 700MB after landing |
| Pin gaps destroy user state (selection/focus edge cases) | high | low | reuse the proven windowed-path pin; suspension fallback is card-wide and conservative; dedicated selection app-test | any state-loss repro |

**Risk R01: prepend (load-previous) viewport instability under spacers** {#r01-prepend}

- **Risk:** load-previous prepends rows; under the windowed render the top spacer and `HeightIndex.shift` must compensate or the viewport jumps.
- **Mitigation:** the load-previous bracket already raises `batchLoading` (scroll-battery freeze) and the prepended rows mount and measure inside the bracket; the inline front-insert compensation (`detectPrepend` + `prependScrollAdjustment` + `heightIndexRef.current.shift`) remains active because `evictOffscreen` is an `inline` sub-mode. Step 4 keeps this path enabled and Step 6 pins it with an app-test.
- **Residual risk:** a prepend arriving while evicted (not under the bracket) — not a real path today (prepends only come from the load-previous gesture), asserted by the suspension safety net if it ever happens.

---

### Design Decisions {#design-decisions}

#### [P01] Eviction mode = the windowed render path with spacers as placeholders (DECIDED) {#p01-windowed-reuse}

**Decision:** `evictOffscreen` renders the `computeWindow` slice between the existing top/bottom spacers; there are no per-row placeholder elements.

**Rationale:**
- The design doc sketched per-row placeholders; investigation found `TugListView`'s windowed path already implements the aggregate-spacer form with prefix-sum spacer math, `scrollToIndex` support, and pin clamping. Aggregate spacers are strictly simpler (no 1,300 placeholder divs), and pixel-identical: a spacer region paints nothing, exactly like today's cv-skipped cells.
- The windowed path was rejected for the transcript only because of estimate fallback ("bounce"); [P02] removes estimates instead of removing windowing.

**Implications:**
- The plan-local refinement supersedes the design doc's placeholder sketch; the doc's invariants (I-1..I-5) are unchanged and still govern.
- Rows outside the window are fully unmounted React children — the heap releases elements, render objects, computed styles, and fibers (the point of E1).

#### [P02] Activation predicate + suspension fallback: estimates are unreachable (DECIDED) {#p02-activation}

**Decision:** Eviction is active only when (a) `batchLoading` is false (post-settle), and (b) every index outside the computed window+pins has a measured height in the `HeightIndex`. If (b) fails on any tick, that tick renders full inline (suspension) and a diagnostic counter increments.

**Rationale:** I-2 (real heights only) as a structural property, not a code-review promise. Restore and load-previous mount fully (today's paths) and measure everything; streaming appends are in-window under `followBottom`; so suspension should never fire in practice — it exists so the failure mode of any future regression is "temporarily mounts everything" (today's behavior), never "wrong scroll geometry".

**Implications:** `HeightIndex` needs a cheap measured-coverage check (Step 2); the estimate-fallback counter is a test-observable diagnostic (Spec S04).

#### [P03] Width/zoom invalidation = suspend, re-measure, re-activate (DECIDED) {#p03-width-invalidation}

**Decision:** A scroller width change (the existing width-observer that strips cv stamps) also epochs the ledger: eviction suspends (full inline render — one heavyweight relayout on a rare, deliberate user gesture, identical to today's cv-wipe behavior), every cell re-measures through the ResizeObserver, and eviction re-activates when the ledger is complete again. Font-scale/page-zoom changes flow through the same width observation (zoom changes effective width).

**Rationale:** Supersedes the design doc's "stale-but-real" transitional compromise with something simpler and stricter — no stale heights exist at all, and the suspension machinery ([P02]) is reused rather than adding a sweep scheduler.

**Implications:** the design doc's one sanctioned exception is retired; I-2 holds unconditionally.

#### [P04] Pinning = the existing windowed-path pin, enabled for the mode (DECIDED) {#p04-pinning}

**Decision:** Enable the `selectionchange`/`focusin`/`focusout` → `pinnedRange` machinery when `evictOffscreen` is active (it is currently gated off for `inline`); no new pin sources in E1.

**Rationale:** it already implements [L22]/[L23] with clamp-outward semantics and covers keyboard focus, CM6 descend scopes (DOM focus), and selections (whole-document selection = mount everything, bounded by user action). Find needs no pin ([P07]). Streaming rows are bottom-anchored and in-window under `followBottom`; unmeasured rows force suspension ([P02]), which covers every remaining "must stay mounted" case conservatively.

**Implications:** permission-dialog/control-bar rows anchor to the region, not to cells (verified: `tug-control-bar-region` wraps the list), so they need no pin; Step 6's selection app-test is the behavioral proof.

#### [P05] Pixel margins with mount/retain hysteresis in pure window math (DECIDED) {#p05-hysteresis}

**Decision:** Extend `computeWindow` with `mountMarginPx` (default: 1 viewport height), `retainMarginPx` (default: 2 viewport heights), and a `prevRange` input: rows inside the mount margin enter the window; rows already mounted leave only when beyond the retain margin. Cell-count `overscanCount` remains for the legacy windowed path.

**Rationale:** cell-count overscan thrashes on tall transcript rows; hysteresis prevents mount/unmount oscillation at the boundary; a pure-function extension keeps the math drop-in testable (bun unit tests — real code, no DOM).

**Implications:** `ComputeWindowInput` grows optional fields; existing callers are unaffected (defaults preserve current behavior).

#### [P06] Restore-churn cap (E1b) is deferred behind a live decision gate (DECIDED) {#p06-churn-gate}

**Decision:** E1 ships without progressive restore mounting. After E1 lands, read the live instance: if the post-restore footprint spike persists as dirty pages despite eviction unmounting the settled rows (the measured failure mode: ~550MB reclaimed only by a critical purge), E1b (batched restore traversal: mount ~40 rows per idle slice → measure → evict) becomes the next recipe.

**Rationale:** eviction may make the spike self-healing (unmounted rows become garbage; JSC GC + bmalloc scavenger return pages under allocation pressure) — measure before building. The design doc's batch shapes section remains the E1b blueprint.

#### [P07] Find requires no pinning or DOM presence (DECIDED) {#p07-find-store-side}

**Decision:** No find-related pin. The Find route counts and orders matches over `transcript-search-index` (store-side, built for windowed rendering); painting resolves DOM ranges for mounted rows only; reveal navigates via `scrollToIndex` (exact under all-measured heights, [P02]) and decorates on `onRenderedRangeChange` (already wired: `handleFindRenderedRangeChange`).

**Implications:** the Step 6 find app-test asserts reveal-into-evicted-region lands the match visible below the stuck sticky header (standing reveal gotcha).

#### [P08] Diagnostic surface is DOM attributes, no new globals (DECIDED) {#p08-diag}

**Decision:** The scroller root publishes `data-evict-active` ("" when eviction is rendering a windowed slice) and `data-evict-fallbacks` (count of suspension ticks since mount) — DOM-published diagnostics ([L06]-style, no React state), readable by at9996 evalJS and `/api/eval` probes.

#### [P09] Leading content moves above the top spacer and joins the offset math (DECIDED) {#p09-leading-content}

**Decision:** Step 2 reorders the render return so the `leadingContent` wrapper (`.tug-list-view-leading` — the transcript's Z0 `SessionTranscriptTopRow`) sits **above** the top spacer, and every offset-computed `scrollTop` path (`makeAnchorResolver`, `scrollToIndex`'s unrendered-target branch, any `indexForOffset` consumer) adds the leading wrapper's measured height (`offsetHeight` read at call time; 0 when absent).

**Rationale:**
- Vet finding F1: today's render order is ring → **top spacer** → leading content → window cells → bottom spacer. Unobservable in inline mode (spacer 0px), but with a grown top spacer Z0 would paint mid-transcript above the first mounted row — a visible I-1 break.
- The offset paths compute from `heightIndex.offsetForIndex(...)`, which covers rows only; without the leading height every computed landing is short by Z0's height. The two-pass `scrollToIndex` correction may absorb the landing error but cannot fix the DOM order.

**Implications:**
- The reorder is byte-identical in inline mode (spacer is 0 — Z0's visual position is unchanged), so no visible change ships to non-evict consumers.
- Step 6's far-scroll test asserts Z0 renders first at scroll-to-top; the reveal tests assert landing accuracy (don't rely on the two-pass correction silently working).

---

### Deep Dives {#deep-dives}

#### Existing machinery inventory (what E1 reuses, verbatim) {#machinery-inventory}

All in `tugdeck/src/components/tugways/`:

- `tug-list-view.tsx` — `inline` prop (mounts all rows; the transcript's mode), `offscreenSkip` prop (cv + exact `contain-intrinsic-size` stamping from the shared cell `ResizeObserver`; stamp code path also handles re-earning stamps after invalidation), the width-observer that strips stamps on scroller width change, `scrollTick` reducer (render-time re-window driver), rAF-coalesced flush (`pendingFlushRef`), front-insert compensation (`detectPrepend`, `prependScrollAdjustment`, `heightIndexRef.current.shift`) gated to `inline`, batch freeze + settle handshake (`batchLoading`, `isScrollBatteryFrozen`, `onFirstSettle`), the selection/focus pin block (gated `if (inline === true) return;` today), `pinnedRangeRef`, cell wrappers carrying `data-tug-list-cell-index` registered in `cellElementMapRef`, imperative handle (`scrollToIndex` with a rendered-element branch and an offset-computed branch), `onRenderedRangeChange`.
- `internal/list-view-window.ts` — `computeWindow` (pure; contiguous slice + spacer heights + `pinnedRange` clamp-outward) and `offsetForIndex`.
- `internal/list-view-height-index.ts` — `HeightIndex` (`get`/`set`/`shift`/`clear`), populated only by real ResizeObserver measurements.
- `cards/session-card-transcript.tsx` — passes `inline`, `offscreenSkip`, `followBottom`, `batchLoading` (raised across restore replay, load-previous brackets, and post-reveal settle), `onFirstSettle`, `pageByEntry`, `interactive={false}`, `onRenderedRangeChange={handleFindRenderedRangeChange}`; `FindTargetRegistryContext`; jump-to-bottom; the Z0 load overlay.
- `lib/transcript-search-index.ts` — store-side find index; its header documents the windowed-rendering contract E1 restores.

#### Why the transcript left windowing, and why that objection is gone {#windowing-history}

The `inline` prop's own JSDoc records the history: windowed rendering relied on `estimatedHeightForKind` for unrendered cells, and each first-time measurement shifted `scrollHeight` by (measured − estimate) — the relaunch "bounce" and near-bottom jitter. `inline` fixed it by mounting everything (heights all real before interaction) at the cost that is now S9's bill. E1 keeps inline's property (all heights real) and windowing's property (viewport-sized DOM) by ordering them: mount-all first (restore), evict after measurement. The `estimatedHeightForKind` fallback still exists for the legacy windowed path but is unreachable in eviction mode ([P02]) — and must be: the transcript registers **no** `estimatedHeightForKind`, so the legacy fallback is `DEFAULT_ESTIMATED_HEIGHT = 60` px against rows that average far taller. Any estimate leak wouldn't be subtle drift; it would be catastrophic geometry.

#### Why an index-keyed ledger is safe: the data-source mutation model {#mutation-model}

`HeightIndex` is keyed by flat index, which is only sound because `SessionTranscriptDataSource`'s mutation model never reuses an index for a different row outside the mounted window (vet finding F2). Verified model: **committed turns are append-only** (the `RowSlot` projection walks committed messages in order; nothing removes or reorders them); **ghost/queued/in-flight churn is tail-only** (ghost rows for `queuedSends` and the `activeTurn`'s rows live after all committed turns, and under `followBottom` the tail is in-window — mounted, so any index reuse there is re-measured by the ResizeObserver on the spot before it can pollute spacer math); **prepends** (load-previous) go through `detectPrepend` → `heightIndex.shift(added)`, preserving alignment. Stale entries past a shrunk `itemCount` are documented harmless in `list-view-height-index.ts` (`computeWindow` walks `[0, itemCount)`). A future data-source change that removes or reorders **committed** rows mid-list would silently misalign every measurement below it — Step 4 records this as a verified invariant so that change knows what it breaks.

#### The heap mechanics this plan banks on {#heap-mechanics}

Unmounting a row releases: React fibers + props/vdom, DOM elements, and WebCore render objects + computed styles (the render tree drops with the element). The store's row models stay (small, honest — I-3). Measured grounding: whole-page text is 0.7MB; 64k mounted transcript nodes; the live core is ~730MB. The arithmetic estimate for the mounted share is 300–400MB — an estimate, which is why [P06] gates E1b on a live read instead of assuming.

---

### Specification {#specification}

**Spec S01: `evictOffscreen` prop contract** {#s01-evict-prop}

- New optional boolean on `TugListViewProps`, default false; valid only with `inline` (dev-warn otherwise). When active and the activation predicate ([P02]) holds, the render path uses the hysteresis window ([P05]) with a **measured-only** height accessor and renders: top spacer → window cells → bottom spacer (the legacy windowed JSX shape) while keeping ALL inline-mode machinery live (front-insert compensation, batch freeze, followBottom, cv stamping on mounted cells). When inactive or suspended, renders exactly today's inline output.
- The transcript is the only E1 consumer; the prop is public TugListView API per [L09]/[L19] (mechanism in the component, policy in the consumer).

**Spec S02: activation predicate** {#s02-activation}

`evictionActive = evictOffscreen && inline && !batchLoading && ledgerCoveredOutsideWindow`, where `ledgerCoveredOutsideWindow` is computed during the window derivation: every index outside `[firstIndex, lastIndex)` ∪ pins has `heightIndex.get(index) !== undefined`. A false predicate renders full inline and bumps the `data-evict-fallbacks` counter ([P08]) — except the `batchLoading` case, which is the ordinary loading state, not a fallback.

**Spec S03: hysteresis window signature** {#s03-hysteresis}

`computeWindow` gains optional `mountMarginPx?: number`, `retainMarginPx?: number`, `prevRange?: {first: number; last: number} | null`. Semantics: visible range extends by `mountMarginPx` on both ends to form the mount range; a row in `prevRange` but outside the mount range stays in the window unless also outside the `retainMarginPx` range. `pinnedRange` clamp applies last. Omitted margins → legacy `overscanCount` behavior (backward compatible). Pure; unit-tested including oscillation (alternating scrollTop at a boundary must not alternate the range).

**Spec S04: diagnostic attributes** {#s04-diag}

On the scroll container: `data-evict-active` present iff the current commit rendered a windowed slice; `data-evict-fallbacks="<n>"` counts suspension ticks ([P02]) since mount. Written via ref post-commit (DOM write, no React state). Read by the at9996 cell and `/api/eval` probes. Not styling hooks — never referenced from CSS.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| window slice (first/last, spacer heights) | structure (derived) | render-time derivation from scrollTop + HeightIndex; re-derived on `scrollTick` | [L24], [L05] |
| `HeightIndex` (the ledger) | local-data | ref (`heightIndexRef`), written in ResizeObserver callbacks | [L04], [L07] |
| `pinnedRange` | local-data | ref + direct DOM observation (`selectionchange`/`focusin`) | [L22], [L23] |
| cv stamps (`contain-intrinsic-size`, `data-cv-ready`) | appearance | DOM attribute/style writes from the observer | [L06] |
| width epoch / suspension | structure (derived) | ledger wipe in the width observer → predicate re-derives | [L24] |
| `data-evict-active` / `data-evict-fallbacks` | appearance (diagnostic) | post-commit ref DOM writes | [L06] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/components/tugways/internal/__tests__/list-view-window-hysteresis.test.ts` | unit tests for Spec S03 (pure math; bun test) |
| `tests/app-test/at0330-transcript-eviction.test.ts` | Step 6 behavioral suite (at0330 verified free — highest existing is at0320) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `ComputeWindowInput.mountMarginPx/retainMarginPx/prevRange` | fields | `internal/list-view-window.ts` | Spec S03; optional, defaults preserve legacy behavior |
| `HeightIndex.measuredCount()` (or `coversRange(first, last)`) | method | `internal/list-view-height-index.ts` | cheap coverage check for Spec S02 |
| `TugListViewProps.evictOffscreen` | prop | `tug-list-view.tsx` | Spec S01 |
| eviction render branch + activation predicate + fallback counter | logic | `tug-list-view.tsx` | [P01], [P02], Spec S02/S04 |
| pin-machinery gate change | logic | `tug-list-view.tsx` | enable when `evictOffscreen` active ([P04]) |
| width-observer ledger epoch | logic | `tug-list-view.tsx` | extend the existing stamp-wipe observer to also clear `HeightIndex` in evict mode ([P03]) |
| `evictOffscreen` pass-through | prop use | `cards/session-card-transcript.tsx` | policy lives in the consumer |
| `AT9996_EVICT` cell | test cell | `tests/app-test/at9996-anim-island-lab.test.ts` | List L01 budgets; A/B via env knob |

---

### Documentation Plan {#documentation-plan}

- [ ] `transcript-dom-eviction.md`: note the [P01] spacer refinement and the [P03] retirement of the stale-but-real compromise (one short dated addendum; the invariants stand).
- [ ] `aug01-perf-brief.md` §F-D: Step 7 records the live exit numbers and the [P06] E1b decision.
- [ ] JSDoc: `evictOffscreen` prop doc (Spec S01 content) beside the existing `inline`/`offscreenSkip` docs; update the transcript's prop comment block (Step 4 task).

---

### Test Plan Concepts {#test-plan-concepts}

**List L01: eviction cell budgets (weight 500)** {#l01-budgets}

- mounted cells per card ≤ `ceil((viewportHeight + 2·retainMarginPx) / minRowHeight) + pinAllowance` computed by the cell from the live knobs (with the [P05] defaults and weight-500 row heights this lands ≈ 25; compute, don't hardcode, so margin tuning can't silently invalidate the assertion) — while dataSource rows ≥ 500
- mounted transcript-region nodes ≥ 60% below same-weight inline baseline (two runs, `AT9996_EVICT=0/1`), and ≤ 25k/card absolute
- full-range scripted scroll: |ΔscrollHeight| ≤ 2px, `data-evict-fallbacks` unchanged (0 expected)
- typist meter within gate (q50 ≤ 7 / q90 ≤ 16 / q99 ≤ 29)

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** | Spec S03 window math (margins, hysteresis, pins, no-oscillation) | Step 1 |
| **Integration (lab)** | at9996 eviction cell budgets + typist gate | Steps 5, 7 |
| **App-test (behavioral)** | far-scroll fidelity, find-reveal into evicted region, selection pin, load-previous hold, expand round-trip | Step 6 |
| **Live instance** | footprint, dual ledger, purge recovery, kb ledger | Step 7 handoff |

#### What stays out of tests {#test-non-goals}

- jsdom/mock-store render tests — banned pattern; all behavioral proof drives the real app.
- a11y-tree snapshots for unmounted rows — accepted trade (Risk R02), not a regression to pin.
- Restore-churn spike size — deliberately unasserted in E1; it is [P06]'s live decision gate, not a lab number.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** Commits on `main` are the user's act; present each step's diff + checkpoint results and stop. (On a dash worktree, `tugutil dash commit` per the dash skill.)

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Hysteresis window math + ledger coverage API | done | `f74ff0a9a` |
| #step-2 | `evictOffscreen` mode in TugListView | done | `ccce589b7` (live smoke folded into #step-4) |
| #step-3 | Pins, width epoch, prepend continuity | done | `303423262` (live smoke folded into #step-4) |
| #step-4 | Transcript adoption | done | `89b3396cb` |
| #step-5 | at9996 eviction cell + typist gate | done | `468697b74` (found + fixed the row-gap spacer defect) |
| #step-6 | Behavioral app-test suite | done | `43bba8491` |
| #step-7 | Integration checkpoint + live handoff | lab done, live pending | build + suites green; the live reads (footprint, dual ledger, purge recovery) wait on the user's relaunch |

#### Step 1: Hysteresis window math + ledger coverage API {#step-1}

**Commit:** `tugdeck(evict): pixel-margin hysteresis in computeWindow + HeightIndex coverage API`

**References:** [P05] hysteresis margins, [P02] activation predicate, Spec S02, Spec S03, (#machinery-inventory)

**Artifacts:** extended `ComputeWindowInput`/`computeWindow`; `HeightIndex.measuredCount()`/`coversRange`; unit test file.

**Tasks:**
- [ ] Add `mountMarginPx`/`retainMarginPx`/`prevRange` to `computeWindow` per Spec S03; legacy calls (omitted fields) byte-identical behavior.
- [ ] Add the coverage check to `HeightIndex`, building on the existing `has(index)` (the class already provides `has`/`delete`/`size` and an opt-in Fenwick `prepare()` cache — an O(range) `has`-walk per render is fine at transcript scale, ~500–1,000 rows; note `prepare()` exists if the per-render O(n) walks ever surface in a profile).
- [ ] Unit tests: margin extension, retain hysteresis (row stays until beyond retain), no-oscillation under alternating scrollTop, pin clamp composed with margins, empty/degenerate inputs.

**Tests:** the new unit file passes under `bun test`.

**Checkpoint:**
- [ ] `cd tugdeck && bun test list-view-window` green; existing list-view unit tests untouched and green.

---

#### Step 2: `evictOffscreen` mode in TugListView {#step-2}

**Depends on:** #step-1

**Commit:** `tugdeck(evict): evictOffscreen mode — windowed slice + spacers under inline, measured-only, suspension fallback [L24][L05][L06]`

**References:** [P01] windowed reuse, [P02] activation, [P08] diag, [P09] leading content, Spec S01, Spec S02, Spec S04, (#state-zone-mapping, #windowing-history)

**Artifacts:** the mode branch in `tug-list-view.tsx`; diag attributes; leading-content reorder.

**Tasks:**
- [ ] Add the `evictOffscreen` prop (Spec S01); dev-warn if set without `inline`.
- [ ] In the window decision (the `inline === true ? fullRange : computeWindow(...)` branch), add the eviction case: when the activation predicate (Spec S02) holds, call the hysteresis `computeWindow` with a **measured-only** accessor (no `estimatedHeightForKind` fallback — unmeasured outside window+pins ⇒ predicate already failed) and render spacers + slice via the legacy windowed JSX shape; otherwise render full inline and (if failure was ledger coverage, not `batchLoading`) bump the fallback counter.
- [ ] Keep every inline-mode subsystem live in the mode: batch freeze/settle, followBottom pin, cv stamping for mounted cells, `onRenderedRangeChange` reporting the slice.
- [ ] Post-commit ref writes for `data-evict-active`/`data-evict-fallbacks` (Spec S04).
- [ ] Verify `scrollToIndex`'s unrendered-target branch uses the measured accessor (exact offsets) in the mode.
- [ ] [P09]: move the `.tug-list-view-leading` wrapper above the top spacer (byte-identical in inline mode — spacer is 0), and add the leading wrapper's `offsetHeight` to every offset-computed `scrollTop` path (`makeAnchorResolver`, `scrollToIndex` unrendered branch, `indexForOffset` consumers).

**Tests:** `bunx vite build` clean (build-only step; behavior lands in Steps 5–6).

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build` green; a debug-instance smoke (HMR) with a hand-toggled `evictOffscreen` on the transcript shows `data-evict-active` present, mounted cell count ≈ window size, and identical visuals.

---

#### Step 3: Pins, width epoch, prepend continuity {#step-3}

**Depends on:** #step-2

**Commit:** `tugdeck(evict): enable selection/focus pins for evict mode; ledger width epoch; prepend hold [L22][L23]`

**References:** [P03] width invalidation, [P04] pinning, Risk R01, (#q03-selection, #machinery-inventory)

**Tasks:**
- [ ] Change the pin-machinery gate from `if (inline === true) return;` to run when `evictOffscreen` is active (stays off for plain inline).
- [ ] Extend the width-observer (the cv stamp-wipe) to also clear the `HeightIndex` when in evict mode — suspension follows automatically from the coverage predicate; re-activation on re-measure ([P03]).
- [ ] Confirm front-insert compensation (`detectPrepend` path) executes in the mode (it is `inline`-gated — evict is an inline sub-mode; verify the guard's exact condition) and that `heightIndex.shift` composes with the coverage counter.

**Tests:** unit-level where pure (shift + coverage counter); behavioral proof deferred to Step 6.

**Checkpoint:**
- [ ] `bunx vite build` green; debug-instance smoke: make a selection, scroll far away, selection survives (pin visible in mounted-cell count); resize the pane — eviction suspends (`data-evict-active` drops) then re-arms.

---

#### Step 4: Transcript adoption {#step-4}

**Depends on:** #step-3

**Commit:** `tugdeck(evict): session transcript opts into evictOffscreen [L09][L19]`

**References:** [P07] find store-side, Spec S01, (#machinery-inventory)

**Tasks:**
- [ ] Pass `evictOffscreen` from `session-card-transcript.tsx` (beside the existing `inline`/`offscreenSkip` props; update the adjacent comment block to describe the eviction contract).
- [ ] Walk the reveal paths against the mode: find-reveal (`FindTargetRegistry.resolve` → unfold → `scrollToIndex` → `handleFindRenderedRangeChange` decorates on mount), jump-to-bottom, `pageByEntry`, restore anchor placement (all post-settle, eviction already active).
- [ ] Confirm the load overlay / `batchLoading` bracket ordering: eviction must not activate mid-replay (Spec S02 covers it; verify the transcript's `batchLoading` derivation includes load-previous and post-reveal settle — it does: `loadActive || settlingAfterLoad`).
- [ ] Verify the (#mutation-model) invariant against the current `SessionTranscriptDataSource`: no code path removes or reorders **committed** rows mid-list (ghost/queued/in-flight churn is tail-only; prepends shift). Record the finding in the step's commit message so a future data-source change knows what it would break.

**Tests:** behavioral suite is Step 6; this step's proof is the smoke + build.

**Checkpoint:**
- [ ] `bunx vite build` green; debug instance: resumed session shows identical transcript, `data-evict-active` present after settle, mounted cells ≈ window, find navigates into an evicted region correctly.

---

#### Step 5: at9996 eviction cell + typist gate {#step-5}

**Depends on:** #step-4

**Commit:** `tugdash(evict): AT9996_EVICT cell — mounted-cell/node budgets, scroll continuity, typist A/B`

**References:** [Q05] budgets, List L01, Spec S04, (#test-categories)

**Tasks:**
- [ ] New `AT9996_EVICT=1` cell in `tests/app-test/at9996-anim-island-lab.test.ts` (foreground tier, per the stall/typist precedent): weight-seeded 3 cards, read budgets per List L01 via evalJS (≤ 4KB payloads — the RPC wedge rule), scripted full-range scroll with scrollHeight-drift and fallback-counter assertions, A/B node census via `AT9996_EVICT=0/1`.
- [ ] Run the typist gate (`AT9996_TYPIST=1 AT9996_TYPIST_WEIGHT=500`) with eviction live; record the numbers in the brief.

**Tests:** the cell itself.

**Checkpoint:**
- [ ] `AT9996_EVICT=1 just app-test tests/app-test/at9996-anim-island-lab.test.ts` green with budget numbers printed; typist within gate.

---

#### Step 6: Behavioral app-test suite {#step-6}

**Depends on:** #step-4

**Commit:** `tugdash(evict): at03xx transcript-eviction behavioral suite (@covers tug-list-view, session-card-transcript)`

**References:** [P04] pinning, [P07] find, Risk R01, Risk R03, (#test-non-goals)

**Tasks:**
- [ ] New app-test file `tests/app-test/at0330-transcript-eviction.test.ts` (at0330 verified free — highest existing is at0320; `@covers` → `tug-list-view.tsx`, `session-card-transcript.tsx`): far-scroll fidelity (thumb-drag to top, content correct, no blank rows in-viewport, **and the Z0 top row renders first at the very top — the [P09] assertion**); find-reveal into an evicted region (match visible BELOW the stuck sticky-header bottom — the standing reveal gotcha; assert landing accuracy rather than relying on the two-pass correction); expand/collapse round-trip on a block near the window edge; selection pin (select, scroll away, selection intact); load-previous viewport hold (Risk R01).
- [ ] `just app-test-covers-check` passes; run the F-A(1) regression picks too (at0191, at0208, at0202, at0271, at0216) since no `@covers` resolves CSS-only surfaces.

**Tests:** the suite itself.

**Checkpoint:**
- [ ] `just app-test tests/app-test/<new-file>` green; `just app-test-changed` green (contention-class failures at0140/at0175/at0272 excepted per standing rule).

---

#### Step 7: Integration checkpoint + live handoff {#step-7}

**Depends on:** #step-5, #step-6

**Commit:** `N/A (verification only)`

**References:** [P06] churn gate, (#success-criteria), brief §F-D exit

**Tasks:**
- [ ] `bunx vite build`; full selective sweep green; typist numbers recorded.
- [ ] Ask the user to rebuild + relaunch. On the fresh instance: `footprint <WebContent-pid>` (find via `lsof -nP -iTCP -sTCP:LISTEN | grep tugcast`, release port 55348); arm `diag/deck-probes/dual-arm.js` via `/api/eval` and watch 5+ minutes for the 30s train; `notifyutil -p org.WebKit.lowMemory` once and read recovery-pair size; kb ledger during the user's real typing.
- [ ] Record the [P06] decision: restore-spike persistence → E1b go/no-go. Update the brief's §F-D with the live numbers and the Step Status Ledger here.

**Checkpoint:**
- [ ] Success criteria (#success-criteria) each checked with a number, against the LIVE instance — never lab numbers alone.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** The session transcript renders through `evictOffscreen` — viewport-sized mounted DOM at exact measured heights, pixel-identical, with the S9 exit measured on the user's live instance.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Eviction active on the live release deck (`data-evict-active` present post-settle on session cards) with zero suspension ticks in steady use (verification: `/api/eval` read of Spec S04 attributes)
- [ ] List L01 budgets green in the at9996 cell; typist gate held
- [ ] Live instance: footprint < 700MB steady, and (train absent over 5+ min) OR (purge recovery pairs < 50ms) — §F-D's exit
- [ ] Step 6 suite green; `just app-test-covers-check` green; `bunx vite build` green
- [ ] [P06] decision recorded in the brief (E1b go/no-go with the live footprint reading)

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] E1b — batched restore traversal (gated by [P06])
- [ ] E2 — intra-entry block-run eviction for whale rows ([Q06])
- [ ] F-A(3b) — occlusion culling for stacked cards (graphics)
- [ ] Retire `estimatedHeightForKind` from the legacy windowed path if the gallery migrates to measured-only

| Checkpoint | Verification |
|------------|--------------|
| Build | `cd tugdeck && bunx vite build` |
| Unit | `cd tugdeck && bun test list-view-window` |
| Lab budgets | `AT9996_EVICT=1 just app-test tests/app-test/at9996-anim-island-lab.test.ts` |
| Typist gate | `AT9996_TYPIST=1 AT9996_TYPIST_WEIGHT=500 just app-test tests/app-test/at9996-anim-island-lab.test.ts` |
| Behavioral | `just app-test tests/app-test/<at03xx-transcript-eviction>.test.ts` + `just app-test-changed` |
| Live exit | `footprint <pid>`, dual ledger, `notifyutil -p org.WebKit.lowMemory`, kb ledger — on the user's instance |
