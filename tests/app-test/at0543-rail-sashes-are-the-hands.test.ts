/**
 * at0543-rail-sashes-are-the-hands.test.ts — a sash the hand moved stays where
 * the hand left it, across a relaunch and across a card coming and going.
 *
 * A rail's `shares` record is the hand's division and nothing else writes it.
 * That is one sentence, and it has two failure modes, so this file drives both
 * against a real pointer:
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
 * @covers tugdeck/src/deck-manager.ts
 * @covers tugdeck/src/serialization.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

/** Geometry tolerance, in px: sub-pixel rounding, never a real disagreement. */
const EPSILON = 3;
/** Room past the settle attribute clearing for the tween's own tail. */
const SETTLE_TAIL_MS = 900;
/** How far down the sash travels. Well past `EPSILON`, well inside the floors
 *  either side of it, so the drag lands where it was aimed. */
const DRAG_PX = 90;

const RAIL_WIDTH = 420;
const MEMBERS = ["cards", "jots", "layout"] as const;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/** Three sidebar cards on the right rail, divided, with no stored shares —
 *  the state a rail nobody has touched is in, which stands at equal shares. */
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
function railHeights(app: App): Promise<Record<string, number>> {
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
function railShares(app: App): Promise<Record<string, number>> {
  return app.evalJS<Record<string, number>>(
    `(((window.tugdeck.diag.getDeckState().imposition.rails || {}).right || {}).shares || {})`,
  );
}

async function settled(app: App): Promise<void> {
  await app.waitForCondition<boolean>(
    `document.querySelector("[data-imposer-settling]") === null`,
    { timeoutMs: 8_000 },
  );
  await wait(SETTLE_TAIL_MS);
}

/** Wait until all three members stand on the right rail and nothing is moving. */
async function awaitRail(app: App): Promise<void> {
  await app.waitForCondition<boolean>(
    `document.querySelectorAll('.tug-pane[data-rail-side="right"]').length === 3`,
    { timeoutMs: 15_000 },
  );
  await settled(app);
}

/** How many members stand on the right rail. */
function railCount(app: App): Promise<number> {
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
async function hideJots(app: App): Promise<void> {
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

/** Every member at the height `expected` records, within `EPSILON`. */
function expectSameHeights(
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

describe.skipIf(!SHOULD_RUN)(
  "at0543 — a rail's sashes are the hand's, and the record outlives its members",
  () => {
    test(
      "a dragged sash survives a relaunch, and survives a card leaving and coming back",
      async () => {
        const tugbankPath = mkTempTugbank();
        /** The heights the hand leaves behind in phase A — the pin for both halves. */
        let dragged: Record<string, number> = {};

        try {
          seedTugbankForLaunch(tugbankPath);

          // ── Phase A: divide the rail by hand, then quit. ──
          {
            const app = await launchTugApp({
              testName: "at0543-rail-sashes-are-the-hands-A",
              env: { TUGBANK_PATH: tugbankPath },
              persistInTestMode: true,
            });
            try {
              await app.seedDeckState({ state: deckShape(), focusCardId: "C" });
              await awaitRail(app);

              const equal = await railHeights(app);
              note(`equal division: ${JSON.stringify(equal)}`);
              expect(
                Object.keys(await railShares(app)),
                "a rail nobody has divided has no record, and stands equal",
              ).toHaveLength(0);

              // The sash between the top two members, dragged down. It writes
              // its fraction per frame and commits once at the release, which
              // is the one path that writes `shares`.
              const seam = `.tug-place-seam[data-rail-seam="right:0"]`;
              await app.waitForCondition<boolean>(
                `document.querySelectorAll(${JSON.stringify(seam)}).length === 1`,
                { timeoutMs: 8_000 },
              );
              const box = await app.getElementBounds(seam);
              const to = {
                x: Math.round(box.x + box.width / 2),
                y: Math.round(box.y + box.height / 2) + DRAG_PX,
              };
              await app.nativeDragElementWithoutRelease(seam, to);
              await app.nativeMouseUp(to);
              await settled(app);

              dragged = await railHeights(app);
              note(`after the drag: ${JSON.stringify(dragged)}`);
              expect(
                dragged[MEMBERS[0]] - equal[MEMBERS[0]],
                "the drag actually moved the sash it grabbed",
              ).toBeGreaterThan(EPSILON * 4);
              expect(
                Object.keys(await railShares(app)).length,
                "the release wrote the division into the record",
              ).toBeGreaterThan(0);

              await app.quitGracefully();
            } finally {
              await app.close().catch(() => undefined);
            }
          }

          // ── Phase B: relaunch from the same tugbank, no seeding. ──
          {
            const app = await launchTugApp({
              testName: "at0543-rail-sashes-are-the-hands-B",
              env: { TUGBANK_PATH: tugbankPath },
              persistInTestMode: true,
              restoreInTestMode: true,
            });
            try {
              await awaitRail(app);
              const restored = await railHeights(app);
              note(`after the relaunch: ${JSON.stringify(restored)}`);
              expectSameHeights(restored, dragged, "relaunch");

              // And the half that used to fail: a member leaves the rail and
              // comes back. The membership sweep dropped the record here, and
              // the rail came back equally divided — the hand's division gone
              // for a gesture that says nothing about it.
              await hideJots(app);
              await settled(app);
              note(`with Jots away: ${JSON.stringify(await railHeights(app))}`);

              await app.dispatchControlAction("toggle-jots");
              await awaitRail(app);
              const returned = await railHeights(app);
              note(`with Jots back: ${JSON.stringify(returned)}`);
              expectSameHeights(returned, dragged, "hide and show");
            } finally {
              await app.close().catch(() => undefined);
            }
          }
        } finally {
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
