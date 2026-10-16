/**
 * at0455-column-split-flow.test.ts — a content slot, divided: a split column in flow.
 *
 * Two cards sharing a numbered slot stack front-to-back and z-order decides
 * which one you see, exactly as two sidebar cards on one edge do. The user may
 * instead SPLIT that slot, and then its vertical run is divided between them
 * and both are visible at once. Stack stays the default; the choice is per-slot
 * state on `imposition.columns`, keyed by pane id ([P11]).
 *
 * The rail already does all of this (at0401), and columns reuse its arithmetic
 * rather than fork it — so what this file is for is the part that is NOT
 * shared: the place. Every assertion below is read from live
 * `getBoundingClientRect()`, because the failures a column-specific bug
 * produces are geometric.
 *
 *   1. **A split column TILES its slot.** Top member at the imposition gap,
 *      bottom member at the deeper bottom gap, exactly one gap of air between
 *      them, and — the column-specific half — one shared width and LEFT edge,
 *      unchanged from the stacked frame. A split divides the run; it must not
 *      touch the band.
 *   2. **The seams are per slot, not per deck.** Two slots split at once must
 *      divide independently: dragging one slot's seam moves that column's two
 *      members and nothing in the other. A single shared property would pass
 *      every single-column test and fail this one.
 *   3. **The seam drags and clamps** against each member's own floor, and the
 *      weights land in the record keyed by pane id.
 *   4. **A column of one is byte-identical to an unsplit slot.** Split a slot,
 *      then take a member away, and the survivor stands exactly where a card
 *      that had never been split stands — no seam, no fractional pin.
 *
 * The stale-seam sweep is asserted through case 4 rather than by reading
 * properties: a survivor pinned to a seam that is no longer drawn is precisely
 * what a missed sweep looks like on screen.
 *
 * Cut from `at0455-column-split` to fit the 20 s budget. This file carries a
 * split column standing in flow; `at0455-column-split-tiles` carries claims
 * 1–4, `-doors` the Layout card's row and the badge menu, and `-chords` the
 * split chords. The deck and the readers are `column-split-fixture.ts`.
 *
 * Deliberately NOT declaring `@covers tugdeck/src/deck-manager.ts`, though this
 * file does drive `setColumnMode` and `setColumnShares` through the action
 * layer. That path is already at the selection budget's ceiling — naming it
 * here makes an edit to the store a 21-file run, which the budget refuses
 * outright and the lint fails on the commit that creates it. The rail twin of
 * every store verb used here is covered from at0401, which does name it.
 *
 * @family at0455-column-split
 * @covers tugdeck/src/layout-imposition.ts
 * @covers tugdeck/src/lib/layout-imposer.ts
 * @covers tugdeck/src/deck-store-selectors.ts
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
 * @covers tugdeck/src/components/chrome/tug-pane.tsx
 * @covers tugdeck/src/components/tugways/tug-column-badge.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import { PIXEL_TOL } from "./_harness/tolerances";
import {
  AFTER_LAND_MS,
  GAP,
  PANE_WIDTH,
  RAIL_WIDTH,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  columnsRecord,
  deckShape,
  rects,
  setColumnMode,
  splitFrameCount,
  wait,
} from "./column-split-fixture";

describe.skipIf(!SHOULD_RUN)("at0455 — column split: in flow", () => {
  test(
    "a split column stands in flow, and the other layout verbs still reach its members",
    async () => {
      const app = await launchTugApp({ testName: "at0455-column-split-flow" });
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelector('.tug-pane[data-pane-id="p4"]') !== null`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);
        await setColumnMode(app, 0, "split");

        // ── In flow, a split column takes ONE place in the strip. ──
        //
        // [P11]: panes sharing a slot share its place in either geometry, so a
        // divided column contributes its widest member's width and no more. A
        // strip that summed the members would open a gap the deck has nothing
        // to put in — asserted against slot 1's frames, which stand right of
        // it and would be pushed a whole card further along.
        const fitLefts = await app.evalJS<Record<string, number>>(
          `(function () {
            var out = {};
            ["p1", "p2", "p3", "p4"].forEach(function (id) {
              var el = document.querySelector('.tug-pane[data-pane-id="' + id + '"]');
              if (el !== null) out[id] = el.getBoundingClientRect().left;
            });
            return out;
          })()`,
        );
        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("set-imposition-layout", { layout: "flow" }), null)`,
        );
        await wait(AFTER_LAND_MS);
        const flowRects = await rects(app, ["p1", "p2", "p3", "p4"]);
        expect(
          Math.abs(flowRects.p1.left - flowRects.p2.left),
          "the two members of the split column share one place in the strip",
        ).toBeLessThan(PIXEL_TOL);
        expect(
          Math.abs(flowRects.p3.left - flowRects.p4.left),
          "and so do slot 1's",
        ).toBeLessThan(PIXEL_TOL);
        // One extent plus one gap, not two extents: slot 1 stands exactly one
        // card-width and one gap right of slot 0.
        expect(
          Math.abs(flowRects.p3.left - (flowRects.p1.left + PANE_WIDTH + GAP)),
          "slot 1 follows slot 0 by one extent and one gap, not by two",
        ).toBeLessThan(PIXEL_TOL);
        // Still divided, and still tiling its run.
        expect(await splitFrameCount(app)).toBe(2);
        const [top, bottom] = [flowRects.p1, flowRects.p2].sort(
          (a, b) => a.top - b.top,
        );
        expect(Math.abs(bottom.top - top.bottom - GAP)).toBeLessThan(PIXEL_TOL);
        note(
          `flow strip: slot0 at ${Math.round(flowRects.p1.left)}, slot1 at ${Math.round(flowRects.p3.left)} (fit had ${Math.round(fitLefts.p3)})`,
        );

        // ── The width verb reaches a split member, and the strip re-measures. ──
        //
        // A width preset is card-addressed and knows nothing about columns, so
        // what is under test is that the column re-reads the new width rather
        // than holding the frame at the one it was built with — and that the
        // strip re-measures the SLOT from its widest member when that changes.
        //
        // The fixture's panes are 420 wide, narrower than every named preset,
        // so "slim" widens A rather than narrowing it. That is the useful
        // direction here: it makes A the widest member of slot 0, so a strip
        // that had baked the old extent would leave slot 1 overlapping it.
        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("set-card-width", { cardIds: ["A"], preset: "slim" }), null)`,
        );
        await wait(AFTER_LAND_MS);
        const resized = await rects(app, ["p1", "p2", "p3"]);
        expect(
          resized.p1.width,
          "the split member took the named preset",
        ).toBeGreaterThan(PANE_WIDTH + 1);
        expect(
          Math.abs(resized.p2.width - PANE_WIDTH),
          "its neighbour in the column kept its own width — a column shares a place, not a width",
        ).toBeLessThan(PIXEL_TOL);
        expect(
          Math.abs(resized.p3.left - (resized.p1.left + resized.p1.width + GAP)),
          "the strip re-measured slot 0 from its now-widest member, so slot 1 still clears it",
        ).toBeLessThan(PIXEL_TOL);
        expect(
          resized.p3.left,
          "…which means slot 1 moved right rather than staying put",
        ).toBeGreaterThan(flowRects.p3.left + 1);

        // ── The nudge verb moves a split member's whole column. ──
        //
        // A slot move is per PANE, so nudging one member takes that member to
        // the next slot and leaves the other behind — which is the honest
        // behavior: the gesture named one card. What must hold is that the
        // column it left drops to one member and un-divides.
        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("nudge-slot-selection", { cardIds: ["A"], delta: 1 }), null)`,
        );
        await wait(AFTER_LAND_MS);
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll('.tug-pane[data-pane-id="p2"][data-column-split]').length`,
          ),
          "the member left behind is alone in slot 0 and no longer a split member",
        ).toBe(0);
        const afterNudge = (await columnsRecord(app))["0"];
        expect(
          afterNudge?.mode,
          "the arrangement survives the departure ([L23]) — it is the geometry that stopped dividing",
        ).toBe("split");
        // The order does NOT survive it. A slot move writes the new slot onto
        // the pane and commits the imposition it was handed, so without a
        // sweep at the geometry commit the column goes on naming a member that
        // now stands somewhere else — which invariant 9 refuses, taking the
        // whole deck to the error overlay on the next validate.
        //
        // That invariant is dev-only and this bundle is a production build, so
        // what is asserted here is the RECORD rather than the throw: an
        // app-test structurally cannot see invariant 9 fire. The throw itself
        // is pinned in `layout-tree.test.ts`, which runs the validator
        // directly.
        expect(
          afterNudge?.order ?? [],
          "the column stopped naming the member that left its slot",
        ).not.toContain("p1");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
