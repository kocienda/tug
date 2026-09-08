/**
 * at0538-rail-cross-side-drag.test.ts — a sidebar card dragged across the deck
 * lands on the other rail.
 *
 * A pinned sidebar card's drag vocabulary used to be its own rail's positions
 * and nothing else: "a pinned sidebar card sees its own rail's positions …
 * cross-place drops are a later feature." This is that feature, for the one
 * crossing a rail card can make — the other rail. Both rails are in the
 * card's vocabulary now: N positions on its own side (it is already one of
 * them), N + 1 on the other, where it would be an arrival. Content cards
 * still never see a rail, and a rail card still never sees a slot.
 *
 * The landing is ONE commit. Changing the card's side alone would append it
 * at the destination's default position and settle, and a second commit
 * writing the order would settle again — two tweens under one release. So the
 * deck-manager composes the side and both rails' orders into one imposition
 * (`moveSidebarToRail`), on the precedent a split set: one commit carrying
 * every field it moves.
 *
 * What this file pins, with a real pointer:
 *
 *   1. **The other rail indicates.** Carrying a left-rail member over the
 *      right rail's middle draws the outline on the right rail's strip.
 *   2. **The release crosses in one commit.** The motion census reads exactly
 *      one store notify and at most one settle arm for the drop.
 *   3. **The imposition is the one the zone promised.** The card's side is
 *      now right, the right rail's order has it at the index it was dropped
 *      at with the rail still split, and the left rail's order no longer names
 *      it.
 *
 * Declaring the engine and the imposer's transform alone: the gesture and the
 * canvas are at the selection budget's fan-out ceiling and at0457 names both.
 *
 * @covers tugdeck/src/lib/drop-zones.ts
 * @covers tugdeck/src/lib/layout-imposer.ts
 */

import { describe, expect, test } from "bun:test";

import {
  launchTugApp,
  note,
  summarizeMotionCensus,
  type App,
} from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 90_000;

/** Geometry tolerance, in px. */
const EPSILON = 3;
/** The settle window, with room for the tween to land. */
const AFTER_LAND_MS = 900;
const SETTLE_TAIL_MS = 900;

const RAIL_WIDTH = 420;
const PANES: Record<string, string> = {
  overview: "pOverview",
  tripwires: "pTripwires",
  layout: "pLayout",
  jots: "pJots",
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

/** Two split rails: overview over tripwires on the left, layout over jots on
 *  the right. */
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
      { id: "L", componentId: "layout", title: "Layout", closable: true },
      { id: "J", componentId: "jots", title: "Jots", closable: true },
    ],
    panes: [
      pane(PANES.overview, "O", "Overview"),
      pane(PANES.tripwires, "T", "Tripwires"),
      pane(PANES.layout, "L", "Layout"),
      pane(PANES.jots, "J", "Jots"),
    ],
    activePaneId: PANES.layout,
    imposition: {
      kind: "three-up",
      sidebars: {
        overview: { side: "left" },
        tripwires: { side: "left" },
        layout: { side: "right" },
        jots: { side: "right" },
      },
      rails: {
        left: { mode: "split", order: ["overview", "tripwires"] },
        right: { mode: "split", order: ["layout", "jots"] },
      },
    },
    hasFocus: true,
  };
}

/** Every pinned rail member's live rect, keyed by pane id. */
async function railRects(app: App): Promise<Record<string, Rect>> {
  return app.evalJS<Record<string, Rect>>(
    `(function () {
      var out = {};
      document.querySelectorAll('.tug-pane[data-rail-side]').forEach(function (el) {
        var r = el.getBoundingClientRect();
        out[el.getAttribute("data-pane-id")] = {
          top: r.top, bottom: r.bottom, left: r.left, width: r.width, height: r.height,
        };
      });
      return out;
    })()`,
  );
}

/** A side's split members' componentIds, top to bottom, read off the frames. */
function railOrderOnScreen(app: App, side: "left" | "right"): Promise<string[]> {
  return app.evalJS<string[]>(
    `Array.from(document.querySelectorAll('.tug-pane[data-rail-split][data-rail-side="${side}"]'))
      .sort(function (a, b) {
        return a.getBoundingClientRect().top - b.getBoundingClientRect().top;
      })
      .map(function (el) { return el.getAttribute("data-rail-member"); })`,
  );
}

/** A side's rail record as the live store holds it. */
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

async function settled(app: App): Promise<void> {
  await app.waitForCondition<boolean>(
    `document.querySelector("[data-imposer-settling]") === null`,
    { timeoutMs: 8_000 },
  );
  await wait(SETTLE_TAIL_MS);
}

describe.skipIf(!SHOULD_RUN)(
  "at0538 — a sidebar card dragged across the deck lands on the other rail",
  () => {
    test(
      "a left-rail member dropped mid-way down a split right rail joins it there, in one commit",
      async () => {
        const app = await launchTugApp({ testName: "at0538-rail-cross-side-drag" });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: deckShape(), focusCardId: "L" });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll('.tug-pane[data-rail-split]').length === 4`,
            { timeoutMs: 8_000 },
          );
          await settled(app);

          expect(await railOrderOnScreen(app, "left")).toEqual(["overview", "tripwires"]);
          expect(await railOrderOnScreen(app, "right")).toEqual(["layout", "jots"]);
          const before = await railRects(app);
          const rightRail = {
            left: before[PANES.layout].left,
            width: before[PANES.layout].width,
            top: before[PANES.layout].top,
            bottom: before[PANES.jots].bottom,
          };

          // ── 1. Carry the left rail's top member over the right rail's middle. ──
          // The middle of the run is inside the second tile — index 1, between
          // layout and jots — whichever way the destination stands, because
          // three equal members put their second tile across the run's middle
          // in a shared division and in a strip alike.
          const target = {
            x: Math.round(rightRail.left + rightRail.width / 2),
            y: Math.round((rightRail.top + rightRail.bottom) / 2),
          };
          await app.nativeDragElementWithoutRelease(titleBar(PANES.overview), target);
          const drawn = await indicator(app);
          note(
            `carrying overview over the right rail: outline ${JSON.stringify(drawn)}, rail left ${rightRail.left.toFixed(1)}`,
          );
          expect(drawn, "the other rail indicates a position").not.toBeNull();
          expect(
            Math.abs(drawn!.left - rightRail.left),
            "the outline stands on the right rail's strip",
          ).toBeLessThanOrEqual(EPSILON + 3);
          expect(
            Math.abs(drawn!.left + drawn!.width - (rightRail.left + rightRail.width)),
            "as wide as that rail",
          ).toBeLessThanOrEqual(EPSILON + 3);

          // ── 2. The release crosses in one commit. ──
          const census = await app.motionCensus(async () => {
            await app.nativeMouseUp(target);
          }, AFTER_LAND_MS);
          note(summarizeMotionCensus("cross-side release", census));
          expect(census.notifies, "side and both orders land as one commit").toBe(1);
          expect(census.arms, "so the settle arms once, not once per field").toBeLessThanOrEqual(1);
          await settled(app);

          // ── 3. The imposition is the one the zone promised. ──
          expect(await sidebarSideOf(app, "overview"), "overview now stands on the right").toBe("right");
          const right = await railInStore(app, "right");
          const left = await railInStore(app, "left");
          note(`after: right ${JSON.stringify(right)}, left ${JSON.stringify(left)}`);
          expect(right.order, "inserted at the index the outline drew").toEqual([
            "layout",
            "overview",
            "jots",
          ]);
          expect(right.mode, "the destination stayed split").toBe("split");
          expect(left.order, "and the origin's order no longer names it").toEqual(["tripwires"]);
          expect(await railOrderOnScreen(app, "right"), "the frames agree").toEqual([
            "layout",
            "overview",
            "jots",
          ]);
          // A lone member is not a split frame, so the left side is read by
          // its pinned frames: exactly tripwires, standing alone.
          expect(
            await app.evalJS<string[]>(
              `Array.from(document.querySelectorAll('.tug-pane[data-rail-side="left"]'))
                .map(function (el) { return el.getAttribute("data-pane-id"); })`,
            ),
            "the left rail holds tripwires alone",
          ).toEqual([PANES.tripwires]);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
