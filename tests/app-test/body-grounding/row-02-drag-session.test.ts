/**
 * row-02-drag-session.test.ts — a Session body card dragged by its handle
 * moves as one piece under the pointer and lands as one.
 *
 * A piece of row 2 ([B02] row 2; the gesture and its reading are
 * `_row-02.ts`'s): the grab handle pressed and dragged through the
 * activated session tap, read by the shell's sampler, the host's snapshot
 * and a composite burst.
 *
 * @foreground
 * @family row-02-drag
 * @covers tugdeck/src/lib/body-placement.ts
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugapp/Sources/TestHarness/NativeEventHandlers.swift
 */

import { describe, test } from "bun:test";

import { sessionUnderTest } from "./_kinds";
import { SHOULD_RUN, TEST_TIMEOUT_MS, dragSession } from "./_row-02";

describe.skipIf(!SHOULD_RUN)("body-grounding row 2: drag", () => {
  test.skipIf(!sessionUnderTest(2))(
    "a body card dragged by its handle moves as one piece under the pointer and lands as one",
    () => dragSession({ foreground: true }),
    TEST_TIMEOUT_MS,
  );
});
