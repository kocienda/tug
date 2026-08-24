<!-- devise-skeleton v4 -->

## Imposer Improvements — Stealth-Eviction Fix and the Space Allocator {#imposer-improvements}

**Purpose:** Fix the intermittent "imposed cards drift to slightly different sizes and positions" defect (a bare click on a resize handle silently evicts a pane from its slot), then teach the imposer to treat the pinned Lens's width as a flexible quantity — the **space allocator** — so that at arrangement-changing moments the deck chooses a Lens width that makes imposed cards tile with clean seams instead of small gaps or small overlaps.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | kocienda |
| Status | implemented |
| Target branch | main |
| Last updated | 2026-07-31 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The layout imposer (`tugdeck/src/lib/layout-imposer.ts`) places imposed panes by a pure rule: a pane in slot `k` of an `N`-slot imposition sits at `k/(N−1) × max(0, band − paneWidth)` from the band's left edge, where the band is the canvas minus the pinned Lens's inset. Two consequences follow. First, any pane that silently *stops* being imposed while remaining pixel-identical will drift apart from the chain the next time the canvas or Lens geometry changes — and exactly that happens today: the resize gesture releases an imposed pane from its slot **at pointer-down** with no click threshold, so a zero-travel click on a resize handle (which extend 4px *outside* the frame, into the 5px imposition gap between adjacent cards) commits the pane as a free pane at its measured rect. This is the observed intermittent drift between Session and Text File cards.

Second, nothing in the system can make seams come out even: card widths are pane-owned and the Lens width is user-set, so the leftover slack shows up as small gaps (band slightly too wide) or small overlaps (band slightly too narrow) between adjacent imposed cards. The one number that can absorb the residual without touching any doctrine — panes own their widths [L09], appearance flows through CSS [L06], positions depend on nothing but the pane's own width — is the Lens width. The space allocator computes, at a small set of explicit moments, the Lens width (within ±10% of the user's preferred width) that makes adjacent imposed cards land exactly one imposition gap apart, and reverts to the preferred width when no in-range solution exists.

#### Strategy {#strategy}

- Land the resize click-threshold fix first, as its own commit: it is independent, and it preserves the width-uniformity of imposed panes that makes the allocator's exact solve reachable in practice.
- Keep the allocator a **pure, closed-form solver** in `layout-imposer.ts`, unit-tested beside `imposeRect` as its numeric twin. No iteration, no DOM.
- Reuse existing plumbing rather than adding state: the persisted "preferred" width already exists (`lensStore.widthPx`), the live width already flows through `pane.size.width` → `LENS_WIDTH_PROPERTY` → every CSS expression. The allocator writes only `pane.size.width`; the serialization blob does not change.
- Trigger re-tunes at exactly three moments — a Layouts-section pick (kind, side, re-pin), a manual window resize, an OS-driven window resize — the last two via one debounced observer that fires only after the resize settles. Live-resize behavior is unchanged (CSS `calc()` continues to absorb it with zero JavaScript).
- Animate re-tunes through the existing settle FLIP by adding the Lens width to `arrangementSignature`.
- Never re-tune from a slot assignment, slot eviction, imposed-card close, or Lens edge drag: the user must never feel the deck changing out from under them, and a single card is not enough to trigger a re-allocation.

#### Success Criteria (Measurable) {#success-criteria}

- A pointer-down/pointer-up on a resize handle of an imposed pane with pointer travel < 3px leaves `pane.slot` defined and the frame's `data-imposed` attribute present, and the pane still tracks a subsequent arrangement change (app-test asserts the post-change frame rect equals `imposeRect`'s prediction).
- A real resize drag (travel ≥ threshold) still evicts the slot, exactly as today (app-test asserts).
- After choosing an N-up arrangement with ≥2 occupied slots whose in-range solve exists, the seam between each pair of adjacent imposed cards equals `IMPOSITION_GAP_PX` ± 1px, and the Lens frame width equals the solver's prediction (app-test measures both).
- When the solve falls outside ±10% of preferred, the Lens renders at the preferred width and seams are what the classic rule produces (app-test asserts no partial correction).
- Re-clicking the already-active Cards option re-tunes: after a seam-disturbing slot assignment, the re-click restores exact seams when the solve is in range (app-test asserts; previously this gesture was a total no-op).
- `lensStore.widthPx` (the preferred width) is bit-identical before and after any number of re-tunes; only an explicit Lens edge drag changes it (app-test asserts).
- Solver unit tests pass: exact tiling for uniform widths and even strides, least-squares behavior for irregular occupancy, every engagement guard, the revert rule, and the `MIN_LENS_WIDTH_PX` floor.
- `bunx vite build` succeeds (production-bundle gate) and `just app-test-changed` passes.

#### Scope {#scope}

1. Click threshold for the pane resize gesture and the Lens deck-edge resize gesture (`tug-pane.tsx`).
2. The pure space-allocator solver in `layout-imposer.ts`, with unit tests.
3. Re-tune plumbing in `deck-manager.ts` for the Layouts-pick moment (kind change, side change, re-pin).
4. A debounced canvas ResizeObserver in `deck-canvas.tsx` for the manual/OS window-resize moments.
5. The Lens-width term in `arrangementSignature` so re-tunes cross via the settle FLIP.
6. App-tests for the eviction fix and the allocator's end-to-end behavior.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Re-tuning on slot assignment, slot eviction, or imposed-pane close (deliberate: a single card joining or leaving must not shuffle the Lens; a seam that goes ragged after imposing one more card stays ragged until the next layout pick or window resize — an accepted, named consequence).
- Re-tuning during or after a Lens edge drag (that gesture *states* a width; it resets the preferred width and the allocator stays out).
- Re-tuning at app launch / deck restore (the persisted allocated width was correct for the persisted window size; if the window comes back at a different size, the resize observer's post-initial observations cover it).
- Resizing imposed *cards* to equalize widths (panes own their widths [L09]; the allocator flexes only the Lens).
- Partial correction when the solve is out of range (revert to preferred, never clamp — a half-corrected gap reads as nothing).
- A TestHarness window-resize RPC (would allow end-to-end testing of the resize moments; recorded as a follow-on).

#### Dependencies / Prerequisites {#dependencies}

- None external. All work is in `tugdeck/`; app-tests follow the existing harness (`tests/app-test/_harness`).

#### Constraints {#constraints}

- **Warnings are errors** across the repo; `bunx vite build` must pass before the tugdeck work is called done (dev esbuild and the production rollup bundle can disagree).
- Tuglaws apply: state zones mapped below; no `localStorage` (the preferred width already persists via tugbank under `dev.tugtool.lens`); appearance changes via CSS/DOM, never React state [L06]; external state via stores + `useSyncExternalStore` [L02]; registrations events depend on in `useLayoutEffect` [L03].
- App-tests: selective runs only (`just app-test-changed`); every new test carries `@covers` lines.
- Only the user commits on `main`; the implement skill commits only on a dash worktree.

#### Assumptions {#assumptions}

- `lensStore.widthPx` is set from exactly one production site — the Lens-pane size-change mirror in `DeckManager.movePane` — and that path is reached only by user gestures on the Lens (edge drag while pinned, free resize while unpinned). Verified during planning; Step 3 re-verifies before repurposing it as "preferred".
- The app-test harness has no native window-resize RPC (verified: nothing in `tests/app-test/_harness` or `tugapp/Sources/TestHarness` provides one), so the resize-moment path is covered at the unit/store level plus a directly-invoked re-tune, not by actually resizing the OS window.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan uses **explicit, named anchors** and **rich `References:` lines** in execution steps, per `tuglaws/devise-skeleton.md`:

- Every heading cited elsewhere carries an explicit `{#anchor}`; anchors are kebab-case, semantic, and free of phase numbers.
- Stable labels: plan-local design decisions `[P01]…`, open questions `[Q01]…`, specs `S01`, tables `T01`, risks `R01` — two digits, never reused. `[P##]` is distinct from the global `[D##]` namespace in `tuglaws/design-decisions.md`, which this plan cites by reference only.
- Execution steps cite plan artifacts by label and anchors in parentheses; **never line numbers**.
- Step dependencies use `**Depends on:** #step-N` anchor references.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Where does the preferred width live? (DECIDED) {#q01-preferred-width-home}

**Question:** Does "preferred Lens width" need a new persisted field (e.g. on the imposition record), or does an existing number already mean this?

**Why it matters:** Decides the serialization blob shape and whether deserialization needs migration work.

**Resolution:** DECIDED (see [P03]). `lensStore.widthPx` already *is* the preferred width — its module doc says "the preferred reopen width … a preference rather than live geometry" — and it is already written only from user gestures. No new persisted field; the blob is untouched.

#### [Q02] Does the ResizeObserver's initial observation trigger a re-tune? (DECIDED) {#q02-initial-observation}

**Question:** `ResizeObserver.observe()` fires an initial callback reporting the current size. Is that a "resize"?

**Why it matters:** Re-tuning on the initial observation means every app launch re-tunes, which violates "nothing changes out from under you" at the moment the user's restored deck appears.

**Resolution:** DECIDED (see [P07]). The first observation is swallowed; only subsequent size changes re-tune. Launch-onto-a-different-display re-tuning is a possible follow-on, not v1.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Re-tune feels like the deck moving on its own | med | low | Only three explicit moments; revert-not-clamp; settle FLIP animates the crossing | User reports surprise motion |
| Lens-width signature term arms spurious settle windows | low | med | Term only changes on re-tune commits and Lens-drag commits; a drag-commit settle is a no-op tween (First==Last) | at0294 regressions |
| Resize-moment path under-tested (no window-resize RPC) | med | med | Unit-test debounce + solver; app-test invokes the re-tune entry directly; follow-on RPC recorded | Flaky behavior on real resizes |

**Risk R01: Allocator fights the resize doctrine** {#r01-resize-doctrine}

- **Risk:** The deck deliberately observes no resizes ("the browser does the reflow" — `deck-canvas.tsx` span-insets note); adding an observer erodes that.
- **Mitigation:** One observer, debounced to fire only after quiet; it performs no layout math itself — it only asks the store to re-tune; the live-resize path stays 100% CSS.
- **Residual risk:** A second consumer could later hang work off the same observer; the module note added in Step 5 forbids that explicitly.

**Risk R02: Repurposing `lensStore.widthPx` breaks the reopen path** {#r02-reopen-width}

- **Risk:** `_createLensPane` opens the Lens at the persisted reopen width; if a re-tune ever leaked into `lensStore.setWidth`, preferred would silently become allocated.
- **Mitigation:** Re-tune commits write `deckState` directly and never route through `movePane`, so the mirror at the end of `movePane` cannot fire; a unit/app-test asserts `widthPx` is unchanged across re-tunes.
- **Residual risk:** A future refactor routing re-tunes through `movePane` would reintroduce the leak; the assertion test is the tripwire.

---

### Design Decisions {#design-decisions}

#### [P01] Resize gestures adopt the drag gesture's click threshold (DECIDED) {#p01-resize-click-threshold}

**Decision:** A resize gesture releases a derived pane (imposed card or pinned Lens) and commits geometry only after the pointer travels ≥ `DRAG_MOVE_THRESHOLD_PX` (3px); below the threshold the gesture is a click, commits nothing, and the pane keeps its slot or pin.

**Rationale:**
- The drag gesture already states the doctrine in code: "a derived pane is released by MOVING it, not by being touched" (`tug-pane.tsx`, `DRAG_MOVE_THRESHOLD_PX` doc and the `dragMoved` latch in `applyDragFrame`). Resize violating it is the root cause of the intermittent drift: `handleResizeStart` calls `releaseImposedFrame` at pointer-down and its `onPointerUp` unconditionally commits `onCardMoved(..., { evictSlot: true })`, even for zero travel.
- The edge handles (`styles/chrome.css`: `.n-e { right: -4px; width: 8px }` and friends) extend 4px outside the frame into the 5px imposition gap, so the seam between adjacent imposed cards is nearly wall-to-wall resize handle — an accidental zero-travel click there is easy and invisible (the evicted pane stays pixel-identical until the next canvas change).

**Implications:**
- `handleResizeStart` defers `releaseImposedFrame` to the first rAF frame past the threshold and gates all per-frame `frame.style` writes on the moved latch; a below-threshold pointer-up skips the commit entirely (for free panes too — the previous identical-rect commit was pointless).
- `handleLensResizeStart` gets the same latch for symmetry: a below-threshold click on the Lens's deck-edge handle skips its `onCardMoved` commit (which today re-commits the start width and needlessly pings the `lensStore` mirror).

#### [P02] The allocator is a pure closed-form least-squares solve in `layout-imposer.ts` (DECIDED) {#p02-pure-solver}

**Decision:** The space allocator is a pure function (`allocateLensWidth`, Spec S01) living beside `imposeRect`, computing the ideal band via a closed-form least-squares fit of adjacent seams to `IMPOSITION_GAP_PX`, and mapping it to a Lens width.

**Rationale:**
- Every seam is linear in the band width, so the least-squares optimum is a two-line closed form — no iteration, no measurement, no DOM. For uniform card widths and evenly spaced occupied slots (the common case) the fit is exact.
- `layout-imposer.ts` is already the pure geometry module ("no DOM, store, or React runtime imports"); the solver is the numeric twin of the placement rule and unit-tests the same way `imposeRect` does.

**Implications:**
- The solver takes numbers only (canvas width, kind, occupied slots + widths, preferred width); callers gather inputs.
- Card widths passed in must be **render** widths — floored at the stack size policy minimum, exactly as `TugPane.renderWidth` and `DeckCanvas.lensRenderWidth` floor them — or the solve would tile a chain that paints wider than computed.

#### [P03] Preferred = `lensStore.widthPx`; allocated = the Lens pane's `size.width` (DECIDED) {#p03-preferred-allocated-split}

**Decision:** The user's preferred Lens width is the number that already exists — `lensStore.widthPx` (tugbank-persisted, `dev.tugtool.lens/widthPx`) — and the allocated width is written into the Lens pane's `size.width` by re-tune commits. No new persisted field; `serialization.ts` is untouched.

**Rationale:**
- The split already exists in the codebase's own words: `lens-store/types.ts` — "pane `size.width` is the live width … this store owns the reopen width, which is a preference rather than live geometry."
- `lensStore.setWidth` has exactly one production call site — the Lens size-change mirror at the end of `DeckManager.movePane` — and `movePane` is reached only by user gestures. Re-tunes commit `deckState` directly (like `_reimpose` does) and never pass through `movePane`, so the preferred width cannot be contaminated by construction.
- Writing `pane.size.width` means zero render plumbing: `DeckCanvas.lensRenderWidth` → `LENS_WIDTH_PROPERTY` → the Lens pin, the band insets, and the frame width all already read it.

**Implications:**
- The layout blob incidentally persists the last allocated width in the Lens pane's `size.width` — which is correct behavior: on relaunch the window restores at its saved size, so the saved allocated width is the right one (see also #q02-initial-observation).
- The re-tune range is computed from `lensStore.getSnapshot().widthPx` at solve time.
- An unpinned (dragged-loose) or closed Lens disengages the allocator entirely.

#### [P04] Flex is ±10% of preferred, floored at `MIN_LENS_WIDTH_PX`; out-of-range solves revert to preferred (DECIDED) {#p04-flex-and-revert}

**Decision:** The allocator may choose any width in `[max(MIN_LENS_WIDTH_PX, round(0.9 × preferred)), round(1.1 × preferred)]`; if the ideal width falls outside, the Lens renders at the preferred width and the classic spread/overlap behavior stands.

**Rationale:**
- A ~20px seam error needs a ~40px band correction at the observed strides; ±10% of the 420px default preferred width (±42px) engages for exactly the small-residual cases and reverts for large slack.
- Reverting beats clamping: a half-corrected 100px gap reads as nothing, while the classic even spread at least looks intentional.

**Implications:**
- The allocated width is rounded to integer pixels (fractional widths are the same hygiene hazard Issue 1 removes).
- With no in-range solve the re-tune still *commits preferred* if the pane currently carries a stale allocated width, so leaving an arrangement's regime restores the user's number.

#### [P05] Re-tunes fire at exactly three moments (DECIDED) {#p05-three-moments}

**Decision:** The allocator runs at (1) a Layouts-section pick — kind change, Lens side change, or re-pin, (2) a settled manual window resize, (3) a settled OS-driven window resize. Slot assignment, slot eviction, imposed-pane close, Lens open/close, and Lens edge drag never re-tune.

**Rationale:**
- The excluded moments are the "out from under you" moments: a single card joining or leaving the chain must not move the Lens, and an edge drag is the user stating a width.
- Moments 2 and 3 are one mechanism (the canvas got a new size, gesture unknown), so one debounced observer covers both.

**Implications:**
- Moment 1 folds into the existing commits: `setImposition`'s kind branch and `_reimpose` (which `setImpositionLens` and `pinLens` both call). `setImposition(null)` (clearing, which freezes panes) does not re-tune.
- **Re-clicking the active kind counts as moment 1.** `setImposition`'s unchanged-kind path currently early-returns into `pinLens()`, which no-ops when the Lens is already pinned — a total no-op. That path must call `retuneLensAllocation()` before returning, so re-asserting the current layout re-tunes. This is also the manual recovery gesture for the excluded moments: seams that went ragged after a slot assignment are fixed by re-clicking the layout.
- A consequence accepted by name: seams that go ragged after a slot assignment stay ragged until the next moment fires — or until the user re-clicks the active layout (previous bullet).

#### [P06] The allocated Lens width joins `arrangementSignature` (DECIDED) {#p06-signature-term}

**Decision:** `arrangementSignature` (`deck-canvas.tsx`) gains a term for the Lens pane's width, so a re-tune-only change (the window-resize moments, where kind and slots are unchanged) arms the settle window and the frames cross by FLIP instead of cutting.

**Rationale:**
- The settle machinery is signature-driven; without the term, a moment-2/3 re-tune would write `LENS_WIDTH_PROPERTY` and every imposed frame would jump in one reflow.
- The term also changes on a Lens edge-drag commit, arming a settle whose tweens are no-ops (the property was live-updated during the drag, so First == Last for every frame) — accepted: the cost is ~300ms of held session notifications after a Lens drag.

**Implications:**
- at0294's "a bare raise arms no settle window" assertion still holds (raises change no width).
- The term must read the same floored render width the property carries, not the raw stored width, so a below-floor stored width can't flap the signature.

#### [P07] One debounced ResizeObserver, as a named exception to the no-resize-observation doctrine (DECIDED) {#p07-resize-observer}

**Decision:** `DeckCanvas` registers a single `ResizeObserver` on the frames' container that swallows its initial observation and, after ~200ms without further observations, calls the deck manager's re-tune entry. It does nothing else, and the module note says so.

**Rationale:**
- The doctrine ("the deck observes no resizes at all — the browser does the reflow") is about the *live* path, which stays pure CSS; the observer runs zero geometry code during the resize and one store call after it settles.
- ResizeObserver on the container (rather than a `window` resize listener) also catches host-side chrome changes that resize the canvas without a window event.

**Implications:**
- Registered in a `useLayoutEffect` with proper cleanup [L03]; the debounce timer lives in a ref (DOM/timer zone, not React state).
- The debounce constant (`RESIZE_RETUNE_QUIET_MS = 200`) lives beside `IMPOSITION_SETTLE_MS` in `layout-imposer.ts` so the tuning surface stays in one module.

---

### Deep Dives {#deep-dives}

#### The stealth eviction, mechanically {#stealth-eviction}

For the cold reader, the exact defect Step 1 removes. In `tugdeck/src/components/chrome/tug-pane.tsx`:

- `handleResizeStart` (the 8-handle pane resize): at pointer-down it runs `releaseImposedFrame(frame, resizeCanvasBounds)` whenever `derivedRef.current` is set (imposed pane or pinned Lens host frame). That helper measures `getBoundingClientRect()`, divides by `getTugZoom()`, writes the fractional result into `frame.style.left/top/width/height`, and clears the CSS pins. The gesture's `onPointerUp` then always calls `computeAndApplyResize` and commits `onCardMoved(id, r, size, released !== null ? { evictSlot: true } : undefined)` — no travel check anywhere.
- `DeckManager.movePane` receives that commit, deletes `pane.slot`, and stores the measured rect. From then on the pane renders in free mode (`position/size` from the store) while every still-imposed pane renders from CSS `calc()` over the live band. Any subsequent band change — window resize, Lens width change, a card joining the chain — moves the imposed panes and leaves the evicted one at its frozen rect: the "slightly different sizes and positions" symptom, intermittent because it needs the accidental handle click *plus* a later canvas change, and unreproducible because re-imposing the card erases the evidence.
- Contrast with the drag gesture in the same file: `handleTitleBarPointerDown`'s `applyDragFrame` latches `dragMoved` only past `DRAG_MOVE_THRESHOLD_PX`, releases the derived frame at that latch, and its `onPointerUp` returns early ("this was a click … nothing is committed") when the latch never set. Step 1 ports exactly this shape to both resize handlers.

Deferral safety: because no `frame.style` writes happen below the threshold, `releaseImposedFrame`'s measurement at latch time sees the identical rect it would have seen at pointer-down.

#### Allocator geometry {#allocator-geometry}

All quantities in layout px. With the Lens pinned at width `L` on either side and `G = IMPOSITION_GAP_PX`, the imposition band is `B = W − L − 3G` where `W` is the canvas width (`resolveSpan` insets `L + G` on the Lens side; `imposeStyle`/`imposeRect` inset one further `G` at each end). A pane of width `w` in slot `k` of an `N`-slot kind sits at `f(B − w)` from the band's left edge, `f = k/(N−1)`.

For occupied slots `k₁ < … < kₘ` (distinct; a slot stacking several panes counts once at its widest render width) with widths `w₁…wₘ`, the seam between neighbours `j` and `j+1` is `seamⱼ(B) = aⱼB + cⱼ` with `aⱼ = fⱼ₊₁ − fⱼ` and `cⱼ = fⱼwⱼ − fⱼ₊₁wⱼ₊₁ − wⱼ`. Minimizing `Σ(seamⱼ − G)²` gives the closed form:

```
B* = Σ aⱼ(G − cⱼ) / Σ aⱼ²          L* = W − 3G − B*
```

Sanity anchor (the motivating case): Five Up, occupied slots {0, 2, 4}, uniform `w = 800`, `G = 5` → `B* = 3w + 2G = 2410`, i.e. the band exactly fits three cards and two gaps; `L* = W − 2425`. Both directions are symmetric: gaps (band too wide) want the Lens to grow, overlaps want it to shrink.

Uniform-width, even-stride occupancy makes the fit exact; irregular occupancy (e.g. slots {0, 1, 4}) has no single-band exact tiling and the least-squares fit spreads the error — which then usually lands out of range and reverts, by design.

#### Why re-tunes bypass `movePane` {#retune-bypasses-movepane}

`movePane` ends with the Lens mirror: `if (sizeChanged && findLensPane(...)?.id === paneId) lensStore.setWidth(size.width)`. That mirror is what makes `widthPx` mean "the width the user chose" — so a re-tune must never route through it, or allocated would overwrite preferred (Risk R02). Re-tune commits therefore write `this.deckState` directly with the lifecycle ledger, in the style of `_reimpose`: `notifyCardWillResize`/`DidResize` for the Lens card and `notifyCardWillMove`/`DidMove` for every slotted pane (the band moves them all).

#### Test reachability of the resize moments {#resize-moment-testing}

The harness cannot resize the Tug.app window (no such RPC in `tests/app-test/_harness` or `tugapp/Sources/TestHarness`). Coverage strategy: the solver and range/revert logic are fully unit-tested; the observer's debounce-and-call wiring is small and inspectable; and the app-test drives the same public re-tune entry (`retuneLensAllocation`) the observer calls, asserting the commit, the FLIP settle, and the untouched preferred width. A native window-resize RPC is a roadmap follow-on that would upgrade this to true end-to-end.

---

### Specification {#specification}

**Spec S01: `allocateLensWidth`** {#s01-allocate-lens-width}

```ts
/** Everything the allocator reads, all numbers in layout px. */
export interface AllocatorInput {
  /** The canvas (frames' container) client width. */
  canvasWidth: number;
  /** The active kind; its slotCount defines the travel fractions. */
  kind: ImpositionKind;
  /** Distinct occupied slots, ascending, each with the widest RENDER width in that slot (floored at the stack size-policy min). */
  occupied: readonly { slot: number; width: number }[];
  /** The user's preferred Lens width (lensStore.widthPx). */
  preferredWidth: number;
  /** The hard floor (MIN_LENS_WIDTH_PX). */
  minWidth: number;
}

/**
 * The width the pinned Lens should render at: the closed-form least-squares
 * solve of Deep Dive #allocator-geometry, rounded to integer px, if it lands
 * inside [max(minWidth, round(0.9 × preferred)), round(1.1 × preferred)];
 * otherwise preferredWidth. Engagement guards — fewer than 2 occupied slots,
 * a non-positive solve denominator — also return preferredWidth.
 */
export function allocateLensWidth(input: AllocatorInput): number
```

Normative rules:
- The function is total: it never throws and always returns a finite positive width (preferred is the universal fallback).
- Callers, not the solver, decide engagement conditions that need deck knowledge: Lens open **and** pinned, `imposition.kind` defined. The solver only guards on its own inputs.
- `occupied` must be deduplicated by slot with per-slot max render width; the deck-manager helper that gathers it owns that rule.

**Table T01: Re-tune moments and their call paths** {#t01-moments}

| Moment | User gesture | Call path | Animation |
|--------|--------------|-----------|-----------|
| Layout pick (kind) | Click a Cards option in the Layouts section | `DeckManager.setImposition(kind)` folds the allocated width into its commit | Existing settle FLIP (kind term changed) |
| Layout re-assert (unchanged kind) | Re-click the already-active Cards option | `setImposition`'s unchanged-kind path calls `retuneLensAllocation()` before returning | Settle FLIP via the [P06] width term |
| Layout pick (side / re-pin) | Click Left/Right or any Layouts row with a floating Lens | `setImpositionLens` / `pinLens` → `_reimpose` folds it in | Existing settle FLIP |
| Window resize (manual or OS) | Drag the window edge; display change | Container `ResizeObserver` → 200ms quiet → `DeckManager.retuneLensAllocation()` | Settle FLIP via the [P06] width term |
| — excluded — | Slot assign/evict, imposed close, Lens open/close, Lens edge drag | none | — |

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| `resizeMoved` latch (per gesture) | appearance/gesture | closure variable in the pointer handlers, like `dragMoved` | [L06] |
| Allocated Lens width | structure | `deckState` pane `size.width`, committed by DeckManager, read via `useSyncExternalStore` | [L02] |
| Preferred Lens width | structure (persisted preference) | existing `lensStore` (`dev.tugtool.lens/widthPx`, tugbank) | [L02] |
| Live width during re-tune settle | appearance | `LENS_WIDTH_PROPERTY` + FLIP transforms, written to DOM | [L06] |
| ResizeObserver registration + debounce timer | structure wiring | `useLayoutEffect` + refs, cleanup on unmount | [L03] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tests/app-test/at0302-imposed-resize-click.test.ts` | Stealth-eviction regression (Step 1); renumber if at0302 is taken by then |
| `tests/app-test/at0303-imposer-space-allocator.test.ts` | Allocator end-to-end (Step 6); renumber if taken |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `AllocatorInput` | interface | `tugdeck/src/lib/layout-imposer.ts` | Spec S01 |
| `allocateLensWidth` | fn | `tugdeck/src/lib/layout-imposer.ts` | Spec S01, pure |
| `LENS_FLEX_FRACTION` | const (0.10) | `tugdeck/src/lib/layout-imposer.ts` | [P04] |
| `RESIZE_RETUNE_QUIET_MS` | const (200) | `tugdeck/src/lib/layout-imposer.ts` | [P07] |
| `retuneLensAllocation` | method | `tugdeck/src/deck-manager.ts` | Public entry for moment 2/3; no-op when disengaged or width unchanged |
| `_allocatedLensWidth` | private helper | `tugdeck/src/deck-manager.ts` | Gathers `AllocatorInput` (container width, occupied slots at render widths via `getStackSizePolicy`, `lensStore.getSnapshot().widthPx`, `MIN_LENS_WIDTH_PX`) |
| `setImposition` / `_reimpose` | modify | `tugdeck/src/deck-manager.ts` | Fold allocated width into their commits (moment 1) |
| `arrangementSignature` | modify | `tugdeck/src/components/chrome/deck-canvas.tsx` | [P06] width term |
| `handleResizeStart` / `handleLensResizeStart` | modify | `tugdeck/src/components/chrome/tug-pane.tsx` | [P01] threshold latch |

---

### Documentation Plan {#documentation-plan}

- [ ] Extend the `layout-imposer.ts` module note with a "space allocator" section (the band/seam math and the three moments).
- [ ] Amend the `deck-canvas.tsx` span-insets comment ("the deck observes no resizes at all") to name the settled-resize observer as the single scoped exception.
- [ ] Update the `DRAG_MOVE_THRESHOLD_PX` doc comment to say it now governs drag *and* resize.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** (`bun test`, tugdeck) | Solver math, range/revert, guards | Step 2 |
| **App-test** (real Tug.app) | Gesture behavior, end-to-end geometry, FLIP settle | Steps 1, 6 |
| **Build gate** | `bunx vite build` — production rollup bundle | Step 7 |

#### What stays out of tests {#test-non-goals}

- True OS-window-resize end-to-end — no harness RPC exists (#resize-moment-testing); the re-tune entry is driven directly instead.
- jsdom/mock-store render tests of `TugPane` — banned pattern; gesture behavior is covered by app-tests against the real app.
- Solver behavior under a floating or closed Lens — the deck-manager guards disengage before the solver runs; the guards are asserted, the solver isn't re-tested through them.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Resize click threshold — stop the stealth eviction | done | 5d32356ff |
| #step-2 | The space-allocator solver | done | f75f9bef8 |
| #step-3 | Re-tune plumbing: moment 1 (Layouts pick) | done | 3fe20b00b |
| #step-4 | Settled-resize observer: moments 2–3 | done | e4ddddaab |
| #step-5 | Settle FLIP for re-tunes (signature term) | done | e4ddddaab (folded with Step 4) |
| #step-6 | Allocator app-test | done | c6a152686 |
| #step-7 | Integration checkpoint | done | 49ce06493 |

#### Step 1: Resize click threshold — stop the stealth eviction {#step-1}

**Commit:** `tugdeck(imposer-resize-threshold): a click on a resize handle keeps the slot`

**References:** [P01] Resize click threshold, (#stealth-eviction, #success-criteria)

**Artifacts:**
- Modified `handleResizeStart` and `handleLensResizeStart` in `tugdeck/src/components/chrome/tug-pane.tsx`
- New app-test `tests/app-test/at0302-imposed-resize-click.test.ts`

**Tasks:**
- [ ] In `handleResizeStart`: add a `resizeMoved` latch mirroring `applyDragFrame`'s `dragMoved`. Do **not** call `releaseImposedFrame` at pointer-down; keep only the measurements that don't mutate (`getBoundingClientRect` snapshots, snap-rect snapshot). On the first frame where `hypot(pointer − start) ≥ DRAG_MOVE_THRESHOLD_PX`, set the latch, run `releaseImposedFrame` for derived panes, and seed `startLeft/startTop/startW/startH` from its result (free panes seed from stored `position`/`size` as today). Gate every `frame.style.left/top/width/height` write (in `applyResizeFrame` and `onPointerUp`) on the latch.
- [ ] In `handleResizeStart`'s `onPointerUp`: when the latch never set, clean up (remove `data-gesture`, release capture, clear guides) and return **without** calling `onCardMoved` — for derived and free panes alike.
- [ ] In `handleLensResizeStart`: same latch on pointer travel; a below-threshold pointer-up skips both the final `container.style.setProperty(LENS_WIDTH_PROPERTY, …)` and the `onCardMoved` commit.
- [ ] Update the `DRAG_MOVE_THRESHOLD_PX` doc comment (it now governs both gestures) and the `releaseImposedFrame` doc ("both gestures release … by converting it here" — now "at the moment the gesture becomes a move").
- [ ] Write `at0302-imposed-resize-click.test.ts` with `@covers tugdeck/src/components/chrome/tug-pane.tsx` and `@covers tugdeck/src/lib/layout-imposer.ts`. Follow `at0294-imposer-flip-settle.test.ts` for deck seeding (`seedDeckState`), state reading, and arrangement-change gestures. Scenario: seed a two-up deck with a pinned right Lens and a pane in each slot; `getElementBounds` a slotted frame; `nativeClick` on its east resize handle (right edge + 2px, vertical center — the handle spans `right: -4px; width: 8px`); assert the frame still carries `data-imposed` and the deck state still records `slot`; flip the Lens side and assert the frame's new rect matches `imposeRect`'s prediction (it still tracks the arrangement). Then the converse: a real drag on the same handle (nativeDrag well past 3px) evicts — `slot` gone, `data-imposed` gone.

**Tests:**
- [ ] at0302 (above): click keeps slot + tracks arrangement; drag still evicts.

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test tests/app-test/at0302-imposed-resize-click.test.ts`
- [ ] `just app-test-changed` (picks up at0294 via the shared `@covers`)

---

#### Step 2: The space-allocator solver {#step-2}

**Depends on:** #step-1

**Commit:** `tugdeck(imposer-space-allocator): closed-form lens-width solver in layout-imposer`

**References:** [P02] Pure solver, [P04] Flex and revert, Spec S01, (#allocator-geometry)

**Artifacts:**
- `AllocatorInput`, `allocateLensWidth`, `LENS_FLEX_FRACTION`, `RESIZE_RETUNE_QUIET_MS` in `tugdeck/src/lib/layout-imposer.ts`
- Unit tests in `tugdeck/src/lib/__tests__/layout-imposer.test.ts`
- The module-note "space allocator" section (#documentation-plan)

**Tasks:**
- [ ] Implement Spec S01 exactly: seam coefficients `aⱼ = fⱼ₊₁ − fⱼ`, `cⱼ = fⱼwⱼ − fⱼ₊₁wⱼ₊₁ − wⱼ`; `B* = Σaⱼ(G − cⱼ)/Σaⱼ²`; `L* = canvasWidth − 3·IMPOSITION_GAP_PX − B*`; round; range `[max(minWidth, round(0.9·preferred)), round(1.1·preferred)]`; revert to `preferredWidth` on any guard or out-of-range result.
- [ ] Guards inside the solver: `occupied.length < 2`, non-finite inputs, `Σaⱼ² ≤ 0` → preferred.

**Tests:**
- [ ] Exact-tiling anchor: `N=5`, slots `{0,2,4}`, `w=800`, `G=5` → `B* = 2410`, `L* = canvasWidth − 2425`; assert seams recomputed through `imposeRect` at the returned width are exactly `G`.
- [ ] Both directions: a canvas producing small gaps shrinks toward the gap by *growing* the Lens; small overlaps by shrinking it.
- [ ] Least-squares case: irregular occupancy `{0,1,4}` returns the closed-form optimum (hand-computed).
- [ ] Revert: solve outside ±10% returns preferred bit-exactly; floor: `0.9·preferred < MIN_LENS_WIDTH_PX` clips the low end of the range.
- [ ] Guards: single occupied slot, empty occupancy, NaN width → preferred.

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/lib/__tests__/layout-imposer.test.ts`

---

#### Step 3: Re-tune plumbing — moment 1 (Layouts pick) {#step-3}

**Depends on:** #step-2

**Commit:** `tugdeck(imposer-space-allocator): retune the lens width on layout picks`

**References:** [P03] Preferred/allocated split, [P05] Three moments, Table T01, Risk R02, (#retune-bypasses-movepane)

**Artifacts:**
- `_allocatedLensWidth` and `retuneLensAllocation` in `tugdeck/src/deck-manager.ts`; `setImposition` and `_reimpose` fold the allocated width into their commits

**Tasks:**
- [ ] `_allocatedLensWidth(panes, imposition): number | null` — returns `null` (disengaged) when the Lens pane is absent, `!isLensPinned(imposition)`, or `imposition.kind` is undefined; otherwise gathers `AllocatorInput`: `canvasWidth = this.container.clientWidth`, occupied slots deduplicated with per-slot **max render width** (each pane's `size.width` floored at `getStackSizePolicy` of its hosted cards' componentIds — mirror `DeckCanvas.lensRenderWidth`'s flooring), `preferredWidth = lensStore.getSnapshot().widthPx`, `minWidth = MIN_LENS_WIDTH_PX`; returns `allocateLensWidth(...)`.
- [ ] Fold into moment-1 commits: in `setImposition`'s kind branch (after slot clamping) and in `_reimpose`, compute the allocated width against the post-change panes/imposition and, when it differs from the Lens pane's current `size.width`, write it into that pane's `size` in the **same** `deckState` commit; extend the existing move ledger with `notifyCardWillResize`/`DidResize` for the Lens card. Never route through `movePane` (#retune-bypasses-movepane).
- [ ] `retuneLensAllocation(): void` — public entry for Step 4 and the re-assert path: computes `_allocatedLensWidth` against current state; no-op when disengaged or `|allocated − current| < 1`; otherwise commits with the `_reimpose`-style ledger (Lens resize + slotted-pane moves) and `scheduleSave()`.
- [ ] Re-assert path ([P05]): in `setImposition`'s unchanged-kind early return, call `retuneLensAllocation()` after `pinLens()` (both when `pinLens` re-pins and when it no-ops), so re-clicking the active Cards option re-tunes instead of doing nothing.
- [ ] Verify (and assert in at0303, Step 6) that `lensStore.widthPx` is untouched by these paths.

**Tests:**
- [ ] Covered by at0303 (Step 6) end-to-end; no mock-store unit tests (#test-non-goals).

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test-changed`

---

#### Step 4: Settled-resize observer — moments 2–3 {#step-4}

**Depends on:** #step-3

**Commit:** `tugdeck(imposer-space-allocator): retune after a settled canvas resize`

**References:** [P05] Three moments, [P07] Resize observer, [Q02] Initial observation, Risk R01, Table T01

**Artifacts:**
- ResizeObserver registration in `tugdeck/src/components/chrome/deck-canvas.tsx`; amended span-insets doctrine comment (#documentation-plan)

**Tasks:**
- [ ] In `DeckCanvas`, a `useLayoutEffect` observing `containerRef.current`: swallow the initial observation ([Q02]); on each subsequent observation reset a `RESIZE_RETUNE_QUIET_MS` timer (ref-held); on expiry call the deck manager's `retuneLensAllocation()`. Disconnect the observer and clear the timer on cleanup.
- [ ] Amend the span-insets comment: live resizes remain pure CSS; this observer is the single scoped exception, fires only after quiet, and must never grow additional work.

**Tests:**
- [ ] Behavioral coverage lands in at0303 via the direct `retuneLensAllocation` invocation (#resize-moment-testing); the wiring is checked by the existing at0294 staying green (no spurious settles at rest).

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test-changed`

---

#### Step 5: Settle FLIP for re-tunes — the signature term {#step-5}

**Depends on:** #step-3

**Commit:** `tugdeck(imposer-space-allocator): lens width joins the arrangement signature`

**References:** [P06] Signature term, (#success-criteria)

**Artifacts:**
- Modified `arrangementSignature` in `tugdeck/src/components/chrome/deck-canvas.tsx`

**Tasks:**
- [ ] Append a Lens-width term to `arrangementSignature`: the Lens pane's floored render width (the same number `lensRenderWidth` computes), empty when no pinned Lens. Keep the pane terms' sort untouched.
- [ ] Confirm against at0294's rules: a bare raise still changes nothing; a re-tune commit now arms the settle window and the frames cross transform-only.

**Tests:**
- [ ] at0294 stays green (`just app-test tests/app-test/at0294-imposer-flip-settle.test.ts`); at0303 (Step 6) asserts the re-tune crossing animates (container wears `data-imposer-settling` mid-window).

**Checkpoint:**
- [ ] `just app-test tests/app-test/at0294-imposer-flip-settle.test.ts`

---

#### Step 6: Allocator app-test {#step-6}

**Depends on:** #step-3, #step-4, #step-5

**Commit:** `tugdeck(imposer-space-allocator): app-test the space allocator end to end`

**References:** [P03], [P04], [P05], [P06], Spec S01, Table T01, Risk R02, (#resize-moment-testing, #success-criteria)

**Artifacts:**
- `tests/app-test/at0303-imposer-space-allocator.test.ts` with `@covers tugdeck/src/lib/layout-imposer.ts`, `@covers tugdeck/src/deck-manager.ts`, `@covers tugdeck/src/components/chrome/deck-canvas.tsx`

**Tasks:**
- [ ] Seeding: follow at0294's `seedDeckState` shape — pinned right Lens, panes slotted for Five Up at slots `{0, 2, 4}` (stored slots are 0-based; the Lens UI labels them 1–5). Because the harness window size is whatever the app launches at, compute the fixture pane width `w` at runtime from the measured canvas width `W` (via `getElementBounds` on the container) so the solve lands ~30px above preferred: `w = (W − 5·GAP − (preferred + 30)) / 3`, rounded; use a card kind whose size-policy min is below that width (e.g. the hello card, min 200 — see `hello-world-card.tsx`).
- [ ] Moment 1: pick Five Up through the Layouts section (follow `at0300-layouts-five-six-up.test.ts` for the gesture). Assert: the Lens frame width equals `allocateLensWidth`'s hand-computed prediction (`W − 3·GAP − B*` per #allocator-geometry); every adjacent seam equals `GAP` ± 1; mid-window the container wears `data-imposer-settling` ([P06]); after land, no inline transforms (at0294's residue rule).
- [ ] Preferred untouched: read `lensStore` state (evalJS) and assert `widthPx` equals the pre-test preferred (Risk R02).
- [ ] Revert case: re-seed with `w` chosen so `L*` exceeds `1.1 × preferred`; pick the layout; assert the Lens renders at exactly the preferred width (no partial correction, [P04]).
- [ ] Moments 2–3 proxy: from the revert state, adjust the fixture (re-seed in-range) and invoke `retuneLensAllocation` directly (evalJS through the deck-manager store handle, following the harness's established `window.__tug` access pattern); assert the same width/seam/settle outcomes (#resize-moment-testing).
- [ ] Re-assert case ([P05]): with the in-range fixture arranged and tuned, disturb a seam by assigning one more card to a free slot (no re-tune fires — excluded moment), then re-click the already-active Cards option; assert `retuneLensAllocation` lands (Lens width equals the new solve, seams back to `GAP` ± 1) and the crossing settles via FLIP.

**Tests:**
- [ ] at0303 (above).

**Checkpoint:**
- [ ] `just app-test tests/app-test/at0303-imposer-space-allocator.test.ts`

---

#### Step 7: Integration checkpoint {#step-7}

**Depends on:** #step-1, #step-2, #step-3, #step-4, #step-5, #step-6

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Confirm the docs plan landed (#documentation-plan) and `just app-test-covers-check` passes for both new tests.

**Tests:**
- [ ] Full changed-scope selection.

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test-covers-check`
- [ ] `just app-test-changed`

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** An imposer whose arrangements cannot be silently corrupted by a stray click, and which — at layout picks and settled window resizes — flexes the pinned Lens within ±10% of the user's preferred width to make imposed cards tile with exact imposition-gap seams, reverting to the preferred width whenever no in-range solve exists.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] A click on any resize handle of an imposed pane never evicts its slot; a real drag still does (at0302).
- [ ] Five Up with slots 1/3/5 at uniform card widths shows exact `IMPOSITION_GAP_PX` seams after a layout pick when the solve is within range, and classic behavior with the preferred Lens width when it isn't (at0303).
- [ ] `lensStore.widthPx` changes only via a Lens edge drag (at0303 assertion).
- [ ] `bunx vite build`, `cd tugdeck && bun test`, `just app-test-covers-check`, and `just app-test-changed` all pass.

**Acceptance tests:**
- [ ] at0302-imposed-resize-click
- [ ] at0303-imposer-space-allocator

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] TestHarness window-resize RPC, upgrading the resize-moment coverage to true end-to-end (#resize-moment-testing).
- [ ] Launch-time re-tune when the restored window lands on a different display ([Q02]'s deferred half).
- [ ] Consider promoting the three-moments rule into `tuglaws/design-decisions.md` as a global `[D##]` once shipped.

| Checkpoint | Verification |
|------------|--------------|
| Stealth eviction fixed | at0302 |
| Allocator engages and reverts correctly | at0303 + solver unit tests |
| Production bundle sound | `bunx vite build` |
| Coverage declared | `just app-test-covers-check` |
