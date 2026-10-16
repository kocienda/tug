/**
 * text-card-manual-save-fixture.ts — the deck shape, selectors and gestures
 * the at0212-text-card-manual-save-* files share.
 *
 * Manual is the shipping default. Each file opens a real disk path so no
 * save lands in an NSSavePanel; edits go through
 * `document.execCommand("insertText")`, which runs the real beforeinput →
 * CM6 pipeline, as at0209 does.
 *
 * @module tests/app-test/text-card-manual-save-fixture
 */

import { expect } from "bun:test";
import type { App } from "./_harness";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 120_000;

export const CARD = '[data-card-id="A"]';
export const EDITOR_CONTENT = `${CARD} [data-slot="tug-text-card-editor"] .cm-content`;
// The save state rides the PANE's document masthead, not a cell inside the
// card — the title bar is not a descendant of the card element, so this is
// pane-scoped on purpose. Chrome follows the frontmost tab, so in the
// two-card cases below this selector reads whichever card is active.
export const SAVE_LINE = `[data-pane-id="p1"] [data-testid="card-masthead-detail"]`;
export const CLOSE_BUTTON = `[data-testid="tug-pane-close-button"]`;

export const ORIGINAL = "alpha\nbeta\ngamma\n";

export function deckShape() {
  return {
    cards: [{ id: "A", componentId: "text", title: "File", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 760, height: 560 },
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

export async function seedTextCard(
  app: App,
  filePath: string,
  mode: "manual" | "automatic" = "manual",
): Promise<void> {
  if (mode === "automatic") {
    await app.evalJS<null>(
      `(window.__tug.setTugbankValue("dev.tugapp.text-card","save-mode",{kind:"string",value:"automatic"}), null)`,
    );
  }
  await app.seedDeckState({
    state: deckShape(),
    cardStates: {
      A: { content: { path: filePath, anchor: { line: 1, ch: 0 }, scrollTop: 0 } },
    },
    focusCardId: "A",
  });
}

export async function waitForEditor(app: App, sentinel: string, timeoutMs = 15000): Promise<void> {
  await app.waitForCondition<boolean>(
    `(function(){
      var el = document.querySelector('${EDITOR_CONTENT}');
      return el !== null && el.innerText.indexOf(${JSON.stringify(sentinel)}) !== -1;
    })()`,
    { timeoutMs },
  );
}

export async function typeIntoEditor(app: App, text: string): Promise<void> {
  const ok = await app.evalJS<boolean>(
    `(function(){
      var el = document.querySelector('${EDITOR_CONTENT}');
      if (!el) return false;
      el.focus();
      return document.execCommand("insertText", false, ${JSON.stringify(text)});
    })()`,
  );
  if (!ok) throw new Error("[at0212] typeIntoEditor: insertText not handled");
}

export async function waitForSaveCell(app: App, want: string, timeoutMs = 15000): Promise<void> {
  await app.waitForCondition<boolean>(
    `(function(){
      var el = document.querySelector('${SAVE_LINE}');
      return el !== null && el.innerText.indexOf(${JSON.stringify(want)}) === 0;
    })()`,
    { timeoutMs },
  );
}

export async function saveCell(app: App): Promise<string> {
  return app.evalJS<string>(`document.querySelector('${SAVE_LINE}').innerText`);
}

/**
 * Let the app settle between synthetic gestures. Native clicks, control
 * dispatches, and sheet-button clicks each kick React renders, portal
 * mounts, and focus transfers that must commit before the next gesture —
 * firing them back-to-back races those transitions.
 */
export const settle = (ms = 450) => new Promise((r) => setTimeout(r, ms));

export async function dispatchControl(app: App, action: string): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.dispatchControlAction(${JSON.stringify(action)}), null)`,
  );
}

export async function waitMenuEnabled(app: App, id: string, want: boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: { found: boolean; enabled?: boolean } = { found: false };
  while (Date.now() < deadline) {
    last = await app.menuItemState(id);
    if (last.found && last.enabled === want) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(last.found, `${id} must exist`).toBe(true);
  expect(last.enabled, `${id} enabled=${want}`).toBe(want);
}

export async function waitSheetButton(app: App, result: string, timeoutMs = 15000): Promise<void> {
  await app.waitForCondition<boolean>(
    `document.querySelector('[data-testid="file-save-sheet-${result}"]') !== null`,
    { timeoutMs },
  );
}

// NSEvent.ModifierFlags: .command = 1<<20, .shift = 1<<17.
export const CMD_MASK = 1 << 20;
export const SHIFT_MASK = 1 << 17;
