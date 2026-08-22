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
 *      the kind defines — occupied or not, and an empty one holding its room
 *      rather than collapsing out of the drawing — centered on the canvas and
 *      standing on the same baseline the host's build stamps use.
 *   2. **Centering is the clearance.** The drawing clears the bottom-left
 *      corner the host reserves for those stamps by construction rather than by
 *      a stated number: a share of the canvas, centered, under a ceiling.
 *   3. **The bracket says which part of the strip is on screen.** It covers the
 *      share of the strip the band shows and stands where that share begins, and
 *      scrolling moves it without changing its size.
 *  3a. **And the veils say it a second time, loudly.** The parts of the strip
 *      the band does not show are dimmed toward the canvas, so what is in view
 *      is simply the bright part. The bracket alone was a hairline that had to
 *      be traced before it could be read. Both are `calc()` over the same two
 *      numbers, so the assertion is that the veils AGREE with the bracket — a
 *      second drawing that could drift is worse than one that was hard to read.
 *  3b. **The reader's own card is marked, and it is the only accent spent.**
 *      Where the reader is LOOKING and which card the reader is IN are
 *      different facts: the first is the band, in neutral ink, and the second
 *      is one segment at `filled`. The assertion is on `data-state`, which is
 *      the fact both forms of the slot carry, and on there being exactly one.
 *   4. **Clicking a segment CENTERS its slot in the band**, in one commit the
 *      settle animates as one crossing — and a slot standing wholly on screen
 *      already travels too. That is the whole difference from the reveal an
 *      activation does: a reveal moves the least it can and would answer the
 *      same click differently depending on where the band happened to stand,
 *      while naming a place has to put the reader at it. **And the arrival is
 *      rung**, the same flash the chord's is: a click names a place, so it
 *      owes the same answer, and the fact that the reader is looking at the
 *      instrument is no reason to stay quiet about the deck.
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
 *  10. **The segments wear the ink of the ground they stand on.** A `TugSlot`'s
 *      own tokens name a control on a control surface, and this mount stands on
 *      the deck canvas — a dark band in every theme, the light ones included —
 *      where control ink authored for a light control surface simply vanishes.
 *      So the strip hands in the CARD pairing through the knobs the primitive
 *      publishes, and this asserts the segment actually REACHED them. It is the
 *      one failure the theme-contrast audit cannot see: a drifted knob name
 *      falls back to the control tint silently, and the pairings table goes on
 *      passing while the drawing goes invisible.
 *
 * @covers tugdeck/src/components/chrome/flow-strip.tsx
 * @covers tugdeck/src/components/chrome/flow-strip.css
 * @covers tugdeck/src/components/tugways/tug-slot-layout.tsx
 * @covers tugdeck/src/components/tugways/tug-slot-layout.css
 * @covers tugdeck/src/components/tugways/tug-slot.css
 * @covers tugdeck/src/lib/flash-pane-border.ts
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
    "a slot with no card is rendered, and holds its room",
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
        // Rendered AND drawn. A slot with no card in it is a PLACE, not an
        // absence: it holds a card's width of strip open, so a card assigned to
        // slot 5 stands at slot 5 rather than sliding up to where slot 3 would
        // have been. The strip used to skip them, which drew a five-up deck
        // with two cards as `1|2` and made a chord naming slot 5 move its card
        // nowhere the eye could follow.
        expect(
          drawn.every((width) => width > 0),
          "all five slots are drawn — the empty ones hold their room",
        ).toBe(true);
        // And they hold the room the cards beside them take, not some other
        // number: the reserved extent is the widest card in the chain
        // (`vacancyExtent`), so on a deck of equal cards every segment is the
        // same width and the map reads evenly.
        const spread = Math.max(...drawn) - Math.min(...drawn);
        expect(
          spread,
          "an empty place is drawn the size of the cards it stands among",
        ).toBeLessThanOrEqual(1);
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
    "clicking a segment centers its slot, and a slot already in view still travels",
    async () => {
      const app = await launchTugApp({ testName: "at0461-flow-strip" });
      try {
        await openDeck(app, { cards: 5, cardWidth: SLIM_PX, layout: "flow" });
        const band = await bandWidth(app);
        const stripWidth = 5 * SLIM_PX + 4 * GAP_PX;
        /** Where the strip stands with slot `k` in the middle of the band. */
        const centered = (k: number): number =>
          Math.min(
            Math.max(0, k * (SLIM_PX + GAP_PX) + SLIM_PX / 2 - band / 2),
            stripWidth - band,
          );

        // The whole difference between centering and revealing, measured on
        // the one slot where the two rules disagree most plainly. The deck
        // starts home, and slot 2 stands wholly inside the band there — so the
        // minimal-move rule would hand back offset 0 and the click would do
        // nothing at all. Naming a place has to put the reader at it.
        expect(await committedOffset(app), "the strip starts home").toBe(0);
        const slot2Left = SLIM_PX + GAP_PX;
        expect(
          slot2Left + SLIM_PX <= band,
          "slot 2 is wholly on screen at home, so a reveal would sit still",
        ).toBe(true);

        const census = await app.motionCensus(async () => {
          await app.nativeClickAtElement(
            `${ROW} [aria-label="Go to slot 2"]`,
          );
          await wait(AFTER_LAND_MS);
        });

        const landed = await committedOffset(app);
        note(
          `${summarizeMotionCensus("segment click, slot already shown", census)} — ` +
            `offset 0 -> ${Math.round(landed)}px, expected ${Math.round(centered(1))}px`,
        );
        expect(
          landed,
          "a slot already in the band centers anyway",
        ).toBeCloseTo(centered(1), 0);
        expect(
          landed,
          "which is a real move, not the same number back",
        ).toBeGreaterThan(1);
        expect(census.notifies, "in one commit").toBe(1);
        expect(
          census.arms,
          "which the settle animates as one crossing",
        ).toBeLessThanOrEqual(1);

        // And a slot the band is not showing at all travels to the same place
        // by the same rule — one arithmetic, whatever the reader can see.
        // The ring is read INSIDE the census block, first thing after the
        // settle. The flash outlives the tween several times over but not
        // forever, and every assertion below is a harness round trip — read
        // last, this would be measuring how long the reads took.
        let rung: string[] = [];
        const again = await app.motionCensus(async () => {
          await app.nativeClickAtElement(
            `${ROW} [aria-label="Go to slot 3"]`,
          );
          await wait(AFTER_LAND_MS);
          rung = await app.evalJS<string[]>(
            `Array.from(document.querySelectorAll(".tug-pane.tug-pane-flash"))
               .map(function (el) { return el.getAttribute("data-pane-id"); })`,
          );
        });
        const moved = await committedOffset(app);
        note(
          `${summarizeMotionCensus("segment click, slot off screen", again)} — ` +
            `offset ${Math.round(landed)} -> ${Math.round(moved)}px, ` +
            `expected ${Math.round(centered(2))}px`,
        );
        expect(
          moved,
          "clicking 3 puts the third slot in the middle of the band",
        ).toBeCloseTo(centered(2), 0);

        // And the arrival is ANSWERED, exactly as the chord's is. A segment
        // click names a place, so it owes the same "here it is" the keyboard
        // owes; the reader looking at the strip while they click it is not a
        // reason to stay silent, because what they need to find is on the
        // deck, not on the instrument.
        note(`the click rang: ${JSON.stringify(rung)}`);
        expect(
          rung,
          "the card standing in the clicked segment's slot is rung, and only it",
        ).toEqual(["p3"]);
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
          `${ROW} [aria-label="Go to slot 1"]`,
          { selector: `${ROW} [aria-label="Go to slot 5"]` },
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

        const box = await boxOf(app, `${ROW} [aria-label="Go to slot 5"]`);
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

        const last = `${ROW} [aria-label="Go to slot 5"]`;
        const census = await app.motionCensus(async () => {
          await app.nativeDragElementWithoutRelease(
            `${ROW} [aria-label="Go to slot 1"]`,
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
          "the release is where the deck now stands — the last segment " +
            "centered, which the clamp pins flush at the strip's far end",
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

  test(
    "the veils cover exactly what the bracket does not, and one segment is marked",
    async () => {
      const app = await launchTugApp({ testName: "at0461-flow-strip" });
      try {
        // A strip well past its band, so there is something for the veils to
        // cover. Two of the three slots are off screen at rest.
        await openDeck(app, { cards: 3, cardWidth: SLIM_PX, layout: "flow" });

        const read = await app.evalJS<{
          frameLeft: number;
          frameRight: number;
          bandLeft: number;
          bandRight: number;
          leadLeft: number;
          leadRight: number;
          trailLeft: number;
          trailRight: number;
          leadPointer: string;
          leadOpacity: number;
        }>(
          `(function () {
            var frame = document.querySelector(".flow-strip-frame")
              .getBoundingClientRect();
            var band = document.querySelector('[data-testid="flow-strip-band"]')
              .getBoundingClientRect();
            var lead = document.querySelector(".flow-strip-veil-leading");
            var trail = document.querySelector(".flow-strip-veil-trailing");
            var lb = lead.getBoundingClientRect();
            var tb = trail.getBoundingClientRect();
            return {
              frameLeft: frame.left, frameRight: frame.right,
              bandLeft: band.left, bandRight: band.right,
              leadLeft: lb.left, leadRight: lb.right,
              trailLeft: tb.left, trailRight: tb.right,
              leadPointer: getComputedStyle(lead).pointerEvents,
              leadOpacity: parseFloat(getComputedStyle(lead).opacity)
            };
          })()`,
        );
        note(
          `frame [${Math.round(read.frameLeft)}..${Math.round(read.frameRight)}] ` +
            `bracket [${Math.round(read.bandLeft)}..${Math.round(read.bandRight)}] ` +
            `veils [${Math.round(read.leadLeft)}..${Math.round(read.leadRight)}] + ` +
            `[${Math.round(read.trailLeft)}..${Math.round(read.trailRight)}]`,
        );

        // The three rectangles tile the drawing with no gap and no overlap:
        // veil, bracket, veil. Asserted against the BRACKET rather than
        // against the offset arithmetic, because the whole reason the veils
        // are safe to add is that they cannot say something different from
        // the readout that was already there.
        expect(
          Math.abs(read.leadLeft - read.frameLeft),
          "the leading veil starts where the drawing does",
        ).toBeLessThanOrEqual(1.5);
        expect(
          Math.abs(read.leadRight - read.bandLeft),
          "and ends where the bracket begins",
        ).toBeLessThanOrEqual(1.5);
        expect(
          Math.abs(read.trailLeft - read.bandRight),
          "the trailing veil starts where the bracket ends",
        ).toBeLessThanOrEqual(1.5);
        expect(
          Math.abs(read.trailRight - read.frameRight),
          "and ends where the drawing does",
        ).toBeLessThanOrEqual(1.5);
        // At rest the band sits at the strip's head, so the leading veil is
        // empty and the trailing one carries the whole covered part. A veil
        // that covered nothing at BOTH ends would satisfy the four bounds
        // above by drawing nothing at all.
        expect(
          read.trailRight - read.trailLeft,
          "and there is something covered to see",
        ).toBeGreaterThan(20);
        // A readout, like the bracket: drawn over the segments, so a hand
        // aiming at a card passes straight through it.
        expect(read.leadPointer, "the veil declines the pointer").toBe("none");
        // Veiled, not hidden. A veil at full opacity would erase the shape of
        // the arrangement, which is the other half of what the strip is for.
        expect(read.leadOpacity, "it dims rather than erases").toBeGreaterThan(0);
        expect(read.leadOpacity, "and leaves the drawing legible").toBeLessThan(1);

        // --- The marked segment. -------------------------------------------
        // `data-state` is the slot's own fact, carried by both of the
        // primitive's forms, and the one every arrangement assertion reads.
        const marked = await app.evalJS<string[]>(
          `Array.from(document.querySelectorAll(${JSON.stringify(SEGMENTS)}))
             .map(function (el) { return el.getAttribute("data-state"); })`,
        );
        note(`segment states: ${marked.join("|")}`);
        expect(
          marked.filter((s) => s === "filled").length,
          "exactly one segment is marked — the card the reader is in",
        ).toBe(1);
        // Card A is seeded focused into slot 0, so the mark is the first.
        expect(marked[0], "and it is the focused card's own slot").toBe("filled");
        expect(
          marked.slice(1).every((s) => s === "rest"),
          "every other slot rests",
        ).toBe(true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the segments take the ink of the surface they stand on",
    async () => {
      const app = await launchTugApp({ testName: "at0461-flow-strip" });
      try {
        await openDeck(app, { cards: 3, cardWidth: SLIM_PX, layout: "flow" });

        const ink = await app.evalJS<{
          background: string;
          color: string;
          want: { background: string; color: string };
          control: { background: string; color: string };
          quietOpacity: number;
        }>(
          `(function () {
            // A RESTING segment. The first is the reader's own slot and wears
            // the accent, which is a different claim (3b) and would read this
            // one as a drifted knob.
            var segment = Array.prototype.filter.call(
              document.querySelectorAll(${JSON.stringify(SEGMENTS)}),
              function (el) { return el.getAttribute("data-state") === "rest"; }
            )[0];
            var computed = getComputedStyle(segment);

            // Resolve the tokens through the live document rather than naming
            // colours here: a literal would be six answers, one per theme, and
            // the claim is about which TOKEN the segment reached, not which
            // colour that token happens to hold today.
            var probe = document.createElement("span");
            probe.style.position = "absolute";
            probe.style.visibility = "hidden";
            document.body.appendChild(probe);
            function resolve(surface, text) {
              probe.style.backgroundColor = "var(" + surface + ")";
              probe.style.color = "var(" + text + ")";
              var p = getComputedStyle(probe);
              return { background: p.backgroundColor, color: p.color };
            }
            var want = resolve(
              "--tug7-surface-card-primary-normal-titlebar-inactive",
              "--tug7-element-card-text-normal-title-inactive"
            );
            var control = resolve(
              "--tug7-surface-control-primary-tinted-action-rest",
              "--tug7-element-control-text-tinted-action-rest"
            );
            probe.remove();

            // The quiet register, read from a strip that is in it. Reached by
            // asking the stylesheet rather than by re-laying the deck out: the
            // rule is a single selector and the opacity is not animated.
            var quiet = 0;
            var strip = document.querySelector(${JSON.stringify(STRIP_ROOT)});
            var map = strip.querySelector(".flow-strip-map");
            var was = strip.getAttribute("data-overflow");
            strip.setAttribute("data-overflow", "false");
            quiet = parseFloat(getComputedStyle(map).opacity);
            strip.setAttribute("data-overflow", was);

            return {
              background: computed.backgroundColor,
              color: computed.color,
              want: want,
              control: control,
              quietOpacity: quiet
            };
          })()`,
        );

        note(
          `segment bg=${ink.background} fg=${ink.color} | ` +
            `card bg=${ink.want.background} fg=${ink.want.color} | ` +
            `control bg=${ink.control.background} fg=${ink.control.color} | ` +
            `quiet opacity=${ink.quietOpacity}`,
        );

        // A segment is a card seen small, so it wears the surface a card wears
        // standing on this canvas — a title bar's, at the weight of a card the
        // reader is not in. The knobs `tug-slot.css` publishes are how it says
        // so, and their `var()` fallbacks are why this has to be asserted: a
        // knob name that drifted would resolve silently back to the control
        // tint, and the pairings table would go on passing the audit while the
        // drawing went invisible in every light theme.
        expect(
          ink.background,
          "the segment's ground is the card title bar's, not a control's",
        ).toBe(ink.want.background);
        expect(
          ink.color,
          "and its number is that title bar's ink",
        ).toBe(ink.want.color);
        expect(
          ink.background,
          "which is emphatically not the control tint it would fall back to",
        ).not.toBe(ink.control.background);

        // And the quiet register is quiet, not absent. This was 0.55 when the
        // strip was a row of pager dots and the register only had to say "there
        // are five of these". The drawing carries the arrangement itself now, so
        // a floor rather than a number: a register that has to be hunted for is
        // not a register.
        expect(
          ink.quietOpacity,
          "a strip inside its band steps back without going faint",
        ).toBeGreaterThanOrEqual(0.75);
        expect(
          ink.quietOpacity,
          "and it does step back — the two registers are still two",
        ).toBeLessThan(1);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
