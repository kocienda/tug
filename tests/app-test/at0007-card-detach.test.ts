/**
 * at0007-card-detach.test.ts — Card detach via tab drag to canvas
 * void, focus + form-control state preserved ([AT0007]).
 *
 * Scenario:
 *
 *   Seed one pane: P1=[A, B] active=A. Click into A's input and
 *   type "alpha". Drag A's tab to an empty area of the canvas (no
 *   tab bar, no other pane underneath). The coordinator's
 *   `updateDragMode` falls through to "detach" for any pointer
 *   release outside known drop targets, and pointerup commits via
 *   `store.detachCard(p1, A, dropPosition)`. A new pane spawns at
 *   the drop position, containing only A.
 *
 *   Verify: A is in a new pane, A is the active card of that new
 *   pane, the new pane is the active pane, A's input value is
 *   still "alpha", and focus is inside A's content.
 *
 * The drag-start save (`captureFocusForDragStart` from
 * `tug-tab-bar#handleTabPointerDown` via
 * `cardDragCoordinator.notifyPotentialDragStart`) preserves the
 * focused element's `bag.focus` before WebKit's mousedown default
 * blurs the input. The drop-time path
 * (`_detachCard → transferFocusAfterMove`) restores focus into the
 * detached card's new DOM location.
 *
 * Probes
 * ------
 * Cards use `componentId: "gallery-input"`. The drop coordinate is
 * a viewport point in clearly-empty canvas space — neither over a
 * `.tug-tab-bar[data-pane-id]` nor a `.tug-pane[data-pane-id]`
 * frame, so the coordinator's hit-test resolves to detach mode.
 *
 * Gating
 * ------
 * `describe.skipIf(!SHOULD_RUN)`. CI and `bun x tsc --noEmit` runs
 * without `TUGAPP_APP_TEST=1` skip every test.
 *
 * @covers tugdeck/src/card-drag-coordinator.ts
 * @covers tugdeck/src/layout-tree.ts
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

describe.skipIf(!SHOULD_RUN)("m07: card detach preserves focus + value", () => {
  test("drag A from P1 to canvas void; A lands in a new pane with value preserved", async () => {
    const app = await launchTugApp({ testName: "at0007-card-detach" });
    try {
      await app.enableDeckTrace(true);

      // -----------------------------------------------------------------
      // Seed: one pane P1=[A, B] active=A. P1 must contain at least
      // two cards because `_detachCard` rejects detaching the last
      // card in a pane ([D06]).
      //
      // P1 is positioned in the upper-left quadrant so the drop
      // coordinate (clearly-empty lower-right area) does not
      // overlap P1's tab bar or pane frame.
      // -----------------------------------------------------------------
      await app.seedDeckState({
        state: {
          cards: [
            { id: "A", componentId: "gallery-input", title: "Card A", closable: true },
            { id: "B", componentId: "gallery-input", title: "Card B", closable: true },
          ],
          panes: [
            {
              id: "p1",
              position: { x: 40, y: 40 },
              size: { width: 400, height: 320 },
              cardIds: ["A", "B"],
              activeCardId: "A",
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

      await app.nativeClickAtElement(inputSelectorFor("A"));
      await app.waitForCondition<boolean>(
        `document.activeElement !== null && document.activeElement.matches(${JSON.stringify(inputSelectorFor("A"))})`,
      );
      await app.type(inputSelectorFor("A"), "alpha");
      expect(await app.getFormControlValue("A", INPUT_PERSIST_KEY)).toBe("alpha");

      // -----------------------------------------------------------------
      // Drag A's tab to a viewport point well outside P1's frame
      // (which is at x=40..440, y=40..360). The drop point at
      // (700, 500) lands in clearly-empty canvas space.
      // -----------------------------------------------------------------
      await app.nativeDragElement(tabSelectorFor("A"), { x: 700, y: 500 });

      // -----------------------------------------------------------------
      // Assertions: A is in a new pane, focus is inside A.
      // -----------------------------------------------------------------
      await app.waitForCondition<boolean>(
        `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
      );
      await app.expectFocusedCard("A");
      expect(await app.getActiveCardId()).toBe("A");

      // Two panes total after the detach (original p1 with just B,
      // plus a fresh pane carrying A). Single-card panes don't render
      // a tab bar, so card-membership probes go via the data-card-
      // host[data-card-id] markers rather than tab elements.
      const paneCount = await app.evalJS<number>(
        `document.querySelectorAll('.tug-pane[data-pane-id]').length`,
      );
      expect(paneCount).toBe(2);

      // A's CardHost remounted in the new pane (its host-root
      // registration was confirmed by the waitForCondition above).
      // B's CardHost stayed mounted in p1.
      const aMounted = await app.evalJS<boolean>(
        `document.querySelector('[data-card-host][data-card-id="A"]') !== null`,
      );
      const bMounted = await app.evalJS<boolean>(
        `document.querySelector('[data-card-host][data-card-id="B"]') !== null`,
      );
      expect(aMounted).toBe(true);
      expect(bMounted).toBe(true);

      // Form-control value survived the detach (DOM identity
      // preserved across React's portal reconciliation).
      expect(await app.getFormControlValue("A", INPUT_PERSIST_KEY)).toBe("alpha");

      // The keyboard is in A — the helper's transfer step (or the
      // default-focus fallback) lands on a sensible target inside the
      // moved card. Either engine shape counts: a marked key view with
      // the sink parked outside, or a dom-granted surface inside.
      expect(await app.evalJS<boolean>(keyboardIsInCard("A"))).toBe(true);
    } catch (err) {
      const tail = app.tailLog(200);
      if (tail !== "") {
        process.stderr.write(
          `\n[at0007-card-detach] Tug.app log tail (last 200 lines):\n${tail}\n`,
        );
      }
      const tracePath = await app.dumpTraceToFile(
        "logs/at0007-card-detach-trace.json",
      );
      if (tracePath !== null) {
        process.stderr.write(`[at0007-card-detach] trace dumped to ${tracePath}\n`);
      }
      throw err;
    } finally {
      await app.close();
    }
  });
});
