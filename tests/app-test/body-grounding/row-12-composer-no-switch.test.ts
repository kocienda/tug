/**
 * row-12-composer-no-switch.test.ts — a launch without the switch makes no
 * body: the Session card and the Overview mount in the shell's own document.
 *
 * A piece of row 12 ([B02] row 12, [B01]; the reading is `_row-12.ts`'s).
 *
 * @foreground
 * @family row-12-composer
 * @covers tugdeck/src/body/body-main.ts
 * @covers tugdeck/src/lib/body-shell.ts
 */

import { describe, test } from "bun:test";

import { kindsUnderTest, sessionUnderTest } from "./_kinds";
import { SHOULD_RUN, TEST_TIMEOUT_MS, overviewNoSwitch, sessionNoSwitch } from "./_row-12";

describe.skipIf(!SHOULD_RUN)("body-grounding row 12: no switch, no body", () => {
  test.skipIf(!sessionUnderTest(12))(
    "without the switch the Session card mounts in the shell's document and the host makes no body",
    () => sessionNoSwitch({ foreground: true }),
    TEST_TIMEOUT_MS,
  );

  test.skipIf(!kindsUnderTest(12).some((k) => k.componentId === "overview"))(
    "without the switch the Overview mounts in the shell's document and the host makes no body for it",
    () => overviewNoSwitch({ foreground: true }),
    TEST_TIMEOUT_MS,
  );
});
