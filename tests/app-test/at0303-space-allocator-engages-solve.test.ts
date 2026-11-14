/**
 * at0303-space-allocator-engages-solve.test.ts — the space allocator, on the
 * real deck: an in-range solve lands exact seams, settles by FLIP, and leaves
 * the preference alone.
 *
 * One of the at0303-space-allocator split, a test to a file so each launch
 * fits its own budget. This file carries claims 1 and 2 (it was half of
 * `at0303-space-allocator-engages`); `at0303-space-allocator-engages-surplus`
 * carries 3, `-retunes` 4 and 5, `-greed` 6 and 7, and `-drag-floor` 8. The
 * deck and the readers are `space-allocator-fixture.ts`.
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
 *  1. It engages. Picking an arrangement whose solve is inside the rail's
 *     bounds lands the rail on that solve, and every seam in the chain on
 *     `IMPOSITION_GAP_PX`. The rail's crossing is a FLIP settle like any other
 *     arrangement change, not a cut.
 *  2. It leaves the preference alone. The allocated width is live geometry; the
 *     width the user CHOSE is what the rail reopens at, and no number of
 *     re-tunes may touch it. Read through the production path — close the
 *     Layout card,
 *     open it again, and it must come back at the preferred width. This is the
 *     no-ratchet guard, and it is now structural: the solver cannot see a rail's
 *     standing width at all.
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
import { bodyOfKind } from "./_harness/card-reach";
import {
  AFTER_LAND_MS,
  GAP,
  LAYOUT_FRAME,
  PREFERRED,
  RAIL_FRAME,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  THREE_UP_TILE,
  canvasWidth,
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
      "an in-range solve lands exact seams, settles by FLIP, and leaves the preference alone",
      async () => {
        const app = await launchTugApp({
          testName: "at0303-imposer-space-allocator",
        });
        try {
          await seedPreferredWidth(app, PREFERRED);
          await seedFixture(app, 400, PREFERRED);

          // The fixture is sized against the canvas the app actually launched
          // at, so the exact solve lands 30px above the preferred width —
          // inside the flex range whatever the window size.
          const canvas = await canvasWidth(app);
          const paneWidth = paneWidthFor(canvas, 30);
          expect(paneWidth).toBeGreaterThanOrEqual(200);
          await seedFixture(app, paneWidth, PREFERRED);
          await wait(AFTER_LAND_MS);

          // At rest the rail shows the preferred width: seeding a deck is not
          // one of the moments that re-tunes.
          expect(await frameWidth(app, "pRail")).toBeCloseTo(PREFERRED, 0);

          // ── The moment: choose Five Up. ──────────────────────────────────
          await app.body("L").nativeClickAtElement(THREE_UP_TILE);

          // The rail's new width crosses by the settle FLIP rather than
          // cutting — the width is part of the arrangement signature.
          await app.waitForCondition<boolean>(
            `document.querySelector("[data-imposer-settling]") !== null`,
            { timeoutMs: 2_000 },
          );
          await wait(AFTER_LAND_MS);
          expect(
            await app.evalJS<boolean>(
              `document.querySelector("[data-imposer-settling]") !== null`,
            ),
          ).toBe(false);

          expect(await frameWidth(app, "pRail")).toBeCloseTo(
            predictedRailWidth(canvas, paneWidth),
            0,
          );
          for (const seam of await seams(app)) {
            expect(Math.abs(seam - GAP)).toBeLessThanOrEqual(PIXEL_TOL);
          }

          // ── The preference is untouched. Read through the path that owns
          // it: the rail reopens at the width the card declares, never at the
          // width the allocator handed it. The reopened pane is a NEW pane,
          // so it is resolved from the card standing in it rather than by the
          // id the seeded one carried. ─────────────────────────────────────
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("toggle-layout"), null)`,
          );
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(RAIL_FRAME)}) === null`,
            { timeoutMs: 5_000 },
          );
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("toggle-layout"), null)`,
          );
          // The reopened card's body is found by its kind, and its pane —
          // the shell's chrome around the body's placeholder — is measured
          // in the shell.
          const reopened = await bodyOfKind(app, "layout");
          await reopened.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(LAYOUT_FRAME)}) !== null`,
            { timeoutMs: 5_000 },
          );
          await wait(AFTER_LAND_MS);
          expect(
            // card-dom: shell — the rail's pane frame is the shell's chrome
            await app.evalJS<number>(
              `document.querySelector('[data-body-placeholder][data-card-id=${JSON.stringify(reopened.cardId)}]')
                 .closest(".tug-pane").getBoundingClientRect().width`,
            ),
          ).toBeCloseTo(PREFERRED, 0);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
