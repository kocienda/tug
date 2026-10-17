/**
 * at0303-space-allocator-greed.test.ts — the space allocator, on the real
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
 * carries claims 6 and 7; `at0303-space-allocator-engages` carries 1–3,
 * `-retunes` 4 and 5, and `-drag-floor` 8. The deck and the readers are
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
  COMFORT_OVERVIEW_WIDTH_PX,
  DEFAULT_OVERVIEW_WIDTH_PX,
  MIN_OVERVIEW_WIDTH_PX,
} from "../../tugdeck/src/lib/overview-measure";
import {
  AFTER_LAND_MS,
  GAP,
  MIN_RAIL_WIDTH_PX,
  PREFERRED,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  THREE_UP_TILE,
  canvasWidth,
  frameWidth,
  railTotalFor,
  seams,
  seedFixture,
  seedPreferredWidth,
  seedTwoRails,
  twoRailPaneWidth,
  wait,
} from "./space-allocator-fixture";
import { kindBody } from "./_harness/card-reach";

describe.skipIf(!SHOULD_RUN)(
  "at0303 — the space allocator flexes the rail to tile the chain",
  () => {
    test(
      "two rails answer with two widths, and greed decides which one is wide",
      async () => {
        const app = await launchTugApp({
          testName: "at0303-imposer-allocator-greed-order",
        });
        try {
          // Both preferences are seeded, so nothing here depends on a default:
          // the Overview at its ch-derived width, the Layout card at 420.
          await seedPreferredWidth(app, PREFERRED);
          await app.evalJS<null>(
            `(window.__tug.setTugbankValue("dev.tugapp.overview", "widthPx", { kind: "i64", value: ${DEFAULT_OVERVIEW_WIDTH_PX} }), null)`,
          );
          await seedFixture(app, 400, PREFERRED);

          const canvas = await canvasWidth(app);

          // ── Surplus. The chain wants 60px more rail than the two
          // preferences total. The GREEDIEST rail is fed first, so all of it
          // goes to the Overview and the Layout card does not move at all. ────
          const surplusPane = twoRailPaneWidth(
            canvas,
            PREFERRED + DEFAULT_OVERVIEW_WIDTH_PX + 60,
          );
          expect(surplusPane).toBeGreaterThanOrEqual(200);
          await seedTwoRails(app, surplusPane);
          await kindBody(app, "layout").nativeClickAtElement(THREE_UP_TILE);
          await wait(AFTER_LAND_MS);

          const surplusTotal = railTotalFor(canvas, surplusPane);
          const fedOverview = await frameWidth(app, "pGaz");
          const heldRail = await frameWidth(app, "pRail");
          expect(heldRail, "the less greedy rail is not fed first").toBeCloseTo(
            PREFERRED,
            0,
          );
          expect(fedOverview).toBeCloseTo(surplusTotal - PREFERRED, 0);
          expect(fedOverview).toBeGreaterThan(DEFAULT_OVERVIEW_WIDTH_PX);
          expect(Math.round(fedOverview)).not.toBe(Math.round(heldRail));
          for (const seam of await seams(app)) {
            expect(Math.abs(seam - GAP)).toBeLessThanOrEqual(PIXEL_TOL);
          }

          // ── Deficit. Now the chain wants 140px LESS rail than the two
          // preferences total, which is more than the Layout card alone can give.
          // The least greedy rail drains first and lands on its floor; only
          // then does the Overview give the remainder — and it is still the
          // wider of the two. ───────────────────────────────────────────────
          const deficitPane = twoRailPaneWidth(
            canvas,
            PREFERRED + DEFAULT_OVERVIEW_WIDTH_PX - 140,
          );
          expect(deficitPane).toBeGreaterThanOrEqual(200);
          await seedTwoRails(app, deficitPane, "three-up");
          await kindBody(app, "layout").nativeClickAtElement(THREE_UP_TILE);
          await wait(AFTER_LAND_MS);

          const deficitTotal = railTotalFor(canvas, deficitPane);
          const drainedRail = await frameWidth(app, "pRail");
          const holdingOverview = await frameWidth(app, "pGaz");
          expect(
            drainedRail,
            "the least greedy rail drains all the way to its floor",
          ).toBeCloseTo(MIN_RAIL_WIDTH_PX, 0);
          expect(holdingOverview).toBeCloseTo(deficitTotal - MIN_RAIL_WIDTH_PX, 0);
          expect(holdingOverview).toBeGreaterThan(drainedRail);
          // And never under the Overview's own hard floor, the width below which
          // a post stops painting at all.
          expect(holdingOverview).toBeGreaterThanOrEqual(MIN_OVERVIEW_WIDTH_PX);
          for (const seam of await seams(app)) {
            expect(Math.abs(seam - GAP)).toBeLessThanOrEqual(PIXEL_TOL);
          }
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a crowded deck spends the Overview's comfort measure to clear the overlap",
      async () => {
        const app = await launchTugApp({
          testName: "at0303-imposer-allocator-crowded",
        });
        try {
          await seedPreferredWidth(app, PREFERRED);
          await app.evalJS<null>(
            `(window.__tug.setTugbankValue("dev.tugapp.overview", "widthPx", { kind: "i64", value: ${DEFAULT_OVERVIEW_WIDTH_PX} }), null)`,
          );
          await seedFixture(app, 400, PREFERRED);

          const canvas = await canvasWidth(app);

          // The shape the whole addendum is about. Size the cards so the chain
          // tiles at a rail total inside the Overview's COMFORT BAND — under
          // what the two comfort floors add up to, but still above what the two
          // hard floors do. At the comfort floors these cards occlude one
          // another; a little lower they stand clear. The deck's duty to show
          // the user's cards outranks the Overview's comfortable measure, so
          // comfort is spent — and spent by the greediest rail last, only after
          // the Layout card has given everything it has.
          //
          // Aimed at the MIDDLE of that band rather than a fixed number of
          // pixels below comfort: the band is exactly the distance between the
          // Overview's two floors, and retuning its type moves both. A hardcoded
          // descent asks for a total the rails may no longer be able to reach.
          const comfortTotal = MIN_RAIL_WIDTH_PX + COMFORT_OVERVIEW_WIDTH_PX;
          const comfortBand = COMFORT_OVERVIEW_WIDTH_PX - MIN_OVERVIEW_WIDTH_PX;
          expect(
            comfortBand,
            "the Overview needs a comfort band for this case to mean anything",
          ).toBeGreaterThanOrEqual(16);
          const tiling = comfortTotal - Math.floor(comfortBand / 2);
          const crowdedPane = twoRailPaneWidth(canvas, tiling);
          expect(crowdedPane).toBeGreaterThanOrEqual(200);
          await seedTwoRails(app, crowdedPane, "three-up");
          await kindBody(app, "layout").nativeClickAtElement(THREE_UP_TILE);
          await wait(AFTER_LAND_MS);

          const overview = await frameWidth(app, "pGaz");
          const rail = await frameWidth(app, "pRail");

          // The cards stand clear. This is the assertion the landed Phase 1
          // solver failed: it pinned the Overview at its comfort measure and let
          // the chain occlude by whatever the arithmetic left over.
          for (const seam of await seams(app)) {
            expect(seam, "no two chain panes overlap").toBeGreaterThan(0);
            expect(Math.abs(seam - GAP)).toBeLessThanOrEqual(PIXEL_TOL);
          }

          // And it was bought with the Overview's comfort, at the Layout card's
          // expense first and never below the width the Overview cannot paint
          // under.
          expect(
            rail,
            "the least greedy rail gives everything before comfort is spent",
          ).toBeCloseTo(MIN_RAIL_WIDTH_PX, 0);
          expect(overview).toBeLessThan(COMFORT_OVERVIEW_WIDTH_PX);
          expect(overview).toBeGreaterThanOrEqual(MIN_OVERVIEW_WIDTH_PX);
          expect(overview + rail).toBeCloseTo(
            railTotalFor(canvas, crowdedPane),
            0,
          );
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
