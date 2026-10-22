/**
 * row-14-beats-move-kinds-out.test.ts — the gesture that only moves another
 * kind carries its body with its chrome.
 *
 * A piece of row 14 ([B02] row 14; the row is `_row-14.ts`'s): a pinned
 * rail moved to the other edge, which keeps its size, or a content card by
 * the flow slide out.
 *
 * @family row-14-beats-move
 * @covers tugdeck/src/lib/card-plan.ts
 * @covers tugapp/Sources/BodyBeats.swift
 */

import { describe, test } from "bun:test";

import { kindsUnderTest } from "./_kinds";
import { carryLeg } from "./_motion";
import { SHOULD_RUN, TEST_TIMEOUT_MS, kindLegs, withKind } from "./_row-14";

describe.skipIf(!SHOULD_RUN)("body-grounding row 14: the way out, every other kind", () => {
  for (const kind of kindsUnderTest(14)) {
    if (kind.componentId === "session") continue;
    test(
      `${kind.componentId}: the gesture that only moves it carries the body with its chrome`,
      () =>
        withKind(kind, "out", ({ app, card, standing, crop }) => {
          const { out } = kindLegs(kind);
          return carryLeg(app, card, [card], out.label, out.js, standing, crop);
        }),
      TEST_TIMEOUT_MS,
    );
  }
});
