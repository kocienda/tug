/**
 * row-02-drag-kinds.test.ts — every other kind's body card dragged by its
 * chrome moves as one piece under the pointer and lands as one.
 *
 * A piece of row 2 ([B02] row 2; the gesture and its reading are
 * `_row-02.ts`'s): a content card pressed at its grab handle, a rail at its
 * whole title bar.
 *
 * @foreground
 * @family row-02-drag
 * @covers tugdeck/src/lib/body-placement.ts
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugapp/Sources/TestHarness/NativeEventHandlers.swift
 */

import { describe, test } from "bun:test";

import { kindsUnderTest } from "./_kinds";
import { SHOULD_RUN, TEST_TIMEOUT_MS, dragKind } from "./_row-02";

describe.skipIf(!SHOULD_RUN)("body-grounding row 2: drag, every other kind", () => {
  for (const kind of kindsUnderTest(2)) {
    if (kind.componentId === "session") continue;
    test(
      `${kind.componentId}: a body card dragged by its chrome moves as one piece under the pointer and lands as one`,
      () => dragKind({ foreground: true }, kind),
      TEST_TIMEOUT_MS,
    );
  }
});
