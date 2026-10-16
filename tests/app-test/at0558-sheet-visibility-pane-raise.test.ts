/**
 * at0558-sheet-visibility-pane-raise.test.ts — a pane-modal sheet is WHOLLY visible, in
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
 * file. This file carries the raise of a sheet's pane above a peer;
 * `-tall-composer-below` and `-tall-composer-above` carry the tall composer,
 * `-folded-card` the sheet asked for on a folded card, and
 * `-entrance-interrupted` the entrance that never committed. The decks and
 * the measures are `sheet-visibility-fixture.ts`.
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
  SHOULD_RUN,
  STACKING,
  TEST_TIMEOUT_MS,
  dismissSheet,
  finishAnimations,
  openAiSheet,
  wallShape,
} from "./sheet-visibility-fixture";

describe.skipIf(!SHOULD_RUN)("AT0558: a pane-modal sheet is wholly visible", () => {
  // [B03]: the raise. A sheet's pane paints above every peer while the sheet is
  // up, and drops back the moment it closes.
  //
  // The overhang this reads used to be bought by folding the card, which is no
  // longer a way to hold a sheet up — the fold stands one down. It does not
  // need to be: p1 and p2 overlap on the wall as seeded, and [B02]'s
  // canvas-sized growth already carries the panel past p1's own bottom edge,
  // which is the case the lift exists for.
  test(
    "a pane holding a sheet paints above a peer that outranks it in focus order",
    async () => {
      const app = await launchTugApp({ testName: "at0558-pane-raise" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: wallShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A") && window.__tug.assertHostRootRegistered("B")`,
        );
        await app.bindSession("A", { tugSessionId: "at0558-raise-a" });
        await app.awaitEngineReady("A");
        // B is bound too, and it must be: an UNBOUND session card raises its
        // own `Choose Session` sheet the moment it is activated, which would
        // put a second sheet — and a second, entirely correct, raise — on the
        // wall and make this case unreadable.
        await app.bindSession("B", { tugSessionId: "at0558-raise-b" });
        await app.awaitEngineReady("B");

        const before = await app.evalJS<{ a: { z: number }; b: { z: number } }>(STACKING);
        note("stacking-before-sheet", before);

        await app.nativeClickAtElement(PROMPT_INPUT);
        await openAiSheet(app);
        await new Promise((r) => setTimeout(r, 1200));
        await finishAnimations(app);

        // The screenshot exactly: the OTHER card is the one the user is working
        // in, so focus order hands it the higher z. Before the lift this is
        // where the panel disappeared under its neighbour.
        await app.evalJS<null>(`(window.__tug.activateCard("B"), null)`);
        await new Promise((r) => setTimeout(r, 600));
        const raised = await app.evalJS<{
          a: { z: number; sheetOpen: string | null };
          b: { z: number; sheetOpen: string | null };
          panelOverlapsPeerPx: number | null;
          sheetCount: number;
        }>(STACKING);
        note("stacking-peer-focused", raised);

        expect(raised.sheetCount).toBe(1);
        expect(raised.a.sheetOpen).toBe("");
        expect(raised.b.sheetOpen).toBeNull();
        // The panel really does reach across the peer pane, so the z-order
        // below is the thing deciding which of them the user sees.
        expect(raised.panelOverlapsPeerPx as number).toBeGreaterThan(0);
        expect(raised.a.z).toBeGreaterThan(raised.b.z);

        await app.evalJS<null>(`(window.__tug.activateCard("A"), null)`);
        await new Promise((r) => setTimeout(r, 600));
        await dismissSheet(app);
        await new Promise((r) => setTimeout(r, 400));
        const after = await app.evalJS<{ a: { z: number; sheetOpen: string | null } }>(
          STACKING,
        );
        note("stacking-after-close", after);
        expect(after.a.sheetOpen).toBeNull();
        expect(after.a.z).toBeLessThan(8900);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
