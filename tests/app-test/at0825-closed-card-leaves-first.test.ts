/**
 * at0825-closed-card-leaves-first.test.ts — in a split, a closed card's view
 * is gone before its neighbour moves into the room it gave up.
 *
 * ## What this gates
 *
 * A card is one view the host stands over the shell's paintless stand-in, so
 * what the reader sees leave is the host's view, not the shell's frame. The
 * settle fades the closed pane's frame on its `depart` beat and only then
 * moves the survivors, but that frame paints nothing: the view is taken down
 * by the placer's commit-time hide (`hiddenSince`). The host shows a card by
 * its `staged` fact, so a hide that cleared `visible` alone was no hide, and
 * the closed card's view stood until the settle's land while its neighbour's
 * view grew behind it.
 *
 * ## The claim
 *
 * Two cards share a column. The lower one is closed, and the host's views are
 * read as fast as the harness answers for the length of the settle. On every
 * reading where the survivor's view stands anywhere but where it stood before
 * the close, the closed card's view is hidden or gone. And the survivor did
 * move, so the claim was read against a motion.
 *
 * Read from the host, never the shell's DOM: the shell's frame fading says
 * nothing of the view the reader sees.
 *
 * @covers tugdeck/src/lib/card-placement.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import { PLACED_MS, pollFor } from "./session-body-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const SURVIVOR = "at0825-a";
const CLOSED = "at0825-b";
/** How long the host's views are read after the close: past the whole settle. */
const WATCH_MS = 1_500;
/** How far a view may stand from its start and still be standing there, pt. */
const MOVED_PT = 1.5;

const twoInAColumn = {
  cards: [SURVIVOR, CLOSED].map((id) => ({ id, componentId: "hello", title: id, closable: true })),
  panes: [SURVIVOR, CLOSED].map((cardId) => ({
    id: `${cardId}-pane`,
    position: { x: 40, y: 40 },
    size: { width: 640, height: 480 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["maker"],
    slot: 0,
  })),
  activePaneId: `${SURVIVOR}-pane`,
  imposition: {
    kind: "four-up",
    layout: "fit",
    sidebars: {},
    // A split, not a stack: both members tile the slot's run, so the survivor
    // takes the closed member's room.
    columns: { 0: { mode: "split", order: [`${SURVIVOR}-pane`, `${CLOSED}-pane`] } },
  },
  hasFocus: true,
};

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const apart = (a: Rect, b: Rect): number =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.width - b.width), Math.abs(a.height - b.height));

describe.skipIf(!SHOULD_RUN)("AT0825: a closed card leaves before its neighbour moves", () => {
  test(
    "the closed card's view is hidden on every reading where the survivor's view has moved",
    async () => {
      const app = await launchTugApp({ testName: "at0825-closed-card-leaves-first" });
      try {
        await app.seedDeckState({ state: twoInAColumn, focusCardId: SURVIVOR });
        const placed = await pollFor(
          () => app.bodies(),
          (bodies) => [SURVIVOR, CLOSED].every((id) => bodies.find((b) => b.cardId === id)?.visible === true),
          PLACED_MS * 3,
        );
        expect(
          [SURVIVOR, CLOSED].map((id) => placed.find((b) => b.cardId === id)?.visible),
          "both cards' views show before the close",
        ).toEqual([true, true]);
        // At rest: the seed's own settle has landed before the close is read against it.
        await app.waitForCondition<boolean>(`document.querySelector("[data-imposer-settling]") === null`, { timeoutMs: 5_000 });
        await Bun.sleep(400);
        const start = (await app.bodies()).find((b) => b.cardId === SURVIVOR)!.presentedFrame;

        await app.evalJS<null>(`(window.__tug.closePane(${JSON.stringify(`${CLOSED}-pane`)}), null)`);
        const readings: Array<{ t: number; moved: number; closedShows: boolean }> = [];
        const t0 = Date.now();
        while (Date.now() - t0 < WATCH_MS) {
          const bodies = await app.bodies();
          const survivor = bodies.find((b) => b.cardId === SURVIVOR);
          const closed = bodies.find((b) => b.cardId === CLOSED);
          if (survivor === undefined) continue;
          readings.push({
            t: Date.now() - t0,
            moved: apart(survivor.presentedFrame, start),
            closedShows: closed?.visible === true,
          });
        }

        const moving = readings.filter((r) => r.moved > MOVED_PT);
        const firstMove = moving[0]?.t ?? null;
        const lastShown = readings.filter((r) => r.closedShows).at(-1)?.t ?? null;
        note("survivor", `started at ${JSON.stringify(start)}; furthest from it ${Math.max(0, ...readings.map((r) => r.moved)).toFixed(1)}pt`);
        note(
          "readings",
          `${readings.length} read; the closed view last showed at ${lastShown}ms, the survivor first moved at ${firstMove}ms`,
        );
        expect(readings.length, "the settle was read many times over").toBeGreaterThan(10);
        expect(moving.length, "the survivor's view moved into the room").toBeGreaterThan(0);
        expect(
          moving.filter((r) => r.closedShows).map((r) => `t=${r.t}ms: survivor ${r.moved.toFixed(1)}pt from its start, closed view still shown`),
          "the closed card's view is gone on every reading where the survivor has moved",
        ).toEqual([]);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
