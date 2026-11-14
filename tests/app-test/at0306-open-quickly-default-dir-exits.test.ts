/**
 * at0306-open-quickly-default-dir-exits.test.ts — Escape and an app switch
 * close the dialog from anywhere in it ([AT0306]).
 *
 * One of the at0306-open-quickly-default-dir split, a test to a file so each
 * launch fits its own budget. Why Open Quickly falls back to the default
 * project directory, and the shared selectors and helpers, are
 * `open-quickly-default-dir-fixture.ts`.
 *
 * @covers tugdeck/src/components/chrome/open-quickly-overlay.tsx
 * @covers tugdeck/src/lib/overlay-shell.ts
 * @covers tugdeck/src/lib/default-workspace-store.ts
 * @covers tugdeck/src/lib/host-menu-state.ts
 * @covers tugdeck/src/lib/open-file-in-card.ts
 * @covers tugdeck/src/components/chrome/modal-input-dialog.tsx
 * @covers tugdeck/src/components/chrome/modal-input-dialog.css
 * @covers tugdeck/src/components/tugways/cards/settings-general-body.tsx
 * @covers tugdeck/src/components/tugways/tug-combo-box.tsx
 * @covers tugdeck/src/components/tugways/tug-combo-box.css
 * @covers tugdeck/src/components/tugways/tug-file-chooser.tsx
 * @covers tugdeck/src/lib/dir-existence.ts
 * @covers tugdeck/src/settings-api.ts
 * @family at0306-open-quickly-default-dir
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, test } from "bun:test";
import { launchTugApp } from "./_harness";
import { overlayReady } from "./overlay-fixture";
import {
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  PANEL,
  INPUT,
  OVERLAY_ROOT,
  MARKER,
  BROWSE,
  RING,
  setInBoth,
} from "./open-quickly-default-dir-fixture";

describe.skipIf(!SHOULD_RUN)(
  "at0306: Open Quickly falls back to the default project directory",
  () => {
    test(
      "Escape and an app switch close the dialog from anywhere in it",
      async () => {
        // The two ways out that are the surface's, not the field's: Escape
        // resolves against the dialog's own focus mode from wherever the ring
        // is resting — including a stop with no DOM focus, where no field
        // keydown handler could stand in — and the app going inactive takes the
        // dialog with it, which is launcher semantics rather than modal
        // semantics (an alert must survive an app switch).
        const base = mkdtempSync(`${tmpdir()}/at0306-esc-`);
        mkdirSync(`${base}/tug`);
        writeFileSync(`${base}/tug/${MARKER}`, "in the default\n");

        const app = await launchTugApp({
          testName: "at0306-open-quickly-esc",
        });
        const panelUp = `document.querySelector(${JSON.stringify(PANEL)}) !== null`;
        try {
          const ui = await overlayReady(app);
          await ui.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(OVERLAY_ROOT)}) !== null`,
            { timeoutMs: 20000 },
          );
          await setInBoth(app, ui,
            `(window.__tug.setTugbankValue("dev.tugapp.app", "default-project-path", { kind: "string", value: ${JSON.stringify(`${base}/tug`)} }), null)`,
          );

          const openOnBrowse = async (): Promise<void> => {
            await app.evalJS<null>(
              `(window.__tug.dispatchControlAction("open-quickly"), null)`,
            );
            await ui.waitForCondition<boolean>(
              `document.querySelector(${JSON.stringify(BROWSE)}) !== null`,
              { timeoutMs: 10000 },
            );
            await ui.waitForCondition<boolean>(
              `document.activeElement === document.querySelector(${JSON.stringify(INPUT)})`,
              { timeoutMs: 8000 },
            );
            await app.nativeKey("Tab");
            await ui.waitForCondition<boolean>(
              `${RING} === "tug-modal-input-dialog:1"`,
              { timeoutMs: 8000 },
            );
          };

          // Escape with the ring on the engine-routed Browse… stop closes the
          // DIALOG. This is the one the query field's own keydown handler could
          // never answer: it has no focus and sees no key.
          await openOnBrowse();
          await app.nativeKey("Escape");
          await ui.waitForCondition<boolean>(`!(${panelUp})`, {
            timeoutMs: 8000,
          });

          // The app yielding frontmost takes the dialog with it — driven by the
          // real `NSApp.deactivate()`, through the real AppDelegate lifecycle
          // frame, not a synthesized blur.
          await openOnBrowse();
          await app.simulateAppResign();
          await ui.waitForCondition<boolean>(`!(${panelUp})`, {
            timeoutMs: 8000,
          });
        } finally {
          await app.close();
          rmSync(base, { recursive: true, force: true });
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
