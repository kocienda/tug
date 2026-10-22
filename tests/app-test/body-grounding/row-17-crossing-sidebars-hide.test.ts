/**
 * row-17-crossing-sidebars-hide.test.ts — hiding the sidebars carries a
 * streaming Session body with its chrome.
 *
 * A piece of row 17 ([B02] row 17; the legs are `_row-17.ts`'s): the body
 * card second in a four-up flow beside a Layout rail. The sidebars carry it
 * as a slide or not at all, and are read as whichever they are.
 *
 * @family row-17-crossing
 * @covers tugdeck/src/body/body-main.ts
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugdeck/src/lib/card-placement.ts
 */

import { describe, test } from "bun:test";

import { sessionUnderTest } from "./_kinds";
import { SHOULD_RUN, TEST_TIMEOUT_MS, control, crossLeg, withFlow } from "./_row-17";

describe.skipIf(!SHOULD_RUN)("body-grounding row 17: the sidebars hide", () => {
  test.skipIf(!sessionUnderTest(17))(
    "hiding the sidebars carries the body with its chrome",
    () =>
      withFlow("sidebars-hide", async ({ app, card, s, crop }) => {
        await crossLeg(app, card, { label: "sidebars hide", run: control("toggle-sidebars"), resizes: false }, s, crop);
      }),
    TEST_TIMEOUT_MS,
  );
});
