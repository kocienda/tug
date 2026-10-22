/**
 * row-14-beats-move-flow-out.test.ts — the flow slide out carries both
 * Session body cards with their chrome.
 *
 * A piece of row 14 ([B02] row 14; the row is `_row-14.ts`'s): Go to slot 2
 * in a four-up flow band holding two body cards, the strip's slide, with its
 * land read on both sides: the shell's one frame, and no commit in either
 * body page across the slide.
 *
 * @family row-14-beats-move
 * @covers tugdeck/src/lib/card-plan.ts
 * @covers tugapp/Sources/BodyBeats.swift
 */

import { describe, test } from "bun:test";

import { sessionUnderTest } from "./_kinds";
import { SHOULD_RUN, TEST_TIMEOUT_MS, action, flowLeg, withFlow } from "./_row-14";

describe.skipIf(!SHOULD_RUN)("body-grounding row 14: the flow slide out", () => {
  test.skipIf(!sessionUnderTest(14))(
    "the flow slide out carries both body cards with their chrome",
    () =>
      withFlow("flow-out", ({ app, card, standing, crop }) =>
        flowLeg(app, card, "go to slot 2", action("go-to-slot", { value: 2 }), standing, crop),
      ),
    TEST_TIMEOUT_MS,
  );
});
