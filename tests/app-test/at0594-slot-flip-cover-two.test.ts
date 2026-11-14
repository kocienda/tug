/**
 * at0594-slot-flip-cover-two.test.ts — a slot mode flip is a cover, not a
 * fade; the two-member slot.
 *
 * Split from `at0594-slot-flip-cover`, one file per member count, each its
 * own launch: the two-member slot here, the three-member one in
 * `at0594-slot-flip-cover-three`. The two launches in one file sat at the
 * 20 s file budget. The deck, the sampler and the claims are one body in
 * `slot-flip-cover-fixture.ts`.
 *
 * Stack Slot and Split Slot play as one motion. The slot's z-frontmost
 * member — the SURVIVOR, the card a stack actually shows — runs a single fused
 * beat: its translate and its height change are the same edge, so they ride
 * one `room` beat rather than a move and then a grow. Every other member
 * animates nothing. On a stack it holds its old tile at full opacity until the
 * survivor has grown over it, and is released only at the chain's completion;
 * on a split it is simply at its tile behind the survivor, uncovered as the
 * survivor retreats. No card fades in either direction
 * (`briefs/column-flip-cover-brief.md`, [B01]–[B03]).
 *
 * The defect this pins: the retiring member used to fade out on a shorter
 * clock than the survivor's two-beat chain, come back at full strength at its
 * committed rect — the full run — and then be painted over by the survivor's
 * grow beat. Every claim below is sampled every frame through the settle,
 * because that defect lives in the frames between the commit and the landing.
 *
 *   1. **No member ever fades.** Every sampled computed opacity is 1, and no
 *      inline opacity is written at any sample.
 *   2. **The survivor's crossing is one fused beat.** Every beat the canvas
 *      names while settling is `room`; no `move` or `grow` is ever sampled.
 *   3. **The stack's retiring member holds its tile until it is covered.**
 *      While the survivor is mid-flight the retiring member is never at its
 *      committed rect: it stands at the tile it is leaving.
 *   4. **The split's revealed member never travels.** It is at its committed
 *      tile from the first settling frame, and the survivor's retreat is what
 *      uncovers it — nothing slides it into place.
 *   5. **Nothing is left behind.** After each settle no member wears an inline
 *      opacity or transform, none keeps the pixel height it was held at, and
 *      no cover mark remains.
 *   6. **The flip never cuts.** The cut census, armed across both directions,
 *      records nothing — a member the flip commits behind its survivor is
 *      read as covered rather than as a jump.
 *
 * @family at0594-slot-flip-cover
 * @covers tugdeck/src/components/chrome/settle-plan.ts
 * @covers tugdeck/src/components/chrome/settle-engine.ts
 * @covers tugdeck/src/lib/cut-detector.ts
 */

import { describe, expect, test } from "bun:test";

import { note } from "./_harness";
import {
  AFTER_LAND_MS,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  assertCover,
  census,
  launch,
  memberAtRank,
  raise,
  readNow,
  sameRect,
  takeCuts,
  wait,
} from "./slot-flip-cover-fixture";

describe.skipIf(!SHOULD_RUN)("at0594 — slot flip cover [two]", () => {
  test(
    "a two-member slot with the bottom member frontmost flips both ways as a cover",
    async () => {
      const paneIds = ["p1", "p2"];
      const app = await launch(2, "at0594-slot-flip-cover-two");
      try {
        // Split first, so the bottom member can be found and raised. This
        // flip is not under test; it lands before anything samples.
        // card-dom: shell — a deck command dispatched in the shell, reaching no card's DOM.
        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("set-slot-mode", { slot: 0, mode: "split" }), null)`,
        );
        await wait(AFTER_LAND_MS);
        const split = await readNow(app, paneIds);
        const survivor = memberAtRank(split, paneIds, 1);
        const other = paneIds.find((id) => id !== survivor)!;
        await raise(app, survivor);
        note(`two-member: bottom member ${survivor} raised; ${other} retires`);

        await app.evalJS<null>(`(window.__tug.armCutDetector(), null)`);

        // ── Stack: the survivor rises and grows; the other holds its tile. ──
        const stacked = await census(app, paneIds, "stack");
        assertCover("stack", stacked, paneIds, survivor, "stack");
        {
          const end = stacked[stacked.length - 1]!.panes;
          expect(
            sameRect(end[survivor]!, end[other]!),
            "stacked members share one rect",
          ).toBe(true);
        }

        // ── Split: the survivor retreats to its tile; the other is uncovered. ──
        const divided = await census(app, paneIds, "split");
        assertCover("split", divided, paneIds, survivor, "split");
        {
          const end = divided[divided.length - 1]!.panes;
          expect(
            sameRect(end[other]!, split.panes[other]!),
            "the revealed member is back at its tile",
          ).toBe(true);
          expect(
            sameRect(end[survivor]!, split.panes[survivor]!),
            "the survivor is back at its tile",
          ).toBe(true);
        }

        expect(
          await takeCuts(app),
          "stack and split on a slot produce no cut records",
        ).toBe("");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
