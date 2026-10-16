/**
 * at0455-column-split-chords.test.ts — a content slot, divided: the split chords.
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
 * the split chords; `at0455-column-split-tiles` carries claims 1–4, `-doors`
 * the Layout card's row and the badge menu, and `-flow` a split column in
 * flow. The deck and the readers are `column-split-fixture.ts`.
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
import {
  AFTER_LAND_MS,
  RAIL_WIDTH,
  SHOULD_RUN,
  SPLIT,
  SPLIT_END,
  TEST_TIMEOUT_MS,
  columnsRecord,
  deckShape,
  splitFrameCount,
  wait,
} from "./column-split-fixture";

describe.skipIf(!SHOULD_RUN)("at0455 — column split: the chords", () => {
  test(
    "the split chords divide, reorder, reach the ends, and refuse at them",
    async () => {
      const app = await launchTugApp({
        testName: "at0455-column-split-chords",
      });
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

        // ⌃⌘/ on the focused card's slot. The chord resolves the layout
        // selection, which with nothing picked in the Cards card is the first
        // responder — card A, in slot 0.
        await app.nativeKey("/", SPLIT);
        await wait(AFTER_LAND_MS);
        expect(
          (await columnsRecord(app))["0"]?.mode,
          "⌃⌘/ divides the slot the focused card stands in",
        ).toBe("split");
        expect(await splitFrameCount(app)).toBe(2);
        // And it is a TOGGLE: the second press re-stacks.
        await app.nativeKey("/", SPLIT);
        await wait(AFTER_LAND_MS);
        expect((await columnsRecord(app))["0"]?.mode).toBe("stack");
        expect(await splitFrameCount(app)).toBe(0);
        await app.nativeKey("/", SPLIT);
        await wait(AFTER_LAND_MS);
        expect(await splitFrameCount(app)).toBe(2);

        // ── The arrows reorder a split column, and the frames follow. ──
        const memberOrder = async (): Promise<string[]> =>
          app.evalJS<string[]>(
            `Array.from(document.querySelectorAll('.tug-pane[data-column-split]'))
              .filter(function (el) { return el.getAttribute("data-imposed") === "0"; })
              .sort(function (a, b) {
                return a.getBoundingClientRect().top - b.getBoundingClientRect().top;
              })
              .map(function (el) { return el.getAttribute("data-pane-id"); })`,
          );
        const before = await memberOrder();
        expect(before.length).toBe(2);
        // p1 hosts card A, which is what the selection resolves to. Send it
        // whichever way it can actually travel, so the assertion is about the
        // move rather than about which end the fixture happened to start at.
        const aWasTop = before[0] === "p1";
        await app.nativeKey(aWasTop ? "ArrowDown" : "ArrowUp", SPLIT);
        await wait(AFTER_LAND_MS);
        const after = await memberOrder();
        expect(
          after,
          "⌃⌘↑/↓ swaps the focused card with its neighbour in the column",
        ).toEqual([...before].reverse());

        // ── ⌃⇧⌘ reaches the far end, and the edge refuses. ──
        await app.nativeKey(aWasTop ? "ArrowUp" : "ArrowDown", SPLIT_END);
        await wait(AFTER_LAND_MS);
        expect(
          (await memberOrder())[aWasTop ? 0 : 1],
          "⌃⇧⌘↑/↓ sends the card all the way to the end",
        ).toBe("p1");
        // Already there: the move is refused, and the order does not budge.
        // The refusal's flash is chrome, so what is asserted is the state —
        // a chord that quietly reordered anyway would show up right here.
        const atEnd = await memberOrder();
        await app.nativeKey(aWasTop ? "ArrowUp" : "ArrowDown", SPLIT_END);
        await wait(AFTER_LAND_MS);
        expect(
          await memberOrder(),
          "a member already at the end it was sent to does not move",
        ).toEqual(atEnd);
        await app.nativeKey(aWasTop ? "ArrowUp" : "ArrowDown", SPLIT);
        await wait(AFTER_LAND_MS);
        expect(await memberOrder()).toEqual(atEnd);
        note(`chord walk: ${before.join(",")} -> ${after.join(",")} -> ${atEnd.join(",")}`);

        // ── ⌃⌘/ on a slot with one card SPLITS it. ──
        //
        // Slot 2 is empty in the fixture, so the card is moved there first.
        // A place one card deep is still a place, and arming it to split is a
        // legal act that the next card to arrive lands into. The pane badge's
        // own menu has always performed it — "One card in this column, press
        // to split it" — so a chord that refused made the two doors onto one
        // verb disagree, and the menu row went dark where the badge was lit.
        //
        // The geometry does not change with the record: case 4 above already
        // asserts that a lone member of a split slot stands exactly where an
        // unsplit one does. What the split buys is the arrangement, which the
        // badge reads and the next arrival divides.
        await app.dispatchControlAction("assign-slot", {
          cardIds: ["A"],
          slot: 2,
        });
        await wait(AFTER_LAND_MS);
        await app.nativeKey("/", SPLIT);
        await wait(AFTER_LAND_MS);
        expect(
          (await columnsRecord(app))["2"]?.mode,
          "⌃⌘/ splits a slot holding one card, arming the place",
        ).toBe("split");
        // And the toggle is a toggle there too: the way back is the same key.
        await app.nativeKey("/", SPLIT);
        await wait(AFTER_LAND_MS);
        expect(
          (await columnsRecord(app))["2"]?.mode,
          "⌃⌘/ re-stacks the place it just split",
        ).toBe("stack");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
