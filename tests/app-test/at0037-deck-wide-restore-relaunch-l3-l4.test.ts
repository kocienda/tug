/**
 * at0037-deck-wide-restore-relaunch-l3-l4.test.ts — multi-card restore
 * preserves the active/inactive selection invariants ([AT0037]).
 *
 * Renamed from `m26-*`; the
 * original `m26` prefix collided with the AT0026 overlay-policy tag
 * (gated by `at0026-overlay-persistence.test.ts`). AT0037 was assigned in
 * the canonical inventory at `tuglaws/at-series-inventory.md`.
 *
 * ## What this gates
 *
 * The engine paint API split into active vs. inactive paths and
 * CardHost's `onRestore` routes by `isActive`. This test
 * verifies the result on multi-card decks:
 *
 *   1. Exactly one card holds document focus — the deck-level
 *      first responder.
 *   2. Exactly one card's range is in `window.getSelection()` (same
 *      card).
 *   3. Every inactive card's selection lives in
 *      `selectionGuard.cardRanges` and is observable via
 *      `__tug.getCaretState(cardId)`.
 *   4. Every inactive card's range is in the
 *      `inactive-selection` CSS Custom Highlight; the active card's
 *      range is NOT.
 *   5. Every card's bag-on-disk has the four 25C.3 axes
 *      (text/atoms/selection/scrollTop) preserved.
 *
 * Pre-25C.4: tests fail because every card's restore calls
 * `setSelectedRange` (focus + `addRange` + `removeAllRanges`), the
 * last writer wins the global Selection / focus, and the deck-level
 * first responder may not be the last writer.
 * Post-25C.4: deterministic — only the active card runs
 * `paintMirrorAsActive`; every inactive card runs
 * `paintMirrorAsInactive(publish)`.
 *
 * ## Test matrix (4 layouts × 2 triggers = 8 tests)
 *
 *   | Layout | Pane geometry | Active (deck FR) | Inactive |
 *   |--------|---------------|------------------|----------|
 *   | L1 | 1 pane, 2 cards (tabs) | gallery-prompt-entry #A | gallery-prompt-entry #B |
 *   | L2 | 1 pane, 2 cards (tabs) | gallery-prompt-entry | dev |
 *   | L3 | 1 pane, 2 cards (tabs) | dev | gallery-prompt-entry |
 *   | L4 | 2 panes, 1 card each | gallery-prompt-entry (in active pane) | dev (pane-active in non-active pane) |
 *
 * L4 is the load-bearing case for the "active = deck-level first
 * responder, NOT pane-active" precision ("Defining
 * 'active' precisely"). Dev is the active card of P2, but P2 is
 * not the active pane — so dev is NOT the deck-level first
 * responder, and its selection routes through
 * `paintMirrorAsInactive`.
 *
 * Triggers: `app.appReload()` (Layer 1 primitive) and
 * `app.quitGracefully()` + relaunch.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * Cut from `at0037-deck-wide-restore-consistency` to fit the 20 s budget.
 * This file carries L3 and L4 under the relaunch;
 * `at0037-deck-wide-restore-reload` carries the four layouts under
 * `appReload`, and `-relaunch-l1-l2` L1 and L2 under the relaunch. The
 * layouts, the invariants and the drivers are `deck-wide-restore-fixture.ts`.
 *
 * @family at0037-deck-wide-restore
 *
 * @covers tugdeck/src/card-state-cache.ts
 * @covers tugdeck/src/layout-persistence.ts
 * @covers tugdeck/src/serialization.ts
 * @covers tugdeck/src/card-state-orchestrator.ts
 * @covers tugdeck/src/components/tugways/selection-guard.ts
 * @covers tugdeck/src/deck-manager.ts
 */

import { describe, test } from "bun:test";
import {
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  makeLayout,
  runRelaunchScenario,
} from "./deck-wide-restore-fixture";

describe.skipIf(!SHOULD_RUN)(
  "m37: deck-wide restore consistency (active/inactive paint split)",
  () => {
    test(
      "L3 (1 pane: dev active + gallery-prompt-entry inactive) × relaunch",
      () => runRelaunchScenario(makeLayout("L3")),
      TEST_TIMEOUT_MS,
    );
    test(
      "L4 (2 panes: gallery-prompt-entry in active pane, dev pane-active in non-active pane) × relaunch",
      () => runRelaunchScenario(makeLayout("L4")),
      TEST_TIMEOUT_MS,
    );
  },
);
