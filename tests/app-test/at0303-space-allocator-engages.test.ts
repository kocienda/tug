/**
 * at0303-space-allocator-engages.test.ts — the space allocator, on the real
 * deck: each rail solved on its own, in registered greed order.
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
 * The total is chosen by the picture it PAINTS — scored on `imposeRect`'s real
 * clamped geometry, worst occlusion first — and a rail carries two floors: the
 * width it cannot paint under, and the narrower-than-comfortable width it will
 * accept when accepting it is what clears the overlap.
 *
 * What has to hold:
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
 *  3. A surplus grows the rail PAST its preference, up to the ceiling. The old
 *     rule capped an untileable slack at the width the user chose and left the
 *     deck's slack pooled between the cards instead; preference is where the
 *     fill starts, not a cap on it. Asserted explicitly so the deleted cap
 *     cannot creep back.
 *  4. Re-asserting the layout re-tunes. Re-clicking the already-active Cards
 *     option used to be a total no-op; it now drives the same entry the
 *     settled-resize observer calls. The harness cannot resize the app's
 *     window, so this gesture is what covers that entry end to end.
 *  5. Joining the chain RE-TUNES. Assigning a card to a slot is the imposer's
 *     own verb — the user asked the deck to arrange itself, whichever door
 *     dispatched it — so the assign itself re-solves the rails for the chain
 *     it just completed, with no separate Layouts click needed.
 *  6. Two rails answer with two widths, in greed order. With the Overview on one
 *     edge and the Layout card on the other, the two rails stand at DIFFERENT
 *     widths, and which one is wide is the registered greed order's answer:
 *     shrink what the chain leaves and the Layout card drains to its floor
 *     while the Overview holds its measure.
 *  7. A crowded deck spends comfort to un-occlude the cards. When the chain
 *     overlaps at the rails' comfort floors but tiles below them, the Overview
 *     gives up its comfortable measure and the chain stands clear — showing
 *     the user's cards outranks a rail's preferred measure. Asserted on real
 *     pane rects: no two chain panes overlap, and the Overview is narrower than
 *     its comfort width while never under its hard floor.
 *  8. The hard floor is the DRAG floor, and it is genuinely reachable. A real
 *     edge drag can take the Overview below its comfort measure, down to the
 *     width it cannot paint under and no further. The rail's comfort measure
 *     constrains the ALLOCATOR; it may not trap the user's own hand.
 *
 * **THE HARNESS CANNOT RESIZE THE WINDOW**, which is why every fixture card
 * width is computed at runtime from the measured canvas: `T*` is
 * `canvas − gap·(R+2) − B*` and `B*` is a function of the chain's card widths,
 * so moving a fixture card's width moves the target exactly as moving the
 * canvas would. Seeding card widths and re-asserting the layout is how this
 * test reaches either side of a breakpoint. Preferences are seeded through
 * tugbank rather than assumed.
 *
 * Cut from `at0303-imposer-space-allocator` to fit the 20 s budget. This file
 * carries claims 1–3; `at0303-space-allocator-retunes` carries 4 and 5,
 * `-greed` 6 and 7, and `-drag-floor` 8. The deck and the readers are
 * `space-allocator-fixture.ts`.
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
  LAYOUT_FRAME,
  PREFERRED,
  RAIL_FRAME,
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
          await app.body("L").waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(LAYOUT_FRAME)}) !== null`,
            { timeoutMs: 5_000 },
          );
          await wait(AFTER_LAND_MS);
          expect(
            await app.body("L").evalJS<number>(
              `document.querySelector(${JSON.stringify(LAYOUT_FRAME)})
                 .closest(".tug-pane").getBoundingClientRect().width`,
            ),
          ).toBeCloseTo(PREFERRED, 0);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

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
