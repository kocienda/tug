/**
 * at0456-column-overflow.test.ts — a column with no room left stops dividing.
 *
 * Two cards in a slot divide its run at a seam, and at0455 pins that. This file
 * is about what happens when the run runs out: three cards declaring a 400px
 * floor cannot all stand in the ~1040px run this canvas gives a column, so
 * division stops being possible and the column takes a different geometry
 * entirely ([P01], [P08]). Every member takes the height IT asked for —
 * `max(floor, natural · weight)` — and they stack down a virtual strip that
 * slides up behind the run on a per-slot offset. The strip is longer than the
 * run, so the card the run's bottom edge cuts IS the affordance, the vertical
 * twin of flow's card half-hidden at the band edge.
 *
 * The floors are why the fixture's cards are `fixture-tall-floor` rather than
 * the Hello cards it used to carry: a floor of 150 lets three members share
 * any canvas this harness opens, and the standing is decided by the floors
 * rather than by the count.
 *
 * The fixture crosses the boundary in both directions rather than starting past
 * it, because the interesting claims are all about the crossing. A column of
 * two is divided at a seam the user drags to a ratio they chose; a third member
 * arrives and the division is abandoned; the third leaves and the ratio the
 * user chose is governing again, unrewritten.
 *
 *   1. **The strip is built from the members.** Each frame stands at the height
 *      the allocator gives it from its own floor, natural and stored weight,
 *      stacked one imposition gap apart from the run's own top — and the last
 *      running PAST the run's bottom edge rather than being squeezed above it.
 *      That overhang is the affordance, and the coordinates the frames pin to
 *      are published on the slot's own strip properties.
 *   2. **The weights the user dragged survive, and are READ.** They were kept
 *      but ignored while an overflowing member's height was a constant; now a
 *      member the hand made bigger is bigger in the strip too, which is what
 *      makes the crossing lossless in both directions.
 *   3. **Activating a below-the-run member slides the column, minimally.** The
 *      bottom member's bottom edge lands flush with the run's, which is the
 *      LEAST slide that shows it — not the top of the strip and not the whole
 *      travel. A member already fully in the run slides nothing at all, which
 *      is the property the reveal rule rests on: an activation that reveals
 *      nothing must commit no geometry, or every click would arm a settle.
 *   4. **Dropping back to two restores the division the user set**, at the same
 *      ratio it had before the third member arrived.
 *
 * Case 3 is the one a pure unit test cannot reach: `DeckManager` reads the run
 * off a live container and is not constructible without one, so the reveal's
 * behaviour is asserted here for the same reason flow's is asserted in at0454
 * rather than in a unit file.
 *
 * Deliberately NOT declaring `@covers tugdeck/src/deck-manager.ts`, for the
 * reason at0455 states: that path is already at the selection budget's ceiling,
 * and naming it here would make an edit to the store a run the budget refuses.
 *
 * @covers tugdeck/src/lib/layout-imposer.ts
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

/** The imposition gaps (`lib/layout-imposer.ts`). */
const GAP = 5;
/**
 * The bottom gap, which is the profile's rather than a constant. A maker's
 * canvas reserves `IMPOSITION_GAP_BOTTOM_MAKER_PX` at the foot for the host's
 * dev-info stamps; a release build draws none and keeps the ordinary gap
 * there. The app-test harness always reports maker mode OFF
 * (`AppDelegate.makerModeEnabled`), so the geometry under test is the release
 * one.
 */
const GAP_BOTTOM = GAP;
/** The floor `fixture-tall-floor` declares. It declares no appetite above it,
 *  so its natural is endless ([P02], Spec S05). */
const FLOOR = 400;
/** Geometry tolerance. A shade wider than at0455's, because the offset is
 *  published rounded to the pixel and every member's top carries that
 *  rounding. */
const EPSILON = 2;
/** The settle window, with room for the tween to land. */
const AFTER_LAND_MS = 900;

/** ⌥⇧⌘[ / ⌥⇧⌘] — the nudge modifiers (at0452 pins that they arrive). */
const NUDGE = ["cmd", "alt", "shift"] as const;

const RAIL_WIDTH = 420;
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
  width: number;
  height: number;
}

/**
 * Two cards sharing slot 0 of a three-up and one standing alone in slot 1, plus
 * the Layout card on the right.
 *
 * Slot 0 starts at two so the division can be dragged to a ratio the user
 * chose — two 400px floors and a gap fit the run with room to drag — and
 * slot 1's card is the third member, one nudge away from putting them past it.
 */
function deckShape() {
  const pane = (id: string, cardId: string, slot: number) => ({
    id,
    position: { x: 40, y: 40 },
    size: { width: PANE_WIDTH, height: 400 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["maker"],
    slot,
  });
  const members: [string, string, number][] = [
    ["p1", "A", 0],
    ["p2", "B", 0],
    ["p3", "C", 1],
  ];
  return {
    cards: [
      ...members.map(([, cardId]) => ({
        id: cardId,
        componentId: "fixture-tall-floor",
        title: `Card ${cardId}`,
        closable: true,
      })),
      { id: "L", componentId: "layout", title: "Layout", closable: true },
    ],
    panes: [
      ...members.map(([id, cardId, slot]) => pane(id, cardId, slot)),
      {
        id: "pRail",
        position: { x: 0, y: 0 },
        size: { width: RAIL_WIDTH, height: 900 },
        cardIds: ["L"],
        activeCardId: "L",
        title: "Layout",
        acceptsFamilies: [],
      },
    ],
    activePaneId: "p1",
    imposition: {
      kind: "three-up",
      sidebars: { layout: { side: "right" } },
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
          top: r.top, bottom: r.bottom, left: r.left,
          width: r.width, height: r.height,
        };
      });
      return out;
    })()`,
  );
}

/** The run the column's members stand in, in viewport coordinates: the canvas
 *  less the gap it keeps at the top and the deeper one at the bottom. Read from
 *  the canvas the deck actually painted, the way at0454 reads the band. */
async function run(
  app: App,
): Promise<{ top: number; bottom: number; height: number }> {
  return app.evalJS<{ top: number; bottom: number; height: number }>(
    `(function () {
      var box = document
        .querySelector("[data-deck-canvas-background]")
        .getBoundingClientRect();
      return {
        top: box.top + ${GAP},
        bottom: box.bottom - ${GAP_BOTTOM},
        height: box.height - ${GAP} - ${GAP_BOTTOM},
      };
    })()`,
  );
}

/** Slot 0's stored offset in px, as the live store holds it. */
async function columnOffset(app: App): Promise<number> {
  return app.evalJS<number>(
    `((window.tugdeck.diag.getDeckState().columnOffsets || {})[0] || 0)`,
  );
}

/** Slot 0's published offset property, in px — what the frames' `calc()`s
 *  actually read. Asserted beside the stored number so a commit that never
 *  reached the DOM cannot pass. */
async function offsetProperty(app: App): Promise<string> {
  return app.evalJS<string>(
    `getComputedStyle(
       document.querySelector("[data-deck-canvas-background]")
     ).getPropertyValue("--tug-slot-0-column-offset").trim()`,
  );
}

/** How many seam handles slot 0 is currently offering. */
async function seamCount(app: App): Promise<number> {
  return app.evalJS<number>(
    `document.querySelectorAll('[data-column-seam^="0:"]').length`,
  );
}

/** Slot 0's published strip coordinates, in px — the `n + 1` numbers the
 *  overflowing frames' `calc()`s actually pin to. Read off the canvas, so a
 *  coordinate the allocator resolved but never published cannot pass. */
async function stripProperties(app: App, count: number): Promise<number[]> {
  return app.evalJS<number[]>(
    `(function () {
      var style = getComputedStyle(
        document.querySelector("[data-deck-canvas-background]"),
      );
      var out = [];
      for (var i = 0; i <= ${count}; i += 1) {
        out.push(
          parseFloat(style.getPropertyValue("--tug-slot-0-strip-" + i).trim()),
        );
      }
      return out;
    })()`,
  );
}

/** The `columns` record as the live store holds it. */
async function columnsRecord(
  app: App,
): Promise<
  Record<string, { mode?: string; order?: string[]; shares?: Record<string, number> }>
> {
  return app.evalJS(
    `(window.tugdeck.diag.getDeckState().imposition.columns || {})`,
  );
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

describe.skipIf(!SHOULD_RUN)("at0456 — column overflow", () => {
  test(
    "a third member trades the division for a strip built from the members, and leaving restores it",
    async () => {
      const app = await launchTugApp({ testName: "at0456-column-overflow" });
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelector('.tug-pane[data-pane-id="p3"]') !== null`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);

        // ── 0. Two members, divided at a ratio the user drags. ──
        await setColumnMode(app, 0, "split");
        expect(await seamCount(app)).toBe(1);
        {
          const before = await rects(app, ["p1", "p2"]);
          const seam = await app.getElementBounds(columnSeam(0, 0));
          await app.nativeDragElement(columnSeam(0, 0), {
            x: Math.round(seam.x + seam.width / 2),
            y: Math.round(before.p1.top + before.p1.height * 0.5),
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
        }
        const dragged = await rects(app, ["p1", "p2"]);
        const draggedShares = (await columnsRecord(app))["0"]?.shares ?? {};
        expect(
          Object.keys(draggedShares).sort(),
          "the weights land keyed by pane id",
        ).toEqual(["p1", "p2"]);
        const draggedRatio = dragged.p1.height / dragged.p2.height;
        note(
          `divided at two: ${Math.round(dragged.p1.height)} / ${Math.round(dragged.p2.height)}, weights ${JSON.stringify(draggedShares)}`,
        );
        expect(
          Math.abs(draggedRatio - 1),
          "the drag left a division that is visibly not the equal one",
        ).toBeGreaterThan(0.15);

        // ── 1. A third member arrives, and the floors rule answers in pixels. ──
        await app.evalJS<null>(
          `(window.__tug.setLayoutSelection(["C"]), null)`,
        );
        // ⌥⇧⌘[ — the nudge chord, as at0452 drives it. A dispatch straight at
        // the action would have to guess which responder owns the verb; the
        // chord is the door the user has.
        await app.nativeKey("[", NUDGE);
        await wait(AFTER_LAND_MS);
        expect(
          await app.evalJS<number>(
            `window.tugdeck.diag.getDeckState().panes.filter(function (p) { return p.slot === 0; }).length`,
          ),
          "the nudge moved C into slot 0",
        ).toBe(3);

        // The nudge raised C, and raising the third member of an overflowing
        // column reveals it — so the strip is already slid. Bring it home by
        // raising the first member, which is the same rule read the other way,
        // and measure the resting geometry from there.
        await app.evalJS<null>(`(window.__tug.activateCard("A"), null)`);
        await wait(AFTER_LAND_MS);
        expect(
          await columnOffset(app),
          "revealing the top member brings the strip back to rest",
        ).toBe(0);

        const geometry = await run(app);
        const three = await rects(app, ["p1", "p2", "p3"]);
        // Each member takes `max(floor, natural · weight)` — what it declared
        // it is finished at, scaled by whatever the drag above stored for it.
        // These panes declare no appetite at all, so none of them is ever
        // finished and each reads the RUN as its natural: one screen of
        // itself, which is what a flowing member with nothing to say about its
        // own height stands at. Computed from the LIVE record rather than
        // restated, so the assertion is the rule and not a transcription of
        // one particular drag.
        const overflowShares = (await columnsRecord(app))["0"]?.shares ?? {};
        const wanted = (id: string): number =>
          Math.max(FLOOR, geometry.height * (overflowShares[id] ?? 1));
        note(
          `overflow members: ${["p1", "p2", "p3"]
            .map((id) => `${id} ${Math.round(three[id].height)} of ${Math.round(wanted(id))}`)
            .join(", ")}`,
        );
        for (const id of ["p1", "p2", "p3"]) {
          expect(
            Math.abs(three[id].height - wanted(id)),
            `${id} stands at the height its own appetite asked for`,
          ).toBeLessThan(EPSILON);
        }
        // Stacked from the run's own top, one imposition gap apart.
        expect(Math.abs(three.p1.top - geometry.top)).toBeLessThan(EPSILON);
        expect(Math.abs(three.p2.top - three.p1.bottom - GAP)).toBeLessThan(
          EPSILON,
        );
        expect(Math.abs(three.p3.top - three.p2.bottom - GAP)).toBeLessThan(
          EPSILON,
        );
        // The overhang: the strip's foot runs past the run's bottom rather than
        // being squeezed above it. WHICH member the run's bottom edge cuts is a
        // fact about the members' own heights now — the heaviest of them can be
        // twice its neighbour — so the claim is about the strip, which is where
        // the affordance actually lives.
        expect(
          three.p3.bottom,
          "the strip overhangs the run — that overhang is the affordance",
        ).toBeGreaterThan(geometry.bottom + EPSILON);
        // A split divides the run and never the band: one left edge, one width.
        expect(Math.abs(three.p2.left - three.p1.left)).toBeLessThan(EPSILON);
        expect(Math.abs(three.p3.left - three.p1.left)).toBeLessThan(EPSILON);
        expect(Math.abs(three.p3.width - three.p1.width)).toBeLessThan(EPSILON);
        // And the coordinates the frames pinned to are on the canvas: every
        // member's top, then the strip's own end, which is what the offset
        // clamp reads. `n + 1` numbers for `n` members.
        const strip = await stripProperties(app, 3);
        note(`slot 0 strip coordinates: ${strip.join(" / ")}`);
        expect(strip[0]).toBe(0);
        for (const [index, id] of ["p1", "p2", "p3"].entries()) {
          expect(
            Math.abs(three[id].top - (geometry.top + strip[index])),
            `${id}'s frame stands at strip coordinate ${index}`,
          ).toBeLessThan(EPSILON);
        }
        expect(
          Math.abs(strip[3] - (three.p3.bottom - geometry.top)),
          "the last coordinate is the strip's own end",
        ).toBeLessThan(EPSILON);
        expect(
          strip[3],
          "and the strip is longer than the run — which is what overflowing means",
        ).toBeGreaterThan(geometry.height);

        // ── 2. The weights survive the crossing, and are read on the far side. ──
        expect(
          overflowShares,
          "the weights the user dragged are preserved untouched",
        ).toEqual(draggedShares);
        // Read, not merely kept: the member the hand made bigger is bigger here
        // too. Under the retired rule every overflowing member was the same
        // height and this record made no difference to anything drawn.
        const heavier = draggedShares.p1 > draggedShares.p2 ? "p1" : "p2";
        const lighter = heavier === "p1" ? "p2" : "p1";
        expect(
          three[heavier].height,
          "the member the drag made heavier is the taller one in the strip",
        ).toBeGreaterThan(three[lighter].height + EPSILON);

        // ── 3. The reveal, and its minimality. ──
        expect(await columnOffset(app)).toBe(0);
        await app.evalJS<null>(`(window.__tug.activateCard("C"), null)`);
        await wait(AFTER_LAND_MS);
        const revealed = await rects(app, ["p1", "p2", "p3"]);
        const geometryAfter = await run(app);
        const offset = await columnOffset(app);
        note(
          `reveal slid slot 0 by ${Math.round(offset)}px, property reads ${await offsetProperty(app)}`,
        );
        expect(offset).toBeGreaterThan(0);
        // The number reached the DOM, not just the store — the frames' pins
        // read the property and nothing else.
        expect(await offsetProperty(app)).toBe(`${Math.round(offset)}px`);
        // The LEAST slide that shows it: the bottom member's bottom edge lands
        // flush with the run's, and no further. Sliding to the strip's end or
        // to the member's own top would both also "show" it, and both would be
        // wrong.
        expect(
          Math.abs(revealed.p3.bottom - geometryAfter.bottom),
          "the revealed member's bottom edge is flush with the run's",
        ).toBeLessThan(EPSILON);
        // The whole column moved, not the activated member alone.
        expect(revealed.p1.top).toBeLessThan(three.p1.top - EPSILON);

        // A member already fully in the run reveals nothing — activating it
        // must not move a pixel. WHICH member that is depends on the heights the
        // members asked for, so it is read off the frames at this offset rather
        // than named: the lowest one standing wholly inside the run.
        const inside = (["p1", "p2", "p3"] as const).filter(
          (id) =>
            revealed[id].top >= geometryAfter.top - EPSILON &&
            revealed[id].bottom <= geometryAfter.bottom + EPSILON,
        );
        expect(
          inside.length,
          "some member stands wholly inside the run at this offset",
        ).toBeGreaterThan(0);
        const settled = inside[inside.length - 1];
        const settledCard = { p1: "A", p2: "B", p3: "C" }[settled];
        note(`activating ${settled} (card ${settledCard}), which is wholly inside the run`);
        await app.evalJS<null>(`(window.__tug.activateCard(${JSON.stringify(settledCard)}), null)`);
        await wait(AFTER_LAND_MS);
        expect(
          Math.abs((await columnOffset(app)) - offset),
          "an activation that reveals nothing commits no geometry",
        ).toBeLessThan(0.001);
        const still = await rects(app, ["p1"]);
        expect(Math.abs(still.p1.top - revealed.p1.top)).toBeLessThan(EPSILON);

        // ── 4. The third leaves, and the user's division is governing again. ──
        //
        // Closed by the door the user has, as at0455 does: raise the member's
        // pane, then close the first card responder.
        await app.click(`${frame("p3")} [data-testid="tug-pane-title-bar"]`);
        await wait(300);
        await app.dispatchControlAction("close");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(frame("p3"))}) === null`,
          { timeoutMs: 5_000 },
        );
        await wait(AFTER_LAND_MS);

        expect(
          await seamCount(app),
          "the seam returns the moment the column stops overflowing",
        ).toBe(1);
        const two = await rects(app, ["p1", "p2"]);
        const geometryEnd = await run(app);
        // Tiled run endpoint to run endpoint, and standing at the run's own top
        // rather than wherever the strip had slid to — a shared column has no
        // offset to hold.
        expect(
          Math.abs(two.p1.top - geometryEnd.top),
          "the top member is back at the run's own top",
        ).toBeLessThan(EPSILON);
        expect(
          Math.abs(two.p2.bottom - geometryEnd.bottom),
          "the bottom member is back at the run's own bottom",
        ).toBeLessThan(EPSILON);
        expect(Math.abs(two.p2.top - two.p1.bottom - GAP)).toBeLessThan(EPSILON);
        // And at the ratio the hand set before the third member ever arrived.
        note(
          `restored: ${Math.round(two.p1.height)} / ${Math.round(two.p2.height)} against ${Math.round(dragged.p1.height)} / ${Math.round(dragged.p2.height)}`,
        );
        expect(
          Math.abs(two.p1.height / two.p2.height - draggedRatio),
          "the division came back at the ratio the user dragged it to",
        ).toBeLessThan(0.05);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
