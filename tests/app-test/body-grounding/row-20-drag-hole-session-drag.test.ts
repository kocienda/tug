/**
 * row-20-drag-hole-session-drag.test.ts — the Text card the Session card was
 * dragged across is whole at rest.
 *
 * A piece of row 20 ([B02] row 20; the row is `_row-20.ts`'s): the body card
 * dragged by its handle across the Text card beside it and dropped in the
 * empty slot past it, and the same drag cancelled with Escape over it.
 *
 * @foreground
 * @family row-20-drag-hole
 * @covers tugdeck/src/lib/body-placement.ts
 */

import { describe, test } from "bun:test";

import { sessionUnderTest } from "./_kinds";
import { SHOULD_RUN, TEST_TIMEOUT_MS, dragSession } from "./_row-20";

describe.skipIf(!SHOULD_RUN)("body-grounding row 20: a drag leaves no hole", () => {
  for (const end of ["drop", "cancel"] as const) {
    test.skipIf(!sessionUnderTest(20))(
      `the Text card a body crossed is whole at rest (${end})`,
      () => dragSession({ foreground: true }, end),
      TEST_TIMEOUT_MS,
    );
  }
});
