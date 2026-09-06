/**
 * at0043-tug-text-editor-copy-diag.test.ts — empirical clipboard read-back
 * for tug-text-editor copy across selection classes (text-only / mixed /
 * atom-only).
 *
 * ## Why this exists
 *
 * Manual checkpoint of Step 9 surfaced two clipboard symptoms:
 *
 *   1. Atom-only selection appears to "fail to copy" — pasting the
 *      result reproduces the atom's label as text rather than an atom
 *      widget, which from a UX POV reads as "the atom didn't get
 *      copied."
 *   2. Mixed (text + atom) selection copies, but pasting reproduces
 *      the atom as plain-text label rather than an atom widget.
 *
 * The plan's Step 9.5A asked: confirm empirically what the failure
 * shape actually is, before refactoring `handleCopy`. This test
 * walks the gallery card through the three selection classes, fires
 * ⌘C, and reads the bridge-readable clipboard back via the same
 * `window.webkit.messageHandlers.clipboardRead` channel that
 * `tug-native-clipboard.ts` exposes to the substrate's paste handler.
 *
## Findings (recorded for future readers)
 *
 *   | scenario   | bridge text | bridge atoms        |
 *   |------------|-------------|---------------------|
 *   | text-only  | "abc"       | "" (no atoms)       |
 *   | mixed      | "xmain.ts"  | sidecar JSON        |
 *   | atom-only  | "main.ts"   | sidecar JSON        |
 *
 *   `.string` carries atom labels substituted for U+FFFC (per
 *   `serializeClipboard`'s `fallback` field) so external apps see
 *   readable text. The atom data rides on the Tug-private
 *   `dev.tugapp.prompt-atoms` pasteboard type (the bridge's `atoms`
 *   field) as the self-contained sidecar JSON — written natively by
 *   `handleCopy` → `writeClipboardViaNative`, bypassing WebKit's
 *   pasteboard normalization entirely. The test rounds-trips through
 *   copy → bridge read → paste-into-fresh-card and asserts the atom
 *   `<img>` reappears in the destination editor's DOM.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * Foreground: ⌘A / ⌘C / ⌘V are Edit-menu key equivalents, so AppKit resolves
 * them against the main menu before the web view sees a keydown. A
 * background instance has no key window for that resolution to land in,
 * and the chord dies there.
 *
 * @foreground
 *
 * @covers tugdeck/src/components/tugways/tug-text-editor/
 * @covers tugdeck/src/components/tugways/tug-text-editor.tsx
 * @covers tugdeck/src/lib/tug-native-clipboard.ts
 * @covers tugdeck/src/lib/atom-plain-text.ts
 * @covers tugdeck/src/lib/copy-as-plain-text.ts
 * @covers tugdeck/src/lib/tug-atom-chip.tsx
 * @covers tugdeck/src/components/tugways/tug-push-button.tsx
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const TEST_TIMEOUT_MS = 90_000;

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

const TUG_EDIT_CONTENT_SELECTOR =
  '[data-slot="tug-text-editor"] .cm-content';

/**
 * The gallery card renders five `TugPushButton`s in
 * `.gallery-text-editor-atom-row`, one per atom kind: file, command,
 * doc, image, link. We only need one — pick "file" by index. Its
 * onClick calls `editRef.current?.insertAtom({ kind: "atom", type:
 * "file", label: "main.ts", value: "/project/src/main.ts" })`.
 */
const GALLERY_FILE_ATOM_BUTTON_SELECTOR =
  '[data-card-id="A"] .gallery-text-editor-atom-row [data-slot="tug-push-button"]:nth-of-type(1)';

/** Label of the "file" sample atom in `gallery-text-editor.tsx`. */
const FILE_ATOM_LABEL = "main.ts";

/**
 * The `text/plain` spelling of that atom — its {@link atomPlainText} form.
 *
 * The bridge's text payload substitutes each `U+FFFC` with the one string
 * every writer of the flavor now writes, so the editor's own ⌘C says the same
 * thing about a file that a transcript copy and the annotation menu do. A
 * file's path is real information a plain paste keeps, hence the link shape
 * rather than the bare name the editor used to write alone.
 */
const FILE_ATOM_PLAIN = "[main.ts](</project/src/main.ts>)";

// ---------------------------------------------------------------------------
// Deck shape
// ---------------------------------------------------------------------------

function deckShape() {
  return {
    cards: [
      { id: "A", componentId: "gallery-text-editor", title: "TugTextEditor A", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 720, height: 540 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function setupGallery(app: App): Promise<void> {
  await app.enableDeckTrace(true);
  await app.seedDeckState({
    state: deckShape(),
    cardStates: {},
    focusCardId: "A",
  });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
  );
  await app.awaitEngineReady("A");

  const editorSelector = `[data-card-id="A"] ${TUG_EDIT_CONTENT_SELECTOR}`;
  await app.nativeClickAtElement(editorSelector);
  await app.waitForCondition<boolean>(
    `document.activeElement !== null && document.activeElement.matches(${JSON.stringify(editorSelector)})`,
    { timeoutMs: 2000 },
  );
}

/**
 * Clear the editor (Cmd-A, Delete) so each scenario starts fresh.
 * Settle gates between the two key events and after Delete: native
 * key posting goes through the OS event queue at full speed, and
 * firing Delete while Cmd-A is still in flight can leave Cmd-A's
 * selection un-applied — Delete then removes only the character
 * before the cursor, leaving residual text from the prior scenario.
 * The textContent + atom-count wait confirms the doc is genuinely
 * empty before the next scenario's typing begins.
 */
async function clearEditor(app: App): Promise<void> {
  await app.nativeKey("a", ["cmd"]);
  await new Promise((r) => setTimeout(r, 80));
  await app.nativeKey("Delete");
  // Empty-doc signal: no atom widgets, and CM6 shows its `.cm-placeholder`
  // (rendered inside `.cm-content` only when the document length is 0). NOT
  // `textContent.length === 0` — the gallery editor configures a placeholder
  // (`DEMO_PLACEHOLDER`), so an empty editor's `.cm-content` textContent is
  // the placeholder string, never empty.
  await app.waitForCondition<boolean>(
    `(function(){
      var ed = document.querySelector('[data-card-id="A"] ${TUG_EDIT_CONTENT_SELECTOR}');
      if (ed === null) return false;
      return ed.querySelectorAll('img[data-atom-label]').length === 0
        && ed.querySelector('.cm-placeholder') !== null;
    })()`,
    { timeoutMs: 2000 },
  );
  await new Promise((r) => setTimeout(r, 80));
}

interface ClipboardSnapshot {
  hasBridge: boolean;
  text: string;
  atoms: string;
}

/**
 * Read the system clipboard via Tug.app's native bridge
 * (NSPasteboard read). Returns plain text + the Tug-private atom
 * sidecar (`dev.tugapp.prompt-atoms` → the bridge's `atoms` field). This
 * is exactly the view the substrate's bridge-paste path consumes.
 *
 * Talks to `window.webkit.messageHandlers.clipboardRead` directly
 * rather than importing `tug-native-clipboard.ts` (the harness's
 * `evalJS` context doesn't resolve module paths). Drives the same
 * Swift-side handler and unique-`requestId` callback shape, with the
 * production `__tugNativeClipboardCallback` chained so a concurrent
 * read in the substrate isn't dropped.
 *
 * Caller pattern: kick off the read, poll until the result lands in
 * `window.__tugClipReadResult` (evalJS doesn't await Promises), then
 * read the result.
 */
async function readClipboard(app: App): Promise<ClipboardSnapshot> {
  await app.evalJS<void>(
    `(function(){
      var w = window;
      w.__tugClipReadResult = null;
      var bridge = w.webkit && w.webkit.messageHandlers && w.webkit.messageHandlers.clipboardRead;
      if (!bridge || typeof bridge.postMessage !== "function") {
        w.__tugClipReadResult = { hasBridge: false, text: "", atoms: "" };
        return;
      }
      var id = "diag-" + Math.random().toString(36).slice(2);
      var prior = w.__tugNativeClipboardCallback;
      w.__tugNativeClipboardCallback = function(data) {
        if (!data || data.requestId !== id) {
          if (typeof prior === "function") prior(data);
          return;
        }
        w.__tugNativeClipboardCallback = prior;
        w.__tugClipReadResult = {
          hasBridge: true,
          text: typeof data.text === "string" ? data.text : "",
          atoms: typeof data.atoms === "string" ? data.atoms : "",
        };
      };
      bridge.postMessage({ requestId: id });
    })()`,
  );
  await app.waitForCondition<boolean>(
    `window.__tugClipReadResult !== null`,
    { timeoutMs: 2000 },
  );
  return app.evalJS<ClipboardSnapshot>(
    `(function(){ var r = window.__tugClipReadResult; window.__tugClipReadResult = null; return r; })()`,
  );
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe.skipIf(!SHOULD_RUN)(
  "m43: tug-text-editor copy clipboard read-back across selection classes",
  () => {
    test(
      "text-only / mixed / atom-only ⌘C produces the documented bridge text payload",
      async () => {
        const tugbankPath = mkTempTugbank();
        try {
          seedTugbankForLaunch(tugbankPath);

          const app = await launchTugApp({
            testName: "m43-tug-text-editor-copy-diag",
            env: { TUGBANK_PATH: tugbankPath },
            persistInTestMode: true,
            foreground: true,
          });

          try {
            await setupGallery(app);

            // ---- Scenario 1: text-only ----
            // Type "abc", select all, ⌘C. Bridge text should match
            // verbatim — text glyphs round-trip unchanged. Settle
            // gates between native key events: CGEvent posting goes
            // through the OS event queue at full speed, and firing
            // Cmd-A while the previous keystroke is still in flight
            // can leave the selection partially-applied (Cmd-C then
            // copies the wrong range, or no range at all).
            await app.nativeType("abc");
            await app.waitForCondition<boolean>(
              `(function(){
                var ed = document.querySelector('[data-card-id="A"] ${TUG_EDIT_CONTENT_SELECTOR}');
                return ed !== null && ed.textContent === "abc";
              })()`,
              { timeoutMs: 2000 },
            );
            await app.nativeKey("a", ["cmd"]);
            await new Promise((r) => setTimeout(r, 80));
            await app.nativeKey("c", ["cmd"]);
            await new Promise((r) => setTimeout(r, 150));
            const textOnlyClip = await readClipboard(app);
            expect(textOnlyClip.hasBridge, "native bridge required for this test").toBe(true);
            expect(
              textOnlyClip.text,
              "text-only ⌘C: bridge text payload",
            ).toBe("abc");

            // ---- Scenario 2: mixed (text + atom) ----
            // Reset, type "x", insert "file" atom (doc = `x` + `￼`),
            // re-focus the editor, select all, ⌘C. Bridge text should
            // be `"x" + atom.label` because `serializeClipboard`
            // substitutes labels for U+FFFC in the `fallback` payload.
            await clearEditor(app);
            await app.nativeType("x");
            await app.waitForCondition<boolean>(
              `(function(){
                var ed = document.querySelector('[data-card-id="A"] ${TUG_EDIT_CONTENT_SELECTOR}');
                return ed !== null && ed.textContent === "x";
              })()`,
              { timeoutMs: 2000 },
            );
            await app.nativeClickAtElement(GALLERY_FILE_ATOM_BUTTON_SELECTOR);
            await app.nativeClickAtElement(`[data-card-id="A"] ${TUG_EDIT_CONTENT_SELECTOR}`);
            await app.waitForCondition<boolean>(
              `(function(){
                var ed = document.querySelector('[data-card-id="A"] ${TUG_EDIT_CONTENT_SELECTOR}');
                if (ed === null) return false;
                return ed.querySelector('img[data-atom-label]') !== null;
              })()`,
              { timeoutMs: 2000 },
            );
            await app.nativeKey("a", ["cmd"]);
            await new Promise((r) => setTimeout(r, 80));
            await app.nativeKey("c", ["cmd"]);
            await new Promise((r) => setTimeout(r, 150));
            const mixedClip = await readClipboard(app);
            expect(
              mixedClip.text,
              "mixed ⌘C: bridge text payload (plain spelling substituted for U+FFFC)",
            ).toBe(`x${FILE_ATOM_PLAIN}`);

            // ---- Scenario 3: atom-only ----
            // Reset, insert "file" atom, shift-arrow-left to select it,
            // ⌘C. Bridge text should be just the atom's plain spelling.
            await clearEditor(app);
            await app.nativeClickAtElement(GALLERY_FILE_ATOM_BUTTON_SELECTOR);
            await app.nativeClickAtElement(`[data-card-id="A"] ${TUG_EDIT_CONTENT_SELECTOR}`);
            await app.waitForCondition<boolean>(
              `(function(){
                var ed = document.querySelector('[data-card-id="A"] ${TUG_EDIT_CONTENT_SELECTOR}');
                if (ed === null) return false;
                return ed.querySelectorAll('img[data-atom-label]').length === 1
                  && ed.textContent.length === 0;
              })()`,
              { timeoutMs: 2000 },
            );
            await app.nativeKey("ArrowLeft", ["shift"]);
            await new Promise((r) => setTimeout(r, 80));
            await app.nativeKey("c", ["cmd"]);
            await new Promise((r) => setTimeout(r, 150));
            const atomOnlyClip = await readClipboard(app);
            expect(
              atomOnlyClip.text,
              "atom-only ⌘C: bridge text payload (the atom's plain spelling)",
            ).toBe(FILE_ATOM_PLAIN);

            // ---- Atom sidecar payload assertions ----
            //
            // text-only has no atoms, so the `dev.tugapp.prompt-atoms`
            // type is never written — the bridge's `atoms` field is
            // empty by design.
            expect(textOnlyClip.atoms, "text-only atoms payload — no atoms = empty").toBe("");

            // Mixed and atom-only carry the self-contained sidecar JSON
            // on the Tug-private pasteboard type. Parse it and assert
            // the atom's label survives; the round-trip paste below
            // proves the data is recoverable end-to-end.
            const mixedSidecar = JSON.parse(mixedClip.atoms) as {
              version: number;
              atoms: { segment: { label: string } }[];
            };
            expect(mixedSidecar.version, "mixed atoms: sidecar version").toBe(1);
            expect(
              mixedSidecar.atoms.map((a) => a.segment.label),
              "mixed atoms: carries the file atom's label",
            ).toContain(FILE_ATOM_LABEL);

            const atomOnlySidecar = JSON.parse(atomOnlyClip.atoms) as {
              version: number;
              atoms: { segment: { label: string } }[];
            };
            expect(atomOnlySidecar.version, "atom-only atoms: sidecar version").toBe(1);
            expect(
              atomOnlySidecar.atoms.map((a) => a.segment.label),
              "atom-only atoms: carries the file atom's label",
            ).toEqual([FILE_ATOM_LABEL]);

            // ---- Round-trip assertion ----
            //
            // Confirm the bridge-paste path reconstructs the atom
            // widget from the sidecar payload. The atom-only clipboard
            // is what was last copied; clear the editor and ⌘V should
            // produce one `<img data-atom-label>` in the destination.
            await clearEditor(app);
            await app.nativeKey("v", ["cmd"]);
            await app.waitForCondition<boolean>(
              `(function(){
                var ed = document.querySelector('[data-card-id="A"] ${TUG_EDIT_CONTENT_SELECTOR}');
                if (ed === null) return false;
                var imgs = ed.querySelectorAll('img[data-atom-label]');
                return imgs.length === 1
                  && imgs[0].getAttribute('data-atom-label') === ${JSON.stringify(FILE_ATOM_LABEL)};
              })()`,
              { timeoutMs: 4000 },
            );
          } finally {
            await app.close();
          }
        } finally {
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
