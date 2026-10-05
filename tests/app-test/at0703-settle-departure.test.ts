/**
 * at0703-settle-departure.test.ts — a card's departure from a split column.
 *
 * The same newcomer closed back out of the column it arrived in: the departing
 * frame fades where it stood on `depart` while the sitters reclaim the height
 * on `room`. The beats and the land are asserted; the gap is sampled and
 * reported, not judged; the window's main-thread time is held under
 * `MAIN_THREAD_BAR_MS.close`.
 *
 * The instrument, the fixture decks, the transcript arms and the bar are
 * `settle-frames-fixture.ts`'s; this file is one gesture's legs. Every card is
 * a session card bound to a real resumed transcript, and every leg runs on the
 * `slice` arm and, where the local corpus holds a whale, the `whale` arm.
 * These legs were `at0622-deck-settle-frames`, which carried every gesture in
 * one file and so selected — and paid for — all of them on a change to any one.
 *
 * @covers tugdeck/src/lib/layout-imposer.ts
 * @covers tugdeck/src/deck-trace.ts
 * @covers tests/app-test/real-transcript-fixture.ts
 */

import { describe, expect, test } from "bun:test";

import { note } from "./_harness";
import { rmTempTugbank } from "./_harness/tugbank-helpers";
import {
  AFTER_LAND_MS,
  BAR_TIMEOUT_MS,
  SHOULD_RUN,
  armedMainThreadMark,
  bandCensus,
  columnBlob,
  expectLand,
  expectMainThreadUnderBar,
  noteBeatStarts,
  expectBeats,
  home,
  largestCommit,
  launch,
  reactCommits,
  readMainThread,
  reportB09,
  sampleB09Gesture,
  traceWithSettleFrames,
  wait,
  windowCommits,
  transcriptArms,
} from "./settle-frames-fixture";

const TEST_NAME = "at0703-settle-departure";
const ARMS = transcriptArms();

/**
 * A card's departure from a split column, against the bar.
 *
 * The arrival that precedes it is the appear leg above, sampled here as the
 * setup and not judged: a departure needs a card to depart. The close is
 * `closePane`, the pane's own close button's call, and it takes the newcomer
 * back out of the column it arrived in. The departing frame fades where it
 * stood on `depart` while the sitters reclaim the height on `room`.
 *
 * The lead recorder is installed first, so every commit in the window carries
 * its render time; the departing pane renders in the close's commit and is
 * unmounted by the land's, and the largest in-window commit is what the
 * reading names beside the gap.
 *
 * **Sampled and reported, NOT judged.** On three solo runs its gap read
 * 2.06–2.24 frames against 2, with a first paint at 2–4 ms and
 * `commitDelayMs` 0. What lands in the window is the close's own deck commit
 * (580 performed fibers, the survivors re-rendering for `placement`) followed
 * within 30 ms by the survivors' tooltip and popover-button trees (450, 192,
 * 184 performed). The departing frame itself renders nothing new. The
 * readings and the cause are in
 * `briefs/departing-and-height-crossing-readings.md`; the beats are asserted,
 * and the bar waits on that cause.
 */
for (const arm of ARMS) describe.skipIf(!SHOULD_RUN || arm.skip)(
  `at0703 — a card's departure from a split column [${arm.size}]`,
  () => {
    test(
      "the same card closed out of the column it arrived in, across depart and room",
      async () => {
        const { app, tugbankPath } = await launch(8, columnBlob(), TEST_NAME, {
          transcripts: arm.size,
          leadRecorder: true,
        });
        try {
          await traceWithSettleFrames(app);
          await home(app);
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
          reportB09("appear (setup)", appear);
          const newcomers = appear.after
            .split(" ")
            .map((s) => s.split("@")[0])
            .filter((id) => id !== "" && !standing.has(id));
          expect(
            newcomers.length,
            `appear (setup): exactly one frame arrived — ${JSON.stringify(newcomers)}`,
          ).toBe(1);

          const mark = await armedMainThreadMark(app);
          const disappear = await sampleB09Gesture(
            app,
            `window.__tug.closePane(${JSON.stringify(newcomers[0])})`,
          );
          reportB09("disappear", disappear);
          note(`at0703 disappear commits: ${JSON.stringify(await reactCommits(app))}`);
          const window_ = await windowCommits(app, mark);
          const largest = window_ === null ? null : largestCommit(window_.commits);
          const mainThread =
            window_ === null ? null : await readMainThread(app, "at0703 disappear", window_);
          note(
            `at0703 disappear window: ${window_?.commits.length ?? 0} commit(s); ` +
              `largest ${JSON.stringify(
                largest === null
                  ? null
                  : {
                      t: largest.t,
                      performed: largest.performed,
                      mounted: largest.mounted,
                      fibers: largest.fibers,
                      reactMs: largest.reactMs,
                      origins: largest.origins,
                    },
              )}`,
          );
          expectBeats("disappear", disappear, ["depart", "room"]);
          noteBeatStarts("disappear", disappear.beatRows, disappear.probe.framePeriodMs);
          expectLand("disappear", disappear.land);
          expect(window_, `disappear: the settle window was found in the trace`).not.toBeNull();
          expectMainThreadUnderBar("disappear", "close", mainThread as NonNullable<typeof mainThread>);
        } finally {
          await app.close();
          rmTempTugbank(tugbankPath);
        }
      },
      BAR_TIMEOUT_MS,
    );
  },
);
