/**
 * row-21-edges-session.test.ts — the Session card's side edges read as the
 * Text card's.
 *
 * A piece of row 21 ([B02] row 21; the row is `_row-21.ts`'s): a body
 * session card beside an in-document Text card, its edges read at three
 * zooms with each card key in turn.
 *
 * @foreground
 * @family row-21-edges
 * @covers tugdeck/src/lib/body-beat-plan.ts
 * @covers tugdeck/src/body/body-page.css
 * @covers tugdeck/src/body/body-main.ts
 * @covers tugapp/Sources/BodyViewController.swift
 */

import { describe, test } from "bun:test";

import { sessionUnderTest } from "./_kinds";
import { SHOULD_RUN, TEST_TIMEOUT_MS, edgesOfSession } from "./_row-21";

describe.skipIf(!SHOULD_RUN)("body-grounding row 21: the Session card's edges are the pane's border", () => {
  test.skipIf(!sessionUnderTest(21))(
    "the body card's side edges read as the Text card's at three zooms, key and not key",
    () => edgesOfSession({ foreground: true }),
    TEST_TIMEOUT_MS,
  );
});
