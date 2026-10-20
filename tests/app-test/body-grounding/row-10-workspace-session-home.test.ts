/**
 * row-10-workspace-session-home.test.ts — the switch home hides the away
 * workspace's Session body and shows both of home's on their own
 * placeholders.
 *
 * A piece of row 10 ([B02] row 10; the switch and its reading are
 * `_row-10.ts`'s): two body Session cards at home, a third opened by ⌘N in a
 * second workspace, switched home through `activate-space`.
 *
 * @foreground
 * @family row-10-workspace
 * @covers tugdeck/src/lib/card-placement.ts
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugapp/Sources/BodyViewController.swift
 */

import { describe, test } from "bun:test";

import { sessionUnderTest } from "./_kinds";
import { SHOULD_RUN, TEST_TIMEOUT_MS, switchSessions } from "./_row-10";

describe.skipIf(!SHOULD_RUN)("body-grounding row 10: workspace switch", () => {
  test.skipIf(!sessionUnderTest(10))(
    "away → home: every departing body hides and every arriving body shows on its own placeholder, with no frame of a body in the wrong place",
    () => switchSessions({ foreground: true }, "home"),
    TEST_TIMEOUT_MS,
  );
});
