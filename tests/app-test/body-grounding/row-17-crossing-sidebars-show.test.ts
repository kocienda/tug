/**
 * row-17-crossing-sidebars-show.test.ts — showing the sidebars again
 * carries a streaming Session body with its chrome.
 *
 * A piece of row 17 ([B02] row 17; the legs are `_row-17.ts`'s): the body
 * card second in a four-up flow beside a Layout rail, the sidebars hidden as
 * the set-up. The sidebars carry it as a slide or not at all, and are read
 * as whichever they are.
 *
 * @foreground
 * @family row-17-crossing
 * @covers tugdeck/src/body/body-main.ts
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugdeck/src/lib/body-placement.ts
 */

import { describe, test } from "bun:test";

import { sessionUnderTest } from "./_kinds";
import { SHOULD_RUN, TEST_TIMEOUT_MS, control, crossLeg, setUpGesture, withFlow } from "./_row-17";

describe.skipIf(!SHOULD_RUN)("body-grounding row 17: the sidebars show", () => {
  test.skipIf(!sessionUnderTest(17))(
    "showing the sidebars again carries the body with its chrome",
    () =>
      withFlow({ foreground: true }, "sidebars-show", async ({ app, card, s, crop }) => {
        await setUpGesture(app, card, "sidebars hide", control("toggle-sidebars"));
        await crossLeg(app, card, { label: "sidebars show", run: control("toggle-sidebars"), resizes: false }, s, crop);
      }),
    TEST_TIMEOUT_MS,
  );
});
