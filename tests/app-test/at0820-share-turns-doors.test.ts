/**
 * at0820-share-turns-doors.test.ts — the ways into share mode, and its
 * exclusion with the card's other bottom-of-card modes.
 *
 * ## What this gates
 *
 *   A. The cell menu's Share from Here… on turn 3 enters share mode with
 *      turns 3 and 4 marked — that turn and every later one.
 *   B. Changes from share mode leaves share mode: the landing needs the
 *      transcript, which the Changes shade makes inert while share mode's
 *      marks are clicked there.
 *   C. File ▸ Share Turns… from Changes leaves Changes and enters share mode
 *      with nothing marked.
 *   D. `/share` typed in the composer enters share mode.
 *   E. The masthead's Share Turns button, second from the left after Rename,
 *      enters share mode.
 *
 * The marks, the gate and the copy are at0819's.
 *
 * @covers tugdeck/src/components/tugways/cards/session-card.tsx
 * @covers tugdeck/src/components/tugways/cards/session-share-view.tsx
 * @covers tugdeck/src/components/tugways/session-masthead.tsx
 * @covers tugdeck/src/components/tugways/cards/share-turn-mark.tsx
 * @covers tugdeck/src/components/tugways/cards/transcript-host-helpers.ts
 * @covers tugdeck/src/lib/share-turns-store.ts
 * @covers tugdeck/src/lib/share-turns.ts
 * @covers tugdeck/src/lib/slash-commands.ts
 * @covers tugdeck/src/components/tugways/command-registry.ts
 * @covers tugapp/Sources/MenuBarBuilder.swift
 */

import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

import { launchTugApp, note } from "./_harness";
import {
  CELL_MENU,
  COMMIT_BUTTON,
  COUNT,
  PROMPT_INPUT,
  SHADE,
  USER_ROWS,
  marksJs,
  openSeededCard,
} from "./share-probes";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SID = "at0820-session";
const SHARE_FROM_HERE = `${CELL_MENU} [data-item-action="share-from-turn"]`;

interface Mark {
  key: string;
  checked: boolean;
}

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));
const barShown = `!!document.querySelector(${JSON.stringify(SHADE)})`;

describe.skipIf(!SHOULD_RUN)("AT0820: the doors into share mode", () => {
  test(
    "Share from Here, the File menu, /share and the masthead enter it; Changes and share mode exclude each other",
    async () => {
      const app = await launchTugApp({ testName: "at0820-share-turns-doors" });
      let projectDir = "";
      try {
        projectDir = await openSeededCard(app, SID);
        const card = app.body("A");

        // ── A. Share from Here… on turn 3 ──────────────────────────────────
        // The menu is opened at the row with a `contextmenu` event, as at0376
        // opens a chip's: the row is brought into view first, since the list
        // rests at its bottom.
        await card.evalJS<null>(`(function(){
          var row = document.querySelectorAll(${JSON.stringify(USER_ROWS)})[2];
          row.scrollIntoView({ block: "center" });
          var r = row.getBoundingClientRect();
          row.dispatchEvent(new MouseEvent("contextmenu", {
            bubbles: true,
            clientX: Math.round(r.left + r.width / 2),
            clientY: Math.round(r.top + r.height / 2),
          }));
          return null;
        })()`);
        await card.waitForCondition<boolean>(`!!document.querySelector(${JSON.stringify(SHARE_FROM_HERE)})`, {
          timeoutMs: 6_000,
        });
        await card.nativeClickAtElement(SHARE_FROM_HERE);
        await card.waitForCondition<boolean>(barShown, { timeoutMs: 6_000 });
        const marks = await card.evalJS<Mark[]>(marksJs());
        note(`at0820 marks after Share from Here: ${JSON.stringify(marks)}`);
        expect(marks.map((m) => m.checked), "turns 3 and 4 are marked").toEqual([false, false, true, true]);

        expect(
          await card.evalJS<boolean>(
            `document.querySelector('[data-card-id="A"] .session-view-slot[data-active-view="changes"]') !== null`,
          ),
          "Changes is closed before its door is used",
        ).toBe(false);
        // ── B. Changes leaves share mode ───────────────────────────────────
        const changes = await app.performMenuItem("session.toggleChanges");
        expect(changes.found && changes.performed, "Show Session Changes performs").toBe(true);
        await card.waitForCondition<boolean>(
          `document.querySelector('[data-card-id="A"] .session-view-slot[data-active-view="changes"]') !== null`,
          { timeoutMs: 4_000 },
        );
        await card.waitForCondition<boolean>(`!(${barShown})`, { timeoutMs: 2_000 });
        await card.waitForCondition<boolean>(`!!document.querySelector(${JSON.stringify(COMMIT_BUTTON)})`, {
          timeoutMs: 6_000,
        });

        // ── C. File ▸ Share Turns… leaves Changes ───────────────────────────
        const share = await app.performMenuItem("file.shareTurns");
        expect(share.found && share.performed, "File ▸ Share Turns… performs").toBe(true);
        await card.waitForCondition<boolean>(barShown, { timeoutMs: 6_000 });
        await card.waitForCondition<boolean>(`!document.querySelector(${JSON.stringify(COMMIT_BUTTON)})`, {
          timeoutMs: 6_000,
        });
        expect(
          await card.evalJS<string>(`(document.querySelector(${JSON.stringify(COUNT)})?.textContent || "")`),
          "the menu door marks nothing",
        ).toBe("No turns marked");

        // ── D. /share typed in the composer ────────────────────────────────
        // Done leaves the mode (Escape is at0819's), and the composer is back.
        await card.nativeClickAtElement(`${SHADE} [data-testid="session-share-done"]`);
        await card.waitForCondition<boolean>(
          `!document.querySelector('[data-card-id="A"] [data-share-mode]')`,
          { timeoutMs: 4_000 },
        );
        await card.nativeClickAtElement(PROMPT_INPUT);
        await app.nativeType("/share");
        await settle();
        await app.nativeKey("Escape"); // dismiss the completion popup
        await settle();
        await app.nativeKey("Return", ["cmd"]);
        await card.waitForCondition<boolean>(barShown, { timeoutMs: 6_000 });

        // ── E. The masthead's Share Turns button ───────────────────────────
        // Second in the card's own run, right after Rename.
        await card.nativeClickAtElement(`${SHADE} [data-testid="session-share-done"]`);
        await card.waitForCondition<boolean>(`!(${barShown})`, { timeoutMs: 4_000 });
        await card.revealPaneControls(".body-chrome-frame");
        // The card's own buttons, in document order, which is the row's.
        const order = await card.evalJS<string[]>(`Array.from(document.querySelectorAll(${JSON.stringify(
          [
            "session-masthead-rename",
            "session-masthead-share",
            "session-masthead-widget",
            "session-masthead-add-dir",
            "session-masthead-reveal",
          ]
            .map((slot) => `[data-slot="${slot}"]`)
            .join(", "),
        )})).map(function (el) { return el.getAttribute("data-slot"); })`);
        note(`at0820 masthead order: ${JSON.stringify(order)}`);
        expect(order.slice(0, 2), "Rename leads, Share Turns follows").toEqual([
          "session-masthead-rename",
          "session-masthead-share",
        ]);
        await card.nativeClickAtElement('[data-slot="session-masthead-share"]');
        await card.waitForCondition<boolean>(barShown, { timeoutMs: 6_000 });
      } finally {
        await app.close();
        if (projectDir !== "") rmSync(projectDir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
