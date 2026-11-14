/**
 * at0543-rail-sashes-are-the-hands-relaunch.test.ts — a dragged sash survives
 * a relaunch, and survives a card leaving and coming back.
 *
 * One of the at0543-rail-sashes-are-the-hands split, a test to a file so each
 * launch fits its own budget. Why a rail's sashes are the hand's, and the
 * shared deck, readers and waits, are `rail-sashes-are-the-hands-fixture.ts`.
 *
 * @covers tugdeck/src/deck-manager.ts
 * @covers tugdeck/src/serialization.ts
 * @covers tugdeck/src/lib/layout-imposer.ts
 * @family at0543-rail-sashes-are-the-hands
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  EPSILON,
  DRAG_PX,
  MEMBERS,
  deckShape,
  railHeights,
  railShares,
  settled,
  awaitRail,
  hideJots,
  expectSameHeights,
} from "./rail-sashes-are-the-hands-fixture";

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
