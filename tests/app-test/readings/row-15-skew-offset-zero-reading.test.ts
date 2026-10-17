/**
 * row-15-skew-offset-zero-reading.test.ts — the skew between a carried body
 * and its chrome with the host's beats at an offset of 0.
 *
 * Leg A of row 15 (`body-grounding/_row-15.ts`): the reading whose median
 * lead is the offset `shippedBeatOffsetPeriods` is set to. A reading, not a
 * guard: it asserts only that the host ran at offset 0, so it lives here,
 * run by name when the shipped offset is reconsidered. Legs B and C, which
 * hold the shipped offset to the bar, stay in the grounding rows.
 *
 * @foreground
 * @covers tugapp/Sources/BodyBeats.swift
 * @covers tugdeck/src/lib/body-beat-plan.ts
 */

import { describe, test } from "bun:test";

import { SHOULD_RUN, TEST_TIMEOUT_MS, offsetZero } from "../body-grounding/_row-15";

describe.skipIf(!SHOULD_RUN)("body-grounding row 15: the skew at an offset of 0", () => {
  test(
    "the skew at an offset of 0",
    () => offsetZero({ foreground: true }),
    TEST_TIMEOUT_MS,
  );
});
