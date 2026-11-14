/**
 * at0454-flow-mode-reveals-close.test.ts — flow mode: a CLOSE reveals the card
 * it activates.
 *
 * One of the at0454-flow-mode split, a test to a file so each launch fits its
 * own budget. This file carries claim 7 (it was half of
 * `at0454-flow-mode-reveals`); `at0454-flow-mode-reveals-arrival` carries
 * claim 6, `at0454-flow-mode-strip` claims 1–5, and
 * `at0454-flow-mode-controls` the bullseye and the Layout control. The deck
 * and the readers are `flow-mode-fixture.ts`.
 *
 * In FIT a slot is an anchor at a fraction of the band, so a deck too narrow
 * for its cards overlaps them. In FLOW the occupied slots stand side by side in
 * a strip: nothing overlaps, the strip runs off the right edge when it is
 * longer than the band, and activating a card slides the viewport the minimum
 * that brings it in.
 *
 *  7. **A CLOSE reveals the card it activates.** Closing a card empties its
 *     slot and hands the first responder to another pane, which is an
 *     activation like any other — and for a while it was the one activation
 *     that revealed nothing, so the inheriting card came up wearing the
 *     active livery while still standing off the band's edge. The reveal
 *     rides the close's own commit rather than the flip beside it, so the
 *     slot emptying and the deck settling onto the survivor are one motion.
 *
 * @family at0454-flow-mode
 * @covers tugdeck/src/layout-imposition.ts
 * @covers tugdeck/src/lib/layout-imposer.ts
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
 * @covers tugdeck/src/components/chrome/flow-offset.ts
 * @covers tugdeck/src/components/chrome/margin-cap.css
 * @covers tugdeck/src/deck-store-selectors.ts
 * @covers tugdeck/src/deck-manager.ts
 * @covers tugdeck/src/lib/close-successor.ts
 * @covers tugdeck/src/lib/opening-placement.ts
 * @covers tugdeck/src/components/layout/layout-card.tsx
 * @covers tugdeck/src/components/layout/layout-miniature.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import { PIXEL_TOL } from "./_harness/tolerances";
import {
  AFTER_LAND_MS,
  KIND_TILES,
  RAIL_WIDTH,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  WIDE_PANE_WIDTH,
  band,
  deckShape,
  flowOffset,
  setLayout,
  slotRects,
  summarize,
  takeCuts,
  wait,
} from "./flow-mode-fixture";

describe.skipIf(!SHOULD_RUN)("at0454 — flow mode: what it reveals", () => {
  test(
    "closing a card brings the card it activates fully into the band",
    async () => {
      // A close is an activation: the card that inherits the first responder
      // was raised by this gesture and the reader was taken there rather than
      // going there, so it is owed the same minimal reveal a raise is owed.
      // It did not get one — the close's own commit wrote the panes and the
      // flip beside it wrote only the bit — so the survivor came up wearing
      // the active livery while still standing off the band's edge, which is
      // the deck activating something it will not show.
      //
      // WHICH card inherits is `lib/close-successor.ts`'s answer and not this
      // file's to settle: the card the reader activated most recently before
      // the one they closed, wherever it stands. What this case needs from
      // that is only that the inheritor start OFF the band, so the reveal has
      // something to do — so the fixture is the wide one, where a slot and a
      // half fill the band, and the inheritor is the strip's first card while
      // the closing one is its last.
      //
      // Pinned through the real X, because the close box is the gesture that
      // found it. A `hello` card does not opt into `confirmClose`, so a click
      // on a single-card pane's X closes it outright (at0040 case 1).
      const app = await launchTugApp({ testName: "at0454-close-reveals" });
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );
        await app.seedDeckState({
          state: deckShape(WIDE_PANE_WIDTH),
          focusCardId: "A",
        });
        await app.body("L").waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(KIND_TILES)}).length > 0`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);
        await setLayout(app, "flow");
        await wait(AFTER_LAND_MS);

        // Activate A, then E, the strip's last card: E comes to the band's far
        // edge and carries A — the card its close will hand back to, because
        // the reader was in it last — off the near one. A slot keeps its place
        // in the strip when a neighbour closes, so the survivor of a close is
        // wherever it was standing, and here that is outside the band.
        await app.evalJS<null>(`(window.__tug.activateCard("A"), null)`);
        await wait(AFTER_LAND_MS);
        await app.evalJS<null>(`(window.__tug.activateCard("E"), null)`);
        await wait(AFTER_LAND_MS);

        const bandBefore = await band(app);
        const survivorBefore = (await slotRects(app)).find(
          (r) => r.paneId === "p1",
        );
        note(
          `before the close: offset ${await flowOffset(app)}, p1 spans ${Math.round(
            survivorBefore?.left ?? NaN,
          )}..${Math.round(survivorBefore?.right ?? NaN)}, band ${Math.round(
            bandBefore.left,
          )}..${Math.round(bandBefore.right)}`,
        );
        expect(
          survivorBefore?.left ?? NaN,
          "the fixture must leave the inheriting card out of the band, or the close has nothing to reveal",
        ).toBeLessThan(bandBefore.left - PIXEL_TOL);

        await app.evalJS<null>(`(window.__tug.armCutDetector(), null)`);
        await takeCuts(app);
        // The pane's chrome is drawn in its card's own page, so E's X is
        // pressed there; the shell's stand-in holds no close button.
        await app.body("E").nativeClickAtElement(`[data-testid="tug-pane-close-button"]`);
        await app.waitForCondition<boolean>(
          `document.querySelector('.tug-pane[data-pane-id="p5"]') === null`,
          { timeoutMs: 4_000 },
        );
        await wait(AFTER_LAND_MS);

        const activePaneId = await app.evalJS<string | null>(
          `(window.tugdeck.diag.getDeckState().activePaneId || null)`,
        );
        expect(
          activePaneId,
          "the close hands the first responder back to the card activated before it",
        ).toBe("p1");

        const closeCuts = await takeCuts(app);
        await app.evalJS<null>(`(window.__tug.disarmCutDetector(), null)`);
        const bandAfter = await band(app);
        const survivor = (await slotRects(app)).find((r) => r.paneId === "p1");
        note(
          `after the close: offset ${await flowOffset(app)}, p1 spans ${Math.round(
            survivor?.left ?? NaN,
          )}..${Math.round(survivor?.right ?? NaN)}, band left ${Math.round(
            bandAfter.left,
          )}, cuts: ${summarize(closeCuts) || "none"}`,
        );
        expect(
          survivor?.left ?? NaN,
          "the card the close activates comes fully inside the band's near edge",
        ).toBeGreaterThanOrEqual(bandAfter.left - PIXEL_TOL);
        expect(
          survivor?.left ?? NaN,
          "and no further in than it had to come — the reveal is minimal, so it stands ON that edge",
        ).toBeLessThanOrEqual(bandAfter.left + PIXEL_TOL);
        expect(
          closeCuts.length,
          "and the slide is the close's own settle rather than a second move after it",
        ).toBe(0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
