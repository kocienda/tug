/**
 * smoke-native-trusted-click.test.ts — Phase A native-gesture smoke:
 * `nativeClickAtElement` delivers an `isTrusted=true` mousedown.
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
  test("trusted click: nativeClickAtElement delivers isTrusted=true mousedown", async () => {
    const app = await launchTugApp({ testName: "smoke-native-trusted-click" });
    const fixtureId = "smoke-native-fx-click";
    try {
      await waitForPaintSettled(app);
      await seedOverlay(
        app,
        fixtureId,
        `<button id="smoke-click-btn" style="width: 180px; height: 48px;">click me</button>`,
      );
      await waitForPaintSettled(app);
      // Install a one-shot mousedown listener that stamps isTrusted
      // onto a global the test reads afterward. `{ once: true }` makes
      // the listener self-removing so a stray click later can't
      // overwrite the captured bit.
      await app.evalJS(`
        window.__smokeClickResult = null;
        document.getElementById("smoke-click-btn").addEventListener(
          "mousedown",
          function(e) {
            window.__smokeClickResult = {
              isTrusted: e.isTrusted,
              button: e.button,
              type: e.type,
            };
          },
          { once: true },
        );
      `);

      await app.nativeClickAtElement("#smoke-click-btn");

      // Poll until the listener fires — CGEvent.post delivery is
      // async to the RPC response, so the event may not have been
      // dispatched by the time nativeClickAtElement resolves.
      await app.waitForCondition("window.__smokeClickResult !== null");
      const result = await app.evalJS<{
        isTrusted: boolean;
        button: number;
        type: string;
      } | null>("window.__smokeClickResult");

      expect(result).not.toBeNull();
      expect(result?.type).toBe("mousedown");
      expect(result?.button).toBe(0);
      // This is the load-bearing assertion for the entire Phase A
      // rewrite: CGEvent.post must produce isTrusted=true.
      expect(result?.isTrusted).toBe(true);
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
