/**
 * row-05-chords-text.test.ts — the chords act in the Text card's body when it
 * holds the keyboard, and in no other.
 *
 * A piece of row 5 ([B02] row 5; the row is `_row-05.ts`'s): with the Text
 * card's body holding the keyboard, typing and ⌘Z land in its editor and the
 * deck chords move and fold its card, while the session bodies beside it
 * stand untouched.
 *
 * @family row-05-chords
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugdeck/src/body/body-main.ts
 * @covers tugdeck/src/lib/keyboard-yield.ts
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugapp/Sources/TestHarness/NativeEventHandlers.swift
 */

import { describe, test } from "bun:test";

import { sessionUnderTest } from "./_kinds";
import { SHOULD_RUN, TEST_TIMEOUT_MS, textChords } from "./_row-05";

describe.skipIf(!SHOULD_RUN)("body-grounding row 5: the Text card's chords", () => {
  test.skipIf(!sessionUnderTest(5))(
    "typing, undo and the deck chords act in the Text card's body, and no other body holds the keyboard",
    () => textChords(),
    TEST_TIMEOUT_MS,
  );
});
