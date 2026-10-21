/**
 * row-05-chords-turns.test.ts — turn navigation and the dictation toggle act
 * in the body that holds the keyboard.
 *
 * A piece of row 5 ([B02] row 5; the row is `_row-05.ts`'s): with a body
 * session card holding the keyboard, ⌃⌘[ and ⌃⌘] page its transcript and ⌘D
 * starts and stops its dictation, leaving the other body's untouched.
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

import { sessionUnderTest } from "./_kinds";
import { SHOULD_RUN, TEST_TIMEOUT_MS, turnChords } from "./_row-05";

describe.skipIf(!SHOULD_RUN)("body-grounding row 5: turn navigation and dictation", () => {
  test.skipIf(!sessionUnderTest(5))(
    "turn navigation and the dictation toggle act in the body that holds the keyboard",
    () => turnChords({ foreground: true }),
    TEST_TIMEOUT_MS,
  );
});
