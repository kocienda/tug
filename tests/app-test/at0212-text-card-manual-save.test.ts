/**
 * at0212-text-card-manual-save.test.ts — Text card manual save mode
 * ([AT0212], arc/file-editing-enhancements.md). Manual is the shipping
 * default; this drives the classic document contract on real files through
 * real code paths — no mocks.
 *
 * (The plan numbered this at0211, but that id was taken by the /btw
 * overlay test landed since; this is the same suite under the next id.)
 *
 * ## Scenarios
 *
 * 1. **Edits stay off disk; menu gates + dynamic ⇧⌘S.** Open a real file
 *    (manual default); typing marks the card "Edited" WITHOUT touching
 *    disk. The File menu validates per Spec S02 (clean → Save/Revert
 *    disabled, Reload enabled; dirty → Save/Revert enabled) and Save As…
 *    carries ⇧⌘S while a text card is frontmost ([P07]).
 * 2. **Dirty close.** A dirty card gated by both a plain X-click (the
 *    `!confirmClose` short-circuit, Risk R02) and the `close` control
 *    action presents the close sheet; Cancel keeps it, Don't Save closes
 *    without writing.
 * 3. **Aside crash-safety.** A dirty edit is set aside under Autosave
 *    Information without touching the real file.
 * 4. **Automatic mode retained.** A seeded automatic text card keeps Save
 *    enabled even when clean (the [P07] no-beep guard).
 * 5. **New Text Card.** `new-text-card` opens a second Untitled editor, and
 *    that buffer's masthead is checked for the two things a not-yet-a-file
 *    document must not do: leave the second line empty (a hole in a fixed
 *    three-line tier) or claim on the third that it was saved.
 *
 * ## Coverage note — the explicit-save write, external-change conflict,
 * and the [P12] "Save Anyway writes the REAL file not the aside" guard are
 * verified at the real store layer in
 * `tugdeck/src/lib/__tests__/text-card-store.manual.test.ts` (deterministic,
 * real fs-io code paths). They are NOT asserted here because a ⌘S-driven
 * save routes through the responder chain to the editor *leaf* responder,
 * and a headless sweep (no frontmost app; synthetic focus over CM6, which
 * owns pointerdown) cannot reliably make that leaf the chain first
 * responder — the same reason at0209 types via `execCommand` rather than
 * native keys. This test covers the wiring the harness can drive
 * faithfully; the store tests cover the write/conflict machine.
 *
 * Every scenario opens a real disk path so no save lands in an NSSavePanel.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/cards/text-card.tsx
 * @covers tugdeck/src/components/tugways/cards/text-card-save-sheets.tsx
 * @covers tugdeck/src/lib/text-card-store.ts
 * @covers tugdeck/src/lib/text-card-save-text.ts
 * @covers tugdeck/src/components/tugways/card-masthead.tsx
 * @covers tugdeck/src/lib/file-io.ts
 * @covers tugdeck/src/components/chrome/tug-pane.tsx
 * @covers tugdeck/src/components/tugways/cards/text-card-status-bar.tsx
 * @covers tugdeck/src/components/tugways/tug-text-card-editor.css
 * @covers tugdeck/src/components/tugways/tug-text-card-editor.tsx
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { launchTugApp, note, type App } from "./_harness";
import { decodePngFile } from "./_harness/png";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CARD = '[data-card-id="A"]';
const EDITOR_CONTENT = `${CARD} [data-slot="tug-text-card-editor"] .cm-content`;
// The save state rides the PANE's document masthead, not a cell inside the
// card — the title bar is not a descendant of the card element, so this is
// pane-scoped on purpose. Chrome follows the frontmost tab, so in the
// two-card cases below this selector reads whichever card is active.
const SAVE_LINE = `[data-pane-id="p1"] [data-testid="card-masthead-detail"]`;
const CLOSE_BUTTON = `[data-testid="tug-pane-close-button"]`;

const ORIGINAL = "alpha\nbeta\ngamma\n";

function mkFixture(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "at0212-"));
  const file = path.join(dir, "manual.txt");
  fs.writeFileSync(file, ORIGINAL, "utf8");
  return { dir, file };
}

function deckShape() {
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

async function seedTextCard(
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

async function waitForEditor(app: App, sentinel: string, timeoutMs = 15000): Promise<void> {
  await app.waitForCondition<boolean>(
    `(function(){
      var el = document.querySelector('${EDITOR_CONTENT}');
      return el !== null && el.innerText.indexOf(${JSON.stringify(sentinel)}) !== -1;
    })()`,
    { timeoutMs },
  );
}

async function typeIntoEditor(app: App, text: string): Promise<void> {
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

async function waitForSaveCell(app: App, want: string, timeoutMs = 15000): Promise<void> {
  await app.waitForCondition<boolean>(
    `(function(){
      var el = document.querySelector('${SAVE_LINE}');
      return el !== null && el.innerText.indexOf(${JSON.stringify(want)}) === 0;
    })()`,
    { timeoutMs },
  );
}

async function saveCell(app: App): Promise<string> {
  return app.evalJS<string>(`document.querySelector('${SAVE_LINE}').innerText`);
}

/**
 * Let the app settle between synthetic gestures. Native clicks, control
 * dispatches, and sheet-button clicks each kick React renders, portal
 * mounts, and focus transfers that must commit before the next gesture —
 * firing them back-to-back races those transitions.
 */
const settle = (ms = 450) => new Promise((r) => setTimeout(r, ms));

async function dispatchControl(app: App, action: string): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.dispatchControlAction(${JSON.stringify(action)}), null)`,
  );
}

async function waitMenuEnabled(app: App, id: string, want: boolean, timeoutMs = 8000): Promise<void> {
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

async function waitSheetButton(app: App, result: string, timeoutMs = 15000): Promise<void> {
  await app.waitForCondition<boolean>(
    `document.querySelector('[data-testid="file-save-sheet-${result}"]') !== null`,
    { timeoutMs },
  );
}

// NSEvent.ModifierFlags: .command = 1<<20, .shift = 1<<17.
const CMD_MASK = 1 << 20;
const SHIFT_MASK = 1 << 17;

describe.skipIf(!SHOULD_RUN)("at0212: Text card manual save", () => {
  test(
    "edits stay off disk; menu gates + dynamic ⇧⌘S",
    async () => {
      const { dir, file } = mkFixture();
      const app = await launchTugApp({ testName: "at0212-gates" });
      try {
        await seedTextCard(app, file);
        await waitForEditor(app, "alpha");

        // Clean titled manual card: "Saved"; Save/Revert disabled, Reload
        // enabled; Save As… carries the dynamic ⇧⌘S ([P07]).
        await waitForSaveCell(app, "Saved");
        await waitMenuEnabled(app, "file.save", false);
        await waitMenuEnabled(app, "file.revertToSaved", false);
        await waitMenuEnabled(app, "file.reloadFromDisk", true);
        const saveAs = await app.menuItemState("file.saveAs");
        expect(saveAs.found && saveAs.keyEquivalent).toBe("s");
        expect(saveAs.found ? (saveAs.modifierMask & CMD_MASK) !== 0 : false).toBe(true);
        expect(saveAs.found ? (saveAs.modifierMask & SHIFT_MASK) !== 0 : false).toBe(true);

        // Type → "Edited", disk UNCHANGED, Save + Revert enabled.
        await typeIntoEditor(app, "EDIT ");
        await waitForSaveCell(app, "Edited");
        await settle();
        expect(fs.readFileSync(file, "utf8")).toBe(ORIGINAL);
        await waitMenuEnabled(app, "file.save", true);
        await waitMenuEnabled(app, "file.revertToSaved", true);

        // The `save` control (the same path File ▸ Save uses) writes the
        // real file and clears dirty. The editor is the first responder
        // (typing focused it), so `save` reaches it via the chain.
        await dispatchControl(app, "save");
        await settle();
        await waitForSaveCell(app, "Saved");
        expect(fs.readFileSync(file, "utf8")).toContain("EDIT ");
      } finally {
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "save survives a title-bar interaction (focus reclaim on cardDidMove)",
    async () => {
      const { dir, file } = mkFixture();
      const app = await launchTugApp({ testName: "at0212-reclaim" });
      try {
        await seedTextCard(app, file);
        await waitForEditor(app, "alpha");
        await typeIntoEditor(app, "MOVED ");
        await waitForSaveCell(app, "Edited");
        await settle();

        // Reposition the card by dragging its title bar. This promotes the
        // pane as first responder and fires cardDidMove — pulling chain
        // focus off the editor. The card's reclaim must restore the editor
        // as first responder, or `save` (editor-owned) would walk up from
        // the pane and miss it — the "moved the card, ⌘S went dead" bug.
        const tb = await app.getElementBounds(
          `[data-testid="tug-pane-title-bar"]`,
        );
        await app.nativeDragElement(`[data-testid="tug-pane-title-bar"]`, {
          x: tb.x + tb.width / 2 + 80,
          y: tb.y + tb.height / 2,
        });
        await settle();

        // The reclaim must have restored the editor as the chain first
        // responder (not merely DOM focus, which survived the drag).
        await app.waitForCondition<boolean>(
          `(function(){
             var fr = document.querySelector('[data-first-responder]');
             var content = document.querySelector('${EDITOR_CONTENT}');
             var editorRid = content ? content.closest('[data-responder-id]')?.getAttribute('data-responder-id') : null;
             return fr !== null && editorRid !== null && fr.getAttribute('data-first-responder') === editorRid;
           })()`,
          { timeoutMs: 8000 },
        );

        // `save` (the same path ⌘S/File▸Save use) still reaches the editor.
        await dispatchControl(app, "save");
        await settle();
        await waitForSaveCell(app, "Saved");
        expect(fs.readFileSync(file, "utf8")).toContain("MOVED ");
      } finally {
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "conflict: Save Anyway writes the buffer to the real file ([P12])",
    async () => {
      const { dir, file } = mkFixture();
      const app = await launchTugApp({ testName: "at0212-conflict" });
      try {
        await seedTextCard(app, file);
        await waitForEditor(app, "alpha");
        await typeIntoEditor(app, "MINE ");
        await waitForSaveCell(app, "Edited");
        await settle();

        // Another app changes the file underneath us; a save now conflicts
        // and raises the modal conflict sheet. (Identity-routed — no
        // pre-focus needed.)
        fs.writeFileSync(file, "FOREIGN CONTENT\n", "utf8");
        await dispatchControl(app, "save");
        await settle();
        await waitSheetButton(app, "save-anyway");

        // Save Anyway writes the BUFFER (not the aside) to the REAL file.
        await settle();
        await app.click(`[data-testid="file-save-sheet-save-anyway"]`);
        await settle();
        await waitForSaveCell(app, "Saved");
        const disk = fs.readFileSync(file, "utf8");
        expect(disk).toContain("MINE ");
        expect(disk).not.toContain("FOREIGN CONTENT");
      } finally {
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "dirty close via X-click and control both gate on the close sheet",
    async () => {
      const { dir, file } = mkFixture();
      const app = await launchTugApp({ testName: "at0212-close" });
      try {
        await seedTextCard(app, file);
        await waitForEditor(app, "alpha");
        await typeIntoEditor(app, "UNSAVED ");
        await waitForSaveCell(app, "Edited");
        await settle();

        // Plain X-click (the !confirmClose short-circuit, Risk R02) raises
        // the sheet, not a silent close. Cancel keeps the card + edits.
        await app.nativeClickAtElement(CLOSE_BUTTON);
        await settle();
        await waitSheetButton(app, "cancel");
        await settle();
        await app.click(`[data-testid="file-save-sheet-cancel"]`);
        await settle();
        await app.waitForCondition<boolean>(
          `document.querySelector('${EDITOR_CONTENT}') !== null`,
        );
        expect(await saveCell(app)).toBe("Edited");

        // The close control gates the same way; Don't Save closes without
        // writing the buffer to disk.
        await dispatchControl(app, "close");
        await settle();
        await waitSheetButton(app, "dont-save");
        await settle();
        await app.click(`[data-testid="file-save-sheet-dont-save"]`);
        await settle();
        await app.waitForCondition<boolean>(
          `document.querySelector('${EDITOR_CONTENT}') === null`,
          { timeoutMs: 15000 },
        );
        expect(fs.readFileSync(file, "utf8")).toBe(ORIGINAL);
      } finally {
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a dirty edit is set aside without touching the real file",
    async () => {
      const asideDir = path.join(
        os.homedir(),
        "Library/Application Support/Tug/Autosave Information",
      );
      const { dir, file } = mkFixture();
      const app = await launchTugApp({ testName: "at0212-aside" });
      try {
        await seedTextCard(app, file);
        await waitForEditor(app, "alpha");
        await typeIntoEditor(app, "ASIDE-SENTINEL ");
        await waitForSaveCell(app, "Edited");
        await settle();

        const deadline = Date.now() + 15000;
        let found = false;
        while (Date.now() < deadline && !found) {
          if (fs.existsSync(asideDir)) {
            for (const name of fs.readdirSync(asideDir)) {
              try {
                if (fs.readFileSync(path.join(asideDir, name), "utf8").includes("ASIDE-SENTINEL")) {
                  found = true;
                  break;
                }
              } catch {
                /* racing writer — retry */
              }
            }
          }
          if (!found) await new Promise((r) => setTimeout(r, 150));
        }
        expect(found).toBe(true);
        expect(fs.readFileSync(file, "utf8")).toBe(ORIGINAL);
      } finally {
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "automatic mode keeps Save enabled when clean (no-beep guard, [P07])",
    async () => {
      const { dir, file } = mkFixture();
      const app = await launchTugApp({ testName: "at0212-automatic" });
      try {
        await seedTextCard(app, file, "automatic");
        await waitForEditor(app, "alpha");
        await waitMenuEnabled(app, "file.save", true);
      } finally {
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the tab-bar × consults the close guard on a dirty card",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "at0212-tab-"));
      const fileA = path.join(dir, "a.txt");
      const fileB = path.join(dir, "b.txt");
      fs.writeFileSync(fileA, ORIGINAL, "utf8");
      fs.writeFileSync(fileB, "other\n", "utf8");
      const app = await launchTugApp({ testName: "at0212-tab-close" });
      try {
        // Two text cards in ONE pane so the tab bar renders; A is active.
        await app.seedDeckState({
          state: {
            cards: [
              { id: "A", componentId: "text", title: "File", closable: true },
              { id: "B", componentId: "text", title: "File", closable: true },
            ],
            panes: [
              {
                id: "p1",
                position: { x: 40, y: 40 },
                size: { width: 760, height: 560 },
                cardIds: ["A", "B"],
                activeCardId: "A",
                title: "",
                acceptsFamilies: ["standard"],
              },
            ],
            activePaneId: "p1",
            hasFocus: true,
          },
          cardStates: {
            A: { content: { path: fileA, anchor: { line: 1, ch: 0 }, scrollTop: 0 } },
            B: { content: { path: fileB, anchor: { line: 1, ch: 0 }, scrollTop: 0 } },
          },
          focusCardId: "A",
        });
        await waitForEditor(app, "alpha");
        await typeIntoEditor(app, "UNSAVED ");
        await waitForSaveCell(app, "Edited");
        await settle();

        // The tab × is a close gesture like the pane X — it must raise the
        // close sheet for a dirty card, never destroy it silently.
        await app.click(`[data-testid="tug-tab-close-A"]`);
        await settle();
        await waitSheetButton(app, "cancel");
        await settle();
        await app.click(`[data-testid="file-save-sheet-cancel"]`);
        await settle();
        await app.waitForCondition<boolean>(
          `document.querySelector('${EDITOR_CONTENT}') !== null`,
        );
        expect(await saveCell(app)).toBe("Edited");

        // Don't Save via the tab × closes the tab without writing.
        await app.click(`[data-testid="tug-tab-close-A"]`);
        await settle();
        await waitSheetButton(app, "dont-save");
        await settle();
        await app.click(`[data-testid="file-save-sheet-dont-save"]`);
        await settle();
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-testid="tug-tab-close-A"]') === null`,
          { timeoutMs: 15000 },
        );
        expect(fs.readFileSync(fileA, "utf8")).toBe(ORIGINAL);
      } finally {
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "pane close visits a dirty background tab before the pane dies",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "at0212-visit-"));
      const fileA = path.join(dir, "a.txt");
      const fileB = path.join(dir, "b.txt");
      fs.writeFileSync(fileA, ORIGINAL, "utf8");
      fs.writeFileSync(fileB, "other\n", "utf8");
      const app = await launchTugApp({ testName: "at0212-visit-dirty" });
      const B_EDITOR = `[data-card-id="B"] [data-slot="tug-text-card-editor"] .cm-content`;
      // Same pane, so the same masthead — it reads B while B is the frontmost tab.
      const B_SAVE_LINE = SAVE_LINE;
      try {
        await app.seedDeckState({
          state: {
            cards: [
              { id: "A", componentId: "text", title: "File", closable: true },
              { id: "B", componentId: "text", title: "File", closable: true },
            ],
            panes: [
              {
                id: "p1",
                position: { x: 40, y: 40 },
                size: { width: 760, height: 560 },
                cardIds: ["A", "B"],
                activeCardId: "A",
                title: "",
                acceptsFamilies: ["standard"],
              },
            ],
            activePaneId: "p1",
            hasFocus: true,
          },
          cardStates: {
            A: { content: { path: fileA, anchor: { line: 1, ch: 0 }, scrollTop: 0 } },
            B: { content: { path: fileB, anchor: { line: 1, ch: 0 }, scrollTop: 0 } },
          },
          focusCardId: "A",
        });
        await waitForEditor(app, "alpha");

        // Dirty card B, then return to the (clean) card A — the user's
        // scenario: the dirty buffer sits in a BACKGROUND tab.
        await app.click(`[data-testid="tug-tab-B"]`);
        await app.waitForCondition<boolean>(
          `(function(){
            var el = document.querySelector('${B_EDITOR}');
            return el !== null && el.innerText.indexOf("other") !== -1;
          })()`,
          { timeoutMs: 15000 },
        );
        await settle();
        const typed = await app.evalJS<boolean>(
          `(function(){
            var el = document.querySelector('${B_EDITOR}');
            if (!el) return false;
            el.focus();
            return document.execCommand("insertText", false, "UNSAVED ");
          })()`,
        );
        expect(typed).toBe(true);
        await app.waitForCondition<boolean>(
          `(function(){
            var el = document.querySelector('${B_SAVE_LINE}');
            return el !== null && el.innerText.indexOf("Edited") === 0;
          })()`,
          { timeoutMs: 15000 },
        );
        await app.click(`[data-testid="tug-tab-A"]`);
        await settle();

        // Pane X: the whole pane is going away, so the dirty background
        // tab must be VISITED — activated and asked — never dropped
        // behind the Close-N-Tabs popover.
        await app.nativeClickAtElement(CLOSE_BUTTON);
        await settle();
        await waitSheetButton(app, "dont-save");
        // Visited: B's editor is the visible one while its sheet asks.
        expect(
          await app.evalJS<boolean>(
            `(function(){
              var el = document.querySelector('${B_EDITOR}');
              return el !== null && el.offsetParent !== null;
            })()`,
          ),
        ).toBe(true);
        await settle();

        // Cancel aborts the whole pane close; the edits survive.
        await app.click(`[data-testid="file-save-sheet-cancel"]`);
        await settle();
        expect(
          await app.evalJS<string>(`document.querySelector('${B_SAVE_LINE}').innerText`),
        ).toStartWith("Edited");

        // X again: Don't Save finishes the close directly — the visit
        // sequence collected the explicit decision, so the Close-N-Tabs
        // popover is superseded (no double prompt). The buffer's edits
        // never reach disk.
        await app.nativeClickAtElement(CLOSE_BUTTON);
        await settle();
        await waitSheetButton(app, "dont-save");
        await settle();
        await app.click(`[data-testid="file-save-sheet-dont-save"]`);
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-card-id="B"]') === null`,
          { timeoutMs: 15000 },
        );
        expect(fs.readFileSync(fileB, "utf8")).toBe("other\n");
      } finally {
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "New Text Card opens a second Untitled editor",
    async () => {
      const { dir, file } = mkFixture();
      const app = await launchTugApp({ testName: "at0212-new-text-card" });
      try {
        await seedTextCard(app, file);
        await waitForEditor(app, "alpha");
        await settle();
        await dispatchControl(app, "new-text-card");
        await settle();
        await app.waitForCondition<boolean>(
          `document.querySelectorAll('[data-slot="tug-text-card-editor"]').length >= 2`,
          { timeoutMs: 15000 },
        );

        // The masthead of a buffer that is NOT A FILE YET. Both lines were
        // wrong when the tier shipped: the second was empty, which on a fixed
        // three-line tier is a hole between two filled lines rather than a
        // shorter masthead, and the third said "Saved" about a buffer nothing
        // had ever written. A stand-in fills the second ([D132]) and the third
        // names what the buffer IS.
        const untitled = await app.evalJS<{
          description: string;
          stamp: string | null;
          fontStyle: string;
          rect: { left: number; top: number; width: number; height: number };
          innerWidth: number;
          detail: string;
        } | null>(`(function () {
          var heads = document.querySelectorAll('[data-slot="card-masthead"]');
          for (var i = 0; i < heads.length; i++) {
            var head = heads[i];
            var title = head.querySelector('[data-testid="card-masthead-title"]');
            if (title === null || title.innerText.indexOf("Untitled") !== 0) continue;
            var desc = head.querySelector('[data-testid="card-masthead-description"]');
            var detail = head.querySelector('[data-testid="card-masthead-detail"]');
            // The quieter ink and the italic both land on the ROW's
            // description element — this span's parent — because that is where
            // the row stamps a stand-in.
            var line = desc === null ? null : desc.parentElement;
            var r = line === null ? null : line.getBoundingClientRect();
            return {
              description: desc === null ? "" : desc.innerText,
              stamp: line === null ? null : line.getAttribute("data-stamp"),
              fontStyle: line === null ? "" : getComputedStyle(line).fontStyle,
              rect:
                r === null
                  ? { left: 0, top: 0, width: 0, height: 0 }
                  : { left: r.left, top: r.top, width: r.width, height: r.height },
              innerWidth: window.innerWidth,
              detail: detail === null ? "" : detail.innerText,
            };
          }
          return null;
        })()`);
        note("at0212 untitled masthead", JSON.stringify(untitled));
        expect(untitled).not.toBeNull();
        expect(untitled!.description).toBe("No file");
        expect(untitled!.stamp, "a stand-in reads a step quieter").toBe("true");
        expect(untitled!.fontStyle, "and in the other type").toBe("italic");
        expect(untitled!.detail).toBe("Draft");

        // …and it actually PAINTS. `font-style: italic` on a weight with no
        // bundled italic face renders nothing at all in this WKWebView — no
        // synthesized oblique — while the element keeps a normal rect, a
        // normal computed color, and its text content. Every assertion above
        // passes on a blank line, so the only honest guard is ink.
        const shot = await app.screenshot();
        try {
          const png = decodePngFile(shot.path);
          const scale = png.width / untitled!.innerWidth;
          const r = untitled!.rect;
          // The run only, not the line box: the description stretches to the
          // pane's width, and counting its empty tail would drown the glyphs.
          const x0 = Math.round(r.left * scale);
          const x1 = Math.round((r.left + Math.min(r.width, 90)) * scale);
          const y0 = Math.round(r.top * scale);
          const y1 = Math.round((r.top + r.height) * scale);
          let ink = 0;
          for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
              const i = (y * png.width + x) * 4;
              // The band is a flat tint; type ink is far off it in luminance.
              const lum =
                0.299 * png.rgba[i]! + 0.587 * png.rgba[i + 1]! + 0.114 * png.rgba[i + 2]!;
              if (lum > 110) ink += 1;
            }
          }
          note("at0212 stand-in ink", `${ink}px in ${x1 - x0}×${y1 - y0}`);
          expect(ink, "the italic stand-in paints glyphs").toBeGreaterThan(40);
        } finally {
          fs.rmSync(shot.path, { force: true });
        }
      } finally {
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
