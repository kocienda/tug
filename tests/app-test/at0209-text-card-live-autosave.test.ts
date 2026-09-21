/**
 * at0209-text-card-live-autosave.test.ts — Text card core loop
 * ([AT0209]): open a real file from disk, live autosave-in-place,
 * conflict adjudication, and quit-flush + relaunch restore.
 *
 * ## Scenarios
 *
 * 1. **Open → edit → autosave → conflict → reload.** Seeds a Text card
 *    bound to a real temp fixture, asserts the editor renders the disk
 *    content, types into the editor and asserts the edit lands ON DISK
 *    within the autosave window (no explicit save), then writes the
 *    file externally + types again and asserts the hash-conditional
 *    write raises the conflict banner instead of clobbering; "Reload
 *    from Disk" adopts the external content and clears the banner.
 *
 * 2. **Quit-flush + relaunch.** Types an edit and quits INSIDE the
 *    debounce window; asserts the deactivation/teardown flush landed
 *    the edit on disk after process exit. A second app process re-opens
 *    the file and shows the flushed content.
 *
 * Everything drives real code paths on real files: the fixture is a
 * real temp file, autosave goes through tugcast's `/api/fs/write`, and
 * the assertions read disk with Bun's fs — no mocks anywhere.
 *
 * Input path: edits are driven by focusing CM6's contenteditable and
 * running `document.execCommand("insertText")`, which fires the REAL
 * beforeinput → CM6 input pipeline (the same handler keystrokes reach).
 * Native CGEvent typing needs the app frontmost, which unattended
 * sweeps can't guarantee; the editor's input handling itself is not
 * what this test gates — the autosave loop is.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/cards/text-card.tsx
 * @covers tugdeck/src/lib/text-card-store.ts
 * @covers tugdeck/src/lib/file-io.ts
 * @covers tugdeck/src/components/tugways/tug-text-card-editor/
 * @covers tugdeck/src/components/tugways/tug-text-card-editor.css
 * @covers tugdeck/src/components/tugways/tug-text-card-editor.tsx
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const TEST_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const FIXTURE_LINES: ReadonlyArray<string> = Array.from(
  { length: 24 },
  (_, i) => `fixture line ${String(i + 1).padStart(2, "0")} alpha beta gamma`,
);
const FIXTURE_CONTENT = FIXTURE_LINES.join("\n") + "\n";

function mkFixture(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "at0209-"));
  const file = path.join(dir, "sample.txt");
  fs.writeFileSync(file, FIXTURE_CONTENT, "utf8");
  return { dir, file };
}

function rmFixture(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Deck seeding
// ---------------------------------------------------------------------------

const EDITOR_CONTENT_SELECTOR =
  '[data-card-id="A"] [data-slot="tug-text-card-editor"] .cm-content';

const EDITOR_SCROLLER_SELECTOR =
  '[data-card-id="A"] [data-slot="tug-text-card-editor"] .cm-scroller';

// A tall fixture — enough lines to scroll well past the 560px pane so a
// nonzero scrollTop is a real viewport offset, not a rounding artifact.
const TALL_LINES: ReadonlyArray<string> = Array.from(
  { length: 200 },
  (_, i) => `tall line ${String(i + 1).padStart(3, "0")} alpha beta gamma delta`,
);
const TALL_CONTENT = TALL_LINES.join("\n") + "\n";

function mkTallFixture(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "at0209-tall-"));
  const file = path.join(dir, "tall.txt");
  fs.writeFileSync(file, TALL_CONTENT, "utf8");
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

/**
 * Seed the deck-wide save-mode default to "automatic" BEFORE the card
 * mounts. Manual is now the shipping default ([P01]); this test exercises
 * the retained automatic live-autosave path, so it opts in explicitly —
 * `setTugbankValue` populates the same client cache `readSaveMode` reads.
 */
async function seedAutomaticSaveMode(app: App): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.setTugbankValue("dev.tugapp.text-card","save-mode",{kind:"string",value:"automatic"}), null)`,
  );
}

async function seedTextCard(app: App, filePath: string): Promise<void> {
  await seedAutomaticSaveMode(app);
  await app.seedDeckState({
    state: deckShape(),
    cardStates: {
      A: {
        content: {
          path: filePath,
          anchor: { line: 1, ch: 0 },
          scrollTop: 0,
        },
      },
    },
    focusCardId: "A",
  });
}

/** Wait until the editor is mounted and renders a sentinel line. */
async function waitForEditorShowing(
  app: App,
  sentinel: string,
  timeoutMs = 8000,
): Promise<void> {
  await app.waitForCondition<boolean>(
    `(function(){
      var el = document.querySelector('${EDITOR_CONTENT_SELECTOR}');
      return el !== null && el.innerText.indexOf(${JSON.stringify(sentinel)}) !== -1;
    })()`,
    { timeoutMs },
  );
}

/**
 * Type into the editor through CM6's real input pipeline: focus the
 * contenteditable and insert via `execCommand("insertText")`, which
 * fires beforeinput exactly like a keystroke.
 */
async function typeIntoEditor(app: App, text: string): Promise<void> {
  const ok = await app.evalJS<boolean>(
    `(function(){
      var el = document.querySelector('${EDITOR_CONTENT_SELECTOR}');
      if (!el) return false;
      el.focus();
      return document.execCommand("insertText", false, ${JSON.stringify(text)});
    })()`,
  );
  if (!ok) {
    throw new Error("[at0209] typeIntoEditor: insertText was not handled");
  }
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
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `[at0209] disk predicate not satisfied within ${timeoutMs}ms; last content:\n${last.slice(0, 400)}`,
  );
}

// ---------------------------------------------------------------------------
// Scenario 1: open → edit → autosave → conflict → reload
// ---------------------------------------------------------------------------

describe.skipIf(!SHOULD_RUN)("at0209: Text card live autosave", () => {
  test(
    "open, autosave-to-disk, conflict banner, reload-from-disk",
    async () => {
      const { dir, file } = mkFixture();
      const app = await launchTugApp({ testName: "at0209-core-loop" });
      try {
        await seedTextCard(app, file);
        await waitForEditorShowing(app, "fixture line 01");
        // The whole fixture is present (24 short lines all render).
        const rendered = await app.evalJS<string>(
          `document.querySelector('${EDITOR_CONTENT_SELECTOR}').innerText`,
        );
        expect(rendered).toContain("fixture line 24");

        // Type through CM6's real input pipeline, arming the autosave
        // debounce.
        await typeIntoEditor(app, "AUTOSAVED-EDIT ");

        // No explicit save: the debounce flush must land the edit on
        // the real file.
        const afterEdit = await waitForDisk(file, (c) =>
          c.includes("AUTOSAVED-EDIT"),
        );
        expect(afterEdit).toContain("fixture line 24");

        // External change + unflushed local edit → the conditional
        // write must 409 into the conflict banner, and the external
        // content must survive on disk untouched.
        const EXTERNAL = "EXTERNAL-WRITER CONTENT\n" + FIXTURE_CONTENT;
        fs.writeFileSync(file, EXTERNAL, "utf8");
        await typeIntoEditor(app, "LOCAL-EDIT ");
        // The conflict banner is a TugPaneBanner, portaled into the
        // pane chrome — outside the card-id subtree, so the probe is
        // document-wide.
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-testid="text-card-conflict-reload"]') !== null`,
          { timeoutMs: 8000 },
        );
        expect(fs.readFileSync(file, "utf8")).toBe(EXTERNAL);

        // Reload from disk: buffer adopts the external content, the
        // banner clears, autosave resumes cleanly.
        await app.click('[data-testid="text-card-conflict-reload"]');
        await waitForEditorShowing(app, "EXTERNAL-WRITER CONTENT");
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-testid="text-card-conflict-reload"]') === null`,
          { timeoutMs: 6000 },
        );
        expect(fs.readFileSync(file, "utf8")).toBe(EXTERNAL);
      } finally {
        await app.close();
        rmFixture(dir);
      }
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Scenario 2: quit inside the debounce window → flush lands → relaunch
  // -------------------------------------------------------------------------

  test(
    "quit-flush inside the debounce window, relaunch re-opens from disk",
    async () => {
      const { dir, file } = mkFixture();

      // Phase A: type and quit immediately — the teardown flush (not
      // the debounce timer) must land the edit.
      {
        const appA = await launchTugApp({ testName: "at0209-quit-A" });
        let closed = false;
        try {
          await seedTextCard(appA, file);
          await waitForEditorShowing(appA, "fixture line 01");
          await typeIntoEditor(appA, "QUIT-FLUSH-EDIT ");
          await appA.quitGracefully();
          closed = true;
        } finally {
          if (!closed) await appA.close();
        }
      }

      const afterQuit = await waitForDisk(
        file,
        (c) => c.includes("QUIT-FLUSH-EDIT"),
        10_000,
      );
      expect(afterQuit).toContain("fixture line 24");

      // Phase B: a fresh process re-opens the file and shows the
      // flushed content (disk is the only source of truth).
      {
        const appB = await launchTugApp({ testName: "at0209-quit-B" });
        try {
          await seedTextCard(appB, file);
          await waitForEditorShowing(appB, "QUIT-FLUSH-EDIT");
        } finally {
          await appB.close();
        }
      }

      rmFixture(dir);
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Scenario 3: in-place reload holds the reader's place
  // -------------------------------------------------------------------------
  //
  // An in-place disk reload (here the conflict-banner "Reload from Disk",
  // which routes through the store's `replaceText` bridge) must leave the
  // TEXT at the top of the viewport where it was. The external writer here
  // adds a line ABOVE the viewport, which is what tells the two possible
  // answers apart: holding the pixel `scrollTop` would slide every visible
  // line down by one row, and holding the text moves `scrollTop` by exactly
  // that row. `replaceText` dispatches the minimal change set, so CM6 maps
  // its own scroll anchor through the insertion and the text does not move.
  //
  // Only scroll is asserted here: CM6 owns the selection (it resets any
  // DOM-seated range back to its own state, and `window.getSelection()`
  // doesn't reflect the editor's selection through the harness), so a
  // multi-char selection can't be seated/read from an app-test. The selection
  // is mapped through the same change set by CM6 itself.
  test(
    "in-place reload holds the text at the viewport top",
    async () => {
      const { dir, file } = mkTallFixture();
      const app = await launchTugApp({ testName: "at0209-reload-restore" });
      try {
        await seedTextCard(app, file);
        await waitForEditorShowing(app, "tall line 001");

        // Drive to a conflict: flush a local edit to disk, change the file
        // externally, then edit again so the conditional write 409s into the
        // banner (the same setup Scenario 1 proves). The external content is
        // itself tall, so a mid-document scrollTop stays valid after reload.
        await typeIntoEditor(app, "EDIT1 ");
        await waitForDisk(file, (c) => c.includes("EDIT1"));
        const EXTERNAL = "EXTERNAL-WRITER LINE\n" + TALL_CONTENT;
        fs.writeFileSync(file, EXTERNAL, "utf8");
        await typeIntoEditor(app, "EDIT2 ");
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-testid="text-card-conflict-reload"]') !== null`,
          { timeoutMs: 8000 },
        );

        // Park the viewport at a real mid-document offset, then read WHICH
        // line sits at the viewport top and how far down its row starts.
        await app.evalJS<null>(
          `(document.querySelector('${EDITOR_SCROLLER_SELECTOR}').scrollTop = 900, null)`,
        );
        const readTop = `(function(){
          var scroller = document.querySelector('${EDITOR_SCROLLER_SELECTOR}');
          var box = scroller.getBoundingClientRect();
          var lines = scroller.querySelectorAll('.cm-line');
          for (var i = 0; i < lines.length; i++) {
            var r = lines[i].getBoundingClientRect();
            if (r.bottom > box.top + 1) {
              return { text: lines[i].textContent, delta: r.top - box.top, scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight };
            }
          }
          return null;
        })()`;
        await app.waitForCondition<boolean>(
          `(function(){ var t = ${readTop}; return t !== null && t.scrollTop > 200 && t.text.indexOf("tall line") === 0; })()`,
          { timeoutMs: 6000 },
        );
        const before = await app.evalJS<{ text: string; delta: number; scrollTop: number; scrollHeight: number }>(readTop);

        // Reload from disk (in-place) — adopts the external content.
        await app.click('[data-testid="text-card-conflict-reload"]');
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-testid="text-card-conflict-reload"]') === null`,
          { timeoutMs: 6000 },
        );

        // The reload landed (the added row made the content taller) and the
        // same text is still at the same place.
        await app.waitForCondition<boolean>(
          `document.querySelector('${EDITOR_SCROLLER_SELECTOR}').scrollHeight > ${before.scrollHeight} + 4`,
          { timeoutMs: 6000 },
        );
        const after = await app.evalJS<{ text: string; delta: number; scrollTop: number; scrollHeight: number }>(readTop);
        expect(after.text).toBe(before.text);
        expect(Math.abs(after.delta - before.delta)).toBeLessThanOrEqual(2);

        // And the disk content really is in the buffer.
        await app.evalJS<null>(
          `(document.querySelector('${EDITOR_SCROLLER_SELECTOR}').scrollTop = 0, null)`,
        );
        await waitForEditorShowing(app, "EXTERNAL-WRITER LINE");
      } finally {
        await app.close();
        rmFixture(dir);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
