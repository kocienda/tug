/**
 * at0294-imposer-flip-raise.test.ts — a slot assignment raises its frame before the frame starts crossing, and a bare raise arms no settle window.
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
  deckShape,
  expectedLeft,
  frameAnimations,
  frameLeft,
  frameZIndex,
  railWidth,
  seedRailPreferred,
  settling,
  viewportWidth,
  wait,
} from "./imposer-flip-fixture";

describe.skipIf(!SHOULD_RUN)(
  "at0294 — the imposer settles by transform-only FLIP and leaves no residue",
  () => {
    test(
      "assigning a slot raises the frame before it starts crossing, and a bare raise arms nothing",
      async () => {
        const app = await launchTugApp({
          testName: "at0294-imposer-flip-raise",
        });
        try {
          // Focus B, so p2 is the frame on top and a raise of p1 is
          // observable: without one, A crosses to p2's slot underneath it.
          await seedRailPreferred(app);
          await app.seedDeckState({ state: deckShape(), focusCardId: "B" });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(FRAMES)}).length === 3`,
            { timeoutMs: 5_000 },
          );
          await wait(AFTER_LAND_MS);
          const vp = await viewportWidth(app);
          const rail = await railWidth(app);
          expect(await frameZIndex(app, "p1")).toBeLessThan(
            await frameZIndex(app, "p2"),
          );

          // A bare raise reorders the panes array and moves no frame, so it
          // must arm no settle window — one would hold every session card's
          // notifications for the length of a motion that never happens.
          // Raised and lowered again, so the assignment below still has a
          // raise to make.
          for (const paneId of ["p1", "p2"]) {
            await app.evalJS<null>(
              `(window.__tug.dispatchControlAction("focus-pane", { paneId: ${JSON.stringify(
                paneId,
              )} }), null)`,
            );
            await wait(120);
            expect(await settling(app)).toBe(false);
            expect(await frameAnimations(app)).toEqual([]);
          }
          expect(await frameZIndex(app, "p1")).toBeLessThan(
            await frameZIndex(app, "p2"),
          );

          // Now the gesture the rail's slot picker dispatches: put A at the
          // slot B already holds. A moves, so it tweens — and by the time it
          // does, it is already the frame on top.
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("assign-slot", { cardId: "A", slot: 1 }), null)`,
          );
          await app.waitForCondition<boolean>(
            `document.querySelector("[data-imposer-settling]") !== null`,
            { timeoutMs: 2_000 },
          );
          {
            // The window is marked at the arm, a frame or two before the
            // tween exists: a body moving with the frame is placed first
            // (set up, then go). So the read is at the tween's start, which
            // is the moment the raise has to precede.
            const startedBy = Date.now() + 2_000;
            let census = await frameAnimations(app);
            while (!census.some((a) => a.paneId === "p1") && Date.now() < startedBy) {
              await wait(16);
              census = await frameAnimations(app);
            }
            expect(census.map((a) => a.paneId)).toContain("p1");
            expect(await frameZIndex(app, "p1")).toBeGreaterThan(
              await frameZIndex(app, "p2"),
            );
          }

          await wait(AFTER_LAND_MS);
          expect(await settling(app)).toBe(false);
          expect(await frameLeft(app, "p1")).toBeCloseTo(
            expectedLeft(1, 2, vp, "right", rail),
            0,
          );
          expect(await frameZIndex(app, "p1")).toBeGreaterThan(
            await frameZIndex(app, "p2"),
          );
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
