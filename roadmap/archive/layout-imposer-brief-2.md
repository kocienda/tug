# Layout Imposer — Round 2, Five Findings from Use

Follow-on to `layout-imposer-brief.md`, written from hands-on feedback after A–E landed. Five items: **F** Escape in the Cards section deselects inconsistently, **G** the Layouts miniature should show live flow positions and animate, **H** split column members should be drag-repositionable like rail cards, **I** a split column should cap what it shows and grow to scroll vertically, **J** the new chords must appear in the Swift menu. Each section records what the code actually does today (all claims re-verified against `main` post-join), the diagnosis or design question, and a sketched approach. An ordering proposal closes the brief. Letters continue A–E so cross-references between the two briefs stay unambiguous.

---

## F — Escape in the Cards section: the inconsistency has an engine

### What the user sees

Escape over a Cards-section selection sometimes deselects, and sometimes instead lands focus on a content card and *selects* it. The report is right that inconsistency is wrong by definition — and it is not noise. Two independent mechanisms produce it, and one of them is a plain bug.

### Diagnosis 1 — the alternation bug: focus-out *creates* a selection

The Lens's own `CANCEL_DIALOG` responder (`lens-content.tsx:258–266`) does: selection non-empty → `clear()`; selection empty → `dispatchCommand(FOCUS_LENS)`. The FOCUS_LENS toggle-out (`deck-canvas.tsx:1482–1515`) restores the prior content card via `transferFocusForActivation(... store.activateCard(prior))`. That first-responder transition is observed by `attachLensSelectionToDeck` (`lens-selection-store.ts`), whose auto-select rule runs `selection.pickOnly(fr)` on any content-card first responder not already in the selection. So the sequence is deterministic and damning: Escape #1 clears the set; Escape #2 focuses out **and the restore re-selects the restored card**; Escape #3 clears that; Escape #4 focuses out again. The auto-select rule exists so a clicked card becomes the layout selection — it was never meant to fire on a *focus restore*. The restore path must not create a selection: either the toggle-out sets a one-shot suppression the attacher consumes, or the attacher distinguishes user activation from programmatic restore (the `transferFocusForActivation` call site knows which it is).

### Diagnosis 2 — who arbitrates Escape depends on invisible state

Four further conditions change the outcome of the identical visible gesture, all confirmed in code:

1. **BASE mode bypasses the list's capture.** `responder-chain-provider.tsx:706–712`: at `BASE_FOCUS_MODE`, an Escape matching `CANCEL_DIALOG` is dispatched into the responder chain *immediately*; the list's `captures` predicate (`tug-list-view.tsx:5596–5602`, "while there is a set, Escape is the list's") is only consulted in `actDispatchListener`, which runs later and only in non-BASE modes. The comment's promise is untrue in the most common state.
2. **The first responder decides which chain rung answers.** FR = Lens content → the lens-content handler; FR = a content card (a plain row click fronts the card) → the walk never reaches lens-content, and either a card-level handler eats it or the root conditional clear (`deck-canvas.tsx:1350–1357`) runs; FR = the Lens card node above lens-content (the ⌘L path) → lens-content is not on the walk at all, and with an empty set the ladder just drops `kbfManual`.
3. **Row ids vs card ids.** The list's guards test `selectedIds` built from *visible rows* (`cards-section.tsx:985–1010`); a selection whose cards are filtered out or collapsed reports size 0, so the list neither captures nor clears while `lensSelectionStore.ids` is non-empty.
4. **Filter text outranks the selection** (`tug-list-view.tsx:5891–5893`, `tug-filter-field.tsx:258–270`) — defensible, but currently an accident of chain order rather than a stated precedence.

### Sketch

Make Escape-in-the-Lens a *decision table*, implemented in one arbiter rather than distributed across chain order: (1) filter has text → clear the filter; (2) selection store non-empty (the **store**, not visible rows) → clear the selection; (3) otherwise → focus out, and the focus-out restore never writes the selection. Fix the `pickOnly` restore bug first — it is severable and explains most of the reported behavior. Then either lift the BASE-mode carve-out so `keyViewCaptures` is consulted before the chain for Escape, or move the selection-clear decision wholly into the chain and delete the list-side clear, so there is one owner. Amend `focus-language.md` with the stated precedence. Tests: at0451 grows an alternation case (Escape, Escape, Escape — the set must never *grow*), plus a filtered-selection case pinning the store-vs-rows fix.

---

## G — The miniature becomes an instrument in flow

### What the code says today

The at-rest drawing is a *stated decision*, not an omission. `layout-miniature.tsx` draws the flow window "at REST, always: at offset 0, flush left. The miniature is a plan readout, not an instrument. A window tracking the live offset would repaint a Lens row on every card activation, and the preview layers would have to draw at rest regardless." The component is purely presentational ([L06]): props in, CSS out, no store reads. All blocks are drawn at one preset width (`cardUnits`), not at the slots' real extents.

### What the feedback reverses, and what it costs

The user wants the committed drawing to show where the cards actually stand in flow — the real strip, the real window position — and to animate as they change. That is a reversal of the recorded decision and should be recorded as one. The costs the original comment named are real but affordable: the repaint-per-activation cost is confined to the *committed* layer (preview layers still draw at rest — an uncommitted arrangement has no offset, so that half of the decision stands); the store-read prohibition stays intact by feeding the live facts down as props (`deckState.flowOffset` and the per-slot extents from `deckFlowStrip`, both already selected in `deck-canvas.tsx:797–798` and readable from the Layouts section's `useDeck()`).

### Sketch

- The miniature grows two committed-layer-only props: `flowOffset` (px, nominal) and per-slot `extents` (the strip's real widths — today `flowStrip` in the drawing is synthesized from one preset width; the real `deckFlowStrip(state).positions` gives the truth, including a split column contributing its widest member). The window's `left` becomes the scaled offset instead of `0%`.
- Animation via CSS transitions on the mini blocks' `left`/`width` and the window's `left` — appearance through CSS, no React state, no TugAnimator (the miniature is not a pane; [L13] governs pane motion, and a transition on a 100-px-wide drawing is the right tool). Preview layers keep no transition so an audition swap stays crisp.
- `flowOffset` is already ephemeral state (`layout-tree.ts:372`, never serialized), so the section re-renders ride the existing `useSyncExternalStore` deck subscription — no new store.
- Decide and record: does the *fit* drawing also animate (preset/count changes)? Recommendation: yes — one transition rule for the whole drawing, so the miniature never cuts where the deck glides.
- The header comment's decision paragraph gets rewritten, not deleted — the preview-at-rest half survives, and the reversal of the committed half should cite this brief's reasoning.

---

## H — Drag-reorder for split column members

### The machinery is closer than expected

The rail reorder drag (`tug-pane.tsx`) is mostly place-agnostic already: measured resting tiles in layout px, half-overlap insertion math (`applyRailReorderFrame:2515–2535`), re-stacking by `top += height + IMPOSITION_GAP_PX` (`railReorderTops:1424`), sibling preview tweens through TugAnimator, and a drop that keeps `data-gesture` so the imposer settle animates the commit. Heights travel with the cards, so a reorder never touches shares — true for columns too, since `setColumnShares` keys by pane id. And `DeckManager.setColumnOrder` (`deck-manager.ts:1603`) already says in its doc comment that it is "what a corridor drag and the move-in-column chords commit" — the drag caller is the missing half of a sentence the code already wrote.

The rail-typed layer that needs generalizing, exhaustively:

1. **The latch gate.** `beginRailReorder` (`tug-pane.tsx:2421`) returns null unless the pane has `sidebarStackRef.current?.side` and `railSplitRef.current`. A split-column pane today falls into the `derivedRef` branch → `releaseImposedFrame` → the drop calls `onCardMoved(..., {evictSlot: true})` — the card *leaves its slot*. The gate grows a column arm keyed off `columnMember !== undefined`.
2. **Member discovery.** Rails select `.tug-pane[data-rail-split][data-lens="${side}"]`; the column twin is `.tug-pane[data-column-split][data-imposed="${slot}"]` — both attributes already stamped (`tug-pane.tsx:3604–3609`), no new DOM needed. Bullseye already drops `data-column-split`, excluding itself.
3. **Identity and commit.** `RailReorderState` keys by componentId and commits `onSetRailOrder(side, order)`; the column drag keys by pane id (`data-pane-id`) and commits through a new `onSetColumnOrder(slot, paneIds)` prop → `store.setColumnOrder` (`deck-canvas.tsx` has `handleSetRailOrder:2715` as the template).
4. **The corridor question — the one real design fork.** On a rail, leaving the 80px corridor (`RAIL_CORRIDOR_SLOP_PX`) converts the gesture to a free drag, and dropping makes the card a free pane. On a column the horizontal exit has a plausible second meaning: *move to the neighboring slot*. Recommendation for discussion: ship parity first (exit = free drag, byte-identical to today's escape hatch), and treat cross-slot drag-assignment as its own feature — it needs drop-target drawing, `assignCardToSlot` batching, and flow-strip interplay that this item shouldn't smuggle in.
5. **Interplay with I.** If I lands first, a column can be taller than its run and scrolled; a reorder drag inside a scrolled column needs edge autoscroll (the vertical analog of nothing that exists today — rails never scroll). If H lands first, its measured-tiles math survives I unchanged, but the drag would need an autoscroll retrofit. Ordering discussed at the end.

### Sketch

Generalize `RailReorderState` to a `PlaceReorderState` carrying the same `SeamPlace` discriminator the seam component already uses (`deck-canvas.tsx:475`), the same way `RailSeam` became `PlaceSeam` in E. The drop math, tween choreography, and post-commit cleanup effect (`tug-pane.tsx:2293`) are reused verbatim. Tests: an at0455 sibling driving a real pointer drag over a split column, asserting order commit, no share mutation, and the settle animating the swap (census cell: `column-drag-reorder`).

---

## I — A split column caps at ~2½ and grows to scroll

### What the geometry does today, and why tall splits degrade

A split column divides its *run* — the fixed vertical span between `GAP` (5px) and `GAP_BOTTOM` (32px) — into N shares via seam fractions (`memberPins`, `layout-imposer.ts:2202`; equal by default through `railSeamFractions`). Every member the user adds shrinks every member: at N=4 each card gets a quarter of the run, at N=6 a sixth. Nothing scrolls; the run is the whole budget. The feedback: past ~2.5 visible members this stops being useful, and the column should instead *grow* — members keep a useful height, the column becomes a strip taller than the run, and the deck reveals members vertically the way flow reveals slots horizontally.

### The horizontal precedent is nearly axis-free already

Flow's pieces, checked against the vertical need:

- **The strip.** `flowStripPositions` (`layout-imposer.ts:1292`) is a running sum of extents plus gaps — pure numbers, no axis in it. A `columnStripPositions` over member heights is the same function over a different measure.
- **The reveal.** `flowRevealOffset` (`layout-imposer.ts:1358`) takes `{stripLeft, extent, stripWidth, band, offset}` — all scalars, `scrollRectToVisible` semantics, already axis-agnostic. It generalizes to the vertical case by renaming, not rewriting.
- **The offset.** `flowOffset` is ephemeral `DeckState` (`layout-tree.ts:372`, not serialized), written by activation through `_flowRevealOffsetFor` (`deck-manager.ts:2302`), published as one custom property (`FLOW_OFFSET_PROPERTY`) whose `left` calc clamps in CSS (`min(var(offset), max(0px, strip − band))`, `layout-imposer.ts:1233–1234`) so resize never needs JS. The vertical twin is per-slot: `columnOffsets?: Record<slot, number>` in `DeckState` (ephemeral, same non-persistence), one `--tug-slot-<k>-column-offset` property, the same clamp shape in the members' `top` calc.

### The design questions to settle in discussion

1. **What is a member's height in an overflowing column?** The "2.5" framing suggests: while N ≤ 2 the run divides as today (shares, seams, drags — unchanged); at N ≥ 3 each member's height becomes `run / 2.5` (so two full cards and half the third visible at rest — the half-card *is* the scroll affordance, exactly as flow's clipped card at the band edge is). Alternative: members keep user-dragged shares interpreted against the virtual strip rather than the run. Recommendation: the fixed `run/2.5` — the moment a column overflows, hand-tuned shares stop meaning "division of what I can see," and the miniature already refuses to draw hand ratios for the same reason.
2. **Do seams survive overflow?** If member heights are fixed at `run/2.5`, the seam drag has nothing to divide and the seams disappear for N ≥ 3 (they return when the column drops back to 2). This mirrors flow, where the allocator's seam terms go to zero (`layout-imposer.ts:1663–1670`). The simpler and recommended answer — but it means a 3-member column has no height control at all, worth confirming.
3. **What writes the offset?** Activation only, at first — `moveInColumn` and the ⌃⌘ arrows compose with reveal-on-activation for free since they end in an activation or an order change. Trackpad scroll over a column is the same deferral flow made (scroll-intent arbitration), and should stay deferred to keep the item shippable.
4. **Interaction with fit vs flow.** A split column contributes its widest member to the flow strip today; an overflowing column changes nothing horizontally. The two axes compose — a flow deck with an overflowing column has two independent offsets, one deck-wide, one per-slot — but the census must prove the settle handles both moving in one gesture.

### Sketch

Phase like D was phased: (1) the vertical strip + reveal math in `layout-imposer.ts` (pure, golden-testable); (2) `columnOffsets` state + the per-slot property + CSS clamp + reveal-on-activation; (3) the `arrangementSignature` column term grows the offset (it already carries mode + members + seams); (4) the miniature's split drawing caps at the same 2.5 rule (it already caps at 3 drawn members — the cap becomes the true geometry rather than a drawing convention); (5) `pane-model.md` records the overflow rule beside the split rule.

---

## J — The chords must reach the Swift menu

### Why they are absent: a decision, not an omission

The five column chords (⌃⌘S, ⌃⌘↑/↓, ⌃⇧⌘↑/↓) were left deliberately unpromoted — `COLUMN_SPLIT_COMMANDS` (`command-registry.ts:643–716`) carries no `menuItemId`, no `mirrored`, no `menuEligible`, with the rationale in its doc block: like ⌘1..9 and the nudge pair, they act on the layout selection, "which is a fact about the Lens's list rather than about the frontmost card, so a menu item's `validate` has nothing to read." And the menu pipeline is such that nothing on the wire can conjure an item: the Swift menu is built statically in `buildMenuBar()` (`AppDelegate.swift` ~771), and `updateMenuState` → `applyCommandChords` can only decorate items that already exist by identifier. `tuglaws/menus.md` is honest about all of this — its chord table already lists the five, marked `JS, global`.

The feedback overrules the rationale: the menu is the discoverability surface, and a chord that exists nowhere the user can browse might as well not exist. The `validate` objection is answerable — it just costs a new menu fact.

### The promotion path, concretely (five surfaces)

1. **`AppDelegate.swift`** — five `NSMenuItem`s in `buildMenuBar()` (Window menu, beside the width/bullseye group at ~1234–1249), `.identified("window.<name>")`, `keyEquivalent: ""` so the sweep writes the chord, `@objc` actions calling `sendControl(...)` with `representedObject` carrying `up|down|top|bottom` (template: `setCardWidthFromMenu(_:)`).
2. **`command-registry.ts`** — `menuItemId`, `mirrored: true`, `menuEligible: true` on each binding, a `disabledChord` decision, and `validate`. The real work: `CommandMenuFacts` has no field describing column membership, so a new fact (`column: { canSplit, canMoveUp, canMoveDown, canMoveToEnds } | null`, resolved from the layout selection + `deckColumnsOf`) joins `CommandMenuFacts`, `EMPTY_MENU_FACTS`, the aggregator in `host-menu-state.ts`, and the Swift `MenuState` decoder.
3. **`host-menu-state.ts`** — publish the fact; `computeCommandCapabilities` picks the entries up once `menuItemId` exists.
4. **Tests** — the `PROMOTED` table and `menuEligible` collision lint in `command-registry.test.ts`; at0168's static identifier→keyEquivalent contract; at0181's swept-chord coverage.
5. **`tuglaws/menus.md`** — regenerate (`TUG_WRITE_MENUS_DOC=1`); the five rows flip `JS, global` → `menu bar (swept)`. `chord-tiers.md`'s residents note updates too.

### The one cost to weigh before committing

Promotion takes a chord out of the JS funnel *globally*: AppKit claims a promoted key equivalent everywhere, including inside text surfaces, and per-surface `preventDefault` scoping stops mattering. ⌃⌘↑/↓ and ⌃⇧⌘↑/↓ have no text-editing meaning, so the claim is likely safe — but "likely" is exactly what an app-test in a CM6 editor should convert to "verified" before the plan declares the item done (type in a session editor, press ⌃⌘↓, assert the caret didn't move *and* the column did or the menu refused). The `validate` gating also needs care: a menu item that is enabled only when the Lens holds a layout selection will read as mostly-disabled in the menu — the fact should fall back to the first-responder card's column the way `resolveLayoutSelection` already ladders, so the menu item is live whenever the *chord* would be.

---

## Proposed ordering

1. **F — Escape.** A shipped bug with a located engine; independent of everything; the `pickOnly`-on-restore fix alone probably resolves most of the felt wrongness, and the arbiter unification hardens the rest.
2. **J — menu promotion.** Small, independent, and it front-loads the `CommandMenuFacts.column` fact, which H and I's growing gesture set will keep consulting.
3. **G — the miniature instrument.** Self-contained inside the Lens; no geometry changes; safe to land while the column work is designed.
4. **I — vertical overflow.** Changes what a split column's geometry *means*; everything after it should be born onto the final meaning.
5. **H — drag reorder.** Lands on I's finished geometry so the drag is designed once, with autoscroll-in-a-scrolled-column in scope from the start rather than retrofitted — and the corridor-exit question (free drag vs slot move) gets settled in discussion before the plan.

Cross-cutting: F and J are parallelizable; G can ride with either; I → H is a hard order. Each item carries its tuglaws edits in the same change (focus-language precedence for F, menus/chord-tiers for J, pane-model overflow rule for I), per the cross-check doctrine. The cut census (C's harness) gains cells alongside I and H — both multiply motion paths on the surface the census exists to keep honest.

## Questions to settle in discussion

- **F:** should filter-text continue to outrank the selection when both are present? (Recommended: yes, stated explicitly.)
- **G:** does fit animate too, or only flow? (Recommended: both — one transition rule.)
- **H:** corridor exit on a column — free drag (parity with rails) or cross-slot move? (Recommended: parity now, cross-slot as its own later feature.)
- **I:** fixed `run/2.5` member height on overflow, with seams retiring at N ≥ 3 — or shares reinterpreted against the strip? (Recommended: fixed height; the half-visible card is the affordance.)
- **J:** confirm the menu items live in the Window menu beside the width group, and that `validate` ladders to the first-responder card so the items aren't dead whenever the Lens lacks a selection.
