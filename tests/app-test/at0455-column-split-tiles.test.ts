/**
 * at0455-column-split-tiles.test.ts — a content slot, divided: the tiling.
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
 * Cut from `at0455-column-split` to fit the 20 s budget. This file carries
 * claims 1–4 in one walk; `at0455-column-split-doors` carries the Layout
 * card's row and the badge menu, `-chords` the split chords, and `-flow` a
 * split column in flow. The deck and the readers are `column-split-fixture.ts`.
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
  GAP_BOTTOM,
  RAIL_WIDTH,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  columnSeam,
  columnsRecord,
  deckShape,
  frame,
  rects,
  setColumnMode,
  splitFrameCount,
  wait,
} from "./column-split-fixture";

describe.skipIf(!SHOULD_RUN)("at0455 — column split: the tiling", () => {
  test(
    "a split slot tiles its run, keeps its band, divides per slot, and returns to the unsplit frame",
    async () => {
      const app = await launchTugApp({ testName: "at0455-column-split" });
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

        // ── 0. The fixture starts stacked. ──
        const stacked = await rects(app, ["p1", "p2", "p3", "p4"]);
        expect(
          await splitFrameCount(app),
          "nothing is split before the user asks for it",
        ).toBe(0);
        // Two panes sharing a slot draw the SAME rect: that is what a stack is,
        // and it is the frame case 4 has to return to.
        expect(Math.abs(stacked.p1.top - stacked.p2.top)).toBeLessThan(PIXEL_TOL);
        expect(Math.abs(stacked.p1.bottom - stacked.p2.bottom)).toBeLessThan(
          PIXEL_TOL,
        );
        expect(Math.abs(stacked.p1.left - stacked.p2.left)).toBeLessThan(
          PIXEL_TOL,
        );

        // ── 1. A split tiles the run and leaves the band alone. ──
        await setColumnMode(app, 0, "split");
        expect(
          await splitFrameCount(app),
          "exactly the split slot's two members carry the split bit",
        ).toBe(2);

        {
          const after = await rects(app, ["p1", "p2", "p3", "p4"]);
          const [top, bottom] = [after.p1, after.p2].sort(
            (a, b) => a.top - b.top,
          );
          // The run's own endpoints, not fractions of it: the top member and a
          // stacked card share a top edge to the pixel.
          expect(
            Math.abs(top.top - stacked.p1.top),
            "the top member starts exactly where the stacked card did",
          ).toBeLessThan(PIXEL_TOL);
          expect(
            Math.abs(bottom.bottom - stacked.p1.bottom),
            "the bottom member ends exactly where the stacked card did",
          ).toBeLessThan(PIXEL_TOL);
          // Exactly one gap of air between them — the same rhythm as every
          // other seam on the deck.
          expect(
            Math.abs(bottom.top - top.bottom - GAP),
            "one imposition gap between the two members",
          ).toBeLessThan(PIXEL_TOL);
          // The column-specific half: a split divides the RUN, never the band.
          expect(
            Math.abs(top.left - stacked.p1.left),
            "a split does not move the slot's left edge",
          ).toBeLessThan(PIXEL_TOL);
          expect(Math.abs(bottom.left - stacked.p1.left)).toBeLessThan(PIXEL_TOL);
          expect(Math.abs(top.width - stacked.p1.width)).toBeLessThan(PIXEL_TOL);
          expect(Math.abs(bottom.width - stacked.p1.width)).toBeLessThan(
            PIXEL_TOL,
          );
          // And the OTHER slot is untouched — a column is a per-slot record.
          expect(Math.abs(after.p3.top - stacked.p3.top)).toBeLessThan(PIXEL_TOL);
          expect(Math.abs(after.p3.bottom - stacked.p3.bottom)).toBeLessThan(
            PIXEL_TOL,
          );
          note(
            `slot 0 split: ${Math.round(top.height)}px over ${Math.round(bottom.height)}px, left unmoved at ${Math.round(top.left)}`,
          );
        }

        // ── 2. Two split slots divide independently. ──
        await setColumnMode(app, 1, "split");
        expect(await splitFrameCount(app)).toBe(4);

        {
          const before = await rects(app, ["p1", "p2", "p3", "p4"]);
          const seam = await app.getElementBounds(columnSeam(0, 0));
          // Drag slot 0's seam a long way up — past the top member's floor, so
          // the clamp decides where it lands rather than the hand.
          await app.nativeDragElement(columnSeam(0, 0), {
            x: Math.round(seam.x + seam.width / 2),
            y: 20,
          });
          await app.waitForCondition<boolean>(
            `(function () {
              var r = document.querySelector(${JSON.stringify(frame("p1"))})
                .getBoundingClientRect();
              return Math.abs(r.height - ${before.p1.height}) > 2;
            })()`,
            { timeoutMs: 5_000 },
          );
          await wait(AFTER_LAND_MS);

          const after = await rects(app, ["p1", "p2", "p3", "p4"]);
          // Slot 1 did not move. This is the assertion a deck-wide seam
          // property fails and a slot-keyed one passes.
          expect(
            Math.abs(after.p3.height - before.p3.height),
            "dragging slot 0's seam leaves slot 1's division exactly as it was",
          ).toBeLessThan(PIXEL_TOL);
          expect(Math.abs(after.p4.height - before.p4.height)).toBeLessThan(
            PIXEL_TOL,
          );
          // Slot 0 is still tiled — a drag moves the boundary, never the ends.
          const [top, bottom] = [after.p1, after.p2].sort(
            (a, b) => a.top - b.top,
          );
          expect(Math.abs(top.top - stacked.p1.top)).toBeLessThan(PIXEL_TOL);
          expect(Math.abs(bottom.bottom - stacked.p1.bottom)).toBeLessThan(
            PIXEL_TOL,
          );
          expect(Math.abs(bottom.top - top.bottom - GAP)).toBeLessThan(PIXEL_TOL);
          // ── 3. The clamp held, and the weights landed keyed by PANE id. ──
          //
          // The hand went to y=20, which is above the deck's own top gap — an
          // unclamped seam would have left the top member a few pixels tall.
          // So the assertion is that the seam REFUSED to follow: the shortest
          // member is still far taller than where the pointer was released.
          const seamStop = top.bottom;
          expect(
            seamStop,
            "the seam stopped well short of where the hand left it",
          ).toBeGreaterThan(60);
          expect(
            Math.min(top.height, bottom.height),
            "neither member was crushed below a usable height",
          ).toBeGreaterThan(50);
          const record = await columnsRecord(app);
          const shares = record["0"]?.shares ?? {};
          expect(
            Object.keys(shares).sort(),
            "the weights are keyed by pane id, and only by panes standing in slot 0",
          ).toEqual(["p1", "p2"]);
          expect(record["1"]?.shares).toBeUndefined();
          note(
            `after the drag: ${Math.round(top.height)} / ${Math.round(bottom.height)}, weights ${JSON.stringify(shares)}`,
          );
        }

        // ── 4. A column of one is the unsplit frame, byte for byte. ──
        // Closed by the door the user has: raise card B's pane, then close the
        // first card responder. A membership change, not a re-seed — the point
        // is that the arrangement survives it and the survivor's geometry does
        // not.
        await app.click(`${frame("p2")} [data-testid="tug-pane-title-bar"]`);
        await wait(300);
        await app.dispatchControlAction("close");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(frame("p2"))}) === null`,
          { timeoutMs: 5_000 },
        );
        await wait(AFTER_LAND_MS);
        {
          const survivor = (await rects(app, ["p1"])).p1;
          expect(
            await app.evalJS<number>(
              `document.querySelectorAll('.tug-pane[data-pane-id="p1"][data-column-split]').length`,
            ),
            "the survivor of a split column is no longer a split member",
          ).toBe(0);
          // The slot is still SPLIT in the record — the arrangement outlives
          // the member ([L23]) — so this is the geometry answering, not the
          // mode. A survivor still pinned to seam 0 is what a missed sweep
          // looks like on screen, and it would fail right here.
          expect(
            Math.abs(survivor.top - stacked.p1.top),
            "the survivor takes the whole run again, from the top gap",
          ).toBeLessThan(PIXEL_TOL);
          expect(
            Math.abs(survivor.bottom - stacked.p1.bottom),
            "…down to the bottom gap",
          ).toBeLessThan(PIXEL_TOL);
          expect(Math.abs(survivor.left - stacked.p1.left)).toBeLessThan(
            PIXEL_TOL,
          );
          // Slot 1's split is untouched by a close in slot 0.
          expect(await splitFrameCount(app)).toBe(2);
          note(
            `survivor run ${Math.round(survivor.top)}..${Math.round(survivor.bottom)} vs unsplit ${Math.round(stacked.p1.top)}..${Math.round(stacked.p1.bottom)}`,
          );
        }

        // The gaps are what the module says they are — asserted once, so a
        // retune of either constant fails here rather than silently rewriting
        // every tolerance above.
        const canvasTop = await app.evalJS<number>(
          `document.querySelector("[data-deck-canvas-background]").getBoundingClientRect().top`,
        );
        const canvasBottom = await app.evalJS<number>(
          `document.querySelector("[data-deck-canvas-background]").getBoundingClientRect().bottom`,
        );
        expect(Math.abs(stacked.p1.top - canvasTop - GAP)).toBeLessThan(PIXEL_TOL);
        expect(
          Math.abs(canvasBottom - stacked.p1.bottom - GAP_BOTTOM),
        ).toBeLessThan(PIXEL_TOL);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
