/**
 * row-14-beats-move-kinds-back.test.ts — the gesture that moves another kind
 * back carries its body with its chrome.
 *
 * A piece of row 14 ([B02] row 14; the row is `_row-14.ts`'s): the way out
 * made as the set-up, then a pinned rail moved back to its edge, or a
 * content card by the flow slide back.
 *
 * @family row-14-beats-move
 * @covers tugdeck/src/lib/card-plan.ts
 * @covers tugapp/Sources/BodyBeats.swift
 */

import { describe, test } from "bun:test";

import { kindsUnderTest } from "./_kinds";
import { carryLeg, setUpGesture } from "./_motion";
import { SHOULD_RUN, TEST_TIMEOUT_MS, kindLegs, withKind } from "./_row-14";

describe.skipIf(!SHOULD_RUN)("body-grounding row 14: the way back, every other kind", () => {
  for (const kind of kindsUnderTest(14)) {
    if (kind.componentId === "session") continue;
    test(
      `${kind.componentId}: the gesture that moves it back carries the body with its chrome`,
      () =>
        withKind(kind, "back", async ({ app, card, standing, crop }) => {
          const { out, back } = kindLegs(kind);
          await setUpGesture(app, card, out.label, (a) => a.evalJS<null>(`(${out.js}, null)`));
          await carryLeg(app, card, [card], back.label, back.js, standing, crop);
        }),
      TEST_TIMEOUT_MS,
    );
  }
});
