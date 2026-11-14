/**
 * at0543-rail-sashes-are-the-hands-cascade.test.ts — a sash pushed past its
 * neighbour's floor keeps going into the member beyond.
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
  SIDEBAR_FLOOR_PX,
  CASCADE_OVERSHOOT_PX,
  deckShape,
  railHeights,
  settled,
  awaitRail,
  totalHeight,
} from "./rail-sashes-are-the-hands-fixture";

describe.skipIf(!SHOULD_RUN)(
  "at0543 — a rail's sashes are the hand's, and the record outlives its members",
  () => {
    test(
      "a sash pushed past its neighbour's floor keeps going into the member beyond",
      async () => {
        const tugbankPath = mkTempTugbank();
        try {
          seedTugbankForLaunch(tugbankPath);
          const app = await launchTugApp({
            testName: "at0543-rail-sashes-cascade",
            env: { TUGBANK_PATH: tugbankPath },
            persistInTestMode: true,
          });
          try {
            await app.seedDeckState({ state: deckShape(), focusCardId: "C" });
            await awaitRail(app);

            const equal = await railHeights(app);
            note(`equal division: ${JSON.stringify(equal)}`);
            const neighbourSlack = (equal["jots"] ?? 0) - SIDEBAR_FLOOR_PX;
            const lastSlack = (equal["layout"] ?? 0) - SIDEBAR_FLOOR_PX;
            expect(
              Math.min(neighbourSlack, lastSlack),
              "the seeded rail divides with slack above every floor to trade",
            ).toBeGreaterThan(CASCADE_OVERSHOOT_PX + EPSILON);

            // The whole of the neighbour's slack and then some: the first
            // member asks for more than the second has to give, so the third
            // is the only place the rest can come from. Under the rule this
            // replaces, the sash stopped the moment the second reached 240
            // and the overshoot went nowhere.
            const travel = neighbourSlack + CASCADE_OVERSHOOT_PX;
            const seam = `.tug-place-seam[data-rail-seam="right:0"]`;
            await app.waitForCondition<boolean>(
              `document.querySelectorAll(${JSON.stringify(seam)}).length === 1`,
              { timeoutMs: 8_000 },
            );
            const box = await app.getElementBounds(seam);
            const to = {
              x: Math.round(box.x + box.width / 2),
              y: Math.round(box.y + box.height / 2 + travel),
            };
            await app.nativeDragElementWithoutRelease(seam, to);
            await app.nativeMouseUp(to);
            await settled(app);

            const after = await railHeights(app);
            note(`after the cascading drag: ${JSON.stringify(after)}`);

            expect(
              (after["cards"] ?? 0) - (equal["cards"] ?? 0),
              "the sash travelled past the neighbour's floor rather than stopping at it",
            ).toBeGreaterThan(neighbourSlack + EPSILON);
            expect(
              Math.abs((after["jots"] ?? 0) - SIDEBAR_FLOOR_PX),
              "the neighbour stands exactly at its floor: pushed onto it, never under it",
            ).toBeLessThanOrEqual(EPSILON);
            expect(
              (equal["layout"] ?? 0) - (after["layout"] ?? 0),
              "the member beyond the neighbour paid the overshoot",
            ).toBeGreaterThan(CASCADE_OVERSHOOT_PX - EPSILON * 2);
            expect(
              Math.abs(totalHeight(after) - totalHeight(equal)),
              "the trade is zero-sum: the run the members divide is unchanged",
            ).toBeLessThanOrEqual(EPSILON);
          } finally {
            await app.close().catch(() => undefined);
          }
        } finally {
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
