<!-- brief-skeleton v1 -->

# The rails stop resizing themselves: Fit alone, sashes the hand's and kept, and one verb that resizes on request

**Purpose:** Four arcs have tried to make a sidebar rail arrange its own height — a stack that hides members, a flow that stands them at measured heights, a fit that seeds itself from appetites and re-seeds on every membership change — and none of it has produced a rail the user can trust to stay where they put it. This brief removes every automatic vertical resize from the rails. A rail is always divided, the sashes belong to the hand and survive relaunch, and the one algorithm left is a verb the user runs: **Resize Sidebars to Fit**.

> **The row is in View now, not Window.** `briefs/menu-bar-relocation-brief.md` moved the sidebar family into the View menu, so the row this brief adds is `view.resizeSidebarsToFit` and it stands in View directly above the sidebar card rows, exactly the placement [B11] asked for. The chord ⌃⌥⌘R, the empty construction-time key equivalent, the `resize-sidebars-to-fit` control frame and the algorithm itself are all unchanged.

---

## Purpose {#purpose}

> "I want to do a rethink on how we handle these sidebar rail layouts. We need to remove all the automatic resizing. It's not working. In its place, I want the *Fit* algorithm as the sole approach, which means we remove *Stack* and *Flow* completely from the sidebar rails. Remove all the tests. All the infrastructure. Pare this back. Clean this up."

The user's design, in their words: the *user* arranges the sidebars on the rails, with the Layout card's Off|Left|Right rows and by dragging the sashes between cards; the sash positions the user chose are saved and come back across launches; and one automatic algorithm exists, invoked only by the user, called *Resize Sidebars to Fit*, which sizes the list cards (Cards, Jots, Arcs, Tripwires) to show the elements they have, gives Overview and Layout their natural sizes, and spreads what is left across the visible cards so each rail ends up full height. It gets ⌃⌥⌘R and a Window menu row directly above the six sidebar-card rows.

This is the fourth brief on this rail, and the first that takes machinery away rather than adding a tier to it. `briefs/rail-vertical-allocation-brief.md` built the allocator and the appetites; `briefs/rail-appetite-truth-brief.md` re-derived the appetites; `briefs/rail-seams-belong-to-the-hand-brief.md` gave Fit's seams to the hand and kept Flow and the seed on the appetites; `briefs/sidebar-height-is-measured-brief.md` replaced the declared appetites with measured ones. The checkpoint at `225d4e9e5` is where that line of work stops.

---

## Evidence {#evidence}

**[F01] Sash positions are already serialized, and are already thrown away on every membership change.** `RailArrangement.shares` (`layout-imposer.ts:232`) is a weight per componentId, written by a seam drag through `setRailShares` (`deck-manager.ts:1941`), carried in `imposition` and written whole by `serialize` (`serialization.ts:158`), and parsed back by `parseRails` (`serialization.ts:349`). So a drag survives a relaunch today. What does not survive is any change to who is standing: `_seededFitShares` (`deck-manager.ts:2707`) drops a side's whole record whenever its key set is not exactly the members now standing ("a division for two members says nothing about three") and re-seeds the side from the measured appetites. Hide Tripwires, show it again, and every sash on that side is where the seed put it, not where the hand did. **(verified — read at `225d4e9e5`)**

**[F02] Under Fit with a record the seams already belong to the hand; every other path is automatic.** `sharedHeightsOf` (`layout-imposer.ts:3553`) with stored weights divides the run by weight, bounded below by floors, and reads no natural — content cannot move a seam that has a record. But a rail with no record stands at the appetite seed, the seed is written at the settle, a settle re-stands every Flow rail, a membership change re-seeds ([F01]), and a rail whose floors exceed its run falls back to a scrolling strip (`placeStandingOf`, `layout-imposer.ts:3712`). Four automatic paths around one manual one. **(verified)**

**[F03] A rail has three answers today — Stack, Fit, Flow — and Stack is the default.** `RailMode = "stack" | "split"` with absent reading as stack ([D134]); under split, `PlaceLayout = "fit" | "flow"` with absent reading as fit. The Layout card offers them as one row per side (`PLACE_ROW_ITEMS`, `layout-card.tsx:337`) dispatching `SET_RAIL_MODE` and `SET_RAIL_LAYOUT` (`layout-card.tsx:1005–1014`), and the title bar's stack badge menu repeats them as verbs — *Stack*, *Fit*, *Flow*, *Equalize Heights*, *Fit to Content* (`tug-pane.tsx:1451–1475`) — with *Fit to Content* also on a seam's double-click. **(verified)**

**[F04] The appetite pipeline is the whole of the automatic machinery, and it is enumerable.** `tugdeck/src/lib/card-appetite-store.ts` (the store and `useMeasuredCardAppetite`), the five callers in `cards-card.tsx:726`, `jots-card.tsx:962`, `arcs-card.tsx:1019`, `tripwires-card.tsx:439`, `layout-card.tsx:823`, `heightSource` and `greedRank` on `CardRegistration` (`card-registry.ts:284, 334`) and on the six registrations, `DeckState.appetites` (`layout-tree.ts:406`), `placeMemberAppetites` (`deck-store-selectors.ts:522`), and in `deck-manager.ts` the subscription, `RESIZE_RETUNE_QUIET_MS`, `_settleAppetites`, `_seededFitShares`, `_railMembersDeclared` and `_anyPlaceOverflows`. In `layout-imposer.ts`: `PlaceLayout` and its helpers, `flowHeightsOf`, `seedSharedHeights`, `seedPlaceShares`, the `layout` argument threaded through `allocatePlaceHeights`, `nominalPlaceAllocation`, `placeSharesFromHeights` and `seamDragBounds`, and the `"overflow"` arithmetic that Flow made necessary. **(verified — by grep at `225d4e9e5`)**

**[F05] The Window menu already has the slot the row goes in, and the pattern the row follows.** `AppDelegate.swift:1324–1389` builds the Window menu as: *Slim / Comfy / Wide*, a separator, then the six sidebar-card parents in noun order (Arcs, Cards, Jots, Layout, Overview, Tripwires), then the pane-list anchor. Every row there is constructed with an **empty** key equivalent, and `applyCommandChords` writes the chord from the frontend's registry, so the chord is a registry fact and stays rebindable. A row that runs a deck verb sends it by `sendControl` with a command id, as `toggleRailFromMenu` does (`AppDelegate.swift:1594`). **(verified)**

**[F06] ⌃⌥⌘R is unbound, and the tier it lives on has one resident.** `tuglaws/chord-tiers.md:41` names ⌃⌥⌘ "the advanced form of a Tug-tier command", with Cycle Permission Mode ⌃⌥⌘P as its sole resident since [D175]. ⌃⌘R is the Arcs card ([D175]); ⌘R is Reveal Stack. Nothing holds ⌃⌥⌘R in the registry, the Swift menus, or `tuglaws/menus.md`. **(verified — grep over `tugdeck/src`, `tugapp/Sources`, `tuglaws`)**

**[F07] Every card the verb must size already names a content element the verb can read.** The measured-height arc gave each of the five content cards one in-flow content element whose border-box height is a function of rail width and card data alone, and proved per card that it cannot see its pane's height (`at0542`'s two-pane-heights invariant). Overview is registered `heightSource: "stream"` and has no such element; its registration carries `min.height: 240` and `preferred.height: 900`, the second being the height a free pane opens at. **(verified)**

**[F08] Columns share the allocator and the layout type, and content cards declare nothing.** `ColumnArrangement` carries the same `mode` and `layout` fields, and `placeMemberAppetites` reads any member with no appetite as `Infinity`, so a column under Flow stands every member at one screen of the run — a distinction from Fit nobody would pick on purpose. Column *stack* is a different matter: it is the front-to-back tab stack of a slot ([D121], [D123]), a real place with its own badge and ⌃⌘S, and it is not a rail. **(verified)**

**[F09] The tests are enumerable too.** App-tests on the rail's vertical machinery: `at0359-sidebar-stack` (stack by default), `at0401-sidebar-split` (a divided rail), `at0540-rail-drop-stacked-side`, `at0542-rail-vertical-allocation` (fit vs strip, the seed, the measurement invariant), the rail row assertions in `at0469-layout-places` and `at0502-layout-card`. Unit tests: `lib/__tests__/layout-imposer-flow.test.ts`, `layout-imposer-heights-census.test.ts`, `card-appetite-store.test.ts`, `__tests__/place-allocation.test.ts`, and the rail cases of `layout-imposer.test.ts`, `layout-imposer-census.test.ts`, `layout-imposer-columns.test.ts`, `factory-rail.test.ts` and `card-registry.test.ts`. Not this machinery, and untouched: `at0454-flow-mode` is the DECK's flow (`ImpositionLayout`), `at0303-imposer-space-allocator` and `at0294`, `at0450` are rail WIDTHS and the imposer's motion. **(verified)**

**[F10] The rails' width allocator is a separate machine and is not in question.** Widths are solved by `retuneSidebarAllocation` at the moments [D136], [D140] and [D166] name, and nothing here reads or writes a width. **(verified)**

---

## Decisions {#decisions}

### One layout

**[B01] A rail is always divided, and Fit is the only way it divides.** `RailMode` and the rail's `PlaceLayout` are deleted. Every member standing on a side is visible at once, at the height its share says. This reverses [D134]'s stack default and retires Flow entirely, on the user's verdict that the two extra answers were what the automatic machinery existed to serve, and the machinery is not working. A stored `mode` or `layout` in an old blob is ignored on read and dropped on the next write.

**[B02] Every rail-layout control in the Layout card is deleted, and so are the badge menu's rail verbs.** The rail has one layout, so a control choosing one is a control with nothing to say. In `layout-card.tsx`: the per-rail *Left Rail* / *Right Rail* rows with their `Stack | Fit | Flow` choice group (`RAIL_CAPTIONS`, `PLACE_ROW_ITEMS`, `placeRowValue`, `RAIL_ROW_SENDER_PREFIX`, the `railModeOf` / `railLayoutOf` reads at `:836–843`). In `layout-places.tsx`: the rail's Stack | Split place mark on the drawing and its ghost-mode preview — a rail has no mode to mark, so the mark is drawn for columns only. In `layout-miniature.tsx`: the stacked-rail picture (cards peeking front-to-back) — a rail is drawn divided, always. The per-card **Off | Left | Right** rows stay untouched, and so do the column rows and column marks ([B12]). In the title bar: *Stack*, *Fit*, *Flow*, *Equalize Heights* and *Fit to Content* leave the stack badge menu for rails, the seam's double-click does nothing, and `SET_RAIL_MODE`, `SET_RAIL_LAYOUT`, `EQUALIZE_RAIL` and `FIT_RAIL_TO_CONTENT` are removed from the action vocabulary. The badge's member rows — reorder, and the card's own place — stay. The arrangement's doors are exactly the two the user named: the Layout card's per-card **Off | Left | Right** rows, and the **sashes**.

### The sashes are the hand's, and kept

**[B03] A sash moves only when the hand moves it, and a rail with no record stands at equal shares.** `shares` stays a weight per componentId over the divisible run, bounded below by floors, and `sharedHeightsOf`'s weighted division is the whole allocator. An unnamed member weighs 1, so a rail nobody has divided stands equal — including the factory-fresh deck's first rail, which stands equal until the user resizes it and never runs the verb on its own. No seed, no settle, no re-stand on content, on resize, or on membership. Weights rather than pixel positions, because a weight over the run restores the same sash positions at the same window height and scales them with it, which is what a saved position should do when the window is a different size.

**[B04] The record outlives its members, the way `order` already does.** `_seededFitShares`'s membership sweep is deleted. A card that closes keeps its share in the record ([L23]); a card that opens with no share joins at weight 1 beside the others' unchanged weights, so their proportions among themselves hold and only the newcomer's share is new. This is the fix for [F01]: the one path that still threw the hand's sashes away.

**[B05] The persistence is the existing v4 blob, and a test proves the round trip.** `rails[side].shares` and `order` already serialize and parse ([F01]); with [B04] there is nothing left to drop them. The app-test drags a sash, relaunches, and reads the same sash position; then hides a card, shows it, and reads the same positions again. That second half is the case [F01] fails today.

**[B06] A rail whose floors exceed its run still stands as a strip, and that is the only standing besides shared.** The floors are design numbers ([B09] of the measured-height brief, unchanged) and cannot be honoured in a run shorter than their sum, so the strip fallback in `placeStandingOf` survives — reduced to that one case, with Flow's arithmetic removed from it.

### The one verb

**[B07] *Resize Sidebars to Fit* is the only automatic algorithm, and only the user runs it.** It is a registry command, `resize-sidebars-to-fit`, on the Tug-tier grammar of a deck verb. It runs once when invoked, writes its result as shares — the hand's, from then on — and nothing re-runs it: not a resize, not a content change, not a membership change, not a relaunch.

**[B08] The verb's arithmetic, per rail with visible members.** Each list card (Cards, Jots, Arcs, Tripwires) and the Layout card takes its **natural**: the height of its content element, read once from the DOM at the moment of the verb ([F07]). Overview takes three quarters of the run ([B10]). Then:

- **When the naturals fit** (Σ natural + seams ≤ run), the slack is distributed across the visible cards in proportion to their naturals, so every card stands at its natural plus a share of the slack and the rail is exactly full.
- **When they do not**, every card stands at its floor plus a share of what remains above the floors, in proportion to (natural − floor), so the cards shrink together and the rail is exactly full.

One formula in two regimes, both of which fill the run. Proportional rather than equal, so a card with more content gets more of the room; the alternative is recorded under Non-goals. The result is converted to shares by `placeSharesFromHeights`'s shared branch and committed through `setRailShares`, exactly as a drag is.

**[B09] The measurement machinery is deleted, not repurposed.** The verb reads a content element's height synchronously; nothing needs a store, an observer, a quiet period, a snapshot in deck state, or a per-card publish. So `card-appetite-store.ts`, `useMeasuredCardAppetite`, `DeckState.appetites`, `_settleAppetites`, `RESIZE_RETUNE_QUIET_MS`'s appetite use, `heightSource`, `greedRank`, `placeMemberAppetites`'s natural and greed, `flowHeightsOf`, `seedSharedHeights`, `seedPlaceShares` and every `layout` parameter in [F04] go. Each content card keeps its content element and marks it — a `data-` attribute on the element, so the verb can find it from the pane without a hook — which is the one trace the measured-height arc leaves.

**[B10] Overview's natural is three quarters of the rail's run, not a measurement.** Overview is a stream: its rendered height is a function of the height it is given, so it has no content height to read ([F07]). The verb stands it at 75% of the deck canvas's height — the same run the rail divides — before the slack is shared. A fraction of the run rather than a pixel constant, so the number means the same thing on every display; and a fraction rather than a whole screen, so the rail's other cards keep their naturals beside it. The fraction is a named constant beside the verb, not a registration field.

**[B11] ⌃⌥⌘R is the chord, and the Window row sits above the six card rows.** Registry: `menuEligible`, so the chord preempts every scoped binding. Swift: one `NSMenuItem`, id `window.resizeSidebarsToFit`, constructed with an empty key equivalent for `applyCommandChords` to fill, sending `resize-sidebars-to-fit` by `sendControl`, inserted after the *Slim / Comfy / Wide* separator and before the *Arcs* parent, followed by its own separator. On the chord algebra: `tuglaws/chord-tiers.md` reads ⌃⌥⌘ as the advanced form of a Tug-tier command, and ⌃⌘R is the Arcs card rather than a base this varies. The user chose ⌃⌥⌘R with that in view; `chord-tiers.md` records the grant as a second resident of the tier with its reading — R for *Resize*, on the tier reserved for deck-shaping verbs a user reaches for deliberately — rather than bending the row to the algebra.

### Scope edges

**[B12] Columns lose Flow and keep Stack.** `PlaceLayout` is deleted as a type, so a column's `layout` field goes with it and a divided column divides on Fit ([F08] — Flow was one screen per member there, a distinction nobody chose). Column `mode` — the slot's tab stack versus its division — is a different place and stands as it is, with its badge verbs and ⌃⌘S. The allocator keeps serving both places from stored shares and floors.

**[B13] The rails' widths are untouched.** [D136], [D140], [D166] and `retuneSidebarAllocation` stand ([F10]).

**[B14] The doctrine says what the rail is now, and the superseded briefs are marked.** `tuglaws/pane-model.md`'s rail paragraphs ("The LAYOUT belongs to the place", "A seam belongs to the hand", the measured-natural and stream paragraphs, `pane-model.md:131–145`) are replaced by three sentences: a rail is always divided; its sashes are the hand's, kept in the blob and never moved by the deck; one verb resizes on request. A design decision records the reversal of [D134] and the deletion of Flow, the seed and the appetites, and cites this brief. `briefs/sidebar-height-is-measured-brief.md` is superseded except for the content element, which survives as the verb's input; its `[B06]` stream test and `[B07]` invariant gate have nothing left to admit a card to.

**[B15] Every test of the rail's vertical machinery is deleted, none is rewritten, and two small ones replace them.** The user's verdict: those tests bogged down four implementation efforts for hours and in the end did nothing to help. So they go, whole: the app-tests `at0359-sidebar-stack`, `at0401-sidebar-split`, `at0540-rail-drop-stacked-side`, `at0542-rail-vertical-allocation`, and the unit tests `layout-imposer-flow.test.ts`, `layout-imposer-heights-census.test.ts`, `card-appetite-store.test.ts`, `place-allocation.test.ts`. The rail-mode and rail-layout assertions inside `at0469-layout-places`, `at0502-layout-card`, `layout-imposer.test.ts`, `layout-imposer-census.test.ts`, `layout-imposer-columns.test.ts`, `factory-rail.test.ts` and `card-registry.test.ts` are removed rather than adapted; what those files still assert about columns, widths, marks and registrations stays. `at0511-window-sidebar-rows` gains the one new Window row. The two replacements are deliberately small: the round trip of [B05] (drag a sash, relaunch, same position; hide a card, show it, same positions), and one app-test for the verb — a rail with a short list and a long one, run once, both regimes of [B08] asserted against the content elements' own heights, and a later content change asserted NOT to move a sash. Nothing else; a third test on this rail needs a reason this brief does not supply.

---

## Non-goals {#non-goals}

- **Any automatic re-run of the verb** — on window resize, on a card's content changing, on a card joining or leaving a rail, at launch, or once at the factory. Rejected by the whole of the Purpose: a rail that resizes itself is the thing that has not worked four times. The factory rail stands equal ([B03]); the user said no to running the verb there.
- **Rewriting the deleted tests under new names.** [B15] deletes them because they cost hours and helped nothing; a rewrite that preserves their assertions preserves the cost.
- **Stack for rails.** The occlusion stack [D134] synthesized was lived on and found to hide content the user wanted visible; the user has now chosen the other side outright.
- **Flow, for rails or columns.** Its one job was to stand cards at measured heights automatically ([B01], [B12]).
- **Equal distribution of the slack** in [B08]. Considered; proportional keeps a long list's room ahead of a short one's, which is what "size them to show the elements they have" asks for even past the naturals. Revisit only from a screen.
- **Equalize Heights and Fit to Content** as rail verbs. Two more algorithms beside the one the user asked for ([B02]); a hand can equalize with a drag.
- **Keeping the appetite store for the verb's input.** A store, an observer and a settle exist to keep a number current for a reader that runs on its own; a verb that runs on request reads the number when it runs ([B09]).
- **A card-level collapse to the title bar.** Still its own feature, still not this.
- **Pixel-position sashes.** Weights restore the same positions at the same window height and scale with a different one ([B03]).

---

## Exit {#exit}

**An arc.** The shape, in the order it must land:

1. **Strip** ([B01], [B02], [B09], [B12], [B15]) — delete `RailMode`, `PlaceLayout`, Flow, the seed, the settle, the appetite store and its five callers, `heightSource`, `greedRank`, the Layout card's rail rows, rail marks and stacked-rail drawing, the badge menu's rail verbs, the four action ids, and every test in [B15]'s deletion list and assertion list. The build is green with the allocator reduced to floors and stored weights, and no test on this rail is rewritten.
2. **Keep** ([B03], [B04], [B05], [B06]) — the membership sweep goes, a joining member weighs 1, and the round-trip test is red before and green after.
3. **The verb** ([B07], [B08], [B10], [B11]) — the content-element marker, Overview at three quarters of the run, the registry command with its chord, the Swift row, and the verb's app-test.
4. **Doctrine** ([B14]) — `pane-model.md`, the design decision, `chord-tiers.md`, the generated `menus.md`, and the supersession note on the measured-height brief.

Step 1 before step 3, so the verb is written against the one allocator rather than beside three. Step 2 is small and separable but must precede step 3's test, which asserts a later content change does not move a sash.
