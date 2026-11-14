/**
 * at0294-imposer-flip-retarget.test.ts — a second arrangement change inside the settle window replaces the tweens rather than stacking them, velocity-matched off the running beat.
 *
 * One of the at0294-imposer-flip split, a test to a file so each launch
 * fits its own budget. The deck, the doctrine and the readers are
 * `imposer-flip-fixture.ts`. It reads the settle mid-window, so it runs
 * alone (`@motion`).
 *
 * @covers tugdeck/src/components/chrome/settle-plan.ts
 * @covers tugdeck/src/components/chrome/settle-engine.ts
 * @covers tugdeck/src/components/tugways/tug-pane.css
 * @covers tugdeck/src/lib/pane-flip.ts
 * @covers tugdeck/src/lib/layout-imposer.ts
 * @family at0294-imposer-flip
 * @motion
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp } from "./_harness";
import {
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  AFTER_LAND_MS,
  FRAMES,
  SETTLE_MS,
  deckShape,
  expectedLeft,
  frameAnimations,
  frameLeft,
  inlineTransforms,
  railWidth,
  retargets,
  seedRailPreferred,
  setImposition,
  setRailSide,
  settling,
  viewportWidth,
  wait,
} from "./imposer-flip-fixture";

describe.skipIf(!SHOULD_RUN)(
  "at0294 — the imposer settles by transform-only FLIP and leaves no residue",
  () => {
    test(
      "a second arrangement change inside the window replaces the tweens rather than stacking them",
      async () => {
        const app = await launchTugApp({
          testName: "at0294-imposer-flip-retarget",
        });
        try {
          await seedRailPreferred(app);
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(FRAMES)}).length === 3`,
            { timeoutMs: 5_000 },
          );
          await wait(AFTER_LAND_MS);
          const vp = await viewportWidth(app);
          await app.enableDeckTrace(true);

          // Two changes inside one window. The second measures each frame's
          // live visual rect — which includes the running tween's transform —
          // so the new motion starts where the eye is.
          await setRailSide(app, "left");
          await wait(Math.floor(SETTLE_MS / 3));
          await setImposition(app, "one-up");

          // At most one tween per frame at any moment: a stacked pair would
          // show the same pane id twice.
          {
            const census = await frameAnimations(app);
            const ids = census.map((a) => a.paneId);
            expect(new Set(ids).size).toBe(ids.length);
          }
          // The retarget was velocity-matched, and it read the velocity off
          // the beat that was running — a rail-side flip is a move-only
          // settle, so the interrupted beat is the move, and the crossing it
          // relaunched is the one beat the velocity is handed to.
          {
            const seen = await retargets(app);
            expect(seen.length).toBeGreaterThan(0);
            for (const r of seen) {
              expect(r.mode).toBe("matched");
              expect(r.beat).toBe("move");
            }
          }

          await wait(AFTER_LAND_MS);
          expect(await settling(app)).toBe(false);
          expect(await frameAnimations(app)).toEqual([]);
          {
            const inline = await inlineTransforms(app);
            expect(Object.values(inline).every((v) => v === "")).toBe(true);
          }

          // One-up puts every imposed frame at the same centred place, and the
          // Layout card now holds the left — so the retarget landed on the arrangement
          // the LAST change asked for, not the first.
          const centred = expectedLeft(0, 1, vp, "left", await railWidth(app));
          expect(await frameLeft(app, "p1")).toBeCloseTo(centred, 0);
          expect(await frameLeft(app, "p2")).toBeCloseTo(centred, 0);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
