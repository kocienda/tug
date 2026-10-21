/**
 * row-12-composer-session-panel.test.ts — the host's file panel, asked for
 * from a Session body, hands its path back to that body, and Escape closes
 * the body's slash popup.
 *
 * A piece of row 12 ([B02] row 12; the reading is `_row-12.ts`'s): ⇧⌘I
 * from inside the body asks the host for its file panel; the panel is driven
 * by keyboard to a file the test wrote, and the path comes back as a file
 * atom in the body's composer, with the keyboard back in that body. Then
 * Session › Open Command Picker raises the body's completion popup, and an
 * Escape posted through the session tap closes it ([F17]).
 *
 * @foreground activation
 * @family row-12-composer
 * @covers tugdeck/src/body/body-main.ts
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugdeck/src/components/tugways/insert-picked-file.ts
 * @covers tugapp/Sources/BodyGeometry.swift
 */

import { describe, test } from "bun:test";

import { sessionUnderTest } from "./_kinds";
import { SHOULD_RUN, TEST_TIMEOUT_MS, sessionComposer } from "./_row-12";

describe.skipIf(!SHOULD_RUN)("body-grounding row 12: the picker handoff and the slash popup", () => {
  test.skipIf(!sessionUnderTest(12))(
    "the host's file panel hands its path back to the body that asked, and Escape closes its slash popup",
    () => sessionComposer({ foreground: true }, "panel"),
    TEST_TIMEOUT_MS,
  );
});
