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
 *   B. Clicking marks 1 and 3 toggles them; a shift-click on 4 extends from
 *      3, so 1, 3 and 4 are marked.
 *   C. Copy acts at once: with Markdown chosen (a share starts as a PDF), a
 *      press on a selection not yet previewed shows the preview first, with a
 *      Copy button, and Return on it copies.
 *   D. Copy writes Markdown that carries `[secret]` where the key was and
 *      `~/` where the home was, holds neither the key nor the raw home, and
 *      holds nothing of the unmarked turn 2.
 *   E. Marking turn 2 moves the selection off the preview: Copy stays open,
 *      and the next press would preview again.
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
  COPY,
  COUNT,
  ENTRY_REGION,
  HOME,
  PROMPT_INPUT,
  SECRET,
  SHADE,
  UNMARKED_WORD,
  chooseFormat,
  clickMark,
  enabledJs,
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

        const marks = await card.evalJS<Mark[]>(marksJs());
        note(`at0819 marks: ${JSON.stringify(marks)}`);
        expect(marks.length, "one mark per turn").toBe(4);
        const [k1, k2, k3, k4] = marks.map((m) => m.key);

        // ── B. Click 1 and 3; shift-click 4 extends from 3 ─────────────────
        // Each click is answered before the next is made, so no two clicks
        // land close enough to read as one gesture.
        const countIs = (text: string) =>
          card.waitForCondition<boolean>(
            `(document.querySelector(${JSON.stringify(COUNT)})?.textContent || "") === ${JSON.stringify(text)}`,
            { timeoutMs: 4_000 },
          );
        await clickMark(app, k1);
        await countIs("1 turn");
        await clickMark(app, k3);
        await countIs("2 turns");
        await clickMark(app, k4, true);
        await countIs("3 turns");
        const checked = (await card.evalJS<Mark[]>(marksJs())).map((m) => m.checked);
        expect(checked, "1, 3 and 4 are marked").toEqual([true, false, true, true]);

        // ── C. Copy previews first, then copies on its own button ──────────
        expect(await card.evalJS<boolean>(enabledJs(COPY)), "Copy is open once a turn is marked").toBe(true);
        await chooseFormat(app, "markdown");
        setPasteboard(SENTINEL);
        await pressThroughPreview(app, COPY);

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

        // ── E. Marking turn 2 moves the selection off the preview ──────────
        await card.waitForCondition<boolean>(`window.__tug.shareState("A").canSend === true`, {
          timeoutMs: 4_000,
        });
        await clickMark(app, k2);
        await card.waitForCondition<boolean>(`window.__tug.shareState("A").canSend === false`, {
          timeoutMs: 4_000,
        });
        expect(await card.evalJS<boolean>(enabledJs(COPY)), "Copy stays open").toBe(true);

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
