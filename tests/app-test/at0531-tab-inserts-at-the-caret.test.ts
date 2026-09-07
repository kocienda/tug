/**
 * at0531-tab-inserts-at-the-caret.test.ts — Tab indents where the caret is
 * ([AT0531]), in both CM6 editing surfaces, under both tab policies.
 *
 * The defect this pins: both editors bound CM6's `indentWithTab`, which runs
 * `indentMore` — a BLOCK-indent command that inserts the indent unit at the
 * **line's start** no matter where the caret sits. Pressing Tab after `ab`
 * put the spaces before the `a`, so "Auto-expand tabs" and "Spaces per tab"
 * looked inert: their only visible effect was at column zero. `tugInsertTab`
 * replaces it — a ranged selection still block-indents (that is what
 * `indentMore` is for), a plain caret inserts at the caret.
 *
 * Scenarios, all driven through real key events on a real file:
 *
 *   1. **Soft tabs advance to the next STOP, at the reader's width.** The
 *      card is seeded with a "Spaces per tab" of 3 — deliberately not the
 *      default — so a caret at column 2 owes ONE space and a caret at
 *      column 4 owes two. A width the setting did not reach, or an insert
 *      that ignored the caret's column, gets a different answer to both.
 *      Asserted on the bytes on disk.
 *   2. **Hard tabs insert a literal tab at the caret.** Toggling
 *      "Auto-expand tabs" off through the card's own gear sheet changes what
 *      the same keystroke produces — the setting reaching the keymap is the
 *      thing under test.
 *   3. **A ranged selection still block-indents.** Shift-Down + Tab moves
 *      every touched line's start, unchanged from CM6's behavior.
 *   4. **The session card's composer agrees.** The same keystroke in a real
 *      Session card's prompt editor inserts at the caret, at the width the
 *      Settings card's "Spaces per tab" wrote — the whole path from the
 *      deck-wide editor settings to the keymap, on the surface the reader
 *      actually types in.
 *
 * @covers tugdeck/src/components/tugways/editor-tab-key.ts
 * @covers tugdeck/src/components/tugways/tug-text-card-editor.tsx
 * @covers tugdeck/src/components/tugways/tug-text-editor.tsx
 * @covers tugdeck/src/lib/text-card-settings.ts
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CARD = '[data-card-id="A"]';
const FILE_EDITOR = `${CARD} [data-slot="tug-text-card-editor"] .cm-content`;
const PROMPT_EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const PANE = '[data-pane-id="p1"]';
const OPTIONS_BUTTON = `${PANE} [data-testid="tug-pane-title-bar-item-show-card-settings"]`;
const OPTIONS_PANEL = '[data-testid="text-card-options"]';
const SOFT_TABS_SWITCH = `${OPTIONS_PANEL} [data-testid="text-card-option-soft-tabs"]`;

function mkFixture(content: string): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "at0531-"));
  const file = path.join(dir, "sample.txt");
  fs.writeFileSync(file, content, "utf8");
  return { dir, file };
}

/** Type through CM6's real beforeinput pipeline, leaving the caret after it. */
async function typeIntoEditor(app: App, selector: string, text: string): Promise<void> {
  await app.evalJS<boolean>(
    `(function(){
      var el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.focus();
      return document.execCommand("insertText", false, ${JSON.stringify(text)});
    })()`,
  );
}

/**
 * The first rendered line's text. CM6 paints a run of spaces as alternating
 * space / no-break space so the browser cannot collapse them; normalizing
 * back gives the document's own characters.
 */
async function firstLine(app: App, selector: string): Promise<string> {
  const raw = await app.evalJS<string>(
    `(function(){
      var el = document.querySelector(${JSON.stringify(selector)});
      var line = el && el.querySelector(".cm-line");
      return line ? line.textContent : "";
    })()`,
  );
  return raw.replace(/ /g, " ");
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
  throw new Error(
    `[at0531] disk predicate unmet in ${timeoutMs}ms; last: ${JSON.stringify(last)}`,
  );
}

async function seedTextCard(app: App, filePath: string): Promise<void> {
  // Automatic save so the assertions can read the document's real bytes off
  // disk rather than inferring them from painted DOM.
  await app.evalJS<null>(
    `(window.__tug.setTugbankValue("dev.tugapp.text-card","save-mode",{kind:"string",value:"automatic"}), null)`,
  );
  // A card that has been tuned: soft tabs on at a width of THREE. Seeded on
  // the per-card domain the gear popover writes, which is what an already
  // configured card looks like on disk.
  await app.evalJS<null>(
    `(window.__tug.setTugbankValue("dev.text-card","A",{kind:"json",value:{softTabs:true,tabSize:3,lineNumbers:true,lineWrap:true}}), null)`,
  );
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
  await app.waitForCondition<boolean>(
    `(function(){
      var el = document.querySelector(${JSON.stringify(FILE_EDITOR)});
      return el !== null && el.innerText.indexOf("hello") !== -1;
    })()`,
    { timeoutMs: 15000 },
  );
}

describe.skipIf(!SHOULD_RUN)("at0531: Tab inserts at the caret", () => {
  test(
    "a file editor's Tab lands at the caret, honours the tab policy, and still block-indents a selection",
    async () => {
      const { dir, file } = mkFixture("hello world\nsecond line\n");
      const app = await launchTugApp({
        testName: "at0531-tab-inserts-at-the-caret",
      });
      try {
        await seedTextCard(app, file);

        // ---- 1. Soft tabs advance to the next stop, at the caret ----
        //
        // Typing "ab" at the document's start leaves the caret at column 2 of
        // "abhello world". At the seeded width of 3 the next stop is column
        // 3, so Tab owes exactly ONE space — and it owes it after the "b",
        // not before the "a". `indentMore` failed both halves of that
        // sentence, and a width stuck at the default would owe two.
        await typeIntoEditor(app, FILE_EDITOR, "ab");
        await app.nativeKey("Tab");
        const softSaved = await waitForDisk(file, (c) => c.startsWith("ab "));
        expect(softSaved.split("\n")[0]).toBe("ab hello world");

        // A second Tab from column 4 owes TWO — the distance to the next
        // multiple of 3, not a fixed count.
        await typeIntoEditor(app, FILE_EDITOR, "x");
        await app.nativeKey("Tab");
        const stopSaved = await waitForDisk(file, (c) => c.startsWith("ab x  "));
        expect(stopSaved.split("\n")[0]).toBe("ab x  hello world");
        expect(await firstLine(app, FILE_EDITOR)).toBe("ab x  hello world");

        // ---- 2. A ranged selection still block-indents ----
        //
        // Shift-ArrowDown carries the selection onto the second line; Tab
        // then means "indent these lines", which is the one job `indentMore`
        // is right for — and it indents by the reader's unit, three spaces.
        await app.nativeKey("ArrowDown", ["shift"]);
        await app.nativeKey("Tab");
        const blockSaved = await waitForDisk(file, (c) => c.startsWith("   "));
        expect(blockSaved.split("\n")[0]).toBe("   ab x  hello world");
        expect(blockSaved.split("\n")[1]).toBe("   second line");

        // ---- 3. Hard tabs insert a literal tab, at the caret ----
        //
        // Same keystroke, opposite policy — driven through the card's own
        // gear sheet, so this covers the setting's whole path from the switch
        // to the keymap.
        await app.revealPaneControls(PANE);
        await app.nativeClickAtElement(OPTIONS_BUTTON);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(OPTIONS_PANEL)}) !== null`,
          { timeoutMs: 15000 },
        );
        await app.nativeClickAtElement(SOFT_TABS_SWITCH);
        await app.nativeClickAtElement('[data-testid="card-settings-done"]');
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(OPTIONS_PANEL)}) === null`,
          { timeoutMs: 10000 },
        );

        // The sheet took focus; hand it back to the editor and collapse the
        // block selection before typing, or the type replaces it.
        await app.evalJS<boolean>(
          `(function(){
            var el = document.querySelector(${JSON.stringify(FILE_EDITOR)});
            if (!el) return false;
            el.focus();
            return true;
          })()`,
        );
        await app.nativeKey("ArrowRight");
        await typeIntoEditor(app, FILE_EDITOR, "cd");
        await app.nativeKey("Tab");
        const hardSaved = await waitForDisk(file, (c) => c.includes("\t"));
        expect(hardSaved).toContain("cd\t");
      } finally {
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the session composer's Tab lands at the caret, at the deck-wide width",
    async () => {
      const app = await launchTugApp({ testName: "at0531-prompt-tab" });
      try {
        // The deck-wide prompt-editor settings, tuned to a width of THREE
        // before the card mounts — the blob the Settings card's Sessions tab
        // writes and `EditorSettingsStore` reads.
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.editor","settings",{kind:"json",value:{fontId:"plex-mono",fontSize:13,lineWrap:true,lineNumbers:false,softTabs:true,tabSize:3,highlightActiveLineGutter:false,returnKeyAction:"newline",numpadEnterAction:"submit"}}), null)`,
        );
        await app.seedDeckState({
          state: {
            cards: [
              {
                id: "A",
                componentId: "session",
                title: "Session",
                closable: true,
              },
            ],
            panes: [
              {
                id: "p1",
                position: { x: 40, y: 40 },
                size: { width: 720, height: 540 },
                cardIds: ["A"],
                activeCardId: "A",
                title: "",
                acceptsFamilies: ["maker"],
              },
            ],
            activePaneId: "p1",
            hasFocus: true,
          },
          focusCardId: "A",
        });
        // A Session card's composer only mounts behind a bound session.
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PROMPT_EDITOR)}) !== null`,
          { timeoutMs: 15000 },
        );

        // A non-empty composer indents; the empty-Tab gesture (which spends
        // Tab on the card's focus cycle) is why there is text here first.
        // Caret at column 2, width 3 → exactly ONE space, after the "b".
        await app.nativeClickAtElement(PROMPT_EDITOR);
        await typeIntoEditor(app, PROMPT_EDITOR, "ab");
        await app.nativeKey("Tab");
        await app.waitForCondition<boolean>(
          `(function(){
            var el = document.querySelector(${JSON.stringify(PROMPT_EDITOR)});
            var line = el && el.querySelector(".cm-line");
            return line !== null &&
              line.textContent.replace(/\\u00a0/g, " ") === "ab ";
          })()`,
          { timeoutMs: 8000 },
        );
        expect(await firstLine(app, PROMPT_EDITOR)).toBe("ab ");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
