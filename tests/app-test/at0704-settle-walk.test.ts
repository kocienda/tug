/**
 * at0704-settle-walk.test.ts — the walk across the band, and the forcing leg.
 *
 * `go-to-slot` out to the far end of a flow strip and home again, against the
 * bar, and then the FORCING leg: the same walk with a long task planted inside
 * the settle window, which must fail the bar the two legs before it passed.
 * Without it every green reading the settle files take is unfalsifiable — a
 * sampler that has silently stopped observing and a deck that genuinely
 * stopped dropping frames produce the same zeros. That is the exact failure
 * the 2026-09-18 drop fix made, where a fix was "verified" green and had not
 * fixed anything.
 *
 * The forcing leg lives here because this is the bar it falsifies:
 * `sampleB09Gesture` and `expectB09Bar` are one instrument across every
 * settle file, and the walk is the cheapest gesture whose plain reading sits
 * furthest inside the bar, so a forced failure here cannot be the deck's own
 * noise.
 *
 * The instrument, the fixture decks, the transcript arms and the bar are
 * `settle-frames-fixture.ts`'s; this file is one gesture's legs. Every card is
 * a session card bound to a real resumed transcript, and every leg runs on the
 * `slice` arm and, where the local corpus holds a whale, the `whale` arm.
 * These legs were `at0622-deck-settle-frames`, which carried every gesture in
 * one file and so selected — and paid for — all of them on a change to any one.
 *
 * @covers tugdeck/src/lib/gesture-drivers.ts
 * @covers tugdeck/src/lib/pane-flip.ts
 * @covers tugdeck/src/lib/settle-frame-probe.ts
 */

import { describe, expect, test } from "bun:test";

import { note } from "./_harness";
import { rmTempTugbank } from "./_harness/tugbank-helpers";
import {
  AFTER_LAND_MS,
  B09_GAP_FRAMES_BAR,
  BAR_TIMEOUT_MS,
  FORCED_STALL_MS,
  SHOULD_RUN,
  type SettleFramesRow,
  blobFor,
  expectB09Bar,
  expectBeats,
  home,
  launch,
  reportB09,
  sampleB09Gesture,
  traceWithSettleFrames,
  wait,
  transcriptArms,
} from "./settle-frames-fixture";

const TEST_NAME = "at0704-settle-walk";
const ARMS = transcriptArms();

/**
 * The walk across the band, both directions, against the bar.
 *
 * `go-to-slot` is the Go ▸ Go to Slot N door, and on a flow deck it is the
 * gesture that carries the reader from one end of the strip to the other with
 * no activation, no focus transfer and no card count change in it — the
 * cheapest motion the deck makes, and therefore the one with the least excuse
 * for a hole in it.
 *
 * Both directions, because the strip's two ends are not symmetric: the walk
 * out runs against a band whose far slots have never been laid out at their
 * final width, and the walk home runs against frames that have.
 */
for (const arm of ARMS) describe.skipIf(!SHOULD_RUN || arm.skip)(`at0704 — the walk across the band [${arm.size}]`, () => {
  test(
    "go-to-slot out and home holds the bar in both directions",
    async () => {
      const { app, tugbankPath } = await launch(4, blobFor(4), TEST_NAME, { transcripts: arm.size });
      try {
        await traceWithSettleFrames(app);
        await home(app);
        await wait(AFTER_LAND_MS);

        const out = await sampleB09Gesture(
          app,
          `window.__tug.dispatchControlAction("go-to-slot", { value: 4 })`,
        );
        reportB09("go-to-slot out", out);
        expectBeats("go-to-slot out", out, ["move"]);
        expectB09Bar("go-to-slot out", out);

        const back = await sampleB09Gesture(
          app,
          `window.__tug.dispatchControlAction("go-to-slot", { value: 1 })`,
        );
        reportB09("go-to-slot home", back);
        expectBeats("go-to-slot home", back, ["move"]);
        expectB09Bar("go-to-slot home", back);

        // ---- The forcing leg ([D5]), for all three of [B09]'s bars. -----
        //
        // One leg, not three, and the reason is that the three legs above
        // read one instrument through one sampler. What has to be shown is
        // that `sampleB09Gesture` and the bar over it notice a defect put
        // there on purpose; which gesture it is planted inside says nothing
        // more. The walk is the cheapest of the three to run and the one
        // whose plain reading sits furthest inside the bar, so a forced
        // failure here cannot be the deck's own noise.
        const forced = await sampleB09Gesture(
          app,
          `window.__tug.dispatchControlAction("go-to-slot", { value: 4 })`,
          FORCED_STALL_MS,
        );
        reportB09("go-to-slot forced", forced);
        expect(
          (forced.row as SettleFramesRow).motionLongestGapFrames,
          `go-to-slot forced: a ${FORCED_STALL_MS}ms task planted inside the ` +
            `settle window must fail the bar the two legs above just ` +
            `passed — out read ` +
            `${(out.row as SettleFramesRow).motionLongestGapMs.toFixed(0)}ms / ` +
            `${(out.row as SettleFramesRow).motionLongestGapFrames.toFixed(2)} ` +
            `frames; forced reads ` +
            `${(forced.row as SettleFramesRow).motionLongestGapMs.toFixed(0)}ms / ` +
            `${(forced.row as SettleFramesRow).motionLongestGapFrames.toFixed(2)}. ` +
            `Without this every green above is unfalsifiable: a sampler that ` +
            `stopped observing and a deck that stopped stalling read the same`,
        ).toBeGreaterThan(B09_GAP_FRAMES_BAR);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    BAR_TIMEOUT_MS,
  );
});
