/**
 * row-01-arrival-warm.test.ts — ⌘N: a card arrives warm, on the waiting
 * spare, with nothing of the canvas, grid or window showing at any frame.
 *
 * A piece of row 1 ([B02] row 1; the arrival and its reading are
 * `_row-01.ts`'s).
 *
 * @foreground activation
 * @family row-01-arrival
 * @covers tugdeck/src/lib/card-placement.ts
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugdeck/src/lib/body-cards-store.ts
 * @covers tugdeck/src/body/body-main.ts
 * @covers tugdeck/src/components/tugways/cards/session-picker-quiet.ts
 * @covers tugdeck/src/components/tugways/tug-pane.css
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugapp/Sources/HostFrameMeter.swift
 */

import { describe, test } from "bun:test";

import { sessionUnderTest } from "./_kinds";
import { SHOULD_RUN, TEST_TIMEOUT_MS, arrivalWarm } from "./_row-01";

describe.skipIf(!SHOULD_RUN)("body-grounding row 1: arrival, warm", () => {
  test.skipIf(!sessionUnderTest(1))(
    "⌘N: a card arrives warm with nothing of the canvas, grid or window showing at any frame",
    () => arrivalWarm({ foreground: true }),
    TEST_TIMEOUT_MS,
  );
});
