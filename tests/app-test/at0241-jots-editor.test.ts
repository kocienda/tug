/**
 * at0241-jots-editor.test.ts — the Jots card's editor round-trip on the CM6
 * substrate: Enter on the cursor row opens the in-place editor (descend into
 * the row's focusable wrapper, DOM focus forwarded into the CM6 caret), typing
 * lands in the document, and Escape ascends back to the list with the edit
 * committed (blur-commit).
 *
 * Also covers the row-click focus route: clicking a row lands the keyboard key
 * view on the card's list, and the `new-jot` capture gesture (⌘J's wire):
 * reveal the card if hidden, create a jot, land the caret in its editor.
 *
 * Runs against an isolated jots file (`TUG_JOTS_PATH`) so the user's
 * machine-global jots.json is never touched.
 *
 * Scenario:
 *   1. Seed one jot; open the Jots card; click the row — the jots list takes
 *      the keyboard key view.
 *   2. Enter → the row's editor mounts and the CM6 content holds DOM focus.
 *   3. Type — the text lands in the editor document.
 *   4. Escape → the editor closes, the list regains the key view, and the
 *      committed row shows the updated incipit.
 *
 * @covers tugdeck/src/components/jots/jots-card.tsx
 * @covers tugdeck/src/lib/jots-store.ts
 * @covers tugdeck/src/lib/jots-doc.ts
 * @covers tugdeck/src/components/tugways/tug-text-editor/
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, type App } from "./_harness";
import { priorCardDeck } from "./_harness/shapes";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const JOTS_KBD = `.jots-card .jots-list[data-key-view-kbd]`;
const EDITOR = `.jots-list .jot-editor`;

async function dispatch(app: App, action: string): Promise<void> {
  await app.dispatchControlAction(action);
}

async function exists(app: App, selector: string): Promise<boolean> {
  return app.evalJS<boolean>(
    `document.querySelector(${JSON.stringify(selector)}) !== null`,
  );
}

describe.skipIf(!SHOULD_RUN)("at0241 — Jots card editor round-trip", () => {
  test(
    "band-click focuses the list; Enter opens the CM6 editor; Escape commits back",
    async () => {
      const tugbankPath = mkTempTugbank();
      const jotsDir = mkdtempSync(join(tmpdir(), "tug-at0241-"));
      const jotsPath = join(jotsDir, "jots.json");
      writeFileSync(
        jotsPath,
        `${JSON.stringify(
          { version: 1, jots: [{ id: "s1", text: "There is a tide" }] },
          null,
          2,
        )}\n`,
      );
      try {
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0241-jots-editor",
          env: { TUGBANK_PATH: tugbankPath, TUG_JOTS_PATH: jotsPath },
          persistInTestMode: true,
        });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: priorCardDeck(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 5_000 },
          );
          // 1. Open the Jots card; the seeded jot row renders; click the
          //    row → the jots list takes the keyboard key view.
          await dispatch(app, "toggle-jots");
          await app.waitForCondition<boolean>(
            `Array.from(document.querySelectorAll('.jot-row-label'))
               .some((el) => el.textContent === 'There is a tide')`,
            { timeoutMs: 5_000 },
          );
          await app.nativeClickAtElement(".jots-card .jot-row-label");
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(JOTS_KBD)}) !== null`,
            { timeoutMs: 3_000 },
          );

          // 2. Enter on the cursor row → the editor mounts and the CM6
          //    content receives DOM focus (the wrapper forwards it).
          await app.nativeKey("Return");
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(EDITOR)}) !== null`,
            { timeoutMs: 3_000 },
          );
          await app.waitForCondition<boolean>(
            `document.activeElement !== null &&
             document.activeElement.closest(${JSON.stringify(EDITOR)}) !== null`,
            { timeoutMs: 3_000 },
          );

          // 3. The editor opened pre-seeded with the jot's existing text
          //    (the data-loss regression guard — an empty editor here would
          //    clobber the jot on the next edit).
          expect(
            await app.evalJS<boolean>(
              `(() => {
                 const content = document.querySelector('${EDITOR} .cm-content');
                 return content !== null &&
                   (content.textContent ?? '').includes('There is a tide');
               })()`,
            ),
          ).toBe(true);

          // Type at the caret — the keystrokes land in the CM6 document
          // alongside the seeded text.
          await app.nativeType(" in the affairs");
          await app.waitForCondition<boolean>(
            `(() => {
               const content = document.querySelector('${EDITOR} .cm-content');
               const text = content?.textContent ?? '';
               return text.includes('in the affairs') && text.includes('There is a tide');
             })()`,
            { timeoutMs: 3_000 },
          );

          // 4. Escape → ascend to the list (key view back on the container),
          //    editor unmounts, and the committed incipit reflects the edit.
          await app.nativeKey("Escape");
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(EDITOR)}) === null`,
            { timeoutMs: 3_000 },
          );
          expect(await exists(app, JOTS_KBD)).toBe(true);
          await app.waitForCondition<boolean>(
            `Array.from(document.querySelectorAll('.jot-row-label'))
               .some((el) => (el.textContent ?? '').includes('in the affairs'))`,
            { timeoutMs: 3_000 },
          );
        } finally {
          await app.close();
        }
      } finally {
        rmSync(jotsDir, { recursive: true, force: true });
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "Space creates a new jot below the cursor and opens it",
    async () => {
      const tugbankPath = mkTempTugbank();
      const jotsDir = mkdtempSync(join(tmpdir(), "tug-at0241b-"));
      const jotsPath = join(jotsDir, "jots.json");
      writeFileSync(
        jotsPath,
        `${JSON.stringify(
          { version: 1, jots: [{ id: "s1", text: "There is a tide" }] },
          null,
          2,
        )}\n`,
      );
      try {
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0241-jots-space",
          env: { TUGBANK_PATH: tugbankPath, TUG_JOTS_PATH: jotsPath },
          persistInTestMode: true,
        });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: priorCardDeck(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 5_000 },
          );
          await dispatch(app, "toggle-jots");
          await app.waitForCondition<boolean>(
            `Array.from(document.querySelectorAll('.jot-row-label'))
               .some((el) => el.textContent === 'There is a tide')`,
            { timeoutMs: 5_000 },
          );
          await app.nativeClickAtElement(".jots-card .jot-row-label");
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(JOTS_KBD)}) !== null`,
            { timeoutMs: 3_000 },
          );

          // Space on the list (the Things-style gesture) creates a new jot
          // below the cursor and opens its editor — an empty CM6 field.
          await app.nativeKey(" ");
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(EDITOR)}) !== null`,
            { timeoutMs: 3_000 },
          );
          // Two rows now exist (the original + the new one), and the open
          // editor is a FRESH empty jot — CM6 shows its placeholder only
          // while the document is empty, so its presence proves the new row
          // carries no text (not a copy of the seeded jot).
          expect(
            await app.evalJS<number>(
              `document.querySelectorAll('.jots-list .jot-row-content, .jots-list .jot-editor').length`,
            ),
          ).toBe(2);
          expect(
            await app.evalJS<boolean>(
              `document.querySelector('${EDITOR} .cm-content .cm-placeholder') !== null`,
            ),
          ).toBe(true);
        } finally {
          await app.close();
        }
      } finally {
        rmSync(jotsDir, { recursive: true, force: true });
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "new-jot reveals the hidden card, creates a jot, and lands the caret",
    async () => {
      const tugbankPath = mkTempTugbank();
      const jotsDir = mkdtempSync(join(tmpdir(), "tug-at0241c-"));
      const jotsPath = join(jotsDir, "jots.json");
      writeFileSync(
        jotsPath,
        `${JSON.stringify({ version: 1, jots: [] }, null, 2)}\n`,
      );
      try {
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0241-new-jot",
          env: { TUGBANK_PATH: tugbankPath, TUG_JOTS_PATH: jotsPath },
          persistInTestMode: true,
        });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: priorCardDeck(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 5_000 },
          );
          // The deck holds no Jots card — capture has to build its own
          // surface. `new-jot` is the wire ⌘J's menu item sends, so this is
          // the chord's path minus AppKit's key-equivalent lookup (which
          // at0168 and at0181 cover).
          expect(await exists(app, ".jots-card")).toBe(false);
          await dispatch(app, "new-jot");

          // The rail appears with exactly one row, and that row is an OPEN
          // editor rather than a settled label — one gesture, caret included.
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(EDITOR)}) !== null`,
            { timeoutMs: 5_000 },
          );
          expect(
            await app.evalJS<number>(
              `document.querySelectorAll('.jots-list .jot-row-content, .jots-list .jot-editor').length`,
            ),
          ).toBe(1);
          // A fresh jot, not a resurrected one: CM6 shows its placeholder
          // only while the document is empty.
          expect(
            await app.evalJS<boolean>(
              `document.querySelector('${EDITOR} .cm-content .cm-placeholder') !== null`,
            ),
          ).toBe(true);
          // DOM focus is inside the CM6 content — typing goes to the jot
          // without any further gesture.
          await app.waitForCondition<boolean>(
            `document.activeElement !== null &&
             document.activeElement.closest(${JSON.stringify(EDITOR)}) !== null`,
            { timeoutMs: 3_000 },
          );
          await app.nativeType("brevity");
          await app.waitForCondition<boolean>(
            `(document.querySelector('${EDITOR} .cm-content')?.textContent ?? '')
               .includes('brevity')`,
            { timeoutMs: 3_000 },
          );
        } finally {
          await app.close();
        }
      } finally {
        rmSync(jotsDir, { recursive: true, force: true });
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
