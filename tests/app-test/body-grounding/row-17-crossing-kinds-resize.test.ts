/**
 * row-17-crossing-kinds-resize.test.ts — the gesture that changes another
 * kind's box carries its body to its new size with its chrome.
 *
 * A piece of row 17 ([B02] row 17; the legs are `_row-17.ts`'s): a rail's
 * box changes when another rail card joins its edge, a content kind's in
 * bullseye in; `row-17-crossing-kinds-resize-back` takes each back. The
 * Overview's column, given posts enough to scroll, is pinned to its bottom
 * across it.
 *
 * @foreground
 * @family row-17-crossing
 * @covers tugdeck/src/body/body-main.ts
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugdeck/src/lib/body-placement.ts
 */

import { describe, test } from "bun:test";

import { kindsUnderTest } from "./_kinds";
import { SHOULD_RUN, TEST_TIMEOUT_MS, kindResizeLeg, withKind } from "./_row-17";

describe.skipIf(!SHOULD_RUN)("body-grounding row 17: the gestures that resize every other kind", () => {
  for (const kind of kindsUnderTest(17)) {
    if (kind.componentId === "session") continue;
    test(
      `${kind.componentId}: the gesture that changes its box carries the body to its new size with its chrome`,
      () => withKind({ foreground: true }, kind, "resize", (at) => kindResizeLeg(kind, false, at)),
      TEST_TIMEOUT_MS,
    );
  }
});
