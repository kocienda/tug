/**
 * rail-sashes-are-the-hands-fixture.ts — the shared deck, readers and waits
 * the at0543-rail-sashes-are-the-hands-* files drive a rail's sashes through.
 *
 * A sash the hand moved stays where the hand left it, across a relaunch and
 * across a card coming and going.
 *
 * A rail's `shares` record is the hand's division and nothing else writes it.
 * That is one sentence, and it has two failure modes, so the relaunch file
 * drives both against a real pointer:
 *
 *   1. **The record outlives the process.** The division is `rails.<side>.shares`
 *      in the v4 blob, which already serializes and parses. Phase A drags a
 *      sash and quits; phase B relaunches from the same tugbank with no
 *      seeding, through the production cold-boot restore, and the members stand
 *      at the same heights.
 *   2. **The record outlives its members.** This is the half that used to fail.
 *      A sweep on every membership change dropped a `shares` record that did
 *      not name exactly the members now standing, so hiding a rail card and
 *      showing it again threw the hand's whole division away and the rail came
 *      back equally divided. The record is now kept the way `order` already is:
 *      a card that leaves keeps its share, and a card that arrives with no
 *      share joins at weight 1 beside the others' unchanged weights.
 *
 * A third sentence, added when the hand found the sash jammed, is the cascade
 * file's: **the trade is not confined to the sash's own two members.** Push the
 * neighbour to its floor and keep going and the members beyond it give up their
 * slack in turn, nearest first — otherwise a rail whose middle card is pinned
 * at 240 stops the sash dead with room standing free one card further down,
 * which is what the hand reads as a sash that has jammed.
 *
 * Heights rather than the stored numbers, because heights are what the rule is
 * about — a share nobody can see move is not the thing the user is promised.
 * The store is read once, to say that a rail nobody has divided carries no
 * record at all and that the release wrote one.
 *
 * Three members rather than five: a sidebar card's floor is 240px and this
 * harness opens a canvas a little over 1000px tall, so three share it
 * comfortably and the rail is divided rather than a strip. A strip has no
 * sashes to move.
 *
 * @module tests/app-test/rail-sashes-are-the-hands-fixture
 */

import { expect } from "bun:test";

import type { App } from "./_harness";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 120_000;

// Its own number, not `PIXEL_TOL` (1.5) from `_harness/tolerances.ts`: a different
// tolerance is this file's decision, so the table does not flatten it.
/** Geometry tolerance, in px: sub-pixel rounding, never a real disagreement. */
export const EPSILON = 3;
/** Room past the settle attribute clearing for the tween's own tail. */
export const SETTLE_TAIL_MS = 900;
/** How far down the sash travels. Well past `EPSILON`, well inside the floors
 *  either side of it, so the drag lands where it was aimed. */
export const DRAG_PX = 90;

/** A sidebar card's registered floor, px — the number the cascade test pushes
 *  the middle member onto and then past. */
export const SIDEBAR_FLOOR_PX = 240;
/** How far past the neighbour's floor the cascading drag travels. Well past
 *  `EPSILON`, and well inside the slack the LAST member has to give. */
export const CASCADE_OVERSHOOT_PX = 60;

export const RAIL_WIDTH = 420;
export const MEMBERS = ["cards", "jots", "layout"] as const;

export const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/** Three sidebar cards on the right rail, divided, with no stored shares —
 *  the state a rail nobody has touched is in, which stands at equal shares. */
export function deckShape() {
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
      { id: "C", componentId: "cards", title: "Cards", closable: true },
      { id: "J", componentId: "jots", title: "Jots", closable: true },
      { id: "L", componentId: "layout", title: "Layout", closable: true },
    ],
    panes: [
      pane("pCards", "C", "Cards"),
      pane("pJots", "J", "Jots"),
      pane("pLayout", "L", "Layout"),
    ],
    activePaneId: "pCards",
    imposition: {
      kind: "three-up",
      sidebars: {
        cards: { side: "right" },
        jots: { side: "right" },
        layout: { side: "right" },
      },
      rails: { right: { order: [...MEMBERS] } },
    },
    hasFocus: true,
  };
}

/**
 * Every right-rail member's height, keyed by componentId — the whole of what
 * a division is, seen from outside.
 */
export function railHeights(app: App): Promise<Record<string, number>> {
  return app.evalJS<Record<string, number>>(
    `(function () {
      var out = {};
      document.querySelectorAll('.tug-pane[data-rail-side="right"]').forEach(function (el) {
        out[el.getAttribute("data-rail-member")] = el.getBoundingClientRect().height;
      });
      return out;
    })()`,
  );
}

/** The right rail's stored shares, as the live store holds them. */
export function railShares(app: App): Promise<Record<string, number>> {
  return app.evalJS<Record<string, number>>(
    `(((window.tugdeck.diag.getDeckState().imposition.rails || {}).right || {}).shares || {})`,
  );
}

export async function settled(app: App): Promise<void> {
  await app.waitForCondition<boolean>(
    `document.querySelector("[data-imposer-settling]") === null`,
    { timeoutMs: 8_000 },
  );
  await wait(SETTLE_TAIL_MS);
}

/** Wait until all three members stand on the right rail and nothing is moving. */
export async function awaitRail(app: App): Promise<void> {
  await app.waitForCondition<boolean>(
    `document.querySelectorAll('.tug-pane[data-rail-side="right"]').length === 3`,
    { timeoutMs: 15_000 },
  );
  await settled(app);
}

/** How many members stand on the right rail. */
export function railCount(app: App): Promise<number> {
  return app.evalJS<number>(
    `document.querySelectorAll('.tug-pane[data-rail-side="right"]').length`,
  );
}

/**
 * Take Jots off the rail. `toggle-jots` is the three-state ladder over one
 * card — show-and-activate a hidden one, activate a showing one, hide the one
 * that already holds the keyboard — so a showing card that is not focused
 * takes two presses to leave, and a focused one takes one. Pressing until the
 * rail is down to two members asks for the outcome rather than counting the
 * presses.
 */
export async function hideJots(app: App): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if ((await railCount(app)) === 2) return;
    await app.dispatchControlAction("toggle-jots");
    await wait(400);
  }
  await app.waitForCondition<boolean>(
    `document.querySelectorAll('.tug-pane[data-rail-side="right"]').length === 2`,
    { timeoutMs: 8_000 },
  );
}

/** Every member's height added up — the run the division divides, which a
 *  drag may move about but never change. */
export function totalHeight(heights: Record<string, number>): number {
  return MEMBERS.reduce((sum, id) => sum + (heights[id] ?? 0), 0);
}

/** Every member at the height `expected` records, within `EPSILON`. */
export function expectSameHeights(
  actual: Record<string, number>,
  expected: Record<string, number>,
  phase: string,
): void {
  for (const componentId of MEMBERS) {
    expect(
      Math.abs((actual[componentId] ?? 0) - (expected[componentId] ?? 0)),
      `${phase}: ${componentId} stands where the hand left it (${expected[componentId]?.toFixed(1)})`,
    ).toBeLessThanOrEqual(EPSILON);
  }
}
