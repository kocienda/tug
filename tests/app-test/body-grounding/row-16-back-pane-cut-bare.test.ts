/**
 * row-16-back-pane-cut-bare.test.ts — a back card paints nothing inside a
 * body the host is carrying across it, on the bare band.
 *
 * A piece of row 16 ([B02] row 16; the row is `_row-16.ts`'s): a body card
 * assigned past the Text card behind it, judged on every composite frame in
 * motion.
 *
 * @foreground
 * @family row-16-back-pane-cut
 * @covers tugdeck/src/lib/body-beat-plan.ts
 * @covers tugdeck/src/lib/body-placement.ts
 */

import { describe, test } from "bun:test";

import { SHOULD_RUN, TEST_TIMEOUT_MS, carryAcross } from "./_row-16";

describe.skipIf(!SHOULD_RUN)("body-grounding row 16: the back pane's cut moves with the carried body", () => {
  test(
    "a body carried across the Text card behind it shows no ink of the Text card on any frame in motion",
    () => carryAcross({ foreground: true }, false),
    TEST_TIMEOUT_MS,
  );
});
