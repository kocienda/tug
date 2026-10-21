/**
 * row-10-workspace-session-home-evicted.test.ts — the switch home onto two
 * evicted Session cards holds row 10's bars.
 *
 * `row-10-workspace-session-home` with the home cards' bodies dormant and
 * then evicted before the switch (`_tiers.ts`): each card's new body shows
 * on its own placeholder, under its last frame until it paints, and no frame
 * shows a body in the wrong place or a bare hole.
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

describe.skipIf(!SHOULD_RUN)("body-grounding row 10: workspace switch home, evicted", () => {
  test.skipIf(!sessionUnderTest(10))(
    "away → home onto evicted cards: every departing body hides and every arriving body shows on its own placeholder",
    () => switchSessions({ foreground: true, tier: "evicted" }, "home"),
    TEST_TIMEOUT_MS,
  );
});
