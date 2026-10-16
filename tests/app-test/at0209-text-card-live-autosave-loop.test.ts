/**
 * at0209-text-card-live-autosave-loop.test.ts — Text card core loop
 * ([AT0209]): open a real file from disk, live autosave-in-place, conflict
 * adjudication, and quit-flush + relaunch restore.
 *
 * One piece of the at0209 split; the fixtures, deck shape and gestures are
 * `text-card-live-autosave-fixture.ts`.
 *
 * 1. **Open → edit → autosave → conflict → reload.** Seeds a Text card bound
 *    to a real temp fixture, asserts the editor renders the disk content,
 *    types into the editor and asserts the edit lands ON DISK within the
 *    autosave window (no explicit save), then writes the file externally +
 *    types again and asserts the hash-conditional write raises the conflict
 *    banner instead of clobbering; "Reload from Disk" adopts the external
 *    content and clears the banner.
 *
 * 2. **Quit-flush + relaunch.** Types an edit and quits INSIDE the debounce
 *    window; asserts the deactivation/teardown flush landed the edit on disk
 *    after process exit. A second app process re-opens the file and shows
 *    the flushed content.
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
import { launchTugApp } from "./_harness";
import { mkTextFixture } from "./_harness/fixtures";
import {
  EDITOR_CONTENT_SELECTOR,
  FIXTURE_CONTENT,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  rmFixture,
  seedTextCard,
  typeIntoEditor,
  waitForDisk,
  waitForEditorShowing,
} from "./text-card-live-autosave-fixture";

// ---------------------------------------------------------------------------
// Scenario 1: open → edit → autosave → conflict → reload
// ---------------------------------------------------------------------------

describe.skipIf(!SHOULD_RUN)("at0209: Text card live autosave", () => {
  test(
    "open, autosave-to-disk, conflict banner, reload-from-disk",
    async () => {
      const { dir, file } = mkTextFixture("at0209-", FIXTURE_CONTENT);
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
      const { dir, file } = mkTextFixture("at0209-", FIXTURE_CONTENT);

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
});
