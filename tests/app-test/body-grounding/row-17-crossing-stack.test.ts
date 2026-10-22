/**
 * row-17-crossing-stack.test.ts — stacking a split column carries a
 * streaming Session body back to the full run.
 *
 * A piece of row 17 ([B02] row 17; the legs are `_row-17.ts`'s): the body
 * card in front of a column it shares, the column split first (unasserted).
 * Stacking it grows the body card over its partner, which retires: held at
 * its tile while the survivor grows over it, its page laid out at the full
 * run in the solve under a cover of its face, landing there at the chain's
 * end. The land owes nothing on either side, for either card, and the
 * placer's land measurement moves neither.
 *
 * @family row-17-crossing
 * @covers tugdeck/src/components/chrome/settle-engine.ts
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugdeck/src/lib/card-placement.ts
 */

import { describe, test } from "bun:test";

import { sessionUnderTest } from "./_kinds";
import { SHOULD_RUN, STACK_PARTNER, TEST_TIMEOUT_MS, control, crossLeg, setUpGesture, withStack } from "./_row-17";

describe.skipIf(!SHOULD_RUN)("body-grounding row 17: a column stack", () => {
  test.skipIf(!sessionUnderTest(17))(
    "stacking a split column carries the body to the full run and its partner under it",
    () =>
      withStack("stack", async ({ app, card, s, crop }) => {
        await setUpGesture(app, card, "split", control("set-column-mode", { slot: 0, mode: "split" }));
        await crossLeg(
          app,
          card,
          { label: "stack", run: control("set-column-mode", { slot: 0, mode: "stack" }), resizes: true, solved: [card, STACK_PARTNER] },
          s,
          crop,
        );
      }),
    TEST_TIMEOUT_MS,
  );
});
