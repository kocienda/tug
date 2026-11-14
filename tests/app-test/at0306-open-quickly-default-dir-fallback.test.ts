/**
 * at0306-open-quickly-default-dir-fallback.test.ts — with zero cards open,
 * ⇧⌘O searches the default directory and opens a file ([AT0306]).
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
import { describe, expect, test } from "bun:test";
import { launchTugApp } from "./_harness";
import { overlayReady } from "./overlay-fixture";
import {
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  PANEL,
  INPUT,
  ROWS,
  OVERLAY_ROOT,
  MARKER,
  CHOOSER,
  setInBoth,
  typeIntoField,
} from "./open-quickly-default-dir-fixture";

describe.skipIf(!SHOULD_RUN)(
  "at0306: Open Quickly falls back to the default project directory",
  () => {
    test(
      "with zero cards open, ⇧⌘O searches the default directory and opens a file",
      async () => {
        const dir = mkdtempSync(`${tmpdir()}/at0306-projects-`);
        const leaf = dir.split("/").pop() ?? "";
        mkdirSync(`${dir}/nested`, { recursive: true });
        writeFileSync(`${dir}/${MARKER}`, "hello from the default directory\n");
        writeFileSync(`${dir}/nested/other.txt`, "unrelated\n");

        const app = await launchTugApp({
          testName: "at0306-open-quickly-default-dir",
        });
        try {
          const ui = await overlayReady(app);
          await ui.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(OVERLAY_ROOT)}) !== null`,
            { timeoutMs: 20000 },
          );

          // The deck is empty and nothing is bound — the state that used to
          // grey the menu item out.
          expect(
            await app.evalJS<number>(
              `window.tugdeck.diag.getDeckState().cards.length`,
            ),
          ).toBe(0);

          // …and File ▸ Open Quickly is enabled anyway. This is the gate that
          // used to read `frontmostProjectBinding()?.projectDir`.
          const menuItem = await app.menuItemState("file.openQuickly");
          expect(menuItem.found).toBe(true);
          expect(menuItem.found && menuItem.enabled).toBe(true);

          await setInBoth(app, ui,
            `(window.__tug.setTugbankValue("dev.tugapp.app", "default-project-path", { kind: "string", value: ${JSON.stringify(dir)} }), null)`,
          );

          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("open-quickly"), null)`,
          );
          await ui.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(PANEL)}) !== null`,
            { timeoutMs: 8000 },
          );

          // The placeholder names the fallback root's leaf directory.
          await ui.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(INPUT)})
               .getAttribute("placeholder") === ${JSON.stringify(`Open Quickly in ${leaf}`)}`,
            { timeoutMs: 8000 },
          );
          // …and the scope row opens on the whole path, not a leaf.
          await ui.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(CHOOSER)}).value === ${JSON.stringify(dir)}`,
            { timeoutMs: 8000 },
          );

          // The acquisition + index round trip lands and the marker shows up.
          await typeIntoField(ui, "at0306-marker");
          await ui.waitForCondition<boolean>(
            `Array.from(document.querySelectorAll(${JSON.stringify(ROWS)}))
               .some((el) => (el.textContent || "").indexOf(${JSON.stringify(MARKER)}) !== -1)`,
            { timeoutMs: 15000 },
          );

          // Enter commits the highlighted row, which opens a Text card on a
          // deck that had none.
          await ui.evalJS<null>(
            `(function(){
               document.querySelector(${JSON.stringify(INPUT)}).dispatchEvent(
                 new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
               return null;
             })()`,
          );
          await ui.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(PANEL)}) === null`,
            { timeoutMs: 8000 },
          );
          await app.waitForCondition<boolean>(
            `window.tugdeck.diag.getDeckState().cards.filter(
               (c) => c.componentId === "text").length === 1`,
            { timeoutMs: 15000 },
          );

          // The card is bound to the file the row named. Asserting the bound
          // path (not the card title, which is the registration's) pins the
          // whole chain: FILETREE answered a project-relative result, the
          // overlay resolved it against the acquired workspace's root, and
          // the Text card mounted on that absolute path. macOS canonicalizes
          // the temp dir (`/var` → `/private/var`), so the tail is what's
          // stable to compare.
          const boundPath = await app.waitForCondition<string>(
            `(function(){
               var card = window.tugdeck.diag.getDeckState().cards.find(
                 (c) => c.componentId === "text");
               if (card === undefined) return false;
               var state = window.tugdeck.diag.getCardState(card.id);
               var path = state && state.content ? state.content.path : null;
               return typeof path === "string" && path !== "" ? path : false;
             })()`,
            { timeoutMs: 15000 },
          );
          expect(boundPath.endsWith(`/${leaf}/${MARKER}`)).toBe(true);
        } finally {
          await app.close();
          rmSync(dir, { recursive: true, force: true });
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
