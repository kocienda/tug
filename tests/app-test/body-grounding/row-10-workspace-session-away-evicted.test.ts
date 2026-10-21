/**
 * row-10-workspace-session-away-evicted.test.ts — the switch back to the away
 * workspace onto its evicted Session card holds row 10's bars.
 *
 * `row-10-workspace-session-away` with the away card's body dormant and then
 * evicted before the switch back (`_tiers.ts`).
 *
 * @foreground activation
 * @family row-10-workspace
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugdeck/src/lib/card-placement.ts
 * @covers tugapp/Sources/BodyViewController.swift
 */

import { describe, test } from "bun:test";

import { sessionUnderTest } from "./_kinds";
import { SHOULD_RUN, TEST_TIMEOUT_MS, switchSessions } from "./_row-10";

describe.skipIf(!SHOULD_RUN)("body-grounding row 10: workspace switch back, evicted", () => {
  test.skipIf(!sessionUnderTest(10))(
    "home → away onto an evicted card: every departing body hides and every arriving body shows on its own placeholder",
    () => switchSessions({ foreground: true, tier: "evicted" }, "away"),
    TEST_TIMEOUT_MS,
  );
});
