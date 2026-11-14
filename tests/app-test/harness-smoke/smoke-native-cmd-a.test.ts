/**
 * smoke-native-cmd-a.test.ts — Phase A native-gesture smoke:
 * `nativeKey('a', ['cmd'])` delivers a trusted keydown with
 * `metaKey=true`.
 *
 * One of the smoke-native split, a test to a file so each launch fits
 * its own budget. What the split pins, why it drives an overlay instead
 * of a seeded deck, and the settle helper, are `smoke-native-fixture.ts`.
 *
 * @covers tests/app-test/_harness/
 * @covers tugapp/Sources/TestHarness/
 * @family smoke-native
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp } from "../_harness";
import {
  SHOULD_RUN,
  waitForPaintSettled,
  seedOverlay,
  removeOverlay,
} from "./smoke-native-fixture";

describe.skipIf(!SHOULD_RUN)("phase A native-gesture smoke", () => {
  test("Cmd+A: nativeKey('a', ['cmd']) delivers trusted keydown with metaKey=true", async () => {
    // Phase-A fidelity thesis, modifier edition: the CGEvent-posted
    // keystroke must arrive at WebKit as
    // `{ isTrusted: true, metaKey: true, code: "KeyA" }`. We cannot
    // assert on *behavior* (select-all) because tugdeck owns a
    // document-level capture-phase keydown listener that matches
    // Cmd+A and calls `event.preventDefault()` before the browser's
    // native select-all runs (see
    // `tugdeck/src/components/tugways/keybinding-map.ts` and
    // `responder-chain-provider.tsx`). Fighting tugdeck's capture
    // listener from a smoke test would be fragile; asserting on the
    // *event shape* directly is the robust pipeline check. Step 3b's
    // AT0003 rewrite does assert on behavior, but there the test scenario
    // is designed around the deck's own bindings, not in conflict
    // with them.
    const app = await launchTugApp({ testName: "smoke-native-cmd-a" });
    const fixtureId = "smoke-native-fx-cmd-a";
    try {
      await waitForPaintSettled(app);
      await seedOverlay(
        app,
        fixtureId,
        `<input id="smoke-cmda-input" type="text" value="hello world" style="width: 300px; height: 32px; font-size: 16px;" />`,
      );
      await waitForPaintSettled(app);
      // Install a one-shot keydown listener in the capture phase on
      // the input itself. tugdeck's listener is on document (capture)
      // — it calls `preventDefault()` but only calls
      // `stopImmediatePropagation()` when a responder handles the
      // action. With no SELECT_ALL responder registered for our
      // overlay, propagation continues and the event reaches our
      // listener. The listener fires once and stamps `isTrusted` +
      // `metaKey` + `code` onto a global the test reads afterward.
      //
      // The listener also claims the key. A ⌘A nobody claims is handed
      // back to AppKit: WebKit reports the keydown unhandled, resends it,
      // Edit › Select All validates dark (no Tug responder for a bare
      // input), and the key falls off the responder chain into the
      // no-responder beep — a red under the harness's silence contract.
      // Every text control in Tug claims its own ⌘A through the text-input
      // substrate; this overlay input is the one that has none, so it
      // claims the key itself, the way the substrate would.
      await app.evalJS(`
        window.__smokeCmdAResult = null;
        document.getElementById("smoke-cmda-input").addEventListener(
          "keydown",
          function(e) {
            // The modifier keydown (code === "MetaLeft") fires before
            // the letter keydown; skip modifier events so we record
            // the 'a' keystroke with its fully-propagated flags.
            if (e.code === "MetaLeft" || e.code === "MetaRight" ||
                e.code === "ShiftLeft" || e.code === "ShiftRight" ||
                e.code === "AltLeft" || e.code === "AltRight" ||
                e.code === "ControlLeft" || e.code === "ControlRight") {
              return;
            }
            if (e.metaKey && e.code === "KeyA") e.preventDefault();
            if (window.__smokeCmdAResult !== null) return;
            window.__smokeCmdAResult = {
              isTrusted: e.isTrusted,
              metaKey: e.metaKey,
              code: e.code,
              key: e.key,
              ctrlKey: e.ctrlKey,
              shiftKey: e.shiftKey,
              altKey: e.altKey,
            };
          },
          { capture: true },
        );
      `);
      await app.nativeClickAtElement("#smoke-cmda-input");
      await app.waitForCondition(
        `document.activeElement === document.getElementById("smoke-cmda-input")`,
      );

      await app.nativeKey("a", ["cmd"]);

      await app.waitForCondition("window.__smokeCmdAResult !== null");
      const result = await app.evalJS<{
        isTrusted: boolean;
        metaKey: boolean;
        code: string;
        key: string;
        ctrlKey: boolean;
        shiftKey: boolean;
        altKey: boolean;
      } | null>("window.__smokeCmdAResult");

      expect(result).not.toBeNull();
      // Load-bearing modifier-flag assertion: Cmd must be set.
      expect(result?.metaKey).toBe(true);
      expect(result?.isTrusted).toBe(true);
      expect(result?.code).toBe("KeyA");
      // Sanity: no stray modifiers.
      expect(result?.ctrlKey).toBe(false);
      expect(result?.shiftKey).toBe(false);
      expect(result?.altKey).toBe(false);
    } finally {
      try {
        await removeOverlay(app, fixtureId);
      } catch {
        // best-effort cleanup
      }
      await app.close();
    }
  });
});
