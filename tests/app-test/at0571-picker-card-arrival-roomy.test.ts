/**
 * at0571-picker-card-arrival-roomy.test.ts — a Session card arriving in a
 * ROOMY column takes the room rather than leaving a dead band beneath it.
 *
 * One piece of the at0571 split; the deck shapes, the frame census and the
 * trace readings are `picker-card-arrival-fixture.ts`.
 *
 * The case from the screenshot, and the one no app-test had driven. The
 * sitter folds first, so the column has hundreds of pixels the sitter's tier
 * does not claim, and then the same production arrival runs. The newcomer
 * takes that room instead of standing at the height it bid with a dead band
 * beneath it, the folded sitter does not move at all, and the column's last
 * member reaches the run's own bottom. "No band beneath it" is read against
 * the frame in slot 1, which is a single member spanning the same run — a
 * reading that cannot be satisfied by the two heights the claim is about.
 * The arrival's weight is derived in the allocator that divides the column
 * (`arrivalSharesOf`), and the roomy claim is a claim about that division.
 *
 * `session-card.tsx`, where the picker is raised, stands at its recorded
 * fan-out and is deliberately not named; `card-lifecycle.ts` owns the channel
 * the picker's presentation rides, so an edit that changes when a card is
 * said to have activated selects this file through it.
 *
 * @covers tugdeck/src/components/chrome/settle-plan.ts
 * @covers tugdeck/src/fold.ts
 * @covers tugdeck/src/lib/pane-flip.ts
 * @covers tugdeck/src/components/chrome/settle-engine.ts
 * @covers tugdeck/src/lib/card-lifecycle.ts
 * @covers tugdeck/src/lib/settle-notice.ts
 * @covers tugdeck/src/lib/layout-imposer.ts
 * @covers tugdeck/src/lib/opening-placement.ts
 * @family at0571-picker-card-arrival
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import { PIXEL_TOL } from "./_harness/tolerances";
import { IMPOSITION_GAP_PX } from "../../tugdeck/src/lib/layout-imposer";
import {
  AFTER_LAND_MS,
  PICKER_FORM,
  SHOULD_RUN,
  SITTER,
  SITTER_FOLDED_TIER_PX,
  TEST_TIMEOUT_MS,
  addSessionCard,
  arrivedPaneId,
  columnShares,
  heldFor,
  isFolded,
  measureAtListCap,
  panelFit,
  paneRects,
  removeArrivalPickerSessions,
  seed,
  seedArrivalPickerSessions,
  setCardFolded,
  wait,
} from "./picker-card-arrival-fixture";

beforeAll(seedArrivalPickerSessions);
afterAll(removeArrivalPickerSessions);

describe.skipIf(!SHOULD_RUN)("AT0571: the divided arrival", () => {
  test(
    "a newcomer onto a ROOMY split column takes the room, and leaves no band beneath it",
    async () => {
      const app = await launchTugApp({ testName: "at0571-roomy-column" });
      try {
        await seed(app);
        // The sitter folds first, which is what makes the column roomy: a
        // folded member pins at its tier and asks for no share of the run
        // ([P05]), so once it has somebody to divide with, everything below
        // its 145px is room nothing has claimed. This is the screenshot's
        // arrangement, and until the one-rule change the arrival stood at its
        // declared height with that room left empty beneath it ([F01]).
        await app.evalJS<null>(`(${setCardFolded("A", true)}, null)`);
        await wait(AFTER_LAND_MS);
        expect(await isFolded(app, SITTER), "the sitter folded").toBe(true);

        const before = await paneRects(app, [SITTER, "p3"]);
        // The run is read off SLOT 1's frame — one member spanning the same
        // vertical run — so nothing below is checked against the numbers it is
        // about.
        const run = before.p3.height;
        note(
          "roomy column",
          `sitter folded at ${before[SITTER].height.toFixed(1)} of run ${run.toFixed(1)}`,
        );
        // A folded card stands at its tier wherever it is, alone in its column
        // included: the fold is the pane's, and floor and ceiling are both the
        // tier ([D185], amended when every content card gained a fold). So the
        // room is already there before anybody arrives — what this case pins is
        // who takes it once somebody does.
        expect(
          Math.abs(before[SITTER].height - SITTER_FOLDED_TIER_PX),
          "alone in its column the folded sitter stands at its tier",
        ).toBeLessThanOrEqual(PIXEL_TOL);

        await app.evalJS<null>(`(${addSessionCard}, null)`);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PICKER_FORM)}) !== null`,
          { timeoutMs: 15_000 },
        );
        await wait(AFTER_LAND_MS);

        const newcomer = await arrivedPaneId(app);
        expect(newcomer, "the card arrived").not.toBeNull();
        const after = await paneRects(app, [SITTER, "p3", newcomer ?? ""]);
        const arrival = after[newcomer ?? ""];
        const shares = await columnShares(app, 0);
        const bid = await heldFor(app, newcomer ?? "");
        note(
          "roomy arrival",
          `sitter=${after[SITTER].height.toFixed(1)} newcomer=${arrival.height.toFixed(1)} bid=${bid.toFixed(1)} of run ${run.toFixed(1)}; band beneath=${(after.p3.bottom - arrival.bottom).toFixed(1)}; shares=${JSON.stringify(shares)}`,
        );

        // ── The room is worth having: what the folded tier leaves is
        //    hundreds of pixels more than the app bid for the newcomer, which
        //    is what makes this the roomy case rather than a tight one. The
        //    comparison is against the LIVE bid — the number this run
        //    measured — because there is no declared height left to compare
        //    against, and that is the arc. ──
        expect(
          bid,
          "the newcomer arrived carrying a measured bid",
        ).toBeGreaterThan(0);
        expect(
          run - IMPOSITION_GAP_PX - SITTER_FOLDED_TIER_PX,
          "and the room the folded sitter leaves is well past what the newcomer bid",
        ).toBeGreaterThan(bid + PIXEL_TOL);

        // ── It took the ROOM, not its bid. Read the strong way round: above
        //    the height it bid, which the ceiling this arc removed could never
        //    have allowed. ──
        expect(
          arrival.height,
          "the newcomer stands above the height it bid — the bid is a floor, not a ceiling",
        ).toBeGreaterThan(bid + PIXEL_TOL);
        expect(
          Math.abs(
            arrival.height - (run - IMPOSITION_GAP_PX - SITTER_FOLDED_TIER_PX),
          ),
          "and it stands at everything the folded sitter's tier did not claim",
        ).toBeLessThanOrEqual(PIXEL_TOL);

        // ── And the sitter claims its TIER and nothing more: what a folded
        //    member is worth is its tier, and every pixel past it went to the
        //    newcomer instead of standing as a band ([B05]). ──
        expect(
          Math.abs(after[SITTER].height - SITTER_FOLDED_TIER_PX),
          "the folded sitter stands at its tier and claims no more",
        ).toBeLessThanOrEqual(PIXEL_TOL);

        // ── NO BAND BENEATH IT. The column's last member reaches the run's
        //    own bottom, read against slot 1's frame. This is the dead band
        //    from the screenshot, asserted away. ──
        expect(
          Math.abs(after.p3.bottom - arrival.bottom),
          "the column's last member reaches the bottom of the run",
        ).toBeLessThanOrEqual(PIXEL_TOL);
        expect(
          Math.abs(after.p3.top - after[SITTER].top),
          "and its first member stands at the top of it",
        ).toBeLessThanOrEqual(PIXEL_TOL);

        // ── The arrival's own weight is in the record, so the next
        //    re-division agrees with what the eye saw rather than handing the
        //    newcomer the unnamed default's fraction ([B05], [F08]). ──
        expect(
          shares?.[newcomer ?? ""],
          "the arrival wrote its weight into the column's division",
        ).toBeGreaterThan(1);

        // ── And the other half of the claim: the card that took the room
        //    holds the picker whole, with the list at its cap. ──
        await measureAtListCap(app, "roomy picker");
        const fit = await panelFit(app, newcomer ?? "");
        note("roomy fit", JSON.stringify(fit));
        expect(fit, "the picker's panel is on screen").not.toBeNull();
        expect(
          fit?.overflow ?? 999,
          "the panel stands at its natural height rather than capped short",
        ).toBeLessThanOrEqual(PIXEL_TOL);
        expect(
          fit?.bottomSlack ?? -1,
          "and its bottom edge sits inside the frame that took the room",
        ).toBeGreaterThanOrEqual(0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
