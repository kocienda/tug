/**
 * at0585-workspace-delete-guard.test.ts — a workspace delete cannot clobber
 * unsaved work.
 *
 * Deleting a workspace closes every card in it, and until now it asked about
 * that only when the workspace held a live session. The case it skipped is the
 * case that needed it most: a session can be resumed from its transcript, and
 * an unsaved buffer cannot be recovered from anywhere. A workspace of Text
 * cards with edits in them went in one click of a menu item.
 *
 * So two things hold now, and this file drives both through the real card:
 *
 *   1. **Every delete confirms** ([P06]), and the sentence names what will
 *      close — the card count from the store rather than from the list, which
 *      a search can narrow. The sessions clause appears only when there are
 *      sessions.
 *   2. **The confirm is not the last word.** On confirm the workspace is
 *      ACTIVATED — a parked workspace's cards are not mounted, so their close
 *      guards are not registered and a walk over them would find nothing to
 *      ask about and take the work silently — and then every card that holds
 *      unsaved state gets its own Save / Don't Save / Cancel sheet, over its
 *      own content. Any Cancel abandons the delete, and the workspace stays
 *      present AND stays active: the user is left looking at the card they
 *      just declined to discard.
 *
 * The walk itself is the pane's, extracted rather than copied ([P05]) — the
 * sequence a pane full of dirty tabs has always run when its X is pressed.
 * Two surfaces with two copies of it is how they come to disagree about which
 * cards get asked; `close-guard-walk.test.ts` pins the sequence's own rules
 * and this file pins that the delete actually runs it.
 *
 * The second workspace is made with the verb rather than seeded, because
 * `createSpace` stands its own factory rail — so the Workspaces card the
 * delete is driven from is the one a user would be looking at, in the
 * workspace they would be looking from.
 *
 * @covers tugdeck/src/lib/close-guard-walk.ts
 * @covers tugdeck/src/components/cards/cards-card.tsx
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const ORIGINAL = "alpha\nbeta\n";

/**
 * "On screen", said out loud.
 *
 * Every visited workspace stays MOUNTED ([B06]), so the document holds one
 * Workspaces card per visited workspace — all but one inside a wrapper with
 * no `data-space-shown` and no boxes. A bare `document.querySelectorAll` over
 * rows counts the hidden ones too. The portaled selectors (menus, confirms,
 * sheets) deliberately carry no scope: an overlay is mounted at the canvas's
 * overlay root, outside every layer.
 */
const SHOWN = "[data-space-layer][data-space-shown] ";

const EDITOR = `${SHOWN}[data-card-id="A"] [data-slot="tug-text-card-editor"] .cm-content`;
const HEADER = `${SHOWN}[data-testid="cards-space-header"]`;
const VERBS_BUTTON = '[data-testid="cards-space-verbs-button"]';
const DELETE_ITEM = '[data-item-action="delete-space"]';
const CONFIRM = '[data-slot="tug-confirm-popover"]';
const CONFIRM_MESSAGE = '[data-slot="tug-confirm-message"]';
const CONFIRM_OK = '[data-slot="tug-confirm-confirm"]';
const CONFIRM_CANCEL = '[data-slot="tug-confirm-cancel"]';
const SHEET_CANCEL = '[data-testid="file-save-sheet-cancel"]';
const SHEET_DONT_SAVE = '[data-testid="file-save-sheet-dont-save"]';

const headerFor = (id: string): string =>
  `${SHOWN}.cards-space-header[data-cards-space-id="${id}"]`;

const settle = (ms = 450): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

interface SpacesProbe {
  activeSpaceId: string;
  spaces: { id: string; name: string; active: boolean }[];
}

/** A Workspaces rail beside one Text card — the shape a delete has to walk. */
function deckShape(): Record<string, unknown> {
  return {
    cards: [
      { id: "C1", componentId: "cards", title: "Workspaces", closable: true },
      { id: "A", componentId: "text", title: "A", closable: true },
    ],
    panes: [
      {
        id: "pc1",
        position: { x: 0, y: 0 },
        size: { width: 420, height: 900 },
        cardIds: ["C1"],
        activeCardId: "C1",
        title: "",
        acceptsFamilies: [] as string[],
      },
      {
        id: "p1",
        position: { x: 60, y: 60 },
        size: { width: 700, height: 500 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["standard"],
      },
    ],
    activePaneId: "p1",
    imposition: { kind: "one-up", sidebars: { cards: { side: "right" } } },
    hasFocus: true,
  };
}

/** Open the `···` menu on a workspace's header and press Delete. */
async function pressDelete(app: App, spaceId: string): Promise<void> {
  await app.nativeClickAtElement(`${headerFor(spaceId)} ${VERBS_BUTTON}`);
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(DELETE_ITEM)}) !== null`,
    { timeoutMs: 8_000 },
  );
  await app.nativeClickAtElement(DELETE_ITEM);
}

describe.skipIf(!SHOULD_RUN)("at0585 — a delete that honours every guard", () => {
  test(
    "a delete over a dirty card confirms, walks its sheet, and Cancel abandons it",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "at0585-"));
      const file = path.join(dir, "note.md");
      fs.writeFileSync(file, ORIGINAL, "utf8");

      const app = await launchTugApp({
        testName: "at0585-workspace-delete-guard",
      });
      try {
        await app.seedDeckState({
          state: deckShape(),
          cardStates: {
            A: {
              content: { path: file, anchor: { line: 1, ch: 0 }, scrollTop: 0 },
            },
          },
          focusCardId: "A",
        });
        await app.waitForCondition<boolean>(
          `(function(){
            var el = document.querySelector(${JSON.stringify(EDITOR)});
            return el !== null && el.innerText.indexOf("alpha") !== -1;
          })()`,
          { timeoutMs: 15_000 },
        );

        // ---- Unsaved work in the card, and never on disk. ----------------
        const typed = await app.evalJS<boolean>(
          `(function(){
            var el = document.querySelector(${JSON.stringify(EDITOR)});
            if (el === null) return false;
            el.focus();
            return document.execCommand("insertText", false, "EDIT ");
          })()`,
        );
        expect(typed, "the editor took the edit").toBe(true);
        await settle();
        expect(
          fs.readFileSync(file, "utf8"),
          "the edit is in the buffer and nowhere else — this is the work a delete must not take",
        ).toBe(ORIGINAL);

        const home = await app.evalJS<SpacesProbe>(
          `window.tugdeck.diag.getSpaces()`,
        );
        const HOME = home.activeSpaceId;
        const HOME_NAME = home.spaces.find((s) => s.id === HOME)?.name ?? "";
        expect(home.spaces.length, "one workspace, so far").toBe(1);

        // ---- A second workspace, from the verb: it brings its own rail. --
        await app.evalJS<string>(`window.tugdeck.lab.createSpace("Away")`);
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(HEADER)}).length === 2`,
          { timeoutMs: 10_000 },
        );
        expect(
          await app.evalJS<string>(
            `window.tugdeck.diag.getSpaces().activeSpaceId`,
          ),
          "createSpace activates what it made, so the delete below is of a PARKED workspace",
        ).not.toBe(HOME);

        // ---- The confirm opens at all, and names the cards. --------------
        // It would not have, before: this workspace holds no live session,
        // and the old gate confirmed only when one did.
        await pressDelete(app, HOME);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CONFIRM)}) !== null`,
          { timeoutMs: 8_000 },
        );
        const message = await app.evalJS<string>(
          `document.querySelector(${JSON.stringify(CONFIRM_MESSAGE)}).textContent`,
        );
        note(`at0585 confirm: ${JSON.stringify(message)}`);
        expect(
          message,
          "the sentence counts what will close, and says nothing about sessions there are none of",
        ).toBe(`Delete ${HOME_NAME} and close 2 cards?`);

        // ---- Confirm is not the last word: the card gets its own sheet. --
        await app.nativeClickAtElement(CONFIRM_OK);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHEET_CANCEL)}) !== null`,
          { timeoutMs: 15_000 },
        );
        expect(
          await app.evalJS<string>(
            `window.tugdeck.diag.getSpaces().activeSpaceId`,
          ),
          "the workspace was activated first — a parked card registers no guard, and its sheet would be over nothing",
        ).toBe(HOME);
        expect(
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(EDITOR)}) !== null`,
          ),
          "and the card the sheet is about is the one on screen",
        ).toBe(true);

        // ---- Cancel abandons the DELETE, not just the sheet. -------------
        await app.nativeClickAtElement(SHEET_CANCEL);
        await settle();
        const afterCancel = await app.evalJS<SpacesProbe>(
          `window.tugdeck.diag.getSpaces()`,
        );
        expect(
          afterCancel.spaces.map((s) => s.id),
          "the workspace is still there",
        ).toContain(HOME);
        expect(
          afterCancel.activeSpaceId,
          "and still active — the user is looking at the card they declined to discard",
        ).toBe(HOME);
        expect(
          fs.readFileSync(file, "utf8"),
          "and nothing was written on the way past",
        ).toBe(ORIGINAL);

        // ---- Don't Save finishes what Cancel abandoned. ------------------
        await pressDelete(app, HOME);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CONFIRM_OK)}) !== null`,
          { timeoutMs: 8_000 },
        );
        await app.nativeClickAtElement(CONFIRM_OK);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHEET_DONT_SAVE)}) !== null`,
          { timeoutMs: 15_000 },
        );
        await app.nativeClickAtElement(SHEET_DONT_SAVE);
        await app.waitForCondition<boolean>(
          `window.tugdeck.diag.getSpaces().spaces.length === 1`,
          { timeoutMs: 15_000 },
        );
        expect(
          await app.evalJS<string[]>(
            `window.tugdeck.diag.getSpaces().spaces.map(function (s) { return s.id; })`,
          ),
          "the workspace is gone, by the user's own word",
        ).not.toContain(HOME);
        expect(
          fs.readFileSync(file, "utf8"),
          "Don't Save means don't save",
        ).toBe(ORIGINAL);
      } finally {
        await app.close().catch(() => undefined);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
