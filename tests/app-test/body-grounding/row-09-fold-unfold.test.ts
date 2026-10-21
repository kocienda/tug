/**
 * row-09-fold-unfold.test.ts — the unfold shows the body only at the land,
 * with no peek.
 *
 * A piece of row 9 ([B02] row 9; the row is `_row-09.ts`'s): a body card
 * folded as the unmeasured set-up, then unfolded through the session tap
 * (⌃⌘Y), read by the composite and the shell's record together.
 *
 * @foreground activation
 * @family row-09-fold
 * @covers tugdeck/src/lib/card-placement.ts
 * @covers tugdeck/src/lib/card-fold.ts
 * @covers tugapp/Sources/BodyViewController.swift
 */

import { describe, test } from "bun:test";

import { kindsUnderTest, sessionUnderTest } from "./_kinds";
import { SHOULD_RUN, TEST_TIMEOUT_MS, foldKind, foldSession } from "./_row-09";

describe.skipIf(!SHOULD_RUN)("body-grounding row 9: the unfold", () => {
  for (const kind of kindsUnderTest(9)) {
    if (kind.componentId === "session") continue;
    test(
      `${kind.componentId}: the unfold shows the body only at the land, with no peek`,
      () => foldKind({ foreground: true }, kind, "unfold"),
      TEST_TIMEOUT_MS,
    );
  }

  test.skipIf(!sessionUnderTest(9))(
    "the unfold carries the body from its folded strip, with no peek",
    () => foldSession({ foreground: true }, "unfold"),
    TEST_TIMEOUT_MS,
  );
});
