/**
 * row-14-beats-move-flow-back.test.ts — the flow slide back carries both
 * Session body cards with their chrome.
 *
 * A piece of row 14 ([B02] row 14; the row is `_row-14.ts`'s): Go to slot 2
 * made as the set-up, then Go to slot 1 in a four-up flow band holding two
 * body cards.
 *
 * @foreground
 * @family row-14-beats-move
 * @covers tugdeck/src/lib/body-beat-plan.ts
 * @covers tugapp/Sources/BodyBeats.swift
 */

import { describe, test } from "bun:test";

import { sessionUnderTest } from "./_kinds";
import { carryLeg, setUpGesture } from "./_motion";
import { FLOW_BODIES, SHOULD_RUN, TEST_TIMEOUT_MS, action, withFlow } from "./_row-14";

describe.skipIf(!SHOULD_RUN)("body-grounding row 14: the flow slide back", () => {
  test.skipIf(!sessionUnderTest(14))(
    "the flow slide back carries both body cards with their chrome",
    () =>
      withFlow({ foreground: true }, "flow-back", async ({ app, card, standing, crop }) => {
        await setUpGesture(app, card, "go to slot 2", (a) => a.evalJS<null>(`(${action("go-to-slot", { value: 2 })}, null)`));
        await carryLeg(app, card, FLOW_BODIES, "go to slot 1", action("go-to-slot", { value: 1 }), standing, crop);
      }),
    TEST_TIMEOUT_MS,
  );
});
