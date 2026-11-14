/**
 * at0212-text-card-manual-save-pane-visit.test.ts — closing a pane in manual
 * save mode visits a dirty background tab before the pane dies ([AT0212],
 * arc/file-editing-enhancements.md).
 *
 * One piece of the at0212 split, a test to a file so each launch fits its
 * own budget; the deck shape and gestures are
 * `text-card-manual-save-fixture.ts`.
 *
 * The dirty background tab is activated and asked, never dropped behind the
 * Close-N-Tabs popover; Cancel aborts the whole pane close and Don't Save
 * finishes it with no double prompt. The scenario opens a real disk path so
 * no save lands in an NSSavePanel.
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
  CLOSE_BUTTON,
  ORIGINAL,
  SAVE_LINE,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  settle,
  waitForCardGone,
  waitForEditor,
  waitSheetButton,
} from "./text-card-manual-save-fixture";

describe.skipIf(!SHOULD_RUN)("at0212: Text card manual save", () => {
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
      // B's masthead, drawn in B's page.
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
        await waitForEditor(app.body("A"), "alpha");

        // Dirty card B, then return to the (clean) card A — the user's
        // scenario: the dirty buffer sits in a BACKGROUND tab.
        // The tab bar is drawn by the frontmost card's page: A's, here.
        await app.body("A").click(`[data-testid="tug-tab-B"]`);
        await app.body("B").waitForCondition<boolean>(
          `(function(){
            var el = document.querySelector('${B_EDITOR}');
            return el !== null && el.innerText.indexOf("other") !== -1;
          })()`,
          { timeoutMs: 15000 },
        );
        await settle();
        const typed = await app.body("B").evalJS<boolean>(
          `(function(){
            var el = document.querySelector('${B_EDITOR}');
            if (!el) return false;
            el.focus();
            return document.execCommand("insertText", false, "UNSAVED ");
          })()`,
        );
        expect(typed).toBe(true);
        await app.body("B").waitForCondition<boolean>(
          `(function(){
            var el = document.querySelector('${B_SAVE_LINE}');
            return el !== null && el.innerText.indexOf("Edited") === 0;
          })()`,
          { timeoutMs: 15000 },
        );
        await app.body("B").click(`[data-testid="tug-tab-A"]`);
        await settle();

        // Pane X: the whole pane is going away, so the dirty background
        // tab must be VISITED — activated and asked — never dropped
        // behind the Close-N-Tabs popover.
        await app.body("A").nativeClickAtElement(CLOSE_BUTTON);
        await settle();
        // The sheet is the dirty card's — B's — so it is read in B's page.
        await waitSheetButton(app.body("B"), "dont-save");
        // Visited: B's editor is the visible one while its sheet asks.
        expect(
          await app.body("B").evalJS<boolean>(
            `(function(){
              var el = document.querySelector('${B_EDITOR}');
              return el !== null && el.offsetParent !== null;
            })()`,
          ),
        ).toBe(true);
        await settle();

        // Cancel aborts the whole pane close; the edits survive.
        await app.body("B").click(`[data-testid="file-save-sheet-cancel"]`);
        await settle();
        expect(
          await app.body("B").evalJS<string>(`document.querySelector('${B_SAVE_LINE}').innerText`),
        ).toStartWith("Edited");

        // X again: Don't Save finishes the close directly — the visit
        // sequence collected the explicit decision, so the Close-N-Tabs
        // popover is superseded (no double prompt). The buffer's edits
        // never reach disk.
        // The visit left B frontmost, so the X is B's page's.
        await app.body("B").nativeClickAtElement(CLOSE_BUTTON);
        await settle();
        await waitSheetButton(app.body("B"), "dont-save");
        await settle();
        await app.body("B").click(`[data-testid="file-save-sheet-dont-save"]`);
        await waitForCardGone(app, "B");
        expect(fs.readFileSync(fileB, "utf8")).toBe("other\n");
      } finally {
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
