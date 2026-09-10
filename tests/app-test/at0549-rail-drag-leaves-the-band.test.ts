/**
 * at0549-rail-drag-leaves-the-band.test.ts — a sidebar card carried across the
 * band leaves the band alone.
 *
 * A rail card can only land in a rail. The drop-zone engine has always said so
 * — `enumerateDropZones` finds the dragged pane's own rail and returns before
 * the slot walk — but two readers beside the engine did not know which kind of
 * card was in the air, and both answered for the wrong one. The held-open
 * slots showed their numbered badges under a bare `data-carrying`, and
 * `autoscrollTargetFor` fell through the rails and the columns to the flow
 * strip unconditionally. So dragging a sidebar card from one deck edge to the
 * other lit every empty content slot and scrolled the content strip to its
 * end, offering a landing that could not happen and moving cards the reader
 * never touched.
 *
 * The marker now carries the kind — `data-carrying="rail"` or `"card"` — and
 * the autoscroll decides once whether the dragged pane is a rail member before
 * it asks any strip.
 *
 * What this file pins, with a real pointer on a flow deck whose strip overflows:
 *
 *   1. **The band scrolls for a content card.** The control, run first and on
 *      the same fixture: a content card held at the band's right edge advances
 *      the flow offset, and every held-open slot shows its number. Without it
 *      the assertions below would pass on a deck that never scrolled at all.
 *   2. **The band is inert for a rail card.** The same hold, at the same point,
 *      with the rail's own card under the hand: the flow offset stays where it
 *      was for the whole hold, and no slot badge is shown. The canvas says
 *      `rail`, which is what both facts read.
 *
 * The offset read is the CUSTOM PROPERTY rather than the store's number: the
 * autoscroll writes per frame onto `--tug-imposer-flow-offset` and commits to
 * the store only at the release, so the store would answer `0` through a scroll
 * that really happened.
 *
 * Declaring the engine and the badge's own stylesheet rather than the canvas.
 * The rule under test is the drop vocabulary's — a place reacts to a drag only
 * when the drag could land in it, which is `enumerateDropZones`'s line drawn
 * everywhere else — and a change to that vocabulary is what would break this
 * file. `deck-canvas.tsx`, where the two readers live, is at the selection
 * budget's accepted fan-out ceiling and its recorded number may be paid down
 * but never raised, so naming it here is not available; at0457 already names
 * it, and this arc's diff selects this file through the stylesheet anyway.
 *
 * @covers tugdeck/src/lib/drop-zones.ts
 * @covers tugdeck/src/components/chrome/slot-vacancy.css
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 90_000;

/** Room past the settle attribute clearing for the tween's own tail. */
const SETTLE_TAIL_MS = 900;
/** How long the hand holds at the band's edge. The strip advances on the
 *  gesture's own rAF while the pointer does nothing, so this is the whole of
 *  the scroll either phase gets. */
const HOLD_MS = 400;
/** Inside `AUTOSCROLL_MARGIN_PX` of the band's far edge, with room to spare. */
const INSIDE_MARGIN_PX = 20;

const RAIL_WIDTH = 420;
/** Wide enough that five of them make a strip longer than any band this
 *  harness opens — the same reason at0454's fixture is built this way. */
const PANE_WIDTH = 420;
const CONTENT_IDS = ["A", "B", "C", "D", "E"];
const RAIL_PANE = "pRail";
/** The one slot of the six no card stands in, so there is a badge to look at. */
const VACANT_SLOT = 5;

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

/** Five content cards in a six-up FLOW strip, and one sidebar card pinned to
 *  the right edge. The strip is longer than the band, so the band has somewhere
 *  to scroll to; slot 6 is empty, so a badge has somewhere to show. */
function deckShape() {
  return {
    cards: [
      ...CONTENT_IDS.map((id) => ({
        id,
        componentId: "hello",
        title: `Card ${id}`,
        closable: true,
      })),
      { id: "L", componentId: "layout", title: "Layout", closable: true },
    ],
    panes: [
      ...CONTENT_IDS.map((id, index) => ({
        id: `p${index + 1}`,
        position: { x: 40, y: 40 },
        size: { width: PANE_WIDTH, height: 400 },
        cardIds: [id],
        activeCardId: id,
        title: "",
        acceptsFamilies: ["maker"],
        slot: index,
      })),
      {
        id: RAIL_PANE,
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
      kind: "six-up",
      layout: "flow",
      sidebars: { layout: { side: "right" } },
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

/** The flow strip's offset as the canvas is DRAWING it — the property the
 *  autoscroll writes per frame, not the store's committed number. */
function flowOffsetDrawn(app: App): Promise<number> {
  return app.evalJS<number>(
    `parseFloat(getComputedStyle(
       document.querySelector("[data-deck-canvas-background]")
     ).getPropertyValue("--tug-imposer-flow-offset")) || 0`,
  );
}

/** What the canvas says is in the air, and whether the empty slot's number is
 *  showing — the two facts the marker's value now decides. */
function carryReading(
  app: App,
): Promise<{ carrying: string | null; badgeOpacity: string | null }> {
  return app.evalJS<{ carrying: string | null; badgeOpacity: string | null }>(
    `(function () {
      var canvas = document.querySelector("[data-deck-canvas-background]");
      var tile = document.querySelector(
        '.tug-slot-vacancy[data-vacant-slot="${VACANT_SLOT}"]');
      var badge = tile === null ? null : tile.querySelector('[data-slot="tug-slot"]');
      return {
        carrying: canvas.getAttribute("data-carrying"),
        badgeOpacity: badge === null ? null : window.getComputedStyle(badge).opacity
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

/** Seed the fixture and answer the point at the band's right edge — inside the
 *  autoscroll margin, where a hold advances whatever strip is askable there.
 *  Measured BEFORE any drag: the rail's frame travels with the hand in the
 *  second phase, and its resting left edge is where the band ends. */
async function seedAndFindTheBandsEdge(app: App): Promise<{ x: number; y: number }> {
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `document.querySelectorAll('.tug-pane[data-rail-side="right"]').length === 1`,
    { timeoutMs: 8_000 },
  );
  await settled(app);
  const rail = (await rectOf(app, frame(RAIL_PANE))) as Rect;
  const canvas = (await rectOf(app, "[data-deck-canvas-background]")) as Rect;
  return {
    x: Math.round(rail.left - INSIDE_MARGIN_PX),
    y: Math.round((canvas.top + canvas.bottom) / 2),
  };
}

describe.skipIf(!SHOULD_RUN)(
  "at0549 — a sidebar card carried across the band leaves the band alone",
  () => {
    test(
      "the band scrolls and numbers itself for a content card, and does neither for a rail card",
      async () => {
        const app = await launchTugApp({
          testName: "at0549-rail-drag-leaves-the-band",
        });
        try {
          // ── 1. The control: a content card at the band's edge scrolls it. ──
          const edge = await seedAndFindTheBandsEdge(app);
          expect(await flowOffsetDrawn(app), "the strip starts at rest").toBe(0);

          await app.nativeDragElementWithoutRelease(titleBar("p1"), edge);
          await wait(HOLD_MS);
          const withCard = await carryReading(app);
          const cardOffset = await flowOffsetDrawn(app);
          note(
            `content card held at the band's edge (${edge.x}, ${edge.y}): ` +
              `carrying=${withCard.carrying} badge opacity=${withCard.badgeOpacity} ` +
              `flow offset ${cardOffset.toFixed(1)}`,
          );
          expect(withCard.carrying, "the canvas says a content card is in the air").toBe("card");
          expect(withCard.badgeOpacity, "so the empty slot shows its number").toBe("1");
          expect(cardOffset, "and the band it could land in scrolls under the hold").toBeGreaterThan(0);

          await app.nativeMouseUp(edge);
          await wait(SETTLE_TAIL_MS);

          // ── 2. The subject: the same hold, with a rail card under the hand. ──
          // Re-seeded rather than continued: the control's release moved a card,
          // and the two phases have to be asking about the same deck.
          const railEdge = await seedAndFindTheBandsEdge(app);
          const before = await flowOffsetDrawn(app);
          expect(before, "the re-seeded strip is at rest again").toBe(0);

          await app.nativeDragElementWithoutRelease(titleBar(RAIL_PANE), railEdge);
          await wait(HOLD_MS);
          const withRail = await carryReading(app);
          const railOffset = await flowOffsetDrawn(app);
          note(
            `rail card held at the same point: carrying=${withRail.carrying} ` +
              `badge opacity=${withRail.badgeOpacity} flow offset ${railOffset.toFixed(1)}`,
          );
          expect(withRail.carrying, "the canvas says a RAIL card is in the air").toBe("rail");
          expect(
            withRail.badgeOpacity,
            "so no slot advertises a landing the card cannot make",
          ).toBe("0");
          expect(
            railOffset,
            "and the band, which the card cannot land in, has not moved",
          ).toBe(before);

          await app.nativeMouseUp(railEdge);
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
