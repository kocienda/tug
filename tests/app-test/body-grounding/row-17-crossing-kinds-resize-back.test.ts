/**
 * row-17-crossing-kinds-resize-back.test.ts — the gesture that takes
 * another kind's box back carries its body to its old size with its chrome.
 *
 * A piece of row 17 ([B02] row 17; the legs are `_row-17.ts`'s): a rail's
 * box changes back when the rail card that joined its edge goes, a content
 * kind's in bullseye out; the first gesture is made as the set-up. The
 * Overview's column, given posts enough to scroll, is pinned to its bottom
 * across it.
 *
 * @family row-17-crossing
 * @covers tugdeck/src/body/body-main.ts
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugdeck/src/lib/card-placement.ts
 */

import { describe, test } from "bun:test";

import { kindsUnderTest } from "./_kinds";
import { SHOULD_RUN, TEST_TIMEOUT_MS, kindResizeLeg, withKind } from "./_row-17";

describe.skipIf(!SHOULD_RUN)("body-grounding row 17: the gesture back, every other kind", () => {
  for (const kind of kindsUnderTest(17)) {
    if (kind.componentId === "session") continue;
    test(
      `${kind.componentId}: the gesture that takes its box back carries the body to its old size with its chrome`,
      () => withKind(kind, "resize-back", (at) => kindResizeLeg(kind, true, at)),
      TEST_TIMEOUT_MS,
    );
  }
});
