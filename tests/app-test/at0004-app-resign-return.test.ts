/**
 * at0004-app-resign-return.test.ts — App resign → return-to-active
 * preserves focus + selection on the current first-responder card
 * ([AT0004]).
 *
 * Scenario:
 *
 *   Seed P1=[A] active=A. Click into A's input and type "alpha"
 *   (caret lands at end). Call `simulateAppResign` — the Swift
 *   handler invokes `NSApp.deactivate()` and activates Finder, so
 *   `applicationDidResignActive:` fires and AppKit blurs the
 *   WKWebView. The browser-level `window.blur` event triggers
 *   `installDeckStoreFocusListeners`'s blur handler, which flushes
 *   A's save callback (`source: "window-blur"`) BEFORE flipping
 *   `state.hasFocus = false`. Wait for the trace event to confirm
 *   the save fired.
 *
 *   Then call `simulateAppBecomeActive`. AppKit re-activates the
 *   WKWebView, the JS `window.focus` event fires,
 *   `setHasFocus(true)` runs, and
 *   `reactivateCurrentFocusDestination(store)` resolves A's saved
 *   focus snapshot and re-focuses A's input. Verify
 *   `document.activeElement` is back inside A's input and the value
 *   "alpha" is intact.
 *
 * Probes
 * ------
 * Card uses `componentId: "gallery-input"`.
 *
 * The deck trace is enabled at the start so we can assert the
 * `save-callback` event with `source: "window-blur"` arrived
 * during the resign — that proves the new wiring (not just the
 * pre-existing `visibilitychange` save) drove the flush. Note:
 * `simulateAppResign` does NOT hide the document, so
 * `visibilitychange` is NOT expected to fire — only the
 * window-`blur` path can produce a save.
 *
 * Gating
 * ------
 * `describe.skipIf(!SHOULD_RUN)`. CI and `bun x tsc --noEmit` runs
 * without `TUGAPP_APP_TEST=1` skip every test.
 *
 * @foreground
 * @covers tugapp/Sources/AppDelegate.swift
 * @covers tugdeck/src/lib/app-lifecycle.ts
 * @covers tugdeck/src/focus-transfer.ts
 * @covers tugdeck/src/components/tugways/focus-manager.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp } from "./_harness";
import { inputSelectorFor, INPUT_PERSIST_KEY } from "./_harness/fixtures";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";


describe.skipIf(!SHOULD_RUN)("m04: app resign → return-to-active preserves focus + value", () => {
  test("simulateAppResign + simulateAppBecomeActive restores focus inside first-responder card", async () => {
    const app = await launchTugApp({
    // Foreground: drives a real app resign / hide / become-active cycle,
    // which only happens to an app that is actually active (pid-mode default
    // never activates).
    foreground: true, testName: "at0004-app-resign-return" });
    try {
      await app.enableDeckTrace(true);

      // -----------------------------------------------------------------
      // Seed: P1=[A] active=A. Single card pane is the simplest case
      // for [A4]; cross-pane wiring is covered by m06/m07.
      // -----------------------------------------------------------------
      await app.seedDeckState({
        state: {
          cards: [
            { id: "A", componentId: "gallery-input", title: "Card A", closable: true },
          ],
          panes: [
            {
              id: "p1",
              position: { x: 40, y: 40 },
              size: { width: 400, height: 320 },
              cardIds: ["A"],
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
      // Resign: NSApp.deactivate() + Finder activation. The Swift
      // bridge waits for applicationDidResignActive; AppKit also
      // blurs the WKWebView, which fires window.blur on the JS side.
      // The blur listener saves A's bag with source "window-blur".
      // -----------------------------------------------------------------
      const markBeforeResign = await app.markDeckTrace();
      await app.simulateAppResign();

      // Wait for the window-blur save trace event. The window.blur
      // event arrives slightly after the Swift handler returns
      // (notification fires synchronously during NSApp.deactivate(),
      // but WKWebView's blur dispatch is on the run-loop's next
      // iteration), so we poll rather than read once.
      await app.waitForCondition<boolean>(
        `(function(){
          var t = window.__tug.getDeckTrace({since: ${markBeforeResign}});
          for (var i = 0; i < t.length; i++) {
            if (t[i].kind === "save-callback" && t[i].source === "window-blur" && t[i].cardId === "A") return true;
          }
          return false;
        })()`,
        { timeoutMs: 2000 },
      );

      // -----------------------------------------------------------------
      // Return to active: NSApp.activate() — applicationDidBecomeActive
      // fires, WKWebView refocuses, window.focus runs the
      // reactivateCurrentFocusDestination helper, which restores
      // focus to A's input.
      // -----------------------------------------------------------------
      await app.simulateAppBecomeActive();

      // Activation reaches `.focus()` synchronously in the focus
      // listener, but WebKit may need a moment to settle the active
      // element after window.focus dispatch — poll.
      await app.waitForCondition<boolean>(
        `document.activeElement !== null && document.activeElement.matches(${JSON.stringify(inputSelectorFor("A"))})`,
        { timeoutMs: 2000 },
      );

      // Value preserved across the resign/return cycle.
      expect(await app.getFormControlValue("A", INPUT_PERSIST_KEY)).toBe("alpha");

      // First responder unchanged.
      expect(await app.getActiveCardId()).toBe("A");
    } catch (err) {
      const tail = app.tailLog(200);
      if (tail !== "") {
        process.stderr.write(
          `\n[at0004-app-resign-return] Tug.app log tail (last 200 lines):\n${tail}\n`,
        );
      }
      const tracePath = await app.dumpTraceToFile(
        "logs/at0004-app-resign-return-trace.json",
      );
      if (tracePath !== null) {
        process.stderr.write(`[at0004-app-resign-return] trace dumped to ${tracePath}\n`);
      }
      throw err;
    } finally {
      await app.close();
    }
  });
});
