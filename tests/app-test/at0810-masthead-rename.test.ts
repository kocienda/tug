/**
 * at0810-masthead-rename.test.ts — a session is renamed in place, in the
 * Session card's masthead.
 *
 * ## What this gates
 *
 * The masthead's name becomes a text field while its card is in rename mode.
 * Two doors on the masthead open it — Rename Session… in the right-click menu,
 * and the pencil that leads the title bar's rollup — and three gestures close it:
 * Escape leaves the name as it was, Return commits the field, and clicking
 * away commits it too. A bare `/rename` in the composer opens the same field.
 *
 * Every gesture is native, because each one is the subject:
 *
 *   - the menu row is reached through the real right press the title bar has
 *     to let through (see at0556 for what happens when it does not);
 *   - the pencil sits in the title bar, whose pointer-down starts a drag, so
 *     the real press on it is also the proof that it moves no card. It is a
 *     member of the rollup, revealed with the row by `revealPaneControls` — a
 *     background app-test has no business moving the physical cursor;
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
const PENCIL = `${PANE} [data-testid="session-name-rename"]`;
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
        // And the selection is painted. The title bar blanks `::selection`
        // for its chrome, which once reached into the field and left the
        // selected name looking unselected.
        const paint = await body.evalJS<string>(
          `getComputedStyle(document.querySelector(${JSON.stringify(EDITOR)}), "::selection").backgroundColor`,
        );
        note("at0810 selection paint", paint);
        expect(paint).not.toBe("rgba(0, 0, 0, 0)");
        expect(paint).not.toBe("transparent");

        await app.nativeType("discarded");
        await body.waitForCondition<boolean>(
          `(function(){ var s = ${titleState()}; return s.value === "discarded"; })()`,
          { timeoutMs: 8_000 },
        );
        await app.nativeKey("Escape");
        await body.waitForCondition<boolean>(shows(NAME, false), { timeoutMs: 8_000 });

        // ---- The pencil opens it, and the press drags nothing. ------------
        //
        // It is one of the rollup's buttons and nothing more: revealed with
        // the row, the leftmost button in it, a glyph with no label, and no
        // control of any kind stands in the title line beside the name.
        const before = await body.evalJS<{ left: number; top: number; gesture: string | null }>(
          paneFrame(),
        );
        await body.revealPaneControls(PANE);
        const seat = await body.evalJS<{ first: boolean; label: string; inTitleLine: number }>(
          `(function(){
             var el = document.querySelector(${JSON.stringify(PENCIL)});
             var row = el.closest('[data-testid="tug-pane-title-bar-rollup-row"]');
             return {
               first: row !== null && row.querySelector(".tug-button") === el,
               label: el.textContent.trim(),
               inTitleLine: document.querySelectorAll(${JSON.stringify(`${MASTHEAD} .tug-session-row-name-line .tug-button`)}).length,
             };
           })()`,
        );
        note("at0810 pencil seat", JSON.stringify(seat));
        expect(seat).toEqual({ first: true, label: "", inTitleLine: 0 });
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
