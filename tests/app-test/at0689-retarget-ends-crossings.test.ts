/**
 * at0689 — a settle that interrupts a fold ends the crossing it does not carry
 * on.
 *
 * A fold opens a crossing on its frame: `data-fold-crossing` and
 * `data-still-crossing` on the frame, and the held content height written as
 * a custom property onto the content box's children, so nothing inside the
 * card moves while the edge sweeps. The fold's own completion takes it off.
 *
 * A second gesture landing inside the fold cancels that completion — its
 * settle generation is gone — and the replacement settle takes the crossing
 * over only on a frame it carries with a height term of its own. A frame it
 * plans any other way is not adopted, and its crossing has to be ended by the
 * settle that took the frame, or it stands after everything has landed: the
 * card held at a box it no longer has, and its end never announced.
 *
 * The audit's repro — an activation in the fold's tail, where the frame has
 * less than half a pixel of height left — does not occur at the default tune:
 * the fold's spring lands from about three pixels out, with the mark still
 * standing until it does, so a frame caught while marked always still has a
 * height term and is adopted. The path that reaches the gap is a column mode
 * flip: stacking a split column mid-fold commits the folding member behind its
 * survivor, and a covered member carries no tween and no crossing of its own.
 *
 * The probe splits a column, folds (and then unfolds) its first member, and on
 * the first animation frame the edge has covered a third of its travel stacks
 * the column. It samples the frame's marks and the held height on every frame
 * through the stack, and asserts that once the deck is quiet neither mark nor
 * the held height is left on the pane.
 *
 * @covers tugdeck/src/components/chrome/settle-engine.ts
 * @covers tugdeck/src/lib/fold-crossing.ts
 */

import { describe, expect, test } from "bun:test";

import { note, type App } from "./_harness";
import { rmTempTugbank } from "./_harness/tugbank-helpers";
import {
  AFTER_LAND_MS,
  FOLD_CARD_ID,
  FOLD_PANE_ID,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  columnBlob,
  home,
  launch,
  wait,
} from "./settle-frames-fixture";

const TEST_NAME = "at0689-retarget-ends-crossings";
const FRAME = `[data-space-layer][data-space-shown] .tug-pane[data-pane-id="${FOLD_PANE_ID}"]`;
/** How long the sampler runs after the fold's dispatch: the fold, the stack that interrupts it, and room after. */
const SAMPLE_MS = 2_000;

/** The frame's laid-out height, unrounded. */
const frameHeight = (app: App): Promise<number> =>
  app.evalJS<number>(
    `document.querySelector(${JSON.stringify(FRAME)}).getBoundingClientRect().height`,
  );

const dispatch = (app: App, action: string, payload: Record<string, unknown>): Promise<null> =>
  app.evalJS<null>(
    `(window.__tug.dispatchControlAction(${JSON.stringify(action)}, ${JSON.stringify(payload)}), null)`,
  );

const columnMode = (app: App, mode: "split" | "stack"): Promise<null> =>
  dispatch(app, "set-column-mode", { slot: 0, mode });

interface Sample {
  t: number;
  height: number;
  fold: boolean;
  still: boolean;
  held: boolean;
}

interface Reading {
  samples: Sample[];
  /** When the stack was dispatched, or `null` when the fold was never caught mid-travel. */
  triggeredAt: number | null;
  /** The frame's height when it was. */
  triggeredHeight: number | null;
}

/**
 * Dispatch the fold, and from inside the frame sampler stack the column on the
 * first frame the crossing stands with a third of the travel from `from` to
 * `to` covered.
 */
async function foldInterrupted(
  app: App,
  folded: boolean,
  from: number,
  to: number,
): Promise<Reading> {
  const third = Math.abs(to - from) / 3;
  await app.evalJS<null>(
    `(function () {
      var rec = (window.__at0685 = { samples: [], triggeredAt: null, triggeredHeight: null });
      var t0 = performance.now();
      var heldOn = function (frame) {
        var box = frame.querySelector(".tug-pane-content");
        if (box === null) return false;
        var roots = box.querySelectorAll("[data-card-host] > *");
        for (var i = 0; i < roots.length; i += 1) {
          var s = roots[i].style;
          if (s.getPropertyValue("--tugx-fold-held-height") !== "" ||
              s.getPropertyValue("--tugx-still-held-height") !== "") return true;
        }
        return false;
      };
      var tick = function () {
        var t = performance.now() - t0;
        var frame = document.querySelector(${JSON.stringify(FRAME)});
        if (frame !== null) {
          var height = frame.getBoundingClientRect().height;
          var fold = frame.hasAttribute("data-fold-crossing");
          var still = frame.hasAttribute("data-still-crossing");
          rec.samples.push({ t: t, height: height, fold: fold, still: still, held: heldOn(frame) });
          if (rec.triggeredAt === null && fold && Math.abs(height - ${from}) >= ${third}) {
            rec.triggeredAt = t;
            rec.triggeredHeight = height;
            window.__tug.dispatchControlAction("set-column-mode", { slot: 0, mode: "stack" });
          }
        }
        if (t < ${SAMPLE_MS}) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      window.__tug.dispatchControlAction("set-card-folded", { cardId: ${JSON.stringify(FOLD_CARD_ID)}, folded: ${folded} });
      return null;
    })()`,
  );
  await wait(SAMPLE_MS + 300);
  return app.evalJS<Reading>(`window.__at0685`);
}

function expectEnded(label: string, r: Reading): void {
  const marked = r.samples.filter((s) => s.fold);
  const last = r.samples[r.samples.length - 1];
  // The first sample of the run of marked samples the reading ends on.
  let standing = r.samples.length;
  while (
    standing > 0 &&
    (r.samples[standing - 1].fold || r.samples[standing - 1].still || r.samples[standing - 1].held)
  ) {
    standing -= 1;
  }
  note(
    label,
    `samples=${r.samples.length} marked=${marked.length} ` +
      `stacked=${r.triggeredAt === null ? "never" : `${Math.round(r.triggeredAt)}ms at ${r.triggeredHeight?.toFixed(1)}px`} ` +
      `last: fold=${last?.fold} still=${last?.still} held=${last?.held} ` +
      `standing from=${standing < r.samples.length ? `${Math.round(r.samples[standing].t)}ms` : "—"}`,
  );
  // The trigger fires only on a sample carrying the fold's mark a third of the
  // way through its travel, so a non-null one is the proof the crossing was
  // caught mid-motion.
  expect(
    r.triggeredAt,
    `${label}: the stack landed mid-fold, with the crossing standing`,
  ).not.toBeNull();
  expect(
    { fold: last.fold, still: last.still, held: last.held },
    `${label}: once the stack has landed, no crossing stands on the frame`,
  ).toEqual({ fold: false, still: false, held: false });
}

describe.skipIf(!SHOULD_RUN)("at0689 — a retarget ends every crossing it does not carry on", () => {
  test(
    "a fold and an unfold interrupted by stacking their column leave no crossing standing",
    async () => {
      const { app, tugbankPath } = await launch(8, columnBlob(), TEST_NAME);
      try {
        await home(app);
        await columnMode(app, "split");
        await wait(AFTER_LAND_MS);
        // Where each direction lands, read off one clean fold and unfold.
        const open = await frameHeight(app);
        await dispatch(app, "set-card-folded", { cardId: FOLD_CARD_ID, folded: true });
        await wait(AFTER_LAND_MS);
        const folded = await frameHeight(app);
        await dispatch(app, "set-card-folded", { cardId: FOLD_CARD_ID, folded: false });
        await wait(AFTER_LAND_MS);
        note("heights", `open=${open} folded=${folded}`);
        expect(folded, "the fold changes the frame's height").toBeLessThan(open);

        expectEnded("fold", await foldInterrupted(app, true, open, folded));

        // The unfold starts from a folded member of a split column.
        await columnMode(app, "split");
        await wait(AFTER_LAND_MS);
        expectEnded("unfold", await foldInterrupted(app, false, folded, open));
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
