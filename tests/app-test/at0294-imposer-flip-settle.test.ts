/**
 * at0294-imposer-flip-settle.test.ts — the imposer settles by FLIP, transform-only mid-window, lands where `imposeRect` says, and leaves no inline transform after two settles.
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
  inlineTransforms,
  railWidth,
  releaseSources,
  seedRailPreferred,
  setRailSide,
  settling,
  viewportWidth,
  wait,
} from "./imposer-flip-fixture";

describe.skipIf(!SHOULD_RUN)(
  "at0294 — the imposer settles by transform-only FLIP and leaves no residue",
  () => {
    test(
      "transform-only mid-window, correct geometry at land, and no inline transform after two settles",
      async () => {
        const app = await launchTugApp({
          testName: "at0294-imposer-flip-settle",
        });
        try {
          // The settle's own records — its arm and its release — ride the
          // deck-trace ring, which records them only while enabled.
          await app.enableDeckTrace(true);
          await seedRailPreferred(app);
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(FRAMES)}).length === 3`,
            { timeoutMs: 5_000 },
          );
          await wait(AFTER_LAND_MS);

          const vp = await viewportWidth(app);

          // --- Settle one: the Layout card crosses to the left. -------------------
          const releasesBefore = (await releaseSources(app)).length;
          await setRailSide(app, "left");

          // Mid-window. The container marks the gesture, and every animation
          // running on a frame touches transform and nothing else — a single
          // layout property in this census is the whole regression.
          await app.waitForCondition<boolean>(
            `document.querySelector("[data-imposer-settling]") !== null`,
            { timeoutMs: 2_000 },
          );
          {
            const census = await frameAnimations(app);
            expect(census.length).toBeGreaterThan(0);
            for (const anim of census) {
              expect(anim.properties.filter((p) => p !== "offset" &&
                p !== "computedOffset" && p !== "easing" && p !== "composite"))
                .toEqual(["transform"]);
            }
          }

          // --- After land. -------------------------------------------------
          await wait(AFTER_LAND_MS);
          expect(await settling(app)).toBe(false);
          expect(await frameAnimations(app)).toEqual([]);
          // THIS settle's release — the records since the flip was
          // dispatched — came off on the settle's own clock, after the last
          // tween finished, and never from the window timer, which is a
          // wedge guard rather than the release ([B04] of
          // `three-beat-settle`).
          {
            const sources = (await releaseSources(app)).slice(releasesBefore);
            expect(sources.length).toBeGreaterThan(0);
            expect(sources[sources.length - 1]).toBe("completion");
            expect(sources).not.toContain("sweep");
          }

          // The residue rule, read off the INLINE style. A frame that never
          // wore a transform computes to `none`, so the computed value would
          // pass here whatever happened.
          {
            const inline = await inlineTransforms(app);
            expect(Object.values(inline).every((v) => v === "")).toBe(true);
          }

          // And the frames are where the imposer says, not a tween's length
          // short of it.
          {
            const rail = await railWidth(app);
            expect(await frameLeft(app, "p1")).toBeCloseTo(
              expectedLeft(0, 2, vp, "left", rail),
              0,
            );
            expect(await frameLeft(app, "p2")).toBeCloseTo(
              expectedLeft(1, 2, vp, "left", rail),
              0,
            );
          }

          // --- Settle two: back to the right. ------------------------------
          // The residue only appears after a settle has completed, so a
          // first-gesture-only test would miss a clear that runs once.
          await setRailSide(app, "right");
          await wait(AFTER_LAND_MS);
          {
            const inline = await inlineTransforms(app);
            expect(Object.values(inline).every((v) => v === "")).toBe(true);
          }
          expect(await frameLeft(app, "p1")).toBeCloseTo(
            expectedLeft(0, 2, vp, "right", await railWidth(app)),
            0,
          );

          // Every frame is a containing block, by design and at rest ([B01]).
          // The probe therefore resolves at the FRAME's origin rather than the
          // viewport's, and that is the rule rather than a defect — see this
          // file's docblock for why the claim was inverted rather than deleted.
          {
            const frameBox = await app.evalJS<{ x: number; y: number }>(
              `(function () {
                var r = document.querySelector('.tug-pane[data-pane-id="p2"]')
                  .getBoundingClientRect();
                return { x: r.left, y: r.top };
              })()`,
            );
            const probeOrigin = await app.evalJS<{ x: number; y: number }>(
              `(function () {
                var frame = document.querySelector('.tug-pane[data-pane-id="p2"]');
                var probe = document.createElement("div");
                probe.style.position = "fixed";
                probe.style.left = "0px";
                probe.style.top = "0px";
                probe.style.width = "1px";
                probe.style.height = "1px";
                frame.appendChild(probe);
                var r = probe.getBoundingClientRect();
                probe.remove();
                return { x: r.left, y: r.top };
              })()`,
            );
            expect(
              probeOrigin.x,
              "a fixed descendant resolves against its frame, not the viewport",
            ).toBeCloseTo(frameBox.x, 0);
            expect(probeOrigin.y).toBeCloseTo(frameBox.y, 0);
            expect(
              frameBox.x,
              "and the frame is genuinely off the viewport origin, or the " +
                "claim above would hold either way",
            ).toBeGreaterThan(1);
          }
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
