/**
 * at0594-slot-flip-cover-three.test.ts — a slot mode flip is a cover, not
 * a fade; the three-member slot.
 *
 * Split from `at0594-slot-flip-cover`, one file per member count, each its
 * own launch: the two-member slot in `at0594-slot-flip-cover-two`, the
 * three-member one here. The deck, the sampler and the claims are one body in
 * `slot-flip-cover-fixture.ts`; the claims and the argument for them are in
 * the two-member file's docblock.
 *
 * The three-member case — middle member frontmost, both directions — holds the
 * same claims and, because the brief left how it READS as an open question,
 * records the survivor's rect through each settle as `note()` lines so the
 * fused beat can be read from the report.
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
  settlingFrames,
  takeCuts,
  wait,
  type Sample,
} from "./slot-flip-cover-fixture";

describe.skipIf(!SHOULD_RUN)("at0594 — slot flip cover [three]", () => {
  test(
    "a three-member slot with the middle member frontmost flips both ways as a cover",
    async () => {
      const paneIds = ["p1", "p2", "p3"];
      const app = await launch(3, "at0594-slot-flip-cover-three");
      try {
        // card-dom: shell — a deck command dispatched in the shell, reaching no card's DOM.
        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("set-slot-mode", { slot: 0, mode: "split" }), null)`,
        );
        await wait(AFTER_LAND_MS);
        const split = await readNow(app, paneIds);
        const survivor = memberAtRank(split, paneIds, 1);
        await raise(app, survivor);
        note(
          `three-member: middle member ${survivor} raised at ${Math.round(split.panes[survivor]!.top)}..${Math.round(split.panes[survivor]!.bottom)}`,
        );

        await app.evalJS<null>(`(window.__tug.armCutDetector(), null)`);

        // The survivor's rect through each settle, for the eye the arc does
        // not have: both edges move on a stack from the middle tile, and both
        // retreat on the split. Read the samples for one edge sweep per beat.
        const trace = (label: string, samples: Sample[]): void => {
          const rows = settlingFrames(samples)
            .filter((_, i) => i % 3 === 0)
            .map((s) => {
              const p = s.panes[survivor]!;
              return `${Math.round(s.t)}ms ${s.beat || "-"} ${Math.round(p.top)}..${Math.round(p.bottom)}`;
            });
          note(`${label} survivor: ${rows.join(" | ")}`);
        };

        const stacked = await census(app, paneIds, "stack");
        trace("stack", stacked);
        assertCover("stack", stacked, paneIds, survivor, "stack");

        const divided = await census(app, paneIds, "split");
        trace("split", divided);
        assertCover("split", divided, paneIds, survivor, "split");
        {
          const end = divided[divided.length - 1]!.panes;
          for (const id of paneIds) {
            expect(
              sameRect(end[id]!, split.panes[id]!),
              `${id} is back at its tile after the round trip`,
            ).toBe(true);
          }
        }

        expect(
          await takeCuts(app),
          "stack and split on a three-member slot produce no cut records",
        ).toBe("");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
