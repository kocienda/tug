/**
 * row-20-drag-hole-session-crossing.test.ts — the Text card a settle carried
 * the Session card across is whole at rest.
 *
 * A piece of row 20 ([B02] row 20; the row is `_row-20.ts`'s): the body card
 * assigned to the empty slot past the Text card, which a settle carries
 * across it on the host.
 *
 * @foreground
 * @family row-20-drag-hole
 * @covers tugdeck/src/lib/body-placement.ts
 */

import { describe, test } from "bun:test";

import { sessionUnderTest } from "./_kinds";
import { SHOULD_RUN, TEST_TIMEOUT_MS, dragSession } from "./_row-20";

describe.skipIf(!SHOULD_RUN)("body-grounding row 20: a crossing leaves no hole", () => {
  test.skipIf(!sessionUnderTest(20))(
    "the Text card a body crossed is whole at rest (crossing)",
    () => dragSession({ foreground: true }, "crossing"),
    TEST_TIMEOUT_MS,
  );
});
