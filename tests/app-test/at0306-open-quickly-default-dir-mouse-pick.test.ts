/**
 * at0306-open-quickly-default-dir-mouse-pick.test.ts — a mouse pick in the
 * scope row's dropdown retargets the search ([AT0306]).
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

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
  DROPDOWN,
  DROPDOWN_ITEMS,
  OTHER_MARKER,
  setInBoth,
  typeIntoField,
} from "./open-quickly-default-dir-fixture";

describe.skipIf(!SHOULD_RUN)(
  "at0306: Open Quickly falls back to the default project directory",
  () => {
    test(
      "a mouse pick in the scope row's dropdown retargets the search",
      async () => {
        // Two directories with disjoint contents: the default, and a recent
        // project. The scope row offers both, so picking the second must swap
        // the search root — placeholder, result list, and all.
        //
        // Driven with the real mouse, because that is the interaction the
        // modal treatment most nearly breaks: under `disableOutsidePointerEvents`
        // the body is `pointer-events: none` and only registered layers get it
        // back, so a dropdown portalled to the canvas overlay root would render
        // and be unclickable. It portals into the panel instead.
        const dir = mkdtempSync(`${tmpdir()}/at0306-default-`);
        const other = mkdtempSync(`${tmpdir()}/at0306-other-`);
        const otherLeaf = other.split("/").pop() ?? "";
        writeFileSync(`${dir}/${MARKER}`, "in the default directory\n");
        writeFileSync(`${other}/${OTHER_MARKER}`, "somewhere else\n");

        const app = await launchTugApp({
          testName: "at0306-open-quickly-chooser",
        });
        try {
          const ui = await overlayReady(app);
          await ui.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(OVERLAY_ROOT)}) !== null`,
            { timeoutMs: 20000 },
          );
          await setInBoth(app, ui,
            `(window.__tug.setTugbankValue("dev.tugapp.app", "default-project-path", { kind: "string", value: ${JSON.stringify(dir)} }),
              window.__tug.setTugbankValue("dev.tugapp.dev", "recent-projects", { kind: "json", value: { paths: [${JSON.stringify(other)}] } }),
              null)`,
          );

          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("open-quickly"), null)`,
          );
          await ui.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(CHOOSER)}) !== null`,
            { timeoutMs: 8000 },
          );

          // The row sits inside the panel, ABOVE the query field — the read
          // order the walk order matches.
          expect(
            await ui.evalJS<boolean>(
              `(function(){
                 var panel = document.querySelector(${JSON.stringify(PANEL)});
                 var input = document.querySelector(${JSON.stringify(INPUT)});
                 var chooser = document.querySelector(${JSON.stringify(CHOOSER)});
                 return panel !== null && chooser !== null && panel.contains(chooser) &&
                   (input.compareDocumentPosition(chooser) & Node.DOCUMENT_POSITION_PRECEDING) !== 0;
               })()`,
            ),
          ).toBe(true);

          // Open the dropdown with a real click. The dialog must stay up: the
          // dropdown is inside the panel, so nothing about this is "outside".
          await ui.nativeClickAtElement(CHOOSER);
          await ui.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(DROPDOWN)}) !== null`,
            { timeoutMs: 8000 },
          );
          expect(
            await ui.evalJS<boolean>(
              `document.querySelector(${JSON.stringify(PANEL)})
                 .contains(document.querySelector(${JSON.stringify(DROPDOWN)}))`,
            ),
            "the dropdown portals inside the panel, where the pointer can reach it",
          ).toBe(true);
          expect(
            await ui.evalJS<string>(
              `getComputedStyle(document.querySelector(${JSON.stringify(DROPDOWN_ITEMS)})).pointerEvents`,
            ),
            "a modal content leaves everything outside it pointer-dead",
          ).not.toBe("none");

          // Pick the recent project by clicking its row.
          const index = await ui.evalJS<number>(
            `Array.from(document.querySelectorAll(${JSON.stringify(DROPDOWN_ITEMS)}))
               .findIndex((el) => (el.textContent || "").indexOf(${JSON.stringify(other)}) !== -1)`,
          );
          expect(index).toBeGreaterThanOrEqual(0);
          await ui.nativeClickAtElement(
            `${DROPDOWN} li:nth-child(${index + 1})`,
          );

          // The dialog survived the pick…
          expect(
            await ui.evalJS<boolean>(
              `document.querySelector(${JSON.stringify(PANEL)}) !== null`,
            ),
            "picking a row does not dismiss the dialog",
          ).toBe(true);

          // …the placeholder renames itself to the picked directory…
          await ui.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(INPUT)})
               .getAttribute("placeholder") === ${JSON.stringify(`Open Quickly in ${otherLeaf}`)}`,
            { timeoutMs: 10000 },
          );

          // …and the results come from it, not from the default directory.
          await typeIntoField(ui, "at0306-");
          await ui.waitForCondition<boolean>(
            `(function(){
               var rows = Array.from(document.querySelectorAll(${JSON.stringify(ROWS)}))
                 .map((el) => el.textContent || "");
               return rows.length > 0 &&
                 rows.some((t) => t.indexOf(${JSON.stringify(OTHER_MARKER)}) !== -1) &&
                 !rows.some((t) => t.indexOf(${JSON.stringify(MARKER)}) !== -1);
             })()`,
            { timeoutMs: 15000 },
          );

          // Escape still dismisses from anywhere in the surface.
          await app.nativeKey("Escape");
          await ui.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(PANEL)}) === null`,
            { timeoutMs: 8000 },
          );
        } finally {
          await app.close();
          rmSync(dir, { recursive: true, force: true });
          rmSync(other, { recursive: true, force: true });
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
