/**
 * row-10-workspace-session-away.test.ts — the switch back to the away
 * workspace hides both of home's Session bodies and shows the away one on
 * its own placeholder.
 *
 * A piece of row 10 ([B02] row 10; the switch and its reading are
 * `_row-10.ts`'s): two body Session cards at home, a third opened by ⌘N in a
 * second workspace; the switch home is made as the set-up, and the switch
 * back through `activate-space` is read.
 *
 * @family row-10-workspace
 * @covers tugdeck/src/lib/card-placement.ts
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugapp/Sources/BodyViewController.swift
 */

import { describe, test } from "bun:test";

import { sessionUnderTest } from "./_kinds";
import { SHOULD_RUN, TEST_TIMEOUT_MS, switchSessions } from "./_row-10";

describe.skipIf(!SHOULD_RUN)("body-grounding row 10: workspace switch back", () => {
  test.skipIf(!sessionUnderTest(10))(
    "home → away: every departing body hides and every arriving body shows on its own placeholder, with no frame of a body in the wrong place",
    () => switchSessions("away"),
    TEST_TIMEOUT_MS,
  );
});
