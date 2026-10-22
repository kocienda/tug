/**
 * row-17-crossing-split.test.ts — a column split carries a streaming
 * Session body to its shorter box.
 *
 * A piece of row 17 ([B02] row 17; the legs are `_row-17.ts`'s): the body
 * card in front of a column it shares; splitting the column shares its
 * height, so the body's box must change.
 *
 * @family row-17-crossing
 * @covers tugdeck/src/body/body-main.ts
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugdeck/src/lib/card-placement.ts
 */

import { describe, test } from "bun:test";

import { sessionUnderTest } from "./_kinds";
import { SHOULD_RUN, TEST_TIMEOUT_MS, control, crossLeg, withStack } from "./_row-17";

describe.skipIf(!SHOULD_RUN)("body-grounding row 17: a column split", () => {
  test.skipIf(!sessionUnderTest(17))(
    "a column split carries the body to its shorter box",
    () =>
      withStack("split", ({ app, card, s, crop }) =>
        crossLeg(app, card, { label: "split", run: control("set-column-mode", { slot: 0, mode: "split" }), resizes: true }, s, crop),
      ),
    TEST_TIMEOUT_MS,
  );
});
