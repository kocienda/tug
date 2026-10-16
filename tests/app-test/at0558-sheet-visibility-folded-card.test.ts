/**
 * at0558-sheet-visibility-folded-card.test.ts — a pane-modal sheet is WHOLLY visible, in
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
 * file. This file carries the sheet asked for on a folded card;
 * `-tall-composer-below` and `-tall-composer-above` carry the tall composer,
 * `-pane-raise` the raise above a peer, and `-entrance-interrupted` the
 * entrance that never committed. The decks and the measures are
 * `sheet-visibility-fixture.ts`.
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
  PROMPT_INPUT,
  SHEET,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  dismissSheet,
  expectWhollyVisible,
  openAiSheet,
  openAiSheetByScript,
  seedOne,
  settle,
} from "./sheet-visibility-fixture";

describe.skipIf(!SHOULD_RUN)("AT0558: a pane-modal sheet is wholly visible", () => {
  // A sheet the user ASKS FOR on a folded card opens the fold first ([B02] of
  // the folded-card brief) and then rises from its rest line exactly as it
  // does on an open card. The folded presentation this case used to assert —
  // a panel standing down to the top anchor and dropping from a 144px
  // masthead over the card beneath — is retired: a folded card shows one row,
  // and a sheet is not one row, so the answer is to stop being folded rather
  // than to find somewhere for the panel to hang.
  //
  // Each reading raises its own sheet, because the anchor is decided when the
  // sheet is raised — once, now, with nothing re-reading it under a mounted
  // panel ([B09]). Folding a card that IS holding one is the tail of this
  // case rather than a question the harness cannot ask: the fold stands the
  // panel down on its way, which is a plain dispatch and not a
  // `ResizeObserver` callback an occluded window would never deliver.
  test(
    "a sheet asked for on a folded card opens the fold and rises from its line, and folding again stands it down",
    async () => {
      const app = await launchTugApp({ testName: "at0558-folded-card" });
      try {
        await seedOne(app, { x: 40, y: 40, width: 675, height: 680 });

        await app.nativeClickAtElement(PROMPT_INPUT);
        await openAiSheet(app);
        const unfolded = await settle(app, 900);
        note("measure-unfolded", unfolded);
        expect(unfolded.presentation).toBe("rise");
        expect(unfolded.clip.anchor).toBe("bottom");
        expectWhollyVisible(unfolded);
        await dismissSheet(app);

        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("toggle-card-fold"), null)`,
        );
        await app.waitForCondition<boolean>(
          `window.__tug.getPaneRecord("p1").folded === true`,
          { timeoutMs: 8000 },
        );
        await new Promise((r) => setTimeout(r, 1200));
        await openAiSheetByScript(app);
        // The ask itself unfolds the card — no notice, no second gesture.
        await app.waitForCondition<boolean>(
          `window.__tug.getPaneRecord("p1").folded === false`,
          { timeoutMs: 8000 },
        );
        const folded = await settle(app, 900);
        note("measure-asked-for-while-folded", folded);
        // A rest line with a box again, and the panel standing on it.
        expect(folded.restLineHeight).not.toBeNull();
        expect(folded.restLineHeight as number).toBeGreaterThan(0);
        expect(folded.presentation).toBe("rise");
        expect(folded.clip.anchor).toBe("bottom");
        expectWhollyVisible(folded);

        // And the way back down: folding a card that IS holding a sheet stands
        // the panel down rather than finding somewhere for it to hang. That is
        // what makes the fold rule total — a folded card has no sheet by any
        // route — and it is why the boxless-slot branch could be retired
        // instead of kept for this one case.
        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("toggle-card-fold"), null)`,
        );
        await app.waitForCondition<boolean>(
          `window.__tug.getPaneRecord("p1").folded === true`,
          { timeoutMs: 8000 },
        );
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(SHEET)}).length === 0`,
          { timeoutMs: 8000 },
        );
        note("the fold stood the sheet down");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
