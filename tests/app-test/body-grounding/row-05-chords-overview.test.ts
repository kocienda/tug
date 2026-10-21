/**
 * row-05-chords-overview.test.ts — the Overview's own chords act in its body.
 *
 * A piece of row 5 ([B02] row 5; the row is `_row-05.ts`'s): with the
 * Overview's body holding the keyboard, its composer takes typing and the
 * Edit chords, ⌃⌘[ and ⌃⌘] page its column by post, and ⌘D starts and stops
 * dictation in its composer.
 *
 * @foreground activation
 * @family row-05-chords
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugdeck/src/body/body-main.ts
 * @covers tugdeck/src/lib/keyboard-yield.ts
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugapp/Sources/TestHarness/NativeEventHandlers.swift
 */

import { describe, test } from "bun:test";

import { kindsUnderTest } from "./_kinds";
import { SHOULD_RUN, TEST_TIMEOUT_MS, overviewChords } from "./_row-05";

describe.skipIf(!SHOULD_RUN)("body-grounding row 5: the Overview's chords", () => {
  test.skipIf(!kindsUnderTest(5).some((k) => k.componentId === "overview"))(
    "overview: its composer's typing and Edit chords, its paging chords and ⌘D act in its body",
    () => overviewChords({ foreground: true }),
    TEST_TIMEOUT_MS,
  );
});
