## Layout Imposer Features — C → A → B → D → E {#layout-imposer-features}

**Purpose:** Implement the five layout-imposer features specified in `roadmap/layout-imposer-brief.md` in the brief's proposed order: **C** always-animated layout changes, **A** multi-select in the Lens Cards section, **B** relative slot nudges, **D** a *flow* layout mode alongside *fit*, **E** vertical splits for content cards. Each phase is a contiguous step range ending in an integration checkpoint, sized to one `/tugplug:dash-implement` invocation.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-19 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-19, Fable 5.** Reviewed `plan:cdb84dfff9963eda`. Lint: 0 errors, 1 warning (the missing-review-record warning, resolved by this round). Oriented on: first review — the freshly authored document, judged against the rubric and the tree. Applied: on the technical-choices axis, Step 13's fit/flow control corrected from `TugOptionGroup` (a multi-toggle, wrong for a mutually-exclusive pair) to `TugChoiceGroup`, which [L19] and the Layouts section's own header doc mandate for every control there; on plan-coherence, [P02]'s ghost capture point pinned to the real close dispatch site (`store.handlePaneClosed` called from `deck-canvas.tsx`) rather than a vaguely named "flow". Symbol claims spot-verified against the tree during authoring and review: `assignCardToSlot`, `getFirstResponderCardId`, `arrangementSignature`, `imposeStyle`/`imposeSidebarStyle`, `RailArrangement`, `LensCardsDataSource`, `lastSelectedRowId`, gesture-record modifier fields, ⌃⌘S and ⌃⌘↑/↓ chord vacancy, and the referenced app-tests (`at0294`, `at0303`, `at0332-pane-occlusion`, `at0401`). Deferred: [Q01] flow-mode trackpad panning stays deferred by design; no new questions raised.

---

### Phase Overview {#phase-overview}

#### Context {#context}

The deck's layout imposer (`tugdeck/src/lib/layout-imposer.ts`) places content cards at slot anchors across the band between the sidebar rails, animating changes through a measured FLIP settle in `tugdeck/src/components/chrome/deck-canvas.tsx`. The system is doctrinally strong where the settle runs, but several geometry paths never enter it (new panes, closing panes, `flushSync` interleavings), the Lens Cards list has no selection model beyond a single cursor, slot moves are absolute-only, overflow is handled only by overlap, and vertical splits exist only for sidebar rails. `roadmap/layout-imposer-brief.md` investigated all five gaps and fixed the order **C → A → B → D → E**; this plan turns that brief into executable steps. The brief's research findings (file paths, symbols, doctrine constraints) are restated here so this document stands alone.

#### Strategy {#strategy}

- **Motion first (Phase C).** Every later phase adds motion paths; they should land on a deck that already keeps the always-animated promise. The cut-detector instrumentation built in C becomes the regression harness for D and E.
- **Selection second (Phase A).** The `LensSelectionStore` and the layout-selection resolver are the shared seam that B's nudge verb and E's split commands act through.
- **Small verb third (Phase B).** The relative nudge is a thin command once A's resolver and batched mutations exist; it also settles the bracket-chord doctrine question.
- **Geometry modes last (Phases D, E).** D's flow mode changes what a slot means (ordinal position vs travel fraction); E's columns extend the slot record. Their data-model shapes are decided together in this plan ([P09], [P11]) so E never reworks D's keys.
- **Laws travel with the steps.** Each step that touches doctrine carries its tuglaws edit in the same commit (chord-tiers residents, list-view-usage matrix, focus-language carve-out, pane-model geometry modes), per the cross-check practice in `tuglaws/tuglaws.md`.
- **Five milestones, five implement calls.** M01=C (steps 1–4), M02=A (steps 5–8), M03=B (steps 9–10), M04=D (steps 11–14), M05=E (steps 15–19).

#### Success Criteria (Measurable) {#success-criteria}

- The cut-census app-test battery (Spec S01) reports zero unexplained cuts across its scripted gesture set: open, close, slot move, width change, rail split flip, tab switch, bullseye enter/exit, rapid retarget (verified by the at-test assertion, not by eye).
- Shift+click, ⌘+click, and shift+arrow build a multi-card selection in the Lens Cards list, visible as the row selection fill; ⌘1..9 and ⌃⌘1..3 then act on every selected card in one animated settle (app-test verified).
- With keyboard focus in the Lens, ⌘1 moves the selected content card(s) — the current silent refusal (deck first responder = the Lens card itself) is gone (app-test verified).
- ⌥⇧⌘[ / ⌥⇧⌘] nudge the selection one slot left/right, clamped as a group, with a visible refusal at the edge (app-test verified).
- In flow mode, cards never overlap, and activating a card not fully inside the band slides the deck minimally until it is, animated through the settle (app-test verified).
- A content slot can be split: two cards in one slot share its column vertically with a draggable seam, and ⌃⌘S / ⌃⌘↑ / ⌃⌘↓ / ⌃⇧⌘↑ / ⌃⇧⌘↓ operate the split from the keyboard (app-test verified).
- `cd tugdeck && bunx vite build` clean and `just app-test-changed` green at every phase exit.

#### Scope {#scope}

1. Cut-detector instrumentation, enter/exit motion for panes, and fixes for the timing hazards enumerated in the brief (Phase C).
2. `LensSelectionStore`, the layout-selection resolver, batched multi-card deck mutations, opt-in `TugListView` multi-select, Cards-section wiring, and the two law amendments (Phase A).
3. The `nudge-slot` command pair on ⌥⇧⌘[ / ⌥⇧⌘] with its chord-tiers entry (Phase B).
4. The `layout: "fit" | "flow"` mode, flow geometry, the flow-offset signature term, reveal-on-activation, and the Layouts-section control (Phase D).
5. Slot-keyed column arrangements (`{mode, order, shares}`), the content-side seam machinery, per-slot Layouts rows, stack-badge menu extension, and the E chord family (Phase E).

#### Non-goals (Explicitly out of scope) {#non-goals}

- Trackpad/scroll-wheel panning of the deck in flow mode (deferred — [Q01]).
- Multi-select in any list other than the Lens Cards section.
- Exit animation for whole-deck teardown (window close, HMR reload).
- Any change to the space allocator's scoring; flow only changes which of its tiers can occur.
- Persisting the flow offset across relaunch ([P10] decides session-only).
- Drag-and-drop of cards between split columns (splits are keyboard/menu/seam-operated in this plan; content drag already evicts slots via the existing gesture path).

#### Dependencies / Prerequisites {#dependencies}

- The brief: `roadmap/layout-imposer-brief.md` (rationale and research trail; this plan restates every fact a step needs).
- Existing FLIP settle machinery: `deck-canvas.tsx` (arm subscriber + settle layout effect), `tugdeck/src/lib/pane-flip.ts`.
- Existing rail-split machinery to port in Phase E: `RailArrangement` and its helpers in `layout-imposer.ts`, the `RailSeam` component in `deck-canvas.tsx`.
- `tugutil` on PATH for `plan lint`; `just app-test-*` recipes for verification.

#### Constraints {#constraints}

- **Warnings are errors** across the workspace; tugdeck changes must pass `bunx vite build` (the debug app loads the prod rollup bundle).
- Tuglaws: [L01] one root render; [L02] external state via `useSyncExternalStore` only; [L03] `useLayoutEffect` for registrations events depend on; [L06] appearance through CSS/DOM, never React state; [L13] CSS for declarative motion, TugAnimator for programmatic motion, rAF is not for animation; [L14] Radix Presence owns enter/exit where Radix is in play; [L27] no retained finished animations.
- Animation doctrine (`tuglaws/animation-doctrine.md`): quiet contract [D1] (zero-delta frames get no animation object), residency [D2]/[D3], no per-frame JS style mutation in product surfaces, no multi-stop `linear()` easings (spring rides in sampled keyframe offsets under keyword `linear`), no transitioning `left`/`top`/`width` for layout motion.
- App-tests are selective: every new test carries `@covers` lines; run via `just app-test-changed` / `just app-test <file>`, never a sweep. Background app-tests cannot deliver menu chords; modifier-click gestures may need `foreground: true` or store-layer coverage (see #test-non-goals).
- Persistent UI state goes through tugbank defaults, never Web storage.

#### Assumptions {#assumptions}

- The five phases land in order; a later phase may assume every earlier step's artifacts exist.
- No second track of work rewrites `deck-canvas.tsx` or `layout-imposer.ts` concurrently.
- The chord decisions here ([P07], [P12]) survive review; if review overturns ⌥⇧⌘[/] for ⌃⌘[/], only Step 9's binding constants change.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows the devise-skeleton anchor and label conventions: explicit kebab-case `{#anchors}` on every cited heading, `#step-N` step anchors, two-digit stable labels (`[P01]`, `[Q01]`, `S01`, `T01`, `R01`, `M01`), `**Depends on:**` lines citing step anchors, and `**References:**` lines citing labels and anchors — never line numbers.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Trackpad panning of the deck in flow mode (DEFERRED) {#q01-flow-trackpad-panning}

**Question:** Should horizontal trackpad scroll pan the deck strip directly in flow mode, in addition to activation-driven reveal?

**Why it matters:** Free panning makes flow feel like a real scroll surface, but it collides with per-card scroll intent arbitration (`tuglaws/scroll-intent.md`) and would give the deck a second offset writer beside activation, complicating the settle-vs-live-scroll story.

**Plan to resolve:** Ship activation-driven reveal first (Phase D). Revisit after living with flow; a follow-on can add panning behind the same `--tug-deck-flow-offset` property without reworking geometry.

**Resolution:** DEFERRED — revisit after M04 ships; tracked in #roadmap-follow-ons.

#### [Q02] Pane exit treatment shape (DECIDED — see [P02]) {#q02-exit-treatment}

**Question:** A closing pane unmounts in frame 0; what visual treatment covers the exit without fighting React's unmount?

**Resolution:** DECIDED — exit ghost overlay, [P02]. If the ghost proves visually wrong in practice, the fallback recorded in [P02] is to keep exits as cuts and record that as an accepted snap in `tuglaws/animation-doctrine.md`.

#### [Q03] Column member persistence strength (DECIDED — see [P11]) {#q03-column-persistence}

**Question:** Rail arrangements key members by `componentId` (sidebar cards are singletons) and persist across close/reopen ([L23]-style). Content cards are not singletons — what do column arrangements key by, and how much persistence do they promise?

**Resolution:** DECIDED — card-id keys with weaker persistence, [P11].

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| New motion paths regress the settle's quiet contract | med | med | Cut-census harness (Step 1) runs in every later phase's checkpoint | Census battery reports a new cut class |
| Modifier-click gestures unverifiable in background app-tests | med | med | Store-layer coverage for selection logic; one `foreground: true` app-test for the real gesture | Foreground tier flakes under contention |
| Flow mode interacts badly with the space allocator | med | low | Flow never overlaps, so the allocator's overlap tier is vacuous; assert allocator output unchanged in fit mode via existing golden | `at0303` imposer-space-allocator app-test drifts |
| Persisted `DeckImposition` grows new fields older builds don't know | low | med | New fields are optional; serialization tolerates absence (same pattern as `rails`) | Deck state fails to restore after relaunch |
| Chord decisions contested at review | low | med | [P07]/[P12] record fallbacks; only binding constants move | Review round overturns a chord |

**Risk R01: Settle regression from enter/exit motion** {#r01-settle-regression}

- **Risk:** The enter/exit treatments (Step 2) add animation objects to frames the settle also animates, violating the one-effect-per-frame clock ([D135] in `tuglaws/design-decisions.md`).
- **Mitigation:** Enter/exit effects use distinct TugAnimator slot keys (`imposer-enter`, `imposer-exit-ghost`) and animate only `opacity` + `transform` on elements the geometry effect does not target (the ghost is a separate element; the enter effect composites over the settled geometry).
- **Residual risk:** A rapid open→retarget inside one settle window can still produce a visible correction; the census test pins the acceptable bound.

**Risk R02: Selection store drifts from deck reality** {#r02-selection-drift}

- **Risk:** Selected card ids can go stale (card closed, moved to another pane, dashed away) leaving the resolver acting on ghosts.
- **Mitigation:** The resolver filters ids against the live registry at read time; the store subscribes to deck changes only to prune (never to grow) its set.
- **Residual risk:** A pruned-to-empty selection silently falls back to first-responder resolution — by design, but worth a diagnostic note in the store.

---

### Design Decisions {#design-decisions}

#### [P01] The cut detector is diagnostics, not product surface (DECIDED) {#p01-cut-detector-diagnostic}

**Decision:** The cut detector is a dev/test-gated observer module (`tugdeck/src/lib/cut-detector.ts`) that samples pane rects per frame **only while explicitly enabled** (app-test surface or dev panel), and ships disabled with zero standing cost.

**Rationale:**
- The animation doctrine bans per-frame JS style *mutation* in product surfaces and reserves per-frame *measurement* for bench probes; a gated diagnostic is a bench probe.
- The quiet contract [D1] demands zero standing timers at rest — the detector must not exist unless armed.

**Implications:**
- Enabled via the test surface (`tugdeck/src/test-surface.ts`) and the dev panel (`tugDevLogStore`), never by default.
- It reads `getBoundingClientRect()` and `el.getAnimations()` per armed frame; it never writes styles.
- Findings are reported as structured records (paneId, frame delta px, running-animation count) the app-test asserts over.

#### [P02] Enter is fade+rise in the settle window; exit is a ghost (DECIDED) {#p02-enter-exit-treatments}

**Decision:** A newly mounted imposed pane plays an enter effect (opacity 0→1 plus a small translateY rise, ~8px, at its final geometry) through TugAnimator in the same settle window; a closing pane leaves a **ghost** — a position-fixed snapshot element appended to the frames container, playing opacity 1→0 for the settle duration, then removed.

**Rationale:**
- The settle skips frames with no First rect (a new pane has none), so enter motion must be authored, not derived.
- React unmounts the closing pane synchronously; only an element outside the pane's React subtree can outlive it. [L14] does not apply — panes are not Radix Presence surfaces.
- Opacity is exempt from the compositor-residency concern; the ghost never animates layout properties.

**Implications:**
- The ghost captures the pane's rect in the close path before unmount — the close is dispatched as `store.handlePaneClosed(stackState.id)` from `deck-canvas.tsx`, and the capture happens at that dispatch site while the frame still exists. It renders a plain styled div (background token fill + border radius), not a live DOM clone, to keep cost and correctness trivial.
- Enter/exit use TugAnimator slot keys `imposer-enter` / `imposer-exit-ghost`, `fill: "none"`, and self-remove on finish ([L27], [D6]).
- Fallback if the ghost reads wrong in practice: delete it and record closes as an accepted snap in `tuglaws/animation-doctrine.md` (see [Q02]).

#### [P03] "The layout selection" is a resolver: selection store first, first responder fallback (DECIDED) {#p03-layout-selection-resolver}

**Decision:** Layout verbs (slot assign, width, nudge, split commands) resolve their target through one function, `resolveLayoutSelection()`: if the `LensSelectionStore` holds a non-empty, live selection, it returns those card ids (ordered); otherwise it returns the deck's first responder card (`DeckManager.getFirstResponderCardId()`), or none.

**Rationale:**
- Today ⌘1 reads only the first responder, and with keyboard focus in the Lens the first responder *is* the Lens card (a sidebar card), so the `MOVE_TO_SLOT` handler in `deck-canvas.tsx` silently refuses — the resolver fixes A's headline bug and gives B and E their target semantics for free.
- One seam keeps "what does a layout verb act on" answerable in one place.

**Implications:**
- "Live" means: the Lens is open and its Cards list holds key view, **or** the selection was explicitly made and not since cleared — concretely, the store carries the set and clears it on deck-level activation gestures that contradict it (activating a card outside the selection collapses the set to that card).
- The resolver filters ids against the card registry at read time (see Risk R02).
- Single-card behavior today is the degenerate case; no behavior change when the selection is empty.

#### [P04] Multi-card mutations are single DeckManager commits (DECIDED) {#p04-batched-commits}

**Decision:** New batched mutators — `assignCardsToSlots(entries: {cardId, slot}[])` and `setCardWidths(cardIds, preset)` — apply all geometry in **one** commit/notify, mirroring `setContentWidth`'s deliberate one-commit shape.

**Rationale:**
- The FLIP settle re-arms per notify; per-card commits re-measure First mid-flight and break the motion. `setContentWidth` (`deck-manager.ts`) was rebuilt as one commit for exactly this reason and documents it.

**Implications:**
- `assignCardsToSlots` performs raise (z-order) work in its own preceding commit exactly as `assignCardToSlot` does today (raise arms nothing — the signature is z-blind), then all slot writes in one geometry commit.
- The single-card paths delegate to the batched ones (a one-element batch), so there is one implementation.
- Group refusal semantics live here: an entry set that violates clamping as a group is refused whole ([P08]).

#### [P05] Multi-select is an opt-in TugListView capability, with two law amendments (DECIDED) {#p05-listview-multiselect}

**Decision:** `TugListView` grows an opt-in multi-select mode (consumer-owned: the host supplies the selected-id set and receives selection intents), rendered as the primitive's own `data-selected` fill on every member row; `tuglaws/list-view-usage.md`'s selection-ownership matrix gains this as a named fifth intent, and `tuglaws/focus-language.md`'s "arrows never select" gains the carve-out: **a bare arrow never selects; a modifier-extended arrow is a selection gesture**.

**Rationale:**
- The matrix says "do not invent a third path" — so the path must be added to the matrix, not bolted on beside it.
- `focus-language.md` already anticipates multi-select: the focus ring is offset outside the item precisely so multi-select needs no extra checkmark.
- Selection state is consumer-owned (the `LensSelectionStore`) because the selection outlives the list's mount and other surfaces (deck handlers) read it — the list is a view of it, per [L02].

**Implications:**
- Pointer path: shift/⌘ facts come from the gesture record (`gesture-interpreter.ts` already records `metaKey`/`shiftKey`) read in `TugListView`'s pointerdown callback — selection commits at pointerdown, never at click (`focus-language.md` pointer doctrine).
- Keyboard path: the backstop key handler in `tug-list-view.tsx` currently returns early on any `metaKey || ctrlKey`; it learns shift+Arrow/Home/End as anchor-ranged selection extension. The spatial cursor handle (which never sees the KeyboardEvent) is untouched — extension rides the backstop, movement rides the handle.
- Anchor semantics: shift+click and shift+arrow extend from the anchor (last non-shift pick); ⌘+click toggles membership and moves the anchor.
- Only member rows (`role === "cell"`, excluding group headers) are selectable; the Cards inventory row in `list-view-usage.md` updates from "none, cursor only".

#### [P06] In the Cards list, select and activate decouple (DECIDED) {#p06-select-vs-activate}

**Decision:** A plain click keeps today's behavior (select + front the card, selection collapses to one). ⌘+click and shift+click modify the selection **without** dispatching `focus-session-card` — the deck does not raise or re-front while a multi-selection is being built. Enter/Space on the cursor row still activates.

**Rationale:**
- Building a selection by clicking would otherwise front every card touched, thrashing z-order and (in flow mode later) scrolling the deck.
- Matches every native multi-select list (Finder, Mail): modifier clicks are selection edits, not open gestures.

**Implications:**
- The Cards delegate's `onSelect` splits: modifier-classified gestures route to the `LensSelectionStore`; plain ones keep the activate path.
- Activating a card outside the current selection (any surface) collapses the selection to that card ([P03] liveness rule).

#### [P07] The nudge chord is ⌥⇧⌘[ / ⌥⇧⌘], read as the ⌥-variant of the lateral ring (DECIDED) {#p07-nudge-chord}

**Decision:** `nudge-slot:left` / `nudge-slot:right` bind ⌥⇧⌘[ and ⌥⇧⌘], deliberately unpromoted to any menu (the same [Q02]-comment pattern as ⌘1..9 in `command-registry.ts`), with a residents entry added to `tuglaws/chord-tiers.md` recording the R1 reading.

**Rationale:**
- Mechanically free: the only bracket chords in the codebase are ⇧⌘[/] (lateral card ring) and ⌥⌘[/] (stack ring); plain ⌘[/] is pool-reserved for back/forward; ⌥⇧⌘ brackets are unclaimed by Tug, macOS, and WebKit.
- Doctrinal reading: ⇧⌘[/] moves *attention* laterally across the cards; the ⌥ operator means "same verb, altered object" — ⌥⇧⌘[/] moves *the card itself* laterally. Same keys, same axis, altered object.
- Fallback recorded: if review rejects the R1 reading, ⌃⌘[/] (Tug layout tier, brackets free there) is the alternative; only the binding constants change.

**Implications:**
- Unpromoted means no Swift menu item and no `codeToKeyEquivalent` asymmetry (which would render ⌥⌘{ / ⌥⌘}).
- The chord-tiers residents table gains the pair with its reading, in the same commit as the binding (laws travel with steps).

#### [P08] Nudges clamp as a group and refuse visibly (DECIDED) {#p08-group-clamp}

**Decision:** A nudge moves every card in the layout selection by ±1 slot; if **any** member is already at the edge in the travel direction, the whole nudge refuses, preserving the selection's relative arrangement. Refusal is visible: the edge-blocked pane's border flashes (`flashPaneBorder`, the existing slot-landing treatment).

**Rationale:**
- Per-card clamping would silently compress the selection against the edge, destroying the arrangement the user is trying to move.
- Errors never fail silently — a refused gesture produces the act or a visible reason.

**Implications:**
- The clamp check lives in `assignCardsToSlots` ([P04]) so every caller gets it.
- Success flashes nothing extra (the settle's motion is the feedback); refusal flashes the blocking pane.

#### [P09] Flow is a mode bit on DeckImposition; slots become ordinal (DECIDED) {#p09-flow-mode-bit}

**Decision:** `DeckImposition` gains `layout?: "fit" | "flow"` (absent = `"fit"`, no migration needed). In flow, slot k's left edge is the running sum of the widths (plus `IMPOSITION_GAP_PX`) of slots 0..k−1 — ordinal position in a strip — instead of the travel-fraction anchor. `kind` (N-up) survives as the slot vocabulary (⌘1..9 range, Layouts miniature) but no longer determines geometry in flow.

**Rationale:**
- The record already persists `kind`/`contentWidth`/`sidebars`/`rails` as optional fields; one more optional field follows the established shape.
- Ordinal geometry is the definition of "never overlap": each slot's extent is its occupant's width.
- Keeping `kind` preserves every existing entry point (⌘1..9, miniature, Layouts picker) without a vocabulary fork.

**Implications:**
- Pure functions in `layout-imposer.ts` compute flow lefts from the occupied-slot list; golden-tested like the allocator.
- A slot with multiple stacked panes contributes the width of its widest member (and in Phase E, a split column contributes its column width).
- `pane-model.md` gains flow as a documented geometry mode.

#### [P10] The flow offset is activation-derived, session-only, and a signature term (DECIDED) {#p10-flow-offset}

**Decision:** The deck's flow offset is state on `DeckManager` (not persisted; starts at 0 each session), written only by the reveal rule — on activation in flow mode, compute the minimal offset change that brings the active card fully inside the band (`scrollRectToVisible` semantics) — and applied to the DOM as one custom property, `--tug-deck-flow-offset`, folded as a subtraction term into `imposeStyle`'s single `left` calc. The offset (rounded px) becomes a term in `arrangementSignature`.

**Rationale:**
- `imposeStyle` already emits exactly one `left` expression per pane; one more `var()` term keeps window resize pure-CSS.
- Activation is deliberately z-blind in the signature; a distinct offset term lets reveal animate through the existing settle without un-blinding z.
- Session-only persistence: the offset is derivable (re-activating any card re-reveals it); persisting it buys nothing and risks restoring a stale viewport.

**Implications:**
- `activateCard` gains its first geometry consequence, but only via the offset term — the z-order commit itself still arms nothing when the offset doesn't change.
- Window resize in flow re-clamps the offset via the existing settled-resize retune moment (200ms quiet), not per-frame.
- Bullseye is unchanged: it already supersedes the pane's mode and slides others off-canvas.

#### [P11] Columns mirror rails: slot-keyed `{mode, order, shares}` with card-id members (DECIDED) {#p11-columns-mirror-rails}

**Decision:** Content splits are recorded as `DeckImposition.columns?: Record<number, ColumnArrangement>` — keyed by slot index — where `ColumnArrangement` has the exact `RailArrangement` shape (`mode?: "stack" | "split"`, `order?: string[]`, `shares?: Record<string, number>`), with members keyed by **card id** (content cards are not singletons, unlike sidebar cards keyed by componentId).

**Rationale:**
- `slotStackByPaneId` in `deck-canvas.tsx` already treats a rail and a slot as the same kind of "place"; the record extension follows the abstraction the code already names.
- Reusing the arrangement shape lets the seam math (`railSeamFractions`, `railSharesFromFractions`, `railWeightOf`), the seam component, and the split/stack choreography port rather than fork.

**Implications:**
- Persistence is weaker than rails: card ids die with their cards, so a column's `order`/`shares` entries for closed cards are inert residue (harmless, [L23]-style never-cleaned) but do not restore across a card's close/reopen. This is accepted ([Q03]).
- Seam custom properties generalize from side-keyed to place-keyed: `--tug-slot-<k>-seam-<j>` beside `--tug-rail-<side>-seam-<j>`.
- Layout-tree invariant 6 (a sidebar pane carries no slot) stands; a new invariant asserts a column's `order` members, when present, are cards in panes assigned to that slot.
- In flow mode ([P09]) a split column contributes one width to the strip: the widest member's pane width.

#### [P12] The split chord family: ⌃⌘S, ⌃⌘↑/↓, ⌃⇧⌘↑/↓ (DECIDED) {#p12-split-chords}

**Decision:** `toggle-column-split` binds ⌃⌘S (split/stack for the slot holding the layout selection's card, or the first responder's slot). `move-in-column:up/down` bind ⌃⌘↑ / ⌃⌘↓. `move-in-column:top/bottom` bind ⌃⇧⌘↑ / ⌃⇧⌘↓.

**Rationale:**
- ⌃⌘ is Tug's layout vocabulary tier; letter S is unoccupied there (verified: only ⌘S and ⇧⌘S exist on KeyS) and mnemonic for split.
- Arrows are R1-exempt (rule R2 in `chord-tiers.md`); ⌃⌘ arrows are unbound in Tug and absent from the macOS never-bind list (which reserves plain ⌃-arrows, not ⌃⌘).
- ⌃⇧⌘ is the counterpart set of a ⌃⌘ base — top/bottom is the ⇧-extreme of up/down, exactly the ⌥⇧⌘↑/↓ First/Last Turn pattern one tier over.

**Implications:**
- All five get chord-tiers residents entries in the same commit as the bindings.
- In a stacked (unsplit) column, ⌃⌘↑/↓ are the natural promote/demote within the stack's z-order — decided here as in-scope so the chords are never dead on an unsplit slot.

---

### Deep Dives {#deep-dives}

#### The ground: how geometry and motion work today {#ground-today}

Facts a cold implementer needs, verified against the tree at authoring time.

**Geometry.** `layout-imposer.ts` is pure: a slot is a position anchor — `offset = travelFraction(slot, count) × max(0, band − width)`, band = canvas minus rail insets minus `IMPOSITION_GAP_PX` (5) each side; `IMPOSITION_GAP_BOTTOM_PX` = 32. `imposeStyle(placement, slotWidth, pinnedFrame?)` emits one inline `left` calc (never `right`) plus `width`, `top`, `bottom`; `imposeSidebarStyle(side, paneWidth, {member?})` emits a rail-mixed `left` and, for split rails, member pins over `--tug-rail-<side>-seam-<j>` custom properties. Width presets `CONTENT_WIDTH_SLIM_PX`/`COMFY`/`WIDE` = 675/800/1230. Overflow overlaps by design; nothing scrolls (`layout-tree.ts` states "the deck does not scroll"). The space allocator (`allocateSidebarWidths`) flexes only rail widths, scored lexicographically `[worstOverlap, worstShortfall, worstError, preferred-distance]`.

**State.** All layout state lives in `DeckManager` (`deck-manager.ts`), published via `useSyncExternalStore` through `IDeckManagerStore`. Per-pane: `TugPaneState.slot?`, `widthPreset?`. Deck-wide: `DeckState.imposition: DeckImposition { kind?, contentWidth?, sidebars, rails? }`. `assignCardToSlot(cardId, slot)` raises first in its own commit, then writes geometry in one commit via `_commitImposition`. `getFirstResponderCardId()` = active pane's active card. `setContentWidth` is deliberately one commit — its doc comment records that per-pane notification broke the settle.

**Motion.** No CSS transitions on pane geometry (`tug-pane.css` documents this). `arrangementSignature(state)` in `deck-canvas.tsx` — terms: imposition record, slot↔pane map, rail widths/modes/seams, per-pane width; deliberately z-blind, height-blind, free-position-blind. A store subscriber (`arm`) measures First rects pre-commit, cancels stragglers `snap-to-end`, sets `data-imposer-settling` + `--tugx-imposer-settle-duration` (`IMPOSITION_SETTLE_MS` = 300); a `useLayoutEffect` keyed on the signature measures Last and plays one WAAPI effect per moved frame via TugAnimator (slot key `imposer-flip`): `translate` (+`scaleX` under 20% distortion — [D135]), real `width`/`height` keyframes otherwise; spring rides in 32 sampled keyframe offsets under keyword `linear` easing (`pane-flip.ts`). Frames with `data-gesture` are skipped. New frames (no First rect) are skipped — the enter cut. TugAnimator `commitStyles()` + `cancel()` on finish; `clearFlip` strips inline transform residue.

**Selection.** The Cards section (`tugdeck/src/components/lens/sections/cards-section.tsx`) is a `TugListView` over `LensCardsDataSource` (`cards-data-source.ts`) with no selection props: one internal scalar `selectedIndex`, one cursor ref, and a module-level `lastSelectedRowId` used only to re-seed the cursor. The delegate's `onSelect` **is** `activate` — it dispatches `focus-session-card`. The backstop key handler bails on any meta/ctrl modifier. `gesture-interpreter.ts` already records `metaKey`/`shiftKey` in the gesture record and is the sole owner of pointer classification.

**Rail splits.** `RailArrangement { mode?, order?, shares? }` at `imposition.rails[side]`; helpers `effectiveRailOrder`, `railModeOf`, `railSeamFractions`, `railSharesFromFractions`, `railWeightOf`, `railMemberPins` in `layout-imposer.ts`; seam properties written by a `useLayoutEffect` in `deck-canvas.tsx` (declared before the settle's Last effect — order load-bearing); the `RailSeam` component owns the pointer drag (rAF property write, commit via `railSharesFromFractions` → `setRailShares`); split/stack flip choreography: z-frontmost member moves with a real height term, other members fade and hold.

#### The cut census: enumerated classes {#cut-census-classes}

From the brief's research; the detector (Step 1) verifies which remain after fixes.

Structural: (1) new pane snaps (no First rect); (2) closing pane cuts at unmount; (3) `data-gesture` frames snap when a commit lands the same tick a gesture ends; (4) signature blind spots — height, free-pane position; (5) non-store geometry (theme swap, chrome-tier attributes) snaps — **accepted**, recorded in doctrine (Step 4); (6) the settled-resize retune re-arranges 200ms after the hand stops — accepted for now, noted in doctrine.

Timing hazards (bugs): (7) `flushSync` inside the notify chain forces DOM to Last geometry before `arm` measures — sites: detach and move-card-to-pane in `deck-manager.ts`, activation transfer in `focus-transfer.ts`; (8) `arm` subscribes in a `useEffect` (post-paint gap on mount); (9) `snap-to-end` → `finish()` → unconditional `commitStyles()` can leave stale inline width/height for a frame on rapid retarget; (10) occlusion controller: hides ride a 400ms timer that checks animations only on the frame element; reveals are synchronous — fast raise/hide/reveal can flash; (11) the session-notification hold flushes at settle release — a content pop at settle end (accepted; note in doctrine).

#### Flow geometry {#flow-geometry}

In flow, the occupied slots (ascending index) form a strip: `stripLeft(k) = Σ_{j<k, occupied} (slotExtent(j) + IMPOSITION_GAP_PX)`. `slotExtent(j)` = widest member pane width (Phase E: a split column's widest member). Pane left = `railInsetLeft + IMPOSITION_GAP_PX + stripLeft(k) − flowOffset`. The reveal rule: given the active card's `[stripLeft, stripLeft + extent]` and viewport `[flowOffset, flowOffset + band]`, the minimal new offset clamps so the card's interval is inside the viewport (card wider than band: pin its left edge). Offset is clamped to `[0, max(0, stripWidth − band)]`. All pure functions, unit-tested; the settle animates offset changes because the rounded offset is a signature term ([P10]).

---

### Specification {#specification}

**Spec S01: Cut detector record and battery** {#s01-cut-detector}

While armed, the detector samples each `.tug-pane[data-pane-id]` per frame (rAF loop is legal here per [P01]) and emits a record `{paneId, dx, dy, dw, dh, animations, gesture}` whenever a rect changes by more than 2px on any axis between consecutive frames with `el.getAnimations().length === 0` and no `data-gesture`. The battery app-test arms it, drives: card open into a slot, card close, ⌘-digit slot move, width preset change, rail split→stack→split, tab switch within a stack, bullseye enter/exit, and a rapid double slot-move (retarget inside the settle window) — then asserts the record set contains no entries outside the accepted classes (#cut-census-classes items 5, 6, 11).

**Spec S02: LensSelectionStore surface** {#s02-selection-store}

`tugdeck/src/components/lens/lens-selection-store.ts`: external store (subscribe/getSnapshot) holding `{ ids: readonly string[], anchorId: string | null }` (ordered by pick sequence). Mutators: `pickOnly(id)`, `toggle(id)`, `extendTo(id, dataSourceOrder)` (anchor-ranged over the list's current visible order), `clear()`, `pruneTo(liveIds)`. Read by `resolveLayoutSelection()` and the Cards section; written only by Cards-section gestures and the collapse rule ([P03], [P06]).

**Spec S03: Command additions** {#s03-command-additions}

| Command id | Chord | Routing | Handler | Phase |
|---|---|---|---|---|
| `nudge-slot:left` / `nudge-slot:right` | ⌥⇧⌘[ / ⌥⇧⌘] | first-responder | deck canvas responder | B |
| `set-imposition-layout` (`fit`/`flow`) | — (Layouts UI only) | registry | action-dispatch → `DeckManager.setImpositionLayout` | D |
| `toggle-column-split` | ⌃⌘S | first-responder | deck canvas responder | E |
| `move-in-column:up` / `:down` | ⌃⌘↑ / ⌃⌘↓ | first-responder | deck canvas responder | E |
| `move-in-column:top` / `:bottom` | ⌃⇧⌘↑ / ⌃⇧⌘↓ | first-responder | deck canvas responder | E |

All chord entries follow the `command-registry.ts` pattern: `chord({key, meta, alt, shift, ctrl}, {preventDefault: true})`; none are menu-promoted ([P07]; the split family may be menu-promoted later as follow-on work).

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| Cut-detector records | diagnostics (dev/test only) | module singleton + test-surface accessor | [P01], doctrine bench-probe carve-out |
| Selection set + anchor | structure | `LensSelectionStore` + `useSyncExternalStore` | [L02] |
| Row selected fill | appearance | `data-selected` attribute stamped by TugListView; CSS owns the paint | [L06] |
| Flow mode (`imposition.layout`) | structure | `DeckManager` state, persisted with the imposition record | [L02] |
| Flow offset | structure → appearance | `DeckManager` field → `--tug-deck-flow-offset` custom property written in the deck-canvas inset effect | [L02], [L06] |
| Column arrangements (`imposition.columns`) | structure | `DeckManager` state, persisted | [L02] |
| Column seam positions | appearance | `--tug-slot-<k>-seam-<j>` custom properties; drag writes property per rAF like `RailSeam` | [L06] |
| Enter/exit motion | programmatic motion | TugAnimator effects, distinct slot keys, self-removing | [L13], [L27] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/lib/cut-detector.ts` | Armed-only per-frame rect sampler emitting cut records ([P01], Spec S01) |
| `tugdeck/src/components/lens/lens-selection-store.ts` | The layout selection store (Spec S02) |
| `tugdeck/src/lib/layout-selection.ts` | `resolveLayoutSelection()` ([P03]) |
| `tests/app-test/at0450-imposer-cut-census.test.ts` | Spec S01 battery (`@covers` deck-canvas, layout-imposer, pane-flip) |
| `tests/app-test/at0451-lens-multiselect.test.ts` | Phase A gestures + batched verbs |
| `tests/app-test/at0452-nudge-slot.test.ts` | Phase B nudge + group clamp |
| `tests/app-test/at0453-flow-mode.test.ts` | Phase D reveal + no-overlap |
| `tests/app-test/at0454-column-split.test.ts` | Phase E splits + chords |

Numbers `at0450+` are placeholders — take the next free numbers at implementation time and keep the slugs.

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `CutDetector`, `armCutDetector` | class/fn | `tugdeck/src/lib/cut-detector.ts` | [P01]; test-surface exposure in `test-surface.ts` |
| `LensSelectionStore` | class | `lens-selection-store.ts` | Spec S02 |
| `resolveLayoutSelection` | fn | `tugdeck/src/lib/layout-selection.ts` | [P03] |
| `assignCardsToSlots`, `setCardWidths` | method | `tugdeck/src/deck-manager.ts` | [P04]; single-card paths delegate |
| `multiSelect` props (set + intents) | props | `tugdeck/src/components/tugways/tug-list-view.tsx` | [P05] |
| `nudge-slot:left/right` entries | CommandEntry | `tugdeck/src/components/tugways/command-registry.ts` | [P07], Spec S03 |
| `layout?: "fit" \| "flow"` | field | `DeckImposition`, `tugdeck/src/lib/layout-imposer.ts` | [P09] |
| `flowStripPositions`, `flowRevealOffset` | fn | `tugdeck/src/lib/layout-imposer.ts` | #flow-geometry, pure |
| `setImpositionLayout`, `setFlowOffset` | method | `tugdeck/src/deck-manager.ts` | [P09], [P10] |
| `--tug-deck-flow-offset` term | calc term | `imposeStyle`, `layout-imposer.ts` | [P10] |
| `ColumnArrangement`, `columns?` | type/field | `layout-imposer.ts` | [P11]; shape-shared with `RailArrangement` |
| `columnSeamProperty`, `columnMemberPins` | fn | `layout-imposer.ts` | generalized from rail equivalents |
| `toggle-column-split`, `move-in-column:*` | CommandEntry | `command-registry.ts` | [P12], Spec S03 |
| `setColumnMode`, `setColumnOrder`, `setColumnShares` | method | `deck-manager.ts` | mirror `setRailMode/Order/Shares` |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/animation-doctrine.md`: accepted-snap list (theme swap, chrome tier, retune delay, settle-release content pop) — Step 4.
- [ ] `tuglaws/list-view-usage.md`: matrix fifth intent + Cards inventory row — Step 6.
- [ ] `tuglaws/focus-language.md`: modifier-arrow selection carve-out — Step 6.
- [ ] `tuglaws/chord-tiers.md`: ⌥⇧⌘[/] residents entry (Step 9); ⌃⌘S, ⌃⌘↑/↓, ⌃⇧⌘↑/↓ entries (Step 18).
- [ ] `tuglaws/pane-model.md`: flow geometry mode (Step 13); column splits (Step 17).

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (bun:test)** | Pure imposer geometry: flow positions, reveal offsets, column pins, selection-store logic | `tugdeck/src/lib/__tests__/`, data-in/data-out |
| **Golden** | Flow position sweep beside the existing allocator golden | drift detection on geometry |
| **App-test** | Real gestures, motion, focus, selection fills | everything behavioral; selective via `@covers` |

#### What stays out of tests {#test-non-goals}

- Fake-DOM / RTL render tests — banned; there is no in-process DOM substrate.
- Mock-store assertion tests — banned; `tsc` catches interface drift.
- Real modifier-click keyboard/mouse combinations in **background** app-tests where the harness cannot deliver them — selection *logic* (anchor, toggle, extend, prune) is covered at the store layer in bun:test; one app-test exercises the real gesture path and is marked `foreground: true` only if background NSEvent modifier clicks prove undeliverable during implementation.
- Per-mutator reflexive pins on the new DeckManager methods — integration app-tests cover the real paths.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** Phases map to milestones: M01 = steps 1–4, M02 = steps 5–8, M03 = steps 9–10, M04 = steps 11–14, M05 = steps 15–19. Run `/tugplug:dash-implement` once per milestone range.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | C: cut detector + census battery | done | `4dc1d5165` |
| #step-2 | C: pane enter and exit motion | done | `9acdb5c26` |
| #step-3 | C: timing-hazard fixes | done | `37ca7468f` |
| #step-4 | C: integration checkpoint + doctrine notes | done | `1ce2ada5d` |
| #step-5 | A: selection store, resolver, batched mutators | done | `a3ff99a14` |
| #step-6 | A: TugListView multi-select + law amendments | done | `19b1d2873` |
| #step-7 | A: Cards section wiring + command retarget | done | `a4c65b50e` |
| #step-8 | A: integration checkpoint | done | `130bfd289` |
| #step-9 | B: nudge-slot commands + chord doctrine | pending | — |
| #step-10 | B: integration checkpoint | pending | — |
| #step-11 | D: flow geometry + mode bit | pending | — |
| #step-12 | D: offset plumbing + reveal-on-activation | pending | — |
| #step-13 | D: Layouts UI + pane-model doc | pending | — |
| #step-14 | D: integration checkpoint | pending | — |
| #step-15 | E: column data model | pending | — |
| #step-16 | E: column geometry + seams | pending | — |
| #step-17 | E: column UI + choreography | pending | — |
| #step-18 | E: split chord family | pending | — |
| #step-19 | E: integration checkpoint | pending | — |

#### Step 1: C — cut detector and census battery {#step-1}

**Commit:** `tugdeck(imposer-motion): cut detector diagnostics and the census app-test battery`

**References:** [P01] cut detector is diagnostics, Spec S01, (#cut-census-classes, #ground-today)

**Artifacts:**
- `tugdeck/src/lib/cut-detector.ts`; test-surface accessor in `tugdeck/src/test-surface.ts`; dev-panel arm/disarm via `tugDevLogStore`.
- `tests/app-test/at0450-imposer-cut-census.test.ts` with `@covers` for `deck-canvas.tsx`, `layout-imposer.ts`, `pane-flip.ts`.

**Tasks:**
- [ ] Implement the detector per Spec S01: armed-only rAF sampling of `.tug-pane[data-pane-id]` rects, record on >2px unanimated delta, skip `data-gesture` frames; disarm cancels the loop and drops all state ([P01] quiet contract).
- [ ] Expose `armCutDetector()` / `disarmCutDetector()` / `takeCutRecords()` on the test surface.
- [ ] Write the battery test driving the Spec S01 gesture set; assert records only from accepted classes. At this step the assertion allowlist includes the known defects (enter cut, exit cut, flushSync sites) so the test is green before the fixes; Steps 2–3 shrink the allowlist.

**Tests:**
- [ ] bun:test for the detector's delta/animation classification over synthetic samples (pure logic extracted from the DOM reader).
- [ ] `at0450-imposer-cut-census` runs green with the initial allowlist.

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test tests/app-test/at0450-imposer-cut-census.test.ts`

---

#### Step 2: C — pane enter and exit motion {#step-2}

**Depends on:** #step-1

**Commit:** `tugdeck(imposer-motion): enter fade-rise and exit ghost for imposed panes`

**References:** [P02] enter/exit treatments, Risk R01, [Q02], (#cut-census-classes, #ground-today)

**Artifacts:**
- Enter effect in the settle's Last pass in `deck-canvas.tsx` (frames with no First rect get `imposer-enter` instead of being skipped); exit ghost creation in the pane-close path.

**Tasks:**
- [ ] Enter: in the settle layout effect, a frame with no First rect plays opacity 0→1 + translateY(8px→0) at its final geometry via TugAnimator (slot `imposer-enter`, `fill: "none"`, settle duration), instead of the current silent `continue`. Reduced-motion (`isTugMotionEnabled()` false) skips it, matching the settle's own gate.
- [ ] Exit: capture the closing pane's rect before unmount in the close flow; append a ghost div (fixed-position, pane ground token fill, pane border radius) to the frames container; play opacity 1→0 (slot `imposer-exit-ghost`); remove on finish. Guard: at most one ghost per pane id; deck teardown removes all ghosts.
- [ ] Shrink the census allowlist: enter and exit classes removed.

**Tests:**
- [ ] `at0450` battery: open and close now produce no cut records; ghost element absent after settle (quiet contract).

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test tests/app-test/at0450-imposer-cut-census.test.ts tests/app-test/at0294-imposer-flip-settle.test.ts`

---

#### Step 3: C — timing-hazard fixes {#step-3}

**Depends on:** #step-1

**Commit:** `tugdeck(imposer-motion): measure-before-flush, layout-effect arm, retarget residue, occlusion animation scan`

**References:** [P01] detector as verifier, Risk R01, (#cut-census-classes)

**Artifacts:**
- Fixes for classes 7–10 in #cut-census-classes.

**Tasks:**
- [ ] `flushSync` sites (detach and move-card-to-pane in `deck-manager.ts`, activation transfer in `focus-transfer.ts`): ensure First rects are captured before the synchronous commit — either by having the settle's `arm` subscriber registered ahead of `useSyncExternalStore`'s (subscription-order audit) or by an explicit pre-flush measure hook the mutator calls; pick whichever the audit shows is reliable, and document the choice in a comment at the arm site.
- [ ] Move the `arm` subscription registration from `useEffect` to `useLayoutEffect` in `deck-canvas.tsx` ([L03] — a registration events depend on).
- [ ] Rapid-retarget residue: on `snap-to-end` cancellation inside `arm`, restore held inline `width`/`height`/`opacity` synchronously (invoke the restorer immediately after the cancel) so no frame paints stale baked pixels.
- [ ] Occlusion hides: extend the hide-timer's animation check to consult the settle window (`data-imposer-settling` on the container) in addition to frame-element animations, deferring hides while a settle runs.
- [ ] Shrink the census allowlist accordingly.

**Tests:**
- [ ] `at0450` battery: rapid double slot-move and tab-switch-during-settle produce no cut records.
- [ ] Existing `at0332-pane-occlusion.test.ts` stays green.

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test tests/app-test/at0450-imposer-cut-census.test.ts tests/app-test/at0332-pane-occlusion.test.ts tests/app-test/at0294-imposer-flip-settle.test.ts`

---

#### Step 4: C — integration checkpoint and doctrine notes {#step-4}

**Depends on:** #step-2, #step-3

**Commit:** `tuglaws(animation-doctrine): record the accepted snaps; imposer motion census green`

**References:** [P02], Spec S01, Milestone M01, (#success-criteria, #cut-census-classes)

**Artifacts:**
- `tuglaws/animation-doctrine.md` accepted-snap list (classes 5, 6, 11: theme/chrome-attr snaps, retune delay, settle-release content pop).

**Tasks:**
- [ ] Verify the census battery's final allowlist contains only the accepted classes; the doctrine edit names each with its rationale.
- [ ] Run the full changed-derived selection.

**Tests:**
- [ ] `at0450` green with the final allowlist.

**Checkpoint:**
- [ ] `just app-test-changed`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 5: A — selection store, resolver, batched mutators {#step-5}

**Depends on:** #step-4

**Commit:** `tugdeck(lens-selection): LensSelectionStore, resolveLayoutSelection, batched slot and width mutators`

**References:** [P03] resolver, [P04] batched commits, Spec S02, Risk R02, (#ground-today, #state-zone-mapping)

**Artifacts:**
- `lens-selection-store.ts`, `layout-selection.ts`, `assignCardsToSlots` / `setCardWidths` on `DeckManager`.

**Tasks:**
- [ ] Implement Spec S02, including `pruneTo` wired to a deck subscription that only shrinks the set (Risk R02), and the collapse rule: `activateCard` on a card outside the selection collapses the set to that card ([P03], [P06]).
- [ ] `resolveLayoutSelection()`: live selection ids (registry-filtered) else first-responder card id else empty.
- [ ] `assignCardsToSlots(entries)`: raise commit(s) first (reuse the `assignCardToSlot` raise shape), then one geometry commit for all slot writes; group-refusal hook for [P08] (refuse whole batch when a validator rejects). `assignCardToSlot` delegates to a one-element batch. `setCardWidths(cardIds, preset)` mirrors `setContentWidth`'s one-commit shape for the named panes only.

**Tests:**
- [ ] bun:test: store logic (pickOnly/toggle/extendTo ordering, anchor movement, prune, collapse), resolver fallback ladder.
- [ ] bun:test: batched mutator produces exactly one geometry notify (count notifies via a test subscriber on the real DeckManager — no mocks).

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/components/lens/__tests__ src/lib/__tests__`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 6: A — TugListView multi-select and the law amendments {#step-6}

**Depends on:** #step-5

**Commit:** `tugdeck(list-view): opt-in multi-select — pointerdown modifiers, shift-arrow extension; amend list-view-usage and focus-language`

**References:** [P05] listview multiselect, (#ground-today, #state-zone-mapping)

**Artifacts:**
- Multi-select props on `TugListView`; `data-selected` stamping for set membership; law edits in `tuglaws/list-view-usage.md` and `tuglaws/focus-language.md`.

**Tasks:**
- [ ] Props: consumer supplies `selectedIds: ReadonlySet<string>` + intent callbacks (`onPick(id)`, `onToggle(id)`, `onExtendTo(id)`); when present, the primitive stamps `data-selected` on every member row whose id is in the set (appearance stays CSS, [L06]).
- [ ] Pointer path: in the pointerdown callback, read the gesture record's `metaKey`/`shiftKey` (from `gesture-interpreter.ts` — never re-derive from the raw event) and route: meta → `onToggle`, shift → `onExtendTo`, plain → `onPick`. Selection still commits at pointerdown; the deferred-click path (armed reorder) carries the same classification.
- [ ] Keyboard path: the backstop handler's meta/ctrl early-return stays; **shift**+ArrowUp/Down/Home/End extends via `onExtendTo` against the cursor's new row. Cursor movement itself is unchanged (the spatial handle never sees the event; extension rides the backstop only, and rule 5b's vertical-only contract is untouched).
- [ ] Only `role === "cell"` member rows participate; group headers are never selectable.
- [ ] Law edits: matrix fifth intent ("consumer-owned multi-select set") with its ownership sentence; Cards inventory row update; focus-language carve-out sentence ("a bare arrow never selects; a modifier-extended arrow is a selection gesture").

**Tests:**
- [ ] bun:test on the extracted classification (gesture record → intent) as pure logic.
- [ ] App-test coverage lands with Step 7's wiring (the primitive alone has no host surface to drive).

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test-select` names the list-view-covered tests; run the printed selection.

---

#### Step 7: A — Cards section wiring and command retarget {#step-7}

**Depends on:** #step-6

**Commit:** `tugdeck(lens-selection): Cards multi-select wired; slot and width commands act on the layout selection`

**References:** [P03], [P06] select vs activate, [P04], Spec S02, (#success-criteria)

**Artifacts:**
- Cards section consumes the store + new props; `MOVE_TO_SLOT` / `SET_PANE_WIDTH` handlers in `deck-canvas.tsx` resolve through `resolveLayoutSelection()` and call the batched mutators.

**Tasks:**
- [ ] Cards section: supply `selectedIds` from the store; intent callbacks — plain pick keeps today's activate path (select + front, collapse set), toggle/extend write the store without dispatching `focus-session-card` ([P06]). `lastSelectedRowId` seeding behavior is preserved.
- [ ] Deck canvas: `MOVE_TO_SLOT` maps every resolved content card to the slot (sidebar cards filtered out with the existing guard), via `assignCardsToSlots`; `SET_PANE_WIDTH` resolves the same way into `setCardWidths`. The Lens-focused case now works: the resolver returns the selection even though the first responder is the Lens card.
- [ ] Refusal visibility: an empty resolution or all-sidebar resolution flashes nothing but logs to the dev panel (`tugDevLogStore`) — no silent dead chord ([P08] spirit; full flash treatment arrives with nudge refusals in Step 9).

**Tests:**
- [ ] `at0451-lens-multiselect.test.ts`: build a selection (evalJS-driven store writes for the logic path; real modifier pointerdown for the gesture path if deliverable in background — else mark the gesture case `foreground: true` per #test-non-goals), then ⌘2 → both cards land slot 2 in one settle (assert one geometry notify via the test surface, both panes' `slot`), width chord applies to both.

**Checkpoint:**
- [ ] `just app-test tests/app-test/at0451-lens-multiselect.test.ts`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 8: A — integration checkpoint {#step-8}

**Depends on:** #step-7

**Commit:** `N/A (verification only)`

**References:** [P03], [P05], [P06], Milestone M02, (#success-criteria)

**Tasks:**
- [ ] Verify the full A surface end to end: mouse selection, keyboard extension, chord application, collapse-on-activate, prune-on-close.
- [ ] Run the census battery — selection gestures must not have introduced cuts.

**Tests:**
- [ ] `at0451` and `at0450` green together.

**Checkpoint:**
- [ ] `just app-test-changed`

---

#### Step 9: B — nudge-slot commands and chord doctrine {#step-9}

**Depends on:** #step-8

**Commit:** `tugdeck(nudge-slot): ⌥⇧⌘ bracket nudges over the layout selection; chord-tiers residents entry`

**References:** [P07] nudge chord, [P08] group clamp, [P04], Spec S03, (#ground-today)

**Artifacts:**
- `nudge-slot:left` / `nudge-slot:right` in `command-registry.ts`; handler on the deck canvas responder; `tuglaws/chord-tiers.md` residents entry.

**Tasks:**
- [ ] Command entries per Spec S03 (unpromoted, `preventDefault`, first-responder routing) beside `SLOT_COMMANDS`, with a [Q02]-style comment explaining non-promotion.
- [ ] Handler: resolve via `resolveLayoutSelection()`; compute `slot ± 1` per member; group clamp — any member at the travel edge refuses the whole nudge and flashes the blocking pane (`flashPaneBorder`); otherwise one `assignCardsToSlots` batch. Cards without a current slot (free-floating) are excluded from the batch; if that empties it, refuse.
- [ ] chord-tiers.md: residents entry for ⌥⇧⌘[/] recording the ⌥-variant-of-lateral reading and the ⌃⌘[/] fallback rationale ([P07]).

**Tests:**
- [ ] `at0452-nudge-slot.test.ts`: single card nudges right/left; two-card selection nudges as a unit; edge refusal preserves both slots and flashes; chord reaches the handler with Lens focused.

**Checkpoint:**
- [ ] `just app-test tests/app-test/at0452-nudge-slot.test.ts`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 10: B — integration checkpoint {#step-10}

**Depends on:** #step-9

**Commit:** `N/A (verification only)`

**References:** [P07], [P08], Milestone M03, (#success-criteria)

**Tasks:**
- [ ] Verify nudge against the census battery (nudges are settles; no cuts) and against `at0451` (nudge respects the same selection the digit chords use).

**Tests:**
- [ ] `at0450`, `at0451`, `at0452` green together.

**Checkpoint:**
- [ ] `just app-test-changed`

---

#### Step 11: D — flow geometry and the mode bit {#step-11}

**Depends on:** #step-10

**Commit:** `tugdeck(flow-mode): layout mode bit and pure flow strip geometry`

**References:** [P09] flow mode bit, Spec S03, (#flow-geometry, #ground-today)

**Artifacts:**
- `layout?: "fit" | "flow"` on `DeckImposition`; `flowStripPositions`, `flowRevealOffset` pure functions; `setImpositionLayout` mutator + `set-imposition-layout` registry action; golden sweep test.

**Tasks:**
- [ ] Extend `DeckImposition` (optional field; serialization tolerates absence — follow the `rails` pattern in `serialization.ts`).
- [ ] Implement #flow-geometry as pure functions beside the allocator; slot extent = widest member pane width.
- [ ] `DeckManager.setImpositionLayout(layout)` through `_commitImposition`; registry action wired in `action-dispatch.ts` (Layouts UI is Step 13's door; the action exists first so tests can drive it).
- [ ] Golden: a sweep of occupancy/width configurations → strip positions and reveal offsets, snapshotted beside `golden/imposer-solutions.json`.

**Tests:**
- [ ] bun:test unit + golden for the pure functions (edge cases: empty deck, single card wider than band, gaps from unoccupied slots, offset clamping).

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/lib/__tests__`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 12: D — offset plumbing and reveal-on-activation {#step-12}

**Depends on:** #step-11

**Commit:** `tugdeck(flow-mode): flow offset custom property, signature term, reveal on activation`

**References:** [P10] flow offset, [P09], Risk R01, (#flow-geometry, #state-zone-mapping)

**Artifacts:**
- `--tug-deck-flow-offset` written in the deck-canvas inset effect; offset subtraction term in `imposeStyle` (flow only); `flowOffset` on `DeckManager`; rounded-offset term in `arrangementSignature`; reveal write in `activateCard`; retune clamp on settled resize.

**Tasks:**
- [ ] `imposeStyle` gains a flow variant of its `left` expression: strip position minus `var(--tug-deck-flow-offset, 0px)`; fit mode's expression is byte-identical to today (assert in a unit test).
- [ ] Deck canvas writes the property in the same `useLayoutEffect` that writes the rail insets (before the settle's Last effect — the declaration order there is load-bearing; add the new write to the existing effect, do not create a second one).
- [ ] `activateCard` in flow: compute `flowRevealOffset` for the activated card; if changed, write it in the same commit as the raise so the settle animates the slide; if unchanged, the commit stays z-only and arms nothing ([P10]).
- [ ] Settled-resize retune clamps the offset to the new strip/band bounds.
- [ ] ⌘1..9 in flow: `assignCardsToSlots` unchanged (slots are ordinal); after a slot move, re-run the reveal for the moved card so it never lands out of view.

**Tests:**
- [ ] `at0453-flow-mode.test.ts` (first half): enter flow via the registry action; activate an off-viewport card → minimal slide, animated (no cut records); activate an in-view card → no geometry commit; cards never overlap (pairwise rect check).

**Checkpoint:**
- [ ] `just app-test tests/app-test/at0453-flow-mode.test.ts tests/app-test/at0450-imposer-cut-census.test.ts`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 13: D — Layouts UI and pane-model doc {#step-13}

**Depends on:** #step-12

**Commit:** `tugdeck(flow-mode): fit/flow control in the Layouts section; pane-model geometry mode doc`

**References:** [P09], Spec S03, (#success-criteria)

**Artifacts:**
- Fit/flow control in `layouts-section.tsx` (a two-segment `TugChoiceGroup` row beside the N-up picker — every Layouts control is a `TugChoiceGroup` per [L19] and the section's own header doc; never hand-rolled, and not `TugOptionGroup`, which is a multi-toggle); miniature updated (`layout-miniature.tsx`) to draw the strip with a viewport window when flow overflows; `tuglaws/pane-model.md` flow section.

**Tasks:**
- [ ] Layouts row dispatches `set-imposition-layout`; control state reads the store (settled controls show what the store holds).
- [ ] Miniature: in flow, draw slots at strip proportions and a viewport rectangle at the offset; in fit, unchanged.
- [ ] `pane-model.md`: flow as the third content geometry (beside fit and free), with the reveal rule and the ordinal-slot meaning.

**Tests:**
- [ ] `at0453` (second half): toggle the control; miniature reflects mode; mode persists across a Reload (imposition record round-trip).

**Checkpoint:**
- [ ] `just app-test tests/app-test/at0453-flow-mode.test.ts`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 14: D — integration checkpoint {#step-14}

**Depends on:** #step-13

**Commit:** `N/A (verification only)`

**References:** [P09], [P10], Milestone M04, (#success-criteria)

**Tasks:**
- [ ] Full flow pass: mode toggle, reveal, slot moves, nudges (B works in flow), width changes re-reveal, bullseye in flow, census battery in flow mode.

**Tests:**
- [ ] `at0450` battery re-run with flow enabled prepended to its gesture set; `at0452` nudge in flow; `at0453` green.

**Checkpoint:**
- [ ] `just app-test-changed`

---

#### Step 15: E — column data model {#step-15}

**Depends on:** #step-14

**Commit:** `tugdeck(column-split): ColumnArrangement record, withers, invariants, mutators`

**References:** [P11] columns mirror rails, [Q03], (#ground-today)

**Artifacts:**
- `ColumnArrangement` type + `columns?` field on `DeckImposition` in `layout-imposer.ts`; withers (`withColumnMode/Order/Shares`); `setColumnMode/Order/Shares` on `DeckManager` (mirroring `setRailMode/Order/Shares`, filtering to cards actually in the slot); layout-tree invariant.

**Tasks:**
- [ ] Type and field, sharing the arrangement helper functions with rails (generalize `railSeamFractions`/`railSharesFromFractions`/weight helpers to arrangement-shape functions if they are side-coupled; keep exported names stable).
- [ ] New invariant in `layout-tree.ts`: a column's `order` members, when present, name cards in panes assigned to that slot (soft: unknown ids are inert residue, [P11]); invariant 6 untouched.
- [ ] Serialization round-trip (optional field, absence-tolerant).

**Tests:**
- [ ] bun:test: withers, mutator filtering, seam-fraction math over column shapes, serialization round-trip.

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/lib/__tests__ src/__tests__`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 16: E — column geometry and seams {#step-16}

**Depends on:** #step-15

**Commit:** `tugdeck(column-split): member pins in imposeStyle, slot seam properties, seam drag on content columns`

**References:** [P11], Risk R01, (#ground-today, #state-zone-mapping)

**Artifacts:**
- `imposeStyle` `member` option (mirroring `imposeSidebarStyle`'s — byte-identical output when absent or single-member); `columnSeamProperty`/`columnMemberPins`; seam-writer generalization in the deck-canvas inset effect; `RailSeam` reuse for columns (place-keyed props).

**Tasks:**
- [ ] `imposeStyle(placement, slotWidth, pinnedFrame, {member?})`: vertical pins as `calc()` over `--tug-slot-<k>-seam-<j>` with equal-division fallbacks, first/last members taking the bare gaps — port `railMemberPins` exactly.
- [ ] Deck canvas: write/remove slot seam properties beside the rail ones in the same effect (stale-index removal included); `tug-pane.tsx` builds the member option when the pane's slot has a split column with >1 visible members.
- [ ] Seam component: parameterize `RailSeam` by place (side or slot) — same drag, clamp, equalize double-click; commit through `setColumnShares`.
- [ ] Flow interplay: a split column's strip extent is its widest member ([P11], [P09]).

**Tests:**
- [ ] bun:test: `columnMemberPins` output shape; single-member byte-identity with the unsplit frame.
- [ ] `at0454-column-split.test.ts` (first half): split a two-card slot via `setColumnMode` (test surface), both cards visible stacked vertically with the seam; drag the seam; equalize.

**Checkpoint:**
- [ ] `just app-test tests/app-test/at0454-column-split.test.ts`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 17: E — column UI and choreography {#step-17}

**Depends on:** #step-16

**Commit:** `tugdeck(column-split): Layouts slot rows, stack-badge menu, split-flip choreography; pane-model doc`

**References:** [P11], [P02], Risk R01, (#ground-today)

**Artifacts:**
- Per-slot split/stack rows in `layouts-section.tsx` (mirroring the rail rows: always rendered, disabled below two members); stack-badge menu extension in `tug-pane.tsx` (`handleArrangeRail` generalizes to places); split↔stack flip choreography for columns (survivor moves with a real height term, others fade — port the rail plan in the settle); `pane-model.md` column section.

**Tasks:**
- [ ] Layouts rows dispatch `SET_COLUMN_MODE`-shaped registry actions (added beside `SET_RAIL_MODE` in `action-dispatch.ts`, with the matching `command-registry.ts` internal entries).
- [ ] Stack-badge menu on a content pane in a multi-card slot offers split/stack/equalize.
- [ ] Choreography: extend the settle's rail-mode fade plan to column-mode flips (the signature already gains column terms via the imposition record; verify and add explicit seam/mode terms if the record term alone is too coarse).
- [ ] `pane-model.md`: columns section beside rails.

**Tests:**
- [ ] `at0454` (second half): flip via the Layouts row and the badge menu; choreography produces no cut records; disabled row below two members.

**Checkpoint:**
- [ ] `just app-test tests/app-test/at0454-column-split.test.ts tests/app-test/at0401-sidebar-split.test.ts`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 18: E — split chord family {#step-18}

**Depends on:** #step-17

**Commit:** `tugdeck(column-split): ⌃⌘S toggle, ⌃⌘↑↓ and ⌃⇧⌘↑↓ column movement; chord-tiers entries`

**References:** [P12] split chords, [P03], Spec S03, (#success-criteria)

**Artifacts:**
- Five command entries + deck-canvas handlers; chord-tiers residents entries.

**Tasks:**
- [ ] `toggle-column-split` (⌃⌘S): resolve the target slot via `resolveLayoutSelection()`'s first card (else first responder); toggle the column's mode; refuse visibly (dev-panel log + no-op flash) on a single-member slot.
- [ ] `move-in-column:up/down/top/bottom`: reorder the resolved card within its column's `order` (stacked columns: promote/demote in z per [P12]); refusal at the edge flashes the pane.
- [ ] chord-tiers.md residents entries for all five ([P12] rationale).

**Tests:**
- [ ] `at0454` (chords): ⌃⌘S splits and re-stacks; ⌃⌘↓ swaps two members; ⌃⇧⌘↑ from bottom lands top; edge refusal flashes. Chords are delivered via the harness key path (they are not menu chords, so background delivery works; if delivery proves foreground-bound during implementation, follow #test-non-goals).

**Checkpoint:**
- [ ] `just app-test tests/app-test/at0454-column-split.test.ts`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 19: E — integration checkpoint {#step-19}

**Depends on:** #step-18

**Commit:** `N/A (verification only)`

**References:** [P11], [P12], Milestone M05, (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Full-surface pass: splits in fit and flow, multi-select + nudge + width over split members, census battery with split flips included, sidebar splits unregressed.

**Tests:**
- [ ] `at0450`–`at0454` and `at0401-sidebar-split` green together.

**Checkpoint:**
- [ ] `just app-test-changed`

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** The deck's layout system keeps an always-animated promise (verified by a census harness), the Lens Cards section supports multi-card selection that every layout verb acts on, cards nudge relatively by keyboard, the deck offers a non-overlapping flow layout beside fit, and content slots split vertically like sidebar rails — with every chord and law change recorded in the tuglaws.

**Milestone M01: Phase C — always animated (steps 1–4)** {#m01-phase-c}
**Milestone M02: Phase A — multi-select (steps 5–8)** {#m02-phase-a}
**Milestone M03: Phase B — relative nudge (steps 9–10)** {#m03-phase-b}
**Milestone M04: Phase D — flow mode (steps 11–14)** {#m04-phase-d}
**Milestone M05: Phase E — content splits (steps 15–19)** {#m05-phase-e}

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Census battery green with only the doctrine-recorded accepted classes (`at0450`).
- [ ] Multi-select flows and batched verbs green (`at0451`), including the Lens-focused ⌘1 case.
- [ ] Nudge with group clamp green (`at0452`); chord-tiers entry landed.
- [ ] Flow reveal, no-overlap, persistence green (`at0453`); pane-model updated.
- [ ] Column splits, seams, choreography, chords green (`at0454`); sidebar splits unregressed (`at0401`).
- [ ] `cd tugdeck && bunx vite build` clean; `just app-test-changed` green at each milestone.

**Acceptance tests:**
- [ ] `just app-test tests/app-test/at0450-imposer-cut-census.test.ts tests/app-test/at0451-lens-multiselect.test.ts tests/app-test/at0452-nudge-slot.test.ts tests/app-test/at0453-flow-mode.test.ts tests/app-test/at0454-column-split.test.ts`

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap-follow-ons}

- [ ] Trackpad panning of the flow strip ([Q01]).
- [ ] Menu promotion for the split chord family (Window menu items with rebindable equivalents).
- [ ] Multi-select in other list surfaces (Jots, Overview) using the [P05] capability.
- [ ] Exit-ghost fidelity (live snapshot instead of token fill) if the plain ghost reads wrong.

| Checkpoint | Verification |
|------------|--------------|
| Milestone M01 | Step 4 checkpoint commands |
| Milestone M02 | Step 8 checkpoint commands |
| Milestone M03 | Step 10 checkpoint commands |
| Milestone M04 | Step 14 checkpoint commands |
| Milestone M05 | Step 19 checkpoint commands |
