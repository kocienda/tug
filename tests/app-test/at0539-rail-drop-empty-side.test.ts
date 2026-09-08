/**
 * at0539-rail-drop-empty-side.test.ts — a rail card dropped on a deck edge
 * with no rail on it lands there, alone.
 *
 * A side with no pinned sidebar cards has no DOM box: its inset is 0 and
 * nothing stands in it, so the drop-zone engine — which reads every place off
 * the frames — had nothing to read a zone from, and the empty edge was not in
 * a rail card's vocabulary at all. The canvas now holds the edge open while a
 * rail card is in the air, on the pattern a vacant slot set: a
 * `.tug-rail-vacancy` tile at the rail's anchor and the width the card's own
 * rail takes, inert to the pointer, read by `enumerate` as that side's one
 * position at index 0, and shown under `data-carrying`.
 *
 * What this file pins, with a real pointer:
 *
 *   1. **The empty edge indicates, at the frame the card will take.** With
 *      the left rail's top member carried over the empty right edge, the
 *      outline stands on the right edge at the left rail's width — which is
 *      the width the arriving card's rail will have — and the tile that
 *      promised it is on the canvas under `data-carrying`.
 *   2. **The release crosses in one commit.** One store notify, at most one
 *      settle arm.
 *   3. **The card is pinned there, alone.** Its side is right, the right
 *      rail's order is the card alone, the left rail's order no longer names
 *      it, and the card's frame stands on the right edge at the width the
 *      outline drew.
 *
 * The open question from the brief — whether a split destination's strip
 * autoscrolls for a foreign card — is answered by reading `autoscrollTargetFor`
 * rather than by a drag here: it asks by RAIL, not by the card's own side, so
 * a foreign card held at an overflowing split destination's edge scrolls that
 * strip exactly as one of its own members would. A destination that does not
 * overflow on its own — two standing members receiving a third — does not
 * scroll, and the three overflow tiles the arrival is offered are still all
 * askable, because the tiles' hit bands cover the run. Nothing in this arc
 * changes that, and this note is the record of it.
 *
 * Declaring the engine and the tile's own stylesheet: the gesture and the
 * canvas are at the selection budget's fan-out ceiling and at0457 names both,
 * but nothing else in the corpus claims `rail-vacancy.css`, and the outline
 * this file reads stands where that file puts the tile.
 *
 * @covers tugdeck/src/lib/drop-zones.ts
 * @covers tugdeck/src/components/chrome/rail-vacancy.css
 */

import { describe, expect, test } from "bun:test";

import {
  launchTugApp,
  note,
  summarizeMotionCensus,
  type App,
} from "./_harness";
import { ZONE_INDICATOR_INSET_PX } from "../../tugdeck/src/lib/drop-zone-indicator";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 90_000;

/** Geometry tolerance, in px. */
const EPSILON = 3;
const AFTER_LAND_MS = 900;
const SETTLE_TAIL_MS = 900;

const RAIL_WIDTH = 420;
const PANES: Record<string, string> = {
  overview: "pOverview",
  tripwires: "pTripwires",
};

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

/** One split rail on the left, overview over tripwires; nothing on the right. */
function deckShape() {
  const pane = (id: string, cardId: string, title: string) => ({
    id,
    position: { x: 0, y: 0 },
    size: { width: RAIL_WIDTH, height: 900 },
    cardIds: [cardId],
    activeCardId: cardId,
    title,
    acceptsFamilies: [],
  });
  return {
    cards: [
      { id: "O", componentId: "overview", title: "Overview", closable: true },
      { id: "T", componentId: "tripwires", title: "Tripwires", closable: true },
    ],
    panes: [pane(PANES.overview, "O", "Overview"), pane(PANES.tripwires, "T", "Tripwires")],
    activePaneId: PANES.overview,
    imposition: {
      kind: "three-up",
      sidebars: {
        overview: { side: "left" },
        tripwires: { side: "left" },
      },
      rails: {
        left: { mode: "split", order: ["overview", "tripwires"] },
      },
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

function railInStore(
  app: App,
  side: "left" | "right",
): Promise<{ mode?: string; order?: string[] }> {
  return app.evalJS<{ mode?: string; order?: string[] }>(
    `(((window.tugdeck.diag.getDeckState().imposition.rails || {})["${side}"]) || {})`,
  );
}

function sidebarSideOf(app: App, componentId: string): Promise<string | null> {
  return app.evalJS<string | null>(
    `(function () {
      var s = (window.tugdeck.diag.getDeckState().imposition.sidebars || {})["${componentId}"];
      return s === undefined ? null : s.side;
    })()`,
  );
}

function pinnedPanesOn(app: App, side: "left" | "right"): Promise<string[]> {
  return app.evalJS<string[]>(
    `Array.from(document.querySelectorAll('.tug-pane[data-rail-side="${side}"]'))
      .map(function (el) { return el.getAttribute("data-pane-id"); })`,
  );
}

async function settled(app: App): Promise<void> {
  await app.waitForCondition<boolean>(
    `document.querySelector("[data-imposer-settling]") === null`,
    { timeoutMs: 8_000 },
  );
  await wait(SETTLE_TAIL_MS);
}

describe.skipIf(!SHOULD_RUN)(
  "at0539 — a rail card dropped on an empty deck edge lands there, alone",
  () => {
    test(
      "the empty right edge holds a strip open, indicates at the card's width, and takes the card",
      async () => {
        const app = await launchTugApp({ testName: "at0539-rail-drop-empty-side" });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: deckShape(), focusCardId: "O" });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll('.tug-pane[data-rail-split]').length === 2`,
            { timeoutMs: 8_000 },
          );
          await settled(app);

          expect(await pinnedPanesOn(app, "right"), "nothing stands on the right").toEqual([]);
          const canvas = (await rectOf(app, "[data-deck-canvas-background]")) as Rect;
          const overviewBefore = (await rectOf(app, frame(PANES.overview))) as Rect;
          const railWidth = overviewBefore.width;

          // ── 1. Carry the left rail's top member over the empty right edge. ──
          const target = {
            x: Math.round(canvas.right - railWidth / 2),
            y: Math.round((canvas.top + canvas.bottom) / 2),
          };
          await app.nativeDragElementWithoutRelease(titleBar(PANES.overview), target);
          const tile = await rectOf(app, '.tug-rail-vacancy[data-vacant-rail="right"]');
          const carrying = await app.evalJS<boolean>(
            `document.querySelector("[data-deck-canvas-background]").hasAttribute("data-carrying")`,
          );
          const drawn = await rectOf(app, ".tug-drop-zone-indicator");
          note(
            `carrying overview over the empty right edge: tile ${JSON.stringify(tile)}, outline ${JSON.stringify(drawn)}, canvas right ${canvas.right.toFixed(1)}, rail width ${railWidth.toFixed(1)}`,
          );
          expect(carrying, "the canvas says a card is in the air").toBe(true);
          expect(tile, "the right edge holds a strip open").not.toBeNull();
          expect(Math.abs(tile!.right - canvas.right), "at the deck's edge").toBeLessThanOrEqual(EPSILON);
          expect(Math.abs(tile!.width - railWidth), "at the card's own rail width").toBeLessThanOrEqual(EPSILON);
          expect(drawn, "and the edge indicates").not.toBeNull();
          const slack = ZONE_INDICATOR_INSET_PX + EPSILON;
          expect(
            Math.abs(drawn!.left - (canvas.right - railWidth)),
            "the outline's left edge is the strip's",
          ).toBeLessThanOrEqual(slack);
          expect(
            Math.abs(drawn!.right - canvas.right),
            "and its right edge is the deck's",
          ).toBeLessThanOrEqual(slack);

          // ── 2. The release crosses in one commit. ──
          const census = await app.motionCensus(async () => {
            await app.nativeMouseUp(target);
          }, AFTER_LAND_MS);
          note(summarizeMotionCensus("empty-side release", census));
          expect(census.notifies, "side and both orders land as one commit").toBe(1);
          expect(census.arms, "so the settle arms once").toBeLessThanOrEqual(1);
          await settled(app);

          // ── 3. The card is pinned there, alone. ──
          expect(await sidebarSideOf(app, "overview"), "overview now stands on the right").toBe("right");
          const right = await railInStore(app, "right");
          const left = await railInStore(app, "left");
          note(`after: right ${JSON.stringify(right)}, left ${JSON.stringify(left)}`);
          expect(right.order, "the right rail is the card alone").toEqual(["overview"]);
          expect(left.order, "and the left rail no longer names it").toEqual(["tripwires"]);
          expect(await pinnedPanesOn(app, "right"), "one frame stands on the right").toEqual([PANES.overview]);
          expect(await pinnedPanesOn(app, "left"), "one on the left").toEqual([PANES.tripwires]);
          const overviewAfter = (await rectOf(app, frame(PANES.overview))) as Rect;
          note(`landed: overview ${JSON.stringify(overviewAfter)}`);
          expect(
            Math.abs(overviewAfter.right - canvas.right),
            "the card's frame stands on the right edge",
          ).toBeLessThanOrEqual(EPSILON);
          // The width is not pinned to the outline's: the tile promised the
          // card's own rail width, and the rail allocator re-shares the deck's
          // width between two standing rails the moment both sides are held,
          // so the landed frame may differ by the allocator's share.
          expect(
            await app.evalJS<number>(`document.querySelectorAll(".tug-rail-vacancy").length`),
            "and with both sides held, no edge is held open",
          ).toBe(0);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
