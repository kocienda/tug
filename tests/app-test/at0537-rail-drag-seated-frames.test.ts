/**
 * at0537-rail-drag-seated-frames.test.ts — a rail card in the air is measured
 * against the frames that stayed put.
 *
 * The drop-zone engine draws the tile a release would land in, and the promise
 * only holds if the tile is computed from where the place IS. Before this, the
 * engine measured a rail's run and strip off `getBoundingClientRect()` of
 * every member — the dragged one included, whose rect carries its drag
 * transform. The run's top was the minimum of the members' tops and the
 * strip's `x` and `width` came from the first member, so dragging a rail's
 * top card moved the whole strip with the hand; and because the gesture
 * re-enumerates on every autoscroll frame, holding the pointer at the run's
 * edge let the error grow for as long as the hand held. The screenshot that
 * opened this work showed the orange outline standing well above and to the
 * side of the frame it was meant to trace.
 *
 * The rule now: a place's run height is the deck's own measurement, and its
 * top and strip are read off a member that is NOT being dragged, by inverting
 * the pin the imposer wrote for that member. The seated frame carries the
 * strip's live offset, so a scrolled rail reads back scrolled.
 *
 * What this file pins, with a real pointer on an overflowing right rail:
 *
 *   1. **The indicator's strip is the seated members' strip.** The top member
 *      is dragged to the run's bottom edge AND inward by a hundred pixels, and
 *      held there while the strip autoscrolls. The outline's left edge and
 *      width are the seated members' — not the travelling card's, which is a
 *      hundred pixels away under the hand.
 *   2. **The indicator's tile is on the seated grid, at the last position.**
 *      With the strip advanced, the tile the outline draws is exactly
 *      `seated.top − j·stride + i·stride` for the seated member `j` and the
 *      last index `i` — the place the pointer is asking for, on the strip as
 *      it stands now.
 *   3. **The release lands where the outline said.** The card ends the gesture
 *      at the last position, and the rail is still split with all three
 *      members. Under the old measurement the pointer's band mapped to one
 *      index earlier, so the drop would have landed the card in the middle.
 *
 * Deliberately declaring the engine alone. The gesture (`tug-pane.tsx`) and
 * the host (`deck-canvas.tsx`) are at the selection budget's fan-out ceiling,
 * and at0457 already names both; the rule under test here is the engine's.
 *
 * @covers tugdeck/src/lib/drop-zones.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";
import { RAIL_SEAM_PX } from "../../tugdeck/src/lib/layout-imposer";
import { ZONE_INDICATOR_INSET_PX } from "../../tugdeck/src/lib/drop-zone-indicator";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 90_000;

/** Geometry tolerance, in px: sub-pixel rounding, never a real disagreement. */
const EPSILON = 3;
/** Room past the settle attribute clearing for the tween's own tail. */
const SETTLE_TAIL_MS = 900;
/** How far inward of the rail's centre the hand travels — far enough that a
 *  strip measured off the travelling card would visibly follow it. */
const INWARD_PX = 100;

const RAIL_WIDTH = 420;
const PANES: Record<string, string> = {
  layout: "pLayout",
  jots: "pJots",
  overview: "pOverview",
};

const frame = (paneId: string): string => `.tug-pane[data-pane-id="${paneId}"]`;
const titleBar = (paneId: string): string => `${frame(paneId)} .tug-pane-title-bar`;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

interface Rect {
  top: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

/** Three sidebar cards on the right rail, split, so the rail overflows. */
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
      { id: "L", componentId: "layout", title: "Layout", closable: true },
      { id: "J", componentId: "jots", title: "Jots", closable: true },
      { id: "O", componentId: "overview", title: "Overview", closable: true },
    ],
    panes: [
      pane(PANES.layout, "L", "Layout"),
      pane(PANES.jots, "J", "Jots"),
      pane(PANES.overview, "O", "Overview"),
    ],
    activePaneId: PANES.layout,
    imposition: {
      kind: "three-up",
      sidebars: {
        layout: { side: "right" },
        jots: { side: "right" },
        overview: { side: "right" },
      },
      rails: {
        right: { mode: "split", order: ["layout", "jots", "overview"] },
      },
    },
    hasFocus: true,
  };
}

/** Every right-rail member's live rect, keyed by pane id. */
async function railRects(app: App): Promise<Record<string, Rect>> {
  return app.evalJS<Record<string, Rect>>(
    `(function () {
      var out = {};
      document.querySelectorAll('.tug-pane[data-rail-side="right"]').forEach(function (el) {
        var r = el.getBoundingClientRect();
        out[el.getAttribute("data-pane-id")] = {
          top: r.top, bottom: r.bottom, left: r.left, width: r.width, height: r.height,
        };
      });
      return out;
    })()`,
  );
}

/** The rail members' componentIds in vertical order, read off the frames. */
function railOrderOnScreen(app: App): Promise<string[]> {
  return app.evalJS<string[]>(
    `Array.from(document.querySelectorAll('.tug-pane[data-rail-split]'))
      .sort(function (a, b) {
        return a.getBoundingClientRect().top - b.getBoundingClientRect().top;
      })
      .map(function (el) { return el.getAttribute("data-rail-member"); })`,
  );
}

/** The right rail's stored order, as the live store holds it. */
function railOrderInStore(app: App): Promise<string[]> {
  return app.evalJS<string[]>(
    `(((window.tugdeck.diag.getDeckState().imposition.rails || {}).right || {}).order || [])`,
  );
}

/** The drop-zone indicator's rect, or null when nothing is indicated. */
async function indicator(app: App): Promise<Rect | null> {
  return app.evalJS<Rect | null>(
    `(function () {
      var el = document.querySelector(".tug-drop-zone-indicator");
      if (el === null) return null;
      var r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, width: r.width, height: r.height };
    })()`,
  );
}

/** The right rail's strip offset as the canvas is drawing it — the custom
 *  property the gesture writes per frame, not the store's number. */
function railOffsetDrawn(app: App): Promise<number> {
  return app.evalJS<number>(
    `parseFloat(getComputedStyle(
       document.querySelector("[data-deck-canvas-background]")
     ).getPropertyValue("--tug-rail-right-offset")) || 0`,
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
  "at0537 — a rail card in the air is measured against the frames that stayed put",
  () => {
    test(
      "the outline traces the seated strip while the hand and the scroll move",
      async () => {
        const app = await launchTugApp({ testName: "at0537-rail-drag-seated-frames" });
        try {
          await app.seedDeckState({ state: deckShape(), focusCardId: "L" });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll('.tug-pane[data-rail-split]').length === 3`,
            { timeoutMs: 8_000 },
          );
          await settled(app);

          const orderBefore = await railOrderOnScreen(app);
          expect(orderBefore, "three members stand split on the right rail").toHaveLength(3);
          const topComponent = orderBefore[0];
          const topPane = PANES[topComponent];
          const seatedPanes = orderBefore.slice(1).map((c) => PANES[c]);
          const before = await railRects(app);
          note(`rail order ${JSON.stringify(orderBefore)}; dragging ${topComponent} from the top`);

          const canvas = await app.evalJS<{ bottom: number }>(
            `(function () {
              var r = document.querySelector("[data-deck-canvas-background]").getBoundingClientRect();
              return { bottom: r.bottom };
            })()`,
          );
          // Inside the run's bottom autoscroll margin — a rail's run ends at
          // the canvas's own foot, so this is close to the edge — and a
          // hundred pixels inward, off the rail's own column. A strip measured
          // off the travelling card would follow the hand there.
          const edge = {
            x: Math.round(before[topPane].left + before[topPane].width / 2 - INWARD_PX),
            y: Math.round(canvas.bottom - 30),
          };
          await app.nativeDragElementWithoutRelease(titleBar(topPane), edge);
          // Hold: the strip advances on the gesture's own clock while the hand
          // does nothing, and the engine re-enumerates on every frame it does.
          await wait(400);

          const drawn = await indicator(app);
          const live = await railRects(app);
          const offset = await railOffsetDrawn(app);
          note(
            `held at the edge: strip offset ${offset.toFixed(1)}px; dragged card left ${live[topPane].left.toFixed(1)}, seated left ${live[seatedPanes[0]].left.toFixed(1)}`,
          );
          expect(drawn, "a zone is indicated while the hand holds").not.toBeNull();
          expect(offset, "the strip advanced under the hold").toBeGreaterThan(0);

          // ── 1. The outline's strip is the seated members' strip. ──
          // The outline draws inset by ZONE_INDICATOR_INSET_PX and its 2px
          // border pushes its measured box a hair past that, so each edge is
          // held to within the inset of the tile's — a strip that followed the
          // hand would be off by INWARD_PX, not by a border.
          const seated = live[seatedPanes[0]];
          const slack = ZONE_INDICATOR_INSET_PX + EPSILON;
          expect(
            Math.abs(drawn!.left - seated.left),
            "the outline's left edge is the seated strip's, not the travelling card's",
          ).toBeLessThanOrEqual(slack);
          expect(
            Math.abs(drawn!.left + drawn!.width - (seated.left + seated.width)),
            "and its right edge is the seated strip's",
          ).toBeLessThanOrEqual(slack);
          expect(
            Math.abs(drawn!.left - live[topPane].left),
            "which is nowhere near the card under the hand",
          ).toBeGreaterThan(INWARD_PX / 2);

          // ── 2. The outline's tile is on the seated grid, at the last position. ──
          // Under overflow every member is `run / 2.5` tall and stands
          // `index` strides down the strip; a seated member at order index j
          // pins the grid, offset and all.
          const stride = seated.height + RAIL_SEAM_PX;
          const j = orderBefore.indexOf(
            Object.keys(PANES).find((c) => PANES[c] === seatedPanes[0]) as string,
          );
          const stripTop = seated.top - j * stride;
          const lastIndex = orderBefore.length - 1;
          const tileTop = stripTop + lastIndex * stride;
          note(
            `seated grid: strip top ${stripTop.toFixed(1)}, stride ${stride.toFixed(1)}; outline top ${drawn!.top.toFixed(1)} vs tile top ${tileTop.toFixed(1)}`,
          );
          expect(
            Math.abs(drawn!.top - tileTop),
            "the outline stands on the last tile of the strip as it is drawn now",
          ).toBeLessThanOrEqual(slack);
          expect(
            Math.abs(drawn!.bottom - (tileTop + seated.height)),
            "and its bottom edge is that tile's",
          ).toBeLessThanOrEqual(slack);

          // ── 3. The release lands where the outline said. ──
          await app.nativeMouseUp(edge);
          await settled(app);
          const orderAfter = await railOrderOnScreen(app);
          const stored = await railOrderInStore(app);
          note(`after the drop: on screen ${JSON.stringify(orderAfter)}, stored ${JSON.stringify(stored)}`);
          expect(orderAfter, "the rail is still split with all three members").toHaveLength(3);
          expect(
            orderAfter[lastIndex],
            "the dragged card landed at the last position — the tile the outline drew",
          ).toBe(topComponent);
          expect(stored[lastIndex], "and the store agrees").toBe(topComponent);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
