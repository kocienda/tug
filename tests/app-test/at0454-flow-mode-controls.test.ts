/**
 * at0454-flow-mode-controls.test.ts — the deck's second geometry mode: its controls.
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
 * Cut from `at0454-flow-mode` to fit the 20 s budget. This file carries the
 * bullseye on a scrolled strip and the Layout control that drives the mode;
 * `at0454-flow-mode-strip` carries claims 1–5, and `at0454-flow-mode-reveals`
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
import {
  AFTER_LAND_MS,
  KIND_GROUP,
  KIND_TILES,
  LAYOUT_TILES,
  RAIL_WIDTH,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  activeLayoutTile,
  band,
  deckShape,
  flowOffset,
  setLayout,
  slotRects,
  tabUntilKbd,
  wait,
} from "./flow-mode-fixture";

describe.skipIf(!SHOULD_RUN)("at0454 — flow mode: its controls", () => {
  test(
    "bullseye on a scrolled strip sends every pane out the side it was on",
    async () => {
      // `bullseyeAnchorCentre` sorts the other panes around the bullseyed
      // card's own former place so that exits can never cross. That line is
      // resolved through `imposeStyle().left` — so on a flow deck it has to be
      // the FLOW left. Fed the fit anchor, the line lands somewhere the deck
      // is not showing and panes slide out through one another.
      //
      // Asserted as parked SIDE rather than by eye, and on the case that can
      // tell the two anchors apart. The bullseyed card is the LEFTMOST of a
      // scrolled strip, so its flow anchor is off the left edge and every
      // other pane is to its right — all of them must park right. Its FIT
      // anchor is a fifth of the band in from the left instead, which puts the
      // second card on the wrong side of the line: fed that, one pane parks
      // left and slides out through the card arriving at the middle.
      //
      // Direction of travel is deliberately not the assertion. A pane scrolled
      // further off-canvas than the parking place travels back toward the edge
      // to reach it, which is invisible motion between two off-screen points,
      // not a crossing.
      const app = await launchTugApp({ testName: "at0454-flow-bullseye" });
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.body("L").waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(KIND_TILES)}).length > 0`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);
        await setLayout(app, "flow");
        await wait(AFTER_LAND_MS);

        // Activating the card is what scrolls the strip AND what makes the
        // pane bullseye-able: the posture is derived from the first responder,
        // so a card you have not focused cannot take it. Card D leaves the
        // strip part-scrolled, which is the state where the two anchors
        // disagree about a card — at either end of the travel they happen to
        // agree, and the test would pass on the bug.
        await app.evalJS<null>(`(window.__tug.activateCard("D"), null)`);
        await wait(AFTER_LAND_MS);
        const scrolled = await flowOffset(app);
        expect(scrolled, "the strip is genuinely scrolled").toBeGreaterThan(0);

        const centre = (r: { left: number; right: number }): number =>
          (r.left + r.right) / 2;
        const before = await slotRects(app);
        const bandBox = await band(app);
        const anchorCentre = centre(
          before.find((r) => r.paneId === "p4") as (typeof before)[number],
        );

        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("set-bullseye", { paneId: "p4" }), null)`,
        );
        await wait(AFTER_LAND_MS);
        // The posture actually engaged. Without this the whole block is a
        // no-op that reads as a pass: nothing moves, nothing crosses.
        expect(
          await app.evalJS<string | null>(
            `(window.tugdeck.diag.getDeckState().bullseyePaneId || null)`,
          ),
          "the bullseye engaged, so there is an exit to measure",
        ).toBe("p4");
        const after = await slotRects(app);

        // The two exit bounds are far apart and unambiguous: leftward parks a
        // pane's whole frame just past the canvas's left edge, rightward just
        // past its right. So the assertion is which BOUND each pane took, not
        // how far it travelled to get there — a pane already scrolled off the
        // left edge travels rightward to reach the left bound, which is
        // invisible motion between two offscreen points rather than a
        // crossing.
        const wrongSide: string[] = [];
        for (const rect of after) {
          if (rect.paneId === "p4") continue;
          const was = before.find((r) => r.paneId === rect.paneId);
          if (was === undefined) continue;
          // Where it stood relative to where the bullseyed card stood — read
          // off painted pixels, which is the line the user's eye used.
          const expectLeft = centre(was) < anchorCentre;
          const wentLeft = rect.right <= bandBox.left;
          const wentRight = rect.left >= bandBox.right;
          if (expectLeft ? !wentLeft : !wentRight) {
            wrongSide.push(
              `${rect.paneId} stood ${expectLeft ? "left" : "right"} of the bullseyed card at ${Math.round(
                anchorCentre,
              )} but parked at ${Math.round(centre(rect))}`,
            );
          }
        }
        note(
          `bullseye in flow at offset ${scrolled}: ${
            wrongSide.length === 0
              ? "every pane left by the side it stood on"
              : wrongSide.join("; ")
          }`,
        );
        expect(
          wrongSide.join("\n"),
          "each pane leaves by the side it was already on, so none can cross the arriving card",
        ).toBe("");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the Layout control drives the mode, draws it, and answers the keyboard",
    async () => {
      const app = await launchTugApp({ testName: "at0454-flow-control" });
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.body("L").waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(LAYOUT_TILES)}).length > 0`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);

        // The row offers exactly the two modes, and rests on the one the deck
        // holds — a settled control shows what the store holds.
        expect(
          await app.body("L").evalJS<string[]>(
            `Array.from(document.querySelectorAll(${JSON.stringify(LAYOUT_TILES)}))
              .map(function (el) { return el.getAttribute("data-choice-value"); })`,
          ),
          "flow first, the arrangement the row rests its reader on",
        ).toEqual(["flow", "fit"]);
        expect(await activeLayoutTile(app), "the control rests on fit").toBe("fit");

        // ── Clicking it moves the deck ──────────────────────────────────────
        await app.body("L").click(`${LAYOUT_TILES}[data-choice-value="flow"]`);
        await wait(AFTER_LAND_MS);
        expect(
          await app.evalJS<string | undefined>(
            `window.tugdeck.diag.getDeckState().imposition.layout`,
          ),
          "the click wrote the record",
        ).toBe("flow");
        expect(await activeLayoutTile(app), "and the control followed it").toBe(
          "flow",
        );

        // ── The miniature draws the mode ────────────────────────────────────
        // The committed drawing carries the mode, and an overflowing strip
        // shows the viewport window — the picture states that this
        // arrangement scrolls.
        const drawing = await app.body("L").evalJS<{ layout: string | null; windows: number }>(
          `(function () {
            var mini = document.querySelector(
              '[data-testid="layout-card-plan"] [data-plan-layer="committed"] .layout-mini',
            );
            return {
              layout: mini.getAttribute("data-layout"),
              windows: mini.querySelectorAll(".layout-mini-window").length,
            };
          })()`,
        );
        note(
          `committed miniature: layout=${drawing.layout}, windows=${drawing.windows}`,
        );
        expect(drawing.layout, "the committed drawing is the flow one").toBe(
          "flow",
        );
        expect(
          drawing.windows,
          "six wide slots overflow the drawn band, so the window shows",
        ).toBe(1);

        // The fit layer is pre-rendered and draws no window — the preview the
        // other segment would show, and the proof the window is mode-borne.
        expect(
          await app.body("L").evalJS<number>(
            `document.querySelectorAll(
              '[data-plan-preview-id="layout:fit"] .layout-mini-window',
            ).length`,
          ),
          "fit tiles the band, so nothing overflows and no window is drawn",
        ).toBe(0);
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll('[data-plan-preview-id="layout:flow"]').length`,
          ),
          "both modes are offerable, so both have a pre-rendered layer",
        ).toBe(1);

        // ── The row is a rung on the keyboard ladder ────────────────────────
        // A row added without a `focusOrder` is invisible to the ladder, and
        // that is a silent failure — the control still works under the mouse.
        // Walked rather than asserted structurally: Tab into the Cards row,
        // run the cursor off the end of its segments, and the group below must
        // be this one. Down inside a choice group steps its run (at0118's
        // contract), so only the last press crosses rows.
        // The keyboard has to be IN the Layout card before Tab walks it, and
        // the card already holds the first responder from the clicks above —
        // so this addresses it by id rather than through `toggle-layout`,
        // which on the focused card is the gesture that takes the rail away.
        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("focus-session-card", { cardId: "L" }), null)`,
        );
        await tabUntilKbd(app, KIND_GROUP);
        // Tab-into parks the cursor on the SELECTED segment, and this deck is
        // six-up — the last one in the run. So a single Down is already off
        // the end, and off the end Down means down.
        await app.body("L").waitForCondition<boolean>(
          `(function () {
            var el = document.querySelector('${KIND_GROUP} [data-key-cursor]');
            return el !== null && el.getAttribute("data-choice-value") === "six-up";
          })()`,
          { timeoutMs: 3_000 },
        );
        await app.nativeKey("ArrowDown");
        await app.body("L").waitForCondition<boolean>(
          `document.querySelector('[data-testid="layout-card-zoom"][data-key-view-kbd]') !== null`,
          { timeoutMs: 3_000 },
        );
        // The Zoom row sits between them, its cursor parked on 100 % — the
        // last of its run — so one more Down is off its end.
        await app.nativeKey("ArrowDown");
        await app.body("L").waitForCondition<boolean>(
          `document.querySelector('[data-testid="layout-card-layout"][data-key-view-kbd]') !== null`,
          { timeoutMs: 3_000 },
        );
        note("the Layout row takes the ring off the end of the run above it");

        // And the cursor lands on the standing answer, not on the run's head —
        // a settled control shows what the store holds, by keyboard too.
        expect(
          await app.body("L").evalJS<string | null>(
            `(function () {
              var el = document.querySelector(
                '[data-testid="layout-card-layout"] [data-key-cursor]',
              );
              return el === null ? null : el.getAttribute("data-choice-value");
            })()`,
          ),
          "the cursor parks on flow, which is what the deck holds",
        ).toBe("flow");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
