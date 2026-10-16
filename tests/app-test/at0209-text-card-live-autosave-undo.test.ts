/**
 * at0209-text-card-live-autosave-undo.test.ts — a reload of a Text card is
 * not an undo step ([AT0209]).
 *
 * One piece of the at0209 split; the fixtures, deck shape and gestures are
 * `text-card-live-autosave-fixture.ts`.
 *
 * 4. **Undo after a reload.** A clean buffer adopts an external change
 *    silently, and one ⌘Z afterwards removes the user's own typing and
 *    nothing else — the reloaded lines stay. The second case has nothing
 *    typed at all, so undo has nothing to offer and the buffer still equals
 *    disk. This is the guard on the automatic-mode hazard: an undo that
 *    resurrected the pre-reload text would be written straight back over the
 *    external editor's work.
 *
 * The card has to hear the external write on its own, and a client only
 * receives FILESYSTEM frames for the bootstrap workspace — under the harness
 * this checkout — so the fixture sits in the checkout's gitignored `.tug/`.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/cards/text-card.tsx
 * @covers tugdeck/src/lib/text-card-store.ts
 * @covers tugdeck/src/lib/file-io.ts
 * @covers tugdeck/src/components/tugways/tug-text-card-editor/
 * @covers tugdeck/src/components/tugways/tug-text-card-editor.css
 * @covers tugdeck/src/components/tugways/tug-text-card-editor.tsx
 * @family at0209-text-card-live-autosave
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { rmTempTugbank } from "./_harness/tugbank-helpers";
import {
  AUTOSAVE_DEBOUNCE_MS,
  EDITOR_CONTENT_SELECTOR,
  FIXTURE_LINES,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  editorText,
  launchOnWatchedFixture,
  mkWatchedFixture,
  rmFixture,
  typeIntoEditor,
  undoOnce,
  waitForDisk,
  waitForEditorShowing,
  waitForUndoState,
} from "./text-card-live-autosave-fixture";

describe.skipIf(!SHOULD_RUN)("at0209: Text card live autosave", () => {
  // -------------------------------------------------------------------------
  // Scenario 4: a reload is not an undo step
  // -------------------------------------------------------------------------
  //
  // In automatic mode the buffer is written back to disk on its own, so an
  // undo that resurrected the pre-reload text would silently overwrite the
  // external editor's work with bytes the user never asked for. The reload
  // therefore goes in with `Transaction.addToHistory.of(false)`: ⌘Z steps
  // back through the user's typing only, and the reloaded lines stay put.

  test(
    "undo after reload removes only the user's typing",
    async () => {
      const TYPED_RUN = "UNDO-RUN-ONE ";
      const EXTERNAL_LINE = "EXTERNAL-WRITER LINE TWENTY";
      const { dir, file } = mkWatchedFixture("at0209-undo");
      const { app, tugbankPath } = await launchOnWatchedFixture(
        file,
        "at0209-undo-after-reload",
      );
      try {
        // One typed run, autosaved to disk. The buffer has to end CLEAN:
        // only a clean buffer adopts an external change silently — a dirty
        // automatic one leaves the verdict to its next conditional write.
        await typeIntoEditor(app, TYPED_RUN);
        await waitForDisk(file, (c) => c.includes(TYPED_RUN.trim()));
        // The write landing on disk is not the settle: the baseline moves on
        // the response, and a further keystroke-free debounce has to expire
        // before the store is quiet. Write externally before that and the
        // save races the external writer.
        await new Promise((resolve) =>
          setTimeout(resolve, AUTOSAVE_DEBOUNCE_MS + 500),
        );

        // External change FAR from the typed run — line 20, while the typed
        // run sits on line 1 — so "the typing went away" and "the reload
        // stayed" are two separate observations.
        const external = fs
          .readFileSync(file, "utf8")
          .replace(FIXTURE_LINES[19] as string, EXTERNAL_LINE);
        expect(external).toContain(EXTERNAL_LINE);
        fs.writeFileSync(file, external, "utf8");
        await waitForEditorShowing(app, EXTERNAL_LINE, 30_000);

        // The machine's own word for what the next ⌘Z does: the typing is
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
        await app.waitForCondition<boolean>(
          `(function(){
            var el = document.querySelector('${EDITOR_CONTENT_SELECTOR}');
            return el !== null && el.innerText.indexOf(${JSON.stringify(TYPED_RUN.trim())}) === -1;
          })()`,
          { timeoutMs: 8000 },
        );
        const afterUndo = await editorText(app);
        expect(afterUndo).toContain(EXTERNAL_LINE);
        expect(afterUndo).toContain("fixture line 01");
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
        rmFixture(dir);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "undo on a freshly reloaded buffer leaves it equal to disk",
    async () => {
      const EXTERNAL_LINE = "EXTERNAL-WRITER FRESH OPEN";
      const { dir, file } = mkWatchedFixture("at0209-undo-fresh");
      const { app, tugbankPath } = await launchOnWatchedFixture(
        file,
        "at0209-undo-fresh-open",
      );
      try {
        // Nothing typed here at all. The reloads this card has already seen
        // (the watcher warm-up, then this write) are the only transactions
        // it has ever dispatched, and none of them is undoable.
        const external = fs
          .readFileSync(file, "utf8")
          .replace(FIXTURE_LINES[19] as string, EXTERNAL_LINE);
        fs.writeFileSync(file, external, "utf8");
        await waitForEditorShowing(app, EXTERNAL_LINE, 30_000);

        const undoState = await waitForUndoState(app, { enabled: false });
        expect(undoState.found, "Edit ▸ Undo must exist").toBe(true);
        expect(
          undoState.enabled,
          "a buffer that was only ever reloaded has nothing to undo",
        ).toBe(false);

        await undoOnce(app);
        // An undo that DID fire would land within a frame or two; give it
        // that long before reading, or "nothing happened" is vacuous.
        await new Promise((resolve) => setTimeout(resolve, 750));
        const afterUndo = await editorText(app);
        expect(afterUndo).toContain(EXTERNAL_LINE);
        expect(afterUndo).not.toContain(FIXTURE_LINES[19] as string);
        // Nothing was written back either: disk is still the external bytes.
        expect(fs.readFileSync(file, "utf8")).toBe(external);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
        rmFixture(dir);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
