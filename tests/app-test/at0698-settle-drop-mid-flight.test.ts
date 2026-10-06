/**
 * at0698-settle-drop-mid-flight.test.ts — a settle dropped mid-flight leaves no frame at its origin.
 *
 * The settle's `fill: "backwards"` holds each frame's start pose before the
 * active phase, which is exactly the window an interrupted settle dies in. So
 * every way out of a settle is a way of leaving a frame wearing its origin,
 * and this file makes the claim on each exit it can reach.
 *
 * The instrument, the fixture decks, the transcript arms and the bar are
 * `settle-frames-fixture.ts`'s; this file is one gesture's legs. Every card is
 * a session card bound to a real resumed transcript, and every leg runs on the
 * `slice` arm and, where the local corpus holds a whale, the `whale` arm.
 * These legs were `at0622-deck-settle-frames`, which carried every gesture in
 * one file and so selected — and paid for — all of them on a change to any one.
 *
 * @covers tugdeck/src/components/chrome/settle-engine.ts
 * @covers tugdeck/src/components/chrome/settle-crossings.ts
 */

import { describe, expect, test } from "bun:test";

import { note } from "./_harness";
import { rmTempTugbank } from "./_harness/tugbank-helpers";
import {
  AFTER_LAND_MS,
  FORCED_STALL_MS,
  SHOULD_RUN,
  SHOWN_FRAMES,
  SPACE_ID,
  STALL_PLANTED_AT_MS,
  TEST_TIMEOUT_MS,
  activateLast,
  activePaneId,
  blobFor,
  home,
  launch,
  pauseAnimationsFor,
  releaseSources,
  residualTranslates,
  resumePausedAnimations,
  tearDownSettle,
  traceMark,
  traceWithSettleFrames,
  wait,
  transcriptArms,
} from "./settle-frames-fixture";

const TEST_NAME = "at0698-settle-drop-mid-flight";
const ARMS = transcriptArms();
/** The sweep leg's wait: the sweep guards twice the settle's window, floored at a second, and room after. */
const SWEEP_WAIT_MS = 3_000;

// ---------------------------------------------------------------------------
// The cancel guarantee
// ---------------------------------------------------------------------------

/**
 * A settle dropped before its tweens finish leaves no frame at its origin.
 *
 * This is the claim the settle's `fill: "backwards"` rests on, and the reason
 * it is a separate test rather than another clause on the bar. A backwards fill
 * holds each frame's start pose BEFORE the active phase, which is exactly the
 * window an interrupted settle dies in — so every way out of a settle is now a
 * way of leaving a frame wearing its origin, and "the deck looks right
 * afterwards" is a claim that has to be made on each exit separately rather
 * than inferred from a gesture that completed.
 *
 * Five legs: a settle carrying a task three times longer than its own window,
 * a retarget dispatched mid-beat, a space switch thrown at a settle in flight,
 * a settle whose animations are paused so the window sweep releases it, and a
 * settle whose engine is torn down mid-beat. What each asserts is the same
 * thing — once the deck is at rest, no shown frame computes a translate —
 * because a frame at rest is committed at Last and the imposer owns nothing on
 * it.
 *
 * The first three release from `"completion"`: the stall does not outlast the
 * settle's own completion handler, and a space switch swaps the shown layer
 * without tearing this canvas down. They are named for the gestures they make
 * rather than for exits they do not reach. The last two each assert the clock
 * that released — `"sweep"` and `"unmount"` — because a leg that claimed an
 * exit and released from completion would be a green proving a different
 * thing than the one on its label.
 */
for (const arm of ARMS) describe.skipIf(!SHOULD_RUN || arm.skip)(
  `at0698 — a settle dropped mid-flight leaves no frame at its origin [${arm.size}]`,
  () => {
    test(
      "a stalled settle, a retarget and a space switch each land the deck with every frame at Last",
      async () => {
        const { app, tugbankPath } = await launch(4, blobFor(4), TEST_NAME, { transcripts: arm.size });
        try {
          await traceWithSettleFrames(app);

          // ---- Leg 1: a long task planted inside the settle window. ----
          //
          // The stall makes the pending window wide, which is the window a
          // backwards fill is applying a start pose through. If the fill's
          // pose could outlive the settle, a run whose tweens were still
          // pending when the window closed is where it would show.
          //
          // It was written to reach the window sweep and does not: three times
          // the forcing stall still releases from `"completion"`, because the
          // completion handler runs as soon as the thread comes back. The leg
          // is kept for the reading it does take.
          await home(app);
          let mark = await traceMark(app);
          await app.armSettleFrameProbe();
          await wait(120);
          await activateLast(app, 4);
          await wait(STALL_PLANTED_AT_MS);
          await app.forceSettleStall(FORCED_STALL_MS * 3);
          await wait(AFTER_LAND_MS * 2);
          const stalledProbe = await app.takeSettleFrameReading();
          await app.disarmSettleFrameProbe();
          const stalledExits = await releaseSources(app, mark);
          const stalledResidue = await residualTranslates(app);
          note(
            `at0698 cancel/stall: exits=${JSON.stringify(stalledExits)} ` +
              `residue=${JSON.stringify(stalledResidue)} ` +
              `offCurveTicks=${stalledProbe.offCurveTicks} ` +
              `pendingTicks=${stalledProbe.pendingTicks}`,
          );
          expect(
            stalledProbe.suspended,
            `stall leg: the window was served — ${stalledProbe.ticks} ticks. ` +
              `A suspended window reports the same zeros as a clean exit`,
          ).toBe(false);
          expect(
            [...stalledResidue],
            `stall leg: a settle carrying a ${FORCED_STALL_MS * 3}ms task left ` +
              `every frame at Last. A pane named here is wearing the opening ` +
              `pose of a beat that is over, which is what a fill that outlived ` +
              `its own active phase would produce`,
          ).toEqual([]);

          // ---- Leg 2: a retarget mid-settle. ---------------------------
          //
          // The second activation's `arm` cancels tweens that had not started
          // — `hold-at-current` on a tween with no progress to hold — and
          // bumps the generation so the first gesture's landing is ignored.
          // The two are not separable, so this leg covers both.
          await home(app);
          mark = await traceMark(app);
          await app.armSettleFrameProbe();
          await wait(120);
          await activateLast(app, 4);
          // Inside the 400ms move beat, and early enough that some tweens
          // have not started: this is the retarget's own window.
          await wait(80);
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("focus-session-card", ` +
              `{ cardId: "at0622-c1" }), null)`,
          );
          await wait(AFTER_LAND_MS * 2);
          const retargetProbe = await app.takeSettleFrameReading();
          await app.disarmSettleFrameProbe();
          const retargetExits = await releaseSources(app, mark);
          const retargetResidue = await residualTranslates(app);
          const landedOn = await activePaneId(app);
          note(
            `at0698 cancel/retarget: exits=${JSON.stringify(retargetExits)} ` +
              `residue=${JSON.stringify(retargetResidue)} ` +
              `landedOn=${landedOn} ` +
              `offCurveTicks=${retargetProbe.offCurveTicks} ` +
              `run=${retargetProbe.longestOffCurveRunTicks} ` +
              `offset=${retargetProbe.longestOffCurveRunOffsetMs}ms`,
          );
          expect(
            retargetProbe.suspended,
            `retarget leg: the window was served — ${retargetProbe.ticks} ticks`,
          ).toBe(false);
          expect(
            landedOn,
            `retarget leg: the deck landed at the SECOND gesture's ` +
              `arrangement. Landing on the first would mean the retarget's ` +
              `generation bump did not take, and every other claim here would ` +
              `be about a gesture nobody made`,
          ).toBe("at0622-p1");
          expect(
            [...retargetResidue],
            `retarget leg: and no frame kept the cancelled gesture's opening ` +
              `pose. A tween cancelled before it started is the exact case a ` +
              `backwards fill changes, because it is the case where the fill ` +
              `was the only thing painting the frame`,
          ).toEqual([]);

          // ---- Leg 3: a space switch thrown at a settle in flight. -----
          //
          // The frames the switch leaves behind are checked, and then the
          // original space is brought back and ITS frames are checked —
          // without the second half the leg would be asserting over a layer
          // that never animated, which nothing could fail. The second half is
          // where the claim actually lives: a deck whose settle was
          // interrupted by the switch comes back with every frame at Last.
          //
          // It does NOT reach the `"unmount"` release. The switch swaps the
          // shown layer and this canvas survives it, so the settle still
          // releases from `"completion"`. Said here so a later reader does not
          // take this leg for the teardown proof it is not.
          await home(app);
          mark = await traceMark(app);
          await wait(120);
          await activateLast(app, 4);
          await wait(80);
          await app.dispatchControlAction("new-space");
          await wait(AFTER_LAND_MS * 2);
          const unmountExits = await releaseSources(app, mark);
          const arrivedResidue = await residualTranslates(app);
          note(
            `at0698 cancel/unmount: exits=${JSON.stringify(unmountExits)} ` +
              `arrivedResidue=${JSON.stringify(arrivedResidue)}`,
          );
          expect(
            [...arrivedResidue],
            `unmount leg: the layer that survives the switch carries no ` +
              `translate`,
          ).toEqual([]);

          await app.dispatchControlAction("activate-space", {
            spaceId: SPACE_ID,
          });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(SHOWN_FRAMES)}).length >= 5`,
            { timeoutMs: 30_000 },
          );
          await wait(AFTER_LAND_MS * 2);
          const returnedResidue = await residualTranslates(app);
          note(
            `at0698 cancel/unmount returned: ` +
              `residue=${JSON.stringify(returnedResidue)}`,
          );
          note(
            `at0698 cancel/exits covered: stall=${JSON.stringify(stalledExits)} ` +
              `retarget=${JSON.stringify(retargetExits)} ` +
              `switch=${JSON.stringify(unmountExits)}`,
          );
          expect(
            [...returnedResidue],
            `unmount leg: and the deck the switch interrupted comes back with ` +
              `every frame at Last. A pane named here kept an origin pose ` +
              `across a teardown that ran no landing — the one exit where ` +
              `nothing is left to put it right`,
          ).toEqual([]);

          // ---- Leg 4: the window sweep. ---------------------------------
          //
          // Every animation the settle launches is paused as it starts, so
          // none finishes and no completion lands: the settle's window timer
          // is the exit that releases it, and its snap-to-end is the only
          // thing that puts the frames at Last.
          await home(app);
          mark = await traceMark(app);
          await wait(120);
          await activateLast(app, 4);
          await pauseAnimationsFor(app, 600);
          await wait(SWEEP_WAIT_MS);
          await resumePausedAnimations(app);
          const sweepExits = await releaseSources(app, mark);
          const sweepResidue = await residualTranslates(app);
          note(
            `at0698 cancel/sweep: exits=${JSON.stringify(sweepExits)} ` +
              `residue=${JSON.stringify(sweepResidue)}`,
          );
          expect(
            sweepExits,
            `sweep leg: the paused settle was released by the window sweep`,
          ).toContain("sweep");
          expect(
            [...sweepResidue],
            `sweep leg: and the sweep left every frame at Last`,
          ).toEqual([]);

          // ---- Leg 5: the teardown. ------------------------------------
          //
          // The engine's teardown — the canvas unmount's body — runs inside
          // the move beat, with the frames still mounted to be read.
          await home(app);
          mark = await traceMark(app);
          await wait(120);
          await activateLast(app, 4);
          await wait(80);
          await tearDownSettle(app);
          await wait(AFTER_LAND_MS * 2);
          const teardownExits = await releaseSources(app, mark);
          const teardownResidue = await residualTranslates(app);
          note(
            `at0698 cancel/teardown: exits=${JSON.stringify(teardownExits)} ` +
              `residue=${JSON.stringify(teardownResidue)}`,
          );
          expect(
            teardownExits,
            `teardown leg: the settle was released by the unmount's teardown`,
          ).toContain("unmount");
          expect(
            [...teardownResidue],
            `teardown leg: and the teardown left every frame at Last`,
          ).toEqual([]);
        } finally {
          await app.close();
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
