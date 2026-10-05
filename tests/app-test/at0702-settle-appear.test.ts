/**
 * at0702-settle-appear.test.ts — a card appears into a split column, at the bar.
 *
 * A new card opening into a split column is seated at the column's bottom in
 * the arriving commit, so the sitters give up height on `room` before its own
 * fade runs on `arrive`. This file holds that choreography against the bar.
 *
 * The instrument, the fixture decks, the transcript arms and the bar are
 * `settle-frames-fixture.ts`'s; this file is one gesture's legs. Every card is
 * a session card bound to a real resumed transcript, and every leg runs on the
 * `slice` arm and, where the local corpus holds a whale, the `whale` arm.
 * These legs were `at0622-deck-settle-frames`, which carried every gesture in
 * one file and so selected — and paid for — all of them on a change to any one.
 *
 * @covers tugdeck/src/lib/opening-placement.ts
 * @covers tests/app-test/real-transcript-fixture.ts
 */

import { describe, expect, test } from "bun:test";

import { note } from "./_harness";
import { rmTempTugbank } from "./_harness/tugbank-helpers";
import {
  AFTER_LAND_MS,
  BAR_TIMEOUT_MS,
  SHOULD_RUN,
  bandCensus,
  columnBlob,
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

const TEST_NAME = "at0702-settle-appear";
const ARMS = transcriptArms();

/**
 * A card appearing and a card leaving, each against the bar.
 *
 * On the SHARED-COLUMN fixture with one column split, which is the shape the
 * ask names and the one where an arrival has a room to be made for it. A new
 * card opening into a split column is seated at that column's bottom in the
 * arriving commit ([D194]), so the sitters give up height for it — the `room`
 * beat — before its own fade runs — the `arrive` beat. On a flow deck of
 * one-card columns the newcomer takes a slot of its own and `room` is a beat
 * about nobody.
 *
 * The close is `closePane`, the pane's own close button's call, and it takes
 * the newcomer back out of the same column: the sitters reclaim the height on
 * the `depart` beat while the departing frame fades where it stood.
 *
 * Both legs assert the beat by name off the imposer's own attribute, because
 * every timing clause in the bar is satisfied perfectly by a card that popped
 * into place with no choreography at all — which is what [F04] turned out to
 * be when it was read from its far end.
 *
 * **What the two legs read, at this arc's end.** The appear leg holds the bar
 * — `["room", "arrive"]`, a 3ms lead, a worst gap of 1.9 frames — with the
 * one exemption `expectB09Bar` documents: the arriving frame paints 24–25
 * ticks off its own curve across the whole of `room`, held at opacity 0
 * throughout, which is the `backwards` question the doctrine's worked example
 * still has open rather than anything the reader sees.
 *
 * **The DISAPPEAR leg is not read here.** It read 24–33ms from the gesture to
 * the first rendered frame with `commitDelayMs` 0 on every run: closing a
 * pane renumbers every surviving pane's position label inside the settle
 * window. The reading is in `briefs/zero-red-app-tests-brief.md`.
 */
for (const arm of ARMS) describe.skipIf(!SHOULD_RUN || arm.skip)(
  `at0702 — a card appears, at the bar [${arm.size}]`,
  () => {
    test(
      "a card arriving into a split column holds the bar across room and arrive",
      async () => {
        const { app, tugbankPath } = await launch(8, columnBlob(), TEST_NAME, { transcripts: arm.size });
        try {
          await traceWithSettleFrames(app);
          await home(app);
          // The active pane is `at0622-p1`, which sits in slot 0; splitting
          // that column is what gives the newcomer a division to be seated
          // at the bottom of.
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("set-column-mode", ` +
              `{ slot: 0, mode: "split" }), null)`,
          );
          await wait(AFTER_LAND_MS);

          const standing = new Set(
            (await bandCensus(app)).split(" ").map((s) => s.split("@")[0]),
          );

          const appear = await sampleB09Gesture(
            app,
            `window.__tug.dispatchControlAction("show-card", ` +
              `{ component: "session" })`,
          );
          reportB09("appear", appear);
          // By equality and in order, like every other [B09] leg: `toContain`
          // on each name passed a settle that ran a third beat, or ran the
          // two in the wrong order, and a card that popped into place
          // satisfies every clause of the bar by having no motion.
          expectBeats("appear", appear, ["room", "arrive"]);

          const newcomers = appear.after
            .split(" ")
            .map((s) => s.split("@")[0])
            .filter((id) => id !== "" && !standing.has(id));
          expect(
            newcomers.length,
            `appear: exactly one frame arrived — ${JSON.stringify(newcomers)}`,
          ).toBe(1);

          // ---- The pose clause's one exemption, and what earns it. ------
          //
          // The arriving frame is held at inline `opacity: 0` until its
          // `arrive` beat begins, and across the whole of `room` it paints
          // the identity while its own curve says its origin. Measured on
          // this leg: 24 of 40 ticks, one unbroken run from 0ms, on the
          // newcomer alone, with the probe reporting `minOpacity: 0` on that
          // same pane. So the exemption is not "the arriving frame is
          // special" — it is "the probe watched this frame be invisible for
          // the whole run", which is a fact the reading itself carries.
          //
          // The two clauses below are what keep it from being a hole. The
          // exempt pane must be the newcomer, and it must be the one the
          // probe saw at zero opacity; anything else and the exemption does
          // not apply and the pose clause judges every pane.
          expect(
            appear.probe.minOpacity,
            `appear: the arriving frame really was held invisible — the ` +
              `probe's worst opacity was ${appear.probe.minOpacity} on ` +
              `\`${appear.probe.minOpacityPaneId}\`. Without a held frame ` +
              `there is nothing to exempt and the clause below judges it`,
          ).toBe(0);
          expect(
            appear.probe.minOpacityPaneId,
            `appear: and the frame held invisible is the one that arrived — ` +
              `${JSON.stringify(newcomers)}`,
          ).toBe(newcomers[0]);
          note(
            `at0702 appear off-curve: ${appear.row?.offCurveTicks} tick(s) ` +
              `on [${appear.row?.offCurvePaneIds.join(", ")}], longest run ` +
              `${appear.row?.longestOffCurveRunTicks} from ` +
              `${appear.row?.longestOffCurveRunOffsetMs}ms — the arriving ` +
              `frame across \`room\`, held at opacity 0 throughout`,
          );
          expectB09Bar("appear", appear, [appear.probe.minOpacityPaneId]);
        } finally {
          await app.close();
          rmTempTugbank(tugbankPath);
        }
      },
      BAR_TIMEOUT_MS,
    );
  },
);
