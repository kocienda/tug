/**
 * row-15-skew-streaming.test.ts — a carried body stands within two frames of
 * travel of its chrome at the offset that ships, with three bodies streaming.
 *
 * A piece of row 15 ([B02] row 15; the row is `_row-15.ts`'s): leg C, leg B
 * with every body mid-turn through both slides.
 *
 * @foreground
 * @family row-15-skew
 * @covers tugapp/Sources/BodyBeats.swift
 * @covers tugdeck/src/lib/body-beat-plan.ts
 */

import { describe, test } from "bun:test";

import { SHOULD_RUN, TEST_TIMEOUT_MS, shipped } from "./_row-15";

describe.skipIf(!SHOULD_RUN)("body-grounding row 15: the skew with three bodies streaming", () => {
  test(
    "the body stands within two frames of travel of its chrome at the offset that ships, three bodies streaming",
    () => shipped({ foreground: true }, true),
    TEST_TIMEOUT_MS,
  );
});
