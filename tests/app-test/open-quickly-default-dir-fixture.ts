/**
 * open-quickly-default-dir-fixture.ts — the shared selectors and page helpers
 * the at0306-open-quickly-default-dir-* files drive Open Quickly through.
 *
 * Open Quickly with nothing open falls back to the default project directory,
 * and its scope row re-points the search ([AT0306]).
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
 *   The dialog is drawn in the overlay page, above every card: the shell
 *   opens it and opens the file it chose (`overlay-shell.ts`), so every read
 *   of the dialog is the overlay's, and every read of the deck, of tugbank and
 *   of the app is the shell's.
 *
 *   The rest drive the `TugFileChooser` scope row that replaced the directory
 *   switcher. The switcher was a `TugPopupButton` whose Radix menu portalled
 *   outside the panel; the chooser's dropdown portals INSIDE it, because a
 *   modal Radix content makes every node outside itself pointer-dead. So a
 *   MOUSE pick in that dropdown is the interaction most at risk, and it is the
 *   one the mouse-pick file drives.
 *
 *   The places file covers what the row owes the user about the places it
 *   offers: two spellings of one directory are one entry (only the server can
 *   say they are the same, [L29]), and an empty directory says so instead of
 *   showing a blank panel. Leaf-name disambiguation is gone with the switcher —
 *   the seed shows whole paths, so there is nothing to tell apart.
 *
 *   The keyboard file drives the row with REAL key events, asserting against
 *   the ENGINE's marks rather than `document.activeElement`: Tab moves the ring
 *   from the query field to the chooser, Enter claims the caret, ↓ opens the
 *   seed, ↓ moves the highlight, Return accepts — and the key view comes back to
 *   the query field, because the user's next act after choosing a scope is
 *   typing a filename. It closes on the result list's own truthfulness, read as
 *   computed style: the highlight paints the solid selection fill while the
 *   field holds the caret, and stands down to an outline the moment the walk
 *   parks elsewhere and no key can move it.
 *
 *   The settle file pins the changed-only guard on re-scoping, on the path
 *   where it is load-bearing. `TugComboBox` settles on blur, so leaving the
 *   chooser settles the path it holds; without the guard that settle re-scopes
 *   to the same place under its canonical name and re-seeds the key view, and
 *   the Tab walk appears to skip the chevron after it. It has to be driven with
 *   the MOUSE, because only a pointer grants the field real DOM focus — a
 *   keyboard walk parks it, and a parked field never blurs, so no keyboard
 *   sequence can reach the settle.
 *
 *   The exits file pins the two exits that belong to the surface rather than
 *   the field: Escape resolves against the dialog's own focus mode from
 *   wherever the ring is resting, and the app going inactive takes the dialog
 *   with it.
 *
 *   The settings file runs the setting and the dialog together, through the
 *   real write path and a real gesture: type a partial path into Settings ▸
 *   General, accept the completion with Return, and open the dialog in the same
 *   breath.
 *
 * Gating
 * ------
 * `describe.skipIf(!SHOULD_RUN)`. CI and `bun x tsc --noEmit` runs without
 * `TUGAPP_APP_TEST=1` skip every test.
 *
 * @module tests/app-test/open-quickly-default-dir-fixture
 */

import type { App, BodyApp } from "./_harness";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 120_000;

export const PANEL = '[data-slot="tug-modal-input-dialog"]';
export const INPUT = ".tug-modal-input-dialog .tug-modal-input-dialog-input";
export const ROWS =
  '[data-slot="tug-modal-input-dialog-list"] .tug-modal-input-dialog-row';
export const OVERLAY_ROOT = '[data-slot="tug-canvas-overlay-root"]';

/** The marker file the query narrows to — distinctive enough to be the only hit. */
export const MARKER = "at0306-marker.txt";

/** The scope row: its path field, its Browse… button, and its dropdown. */
export const CHOOSER = `${PANEL} input.tug-file-chooser-input`;
/** The chooser's menu-mode chevron — the scope row's third focus stop. */
export const CHEVRON = `${PANEL} .tug-combo-box-chevron`;
export const BROWSE = `${PANEL} [data-slot="tug-file-chooser-browse"]`;
export const DROPDOWN = '[data-slot="tug-modal-input-dialog-chooser-overlay"]';
export const DROPDOWN_ITEMS = `${DROPDOWN} li`;

/** The marker file in the *second* directory, reached through the scope row. */
export const OTHER_MARKER = "at0306-elsewhere.txt";

/** The `data-slot` of whatever currently wears the keyboard ring. */
export const RING = `(function () {
  var el = document.querySelector("[data-key-view-kbd]");
  return el === null ? "(none)" : (el.getAttribute("data-tug-focus-key") || el.getAttribute("data-slot") || el.tagName);
})()`;

/**
 * A tugbank write, made in both pages that read it: the shell's (the menu
 * gate, the deck) and the overlay's (the dialog). The harness's write is the
 * page's own client cache, as a DEFAULTS frame arriving there would write it,
 * so a setting the dialog must see is written where the dialog is.
 */
export async function setInBoth(app: App, ui: BodyApp, script: string): Promise<void> {
  await app.evalJS<null>(script);
  await ui.evalJS<null>(script);
}

/** Set the query field's value the way a React controlled input accepts it, in the overlay page `ui`. */
export async function typeIntoField(ui: BodyApp, text: string): Promise<void> {
  await ui.evalJS<null>(
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
