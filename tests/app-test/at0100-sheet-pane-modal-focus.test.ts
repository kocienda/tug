/**
 * at0100-sheet-pane-modal-focus.test.ts — a sheet is PANE-modal, never
 * app-modal ([D15], pane-model). Its modality must NOT leak to other panes.
 *
 * Regression for a focus-trap leak: `TugSheet` wrapped its content in a Radix
 * `FocusScope trapped`, whose trap is DOCUMENT-GLOBAL — it redirects any focus
 * that lands outside the scope back into it, from anywhere. So a sheet open in
 * one pane blocked focusing a card in ANOTHER pane: clicking the other card's
 * input yanked focus back into the sheet, and only dismissing the sheet
 * restored it. Same-pane modality is (correctly) enforced by `inert` on the
 * sheet's own `.tug-pane-body`; the global trap was the leak, and is gone.
 *
 * Two panes: card A is a live dev session (with a prompt entry), card B opens
 * a sheet. With B's sheet open, clicking A's prompt entry must focus it — focus
 * lands in card A, not back inside card B's sheet.
 *
 * @covers tugdeck/src/components/tugways/tug-sheet.tsx
 * @covers tugdeck/src/components/tugways/focus-manager.ts
 * @covers tugdeck/src/components/chrome/pane-focus-controller.ts
 * @covers tugdeck/src/lib/sheet-lifecycle.ts
 * @covers tugdeck/src/components/tugways/cards/gallery-sheet.tsx
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SID_A = "at0100-card-a";
const FEED_CODE_OUTPUT = 0x40;

const PROMPT_A = '[data-card-id="A"] [data-slot="tug-text-editor"] .cm-content';
const TRIGGER_B = '[data-card-id="B"] [data-testid="gallery-sheet-trigger"]';
const SHEET = '[data-slot="tug-sheet"]';

function deckShape() {
  return {
    cards: [
      { id: "A", componentId: "session", title: "Session", closable: true },
      { id: "B", componentId: "gallery-sheet", title: "Sheet Gallery", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 720, height: 600 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
      {
        id: "p2",
        position: { x: 820, y: 40 },
        size: { width: 720, height: 600 },
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

describe.skipIf(!SHOULD_RUN)("AT0100: a sheet is pane-modal — no cross-pane focus trap", () => {
  test(
    "a sheet open in pane 2 does not block focusing the dev prompt in pane 1",
    async () => {
      const app = await launchTugApp({ testName: "at0100-sheet-pane-modal-focus" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A") && window.__tug.assertHostRootRegistered("B")`,
        );

        // Card A: a live dev session with a committed turn, so its prompt entry
        // is present (an unbound card would show its own picker sheet instead).
        await app.bindSession("A", { tugSessionId: SID_A });
        await app.awaitEngineReady("A");
        const frame = (decoded: Record<string, unknown>) =>
          app.driveSession("A", {
            op: "ingestFrame",
            feedId: FEED_CODE_OUTPUT,
            decoded: { tug_session_id: SID_A, ...decoded },
          });
        await app.driveSession("A", { op: "send", text: "hello" });
        await frame({ type: "content_block_start", msg_id: "m1", block_index: 0, kind: "text" });
        await frame({ type: "assistant_text", msg_id: "m1", block_index: 0, text: "hi", is_partial: false });
        await frame({ type: "turn_complete", msg_id: "m1", result: "success" });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PROMPT_A)}) !== null`,
          { timeoutMs: 8000 },
        );

        // Open a sheet in card B (pane 2).
        await app.nativeClickAtElement(TRIGGER_B);
        await app.waitForCondition<boolean>(
          `(function(){
             var el = document.querySelector(${JSON.stringify(SHEET)});
             if (!el) return false;
             var r = el.getBoundingClientRect();
             return r.width > 0 && r.height > 0;
           })()`,
          { timeoutMs: 6000 },
        );

        // Click card A's prompt entry. With B's sheet open, focus must land in
        // card A — NOT get yanked back into the sheet (the cross-pane leak).
        await app.nativeClickAtElement(PROMPT_A);
        await app.waitForCondition<boolean>(
          `(function(){
             var ae = document.activeElement;
             var cardA = document.querySelector('[data-card-id="A"]');
             return cardA !== null && ae !== null && cardA.contains(ae);
           })()`,
          { timeoutMs: 4000 },
        );

        const probe = await app.evalJS<{ inCardA: boolean; inSheet: boolean }>(
          `(function(){
             var ae = document.activeElement;
             var cardA = document.querySelector('[data-card-id="A"]');
             var sheet = document.querySelector(${JSON.stringify(SHEET)});
             return {
               inCardA: cardA !== null && ae !== null && cardA.contains(ae),
               inSheet: sheet !== null && ae !== null && sheet.contains(ae),
             };
           })()`,
        );
        expect(probe.inSheet).toBe(false); // not yanked into pane 2's sheet
        expect(probe.inCardA).toBe(true); // focus stayed in pane 1's card
        // And the sheet is still open — A's focus didn't dismiss B's modality.
        expect(
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
          ),
        ).toBe(true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
