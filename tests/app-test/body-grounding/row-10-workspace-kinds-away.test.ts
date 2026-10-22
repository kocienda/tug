/**
 * row-10-workspace-kinds-away.test.ts — the switch back to the away
 * workspace hides every other kind's home body and shows its away one on its
 * own placeholder.
 *
 * A piece of row 10 ([B02] row 10; the switch and its reading are
 * `_row-10.ts`'s): a card of the kind at home and one in the second
 * workspace; the switch home is made as the set-up, and the switch back is
 * read.
 *
 * @family row-10-workspace
 * @covers tugdeck/src/lib/card-placement.ts
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugapp/Sources/BodyViewController.swift
 */

import { describe, test } from "bun:test";

import { kindsUnderTest } from "./_kinds";
import { SHOULD_RUN, TEST_TIMEOUT_MS, switchKind } from "./_row-10";

describe.skipIf(!SHOULD_RUN)("body-grounding row 10: workspace switch back, every other kind", () => {
  for (const kind of kindsUnderTest(10)) {
    if (kind.componentId === "session") continue;
    test(
      `${kind.componentId}: home → away: its departing body hides and its arriving body shows on its own placeholder, with no frame of a body in the wrong place`,
      () => switchKind(kind, "away"),
      TEST_TIMEOUT_MS,
    );
  }
});
