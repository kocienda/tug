/**
 * row-10-workspace-kinds-home-evicted.test.ts — the switch home onto every
 * other kind's evicted card holds row 10's bars.
 *
 * `row-10-workspace-kinds-home` with the home card's body dormant and then
 * evicted before the switch (`_tiers.ts`).
 *
 * @foreground activation
 * @family row-10-workspace
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugdeck/src/lib/card-placement.ts
 * @covers tugapp/Sources/BodyViewController.swift
 */

import { describe, test } from "bun:test";

import { kindsUnderTest } from "./_kinds";
import { SHOULD_RUN, TEST_TIMEOUT_MS, switchKind } from "./_row-10";

describe.skipIf(!SHOULD_RUN)("body-grounding row 10: workspace switch home, evicted, every other kind", () => {
  for (const kind of kindsUnderTest(10)) {
    if (kind.componentId === "session") continue;
    test(
      `${kind.componentId}: away → home onto an evicted card: its departing body hides and its arriving body shows on its own placeholder`,
      () => switchKind({ foreground: true, tier: "evicted" }, kind, "home"),
      TEST_TIMEOUT_MS,
    );
  }
});
