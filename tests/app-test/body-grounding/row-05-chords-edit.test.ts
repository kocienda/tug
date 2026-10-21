/**
 * row-05-chords-edit.test.ts — typing, ⌘K, the Edit chords and the find
 * chords act in the body that holds the keyboard.
 *
 * A piece of row 5 ([B02] row 5; the row is `_row-05.ts`'s): with a body
 * session card holding the keyboard, its composer takes typing and the Edit
 * chords, ⌘K focuses it, and ⌘F, ⌘G, ⇧⌘G and Escape drive its find bar.
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
import { SHOULD_RUN, TEST_TIMEOUT_MS, editChords } from "./_row-05";

describe.skipIf(!SHOULD_RUN)("body-grounding row 5: the Edit and find chords", () => {
  test.skipIf(!sessionUnderTest(5))(
    "typing, ⌘K, the Edit chords and the find chords act in the body that holds the keyboard",
    () => editChords({ foreground: true }),
    TEST_TIMEOUT_MS,
  );
});
