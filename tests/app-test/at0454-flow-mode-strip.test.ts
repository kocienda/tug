/**
 * at0454-flow-mode-strip.test.ts — the deck's second geometry mode: the strip.
 *
 * In FIT a slot is an anchor at a fraction of the band, so a deck too narrow
 * for its cards overlaps them. In FLOW the occupied slots stand side by side in
 * a strip: nothing overlaps, the strip runs off the right edge when it is
 * longer than the band, and activating a card slides the viewport the minimum
 * that brings it in.
 *
 * Seven things are pinned here, and each of them failed in an obvious way while
 * the mode was being built:
 *
 *  1. **Nothing overlaps.** Asserted pairwise over the occupied slots rather
 *     than by trusting the strip's arithmetic, and on a deck whose cards are
 *     wider than the band — a fixture where fit demonstrably DOES overlap, so
 *     the assertion has something to catch.
 *  2. **The reveal is minimal, and it animates.** Activating a card that is off
 *     the right edge slides the strip exactly far enough; activating one that
 *     is already in view moves nothing at all, because an activation that
 *     reveals nothing must commit no geometry.
 *  3. **The mode toggle is a census gesture.** `arrangementSignature` gains
 *     `imposition.layout` as a term of its own. Without it the toggle moves
 *     every pane's `left` while every other term holds still, no settle arms,
 *     and the one gesture the mode exists to offer is the one that cuts.
 *  4. **The offset's clamp lives in CSS.** Fit answers a window resize entirely
 *     in the browser; flow has to as well, or it is the one mode that shows a
 *     stale viewport until the 200ms settled-resize retune fires. The clamp
 *     block writes an offset past the strip's end — which is exactly the state
 *     a widened window leaves behind before the retune — and requires the
 *     browser to hold the last card against the band's right edge anyway.
 *  5. **The band's edge is real ink.** A straddling card's overhang paints on
 *     under the rail and out into the margin between the rail and the window
 *     edge unless something stops it. The rail does the stopping now — it is
 *     opaque and outranks every free card — and the five pixels it stands off
 *     the window edge, which no rail width can cover, are covered by a margin
 *     cap. So the pin is that no card answers in that margin while the same
 *     card still answers inside the band, and that what answers there is the
 *     cap, carrying the canvas-background marker so the press it takes still
 *     deselects.
 *  6. **A card that ARRIVES is revealed too, and in TWO MOVES.** A card
 *     opened from another lands in the nearest slot that will take it, and
 *     that can be a slot the band is not showing. The raise reveals; for a
 *     while the arrival did not, and the file the reader had just clicked
 *     landed somewhere off the band with nothing to say where. And the two are
 *     SEQUENTIAL: the card lands, stands on screen for a beat where it landed,
 *     and only then does the deck cross to it. Two store commits do not make
 *     two moves — batched into one render they are a single frame, and a card
 *     whose first appearance is already in view never shows the reader that
 *     the deck moved to find it. So the pin is where the card actually STOOD,
 *     sampled the whole way through.
 *  7. **A CLOSE reveals the card it activates.** Closing a card empties its
 *     slot and hands the first responder to another pane, which is an
 *     activation like any other — and for a while it was the one activation
 *     that revealed nothing, so the inheriting card came up wearing the
 *     active livery while still standing off the band's edge. The reveal
 *     rides the close's own commit rather than the flip beside it, so the
 *     slot emptying and the deck settling onto the survivor are one motion.
 *
 * Cut from `at0454-flow-mode` to fit the 20 s budget. This file carries
 * claims 1–5 in one walk; `at0454-flow-mode-controls` carries the bullseye on
 * a scrolled strip and the Layout control, and `at0454-flow-mode-reveals`
 * claims 6 and 7. The deck and the readers are `flow-mode-fixture.ts`.
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
  IMPOSITION_GAP_PX,
  RAIL_EDGE_INSET_PX,
  RAIL_GUTTER_PX,
} from "../../tugdeck/src/lib/layout-imposer";
import {
  AFTER_LAND_MS,
  KIND_TILES,
  RAIL_WIDTH,
  SHOULD_RUN,
  SLOTS,
  TEST_TIMEOUT_MS,
  band,
  deckShape,
  flowOffset,
  setLayout,
  slotRects,
  summarize,
  takeCuts,
  wait,
} from "./flow-mode-fixture";

describe.skipIf(!SHOULD_RUN)("at0454 — flow mode: the strip", () => {
  test(
    "the strip never overlaps, reveals minimally, toggles without cutting, and clamps in CSS",
    async () => {
      const app = await launchTugApp({ testName: "at0454-flow-mode" });
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(KIND_TILES)}).length > 0`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);

        // ── The fixture earns its assertions ────────────────────────────────
        // In fit, five 420px cards in a six-up on this band overlap. If they
        // did not, "nothing overlaps in flow" would be true of fit too and the
        // block below would be pinning nothing.
        const fitRects = await slotRects(app);
        const fitOverlaps = fitRects.some(
          (rect, index) =>
            index > 0 && rect.left < fitRects[index - 1].right - PIXEL_TOL,
        );
        note(`fit: ${fitRects.length} slots, overlapping = ${fitOverlaps}`);
        expect(
          fitOverlaps,
          "the fixture must be a deck fit actually crowds",
        ).toBe(true);

        // ── 1. Nothing overlaps in flow ─────────────────────────────────────
        await setLayout(app, "flow");
        await wait(AFTER_LAND_MS);
        const rects = await slotRects(app);
        expect(rects.length, "every seeded card still stands").toBe(SLOTS);
        for (let i = 1; i < rects.length; i += 1) {
          expect(
            rects[i].left,
            `slot ${i} starts at or after slot ${i - 1} ends`,
          ).toBeGreaterThanOrEqual(rects[i - 1].right - PIXEL_TOL);
        }
        const bandBox = await band(app);
        const stripLength = rects[rects.length - 1].right - rects[0].left;
        note(
          `flow: strip ${Math.round(stripLength)}px over a ${Math.round(
            bandBox.right - bandBox.left,
          )}px band`,
        );
        expect(
          stripLength,
          "the strip must overflow, or there is nothing to reveal",
        ).toBeGreaterThan(bandBox.right - bandBox.left);

        // ── 2. The reveal is minimal, and it animates ───────────────────────
        expect(await flowOffset(app), "the strip starts at rest").toBe(0);
        await app.evalJS<null>(`(window.__tug.armCutDetector(), null)`);
        await takeCuts(app);

        await app.evalJS<null>(`(window.__tug.activateCard("E"), null)`);
        await wait(AFTER_LAND_MS);
        const revealCuts = await takeCuts(app);
        note(`reveal cuts: ${summarize(revealCuts) || "none"}`);
        expect(
          revealCuts.length,
          "the slide is a settle, not a jump",
        ).toBe(0);

        const revealed = (await slotRects(app))[SLOTS - 1];
        const bandAfter = await band(app);
        note(
          `after reveal: offset ${await flowOffset(app)}, card right ${Math.round(
            revealed.right,
          )}, band right ${Math.round(bandAfter.right)}, canvas ${await app.evalJS<number>(
            `document.querySelector("[data-deck-canvas-background]").parentElement.clientWidth`,
          )}`,
        );
        expect(
          revealed.right,
          "the activated card is inside the band's right edge",
        ).toBeLessThanOrEqual(bandAfter.right + PIXEL_TOL);
        expect(
          revealed.right,
          "and no further in than it had to come — the move is minimal",
        ).toBeGreaterThanOrEqual(bandAfter.right - PIXEL_TOL);

        // Activating a card already in view commits nothing.
        const offsetBefore = await flowOffset(app);
        await takeCuts(app);
        await app.evalJS<null>(`(window.__tug.activateCard("D"), null)`);
        await wait(AFTER_LAND_MS);
        expect(
          await flowOffset(app),
          "an activation that reveals nothing moves nothing",
        ).toBe(offsetBefore);
        expect(
          (await takeCuts(app)).length,
          "and arms no settle either",
        ).toBe(0);

        // ── 3. The mode toggle is a census gesture ──────────────────────────
        await takeCuts(app);
        await setLayout(app, "fit");
        await wait(AFTER_LAND_MS);
        const toFit = await takeCuts(app);
        await setLayout(app, "flow");
        await wait(AFTER_LAND_MS);
        const toFlow = await takeCuts(app);
        note(
          `toggle cuts: → fit ${summarize(toFit) || "none"}; → flow ${
            summarize(toFlow) || "none"
          }`,
        );
        expect(
          toFit.length,
          "leaving flow crosses — this is what the layout signature term is for",
        ).toBe(0);
        expect(toFlow.length, "and so does entering it").toBe(0);
        await app.evalJS<null>(`(window.__tug.disarmCutDetector(), null)`);

        // ── 4. The clamp is expressed in CSS ────────────────────────────────
        // Widening the window leaves the stored offset past the strip's end
        // until the settled-resize retune fires 200ms later. Written directly
        // here — the same property, on the same element, by the same name the
        // canvas writes it under — because what is being pinned is the
        // browser's resolution of `imposeStyle`'s expression, not the store's
        // arithmetic. Without the CSS clamp the strip stays shoved left with
        // dead air at the right edge.
        //
        // What lands on the band's edge is the strip's LAST PLACE, and on this
        // fixture that is not a card: five cards stand in a six-up, and every
        // slot of the kind holds its place whether or not a card is in it, so
        // slot 5 is a held-open vacancy at the strip's end. Measured as the
        // rightmost edge of anything imposed, which is what "the strip's far
        // end" means and what the clamp is actually pinning.
        const clamped = await app.evalJS<{ right: number; band: number }>(
          `(function () {
            var strip = parseFloat(
              getComputedStyle(document.querySelector("[data-deck-canvas-background]"))
                .getPropertyValue("--tug-imposer-flow-strip"),
            ) || 0;
            // The offset does not inherit: it is written on each reader, so
            // the test writes where the deck writes.
            document
              .querySelectorAll('.tug-pane[data-imposed], .tug-slot-vacancy[data-vacant-slot]')
              .forEach(function (el) {
                el.style.setProperty("--tug-imposer-flow-offset", (strip + 4000) + "px");
              });
            var right = -Infinity;
            document
              .querySelectorAll('.tug-pane[data-imposed], .tug-slot-vacancy[data-vacant-slot]')
              .forEach(function (el) {
                if (el.getAttribute("data-pane-id") === "pRail") return;
                right = Math.max(right, el.getBoundingClientRect().right);
              });
            var rail = document
              .querySelector('.tug-pane[data-pane-id="pRail"]')
              .getBoundingClientRect();
            return { right: right, band: rail.left - ${RAIL_GUTTER_PX} };
          })()`,
        );
        note(
          `clamped: strip's far end at ${Math.round(clamped.right)}, band right ${Math.round(clamped.band)}`,
        );
        expect(
          Math.abs(clamped.right - clamped.band),
          "an offset past the strip's end still lands its last place on the band's edge",
        ).toBeLessThanOrEqual(PIXEL_TOL);

        // ── 5. The band's edge is occlusion, not a cut ──────────────────────
        // A card that straddles the band's far edge keeps painting: across the
        // rail's gutter in plain sight, and then behind the rail, which is
        // opaque and outranks every free card. **That visible crossing is the
        // point.** It is what says *there is more, behind this*, and a deck
        // that hid it would be cutting the card with paint instead of with a
        // `clip-path` — which is exactly the regression this part now pins.
        // The gutter is air the card crosses, never a leak to be covered.
        //
        // So: the gutter shows CARD, the rail's own band shows RAIL, and the
        // only capped strip is the one no rail stands in. This deck's rail is
        // flush to the right window edge, so that side is uncapped and the
        // bare left side carries a cap exactly one card gap wide.
        const ink = await app.evalJS<{
          gutterPane: string | null;
          overRailPane: string | null;
          inBand: string | null;
          rightCap: boolean;
          leftCapWidth: number | null;
          leftCapCanvas: boolean;
        }>(
          `(function () {
            // At rest the strip runs 2120px into a ~1550px band, so a card is
            // guaranteed to straddle the far edge — the reveal above parked
            // the strip on a boundary, where nothing crosses the gutter and
            // the assertion would prove nothing.
            //
            // The offset does not inherit: it is written on each reader.
            document
              .querySelectorAll('.tug-pane[data-imposed], .tug-slot-vacancy[data-vacant-slot]')
              .forEach(function (el) {
                el.style.setProperty("--tug-imposer-flow-offset", "0px");
              });
            function paneAt(x, y) {
              var el = document.elementFromPoint(x, y);
              var pane = el && el.closest ? el.closest(".tug-pane") : null;
              return pane === null ? null : pane.getAttribute("data-pane-id");
            }
            var rail = document
              .querySelector('.tug-pane[data-pane-id="pRail"]')
              .getBoundingClientRect();
            var left = document.querySelector('[data-margin-cap="left"]');
            return {
              // The gutter's middle: clear of the rail's own edge affordance,
              // which hangs a few pixels past its frame.
              gutterPane: paneAt(rail.left - ${RAIL_GUTTER_PX} / 2, 600),
              // Well inside the rail, where the card behind it must not show.
              overRailPane: paneAt(rail.left + 40, 600),
              inBand: paneAt(rail.left - ${RAIL_GUTTER_PX} - 40, 600),
              rightCap:
                document.querySelector('[data-margin-cap="right"]') !== null,
              leftCapWidth:
                left === null ? null : left.getBoundingClientRect().width,
              leftCapCanvas:
                left !== null &&
                left.hasAttribute("data-deck-canvas-background"),
            };
          })()`,
        );
        note(
          `gutter ${String(ink.gutterPane)} | over rail ${String(ink.overRailPane)} | in band ${String(ink.inBand)} | caps right=${ink.rightCap} left=${String(ink.leftCapWidth)}`,
        );
        expect(
          ink.gutterPane,
          "a straddling card crosses the rail's gutter in plain sight",
        ).not.toBeNull();
        expect(
          ink.gutterPane,
          "and it is a card standing there, not the rail reaching in",
        ).not.toBe("pRail");
        expect(
          ink.overRailPane,
          "the rail is what paints over the card, which is the whole occlusion",
        ).toBe("pRail");
        expect(
          ink.inBand,
          "the straddling card still paints inside the band",
        ).not.toBeNull();
        expect(
          ink.rightCap,
          "a rail flush to the window leaves nothing bare, so that side is uncapped",
        ).toBe(RAIL_EDGE_INSET_PX > 0);
        expect(
          ink.leftCapWidth === null ? null : Math.round(ink.leftCapWidth),
          "the bare side is capped at exactly the band's own gap, and no wider",
        ).toBe(IMPOSITION_GAP_PX);
        expect(
          ink.leftCapCanvas,
          "and that cap carries the canvas-background marker, so a press there still deselects",
        ).toBe(true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
