/**
 * at0306-open-quickly-default-dir-settle.test.ts — leaving the scope row
 * without changing it re-scopes nothing ([AT0306]).
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
import { appIsActive } from "./_harness/selectors";
import {
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  PANEL,
  INPUT,
  OVERLAY_ROOT,
  MARKER,
  CHOOSER,
  CHEVRON,
  BROWSE,
  DROPDOWN,
  RING,
  setInBoth,
} from "./open-quickly-default-dir-fixture";

describe.skipIf(!SHOULD_RUN)(
  "at0306: Open Quickly falls back to the default project directory",
  () => {
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
        // the keyboard file's walk cannot pin this.
        const base = mkdtempSync(`${tmpdir()}/at0306-settle-`);
        mkdirSync(`${base}/tug`);
        writeFileSync(`${base}/tug/${MARKER}`, "in the default\n");

        const app = await launchTugApp({
          testName: "at0306-open-quickly-settle",
        });
        try {
          const ui = await overlayReady(app);
          await ui.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(OVERLAY_ROOT)}) !== null`,
            { timeoutMs: 20000 },
          );
          // The paint asserted below is the focus language of a foreground
          // app, which `focus-ring.css` stands down under
          // `data-app-active="false"`. The deck's `hasFocus` follows the app's
          // activity ([B13] of the bodies migration), and a pid-mode harness
          // app never activates, so the launch's own deck is re-seeded as it
          // stands with the bit set — the way every seeded fixture sets it.
          await app.seedDeckState({
            state: {
              ...(await app.evalJS<Record<string, unknown>>(`window.tugdeck.diag.getDeckState()`)),
              hasFocus: true,
            },
          });
          await app.waitForCondition<boolean>(appIsActive(), { timeoutMs: 8000 });
          // A seed may bring the pages up again, the overlay among them.
          await overlayReady(app);
          await setInBoth(app, ui,
            `(window.__tug.setTugbankValue("dev.tugapp.app", "default-project-path", { kind: "string", value: ${JSON.stringify(`${base}/tug`)} }), null)`,
          );
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("open-quickly"), null)`,
          );
          await ui.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(CHOOSER)}) !== null`,
            { timeoutMs: 10000 },
          );
          await ui.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(INPUT)})
               .getAttribute("placeholder") === "Open Quickly in tug"`,
            { timeoutMs: 10000 },
          );

          // Click into the scope field — real DOM focus, which is what makes a
          // later blur a real blur — then close the menu the click opened.
          await ui.nativeClickAtElement(CHOOSER);
          await ui.waitForCondition<boolean>(
            `document.activeElement === document.querySelector(${JSON.stringify(CHOOSER)})`,
            { timeoutMs: 8000 },
          );
          await app.nativeKey("Escape");
          await ui.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(DROPDOWN)}) === null`,
            { timeoutMs: 8000 },
          );
          expect(
            await ui.evalJS<boolean>(
              `document.querySelector(${JSON.stringify(PANEL)}) !== null`,
            ),
            "Escape closes the chooser's list, not the dialog under it",
          ).toBe(true);

          const scopeBefore = await ui.evalJS<string>(
            `document.querySelector(${JSON.stringify(CHOOSER)}).value`,
          );

          // Tab out. The field blurs for real, so the settle fires — and the
          // guard is the only thing standing between that settle and a
          // pointless re-scope.
          await app.nativeKey("Tab");
          await ui.waitForCondition<boolean>(
            `${RING} === "tug-modal-input-dialog:3"`,
            { timeoutMs: 8000 },
          );
          note(
            `after Tab off the chooser: ring=${await ui.evalJS<string>(RING)}`,
          );

          // The chevron is a live control, and a live control fills with its
          // role colour under the ring — the doubled treatment the Browse
          // button at the other end of the bar wears. A ghost glyph carrying a
          // bare outline reads as a stray box beside the field, so this is
          // asserted as PAINT: the resting chevron is transparent, the one
          // holding the ring is not.
          const chevronFill = await ui.evalJS<string>(
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
            await ui.evalJS<boolean>(
              `document.activeElement === document.querySelector(${JSON.stringify(INPUT)})`,
            ),
            "the walk did not bounce back to the query field",
          ).toBe(false);
          expect(
            await ui.evalJS<string>(
              `document.querySelector(${JSON.stringify(CHOOSER)}).value`,
            ),
            "leaving the row unchanged leaves the scope unchanged",
          ).toBe(scopeBefore);
          expect(
            await ui.evalJS<string>(
              `document.querySelector(${JSON.stringify(INPUT)}).getAttribute("placeholder")`,
            ),
          ).toBe("Open Quickly in tug");
          expect(
            await ui.evalJS<boolean>(
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
  },
);
