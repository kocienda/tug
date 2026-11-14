/**
 * at0212-text-card-manual-save-close.test.ts — closing a dirty Text card in
 * manual save mode always asks first ([AT0212],
 * arc/file-editing-enhancements.md).
 *
 * One piece of the at0212 split, a test to a file so each launch fits its
 * own budget; the deck shape and gestures are
 * `text-card-manual-save-fixture.ts`. The tab-bar × is
 * `at0212-text-card-manual-save-tab-close`, and a pane close visiting a
 * dirty background tab is `at0212-text-card-manual-save-pane-visit`.
 *
 * **Dirty close.** A dirty card gated by both a plain X-click (the
 * `!confirmClose` short-circuit, Risk R02) and the `close` control action
 * presents the close sheet; Cancel keeps it, Don't Save closes without
 * writing.
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
 * @family at0212-text-card-manual-save
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { launchTugApp } from "./_harness";
import { mkTextFixture } from "./_harness/fixtures";
import {
  CLOSE_BUTTON,
  EDITOR_CONTENT,
  ORIGINAL,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  dispatchControl,
  saveCell,
  seedTextCard,
  settle,
  typeIntoEditor,
  waitForCardGone,
  waitForEditor,
  waitForSaveCell,
  waitSheetButton,
} from "./text-card-manual-save-fixture";

describe.skipIf(!SHOULD_RUN)("at0212: Text card manual save", () => {
  test(
    "dirty close via X-click and control both gate on the close sheet",
    async () => {
      const { dir, file } = mkTextFixture("at0212-", ORIGINAL, { name: "manual.txt" });
      const app = await launchTugApp({ testName: "at0212-close" });
      try {
        await seedTextCard(app, file);
        await waitForEditor(app.body("A"), "alpha");
        await typeIntoEditor(app.body("A"), "UNSAVED ");
        await waitForSaveCell(app.body("A"), "Edited");
        await settle();

        // Plain X-click (the !confirmClose short-circuit, Risk R02) raises
        // the sheet, not a silent close. Cancel keeps the card + edits.
        await app.body("A").nativeClickAtElement(CLOSE_BUTTON);
        await settle();
        await waitSheetButton(app.body("A"), "cancel");
        await settle();
        await app.body("A").click(`[data-testid="file-save-sheet-cancel"]`);
        await settle();
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector('${EDITOR_CONTENT}') !== null`,
        );
        expect(await saveCell(app.body("A"))).toBe("Edited");

        // The close control gates the same way; Don't Save closes without
        // writing the buffer to disk.
        await dispatchControl(app, "close");
        await settle();
        await waitSheetButton(app.body("A"), "dont-save");
        await settle();
        await app.body("A").click(`[data-testid="file-save-sheet-dont-save"]`);
        await settle();
        await waitForCardGone(app, "A");
        expect(fs.readFileSync(file, "utf8")).toBe(ORIGINAL);
      } finally {
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
