/**
 * row-01-arrival-cold.test.ts — ⌘N: a card opened while the spare is taken
 * arrives cold, with nothing of the canvas, grid or window showing at any
 * frame.
 *
 * A piece of row 1 ([B02] row 1; the arrival and its reading are
 * `_row-01.ts`'s): a second card takes the spare unobserved, and a third
 * is opened behind it, inside the second the spare takes to be replaced,
 * so it is made cold.
 *
 * @family row-01-arrival
 * @covers tugdeck/src/lib/card-placement.ts
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugdeck/src/lib/body-cards-store.ts
 * @covers tugdeck/src/body/body-main.ts
 * @covers tugdeck/src/components/tugways/tug-pane.css
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugapp/Sources/HostFrameMeter.swift
 */

import { describe, test } from "bun:test";

import { sessionUnderTest } from "./_kinds";
import { SHOULD_RUN, TEST_TIMEOUT_MS, arrivalCold } from "./_row-01";

describe.skipIf(!SHOULD_RUN)("body-grounding row 1: arrival, cold", () => {
  test.skipIf(!sessionUnderTest(1))(
    "⌘N: a card arrives cold with nothing of the canvas, grid or window showing at any frame",
    () => arrivalCold(),
    TEST_TIMEOUT_MS,
  );
});
