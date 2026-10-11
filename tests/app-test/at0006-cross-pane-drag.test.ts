/**
 * at0006-cross-pane-drag.test.ts — Cross-pane card move via tab drag,
 * focus + form-control state preserved ([AT0006]).
 *
 * Scenario:
 *
 *   Seed two panes: P1=[A, B] active=A, P2=[C, D] active=C. Click
 *   into A's input and type "alpha". Drag A's tab into P2's tab bar
 *   so the coordinator's hit-test classifies the drop as "merge";
 *   the drop commits via `store.moveCardToPane(P1, A, P2, …)`.
 *   Verify that A is now mounted under P2, P2 is the deck's active
 *   pane, A is the active card / first responder, A's input value
 *   is still "alpha", and focus has landed inside A's content.
 *
 * `_moveCardToPane` always activates the target pane on a cross-
 * pane move. The user's intent in
 * dragging a card to another pane is to follow the card —
 * attention moves with the gesture. The drag-start save
 * (`captureFocusForDragStart` via
 * `cardDragCoordinator.notifyPotentialDragStart`) preserves
 * `bag.focus` before WebKit's mousedown default blurs the input;
 * the drop-time path (`_moveCardToPane → transferFocusAfterMove`)
 * resolves the saved snapshot (or falls through to default-focus
 * when the pre-commit `invokeSaveCallback("manual")` clobbered the
 * snapshot to "none") and lands the caret inside A's new DOM
 * location.
 *
 * Probes
 * ------
 * Cards use `componentId: "gallery-input"` (same fixture as
 * m01/m03/m16). Tabs are click-targetable via
 * `[data-testid="tug-tab-${cardId}"]`; tab bars carry
 * `[data-pane-id]` so a drop-coordinate selector that points at
 * P2's tab bar resolves to the merge target.
 *
 * Gating
 * ------
 * `describe.skipIf(!SHOULD_RUN)`. CI and `bun x tsc --noEmit` runs
 * without `TUGAPP_APP_TEST=1` skip every test.
 *
 * @covers tugdeck/src/card-drag-coordinator.ts
 * @covers tugdeck/src/components/tugways/tug-tab-bar.tsx
 * @covers tugdeck/src/focus-transfer.ts
 * @covers tugdeck/src/deck-manager.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp } from "./_harness";
import { inputSelectorFor, INPUT_PERSIST_KEY } from "./_harness/fixtures";
import { keyboardIsInCard } from "./_harness/selectors";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";


function tabSelectorFor(cardId: string): string {
  return `[data-testid="tug-tab-${cardId}"]`;
}

/**
 * Selector for a pane's multi-tab bar. The bar carries
 * `[data-pane-id]` and the `.tug-tab-bar` class — both are read by
 * `cardDragCoordinator.buildHitTestCache`'s tier-1 hit-test query.
 */
function tabBarSelectorFor(paneId: string): string {
  return `.tug-tab-bar[data-pane-id="${paneId}"]`;
}

describe.skipIf(!SHOULD_RUN)("m06: cross-pane drag preserves focus + value", () => {
  test("drag A from P1 into P2's tab bar; A becomes active in P2 with focus + value preserved", async () => {
    const app = await launchTugApp({ testName: "at0006-cross-pane-drag" });
    try {
      await app.enableDeckTrace(true);

      // -----------------------------------------------------------------
      // Seed: P1=[A, B] active=A; P2=[C, D] active=C. Both panes
      // multi-tab so the hit-test resolves P2's bar in tier 1.
      // (A single-card P2 would resolve via tier 2 — pane frame
      // accessory — and exercise the same `moveCardToPane` path,
      // but the multi-tab variant is the more frequent user flow.)
      // -----------------------------------------------------------------
      await app.seedDeckState({
        state: {
          cards: [
            { id: "A", componentId: "gallery-input", title: "Card A", closable: true },
            { id: "B", componentId: "gallery-input", title: "Card B", closable: true },
            { id: "C", componentId: "gallery-input", title: "Card C", closable: true },
            { id: "D", componentId: "gallery-input", title: "Card D", closable: true },
          ],
          panes: [
            {
              id: "p1",
              position: { x: 40, y: 40 },
              size: { width: 480, height: 360 },
              cardIds: ["A", "B"],
              activeCardId: "A",
              title: "",
              acceptsFamilies: ["maker"],
            },
            {
              id: "p2",
              position: { x: 600, y: 40 },
              size: { width: 480, height: 360 },
              cardIds: ["C", "D"],
              activeCardId: "C",
              title: "",
              acceptsFamilies: ["maker"],
            },
          ],
          activePaneId: "p1",
          hasFocus: true,
        },
        focusCardId: "A",
      });

      await app.waitForCondition<boolean>(
        `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
      );

      // -----------------------------------------------------------------
      // Type "alpha" into A's input so we have a saved-bag fixture
      // to verify form-control survival across the move.
      // -----------------------------------------------------------------
      await app.nativeClickAtElement(inputSelectorFor("A"));
      await app.waitForCondition<boolean>(
        `document.activeElement !== null && document.activeElement.matches(${JSON.stringify(inputSelectorFor("A"))})`,
      );
      await app.type(inputSelectorFor("A"), "alpha");
      expect(await app.getFormControlValue("A", INPUT_PERSIST_KEY)).toBe("alpha");

      // -----------------------------------------------------------------
      // Drag A's tab into P2's tab bar. The coordinator's
      // updateDragMode classifies the drop as "merge" once the
      // pointer is inside P2's bar rect; pointerup commits via
      // `store.moveCardToPane(p1, A, p2, insertIndex)`.
      // -----------------------------------------------------------------
      await app.nativeDragElement(tabSelectorFor("A"), {
        selector: tabBarSelectorFor("p2"),
      });

      // -----------------------------------------------------------------
      // Assertions: A followed the gesture into P2 with focus + value
      // preserved.
      // -----------------------------------------------------------------
      await app.waitForCondition<boolean>(
        `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
      );

      // The moved card is the new first responder (cross-pane move
      // activates the target pane and makes the dragged card FR).
      await app.expectFocusedCard("A");
      expect(await app.getActiveCardId()).toBe("A");

      // A's tab now lives under P2's tab bar. Probe by walking up
      // from A's tab element to its nearest .tug-pane[data-pane-id]
      // ancestor and reading the pane id.
      const aPaneIdAfter = await app.evalJS<string | null>(
        `(document.querySelector(${JSON.stringify(tabSelectorFor("A"))})
            ?.closest('.tug-pane[data-pane-id]')
            ?.getAttribute('data-pane-id')) ?? null`,
      );
      expect(aPaneIdAfter).toBe("p2");

      // Form-control value survived the React portal reconciliation
      // (DOM identity preserved across the move).
      expect(await app.getFormControlValue("A", INPUT_PERSIST_KEY)).toBe("alpha");

      // The keyboard is in A — the helper's transfer step (or the
      // default-focus fallback) landed on a sensible target inside the
      // moved card. Either engine shape counts: a marked key view with
      // the sink parked outside, or a dom-granted surface inside.
      expect(await app.evalJS<boolean>(keyboardIsInCard("A"))).toBe(true);
    } catch (err) {
      const tail = app.tailLog(200);
      if (tail !== "") {
        process.stderr.write(
          `\n[at0006-cross-pane-drag] Tug.app log tail (last 200 lines):\n${tail}\n`,
        );
      }
      const tracePath = await app.dumpTraceToFile(
        "logs/at0006-cross-pane-drag-trace.json",
      );
      if (tracePath !== null) {
        process.stderr.write(`[at0006-cross-pane-drag] trace dumped to ${tracePath}\n`);
      }
      throw err;
    } finally {
      await app.close();
    }
  });
});
