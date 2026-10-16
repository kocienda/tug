/**
 * at0558-sheet-visibility-tall-composer-above.test.ts — a pane-modal sheet is WHOLLY visible, in
 * every form a Session card takes.
 *
 * Three regressions, one surface. A sheet used to be sized and placed against
 * its own pane frame, so on a card whose composer had grown tall the panel was
 * taller than the room left above the rest line and its top went under the
 * masthead; on a folded card the rest line is `display: none` and the anchor
 * arithmetic ran on a zero box; and a peer pane standing later in focus order
 * painted straight over the panel. The panel is now measured against the
 * visible canvas — it grows down toward the canvas bottom first and then up
 * past its own frame's top if it must — it stands down to the top anchor when
 * the rest line has no box, and its pane is lifted above every peer for as
 * long as it is up.
 *
 * The modality those changes must not touch is pinned elsewhere:
 * `at0057-popup-in-sheet-stacking` and `at0100-sheet-pane-modal-focus`.
 *
 * Reading the geometry under this harness: the window is occluded, so the
 * document timeline never advances and the sheet's enter animation stays
 * parked on its first frame — the panel reads `opacity: 0` with the `rise`
 * resting `translateY(28px)` still applied, forever. Layout reads
 * (`offsetHeight`, computed `height`/`max-height`) are unaffected, but
 * `getBoundingClientRect` is displaced by that transform. Author styles cannot
 * reach it (`data-tug-motion="off"` loses to a running WAAPI animation), so
 * every case here FINISHES the sheet's animations before it measures, and
 * `fill: forwards` holds the presented geometry after that.
 *
 * Cut from `at0558-sheet-visibility` to fit the 20 s budget, one launch to a
 * file. This file carries the tall composer on a pane low on the wall;
 * `-tall-composer-below` carries the pane with room below it, `-folded-card`
 * the sheet asked for on a folded card, `-pane-raise` the raise above a peer,
 * and `-entrance-interrupted` the entrance that never committed. The decks
 * and the measures are `sheet-visibility-fixture.ts`.
 *
 * @family at0558-sheet-visibility
 *
 * @covers tugdeck/src/components/tugways/tug-sheet.tsx
 * @covers tugdeck/src/components/tugways/tug-sheet.css
 * @covers tugdeck/src/components/tugways/tug-pane.css
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note } from "./_harness";
import {
  CARD,
  PROMPT_INPUT,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  expectWhollyVisible,
  openAiSheet,
  enterLong,
  seedOne,
  settle,
} from "./sheet-visibility-fixture";

describe.skipIf(!SHOULD_RUN)("AT0558: a pane-modal sheet is wholly visible", () => {
  // The tall-composer case on a pane low on the wall with almost nothing
  // below it, which is the only way to reach the upward branch — there the
  // clip must hang above the pane's own frame. Its twin,
  // `at0558-sheet-visibility-tall-composer-below`, has room below the pane.
  const SHAPES = [
    { label: "room-above", pane: { x: 40, y: 460, width: 675, height: 560 } },
  ];

  for (const shape of SHAPES) {
    test(
      `the AI settings sheet is whole with a tall composer — ${shape.label}`,
      async () => {
        const app = await launchTugApp({ testName: `at0558-tall-composer-${shape.label}` });
        try {
          await seedOne(app, shape.pane);

          await app.nativeClickAtElement(PROMPT_INPUT);
          await enterLong(app);
          await app.waitForCondition<boolean>(
            `(function(){ var e = document.querySelector(${JSON.stringify(CARD)} + " .session-view-slot"); return e !== null && e.getBoundingClientRect().height < 200; })()`,
            { timeoutMs: 8000 },
          );

          await openAiSheet(app);
          const m = await settle(app, 1200);
          note(`measure-${shape.label}`, m);

          // The rest line really is squeezed — otherwise the panel fits
          // trivially and this case is not asking its question.
          expect(m.restLineHeight).not.toBeNull();
          expect(m.restLineHeight as number).toBeLessThan(200);
          expectWhollyVisible(m);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  }
});
