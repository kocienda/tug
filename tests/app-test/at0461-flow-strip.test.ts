/**
 * at0461-flow-strip.test.ts — the deck says which slots it has, and which of
 * them the band is showing.
 *
 * In flow the strip runs past the band it is seen through, and the cards alone
 * cannot say how many places there are or which of them are on screen. The
 * flow strip is that readout: the arrangement drawn TO SCALE in the bottom band
 * the imposition already keeps clear — each slot at its own place and its own
 * width — in the same `TugSlot` vocabulary the Lens's Cards row arranges places
 * with, elongated.
 *
 * What this file pins:
 *
 *   1. **It stands in flow and nowhere else.** Fit has no strip to report on.
 *      The moment the layout is flow the strip is there, one segment per slot
 *      the kind defines — occupied or not — centered on the canvas and standing
 *      on the same baseline the host's build stamps use.
 *   2. **Centering is the clearance.** The drawing clears the bottom-left
 *      corner the host reserves for those stamps by construction rather than by
 *      a stated number: a share of the canvas, centered, under a ceiling.
 *   3. **The bracket says which part of the strip is on screen.** It covers the
 *      share of the strip the band shows and stands where that share begins, and
 *      scrolling moves it without changing its size.
 *   4. **Clicking a segment reveals its slot** by the least the strip can move —
 *      the same arithmetic an activation reveals with — in one commit the settle
 *      animates as one crossing.
 *   5. **The bracket is live between commits.** A held gesture moves the strip
 *      on the gauge channel and the bracket follows with ZERO store notifies —
 *      a projection rather than a render, and here not even a scripted one: its
 *      geometry is a `calc()` over the published property.
 *   6. **A scrub previews and commits once.** Pointer down on the row and drag
 *      across it: every crossed segment previews, nothing commits, and the
 *      release is the one write the census counts.
 *   7. **A sideways wheel scrolls, and quiet commits it.** A wheel has no
 *      release, so the idle timeout is its end; a plain vertical wheel is not
 *      this gesture at all and leaves the strip alone.
 *   8. **A live card drag takes the strip out of the way.** The band is
 *      drop-zone country while a card is being dragged over it, and the
 *      channel's `data-gauge-drag` stamp is what makes the strip decline the
 *      pointer.
 *   9. **The bracket is withheld when there is no position to state.** A strip
 *      that fits its band is wholly on screen, so the bracket goes and the
 *      drawing steps back a register — the same elements, quieter, never a
 *      component that arrives. And it is a READOUT: it declines the pointer, so
 *      a hand aiming at a card is not caught by the picture of where it already
 *      is.
 *
 * @covers tugdeck/src/components/chrome/flow-strip.tsx
 * @covers tugdeck/src/components/chrome/flow-strip.css
 * @covers tugdeck/src/components/tugways/tug-slot-layout.tsx
 * @covers tugdeck/src/components/tugways/tug-slot-layout.css
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

/** The slim content-width preset. */
const SLIM_PX = 675;
/** `IMPOSITION_GAP_PX` — what stands between two slots of the strip. */
const GAP_PX = 5;
/** `FLOW_WHEEL_IDLE_MS` — how long a wheel gesture stays open after its last
 *  delivery before the strip commits where it stopped. */
const FLOW_WHEEL_IDLE_MS = 180;
/**
 * The corner the host's maker-mode build stamps are drawn into
 * (`MainWindow.swift`'s `setDevInfo`): a monospaced line running as long as the
 * branch name. The strip must never reach into it — which centering guarantees,
 * and this is the number that would catch a drawing that stopped being centered.
 */
const STAMP_CORNER_PX = 420;

const STRIP_ROOT = '[data-testid="flow-strip"]';
/** The segment row itself. The container spans the canvas so it can center against
 *  it, so the ROW is what a placement assertion has to measure. */
const ROW = `${STRIP_ROOT} [data-slot="tug-slot-layout"]`;
const SEGMENTS = `${ROW} [data-slot="tug-slot"]`;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/**
 * Where the band bracket stands, as fractions of the drawn strip — which is the
 * scale the whole instrument works in, and the one a reader is comparing
 * against when they look at it.
 *
 * Read off the boxes rather than off the custom properties behind them: what is
 * under test is what the reader sees, and a property that resolved to nothing
 * would still read back as the number that was written.
 */
async function bracket(app: App): Promise<{ left: number; width: number }> {
  return app.evalJS(
    `(function () {
      var frame = document.querySelector(".flow-strip-frame")
        .getBoundingClientRect();
      var band = document.querySelector('[data-testid="flow-strip-band"]')
        .getBoundingClientRect();
      return {
        left: (band.left - frame.left) / frame.width,
        width: band.width / frame.width
      };
    })()`,
  );
}

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

/** What the gauge channel has published onto the strip — a fraction of the band,
 *  and the deck's live position between commits. */
async function publishedOffset(app: App): Promise<number | null> {
  return app.evalJS<number | null>(
    `(function () {
      var stripEl = document.querySelector(${JSON.stringify(STRIP_ROOT)});
      if (stripEl === null) return null;
      var raw = stripEl.style.getPropertyValue("--gauge-flow-offset");
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

/** Whether the channel has stamped a live drag on the strip, and what the row
 *  and a segment are answering the pointer with. */
async function pointerGate(
  app: App,
): Promise<{ stamped: boolean; row: string; segment: string }> {
  return app.evalJS(
    `(function () {
      var stripEl = document.querySelector(${JSON.stringify(STRIP_ROOT)});
      var row = document.querySelector(${JSON.stringify(ROW)});
      var segment = document.querySelector(${JSON.stringify(SEGMENTS)});
      return {
        stamped: stripEl !== null && stripEl.hasAttribute("data-gauge-drag"),
        row: row === null ? "" : getComputedStyle(row).pointerEvents,
        segment: segment === null ? "" : getComputedStyle(segment).pointerEvents,
      };
    })()`,
  );
}

/** One wheel delivery over the canvas, at the deck's own background — which is
 *  what a wheel on bare canvas targets. */
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

interface StripReading {
  present: boolean;
  segments: number;
  digits: string[];

  /** The segment row's box, and the canvas's, so the placement can be judged. Null
   *  when there is no strip: an absent element has no box. */
  rowLeft: number | null;
  rowRight: number | null;
  rowBottom: number | null;
  canvasLeft: number;
  canvasRight: number;
  canvasBottom: number;
}

async function readStrip(app: App): Promise<StripReading> {
  return app.evalJS<StripReading>(
    `(function () {
      var canvas = document.querySelector("[data-deck-canvas-background]")
        .getBoundingClientRect();
      var row = document.querySelector(${JSON.stringify(ROW)});
      if (row === null) {
        return {
          present: false, segments: 0, digits: [],
          rowLeft: null, rowRight: null, rowBottom: null,
          canvasLeft: canvas.left, canvasRight: canvas.right,
          canvasBottom: canvas.bottom,
        };
      }
      var box = row.getBoundingClientRect();
      var segments = Array.prototype.slice.call(
        document.querySelectorAll(${JSON.stringify(SEGMENTS)})
      );
      return {
        present: true,
        segments: segments.length,
        digits: segments.map(function (el) { return el.textContent; }),

        rowLeft: box.left,
        rowRight: box.right,
        rowBottom: box.bottom,
        canvasLeft: canvas.left,
        canvasRight: canvas.right,
        canvasBottom: canvas.bottom,
      };
    })()`,
  );
}

describe.skipIf(!SHOULD_RUN)("at0461 — the flow strip", () => {
  test(
    "stand in flow, centered in the bottom band, and nowhere in fit",
    async () => {
      const app = await launchTugApp({ testName: "at0461-flow-strip" });
      try {
        await openDeck(app, { cards: 3, cardWidth: SLIM_PX, layout: "fit" });

        expect(
          (await readStrip(app)).present,
          "fit has no strip to report on, so it has no strip",
        ).toBe(false);

        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("set-imposition-layout", { layout: "flow" }), null)`,
        );
        await wait(AFTER_LAND_MS);

        const strip = await readStrip(app);
        const rowCenter = ((strip.rowLeft ?? 0) + (strip.rowRight ?? 0)) / 2;
        const canvasCenter = (strip.canvasLeft + strip.canvasRight) / 2;
        note(
          `strip: present=${strip.present} segments=${strip.segments} ` +
            `digits=${strip.digits.join("")} ` +
            `centerOff=${(rowCenter - canvasCenter).toFixed(2)}px ` +
            `up=${Math.round(strip.canvasBottom - (strip.rowBottom ?? 0))} ` +
            `leftClear=${Math.round((strip.rowLeft ?? 0) - strip.canvasLeft)}`,
        );

        expect(strip.present, "flow puts the strip on the canvas").toBe(true);
        expect(
          strip.segments,
          "one segment per slot the kind defines — three-up is three",
        ).toBe(3);
        expect(
          strip.digits,
          "numbered the way the Cards control numbers the same places",
        ).toEqual(["1", "2", "3"]);
        expect(
          Math.abs(rowCenter - canvasCenter),
          "the row stands centered on the canvas",
        ).toBeLessThanOrEqual(1);
        // The band is 32px deep and the host draws its stamps 8px up in it; the
        // strip shares that line rather than inventing a second one.
        expect(
          Math.round(strip.canvasBottom - (strip.rowBottom ?? 0)),
          "on the stamps' own baseline",
        ).toBe(8);
        expect(
          (strip.rowLeft ?? 0) - strip.canvasLeft,
          "and clear of the corner the stamps are reserved — which centering buys",
        ).toBeGreaterThanOrEqual(STAMP_CORNER_PX);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a slot with no card is rendered, and drawn nowhere",
    async () => {
      const app = await launchTugApp({ testName: "at0461-flow-strip" });
      try {
        // Two cards in a five-up deck: three of the five slots stand empty.
        const state = deckShape(5, SLIM_PX);
        (state.imposition as Record<string, unknown>).layout = "flow";
        (state.imposition as Record<string, unknown>).kind = "five-up";
        state.cards = (state.cards as Record<string, unknown>[]).filter(
          (card) => card.id === "A" || card.id === "B" || card.id === "L",
        );
        state.panes = (state.panes as Record<string, unknown>[]).filter(
          (pane) => pane.id === "p1" || pane.id === "p2" || pane.id === "pLens",
        );
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugtool.lens", "widthPx", { kind: "i64", value: ${LENS_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state, focusCardId: "A" });
        await wait(AFTER_LAND_MS);

        const strip = await readStrip(app);
        const drawn = await app.evalJS<number[]>(
          `Array.prototype.map.call(
            document.querySelectorAll(${JSON.stringify(SEGMENTS)}),
            function (el) { return Math.round(el.getBoundingClientRect().width); }
          )`,
        );
        note(`five-up, two cards: widths=${drawn.join(",")}`);
        expect(
          strip.segments,
          "every slot the kind defines is rendered — five, not two",
        ).toBe(5);
        // Rendered and NOT DRAWN. A slot with no card in it has no place in the
        // strip and no width, so there is nothing to draw — but it keeps its
        // index, which is what lets every reading here stay addressed by slot
        // rather than by how many slots happen to be occupied.
        expect(
          drawn.slice(0, 2).every((width) => width > 0),
          "the two occupied slots are drawn",
        ).toBe(true);
        expect(
          drawn.slice(2),
          "and the three empty ones take no room at all",
        ).toEqual([0, 0, 0]);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the bracket says which part of the strip is on screen",
    async () => {
      const app = await launchTugApp({ testName: "at0461-flow-strip" });
      try {
        // Five slim cards run far past the band, so the two ends of the strip
        // have no slot in common — which is what makes where the bracket stands
        // a reading that changes as the strip moves.
        await openDeck(app, { cards: 5, cardWidth: SLIM_PX, layout: "flow" });
        const band = await bandWidth(app);
        const stripWidth = 5 * SLIM_PX + 4 * GAP_PX;
        note(`band ${Math.round(band)}px, strip ${stripWidth}px`);
        expect(
          band,
          "the fixture needs a strip that runs past its band",
        ).toBeLessThan(stripWidth);

        const owedWidth = band / stripWidth;
        const home = await bracket(app);
        note(
          `at home: bracket ${home.left.toFixed(3)}..${(home.left + home.width).toFixed(3)}` +
            ` — owed 0..${owedWidth.toFixed(3)}`,
        );
        expect(
          home.left,
          "the strip starts home, so the bracket starts at its head",
        ).toBeCloseTo(0, 3);
        expect(
          home.width,
          "and covers exactly the share of the strip the band shows",
        ).toBeCloseTo(owedWidth, 2);

        // Move the strip to the far end — through the deck's own wheel gesture,
        // which is the path a reader takes. The committed picture is what is
        // read afterwards.
        for (let i = 0; i < 20; i += 1) await wheel(app, { deltaX: 240 });
        await wait(FLOW_WHEEL_IDLE_MS * 3);
        await wait(AFTER_LAND_MS);

        const landed = await committedOffset(app);
        const away = await bracket(app);
        note(
          `at ${Math.round(landed)}px: bracket ${away.left.toFixed(3)}..` +
            `${(away.left + away.width).toFixed(3)} — owed ` +
            `${(landed / stripWidth).toFixed(3)}..1`,
        );
        expect(
          landed,
          "the wheel ran the strip to its far end",
        ).toBeCloseTo(stripWidth - band, 0);
        expect(
          away.left,
          "so the bracket stands where that far end begins",
        ).toBeCloseTo(landed / stripWidth, 2);
        expect(
          away.left + away.width,
          "and its far edge is the end of the strip",
        ).toBeCloseTo(1, 2);
        expect(
          away.width,
          "the band did not change size, only where it looks",
        ).toBeCloseTo(home.width, 2);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "clicking a segment reveals its slot, by the least the strip can move",
    async () => {
      const app = await launchTugApp({ testName: "at0461-flow-strip" });
      try {
        await openDeck(app, { cards: 3, cardWidth: SLIM_PX, layout: "flow" });
        const band = await bandWidth(app);
        // The last slot's right edge, brought to the band's right edge — the
        // same arithmetic an activation reveals with, and the least move that
        // puts the whole slot on screen.
        const expected = 2 * (SLIM_PX + GAP_PX) + SLIM_PX - band;

        const census = await app.motionCensus(async () => {
          await app.nativeClickAtElement(
            `${ROW} [aria-label="Reveal slot 3"]`,
          );
          await wait(AFTER_LAND_MS);
        });

        const landed = await committedOffset(app);
        note(
          `${summarizeMotionCensus("segment click", census)} — ` +
            `offset ${Math.round(landed)}px, expected ${Math.round(expected)}px`,
        );
        expect(
          landed,
          "clicking 3 brings the third slot into the band",
        ).toBeCloseTo(expected, 0);
        expect(census.notifies, "in one commit").toBe(1);
        expect(
          census.arms,
          "which the settle animates as one crossing",
        ).toBeLessThanOrEqual(1);

        // A slot already wholly on screen computes its own offset back, so it
        // moves nothing at all.
        const still = await app.motionCensus(async () => {
          await app.nativeClickAtElement(
            `${ROW} [aria-label="Reveal slot 3"]`,
          );
          await wait(AFTER_LAND_MS);
        });
        note(summarizeMotionCensus("segment click, already shown", still));
        expect(
          await committedOffset(app),
          "a slot already in the band stays where it is",
        ).toBeCloseTo(expected, 0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the segments repaint under the hand with the store hearing nothing at all",
    async () => {
      const app = await launchTugApp({ testName: "at0461-flow-strip" });
      try {
        await openDeck(app, { cards: 5, cardWidth: SLIM_PX, layout: "flow" });
        const before = await bracket(app);
        expect(
          before.left + before.width,
          "the fixture starts home, with the strip's far end off screen",
        ).toBeLessThan(0.99);

        // The press and the travel happen OUTSIDE the census, so what it counts
        // is the held gesture alone. A pointer gesture is the right one to hold
        // this claim on: it ends when the hand lets go, where a wheel ends on a
        // quiet timer that would land its own commit inside any bracket long
        // enough to read the picture back.
        await app.nativeDragElementWithoutRelease(
          `${ROW} [aria-label="Reveal slot 1"]`,
          { selector: `${ROW} [aria-label="Reveal slot 5"]` },
        );
        let held: { left: number; width: number } | null = null;
        let live: number | null = null;
        let committed = -1;
        const census = await app.motionCensus(async () => {
          live = await publishedOffset(app);
          held = await bracket(app);
          committed = await committedOffset(app);
        }, 0);

        const during = held as unknown as { left: number; width: number };
        note(
          `${summarizeMotionCensus("held scrub", census)} — ` +
            `published=${(live as number | null)?.toFixed(4)} ` +
            `committed=${committed}px bracket at ${during.left.toFixed(3)}`,
        );
        expect(committed, "the store has not heard about the gesture yet").toBe(
          0,
        );
        expect(
          during.left + during.width,
          "and the bracket has already reached the strip's far end",
        ).toBeCloseTo(1, 2);
        expect(
          during.left,
          "which is a different picture from the one React rendered",
        ).toBeGreaterThan(before.left);
        // The claim the census carries: the picture moved without one store
        // notify, so no render can have produced it. Here the projection is not
        // even script — the bracket's geometry is a `calc()` over the property
        // the channel publishes, so the frame is the style engine's alone.
        expect(
          census.notifies,
          "the bracket moved with zero store notifies — a projection, not a render",
        ).toBe(0);

        const box = await boxOf(app, `${ROW} [aria-label="Reveal slot 5"]`);
        await app.nativeMouseUp({
          x: Math.round(box.left + box.width / 2),
          y: Math.round(box.top + box.height / 2),
        });
        await wait(AFTER_LAND_MS);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a scrub across the segments previews each one and commits once at release",
    async () => {
      const app = await launchTugApp({ testName: "at0461-flow-strip" });
      try {
        await openDeck(app, { cards: 5, cardWidth: SLIM_PX, layout: "flow" });
        expect(await committedOffset(app), "the strip starts home").toBe(0);

        const last = `${ROW} [aria-label="Reveal slot 5"]`;
        const census = await app.motionCensus(async () => {
          await app.nativeDragElementWithoutRelease(
            `${ROW} [aria-label="Reveal slot 1"]`,
            { selector: last },
          );
          await wait(120);

          const live = await publishedOffset(app);
          const during = await bracket(app);
          const committed = await committedOffset(app);
          note(
            `under the hand: published=${live?.toFixed(4)} committed=${committed}px ` +
              `bracket at ${during.left.toFixed(3)}`,
          );
          expect(
            live ?? 0,
            "the strip is drawn where the hand has scrubbed it",
          ).toBeGreaterThan(0);
          expect(
            committed,
            "and nothing is committed until the hand lets go",
          ).toBe(0);
          expect(
            during.left + during.width,
            "while the bracket already stands over the slot under the finger",
          ).toBeCloseTo(1, 2);

          const box = await boxOf(app, last);
          await app.nativeMouseUp({
            x: Math.round(box.left + box.width / 2),
            y: Math.round(box.top + box.height / 2),
          });
          await wait(AFTER_LAND_MS);
        });

        const landed = await committedOffset(app);
        const band = await bandWidth(app);
        const stripWidth = 5 * SLIM_PX + 4 * GAP_PX;
        note(
          `${summarizeMotionCensus("scrub", census)} — landed ${Math.round(landed)}px`,
        );
        expect(
          landed,
          "the release is where the deck now stands — the last segment's reveal",
        ).toBeCloseTo(stripWidth - band, 0);
        expect(
          census.notifies,
          "one gesture, one commit, one notify — every frame before it was a projection",
        ).toBe(1);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a live card drag takes the strip out of the pointer's way",
    async () => {
      const app = await launchTugApp({ testName: "at0461-flow-strip" });
      try {
        await openDeck(app, { cards: 3, cardWidth: SLIM_PX, layout: "flow" });

        const atRest = await pointerGate(app);
        note(`at rest: drag=${atRest.stamped} row=${atRest.row} segment=${atRest.segment}`);
        expect(atRest.stamped, "no drag, no stamp").toBe(false);
        expect(atRest.segment, "and the segments take the pointer as usual").toBe(
          "auto",
        );

        // A real card drag: the band becomes drop-zone country, and the strip
        // stand right in it.
        const map = await boxOf(app, ROW);
        await app.nativeDragElementWithoutRelease(
          `.tug-pane[data-pane-id="p1"] .tug-pane-title-bar`,
          {
            x: Math.round(map.left + map.width / 2),
            y: Math.round(map.top + map.height / 2),
          },
        );
        try {
          await wait(120);
          const under = await pointerGate(app);
          note(
            `under the hand: drag=${under.stamped} row=${under.row} segment=${under.segment}`,
          );
          expect(
            under.stamped,
            "the channel stamps the drag on every registered element",
          ).toBe(true);
          expect(
            under.segment,
            "so the strip declines the pointer rather than swallowing the release",
          ).toBe("none");
        } finally {
          await app.nativeMouseUp({
            x: Math.round(map.left + map.width / 2),
            y: Math.round(map.top + map.height / 2),
          });
          await wait(AFTER_LAND_MS);
        }

        const after = await pointerGate(app);
        note(`after release: drag=${after.stamped} segment=${after.segment}`);
        expect(after.stamped, "the drag ending takes its stamp with it").toBe(
          false,
        );
        expect(after.segment, "and the segments are a target again").toBe("auto");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a sideways wheel scrolls the strip and commits where it came to rest",
    async () => {
      const app = await launchTugApp({ testName: "at0461-flow-strip" });
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

  test(
    "the band is drawn over the strip, and withheld when there is none to draw",
    async () => {
      const app = await launchTugApp({ testName: "at0461-flow-strip" });
      try {
        // Two narrow cards: the whole strip fits the band, so there is no
        // position to state.
        await openDeck(app, { cards: 2, cardWidth: 300, layout: "flow" });

        const quiet = await app.evalJS<{
          overflow: string;
          bandShown: string;
          present: boolean;
        }>(
          `(function () {
            var strip = document.querySelector(${JSON.stringify(STRIP_ROOT)});
            var band = document.querySelector('[data-testid="flow-strip-band"]');
            return {
              overflow: strip.getAttribute("data-overflow"),
              bandShown: band === null ? "" : getComputedStyle(band).display,
              present: band !== null
            };
          })()`,
        );
        note(
          `fits: overflow=${quiet.overflow} band present=${quiet.present} display=${quiet.bandShown}`,
        );
        expect(quiet.overflow, "a strip inside its band does not overflow").toBe(
          "false",
        );
        // In the DOM at BOTH registers. The boundary is a change of how loudly
        // the same elements speak, never a component arriving ([P10]) — an
        // instrument that materialised when the strip grew would read as a new
        // thing rather than as this one speaking up.
        expect(quiet.present, "the bracket is in the DOM either way").toBe(true);
        expect(
          quiet.bandShown,
          "and withheld while there is no position to state",
        ).toBe("none");

        // Now a strip that runs well past its band.
        await openDeck(app, { cards: 3, cardWidth: SLIM_PX, layout: "flow" });
        const band = await bandWidth(app);
        const stripWidth = SLIM_PX * 3 + GAP_PX * 2;

        const drawn = await app.evalJS<{
          overflow: string;
          pointer: string;
          frameLeft: number;
          frameWidth: number;
          bandLeft: number;
          bandWidth: number;
        }>(
          `(function () {
            var strip = document.querySelector(${JSON.stringify(STRIP_ROOT)});
            var frame = strip.querySelector(".flow-strip-frame")
              .getBoundingClientRect();
            var el = document.querySelector('[data-testid="flow-strip-band"]');
            var box = el.getBoundingClientRect();
            return {
              overflow: strip.getAttribute("data-overflow"),
              pointer: getComputedStyle(el).pointerEvents,
              frameLeft: frame.left,
              frameWidth: frame.width,
              bandLeft: box.left,
              bandWidth: box.width
            };
          })()`,
        );

        // What the bracket owes, from the deck's own numbers rather than from
        // the stylesheet's: it covers the share of the strip on screen, and it
        // starts where that share starts.
        const owedWidth = (band / stripWidth) * drawn.frameWidth;
        const owedLeft =
          drawn.frameLeft + ((await committedOffset(app)) / stripWidth) * drawn.frameWidth;
        note(
          `overflowing: band ${Math.round(drawn.bandWidth)}px (owed ${Math.round(owedWidth)}) ` +
            `at +${Math.round(drawn.bandLeft - drawn.frameLeft)} ` +
            `(owed +${Math.round(owedLeft - drawn.frameLeft)}) pointer=${drawn.pointer}`,
        );

        expect(drawn.overflow, "the strip runs past its band").toBe("true");
        expect(
          Math.abs(drawn.bandWidth - owedWidth),
          "the bracket is as wide as the share of the strip on screen",
        ).toBeLessThanOrEqual(1.5);
        expect(
          Math.abs(drawn.bandLeft - owedLeft),
          "and stands where that share begins",
        ).toBeLessThanOrEqual(1.5);
        // A readout, not a control. It is drawn OVER the segments, so a hand
        // aiming at a card must pass straight through it.
        expect(
          drawn.pointer,
          "the bracket declines the pointer it is drawn over",
        ).toBe("none");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
