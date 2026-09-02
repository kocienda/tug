/**
 * at0456-column-overflow.test.ts — a column past two members stops dividing.
 *
 * Two cards in a slot divide its run at a seam, and at0455 pins that. This file
 * is about what happens at the THIRD: division stops being useful past about
 * two and a half visible cards, so the column takes a different geometry
 * entirely ([P08]). Every member becomes the same height — the run over 2.5 —
 * and they stack down a virtual strip that slides up behind the run on a
 * per-slot offset. Two whole members and half of a third stand in the run, and
 * the half-visible card IS the affordance, the vertical twin of flow's card
 * clipped at the band edge.
 *
 * The fixture crosses the boundary in both directions rather than starting past
 * it, because the interesting claims are all about the crossing. A column of
 * two is divided at a seam the user drags to a ratio they chose; a third member
 * arrives and the division is abandoned; the third leaves and the ratio the
 * user chose is governing again, unrewritten.
 *
 *   1. **The 2.5 rule holds in the frames.** Three members, all one height,
 *      that height `run / 2.5`, stacked one imposition gap apart from the run's
 *      own top — and the third running PAST the run's bottom edge rather than
 *      being squeezed above it. That overhang is the affordance.
 *   2. **The seams retire, and the shares survive them.** No seam element for
 *      an overflowing column, and the weights the drag set are still in the
 *      record — untouched and unread, since the drawn members are equal despite
 *      a record that says otherwise.
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
/** How many members stand in the run at once ([P08]). */
const VISIBLE_MEMBERS = 2.5;
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
 * chose; slot 1's card is the third member, one nudge away.
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
        componentId: "hello",
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
    "a third member retires the seam for a strip at run/2.5, and leaving restores the division",
    async () => {
      const app = await launchTugApp({ testName: "at0456-column-overflow" });
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugtool.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
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

        // ── 1. A third member arrives, and the 2.5 rule answers in pixels. ──
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
        const memberHeight = geometry.height / VISIBLE_MEMBERS;
        note(
          `overflow members: ${["p1", "p2", "p3"]
            .map((id) => Math.round(three[id].height))
            .join(" / ")}px of an expected ${Math.round(memberHeight)}`,
        );
        for (const id of ["p1", "p2", "p3"]) {
          expect(
            Math.abs(three[id].height - memberHeight),
            `${id} takes the run over 2.5`,
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
        // The half card: the third member's frame runs past the run's bottom
        // rather than being squeezed above it.
        expect(three.p3.top).toBeLessThan(geometry.bottom);
        expect(
          three.p3.bottom,
          "the third member overhangs the run — that overhang is the affordance",
        ).toBeGreaterThan(geometry.bottom + EPSILON);
        // A split divides the run and never the band: one left edge, one width.
        expect(Math.abs(three.p2.left - three.p1.left)).toBeLessThan(EPSILON);
        expect(Math.abs(three.p3.left - three.p1.left)).toBeLessThan(EPSILON);
        expect(Math.abs(three.p3.width - three.p1.width)).toBeLessThan(EPSILON);

        // ── 2. The seams retire; the weights survive, unread. ──
        expect(
          await seamCount(app),
          "an overflowing column offers no division to drag",
        ).toBe(0);
        expect(
          (await columnsRecord(app))["0"]?.shares,
          "the weights the user dragged are preserved untouched",
        ).toEqual(draggedShares);
        // And unread: the members are equal despite a record that is not.
        expect(Math.abs(three.p1.height - three.p2.height)).toBeLessThan(
          EPSILON,
        );

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

        // A member already fully in the run reveals nothing. At this offset the
        // strip's bottom is flush, so the middle member stands wholly inside
        // the run — activating it must not move a pixel.
        await app.evalJS<null>(`(window.__tug.activateCard("B"), null)`);
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
