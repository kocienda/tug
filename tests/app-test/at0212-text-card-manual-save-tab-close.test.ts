/**
 * at0212-text-card-manual-save-tab-close.test.ts — the tab-bar × on a dirty
 * Text card in manual save mode consults the same close guard as the pane X
 * ([AT0212], arc/file-editing-enhancements.md).
 *
 * One piece of the at0212 split, a test to a file so each launch fits its
 * own budget; the deck shape and gestures are
 * `text-card-manual-save-fixture.ts`.
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
import * as os from "node:os";
import * as path from "node:path";
import { launchTugApp } from "./_harness";
import {
  EDITOR_CONTENT,
  ORIGINAL,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  saveCell,
  settle,
  typeIntoEditor,
  waitForCardGone,
  waitForEditor,
  waitForSaveCell,
  waitSheetButton,
} from "./text-card-manual-save-fixture";

describe.skipIf(!SHOULD_RUN)("at0212: Text card manual save", () => {
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
        await waitForEditor(app.body("A"), "alpha");
        await typeIntoEditor(app.body("A"), "UNSAVED ");
        await waitForSaveCell(app.body("A"), "Edited");
        await settle();

        // The tab × is a close gesture like the pane X — it must raise the
        // close sheet for a dirty card, never destroy it silently.
        await app.body("A").click(`[data-testid="tug-tab-close-A"]`);
        await settle();
        await waitSheetButton(app.body("A"), "cancel");
        await settle();
        await app.body("A").click(`[data-testid="file-save-sheet-cancel"]`);
        await settle();
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector('${EDITOR_CONTENT}') !== null`,
        );
        expect(await saveCell(app.body("A"))).toBe("Edited");

        // Don't Save via the tab × closes the tab without writing.
        await app.body("A").click(`[data-testid="tug-tab-close-A"]`);
        await settle();
        await waitSheetButton(app.body("A"), "dont-save");
        await settle();
        await app.body("A").click(`[data-testid="file-save-sheet-dont-save"]`);
        await settle();
        await waitForCardGone(app, "A");
        expect(fs.readFileSync(fileA, "utf8")).toBe(ORIGINAL);
      } finally {
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
