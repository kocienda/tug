/**
 * row-10-workspace-session-home-dormant.test.ts — the switch home onto two
 * dormant Session bodies holds row 10's bars.
 *
 * `row-10-workspace-session-home` with the home cards' bodies put in the
 * dormant tier before the switch (`_tiers.ts`): each arriving body shows on
 * its own placeholder, lidded until it has caught up, and no frame shows a
 * body in the wrong place or a bare hole.
 *
 * @foreground activation
 * @family row-10-workspace
 * @covers tugdeck/src/body/body-dormancy.ts
 * @covers tugdeck/src/lib/card-placement.ts
 * @covers tugapp/Sources/BodyViewController.swift
 */

import { describe, test } from "bun:test";

import { sessionUnderTest } from "./_kinds";
import { SHOULD_RUN, TEST_TIMEOUT_MS, switchSessions } from "./_row-10";

describe.skipIf(!SHOULD_RUN)("body-grounding row 10: workspace switch home, dormant", () => {
  test.skipIf(!sessionUnderTest(10))(
    "away → home onto dormant bodies: every departing body hides and every arriving body shows on its own placeholder",
    () => switchSessions({ foreground: true, tier: "dormant" }, "home"),
    TEST_TIMEOUT_MS,
  );
});
