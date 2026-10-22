/**
 * row-19-streams-flow-back.test.ts — three streaming bodies keep applying
 * batches through a flow slide back.
 *
 * A piece of row 19 ([B02] row 19; the row is `_row-19.ts`'s): the band is
 * slid to slot 2 as the set-up, then three body cards stream while it slides
 * back to slot 1.
 *
 * @family row-19-streams
 * @covers tugdeck/src/body/body-main.ts
 * @covers tugdeck/src/connection.ts
 */

import { describe, test } from "bun:test";

import { SHOULD_RUN, TEST_TIMEOUT_MS, streamFlow } from "./_row-19";

describe.skipIf(!SHOULD_RUN)("body-grounding row 19: the flow slide back", () => {
  test(
    "three streaming bodies keep applying batches through a flow slide back",
    () => streamFlow("back"),
    TEST_TIMEOUT_MS,
  );
});
