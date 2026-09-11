/**
 * at0556-masthead-control-click-menu.test.ts — the masthead answers a macOS
 * Control-click the same way it answers a right button.
 *
 * ## What this gates
 *
 * The pane's title bar starts a drag on pointer-down and takes POINTER CAPTURE
 * on the frame to do it. WebKit then retargets every later event of that
 * pointer to the capture element, the `contextmenu` included — so a press the
 * bar mistakes for a drag arrives at `.tug-pane`, no handler inside the bar
 * ever sees it, and the app's document-level fallback answers with "No
 * Actions". The session masthead's three lines live in that bar, which is how
 * a row carrying five copies came to look like a surface with nothing to say.
 *
 * `a69b2cfd7` closed that for the right button with a `button !== 0` guard.
 * A macOS **Control-click is button 0**, so it walked straight through the
 * guard and took the capture, and the masthead went silent again for every
 * reader who right-clicks that way. at0387 stayed green throughout: it presses
 * with a real right button, which is the one spelling the guard covered.
 *
 * So the gesture is the subject here, and it is driven natively — Control held
 * at the windowserver, a real left press posted underneath it. A synthesized
 * `contextmenu` cannot see any of this: it never takes a capture, so it never
 * meets the bug. What the seeded card lacks against the user's own — a live
 * tugcode session, an arc on the title — is not in the path: the capture is
 * taken by the bar on pointer-down before anything about the session is
 * consulted, and the press either reaches the row or does not.
 *
 * The second assertion is the fix's other half: a Control-click must not START
 * a drag either. A press that opened the menu and moved the card under it
 * would be trading one defect for a worse one.
 *
 * The guard this gates lives in `tug-pane.tsx`, and that file is NOT named
 * below: it stands at its accepted fan-out of 21 and a recorded number may be
 * paid down, never refinanced. What is named instead is the module the guard
 * now asks — `whole-entity-press.ts`, where "secondary press" is defined for
 * the whole app — which is the half of the fix that had no home before. An
 * edit to the bar's own pointer-down still selects at0387, which drives a real
 * right press through the same capture.
 *
 * @covers tugdeck/src/lib/whole-entity-press.ts
 * @covers tugdeck/src/components/tugways/session-identity-row.tsx
 * @covers tugdeck/src/components/tugways/session-identity-menu.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SESSION_ID = "c4d5e6f7-2b3c-4d5e-9f60-6b7c8d9e0f13";
const PROJECT_DIR = "/Users/tester/src/tugtool";
const TAG = "calm-meridian";

const PROMPT =
  "Bring the masthead's right-click menu back for a Control-click, which is " +
  "the gesture the button guard never covered";

const PANE = '.tug-pane[data-pane-id="p1"]';
const MASTHEAD = `${PANE} [data-slot="session-masthead"]`;
const TITLE = `${MASTHEAD} .session-masthead-title`;
const DESCRIPTION = `${MASTHEAD} .tug-session-row-description`;
const MENU = '[data-slot="tug-editor-context-menu"]';

function deckShape() {
  return {
    cards: [{ id: "S", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 820, height: 620 },
        cardIds: ["S"],
        activeCardId: "S",
        title: "",
        acceptsFamilies: ["standard"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

/** The `session_updated` frame the supervisor pushes after a ledger write. */
function publishSession(): string {
  return `window.__tug.publishSessionUpdated(${JSON.stringify(
    JSON.stringify({
      session_id: SESSION_ID,
      fields: {
        session_id: SESSION_ID,
        project_dir: PROJECT_DIR,
        tag: TAG,
        name: null,
        name_user_set: false,
        turn_count: 6,
        file_size: 12_288,
        last_user_prompt: PROMPT,
        last_used_at: 1_754_600_000_000,
      },
    }),
  )})`;
}

/** Every row of the open menu, in the order it renders. */
function menuRows(): string {
  return `Array.prototype.map.call(
     document.querySelectorAll(${JSON.stringify(MENU)} + ' [role="menuitem"]'),
     function (item) {
       return {
         action: item.getAttribute("data-item-action") || "",
         disabled: item.getAttribute("aria-disabled") === "true",
       };
     })`;
}

/** Where the pane stands, and whether a hand is on it. */
function paneFrame(): string {
  return `(function(){
     var el = document.querySelector(${JSON.stringify(PANE)});
     var r = el.getBoundingClientRect();
     return {
       left: Math.round(r.left),
       top: Math.round(r.top),
       gesture: el.getAttribute("data-gesture"),
     };
   })()`;
}

function closeMenu(): string {
  return `(function(){
     document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
     return null;
   })()`;
}

describe.skipIf(!SHOULD_RUN)("at0556 — the masthead under a Control-click", () => {
  test(
    "a Control-click on the masthead opens the session's menu and moves no card",
    async () => {
      const app = await launchTugApp({
        testName: "at0556-masthead-control-click-menu",
      });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "S" });
        await app.bindSession("S", {
          tugSessionId: SESSION_ID,
          projectDir: PROJECT_DIR,
        });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(MASTHEAD)}) !== null`,
          { timeoutMs: 15_000 },
        );
        expect(await app.evalJS<boolean>(publishSession())).toBe(true);
        await app.waitForCondition<boolean>(
          `(function(){
             var el = document.querySelector(${JSON.stringify(DESCRIPTION)});
             return el !== null && (el.textContent || "").indexOf("Control-click") !== -1;
           })()`,
          { timeoutMs: 10_000 },
        );

        const before = await app.evalJS<{
          left: number;
          top: number;
          gesture: string | null;
        }>(paneFrame());

        // ---- The description, Control-clicked. ----------------------------
        //
        // Control down at the windowserver, then an ordinary LEFT press. That
        // is button 0 plus `ctrlKey` at the DOM — the press the old guard read
        // as a drag.
        await app.withModifiersHeld(["ctrl"], async () => {
          await app.nativeClickAtElement(DESCRIPTION);
        });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(MENU)}) !== null`,
          { timeoutMs: 8_000 },
        );
        // And nothing else answered the same press.
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll('.tug-menu-content').length`,
          ),
        ).toBe(1);

        const rows = await app.evalJS<
          ReadonlyArray<{ action: string; disabled: boolean }>
        >(menuRows());
        note("at0556 menu", JSON.stringify(rows));
        // The row's own menu, identified by the copies only it offers — the
        // same subsequence at0387 pins, for the same reason: what a surface
        // offers above them is that surface's business.
        const copies = rows.filter((r) => r.action.startsWith("copy-session-"));
        expect(copies.map((r) => r.action)).toEqual([
          "copy-session-atom",
          "copy-session-citation",
          "copy-session-id",
          "copy-session-description",
          "copy-session-activity",
        ]);

        // ---- …and the card did not move under it. -------------------------
        const during = await app.evalJS<{
          left: number;
          top: number;
          gesture: string | null;
        }>(paneFrame());
        note("at0556 frame", `${JSON.stringify(before)} -> ${JSON.stringify(during)}`);
        expect(during.left).toBe(before.left);
        expect(during.top).toBe(before.top);
        // `data-gesture` is what the drag writes at pointer-down, before the
        // press has travelled anywhere. A press that never started a drag
        // never wrote it.
        expect(during.gesture).toBe(null);

        await app.evalJS<null>(closeMenu());
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(MENU)}) === null`,
          { timeoutMs: 8_000 },
        );

        // ---- The title line answers the same way. -------------------------
        //
        // A separate press because the title is the run with a claimant of its
        // own: it sits inside a `TugLabel`, which is intrinsically copyable, so
        // the row's capture handler is what keeps one menu over this point
        // rather than the label's Cut/Copy/Paste.
        await app.withModifiersHeld(["ctrl"], async () => {
          await app.nativeClickAtElement(TITLE);
        });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(MENU)}) !== null`,
          { timeoutMs: 8_000 },
        );
        const titleRows = await app.evalJS<
          ReadonlyArray<{ action: string; disabled: boolean }>
        >(menuRows());
        note("at0556 title menu", JSON.stringify(titleRows));
        expect(
          titleRows.filter((r) => r.action.startsWith("copy-session-")).length,
        ).toBe(5);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
