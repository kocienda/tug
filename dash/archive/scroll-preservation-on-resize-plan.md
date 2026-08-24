<!-- devise-skeleton v5 -->

## Scroll Preservation Across Width Changes {#scroll-preservation-on-resize}

**Purpose:** A change in a card's width — by any gesture, on any card type — never changes what the user is looking at. This phase ships the resize-episode primitive and wires every scroller in tugdeck to hold its top-edge content anchor across bullseye, width presets, drag-resize, rail drags, imposition switches, and zoom.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-16 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-16, claude-fable-5.** Reviewed `plan:4c7dd478eae2beb4`. Lint: 0 errors, 1 warning (PL023, resolved by this record). Oriented on: the freshly-authored document, same session as devise; review carried out in-thread on Fable (the skill routes review to the strongest model — Fable sits above Opus, and the owner selected it deliberately).
Applied: (axis 2/4, technical + holes) the generic fallback's discovery — `querySelectorAll('[data-tug-scroll-key]')` — silently missed every plain-flow card scroller the plan itself promised to cover: `.diff-card` carries `overflow: auto` and no key (verified in `cards/diff-card.css`), likewise file-view, gazette transcript, settings tab-view, and devtools; the fix stamps `data-tug-scroll-key` on each in #step-1, which also opts them into CardHost's cross-mount region preservation rather than teaching discovery to sniff computed styles. (axis 5, test sanity) #step-1 and #step-2 specced unit tests that require a DOM — there is no DOM substrate under `bun test` (happy-dom deleted; verified no existing test touches `SmartScroll` or constructs elements); reshaped #step-1's tests to pure anchor-arithmetic functions over data with the DOM lifecycle proven in at0430, and #step-2's to the real `SmartScroll` state machine driven against a structural container stub with no mock-call assertions. Tuglaws cross-check: [L06] honored — scroll position and episode state stay DOM/module authority, never React state (State Zone Mapping adds no store fields, no serialization); [L03] honored — preserve listeners land in the same `useLayoutEffect` region as the existing `tug-region-scroll-set` listener; [L02] untouched — no external state enters React; [L23] extended, not altered — cold-boot restore semantics stay byte-identical per Spec S02. Sequencing verified: the settle site (#step-4) lands after the TugListView handler (#step-3) so the first episode raised has a claimant, and at0372's no-write contract is re-run at both #step-4 and #step-10.
Deferred: nothing — [Q01] (prompt entry) was already decided in-plan.

---

### Phase Overview {#phase-overview}

#### Context {#context}

Entering bullseye mode (⌃⌘B) loses scroll position in the card it centres. The root cause is not bullseye-specific: tugdeck has **no resize episode**. Every scroll-preservation mechanism in the codebase — the CardHost state bag, `captureRegionScrolls`/`applyRegionScrolls`, SmartScroll's cold-boot restore target — is keyed to card *mount/unmount*, and a width change is neither. When a pane's width changes, the scroller element survives untouched (panes are keyed by stable stack id in `deck-canvas.tsx`; card content is portaled into a permanent `.tug-pane-content` div by `card-host.tsx`), so `scrollTop` is faithfully preserved while the content re-wraps out from under it: same numeric offset, different line.

Four things move during a bullseye toggle (the worst case, but every width gesture shares the first three): (1) the pane is clamped to comfy/800px by `imposeStyle({slot: 0, count: 1}, bullseyeWidth, …)` in `tug-pane.tsx`, so text re-wraps and content height changes; (2) the width is *animated*, not switched — the FLIP settle in `deck-canvas.tsx` tweens real inline `width` over `IMPOSITION_SETTLE_MS` (300ms), a genuine reflow every frame; (3) `TugListView` wipes its measured-height ledger on width settle (correctly — remembered heights are exact only at the width they were measured at), forcing a full re-render and re-measure during which position drifts again; (4) bullseye also changes height to the full vertical run. The only invariant defended today is follow-bottom. CSS `overflow-anchor` would cover much of this for free, but WebKit does not implement it — the anchoring must be ours. The design brief is `dash/scroll-preservation-on-resize.md`.

#### Strategy {#strategy}

- **State the invariant as law first** (in `tuglaws/state-preservation.md`), then build the mechanism to uphold it. The law is the top edge, unconditionally — see [P01].
- **Reuse the cold-boot restore machinery.** A width change is architecturally the same event as a cold boot: throw away measured geometry, re-measure, put the user back. `SmartScroll.setRestoreTarget`/`applyRestoreTarget` and `TugListView`'s `makeAnchorResolver` already do the hard half; the work is wiring them to a second occasion.
- **One new primitive, one existing seam.** A `resize-episode` module dispatches cancelable begin/end events on `[data-tug-scroll-key]` scrollers, mirroring the existing `tug-region-scroll-set` protocol. Smart scrollers claim their own anchor by `preventDefault`; everyone else gets the module's generic element anchor. No registry.
- **Land the biggest win first.** The episode primitive plus the `TugListView` handler fixes the transcript, Jots, Lens, and every sheet in one move. CM6, plain-flow fallback, and PDF/image follow.
- **Re-anchor every frame during the tween** ([P02]) so content stays visually still while the frame animates — one `scrollTop` write per ResizeObserver delivery.
- **Guard with the displacement counter.** `TugListView` already publishes `data-scroll-displacements`; generalize it and assert it stays flat across width gestures in app-tests.

#### Success Criteria (Measurable) {#success-criteria}

- In an app-test, scroll the Session transcript to a mid-content element, toggle bullseye on and off, and the element's viewport-relative top is unchanged (±1px) at each settle. (New app-test, #step-6)
- The same holds for ⌃⌘1/⌃⌘2/⌃⌘3 width chords and a drag-resize on the transcript, a text card (CM6), and a diff card (plain flow). (Same app-test file)
- A transcript following the bottom stays pinned to the bottom across every width gesture — the existing behavior, now asserted. (#step-6)
- `data-scroll-displacements` on a preserving scroller does not increment across a width gesture. (#step-6)
- `tugdeck` unit tests cover the generic anchor math and the SmartScroll episode-target semantics. (`cd tugdeck && bun test`)

#### Scope {#scope}

1. The `resize-episode` module: begin/end lifecycle, event protocol, generic fallback anchor.
2. SmartScroll: episode-scoped restore targets that suspend the drift-supersede check.
3. `TugListView`: begin/end handlers riding the existing anchor writer and restore resolver.
4. Raise sites: the deck-canvas FLIP settle, pane drag-resize, sidebar rail drag.
5. CM6 scrollers: hoist the file-block line-anchor writer into the shared substrate; line-anchored episode handler.
6. `TugMarkdownView`, PDF, and image handlers.
7. The law text in `tuglaws/state-preservation.md`; app-test coverage.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Height-only changes (content growth, vertical drag-resize) beyond what the top-edge anchor gives for free — follow-bottom already owns the bottom-pinned case, and a pure height change does not reflow content.
- Preserving *horizontal* scroll across width changes (status bars, wide code). `scrollLeft` is clamped by the browser when the scroller narrows; no anchor semantics improve on that.
- Caret-pinned anchoring in editors — rejected by [P01].
- Freezing content layout during the tween — rejected by [P02].
- Cross-mount preservation changes. The CardHost bag, `captureRegionScrolls`, and cold-boot restore are untouched except where SmartScroll's restore-target internals are extended (#step-2).

#### Dependencies / Prerequisites {#dependencies}

- The shipped anchor writers: `TugListView`'s `data-tug-scroll-state` anchor writer and `makeAnchorResolver`; `file-block.tsx`'s `writeScrollState` line writer.
- `SmartScroll` (`tugdeck/src/lib/smart-scroll.ts`) and its restore-target machinery.
- The app-test harness; `tests/app-test/at0372-bullseye.test.ts` as the geometry reference for bullseye assertions.

#### Constraints {#constraints}

- WebKit only (Tug.app's WKWebView). No `overflow-anchor`; `:has()` never invalidates on descendant attribute changes; background app-test windows suspend rAF entirely, so no episode lifecycle may hang off an animation frame or animation callback alone.
- Tuglaws: scroll position is DOM authority, mutated directly, never React state ([L06]); registrations events depend on go in `useLayoutEffect` ([L03]); external state enters React through `useSyncExternalStore` only ([L02]) — this plan adds no such state.
- `-D warnings` equivalent for the frontend: `bunx tsc --noEmit` and `bunx vite build` must stay clean; the debug app loads the prod rollup bundle, so a vite build is part of "done" for every step.
- App-tests are selective: `just app-test-changed` / `just app-test <file>`, never a sweep.

#### Assumptions {#assumptions}

- The FLIP settle's completion path (`Promise.allSettled(anims.map(a => a.finished))` in `deck-canvas.tsx`) runs even in background windows, because TugAnimator resolves `finished` after committing; the wall-clock safety net in [P05] exists in case it does not.
- One ResizeObserver delivery per frame per scroller during the width tween is cheap enough that a `scrollTop` write per delivery does not show up in the typing-lag traces. (If it does, Risk R03's trigger fires.)

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan uses explicit `{#anchor}` headings, stable `[P##]`/`[Q##]`/`S##`/`T##`/`R##` labels, `**Depends on:**` lines with `#step-N` anchors, and `**References:**` lines citing plan artifacts — per `tuglaws/devise-skeleton.md`. `[D##]` citations refer to the global `tuglaws/design-decisions.md`; `[L##]` to `tuglaws/tuglaws.md`.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Does the prompt entry need an episode handler? (DECIDED — no) {#q01-prompt-entry}

**Question:** The Session card's prompt entry is a CM6 scroller capped at `50cqh`; does it need line-anchored preservation?

**Why it matters:** It is the most-used editor in the product.

**Resolution:** DECIDED (see [P07]). The entry is bottom-anchored by its own design (it grows from the bottom, caret usually at the end) and short; the generic fallback anchor from #step-1 applies to it like any unclaimed scroller, and that is sufficient. The CM6 line-anchor hoist (#step-7) targets `TugCodeView` and `TugTextCardEditor`, where documents are long. If real use shows drift in the entry, adding the shared extension is a one-line opt-in.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| SmartScroll drift-supersede cancels the restore mid-episode | high | high (certain, unmitigated) | #step-2 suspends the check for episode targets | n/a — designed in |
| Episode never ends in a background window | med | med | wall-clock safety net [P05] | app-test flake with `data-resize-episode` stuck on |
| Per-frame re-anchor costs main-thread time | med | low | one write per RO delivery; counter-guarded | typing-lag traces show `resize-episode` frames |
| Ledger-wipe re-measure fights the restore | med | med | resolver-based target *tracks* drift by design | anchor lands >1px off at settle in #step-6 |

**Risk R01: The drift-supersede self-cancel** {#r01-drift-supersede}

- **Risk:** `SmartScroll.applyRestoreTarget` clears its target when `scrollTop` is found more than `RESTORE_SUPERSEDE_DRIFT_PX` from the baseline recorded after its last write (`smart-scroll.ts`, the `_restoreBaselineTop` check). That logic assumes "DOM content growth never moves `scrollTop`" — true for growth *below* the viewport, false for a re-wrap *above* it, which is exactly what a width change produces. Unfixed, the episode's restore target cancels itself on the first mid-tween reflow and the whole feature silently no-ops.
- **Mitigation:**
  - #step-2 adds an episode-scoped target mode that skips the baseline-drift supersede while the episode is open.
  - The `isUserScrolling` supersede stays live in episode mode — a scrollbar grab mid-resize still hands the position to the user.
- **Residual risk:** A native scrollbar drag during the 300ms tween delivers no events (the phase machine sits in `idle`), and with the drift check suspended it cannot be distinguished from reflow — the restore wins for the remainder of the episode. Accepted: the window is 300ms and the user's next scroll owns the position.

**Risk R02: rAF-suspended windows** {#r02-raf-suspension}

- **Risk:** Background app-test windows run no rAF and suspend animations; an episode whose end depends on an animation callback stays open forever, leaving scrollers in restore mode.
- **Mitigation:**
  - End is raised from the settle's completion promise **and** a `setTimeout` safety net ([P05]); pointer-gesture episodes end on `pointerup`, which always fires.
  - `endResizeEpisode` is idempotent.
- **Residual risk:** None meaningful; the safety net converts a stuck episode into a slightly-late end.

**Risk R03: Re-anchor cost during the tween** {#r03-reanchor-cost}

- **Risk:** Writing `scrollTop` on every ResizeObserver delivery during a 300ms tween adds forced-layout pressure to an already reflow-heavy window.
- **Mitigation:**
  - One write per delivery, no rAF loops of our own; the RO already coalesces per frame.
  - The write happens only while an episode is open and only when the resolved target differs from the current `scrollTop`.
- **Residual risk:** On very tall re-measuring transcripts the tween may drop frames it already drops today; the anchor makes the result *correct*, not slower.

---

### Design Decisions {#design-decisions}

#### [P01] The anchor is always the top edge (DECIDED) {#p01-top-edge-anchor}

**Decision:** The topmost visible content anchor keeps its offset from the viewport top across a width change, for every card, unconditionally. A visible caret or selection does not claim the anchor.

**Rationale:**
- One rule for every card is auditable; "caret wins when visible" is a second rule requiring per-scroller caret plumbing and produces surprising jumps when the caret is far offscreen.
- Matches CSS scroll anchoring semantics, so future WebKit support could subsume the generic fallback.
- Every scroller with real semantics already writes exactly this anchor (`TugListView`'s `{index, offset}`; file-block's `{line, offsetPx}`).
- Confirmed by the owner in the design session (2026-08-16).

**Implications:**
- Episode handlers capture "what is at the viewport top" at begin, never "where is the caret".
- A scroller following the bottom is the one exception: `atBottom` skips the anchor and follow-bottom pinning owns the position (already-correct behavior, now part of the law).

#### [P02] Content reflows live, re-anchored every frame (DECIDED) {#p02-reflow-reanchored}

**Decision:** During the animated width tween, content re-wraps continuously and the anchor is re-applied on every ResizeObserver delivery; there is no layout freeze and no end-of-tween snap.

**Rationale:**
- A freeze-then-reflow shows a visible snap at the end of every width change — worse than the continuous form.
- The hooks already exist: `TugListView` and `TugMarkdownView` both own container ResizeObservers that today only bottom-pin and re-window.
- Confirmed by the owner in the design session (2026-08-16).

**Implications:**
- Episode handlers must be cheap per delivery (resolve target, compare, conditionally write).
- The generic fallback re-anchors from the same deliveries via its own ResizeObserver, installed only for the episode's duration.

#### [P03] The episode rides the region-scroll seam — events, not a registry (DECIDED) {#p03-event-seam}

**Decision:** `beginResizeEpisode(frameEl)` discovers scrollers via `frameEl.querySelectorAll('[data-tug-scroll-key]')` and dispatches cancelable `tug-scroll-preserve-begin` / `tug-scroll-preserve-end` CustomEvents on each; a handler that claims its own anchor calls `preventDefault()`, and an unclaimed scroller falls through to the module's generic anchor.

**Rationale:**
- This is exactly the `tug-region-scroll-set` protocol from `card-host.tsx` `applyRegionScrolls`: cancelable event first, direct fallback second. Same seam, second occasion — no new registry, no plumbing through React props.
- The selector reaches portaled card content because `.tug-pane-content` lives inside the frame element.
- The `.tug-pane-content` host itself is `overflow: auto` (`tug-pane.css`) but carries no `data-tug-scroll-key`; the module also anchors the host element directly when it is the active scroller (scrollHeight > clientHeight), so cards that never opted into region scroll still preserve.

**Implications:**
- Handlers attach listeners in `useLayoutEffect` ([L03]) on the same element that carries `data-tug-scroll-key`.
- The events carry `{episodeId}` in `detail`; end events with an unknown id are ignored (idempotency).
- **Plain-flow card scrollers that carry no key today must be stamped** or discovery misses them: `.diff-card` (`cards/diff-card.css` gives it `overflow: auto`, no key), `.file-view-card`, `.gazette-transcript`, `.tug-tab-view-list`/`.tug-tab-view-detail`, `.devtools-card-panel`. Stamping a `data-tug-scroll-key` also opts each into CardHost's cross-mount region preservation (`captureRegionScrolls`) — a strict improvement aligned with [L23], and the reason stamping is preferred over teaching discovery to sniff computed `overflow`.

#### [P04] Width restores are episode-scoped SmartScroll restore targets (DECIDED) {#p04-episode-restore-target}

**Decision:** `SmartScroll` gains an episode variant of the restore target: `setRestoreTarget(resolver, {suspendDriftSupersede: true})` (exact signature per Spec S02). While such a target is installed, the `_restoreBaselineTop` drift check is skipped; `isUserScrolling` supersede and explicit-programmatic-scroll supersede stay live. `clearRestoreTarget()` semantics are unchanged.

**Rationale:**
- The drift check's premise ("content growth never moves scrollTop") is false under re-wrap above the viewport — Risk R01. Suspending it only for episode targets keeps cold-boot restore semantics byte-identical.
- Reusing `setRestoreTarget`/`applyRestoreTarget` inherits the already-solved rules: resolver re-invoked per heartbeat, target tracks drifting heights, user gesture wins, restore disengages follow-bottom.

**Implications:**
- `TugListView`'s existing `applyRestoreTarget` heartbeat (the per-commit effect and the container-RO path) lands the episode restore with no new call sites beyond the RO forwarding in #step-3.
- The episode end clears the target if still installed.

#### [P05] Episode end never depends on an animation callback alone (DECIDED) {#p05-end-safety-net}

**Decision:** Settle-driven episodes end from the FLIP settle's `Promise.allSettled` completion **and** a `setTimeout(IMPOSITION_SETTLE_MS + slack)` safety net, whichever fires first; pointer-gesture episodes end on `pointerup`/`pointercancel`. `endResizeEpisode` is idempotent per episode id.

**Rationale:**
- Background windows suspend rAF and animations (`reference_apptest_raf_suspended`); a lifecycle hung off `finished` alone can stall.
- TugAnimator scales durations by `getTugTiming()`, so the safety-net timeout must read the same scaled duration the settle uses (`settleDurationRef` feeds it in `deck-canvas.tsx`).

**Implications:**
- The module tracks the pending timer per episode and cancels it on explicit end.

#### [P06] The generic fallback anchor is what CSS scroll anchoring does (DECIDED) {#p06-generic-anchor}

**Decision:** For an unclaimed scroller: at begin, find the anchor node via `elementFromPoint` at the scroller's content top-left inset (walking up to the nearest child of the scroller), record `anchorRect.top − scrollerRect.top`; on each re-anchor, `scrollTop += (currentDelta − savedDelta)`. If the scroller is at the bottom (`scrollTop + clientHeight >= scrollHeight − 1`) at begin, pin the bottom instead. If `scrollTop === 0`, do nothing (top is already the anchor).

**Rationale:**
- Element-relative anchoring survives reflow by construction; a pixel-fraction anchor does not.
- `elementFromPoint` works on plain-flow content (diff rows, gazette turns, settings sections) with no per-card knowledge.

**Implications:**
- The anchor node is held by reference for the episode's duration; if it is removed from the DOM mid-episode (virtualized eviction — should not happen on unclaimed scrollers, which are all plain flow), the fallback degrades to holding the last computed `scrollTop` and stops adjusting.
- Image file-view cards, whose content never re-wraps but scales, are covered by the fractional variant in #step-8.

#### [P07] CM6 preservation lands in the shared substrate, keyed by line (DECIDED) {#p07-cm6-line-anchor}

**Decision:** Hoist `file-block.tsx`'s line-anchor pattern (`view.lineBlockAtHeight(scrollTop)` → `{line, offsetPx}`; restore via `view.lineBlockAt(doc.line(n).from).top + offsetPx`) into a shared CM6 extension in the `tug-text-editor` substrate, and register a preserve-begin/end handler on `view.scrollDOM` wherever the scroll key is stamped. `TugCodeView` and `TugTextCardEditor` adopt it; the prompt entry does not ([Q01]).

**Rationale:**
- The pattern is proven: file blocks already write it on every scroll, and the mount path already restores by line ("robust to font-load reflow because the saved LINE is what we restore to").
- CM6 virtualizes its own document; a DOM-element anchor (P06) is wrong inside it, and `lineBlockAtHeight` reads the height map that covers the full document whether or not the line is rendered.

**Implications:**
- `lineBlockAtHeight` throws before the measurement plugin runs; handlers swallow defensively exactly as `writeScrollState` does today.
- During the tween, re-anchor on CM6's own `geometryChanged` updates (via an `updateListener`) rather than an external RO — CM6 owns its layout pipeline.

#### [P08] The invariant is law, recorded in state-preservation.md (DECIDED) {#p08-law-text}

**Decision:** Add a "Resize preservation" section to `tuglaws/state-preservation.md` (whose existing prose covers only cross-mount preservation) stating: a change in a card's width never changes what the user is looking at; the top-edge anchor holds through every intermediate frame; follow-bottom stays pinned; non-reflowing content holds fractional position.

**Rationale:**
- The doc is the [L23] home; a mechanism without a stated invariant erodes.

**Implications:**
- The section names the episode module and the event protocol so future scrollers know the opt-in surface.

---

### Deep Dives {#deep-dives}

#### Where the machinery already lives {#existing-machinery}

A cold reader should not re-derive these; they were verified against the code on 2026-08-16.

- **Pane identity survives width changes.** `deck-canvas.tsx` renders panes keyed by stable stack id with no DOM reordering on focus change; `TugPane` renders a permanent `.tug-pane-content` div and `CardHost` portals card content into it via the pane-content registry keyed by `stackId` (`card-host.tsx`, `useHostContentElement`). Bullseye and width changes alter only the frame's inline `style`.
- **Bullseye geometry.** `tug-pane.tsx` computes `bullseyeWidth = resolveContentWidthPx(DEFAULT_CONTENT_WIDTH, sizePolicy.min.width, sizePolicy.max?.width)` (comfy = 800, `layout-imposer.ts`) and applies `imposeStyle({slot: 0, count: 1}, bullseyeWidth, pinnedFrame)` when the derived `bullseyePaneIdOf(state)` matches. Bullseye writes no stored geometry (`at0372` pins this).
- **The FLIP settle.** `arrangementSignature(state)` (`deck-canvas.tsx`) includes the *derived* bullseye id, the imposition kind, per-pane `slot:width`, and rail terms; a signature change arms the settle. The Last pass computes `widthChanges = |first.width − last.width| >= 0.5`; deltas past `MAX_FLIP_SCALE_DISTORTION` tween real inline `width` over the scaled `IMPOSITION_SETTLE_MS` (300ms) via TugAnimator; `Promise.allSettled(anims.map(a => a.finished))` runs the inline restorers and `clearFlip`. This completion path is the settle-episode end hook.
- **`TugListView` anchor writer.** A per-commit effect serializes `{anchor: {index, offset, turnDepthFromEnd|depthFromEnd}, scrollHeight, atBottom?}` onto `data-tug-scroll-state`. `makeAnchorResolver(anchorIndex, anchorOffset, turnDepth, rowDepth)` returns a resolver reading the **live** `heightIndex` per call, returning `null` while the anchor row is outside the data source. The mount seed and the `tug-region-scroll-set` listener both feed `SmartScroll.setRestoreTarget`; the `applyRestoreTarget` heartbeat runs per commit.
- **Width-settle ledger wipe.** `TugListView`'s width-invalidation effect debounces `clientWidth` changes (`widthSettlePendingRef` freezes the cell observer during the pending window), then wipes `contain-intrinsic-size` stamps and, under `evictOffscreen`, the measured-height ledger — forcing a full re-render and re-measure at the new width. The episode restore target must remain installed *through* this wipe-and-re-measure; the resolver-based target is designed for exactly that drift.
- **Container ResizeObservers.** `TugListView` observes its scroll container: today the callback does a synchronous `maybePinToBottom()` (gated by `isScrollBatteryFrozen()`) and requests re-window via `scrollTick()`. `TugMarkdownView` observes its container to update viewport height and rebuild the window. Both are the [P02] re-anchor hooks.
- **SmartScroll restore internals.** `setRestoreTarget(resolver)` disengages follow-bottom; `applyRestoreTarget()` clears on `isUserScrolling`, clears when `|scrollTop − _restoreBaselineTop| > RESTORE_SUPERSEDE_DRIFT_PX` (the Risk R01 check), else resolves and writes through `_writeScrollTop` (which arms idle-re-engagement suppression so the deferred scroll event cannot flip follow-bottom back on).
- **CM6 line writer.** `file-block.tsx` stamps `data-tug-scroll-key={key}/file-scroll` on `view.scrollDOM`, writes `{line: {number, offsetPx}, scrollHeight}` to `data-tug-scroll-state` on every scroll (throws swallowed pre-measurement), and restores line-relative on first mount.
- **Resize gestures.** `handleResizeStart` (`tug-pane.tsx`) drives 8-edge drag-resize with RAF appearance-zone mutation during and `onCardMoved` commit on pointer end; `handleSidebarResizeStart` drives rail edge drags writing `--tug-sidebar-width-left/right` live.
- **Displacement counter.** `TugListView` publishes `data-scroll-displacements` on the scroller from mount (`"0"` is a positive assertion) and increments it when content displacement moves the viewport.

#### Episode lifecycle {#episode-lifecycle}

```
gesture site                     resize-episode module                scroller handler
------------                     ---------------------                ----------------
beginResizeEpisode(frameEl) ──▶  id = next++                          on "tug-scroll-preserve-begin":
                                 for el of frameEl.querySelectorAll     capture anchor (claimed) and
                                   ('[data-tug-scroll-key]')            preventDefault()
                                   dispatch begin(el, {id})           unclaimed: module records
                                 + the .tug-pane-content host           generic element anchor,
                                 stamp data-resize-episode              installs its own RO
                                 arm safety-net timeout
        (tween runs; RO deliveries / CM6 geometry updates re-anchor per [P02])
endResizeEpisode(frameEl, id) ─▶ dispatch end(el, {id}) each          on "tug-scroll-preserve-end":
                                 clear stamp, cancel timeout            final re-anchor, clear target
```

`data-resize-episode` on the frame is the observable episode state for tests — a DOM attribute, not React state ([L06]).

**Table T01: Raise sites** {#t01-raise-sites}

| Gesture | Begin | End |
|---|---|---|
| Bullseye enter/exit, imposition switch, ⌃⌘1/2/3, width popup, deck-wide width | deck-canvas settle: on arming, before the Last pass measures (`settleFirstRectsRef` capture) | settle completion `Promise.allSettled` + safety net |
| 8-edge drag-resize | `handleResizeStart` pointer-down latch | `pointerup`/`pointercancel` |
| Rail edge drag | `handleSidebarResizeStart` latch | `pointerup`/`pointercancel` |
| Page zoom / font scale | no explicit episode — reaches scrollers as a `clientWidth` change; `TugListView`'s width-invalidation path re-measures and claimed scrollers hold via their normal heartbeat | n/a |

**Table T02: Scroller handlers** {#t02-scroller-handlers}

| Scroller | Anchor | Mechanism | Step |
|---|---|---|---|
| `TugListView` (transcript, Jots, Lens sections, sheets, keyboard, path/search/todo blocks) | `{index, offset, turnDepth}` it already writes | episode restore target via `makeAnchorResolver`; `atBottom` → skip, follow-bottom owns it | #step-3 |
| CM6 (`TugCodeView` in file blocks, `TugTextCardEditor` in text card) | line number + intra-line px | shared substrate extension, [P07] | #step-7 |
| `TugMarkdownView` | block index + offset | claim with block offsets it already tracks (its shrink-recovery snap is the pattern) | #step-8 |
| PDF (`pdf-view.tsx`) | page index + fraction of page | own listener; pages absolutely positioned from a document model | #step-8 |
| Image file-view | fractional `scrollTop/scrollHeight` | generic module variant for non-reflowing content | #step-8 |
| Plain flow (diff, gazette transcript, settings, devtools, `.tug-pane-content` host) | nearest stable child at top inset | generic fallback [P06] | #step-1 |

---

### Specification {#specification}

**Spec S01: The episode module API** {#s01-episode-api}

`tugdeck/src/lib/resize-episode.ts`:

```ts
export interface ResizeEpisodeHandle { readonly id: number; end(): void; }

/** Begin a resize episode for every preservable scroller inside `frameEl`.
 *  Dispatches cancelable `tug-scroll-preserve-begin`; unclaimed scrollers get
 *  the generic anchor. Stamps `data-resize-episode` on `frameEl`. Arms a
 *  safety-net end at `durationMs + RESIZE_EPISODE_SLACK_MS`. */
export function beginResizeEpisode(frameEl: HTMLElement, durationMs: number): ResizeEpisodeHandle;
```

Event contract (both events target the scroller element, `bubbles: false`, begin is `cancelable: true`):

```ts
type PreserveBeginDetail = { episodeId: number };
type PreserveEndDetail = { episodeId: number };
// "tug-scroll-preserve-begin" — preventDefault() claims the scroller.
// "tug-scroll-preserve-end"   — always dispatched, even to claimed scrollers.
```

Generic-anchor rules are [P06]. `end()` is idempotent; a second `beginResizeEpisode` on the same frame while one is open ends the old episode first (re-capturing anchors at the current — correct — position).

**Spec S02: SmartScroll episode targets** {#s02-smartscroll-episode}

```ts
// smart-scroll.ts — signature change (backward compatible):
setRestoreTarget(resolver: () => number | null, opts?: { suspendDriftSupersede?: boolean }): void;
```

`applyRestoreTarget()` skips the `_restoreBaselineTop` drift-supersede when the installed target carries `suspendDriftSupersede`. All other supersedes (`isUserScrolling`, explicit `scrollTo`/`scrollToTop`/`scrollToElement`) are unchanged. Cold-boot callers pass no opts and behave byte-identically.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| open episode (id, anchors, safety timer) | local-data, non-React | module-level `Map` in `resize-episode.ts` + `data-resize-episode` DOM attribute | [L06] |
| scroll position during/after episode | DOM authority | direct `scrollTop` writes via SmartScroll `_writeScrollTop` / element assignment | [L06] |
| episode restore target | local-data | `SmartScroll` private field (existing `_restoreTarget`, new flag) | [L06], [L23] |
| handler registration | — | `addEventListener` in `useLayoutEffect` | [L03] |
| CM6 line anchor | local-data | CM6 extension state on the `EditorView` | [L06] |

No new React state, no store fields, no serialization changes.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/lib/resize-episode.ts` | episode lifecycle, event protocol, generic fallback anchor |
| `tugdeck/src/__tests__/resize-episode.test.ts` | unit: lifecycle, idempotency, claim/fallback dispatch, generic anchor math |
| `tests/app-test/at0430-resize-scroll-preservation.test.ts` | app-test: anchors hold across bullseye/chords/drag on transcript, text card, diff card |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `beginResizeEpisode`, `ResizeEpisodeHandle` | fn/type | `tugdeck/src/lib/resize-episode.ts` | Spec S01 |
| `RESIZE_EPISODE_SLACK_MS` | const | same | safety-net slack, [P05] |
| `setRestoreTarget` | method (extend) | `tugdeck/src/lib/smart-scroll.ts` | Spec S02, opts param |
| preserve-begin/end listeners | effect | `tugdeck/src/components/tugways/tug-list-view.tsx` | beside the existing `tug-region-scroll-set` listener |
| container-RO episode forwarding | edit | same, container ResizeObserver callback | call `applyRestoreTarget()` while episode target installed |
| settle begin/end raise | edit | `tugdeck/src/components/chrome/deck-canvas.tsx` | arm site + `Promise.allSettled` completion |
| drag begin/end raise | edit | `tugdeck/src/components/chrome/tug-pane.tsx` | `handleResizeStart`, `handleSidebarResizeStart` |
| CM6 line-anchor extension | CM6 extension | `tugdeck/src/components/tugways/tug-text-editor.tsx` (substrate) | [P07]; adopted by `tug-code-view.tsx`, `tug-text-card-editor.tsx`; `file-block.tsx` writer refactored onto it |
| markdown episode handler | effect | `tugdeck/src/components/tugways/tug-markdown-view.tsx` | block-offset anchor |
| PDF episode handler | effect | `tugdeck/src/components/tugways/cards/pdf-view.tsx` | page + fraction |
| resize-preservation law section | doc | `tuglaws/state-preservation.md` | [P08] |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** (`bun test`, `tugdeck/src/__tests__`) | episode lifecycle, event claim/fallback, generic anchor math, SmartScroll episode-target supersede rules | pure logic with a constructible DOM-free or minimal-DOM surface |
| **App-test** (real Tug.app) | the invariant itself: anchors hold across real gestures on real cards | end-to-end proof; the displacement counter as a tripwire |

#### What stays out of tests {#test-non-goals}

- jsdom render tests of card components — banned pattern; the app-test drives the real app.
- Pixel-exact assertions during the 300ms tween — mid-flight reads return interpolated values and rAF-dependent motion is suspended in background windows; assertions land at settle boundaries only.
- The prompt entry's scroll behavior ([Q01] — deliberately unclaimed).
- Per-theme/appearance interactions — width preservation is geometry, not paint.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** Every step ends with `cd tugdeck && bunx tsc --noEmit && bunx vite build` clean (the debug app loads the prod bundle).

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Episode module + generic fallback | done | `446bc7859` |
| #step-2 | SmartScroll episode targets | done | `cba5e4d3c` |
| #step-3 | TugListView handler | done | `1ccc73fa9` |
| #step-4 | Settle raise site | done | `34c871305` |
| #step-5 | Drag raise sites | done | `67a460e80` |
| #step-6 | App-test: the invariant | done | `a890b074b` |
| #step-7 | CM6 substrate anchor | done | `e7373e10c` |
| #step-8 | Markdown, PDF, image handlers | done | `426e7d204` |
| #step-9 | Law text + doc | done | `4cf090897` |
| #step-10 | Integration checkpoint | done | `a9157d55a` |

#### Step 1: Episode module + generic fallback {#step-1}

**Commit:** `tugdeck(resize-episode): the resize episode — begin/end events on the region-scroll seam, generic top-edge anchor`

**References:** [P03] event seam, [P05] safety net, [P06] generic anchor, Spec S01, Table T02, (#episode-lifecycle, #existing-machinery)

**Artifacts:**
- `tugdeck/src/lib/resize-episode.ts`
- `tugdeck/src/__tests__/resize-episode.test.ts`

**Tasks:**
- [ ] Implement `beginResizeEpisode(frameEl, durationMs)` per Spec S01: scroller discovery (`[data-tug-scroll-key]` plus the `.tug-pane-content` host when it is the active scroller), cancelable begin dispatch, claimed-set tracking, `data-resize-episode` stamp, safety-net timer.
- [ ] Implement the generic fallback per [P06]: anchor node via `elementFromPoint` at the scroller's content top inset walked up to the direct-child level; bottom-pin when at bottom; no-op at `scrollTop === 0`; per-episode ResizeObserver on the scroller re-applying the delta each delivery ([P02]); final re-apply + disconnect on end. Factor the anchor arithmetic (saved-delta → scrollTop adjustment; bottom/zero gates; the #step-8 fraction variant) into exported pure functions over plain `{scrollTop, scrollHeight, clientHeight, anchorTop}` data, so the math is testable without a DOM.
- [ ] Stamp `data-tug-scroll-key` on the plain-flow card scrollers discovery would otherwise miss ([P03] implications): `.diff-card` (`cards/diff-card.tsx`), `.file-view-card` (`cards/file-view-card.tsx`), `.gazette-transcript` (`gazette/gazette-card.tsx`), `.tug-tab-view-list` and `.tug-tab-view-detail` (`tug-tab-view.tsx`), `.devtools-card-panel` (`devtools/devtools-card.tsx`). Distinct key per region; this also opts each into CardHost's cross-mount region preservation.
- [ ] `end()` idempotent; re-begin on an open frame ends the prior episode first.

**Tests:**
- [ ] Unit (pure logic over data — there is no DOM substrate under `bun test`): the anchor arithmetic — a child-height change between begin and re-anchor lands the anchor at its saved viewport-top delta; bottom-pinned input stays at bottom; `scrollTop === 0` stays 0; fraction math round-trips.
- [ ] Event dispatch, claim/fallback selection, idempotent end, and the safety net are real-DOM behavior — covered in at0430 (#step-6) via the `data-resize-episode` stamp and anchor assertions, not unit-tested against a fake DOM (banned pattern).

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/__tests__/resize-episode.test.ts`
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`

---

#### Step 2: SmartScroll episode targets {#step-2}

**Depends on:** #step-1

**Commit:** `tugdeck(smart-scroll): episode-scoped restore targets — a re-wrap above the viewport is not the user`

**References:** [P04] episode restore target, Risk R01, Spec S02, (#existing-machinery)

**Artifacts:**
- `setRestoreTarget(resolver, opts?)` in `tugdeck/src/lib/smart-scroll.ts`

**Tasks:**
- [ ] Add the `suspendDriftSupersede` opt per Spec S02; skip only the `_restoreBaselineTop` drift check for such targets. `isUserScrolling` and explicit-scroll supersedes unchanged. Update the restore-policy comment block (the one documenting attribution rules) to name the episode case and why the drift premise fails under re-wrap.

**Tests:**
- [ ] Unit (new file; no smart-scroll unit tests exist today): drive the **real** `SmartScroll` state machine against a minimal structural container stub (a plain object with live `scrollTop`/`scrollHeight`/`clientHeight` and no-op listener methods — real logic over data, no fake-DOM render, no mock-call-count assertions). Assert: an episode target survives a baseline drift larger than `RESTORE_SUPERSEDE_DRIFT_PX` and still writes its resolved value; a cold-boot target (no opts) self-clears on the same drift; `isUserScrolling` clears both kinds.

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`

---

#### Step 3: TugListView handler {#step-3}

**Depends on:** #step-2

**Commit:** `tugdeck(tug-list-view): claim the resize episode — the live anchor becomes an episode restore target`

**References:** [P01] top edge, [P02] reflow re-anchored, [P04] episode target, Table T02, Risk R01, (#existing-machinery, #episode-lifecycle)

**Artifacts:**
- preserve-begin/end listeners + container-RO forwarding in `tugdeck/src/components/tugways/tug-list-view.tsx`

**Tasks:**
- [ ] Add `tug-scroll-preserve-begin`/`-end` listeners in the same `useLayoutEffect` region as the existing `tug-region-scroll-set` listener ([L03]). On begin: `preventDefault()`; read the live anchor the writer effect maintains (compute directly from `heightIndexRef` + current `scrollTop`, same derivation as the `data-tug-scroll-state` writer — do not round-trip through the attribute); if following bottom (`smartScrollRef.current?.isFollowingBottom`), claim but install no target — the existing sync `maybePinToBottom` in the container RO owns the bottom case. Otherwise `setRestoreTarget(makeAnchorResolver(index, offset, turnDepth, rowDepth), {suspendDriftSupersede: true})`.
- [ ] In the container ResizeObserver callback, alongside the existing `maybePinToBottom()`: call `smartScrollRef.current?.applyRestoreTarget()` so the anchor re-lands on every delivery during the tween ([P02]). (`applyRestoreTarget` is a no-op with no target installed — cold paths unaffected. Order: after the pin call; the two are mutually exclusive by the begin-time branch.)
- [ ] On end: one final `applyRestoreTarget()`, then `clearRestoreTarget()`.
- [ ] Verify interaction with the width-invalidation effect: the episode target must stay installed across the ledger wipe and re-measure (`widthSettlePendingRef` freeze window) — the resolver returning `null` while rows are unresolvable is the designed wait state; add a comment tying the two effects together at the invalidation site.

**Tests:**
- [ ] Covered end-to-end in #step-6 (real reflow is not constructible in unit scope without banned fake-DOM shapes).

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`

---

#### Step 4: Settle raise site {#step-4}

**Depends on:** #step-3

**Commit:** `tugdeck(deck-canvas): the FLIP settle opens a resize episode — bullseye, chords, and imposition stop losing the reader's place`

**References:** [P03] event seam, [P05] safety net, Table T01, (#existing-machinery, #episode-lifecycle)

**Artifacts:**
- begin/end raise in `tugdeck/src/components/chrome/deck-canvas.tsx`

**Tasks:**
- [ ] On settle arming (where `settleFirstRectsRef` captures first rects for frames with motion), call `beginResizeEpisode(frame, scaledDuration)` for each such frame, holding the handles in a ref keyed by pane id. Use the same scaled duration the settle animations use (`settleDurationRef`), so the safety net outlives the tween under `getTugTiming()` scaling.
- [ ] End each frame's episode inside the existing `Promise.allSettled(...).then(...)` completion (before/with `clearFlip` — after the inline restorers run, so the final re-anchor sees final geometry). Frames with no width/height tween (`anims.length === 0` early-continue) end immediately.
- [ ] A re-arm while episodes are open (rapid gesture chains) relies on Spec S01's re-begin semantics; drop the stale handles.

**Tests:**
- [ ] Covered in #step-6; the `data-resize-episode` stamp is the observable.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `just app-test tests/app-test/at0372-bullseye.test.ts` — the existing bullseye geometry/no-write assertions still pass with episodes riding the settle

---

#### Step 5: Drag raise sites {#step-5}

**Depends on:** #step-4

**Commit:** `tugdeck(tug-pane): drag-resize and rail drags open resize episodes for the panes they reshape`

**References:** [P03] event seam, [P05] end on pointerup, Table T01, (#episode-lifecycle)

**Artifacts:**
- begin/end raise in `tugdeck/src/components/chrome/tug-pane.tsx`

**Tasks:**
- [ ] `handleResizeStart`: begin an episode on the pane's frame element when the drag latches (only for edges that change width — pure `n`/`s` drags don't reflow, but begin unconditionally is acceptable since a no-width-change episode's anchors are no-ops; prefer unconditional for simplicity); end on `pointerup`/`pointercancel` in the same listener teardown that commits `onCardMoved`.
- [ ] `handleSidebarResizeStart`: a rail drag reshapes the *rail members'* frames (live `--tug-sidebar-width-left/right` writes) — begin an episode per affected member frame at latch, end on pointer end.
- [ ] Pass a generous `durationMs` (the drag's length is unbounded; use a long safety net, e.g. 60s — `pointerup` is the real end and always fires; the net only covers a torn-down pane mid-drag).

**Tests:**
- [ ] Covered in #step-6 (drag-resize case).

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`

---

#### Step 6: App-test — the invariant {#step-6}

**Depends on:** #step-5

**Commit:** `tests(app-test): at0430 — width changes never move what the user is looking at`

**References:** [P01] top edge, [P02] reflow re-anchored, Table T01, Table T02, (#success-criteria, #test-non-goals)

**Artifacts:**
- `tests/app-test/at0430-resize-scroll-preservation.test.ts` with `@covers` on `resize-episode.ts`, `smart-scroll.ts`, `tug-list-view.tsx`, `deck-canvas.tsx`, `tug-pane.tsx`

**Tasks:**
- [ ] Transcript case: populate a session transcript tall enough to scroll (fixture replay, per existing at04xx patterns), scroll to a mid-content row, record the row's `getBoundingClientRect().top` relative to the scroller; toggle bullseye on; await settle (`data-resize-episode` absent and the settle window closed — mirror at0372's settle-wait helper); assert the same row's relative top within ±1px; toggle off; assert again. Repeat for ⌃⌘1 and ⌃⌘3 chords.
- [ ] Follow-bottom case: pin the transcript to bottom, toggle bullseye, assert still at bottom both sides.
- [ ] Diff-card (plain flow / generic fallback) case: open a diff card with a long diff, scroll mid-content, apply a width chord, assert the anchor element's relative top.
- [ ] Drag-resize case: perform a west-edge drag on the transcript pane (background-safe NSEvent mouse path), assert anchor at pointer end.
- [ ] Displacement tripwire: read `data-scroll-displacements` on the transcript scroller before and after each gesture; assert unchanged.
- [ ] All assertions at settle boundaries only (#test-non-goals); `note()` the measured deltas for the diagnostics section.

**Tests:**
- [ ] The file *is* the test.

**Checkpoint:**
- [ ] `just app-test tests/app-test/at0430-resize-scroll-preservation.test.ts`
- [ ] `just app-test-covers-check`

---

#### Step 7: CM6 substrate anchor {#step-7}

**Depends on:** #step-6

**Commit:** `tugdeck(tug-text-editor): line-anchored resize preservation in the CM6 substrate; file-block's writer moves home`

**References:** [P07] CM6 line anchor, [Q01] prompt entry, Table T02, (#existing-machinery)

**Artifacts:**
- shared CM6 line-anchor extension in `tugdeck/src/components/tugways/tug-text-editor.tsx`; adoption in `tug-code-view.tsx` and `tug-text-card-editor.tsx`; `file-block.tsx` refactored onto it

**Tasks:**
- [ ] Extract file-block's `writeScrollState` pattern into a substrate extension exposing: the scroll-state attribute writer (unchanged wire format `{line: {number, offsetPx}, scrollHeight}`), and preserve-begin/end handling on `view.scrollDOM` — begin captures `{line, offsetPx}` from `lineBlockAtHeight(scrollTop)` (claim via `preventDefault`), an `updateListener` re-applies `lineBlockAt(doc.line(n).from).top + offsetPx` on `geometryChanged` while the episode is open, end applies once and releases. Throws pre-measurement swallowed, as today.
- [ ] `TugCodeView` and `TugTextCardEditor` install the extension; `file-block.tsx` drops its local writer in favor of the shared one (same attribute, same mount-restore path — no behavior change to cross-mount preservation).
- [ ] The prompt entry does **not** adopt it ([Q01]).
- [ ] Text-card case appended to at0430: open a text card on a long file, scroll mid-document, width chord + bullseye, assert the anchored *line*'s viewport position (query CM6 line geometry via the test surface, not pixels-only).

**Tests:**
- [ ] at0430 text-card section.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `just app-test tests/app-test/at0430-resize-scroll-preservation.test.ts`

---

#### Step 8: Markdown, PDF, image handlers {#step-8}

**Depends on:** #step-6

**Commit:** `tugdeck(markdown+pdf+file-view): the remaining scrollers claim their episodes — blocks, pages, and fractions`

**References:** [P01], [P06], Table T02, (#existing-machinery)

**Artifacts:**
- episode handlers in `tug-markdown-view.tsx`, `cards/pdf-view.tsx`; fractional variant in `resize-episode.ts` adopted by the image file-view scroller

**Tasks:**
- [ ] `TugMarkdownView`: claim begin with a block-index + intra-block-offset anchor (the block-offset model its content-shrink recovery already navigates); re-anchor from its existing container RO while open; final apply on end.
- [ ] PDF: claim with `{pageIndex, fractionOfPage}` from the current `scrollTop` against the page-position model; re-anchor on the container RO; pages are absolutely positioned so restore is a direct computation.
- [ ] Image file-view: mark the scroller (`.file-view-card`) for the fractional variant — non-reflowing content holds `scrollTop/scrollHeight` fraction. Add the marker attribute the module recognizes (e.g. `data-tug-preserve="fraction"`), documented in Spec S01's module header.
- [ ] Note: `TugMarkdownView` currently ships in gallery only; the handler still lands so the next consumer inherits the invariant.

**Tests:**
- [ ] Unit: fractional variant math in `resize-episode.test.ts`.
- [ ] at0430: PDF case if a fixture PDF exists in the app-test corpus; otherwise the PDF handler is exercised by its RO path and left to the unit-level page-math test — `note()` the omission in the test file header.

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`

---

#### Step 9: Law text + doc {#step-9}

**Depends on:** #step-6

**Commit:** `tuglaws(state-preservation): resize preservation — a width change never moves what the user is looking at`

**References:** [P08] law text, [P01], [P02], (#context, #success-criteria)

**Artifacts:**
- "Resize preservation" section in `tuglaws/state-preservation.md`

**Tasks:**
- [ ] Write the section: the invariant (top-edge anchor through every intermediate frame; follow-bottom stays pinned; non-reflowing content holds fraction), the episode protocol (`tug-scroll-preserve-begin`/`-end` on `[data-tug-scroll-key]`, claim by `preventDefault`), the raise sites (Table T01's content), and the opt-in surface for future scrollers. Cross-link from the existing capture/restore lifecycle sections so a reader of the mount path finds the resize path.

**Tests:**
- [ ] None (doc).

**Checkpoint:**
- [ ] Section present; links resolve (manual read).

---

#### Step 10: Integration Checkpoint {#step-10}

**Depends on:** #step-7, #step-8, #step-9

**Commit:** `N/A (verification only)`

**References:** [P01]–[P08], (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Full at0430 run green: transcript, follow-bottom, diff, drag, text-card, displacement tripwire.
- [ ] at0372 (bullseye geometry + no-write) still green — episodes must not perturb the settle's geometry or provoke a store write.
- [ ] `just app-test-changed` over the full working diff for any additionally-selected files.

**Tests:**
- [ ] Aggregate app-test selection.

**Checkpoint:**
- [ ] `just app-test tests/app-test/at0430-resize-scroll-preservation.test.ts tests/app-test/at0372-bullseye.test.ts`
- [ ] `just app-test-changed`
- [ ] `cd tugdeck && bun test && bunx tsc --noEmit && bunx vite build`

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Every card of every type holds its scroll position — top-edge anchored, follow-bottom pinned, fraction-held where content cannot reflow — across every mechanism that changes a card's width, with the invariant recorded in tuglaws and pinned by at0430.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Bullseye on/off leaves the transcript's anchored row at the same viewport-relative top (at0430)
- [ ] Width chords, the width popup path (same `SET_CARD_WIDTH` action), drag-resize, and rail drags preserve on list, CM6, and plain-flow scrollers (at0430)
- [ ] Follow-bottom stays pinned across all of the above (at0430)
- [ ] `data-scroll-displacements` flat across width gestures (at0430)
- [ ] Cold-boot restore behavior unchanged (existing boot-faithful-restore unit tests + at0372 green)
- [ ] Law section in `tuglaws/state-preservation.md`

**Acceptance tests:**
- [ ] `just app-test tests/app-test/at0430-resize-scroll-preservation.test.ts`
- [ ] `just app-test tests/app-test/at0372-bullseye.test.ts`

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Prompt-entry opt-in to the CM6 line anchor if real use shows drift ([Q01])
- [ ] Height-change anchoring for gestures that change only height (bullseye's full-run stretch is absorbed by the top-edge anchor; a dedicated treatment is deferred until a case demands it)
- [ ] Retiring the generic fallback for any scroller WebKit's future `overflow-anchor` would cover

| Checkpoint | Verification |
|------------|--------------|
| Invariant holds end-to-end | at0430 green |
| Bullseye contract intact | at0372 green |
| No cold-boot regression | `cd tugdeck && bun test` green |
| Bundle clean | `bunx tsc --noEmit && bunx vite build` |
