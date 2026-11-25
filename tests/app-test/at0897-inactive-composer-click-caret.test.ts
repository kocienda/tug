/**
 * at0897-inactive-composer-click-caret.test.ts — a click into an inactive
 * card's prompt entry activates the card AND puts the caret where the click
 * landed.
 *
 * Two prompt-entry cards side by side. Card B's composer holds a line of text
 * with its caret at the end; card A is then made active. One real click on B,
 * between two characters in the middle of that line, must leave B active with
 * its caret at that boundary — not at the end where it was, and not at the
 * start.
 *
 * @covers tugdeck/src/gesture-interpreter.ts
 * @covers tugdeck/src/components/tugways/responder-chain-provider.tsx
 * @covers tugdeck/src/components/tugways/focus-manager.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note } from "./_harness";
import { waitForBodyReady } from "./_harness/card-reach";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const TEXT = "abcdefghijklmnop";
const AIM = 6; // between "f" and "g"

function twoComposers() {
  return {
    cards: [
      { id: "A", componentId: "gallery-prompt-entry", title: "Card A", closable: true },
      { id: "B", componentId: "gallery-prompt-entry", title: "Card B", closable: true },
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

const editor = (id: string) => `[data-card-id="${id}"] [data-slot="tug-text-editor"] .cm-content`;

/** The caret's offset within the first line, or null when the editor has no caret. */
const CARET_IN_B = `(function(){
  var content = document.querySelector(${JSON.stringify(editor("B"))});
  var sel = window.getSelection();
  if (!content || !sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
  if (!content.contains(sel.anchorNode)) return null;
  var line = content.querySelector(".cm-line");
  var r = document.createRange();
  r.setStart(line, 0);
  r.setEnd(sel.anchorNode, sel.anchorOffset);
  return r.toString().length;
})()`;

/** The viewport point just right of the boundary before character AIM. */
const AIM_POINT = `(function(){
  var line = document.querySelector(${JSON.stringify(editor("B"))} + " .cm-line");
  var walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  var node = walker.nextNode();
  var r = document.createRange();
  r.setStart(node, ${AIM});
  r.setEnd(node, ${AIM + 1});
  var b = r.getBoundingClientRect();
  return { x: b.left + 1, y: b.top + b.height / 2 };
})()`;

describe.skipIf(!SHOULD_RUN)("at0897 — inactive composer click places the caret", () => {
  test(
    "one click on an inactive card's composer activates it with the caret under the click",
    async () => {
      const app = await launchTugApp({ testName: "at0897-inactive-composer-click-caret" });
      try {
        await app.seedDeckState({ state: twoComposers(), focusCardId: "B" });
        const a = await waitForBodyReady(app, "A");
        const b = await waitForBodyReady(app, "B");
        await b.waitForCondition<boolean>(`document.querySelector(${JSON.stringify(editor("B"))}) !== null`);
        await a.waitForCondition<boolean>(`document.querySelector(${JSON.stringify(editor("A"))}) !== null`);

        // Type into B with a real click and insertText, caret left at the end.
        await b.nativeClickAtElement(editor("B"));
        await app.waitForCondition<boolean>(`window.__tug.getActiveCardId() === "B"`, { timeoutMs: 4000 });
        await b.evalJS<boolean>(`document.execCommand("insertText", false, ${JSON.stringify(TEXT)})`);
        await b.waitForCondition<boolean>(`${CARET_IN_B} === ${TEXT.length}`, { timeoutMs: 3000 });

        // Make A the active card.
        await a.nativeClickAtElement(editor("A"));
        await app.waitForCondition<boolean>(`window.__tug.getActiveCardId() === "A"`, { timeoutMs: 4000 });

        // One click into B's text, mid-line.
        const point = await b.evalJS<{ x: number; y: number }>(AIM_POINT);
        await b.nativeClick(point);
        await app.waitForCondition<boolean>(`window.__tug.getActiveCardId() === "B"`, { timeoutMs: 4000 });
        // B's window regaining focus is what used to put the old caret back
        // (synchronously and again a frame later); wait for it, then let the
        // frame-later pass land before reading.
        await b.waitForCondition<boolean>(`document.hasFocus() === true`, { timeoutMs: 4000 });
        await new Promise((r) => setTimeout(r, 500));
        const caret = await b.evalJS<number | null>(CARET_IN_B);
        note(`caret after the activating click: ${caret}`);
        expect(caret, "the caret sits where the click landed").toBe(AIM);
      } catch (err) {
        const tail = app.tailLog(120);
        if (tail !== "") process.stderr.write(`\n[at0897] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
