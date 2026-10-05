/**
 * at0705-settle-bullseye.test.ts — bullseye in and out, and [F15]'s width.
 *
 * Bullseye on a wide deck crosses by real `width` rather than raster
 * `scaleX`, because the distortion is past `MAX_FLIP_SCALE_DISTORTION`. This
 * file holds the bar in both directions and that the runtime [D9] guard
 * reports `:width` and nothing else.
 *
 * The instrument, the fixture decks, the transcript arms and the bar are
 * `settle-frames-fixture.ts`'s; this file is one gesture's legs. Every card is
 * a session card bound to a real resumed transcript, and every leg runs on the
 * `slice` arm and, where the local corpus holds a whale, the `whale` arm.
 * These legs were `at0622-deck-settle-frames`, which carried every gesture in
 * one file and so selected — and paid for — all of them on a change to any one.
 *
 * @covers tugdeck/src/lib/pane-flip.ts
 * @covers tuglaws/animation-doctrine.md
 */

import { describe, expect, test } from "bun:test";

import { note } from "./_harness";
import { rmTempTugbank } from "./_harness/tugbank-helpers";
import {
  AFTER_LAND_MS,
  BAR_TIMEOUT_MS,
  SHOULD_RUN,
  bandCensus,
  blobFor,
  expectB09Bar,
  expectBeats,
  home,
  launch,
  report,
  reportB09,
  sampleB09Gesture,
  traceWithSettleFrames,
  wait,
  transcriptArms,
} from "./settle-frames-fixture";

const TEST_NAME = "at0705-settle-bullseye";
const ARMS = transcriptArms();

/**
 * Bullseye in and out, against the bar — and [F15] named by a test.
 *
 * `toggle-bullseye` puts the frontmost pane alone in the band and takes it
 * out again. Its term is a real `width`: the distortion the flip would have
 * to carry as `scaleX` is past `MAX_FLIP_SCALE_DISTORTION`, so `pane-flip.ts`
 * tweens width keyframes instead and re-wraps the subtree every frame. That
 * is a [D9] violation the doctrine does not name — the worked example still
 * says width crosses as `scaleX` — and until this leg existed the runtime
 * guard had never been SHOWN reporting `:width` on any gesture. The column
 * leg asserts `:height` the same way, and for the same reason: a standing
 * violation the doctrine records in prose and no test exercises is a comment,
 * not a fact.
 *
 * **On a WIDE deck rather than the fixture's own width, and that is [F15]
 * read narrower than the brief states it.** Whether a width change rides as
 * a real term or as a raster `scaleX` is a question about the distortion,
 * not about the gesture, and `MAX_FLIP_SCALE_DISTORTION` was chosen to admit
 * the ADJACENT preset — `pane-flip.ts` says so where the constant is
 * declared. The deck's three widths are slim 675, comfy 800 and wide 1230,
 * and bullseye opens the frontmost pane at comfy; from slim that is one step
 * and reads 0.185, just inside the cap. Run at the fixture's own width this
 * leg's first reading was an empty violation list — the guard saw nothing
 * because there was nothing to see. So the leg sets the deck to wide first,
 * through `set-content-width`, which is the Layout card's own door: 1230 →
 * 800 is two steps and a distortion of 0.54, and the width really rides.
 *
 * What that costs [F15] is its generality, and the finding is worth more
 * stated correctly: the width-over-cap path is bullseye's ON A WIDE DECK,
 * not bullseye's as such.
 *
 * So the violation clause here is two-sided. The guard must report something
 * — an empty list would mean the gesture never took the width path and the
 * clause proved nothing — and everything it reports must be `:width`. Any
 * other property is a second standing violation nobody has written down.
 */
for (const arm of ARMS) describe.skipIf(!SHOULD_RUN || arm.skip)(`at0705 — bullseye, and [F15]'s width [${arm.size}]`, () => {
  test(
    "bullseye in and out holds the bar, and the runtime guard reports :width and nothing else",
    async () => {
      const { app, tugbankPath } = await launch(4, blobFor(4), TEST_NAME, { transcripts: arm.size });
      try {
        await traceWithSettleFrames(app);
        await home(app);
        // Two preset steps from where bullseye opens, so the flip crosses by
        // real geometry rather than by raster; see the docblock.
        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("set-content-width", ` +
            `{ preset: "wide" }), null)`,
        );
        await wait(AFTER_LAND_MS);
        await home(app);
        await wait(AFTER_LAND_MS);
        note(`at0705 bullseye fixture at wide: ${await bandCensus(app)}`);

        const enter = await sampleB09Gesture(
          app,
          `window.__tug.dispatchControlAction("toggle-bullseye", {})`,
        );
        reportB09("bullseye enter", enter);
        expectBeats("bullseye enter", enter, ["shrink", "move"]);
        expect(
          enter.violations.length,
          `bullseye enter: the runtime [D9] guard reported something — an ` +
            `empty list here means the gesture never took the width path and ` +
            `the clause below is about nothing ([F15])`,
        ).toBeGreaterThan(0);
        expect(
          [
            ...new Set(
              enter.violations.map((v) => v.slice(v.lastIndexOf(":") + 1)),
            ),
          ].sort(),
          `bullseye enter: and every property it reported is \`width\` — ` +
            `${JSON.stringify(enter.violations)}. [F15]: width over the ` +
            `scale cap is the second standing [D9] hit, and anything else ` +
            `here is a third nobody has written down`,
        ).toEqual(["width"]);
        expectB09Bar("bullseye enter", enter);

        const exit = await sampleB09Gesture(
          app,
          `window.__tug.dispatchControlAction("toggle-bullseye", {})`,
        );
        reportB09("bullseye exit", exit);
        expectBeats("bullseye exit", exit, ["move", "grow"]);
        expect(
          [
            ...new Set(
              exit.violations.map((v) => v.slice(v.lastIndexOf(":") + 1)),
            ),
          ].sort(),
          `bullseye exit: the same on the way out — ` +
            `${JSON.stringify(exit.violations)}`,
        ).toEqual(["width"]);
        expectB09Bar("bullseye exit", exit);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    BAR_TIMEOUT_MS,
  );
});
