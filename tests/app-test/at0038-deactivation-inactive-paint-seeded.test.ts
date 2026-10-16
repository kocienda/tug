/**
 * at0038-deactivation-inactive-paint-seeded.test.ts — deactivation publishes
 * the user's selection to selectionGuard at the same DOM positions
 * the user actually selected ([AT0038] regression gate).
 *
 * Renamed from `m27-*` during the AT-series audit; the
 * original `m27` prefix collided with the AT0027 layout-state tag
 * (gated by `at0027-layout-state-persistence.test.ts`). AT0038 was
 * assigned in the canonical inventory at `tuglaws/at-series-inventory.md`.
 *
 * ## What this gates
 *
 * Manual repro: user types enough content into dev /
 * gallery-prompt-entry to make it scroll,
 * makes a selection, clicks any other card to deactivate. The
 * inactive-paint highlight ends up at the wrong text content — at
 * the absolute position in the component equal to the
 * relative/visible position when scrolled, instead of at the user's
 * actual selection.
 *
 * `paintMirrorAsInactive(publish)` rebuilds a DOM
 * Range from `mirror.selection` flat offsets via `flatToDom`. If
 * either the mirror's offsets are stale or the rebuilt Range's
 * DOM positions differ from the user's original Range, the
 * inactive highlight paints at the wrong place.
 *
 * This test verifies: at the moment of deactivation, the Range
 * landed in `selectionGuard.cardRanges` for the deactivated card has
 * the SAME DOM start/end (anchor/focus paths) as the user's
 * pre-deactivation selection in `window.getSelection()`.
 *
 * ## Test scenarios
 *
 * Two scenarios per target card:
 *   - SEED — bag.content is pre-seeded with text + selection +
 *     scrollTop; the engine restores it on mount; we deactivate.
 *   - TYPE — content is typed via `nativeType`; selection is set
 *     programmatically via the live DOM after user-driven typing
 *     populates the editor.
 *
 * Three cards × two scenarios = six tests. Each clicks a sibling
 * tab to deactivate, then asserts the cardRanges Range matches the
 * pre-deactivation live Range.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * Foreground: the selection this publishes lives in a CM6 editor, and CM6
 * tracks its selection from `view.hasFocus` — real DOM focus. A background
 * window’s document never has focus, so there is no live selection for
 * deactivation to hand to the inactive-selection highlight.
 *
 * Cut from `at0038-deactivation-inactive-paint` to fit the 20 s budget. This
 * file carries the seeded and the live-selection scenarios;
 * `at0038-deactivation-inactive-paint-typed` carries type-and-scroll. The
 * deck, the content and the scenarios are `deactivation-paint-fixture.ts`.
 *
 * @family at0038-deactivation-inactive-paint
 *
 * @foreground
 *
 * @covers tugdeck/src/engine-hooks.ts
 * @covers tugdeck/src/components/tugways/selection-guard.ts
 * @covers tugdeck/src/card-state-orchestrator.ts
 * @covers tugdeck/src/focus-transfer.ts
 */

import { describe, test } from "bun:test";
import { launchTugApp } from "./_harness";
import {
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  runDeactivationScenario,
  runLiveSelectionScenario,
} from "./deactivation-paint-fixture";

describe.skipIf(!SHOULD_RUN)(
  "m38: deactivation publishes inactive paint at the user's exact DOM position",
  () => {
    test(
      "gallery-prompt-entry — seeded selection survives deactivation at correct DOM position",
      async () => {
        const app = await launchTugApp({
          testName: "at0027-gallery-prompt-entry",
          foreground: true,
        });
        try {
          await runDeactivationScenario(app, "gallery-prompt-entry");
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "gallery-prompt-entry — LIVE selection (set via DOM) survives deactivation",
      async () => {
        const app = await launchTugApp({
          testName: "at0027-live-gallery-prompt-entry",
          foreground: true,
        });
        try {
          await runLiveSelectionScenario(app, "gallery-prompt-entry");
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
