/**
 * at0306-open-quickly-default-dir-keyboard.test.ts — the scope row is
 * reachable and operable from the keyboard alone ([AT0306]).
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
import { launchTugApp, note } from "./_harness";
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
  OTHER_MARKER,
  RING,
  setInBoth,
  typeIntoField,
} from "./open-quickly-default-dir-fixture";

describe.skipIf(!SHOULD_RUN)(
  "at0306: Open Quickly falls back to the default project directory",
  () => {
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
          const ui = await overlayReady(app);
          await ui.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(OVERLAY_ROOT)}) !== null`,
            { timeoutMs: 20000 },
          );
          await setInBoth(app, ui,
            `(window.__tug.setTugbankValue("dev.tugapp.app", "default-project-path", { kind: "string", value: ${JSON.stringify(`${base}/tug`)} }),
              window.__tug.setTugbankValue("dev.tugapp.dev", "recent-projects", { kind: "json", value: { paths: [${JSON.stringify(`${base}/other`)}] } }),
              null)`,
          );
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("open-quickly"), null)`,
          );
          await ui.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(CHOOSER)}) !== null`,
            { timeoutMs: 10000 },
          );

          // The dialog seeds the key view onto its query field, and the field
          // being a text surface means the engine grants it real DOM focus.
          await ui.waitForCondition<boolean>(
            `document.activeElement === document.querySelector(${JSON.stringify(INPUT)})`,
            { timeoutMs: 8000 },
          );

          // Tab advances the walk through the scope row in reading order:
          // Browse… first, then the path field, parked.
          await app.nativeKey("Tab");
          await ui.waitForCondition<boolean>(
            `${RING} === "tug-modal-input-dialog:1"`,
            { timeoutMs: 8000 },
          );
          await app.nativeKey("Tab");
          await ui.waitForCondition<boolean>(
            `${RING} === "tug-modal-input-dialog:2"`,
            { timeoutMs: 8000 },
          );
          expect(
            await ui.evalJS<boolean>(
              `document.querySelector(${JSON.stringify(PANEL)}) !== null`,
            ),
            "stepping off the query field does not dismiss the dialog",
          ).toBe(true);

          // Enter at a parked text stop claims the caret — the grant.
          await app.nativeKey("Return");
          await ui.waitForCondition<boolean>(
            `document.activeElement === document.querySelector(${JSON.stringify(CHOOSER)})`,
            { timeoutMs: 8000 },
          );

          // ↓ opens the seed menu, ↓ again moves the highlight off the first
          // row, Return accepts it — the keyboard equivalent of the mouse-pick
          // file's click.
          await app.nativeKey("ArrowDown");
          await ui.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(DROPDOWN)}) !== null`,
            { timeoutMs: 8000 },
          );
          const highlighted = `(function () {
            var el = document.querySelector(${JSON.stringify(DROPDOWN)} + " li[aria-selected='true']");
            return el === null ? "(none)" : (el.textContent || "").trim();
          })()`;
          // Walk down to the "other" row whatever its index, then commit.
          for (let i = 0; i < 4; i += 1) {
            const onOther = await ui.evalJS<boolean>(
              `${highlighted}.indexOf(${JSON.stringify(`${base}/other`)}) !== -1`,
            );
            if (onOther) break;
            await app.nativeKey("ArrowDown");
          }
          note(`highlighted before Return: ${await ui.evalJS<string>(highlighted)}`);
          await app.nativeKey("Return");

          // The root swaps…
          await ui.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(INPUT)})
               .getAttribute("placeholder") === "Open Quickly in other"`,
            { timeoutMs: 10000 },
          );

          // …and the keyboard comes back to the query field, because the next
          // thing the user does is type a filename. An engine placement, so it
          // grants the caret rather than parking.
          await ui.waitForCondition<boolean>(
            `document.activeElement === document.querySelector(${JSON.stringify(INPUT)})`,
            { timeoutMs: 8000 },
          );
          await typeIntoField(ui, "at0306-");
          await ui.waitForCondition<boolean>(
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
          const live = await ui.evalJS<Paint>(highlightPaint);
          note(`highlight with the caret in the field: ${JSON.stringify(live)}`);
          expect(live.caret, "the query field holds the caret").toBe(true);
          expect(live.shadow, "a live highlight is the plain selection fill").toBe(
            "none",
          );

          await app.nativeKey("Tab");
          await ui.waitForCondition<boolean>(
            `${RING} === "tug-modal-input-dialog:1"`,
            { timeoutMs: 8000 },
          );
          const parked = await ui.evalJS<Paint>(highlightPaint);
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
  },
);
