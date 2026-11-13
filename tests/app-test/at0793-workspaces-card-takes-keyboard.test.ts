/**
 * at0793-workspaces-card-takes-keyboard.test.ts — the Workspaces card takes
 * the keyboard when the reader clicks it and when they press ⌃⌘W, and shows
 * its cursor the moment it does.
 *
 * Every other surface of the card stands on this one: the list's cursor is
 * the keyboard's position, and a card that holds the keyboard without showing
 * where reads to the reader as a card that never took it. Nothing else drives
 * either door to this card — the sidebar ladder is pinned on the Layout card
 * (at0231) and the rail chords on the rail (at0501) — so a regression in
 * either went unseen.
 *
 * The card is `kbfAtRest`: holding the keyboard engages keyboard-focus mode
 * on its own, so the movement cursor shows with no key pressed. That is what
 * "shows its cursor" means here — the card's page paints the mode
 * (`data-kbf`) and one of its rows carries `data-key-cursor` — read before any
 * key reaches the page, since the first key would engage the mode by itself
 * and hide a door that left it off.
 *
 * One launch, three legs in the workspace the deck opened in and the same
 * three again in a workspace reached by a click on its header — whose
 * Workspaces card is a body that stood up for the switch, which is how a
 * reader's deck gets to most of its Workspaces cards. Each leg starts with the
 * keyboard in that workspace's Text card:
 *
 *   1. **A click on the card's blank area.** The rows stop short of the
 *      card's middle, so its centre is the card itself and no row.
 *   2. **A click on the active workspace's header.** "Go there" is a no-op on
 *      the workspace already showing, so the click is a click on the card.
 *   3. **⌃⌘W, as a real keystroke.** With the card showing but not holding
 *      the keyboard, the sidebar ladder's rung is "focus it".
 *
 * Each leg asserts, in order: the deck's half — the Workspaces card is the
 * active card — and the card's half — its page's key view, first responder or
 * DOM focus is inside its host (`keyboardIsInCard`); the host's half — the
 * card's body web view is the window's first responder, without which no key
 * reaches the page at all; the cursor shows; and an arrow then moves it.
 *
 * @covers tugdeck/src/components/cards/cards-card.tsx
 * @covers tugdeck/src/components/tugways/focus-manager.ts
 * @covers tugdeck/src/sidebar-toggle.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankWrite,
} from "./_harness/tugbank-helpers";
import { keyboardIsInCard, kindBody } from "./_harness/card-reach";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

/** How long a door has to land the keyboard and show the cursor. */
const LAND_MS = 2_000;

/**
 * What the card's page shows of the keyboard: whether it paints the mode, the
 * movement cursor's row, and whether that row is the list's last (so the
 * arrow can be pointed somewhere the cursor can go).
 */
const CURSOR_READING = `(function () {
   var cells = document.querySelectorAll(".cards-list .tug-list-view-cell[data-tug-list-cell-index]");
   var cursor = document.querySelector(".cards-list .tug-list-view-cell[data-key-cursor]");
   return {
     kbf: document.documentElement.hasAttribute("data-kbf"),
     cursor: cursor === null ? null : cursor.getAttribute("data-tug-list-cell-index"),
     atLast: cursor !== null && cells.length > 0 && cursor === cells[cells.length - 1],
   };
 })()`;

interface CursorReading {
  kbf: boolean;
  cursor: string | null;
  atLast: boolean;
}

/** The engine's own account, for the note a miss leaves. */
const ENGINE_READING = `JSON.stringify({
   engaged: window.__tug.kbfEngaged(),
   manual: window.__tug.kbfManual(),
   keyCard: window.__tug.getKeyCardId(),
 })`;

interface DoorResult {
  holds: boolean;
  shows: boolean;
  moves: boolean;
}

const headerOf = (i: number): string =>
  `.cards-space-header[data-cards-space-id="at0793-s${i}"]`;

/** Two workspaces, each a stack of three Text cards with the Workspaces card on the right rail. */
function blob(): Record<string, unknown> {
  const spaces = [0, 1].map((i) => ({
    id: `at0793-s${i}`,
    name: `W${i}`,
    deck: {
      cards: [
        { id: `T${i}`, componentId: "text", title: `T${i}`, closable: true },
        { id: `U${i}`, componentId: "text", title: `U${i}`, closable: true },
        { id: `V${i}`, componentId: "text", title: `V${i}`, closable: true },
        { id: `C${i}`, componentId: "cards", title: "Workspaces", closable: true },
      ],
      panes: [
        {
          id: `pt${i}`,
          position: { x: 60, y: 60 },
          size: { width: 700, height: 400 },
          cardIds: [`T${i}`, `U${i}`, `V${i}`],
          activeCardId: `T${i}`,
          title: "",
          acceptsFamilies: ["standard"],
        },
        {
          id: `pc${i}`,
          position: { x: 0, y: 0 },
          size: { width: 460, height: 900 },
          cardIds: [`C${i}`],
          activeCardId: `C${i}`,
          title: "",
          acceptsFamilies: [] as string[],
        },
      ],
      activePaneId: `pt${i}`,
      imposition: { kind: "one-up", sidebars: { cards: { side: "right" } } },
      hasFocus: true,
    },
  }));
  return { version: 5, activeSpaceId: "at0793-s0", spaces };
}

describe.skipIf(!SHOULD_RUN)("at0793 — the Workspaces card takes the keyboard", () => {
  test(
    "a click on the card and ⌃⌘W each put the keyboard in it, with its cursor showing",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      tugbankWrite(
        tugbankPath,
        "dev.tugapp.deck.layout",
        "layout",
        "json",
        JSON.stringify(blob()),
      );
      const app = await launchTugApp({
        testName: "at0793-takes-keyboard",
        env: { TUGBANK_PATH: tugbankPath },
        skipAccessibilityPreflight: true,
        persistInTestMode: true,
        restoreInTestMode: true,
      });
      const cards = kindBody(app, "cards");

      /** Put the keyboard back in the Text card, so each leg starts away from the rail. */
      const awayTo = async (textId: string): Promise<void> => {
        await app.evalJS<null>(`(window.__tug.activateCard(${JSON.stringify(textId)}), null)`);
        await app.waitForCondition<boolean>(
          `window.__tug.getActiveCardId() === ${JSON.stringify(textId)}`,
          { timeoutMs: 3_000 },
        );
      };

      /** After a door: does the card hold the keyboard, show its cursor, and move it on an arrow? */
      const landed = async (cardId: string, leg: string): Promise<DoorResult> => {
        const deadline = Date.now() + LAND_MS;
        let holds = false;
        let reading: CursorReading = { kbf: false, cursor: null, atLast: false };
        for (;;) {
          const page = await keyboardIsInCard(app, cardId);
          const host = (await app.bodies()).some((b) => b.cardId === cardId && b.firstResponder);
          holds = page && host;
          reading = await cards.evalJS<CursorReading>(CURSOR_READING);
          if (holds && reading.kbf && reading.cursor !== null) break;
          if (Date.now() >= deadline) break;
          await Bun.sleep(50);
        }
        const shows = holds && reading.kbf && reading.cursor !== null;
        if (!shows) {
          const active = await app.evalJS<string | null>(`window.__tug.getActiveCardId()`);
          const engine = await cards.evalJS<string>(ENGINE_READING);
          note(
            `at0793 ${leg}: holds=${holds} active=${JSON.stringify(active)} ` +
              `reading=${JSON.stringify(reading)} engine=${engine}`,
          );
        }
        if (!holds) return { holds, shows, moves: false };
        // Away from whichever end the cursor stands at, so the press has somewhere to go.
        await app.nativeKey(reading.atLast ? "ArrowUp" : "ArrowDown", []);
        await Bun.sleep(150);
        const after = await cards.evalJS<CursorReading>(CURSOR_READING);
        const moves = after.cursor !== null && after.cursor !== reading.cursor;
        if (!moves) note(`at0793 ${leg}: arrow left the cursor at ${JSON.stringify(after)}`);
        return { holds, shows, moves };
      };

      /** The three doors, from the Text card, onto workspace `i`'s Workspaces card. */
      const doors = async (i: number): Promise<Record<string, DoorResult>> => {
        const text = `T${i}`;
        // The rail is the window's: the layout below boots onto one
        // Workspaces card, the first workspace's, which every workspace shows.
        const card = "C0";
        await awayTo(text);
        const blankTarget = await cards.evalJS<string>(
          `(function () {
             var r = document.querySelector(".cards-card").getBoundingClientRect();
             var el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
             return el === null ? "none" : String(el.className);
           })()`,
        );
        expect(
          blankTarget,
          "the card's centre is the card, not a row, so the blank leg clicks the card itself",
        ).not.toContain("tug-list-view-cell");
        await cards.nativeClickAtElement(".cards-card");
        const blank = await landed(card, `W${i} blank click`);
        await awayTo(text);
        await cards.nativeClickAtElement(headerOf(i));
        const header = await landed(card, `W${i} header click`);
        await awayTo(text);
        await app.nativeKey("w", ["ctrl", "cmd"]);
        const chord = await landed(card, `W${i} ⌃⌘W`);
        return { blank, header, chord };
      };

      try {
        await app.waitForCondition<boolean>(
          `typeof window.tugdeck !== "undefined"
           && window.tugdeck.diag.getSpaces().spaces.length === 2`,
          { timeoutMs: 15_000 },
        );
        await cards.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(headerOf(0))}) !== null`,
          { timeoutMs: 15_000 },
        );

        const opened = await doors(0);

        // The switch: a click on the other workspace's header.
        await cards.nativeClickAtElement(headerOf(1));
        await app.waitForCondition<boolean>(
          `window.tugdeck.diag.getSpaces().activeSpaceId === "at0793-s1"`,
          { timeoutMs: 10_000 },
        );
        await cards.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(headerOf(1))}) !== null`,
          { timeoutMs: 15_000 },
        );
        const switched = await doors(1);

        note(`at0793 opened=${JSON.stringify(opened)} switched=${JSON.stringify(switched)}`);
        const works: DoorResult = { holds: true, shows: true, moves: true };
        const allWork = { blank: works, header: works, chord: works };
        expect(
          opened,
          "each door puts the keyboard in the Workspaces card the deck opened with, its cursor showing and moving",
        ).toEqual(allWork);
        expect(
          switched,
          "and in the same Workspaces card once a switch has reached the other workspace",
        ).toEqual(allWork);
      } finally {
        await app.close().catch(() => undefined);
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
