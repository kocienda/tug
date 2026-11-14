/**
 * at0819-share-turns-markdown.test.ts — share mode on a Session card: pick
 * turns, preview them, and copy them as scrubbed Markdown.
 *
 * ## What this gates
 *
 * The pure pieces — the selection edits, the slice, the walk, the gate's
 * comparison — have unit tests. What only the running app has is the whole
 * path: the door entering the mode, the marks drawn in the real transcript,
 * the native shift-click reaching the gesture record, the scrub round trip
 * through tugcast, the host's preview sheet, and the pasteboard.
 *
 *   A. File ▸ Share Turns… enters share mode: the Share shade rises from the
 *      bottom of the transcript and rests on the Z2 status bar, and the
 *      composer stays where it is, with the draft typed into it still there.
 *      Tools' choices share the left edge of the title and the description;
 *      Mark All and Clear All sit on the title's row, flush right, and hold
 *      still as the count changes; Format sits on Tools' line; and Action sits on the buttons'
 *      row, at its left, under the Tools label. Narrowed until the line does
 *      not fit, the form stacks Format under Tools with the two choices on
 *      one left edge, and widened again it is one line.
 *   B. Every entry carries its turn's check — the prompt and the answer of
 *      each of the four turns, and a shell exchange seeded after them.
 *      Clicking marks 1 and 3 toggles them (both of a turn's checks follow);
 *      a shift-click on 4 extends from 3; a click marks the shell turn — so
 *      1, 3, 4 and the shell are marked. Each check sits at the right of its
 *      entry's header, after the address, and the participant icon still
 *      draws in its seat.
 *   C. The shade has one action button, which wears what the Action menu
 *      names. With Markdown chosen (a share starts as a PDF) and Copy chosen
 *      in the menu, a press on a selection not yet previewed shows the
 *      preview first, with a Copy button, and Return on it copies.
 *   D. Copy writes Markdown that carries `[secret]` where the key was and
 *      `~/` where the home was — in the shell's output too — holds neither
 *      the key nor the raw home, holds the shell exchange as a fenced block,
 *      and holds nothing of the unmarked turn 2.
 *   E. Marking turn 2 moves the selection off the preview: the action button
 *      stays open, and the next press would preview again.
 *   E2. Mark All marks all five turns; Clear unmarks them, leaving the mode on.
 *   F. Escape leaves share mode, and the composer's draft is intact.
 *
 * @covers tugdeck/src/components/tugways/cards/session-card.tsx
 * @covers tugdeck/src/components/tugways/cards/session-share-view.tsx
 * @covers tugdeck/src/components/tugways/tug-sheet.tsx
 * @covers tugdeck/src/components/tugways/cards/share-turn-mark.tsx
 * @covers tugdeck/src/lib/share-turns-store.ts
 * @covers tugdeck/src/lib/share-actions.ts
 * @covers tugdeck/src/lib/share-turns.ts
 * @covers tugdeck/src/lib/share-scrub.ts
 * @covers tugdeck/src/lib/os-share.ts
 * @covers tugapp/Sources/SharePreviewSheet.swift
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor/control/share.rs
 */

import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

import { launchTugApp, note } from "./_harness";
import {
  ACTION_TRIGGER,
  CLEAR,
  COUNT,
  ENTRY_REGION,
  GO,
  HOME,
  MARK,
  MARK_ALL,
  PROMPT_INPUT,
  SECRET,
  SHADE,
  UNMARKED_WORD,
  chooseFormat,
  clickMark,
  enabledJs,
  markRowsJs,
  marksJs,
  openSeededCard,
  pressThroughPreview,
  readPasteboard,
  setPasteboard,
} from "./share-probes";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SID = "at0819-session";
const DRAFT = "unsent words";
const SENTINEL = "at0819-sentinel";
/** The seeded shell exchange: its command, and output naming a home path. */
const SHELL_COMMAND = "ls at0819-demo";
const SHELL_OUTPUT = `${HOME}/src/demo/notes.txt\n`;
const SHELL_ROW = '[data-card-id="A"] [data-slot="session-transcript-shell-row"]';

interface Mark {
  key: string;
  checked: boolean;
}

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!SHOULD_RUN)("AT0819: share turns as Markdown", () => {
  test(
    "mark, preview and copy scrubbed Markdown; Escape leaves with the draft intact",
    async () => {
      const app = await launchTugApp({ testName: "at0819-share-turns-markdown" });
      let projectDir = "";
      try {
        projectDir = await openSeededCard(app, SID);
        const card = app.body("A");
        // A shell exchange after the four turns: ink, and shareable too.
        await app.driveSession("A", {
          op: "shellExchange",
          exchangeId: "at0819-x1",
          command: SHELL_COMMAND,
          output: SHELL_OUTPUT,
          cwd: projectDir,
          exitCode: 0,
        });
        await card.waitForCondition<boolean>(`!!document.querySelector(${JSON.stringify(SHELL_ROW)})`, {
          timeoutMs: 6_000,
        });

        // A draft in the composer, which share mode must not lose.
        await card.nativeClickAtElement(PROMPT_INPUT);
        await app.nativeType(DRAFT);
        // The keystrokes land after `nativeType` returns: wait for the last.
        await card.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(PROMPT_INPUT)})?.textContent || "").endsWith(${JSON.stringify(DRAFT.slice(-3))})`,
          { timeoutMs: 4_000 },
        );
        // What the composer holds going in is what it must hold coming out.
        const draftBefore = await card.evalJS<string>(
          `(document.querySelector(${JSON.stringify(PROMPT_INPUT)})?.textContent || "")`,
        );
        expect(draftBefore.length, "the composer holds a draft").toBeGreaterThan(0);

        // ── A. File ▸ Share Turns… enters the mode ─────────────────────────
        await app.performMenuItem("file.shareTurns");
        await card.waitForCondition<boolean>(`!!document.querySelector(${JSON.stringify(SHADE)})`, {
          timeoutMs: 6_000,
        });
        expect(
          await card.evalJS<string>(
            `getComputedStyle(document.querySelector(${JSON.stringify(ENTRY_REGION)})).display`,
          ),
          "the composer stays",
        ).not.toBe("none");
        // The shade rests on Z2: its panel's bottom edge meets the status
        // bar's top, once its rise has landed.
        const restJs = `(function(){
          var panel = document.querySelector(${JSON.stringify(SHADE)}).closest(".tug-sheet-shade");
          var z2 = document.querySelector('[data-card-id="A"] [data-slot="session-card-status-bar"]');
          if (panel === null || z2 === null) return null;
          return Math.abs(panel.getBoundingClientRect().bottom - z2.getBoundingClientRect().top);
        })()`;
        await card.waitForCondition<boolean>(`(${restJs}) !== null && (${restJs}) <= 2`, { timeoutMs: 4_000 });
        // Tools' choices share a left edge with the title, the description
        // and the Mark All row above them; Format sits on Tools' line; Action
        // sits on the buttons' row, at its left, under the Tools label. With
        // nothing marked the action button has nothing to act on.
        const layoutJs = `(function(){
          function r(s) { return document.querySelector(s).getBoundingClientRect(); }
          var lefts = [
            '[data-card-id="A"] [data-slot="session-share-view"] .tug-sheet-title',
            '[data-card-id="A"] [data-testid="session-share-instruction"]',
            '[data-card-id="A"] [data-testid="session-share-tool-mode"]',
          ].map(function (s) { return Math.round(r(s).left); });
          var tools = r('[data-card-id="A"] [data-testid="session-share-tool-mode"]');
          var format = r('[data-card-id="A"] [data-testid="session-share-format"]');
          var action = r(${JSON.stringify(ACTION_TRIGGER)});
          var go = r(${JSON.stringify(GO)});
          return {
            lefts: lefts,
            layout: document.querySelector('[data-card-id="A"] [data-testid="session-share-form"]').getAttribute("data-layout"),
            toolsMid: Math.round(tools.top + tools.height / 2),
            formatMid: Math.round(format.top + format.height / 2),
            toolsLeft: Math.round(tools.left),
            formatLeft: Math.round(format.left),
            toolsLabelLeft: Math.round(document.querySelector('[data-card-id="A"] [data-testid="session-share-form"]').getBoundingClientRect().left),
            actionMid: Math.round(action.top + action.height / 2),
            actionLeft: Math.round(action.left),
            actionLabelLeft: Math.round(r('[data-card-id="A"] .session-share-view__actions .session-share-view__label').left),
            goMid: Math.round(go.top + go.height / 2),
            goLeft: Math.round(go.left),
            markAllLeft: Math.round(r('[data-card-id="A"] [data-testid="session-share-mark-all"]').left),
            clearRight: Math.round(r('[data-card-id="A"] [data-testid="session-share-clear"]').right),
            goRight: Math.round(go.right),
            marksMidY: (function () {
              var a = r('[data-card-id="A"] [data-testid="session-share-mark-all"]');
              return Math.round(a.top + a.height / 2);
            })(),
            titleMidY: (function () {
              var t = r('[data-card-id="A"] [data-slot="session-share-view"] .tug-sheet-title');
              return Math.round(t.top + t.height / 2);
            })(),
          };
        })()`;
        type Layout = {
          lefts: number[]; layout: string; toolsMid: number; formatMid: number; toolsLeft: number; formatLeft: number;
          toolsLabelLeft: number; actionMid: number; actionLeft: number; actionLabelLeft: number; goMid: number; goLeft: number;
          markAllLeft: number; clearRight: number; goRight: number; marksMidY: number; titleMidY: number;
        };
        const layout = await card.evalJS<Layout>(layoutJs);
        note(`at0819 layout: ${JSON.stringify(layout)}`);
        expect(
          Math.max(...layout.lefts) - Math.min(...layout.lefts),
          `the header's text and Tools share a left edge: ${JSON.stringify(layout.lefts)}`,
        ).toBeLessThanOrEqual(1);
        expect(Math.abs(layout.toolsMid - layout.formatMid), "Format sits on Tools' line").toBeLessThanOrEqual(2);
        expect(layout.layout, "the form is one line where it fits").toBe("line");
        expect(Math.abs(layout.actionMid - layout.goMid), "Action sits on the buttons' row").toBeLessThanOrEqual(2);
        expect(layout.actionLeft, "Action is at the row's left, before the buttons").toBeLessThan(layout.goLeft);
        expect(Math.abs(layout.actionLabelLeft - layout.toolsLabelLeft), "the Action label is under the Tools label").toBeLessThanOrEqual(1);
        expect(Math.abs(layout.marksMidY - layout.titleMidY), "Mark All sits on the title's row").toBeLessThanOrEqual(2);
        expect(Math.abs(layout.clearRight - layout.goRight), "Clear All is flush with the action button's right edge").toBeLessThanOrEqual(1);
        // Narrowed until the line does not fit, Format stacks under Tools on
        // Tools' left edge; widened again, it is one line.
        const VIEW = '[data-card-id="A"] [data-slot="session-share-view"]';
        await card.evalJS<null>(`(document.querySelector(${JSON.stringify(VIEW)}).style.width = "480px", null)`);
        await card.waitForCondition<boolean>(
          `document.querySelector('[data-card-id="A"] [data-testid="session-share-form"]').getAttribute("data-layout") === "stack"`,
          { timeoutMs: 4_000 },
        );
        const stacked = await card.evalJS<Layout>(layoutJs);
        note(`at0819 stacked layout: ${JSON.stringify(stacked)}`);
        expect(stacked.formatMid, "stacked, Format is under Tools").toBeGreaterThan(stacked.toolsMid + 4);
        expect(Math.abs(stacked.formatLeft - stacked.toolsLeft), "stacked, the choices share a left edge").toBeLessThanOrEqual(1);
        await card.evalJS<null>(`(document.querySelector(${JSON.stringify(VIEW)}).style.width = "", null)`);
        await card.waitForCondition<boolean>(
          `document.querySelector('[data-card-id="A"] [data-testid="session-share-form"]').getAttribute("data-layout") === "line"`,
          { timeoutMs: 4_000 },
        );
        expect(await card.evalJS<boolean>(enabledJs(GO)), "nothing marked, nothing to do").toBe(false);
        expect(
          await card.evalJS<string>(`document.querySelector(${JSON.stringify(GO)}).textContent || ""`),
          "the action button wears the menu's choice",
        ).toBe("Preview…");

        const marks = await card.evalJS<Mark[]>(marksJs());
        note(`at0819 marks: ${JSON.stringify(marks)}`);
        expect(marks.length, "every turn is markable, the shell's too").toBe(5);
        const [k1, k2, k3, k4, k5] = marks.map((m) => m.key);
        const rows = await card.evalJS<Record<string, number>>(markRowsJs());
        note(`at0819 marks by entry: ${JSON.stringify(rows)}`);
        expect(rows, "every entry carries its turn's check").toEqual({ user: 4, assistant: 4, shell: 1, other: 0 });

        // ── B. Click 1 and 3; shift-click 4 extends from 3 ─────────────────
        // Each click is answered before the next is made, so no two clicks
        // land close enough to read as one gesture.
        const countIs = (text: string) =>
          card.waitForCondition<boolean>(
            `(document.querySelector(${JSON.stringify(COUNT)})?.textContent || "") === ${JSON.stringify(text)}`,
            { timeoutMs: 4_000 },
          );
        await clickMark(app, k1);
        await countIs("1 turn selected");
        await clickMark(app, k3);
        await countIs("2 turns selected");
        await clickMark(app, k4, true);
        await countIs("3 turns selected");
        await clickMark(app, k5);
        await countIs("4 turns selected");
        expect(
          (await card.evalJS<Layout>(layoutJs)).markAllLeft,
          "the Mark All row holds still as the count changes",
        ).toBe(layout.markAllLeft);
        const checked = (await card.evalJS<Mark[]>(marksJs())).map((m) => m.checked);
        expect(checked, "1, 3, 4 and the shell are marked, every entry's check").toEqual([true, false, true, true, true]);
        const seat = await card.evalJS<{ icons: number; marks: number; rightOfAddress: boolean }>(`(function(){
          var marks = Array.from(document.querySelectorAll(${JSON.stringify(MARK)}));
          var right = marks.every(function (m) {
            var pin = m.closest(".tug-transcript-entry__pin");
            var seq = pin && pin.querySelector(".tug-transcript-entry__sequence");
            return seq !== null && m.getBoundingClientRect().left >= seq.getBoundingClientRect().right;
          });
          var icons = marks.filter(function (m) {
            var pin = m.closest(".tug-transcript-entry__pin");
            return pin !== null && pin.querySelector(".tug-transcript-entry__icon svg") !== null;
          }).length;
          return { icons: icons, marks: marks.length, rightOfAddress: right };
        })()`);
        note(`at0819 mark seat: ${JSON.stringify(seat)}`);
        expect(seat.icons, "every marked row keeps its participant icon").toBe(seat.marks);
        expect(seat.rightOfAddress, "each check sits right of its turn address").toBe(true);

        // ── C. Copy previews first, then copies on its own button ──────────
        expect(await card.evalJS<boolean>(enabledJs(GO)), "the action button is open once a turn is marked").toBe(true);
        // It is the shade's default button, and wears the default ring.
        await card.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(GO)}).hasAttribute("data-default-ring")`,
          { timeoutMs: 4_000 },
        );
        await chooseFormat(app, "markdown");
        setPasteboard(SENTINEL);
        await pressThroughPreview(app, "copy");
        expect(
          await card.evalJS<string>(`document.querySelector(${JSON.stringify(GO)}).textContent || ""`),
          "the action button wears Copy",
        ).toBe("Copy");

        // ── D. Copy writes the scrubbed Markdown ───────────────────────────
        const deadline = Date.now() + 5_000;
        let copied = readPasteboard();
        while (copied === SENTINEL && Date.now() < deadline) {
          await settle(50);
          copied = readPasteboard();
        }
        note(`at0819 copied:\n${copied}`);
        expect(copied, "something was copied").not.toBe(SENTINEL);
        expect(copied, "the key is scrubbed").toContain("[secret]");
        expect(copied, "the home is shortened").toContain("~/src/demo/config.ts");
        expect(copied, "the key never leaves").not.toContain(SECRET);
        expect(copied, "the raw home never leaves").not.toContain(HOME);
        expect(copied, "the unmarked turn stays out").not.toContain(UNMARKED_WORD);
        expect(copied, "the shell exchange is a fenced block").toContain(`## Shell\n\n\`\`\`\n$ ${SHELL_COMMAND}\n`);
        expect(copied, "the shell's home is shortened").toContain("~/src/demo/notes.txt");

        // ── E. Marking turn 2 moves the selection off the preview ──────────
        await card.waitForCondition<boolean>(`window.__tug.shareState("A").canSend === true`, {
          timeoutMs: 4_000,
        });
        await clickMark(app, k2);
        await card.waitForCondition<boolean>(`window.__tug.shareState("A").canSend === false`, {
          timeoutMs: 4_000,
        });
        expect(await card.evalJS<boolean>(enabledJs(GO)), "the action button stays open").toBe(true);

        // ── E2. Mark All, then Clear ───────────────────────────────────────
        await card.nativeClickAtElement(MARK_ALL);
        await countIs("5 turns selected");
        expect((await card.evalJS<Mark[]>(marksJs())).every((m) => m.checked), "every turn is marked").toBe(true);
        await card.nativeClickAtElement(CLEAR);
        await countIs("No turns selected");
        expect((await card.evalJS<Mark[]>(marksJs())).some((m) => m.checked), "no turn is marked").toBe(false);
        expect(await card.evalJS<boolean>(`!!document.querySelector(${JSON.stringify(SHADE)})`), "the mode stays on").toBe(true);

        // ── F. Escape leaves, and the draft is there ───────────────────────
        await app.nativeKey("Escape");
        await card.waitForCondition<boolean>(`!document.querySelector(${JSON.stringify(SHADE)})`, {
          timeoutMs: 4_000,
        });
        const draft = await card.evalJS<string>(
          `(document.querySelector(${JSON.stringify(PROMPT_INPUT)})?.textContent || "")`,
        );
        expect(draft, "the composer's draft survives share mode").toBe(draftBefore);
      } finally {
        await app.close();
        if (projectDir !== "") rmSync(projectDir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
