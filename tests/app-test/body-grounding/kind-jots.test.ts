/**
 * kind-jots.test.ts — the Jots card is a body, and everything it is for works
 * in its body.
 *
 * The Jots rail pinned to the deck's edge, over a jots file on disk
 * (`TUG_JOTS_PATH`), the production source of its data:
 *
 * - **It mounts as a body** holding the Jots card, and the shell's document
 *   holds no jot list.
 * - **Its data** — the file's jots are the body's rows.
 * - **Its own interactions** — a row's menu opens inside the body; a click
 *   and Return open a jot's editor there, typing lands in it, and Escape
 *   commits the edit to the file; the add button makes a new jot, written to
 *   the file; and a vertical drag of the last row onto the first reorders the
 *   file, which is what a reload reads back.
 * - **Its surface** — the body paints the rail's sunken surface, read off the
 *   composite.
 *
 * @covers tugdeck/src/components/jots/jots-card-registration.tsx
 * @covers tugdeck/src/components/jots/jots-card.tsx
 * @covers tugdeck/src/components/tugways/tug-editor-context-menu.tsx
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note } from "../_harness";
import { pollFor, settleFor } from "./_bodies";
import { expectRailSurface, kindDeck, standUpKind } from "./_kind-bodies";
import { cardKind } from "./_kinds";

const TEST_NAME = "body-grounding-kind-jots";
const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;
const READ_MS = 5_000;

const JOTS = "kj-jots";
const SEEDED = [
  { id: "kj-1", text: "first seeded jot" },
  { id: "kj-2", text: "second seeded jot" },
];
const LABEL = ".jots-list .jot-row-label";
const rowLabel = (id: string): string => `.jots-list .jot-row-content[data-jot-id="${id}"] .jot-row-label`;
const EDITOR = ".jots-list .jot-editor";
const MENU = '[data-slot="tug-editor-context-menu"]';
const ADD = '[data-testid="jots-add-button"]';

const present = (selector: string): string => `document.querySelector(${JSON.stringify(selector)}) !== null`;
const labels = `Array.from(document.querySelectorAll(${JSON.stringify(LABEL)})).map(function (el) { return el.textContent || ""; })`;
const rectOf = (selector: string): string => `(function () {
  var r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
  return { x: r.left + Math.min(24, r.width / 2), y: r.top + r.height / 2 };
})()`;

interface JotsFile {
  jots: { id: string; text: string }[];
}

describe.skipIf(!SHOULD_RUN)("body-grounding kind check: Jots", () => {
  test(
    "the Jots card mounts as a body over its file, and its menus, editor, add and reorder work there and reach the file",
    async () => {
      const scratch = mkdtempSync(join(tmpdir(), "tug-kind-jots-"));
      const jotsPath = join(scratch, "jots.json");
      writeFileSync(jotsPath, `${JSON.stringify({ version: 1, jots: SEEDED }, null, 2)}\n`);
      const onDisk = (): JotsFile => JSON.parse(readFileSync(jotsPath, "utf8")) as JotsFile;
      const app = await launchTugApp({ testName: TEST_NAME, env: { TUG_JOTS_PATH: jotsPath } });
      try {
        await app.seedDeckState({ state: kindDeck(cardKind("jots"), JOTS), focusCardId: JOTS });
        const body = await standUpKind(app, cardKind("jots"), JOTS);
        // card-dom: shell
        expect(await app.evalJS<boolean>(present(".jots-list")), "the shell's document holds no jot list").toBe(false);

        // ── Its data: the file's jots are the body's rows ────────────────
        const rows = await settleFor(() => body.evalJS<string[]>(labels), (l) => l.length === SEEDED.length, READ_MS);
        expect(rows, "the body lists the file's jots").toEqual(SEEDED.map((j) => j.text));

        // ── A row's menu opens inside the body ──────────────────────────
        await body.nativeClickAtElement(rowLabel("kj-1"), { button: "right" });
        const menu = await settleFor(() => body.evalJS<boolean>(present(MENU)), (v) => v, READ_MS);
        expect(menu, "the row's menu opens in the Jots body").toBe(true);
        await app.nativeKey("Escape");
        await pollFor(() => body.evalJS<boolean>(present(MENU)), (v) => !v, READ_MS);

        // ── The editor: click, Return, type, Escape commits to the file ──
        await body.nativeClickAtElement(rowLabel("kj-1"));
        await app.nativeKey("Return");
        const editing = await settleFor(() => body.evalJS<boolean>(`document.activeElement !== null && document.activeElement.closest(${JSON.stringify(EDITOR)}) !== null`), (v) => v, READ_MS);
        expect(editing, "Return opens the jot's editor in the body, with the caret in it").toBe(true);
        await app.nativeType(" edited");
        await app.nativeKey("Escape");
        const edited = await settleFor(() => Promise.resolve(onDisk().jots.find((j) => j.id === "kj-1")?.text ?? ""), (t) => t.endsWith(" edited"), READ_MS);
        expect(edited, "the edit reached the file").toBe("first seeded jot edited");

        // ── Add: a new jot, written to the file ─────────────────────────
        await body.nativeClickAtElement(ADD);
        await pollFor(() => body.evalJS<boolean>(`document.activeElement !== null && document.activeElement.closest(${JSON.stringify(EDITOR)}) !== null`), (v) => v, READ_MS);
        await app.nativeType("added jot");
        await app.nativeKey("Escape");
        const added = await settleFor(() => Promise.resolve(onDisk().jots.map((j) => j.text)), (t) => t.includes("added jot"), READ_MS);
        expect(added, "the added jot reached the file").toContain("added jot");

        // ── Reorder: the last row dragged onto the first ────────────────
        const order = await settleFor(() => body.evalJS<string[]>(labels), (l) => l.length === 3, READ_MS);
        const last = order[order.length - 1];
        const ids = await body.evalJS<string[]>(`Array.from(document.querySelectorAll(".jots-list .jot-row-content[data-jot-id]")).map(function (el) { return el.getAttribute("data-jot-id"); })`);
        const from = await body.evalJS<{ x: number; y: number }>(rectOf(rowLabel(ids[ids.length - 1])));
        const to = await body.evalJS<{ x: number; y: number }>(rectOf(rowLabel(ids[0])));
        await body.nativeDrag(from, { x: from.x, y: to.y - 6 }, { mouseDownDelayMs: 150, mouseUpDelayMs: 200, interpolationSteps: 20, interpolationDelayMs: 20 });
        const reordered = await settleFor(() => Promise.resolve(onDisk().jots.map((j) => j.text)), (t) => t[0] === last, READ_MS);
        note(`jots: before ${JSON.stringify(order)}; on disk after the drag ${JSON.stringify(reordered)}`);
        expect(reordered[0], "the dragged jot is first in the file, which a reload reads back").toBe(last);

        // ── Surface ─────────────────────────────────────────────────────
        await expectRailSurface(app, JOTS);
      } finally {
        await app.close();
        rmSync(scratch, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
