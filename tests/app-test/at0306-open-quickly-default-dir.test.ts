/**
 * at0306-open-quickly-default-dir.test.ts — Open Quickly with nothing open
 * falls back to the default project directory, and its scope row re-points the
 * search ([AT0306]).
 *
 * Scenario:
 *
 *   Point `dev.tugapp.app / default-project-path` at a temp directory holding
 *   known files, then — with an empty deck and no session binding anywhere —
 *   send the `open-quickly` control the ⇧⌘O menu item dispatches. The dialog
 *   must name that directory in its placeholder, list its files as the query
 *   narrows, and open the committed one in a fresh Text card.
 *
 *   This is the end-to-end proof of the whole fallback path: the frontend
 *   resolves the setting, `POST /api/workspace/acquire` registers the
 *   directory as a browse hold on tugcast's WorkspaceRegistry, the FILETREE
 *   feed routes queries by that workspace's root, and `openFileInCard` creates
 *   a card on a deck that has none. at0213 covers the same dialog with no
 *   workspace at all; this one covers it with a workspace nothing bound.
 *
 *   The rest drive the `TugFileChooser` scope row that replaced the directory
 *   switcher. The switcher was a `TugPopupButton` whose Radix menu portalled
 *   outside the panel; the chooser's dropdown portals INSIDE it, because a
 *   modal Radix content makes every node outside itself pointer-dead. So a
 *   MOUSE pick in that dropdown is the interaction most at risk, and it is the
 *   one test 2 drives.
 *
 *   Test 3 covers what the row owes the user about the places it offers: two
 *   spellings of one directory are one entry (only the server can say they are
 *   the same, [L29]), and an empty directory says so instead of showing a blank
 *   panel. Leaf-name disambiguation is gone with the switcher — the seed shows
 *   whole paths, so there is nothing to tell apart.
 *
 *   Test 4 drives the row with REAL key events, asserting against the ENGINE's
 *   marks rather than `document.activeElement`: Tab moves the ring from the
 *   query field to the chooser, Enter claims the caret, ↓ opens the seed, ↓
 *   moves the highlight, Return accepts — and the key view comes back to the
 *   query field, because the user's next act after choosing a scope is typing a
 *   filename. It closes on the result list's own truthfulness, read as computed
 *   style: the highlight paints the solid selection fill while the field holds
 *   the caret, and stands down to an outline the moment the walk parks
 *   elsewhere and no key can move it.
 *
 *   Test 5 pins the changed-only guard on re-scoping, on the path where it is
 *   load-bearing. `TugComboBox` settles on blur, so leaving the chooser settles
 *   the path it holds; without the guard that settle re-scopes to the same
 *   place under its canonical name and re-seeds the key view, and the Tab walk
 *   appears to skip the chevron after it. It has to be driven with the MOUSE, because only a
 *   pointer grants the field real DOM focus — a keyboard walk parks it, and a
 *   parked field never blurs, so no keyboard sequence can reach the settle.
 *
 *   Test 6 pins the two exits that belong to the surface rather than the field:
 *   Escape resolves against the dialog's own focus mode from wherever the ring
 *   is resting, and the app going inactive takes the dialog with it.
 *
 *   Test 7 runs the setting and the dialog together, through the real write
 *   path and a real gesture: type a partial path into Settings ▸ General,
 *   accept the completion with Return, and open the dialog in the same breath.
 *
 * Gating
 * ------
 * `describe.skipIf(!SHOULD_RUN)`. CI and `bun x tsc --noEmit` runs without
 * `TUGAPP_APP_TEST=1` skip every test.
 *
 * @foreground
 * @covers tugdeck/src/components/chrome/open-quickly-overlay.tsx
 * @covers tugdeck/src/lib/default-workspace-store.ts
 * @covers tugdeck/src/lib/host-menu-state.ts
 * @covers tugdeck/src/lib/open-file-in-card.ts
 * @covers tugdeck/src/components/tugways/tug-modal-input-dialog.tsx
 * @covers tugdeck/src/components/tugways/tug-modal-input-dialog.css
 * @covers tugdeck/src/components/tugways/cards/settings-general-body.tsx
 * @covers tugdeck/src/components/tugways/tug-combo-box.tsx
 * @covers tugdeck/src/components/tugways/tug-combo-box.css
 * @covers tugdeck/src/components/tugways/tug-file-chooser.tsx
 * @covers tugdeck/src/lib/dir-existence.ts
 * @covers tugdeck/src/settings-api.ts
 */

import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const PANEL = '[data-slot="tug-modal-input-dialog"]';
const INPUT = ".tug-modal-input-dialog .tug-modal-input-dialog-input";
const ROWS =
  '[data-slot="tug-modal-input-dialog-list"] .tug-modal-input-dialog-row';
const OVERLAY_ROOT = '[data-slot="tug-canvas-overlay-root"]';

/** The marker file the query narrows to — distinctive enough to be the only hit. */
const MARKER = "at0306-marker.txt";

/** The scope row: its path field, its Browse… button, and its dropdown. */
const CHOOSER = `${PANEL} input.tug-file-chooser-input`;
/** The chooser's menu-mode chevron — the scope row's third focus stop. */
const CHEVRON = `${PANEL} .tug-combo-box-chevron`;
const BROWSE = `${PANEL} [data-slot="tug-file-chooser-browse"]`;
const DROPDOWN = '[data-slot="tug-modal-input-dialog-chooser-overlay"]';
const DROPDOWN_ITEMS = `${DROPDOWN} li`;

/** The marker file in the *second* directory, reached through the scope row. */
const OTHER_MARKER = "at0306-elsewhere.txt";

/** The `data-slot` of whatever currently wears the keyboard ring. */
const RING = `(function () {
  var el = document.querySelector("[data-key-view-kbd]");
  return el === null ? "(none)" : (el.getAttribute("data-tug-focus-key") || el.getAttribute("data-slot") || el.tagName);
})()`;

/** Set the query field's value the way a React controlled input accepts it. */
async function typeIntoField(app: App, text: string): Promise<void> {
  await app.evalJS<null>(
    `(function(){
       var input = document.querySelector(${JSON.stringify(INPUT)});
       var setter = Object.getOwnPropertyDescriptor(
         window.HTMLInputElement.prototype, "value").set;
       setter.call(input, ${JSON.stringify(text)});
       input.dispatchEvent(new Event("input", { bubbles: true }));
       return null;
     })()`,
  );
}

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
          await app.waitForCondition<boolean>(
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

          await app.evalJS<null>(
            `(window.__tug.setTugbankValue("dev.tugapp.app", "default-project-path", { kind: "string", value: ${JSON.stringify(dir)} }), null)`,
          );

          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("open-quickly"), null)`,
          );
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(PANEL)}) !== null`,
            { timeoutMs: 8000 },
          );

          // The placeholder names the fallback root's leaf directory.
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(INPUT)})
               .getAttribute("placeholder") === ${JSON.stringify(`Open Quickly in ${leaf}`)}`,
            { timeoutMs: 8000 },
          );
          // …and the scope row opens on the whole path, not a leaf.
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(CHOOSER)}).value === ${JSON.stringify(dir)}`,
            { timeoutMs: 8000 },
          );

          // The acquisition + index round trip lands and the marker shows up.
          await typeIntoField(app, "at0306-marker");
          await app.waitForCondition<boolean>(
            `Array.from(document.querySelectorAll(${JSON.stringify(ROWS)}))
               .some((el) => (el.textContent || "").indexOf(${JSON.stringify(MARKER)}) !== -1)`,
            { timeoutMs: 15000 },
          );

          // Enter commits the highlighted row, which opens a Text card on a
          // deck that had none.
          await app.evalJS<null>(
            `(function(){
               document.querySelector(${JSON.stringify(INPUT)}).dispatchEvent(
                 new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
               return null;
             })()`,
          );
          await app.waitForCondition<boolean>(
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
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(OVERLAY_ROOT)}) !== null`,
            { timeoutMs: 20000 },
          );
          await app.evalJS<null>(
            `(window.__tug.setTugbankValue("dev.tugapp.app", "default-project-path", { kind: "string", value: ${JSON.stringify(dir)} }),
              window.__tug.setTugbankValue("dev.tugapp.dev", "recent-projects", { kind: "json", value: { paths: [${JSON.stringify(other)}] } }),
              null)`,
          );

          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("open-quickly"), null)`,
          );
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(CHOOSER)}) !== null`,
            { timeoutMs: 8000 },
          );

          // The row sits inside the panel, ABOVE the query field — the read
          // order the walk order matches.
          expect(
            await app.evalJS<boolean>(
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
          await app.nativeClickAtElement(CHOOSER);
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(DROPDOWN)}) !== null`,
            { timeoutMs: 8000 },
          );
          expect(
            await app.evalJS<boolean>(
              `document.querySelector(${JSON.stringify(PANEL)})
                 .contains(document.querySelector(${JSON.stringify(DROPDOWN)}))`,
            ),
            "the dropdown portals inside the panel, where the pointer can reach it",
          ).toBe(true);
          expect(
            await app.evalJS<string>(
              `getComputedStyle(document.querySelector(${JSON.stringify(DROPDOWN_ITEMS)})).pointerEvents`,
            ),
            "a modal content leaves everything outside it pointer-dead",
          ).not.toBe("none");

          // Pick the recent project by clicking its row.
          const index = await app.evalJS<number>(
            `Array.from(document.querySelectorAll(${JSON.stringify(DROPDOWN_ITEMS)}))
               .findIndex((el) => (el.textContent || "").indexOf(${JSON.stringify(other)}) !== -1)`,
          );
          expect(index).toBeGreaterThanOrEqual(0);
          await app.nativeClickAtElement(
            `${DROPDOWN} li:nth-child(${index + 1})`,
          );

          // The dialog survived the pick…
          expect(
            await app.evalJS<boolean>(
              `document.querySelector(${JSON.stringify(PANEL)}) !== null`,
            ),
            "picking a row does not dismiss the dialog",
          ).toBe(true);

          // …the placeholder renames itself to the picked directory…
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(INPUT)})
               .getAttribute("placeholder") === ${JSON.stringify(`Open Quickly in ${otherLeaf}`)}`,
            { timeoutMs: 10000 },
          );

          // …and the results come from it, not from the default directory.
          await typeIntoField(app, "at0306-");
          await app.waitForCondition<boolean>(
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
          await app.waitForCondition<boolean>(
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
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(OVERLAY_ROOT)}) !== null`,
            { timeoutMs: 20000 },
          );
          await app.evalJS<null>(
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
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(CHOOSER)}) !== null`,
            { timeoutMs: 8000 },
          );

          // The default directory is empty — say so rather than showing a
          // blank panel that reads as a hang.
          await app.waitForCondition<boolean>(
            `(document.querySelector('[data-slot="tug-modal-input-dialog-empty"]')
               || {}).textContent === "No files in tug"`,
            { timeoutMs: 15000 },
          );

          await app.nativeClickAtElement(CHOOSER);
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(DROPDOWN)}) !== null`,
            { timeoutMs: 8000 },
          );
          const items = JSON.parse(
            await app.evalJS<string>(
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

    test(
      "the scope row is reachable and operable from the keyboard alone",
      async () => {
        // Driven with REAL key events and asserted against the ENGINE's own
        // marks, because every failure this pins was invisible otherwise. The
        // dialog's stops are authored into one focus group: the query field is
        // a text surface the engine grants real DOM focus, and a stop reached
        // by MOVEMENT parks — ring, no caret — until Return or a printable
        // asks for the caret. Watching `activeElement` alone would call that
        // park "focus left the dialog".
        const base = mkdtempSync(`${tmpdir()}/at0306-keys-`);
        mkdirSync(`${base}/tug`);
        writeFileSync(`${base}/tug/${MARKER}`, "in the default\n");
        mkdirSync(`${base}/other`);
        writeFileSync(`${base}/other/${OTHER_MARKER}`, "elsewhere\n");

        const app = await launchTugApp({ testName: "at0306-open-quickly-keys" });
        try {
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(OVERLAY_ROOT)}) !== null`,
            { timeoutMs: 20000 },
          );
          await app.evalJS<null>(
            `(window.__tug.setTugbankValue("dev.tugapp.app", "default-project-path", { kind: "string", value: ${JSON.stringify(`${base}/tug`)} }),
              window.__tug.setTugbankValue("dev.tugapp.dev", "recent-projects", { kind: "json", value: { paths: [${JSON.stringify(`${base}/other`)}] } }),
              null)`,
          );
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("open-quickly"), null)`,
          );
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(CHOOSER)}) !== null`,
            { timeoutMs: 10000 },
          );

          // The dialog seeds the key view onto its query field, and the field
          // being a text surface means the engine grants it real DOM focus.
          await app.waitForCondition<boolean>(
            `document.activeElement === document.querySelector(${JSON.stringify(INPUT)})`,
            { timeoutMs: 8000 },
          );

          // Tab advances the walk through the scope row in reading order:
          // Browse… first, then the path field, parked.
          await app.nativeKey("Tab");
          await app.waitForCondition<boolean>(
            `${RING} === "tug-modal-input-dialog:1"`,
            { timeoutMs: 8000 },
          );
          await app.nativeKey("Tab");
          await app.waitForCondition<boolean>(
            `${RING} === "tug-modal-input-dialog:2"`,
            { timeoutMs: 8000 },
          );
          expect(
            await app.evalJS<boolean>(
              `document.querySelector(${JSON.stringify(PANEL)}) !== null`,
            ),
            "stepping off the query field does not dismiss the dialog",
          ).toBe(true);

          // Enter at a parked text stop claims the caret — the grant.
          await app.nativeKey("Return");
          await app.waitForCondition<boolean>(
            `document.activeElement === document.querySelector(${JSON.stringify(CHOOSER)})`,
            { timeoutMs: 8000 },
          );

          // ↓ opens the seed menu, ↓ again moves the highlight off the first
          // row, Return accepts it — the keyboard equivalent of test 2's click.
          await app.nativeKey("ArrowDown");
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(DROPDOWN)}) !== null`,
            { timeoutMs: 8000 },
          );
          const highlighted = `(function () {
            var el = document.querySelector(${JSON.stringify(DROPDOWN)} + " li[aria-selected='true']");
            return el === null ? "(none)" : (el.textContent || "").trim();
          })()`;
          // Walk down to the "other" row whatever its index, then commit.
          for (let i = 0; i < 4; i += 1) {
            const onOther = await app.evalJS<boolean>(
              `${highlighted}.indexOf(${JSON.stringify(`${base}/other`)}) !== -1`,
            );
            if (onOther) break;
            await app.nativeKey("ArrowDown");
          }
          note(`highlighted before Return: ${await app.evalJS<string>(highlighted)}`);
          await app.nativeKey("Return");

          // The root swaps…
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(INPUT)})
               .getAttribute("placeholder") === "Open Quickly in other"`,
            { timeoutMs: 10000 },
          );

          // …and the keyboard comes back to the query field, because the next
          // thing the user does is type a filename. An engine placement, so it
          // grants the caret rather than parking.
          await app.waitForCondition<boolean>(
            `document.activeElement === document.querySelector(${JSON.stringify(INPUT)})`,
            { timeoutMs: 8000 },
          );
          await typeIntoField(app, "at0306-");
          await app.waitForCondition<boolean>(
            `(function () {
               var rows = Array.from(document.querySelectorAll(${JSON.stringify(ROWS)}))
                 .map(function (el) { return el.textContent || ""; });
               return rows.length > 0 &&
                 rows.some(function (t) { return t.indexOf(${JSON.stringify(OTHER_MARKER)}) !== -1; });
             })()`,
            { timeoutMs: 15000 },
          );

          // The result highlight is the query field's cursor: ↑/↓ and every
          // keystroke that re-queries are the field's, so the solid selection
          // fill is only truthful while the field holds the caret. Read as
          // COMPUTED style, not as an attribute — the row keeps `data-selected`
          // either way, and the whole point is what it paints. `box-shadow` is
          // the discriminator: the live fill has none, the stood-down one is an
          // inset outline over a fraction-strength wash.
          const highlightPaint = `(function () {
            var panel = document.querySelector(${JSON.stringify(PANEL)});
            var row = document.querySelector(
              ${JSON.stringify(ROWS)} + '[data-selected="true"]'
            );
            return {
              caret: panel !== null && panel.hasAttribute("data-query-caret"),
              shadow: row === null ? "(no row)" : getComputedStyle(row).boxShadow,
            };
          })()`;
          type Paint = { caret: boolean; shadow: string };
          const live = await app.evalJS<Paint>(highlightPaint);
          note(`highlight with the caret in the field: ${JSON.stringify(live)}`);
          expect(live.caret, "the query field holds the caret").toBe(true);
          expect(live.shadow, "a live highlight is the plain selection fill").toBe(
            "none",
          );

          await app.nativeKey("Tab");
          await app.waitForCondition<boolean>(
            `${RING} === "tug-modal-input-dialog:1"`,
            { timeoutMs: 8000 },
          );
          const parked = await app.evalJS<Paint>(highlightPaint);
          note(`highlight with the walk parked on Browse: ${JSON.stringify(parked)}`);
          expect(
            parked.caret,
            "stepping the walk off the field takes the caret with it",
          ).toBe(false);
          expect(
            parked.shadow !== "none" && parked.shadow !== "(no row)",
            "the highlight stands down to an outline once no key can move it",
          ).toBe(true);
        } finally {
          await app.close();
          rmSync(base, { recursive: true, force: true });
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "leaving the scope row without changing it re-scopes nothing",
      async () => {
        // The changed-only guard, on the path where it bites. `TugComboBox`
        // settles on BLUR, so merely leaving the field settles the path it
        // already holds — and a re-scope fired from that settle would swap the
        // workspace to the same directory under its canonical name (every temp
        // dir on macOS is reached through a symlink, so the spelling in the
        // field is never the canonical one) and re-seed the key view onto the
        // query field. The Tab walk would then appear to skip the chevron
        // after the field entirely.
        //
        // The MOUSE is what makes this reachable: only a pointer grants the
        // chooser real DOM focus. A keyboard walk parks the stop instead, and a
        // parked field never blurs, so the settle never fires — which is why
        // test 4's keyboard walk cannot pin this.
        const base = mkdtempSync(`${tmpdir()}/at0306-settle-`);
        mkdirSync(`${base}/tug`);
        writeFileSync(`${base}/tug/${MARKER}`, "in the default\n");

        const app = await launchTugApp({
          testName: "at0306-open-quickly-settle",
        });
        try {
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(OVERLAY_ROOT)}) !== null`,
            { timeoutMs: 20000 },
          );
          await app.evalJS<null>(
            `(window.__tug.setTugbankValue("dev.tugapp.app", "default-project-path", { kind: "string", value: ${JSON.stringify(`${base}/tug`)} }), null)`,
          );
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("open-quickly"), null)`,
          );
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(CHOOSER)}) !== null`,
            { timeoutMs: 10000 },
          );
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(INPUT)})
               .getAttribute("placeholder") === "Open Quickly in tug"`,
            { timeoutMs: 10000 },
          );

          // Click into the scope field — real DOM focus, which is what makes a
          // later blur a real blur — then close the menu the click opened.
          await app.nativeClickAtElement(CHOOSER);
          await app.waitForCondition<boolean>(
            `document.activeElement === document.querySelector(${JSON.stringify(CHOOSER)})`,
            { timeoutMs: 8000 },
          );
          await app.nativeKey("Escape");
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(DROPDOWN)}) === null`,
            { timeoutMs: 8000 },
          );
          expect(
            await app.evalJS<boolean>(
              `document.querySelector(${JSON.stringify(PANEL)}) !== null`,
            ),
            "Escape closes the chooser's list, not the dialog under it",
          ).toBe(true);

          const scopeBefore = await app.evalJS<string>(
            `document.querySelector(${JSON.stringify(CHOOSER)}).value`,
          );

          // Tab out. The field blurs for real, so the settle fires — and the
          // guard is the only thing standing between that settle and a
          // pointless re-scope.
          await app.nativeKey("Tab");
          await app.waitForCondition<boolean>(
            `${RING} === "tug-modal-input-dialog:3"`,
            { timeoutMs: 8000 },
          );
          note(
            `after Tab off the chooser: ring=${await app.evalJS<string>(RING)}`,
          );

          // The chevron is a live control, and a live control fills with its
          // role colour under the ring — the doubled treatment the Browse
          // button at the other end of the bar wears. A ghost glyph carrying a
          // bare outline reads as a stray box beside the field, so this is
          // asserted as PAINT: the resting chevron is transparent, the one
          // holding the ring is not.
          const chevronFill = await app.evalJS<string>(
            `(function () {
               var el = document.querySelector('${CHEVRON}');
               return el === null ? "(none)" : getComputedStyle(el).backgroundColor;
             })()`,
          );
          note(`chevron fill while it holds the ring: ${chevronFill}`);
          expect(
            chevronFill !== "(none)" &&
              chevronFill !== "transparent" &&
              chevronFill !== "rgba(0, 0, 0, 0)",
            "the chevron holding the ring fills like every other live control",
          ).toBe(true);

          // The walk landed on the chevron rather than bouncing back to the query
          // field, and the scope is exactly what it was.
          expect(
            await app.evalJS<boolean>(
              `document.activeElement === document.querySelector(${JSON.stringify(INPUT)})`,
            ),
            "the walk did not bounce back to the query field",
          ).toBe(false);
          expect(
            await app.evalJS<string>(
              `document.querySelector(${JSON.stringify(CHOOSER)}).value`,
            ),
            "leaving the row unchanged leaves the scope unchanged",
          ).toBe(scopeBefore);
          expect(
            await app.evalJS<string>(
              `document.querySelector(${JSON.stringify(INPUT)}).getAttribute("placeholder")`,
            ),
          ).toBe("Open Quickly in tug");
          expect(
            await app.evalJS<boolean>(
              `document.querySelector(${JSON.stringify(BROWSE)}) !== null`,
            ),
          ).toBe(true);
        } finally {
          await app.close();
          rmSync(base, { recursive: true, force: true });
        }
      },
      TEST_TIMEOUT_MS,
    );

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
          // Foreground: the final leg is a real app resign, which only
          // happens to an app that is actually active (pid-mode default
          // never activates).
          foreground: true,
        });
        const panelUp = `document.querySelector(${JSON.stringify(PANEL)}) !== null`;
        try {
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(OVERLAY_ROOT)}) !== null`,
            { timeoutMs: 20000 },
          );
          await app.evalJS<null>(
            `(window.__tug.setTugbankValue("dev.tugapp.app", "default-project-path", { kind: "string", value: ${JSON.stringify(`${base}/tug`)} }), null)`,
          );

          const openOnBrowse = async (): Promise<void> => {
            await app.evalJS<null>(
              `(window.__tug.dispatchControlAction("open-quickly"), null)`,
            );
            await app.waitForCondition<boolean>(
              `document.querySelector(${JSON.stringify(BROWSE)}) !== null`,
              { timeoutMs: 10000 },
            );
            await app.waitForCondition<boolean>(
              `document.activeElement === document.querySelector(${JSON.stringify(INPUT)})`,
              { timeoutMs: 8000 },
            );
            await app.nativeKey("Tab");
            await app.waitForCondition<boolean>(
              `${RING} === "tug-modal-input-dialog:1"`,
              { timeoutMs: 8000 },
            );
          };

          // Escape with the ring on the engine-routed Browse… stop closes the
          // DIALOG. This is the one the query field's own keydown handler could
          // never answer: it has no focus and sees no key.
          await openOnBrowse();
          await app.nativeKey("Escape");
          await app.waitForCondition<boolean>(`!(${panelUp})`, {
            timeoutMs: 8000,
          });

          // The app yielding frontmost takes the dialog with it — driven by the
          // real `NSApp.deactivate()`, through the real AppDelegate lifecycle
          // frame, not a synthesized blur.
          await openOnBrowse();
          await app.simulateAppResign();
          await app.waitForCondition<boolean>(`!(${panelUp})`, {
            timeoutMs: 8000,
          });
        } finally {
          await app.close();
          rmSync(base, { recursive: true, force: true });
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "choosing a new default directory in Settings re-points Open Quickly",
      async () => {
        // The user's flow, end to end, with nothing synthesized in the middle:
        // type a partial path into Settings ▸ General, accept the completion
        // with a real Return, and open the dialog in the same breath.
        //
        // Accepting is the gesture that has to write. It is where the user
        // stops choosing, and a field that comes to rest there while tugbank
        // still holds the old path is the whole defect this test exists for —
        // the dialog went on naming a directory the user had visibly replaced.
        // So this asserts both halves: the store really changed (to the
        // CANONICAL spelling — the path is a persisted key, [L29]), and the
        // field shows exactly what the store holds.
        //
        // Then the dialog, immediately: until the server's DEFAULTS frame comes
        // back around, the only thing that knows the new path is the local
        // cache write `putDefaultProjectPath` makes once the PUT lands.
        const base = mkdtempSync(`${tmpdir()}/at0306-live-`);
        mkdirSync(`${base}/before`);
        writeFileSync(`${base}/before/${MARKER}`, "the old default\n");
        mkdirSync(`${base}/after`);
        writeFileSync(`${base}/after/${OTHER_MARKER}`, "the new default\n");

        const app = await launchTugApp({ testName: "at0306-open-quickly-live" });
        const placeholder = `document.querySelector(${JSON.stringify(INPUT)})
          .getAttribute("placeholder")`;
        const SETTINGS_FIELD =
          '[data-testid="settings-default-project-dir-field"] input';
        try {
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(OVERLAY_ROOT)}) !== null`,
            { timeoutMs: 20000 },
          );
          await app.evalJS<null>(
            `(window.__tug.setTugbankValue("dev.tugapp.app", "default-project-path", { kind: "string", value: ${JSON.stringify(`${base}/before`)} }), null)`,
          );

          // Baseline: the dialog opens on the directory that is set now.
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("open-quickly"), null)`,
          );
          await app.waitForCondition<boolean>(
            `${placeholder} === "Open Quickly in before"`,
            { timeoutMs: 10000 },
          );
          await app.nativeKey("Escape");
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(PANEL)}) === null`,
            { timeoutMs: 8000 },
          );

          // Change it the way the user does — the Settings card's own field.
          await app.evalJS(
            `window.__tug.dispatchControlAction("show-card", { component: "settings" })`,
          );
          // The card's sections are all expanded on a fresh profile, so
          // General's body is rendered without a selection gesture.
          await app.waitForCondition<boolean>(
            `document.querySelector('[data-testid="settings-general"]') !== null`,
            { timeoutMs: 10000 },
          );
          await app.focusElement(SETTINGS_FIELD);
          // Type a PARTIAL path — replacing the field's contents, since the
          // field already shows the stored path and `app.type` types after it.
          // Partial so the completion list has something to offer, which is
          // what the real gesture ends on.
          await app.evalJS<null>(
            `(function(){
               var input = document.querySelector(${JSON.stringify(SETTINGS_FIELD)});
               var setter = Object.getOwnPropertyDescriptor(
                 window.HTMLInputElement.prototype, "value").set;
               setter.call(input, ${JSON.stringify(`${base}/aft`)});
               input.dispatchEvent(new Event("input", { bubbles: true }));
               return null;
             })()`,
          );
          await app.waitForCondition<boolean>(
            `Array.from(document.querySelectorAll(".tug-combo-box-item"))
               .some((el) => (el.textContent || "").indexOf("after") !== -1)`,
            { timeoutMs: 8000 },
          );

          // Accept it with a real Return. This is the settle: the field stops
          // being an edit and the value has to reach tugbank.
          await app.nativeKey("Return");

          // tugbank really holds it, read back over the same HTTP surface the
          // write went through — and in the CANONICAL spelling, which under a
          // symlinked tmpdir (`/var` → `/private/var`) is not the string that
          // was typed. A write that skipped the gateway fails here ([L29]).
          // Polled on a window global because `evalJS` can't await.
          const canonicalAfter = `${realpathSync(base)}/after`;
          await app.evalJS(`(() => {
            window.__at0306 = undefined;
            const poll = () => {
              fetch("/api/defaults/dev.tugapp.app/default-project-path")
                .then((r) => (r.ok ? r.json() : { kind: "error", value: r.status }))
                .then((j) => {
                  if (j.kind === "string" && j.value !== ${JSON.stringify(`${base}/before`)}) {
                    window.__at0306 = j;
                    return;
                  }
                  window.setTimeout(poll, 100);
                })
                .catch((e) => { window.__at0306 = { kind: "error", value: String(e) }; });
            };
            poll();
          })()`);
          const stored = await app.waitForCondition<{ value: string }>(
            `window.__at0306`,
            { timeoutMs: 15000 },
          );
          expect(stored.value).toBe(canonicalAfter);

          // And the field shows what the store holds — no settled field ever
          // displays a path tugbank doesn't have.
          expect(
            await app.evalJS<string>(
              `document.querySelector(${JSON.stringify(SETTINGS_FIELD)}).value`,
            ),
          ).toBe(canonicalAfter);

          // Open Quickly, right now — no waiting on the server round trip.
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("open-quickly"), null)`,
          );
          await app.waitForCondition<boolean>(
            `${placeholder} === "Open Quickly in after"`,
            { timeoutMs: 10000 },
          );

          // And the search root really moved, not just the label: the file
          // that only exists in the new directory is the one that comes back.
          await typeIntoField(app, "at0306-");
          await app.waitForCondition<boolean>(
            `Array.from(document.querySelectorAll(${JSON.stringify(ROWS)}))
               .some((el) => (el.textContent || "").indexOf(${JSON.stringify(OTHER_MARKER)}) !== -1)`,
            { timeoutMs: 10000 },
          );
        } finally {
          await app.close();
          rmSync(base, { recursive: true, force: true });
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
