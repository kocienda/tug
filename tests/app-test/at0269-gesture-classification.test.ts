/**
 * at0269-gesture-classification.test.ts — the pointer stream has one
 * interpreter, and deselect is a deliberate classification.
 *
 * Two properties, asserted on the classification record itself
 * (`window.__tug.currentGesture()`) rather than only on its downstream effects:
 *
 *   1. A click on bare canvas classifies `activation: "deselect"` and really
 *      does deselect — the pane drops to `data-focused="false"` and no card is
 *      the first responder.
 *   2. A pointerdown that lands inside the deck but misses every pane WITHOUT
 *      striking the canvas background surface classifies `chrome`, not
 *      `deselect`, and the active card survives. Deselect used to be the
 *      absence of a pane under the pointer, which made portal gaps, overlay
 *      seams and below-the-fold geometry silently deselect the deck.
 *
 * Scenario 2 dispatches its pointerdown at a named element (the deck root
 * wrapper, which is not the marked background surface) because the geometry it
 * models — a seam with no pane under it but something else on top — has no
 * stable screen coordinate to click.
 *
 * @covers tugdeck/src/gesture-interpreter.ts
 * @covers tugdeck/src/lib/press-travel.ts
 * @covers tugdeck/src/components/chrome/pane-focus-controller.ts
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

// One card in a pane on the left, leaving bare canvas on the right (x ≈ 700).
function oneCard() {
  return {
    cards: [
      { id: "A", componentId: "gallery-input", title: "Card A", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 460, height: 520 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

const paneSelected = (paneId: string) =>
  `(function(){
    var el = document.querySelector('.tug-pane[data-pane-id="${paneId}"]');
    return el !== null && el.getAttribute("data-focused") === "true";
  })()`;

const settle = () => new Promise((r) => setTimeout(r, 350));

interface GestureRecord {
  site: string;
  activation: string;
  reasons: string[];
}

describe.skipIf(!SHOULD_RUN)("at0269 — gesture classification", () => {
  test(
    "bare canvas deselects; a deck gesture that merely misses every pane does not",
    async () => {
      const app = await launchTugApp({
        testName: "at0269-gesture-classification",
      });
      try {
        await app.seedDeckState({ state: oneCard(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-card-id="A"]') !== null`,
          { timeoutMs: 6000 },
        );
        await settle();
        expect(await app.evalJS<boolean>(paneSelected("p1"))).toBe(true);

        // (1) Bare canvas: a real, deliberate deselect. The record is read
        // while the gesture is live — between the press and the release —
        // because it retires at pointerup.
        await app.nativeMouseDown({ x: 700, y: 300 });
        // Posting the native press returns before the app has processed it, so
        // wait for the record to appear rather than racing it. It survives
        // until the release below retires the gesture.
        await app.waitForCondition<boolean>(
          `window.__tug.currentGesture() !== null`,
          { timeoutMs: 6000 },
        );
        const canvasGesture = await app.evalJS<GestureRecord | null>(
          `window.__tug.currentGesture()`,
        );
        await app.nativeMouseUp({ x: 700, y: 300 });
        console.log("[at0269] canvas gesture:", JSON.stringify(canvasGesture));
        expect(canvasGesture?.site).toBe("canvas-background");
        expect(canvasGesture?.activation).toBe("deselect");

        await settle();
        expect(
          await app.evalJS<boolean>(paneSelected("p1")),
          "canvas click deselects",
        ).toBe(false);
        expect(await app.evalJS<string | null>(`window.__tug.getActiveCardId()`)).toBe(
          null,
        );

        // Re-select for scenario 2: a click inside the pane activates it again.
        await app.nativeMouseDown({ x: 200, y: 300 });
        await app.waitForCondition<boolean>(
          `window.__tug.currentGesture() !== null`,
          { timeoutMs: 6000 },
        );
        const reselectGesture = await app.evalJS<GestureRecord | null>(
          `window.__tug.currentGesture()`,
        );
        await app.nativeMouseUp({ x: 200, y: 300 });
        console.log("[at0269] reselect gesture:", JSON.stringify(reselectGesture));
        expect(reselectGesture?.site).toBe("pane");
        expect(reselectGesture?.activation).toBe("activate");
        await app.waitForCondition<boolean>(paneSelected("p1"), {
          timeoutMs: 6000,
        });

        // (2) Inside the deck, outside every pane, but not the background
        // surface itself: the deck root wrapper that hosts the background as a
        // child. This is the shape of a portal gap or an overlay seam.
        const gapGesture = await app.evalJS<GestureRecord | null>(
          `(function(){
            var bg = document.querySelector("[data-deck-canvas-background]");
            if (bg === null) throw new Error("canvas background marker not found");
            var root = bg.parentElement;
            if (root === null) throw new Error("deck root not found");
            if (root.hasAttribute("data-deck-canvas-background")) {
              throw new Error("deck root is itself marked as background");
            }
            root.dispatchEvent(new PointerEvent("pointerdown", {
              bubbles: true, cancelable: true, composed: true, view: window,
              pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0,
            }));
            return window.__tug.currentGesture();
          })()`,
        );
        console.log("[at0269] gap gesture:", JSON.stringify(gapGesture));
        expect(gapGesture?.site).toBe("chrome");
        expect(gapGesture?.activation).toBe("none");
        expect(gapGesture?.reasons).toContain("canvas-gap");

        await settle();
        expect(
          await app.evalJS<boolean>(paneSelected("p1")),
          "a missed-pane gesture leaves the deck selected",
        ).toBe(true);
        expect(await app.evalJS<string | null>(`window.__tug.getActiveCardId()`)).toBe(
          "A",
        );
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0269] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
