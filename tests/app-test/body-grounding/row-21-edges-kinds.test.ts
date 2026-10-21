/**
 * row-21-edges-kinds.test.ts — every other kind's side edges are one border,
 * no sliver beside it.
 *
 * A piece of row 21 ([B02] row 21; the row is `_row-21.ts`'s): a card of
 * each other kind beside an in-document Text card, its edges read at three
 * zooms with each card key in turn.
 *
 * @foreground activation
 * @family row-21-edges
 * @covers tugdeck/src/lib/card-plan.ts
 * @covers tugdeck/src/body/body-page.css
 * @covers tugdeck/src/body/body-main.ts
 * @covers tugapp/Sources/BodyViewController.swift
 */

import { describe, test } from "bun:test";

import { kindsUnderTest } from "./_kinds";
import { SHOULD_RUN, TEST_TIMEOUT_MS, edgesOfKind } from "./_row-21";

describe.skipIf(!SHOULD_RUN)("body-grounding row 21: every other kind's edges are the pane's border", () => {
  for (const kind of kindsUnderTest(21)) {
    if (kind.componentId === "session") continue;
    test(
      `${kind.componentId}: its side edges are one border, no sliver beside it, at three zooms, key and not key`,
      () => edgesOfKind({ foreground: true }, kind),
      TEST_TIMEOUT_MS,
    );
  }
});
