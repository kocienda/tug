/**
 * sheet-visibility-fixture.ts — the decks, the measures and the sheet
 * gestures the at0558 sheet visibility files share. The measure reads the
 * panel against the visible canvas after finishing the sheet's animations,
 * for the reason `at0558-sheet-visibility-tall-composer-below` gives.
 *
 * Split out of `at0558-sheet-visibility.test.ts` when that file was cut into
 * `at0558-sheet-visibility-tall-composer-below`, `-tall-composer-above`,
 * `-folded-card`, `-pane-raise` and `-entrance-interrupted` to keep each
 * under the 20 s budget.
 */

import { expect } from "bun:test";
import { type App } from "./_harness";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 180_000;

export const SID = "at0558-session";
export const CARD = '[data-card-id="A"]';
export const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
export const AI_CHIP = `${CARD} [data-slot="ai-chip"]`;
export const SHEET = '[data-slot="tug-sheet"]';

/** Long enough that the composer grows and squeezes the modal rest line. */
export const LONG = Array.from(
  { length: 28 },
  (_, i) =>
    `line ${i} of a long prompt that makes the composer grow tall enough to squeeze the modal rest line`,
).join(" ");

export interface Measure {
  clip: { top: number; bottom: number; height: number; anchor: string | null };
  presentation: string | null;
  content: { top: number; bottom: number; height: number };
  frame: { top: number; bottom: number };
  canvas: { top: number; bottom: number };
  restLineHeight: number | null;
  /** How far the panel's top is cut off by its own clip. */
  topCutPx: number;
  /** How far the panel's bottom hangs past its own clip. */
  bottomOverflowPx: number;
}

export const MEASURE = `(function(){
  var c = document.querySelector(${JSON.stringify(SHEET)});
  if (c === null) return null;
  var k = c.closest(".tug-sheet-clip");
  var frame = c.closest(".tug-pane");
  // The canvas by IDENTITY, never by parentage: a workspace wrapper stands
  // between a pane frame and the container, shown as display:contents, so
  // parentElement answers with a rect of zeros. A probe reading that would be
  // asking whether the panel fits inside a zero-height box at the viewport
  // origin, which is a question about the probe rather than about the sheet.
  var canvas = frame.closest("[data-deck-canvas-background]");
  var kr = k.getBoundingClientRect();
  var cr = c.getBoundingClientRect();
  var fr = frame.getBoundingClientRect();
  var vr = canvas.getBoundingClientRect();
  var slot = document.querySelector(${JSON.stringify(CARD)} + " .session-view-slot");
  var r = function (x) { return Math.round(x * 10) / 10; };
  return {
    clip: { top: r(kr.top), bottom: r(kr.bottom), height: r(kr.height), anchor: k.getAttribute("data-vertical-anchor") },
    presentation: c.getAttribute("data-tug-sheet-presentation"),
    content: { top: r(cr.top), bottom: r(cr.bottom), height: r(cr.height) },
    frame: { top: r(fr.top), bottom: r(fr.bottom) },
    canvas: { top: r(vr.top), bottom: r(vr.bottom) },
    restLineHeight: slot === null ? null : r(slot.getBoundingClientRect().height),
    topCutPx: r(kr.top - cr.top),
    bottomOverflowPx: r(cr.bottom - kr.bottom),
  };
})()`;

export const STACKING = `(function(){
  var q = function (id) { return document.querySelector('.tug-pane[data-pane-id="' + id + '"]'); };
  var a = q("p1"), b = q("p2");
  var c = document.querySelector(${JSON.stringify(SHEET)});
  var r = function (x) { return Math.round(x * 10) / 10; };
  var panel = c === null ? null : c.getBoundingClientRect();
  var bBox = b.getBoundingClientRect();
  return {
    a: { z: Number(getComputedStyle(a).zIndex), sheetOpen: a.getAttribute("data-sheet-open"), folded: a.getAttribute("data-folded") },
    b: { z: Number(getComputedStyle(b).zIndex), sheetOpen: b.getAttribute("data-sheet-open") },
    // Does the panel actually reach over the peer pane? If it does not, the
    // stacking question this case exists to ask is not being asked.
    panelOverlapsPeerPx:
      panel === null ? null : r(Math.min(panel.bottom, bBox.bottom) - Math.max(panel.top, bBox.top)),
    sheetCount: document.querySelectorAll(${JSON.stringify(SHEET)}).length,
  };
})()`;

export function deckShape(pane: { x: number; y: number; width: number; height: number }) {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: pane.x, y: pane.y },
        size: { width: pane.width, height: pane.height },
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

// [B03]: a folded card holding a sheet, with a peer card BELOW it in the deck's
// array — so the peer's focus-order z outranks the folded card's and, before
// the lift, painted over its panel.
export function wallShape() {
  return {
    cards: [
      { id: "A", componentId: "session", title: "Session A", closable: true },
      { id: "B", componentId: "session", title: "Session B", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 675, height: 680 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
      {
        id: "p2",
        position: { x: 40, y: 400 },
        size: { width: 675, height: 600 },
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

export async function finishAnimations(app: App): Promise<void> {
  await app.evalJS<null>(
    `(document.querySelectorAll(${JSON.stringify(SHEET)}).forEach(function (e) { e.getAnimations().forEach(function (a) { a.finish(); }); }), null)`,
  );
}

export async function settle(app: App, ms: number): Promise<Measure> {
  await new Promise((r) => setTimeout(r, ms));
  await finishAnimations(app);
  return await app.evalJS<Measure>(MEASURE);
}

/** The whole panel is inside the visible canvas, and nothing of it is clipped. */
export function expectWhollyVisible(m: Measure): void {
  expect(m.topCutPx).toBeLessThanOrEqual(0.5);
  expect(m.bottomOverflowPx).toBeLessThanOrEqual(0.5);
  expect(m.content.top).toBeGreaterThanOrEqual(m.canvas.top);
  expect(m.content.bottom).toBeLessThanOrEqual(m.canvas.bottom);
  expect(m.content.height).toBeGreaterThan(0);
}

export async function seedOne(
  app: App,
  pane: { x: number; y: number; width: number; height: number },
): Promise<void> {
  // `isEngineReady` reads the deck trace, so the trace has to be on before
  // the engine mounts or the ready event is never recorded.
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: deckShape(pane), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
  );
  await app.bindSession("A", { tugSessionId: SID });
  await app.awaitEngineReady("A");
}

/**
 * Enter {@link LONG} into the focused composer as one text insertion — the
 * `insertText` input a keystroke makes, carrying the whole string at once.
 * The cases need the composer tall, not typed: keying 2,800 characters in one
 * at a time was most of each tall-composer file's time. Not a paste: a long
 * paste is a different gesture, and the composer may answer it differently.
 */
export async function enterLong(app: App): Promise<void> {
  await app.evalJS<null>(`(function(){
    var cm = document.querySelector(${JSON.stringify(PROMPT_INPUT)});
    cm.focus();
    document.execCommand("insertText", false, ${JSON.stringify(LONG)});
    return null;
  })()`);
}

export async function openAiSheet(app: App): Promise<void> {
  await app.nativeClickAtElement(AI_CHIP);
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
    { timeoutMs: 8000 },
  );
}

/**
 * The same opener, driven through the chip's own `onClick` rather than through
 * the window server. A fold takes the entry region's box away, and an unfold
 * under an occluded harness window does not settle it back, so on a card that
 * has been folded there is no on-screen target to aim a native click at.
 */
export async function openAiSheetByScript(app: App): Promise<void> {
  await app.evalJS<null>(
    `(document.querySelector(${JSON.stringify(AI_CHIP)}).click(), null)`,
  );
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
    { timeoutMs: 8000 },
  );
}

/**
 * Escape dismisses a pane-modal sheet — but the exit animation is what takes
 * the panel out of the DOM, and under an occluded harness window a running
 * animation never advances, so the dismissed sheet would stand there forever.
 * Finishing the animations after the key is what lets the unmount land.
 */
export async function dismissSheet(app: App): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await app.nativeKey("Escape");
    await new Promise((r) => setTimeout(r, 300));
    await finishAnimations(app);
    await new Promise((r) => setTimeout(r, 500));
    const gone = await app.evalJS<boolean>(
      `document.querySelector(${JSON.stringify(SHEET)}) === null`,
    );
    if (gone) return;
  }
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(SHEET)}) === null`,
    { timeoutMs: 8000 },
  );
}
