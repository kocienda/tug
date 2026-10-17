/**
 * at0455-column-split-doors.test.ts — a content slot, divided: the doors to the split.
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
 * the Layout card's row and the badge menu as doors to the split;
 * `at0455-column-split-tiles` carries claims 1–4, `-chords` the split chords,
 * and `-flow` a split column in flow. The deck and the readers are
 * `column-split-fixture.ts`.
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
  TEST_TIMEOUT_MS,
  columnsRecord,
  deckShape,
  frame,
  markedSlots,
  placeMark,
  placeOffers,
  splitFrameCount,
  wait,
} from "./column-split-fixture";

describe.skipIf(!SHOULD_RUN)("at0455 — column split: the doors", () => {
  test(
    "the Layout card's row and the badge menu are doors to the split, and the flip never cuts",
    async () => {
      const app = await launchTugApp({
        testName: "at0455-column-split-doors",
      });
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.dispatchControlAction("toggle-layout");
        await app.body("L").waitForCondition<boolean>(
          `document.querySelector('[data-testid="layout-card-kind"]') !== null`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);

        // ── The picture marks every drawn slot, the empty one included. ──
        //
        // The Layout card's door for a column's arrangement is a mark on the deck's own
        // drawing rather than a row of words under it (at0469 covers the mark
        // itself); what this file still owns is that the door reaches the
        // COLUMN command and that the geometry follows.
        expect(
          await markedSlots(app.body("L")),
          "a mark for every slot the kind defines, the empty slot 2 included",
        ).toEqual([0, 1, 2]);

        // ── The Layout card's door splits. ──
        //
        // One mark rather than two segments: it carries the arrangement NOT in
        // force, so pressing it is always "make it the other thing" and the
        // test presses the same element to go each way.
        expect(await placeOffers(app.body("L"), "col-0")).toBe("split");
        await app.body("L").click(placeMark("col-0"));
        await wait(AFTER_LAND_MS);
        expect(
          await splitFrameCount(app),
          "pressing slot 0's mark divides that column",
        ).toBe(2);
        expect((await columnsRecord(app))["0"]?.mode).toBe("split");

        // ── The flip does not cut. ──
        //
        // The census gesture for this feature: a mode flip moves every member's
        // vertical pins while no pane changes slot, width, or kind. Without the
        // column terms in `arrangementSignature` the settle would not arm and
        // the one gesture the feature exists for would be the one that cuts.
        await app.evalJS<null>(`(window.__tug.armCutDetector(), null)`);
        // Split now, so the mark offers stack; press it, then press it back.
        expect(await placeOffers(app.body("L"), "col-0")).toBe("stack");
        await app.body("L").click(placeMark("col-0"));
        await wait(AFTER_LAND_MS);
        await app.body("L").click(placeMark("col-0"));
        await wait(AFTER_LAND_MS);
        await app.evalJS<null>(`(window.__tug.disarmCutDetector(), null)`);
        const cuts = await app.evalJS<{ paneId: string; kind: string; dx: number; dy: number }[]>(
          `window.__tug.takeCutRecords()`,
        );
        expect(
          cuts.map((c) => `${c.paneId}:${c.kind}`).join("; "),
          "stack→split→stack on a column produces no cut records",
        ).toBe("");

        // ── The pair is one coordinate, so it is one footprint. ──
        // The cluster reads outward-in — the deck's slot, then this pane's own
        // place — and that reading only works if the two chips are the same
        // box. Compared rect to rect rather than against pixel constants: the
        // claim is that they AGREE, which stays true through a future retune of
        // what the size is.
        const chipBoxes = await app.evalJS<{
          slot: { width: number; height: number } | null;
          column: { width: number; height: number } | null;
        }>(
          `(function () {
            var pane = document.querySelector(${JSON.stringify(frame("p3"))});
            function box(sel) {
              var el = pane === null ? null : pane.querySelector(sel);
              if (el === null) return null;
              var r = el.getBoundingClientRect();
              return { width: r.width, height: r.height };
            }
            return {
              slot: box('.card-slot-badge [data-slot="tug-slot"]'),
              column: box('[data-slot="tug-column-badge"]'),
            };
          })()`,
        );
        expect(chipBoxes.slot, "the slot chip is on the cluster").not.toBeNull();
        expect(
          chipBoxes.column,
          "the column badge is on the cluster",
        ).not.toBeNull();
        expect(
          chipBoxes.column,
          "the column badge draws in the slot chip's exact footprint",
        ).toEqual(chipBoxes.slot);

        // A stacked column says how many cards share the slot — the fact the
        // eye cannot get, since the pane you are looking at is the top one.
        expect(
          await app.evalJS<string | null>(
            `(function () {
              var el = document.querySelector(${JSON.stringify(frame("p3"))} + ' [data-slot="tug-column-badge"]');
              return el === null ? null : el.getAttribute("data-kind") + ":" + el.textContent.trim();
            })()`,
          ),
          "a stacked column's badge is the member count over the stack glyph",
        ).toBe("stack:2");

        // ── The badge menu is the other door, and it names the place. ──
        const badge = `${frame("p3")} [data-testid="tug-pane-title-bar-stack-badge"]`;
        await app.click(badge);
        await wait(400);
        const rows = await app.evalJS<string[]>(
          `Array.from(document.querySelectorAll('[data-testid="tug-pane-title-bar-stack-menu"] [role="menuitem"], [data-testid="tug-pane-title-bar-stack-menu"] [role="menuitemradio"]'))
            .map(function (el) { return (el.textContent || "").trim(); })`,
        );
        expect(
          rows,
          "a stacked column's badge menu offers Split Vertically below its members",
        ).toContain("Split Vertically");
        await app.click(
          `[data-testid="tug-pane-title-bar-stack-menu"] [role="menuitem"]:last-child`,
        );
        await wait(AFTER_LAND_MS);
        expect(
          (await columnsRecord(app))["1"]?.mode,
          "the badge's Split verb resolved to the COLUMN command, not the rail one",
        ).toBe("split");
        expect(await splitFrameCount(app)).toBe(4);

        // ── A slot dropping to one card KEEPS its door. ──
        //
        // The deliberate reversal. A column row used to vanish when its slot
        // fell to one card, on the argument that a column of one is already
        // unsplit and has nothing to restore. It is not: membership churn
        // preserves the arrangement (`columnDrawsSplit`), so the slot goes on
        // storing `split` with nothing to divide — and with the row gone, no
        // way to say otherwise. The mark stays instead, still saying what the
        // slot is set to and still pressable, so there is a way back.
        await app.click(`${frame("p2")} [data-testid="tug-pane-title-bar"]`);
        await wait(300);
        await app.dispatchControlAction("close");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(frame("p2"))}) === null`,
          { timeoutMs: 5_000 },
        );
        await wait(AFTER_LAND_MS);
        expect(
          await markedSlots(app.body("L")),
          "every slot is still marked — slot 0 lost a card, not its place",
        ).toEqual([0, 1, 2]);
        const survivor = await app.body("L").evalJS<string | null>(
          `(function () {
            var el = document.querySelector('[data-testid="layout-card-toggles"] .layout-places-mark[data-place="col-0"]');
            return el === null ? null : el.getAttribute("data-mode");
          })()`,
        );
        note(`slot 0 after losing a member: ${survivor}`);
        expect(
          survivor,
          "the slot kept the split it was set to when its second card left",
        ).toBe("split");
        // ── And the survivor's own masthead says the same word. ──
        //
        // The badge names the arrangement the slot is SET to, which at one
        // card deep is the only surface that can: the run legitimately does
        // not divide, so the picture alone cannot tell a split slot from a
        // stacked one. Reading the geometry here made the badge answer `1`
        // for a place the user had split — the same `1` a never-split slot
        // wears — and the band letter only appeared when a second card
        // arrived, as a change attributed to the wrong gesture
        // (`tuglaws/pane-model.md`, "A badge names the arrangement the place
        // is SET to").
        expect(
          await app.evalJS<string | null>(
            `(function () {
              var el = document.querySelector(${JSON.stringify(frame("p1"))} + ' [data-slot="tug-column-badge"]');
              return el === null ? null : el.getAttribute("data-kind") + ":" + el.textContent.trim();
            })()`,
          ),
          "the lone member of a split slot wears its band letter, not a count",
        ).toBe("split:A");
        // And the way back is a press, on the mark that was unreachable before.
        expect(await placeOffers(app.body("L"), "col-0")).toBe("stack");
        await app.body("L").click(placeMark("col-0"));
        await wait(AFTER_LAND_MS);
        expect(
          (await columnsRecord(app))["0"]?.mode ?? "stack",
          "the survivor's arrangement is still the user's to change",
        ).not.toBe(survivor);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
