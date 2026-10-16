/**
 * at0558-sheet-visibility-entrance-interrupted.test.ts — a pane-modal sheet is WHOLLY visible, in
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
 * file. This file carries the panel whose entrance never committed;
 * `-tall-composer-below` and `-tall-composer-above` carry the tall composer,
 * `-folded-card` the sheet asked for on a folded card, and `-pane-raise` the
 * raise above a peer. The decks and the measures are
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
  CARD,
  PROMPT_INPUT,
  SHEET,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  openAiSheet,
  seedOne,
} from "./sheet-visibility-fixture";

describe.skipIf(!SHOULD_RUN)("AT0558: a pane-modal sheet is wholly visible", () => {
  // [B07]: the one at0558 case that does NOT finish the animations.
  //
  // Every other at0558-sheet-visibility case does, and has to — the harness window is occluded, the
  // document timeline never advances, and a geometry read taken against a
  // parked first frame is a read of the wrong box. But that force-finish is
  // also precisely what hides the most likely way for a sheet to be
  // invisible, so the file that exists to prove a panel is visible could not
  // see the panel not be.
  //
  // What it reads instead is the state a panel is LEFT in when its entrance
  // ends without committing, reached the way the app reaches it: the panel's
  // pane is taken out of rendering while the entrance is in flight, which is
  // what a workspace switch does to every card in the layer it leaves
  // (`display: none`, `space-layer.css`). `commitStyles()` throws on a target
  // that is not being rendered, `tug-animator` swallows that and cancels, and
  // the panel comes back with no animation, nothing inline, and — until the
  // presented state was a state — nothing to make it visible.
  //
  // Before the presented state was a state, this read `opacity: 0` on a panel
  // whose scrim was up and whose geometry was correct: a sheet the user could
  // not see and could not dismiss by looking at it.
  test(
    "a panel whose entrance never committed is presented anyway",
    async () => {
      const app = await launchTugApp({ testName: "at0558-entrance-interrupted" });
      try {
        await seedOne(app, { x: 40, y: 40, width: 675, height: 680 });

        await app.nativeClickAtElement(PROMPT_INPUT);
        await openAiSheet(app);
        // Out of rendering, with the entrance still running. The animation
        // keeps its own clock — it is the COMMIT at the end of it that a
        // hidden target refuses.
        const parked = await app.evalJS<{ anims: number }>(
          `(function(){
             var c = document.querySelector(${JSON.stringify(SHEET)});
             var n = c.getAnimations().length;
             c.closest(".tug-pane").style.display = "none";
             return { anims: n };
           })()`,
        );
        note("entrance-parked", parked);
        // The premise: an entrance really was in flight when the pane went
        // dark. Without this the reading below proves nothing.
        expect(parked.anims).toBeGreaterThan(0);

        // Long enough for it to have ended — thrown, been swallowed, and been
        // cancelled — and then back into rendering to be looked at.
        await new Promise((r) => setTimeout(r, 1500));
        await app.evalJS<null>(
          `(function(){
             document.querySelector(${JSON.stringify(CARD)}).closest(".tug-pane").style.display = "";
             return null;
           })()`,
        );
        await new Promise((r) => setTimeout(r, 400));

        const presented = await app.evalJS<{
          opacity: string;
          presented: boolean;
          anims: number;
          height: number;
          inlineOpacity: string;
        }>(
          `(function(){
             var c = document.querySelector(${JSON.stringify(SHEET)});
             var s = getComputedStyle(c);
             return {
               opacity: s.opacity,
               presented: c.hasAttribute("data-tug-sheet-presented"),
               anims: c.getAnimations().length,
               height: Math.round(c.getBoundingClientRect().height),
               inlineOpacity: c.style.opacity,
             };
           })()`,
        );
        note("entrance-interrupted", presented);

        // Visible, with no animation left to be holding it there and nothing
        // committed inline — so the only thing that can be showing this panel
        // is the state the component declared.
        expect(presented.anims).toBe(0);
        expect(presented.inlineOpacity).toBe("");
        expect(presented.presented).toBe(true);
        expect(presented.opacity).toBe("1");
        // And a panel, not a sliver: an invisible sheet and a zero-height one
        // are different defects and this case must not pass on the second.
        expect(presented.height).toBeGreaterThan(100);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
