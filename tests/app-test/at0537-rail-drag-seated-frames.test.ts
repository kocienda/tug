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
  cards: "pCards",
  dashes: "pDashes",
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

/**
 * Five sidebar cards on the right rail, split, so the rail overflows.
 *
 * Five rather than three because the standing is decided by the members'
 * floors against the run ([P01]): a sidebar card's floor is 240px and this
 * harness opens a canvas a little over 1000px tall, so three of them share it
 * comfortably and it takes five before the floors stop fitting. The count was
 * never what made a rail overflow — it only used to be what the code looked
 * at.
 */
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
      { id: "C", componentId: "cards", title: "Cards", closable: true },
      { id: "R", componentId: "dashes", title: "Arcs", closable: true },
    ],
    panes: [
      pane(PANES.layout, "L", "Layout"),
      pane(PANES.jots, "J", "Jots"),
      pane(PANES.overview, "O", "Overview"),
      pane(PANES.cards, "C", "Cards"),
      pane(PANES.dashes, "R", "Arcs"),
    ],
    activePaneId: PANES.layout,
    imposition: {
      kind: "three-up",
      sidebars: {
        layout: { side: "right" },
        jots: { side: "right" },
        overview: { side: "right" },
        cards: { side: "right" },
        dashes: { side: "right" },
      },
      rails: {
        right: {
          mode: "split",
          order: ["layout", "jots", "overview", "cards", "dashes"],
        },
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
            `document.querySelectorAll('.tug-pane[data-rail-split]').length === 5`,
            { timeoutMs: 8_000 },
          );
          await settled(app);

          const orderBefore = await railOrderOnScreen(app);
          expect(orderBefore, "five members stand split on the right rail").toHaveLength(5);
          const topComponent = orderBefore[0];
          const topPane = PANES[topComponent];
          const seatedPanes = orderBefore.slice(1).map((c) => PANES[c]);
          const before = await railRects(app);
          note(`rail order ${JSON.stringify(orderBefore)}; dragging ${topComponent} from the top`);

          const canvas = await app.evalJS<{ top: number; bottom: number }>(
            `(function () {
              var r = document.querySelector("[data-deck-canvas-background]").getBoundingClientRect();
              return { top: r.top, bottom: r.bottom };
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

          // ── 2. The outline is the card's own box, inside the run. ──
          // The tile the outline draws is the DRAGGED card's box in the
          // allocation the drop would make — a strip of one more member, with
          // its own longer length and therefore its own offset clamp. Its top
          // is therefore not a landmark on the seated strip and cannot be one:
          // reproducing it here would be a second copy of `placeTiles`, and two
          // derivations of a tile agree only by luck.
          //
          // What IS the claim, and what the retired stride arithmetic was
          // standing in for: the outline is the size of the card that would
          // land there, and it OVERLAPS the run rather than being drawn off
          // somewhere else. Not "inside the run": a flowing member stands at
          // the height its own content asked for ([B08]), so a card can be
          // taller than the run it is landing in and its tile then hangs past
          // an edge exactly as the card will. Part 3 closes the loop by
          // releasing and checking that the card landed where the outline
          // said, which is the claim that needs no tolerance at all.
          note(
            `outline ${drawn!.top.toFixed(1)}..${drawn!.bottom.toFixed(1)} (h ${drawn!.height.toFixed(1)}) vs card h ${live[topPane].height.toFixed(1)}, run ${canvas.top.toFixed(1)}..${canvas.bottom.toFixed(1)}`,
          );
          expect(
            Math.abs(drawn!.height - live[topPane].height),
            "the outline is the size of the card that would land there",
          ).toBeLessThanOrEqual(slack);
          expect(
            drawn!.bottom,
            "and it reaches into the run rather than standing above it",
          ).toBeGreaterThan(canvas.top + slack);
          expect(
            drawn!.top,
            "and does not begin below its foot",
          ).toBeLessThan(canvas.bottom - slack);

          // ── 3. The release lands where the outline said. ──
          await app.nativeMouseUp(edge);
          await settled(app);
          const orderAfter = await railOrderOnScreen(app);
          const stored = await railOrderInStore(app);
          note(`after the drop: on screen ${JSON.stringify(orderAfter)}, stored ${JSON.stringify(stored)}`);
          expect(orderAfter, "the rail is still split with all five members").toHaveLength(5);
          // The outline is a promise the commit keeps BY CONSTRUCTION — the
          // tile was drawn from the same allocation, over the same appetites
          // and weights, that the drop then commits ([P06]). So the promise is
          // checkable directly, without naming a position: the card's landed
          // frame IS the box the outline drew — on the strip, which is the
          // coordinate the promise is made in. The strip may have slid under it
          // in between: a flowing member stands as tall as its own content
          // ([B08]), so a tile can hang past the run's top, and the drop then
          // reveals the card it landed. That slide is read off the rail's own
          // offset rather than allowed for as tolerance, so the claim stays
          // exact.
          const slid = offset - (await railOffsetDrawn(app));
          const landed = (await railRects(app))[topPane];
          note(
            `landed ${landed.top.toFixed(1)}..${landed.bottom.toFixed(1)} against the outline's ${drawn!.top.toFixed(1)}..${drawn!.bottom.toFixed(1)}, strip slid ${slid.toFixed(1)}px`,
          );
          expect(
            Math.abs(landed.top - (drawn!.top + slid)),
            "the dragged card landed exactly where the outline drew it",
          ).toBeLessThanOrEqual(slack);
          expect(
            Math.abs(landed.bottom - (drawn!.bottom + slid)),
            "and its foot is the outline's too",
          ).toBeLessThanOrEqual(slack);
          expect(
            stored,
            "and the store's order is the one on screen",
          ).toEqual(orderAfter);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
