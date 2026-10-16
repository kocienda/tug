/**
 * at0303-space-allocator-retunes.test.ts — the space allocator, on the real
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
 * carries claims 4 and 5; `at0303-space-allocator-engages` carries 1–3,
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
  GAP,
  KIND_TILES,
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
      "re-clicking the active layout re-tunes, and nothing else does",
      async () => {
        const app = await launchTugApp({
          testName: "at0303-imposer-allocator-reassert",
        });
        try {
          await seedPreferredWidth(app, PREFERRED);
          await seedFixture(app, 400, PREFERRED);

          const canvas = await canvasWidth(app);
          const first = paneWidthFor(canvas, 30);
          await seedFixture(app, first, PREFERRED);
          await wait(AFTER_LAND_MS);
          await app.nativeClickAtElement(THREE_UP_TILE);
          await wait(AFTER_LAND_MS);
          expect(await frameWidth(app, "pRail")).toBeCloseTo(
            predictedRailWidth(canvas, first),
            0,
          );

          // Now change what the chain wants, WITHOUT going through a moment:
          // the arrangement is already Five Up, so this is the state a card
          // resize leaves behind — seams gone ragged, and nothing has asked
          // for them back.
          const second = paneWidthFor(canvas, -30);
          await app.seedDeckState({
            state: {
              ...deckShape(second, predictedRailWidth(canvas, first)),
              imposition: { kind: "three-up", layout: "fit", sidebars: { layout: { side: "right" } } },
            },
            focusCardId: "A",
          });
          await wait(AFTER_LAND_MS);
          expect(await frameWidth(app, "pRail")).toBeCloseTo(
            predictedRailWidth(canvas, first),
            0,
          );
          expect(
            Math.abs((await seams(app))[0] - GAP),
          ).toBeGreaterThan(PIXEL_TOL);

          // Re-click the layout that is ALREADY active. This used to be a
          // total no-op; it now runs the same re-tune the settled-resize
          // observer asks for.
          await app.nativeClickAtElement(THREE_UP_TILE);
          await wait(AFTER_LAND_MS);

          expect(await frameWidth(app, "pRail")).toBeCloseTo(
            predictedRailWidth(canvas, second),
            0,
          );
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
      "a card joining the chain re-tunes the rails in the same gesture",
      async () => {
        const app = await launchTugApp({
          testName: "at0303-imposer-allocator-assign",
        });
        try {
          await seedPreferredWidth(app, PREFERRED);
          await seedFixture(app, 400, PREFERRED);

          // Sized so the THREE-card chain's exact solve sits 30px above the
          // preferred width — in range. The two-card chain it starts as is
          // never solved at all: seeding a deck is not one of the moments,
          // so the rail rests at the preferred width until a gesture asks.
          const canvas = await canvasWidth(app);
          const paneWidth = paneWidthFor(canvas, 30);
          expect(paneWidth).toBeGreaterThanOrEqual(200);

          const shape = deckShape(paneWidth, PREFERRED);
          const middle = shape.panes.find((p) => p.id === "p2");
          if (middle === undefined) throw new Error("fixture lost p2");
          delete (middle as { slot?: number }).slot;
          await app.seedDeckState({
            state: {
              ...shape,
              panes: [...shape.panes],
              imposition: { kind: "three-up", layout: "fit", sidebars: { layout: { side: "right" } } },
            },
            focusCardId: "A",
          });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(KIND_TILES)}).length > 0`,
            { timeoutMs: 8_000 },
          );
          await wait(AFTER_LAND_MS);
          expect(await frameWidth(app, "pRail")).toBeCloseTo(PREFERRED, 0);

          // ── Put the loose card in the chain's one hole — the assign the
          // Cards row's slot picker dispatches (a ⌘N chord lands on the same
          // verb). The assign
          // completes a chain the allocator can tile, and the assign ITSELF
          // is the moment: the user just asked the deck to arrange itself,
          // and the deck makes room for what it was asked to arrange. ──────
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("assign-slot", { cardId: "B", slot: 1 }), null)`,
          );
          await wait(AFTER_LAND_MS);

          expect(await frameWidth(app, "pRail")).toBeCloseTo(
            predictedRailWidth(canvas, paneWidth),
            0,
          );
          for (const seam of await seams(app)) {
            expect(Math.abs(seam - GAP)).toBeLessThanOrEqual(PIXEL_TOL);
          }
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
