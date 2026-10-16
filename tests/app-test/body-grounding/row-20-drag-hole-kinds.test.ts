/**
 * row-20-drag-hole-kinds.test.ts — the Text card another kind's rail crossed
 * is whole at rest.
 *
 * A piece of row 20 ([B02] row 20; the row is `_row-20.ts`'s): a pinned rail
 * dragged by its bar over the Text card beside it, dropped there or
 * cancelled over it.
 *
 * @foreground
 * @family row-20-drag-hole
 * @covers tugdeck/src/lib/body-placement.ts
 */

import { describe, test } from "bun:test";

import { kindsUnderTest } from "./_kinds";
import { SHOULD_RUN, TEST_TIMEOUT_MS, dragKind } from "./_row-20";

describe.skipIf(!SHOULD_RUN)("body-grounding row 20: a rail's drag leaves no hole", () => {
  for (const kind of kindsUnderTest(20)) {
    if (kind.componentId === "session" || !kind.rail) continue;
    for (const end of ["drop", "cancel"] as const) {
      test(
        `${kind.componentId}: the Text card its rail crossed is whole at rest (${end})`,
        () => dragKind({ foreground: true }, kind, end),
        TEST_TIMEOUT_MS,
      );
    }
  }
});
