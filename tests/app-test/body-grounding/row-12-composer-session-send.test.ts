/**
 * row-12-composer-session-send.test.ts — Z2 and the composer work in a
 * Session body: a prompt sent plays the next turn, and text and an image
 * paste into it.
 *
 * A piece of row 12 ([B02] row 12; the reading is `_row-12.ts`'s).
 *
 * @foreground
 * @family row-12-composer
 * @covers tugdeck/src/body/body-main.ts
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugdeck/src/components/tugways/tug-text-editor/clipboard-filters.ts
 * @covers tugapp/Sources/BodyGeometry.swift
 */

import { describe, test } from "bun:test";

import { sessionUnderTest } from "./_kinds";
import { SHOULD_RUN, TEST_TIMEOUT_MS, sessionComposer } from "./_row-12";

describe.skipIf(!SHOULD_RUN)("body-grounding row 12: Z2, the composer, paste and the picker handoff", () => {
  test.skipIf(!sessionUnderTest(12))(
    "Z2 and the composer work in a body, and text and an image paste into it",
    () => sessionComposer({ foreground: true }, "send"),
    TEST_TIMEOUT_MS,
  );
});
