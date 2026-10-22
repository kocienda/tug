/**
 * row-17-crossing-new-card.test.ts — a new card opened beside a streaming
 * Session body moves it with its chrome.
 *
 * A piece of row 17 ([B02] row 17; the legs are `_row-17.ts`'s): ⌘N's own
 * action, `show-card`, opens a card beside the body card in a four-up flow;
 * its neighbours ride the arrival's fused room beat, which carries size
 * terms, and the body card must move.
 *
 * @family row-17-crossing
 * @covers tugdeck/src/body/body-main.ts
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugdeck/src/lib/card-placement.ts
 */

import { describe, test } from "bun:test";

import { sessionUnderTest } from "./_kinds";
import { SHOULD_RUN, TEST_TIMEOUT_MS, control, crossLeg, withFlow } from "./_row-17";

describe.skipIf(!SHOULD_RUN)("body-grounding row 17: a new card", () => {
  test.skipIf(!sessionUnderTest(17))(
    "a new card opened beside the body card moves it with its chrome",
    () =>
      withFlow("new-card", ({ app, card, s, crop }) =>
        crossLeg(app, card, { label: "new card", run: control("show-card", { component: "session" }), resizes: false, moves: true }, s, crop),
      ),
    TEST_TIMEOUT_MS,
  );
});
