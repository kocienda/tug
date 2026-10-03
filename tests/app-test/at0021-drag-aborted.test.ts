/**
 * at0021-drag-aborted.test.ts — Drag aborted via Escape preserves
 * focus inside the source card (harness
 * extension).
 *
 * Scenario:
 *
 *   Seed one pane: P1=[A, B] active=A. Click into A's input and
 *   type "alpha". Begin a drag of A's tab past the 5px threshold
 *   without releasing — `nativeDragElementWithoutRelease` posts
 *   `mouseDown` + the interpolated trail but no `mouseUp`. With
 *   the pointer held, fire `nativeKey("Escape")`. The drag
 *   coordinator's window-capture keydown listener (installed in
 *   `cardDragCoordinator.startDrag`; on `window` because the responder
 *   chain's document-capture act-dispatch stage stops an Escape before a
 *   document listener added mid-drag hears it) matches Escape, runs
 *   `cleanup()` without committing any DeckManager action, then
 *   routes through `transferFocusAfterMove` to refocus into A's
 *   pre-drag DOM location. Finally release the pointer with
 *   `nativeMouseUp` — by then the gesture is already over from
 *   the coordinator's perspective.
 *
 *   Verify: A stays in P1, A's input value is still "alpha",
 *   focus is restored inside A's content.
 *
 * Probes
 * ------
 * Cards use `componentId: "gallery-input"`. The mouseUp coordinate
 * matches the trail's destination so the event lands in the same
 * region the pointer was held over.
 *
 * Gating
 * ------
 * `describe.skipIf(!SHOULD_RUN)`. CI and `bun x tsc --noEmit` runs
 * without `TUGAPP_APP_TEST=1` skip every test.
 *
 * @covers tugdeck/src/card-drag-coordinator.ts
 * @covers tugdeck/src/components/tugways/tug-tab-bar.tsx
 * @covers tugdeck/src/focus-transfer.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp } from "./_harness";
import { keyboardIsInCard } from "./_harness/selectors";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const INPUT_PERSIST_KEY = "gallery-input/size/sm";

function inputSelectorFor(cardId: string): string {
  return `[data-card-id="${cardId}"] [data-tug-state-key="${INPUT_PERSIST_KEY}"]`;
}

function tabSelectorFor(cardId: string): string {
  return `[data-testid="tug-tab-${cardId}"]`;
}

describe.skipIf(!SHOULD_RUN)("m21: drag aborted by Escape preserves focus", () => {
  test("Escape mid-drag rolls back commit and restores focus inside source card", async () => {
    const app = await launchTugApp({ testName: "at0021-drag-aborted" });
    try {
      await app.enableDeckTrace(true);

      // -----------------------------------------------------------------
      // Seed: P1=[A, B] active=A. P1 must contain at least two
      // cards so the drag is allowed ([D06] last-card guard).
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
      // Mid-drag Escape sequence.
      //
      // Drop coordinate is well outside P1 (700, 500) — if the
      // gesture committed, it would resolve to detach mode. The
      // Escape between the trail and the mouseUp prevents the
      // commit from running.
      // -----------------------------------------------------------------
      const dropPoint = { x: 700, y: 500 };
      await app.nativeDragElementWithoutRelease(tabSelectorFor("A"), dropPoint);
      await app.nativeKey("Escape");
      await app.nativeMouseUp(dropPoint);

      // -----------------------------------------------------------------
      // Assertions: A stays in P1, value preserved, focus inside A.
      // -----------------------------------------------------------------
      // P1 still has both A and B as tabs. The DOM probe walks up
      // from each tab to its nearest .tug-pane[data-pane-id]
      // ancestor and confirms both resolve to p1.
      const aPaneIdAfter = await app.evalJS<string | null>(
        `(document.querySelector(${JSON.stringify(tabSelectorFor("A"))})
            ?.closest('.tug-pane[data-pane-id]')
            ?.getAttribute('data-pane-id')) ?? null`,
      );
      expect(aPaneIdAfter).toBe("p1");

      const bPaneIdAfter = await app.evalJS<string | null>(
        `(document.querySelector(${JSON.stringify(tabSelectorFor("B"))})
            ?.closest('.tug-pane[data-pane-id]')
            ?.getAttribute('data-pane-id')) ?? null`,
      );
      expect(bPaneIdAfter).toBe("p1");

      // P1 is still the only pane (no detach happened).
      const paneCount = await app.evalJS<number>(
        `document.querySelectorAll('.tug-pane[data-pane-id]').length`,
      );
      expect(paneCount).toBe(1);

      // A is still the active card of the active pane.
      expect(await app.getActiveCardId()).toBe("A");

      // Form-control value survived the cancelled drag (no commit
      // ran, so the input is untouched).
      expect(await app.getFormControlValue("A", INPUT_PERSIST_KEY)).toBe("alpha");

      // Keyboard restored to A via the cancel hook in
      // cardDragCoordinator#onDocumentKeydown → transferFocusAfterMove. The
      // engine may satisfy that by marking A's key view with the sink parked
      // outside the card, or by granting a text surface inside it real DOM
      // focus; `keyboardIsInCard` accepts either.
      expect(await app.evalJS<boolean>(keyboardIsInCard("A"))).toBe(true);
    } catch (err) {
      const tail = app.tailLog(200);
      if (tail !== "") {
        process.stderr.write(
          `\n[at0021-drag-aborted] Tug.app log tail (last 200 lines):\n${tail}\n`,
        );
      }
      const tracePath = await app.dumpTraceToFile(
        "logs/at0021-drag-aborted-trace.json",
      );
      if (tracePath !== null) {
        process.stderr.write(`[at0021-drag-aborted] trace dumped to ${tracePath}\n`);
      }
      throw err;
    } finally {
      await app.close();
    }
  });
});
