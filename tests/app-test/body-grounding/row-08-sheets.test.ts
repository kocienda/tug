/**
 * row-08-sheets.test.ts — the Changes shade, the History shade and the
 * find bar, from a body.
 *
 * The bar's eighth row ([B02] row 8). A body session card bound to this
 * checkout, with more dirty files in it than the shade's auto-size holds,
 * stands in a pane. Through the session tap ([B04]) ⌃⌘C raises the Changes
 * shade over the transcript: it stands inside the body's document, lists
 * the dirty files, covers Z2 as the shell's does, scrolls as a list, and
 * ⌃⌘C again drops it. ⌃⌘H raises the History shade: it lists the
 * checkout's commits, seeds its key view on Done, scrolls, and ⌃⌘H drops
 * it. ⌘F opens the find bar, typing lands in its field, and Escape closes
 * it. Under every one the body still holds the keyboard and its composer
 * still takes a character ([F18]: the first keystroke used to close the
 * shade).
 *
 * Every assertion is the body page's own DOM — the shade, its list, its
 * scroll, what a hit at Z2's centre lands on — and the host's word on
 * first responder. The reading behind the row is [F20]: a body attached
 * none of the connection-scoped stores the shell boots, so its shade
 * waited on a project scan forever.
 *
 * @covers tugdeck/src/body/body-main.ts
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-view.tsx
 * @covers tugdeck/src/components/tugways/cards/session-history/session-history-view.tsx
 * @covers tugdeck/src/lib/card-fold.ts
 */

import { describe, expect, test } from "bun:test";
import { existsSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { launchTugApp, note, type App } from "../_harness";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "../streaming-stub-fixture";
import {
  PROMPT_INPUT,
  SETTLE_MS,
  bodyOf,
  composerFocused,
  composerText,
  focusBody,
  settleFor,
  spawnStub,
  waitForBody,
} from "./_bodies";

const TEST_NAME = "body-grounding-row-08-sheets";
const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

const A = "row08-a";
/** The checkout, which is the one project tugcast composes changes for. */
const PROJECT_DIR = realpathSync(resolve(import.meta.dir, "..", "..", ".."));
/** More dirty files than the shade's auto-size holds, so its list has to scroll. */
const SCRATCH_COUNT = 24;
const scratchFile = (i: number): string => join(PROJECT_DIR, `row08-scratch-${String(i).padStart(2, "0")}.txt`);

const CHANGES_SHEET = '.session-view-pane[data-view="changes"] [data-slot="tug-sheet"]';
const CHANGES_FILE = `[data-testid="tug-changes-list-file-block"][data-path="row08-scratch-00.txt"]`;
const HISTORY_VIEW = '[data-slot="session-history-view"]';
const HISTORY_ROWS = `${HISTORY_VIEW} [data-slot="tug-commit-atom"], ${HISTORY_VIEW} button, ${HISTORY_VIEW} li`;
const FIND_BAR = '[data-slot="session-card-find-bar"]';
const FIND_INPUT = '[data-testid="session-card-find-input"] .cm-content';
const Z2 = ".session-card-status-bar";

const present = (sel: string): string => `document.querySelector(${JSON.stringify(sel)}) !== null`;
const rectOf = (sel: string): string => `(function () { var e = document.querySelector(${JSON.stringify(sel)}); if (e === null) return null; var r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`;
/** The nearest scrolling ancestor of `sel` (itself included), scrolled by `px`: its scrollTop after, or null when nothing scrolls. */
const scrollBy = (sel: string, px: number): string => `(function () {
  var e = document.querySelector(${JSON.stringify(sel)});
  while (e !== null) {
    var cs = getComputedStyle(e);
    if ((cs.overflowY === "auto" || cs.overflowY === "scroll") && e.scrollHeight > e.clientHeight + 1) { e.scrollTop += ${px}; return e.scrollTop; }
    e = e.parentElement;
  }
  return null;
})()`;
/** What a hit at Z2's centre lands on, by slot, or null without a Z2. */
const hitAtZ2 = `(function () {
  var s = document.querySelector(${JSON.stringify(Z2)}); if (s === null) return null;
  var r = s.getBoundingClientRect(); var h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  if (h === null) return null; var slotted = h.closest("[data-slot]"); return slotted === null ? h.className : slotted.getAttribute("data-slot");
})()`;

function deck(): Record<string, unknown> {
  return {
    cards: [{ id: A, componentId: "session", title: "A", closable: true }],
    panes: [
      {
        id: `${A}-pane`,
        position: { x: 40, y: 40 },
        size: { width: 900, height: 720 },
        cardIds: [A],
        activeCardId: A,
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: `${A}-pane`,
    hasFocus: true,
  };
}

/** The body holds the keyboard and one character typed lands in its composer. */
async function composerTakesAKey(app: App, cardId: string, ch: string, label: string): Promise<void> {
  const body = app.body(cardId);
  const holder = await settleFor(() => bodyOf(app, cardId), (b) => b?.firstResponder === true, SETTLE_MS);
  expect(holder?.firstResponder, `${label}: the body still holds the keyboard`).toBe(true);
  await body.nativeClickAtElement(PROMPT_INPUT);
  await body.waitForCondition<boolean>(composerFocused, { timeoutMs: SETTLE_MS });
  await app.nativeType(ch);
  const text = await settleFor(() => body.evalJS<string | null>(composerText), (t) => t?.includes(ch) === true, SETTLE_MS);
  expect(text, `${label}: the character landed in the composer`).toContain(ch);
}

describe.skipIf(!SHOULD_RUN)("body-grounding row 8: the Changes shade, History and the find bar from a body", () => {
  test(
    "each opens, lists, scrolls and closes inside the body, and the keyboard stays with it",
    async () => {
      const stubDir = stubDirectory();
      for (let i = 0; i < SCRATCH_COUNT; i++) writeFileSync(scratchFile(i), `row 8 scratch ${i}\n`);
      const app = await launchTugApp({
        testName: TEST_NAME,
        env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
      });
      try {
        await app.seedDeckState({ state: deck(), focusCardId: A });
        await spawnStub(app, A, stubDir, 2, 1, PROJECT_DIR);
        await waitForBody(app, A);
        const a = app.body(A);
        await focusBody(app, A);

        // ---- The Changes shade ----
        await app.nativeKey("c", ["ctrl", "cmd"]);
        await a.waitForCondition<boolean>(present(CHANGES_SHEET), { timeoutMs: 12_000 });
        const listed = await settleFor(() => a.evalJS<boolean>(present(CHANGES_FILE)), (v) => v, 20_000);
        await Bun.sleep(400); // the shade's own rise
        const files = await a.evalJS<string[]>(`Array.from(document.querySelectorAll('[data-testid="tug-changes-list-file-block"]')).map(function (e) { return e.getAttribute("data-path"); })`);
        note(`changes: sheet ${JSON.stringify(await a.evalJS(rectOf(CHANGES_SHEET)))} in ${await a.evalJS<string>("window.innerWidth + 'x' + window.innerHeight")}; ${files.length} files; scanning ${await a.evalJS<boolean>(present('[data-testid="session-changes-scanning"]'))}; hit at Z2 ${await a.evalJS<string | null>(hitAtZ2)}`);
        expect(listed, "the shade lists the dirty files").toBe(true);
        expect(files.length, "every scratch file is listed").toBeGreaterThanOrEqual(SCRATCH_COUNT);
        expect(await a.evalJS<string | null>(hitAtZ2), "the shade stands over Z2, as the shell's does").toBe("tug-list-row");
        const changesScrolled = await a.evalJS<number | null>(scrollBy(CHANGES_FILE, 120));
        expect(changesScrolled, "the list scrolled").toBeGreaterThan(0);
        await composerTakesAKey(app, A, "q", "with the Changes shade up");
        expect(await a.evalJS<boolean>(present(CHANGES_SHEET)), "the keystroke did not close the shade").toBe(true);
        await app.nativeKey("c", ["ctrl", "cmd"]);
        await a.waitForCondition<boolean>(`!(${present(CHANGES_SHEET)})`, { timeoutMs: 8_000 });

        // ---- The History shade ----
        await app.nativeKey("h", ["ctrl", "cmd"]);
        await a.waitForCondition<boolean>(present(HISTORY_VIEW), { timeoutMs: 12_000 });
        const rows = await settleFor(() => a.evalJS<number>(`document.querySelectorAll(${JSON.stringify(HISTORY_ROWS)}).length`), (n) => n > 3, 20_000);
        note(`history: view ${JSON.stringify(await a.evalJS(rectOf(HISTORY_VIEW)))}; rows ${rows}; key view ${await a.evalJS<string | null>(`document.querySelector("[data-key-view-kbd]")?.getAttribute("data-testid") ?? null`)}`);
        expect(rows, "the history lists commits").toBeGreaterThan(3);
        expect(await a.evalJS<string | null>(`document.querySelector("[data-key-view-kbd]")?.getAttribute("data-testid") ?? null`), "the shade seeds its key view on Done").toBe("session-history-done");
        const historyScrolled = await a.evalJS<number | null>(scrollBy(HISTORY_VIEW, 120));
        expect(historyScrolled, "the history scrolled").toBeGreaterThan(0);
        await composerTakesAKey(app, A, "r", "with History up");
        expect(await a.evalJS<boolean>(present(HISTORY_VIEW)), "the keystroke did not close History").toBe(true);
        await app.nativeKey("h", ["ctrl", "cmd"]);
        await a.waitForCondition<boolean>(`!(${present(HISTORY_VIEW)})`, { timeoutMs: 8_000 });

        // ---- The find bar ----
        await app.nativeKey("f", ["cmd"]);
        await a.waitForCondition<boolean>(present(FIND_BAR), { timeoutMs: 8_000 });
        await a.waitForCondition<boolean>(`document.activeElement !== null && document.activeElement.closest(${JSON.stringify(FIND_INPUT)}) !== null`, { timeoutMs: SETTLE_MS });
        await app.nativeType("hello");
        const findText = await settleFor(
          () => a.evalJS<string>(`(function () { var l = document.querySelector(${JSON.stringify(`${FIND_INPUT} .cm-line`)}); if (!l) return ""; var t = ""; l.childNodes.forEach(function (n) { if (!(n.nodeType === 1 && n.classList.contains("cm-placeholder"))) t += n.textContent; }); return t; })()`),
          (t) => t.includes("hello"),
          SETTLE_MS,
        );
        note(`find: bar ${JSON.stringify(await a.evalJS(rectOf(FIND_BAR)))}; text ${JSON.stringify(findText)}`);
        expect(findText, "typing lands in the find field").toContain("hello");
        await app.nativeKey("Escape", []);
        await a.waitForCondition<boolean>(`!(${present(FIND_BAR)})`, { timeoutMs: 8_000 });
        await composerTakesAKey(app, A, "s", "after the find bar closed");
      } finally {
        await app.close();
        for (let i = 0; i < SCRATCH_COUNT; i++) if (existsSync(scratchFile(i))) rmSync(scratchFile(i), { force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
