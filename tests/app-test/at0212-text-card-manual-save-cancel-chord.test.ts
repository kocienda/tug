/**
 * at0212-text-card-manual-save-cancel-chord.test.ts — ⌘. cancels the close
 * sheet a dirty Text card raises, exactly as clicking Cancel does ([AT0212],
 * [D126] ⌘. parity).
 *
 * One piece of the at0212 split; the deck shape and gestures are
 * `text-card-manual-save-fixture.ts`. The chord is a real native key, so it
 * travels the path the user's keyboard does: AppKit, the body's web view,
 * the page's keybinding funnel, then the sheet.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/cards/text-card-save-sheets.tsx
 * @covers tugdeck/src/components/tugways/tug-sheet.tsx
 * @covers tugdeck/src/components/tugways/keymap-registry.ts
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
  saveCell,
  seedTextCard,
  settle,
  typeIntoEditor,
  waitForEditor,
  waitForSaveCell,
  waitSheetButton,
} from "./text-card-manual-save-fixture";

const SHEET = `[data-slot="file-save-sheet"]`;

describe.skipIf(!SHOULD_RUN)("at0212: Text card close sheet cancel chord", () => {
  test(
    "⌘. dismisses the close sheet and keeps the card and its edits",
    async () => {
      const { dir, file } = mkTextFixture("at0212-", ORIGINAL, { name: "manual.txt" });
      const app = await launchTugApp({ testName: "at0212-cancel-chord" });
      try {
        await seedTextCard(app, file);
        await waitForEditor(app.body("A"), "alpha");
        await typeIntoEditor(app.body("A"), "UNSAVED ");
        await waitForSaveCell(app.body("A"), "Edited");
        await settle();

        await app.body("A").nativeClickAtElement(CLOSE_BUTTON);
        await settle();
        await waitSheetButton(app.body("A"), "cancel");
        // The open sheet holds the chain's first responder — the register the
        // registry's ⌘. binding dispatches to. Focus itself is parked on the
        // engine's key sink, outside the sheet, so no keydown handler inside
        // the sheet hears the key; the chain is the only way in.
        expect(
          await app.body("A").evalJS<boolean>(
            `(function(){
              var s = document.querySelector('${SHEET}');
              var fr = document.querySelector('[data-first-responder]');
              return s !== null && fr !== null && fr.contains(s);
            })()`,
          ),
          "the open close sheet holds the first responder",
        ).toBe(true);
        await settle();

        await app.nativeKey(".", ["cmd"]);
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector('${SHEET}') === null`,
          { timeoutMs: 6000 },
        );
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector('${EDITOR_CONTENT}') !== null`,
        );
        expect(await saveCell(app.body("A"))).toBe("Edited");
        expect(fs.readFileSync(file, "utf8")).toBe(ORIGINAL);
      } finally {
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
