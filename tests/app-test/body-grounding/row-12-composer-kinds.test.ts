/**
 * row-12-composer-kinds.test.ts — the Overview's composer, in its body,
 * takes typing, a text paste and an image paste as an attachment.
 *
 * A piece of row 12 ([B02] row 12; the reading is `_row-12.ts`'s): every
 * other kind with a field of its own is read the same way, and the Overview
 * is the one under test.
 *
 * @foreground
 * @family row-12-composer
 * @covers tugdeck/src/body/body-main.ts
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugdeck/src/components/tugways/tug-text-editor/clipboard-filters.ts
 */

import { describe, test } from "bun:test";

import { kindsUnderTest } from "./_kinds";
import { SHOULD_RUN, TEST_TIMEOUT_MS, overviewComposer } from "./_row-12";

describe.skipIf(!SHOULD_RUN)("body-grounding row 12: the Overview's composer", () => {
  test.skipIf(!kindsUnderTest(12).some((k) => k.componentId === "overview"))(
    "overview: its composer takes typing, a text paste and an image paste in its body",
    () => overviewComposer({ foreground: true }),
    TEST_TIMEOUT_MS,
  );
});
