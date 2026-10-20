/**
 * at0213-open-quickly.test.ts — the Open Quickly dialog (File ▸ Open Quickly,
 * ⇧⌘O → `open-quickly` control → OpenQuicklyOverlay → TugModalInputDialog).
 *
 * This file covers the dialog's own behavior with no search root: the control
 * opens the deck-global dialog — drawn in the overlay page, above every card,
 * so every read of it is the overlay's — the query field claims focus,
 * registers as a chain responder, and accepts input, and every dismissal path
 * closes it. The
 * FILETREE-backed result list and the file-open commit need a registered
 * workspace, which at0306 provides by pointing the default project directory at
 * a temp tree — so the two files together cover the surface end to end. The
 * `file:line` query parsing is covered by `file-location-query.test.ts`.
 *
 * The dismissal list is the point of the rework, and it is now closed and
 * short: the Escape ladder, ⌘., an outside interaction, an app switch, and the
 * commit. The old popup had, on top of those, an `onBlur` with three
 * exemptions, a caller-supplied `dismissGuard`, and a backdrop `onMouseDown` —
 * an apparatus that existed to approximate modality. Real modality replaced it,
 * which is why the outside-click test below asserts a second thing it never
 * used to: that the click did not activate what it landed on.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @foreground
 * @covers tugdeck/src/lib/open-quickly-store.ts
 * @covers tugdeck/src/components/chrome/open-quickly-overlay.tsx
 * @covers tugdeck/src/components/tugways/tug-modal-input-dialog.tsx
 * @covers tugdeck/src/lib/open-file-in-card.ts
 * @covers tugdeck/src/lib/file-location-query.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note, type App, type BodyApp } from "./_harness";
import { overlayReady } from "./overlay-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const PANEL = '[data-slot="tug-modal-input-dialog"]';
const INPUT = ".tug-modal-input-dialog .tug-modal-input-dialog-input";
const OVERLAY = '[data-slot="tug-modal-input-dialog-overlay"]';
const OVERLAY_ROOT = '[data-slot="tug-canvas-overlay-root"]';

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

async function dispatchControl(app: App, action: string): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.dispatchControlAction(${JSON.stringify(action)}), null)`,
  );
}

async function exists(ui: BodyApp, selector: string): Promise<boolean> {
  return ui.evalJS<boolean>(
    `document.querySelector(${JSON.stringify(selector)}) !== null`,
  );
}

async function waitGone(ui: BodyApp, selector: string, timeoutMs = 8000): Promise<void> {
  await ui.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(selector)}) === null`,
    { timeoutMs },
  );
}

/** Open the dialog from the shell; it is drawn in the overlay page `ui`. */
async function openDialog(app: App, ui: BodyApp): Promise<void> {
  await dispatchControl(app, "open-quickly");
  await ui.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(PANEL)}) !== null`,
    { timeoutMs: 8000 },
  );
}

describe.skipIf(!SHOULD_RUN)("at0213: Open Quickly dialog", () => {
  test(
    "open-quickly opens a focused, app-modal search dialog that accepts input",
    async () => {
      const app = await launchTugApp({ testName: "at0213-open-quickly" });
      try {
        // The overlay page (and its canvas overlay root) must be up before
        // the control has anywhere to portal.
        const ui = await overlayReady(app);
        await ui.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(OVERLAY_ROOT)}) !== null`,
          { timeoutMs: 20000 },
        );

        // 1. The control opens the dialog, with its blocking overlay.
        await openDialog(app, ui);
        expect(await exists(ui, OVERLAY)).toBe(true);

        // 2. The query field claims focus on open — typing-first.
        await ui.waitForCondition<boolean>(
          `document.activeElement === document.querySelector(${JSON.stringify(INPUT)})`,
          { timeoutMs: 4000 },
        );

        // 3. The field is a registered chain responder. ⌘V is a
        // capture-phase global binding dispatched to the FIRST RESPONDER, and
        // promotion walks DOM-up from the focused element to the nearest
        // `data-responder-id`. Without this attribute the dialog's paste is
        // delivered to whatever surface behind it still held first responder.
        expect(
          await ui.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(INPUT)})
               .hasAttribute("data-responder-id")`,
          ),
        ).toBe(true);

        // 4. The dialog's own rules beat TugInput's boxed chrome: the field
        // renders as a bare search line on the panel surface, not a 32px
        // bordered box with its own fill.
        const fieldChrome = await ui.evalJS<{
          bg: string;
          border: string;
          pad: string;
          size: number;
        }>(
          `(function(){
             var s = getComputedStyle(
               document.querySelector(${JSON.stringify(INPUT)}));
             return {
               bg: s.backgroundColor,
               border: s.borderTopStyle,
               pad: s.paddingLeft,
               size: parseFloat(s.fontSize),
             };
           })()`,
        );
        expect(fieldChrome.bg).toBe("rgba(0, 0, 0, 0)");
        expect(fieldChrome.border).toBe("none");
        expect(fieldChrome.pad).toBe("0px");
        // Larger than TugInput's md size variant (font-size-sm), which the
        // dialog's font-size-xl must be overriding.
        expect(fieldChrome.size).toBeGreaterThan(16);

        // 5. It is a live controlled input — typing lands in the field.
        await ui.evalJS<null>(
          `(function(){
             var input = document.querySelector(${JSON.stringify(INPUT)});
             var setter = Object.getOwnPropertyDescriptor(
               window.HTMLInputElement.prototype, "value").set;
             setter.call(input, "readme");
             input.dispatchEvent(new Event("input", { bubbles: true }));
             return null;
           })()`,
        );
        await ui.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(INPUT)}).value === "readme"`,
          { timeoutMs: 4000 },
        );

        // 6. Escape dismisses — the engine's ladder, not a field handler.
        await app.nativeKey("Escape");
        await waitGone(ui, PANEL);
        // …and the overlay goes with it. A blocking overlay left standing over
        // a dismissed dialog is a deck nothing can be clicked on.
        expect(await exists(ui, OVERLAY)).toBe(false);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "Escape cancels the manual mode first, and dismisses on the next press",
    async () => {
      // Escape has two meanings inside a typing-first dialog and they are
      // ORDERED, not exclusive: at a ⌥⇥-parked text stop it hands the caret
      // back (the ring says "you are here", Escape says "stop steering"), and
      // with the caret live it closes the surface. The ladder rung that grants
      // sits ahead of the surface's own dismiss, so the risk this pins is that
      // the grant never lets go — an Escape that cancels the mode and then
      // keeps cancelling it, leaving the dialog unclosable from the keyboard.
      const app = await launchTugApp({
        testName: "at0213-open-quickly-escape",
        // ⌥⇥ and Escape are real key events against a frontmost app.
        foreground: true,
      });
      try {
        const ui = await overlayReady(app);
        await ui.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(OVERLAY_ROOT)}) !== null`,
          { timeoutMs: 20000 },
        );
        await openDialog(app, ui);
        await ui.waitForCondition<boolean>(
          `document.activeElement === document.querySelector(${JSON.stringify(INPUT)})`,
          { timeoutMs: 8000 },
        );

        const state = `(function () {
          var input = document.querySelector(${JSON.stringify(INPUT)});
          var ringed = document.querySelector("[data-key-view-kbd]");
          var panel = document.querySelector(${JSON.stringify(PANEL)});
          return {
            closing: panel !== null && panel.hasAttribute("data-closing"),
            opacity: panel === null ? "(none)" : getComputedStyle(panel).opacity,
            dialog: panel !== null,
            caret: input !== null && document.activeElement === input,
            mode: document.documentElement.hasAttribute("data-kbf"),
            engaged: window.__tug.kbfEngaged(),
            manual: window.__tug.kbfManual(),
            ringed: ringed === null ? "(none)" : (ringed.getAttribute("data-tug-focus-key") || ringed.tagName),
          };
        })()`;
        type State = {
          closing: boolean;
          opacity: string;
          dialog: boolean;
          caret: boolean;
          mode: boolean;
          engaged: boolean | null;
          manual: boolean | null;
          ringed: string;
        };

        // ⌥⇥ engages the mode over the live caret, which PARKS the field: the
        // ring lands where the caret was.
        await app.nativeKey("Tab", ["alt"]);
        await ui.waitForCondition<boolean>(
          `document.documentElement.hasAttribute("data-kbf")`,
          { timeoutMs: 8000 },
        );
        const engaged = await ui.evalJS<State>(state);
        note(`after ⌥⇥: ${JSON.stringify(engaged)}`);
        expect(engaged.dialog, "⌥⇥ leaves the dialog open").toBe(true);
        expect(engaged.ringed, "⌥⇥ parks the ring on the query field").toBe(
          "tug-modal-input-dialog:0",
        );

        // First Escape: the mode goes, the caret comes back, the dialog stays.
        await app.nativeKey("Escape");
        await ui.waitForCondition<boolean>(
          `document.activeElement === document.querySelector(${JSON.stringify(INPUT)})`,
          { timeoutMs: 8000 },
        );
        const cancelled = await ui.evalJS<State>(state);
        note(`after the first Escape: ${JSON.stringify(cancelled)}`);
        expect(
          cancelled.dialog,
          "Escape at a parked stop cancels the mode, never the dialog",
        ).toBe(true);
        expect(cancelled.caret, "…and hands the caret back to the field").toBe(
          true,
        );

        // Second Escape: no parked stop left, so the rung falls through to the
        // surface's dismiss. THIS is the one that regressed.
        await app.nativeKey("Escape");
        await waitGone(ui, PANEL);
        expect(
          await exists(ui, OVERLAY),
          "the blocking overlay goes with the dialog",
        ).toBe(false);

        // And the same ladder from the other starting state: the deck already
        // in the mode when the dialog opens. The deck's mode is the shell's,
        // which holds the keyboard once the dialog has gone. The manual bit
        // is the DECK's here, not something the dialog's own ⌥⇥ set, so the grant rung must still
        // let go on the press after it — otherwise a user who works in the mode
        // finds the launcher unclosable, which is the state a fresh app-test
        // deck never reaches on its own.
        await app.nativeKey("Tab", ["alt"]);
        await app.waitForCondition<boolean>(
          `document.documentElement.hasAttribute("data-kbf")`,
          { timeoutMs: 8000 },
        );
        await openDialog(app, ui);
        const onOpen = await ui.evalJS<State>(state);
        note(`dialog opened with the deck already engaged: ${JSON.stringify(onOpen)}`);
        // ONE press. The deck's bit is not the dialog's, and the dialog opens
        // with it cleared, so there is no invisible mode for Escape to spend
        // itself leaving — the launcher's first Escape is the launcher's.
        expect(onOpen.dialog, "the dialog is up").toBe(true);
        await app.nativeKey("Escape");
        await settle(400);
        note(
          `after one Escape: ${JSON.stringify(await ui.evalJS<State>(state))}`,
        );
        expect(
          await exists(ui, PANEL),
          "one Escape closes the dialog even when the deck was already in the mode",
        ).toBe(false);
        expect(
          await app.evalJS<boolean | null>(`window.__tug.kbfManual()`),
          "…and the deck gets its own mode back on the way out",
        ).toBe(true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "⌘. dismisses, and an outside click dismisses without activating what it hit",
    async () => {
      const app = await launchTugApp({
        testName: "at0213-open-quickly-dismiss",
        // ⌘. is only delivered to an app that is actually frontmost — the
        // background pid-mode default drops it and only the bare `Meta`
        // keydown reaches the page. Same reason at0151 runs foreground.
        foreground: true,
      });
      try {
        const ui = await overlayReady(app);
        await ui.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(OVERLAY_ROOT)}) !== null`,
          { timeoutMs: 20000 },
        );

        // ⌘. — the macOS cancel chord, new with the modal shell.
        await openDialog(app, ui);
        await app.nativeKey(".", ["cmd"]);
        await waitGone(ui, PANEL);

        // An outside click dismisses (launcher posture), and the overlay
        // swallows it so nothing beneath activates. The proof is a deck that
        // did not change: the click lands where the empty deck's own surface
        // is, and if the overlay had let it through, the deck would have taken
        // it as an activation.
        await settle();
        const deckBefore = await app.evalJS<string>(
          `JSON.stringify(window.tugdeck.diag.getDeckState())`,
        );
        await openDialog(app, ui);

        // A point well outside the panel — the panel sits ~22vh down and is at
        // most 680px wide, so the top-left corner region is never under it.
        const outside = await ui.evalJS<{ x: number; y: number }>(
          `(function(){
             var r = document.querySelector(${JSON.stringify(PANEL)}).getBoundingClientRect();
             return { x: Math.max(8, Math.round(r.left / 2)), y: 8 };
           })()`,
        );
        note(`outside click at ${outside.x},${outside.y}`);
        await app.nativeClick(outside);
        await waitGone(ui, PANEL);

        // Nothing beneath the overlay was activated by that press.
        await settle(500);
        const deckAfter = await app.evalJS<string>(
          `JSON.stringify(window.tugdeck.diag.getDeckState())`,
        );
        expect(deckAfter).toBe(deckBefore);
        expect(await exists(ui, OVERLAY)).toBe(false);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
