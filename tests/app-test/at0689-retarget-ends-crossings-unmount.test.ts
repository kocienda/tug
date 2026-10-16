/**
 * at0689-retarget-ends-crossings-unmount — a settle that interrupts a fold ends the crossing it does not carry
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
 * Two more legs take the same fold through the two exits no completion runs
 * on. The window sweep: at the same third of the travel every animation on
 * the page is paused, so the fold's tween never finishes and the settle's
 * window timer is what releases it. The unmount: at the same third the settle
 * engine's teardown runs — the body the canvas's unmount runs — with the frame
 * still mounted. Each asserts the clock that released and that no crossing
 * stands once it has, because those two exits end what the settle holds open
 * with nothing behind them to end it later.
 *
 * Cut from `at0689-retarget-ends-crossings` to fit the 20 s budget. This file
 * carries the unmount; `at0689-retarget-ends-crossings-stack-fold` and `-stack-unfold` carry the
 * fold and the unfold interrupted by a stack, and `-sweep` the window sweep.
 * The deck, the interrupted fold and the crossing check are
 * `retarget-crossings-fixture.ts`. The card is folded first, which is the
 * state the sweep leg left it in when the two ran in one file.
 *
 * @family at0689-retarget-ends-crossings
 * @covers tugdeck/src/components/chrome/settle-plan.ts
 * @covers tugdeck/src/fold.ts
 * @covers tugdeck/src/components/chrome/settle-engine.ts
 * @covers tugdeck/src/components/chrome/settle-crossings.ts
 * @covers tugdeck/src/lib/fold-crossing.ts
 */

import { describe, expect, test } from "bun:test";

import { note } from "./_harness";
import { rmTempTugbank } from "./_harness/tugbank-helpers";
import {
  FOLD_CARD_ID,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  releaseSources,
  traceMark,
} from "./settle-frames-fixture";
import {
  TEARDOWN_JS,
  dispatch,
  expectEnded,
  foldInterrupted,
  landed,
  standUp,
} from "./retarget-crossings-fixture";

const TEST_NAME = "at0689-retarget-ends-crossings-unmount";

describe.skipIf(!SHOULD_RUN)("at0689 — every exit ends the crossings a settle holds open: the unmount", () => {
  test(
    "an unfold the teardown releases leaves no crossing standing",
    async () => {
      const { app, tugbankPath, open, folded } = await standUp(TEST_NAME);
      try {
        expect(folded, "the fold changes the frame's height").toBeLessThan(open);

        await dispatch(app, "set-card-folded", { cardId: FOLD_CARD_ID, folded: true });
        await landed(app, `h < ${open} - 1`);

        // The unmount: the engine's teardown runs a third of the way through
        // the unfold, with the frame still mounted to be read.
        const mark = await traceMark(app);
        const tornDown = await foldInterrupted(app, false, folded, open, TEARDOWN_JS);
        const tornDownBy = await releaseSources(app, mark);
        note("unmount exits", JSON.stringify(tornDownBy));
        expect(
          tornDownBy,
          "unmount leg: the unfold was released by the teardown",
        ).toContain("unmount");
        expectEnded("unmount", tornDown);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
