/**
 * at0454-flow-mode-reveals-arrival.test.ts — flow mode: a card that ARRIVES
 * is revealed too, and in TWO MOVES.
 *
 * One of the at0454-flow-mode split, a test to a file so each launch fits its
 * own budget. This file carries claim 6 (it was half of
 * `at0454-flow-mode-reveals`); `at0454-flow-mode-reveals-close` carries claim
 * 7, `at0454-flow-mode-strip` claims 1–5, and `at0454-flow-mode-controls` the
 * bullseye and the Layout control. The deck and the readers are
 * `flow-mode-fixture.ts`.
 *
 * In FIT a slot is an anchor at a fraction of the band, so a deck too narrow
 * for its cards overlaps them. In FLOW the occupied slots stand side by side in
 * a strip: nothing overlaps, the strip runs off the right edge when it is
 * longer than the band, and activating a card slides the viewport the minimum
 * that brings it in.
 *
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
});
