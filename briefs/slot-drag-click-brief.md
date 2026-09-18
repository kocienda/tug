<!-- brief-skeleton v1 -->

# Dragging a Card Between Slots Clicks the Band, One Slot at a Time

**Purpose:** Carrying a content card across a flow deck scrolls the strip at a rate, from a margin measured against the wrong band, and can indicate a slot tile that lies behind a sidebar rail. The band should click one slot per deliberate crossing of the rail's inner edge or the canvas edge, with hysteresis, and a content drag should never indicate anything but a content slot.

---

## Purpose {#purpose}

> "Dragging cards between slots isn't great. The *next slot* trigger should happen at the edge of the sidebar rails or deck/canvas, whichever comes first, and the *click* to the next slot, rather than scroll. The *click* should have a hysteresis, so I can control how it moves. Also, dragging a content card should *never* highlight a sidebar slot — content slots only."

Three complaints, all about one gesture: the title-bar drag of a content card on a deck in flow, where the strip is longer than the band and the card has to be carried to a slot that is not on screen.

1. **Where the trigger is.** The band is expected to advance when the hand reaches the edge of the deck: the rail's inner edge when a rail stands on that side, otherwise the canvas edge. Today it fires somewhere else.
2. **What the trigger does.** The strip should step to the next slot as a discrete click, not slide at a rate for as long as the hand holds. And a click should be something the hand controls: one crossing, one click.
3. **What gets indicated.** A content card is offered content places only. Whatever is being drawn on the sidebar during a content drag is wrong.

---

## Evidence {#evidence}

**[F01] The flow autoscroll band ignores the rails.** The flow branch of `autoscrollTargetFor` in `tugdeck/src/components/chrome/deck-canvas.tsx` reports `bandStart: IMPOSITION_GAP_PX` and `bandEnd: IMPOSITION_GAP_PX + band`, where `band` is `getBandWidth()` — the canvas less the rail insets and two gaps. The band's real left edge is `INSET_LEFT + GAP` (the flow `style.left` expression in `tugdeck/src/lib/layout-imposer.ts`, `imposeStyle`), and `INSET_LEFT` is the left rail's width plus a gap when one stands (`resolveSpan`, `railSpanInsetPx`). So with a left rail the reported band starts under the rail, and its right end lands a full rail width inboard of the true right edge. The column and rail branches of the same function read their band off a seated member's frame; the flow branch is the one that does not. **(verified — read out of the source.)**

**[F02] The trigger is a margin and the motion is a rate.** `autoscrollDelta` in `tugdeck/src/lib/drop-zones.ts` returns travel whenever the pointer is within `AUTOSCROLL_MARGIN_PX` (56) of either band edge, at `AUTOSCROLL_RATE_PX_PER_SEC` (900), scaled by elapsed time. `advanceAutoscroll` in `tugdeck/src/components/chrome/tug-pane.tsx` runs it on the gesture's own rAF, writes the offset to the flow custom property through `applyScroll`, reschedules itself while the hand holds, and commits once at release through `commitScroll` with a cut landing. Nothing in that path knows what a slot is. **(verified.)**

**[F03] The drag's frame compensation reads the running offset per frame.** `autoscrollCompensation` in `tug-pane.tsx` sums `run.offset - run.target.offset` over every strip the gesture has moved and adds it to the frame's transform, so the card stays in hand while the strip moves under it. It reads whatever offset the run holds this frame and does not care how the offset got there — a rate, a step, or an interpolated step all compensate the same way. **(verified.)**

**[F04] The two vocabularies are already disjoint at the engine.** `enumerateDropZones` in `drop-zones.ts` offers a content card `column-index`, `slot` and `tab-bar` zones and never a `rail-index`; the tab-bar cache built at drag start in `tug-pane.tsx` skips every bar inside a `.tug-pane[data-sidebar-pane]`. `at0457-drop-zone-drag.test.ts` (item 7) and `at0549-card-drag-leaves-the-rail.test.ts` pin this. The sidebar highlight is therefore not a rail zone being offered. **(verified.)**

**[F05] A content tile behind a rail is still offered, at its real rect, and the indicator paints above rails.** Since the flow band went from clipping to occlusion (`briefs/flow-band-occlusion-brief.md`, [B01]), a slot tile that has travelled past the band edge slides under the rail with its DOM frame intact. `enumerate` in `deck-canvas.tsx` measures every shown pane frame and every `.tug-slot-vacancy[data-vacant-slot]` tile off the DOM, so those tiles become `slot` and `column-index` zones at their true, off-band rects. `pickLiveZone` chooses by edge distance then centre distance, so a hand nearing or over the rail is nearest to exactly that tile. The indicator (`.tug-drop-zone-indicator`, `styles/chrome.css`) is `z-index: 99960`, above the rails at 8990–8999, so the outline draws on the sidebar. The Layout card's miniature draws the same rect through `publishDragZone`. **This is inference from reading; nothing reproduced it.** One drag of a content card toward a rail on a flow deck with a straddling slot would confirm it, and is the first thing the arc should do.

**[F06] The reveal arithmetic that a click wants already exists.** `flowRevealOffset` in `layout-imposer.ts` answers "the least travel that shows this slot whole", and `deckFlowStrip` in `tugdeck/src/deck-store-selectors.ts` gives every slot's strip position and extent, empty slots included. `DeckManager._flowRevealOffsetFor` uses exactly this pair when a card is raised. The centring rule (`stripCenterOffset`, used by the Layout card's flow strip on a segment press) is the other candidate and is what a reader naming a slot gets. **(verified.)**

**[F07] The feel constants have one home.** `drop-zones.ts` opens with a `[Q01]` block holding `ZONE_HYSTERESIS_PX`, `AUTOSCROLL_MARGIN_PX` and `AUTOSCROLL_RATE_PX_PER_SEC`, on the stated rule that a tuning round is one file and one diff. `ZONE_HYSTERESIS_PX` already gives the zone indication a sticky incumbent; the strip's motion has no equivalent. **(verified.)**

**[F08] The tests that hold this gesture.** `tests/app-test/at0457-drop-zone-drag.test.ts` (the engine's seven promises), `at0549-card-drag-leaves-the-rail.test.ts` (a content card over an overflowing rail leaves the rail's offset alone and rings no edge), `at0549-rail-drag-leaves-the-band.test.ts` (its mirror), `at0537`, `at0538`, `at0539` (rail drags), and `at0454-flow-mode.test.ts` (the band edge). Unit coverage of the pure half lives in the `drop-zones` and `layout-imposer-flow` test files under `tugdeck/src/lib/__tests__/`. **(verified — listed from the tree.)**

---

## Decisions {#decisions}

**[B01] The flow trigger edge on each side is the rail's inner edge when a rail stands there, and the canvas edge otherwise.** That is "whichever comes first" walking outward from the middle of the deck: a rail is always inboard of the canvas edge, so it is the first edge the hand reaches. The edges are exposed from the store beside `getBandWidth()`, computed from the same rail insets that size the band (`_flowBandWidth`), so the trigger and the pins agree by construction rather than by two readings of the rails ([F01]). The flow branch of `autoscrollTargetFor` reads them and stops reporting the bare gap. The 5px seam between the rail's inner edge and the band's edge is inside the trigger, not a place the hand has to find.

**[B02] Crossing an edge clicks the strip one slot, and nothing slides at a rate.** On the right edge the click names the first slot whose right edge lies past the band's right edge; on the left, the first whose left edge lies before the band's left edge. The new offset is `flowRevealOffset` for that slot — the least travel that shows it whole ([F06]). Reveal rather than centre, because the hand is reaching for the slot beside the rail and everything else on screen should move as little as possible; centring is the rule for a reader naming a slot by number, which is a different gesture. The offset still travels through `applyScroll` per frame and `commitScroll` once at release, exactly as the rate did, so the store is written once and the cut landing stays.

**[B03] A click animates on the gesture's own rAF, not on a CSS transition and not on a second clock.** The step interpolates from the standing offset to the target over a short duration (a feel constant, on the order of 150–200ms), one write of the custom property per frame. This is the same frame loop the rate used ([D135], one clock), and it is what keeps the card in hand: the compensation reads the run's offset per frame and adds it to the transform ([F03]), so an interpolated offset compensates for free. A CSS transition on the property would move the strip on a clock the compensation cannot see, and the card would lag the strip for the length of the tween.

**[B04] The click has hysteresis: fire on crossing out, re-arm on coming back in, and repeat only slowly while held.** Three feel constants, all in the `[Q01]` block of `drop-zones.ts` beside the others ([F07]):

- **Fire at the edge.** The first frame the pointer is outboard of a side's trigger edge ([B01]) fires one click on that side and disarms it.
- **Re-arm inboard.** The side re-arms only once the pointer has come back inside the band by `FLOW_STEP_REARM_PX` (start at 24–32px). A hand parked at the edge, or trembling across it, fires nothing more. This is what "so I can control how it moves" asks for: one crossing, one click.
- **Slow repeat while held.** A hand that stays outboard of a disarmed edge gets another click every `FLOW_STEP_REPEAT_MS` (start around 700ms), so a six-slot strip can be crossed without pumping the hand. Set to `Infinity` to make every click a crossing. This is the one knob expected to move during tuning.

The decision is a pure function — pointer, the two edges, the per-side armed state, and the clock in; a step direction or nothing out — so it is testable over synthetic geometry the way `autoscrollDelta` is. The gesture carries the armed state per side the way it carries `autoscrolledRef` today, and clears it with the rest of the drag's state on every path that ends the gesture.

**[B05] A content card's zones are clipped to the band.** A tile whose rect lies wholly outboard of the band ([B01]'s edges) is not offered. A tile that straddles an edge keeps only its in-band portion, for both its landing `rect` and its `hit` rect, so the indicator can never draw on a rail and the Layout card's miniature inherits the same rects ([F05]). The clip is a step in `enumerateDropZones` over the measured band, in the pure half, so a unit test can hold it. Rail zones are not clipped: a rail card's places are the rails.

**[B06] While the hand is outboard, the incumbent zone holds; after a click, the indication walks by re-enumeration.** With off-band tiles gone ([B05]), a pointer over a rail has no zone under it; `pickLiveZone` keeps the incumbent rather than jumping to whatever in-band tile is nearest by centre. When a click lands, the gesture re-enumerates (the strip moved, so every tile moved — the same rule the rate used), the newly revealed tile beside the rail is now in-band and nearest, and the indication moves to it. One click, one slot, and the outline says so. No new indication logic is written for this; it falls out of [B05] and the existing re-enumerate-on-scroll.

**[B07] Columns and rails keep their vertical rate scroll.** The complaint is about slots, which are the flow strip's places. `AUTOSCROLL_MARGIN_PX` and `AUTOSCROLL_RATE_PX_PER_SEC` stay for the column and rail branches, and `autoscrollDelta` keeps serving them. If a column's run wants the same click later, [B04]'s function is axis-free by construction and can be read vertically; that is a separate arc.

**[B08] The feel numbers are tuned by hand on a debug build, in one file.** As `[Q01]` already says of the drag's other constants. The step duration, the re-arm distance and the repeat interval ship with the starting values above and are expected to move; the brief fixes the structure, not the numbers.

---

## Open Questions {#open-questions}

- **Confirm [F05] in the app before building on it.** It is the mechanism the reading found for "highlights a sidebar slot", and it is the only finding here that was not read directly out of a rule. If a drag toward a rail on a flow deck with a straddling slot shows the outline on the rail, [B05] is the fix. If the highlight is something else, the arc stops and says what it saw.

  **[F09] Confirmed, both halves, with a probe in the app.** Five 420px cards in a six-up flow with a right Layout rail (rail frame 1239–1659 on a 1659px canvas), the first card carried by its title bar to the rail's centre and held. A rAF sampler read `.tug-drop-zone-indicator` against the rail's frame every frame: of 85 frames with an outline, 78 overlapped the rail. Two shapes were seen. While the rate scrolled the strip, the outline was a 420px slot tile straddling the rail's inner edge at its true rect (`1160..1580`, `1345..1765`, `1225..1645` against `rail.left = 1239`) — a straddling tile is not cut. Once the CSS clamp held the last card against the band's edge, the outline settled on `1239..1659 × 6..1047` for the rest of the hold: the empty slot 5's vacancy tile, whose strip position at the clamp lands exactly under the rail — a tile wholly outboard of the band is still offered, and `pickLiveZone` chooses it because it is the tile under the hand. Neither shape was a rail zone; the canvas read `card` throughout. So the sidebar highlight IS an off-band content tile, and [B05] is the fix. Seen in passing: the flow offset property kept advancing at the rate past the CSS clamp (property `1140` while the clamp drew `891`), so the rate overshoots the strip's end and the click, which names a slot through `flowRevealOffset`, should not.

---

## Non-goals {#non-goals}

- **Centring the revealed slot.** Rejected for the drag: the hand is reaching for the slot beside the rail, and centring moves everything on screen more than the reach asks. Centring stays the Layout card's rule for naming a slot by number ([B02]).
- **A CSS transition on the flow offset property.** Rejected: it would move the strip on a clock the drag's compensation cannot read, and the card would lag the strip ([B03]).
- **A wider trigger margin instead of the edge.** Rejected: a margin inside the band is a hairline to find, and it is how the current rate fires in the middle of the deck under a left rail ([F01]). The edge is a thing the hand can feel.
- **Firing a click on dwell alone, with no crossing.** Rejected: a click with no crossing is the rate again, in coarser units. The crossing is the act; the repeat while held is the concession to long strips, and it is slow and switchable ([B04]).
- **Clicking columns and rails.** Out of scope ([B07]).
- **Re-clipping the flow band.** The occlusion decision stands (`flow-band-occlusion-brief.md` [B01]); the fix is to clip the zones, not the ink ([B05]).

---

## Exit {#exit}

**An arc.** The shape of the work, in the order it should land:

1. **Confirm [F05]** with one drag in the app, and note what was seen.
2. **The band's edges, from the store** ([B01]): expose them beside `getBandWidth()` and read them in the flow branch of `autoscrollTargetFor`. `at0549-card-drag-leaves-the-rail` and `at0454-flow-mode` are the fixtures with rails standing.
3. **Clip content zones to the band** ([B05]) in `enumerateDropZones`, with unit tests over synthetic geometry: a tile behind a rail is not offered, a straddling tile is cut at the edge, a rail card's zones are untouched.
4. **The step decision** ([B04]) as a pure function in `drop-zones.ts`, with its three constants, and unit tests for fire, re-arm, and repeat.
5. **The click in the gesture** ([B02], [B03]): replace the flow branch of `advanceAutoscroll` with the step and its rAF tween, keep `applyScroll` and `commitScroll` as they are, carry and clear the armed state.
6. **App-test pins:** extend `at0549-card-drag-leaves-the-rail` so a content card held over a rail clicks the band one slot and no outline draws over the rail; re-run `at0457`, `at0454` and the rail-drag files, since their fixtures cross the band.
7. **A tuning round** ([B08]) on a debug build for the three numbers.
