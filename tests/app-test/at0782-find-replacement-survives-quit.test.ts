/**
 * at0782-find-replacement-survives-quit.test.ts — a replacement typed just
 * before a quit is on disk after it ([AT0782]).
 *
 * ## Why this exists
 *
 * The replacement field persists to the deck-wide find preference through a
 * debounced write. A quit inside that debounce would drop it, so the teardown
 * core writes the value the debounce is still holding — the shell's
 * `teardownSave` and a card body's `saveNow` alike, since the Text card's bar
 * types its replacement in the card's own page.
 *
 * ## Test matrix (one launch over its own tugbank and temp file)
 *
 *   1. Find and Replace… opens the Text card's bar; a replacement is typed
 *      and the app quits at once; the replacement is in the tugbank after.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/settings-api.ts
 * @covers tugdeck/src/teardown.ts
 * @covers tugdeck/src/body/body-card-deck.ts
 * @covers tugdeck/src/lib/create-find-session.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchTugApp, type App, type BodyApp } from "./_harness";
import { waitForBodyReady } from "./_harness/card-reach";
import { mkTempTugbank, rmTempTugbank, tugbankRead } from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

let dir = "";
let filePath = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  dir = mkdtempSync(join(tmpdir(), "at0782-"));
  filePath = join(dir, "notes.txt");
  writeFileSync(filePath, ["alpha meridian one", "beta meridian two"].join("\n"));
});

afterAll(() => {
  if (dir === "" || !existsSync(dir)) return;
  rmSync(dir, { recursive: true, force: true });
});

const EDITOR = `[data-card-id="A"] [data-slot="tug-text-card-editor"] .cm-content`;
const BAR = `[data-card-id="A"] [data-slot="text-card-find-bar"]`;
const REPLACEMENT = `${BAR} [data-testid="text-card-replace-input"] .cm-content`;

/** Wait until the caret is inside `selector`. */
async function waitCaretIn(body: BodyApp, selector: string): Promise<void> {
  await body.waitForCondition<boolean>(
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      return el !== null && document.activeElement !== null && el.contains(document.activeElement);
    })()`,
    { timeoutMs: 4000 },
  );
}

describe.skipIf(!SHOULD_RUN)("AT0782: a replacement typed just before a quit survives it", () => {
  test(
    "the teardown core writes the debounced replacement before the page goes",
    async () => {
      const tugbankPath = mkTempTugbank();
      try {
        const app: App = await launchTugApp({
          testName: "at0782-replacement-at-quit",
          env: { TUGBANK_PATH: tugbankPath },
          persistInTestMode: true,
        });
        try {
          await app.seedDeckState({
            state: {
              cards: [{ id: "A", componentId: "text", title: "Notes", closable: true }],
              panes: [
                {
                  id: "p1",
                  position: { x: 20, y: 30 },
                  size: { width: 560, height: 420 },
                  cardIds: ["A"],
                  activeCardId: "A",
                  title: "",
                  acceptsFamilies: ["maker"],
                },
              ],
              activePaneId: "p1",
              hasFocus: true,
            },
            cardStates: {
              A: { content: { path: filePath, anchor: { line: 1, ch: 0 }, scrollTop: 0 } },
            },
            focusCardId: "A",
          });
          const a = await waitForBodyReady(app, "A");
          await a.waitForCondition<boolean>(
            `(document.querySelector(${JSON.stringify(EDITOR)})?.innerText ?? "").indexOf("alpha meridian") !== -1`,
            { timeoutMs: 15_000 },
          );
          await a.nativeClickAtElement(EDITOR);
          const opened = await app.performMenuItem("edit.findAndReplace");
          expect(opened.found && opened.performed, "Find and Replace… performs").toBe(true);
          await a.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(REPLACEMENT)}) !== null`,
            { timeoutMs: 4000 },
          );
          // The field seeds from the remembered replacement, and the temp
          // tugbank holds none, so it starts empty.
          await a.nativeClickAtElement(REPLACEMENT);
          await waitCaretIn(a, REPLACEMENT);
          await app.nativeType("survivor");
          await a.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(`${REPLACEMENT} .cm-line`)})?.textContent === "survivor"`,
            { timeoutMs: 4000 },
          );
        } finally {
          // Straight to the quit: the replacement's write is still inside its
          // debounce, and only the teardown core can put it on disk now.
          await app.quitGracefully();
        }
        const onDisk = tugbankRead<string>(tugbankPath, "dev.tugapp.find", "replacement");
        expect(onDisk?.value, "the replacement typed before the quit is on disk").toBe("survivor");
      } finally {
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
