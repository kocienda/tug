/**
 * at0212-text-card-manual-save-save.test.ts — a Text card in manual save
 * mode keeps edits off disk until it is told to save ([AT0212],
 * arc/file-editing-enhancements.md).
 *
 * One piece of the at0212 split; the deck shape and gestures are
 * `text-card-manual-save-fixture.ts`. Manual is the shipping default; this
 * drives the classic document contract on real files through real code
 * paths — no mocks.
 *
 * 1. **Edits stay off disk; menu gates + dynamic ⇧⌘S.** Open a real file
 *    (manual default); typing marks the card "Edited" WITHOUT touching disk.
 *    The File menu validates per Spec S02 (clean → Save/Revert disabled,
 *    Reload enabled; dirty → Save/Revert enabled) and Save As… carries ⇧⌘S
 *    while a text card is frontmost ([P07]); the `save` control writes.
 * 2. **Save survives a title-bar drag** — the card reclaims the editor as
 *    first responder on cardDidMove.
 * 3. **Conflict: Save Anyway writes the buffer to the real file** ([P12]).
 * 4. **Automatic mode retained.** A seeded automatic text card keeps Save
 *    enabled even when clean (the [P07] no-beep guard).
 *
 * The explicit-save write, external-change conflict, and the [P12] "Save
 * Anyway writes the REAL file not the aside" machine are also verified at
 * the store layer in `tugdeck/src/lib/__tests__/text-card-store.manual.test.ts`;
 * this file covers the wiring the harness can drive faithfully.
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
 * @family at0212-text-card-manual-save
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { launchTugApp, note } from "./_harness";
import { AUTOMATIC_SAVE_MODE, mkSeededTugbank } from "./_harness/tugbank-helpers";
import { mkTextFixture } from "./_harness/fixtures";
import { chromePoint } from "./card-chrome-fixture";
import {
  CMD_MASK,
  EDITOR_CONTENT,
  ORIGINAL,
  SHIFT_MASK,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  dispatchControl,
  seedTextCard,
  settle,
  typeIntoEditor,
  waitForEditor,
  waitForSaveCell,
  waitMenuEnabled,
  waitSheetButton,
} from "./text-card-manual-save-fixture";

describe.skipIf(!SHOULD_RUN)("at0212: Text card manual save", () => {
  test(
    "edits stay off disk; menu gates + dynamic ⇧⌘S",
    async () => {
      const { dir, file } = mkTextFixture("at0212-", ORIGINAL, { name: "manual.txt" });
      const app = await launchTugApp({ testName: "at0212-gates" });
      try {
        await seedTextCard(app, file);
        await waitForEditor(app.body("A"), "alpha");

        // Clean titled manual card: "Saved"; Save/Revert disabled, Reload
        // enabled; Save As… carries the dynamic ⇧⌘S ([P07]).
        await waitForSaveCell(app.body("A"), "Saved");
        await waitMenuEnabled(app, "file.save", false);
        await waitMenuEnabled(app, "file.revertToSaved", false);
        await waitMenuEnabled(app, "file.reloadFromDisk", true);
        const saveAs = await app.menuItemState("file.saveAs");
        expect(saveAs.found && saveAs.keyEquivalent).toBe("s");
        expect(saveAs.found ? (saveAs.modifierMask & CMD_MASK) !== 0 : false).toBe(true);
        expect(saveAs.found ? (saveAs.modifierMask & SHIFT_MASK) !== 0 : false).toBe(true);

        // Type → "Edited", disk UNCHANGED, Save + Revert enabled.
        await typeIntoEditor(app.body("A"), "EDIT ");
        await waitForSaveCell(app.body("A"), "Edited");
        await settle();
        expect(fs.readFileSync(file, "utf8")).toBe(ORIGINAL);
        await waitMenuEnabled(app, "file.save", true);
        await waitMenuEnabled(app, "file.revertToSaved", true);

        // The `save` control (the same path File ▸ Save uses) writes the
        // real file and clears dirty. The editor is the first responder
        // (typing focused it), so `save` reaches it via the chain.
        await dispatchControl(app, "save");
        await settle();
        await waitForSaveCell(app.body("A"), "Saved");
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
      const { dir, file } = mkTextFixture("at0212-", ORIGINAL, { name: "manual.txt" });
      const app = await launchTugApp({ testName: "at0212-reclaim" });
      try {
        await seedTextCard(app, file);
        await waitForEditor(app.body("A"), "alpha");
        await typeIntoEditor(app.body("A"), "MOVED ");
        await waitForSaveCell(app.body("A"), "Edited");
        await settle();

        // Reposition the card by dragging its title bar. This promotes the
        // pane as first responder and fires cardDidMove — pulling chain
        // focus off the editor. The card's reclaim must restore the editor
        // as first responder, or `save` (editor-owned) would walk up from
        // the pane and miss it — the "moved the card, ⌘S went dead" bug.
        // The bar is the card's own, drawn in its page; the drag is the
        // window's, so it is pressed at the bar's grab handle, in the
        // shell's points — the masthead's lines beside it are its own
        // controls, not the bar.
        const responders = `(function(){
          var fr = document.querySelector('[data-first-responder]');
          var content = document.querySelector('${EDITOR_CONTENT}');
          var editorRid = content ? content.closest('[data-responder-id]')?.getAttribute('data-responder-id') : null;
          var active = document.activeElement;
          return {
            fr: fr === null ? null : fr.getAttribute('data-first-responder'),
            editor: editorRid,
            active: active === null ? null : (active.getAttribute('data-testid') || active.className || active.tagName),
          };
        })()`;
        const paneAt = `JSON.stringify(window.__tug.getPaneRecord("p1").position)`;
        const before = { responders: await app.body("A").evalJS<unknown>(responders), pane: await app.evalJS<string>(paneAt) };
        const from = await chromePoint(app, "A", ".tug-pane-title-bar .tug-pane-grab-handle");
        await app.nativeDrag(from, { x: from.x + 80, y: from.y });
        await settle();

        // The reclaim must have restored the editor as the chain first
        // responder (not merely DOM focus, which survived the drag).
        try {
          await app.body("A").waitForCondition<boolean>(
            `(function(){ var r = ${responders}; return r.fr !== null && r.editor !== null && r.fr === r.editor; })()`,
            { timeoutMs: 8000 },
          );
        } catch (error) {
          // What stood when the editor never came back: the page's responders and focus, before the drag and after, and whether the pane moved.
          note("before the drag", before);
          note("after the drag", { responders: await app.body("A").evalJS<unknown>(responders), pane: await app.evalJS<string>(paneAt) });
          note("view", (await app.bodies()).find((b) => b.cardId === "A") ?? null);
          throw error;
        }

        // `save` (the same path ⌘S/File▸Save use) still reaches the editor.
        await dispatchControl(app, "save");
        await settle();
        await waitForSaveCell(app.body("A"), "Saved");
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
      const { dir, file } = mkTextFixture("at0212-", ORIGINAL, { name: "manual.txt" });
      const app = await launchTugApp({ testName: "at0212-conflict" });
      try {
        await seedTextCard(app, file);
        await waitForEditor(app.body("A"), "alpha");
        await typeIntoEditor(app.body("A"), "MINE ");
        await waitForSaveCell(app.body("A"), "Edited");
        await settle();

        // Another app changes the file underneath us; a save now conflicts
        // and raises the modal conflict sheet. (Identity-routed — no
        // pre-focus needed.)
        fs.writeFileSync(file, "FOREIGN CONTENT\n", "utf8");
        await dispatchControl(app, "save");
        await settle();
        await waitSheetButton(app.body("A"), "save-anyway");

        // Save Anyway writes the BUFFER (not the aside) to the REAL file.
        await settle();
        await app.body("A").click(`[data-testid="file-save-sheet-save-anyway"]`);
        await settle();
        await waitForSaveCell(app.body("A"), "Saved");
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
    "automatic mode keeps Save enabled when clean (no-beep guard, [P07])",
    async () => {
      const { dir, file } = mkTextFixture("at0212-", ORIGINAL, { name: "manual.txt" });
      // A body card reads its save mode from the tugbank the app opens, so
      // automatic is seeded there rather than through the shell's cache.
      const app = await launchTugApp({
        testName: "at0212-automatic",
        env: { TUGBANK_PATH: mkSeededTugbank([AUTOMATIC_SAVE_MODE]) },
      });
      try {
        await seedTextCard(app, file, "automatic");
        await waitForEditor(app.body("A"), "alpha");
        await waitMenuEnabled(app, "file.save", true);
      } finally {
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
