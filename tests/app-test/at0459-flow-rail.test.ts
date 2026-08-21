/**
 * at0459-flow-rail.test.ts — the deck says where it stands in its own strip.
 *
 * In flow the chain runs past the band it is seen through, and until the rail
 * there was nothing on the canvas that said so. The rail furnishes the bottom
 * band the imposition already keeps clear — a segment per occupied slot,
 * proportional to that slot's real extent, numbered the way the Cards control
 * numbers the same places.
 *
 * What this file pins:
 *
 *   1. **It stands in flow and nowhere else.** Fit has no strip to stand in, so
 *      there is nothing to draw. The moment the layout is flow the rail is
 *      there, with one segment per occupied slot, in the bottom band and clear
 *      of the corner the host reserves for its build stamps (Spec S03).
 *   2. **Overflow changes the register, never the component** ([P10]). A strip
 *      inside its band is drawn quiet with no thumb; widening the cards past
 *      the band raises the emphasis and reveals the thumb — and it is the SAME
 *      ELEMENT on both sides of that boundary, which the test proves by
 *      marking the node before the flip and finding its mark after.
 *
 *   3. **The thumb drags the strip, and the store hears once** ([P11], [P01]).
 *      Under the hand the deck moves on the gauge channel with nothing
 *      committed; the release is the one write, and the census counts it.
 *   4. **A numbered segment reveals its slot** by the least the strip can move
 *      — the same arithmetic an activation reveals with — in one commit the
 *      settle animates as one crossing.
 *   5. **A sideways wheel scrolls, and quiet commits it.** A wheel has no
 *      release, so the idle timeout is its end; a plain vertical wheel is not
 *      this gesture at all and leaves the strip alone.
 *
 * The overflow case is deliberately driven by the width picker rather than by
 * adding cards: a preset flip is the boundary crossing a user actually makes,
 * and it changes nothing structural for a mount/unmount to hide behind.
 *
 * @covers tugdeck/src/components/chrome/flow-rail.tsx
 * @covers tugdeck/src/components/chrome/flow-rail.css
 */

import { describe, expect, test } from "bun:test";

import {
  launchTugApp,
  note,
  summarizeMotionCensus,
  type App,
} from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const LENS_WIDTH = 420;
/** The settle window, with room for a landing tween. */
const AFTER_LAND_MS = 900;

/** The two width presets the register flip is driven with. */
const SLIM_PX = 675;
const WIDE_PX = 1230;
/** `IMPOSITION_GAP_PX` — what stands between two slots of the strip. */
const GAP_PX = 5;
/** `FLOW_WHEEL_IDLE_MS` — how long a wheel gesture stays open after its last
 *  delivery before the strip commits where it stopped. */
const FLOW_WHEEL_IDLE_MS = 180;

const RAIL = '[data-testid="flow-rail"]';
const THUMB = '[data-testid="flow-rail-thumb"]';

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/** A deck of `count` content cards, one per slot, with the Lens on the right. */
function deckShape(count: number, cardWidth: number): Record<string, unknown> {
  const ids = ["A", "B", "C", "D", "E"].slice(0, count);
  return {
    cards: [
      ...ids.map((id) => ({
        id,
        componentId: "hello",
        title: `Card ${id}`,
        closable: true,
      })),
      { id: "L", componentId: "lens", title: "Lens", closable: true },
    ],
    panes: [
      ...ids.map((id, index) => ({
        id: `p${index + 1}`,
        position: { x: 40, y: 40 },
        size: { width: cardWidth, height: 400 },
        cardIds: [id],
        activeCardId: id,
        title: "",
        acceptsFamilies: ["maker"],
        slot: index,
      })),
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
      kind: ["one-up", "two-up", "three-up", "four-up", "five-up"][count - 1],
      sidebars: { lens: { side: "right" } },
    },
    hasFocus: true,
  };
}

async function openDeck(
  app: App,
  options: { cards: number; cardWidth: number; layout: "fit" | "flow" },
): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.setTugbankValue("dev.tugtool.lens", "widthPx", { kind: "i64", value: ${LENS_WIDTH} }), null)`,
  );
  const state = deckShape(options.cards, options.cardWidth);
  if (options.layout === "flow") {
    (state.imposition as Record<string, unknown>).layout = "flow";
  }
  await app.seedDeckState({ state, focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `document.querySelector('[data-testid="lens-layouts-plan"]') !== null`,
    { timeoutMs: 8_000 },
  );
  await wait(AFTER_LAND_MS);
}

/** The band the strip is seen through: the canvas less the Lens's inset and
 *  the chain's own gap at either end — the same arithmetic `_flowBandWidth`
 *  does, read off the elements the deck actually drew. */
async function bandWidth(app: App): Promise<number> {
  return app.evalJS<number>(
    `(function () {
      var box = document.querySelector("[data-deck-canvas-background]")
        .getBoundingClientRect();
      var lens = document.querySelector('.tug-pane[data-pane-id="pLens"]')
        .getBoundingClientRect();
      return (lens.left - 5) - (box.left + 5);
    })()`,
  );
}

/** Where the store says the strip stands — the committed offset, in px. */
async function committedOffset(app: App): Promise<number> {
  return app.evalJS<number>(
    `(window.tugdeck.diag.getDeckState().flowOffset || 0)`,
  );
}

/** What the gauge channel has published onto the rail — a fraction of the
 *  band, and the deck's live position between commits. */
async function publishedOffset(app: App): Promise<number | null> {
  return app.evalJS<number | null>(
    `(function () {
      var rail = document.querySelector(${JSON.stringify(RAIL)});
      if (rail === null) return null;
      var raw = rail.style.getPropertyValue("--gauge-flow-offset");
      return raw === "" ? null : parseFloat(raw);
    })()`,
  );
}

/** One element's viewport box. */
async function boxOf(
  app: App,
  selector: string,
): Promise<{ left: number; top: number; width: number; height: number }> {
  return app.evalJS(
    `(function () {
      var r = document.querySelector(${JSON.stringify(selector)})
        .getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    })()`,
  );
}

/** One wheel delivery over the canvas, at the canvas itself — the deck's own
 *  background, which is what a wheel on bare canvas targets. */
async function wheel(
  app: App,
  delta: { deltaX?: number; deltaY?: number },
): Promise<void> {
  await app.evalJS<null>(
    `(function () {
      document.querySelector("[data-deck-canvas-background]").dispatchEvent(
        new WheelEvent("wheel", {
          deltaX: ${delta.deltaX ?? 0},
          deltaY: ${delta.deltaY ?? 0},
          bubbles: true,
          cancelable: true,
        })
      );
      return null;
    })()`,
  );
}

interface RailReading {
  present: boolean;
  overflow: string | null;
  segments: number;
  digits: string[];
  thumbDisplay: string | null;
  thumbWidthRatio: number | null;
  marked: string | null;
  /** The rail's own box, and the canvas's, so the placement can be judged.
   *  Null when there is no rail: an absent element has no box, and NaN is not
   *  a thing the bridge can carry back. */
  railLeft: number | null;
  railBottom: number | null;
  canvasLeft: number;
  canvasBottom: number;
}

async function readRail(app: App): Promise<RailReading> {
  return app.evalJS<RailReading>(
    `(function () {
      var rail = document.querySelector(${JSON.stringify(RAIL)});
      var canvas = document.querySelector("[data-deck-canvas-background]")
        .getBoundingClientRect();
      if (rail === null) {
        return {
          present: false, overflow: null, segments: 0, digits: [],
          thumbDisplay: null, thumbWidthRatio: null, marked: null,
          railLeft: null, railBottom: null,
          canvasLeft: canvas.left, canvasBottom: canvas.bottom,
        };
      }
      var box = rail.getBoundingClientRect();
      var thumb = rail.querySelector(${JSON.stringify(THUMB)});
      var segments = Array.prototype.slice.call(
        rail.querySelectorAll(".flow-rail-segment")
      );
      return {
        present: true,
        overflow: rail.getAttribute("data-overflow"),
        segments: segments.length,
        digits: segments.map(function (el) { return el.textContent; }),
        thumbDisplay: thumb === null ? null : getComputedStyle(thumb).display,
        thumbWidthRatio:
          thumb === null || box.width === 0
            ? null
            : thumb.getBoundingClientRect().width / box.width,
        marked: rail.getAttribute("data-at0459-mark"),
        railLeft: box.left,
        railBottom: box.bottom,
        canvasLeft: canvas.left,
        canvasBottom: canvas.bottom,
      };
    })()`,
  );
}

describe.skipIf(!SHOULD_RUN)("at0459 — the flow rail", () => {
  test(
    "stands in flow, in the bottom band, and nowhere in fit",
    async () => {
      const app = await launchTugApp({ testName: "at0459-flow-rail" });
      try {
        await openDeck(app, { cards: 3, cardWidth: SLIM_PX, layout: "fit" });

        expect(
          (await readRail(app)).present,
          "fit has no strip to stand in, so it has no rail",
        ).toBe(false);

        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("set-imposition-layout", { layout: "flow" }), null)`,
        );
        await wait(AFTER_LAND_MS);

        const rail = await readRail(app);
        note(
          `rail: present=${rail.present} segments=${rail.segments} ` +
            `digits=${rail.digits.join("")} overflow=${rail.overflow} ` +
            `left=+${Math.round((rail.railLeft ?? 0) - rail.canvasLeft)} ` +
            `up=${Math.round(rail.canvasBottom - (rail.railBottom ?? 0))}`,
        );
        expect(rail.present, "flow puts the rail on the canvas").toBe(true);
        expect(rail.segments, "one segment per occupied slot").toBe(3);
        expect(rail.digits, "numbered the way the Cards control numbers them").toEqual(
          ["1", "2", "3"],
        );
        // The band is 32px deep and the host draws its stamps 8px up in it; the
        // rail shares that line rather than inventing a second one.
        expect(
          Math.round(rail.canvasBottom - (rail.railBottom ?? 0)),
          "the rail stands on the stamps' own baseline",
        ).toBe(8);
        expect(
          (rail.railLeft ?? 0) - rail.canvasLeft,
          "and clear of the corner the stamps are reserved",
        ).toBeGreaterThanOrEqual(420);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "overflow raises the register without replacing the rail",
    async () => {
      const app = await launchTugApp({ testName: "at0459-flow-rail" });
      try {
        await openDeck(app, { cards: 2, cardWidth: SLIM_PX, layout: "flow" });

        // Two slots, so the strip is both card widths and the gap between them.
        const slimStrip = SLIM_PX * 2 + GAP_PX;
        const wideStrip = WIDE_PX * 2 + GAP_PX;
        const band = await bandWidth(app);
        note(
          `band ${Math.round(band)}px, strip slim ${slimStrip}px / wide ${wideStrip}px`,
        );
        expect(
          band,
          "the fixture needs a band the slim strip fits inside",
        ).toBeGreaterThan(slimStrip);
        expect(
          band,
          "and that the wide strip runs past — that is the boundary being crossed",
        ).toBeLessThan(wideStrip);

        const quiet = await readRail(app);
        expect(quiet.present, "the rail stands even with nothing to scroll").toBe(
          true,
        );
        expect(
          quiet.overflow,
          "a strip inside its band is drawn in the quiet register",
        ).toBe("false");
        expect(
          quiet.thumbDisplay,
          "with no thumb, because there is no position to state",
        ).toBe("none");

        // Mark the node. If the boundary remounted the rail, the mark goes with
        // the old element and the reading after the flip comes back null.
        await app.evalJS<null>(
          `(document.querySelector(${JSON.stringify(RAIL)})
             .setAttribute("data-at0459-mark", "same"), null)`,
        );

        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("set-content-width", { preset: "wide" }), null)`,
        );
        await wait(AFTER_LAND_MS);

        const loud = await readRail(app);
        note(
          `after wide: overflow=${loud.overflow} thumb=${loud.thumbDisplay} ` +
            `thumbRatio=${loud.thumbWidthRatio?.toFixed(3)} mark=${loud.marked}`,
        );
        expect(
          loud.marked,
          "the SAME element crossed the boundary — a register change, not a new component",
        ).toBe("same");
        expect(loud.overflow, "and it now reads in the loud register").toBe(
          "true",
        );
        expect(
          loud.thumbDisplay,
          "which is what reveals the thumb",
        ).toBe("block");
        expect(
          loud.thumbWidthRatio ?? 0,
          "whose width is the share of the strip on screen",
        ).toBeCloseTo(band / wideStrip, 1);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the thumb drags the strip, and the store hears about it once",
    async () => {
      const app = await launchTugApp({ testName: "at0459-flow-rail" });
      try {
        // Three slim cards run well past the band, so there is travel to drag.
        await openDeck(app, { cards: 3, cardWidth: SLIM_PX, layout: "flow" });
        expect(await committedOffset(app), "the strip starts home").toBe(0);

        const thumb = await boxOf(app, THUMB);
        const target = {
          x: Math.round(thumb.left + thumb.width / 2 + 120),
          y: Math.round(thumb.top + thumb.height / 2),
        };

        const census = await app.motionCensus(async () => {
          await app.nativeDragElementWithoutRelease(THUMB, target);
          await wait(120);
          // Mid-gesture: the deck has moved and the store has not heard a word.
          const live = await publishedOffset(app);
          const committed = await committedOffset(app);
          note(
            `under the hand: published=${live?.toFixed(4)} committed=${committed}px`,
          );
          expect(
            live ?? 0,
            "the strip is drawn where the hand has it",
          ).toBeGreaterThan(0);
          expect(
            committed,
            "and nothing is committed until the hand lets go",
          ).toBe(0);
          await app.nativeMouseUp(target);
          await wait(AFTER_LAND_MS);
        });

        note(summarizeMotionCensus("thumb drag", census));
        expect(
          await committedOffset(app),
          "the release is where the deck now stands",
        ).toBeGreaterThan(0);
        expect(
          census.notifies,
          "one gesture, one commit, one notify",
        ).toBe(1);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a numbered segment reveals its slot, by the least the strip can move",
    async () => {
      const app = await launchTugApp({ testName: "at0459-flow-rail" });
      try {
        await openDeck(app, { cards: 3, cardWidth: SLIM_PX, layout: "flow" });
        const band = await bandWidth(app);
        // The last slot's right edge, brought to the band's right edge — the
        // same arithmetic an activation reveals with, and the least move that
        // puts the whole slot on screen.
        const expected = 2 * (SLIM_PX + GAP_PX) + SLIM_PX - band;

        const census = await app.motionCensus(async () => {
          await app.nativeClickAtElement(
            `${RAIL} .flow-rail-segment[data-slot="2"]`,
          );
          await wait(AFTER_LAND_MS);
        });

        const landed = await committedOffset(app);
        note(
          `${summarizeMotionCensus("segment click", census)} — ` +
            `offset ${Math.round(landed)}px, expected ${Math.round(expected)}px`,
        );
        expect(landed, "clicking 3 brings the third slot into the band").toBeCloseTo(
          expected,
          0,
        );
        expect(census.notifies, "in one commit").toBe(1);
        expect(
          census.arms,
          "which the settle animates as one crossing",
        ).toBeLessThanOrEqual(1);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a sideways wheel scrolls the strip and commits where it came to rest",
    async () => {
      const app = await launchTugApp({ testName: "at0459-flow-rail" });
      try {
        await openDeck(app, { cards: 3, cardWidth: SLIM_PX, layout: "flow" });

        // A plain vertical wheel is not this gesture. The dominant axis decides,
        // so scrolling down over the deck leaves the strip exactly where it is.
        await wheel(app, { deltaY: 240 });
        await wait(FLOW_WHEEL_IDLE_MS * 2);
        expect(
          await committedOffset(app),
          "a vertical wheel is not a sideways one",
        ).toBe(0);

        // Sideways, in three deliveries, as a trackpad would send them.
        for (let i = 0; i < 3; i += 1) await wheel(app, { deltaX: 120 });
        const live = await publishedOffset(app);
        const midFlight = await committedOffset(app);
        note(
          `wheel mid-flight: published=${live?.toFixed(4)} committed=${midFlight}px`,
        );
        expect(live ?? 0, "the strip moves with the wheel").toBeGreaterThan(0);
        expect(
          midFlight,
          "and a wheel with no release commits nothing while it is still moving",
        ).toBe(0);

        // Quiet is the only end a wheel has.
        await wait(FLOW_WHEEL_IDLE_MS * 3);
        const landed = await committedOffset(app);
        note(`wheel settled at ${Math.round(landed)}px`);
        expect(landed, "the idle timeout commits where it stopped").toBeCloseTo(
          360,
          0,
        );
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
