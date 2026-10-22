/**
 * at0303-space-allocator-drag-floor.test.ts — the space allocator, on the real
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
 * carries claim 8; `at0303-space-allocator-engages` carries 1–3, `-retunes`
 * 4 and 5, and `-greed` 6 and 7. The deck and the readers are
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
import { chromePoint } from "./card-chrome-fixture";
import {
  COMFORT_OVERVIEW_WIDTH_PX,
  MEASURE_OVERVIEW_WIDTH_PX,
  MIN_OVERVIEW_WIDTH_PX,
} from "../../tugdeck/src/lib/overview-measure";
import {
  AFTER_LAND_MS,
  PREFERRED,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  frameWidth,
  seedFixture,
  seedPreferredWidth,
  seedTwoRails,
  wait,
} from "./space-allocator-fixture";

describe.skipIf(!SHOULD_RUN)(
  "at0303 — the space allocator flexes the rail to tile the chain",
  () => {
    test(
      "the user can drag the Overview below its comfort measure, down to its hard floor",
      async () => {
        const app = await launchTugApp({
          testName: "at0303-imposer-allocator-drag-floor",
        });
        try {
          await seedPreferredWidth(app, PREFERRED);
          await app.evalJS<null>(
            `(window.__tug.setTugbankValue("dev.tugapp.overview", "widthPx", { kind: "i64", value: ${MEASURE_OVERVIEW_WIDTH_PX} }), null)`,
          );
          await seedFixture(app, 400, PREFERRED);
          await seedTwoRails(app, 400, "three-up");

          // The Overview holds the LEFT edge, so its one handle is its east
          // one — a rail exposes only its deck-facing edge. The card draws it
          // in its own page.
          const handle = ".body-chrome-frame .tug-pane-resize";
          expect(
            await app.body("G").evalJS<string[]>(
              `Array.from(document.querySelectorAll(${JSON.stringify(handle)})).map(function (el) { return el.className; })`,
            ),
          ).toEqual(["tug-pane-resize tug-pane-rail-edge tug-pane-resize-e"]);

          const grip = await chromePoint(app, "G", ".tug-pane-resize-e");

          // Drag it well past the comfort measure and past the hard floor too:
          // 300px in from a 580px rail asks for 280, which is under both. The
          // resize commit clamps to the registered `sizePolicy.min.width`, so
          // where it lands is the answer to "what floor does the user's own
          // hand actually meet".
          await app.nativeDrag(grip, { x: grip.x - 300, y: grip.y });
          await wait(AFTER_LAND_MS);

          const dragged = await frameWidth(app, "pGaz");
          expect(
            dragged,
            "the drag reaches the hard floor, not the comfort measure",
          ).toBeCloseTo(MIN_OVERVIEW_WIDTH_PX, 0);
          expect(dragged).toBeLessThan(COMFORT_OVERVIEW_WIDTH_PX);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
