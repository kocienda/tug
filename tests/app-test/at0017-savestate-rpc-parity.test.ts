/**
 * at0017-savestate-rpc-parity.test.ts — `window.tugdeck.saveState()`
 * captures the same axes as the will-phase / window-blur save
 * paths.
 *
 * ## Why this exists
 *
 * `AppDelegate.applicationShouldTerminate` calls
 * `window.tugdeck.saveState()` — the only reliable save-on-quit
 * path under WKWebView, which doesn't fire `visibilitychange` or
 * `beforeunload` on quit. If `saveState()` captures a narrower
 * axis set than the will-phase listeners, the on-quit snapshot
 * would silently drop state vs the cmd-tab-away snapshot.
 *
 * The test drives both paths against the same steady-state input
 * and asserts byte-equal bag content. Production wires
 * `saveState` → `deck.saveAndFlushSync()` (which iterates every
 * card through `invokeSaveCallback("manual")`) and the will-phase
 * `window-blur` listener → `invokeSaveCallback("window-blur")`
 * for the FR card; both call the card's same `onSave` closure, so
 * the bags should match modulo source tag.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @foreground
 * @covers tugdeck/src/serialization.ts
 * @covers tugdeck/src/deck-manager.ts
 * @covers tugdeck/src/test-surface.ts
 * @covers tugapp/Sources/AppDelegate.swift
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const TEST_TIMEOUT_MS = 60_000;

const INPUT_PERSIST_KEY = "gallery-input/size/sm";

function inputSelectorFor(cardId: string): string {
  return `[data-card-id="${cardId}"] [data-tug-state-key="${INPUT_PERSIST_KEY}"]`;
}

describe.skipIf(!SHOULD_RUN)("m17: saveState RPC captures same axes as will-phase saves", () => {
  test("saveState() bag === window-blur bag for steady state", async () => {
    const app = await launchTugApp({
    // Foreground: drives a real app resign / hide / become-active cycle,
    // which only happens to an app that is actually active (pid-mode default
    // never activates).
    foreground: true, testName: "at0017-savestate-rpc-parity" });
    try {
      await app.enableDeckTrace(true);

      await app.seedDeckState({
        state: {
          cards: [
            { id: "A", componentId: "gallery-input", title: "Card A", closable: true },
          ],
          panes: [
            {
              id: "p1",
              position: { x: 40, y: 40 },
              size: { width: 480, height: 320 },
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

      // Type into the FC card so the bag carries user state.
      await app.nativeClickAtElement(inputSelectorFor("A"));
      await app.waitForCondition<boolean>(
        `document.activeElement !== null && document.activeElement.matches(${JSON.stringify(inputSelectorFor("A"))})`,
      );
      await app.type(inputSelectorFor("A"), "parity-probe");
      expect(await app.getFormControlValue("A", INPUT_PERSIST_KEY)).toBe("parity-probe");

      // Drive the saveState RPC (production path:
      // AppDelegate.applicationShouldTerminate). Read bag.
      const bagAfterSaveState = await app.evalJS<unknown>(
        `(function(){
          if (!window.tugdeck || typeof window.tugdeck.saveState !== "function") {
            throw new Error("window.tugdeck.saveState missing");
          }
          window.tugdeck.saveState();
          return window.__tug.getCardStateBag("A");
        })()`,
      );

      // Drive the window-blur path (production path:
      // installDeckStoreFocusListeners on app resign).
      const markBlur = await app.markDeckTrace();
      await app.simulateAppResign();
      await app.waitForCondition<boolean>(
        `(function(){
          var t = window.__tug.getDeckTrace({since: ${markBlur}});
          for (var i = 0; i < t.length; i++) {
            if (t[i].kind === "save-callback" && t[i].source === "window-blur" && t[i].cardId === "A") return true;
          }
          return false;
        })()`,
        { timeoutMs: 2000 },
      );
      const bagAfterWindowBlur = await app.evalJS<unknown>(
        `window.__tug.getCardStateBag("A")`,
      );

      // saveState bag must exist and contain the user's edit.
      expect(bagAfterSaveState).not.toBeNull();
      expect(JSON.stringify(bagAfterSaveState)).toContain("parity-probe");

      // The two bags should hold the same axes and the same values for
      // steady state. Any axis present in one and not the other is the
      // [AT0017] gap. Compared as values, not as serialized strings: the
      // two paths build their objects in different key orders, and key
      // order is not part of what a bag says.
      expect(bagAfterSaveState).toEqual(bagAfterWindowBlur);
    } catch (err) {
      const tail = app.tailLog(200);
      if (tail !== "") {
        process.stderr.write(`\n[at0017-savestate-rpc-parity] log tail:\n${tail}\n`);
      }
      throw err;
    } finally {
      await app.close();
    }
  }, TEST_TIMEOUT_MS);
});
