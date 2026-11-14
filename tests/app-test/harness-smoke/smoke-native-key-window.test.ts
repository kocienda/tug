/**
 * smoke-native-key-window.test.ts — pid mode: the app believes it is
 * active and its window is really key, with the user's app and input
 * source untouched.
 *
 * One of the smoke-native split, a test to a file so each launch fits
 * its own budget. What the split pins, and the settle helper, are
 * `smoke-native-fixture.ts`.
 *
 * @covers tests/app-test/_harness/
 * @covers tugapp/Sources/TestHarness/
 * @family smoke-native
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp } from "../_harness";
import { SHOULD_RUN, waitForPaintSettled } from "./smoke-native-fixture";

describe.skipIf(!SHOULD_RUN)("phase A native-gesture smoke", () => {
  test("pid mode: the app believes it is active and its window is really key, with the user's app and input source untouched", async () => {
    // The background launch never activates. AppKit refuses key status to
    // an inactive app's window, so the host's `TugApplication` has the app
    // believe it is active in this mode and the real `makeKey()` succeeds:
    // `isKeyWindow` is AppKit's own state, `NSApp.keyWindow` names the
    // window, and `isActive` reads true — what a foreground app is, which
    // is what gives chords the key window's view-then-menu order and lets
    // a nil-target Edit action resolve. The other half of the contract is
    // that none of it touched the user: the frontmost app and the keyboard
    // input source read the same now as before the host's `run()`, and the
    // frontmost app is not this one.
    const app = await launchTugApp({ testName: "smoke-native-key-window" });
    try {
      await waitForPaintSettled(app);
      const state = await app.windowState();
      const seen = JSON.stringify(state);
      expect(state.isActive, `the app must believe it is active; saw ${seen}`).toBe(true);
      expect(state.isKeyWindow, `the window must really be key; saw ${seen}`).toBe(true);
      expect(state.appKeyWindow, `NSApp.keyWindow must name the window; saw ${seen}`).toBe(true);
      expect(state.firstResponder, `the window must have a first responder; saw ${seen}`).not.toBeNull();
      expect(state.frontmostNow, `the user's frontmost app must not move across the launch; saw ${seen}`).toBe(state.frontmostAtLaunch);
      expect(state.frontmostNow, `this app must never be frontmost; saw ${seen}`).not.toBe("dev.tugapp.app.apptest");
      expect(state.inputSourceNow, `the keyboard input source must not change across the launch; saw ${seen}`).toBe(state.inputSourceAtLaunch);
      // WebKit reads the window active from the real key window, and the
      // host announced the activation in-process, so the page believes it
      // is in front the way a foreground app's does: the document has
      // focus, and the deck's own projection of the active bit agrees.
      const page = await app.evalJS<{ hasFocus: boolean; appActive: string | null }>(
        `({ hasFocus: document.hasFocus(), appActive: document.documentElement.getAttribute("data-app-active") })`,
      );
      expect(page.hasFocus, `the shell must read document.hasFocus() under the real key window; saw ${JSON.stringify(page)}`).toBe(true);
      expect(page.appActive, `the deck's data-app-active must agree with the announced activation; saw ${JSON.stringify(page)}`).toBe("true");
    } finally {
      await app.close();
    }
  });
});
