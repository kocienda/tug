/**
 * smoke-native-type.test.ts — Phase A native-gesture smoke: `nativeType`
 * inserts ASCII text into the focused input.
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
  test("type: nativeType inserts ASCII text into focused input", async () => {
    const app = await launchTugApp({ testName: "smoke-native-type" });
    const fixtureId = "smoke-native-fx-type";
    try {
      await waitForPaintSettled(app);
      await seedOverlay(
        app,
        fixtureId,
        `<input id="smoke-type-input" type="text" style="width: 300px; height: 32px; font-size: 16px;" />`,
      );
      await waitForPaintSettled(app);
      await app.nativeClickAtElement("#smoke-type-input");
      // Wait for focus to land — WebKit's focus-on-mousedown path is
      // async to our RPC response just like the mousedown dispatch.
      await app.waitForCondition(
        `document.activeElement === document.getElementById("smoke-type-input")`,
      );

      await app.nativeType("hello");

      // Poll on value rather than asserting immediately; keystroke
      // dispatch → InputEvent → `.value` write is also async.
      await app.waitForCondition(
        `document.getElementById("smoke-type-input").value === "hello"`,
      );
      const value = await app.getElementValue("#smoke-type-input");
      expect(value).toBe("hello");
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
