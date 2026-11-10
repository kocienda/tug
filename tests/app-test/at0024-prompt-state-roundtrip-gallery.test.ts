/**
 * at0024-prompt-state-roundtrip-gallery.test.ts — the prompt-state round-trip
 * ([AT0024]) for the `gallery-prompt-entry` card, across `appReload` and a
 * quit + relaunch. The matrix, its four axes (text, atoms, selection,
 * scrollTop) and the Phase A → Phase B contract are documented in
 * `prompt-state-roundtrip-fixture.ts`; the Session card's half is
 * `at0024-prompt-state-roundtrip-session.test.ts`. The matrix is split by card
 * so each file's four launches stay under the 20 s file budget.
 *
 * @covers tugdeck/src/engine-hooks.ts
 * @covers tugdeck/src/serialization.ts
 * @covers tugdeck/src/card-state-orchestrator.ts
 * @covers tugdeck/src/components/tugways/tug-prompt-entry.tsx
 * @covers tugdeck/src/components/tugways/tug-text-editor/
 * @covers tugdeck/src/components/tugways/tug-text-editor.tsx
 * @family at0024-prompt-state-roundtrip
 */

import { describe, test } from "bun:test";
import {
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  runAppReloadScenario,
  runRelaunchScenario,
} from "./prompt-state-roundtrip-fixture";

describe.skipIf(!SHOULD_RUN)("m24: prompt-state round-trip across reload + relaunch", () => {
  test(
    "gallery-prompt-entry × appReload",
    () => runAppReloadScenario("gallery-prompt-entry"),
    TEST_TIMEOUT_MS,
  );

  test(
    "gallery-prompt-entry × relaunch",
    () => runRelaunchScenario("gallery-prompt-entry"),
    TEST_TIMEOUT_MS,
  );
});
