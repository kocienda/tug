<!-- brief-skeleton v1 -->

# The Drop Preview Traces the Landing, and Goes Behind the Rail to Do It

**Purpose:** The drop-zone outline on a flow deck is cut at the band's edge, so a card carried toward a rail or the canvas edge is shown a box no card will ever occupy. The preview should always be the frame the card lands in, even when part of that frame lies behind a rail or off the canvas.

---

## Purpose {#purpose}

> "The drop previews aren't quite right here. They should always show what the card will look like when I drop, i.e. not misaligned, and that also means that the preview frame should sometimes go off-screen."

Two screenshots, both on a four-up slim flow deck with a Layout rail standing on the right. In the first, the outline is a tall narrow box at the band's left edge, 428px wide on a 675px slot, overlapping the middle of a card that is not moving. In the second, the outline stops flush at the band's right edge while the card in hand runs on past it toward the rail. Neither box is where the card will land; each is the visible part of where it will land, and that reads as misalignment. The Layout card's miniature draws the same cut rect.

This is the other face of the `slot-drag-click` arc (`briefs/slot-drag-click-brief.md`, joined as `4aef806c3`). Its [B05] answered "a content drag should never highlight a sidebar slot" by clipping a content card's zones to the band. The clip removed the outline from the rail and put a lie in its place.

---

## Evidence {#evidence}

**[F01] The straddler's landing rect is cut at the band edge.** `clipZonesToBand` in `tugdeck/src/lib/drop-zones.ts` runs over every content zone `enumerateDropZones` returns: a zone whose rect lies wholly outboard of the band is dropped, and a straddling zone's `rect` **and** `hit` are both cut to the in-band portion by `clipRectToBand`. `indicate` in `tugdeck/src/components/chrome/deck-canvas.tsx` hands `zone.rect` straight to `indicateDropZone` (`tugdeck/src/lib/drop-zone-indicator.ts`), which sets the outline's `left`/`width` from it, and to `publishDragZone`, which the Layout miniature reads. So the outline and the miniature trace the cut rect rather than the tile. **(verified — read out of the source; the two screenshots are that rect on screen.)**

**[F02] The outline was on the rail because it outranks the rail.** `.tug-drop-zone-indicator` in `tugdeck/styles/chrome.css` is `position: absolute; z-index: 99960`. The rail band is `SIDEBAR_PANE_ZINDEX_BASE` 8990 and eight ranks above it, the margin caps and the rail shadow are `MARGIN_CAP_ZINDEX` 8989, and content panes take `CARD_ZINDEX_BASE + i` from 1 (`deck-canvas.tsx`). A card travelling toward a rail slides behind it because the rail outranks the card (`tuglaws/pane-model.md`, "the rails occlude and the margin is capped"); the indicator was the one element in the drag exempt from that order, which is the whole reason a straddling tile's outline could be seen on the panel. **(verified.)**

**[F03] The hit rect and the landing rect are already distinct things.** `DropZone.hit` is optional and `hitRectOf(zone)` falls back to `rect`; `pickLiveZone` scores zones by `hitRectOf` alone, and `indicate` reads `rect` alone. A column position's hit is a band across the run that differs from its tile by design (`tileHitBands`). So a zone can keep a true `rect` and a clipped `hit` without any reader having to learn a new field. **(verified.)**

**[F04] The pin that guards the rail asserts absence, not occlusion.** `tests/app-test/at0549-card-drag-leaves-the-rail.test.ts`, the flow-click test added by `slot-drag-click`, samples `.tug-drop-zone-indicator`'s right edge against the rail's left edge every 8ms and asserts the worst overhang is within 3px. Under [B02] below that assertion becomes false by design: the outline's box will extend behind the rail, and what must hold instead is that the rail paints over it. `getBoundingClientRect` cannot see paint order; the pin has to read stacking — `getComputedStyle(indicator).zIndex` against the rail's — or use `document.elementFromPoint` at a point on the rail inside the outline's box and require the rail. **(verified — read from the test.)**

**[F05] What happens past the canvas edge on a side with no rail is not established.** The margin cap on a rail-less side covers the band's own `IMPOSITION_GAP_PX` at 8989 and paints the body's ground (`margin-cap.css`, `deck-canvas.tsx` near line 6488), so an indicator ranked under it is occluded across the gap. Past the gap the outline's box lies outside the canvas element. Whether it is clipped there, or paints over the Arcs/Overview column beside the deck, depends on the overflow of the canvas's ancestors, which this reading did not settle; the `overflow` rules found in `chrome.css` are for an SVG glow, not the canvas. **Inference; one drag toward the rail-less edge on a debug build confirms it either way**, and the first screenshot is exactly that drag.

---

## Decisions {#decisions}

**[B01] A zone's landing `rect` is never clipped; only its `hit` is.** The rect is the promise — the frame the commit will give the card — and the outline and the miniature must trace it whole or they are showing something the drop will not do. The hit is what a hand can ask for, and it stays cut to the band so a pointer over a rail finds nothing under it and the incumbent holds, exactly as `slot-drag-click` [B06] wanted. `clipZonesToBand` keeps its two other rules unchanged: a tile wholly outboard of the band is still not offered — a landing nobody can see is not an offer — and rail zones are untouched, because a rail card's places are the rails. The unit test "a straddling position's hit rect is cut with its tile" in `tugdeck/src/lib/__tests__/drop-zones.test.ts` inverts to "the hit is cut and the tile is not"; the origin keeps its unclipped fallback as it does now.

**[B02] The indicator ranks below the rails and the margin caps, and above every content card.** The outline traces a tile that slides behind the rail, so it slides behind the rail with it: a straddling tile's box now runs on under the panel and the panel paints over it, which is "the preview frame goes off-screen" with no clipping arithmetic at all. The value is flat and lives with the other chrome tiers in `tugdeck/styles/chrome.css` beside `--tug-z-pane-sheet-open` (8900), which already documents that a flat value clears every free pane with room to spare. It must be strictly below 8989 (the caps and the rail shadow), so the cap on a rail-less side occludes the outline across the gap the same way it occludes a card. The dragged frame's own rank does not matter: the outline is the place, and the card in hand may cover it.

**[B03] `at0549-card-drag-leaves-the-rail`'s rail pin asserts occlusion, not absence.** The outline's box may cross the rail's near edge; the rail must paint over it. `document.elementFromPoint` at a point on the rail inside the outline's box, expected to resolve to the rail (or a descendant), is the reading that matches what the eye checks; the z-index comparison is the cheaper fallback if `elementFromPoint` proves flaky under the harness's occlusion. The flow-click assertions in the same test — one slot's reveal, held under the parked hand — are untouched.

**[B04] The miniature changes nothing and inherits the true rect.** `publishDragZone` is fed `zone.rect`; with [B01] that is the whole tile, and the Layout card's highlight becomes the whole slot rather than its visible fraction, which is what a plan of the strip should show. No work in `layout-miniature.tsx`.

---

## Open Questions {#open-questions}

- **[F05] — the rail-less edge.** If the outline paints over the column beside the deck rather than being clipped at the canvas, the answer is an `overflow: clip` on the canvas element or its frame container, chosen after checking that nothing the canvas positions is meant to escape it (the SVG glow in `chrome.css` is the one candidate found). Settle it with one drag on a debug build before the z value is committed, not after.

---

## Non-goals {#non-goals}

- **Offering a tile that lies wholly behind a rail.** Rejected: with the indicator under the rail the outline would be invisible, and the drop would land the card somewhere the reader could not see. The click ([slot-drag-click] [B02]) is how a hand reaches a slot behind the rail — it brings the slot into the band first.
- **Re-clipping the indicator by arithmetic instead of by stacking.** Rejected: any cut rect is the misalignment this brief is about. Occlusion is the rule the cards already live under, and the outline is a drawing of a card's place.
- **Drawing the outline at the dragged frame's rank or above it.** Rejected: the outline is the place, not the card; nothing is lost when the card in hand covers it.
- **Re-clipping the flow band's ink.** The occlusion decision stands (`briefs/flow-band-occlusion-brief.md` [B01]).
- **Touching the click, the hysteresis, or the band edges.** All of `slot-drag-click` outside [B05]'s rect clip stands as landed.

---

## Exit {#exit}

**An arc.** The shape of the work, in the order it should land:

1. **[B01]** in `clipZonesToBand`: clip `hit`, leave `rect`; invert the straddler unit test and add one for a straddling `slot` zone (no hit of its own) gaining a clipped `hit` while keeping its tile.
2. **[B02]** in `chrome.css`: the indicator's tier, declared beside the other flat chrome tiers with its argument, strictly under `MARGIN_CAP_ZINDEX`.
3. **Confirm [F05]** with one drag toward the rail-less edge on a debug build, and clip the canvas if the outline escapes it.
4. **[B03]** in `at0549-card-drag-leaves-the-rail`: the rail assertion becomes an occlusion reading; re-run `at0549-rail-drag-leaves-the-band`, `at0454-flow-mode` and `at0457-drop-zone-drag` (still red on its pre-existing line-397 assertion; nothing here should move that).
