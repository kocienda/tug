/**
 * at0752-session-atom-paste-caret.test.ts — typing after a pasted session
 * atom lands after it.
 *
 * ## What this gates
 *
 * Paste a session atom into an empty composer and the caret sits after the
 * chip. Type a character with a real keystroke and it has to land there too,
 * after the chip, not before it. The keystroke is typed only once the chip's
 * verdict has settled and repainted it, because that is the composer a user
 * types into a moment after pasting.
 *
 * @covers tugdeck/src/components/tugways/tug-text-editor/atom-decoration.ts
 * @covers tugdeck/src/components/tugways/tug-text-editor/session-dot-layer.tsx
 * @covers tugdeck/src/components/tugways/tug-text-editor.tsx
 * @covers tugdeck/src/lib/session-atom.ts
 * @covers tugdeck/src/lib/tug-atom-img.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";
import { waitForBodyReady } from "./_harness/card-reach";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const SESSION_ID = "a7c1d2e3-4b5a-4c6d-8e7f-9a0b1c2d3e4f";
const TAG = "brisk-otter";

const COMPOSER = '[data-card-id="A"] [data-slot="tug-text-editor"] .cm-content';
const CHIP = `${COMPOSER} img[data-atom-type="session"]`;

async function publishSessionUpdated(app: App, fields: Record<string, unknown>): Promise<void> {
  const row = JSON.stringify(JSON.stringify({ session_id: SESSION_ID, fields }));
  // card-dom: shell — the shell's ledger copy, beside the card's own.
  await app.evalJS<boolean>(`window.__tug.publishSessionUpdated(${row})`);
  await app.body("A").evalJS<boolean>(`window.__tug.publishSessionUpdated(${row})`);
}

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 20, y: 20 },
        size: { width: 700, height: 420 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["standard"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

/** The composer's lines, with each atom read as `[atom]`. */
const READ_LINE = `(function(){
  var cm = document.querySelector(${JSON.stringify(COMPOSER)});
  var out = "";
  cm.querySelectorAll('.cm-line').forEach(function (line) {
    var walk = document.createTreeWalker(line, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    var n;
    while ((n = walk.nextNode()) !== null) {
      if (n.nodeType === 3) out += n.textContent;
      else if (n.tagName === "IMG" && !n.classList.contains("cm-widgetBuffer")) out += "[atom]";
    }
  });
  return out.replace(/\\u200b/g, "");
})()`;

describe.skipIf(!SHOULD_RUN)("at0752 — typing after a pasted session atom", () => {
  test(
    "the first keystroke after the paste lands after the chip",
    async () => {
      const app = await launchTugApp({ testName: "at0752-session-atom-paste-caret" });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await waitForBodyReady(app, "A");
        await app.bindSession("A", {
          tugSessionId: SESSION_ID,
          projectDir: "/Users/tester/src/tugtool",
        });
        await publishSessionUpdated(app, { tag: TAG, name: null, name_user_set: false });
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(COMPOSER)}) !== null`,
          { timeoutMs: 20_000 },
        );

        // card-dom: shell — the copy is the shell's surface; the pasteboard is the app's.
        expect(
          await app.evalJS<boolean>(`window.__tug.copySessionAtom(${JSON.stringify(SESSION_ID)})`),
        ).toBe(true);

        // A's view is the window's first responder, as it is for a user
        // typing in it, so the keystroke reaches the page it is aimed at.
        await app.dispatchControlAction("focus-session-card", { cardId: "A" });
        const deadline = Date.now() + 5_000;
        while (!(await app.bodies()).some((b) => b.cardId === "A" && b.firstResponder === true)) {
          if (Date.now() > deadline) throw new Error("A's view never became the first responder");
          await Bun.sleep(50);
        }
        await app.body("A").focusElement(COMPOSER);
        await app.body("A").evalJS<null>(`(function(){
          var cm = document.querySelector(${JSON.stringify(COMPOSER)});
          cm.dispatchEvent(new ClipboardEvent("paste", {
            bubbles: true, cancelable: true, clipboardData: new DataTransfer(),
          }));
          return null;
        })()`);
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CHIP)}) !== null`,
          { timeoutMs: 8_000 },
        );
        // The harness session is on no machine, so the verdict turns the
        // chip's face from its first bake to `missing`. Type after that.
        await app.body("A").waitForCondition<boolean>(
          `(function(){
            var img = document.querySelector(${JSON.stringify(CHIP)});
            return img !== null && img.dataset.chipVariant === "missing";
          })()`,
          { timeoutMs: 8_000 },
        );

        await app.nativeType("x");
        await app.body("A").waitForCondition<boolean>(
          `${READ_LINE}.indexOf("x") !== -1`,
          { timeoutMs: 4_000 },
        );
        const line = await app.body("A").evalJS<string>(READ_LINE);
        note("at0752 composer line", JSON.stringify(line));
        expect(line).toBe("[atom]x");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
