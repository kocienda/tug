/**
 * row-17-crossing-bullseye-out.test.ts — bullseye out carries a streaming
 * Session body back to its size with its chrome.
 *
 * A piece of row 17 ([B02] row 17; the legs are `_row-17.ts`'s): the body
 * card second in a four-up flow, bullseye in made as the set-up. The
 * gesture must change the body's box, with `crossingReady` within a display
 * period of the first moving beat and the transcript pinned to its bottom
 * before and after.
 *
 * @foreground activation
 * @family row-17-crossing
 * @covers tugdeck/src/body/body-main.ts
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugdeck/src/lib/card-placement.ts
 */

import { describe, test } from "bun:test";

import { sessionUnderTest } from "./_kinds";
import { SHOULD_RUN, TEST_TIMEOUT_MS, control, crossLeg, setUpGesture, withFlow } from "./_row-17";

describe.skipIf(!SHOULD_RUN)("body-grounding row 17: bullseye out", () => {
  test.skipIf(!sessionUnderTest(17))(
    "bullseye out carries the body back to its size with its chrome",
    () =>
      withFlow({ foreground: true }, "bullseye-out", async ({ app, card, s, crop }) => {
        await setUpGesture(app, card, "bullseye in", control("toggle-bullseye"));
        await crossLeg(app, card, { label: "bullseye out", run: control("toggle-bullseye"), resizes: true }, s, crop);
      }),
    TEST_TIMEOUT_MS,
  );
});
