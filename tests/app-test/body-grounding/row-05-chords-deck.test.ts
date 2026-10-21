/**
 * row-05-chords-deck.test.ts — the deck chords move a body card's chrome from
 * its body.
 *
 * A piece of row 5 ([B02] row 5; the row is `_row-05.ts`'s): with a body
 * session card holding the keyboard, ⌃⌘Y folds and unfolds it, ⌘2 and ⌘1
 * move it, and ⇧⌥⌘] and ⇧⌥⌘[ nudge it, each read in the shell's deck state.
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
import { SHOULD_RUN, TEST_TIMEOUT_MS, deckChords } from "./_row-05";

describe.skipIf(!SHOULD_RUN)("body-grounding row 5: the deck chords from a body", () => {
  test.skipIf(!sessionUnderTest(5))(
    "fold, move to slot and nudge act on the card whose body holds the keyboard",
    () => deckChords({ foreground: true }),
    TEST_TIMEOUT_MS,
  );
});
