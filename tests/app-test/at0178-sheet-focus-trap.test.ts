/**
 * at0178-sheet-focus-trap.test.ts — opening a sheet pushes a focus-trap mode;
 * dismissing it pops the mode and restores the key view to the opener.
 *
 * Step 4 of the keyboard-access plan wires the CFRunLoop-style focus trap
 * ([#cfrunloop-model]) into TugSheet via `useFocusTrap`: while a sheet is open a
 * trapped focus mode is current — projected onto the document root as
 * `data-focus-mode` — and on dismiss the mode is popped and the key view
 * returns to the element that was current when the sheet opened.
 *
 * Driven through the session card's permission sheet (a TugSheet opened by clicking
 * the Mode chip):
 *   - open  → `data-focus-mode` present on <html>, and the sheet is shown;
 *   - Escape → sheet closes, `data-focus-mode` removed, and the key view is
 *     back inside the card.
 *
 * Has teeth: without the trap wiring, `data-focus-mode` never appears (the push
 * assertion fails); without the pop, it never clears (the dismiss assertion
 * fails). The trap mechanism itself — mode filtering, wrap, key-view
 * capture/restore — is pinned in the pure-logic `focus-walk.test.ts`.
 *
 * @covers tugdeck/src/components/tugways/tug-sheet.tsx
 * @covers tugdeck/src/components/tugways/focus-manager.ts
 * @covers tugdeck/src/lib/sheet-lifecycle.ts
 * @covers tugdeck/src/components/tugways/cards/ai-chip.tsx
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp } from "./_harness";
import { sessionCardShape, SESSION_CARD_SIZE_COMPACT } from "./_harness/shapes";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SID = "at0178-session";

const CARD = '[data-card-id="A"]';
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const MODE_CHIP = `${CARD} [data-slot="ai-chip"]`;
const SHEET = '[data-slot="tug-sheet"]';

const HAS_FOCUS_MODE = `document.documentElement.hasAttribute("data-focus-mode")`;
const KEY_VIEW_IN_CARD = `(function(){ var kv = document.querySelector("[data-key-view]"); var card = document.querySelector(${JSON.stringify(CARD)}); return kv !== null && card !== null && card.contains(kv); })()`;

describe.skipIf(!SHOULD_RUN)("AT0178: sheet pushes/pops a focus-trap mode", () => {
  test(
    "opening the permission sheet pushes data-focus-mode; Escape pops it and restores the key view",
    async () => {
      const app = await launchTugApp({ testName: "at0178-sheet-focus-trap" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: sessionCardShape(SESSION_CARD_SIZE_COMPACT), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A", { tugSessionId: SID });
        await app.awaitEngineReady("A");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(MODE_CHIP)}) !== null`,
          { timeoutMs: 8000 },
        );

        // Focus the card so the key view sits inside it, and no trap is active.
        await app.nativeClickAtElement(PROMPT_INPUT);
        await app.waitForCondition<boolean>(KEY_VIEW_IN_CARD, { timeoutMs: 6000 });
        const beforeFocusMode = await app.evalJS<boolean>(HAS_FOCUS_MODE);
        expect(beforeFocusMode).toBe(false);

        // Open the AI configuration sheet (clicking the AI chip) → a trap mode
        // is pushed and the sheet is shown.
        await app.nativeClickAtElement(MODE_CHIP);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
          { timeoutMs: 6000 },
        );
        await app.waitForCondition<boolean>(HAS_FOCUS_MODE, { timeoutMs: 4000 });

        // Escape dismisses the sheet → the trap mode pops and the key view
        // returns to the card.
        await app.nativeKey("Escape");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHEET)}) === null`,
          { timeoutMs: 6000 },
        );
        await app.waitForCondition<boolean>(`!(${HAS_FOCUS_MODE})`, { timeoutMs: 4000 });
        await app.waitForCondition<boolean>(KEY_VIEW_IN_CARD, { timeoutMs: 4000 });
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
