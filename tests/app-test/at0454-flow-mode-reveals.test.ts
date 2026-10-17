/**
 * at0454-flow-mode-reveals.test.ts — the deck's second geometry mode: what it reveals.
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
 * claims 6 and 7 (an arrival is revealed in two moves, a close reveals the
 * card it activates); `at0454-flow-mode-strip` carries claims 1–5, and
 * `at0454-flow-mode-controls` the bullseye and the Layout control. The deck
 * and the readers are `flow-mode-fixture.ts`.
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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { launchTugApp, note } from "./_harness";
import { PIXEL_TOL } from "./_harness/tolerances";
import {
  AFTER_LAND_MS,
  ARRIVE_BEAT_MS,
  KIND_TILES,
  RAIL_WIDTH,
  SHOULD_RUN,
  SLOTS,
  TEST_TIMEOUT_MS,
  WIDE_PANE_WIDTH,
  band,
  cardRect,
  deckShape,
  flowOffset,
  setLayout,
  slotRects,
  startArrivalSampler,
  stopArrivalSampler,
  summarize,
  takeCuts,
  textCardIds,
  wait,
} from "./flow-mode-fixture";

describe.skipIf(!SHOULD_RUN)("at0454 — flow mode: what it reveals", () => {

  // ── 6. A card that arrives is revealed too ─────────────────────────────────
  //
  // The strip is scrolled to show the last card, E in slot 4, which leaves the
  // empty slot 5 beside it past the band's far edge. A file opened from E
  // takes that slot — the nearest, the empty one, and the one to the right —
  // so it lands where the reader cannot see it, and the question is whether
  // the deck brings it in.
  //
  // The pin is that the card ends up readable: its near edge is not under the
  // band's, and it is either wholly in the band or, when it is wider than the
  // band, pinned at the edge reading starts at. And no further in than it had
  // to come — the move is minimal.
  test(
    "a card that arrives is revealed, not merely placed",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "at0454-"));
      const file = path.join(dir, "arrival.txt");
      fs.writeFileSync(file, "arrival\n");

      const app = await launchTugApp({ testName: "at0454-flow-mode-arrival" });
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

        // Bring the last card into view by raising it; the empty slot beside
        // it is left beyond the band.
        await app.evalJS<null>(`(window.__tug.activateCard("E"), null)`);
        await wait(AFTER_LAND_MS);

        const bandBefore = await band(app);
        const origin = (await slotRects(app))[SLOTS - 1];
        note(
          `before the open: slot 4 spans ${Math.round(origin.left)}..${Math.round(
            origin.right,
          )}, band ${Math.round(bandBefore.left)}..${Math.round(bandBefore.right)}`,
        );

        // Open a file from the active card. The deck places it in the empty
        // slot to its right, and the arrival owes the reveal.
        const before = await textCardIds(app);
        // What the reader would have seen, sampled the whole way through.
        // Started before the gesture so the very first frame the card is on
        // screen is in the record.
        await startArrivalSampler(app, before);
        await app.dispatchControlAction("open-file", { path: file });
        await app.waitForCondition<boolean>(
          `window.tugdeck.diag.getDeckState().cards.filter(function (c) {
            return c.componentId === "text";
          }).length === ${before.length + 1}`,
          { timeoutMs: 15_000 },
        );
        const fresh = (await textCardIds(app)).filter(
          (id) => !before.includes(id),
        );
        expect(fresh, "exactly one card answered the open").toHaveLength(1);
        await wait(AFTER_LAND_MS);
        const seen = await stopArrivalSampler(app);

        const bandAfter = await band(app);
        const arrived = await cardRect(app, fresh[0]);
        const width = arrived.right - arrived.left;
        const bandWidth = bandAfter.right - bandAfter.left;
        note(
          `after the open: card spans ${Math.round(arrived.left)}..${Math.round(
            arrived.right,
          )}, band ${Math.round(bandAfter.left)}..${Math.round(
            bandAfter.right,
          )}, offset ${await flowOffset(app)}`,
        );
        expect(
          await app.evalJS<number | null>(
            `(function () {
              var pane = window.tugdeck.diag.getDeckState().panes.find(function (p) {
                return p.cardIds.indexOf(${JSON.stringify(fresh[0])}) !== -1;
              });
              return pane === undefined || pane.slot === undefined ? null : pane.slot;
            })()`,
          ),
          "the file takes the empty slot beside the card that opened it",
        ).toBe(SLOTS);
        expect(
          arrived.left,
          "the arrived card's near edge is not under the rail",
        ).toBeGreaterThanOrEqual(bandAfter.left - PIXEL_TOL);
        // Minimal: a card that fits comes in until its far edge meets the
        // band's; one wider than the band stops at the edge reading starts at.
        if (width <= bandWidth + PIXEL_TOL) {
          expect(
            Math.abs(arrived.right - bandAfter.right),
            "and no further in than it had to come — flush with the far edge",
          ).toBeLessThanOrEqual(PIXEL_TOL);
        } else {
          expect(
            Math.abs(arrived.left - bandAfter.left),
            "and no further in than it had to come — pinned at the near edge",
          ).toBeLessThanOrEqual(PIXEL_TOL);
        }

        // ── TWO MOVES, NOT ONE ──────────────────────────────────────────────
        //
        // Where the card STOOD, over time, is the only witness to this. Two
        // store commits are not two moves: batched into one render they are a
        // single frame, and the card is on screen for the first time already
        // in view. So the pin is the sampled run of positions.
        expect(seen.length, "the card was on screen to be sampled").toBeGreaterThan(0);
        const landed = seen[0].left;
        const settled = seen[seen.length - 1].left;
        const stillLanded = seen.filter((s) => Math.abs(s.left - landed) <= PIXEL_TOL);
        const heldMs = stillLanded[stillLanded.length - 1].t - stillLanded[0].t;
        const travelling = seen.filter(
          (s) => s.left < landed - PIXEL_TOL && s.left > settled + PIXEL_TOL,
        );
        note(
          `${seen.length} samples: landed at ${Math.round(landed)}, held ${Math.round(
            heldMs,
          )}ms, ${travelling.length} in transit, ended at ${Math.round(
            seen[seen.length - 1].left,
          )}`,
        );

        // 1. The file opens FIRST — the reader sees the card where it landed,
        //    which is out past the band's far edge.
        expect(
          landed + width,
          "the card is first seen where it landed, not already in view",
        ).toBeGreaterThan(bandAfter.right + PIXEL_TOL);

        // 2. And it is left there long enough to be read as its own event.
        //    Half the beat is the floor, so a sampler the harness throttles
        //    still measures a hold rather than a flicker.
        expect(
          heldMs,
          "and stands there for a beat before anything moves",
        ).toBeGreaterThanOrEqual(ARRIVE_BEAT_MS / 2);

        // 3. THEN the deck travels to it — a crossing with a middle, not a
        //    cut from one place to the other.
        expect(
          travelling.length,
          "and then the deck crosses to it, through places in between",
        ).toBeGreaterThan(0);
      } finally {
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

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
        await app.nativeClickAtElement(
          `.tug-pane[data-pane-id="p5"] [data-testid="tug-pane-close-button"]`,
        );
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
