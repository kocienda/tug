/**
 * smoke-native-double-click.test.ts — Phase A native-gesture smoke:
 * `nativeDoubleClick` selects the clicked word.
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
  test("double-click: nativeDoubleClickAtElement selects the clicked word", async () => {
    const app = await launchTugApp({ testName: "smoke-native-double-click" });
    const fixtureId = "smoke-native-fx-double";
    try {
      await waitForPaintSettled(app);
      // Input with two words; double-click near the start selects
      // the first word.
      await seedOverlay(
        app,
        fixtureId,
        `<input id="smoke-dblclick-input" type="text" value="hello world" style="width: 300px; height: 32px; font-size: 16px;" />`,
      );
      await waitForPaintSettled(app);

      // Text-inputs render their value inside a shadow DOM that's not
      // directly queryable for per-char rects, so the safe target is
      // a viewport point near the START of the input's content box
      // — well inside "hello", far from the "hello world" word break.
      // The previous approach of picking `width * 0.20` landed on
      // "world" because `<input style="width:300px">` is much wider
      // than 11 chars of 16px text; 10px in from the content edge is
      // robust against any readable font size.
      const firstWordTarget = await app.evalJS<{ x: number; y: number }>(`
        (function() {
          var el = document.getElementById("smoke-dblclick-input");
          var r = el.getBoundingClientRect();
          // Account for the input's padding (user-agent default ~2px
          // on the left). 10px further in lands on the first
          // character regardless of font metrics.
          return { x: r.left + 10, y: r.top + r.height / 2 };
        })()
      `);

      await app.nativeDoubleClick(firstWordTarget);

      // Poll on the input's selection range for "hello". The second
      // click's mouseup + dblclick events dispatch ~100ms after
      // nativeDoubleClick's RPC returns, so the condition is
      // observably-false at first; waitForCondition handles that.
      await app.waitForCondition(
        `(function() {
          var el = document.getElementById("smoke-dblclick-input");
          if (document.activeElement !== el) return false;
          return el.selectionStart === 0 && el.selectionEnd === 5;
        })()`,
      );
      const sel = await app.getSelection();
      expect(sel).not.toBeNull();
      expect(sel?.kind).toBe("input");
      if (sel?.kind === "input") {
        expect(sel.value).toBe("hello world");
        expect(sel.selectionStart).toBe(0);
        expect(sel.selectionEnd).toBe(5);
      }
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
