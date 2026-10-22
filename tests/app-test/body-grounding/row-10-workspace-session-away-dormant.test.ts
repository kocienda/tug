/**
 * row-10-workspace-session-away-dormant.test.ts — the switch back to the away
 * workspace onto its dormant Session body holds row 10's bars.
 *
 * `row-10-workspace-session-away` with the away card's body put in the
 * dormant tier before the switch back (`_tiers.ts`).
 *
 * @family row-10-workspace
 * @covers tugdeck/src/body/body-dormancy.ts
 * @covers tugdeck/src/lib/card-placement.ts
 * @covers tugapp/Sources/BodyViewController.swift
 */

import { describe, test } from "bun:test";

import { sessionUnderTest } from "./_kinds";
import { SHOULD_RUN, TEST_TIMEOUT_MS, switchSessions } from "./_row-10";

describe.skipIf(!SHOULD_RUN)("body-grounding row 10: workspace switch back, dormant", () => {
  test.skipIf(!sessionUnderTest(10))(
    "home → away onto a dormant body: every departing body hides and every arriving body shows on its own placeholder",
    () => switchSessions("away", "dormant"),
    TEST_TIMEOUT_MS,
  );
});
