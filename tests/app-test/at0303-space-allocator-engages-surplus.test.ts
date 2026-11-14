/**
 * at0303-space-allocator-engages-surplus.test.ts — the space allocator, on the
 * real deck: a surplus grows the rail past its preference, and stops at the
 * ceiling.
 *
 * One of the at0303-space-allocator split, a test to a file so each launch
 * fits its own budget. This file carries claim 3 (it was half of
 * `at0303-space-allocator-engages`); `at0303-space-allocator-engages-solve`
 * carries 1 and 2, `-retunes` 4 and 5, `-greed` 6 and 7, and `-drag-floor` 8.
 * The deck and the readers are `space-allocator-fixture.ts`.
 *
 * A slot is an anchor at a fixed fraction of the band and a card's width is its
 * own, so whatever the band leaves over shows up as slack between the cards:
 * choose Five Up on a roomy deck and the cards stand apart, narrow the window
 * slightly and the same arrangement overlaps. The **space allocator** treats the
 * pinned rails' width as the flexible quantity — they are the band's other ends
 * — and solves for the total that puts every seam on one imposition gap. That
 * total is then shared out under a fixed order of invariants: floors are
 * inviolable, the tiling total outranks preferences, preferences fill in greed
 * order (the Overview is greedier than the Layout card, which is greedier than
 * Jots), and the slim content width (675) caps everything. Nothing is graded
 * and the answer is a pure function of the canvas, the chain, and the rails'
 * policies.
 *
 *  3. A surplus grows the rail PAST its preference, up to the ceiling. The old
 *     rule capped an untileable slack at the width the user chose and left the
 *     deck's slack pooled between the cards instead; preference is where the
 *     fill starts, not a cap on it. Asserted explicitly so the deleted cap
 *     cannot creep back.
 *
 * **THE HARNESS CANNOT RESIZE THE WINDOW**, which is why every fixture card
 * width is computed at runtime from the measured canvas: `T*` is
 * `canvas − gap·(R+2) − B*` and `B*` is a function of the chain's card widths,
 * so moving a fixture card's width moves the target exactly as moving the
 * canvas would. Seeding card widths and re-asserting the layout is how this
 * test reaches either side of a breakpoint. Preferences are seeded through
 * tugbank rather than assumed.
 *
 * @family at0303-space-allocator
 * @covers tugdeck/src/layout-imposition.ts
 * @covers tugdeck/src/lib/layout-imposer.ts
 * @covers tugdeck/src/deck-manager.ts
 * @covers tugdeck/src/card-registry.ts
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp } from "./_harness";
import { PIXEL_TOL } from "./_harness/tolerances";
import {
  AFTER_LAND_MS,
  CEILING,
  GAP,
  PREFERRED,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  THREE_UP_TILE,
  canvasWidth,
  deckShape,
  frameWidth,
  paneWidthFor,
  predictedRailWidth,
  seams,
  seedFixture,
  seedPreferredWidth,
  wait,
} from "./space-allocator-fixture";

describe.skipIf(!SHOULD_RUN)(
  "at0303 — the space allocator flexes the rail to tile the chain",
  () => {
    test(
      "a surplus grows the rail past its preference, and stops at the ceiling",
      async () => {
        const app = await launchTugApp({
          testName: "at0303-imposer-allocator-surplus",
        });
        try {
          await seedPreferredWidth(app, PREFERRED);
          await seedFixture(app, 400, PREFERRED);

          const canvas = await canvasWidth(app);

          // First, a surplus the rail can absorb: the solve sits 120px above
          // the chosen 420, well under the 675 ceiling. The rail takes all of
          // it. The width the user chose is where the fill STARTS — the
          // deleted rule capped an untileable slack here and left the deck's
          // spare pixels pooled between the cards instead.
          const reachable = paneWidthFor(canvas, 120);
          expect(reachable).toBeGreaterThanOrEqual(200);
          await seedFixture(app, reachable, PREFERRED);
          await wait(AFTER_LAND_MS);
          expect(await frameWidth(app, "pRail")).toBeCloseTo(PREFERRED, 0);

          await app.body("L").nativeClickAtElement(THREE_UP_TILE);
          await wait(AFTER_LAND_MS);
          const grown = await frameWidth(app, "pRail");
          expect(grown).toBeCloseTo(predictedRailWidth(canvas, reachable), 0);
          expect(grown).toBeGreaterThan(PREFERRED);
          for (const seam of await seams(app)) {
            expect(Math.abs(seam - GAP)).toBeLessThanOrEqual(PIXEL_TOL);
          }

          // Then a surplus it cannot: the solve sits 320px above the chosen
          // width — 65 past the slim ceiling. The rail grows as far as it may
          // and stops there, and the pixels it could not take stay in the
          // chain, which is why the cards still stand apart.
          const unreachable = paneWidthFor(canvas, 320);
          expect(unreachable).toBeGreaterThanOrEqual(200);
          await app.seedDeckState({
            state: {
              ...deckShape(unreachable, PREFERRED),
              imposition: { kind: "three-up", layout: "fit", sidebars: { layout: { side: "right" } } },
            },
            focusCardId: "A",
          });
          await wait(AFTER_LAND_MS);
          await app.body("L").nativeClickAtElement(THREE_UP_TILE);
          await wait(AFTER_LAND_MS);

          expect(await frameWidth(app, "pRail")).toBeCloseTo(CEILING, 0);
          for (const seam of await seams(app)) {
            expect(seam).toBeGreaterThan(GAP);
          }

          // Idempotent: the answer is a function of the inputs, not of where
          // the rail happens to be standing, so re-asserting changes nothing.
          await app.body("L").nativeClickAtElement(THREE_UP_TILE);
          await wait(AFTER_LAND_MS);
          expect(await frameWidth(app, "pRail")).toBeCloseTo(CEILING, 0);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
