/**
 * at0306-open-quickly-default-dir-places.test.ts — the scope row names each
 * place once, and an empty directory says so ([AT0306]).
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

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { launchTugApp, note } from "./_harness";
import { overlayReady } from "./overlay-fixture";
import {
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  OVERLAY_ROOT,
  CHOOSER,
  DROPDOWN,
  DROPDOWN_ITEMS,
  setInBoth,
} from "./open-quickly-default-dir-fixture";

describe.skipIf(!SHOULD_RUN)(
  "at0306: Open Quickly falls back to the default project directory",
  () => {
    test(
      "the scope row names each place once, and an empty directory says so",
      async () => {
        // `b/proj` is a symlink to `a/proj` — one directory, two spellings, and
        // only the server can tell ([L29]). The default directory is empty.
        const base = mkdtempSync(`${tmpdir()}/at0306-places-`);
        mkdirSync(`${base}/tug`);
        mkdirSync(`${base}/a/proj`, { recursive: true });
        writeFileSync(`${base}/a/proj/alpha.txt`, "x\n");
        mkdirSync(`${base}/b`);
        symlinkSync(`${base}/a/proj`, `${base}/b/proj`);
        mkdirSync(`${base}/c/proj`, { recursive: true });

        const app = await launchTugApp({
          testName: "at0306-open-quickly-places",
        });
        try {
          const ui = await overlayReady(app);
          await ui.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(OVERLAY_ROOT)}) !== null`,
            { timeoutMs: 20000 },
          );
          await setInBoth(app, ui,
            `(window.__tug.setTugbankValue("dev.tugapp.app", "default-project-path", { kind: "string", value: ${JSON.stringify(`${base}/tug`)} }),
              window.__tug.setTugbankValue("dev.tugapp.dev", "recent-projects", { kind: "json", value: { paths: [
                ${JSON.stringify(`${base}/a/proj`)},
                ${JSON.stringify(`${base}/b/proj`)},
                ${JSON.stringify(`${base}/c/proj`)}
              ] } }), null)`,
          );

          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("open-quickly"), null)`,
          );
          await ui.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(CHOOSER)}) !== null`,
            { timeoutMs: 8000 },
          );

          // The default directory is empty — say so rather than showing a
          // blank panel that reads as a hang.
          await ui.waitForCondition<boolean>(
            `(document.querySelector('[data-slot="tug-modal-input-dialog-empty"]')
               || {}).textContent === "No files in tug"`,
            { timeoutMs: 15000 },
          );

          await ui.nativeClickAtElement(CHOOSER);
          await ui.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(DROPDOWN)}) !== null`,
            { timeoutMs: 8000 },
          );
          const items = JSON.parse(
            await ui.evalJS<string>(
              `JSON.stringify(Array.from(document.querySelectorAll(${JSON.stringify(DROPDOWN_ITEMS)}))
                 .map(function (el) { return (el.textContent || "").trim(); }))`,
            ),
          ) as string[];
          note(`scope seed offered: ${items.join(" | ")}`);

          // The symlink collapsed into its target: three recents, two places,
          // plus the default. Whole paths, so the two real `proj` directories
          // need no disambiguation — the thing the retired switcher's label
          // machinery existed to do.
          const seeded = items.filter((t) => t.startsWith(base));
          expect(seeded).toEqual([
            `${base}/tug`,
            `${base}/a/proj`,
            `${base}/c/proj`,
          ]);
        } finally {
          await app.close();
          rmSync(base, { recursive: true, force: true });
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
