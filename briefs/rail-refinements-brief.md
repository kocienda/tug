<!-- brief-skeleton v1 -->

# Rail refinements: hairlines that mean a boundary, a drop engine that measures seated frames, and rails that trade cards

**Purpose:** After the rail-panel arc landed (`[D181]`), a pinned rail draws hairlines at the window's own top and bottom, the drop-zone outline for a rail card in the air stands in the wrong place, and a sidebar card cannot be dragged from one side of the deck to the other. Four tuning notes, all to be done, directly on `main`.

---

## Purpose {#purpose}

The user's notes, verbatim:

> - I should *never* see an outline on a sidebar card when it intersects the top or bottom of the deck-canvas.
> - That point said above, we should show *all* the outlines around *all* the edges of a sidebar card when we drag it, (and then hide them again when we know where it has landed). Again, the rule on outlines on seated sidebar cards is to show them only when bordering a gap between another sidebar card or the gap between it and a content card.
> - Dragging a card shows an out-of-date outline geometry. Some code didn't get the memo.
> - I should be able to drag a sidebar card *between sides* of the deck canvas, meaning dragging a card on the left to the right, or dragging a card on the right to the left.

Two screenshots accompanied them: a right-hand rail split into CARDS / JOTS / LAYOUT with a hairline running along the canvas's top edge, and the same rail mid-drag with the orange drop-zone outline standing well above and to the left of the frame it was meant to trace.

The first two notes are one rule about what a rail hairline *means*. The last two are about the drop-zone engine: one is a measurement it gets wrong today, the other a vocabulary it deliberately does not have yet.

---

## Evidence {#evidence}

**[F01] Top rules are only ever drawn by member index 0, which is the member at the canvas top.** The panel treatment (`tugdeck/src/components/tugways/tug-pane.css`, the `[data-rail-treatment="panel"]` block) sets `border-width: 1px 1px 1px 0` on every pinned rail member and then drops `border-top-width` on every member whose `data-rail-member-index` is not `"0"`. So the seam's single hairline is the *lower* member's top rule, the first member keeps a top rule that lands exactly on the window's top edge, and the last member keeps a bottom rule that lands on the window's bottom edge. That is the outline in the first screenshot. **(verified — read from the CSS)**

**[F02] `data-rail-member-index` cannot say "last".** `TugPane` stamps a member's index (`tugdeck/src/components/chrome/tug-pane.tsx`, the `data-rail-member` spread) but not the rail's count, so no selector can pick the bottom member to drop its bottom rule. **(verified)**

**[F03] The in-flight window the user described already exists as `data-gesture`.** The frame receives `data-gesture` at lift (`tug-pane.tsx:2902`) and loses it only when the landing animation finishes (`landZoneDrop`, `tug-pane.tsx:2689` — "The frame keeps `data-gesture` until the landing finishes"), not at pointer-up. A card reordered within its own rail keeps `data-rail-side` throughout, so the existing "afloat regains the card frame" rule, keyed on the *absence* of `data-rail-side`, never fires for it. **(verified)**

**[F04] The drop engine still divides a rail with card-gap seams.** `tugdeck/src/lib/drop-zones.ts` hardcodes `IMPOSITION_GAP_PX` at three sites: `runOf` (sums member heights plus a gap per seam), `overflowTiles` (stacks tiles a gap apart), and `divisionTile` (surrenders half a gap at each interior edge). The imposer now divides a rail with `RAIL_SEAM_PX` (0) and a column with `IMPOSITION_GAP_PX`, carried as `PlaceRun.seam` (`tugdeck/src/lib/layout-imposer.ts`). The file's own contract — "both sides compute the landing from `railSeamFractions`, so they cannot drift ([P06])" — is broken by 5px per seam for a rail. **(verified)**

**[F05] A frame in flight defines the place it is flying over.** `enumerate` (`tugdeck/src/components/chrome/deck-canvas.tsx:3099`) measures every `.tug-pane[data-pane-id]` with `getBoundingClientRect()`, which includes the drag transform. `railZonesOf` then takes the run's top from `Math.min` over the members' `y` and the strip's `x`/`width` from `members[0]` — so the dragged card's travelling position moves the run, and the whole strip if it is the first member. The gesture re-enumerates on every autoscroll frame (`tug-pane.tsx:3168`), so the error grows the longer the pointer holds at the edge. This is the offset in the second screenshot. The column path (`columnZonesOf`) has the identical hazard. **(verified — read from the code; the screenshot's offset is consistent with it, not separately measured)**

**[F06] Cross-place drops are a named non-feature.** `enumerateDropZones` (`drop-zones.ts:535`): "a pinned sidebar card sees its own rail's positions and nothing else … Cross-place drops are a later feature, and the way this stays a later feature is that neither vocabulary can name the other's places." The `rail-index` commit (`deck-canvas.tsx:3247`) calls `setRailOrder(zone.side, …)` alone and assumes the dragged card is already a member of that side. **(verified)**

**[F07] The pieces of a one-commit side change exist.** `withSidebarSide` (`layout-imposer.ts:367`) and `withRailOrder` (`layout-imposer.ts:467`) are pure imposition transforms; `setRailMode` (`tugdeck/src/deck-manager.ts`) composes two of them into one `_reimpose` and states why: "One commit carrying both fields, never two: the split arms exactly one settle." `setSidebarSide` alone would append the card at the side's default position and settle once, then `setRailOrder` would settle again. **(verified)**

**[F08] An unoccupied side has no strip.** A rail's inset is published as `--tug-imposer-inset-left`/`-right` and its width as `--tug-sidebar-width-left`/`-right` (`sidebarWidthProperty`); a side with no pinned sidebar cards has inset 0 and nothing standing in it, so there is no DOM box an `enumerate` could read a zone from. The precedent for a held-open place is `.tug-slot-vacancy` (`deck-canvas.tsx:3585`): a tile rendered at the anchor and width a landing card would take, inert to the pointer, shown under the canvas's `data-carrying` attribute (`tugdeck/src/components/chrome/slot-vacancy.css`), and read by `enumerate` through `[data-vacant-slot]`. **(verified)**

**[F09] A stacked rail is one rect, front to back.** Every member of a stacked rail draws the same frame; which one is in front is z-order from the store's pane array (raise on activate), and the rail's stored `order` and `shares` are kept across stack/split so a re-split lands where the user left it. **(verified)**

---

## Decisions {#decisions}

**[B01] A rail hairline marks a boundary with something else; the window's own edges get none.** The rule the user stated: a seated sidebar card shows a rule only where it borders the seam with another sidebar card or the gutter to the content cards. The window's top and bottom are not boundaries with anything, which is the same reason the outer edge has never carried one. Consequences: a stacked rail — one member, no seams — draws only its inner-edge rule and reads as one flush panel from window top to window bottom; an overflowing rail's clipped members have no top or bottom rule to hide.

**[B02] The seam's one hairline is the upper member's bottom rule; top rules are gone.** Rather than the lower member owning the seam (today's `border-top-width: 0` on every member but the first), every member has `border-top-width: 0`, and every member *with a member below it* has `border-bottom-width: 1px`. The last member draws no bottom. This puts both window edges on the same footing without a special case for index 0.

**[B03] `TugPane` stamps whether a member is the last one.** `data-rail-member-index` stays; a companion `data-rail-member-last` (or an equivalent the CSS can select against) is stamped from the rail's member count, because "am I last" is a fact the pane has and the stylesheet needs, and index alone cannot say it ([F02]).

**[B04] The full hairline runs the rail's width, unchanged.** The user's call ("leave it"): no horizontal terminator or inset at the gutter side of a seam.

**[B05] A rail card in the air regains the whole card frame, keyed on `data-gesture`.** For the duration of `data-gesture` — lift to landing's end ([F03]) — a pinned rail member gets `border-width: 1px` on every edge, and the card's radius and shadow back. This is the doctrine the treatment block already states for a rail dragged off its pin ("it regains the frame while it is afloat … needs a card's frame to read as a thing that can be dropped"); a card reordered within its rail is afloat for the same reason, so the afloat rule and the in-flight rule become one statement rather than two. Hiding "when we know where it has landed" is exactly when `landZoneDrop` removes the attribute, so no new lifecycle is needed.

**[B06] The drop engine carries the seam as a value, as the imposer does.** `runOf`, `overflowTiles`, and `divisionTile` take a `seam` parameter; `railZonesOf` supplies `RAIL_SEAM_PX`, the column path `IMPOSITION_GAP_PX`. This restores the [P06] contract ([F04]) by the same move that fixed it on the imposer side (`PlaceRun.seam`), so the two sides agree by construction and a future seam change is one constant.

**[B07] A place's geometry is measured from seated frames only.** A rail's run comes from `getRailRunHeight()` and its strip's `x`/`width` from any member *other* than the one being dragged; only when the dragged card is the rail's sole member is its own rect used, and then its rect at gesture start rather than a re-measure. Columns get the identical treatment against `getColumnRunHeight()`. This closes [F05] structurally rather than by subtracting the transform back out, which would leave the next re-measure site to make the same mistake.

**[B08] A rail card's drag vocabulary is both rails.** `enumerateDropZones` enumerates `railZonesOf` for every side, not only the dragged card's. The card's own rail advertises N positions (it is already one of them); the other rail advertises N+1 (it is an arrival). Each side's hit bands widen to that side's full rail band, so the pointer crossing the deck finds them. The content-card vocabulary is untouched — a content card still never sees a rail.

**[B09] A cross-side landing is one commit.** A new deck-manager verb — `moveSidebarToRail(componentId, side, index)` or equivalent — composes `withSidebarSide` with `withRailOrder` on both sides (removed from the origin's order, inserted at `index` in the destination's) into a single `_reimpose`, on the `setRailMode` precedent ([F07]). The existing `rail-index` commit routes through it when `zone.side` is not the card's current side, and stays as it is otherwise.

**[B10] The empty side holds open a landing strip while a rail card is in the air.** The user's call ("let's try this"). A side with no pinned sidebar cards renders a vacancy tile at the edge — the rail's anchor and the width a landing card would take — shown under `data-carrying` like `.tug-slot-vacancy`, inert to the pointer, and read by `enumerate` as that side's one `rail-index` zone at index 0. This is the third place the vacancy pattern applies ([F08]), and the tile is the promise the indicator draws, the same way a slot's is. The strip's width is the destination side's stored width where one is remembered, else the dragged card's own rail width, so the tile is the frame the card will actually take.

**[B11] Dropping onto a stacked rail joins the stack on top; the rail stays stacked.** The user's call. A stacked destination advertises one zone — the rail's whole rect — and the arrival goes to the front (raised, index 0 of the stored order), with the destination's mode untouched. Splitting the rail on arrival is ruled out.

**[B12] All four notes are done in this piece of work, on `main`.** The user declined to defer cross-side dragging. The order of landing that the code wants: the drop engine first ([B06], [B07]) because a correct outline is what the rest is judged by, then the hairlines ([B01]–[B05]), then cross-side dragging ([B08]–[B11]).

---

## Open Questions {#open-questions}

- **Where the arrival lands on a split destination when its zone is at the strip's overflow tail.** A rail of three or more stands under the overflow rule; the N+1 tiles for an arrival are `run / 2.5` tall down a strip that runs past the canvas. Whether the destination's strip should autoscroll for a *foreign* card the way it does for its own is not settled here; the autoscroll target reads the pointer's side and should just work, but it has only ever been exercised by a member. To be confirmed at the first app-test, not decided in prose.

---

## Non-goals {#non-goals}

- **Content cards onto a rail, or rail cards into a content slot.** The vocabularies stay disjoint across *kinds* of card ([F06]); this work only lets a rail card name the other rail.
- **Subtracting the drag transform from a live measurement** as the fix for [F05]. It would correct today's site and leave every future re-measure to repeat the mistake; seated-frames-only ([B07]) is the rule that survives.
- **A horizontal terminator at the gutter side of a seam** — rejected by the user ([B04]).
- **Splitting a stacked destination on arrival** — rejected by the user ([B11]).
- **Two `_reimpose` calls for a side change** — two settles for one gesture, ruled out on `setRailMode`'s own reasoning ([B09]).
- **A rail seam other than 0 or a change to `RAIL_SEAM_PX`.** The seam is the previous round's decision; if the 0 seam reads wrong it is one constant, and not this work.

---

## Exit {#exit}

**An arc.** The first steps, in the order [B12] names:

1. Thread `seam` through `runOf`, `overflowTiles`, and `divisionTile` in `drop-zones.ts`; `railZonesOf` and the column path each supply theirs. The existing drop-zone unit tests pin the rail tiles at the 0 seam.
2. Make `railZonesOf` and `columnZonesOf` read the run from the store's run-height and the strip from a seated member, with the sole-member fallback ([B07]). An app-test that autoscrolls a rail drag and asserts the indicator's rect against the seated member's.
3. The hairline rule ([B01]–[B03]): `data-rail-member-last` stamped in `tug-pane.tsx`; the panel block rewritten to inner edge plus a bottom rule on every non-last member. `at0401`/`at0359` extended to read the rules.
4. The in-flight frame ([B05]): the panel block's `[data-gesture]` rule, folded together with the afloat rule.
5. Both-rails enumeration ([B08]) and the one-commit verb ([B09]), with the `rail-index` commit routed through it.
6. The empty-side vacancy ([B10]) and the stacked-destination zone ([B11]), each with an app-test that drags a card from one side to the other and asserts the new imposition.
7. Doctrine: `tuglaws/pane-model.md` § rail and `[D181]` say the hairline rule and the cross-side gesture.
