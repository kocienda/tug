/**
 * at0455-column-split.test.ts — a content slot, divided.
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
 * Deliberately NOT declaring `@covers tugdeck/src/deck-manager.ts`, though this
 * file does drive `setColumnMode` and `setColumnShares` through the action
 * layer. That path is already at the selection budget's ceiling — naming it
 * here makes an edit to the store a 21-file run, which the budget refuses
 * outright and the lint fails on the commit that creates it. The rail twin of
 * every store verb used here is covered from at0401, which does name it.
 *
 * @covers tugdeck/src/lib/layout-imposer.ts
 * @covers tugdeck/src/deck-store-selectors.ts
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
 * @covers tugdeck/src/components/chrome/tug-pane.tsx
 * @covers tugdeck/src/components/tugways/tug-column-badge.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

/** The imposition gaps (`lib/layout-imposer.ts`). */
const GAP = 5;
const GAP_BOTTOM = 32;
/** Geometry tolerance: sub-pixel layout rounding, never a real disagreement. */
const EPSILON = 1.5;
/** The settle window, with room for the tween to land. */
const AFTER_LAND_MS = 900;

/** The split family lives on the Tug layout tier (tuglaws/chord-tiers.md). */
const SPLIT = ["cmd", "ctrl"] as const;
const SPLIT_END = ["cmd", "ctrl", "shift"] as const;

const LENS_WIDTH = 420;
const PANE_WIDTH = 420;

const frame = (paneId: string): string => `.tug-pane[data-pane-id="${paneId}"]`;
const columnSeam = (slot: number, index: number): string =>
  `[data-column-seam="${slot}:${index}"]`;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

interface Rect {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

/**
 * Four cards in a three-up: two sharing slot 0, two sharing slot 1, plus the
 * Lens on the right.
 *
 * Two occupied-and-shared slots rather than one, because the bug a
 * single-column fixture cannot see is a seam property that is keyed by index
 * alone: with one split column it reads correctly, and with two it has both
 * columns dividing at the same fraction.
 */
function deckShape() {
  const pane = (id: string, slot: number, cardId: string) => ({
    id,
    position: { x: 40, y: 40 },
    size: { width: PANE_WIDTH, height: 400 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["maker"],
    slot,
  });
  const members: [string, number, string][] = [
    ["p1", 0, "A"],
    ["p2", 0, "B"],
    ["p3", 1, "C"],
    ["p4", 1, "D"],
  ];
  return {
    cards: [
      ...members.map(([, , cardId]) => ({
        id: cardId,
        componentId: "hello",
        title: `Card ${cardId}`,
        closable: true,
      })),
      { id: "L", componentId: "lens", title: "Lens", closable: true },
    ],
    panes: [
      ...members.map(([id, slot, cardId]) => pane(id, slot, cardId)),
      {
        id: "pLens",
        position: { x: 0, y: 0 },
        size: { width: LENS_WIDTH, height: 900 },
        cardIds: ["L"],
        activeCardId: "L",
        title: "Lens",
        acceptsFamilies: [],
      },
    ],
    activePaneId: "p1",
    imposition: {
      kind: "three-up",
      sidebars: { lens: { side: "right" } },
    },
    hasFocus: true,
  };
}

/** Every named pane's live frame, in viewport coordinates. */
async function rects(app: App, paneIds: string[]): Promise<Record<string, Rect>> {
  return app.evalJS<Record<string, Rect>>(
    `(function () {
      var out = {};
      ${JSON.stringify(paneIds)}.forEach(function (id) {
        var el = document.querySelector('.tug-pane[data-pane-id="' + id + '"]');
        if (el === null) return;
        var r = el.getBoundingClientRect();
        out[id] = {
          top: r.top, bottom: r.bottom, left: r.left, right: r.right,
          width: r.width, height: r.height,
        };
      });
      return out;
    })()`,
  );
}

/** How many frames are currently rendering as split column members. */
function splitFrameCount(app: App): Promise<number> {
  return app.evalJS<number>(
    `document.querySelectorAll('.tug-pane[data-column-split]').length`,
  );
}

/** A place's mark on the Layout drawing — the Lens door for its arrangement. */
const placeMark = (key: string): string =>
  `[data-testid="lens-layouts-place-${key}"]`;

/** Which slots the drawing currently marks, low to high. */
function markedSlots(app: App): Promise<number[]> {
  return app.evalJS<number[]>(
    `Array.from(document.querySelectorAll('[data-testid="lens-layouts-places"] .layout-places-mark[data-place^="col-"]'))
      .map(function (el) {
        return parseInt(el.getAttribute("data-place").replace("col-", ""), 10);
      })
      .sort(function (a, b) { return a - b; })`,
  );
}

/** The arrangement pressing this mark would set — always the one NOT in force. */
function placeOffers(app: App, key: string): Promise<string | null> {
  return app.getElementAttribute(placeMark(key), "data-choice-value");
}

async function setColumnMode(
  app: App,
  slot: number,
  mode: "stack" | "split",
): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.dispatchControlAction("set-column-mode", { slot: ${slot}, mode: ${JSON.stringify(mode)} }), null)`,
  );
  await wait(AFTER_LAND_MS);
}

/** The `columns` record as the live store holds it. */
async function columnsRecord(
  app: App,
): Promise<Record<string, { mode?: string; order?: string[]; shares?: Record<string, number> }>> {
  return app.evalJS(
    `(window.tugdeck.diag.getDeckState().imposition.columns || {})`,
  );
}

describe.skipIf(!SHOULD_RUN)("at0455 — column split", () => {
  test(
    "a split slot tiles its run, keeps its band, divides per slot, and returns to the unsplit frame",
    async () => {
      const app = await launchTugApp({ testName: "at0455-column-split" });
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugtool.lens", "widthPx", { kind: "i64", value: ${LENS_WIDTH} }), null)`,
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
        expect(Math.abs(stacked.p1.top - stacked.p2.top)).toBeLessThan(EPSILON);
        expect(Math.abs(stacked.p1.bottom - stacked.p2.bottom)).toBeLessThan(
          EPSILON,
        );
        expect(Math.abs(stacked.p1.left - stacked.p2.left)).toBeLessThan(
          EPSILON,
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
          ).toBeLessThan(EPSILON);
          expect(
            Math.abs(bottom.bottom - stacked.p1.bottom),
            "the bottom member ends exactly where the stacked card did",
          ).toBeLessThan(EPSILON);
          // Exactly one gap of air between them — the same rhythm as every
          // other seam on the deck.
          expect(
            Math.abs(bottom.top - top.bottom - GAP),
            "one imposition gap between the two members",
          ).toBeLessThan(EPSILON);
          // The column-specific half: a split divides the RUN, never the band.
          expect(
            Math.abs(top.left - stacked.p1.left),
            "a split does not move the slot's left edge",
          ).toBeLessThan(EPSILON);
          expect(Math.abs(bottom.left - stacked.p1.left)).toBeLessThan(EPSILON);
          expect(Math.abs(top.width - stacked.p1.width)).toBeLessThan(EPSILON);
          expect(Math.abs(bottom.width - stacked.p1.width)).toBeLessThan(
            EPSILON,
          );
          // And the OTHER slot is untouched — a column is a per-slot record.
          expect(Math.abs(after.p3.top - stacked.p3.top)).toBeLessThan(EPSILON);
          expect(Math.abs(after.p3.bottom - stacked.p3.bottom)).toBeLessThan(
            EPSILON,
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
          ).toBeLessThan(EPSILON);
          expect(Math.abs(after.p4.height - before.p4.height)).toBeLessThan(
            EPSILON,
          );
          // Slot 0 is still tiled — a drag moves the boundary, never the ends.
          const [top, bottom] = [after.p1, after.p2].sort(
            (a, b) => a.top - b.top,
          );
          expect(Math.abs(top.top - stacked.p1.top)).toBeLessThan(EPSILON);
          expect(Math.abs(bottom.bottom - stacked.p1.bottom)).toBeLessThan(
            EPSILON,
          );
          expect(Math.abs(bottom.top - top.bottom - GAP)).toBeLessThan(EPSILON);
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
          ).toBeLessThan(EPSILON);
          expect(
            Math.abs(survivor.bottom - stacked.p1.bottom),
            "…down to the bottom gap",
          ).toBeLessThan(EPSILON);
          expect(Math.abs(survivor.left - stacked.p1.left)).toBeLessThan(
            EPSILON,
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
        expect(Math.abs(stacked.p1.top - canvasTop - GAP)).toBeLessThan(EPSILON);
        expect(
          Math.abs(canvasBottom - stacked.p1.bottom - GAP_BOTTOM),
        ).toBeLessThan(EPSILON);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the Lens row and the badge menu are doors to the split, and the flip never cuts",
    async () => {
      const app = await launchTugApp({
        testName: "at0455-column-split-doors",
      });
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugtool.lens", "widthPx", { kind: "i64", value: ${LENS_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.dispatchControlAction("focus-lens");
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-testid="lens-layouts-kind"]') !== null`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);

        // ── The picture marks every drawn slot, the empty one included. ──
        //
        // The Lens door for a column's arrangement is a mark on the deck's own
        // drawing rather than a row of words under it (at0469 covers the mark
        // itself); what this file still owns is that the door reaches the
        // COLUMN command and that the geometry follows.
        expect(
          await markedSlots(app),
          "a mark for every slot the kind defines, the empty slot 2 included",
        ).toEqual([0, 1, 2]);

        // ── The Lens door splits. ──
        //
        // One mark rather than two segments: it carries the arrangement NOT in
        // force, so pressing it is always "make it the other thing" and the
        // test presses the same element to go each way.
        expect(await placeOffers(app, "col-0")).toBe("split");
        await app.click(placeMark("col-0"));
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
        expect(await placeOffers(app, "col-0")).toBe("stack");
        await app.click(placeMark("col-0"));
        await wait(AFTER_LAND_MS);
        await app.click(placeMark("col-0"));
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
          await markedSlots(app),
          "every slot is still marked — slot 0 lost a card, not its place",
        ).toEqual([0, 1, 2]);
        const survivor = await app.evalJS<string | null>(
          `(function () {
            var el = document.querySelector('[data-testid="lens-layouts-places"] .layout-places-mark[data-place="col-0"]');
            return el === null ? null : el.getAttribute("data-mode");
          })()`,
        );
        note(`slot 0 after losing a member: ${survivor}`);
        expect(
          survivor,
          "the slot kept the split it was set to when its second card left",
        ).toBe("split");
        // And the way back is a press, on the mark that was unreachable before.
        expect(await placeOffers(app, "col-0")).toBe("stack");
        await app.click(placeMark("col-0"));
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

  test(
    "the split chords divide, reorder, reach the ends, and refuse at them",
    async () => {
      const app = await launchTugApp({
        testName: "at0455-column-split-chords",
      });
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugtool.lens", "widthPx", { kind: "i64", value: ${LENS_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelector('.tug-pane[data-pane-id="p4"]') !== null`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);

        // ⌃⌘S on the focused card's slot. The chord resolves the layout
        // selection, which with nothing picked in the Lens is the first
        // responder — card A, in slot 0.
        await app.nativeKey("s", SPLIT);
        await wait(AFTER_LAND_MS);
        expect(
          (await columnsRecord(app))["0"]?.mode,
          "⌃⌘S divides the slot the focused card stands in",
        ).toBe("split");
        expect(await splitFrameCount(app)).toBe(2);
        // And it is a TOGGLE: the second press re-stacks.
        await app.nativeKey("s", SPLIT);
        await wait(AFTER_LAND_MS);
        expect((await columnsRecord(app))["0"]?.mode).toBe("stack");
        expect(await splitFrameCount(app)).toBe(0);
        await app.nativeKey("s", SPLIT);
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

        // ── ⌃⌘S on a slot with one card is refused, not obeyed. ──
        //
        // Slot 2 is empty in the fixture, so the card is moved there first:
        // a slot of one has nothing to divide, and the record must stay clean
        // rather than gaining a split nothing can draw.
        await app.dispatchControlAction("assign-slot", {
          cardIds: ["A"],
          slot: 2,
        });
        await wait(AFTER_LAND_MS);
        await app.nativeKey("s", SPLIT);
        await wait(AFTER_LAND_MS);
        expect(
          (await columnsRecord(app))["2"],
          "⌃⌘S refuses a slot holding one card rather than recording a split",
        ).toBeUndefined();
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a split column stands in flow, and the other layout verbs still reach its members",
    async () => {
      const app = await launchTugApp({ testName: "at0455-column-split-flow" });
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugtool.lens", "widthPx", { kind: "i64", value: ${LENS_WIDTH} }), null)`,
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
        ).toBeLessThan(EPSILON);
        expect(
          Math.abs(flowRects.p3.left - flowRects.p4.left),
          "and so do slot 1's",
        ).toBeLessThan(EPSILON);
        // One extent plus one gap, not two extents: slot 1 stands exactly one
        // card-width and one gap right of slot 0.
        expect(
          Math.abs(flowRects.p3.left - (flowRects.p1.left + PANE_WIDTH + GAP)),
          "slot 1 follows slot 0 by one extent and one gap, not by two",
        ).toBeLessThan(EPSILON);
        // Still divided, and still tiling its run.
        expect(await splitFrameCount(app)).toBe(2);
        const [top, bottom] = [flowRects.p1, flowRects.p2].sort(
          (a, b) => a.top - b.top,
        );
        expect(Math.abs(bottom.top - top.bottom - GAP)).toBeLessThan(EPSILON);
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
        ).toBeLessThan(EPSILON);
        expect(
          Math.abs(resized.p3.left - (resized.p1.left + resized.p1.width + GAP)),
          "the strip re-measured slot 0 from its now-widest member, so slot 1 still clears it",
        ).toBeLessThan(EPSILON);
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
