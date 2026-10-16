/**
 * row-15-skew-shipped.test.ts — a carried body stands within two frames of
 * travel of its chrome at the offset that ships.
 *
 * A piece of row 15 ([B02] row 15; the row is `_row-15.ts`'s): leg B, a
 * flow slide out and back with no override, every frame in motion held to
 * the bar.
 *
 * @foreground
 * @family row-15-skew
 * @covers tugapp/Sources/BodyBeats.swift
 * @covers tugdeck/src/lib/body-beat-plan.ts
 */

import { describe, test } from "bun:test";

import { SHOULD_RUN, TEST_TIMEOUT_MS, shipped } from "./_row-15";

describe.skipIf(!SHOULD_RUN)("body-grounding row 15: the skew at the offset that ships", () => {
  test(
    "the body stands within two frames of travel of its chrome at the offset that ships",
    () => shipped({ foreground: true }, false),
    TEST_TIMEOUT_MS,
  );
});
