/**
 * row-17-crossing-bullseye-in.test.ts — bullseye in carries a streaming
 * Session body to its new size with its chrome.
 *
 * A piece of row 17 ([B02] row 17; the legs are `_row-17.ts`'s): the body
 * card second in a four-up flow. Before the gesture, the content box's top
 * corners stand square under the masthead; then the gesture must change the
 * body's box, with `crossingReady` within a display period of the first
 * moving beat and the transcript pinned to its bottom before and after.
 *
 * @foreground activation
 * @family row-17-crossing
 * @covers tugdeck/src/body/body-main.ts
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugdeck/src/lib/card-placement.ts
 */

import { describe, test } from "bun:test";

import { sessionUnderTest } from "./_kinds";
import { SHOULD_RUN, TEST_TIMEOUT_MS, control, crossLeg, expectSquareTop, withFlow } from "./_row-17";

describe.skipIf(!SHOULD_RUN)("body-grounding row 17: bullseye in", () => {
  test.skipIf(!sessionUnderTest(17))(
    "bullseye in carries the body to its new size with its chrome",
    () =>
      withFlow({ foreground: true }, "bullseye-in", async ({ app, card, s, crop }) => {
        await expectSquareTop(app, card, s.palette);
        await crossLeg(app, card, { label: "bullseye in", run: control("toggle-bullseye"), resizes: true }, s, crop);
      }),
    TEST_TIMEOUT_MS,
  );
});
