/**
 * at0461-flow-dots.test.ts — the deck says which slots it has, and which of
 * them the band is showing.
 *
 * In flow the strip runs past the band it is seen through, and the cards alone
 * cannot say how many places there are or which of them are on screen. The dots
 * are that readout: one numbered chip per slot the kind defines, centered in the
 * bottom band the imposition already keeps clear, drawn as the same `TugSlot`
 * the Lens's Cards row arranges slots with.
 *
 * What this file pins:
 *
 *   1. **They stand in flow and nowhere else.** Fit has no strip to report on.
 *      The moment the layout is flow the dots are there, one chip per slot the
 *      kind defines — occupied or not — centered on the canvas and standing on
 *      the same baseline the host's build stamps use.
 *   2. **Centering is the clearance.** The chips clear the bottom-left corner
 *      the host reserves for those stamps by construction rather than by a
 *      stated number: a row of at most six chips centered on the canvas cannot
 *      reach a corner.
 *   3. **A chip reads whether its slot is on screen.** In-band slots are
 *      `outlined`, everything else rests — and scrolling the strip changes which
 *      chips are which.
 *   4. **Clicking a chip reveals its slot** by the least the strip can move —
 *      the same arithmetic an activation reveals with — in one commit the settle
 *      animates as one crossing.
 *   5. **The chips are live between commits.** A held gesture moves the strip on
 *      the gauge channel; the chips repaint from a DOM projection with ZERO
 *      notifies, which is what makes it a projection rather than a render.
 *   6. **A scrub previews and commits once.** Pointer down on the row and drag
 *      across it: every crossed chip previews, nothing commits, and the release
 *      is the one write the census counts.
 *   7. **A sideways wheel scrolls, and quiet commits it.** A wheel has no
 *      release, so the idle timeout is its end; a plain vertical wheel is not
 *      this gesture at all and leaves the strip alone.
 *   8. **A live card drag takes the dots out of the way.** The band is drop-zone
 *      country while a card is being dragged over it, and the channel's
 *      `data-gauge-drag` stamp is what makes the dots decline the pointer.
 *
 * @covers tugdeck/src/components/chrome/flow-dots.tsx
 * @covers tugdeck/src/components/chrome/flow-dots.css
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
 * branch name. The dots must never reach into it — which centering guarantees,
 * and this is the number that would catch a drawing that stopped being centered.
 */
const STAMP_CORNER_PX = 420;

const DOTS = '[data-testid="flow-dots"]';
/** The chip row itself. The container spans the canvas so it can center against
 *  it, so the ROW is what a placement assertion has to measure. */
const ROW = `${DOTS} [data-slot="tug-slot-layout"]`;
const CHIPS = `${ROW} [data-slot="tug-slot"]`;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/**
 * The looks the readout owes, derived here from the strip's own arithmetic
 * rather than read from the thing under test. A slot is shown when any part of
 * it is inside the band; a card clipped at the band edge is still a card the
 * reader can see.
 *
 * The band is measured off the real deck, so this holds at whatever width the
 * harness's window happens to open at.
 */
function expectedStates(options: {
  count: number;
  occupied: number;
  cardWidth: number;
  band: number;
  offset: number;
}): string[] {
  const { count, occupied, cardWidth, band, offset } = options;
  const stride = cardWidth + GAP_PX;
  return Array.from({ length: count }, (_, slot) => {
    if (slot >= occupied) return "rest";
    const left = slot * stride;
    const right = left + cardWidth;
    return right > offset && left < offset + band ? "outlined" : "rest";
  });
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

/** What the gauge channel has published onto the dots — a fraction of the band,
 *  and the deck's live position between commits. */
async function publishedOffset(app: App): Promise<number | null> {
  return app.evalJS<number | null>(
    `(function () {
      var dots = document.querySelector(${JSON.stringify(DOTS)});
      if (dots === null) return null;
      var raw = dots.style.getPropertyValue("--gauge-flow-offset");
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

/** Whether the channel has stamped a live drag on the dots, and what the row
 *  and a chip are answering the pointer with. */
async function pointerGate(
  app: App,
): Promise<{ stamped: boolean; row: string; chip: string }> {
  return app.evalJS(
    `(function () {
      var dots = document.querySelector(${JSON.stringify(DOTS)});
      var row = document.querySelector(${JSON.stringify(ROW)});
      var chip = document.querySelector(${JSON.stringify(CHIPS)});
      return {
        stamped: dots !== null && dots.hasAttribute("data-gauge-drag"),
        row: row === null ? "" : getComputedStyle(row).pointerEvents,
        chip: chip === null ? "" : getComputedStyle(chip).pointerEvents,
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

interface DotsReading {
  present: boolean;
  chips: number;
  digits: string[];
  states: string[];
  /** The chip row's box, and the canvas's, so the placement can be judged. Null
   *  when there are no dots: an absent element has no box. */
  rowLeft: number | null;
  rowRight: number | null;
  rowBottom: number | null;
  canvasLeft: number;
  canvasRight: number;
  canvasBottom: number;
}

async function readDots(app: App): Promise<DotsReading> {
  return app.evalJS<DotsReading>(
    `(function () {
      var canvas = document.querySelector("[data-deck-canvas-background]")
        .getBoundingClientRect();
      var row = document.querySelector(${JSON.stringify(ROW)});
      if (row === null) {
        return {
          present: false, chips: 0, digits: [], states: [],
          rowLeft: null, rowRight: null, rowBottom: null,
          canvasLeft: canvas.left, canvasRight: canvas.right,
          canvasBottom: canvas.bottom,
        };
      }
      var box = row.getBoundingClientRect();
      var chips = Array.prototype.slice.call(
        document.querySelectorAll(${JSON.stringify(CHIPS)})
      );
      return {
        present: true,
        chips: chips.length,
        digits: chips.map(function (el) { return el.textContent; }),
        states: chips.map(function (el) { return el.getAttribute("data-state"); }),
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

describe.skipIf(!SHOULD_RUN)("at0461 — the flow dots", () => {
  test(
    "stand in flow, centered in the bottom band, and nowhere in fit",
    async () => {
      const app = await launchTugApp({ testName: "at0461-flow-dots" });
      try {
        await openDeck(app, { cards: 3, cardWidth: SLIM_PX, layout: "fit" });

        expect(
          (await readDots(app)).present,
          "fit has no strip to report on, so it has no dots",
        ).toBe(false);

        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("set-imposition-layout", { layout: "flow" }), null)`,
        );
        await wait(AFTER_LAND_MS);

        const dots = await readDots(app);
        const rowCenter = ((dots.rowLeft ?? 0) + (dots.rowRight ?? 0)) / 2;
        const canvasCenter = (dots.canvasLeft + dots.canvasRight) / 2;
        note(
          `dots: present=${dots.present} chips=${dots.chips} ` +
            `digits=${dots.digits.join("")} states=${dots.states.join(",")} ` +
            `centerOff=${(rowCenter - canvasCenter).toFixed(2)}px ` +
            `up=${Math.round(dots.canvasBottom - (dots.rowBottom ?? 0))} ` +
            `leftClear=${Math.round((dots.rowLeft ?? 0) - dots.canvasLeft)}`,
        );

        expect(dots.present, "flow puts the dots on the canvas").toBe(true);
        expect(
          dots.chips,
          "one chip per slot the kind defines — three-up is three",
        ).toBe(3);
        expect(
          dots.digits,
          "numbered the way the Cards control numbers the same places",
        ).toEqual(["1", "2", "3"]);
        expect(
          Math.abs(rowCenter - canvasCenter),
          "the row stands centered on the canvas",
        ).toBeLessThanOrEqual(1);
        // The band is 32px deep and the host draws its stamps 8px up in it; the
        // dots share that line rather than inventing a second one.
        expect(
          Math.round(dots.canvasBottom - (dots.rowBottom ?? 0)),
          "on the stamps' own baseline",
        ).toBe(8);
        expect(
          (dots.rowLeft ?? 0) - dots.canvasLeft,
          "and clear of the corner the stamps are reserved — which centering buys",
        ).toBeGreaterThanOrEqual(STAMP_CORNER_PX);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "every slot the kind defines gets a chip, occupied or not",
    async () => {
      const app = await launchTugApp({ testName: "at0461-flow-dots" });
      try {
        // Two cards in a five-up deck: three of the five slots stand empty, and
        // an empty slot is never in the band in any useful sense, so it rests.
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

        const dots = await readDots(app);
        note(`five-up, two cards: states=${dots.states.join(",")}`);
        expect(dots.chips, "five slots, five chips").toBe(5);
        expect(
          dots.states.slice(2),
          "the three unoccupied slots rest — there is nothing of them to show",
        ).toEqual(["rest", "rest", "rest"]);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a chip reads whether the band is showing its slot",
    async () => {
      const app = await launchTugApp({ testName: "at0461-flow-dots" });
      try {
        // Five slim cards run far past the band, so the two ends of the strip
        // have no slot in common — which is what makes "which chips are
        // outlined" a reading that changes as the strip moves.
        await openDeck(app, { cards: 5, cardWidth: SLIM_PX, layout: "flow" });
        const band = await bandWidth(app);
        const stripWidth = 5 * SLIM_PX + 4 * GAP_PX;
        note(`band ${Math.round(band)}px, strip ${stripWidth}px`);
        expect(
          band,
          "the fixture needs a strip that runs past its band",
        ).toBeLessThan(stripWidth);

        const home = await readDots(app);
        const atHome = expectedStates({
          count: 5,
          occupied: 5,
          cardWidth: SLIM_PX,
          band,
          offset: 0,
        });
        note(`at home: ${home.states.join(",")} — owed ${atHome.join(",")}`);
        expect(
          home.states[0],
          "the strip starts home, so the first slot is on screen",
        ).toBe("outlined");
        expect(
          home.states[4],
          "and the last one is not — that is what the readout is for",
        ).toBe("rest");
        expect(
          home.states,
          "and every chip reads what the strip's own arithmetic says it should",
        ).toEqual(atHome);

        // Move the strip to the far end — through the deck's own wheel gesture,
        // which is the path a reader takes. The committed picture is what is
        // read afterwards.
        for (let i = 0; i < 20; i += 1) await wheel(app, { deltaX: 240 });
        await wait(FLOW_WHEEL_IDLE_MS * 3);
        await wait(AFTER_LAND_MS);

        const landed = await committedOffset(app);
        const away = await readDots(app);
        const atEnd = expectedStates({
          count: 5,
          occupied: 5,
          cardWidth: SLIM_PX,
          band,
          offset: landed,
        });
        note(
          `at ${Math.round(landed)}px: ${away.states.join(",")} — owed ${atEnd.join(",")}`,
        );
        expect(
          landed,
          "the wheel ran the strip to its far end",
        ).toBeCloseTo(stripWidth - band, 0);
        expect(
          away.states[4],
          "scrolled to the end, the last slot is what the band shows",
        ).toBe("outlined");
        expect(
          away.states[0],
          "and the first has gone off the other side",
        ).toBe("rest");
        expect(
          away.states,
          "and the readout still matches the arithmetic, chip for chip",
        ).toEqual(atEnd);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "clicking a chip reveals its slot, by the least the strip can move",
    async () => {
      const app = await launchTugApp({ testName: "at0461-flow-dots" });
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
          `${summarizeMotionCensus("chip click", census)} — ` +
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
        note(summarizeMotionCensus("chip click, already shown", still));
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
    "the chips repaint under the hand with the store hearing nothing at all",
    async () => {
      const app = await launchTugApp({ testName: "at0461-flow-dots" });
      try {
        await openDeck(app, { cards: 5, cardWidth: SLIM_PX, layout: "flow" });
        const before = await readDots(app);
        expect(
          before.states[4],
          "the fixture starts with the last slot off screen",
        ).toBe("rest");

        // The press and the travel happen OUTSIDE the census, so what it counts
        // is the held gesture alone. A pointer gesture is the right one to hold
        // this claim on: it ends when the hand lets go, where a wheel ends on a
        // quiet timer that would land its own commit inside any bracket long
        // enough to read the picture back.
        await app.nativeDragElementWithoutRelease(
          `${ROW} [aria-label="Reveal slot 1"]`,
          { selector: `${ROW} [aria-label="Reveal slot 5"]` },
        );
        let held: DotsReading | null = null;
        let live: number | null = null;
        let committed = -1;
        const census = await app.motionCensus(async () => {
          live = await publishedOffset(app);
          held = await readDots(app);
          committed = await committedOffset(app);
        }, 0);

        const during = held as unknown as DotsReading;
        note(
          `${summarizeMotionCensus("held scrub", census)} — ` +
            `published=${(live as number | null)?.toFixed(4)} ` +
            `committed=${committed}px states=${during.states.join(",")}`,
        );
        expect(committed, "the store has not heard about the gesture yet").toBe(
          0,
        );
        expect(
          during.states[4],
          "and the chips already say the last slot is on screen",
        ).toBe("outlined");
        expect(
          during.states,
          "which is a different picture from the one React rendered",
        ).not.toEqual(before.states);
        // The claim the census carries: the picture moved without one store
        // notify, so no render can have produced it.
        expect(
          census.notifies,
          "the chips repainted with zero store notifies — a DOM projection, not a render",
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
    "a scrub across the chips previews each one and commits once at release",
    async () => {
      const app = await launchTugApp({ testName: "at0461-flow-dots" });
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
          const during = await readDots(app);
          const committed = await committedOffset(app);
          note(
            `under the hand: published=${live?.toFixed(4)} committed=${committed}px ` +
              `states=${during.states.join(",")}`,
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
            during.states[4],
            "while the chips already read the slot under the finger",
          ).toBe("outlined");

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
          "the release is where the deck now stands — the last chip's reveal",
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
    "a live card drag takes the dots out of the pointer's way",
    async () => {
      const app = await launchTugApp({ testName: "at0461-flow-dots" });
      try {
        await openDeck(app, { cards: 3, cardWidth: SLIM_PX, layout: "flow" });

        const atRest = await pointerGate(app);
        note(`at rest: drag=${atRest.stamped} row=${atRest.row} chip=${atRest.chip}`);
        expect(atRest.stamped, "no drag, no stamp").toBe(false);
        expect(atRest.chip, "and the chips take the pointer as usual").toBe(
          "auto",
        );

        // A real card drag: the band becomes drop-zone country, and the dots
        // stand right in it.
        const dots = await boxOf(app, ROW);
        await app.nativeDragElementWithoutRelease(
          `.tug-pane[data-pane-id="p1"] .tug-pane-title-bar`,
          {
            x: Math.round(dots.left + dots.width / 2),
            y: Math.round(dots.top + dots.height / 2),
          },
        );
        try {
          await wait(120);
          const under = await pointerGate(app);
          note(
            `under the hand: drag=${under.stamped} row=${under.row} chip=${under.chip}`,
          );
          expect(
            under.stamped,
            "the channel stamps the drag on every registered element",
          ).toBe(true);
          expect(
            under.chip,
            "so the dots decline the pointer rather than swallowing the release",
          ).toBe("none");
        } finally {
          await app.nativeMouseUp({
            x: Math.round(dots.left + dots.width / 2),
            y: Math.round(dots.top + dots.height / 2),
          });
          await wait(AFTER_LAND_MS);
        }

        const after = await pointerGate(app);
        note(`after release: drag=${after.stamped} chip=${after.chip}`);
        expect(after.stamped, "the drag ending takes its stamp with it").toBe(
          false,
        );
        expect(after.chip, "and the chips are a target again").toBe("auto");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a sideways wheel scrolls the strip and commits where it came to rest",
    async () => {
      const app = await launchTugApp({ testName: "at0461-flow-dots" });
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
