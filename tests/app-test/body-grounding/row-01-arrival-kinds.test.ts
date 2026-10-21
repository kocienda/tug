/**
 * row-01-arrival-kinds.test.ts — every other kind, opened the way it opens,
 * arrives with nothing of the canvas, grid or window showing at any frame.
 *
 * A piece of row 1 ([B02] row 1; the arrival and its reading are
 * `_row-01.ts`'s): a rail shown on its edge, a content card added as a
 * tab, each handed off the moment the deck holds it.
 *
 * @foreground activation
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

import { kindsUnderTest } from "./_kinds";
import { SHOULD_RUN, TEST_TIMEOUT_MS, arrivalOfKind } from "./_row-01";

describe.skipIf(!SHOULD_RUN)("body-grounding row 1: arrival, every other kind", () => {
  for (const kind of kindsUnderTest(1)) {
    if (kind.componentId === "session") continue;
    test(
      `${kind.componentId}: a card opened the user's way arrives with nothing of the canvas, grid or window showing at any frame`,
      () => arrivalOfKind({ foreground: true }, kind),
      TEST_TIMEOUT_MS,
    );
  }
});
