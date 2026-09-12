/**
 * at0295-background-activation-click.test.ts — the click that brings a
 * backgrounded Tug.app forward activates the card it landed on.
 *
 * `WKWebView` does not accept first mouse, so AppKit consumes that click and
 * the document never sees it: before this wiring, the app came forward with
 * whatever card was active when it was backgrounded, no matter which card the
 * user aimed at. `MainWindow.sendEvent` now recognizes the activating
 * mouse-down, converts its location to viewport coordinates and hands it to
 * `__tugBridge.onActivationClick`, which runs it through the gesture
 * interpreter's classification and realizes the activation transfer.
 *
 * Both scenarios background the app for real (`simulateAppResign` →
 * `NSApp.deactivate()` + Finder activation) and click with a real
 * `CGEvent` post, so the whole path is exercised: WindowServer routing →
 * `MainWindow.sendEvent` → bridge → interpreter → focus transfer.
 *
 *   1. Backgrounded, click card B in the second pane: B becomes the active
 *      card and p2 the focused pane. `currentGesture()` stays null throughout —
 *      the document really never received the click, so the activation came
 *      from the host path and nothing under the cursor was pressed.
 *   2. Backgrounded, click bare canvas: the app comes forward with its
 *      selection intact. A foreground canvas click deselects; the click that
 *      merely raises the app does not.
 *   3. Backgrounded in FLOW, click a card straddling the band's right edge:
 *      the strip slides and the card comes fully into view. The activation and
 *      the reveal are separate commits, and the pointer stream defers the
 *      reveal to the release because the hand is still down on the card. An
 *      activation click is swallowed whole — there is no release — so the
 *      reveal must be taken at the activation or never at all, and "never"
 *      left the aimed-at card active and still half-occluded.
 *
 * @foreground
 * @covers tugapp/Sources/MainWindow.swift
 * @covers tugdeck/src/lib/activation-click-bridge.ts
 * @covers tugdeck/src/gesture-interpreter.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

// Two panes side by side across the top, leaving bare canvas below them.
function twoPanes() {
  return {
    cards: [
      { id: "A", componentId: "gallery-input", title: "Card A", closable: true },
      { id: "B", componentId: "gallery-input", title: "Card B", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 420, height: 400 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
      {
        id: "p2",
        position: { x: 520, y: 40 },
        size: { width: 420, height: 400 },
        cardIds: ["B"],
        activeCardId: "B",
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

// Viewport points, verified below against what actually sits under them: the
// panes span y 40–440, p1 x 40–460 and p2 x 520–940. A `[data-card-id]`
// selector is not usable here — the first match is a zero-sized element, so a
// click at its center lands in the deck's top-left corner.
const CARD_A_POINT = { x: 200, y: 200 };
const CARD_B_POINT = { x: 700, y: 200 };
const CANVAS_POINT = { x: 700, y: 700 };

/** Frames are measured in device pixels; a rounded pin is within a pixel. */
const TOL = 1.5;

/**
 * Scenario 3's deck: five 420px cards standing side by side in a flow strip,
 * which on any window this harness opens runs off the band's right edge — so
 * the last slots straddle it and have something to be revealed from.
 */
function flowStrip() {
  const ids = ["A", "B", "C", "D", "E"];
  return {
    cards: ids.map((id) => ({
      id,
      componentId: "gallery-input",
      title: `Card ${id}`,
      closable: true,
    })),
    panes: ids.map((id, index) => ({
      id: `p${index + 1}`,
      position: { x: 40, y: 40 },
      size: { width: 420, height: 400 },
      cardIds: [id],
      activeCardId: id,
      title: "",
      acceptsFamilies: ["maker"],
      slot: index,
    })),
    activePaneId: "p1",
    imposition: { kind: "six-up", layout: "flow" },
    hasFocus: true,
  };
}

interface Frame {
  paneId: string;
  cardId: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Every imposed pane's painted frame, in slot order. */
const IMPOSED_FRAMES = `(function () {
  var state = window.tugdeck.diag.getDeckState();
  var out = [];
  state.panes.forEach(function (pane) {
    if (pane.slot === undefined) return;
    var el = document.querySelector('.tug-pane[data-pane-id="' + pane.id + '"]');
    if (el === null) return;
    var b = el.getBoundingClientRect();
    out.push({
      paneId: pane.id,
      cardId: pane.activeCardId,
      slot: pane.slot,
      left: b.left,
      right: b.right,
      top: b.top,
      bottom: b.bottom,
    });
  });
  out.sort(function (a, b) { return a.slot - b.slot; });
  return out;
})()`;

const FLOW_OFFSET = `(window.tugdeck.diag.getDeckState().flowOffset || 0)`;

/** The canvas's own right edge — the hard limit no revealed card may cross. */
const CANVAS_RIGHT =
  `document.querySelector("[data-deck-canvas-background]").getBoundingClientRect().right`;

const settle = () => new Promise((r) => setTimeout(r, 350));

describe.skipIf(!SHOULD_RUN)("at0295 — background activation click", () => {
  test(
    "the activating click activates the card under it, and leaves a canvas click's selection alone",
    async () => {
      const app = await launchTugApp({
    // Foreground: drives a real app resign / hide / become-active cycle,
    // which only happens to an app that is actually active (pid-mode default
    // never activates).
    foreground: true,
        testName: "at0295-background-activation-click",
      });
      try {
        await app.seedDeckState({ state: twoPanes(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-card-id="B"]') !== null`,
          { timeoutMs: 6000 },
        );
        await settle();
        expect(await app.getActiveCardId()).toBe("A");
        expect(await app.evalJS<boolean>(paneSelected("p1"))).toBe(true);

        // The canvas point scenario 2 uses must really be bare canvas — a
        // window narrower or shorter than seeded would put a pane there.
        expect(
          await app.evalJS<boolean>(
            `document.elementFromPoint(${CANVAS_POINT.x}, ${CANVAS_POINT.y})
               ?.hasAttribute("data-deck-canvas-background") === true`,
          ),
          "the canvas point sits on the deck background",
        ).toBe(true);

        // -------------------------------------------------------------
        // (1) Backgrounded → click card B.
        // -------------------------------------------------------------
        await app.simulateAppResign();
        await settle();
        expect(await app.evalJS<boolean>(`document.hasFocus()`)).toBe(false);

        expect(
          await app.evalJS<string | null>(
            `document.elementFromPoint(${CARD_B_POINT.x}, ${CARD_B_POINT.y})
               ?.closest("[data-card-id]")?.getAttribute("data-card-id") ?? null`,
          ),
          "the card-B point sits on card B",
        ).toBe("B");

        await app.nativeClick(CARD_B_POINT, { activateFirst: false });
        await app.waitForCondition<boolean>(
          `window.__tug.getActiveCardId() === "B"`,
          { timeoutMs: 6000 },
        );
        await app.waitForCondition<boolean>(paneSelected("p2"), {
          timeoutMs: 10000,
        });
        expect(await app.evalJS<boolean>(`document.hasFocus()`)).toBe(true);
        // No pointer gesture ran: the click activated the card without ever
        // being delivered to the document.
        expect(
          await app.evalJS<unknown>(`window.__tug.currentGesture()`),
          "the activating click is not delivered as a gesture",
        ).toBe(null);

        // -------------------------------------------------------------
        // (2) Foreground canvas click deselects; the activating one does not.
        // -------------------------------------------------------------
        await app.nativeClick(CANVAS_POINT);
        await app.waitForCondition<boolean>(
          `window.__tug.getActiveCardId() === null`,
          { timeoutMs: 6000 },
        );

        await app.nativeClick(CARD_A_POINT);
        await app.waitForCondition<boolean>(
          `window.__tug.getActiveCardId() === "A"`,
          { timeoutMs: 6000 },
        );

        await app.simulateAppResign();
        await settle();
        await app.nativeClick(CANVAS_POINT, { activateFirst: false });
        await app.waitForCondition<boolean>(`document.hasFocus()`, {
          timeoutMs: 6000,
        });
        await settle();
        expect(
          await app.getActiveCardId(),
          "raising the app on bare canvas keeps the selection",
        ).toBe("A");
        expect(await app.evalJS<boolean>(paneSelected("p1"))).toBe(true);

        // -------------------------------------------------------------
        // (3) Backgrounded → click a card the band is only half showing.
        // -------------------------------------------------------------
        await app.seedDeckState({ state: flowStrip(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelector('.tug-pane[data-pane-id="p5"]') !== null`,
          { timeoutMs: 8000 },
        );
        await settle();
        expect(
          await app.evalJS<number>(FLOW_OFFSET),
          "the strip starts at rest",
        ).toBe(0);

        const edge = await app.evalJS<number>(CANVAS_RIGHT);
        const frames = await app.evalJS<Frame[]>(IMPOSED_FRAMES);
        // The straddler: far enough past the edge to be visibly cut, and with
        // enough of its near side showing to aim at.
        const straddler = frames.find(
          (f) => f.right > edge + TOL && f.left < edge - 120,
        );
        note(
          `frames: ${frames
            .map((f) => `${f.cardId} ${Math.round(f.left)}–${Math.round(f.right)}`)
            .join(", ")} | canvas right ${Math.round(edge)}`,
        );
        expect(
          straddler,
          "the fixture must leave a card straddling the edge, or there is nothing to reveal",
        ).toBeDefined();
        if (straddler === undefined) throw new Error("unreachable");

        const straddlerPoint = {
          x: Math.round(straddler.left + 60),
          y: Math.round((straddler.top + straddler.bottom) / 2),
        };
        expect(
          await app.evalJS<string | null>(
            `document.elementFromPoint(${straddlerPoint.x}, ${straddlerPoint.y})
               ?.closest("[data-card-id]")?.getAttribute("data-card-id") ?? null`,
          ),
          "the aim point sits on the straddling card",
        ).toBe(straddler.cardId);

        await app.simulateAppResign();
        await settle();
        await app.nativeClick(straddlerPoint, { activateFirst: false });
        await app.waitForCondition<boolean>(
          `window.__tug.getActiveCardId() === ${JSON.stringify(straddler.cardId)}`,
          { timeoutMs: 6000 },
        );
        // The slide is a settle, so give the tween its landing.
        await settle();
        await settle();

        const after = (await app.evalJS<Frame[]>(IMPOSED_FRAMES)).find(
          (f) => f.paneId === straddler.paneId,
        );
        note(
          `after activation click: offset ${await app.evalJS<number>(FLOW_OFFSET)}, ` +
            `card right ${Math.round(after?.right ?? NaN)}`,
        );
        expect(
          await app.evalJS<number>(FLOW_OFFSET),
          "the activating click slid the strip",
        ).toBeGreaterThan(0);
        expect(
          after?.right ?? Infinity,
          "the card the click named is fully in view",
        ).toBeLessThanOrEqual(edge + TOL);
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0295] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
