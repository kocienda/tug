/**
 * row-10-workspace-kinds-home-dormant.test.ts — the switch home onto every
 * other kind's dormant body holds row 10's bars.
 *
 * `row-10-workspace-kinds-home` with the home card's body put in the dormant
 * tier before the switch (`_tiers.ts`).
 *
 * @family row-10-workspace
 * @covers tugdeck/src/body/body-dormancy.ts
 * @covers tugdeck/src/lib/card-placement.ts
 * @covers tugapp/Sources/BodyViewController.swift
 */

import { describe, test } from "bun:test";

import { kindsUnderTest } from "./_kinds";
import { SHOULD_RUN, TEST_TIMEOUT_MS, switchKind } from "./_row-10";

describe.skipIf(!SHOULD_RUN)("body-grounding row 10: workspace switch home, dormant, every other kind", () => {
  for (const kind of kindsUnderTest(10)) {
    if (kind.componentId === "session") continue;
    test(
      `${kind.componentId}: away → home onto a dormant body: its departing body hides and its arriving body shows on its own placeholder`,
      () => switchKind(kind, "home", "dormant"),
      TEST_TIMEOUT_MS,
    );
  }
});
