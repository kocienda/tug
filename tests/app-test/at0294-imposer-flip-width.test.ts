/**
 * at0294-imposer-flip-width.test.ts — a deck-wide content-width change crosses on the settle's beats, over the smear cap by real width rather than a scale, and keeps neither transform nor origin.
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
  PANE_WIDTH,
  deckShape,
  expectedLeft,
  firstKeyframeTransforms,
  frameAnimations,
  frameLeft,
  inlineTransformOrigins,
  inlineTransforms,
  inlineWidths,
  railWidth,
  runningBeat,
  seedRailPreferred,
  setContentWidth,
  settling,
  viewportWidth,
  wait,
  widthKeyframeEndpoints,
  type FrameAnimation,
} from "./imposer-flip-fixture";

describe.skipIf(!SHOULD_RUN)(
  "at0294 — the imposer settles by transform-only FLIP and leaves no residue",
  () => {
    test(
      "a deck-wide width change crosses too — over the cap, by real width rather than a smear",
      async () => {
        const app = await launchTugApp({
          testName: "at0294-imposer-flip-width",
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

          // The Layouts section's width row. Every content pane goes from the
          // seed's 420 to slim's 675, which moves the seams as well as the
          // boxes — the whole arrangement changes, and none of it may cut.
          await setContentWidth(app, "slim");

          await app.waitForCondition<boolean>(
            `document.querySelector("[data-imposer-settling]") !== null`,
            { timeoutMs: 2_000 },
          );
          {
            // 420 → 675 is over the smear cap ([D135]:
            // `MAX_FLIP_SCALE_DISTORTION`), so the width crosses as real
            // geometry — and a real size term never shares a beat with a
            // translate. The settle runs as beats, shrink then move then
            // grow; whatever the deck shrinks to make room runs first, and
            // the content frames are read at the move. Slot 0 anchors the
            // band's start, so p1's left never moves under a deck width
            // change and its whole crossing is the grow beat — through the
            // move it waits, its width held at 420 inline. p2's left shifts
            // with the width, so it moves, transform-only, at its First
            // width, and grows after.
            const effects = (
              census: FrameAnimation[],
              paneId: string,
            ): string[] =>
              census
                .filter((anim) => anim.paneId === paneId && anim.phase === "active")
                .map((anim) =>
                  anim.properties
                    .filter((p) => p !== "offset" && p !== "computedOffset" &&
                      p !== "easing" && p !== "composite")
                    .join(","),
                )
                .sort();
            await app.waitForCondition<boolean>(
              `document.querySelector("[data-imposer-beat='move']") !== null`,
              { timeoutMs: 2_000 },
            );
            expect(await runningBeat(app)).toBe("move");
            {
              const census = await frameAnimations(app);
              expect(effects(census, "p1")).toEqual([]);
              expect(effects(census, "p2")).toEqual(["transform"]);
              // p1's grow beat EXISTS through the move and is not running:
              // the settle creates every beat in one frame and holds each off
              // by the beats before it, so what keeps p1's width at First
              // through the move is still the inline hold `applyHolds` wrote
              // at launch: a DELAYED beat fills `none`, so its effect applies
              // nothing while it waits. What the beat no longer needs at its
              // boundary is a compositor. The old chain created the effect
              // there instead, and lost a frame doing it.
              const waiting = census
                .filter((a) => a.paneId === "p1" && a.phase === "before")
                .map((a) => a.properties.filter((p) => p === "width").join(","));
              expect(waiting).toEqual(["width"]);
            }
            // The transform tween carries no scale at all — the width delta
            // rides as real geometry, so nothing inside the frame is ever a
            // stretched raster. A zero vertical term comes back from the
            // engine as the one-argument `translate(0px)`, so the y is
            // optional here.
            const starts = await firstKeyframeTransforms(app);
            expect(starts["p2"]).toMatch(
              /^translate\(-?[\d.]+px(, -?[\d.]+px)?\)$/,
            );
            // Both frames hold their First width through the move: the
            // commit already gave them 675, and the hold is what keeps the
            // grow for the grow beat.
            {
              const held = await inlineWidths(app);
              expect(held["p1"]).toBe(`${PANE_WIDTH}px`);
              expect(held["p2"]).toBe(`${PANE_WIDTH}px`);
            }
            // The origin is the transform tween's to write, so only the frame
            // that carries one wears it.
            const origins = await inlineTransformOrigins(app);
            expect(origins["p1"]).toBe("");
            expect(origins["p2"]).toBe("0px 0px");
            // Then the grow beat: both frames' width tweens walk the real
            // endpoints, from the seed's width to the preset's, pinned at
            // both ends — and nothing translates.
            await app.waitForCondition<boolean>(
              `document.querySelector("[data-imposer-beat='grow']") !== null`,
              { timeoutMs: 2_000 },
            );
            {
              const census = await frameAnimations(app);
              expect(effects(census, "p1")).toEqual(["width"]);
              expect(effects(census, "p2")).toEqual(["width"]);
            }
            const widths = await widthKeyframeEndpoints(app);
            for (const paneId of ["p1", "p2"]) {
              expect(widths[paneId]).toEqual({
                first: `${PANE_WIDTH}px`,
                last: "675px",
              });
            }
          }

          // After land: the boxes are the preset's, sitting where the imposer
          // puts a 675-wide pane, and no frame keeps either half of the pose
          // the tween wore.
          await wait(AFTER_LAND_MS);
          expect(await settling(app)).toBe(false);
          expect(await frameAnimations(app)).toEqual([]);
          {
            const inline = await inlineTransforms(app);
            expect(Object.values(inline).every((v) => v === "")).toBe(true);
            const origins = await inlineTransformOrigins(app);
            expect(Object.values(origins).every((v) => v === "")).toBe(true);
          }
          const rail = await railWidth(app);
          for (const [paneId, slot] of [
            ["p1", 0],
            ["p2", 1],
          ] as const) {
            expect(
              await app.evalJS<number>(
                `document.querySelector('.tug-pane[data-pane-id="${paneId}"]').getBoundingClientRect().width`,
              ),
            ).toBeCloseTo(675, 0);
            expect(await frameLeft(app, paneId)).toBeCloseTo(
              expectedLeft(slot, 2, vp, "right", rail, 675),
              0,
            );
          }
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
