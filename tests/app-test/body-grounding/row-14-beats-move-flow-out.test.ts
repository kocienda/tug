/**
 * row-14-beats-move-flow-out.test.ts — the flow slide out carries both
 * Session body cards with their chrome.
 *
 * A piece of row 14 ([B02] row 14; the row is `_row-14.ts`'s): Go to slot 2
 * in a four-up flow band holding two body cards, the strip's prelaunched
 * slide.
 *
 * @family row-14-beats-move
 * @covers tugdeck/src/lib/card-plan.ts
 * @covers tugapp/Sources/BodyBeats.swift
 */

import { describe, test } from "bun:test";

import { sessionUnderTest } from "./_kinds";
import { carryLeg } from "./_motion";
import { FLOW_BODIES, SHOULD_RUN, TEST_TIMEOUT_MS, action, withFlow } from "./_row-14";

describe.skipIf(!SHOULD_RUN)("body-grounding row 14: the flow slide out", () => {
  test.skipIf(!sessionUnderTest(14))(
    "the flow slide out carries both body cards with their chrome",
    () =>
      withFlow("flow-out", ({ app, card, standing, crop }) =>
        carryLeg(app, card, FLOW_BODIES, "go to slot 2", action("go-to-slot", { value: 2 }), standing, crop),
      ),
    TEST_TIMEOUT_MS,
  );
});
