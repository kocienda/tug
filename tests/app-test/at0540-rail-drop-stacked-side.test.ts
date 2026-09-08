/**
 * at0540-rail-drop-stacked-side.test.ts — a rail card dropped on a stacked
 * rail joins the stack in front, and the rail stays stacked.
 *
 * A stacked rail is one rect front to back ([F09]): every member draws the
 * same frame and z-order decides which is seen. So it is not a division a
 * card could take a position in, and the drop-zone engine offers it as ONE
 * zone — the rail's whole rect — whose arrival goes to the front, index 0 of
 * the stored order, with the destination's mode untouched ([B11]). Splitting
 * the rail on arrival was ruled out.
 *
 * What this file pins, with a real pointer:
 *
 *   1. **The stacked rail indicates as one rect.** Carrying a left-rail
 *      member over the stacked right rail draws the outline on the rail's
 *      whole frame, and the outline does not move between the rail's upper
 *      and lower halves — there is one zone, not two.
 *   2. **The release crosses in one commit.** One store notify, at most one
 *      settle arm.
 *   3. **The card is on top and the rail is still stacked.** Its side is
 *      right, the right rail's order starts with it, the mode is still
 *      `stack`, all three right-rail frames share one rect, the arriving
 *      card's z-index is the highest of them, and the left rail's order no
 *      longer names it.
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
  right: number;
  width: number;
  height: number;
}

/** A split left rail (overview over tripwires) and a STACKED right rail
 *  (layout and jots, one frame). */
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
        right: { mode: "stack", order: ["layout", "jots"] },
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

/** Each right-rail frame's pane id, rect and z-index. */
function rightRailFrames(
  app: App,
): Promise<{ paneId: string; z: number; rect: Rect }[]> {
  return app.evalJS<{ paneId: string; z: number; rect: Rect }[]>(
    `Array.from(document.querySelectorAll('.tug-pane[data-rail-side="right"]')).map(function (el) {
      var r = el.getBoundingClientRect();
      var z = parseInt(window.getComputedStyle(el).zIndex, 10);
      return {
        paneId: el.getAttribute("data-pane-id"),
        z: Number.isNaN(z) ? 0 : z,
        rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height },
      };
    })`,
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

function sameRect(a: Rect, b: Rect): boolean {
  return (
    Math.abs(a.left - b.left) <= EPSILON &&
    Math.abs(a.right - b.right) <= EPSILON &&
    Math.abs(a.top - b.top) <= EPSILON &&
    Math.abs(a.bottom - b.bottom) <= EPSILON
  );
}

describe.skipIf(!SHOULD_RUN)(
  "at0540 — a rail card dropped on a stacked rail joins the stack in front",
  () => {
    test(
      "the stacked right rail indicates as one rect, takes the card on top, and stays stacked",
      async () => {
        const app = await launchTugApp({ testName: "at0540-rail-drop-stacked-side" });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: deckShape(), focusCardId: "L" });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll('.tug-pane[data-rail-side]').length === 4`,
            { timeoutMs: 8_000 },
          );
          await settled(app);

          const rightBefore = await rightRailFrames(app);
          expect(rightBefore, "two frames stand on the right").toHaveLength(2);
          expect(sameRect(rightBefore[0].rect, rightBefore[1].rect), "as one stacked rect").toBe(true);
          const rail = rightBefore[0].rect;
          const slack = ZONE_INDICATOR_INSET_PX + EPSILON;

          // ── 1. Carry the left rail's top member over the stacked right rail. ──
          const upper = {
            x: Math.round((rail.left + rail.right) / 2),
            y: Math.round(rail.top + rail.height * 0.25),
          };
          const lower = {
            x: upper.x,
            y: Math.round(rail.top + rail.height * 0.75),
          };
          await app.nativeDragElementWithoutRelease(titleBar(PANES.overview), upper);
          const drawnUpper = await rectOf(app, ".tug-drop-zone-indicator");
          note(
            `carrying overview over the stack's upper half: outline ${JSON.stringify(drawnUpper)}, rail ${JSON.stringify(rail)}`,
          );
          expect(drawnUpper, "the stacked rail indicates").not.toBeNull();
          expect(Math.abs(drawnUpper!.left - rail.left), "on the rail's left edge").toBeLessThanOrEqual(slack);
          expect(Math.abs(drawnUpper!.right - rail.right), "its right edge").toBeLessThanOrEqual(slack);
          expect(Math.abs(drawnUpper!.top - rail.top), "its top").toBeLessThanOrEqual(slack);
          expect(Math.abs(drawnUpper!.bottom - rail.bottom), "and its bottom — the whole rect").toBeLessThanOrEqual(slack);

          // Move to the lower half: same zone, so the outline does not move.
          await app.nativeDragElementWithoutRelease(titleBar(PANES.overview), lower);
          const drawnLower = await rectOf(app, ".tug-drop-zone-indicator");
          note(`over the lower half: outline ${JSON.stringify(drawnLower)}`);
          expect(drawnLower, "still indicated").not.toBeNull();
          expect(sameRect(drawnLower!, drawnUpper!), "one zone, not two").toBe(true);

          // ── 2. The release crosses in one commit. ──
          const census = await app.motionCensus(async () => {
            await app.nativeMouseUp(lower);
          }, AFTER_LAND_MS);
          note(summarizeMotionCensus("stacked-side release", census));
          expect(census.notifies, "side and both orders land as one commit").toBe(1);
          expect(census.arms, "so the settle arms once").toBeLessThanOrEqual(1);
          await settled(app);

          // ── 3. The card is on top and the rail is still stacked. ──
          expect(await sidebarSideOf(app, "overview"), "overview now stands on the right").toBe("right");
          const right = await railInStore(app, "right");
          const left = await railInStore(app, "left");
          note(`after: right ${JSON.stringify(right)}, left ${JSON.stringify(left)}`);
          expect(right.order, "at the front of the stored order").toEqual(["overview", "layout", "jots"]);
          expect(right.mode, "and the rail stayed stacked").toBe("stack");
          expect(left.order, "the origin's order no longer names it").toEqual(["tripwires"]);
          expect(await pinnedPanesOn(app, "left"), "tripwires stands alone on the left").toEqual([PANES.tripwires]);

          const rightAfter = await rightRailFrames(app);
          note(`right rail frames: ${rightAfter.map((f) => `${f.paneId}=z${f.z} ${JSON.stringify(f.rect)}`).join(" ")}`);
          expect(rightAfter.map((f) => f.paneId).sort(), "three frames stand on the right").toEqual(
            [PANES.overview, PANES.layout, PANES.jots].sort(),
          );
          // One rect, compared frame to frame rather than against the rail as
          // it stood before the drop: the rail allocator re-shares the deck's
          // width between the two rails when a side's membership changes, so
          // the stack's width may move by the allocator's share. Its edge does
          // not.
          const stack = rightAfter[0].rect;
          expect(Math.abs(stack.right - rail.right), "the stack still stands on the right edge").toBeLessThanOrEqual(EPSILON);
          for (const member of rightAfter) {
            expect(sameRect(member.rect, stack), `${member.paneId} draws the stack's one rect`).toBe(true);
          }
          const overview = rightAfter.find((f) => f.paneId === PANES.overview)!;
          for (const member of rightAfter) {
            if (member.paneId === PANES.overview) continue;
            expect(overview.z, `overview is in front of ${member.paneId}`).toBeGreaterThan(member.z);
          }
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
