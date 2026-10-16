/**
 * row-15-skew-offset-zero.test.ts — the skew between a carried body and its
 * chrome with the host's beats at an offset of 0.
 *
 * A piece of row 15 ([B02] row 15; the row is `_row-15.ts`'s): leg A, the
 * reading whose median lead is the offset `shippedBeatOffsetPeriods` is set
 * to.
 *
 * @foreground
 * @family row-15-skew
 * @covers tugapp/Sources/BodyBeats.swift
 * @covers tugdeck/src/lib/body-beat-plan.ts
 */

import { describe, test } from "bun:test";

import { SHOULD_RUN, TEST_TIMEOUT_MS, offsetZero } from "./_row-15";

describe.skipIf(!SHOULD_RUN)("body-grounding row 15: the skew at an offset of 0", () => {
  test(
    "the skew at an offset of 0",
    () => offsetZero({ foreground: true }),
    TEST_TIMEOUT_MS,
  );
});
