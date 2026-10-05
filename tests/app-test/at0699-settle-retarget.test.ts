/**
 * at0699-settle-retarget.test.ts — a settle interrupted mid-flight leaves no frame stranded.
 *
 * A second gesture arriving while the first's tweens are in flight: the arm
 * holds them `hold-at-current`, measures, and hands the residue back. Two
 * shapes — a fold retargeted by a fold, and a width change retargeted by a
 * fold — and the claim on both is that no frame stands at the first gesture's
 * end pose with no tween on it.
 *
 * The instrument, the fixture decks, the transcript arms and the bar are
 * `settle-frames-fixture.ts`'s; this file is one gesture's legs. Every card is
 * a session card bound to a real resumed transcript, and every leg runs on the
 * `slice` arm and, where the local corpus holds a whale, the `whale` arm.
 * These legs were `at0622-deck-settle-frames`, which carried every gesture in
 * one file and so selected — and paid for — all of them on a change to any one.
 *
 * @covers tugdeck/src/components/chrome/settle-engine.ts
 * @covers tugdeck/src/lib/fold-crossing.ts
 * @covers tugdeck/styles/chrome.css
 * @covers tugdeck/src/deck-trace.ts
 * @covers tests/app-test/real-transcript-fixture.ts
 */

import { describe, expect, test } from "bun:test";

import { note } from "./_harness";
import { rmTempTugbank } from "./_harness/tugbank-helpers";
import {
  AFTER_LAND_MS,
  RETARGET_AT_MS,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  type SettleFramesRow,
  blobFor,
  home,
  launch,
  paneHeightOf,
  residualTranslates,
  retargetRows,
  settleFrameRows,
  traceMark,
  traceWithSettleFrames,
  wait,
  transcriptArms,
} from "./settle-frames-fixture";

const TEST_NAME = "at0699-settle-retarget";
const ARMS = transcriptArms();

for (const arm of ARMS) describe.skipIf(!SHOULD_RUN || arm.skip)(
  `at0699 — a settle interrupted mid-flight leaves no frame stranded [${arm.size}]`,
  () => {
    test(
      "a fold retargeted at 140ms, and a resize interrupted by a fold, strand no frame at the first gesture's end pose",
      async () => {
        // The folds land on c2, c3 and c4; the heights this leg reads are p2's and p4's.
        const { app, tugbankPath } = await launch(4, blobFor(4), TEST_NAME, {
          transcripts: arm.size,
          whaleCards: ["at0622-c2", "at0622-c4"],
        });
        try {
          await traceWithSettleFrames(app);

          // ---- Leg 1: one fold interrupted by another. ----------------
          //
          // Two folds on two different panes. The second arm finds the
          // first's pane still in `settleTweensRef`, holds it
          // `hold-at-current`, measures, and hands the residue back — the
          // third pass, which is the whole subject.
          await home(app);
          let mark = await traceMark(app);
          await app.armSettleFrameProbe();
          // The classifier derives the display's period from the quiet head,
          // so the whole reading's scale depends on there being one.
          await wait(120);
          const beforeSlide = await paneHeightOf(app, "at0622-p2");
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("set-card-folded", ` +
              `{ cardId: "at0622-c2", folded: true }), null)`,
          );
          await wait(RETARGET_AT_MS);
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("set-card-folded", ` +
              `{ cardId: "at0622-c3", folded: true }), null)`,
          );
          await wait(AFTER_LAND_MS * 2);
          await app.waitForCondition<boolean>(
            `window.__deckTrace.since(${mark}).some(function (e) {
               return e.kind === "settle-frames";
             })`,
            { timeoutMs: 20_000 },
          );
          const slideProbe = await app.takeSettleFrameReading();
          await app.disarmSettleFrameProbe();
          const slideRows = await settleFrameRows(app, mark);
          const slideRow = slideRows[slideRows.length - 1] as SettleFramesRow;
          const afterSlide = await paneHeightOf(app, "at0622-p2");
          const slideRetargets = await retargetRows(app, mark);
          note(`at0699 retarget/slide probe: ${JSON.stringify(slideProbe)}`);
          note(`at0699 retarget/slide row: ${JSON.stringify(slideRow)}`);
          note(
            `at0699 retarget/slide height p2: ${beforeSlide} -> ${afterSlide}px`,
          );
          note(
            `at0699 retarget/slide retargets: ` +
              `${JSON.stringify(slideRetargets)}`,
          );

          expect(
            slideProbe.suspended,
            `slide retarget: the window was served across both gestures — ` +
              `${slideProbe.ticks} ticks at ` +
              `${slideProbe.framePeriodMs.toFixed(2)}ms. A suspended window ` +
              `reports the same zeros as a deck that never hopped`,
          ).toBe(false);
          expect(
            slideRetargets.length,
            `slide retarget: the second walk really caught the first in ` +
              `flight — the canvas recorded ` +
              `${slideRetargets.length} \`settle-retarget\` row(s): ` +
              `${JSON.stringify(slideRetargets)}. Without one there is no ` +
              `interrupted tween, no residue handed back, and the clause ` +
              `below is a claim about a gesture nobody made`,
          ).toBeGreaterThan(0);
          expect(
            beforeSlide === afterSlide,
            `slide retarget: and the FIRST fold really landed — ` +
              `${beforeSlide} -> ${afterSlide}px on p2. A gesture that moved ` +
              `nothing satisfies the clause below by having no travel to ` +
              `interrupt`,
          ).toBe(false);
          expect(
            slideProbe.strandedTicks,
            `slide retarget: no shown frame stood at the FIRST gesture's end ` +
              `pose with no tween on it — ${slideProbe.strandedTicks} tick(s) ` +
              `on [${slideProbe.strandedPaneIds.join(", ")}]. Every frame's ` +
              `pose on the tick after the second gesture lies on the first ` +
              `tween's curve or the second's; a stranded tick is the one that ` +
              `lies on neither, and it is the double hop the reader sees`,
          ).toBe(0);
          expect(
            slideRow.strandedTicks,
            `slide retarget: and the product's own record, over the settle ` +
              `rather than the window, agrees — ` +
              `${slideRow.strandedTicks} tick(s) on ` +
              `[${slideRow.strandedPaneIds.join(", ")}]`,
          ).toBe(0);

          // ---- Leg 2: a resize interrupted by a fold. -----------------
          //
          // The mixed shape, and the one the first leg cannot be: a content
          // width change resizes every frame, so the arm takes the MEASURED
          // path with `sizeChanged` true and opens a resize episode per
          // frame, and the fold that interrupts it carries a `height` term
          // of its own. The settle crosses between the arm's prelaunch and
          // the Last pass that [F13] says are two mechanisms rather than
          // one, which is where a double hop has two places to come from
          // instead of one.
          await home(app);
          const foldHeightBefore = await paneHeightOf(app, "at0622-p4");
          mark = await traceMark(app);
          await app.armSettleFrameProbe();
          await wait(120);
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("set-content-width", ` +
              `{ preset: "wide" }), null)`,
          );
          await wait(RETARGET_AT_MS);
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("set-card-folded", ` +
              `{ cardId: "at0622-c4", folded: true }), null)`,
          );
          await wait(AFTER_LAND_MS * 2);
          await app.waitForCondition<boolean>(
            `window.__deckTrace.since(${mark}).some(function (e) {
               return e.kind === "settle-frames";
             })`,
            { timeoutMs: 20_000 },
          );
          const foldProbe = await app.takeSettleFrameReading();
          await app.disarmSettleFrameProbe();
          const foldRows = await settleFrameRows(app, mark);
          const foldRow = foldRows[foldRows.length - 1] as SettleFramesRow;
          const foldHeightAfter = await paneHeightOf(app, "at0622-p4");
          const foldRetargets = await retargetRows(app, mark);
          note(`at0699 retarget/fold probe: ${JSON.stringify(foldProbe)}`);
          note(`at0699 retarget/fold row: ${JSON.stringify(foldRow)}`);
          note(
            `at0699 retarget/fold height: ${foldHeightBefore} -> ` +
              `${foldHeightAfter}px`,
          );
          note(
            `at0699 retarget/fold retargets: ${JSON.stringify(foldRetargets)}`,
          );

          expect(
            foldProbe.suspended,
            `resize/fold: the window was served across both gestures — ` +
              `${foldProbe.ticks} ticks`,
          ).toBe(false);
          expect(
            foldRetargets.length,
            `resize/fold: the fold really caught the resize in flight — the ` +
              `canvas recorded ${foldRetargets.length} ` +
              `\`settle-retarget\` row(s): ${JSON.stringify(foldRetargets)}`,
          ).toBeGreaterThan(0);
          expect(
            foldHeightBefore === foldHeightAfter,
            `resize/fold: the fold really landed — ${foldHeightBefore} -> ` +
              `${foldHeightAfter}px on p4`,
          ).toBe(false);
          expect(
            foldProbe.strandedTicks,
            `resize/fold: no frame stood at the resize's end pose with ` +
              `no tween on it — ${foldProbe.strandedTicks} tick(s) on ` +
              `[${foldProbe.strandedPaneIds.join(", ")}]`,
          ).toBe(0);
          expect(
            foldRow.strandedTicks,
            `resize/fold: and the product's own record agrees — ` +
              `${foldRow.strandedTicks} tick(s) on ` +
              `[${foldRow.strandedPaneIds.join(", ")}]`,
          ).toBe(0);

          // ---- The residue clause, for both. --------------------------
          // A settle that strands nothing and leaves an opening pose on is
          // still a settle that ended wrong, and the two failures are
          // independent.
          const residue = await residualTranslates(app);
          expect(
            [...residue],
            `both legs: every surviving frame landed at Last. A pane named ` +
              `here kept the opening pose of a beat that is over`,
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
