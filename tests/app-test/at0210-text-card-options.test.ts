/**
 * at0210-text-card-options.test.ts — Text card masthead + editor options
 * ([AT0210]): open a real file, then drive the title bar's Editor Options
 * sheet and assert each toggle reconfigures the live CodeMirror 6 editor.
 *
 * Scenario: seed a Text card bound to a real temp fixture, assert the pane's
 * document masthead names the file and its path and that the editor mounts
 * with the default line-number gutter. Press the title bar's gear button,
 * toggle Line numbers off (the CM6 `lineNumbers` compartment drops
 * the gutter), then toggle Soft wrap on (the `lineWrapping` compartment adds
 * `.cm-lineWrapping`). Every step drives the real settings → CM6 reconfigure
 * path on a real file — no mocks.
 *
 * The masthead lives in the pane's title bar, which the card draws in its own
 * page beside the card element, so its selectors are read in the card's page
 * and are not card-scoped.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/cards/card-settings-sheet.tsx
 * @covers tugdeck/src/components/tugways/cards/text-card-controls.tsx
 * @covers tugdeck/src/lib/text-card-settings.ts
 * @covers tugdeck/src/lib/use-text-card-settings.ts
 * @covers tugdeck/src/components/tugways/tug-text-card-editor/
 * @covers tugdeck/src/components/tugways/cards/text-card-status-bar.tsx
 * @covers tugdeck/src/components/tugways/cards/text-card.tsx
 * @covers tugdeck/src/components/tugways/tug-text-card-editor.css
 * @covers tugdeck/src/components/tugways/tug-text-card-editor.tsx
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { launchTugApp, type App } from "./_harness";
import { kindBody } from "./_harness/card-reach";
import { mkTextFixture } from "./_harness/fixtures";
import { AUTOMATIC_SAVE_MODE, mkSeededTugbank } from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CARD = '[data-card-id="A"]';
const EDITOR_CONTENT = `${CARD} [data-slot="tug-text-card-editor"] .cm-content`;
const LINE_NUMBERS = `${CARD} [data-slot="tug-text-card-editor"] .cm-lineNumbers`;
// The masthead and the title-bar buttons are the pane's, not the card's — the
// title bar is a sibling of the card element in the card's page, which holds
// the one pane, so a card-scoped prefix matches nothing here and no pane
// scope is needed.
const MASTHEAD_TITLE = '[data-testid="card-masthead-title"]';
const MASTHEAD_DESCRIPTION = '[data-testid="card-masthead-description"]';
const MASTHEAD_DETAIL = '[data-testid="card-masthead-detail"]';
const OPTIONS_BUTTON = '[data-testid="tug-pane-title-bar-item-show-card-settings"]';
const REVEAL_BUTTON = '[data-testid="tug-pane-title-bar-item-reveal-card-file"]';
const OPTIONS_PANEL = '[data-testid="text-card-options"]';
// Scoped to the sheet: the same option testids also appear in the
// Settings card's Text Card tab (shared TextCardControls).
const LINE_NUMBERS_SWITCH = `${OPTIONS_PANEL} [data-testid="text-card-option-line-numbers"]`;
const LINE_WRAP_SWITCH = `${OPTIONS_PANEL} [data-testid="text-card-option-line-wrap"]`;

const FIXTURE_CONTENT =
  Array.from({ length: 12 }, (_, i) => `fixture line ${i + 1}`).join("\n") + "\n";

/** A fixture whose newlines are CRLF (Windows). */
function mkCrlfFixture(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "at0210-crlf-"));
  const file = path.join(dir, "windows.txt");
  const crlf =
    Array.from({ length: 6 }, (_, i) => `line ${i + 1}`).join("\r\n") + "\r\n";
  fs.writeFileSync(file, crlf, "utf8");
  return { dir, file };
}

/** Type into the editor through CM6's real beforeinput pipeline. */
async function typeIntoEditor(app: App, text: string): Promise<void> {
  await app.body("A").evalJS<boolean>(
    `(function(){
      var el = document.querySelector(${JSON.stringify(EDITOR_CONTENT)});
      if (!el) return false;
      el.focus();
      return document.execCommand("insertText", false, ${JSON.stringify(text)});
    })()`,
  );
}

/** Poll the real file on disk until `predicate` holds. */
async function waitForDisk(
  file: string,
  predicate: (content: string) => boolean,
  timeoutMs = 8000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    last = fs.readFileSync(file, "utf8");
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`[at0210] disk predicate unmet in ${timeoutMs}ms; last:\n${last.slice(0, 200)}`);
}

async function seedTextCard(app: App, filePath: string): Promise<void> {
  // Manual is the shipping default ([P01]); this test's clean-file "Saved"
  // cell and the CRLF-autosave scenario are automatic-mode behaviors. The
  // card reads the mode from its own page's tugbank snapshot, so the launch
  // seeds it into the tugbank (`AUTOMATIC_SAVE_MODE`) before the app opens.
  await app.seedDeckState({
    state: {
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
    },
    cardStates: {
      A: { content: { path: filePath, anchor: { line: 1, ch: 0 }, scrollTop: 0 } },
    },
    focusCardId: "A",
  });
}

const WRAP_STATE = `(() => {
  const el = document.querySelector(${JSON.stringify(EDITOR_CONTENT)});
  return el !== null && el.classList.contains("cm-lineWrapping");
})()`;

/**
 * Press the title bar's gear — the card's own Editor Options button. The
 * press dispatches the command key-card routed, so the sheet opens wherever
 * focus happens to sit.
 */
async function pressEditorOptions(app: App): Promise<void> {
  await app.body("A").waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(OPTIONS_BUTTON)}) !== null`,
    { timeoutMs: 8000 },
  );
  // The gear rests inside the pane's rollup, revealed on a title-bar hover.
  // Pin the row open first or the press lands on the bar behind it.
  await app.body("A").revealPaneControls();
  await app.body("A").nativeClickAtElement(OPTIONS_BUTTON);
}

describe.skipIf(!SHOULD_RUN)("at0210: Text card masthead + editor options", () => {
  test(
    "the masthead names the file; the gear's options reconfigure the live editor",
    async () => {
      const { dir, file } = mkTextFixture("at0210-", FIXTURE_CONTENT);
      const app = await launchTugApp({
        testName: "at0210-text-card-options",
        env: { TUGBANK_PATH: mkSeededTugbank([AUTOMATIC_SAVE_MODE]) },
      });
      try {
        await seedTextCard(app, file);

        // Editor mounts with the fixture content.
        await app.body("A").waitForCondition<boolean>(
          `(function(){
            var el = document.querySelector(${JSON.stringify(EDITOR_CONTENT)});
            return el !== null && el.innerText.indexOf("fixture line 1") !== -1;
          })()`,
          { timeoutMs: 15000 },
        );

        // The pane's masthead names the file, says where it lives, and — on
        // its third line — how it stands with the disk. A freshly loaded file
        // is clean, so the save state reads "Saved".
        expect(
          await app.body("A").evalJS<string>(
            `document.querySelector(${JSON.stringify(MASTHEAD_TITLE)}).innerText`,
          ),
        ).toBe("sample.txt");
        expect(
          await app.body("A").evalJS<string>(
            `document.querySelector(${JSON.stringify(MASTHEAD_DESCRIPTION)}).innerText`,
          ),
        ).toContain("sample.txt");
        const saveLine = await app.body("A").evalJS<string>(
          `document.querySelector(${JSON.stringify(MASTHEAD_DETAIL)}).innerText`,
        );
        expect(saveLine.startsWith("Saved")).toBe(true);

        // The bottom status bar keeps the settable pair and the caret; the
        // save state is no longer one of its cells.
        expect(
          await app.body("A").evalJS<number>(
            `document.querySelectorAll('${CARD} [data-testid="text-card-status-save"]').length`,
          ),
        ).toBe(0);
        const statusText = await app.body("A").evalJS<string>(
          `document.querySelector('${CARD} [data-slot="text-card-status-bar"]').innerText`,
        );
        // The settable popups render their current values (file type +
        // line ending).
        expect(statusText).toContain("Plain Text");
        expect(statusText).toContain("Unix (LF)");
        const caretCell = await app.body("A").evalJS<string>(
          `document.querySelector('${CARD} [data-testid="text-card-status-caret"]').innerText`,
        );
        expect(caretCell).toContain("L: 1");

        // Default settings: line-number gutter present, soft wrap on. A card
        // is a column of text in a window the user sizes, so a fresh one never
        // scrolls sideways — the first attachment link would put it there.
        expect(
          await app.body("A").evalJS<boolean>(
            `document.querySelector(${JSON.stringify(LINE_NUMBERS)}) !== null`,
          ),
        ).toBe(true);
        expect(await app.body("A").evalJS<boolean>(WRAP_STATE)).toBe(true);

        // Open the options through the title bar's gear button.
        await pressEditorOptions(app);
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(OPTIONS_PANEL)}) !== null`,
          { timeoutMs: 15000 },
        );

        // Toggle Line numbers off → the CM6 gutter drops.
        await app.body("A").nativeClickAtElement(LINE_NUMBERS_SWITCH);
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(LINE_NUMBERS)}) === null`,
          { timeoutMs: 15000 },
        );

        // Toggle Soft wrap off → the CM6 content loses cm-lineWrapping.
        await app.body("A").nativeClickAtElement(LINE_WRAP_SWITCH);
        await app.body("A").waitForCondition<boolean>(`${WRAP_STATE} === false`, {
          timeoutMs: 15000,
        });
        expect(await app.body("A").evalJS<boolean>(WRAP_STATE)).toBe(false);

        // Done puts the sheet away. Every control wrote as it was touched, so
        // there is nothing to confirm — but a sheet with no way out but
        // Escape is a sheet a reader can be stuck in.
        await app.body("A").nativeClickAtElement('[data-testid="card-settings-done"]');
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(OPTIONS_PANEL)}) === null`,
          { timeoutMs: 10000 },
        );

        // A bound card's Reveal button is live — the dimmed case is the next
        // test, on a buffer that is not a file yet.
        expect(
          await app.body("A").evalJS<boolean>(
            `document.querySelector(${JSON.stringify(REVEAL_BUTTON)}).disabled`,
          ),
        ).toBe(false);
      } finally {
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "an untitled draft keeps its Reveal button, dimmed, and says why",
    async () => {
      const app = await launchTugApp({ testName: "at0210-untitled-reveal" });
      try {
        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("new-text-card", {}), null)`,
        );
        // The draft's card id is minted by the deck, so its body is found by kind.
        const body = kindBody(app, "text");
        await body.waitForCondition<boolean>(
          `document.querySelector('[data-slot="tug-text-card-editor"]') !== null`,
          { timeoutMs: 15000 },
        );

        // The button is THERE. It would have been simpler to publish it only
        // for a bound card, and that is exactly what makes the cluster
        // unlearnable: the gear and the width control would sit at different
        // places on a draft than on a saved file, and would jump sideways the
        // instant it was saved.
        const REVEAL = '[data-testid="tug-pane-title-bar-item-reveal-card-file"]';
        await body.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(REVEAL)}) !== null`,
          { timeoutMs: 10000 },
        );

        // And it is dimmed, because there is no file for the Finder to
        // select. The answer comes from the command table asking this card,
        // not from the card asserting it.
        expect(
          await body.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(REVEAL)}).disabled`,
          ),
        ).toBe(true);

        // The reason is reachable. A disabled `.tug-button` takes
        // `pointer-events: none`, so the bubble hangs on the anchoring span —
        // hovering the button itself would tell the reader nothing.
        const anchor = `document.querySelector(${JSON.stringify(REVEAL)}).closest('.tug-pane-title-bar-tooltip-anchor')`;
        expect(await body.evalJS<boolean>(`${anchor} !== null`)).toBe(true);
        await body.evalJS<null>(
          `(function () {
             var el = ${anchor};
             var opts = { bubbles: true, cancelable: true, pointerType: "mouse" };
             el.dispatchEvent(new PointerEvent("pointerenter", opts));
             el.dispatchEvent(new PointerEvent("pointermove", opts));
             return null;
           })()`,
        );
        await body.waitForCondition<boolean>(
          `document.querySelector('[data-slot="tug-tooltip"]') !== null`,
          { timeoutMs: 8000 },
        );
        expect(
          await body.evalJS<string>(
            `document.querySelector('[data-slot="tug-tooltip"]').innerText.trim()`,
          ),
        ).toContain("No file");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "autosave preserves a file's CRLF line endings on write",
    async () => {
      const { dir, file } = mkCrlfFixture();
      const app = await launchTugApp({
        testName: "at0210-crlf",
        env: { TUGBANK_PATH: mkSeededTugbank([AUTOMATIC_SAVE_MODE]) },
      });
      try {
        await seedTextCard(app, file);
        await app.body("A").waitForCondition<boolean>(
          `(function(){
            var el = document.querySelector(${JSON.stringify(EDITOR_CONTENT)});
            return el !== null && el.innerText.indexOf("line 1") !== -1;
          })()`,
          { timeoutMs: 15000 },
        );

        // The status bar detected the file's newline style.
        const statusText = await app.body("A").evalJS<string>(
          `document.querySelector('${CARD} [data-slot="text-card-status-bar"]').innerText`,
        );
        expect(statusText).toContain("Windows (CRLF)");

        // Word count (middle of "lines / words / characters") before edit.
        const wordsBefore = await app.body("A").evalJS<number>(
          `parseInt(document.querySelector('${CARD} [data-testid="text-card-status-counts"]').innerText.split("/")[1].replace(/[^0-9]/g,""), 10)`,
        );

        // Type an edit → autosave writes. CM6 normalizes to \n
        // internally, so the store must re-serialize to CRLF at the
        // write boundary; the file must NOT be flattened to LF.
        await typeIntoEditor(app, "EDIT ");

        // The incremental word count picked up the one new word.
        await app.body("A").waitForCondition<boolean>(
          `parseInt(document.querySelector('${CARD} [data-testid="text-card-status-counts"]').innerText.split("/")[1].replace(/[^0-9]/g,""), 10) === ${wordsBefore + 1}`,
          { timeoutMs: 8000 },
        );

        const disk = await waitForDisk(file, (c) => c.includes("EDIT"));
        expect(disk.includes("\r\n")).toBe(true);
        // No bare LF: every "\n" is part of a "\r\n".
        expect(disk.split("\r\n").length).toBe(disk.split("\n").length);
      } finally {
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
