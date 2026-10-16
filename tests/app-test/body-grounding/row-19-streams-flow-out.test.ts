/**
 * row-19-streams-flow-out.test.ts — three streaming bodies keep applying
 * batches through a flow slide out.
 *
 * A piece of row 19 ([B02] row 19; the row is `_row-19.ts`'s): three body
 * cards stream while the flow band slides to slot 2.
 *
 * @foreground
 * @family row-19-streams
 * @covers tugdeck/src/body/body-main.ts
 * @covers tugdeck/src/connection.ts
 */

import { describe, test } from "bun:test";

import { SHOULD_RUN, TEST_TIMEOUT_MS, streamFlow } from "./_row-19";

describe.skipIf(!SHOULD_RUN)("body-grounding row 19: the flow slide out", () => {
  test(
    "three streaming bodies keep applying batches through a flow slide out",
    () => streamFlow({ foreground: true }, "out"),
    TEST_TIMEOUT_MS,
  );
});
