/**
 * at0810-masthead-rename.test.ts — a session is renamed in place, in the
 * Session card's masthead.
 *
 * ## What this gates
 *
 * The masthead's name becomes a text field while its card is in rename mode.
 * Two doors on the masthead open it — Rename Session… in the right-click menu,
 * and the pencil that follows the name on hover — and three gestures close it:
 * Escape leaves the name as it was, Return commits the field, and clicking
 * away commits it too. A bare `/rename` in the composer opens the same field.
 *
 * Every gesture is native, because each one is the subject:
 *
 *   - the menu row is reached through the real right press the title bar has
 *     to let through (see at0556 for what happens when it does not);
 *   - the pencil sits in the title bar, whose pointer-down starts a drag, so
 *     the real press on it is also the proof that it moves no card. It is
 *     revealed by the `pointerenter` the name listens for, dispatched here
 *     the way `revealPaneControls` dispatches the title bar's — a background
 *     app-test has no business moving the physical cursor;
 *   - the field takes the key view through the focus engine from chrome that
 *     stands outside the card host, so only real keystrokes say whether the
 *     typing, the Return and the Escape reach it.
 *
 * The line is seeded into the ledger first, so each rename is one tugcast
 * accepts: a refused rename puts the old name back on the ack, and the title
 * read after a commit would then be a race against the refusal. That the name
 * survives onto a later segment is at0481's subject, not this file's.
 *
 * @covers tugdeck/src/components/tugways/session-masthead.tsx
 * @covers tugdeck/src/components/tugways/session-identity-row.tsx
 * @covers tugdeck/src/components/tugways/session-identity-menu.tsx
 * @covers tugdeck/src/components/tugways/session-name-editor.tsx
 * @covers tugdeck/src/components/tugways/session-name-editor.css
 * @covers tugdeck/src/lib/session-rename-mode-store.ts
 * @covers tugdeck/src/lib/session-rename-commit.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SESSION_ID = "c4d5e6f7-2b3c-4d5e-9f60-6b7c8d9e0810";
const LINE_ID = "c4d5e6f7-2b3c-4d5e-9f60-6b7c8d9e0811";
const TAG = "calm-meridian";

const NAME = "harbor light";
const BY_RETURN = "low tide";
const BY_BLUR = "north pier";
const BY_SLASH = "east quay";

// The masthead is pane chrome, which a Session card draws in its own page.
const PANE = ".body-chrome-frame";
const MASTHEAD = `${PANE} [data-slot="session-masthead"]`;
const TITLE = `${MASTHEAD} .tug-session-identity-title`;
const EDITOR = `${MASTHEAD} [data-testid="session-name-editor"]`;
const PENCIL = `${MASTHEAD} [data-testid="session-name-rename"]`;
const MENU = '[data-slot="tug-editor-context-menu"]';
const RENAME_ROW = `${MENU} [data-item-action="rename-session"]`;
const PROMPT = `[data-slot="tug-text-editor"] .cm-content`;

let projectDir = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-at0810-")));
  writeFileSync(join(projectDir, "README.md"), "at0810\n");
});

afterAll(() => {
  if (projectDir !== "" && existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

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
        line_id: LINE_ID,
        project_dir: projectDir,
        tag: TAG,
        name: NAME,
        name_user_set: true,
        turn_count: 6,
        file_size: 12_288,
        last_user_prompt: "Rename the session from its masthead",
        last_used_at: 1_754_600_000_000,
      },
    }),
  )})`;
}

/** What the masthead's title line is showing, and whether it is a field. */
function titleState(): string {
  return `(function(){
     var title = document.querySelector(${JSON.stringify(TITLE)});
     var field = document.querySelector(${JSON.stringify(EDITOR)});
     return {
       text: title === null ? null : (title.textContent || ""),
       editing: field !== null,
       value: field === null ? null : field.value,
       focused: field !== null && document.activeElement === field,
       selected: field === null ? null : field.selectionEnd - field.selectionStart,
     };
   })()`;
}

interface TitleState {
  text: string | null;
  editing: boolean;
  value: string | null;
  focused: boolean;
  selected: number | null;
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

describe.skipIf(!SHOULD_RUN)("at0810 — the masthead's name is edited in place", () => {
  test(
    "the menu and the pencil open the field; Esc cancels, Return and a click away rename",
    async () => {
      const app = await launchTugApp({ testName: "at0810-masthead-rename" });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "S" });
        app.seedLedger({
          sessions: [
            {
              session_id: SESSION_ID,
              workspace_key: projectDir,
              project_dir: projectDir,
              card_id: "S",
              line_id: LINE_ID,
              tag: TAG,
            },
          ],
        });
        await app.bindSession("S", {
          tugSessionId: SESSION_ID,
          lineId: LINE_ID,
          projectDir,
        });
        const body = app.body("S");
        await body.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(MASTHEAD)}) !== null`,
          { timeoutMs: 15_000 },
        );
        expect(await app.evalJS<boolean>(publishSession())).toBe(true);
        expect(await body.evalJS<boolean>(publishSession())).toBe(true);
        const shows = (name: string, editing: boolean): string =>
          `(function(){
             var s = ${titleState()};
             return s.editing === ${editing} && s.text !== null &&
               (${editing} || s.text.indexOf(${JSON.stringify(name)}) !== -1);
           })()`;
        await body.waitForCondition<boolean>(shows(NAME, false), { timeoutMs: 10_000 });

        const openFromMenu = async (): Promise<void> => {
          await body.nativeRightClickAtElement(TITLE);
          await body.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(RENAME_ROW)}) !== null`,
            { timeoutMs: 8_000 },
          );
          await body.nativeClickAtElement(RENAME_ROW);
          await body.waitForCondition<boolean>(
            `(function(){ var s = ${titleState()}; return s.editing && s.focused; })()`,
            { timeoutMs: 8_000 },
          );
        };

        // Where the masthead's lines stand, for the claim that opening the
        // field moves none of them: the title box, the description under it,
        // and the bar they are both in.
        const lines = (): string =>
          `(function(){
             function box(sel){ var b = document.querySelector(sel).getBoundingClientRect(); return [Math.round(b.top * 10) / 10, Math.round(b.height * 10) / 10]; }
             return {
               title: box(${JSON.stringify(TITLE)}),
               description: box(${JSON.stringify(`${MASTHEAD} .tug-session-row-description`)}),
               bar: box(${JSON.stringify(`${PANE} .tug-pane-title-bar`)}),
             };
           })()`;
        const atRest = await body.evalJS<unknown>(lines());

        // ---- The menu's row opens the field; Escape leaves the name. ------
        await openFromMenu();
        // Editing changes nothing vertically: no line hops, the bar keeps its height.
        expect(await body.evalJS<unknown>(lines())).toEqual(atRest);
        const opened = await body.evalJS<TitleState>(titleState());
        note("at0810 opened", JSON.stringify(opened));
        // Seeded with the name, the whole of it selected so typing replaces it.
        expect(opened.value).toBe(NAME);
        expect(opened.selected).toBe(NAME.length);

        await app.nativeType("discarded");
        await body.waitForCondition<boolean>(
          `(function(){ var s = ${titleState()}; return s.value === "discarded"; })()`,
          { timeoutMs: 8_000 },
        );
        await app.nativeKey("Escape");
        await body.waitForCondition<boolean>(shows(NAME, false), { timeoutMs: 8_000 });

        // ---- The pencil opens it, and the press drags nothing. ------------
        //
        // The pointer enters the name, which is all the reveal asks for; the
        // button has no width until then. The place it will stand answers the
        // pointer all the same: a point just past the name, at rest, is the
        // button's own wrapper, so a pointer arriving there reveals it too.
        expect(
          await body.evalJS<boolean>(
            `(function(){
               var r = document.querySelector(${JSON.stringify(TITLE)}).getBoundingClientRect();
               var hit = document.elementFromPoint(r.right + 24, r.top + r.height / 2);
               return hit !== null && hit.closest('[data-slot="session-name-rename"]') !== null;
             })()`,
          ),
        ).toBe(true);
        const before = await body.evalJS<{ left: number; top: number; gesture: string | null }>(
          paneFrame(),
        );
        expect(
          await body.evalJS<number>(
            `document.querySelector(${JSON.stringify(PENCIL)}).closest('[data-slot="session-name-rename"]').getBoundingClientRect().width`,
          ),
        ).toBe(0);
        await body.evalJS<null>(
          `(function(){
             document.querySelector(${JSON.stringify(TITLE)})
               .closest(".tug-session-identity-run")
               .dispatchEvent(new PointerEvent("pointerenter", { bubbles: false }));
             return null;
           })()`,
        );
        await body.waitForCondition<boolean>(
          `(function(){
             var el = document.querySelector(${JSON.stringify(PENCIL)});
             if (el === null) return false;
             var span = el.closest('[data-slot="session-name-rename"]');
             return span.getBoundingClientRect().width > 0 && el.getBoundingClientRect().width > 0;
           })()`,
          { timeoutMs: 8_000 },
        );
        // The label is the button's own, inside its box.
        expect(
          await body.evalJS<string>(
            `document.querySelector(${JSON.stringify(PENCIL)}).textContent.trim()`,
          ),
        ).toBe("Rename");
        await body.nativeClickAtElement(PENCIL);
        await body.waitForCondition<boolean>(
          `(function(){ var s = ${titleState()}; return s.editing && s.focused; })()`,
          { timeoutMs: 8_000 },
        );
        // Opened by a press, the name is still selected whole.
        const byPencil = await body.evalJS<TitleState>(titleState());
        expect(byPencil.value).toBe(NAME);
        expect(byPencil.selected).toBe(NAME.length);
        const during = await body.evalJS<{ left: number; top: number; gesture: string | null }>(
          paneFrame(),
        );
        note("at0810 frame", `${JSON.stringify(before)} -> ${JSON.stringify(during)}`);
        expect(during.left).toBe(before.left);
        expect(during.top).toBe(before.top);
        expect(during.gesture).toBe(null);

        // ---- Return renames. ---------------------------------------------
        await app.nativeType(BY_RETURN);
        await body.waitForCondition<boolean>(
          `(function(){ var s = ${titleState()}; return s.value === ${JSON.stringify(BY_RETURN)}; })()`,
          { timeoutMs: 8_000 },
        );
        await app.nativeKey("Enter");
        note("at0810 after Return", JSON.stringify(await body.evalJS<TitleState>(titleState())));
        await body.waitForCondition<boolean>(shows(BY_RETURN, false), { timeoutMs: 8_000 });

        // ---- A click away renames too. -----------------------------------
        await openFromMenu();
        await app.nativeType(BY_BLUR);
        await body.waitForCondition<boolean>(
          `(function(){ var s = ${titleState()}; return s.value === ${JSON.stringify(BY_BLUR)}; })()`,
          { timeoutMs: 8_000 },
        );
        await body.nativeClickAtElement(PROMPT);
        await body.waitForCondition<boolean>(shows(BY_BLUR, false), { timeoutMs: 8_000 });

        // ---- A bare `/rename` is a third door onto the same field. --------
        //
        // The click away left the caret in the composer.
        await app.nativeType("/rename");
        await new Promise((r) => setTimeout(r, 150));
        await app.nativeKey("Enter", ["cmd"]);
        await body.waitForCondition<boolean>(
          `(function(){ var s = ${titleState()}; return s.editing && s.focused; })()`,
          { timeoutMs: 8_000 },
        );
        await app.nativeType(BY_SLASH);
        await body.waitForCondition<boolean>(
          `(function(){ var s = ${titleState()}; return s.value === ${JSON.stringify(BY_SLASH)}; })()`,
          { timeoutMs: 8_000 },
        );
        await app.nativeKey("Enter");
        await body.waitForCondition<boolean>(shows(BY_SLASH, false), { timeoutMs: 8_000 });
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
