/**
 * at0549-card-drag-leaves-the-rail.test.ts — a content card carried over a rail
 * leaves the rail alone.
 *
 * The mirror of at0549-rail-drag-leaves-the-band, and the same defect read from
 * the other side. A content card can only land in a column or in the band; the
 * drop-zone engine offers it `column-index`, `slot` and `tab-bar` zones and
 * never a `rail-index`. But the empty deck edge rang its hairline under a bare
 * `data-carrying`, and `autoscrollTargetFor` asked the rails first without ever
 * looking at what was in the air — so a content card held over an overflowing
 * rail scrolled that rail's members under the reader's hand, and rang an edge
 * it could not land on.
 *
 * What this file pins, with a real pointer on an overflowing right rail:
 *
 *   1. **The rail scrolls for one of its own.** The control, run first and on
 *      the same fixture: the rail's top member held at the run's bottom edge
 *      advances the rail's strip, and the empty left edge shows its hairline.
 *      Without it the assertions below would pass on a rail that never
 *      scrolled at all.
 *   2. **The rail is inert for a content card.** The same hold, at the same
 *      point, with a content card under the hand: the rail's offset stays where
 *      it was for the whole hold, and the empty edge draws nothing. The canvas
 *      says `card`, which is what both facts read.
 *
 * The offset read is the CUSTOM PROPERTY rather than the store's number, for
 * the reason at0537 reads it that way: the autoscroll writes per frame and
 * commits at the release, so the store would answer `0` through a scroll that
 * really happened. The ring is read as its computed `box-shadow` rather than by
 * the selector, because the question is what the reader SEES.
 *
 * Declaring the engine and the tile's own stylesheet rather than the canvas,
 * for at0539's reason and at this file's turn of it: the rule under test is
 * the drop vocabulary's, `deck-canvas.tsx` is at the selection budget's
 * accepted fan-out ceiling with its number ratcheted against a rise, and this
 * arc's diff selects this file through `rail-vacancy.css` regardless.
 *
 * @covers tugdeck/src/lib/drop-zones.ts
 * @covers tugdeck/src/components/chrome/rail-vacancy.css
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 90_000;

/** Room past the settle attribute clearing for the tween's own tail. */
const SETTLE_TAIL_MS = 900;
/** How long the hand holds at the run's edge. The strip advances on the
 *  gesture's own rAF while the pointer does nothing. */
const HOLD_MS = 400;
/** Inside `AUTOSCROLL_MARGIN_PX` of the run's foot, with room to spare. */
const INSIDE_MARGIN_PX = 30;

const RAIL_WIDTH = 420;
const PANE_WIDTH = 420;
/** Five sidebar cards, for at0537's reason: the standing is decided by the
 *  members' 240px floors against a run this harness opens a little over 1000px
 *  tall, so three share it comfortably and it takes five to overflow. */
const RAIL_COMPONENTS = ["layout", "jots", "overview", "cards", "tripwires"];
const RAIL_PANES: Record<string, string> = {
  layout: "pLayout",
  jots: "pJots",
  overview: "pOverview",
  cards: "pCards",
  tripwires: "pTripwires",
};
const CONTENT_PANE = "p1";

const frame = (paneId: string): string => `.tug-pane[data-pane-id="${paneId}"]`;
const titleBar = (paneId: string): string => `${frame(paneId)} .tug-pane-title-bar`;

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

/** Five sidebar cards split down the right rail so it overflows, one content
 *  card in a three-up, and nothing on the left — so the left edge is held open
 *  and has a hairline to show or withhold. */
function deckShape() {
  const railPane = (id: string, cardId: string, title: string) => ({
    id,
    position: { x: 0, y: 0 },
    size: { width: RAIL_WIDTH, height: 900 },
    cardIds: [cardId],
    activeCardId: cardId,
    title,
    acceptsFamilies: [],
  });
  const titles: Record<string, string> = {
    layout: "Layout",
    jots: "Jots",
    overview: "Overview",
    cards: "Cards",
    tripwires: "Tripwires",
  };
  const sidebars: Record<string, { side: "right" }> = {};
  for (const component of RAIL_COMPONENTS) sidebars[component] = { side: "right" };
  return {
    cards: [
      ...RAIL_COMPONENTS.map((component) => ({
        id: component,
        componentId: component,
        title: titles[component],
        closable: true,
      })),
      { id: "A", componentId: "hello", title: "Card A", closable: true },
    ],
    panes: [
      ...RAIL_COMPONENTS.map((component) =>
        railPane(RAIL_PANES[component], component, titles[component]),
      ),
      {
        id: CONTENT_PANE,
        position: { x: 40, y: 40 },
        size: { width: PANE_WIDTH, height: 400 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
        slot: 0,
      },
    ],
    activePaneId: CONTENT_PANE,
    imposition: {
      kind: "three-up",
      sidebars,
      rails: { right: { mode: "split", order: [...RAIL_COMPONENTS] } },
    },
    hasFocus: true,
  };
}

const RECT_JS = (selector: string): string =>
  `(function () {
    var el = document.querySelector('${selector}');
    if (el === null) return null;
    var r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
  })()`;

function rectOf(app: App, selector: string): Promise<Rect | null> {
  return app.evalJS<Rect | null>(RECT_JS(selector));
}

/** The right rail's strip offset as the canvas is DRAWING it. */
function railOffsetDrawn(app: App): Promise<number> {
  return app.evalJS<number>(
    `parseFloat(getComputedStyle(
       document.querySelector("[data-deck-canvas-background]")
     ).getPropertyValue("--tug-rail-right-offset")) || 0`,
  );
}

/** What the canvas says is in the air, and whether the held-open left edge is
 *  drawing its hairline — read as ink rather than as a selector match. */
function carryReading(
  app: App,
): Promise<{ carrying: string | null; ringShadow: string | null }> {
  return app.evalJS<{ carrying: string | null; ringShadow: string | null }>(
    `(function () {
      var canvas = document.querySelector("[data-deck-canvas-background]");
      var tile = document.querySelector('.tug-rail-vacancy[data-vacant-rail="left"]');
      return {
        carrying: canvas.getAttribute("data-carrying"),
        ringShadow: tile === null ? null : window.getComputedStyle(tile).boxShadow
      };
    })()`,
  );
}

async function settled(app: App): Promise<void> {
  await app.waitForCondition<boolean>(
    `document.querySelector("[data-imposer-settling]") === null`,
    { timeoutMs: 8_000 },
  );
  await wait(SETTLE_TAIL_MS);
}

/** Seed the fixture and answer the point inside the right rail's column at the
 *  run's foot — inside the autoscroll margin, where a hold advances whatever
 *  strip is askable there. Measured BEFORE any drag: a dragged frame travels
 *  with the hand, and this point has to be the same one in both phases. */
async function seedAndFindTheRunsFoot(app: App): Promise<{ x: number; y: number }> {
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `document.querySelectorAll('.tug-pane[data-rail-split]').length === 5`,
    { timeoutMs: 8_000 },
  );
  await settled(app);
  const rail = (await rectOf(app, frame(RAIL_PANES.layout))) as Rect;
  const canvas = (await rectOf(app, "[data-deck-canvas-background]")) as Rect;
  return {
    x: Math.round(rail.left + rail.width / 2),
    y: Math.round(canvas.bottom - INSIDE_MARGIN_PX),
  };
}

describe.skipIf(!SHOULD_RUN)(
  "at0549 — a content card carried over a rail leaves the rail alone",
  () => {
    test(
      "the rail scrolls and rings for one of its own, and does neither for a content card",
      async () => {
        const app = await launchTugApp({
          testName: "at0549-card-drag-leaves-the-rail",
        });
        try {
          // ── 1. The control: a rail card at the run's foot scrolls the rail. ──
          const foot = await seedAndFindTheRunsFoot(app);
          expect(await railOffsetDrawn(app), "the rail starts at rest").toBe(0);

          await app.nativeDragElementWithoutRelease(titleBar(RAIL_PANES.layout), foot);
          await wait(HOLD_MS);
          const withRail = await carryReading(app);
          const railOffset = await railOffsetDrawn(app);
          note(
            `rail card held at the run's foot (${foot.x}, ${foot.y}): ` +
              `carrying=${withRail.carrying} ring=${withRail.ringShadow} ` +
              `rail offset ${railOffset.toFixed(1)}`,
          );
          expect(withRail.carrying, "the canvas says a rail card is in the air").toBe("rail");
          expect(withRail.ringShadow, "so the empty edge shows its hairline").not.toBe("none");
          expect(railOffset, "and the rail it could land in scrolls under the hold").toBeGreaterThan(0);

          await app.nativeMouseUp(foot);
          await wait(SETTLE_TAIL_MS);

          // ── 2. The subject: the same hold, with a content card under the hand. ──
          // Re-seeded rather than continued: the control's release reordered the
          // rail, and the two phases have to be asking about the same deck.
          const cardFoot = await seedAndFindTheRunsFoot(app);
          const before = await railOffsetDrawn(app);
          expect(before, "the re-seeded rail is at rest again").toBe(0);

          await app.nativeDragElementWithoutRelease(titleBar(CONTENT_PANE), cardFoot);
          await wait(HOLD_MS);
          const withCard = await carryReading(app);
          const cardOffset = await railOffsetDrawn(app);
          note(
            `content card held at the same point: carrying=${withCard.carrying} ` +
              `ring=${withCard.ringShadow} rail offset ${cardOffset.toFixed(1)}`,
          );
          expect(withCard.carrying, "the canvas says a CONTENT card is in the air").toBe("card");
          expect(
            withCard.ringShadow,
            "so no deck edge advertises a landing the card cannot make",
          ).toBe("none");
          expect(
            cardOffset,
            "and the rail, which the card cannot land in, has not moved",
          ).toBe(before);

          await app.nativeMouseUp(cardFoot);
          await wait(SETTLE_TAIL_MS);
          expect(
            await app.evalJS<boolean>(
              `document.querySelector("[data-carrying]") !== null`,
            ),
            "the drag is over, so nothing is carrying",
          ).toBe(false);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
