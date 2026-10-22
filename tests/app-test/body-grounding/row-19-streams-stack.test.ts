/**
 * row-19-streams-stack.test.ts — two streaming bodies keep applying batches
 * through a cross-column stack move.
 *
 * A piece of row 19 ([B02] row 19; the row is `_row-19.ts`'s): two body
 * cards, one per column of a two-up, stream while one crosses into the
 * other's stacked column.
 *
 * @family row-19-streams
 * @covers tugdeck/src/body/body-main.ts
 * @covers tugdeck/src/connection.ts
 */

import { describe, test } from "bun:test";

import { SHOULD_RUN, TEST_TIMEOUT_MS, streamStack } from "./_row-19";

describe.skipIf(!SHOULD_RUN)("body-grounding row 19: a stack move", () => {
  test(
    "two streaming bodies keep applying batches through a cross-column stack move",
    () => streamStack(),
    TEST_TIMEOUT_MS,
  );
});
