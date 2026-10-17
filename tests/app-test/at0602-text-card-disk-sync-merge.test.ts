/**
 * at0602-text-card-disk-sync-merge.test.ts — a dirty Text card merges a
 * write from outside the app instead of conflicting ([AT0602]).
 *
 * One piece of the at0602 split; the fixtures, deck shapes and instruments
 * are `text-card-disk-sync-fixture.ts`. Every fixture lives in an OS temp
 * directory, outside every workspace.
 *
 * 3. **A dirty buffer merges instead of conflicting.** The user's typing and
 *    an external edit in a distant region both survive, with no conflict
 *    banner and no conflict sheet — in automatic mode (where the merged text
 *    then autosaves, proving the baseline moved with it and the next
 *    conditional write is not a 409) and in manual mode, the shipping
 *    default. The typing goes in at the caret the card opens with — line 1 —
 *    and the external edit near the BOTTOM: CM6 owns its own selection, so
 *    the caret the harness can seat is the one the scenario uses.
 *    `_mergeOrConflict` patched to always conflict turned exactly these two
 *    tests red.
 *
 * 4. **A reload is not an undo step.** The `at0209` pin, re-run against a
 *    file outside every workspace: after the card adopts an external change
 *    on its own, Edit ▸ Undo still names the user's typing, and one undo
 *    removes that typing and leaves the reloaded lines.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/text-card-store.ts
 * @covers tugdeck/src/lib/file-watch-client.ts
 * @covers tugdeck/src/lib/three-way-merge.ts
 * @covers tugdeck/src/components/tugways/tug-text-card-editor.tsx
 * @covers tugdeck/src/components/tugways/cards/text-card.tsx
 * @covers tugrust/crates/tugcast/src/feeds/file_watch.rs
 * @covers tugdeck/src/components/chrome/space-layer.css
 * @covers tugdeck/src/components/chrome/space-layer.ts
 * @family at0602-text-card-disk-sync
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { launchTugApp } from "./_harness";
import { mkTextFixture } from "./_harness/fixtures";
import { AUTOMATIC_SAVE_MODE, mkSeededTugbank, rmTempTugbank } from "./_harness/tugbank-helpers";
import {
  AUTOSAVE_DEBOUNCE_MS,
  EDITOR_CONTENT_SELECTOR,
  EXTERNAL_LINE,
  FIXTURE_CONTENT,
  FIXTURE_LINES,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  TYPED_RUN,
  assertNoConflictSurface,
  editorText,
  proveWatchLive,
  rmFixture,
  seedTextCard,
  typeIntoEditor,
  undoOnce,
  waitForDisk,
  waitForEditorShowing,
  waitForUndoState,
} from "./text-card-disk-sync-fixture";

describe.skipIf(!SHOULD_RUN)("at0602: Text card disk sync", () => {
  // -------------------------------------------------------------------------
  // Scenario 3: a dirty buffer merges, in both save modes
  // -------------------------------------------------------------------------

  test(
    "automatic mode merges a distant external edit into a dirty buffer",
    async () => {
      const { dir, file } = mkTextFixture("at0602-merge-auto-", FIXTURE_CONTENT, { realpath: true });
      // A body Text card reads its save mode from the tugbank the app opens,
      // not from the shell's cache `seedTextCard` writes, so automatic is
      // seeded there too.
      const tugbankPath = mkSeededTugbank([AUTOMATIC_SAVE_MODE]);
      const app = await launchTugApp({ testName: "at0602-merge-automatic", env: { TUGBANK_PATH: tugbankPath } });
      try {
        await seedTextCard(app, file, "automatic");
        await waitForEditorShowing(app, "fixture line 01");
        await proveWatchLive(app, file, FIXTURE_CONTENT, "fixture line 01");

        // Dirty the buffer at the caret the card opened with — line 1 — and
        // put the external edit on line 20, far enough away that the two
        // sides never touch.
        await typeIntoEditor(app, TYPED_RUN);
        const external = FIXTURE_CONTENT.replace(
          FIXTURE_LINES[19] as string,
          EXTERNAL_LINE,
        );
        fs.writeFileSync(file, external, "utf8");

        await waitForEditorShowing(app, EXTERNAL_LINE, 20_000);
        const merged = await editorText(app);
        expect(merged, "the user's typing survived the merge").toContain(
          TYPED_RUN.trim(),
        );
        expect(merged).toContain("fixture line 01");
        await assertNoConflictSurface(app);

        // Automatic mode writes the merged text back on its own — and that
        // write is conditional on the baseline, so its landing is the proof
        // that the baseline moved to the disk's when the merge applied.
        const onDisk = await waitForDisk(
          file,
          (c) => c.includes(TYPED_RUN.trim()),
          15_000,
        );
        expect(onDisk, "the external edit is still on disk too").toContain(
          EXTERNAL_LINE,
        );
        await assertNoConflictSurface(app);
      } finally {
        await app.close();
        rmFixture(dir);
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "manual mode merges a distant external edit into a dirty buffer",
    async () => {
      const { dir, file } = mkTextFixture("at0602-merge-manual-", FIXTURE_CONTENT, { realpath: true });
      const app = await launchTugApp({ testName: "at0602-merge-manual" });
      try {
        await seedTextCard(app, file, "manual");
        await waitForEditorShowing(app, "fixture line 01");
        await proveWatchLive(app, file, FIXTURE_CONTENT, "fixture line 01");

        await typeIntoEditor(app, TYPED_RUN);
        const external = FIXTURE_CONTENT.replace(
          FIXTURE_LINES[19] as string,
          EXTERNAL_LINE,
        );
        fs.writeFileSync(file, external, "utf8");

        await waitForEditorShowing(app, EXTERNAL_LINE, 20_000);
        const merged = await editorText(app);
        expect(merged, "the user's typing survived the merge").toContain(
          TYPED_RUN.trim(),
        );
        expect(merged).toContain("fixture line 01");
        await assertNoConflictSurface(app);

        // Manual mode writes nothing without being asked, so the external
        // bytes are still exactly what is on disk.
        expect(fs.readFileSync(file, "utf8")).toBe(external);
      } finally {
        await app.close();
        rmFixture(dir);
      }
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Scenario 4: a reload is not an undo step
  // -------------------------------------------------------------------------
  //
  // In automatic mode the buffer is written back to disk on its own, so an
  // undo that resurrected the pre-reload text would silently overwrite the
  // external editor's work with bytes the user never asked for.

  test(
    "undo after an external reload removes only the user's typing",
    async () => {
      const UNDO_RUN = "UNDO-RUN-ONE ";
      const { dir, file } = mkTextFixture("at0602-undo-", FIXTURE_CONTENT, { realpath: true });
      const tugbankPath = mkSeededTugbank([AUTOMATIC_SAVE_MODE]);
      const app = await launchTugApp({ testName: "at0602-undo-after-reload", env: { TUGBANK_PATH: tugbankPath } });
      try {
        await seedTextCard(app, file, "automatic");
        await waitForEditorShowing(app, "fixture line 01");
        await proveWatchLive(app, file, FIXTURE_CONTENT, "fixture line 01");

        // One typed run, autosaved to disk. The buffer has to end CLEAN:
        // only a clean buffer adopts an external change silently.
        await typeIntoEditor(app, UNDO_RUN);
        await waitForDisk(file, (c) => c.includes(UNDO_RUN.trim()));
        // The write landing on disk is not the settle: the baseline moves on
        // the response, and a further keystroke-free debounce has to expire
        // before the store is quiet.
        await new Promise((resolve) =>
          setTimeout(resolve, AUTOSAVE_DEBOUNCE_MS + 500),
        );

        const external = fs
          .readFileSync(file, "utf8")
          .replace(FIXTURE_LINES[19] as string, EXTERNAL_LINE);
        expect(external).toContain(EXTERNAL_LINE);
        fs.writeFileSync(file, external, "utf8");
        await waitForEditorShowing(app, EXTERNAL_LINE, 20_000);

        // The machine's own word for what the next undo does: the typing is
        // still one undo step, and the reload added none of its own.
        const undoState = await waitForUndoState(app, {
          enabled: true,
          title: "Undo Typing",
        });
        expect(undoState.found, "Edit ▸ Undo must exist").toBe(true);
        expect(
          undoState.title,
          "Undo names the user's typing, not the reload",
        ).toBe("Undo Typing");

        await undoOnce(app);
        await app.body("A").waitForCondition<boolean>(
          `(function(){
            var el = document.querySelector('${EDITOR_CONTENT_SELECTOR}');
            return el !== null && el.innerText.indexOf(${JSON.stringify(UNDO_RUN.trim())}) === -1;
          })()`,
          { timeoutMs: 8000 },
        );
        const afterUndo = await editorText(app);
        expect(afterUndo).toContain(EXTERNAL_LINE);
        expect(afterUndo).toContain("fixture line 01");
      } finally {
        await app.close();
        rmFixture(dir);
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );

});
