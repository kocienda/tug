/**
 * smoke-native-drag.test.ts — Phase A native-gesture smoke: an endpoint
 * `nativeDrag` produces a painted selection.
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
  test("endpoint drag: nativeDrag produces a painted selection", async () => {
    // User-facing assertion: after dragging from char-0 to char-5,
    // the selection actually reads "Hello" — the same outcome a real
    // user would see from a real mouse drag.
    //
    // Environmental setup: tugdeck's `selectionGuard` blocks
    // `selectstart` for any target outside a registered card
    // boundary (see
    // `tugdeck/src/components/tugways/selection-guard.ts`
    // `handleSelectStart`). Real user scenarios drag INSIDE a card
    // content area, which is always registered. To mirror that
    // environment in a smoke test without seeding a full deck + card
    // tree, we register our overlay element as an ad-hoc boundary
    // via `__tug.registerSelectionBoundary(cardId, selector)`. This
    // is a test-only surface method added in SURFACE_VERSION 1.1.0;
    // it is a thin wrapper over `selectionGuard.registerBoundary`,
    // the same call a mounting card makes.
    const app = await launchTugApp({ testName: "smoke-native-drag" });
    const fixtureId = "smoke-native-fx-drag";
    try {
      await waitForPaintSettled(app);
      await seedOverlay(
        app,
        fixtureId,
        `<div id="smoke-drag-editor" contenteditable="true" style="font-size: 18px; line-height: 1.5; padding: 8px; border: 1px solid #aaa; user-select: text;">Hello World</div>`,
      );
      // Register the overlay as a selection boundary — mirrors what
      // a mounting card's `useSelectionBoundary` hook does. Without
      // this, `selectionGuard.handleSelectStart` calls preventDefault
      // and WebKit never begins the selection.
      await app.registerSelectionBoundary("smoke-drag-fake-card", `#${fixtureId}`);
      await waitForPaintSettled(app);

      // Compute char-0 and char-5 viewport points via Range rects.
      // Range rects are the browser's authoritative per-character
      // geometry and survive font-metric variability.
      const points = await app.evalJS<{
        from: { x: number; y: number };
        to: { x: number; y: number };
      }>(`(function() {
        var editor = document.getElementById("smoke-drag-editor");
        var textNode = editor.firstChild;
        var fromRect = (function() {
          var r = document.createRange();
          r.setStart(textNode, 0); r.setEnd(textNode, 1);
          var rect = r.getBoundingClientRect();
          return { x: rect.left + 1, y: rect.top + rect.height / 2 };
        })();
        var toRect = (function() {
          var r = document.createRange();
          r.setStart(textNode, 0); r.setEnd(textNode, 5);
          var rect = r.getBoundingClientRect();
          return { x: rect.right - 1, y: rect.top + rect.height / 2 };
        })();
        return { from: fromRect, to: toRect };
      })()`);

      await app.nativeDrag(points.from, points.to, {
        mouseDownDelayMs: 40,
        mouseUpDelayMs: 40,
      });

      // Poll for the selection to appear. A successful drag produces
      // a non-collapsed selection of length 5 ("Hello"). WebKit
      // dispatches selection-change events asynchronously after
      // mouseUp.
      await app.waitForCondition(
        `(function() {
          var sel = window.getSelection();
          return sel !== null && !sel.isCollapsed && sel.toString().length === 5;
        })()`,
        { timeoutMs: 3000 },
      );
      const selectedText = await app.evalJS<string>(
        `String(window.getSelection() || "")`,
      );
      expect(selectedText).toBe("Hello");
    } finally {
      try {
        await app.unregisterSelectionBoundary("smoke-drag-fake-card");
      } catch {
        // best-effort cleanup
      }
      try {
        await removeOverlay(app, fixtureId);
      } catch {
        // best-effort cleanup
      }
      await app.close();
    }
  });
});
