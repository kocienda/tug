/**
 * row-14-beats-move-flow-back.test.ts — the flow slide back carries both
 * Session body cards with their chrome.
 *
 * A piece of row 14 ([B02] row 14; the row is `_row-14.ts`'s): Go to slot 2
 * made as the set-up, then Go to slot 1 in a four-up flow band holding two
 * body cards, with its land read on both sides as the way out's is.
 *
 * @family row-14-beats-move
 * @covers tugdeck/src/lib/card-plan.ts
 * @covers tugapp/Sources/BodyBeats.swift
 */

import { describe, test } from "bun:test";

import { sessionUnderTest } from "./_kinds";
import { setUpGesture } from "./_motion";
import { SHOULD_RUN, TEST_TIMEOUT_MS, action, flowLeg, withFlow } from "./_row-14";

describe.skipIf(!SHOULD_RUN)("body-grounding row 14: the flow slide back", () => {
  test.skipIf(!sessionUnderTest(14))(
    "the flow slide back carries both body cards with their chrome",
    () =>
      withFlow("flow-back", async ({ app, card, standing, crop }) => {
        await setUpGesture(app, card, "go to slot 2", (a) => a.evalJS<null>(`(${action("go-to-slot", { value: 2 })}, null)`));
        await flowLeg(app, card, "go to slot 1", action("go-to-slot", { value: 1 }), standing, crop);
      }),
    TEST_TIMEOUT_MS,
  );
});
