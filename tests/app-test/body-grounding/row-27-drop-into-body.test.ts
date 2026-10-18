/**
 * row-27-drop-into-body.test.ts — a drag that arrives over a body is the
 * body's: a file from outside the window lands in its composer, and so does
 * a jot dragged from the Jots card's own body.
 *
 * AppKit picks a drag's destination without asking `hitTest`, so the shell's
 * web view, which covers the window, is sent every drag, even over a body a
 * click would pass through to. The shell's view now hands each dragging call
 * to the body beneath the pointer wherever the hit region passes through and
 * no `pointerClaim` covers it, and WebKit turns the forwarded call into the
 * body page's own `dragenter`/`dragover`/`drop`.
 *
 * One body Session card beside the Jots card, each in its own body:
 *
 * - **A file from outside the window.** A PNG dragged through a real
 *   `NSDraggingSession` from a source window beside the deck (the path a
 *   Finder drag takes) and dropped on the body's composer: the body's page
 *   sees the drag and the drop with `Files` on it, the shell's page sees no
 *   drop, an attachment tile lands in the body's composer, and the source is
 *   told the drop was taken as a copy.
 * - **A jot from the Jots body.** The Jots card's row dragged by a real mouse
 *   trail into the Session body's composer: WebKit's own drag, begun in the
 *   Jots card's page, carries the jot's private type across to the Session
 *   card's page, the shell's page takes no drop, and the jot's text lands in
 *   the Session body's composer.
 *
 * @foreground
 * @covers tugapp/Sources/MainWindow.swift
 * @covers tugapp/Sources/BodyGeometry.swift
 * @covers tugdeck/src/components/tugways/use-composer-drop.ts
 * @covers tugdeck/src/lib/jot-drag.ts
 * @covers tugdeck/src/components/jots/jots-card-registration.tsx
 * @covers tugdeck/src/lib/pointer-claim.ts
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note } from "../_harness";
import { nativeDrag, nativeFileDrag } from "../_harness/client";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "../streaming-stub-fixture";
import { PROMPT_INPUT, SETTLE_MS, bodyOf, composerText, pollFor, spawnStub, waitForBody } from "./_bodies";
import { kindDeck, standUpKind } from "./_kind-bodies";
import { cardKind } from "./_kinds";

const TEST_NAME = "body-grounding-row-27-drop-into-body";
const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

const A = "r27-a";
const JOTS = "r27-jots";
const JOT_ID = "r27-j0";
const JOT_TEXT = "row27 dragged jot";
const JOT_LABEL = `.jots-list .jot-row-content[data-jot-id="${JOT_ID}"] .jot-row-label`;
const ATTACHMENT_TILE = '[data-slot="tug-attachment-preview__tile"]';
/** A 2×2 PNG. */
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR4nGP4z8DwHwYZAB3xBP0u7gqmAAAAAElFTkSuQmCC";
/** NSDragOperation.copy. */
const DRAG_OPERATION_COPY = 1;

interface DragLog {
  enter: number;
  over: number;
  leave: number;
  drop: number;
  types: string[];
}

/** In a page: count the drag events the window sees, and the types the last one carried. */
const armDragLog = `(function () {
  var log = { enter: 0, over: 0, leave: 0, drop: 0, types: [] };
  window.__row27Drag = log;
  function count(key) {
    return function (e) {
      log[key] += 1;
      if (e.dataTransfer) log.types = Array.from(e.dataTransfer.types);
    };
  }
  window.addEventListener("dragenter", count("enter"), true);
  window.addEventListener("dragover", count("over"), true);
  window.addEventListener("dragleave", count("leave"), true);
  window.addEventListener("drop", count("drop"), true);
  return true;
})()`;
const readDragLog = "window.__row27Drag";
const tileCount = `document.querySelectorAll(${JSON.stringify(ATTACHMENT_TILE)}).length`;
const composerCenter = `(function () {
  var r = document.querySelector(${JSON.stringify(PROMPT_INPUT)}).getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`;
const labelRect = `(function () {
  var r = document.querySelector(${JSON.stringify(JOT_LABEL)}).getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
})()`;

describe.skipIf(!SHOULD_RUN)("body-grounding row 27: a drag over a body is the body's", () => {
  test(
    "a file dragged in from outside the window and a jot dragged from the shell both land in the body's composer",
    async () => {
      const stubDir = stubDirectory();
      const scratch = mkdtempSync(join(tmpdir(), "tug-row27-"));
      const pngPath = join(scratch, "row27.png");
      writeFileSync(pngPath, Buffer.from(PNG_BASE64, "base64"));
      const jotsPath = join(scratch, "jots.json");
      writeFileSync(jotsPath, `${JSON.stringify({ version: 1, jots: [{ id: JOT_ID, text: JOT_TEXT }] }, null, 2)}\n`);
      const app = await launchTugApp({
        testName: TEST_NAME,
        foreground: true,
        env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir, TUG_JOTS_PATH: jotsPath },
      });
      try {
        await app.seedDeckState({ state: kindDeck(cardKind("jots"), JOTS, { sessions: [A], focus: A }), focusCardId: A });
        await spawnStub(app, A, stubDir, 2, 1);
        await waitForBody(app, A);
        const jots = await standUpKind(app, cardKind("jots"), JOTS);
        await jots.waitForCondition<boolean>(`document.querySelector(${JSON.stringify(JOT_LABEL)}) !== null`, { timeoutMs: SETTLE_MS * 2 });
        const a = app.body(A);
        await a.evalJS<boolean>(armDragLog);
        await jots.evalJS<boolean>(armDragLog);
        await app.evalJS<boolean>(armDragLog);

        // ---- A file from outside the window, dropped on the body's composer ----
        const inBody = await a.evalJS<{ x: number; y: number }>(composerCenter);
        const fileDrag = await nativeFileDrag(a, pngPath, inBody, { interpolationSteps: 24, interpolationDelayMs: 25, dwellMs: 400 });
        const tiles = await pollFor(() => a.evalJS<number>(tileCount), (n) => n > 0, SETTLE_MS);
        const bodyLog = await a.evalJS<DragLog>(readDragLog);
        const shellLog = await app.evalJS<DragLog>(readDragLog);
        note(`file drag: session ${JSON.stringify(fileDrag)}; body page ${JSON.stringify(bodyLog)}; shell page ${JSON.stringify(shellLog)}; ${tiles} attachment tile(s)`);
        expect(fileDrag.began && fileDrag.ended, "the drag session began and ended").toBe(true);
        expect(bodyLog.enter, "the body's page saw the drag enter").toBeGreaterThan(0);
        expect(bodyLog.drop, "the body's page took the drop").toBe(1);
        expect(bodyLog.types, "the drag carried Files into the body").toContain("Files");
        expect(shellLog.drop, "the shell's page took no drop").toBe(0);
        expect(tiles, "the PNG lands as an attachment tile in the body's composer").toBeGreaterThan(0);
        expect(fileDrag.operation, "the source was told the drop was taken as a copy").toBe(DRAG_OPERATION_COPY);

        // ---- A jot from the Jots card's body into the Session body's composer ----
        const frame = (await bodyOf(app, A))?.frame;
        const jotsFrame = (await bodyOf(app, JOTS))?.frame;
        expect(frame, `${A}: the host reports the body's frame`).toBeDefined();
        expect(jotsFrame, `${JOTS}: the host reports the Jots body's frame`).toBeDefined();
        const label = await jots.evalJS<{ x: number; y: number; width: number; height: number }>(labelRect);
        const from = { x: jotsFrame!.x + label.x + Math.min(24, label.width / 2), y: jotsFrame!.y + label.y + label.height / 2 };
        const to = { x: frame!.x + inBody.x, y: frame!.y + inBody.y };
        const dropsBefore = (await a.evalJS<DragLog>(readDragLog)).drop;
        await nativeDrag(app, from, to, { mouseDownDelayMs: 150, mouseUpDelayMs: 300, interpolationSteps: 30, interpolationDelayMs: 25 });
        const text = await pollFor(() => a.evalJS<string | null>(composerText), (t) => t?.includes(JOT_TEXT) === true, SETTLE_MS);
        const jotBodyLog = await a.evalJS<DragLog>(readDragLog);
        const jotShellLog = await app.evalJS<DragLog>(readDragLog);
        const jotSourceLog = await jots.evalJS<DragLog>(readDragLog);
        note(`jot drag ${JSON.stringify(from)} → ${JSON.stringify(to)}: body page ${JSON.stringify(jotBodyLog)}; Jots page ${JSON.stringify(jotSourceLog)}; shell page ${JSON.stringify(jotShellLog)}; composer ${JSON.stringify(text)}`);
        expect(jotBodyLog.drop, "the body's page took the jot's drop").toBe(dropsBefore + 1);
        expect(jotBodyLog.types, "the jot's private type crossed to the body's page").toContain("application/x-tug-jot");
        expect(jotShellLog.drop, "the shell's page took no drop").toBe(0);
        expect(jotSourceLog.drop, "the Jots card's page took no drop").toBe(0);
        expect(text, "the jot's text lands in the body's composer").toContain(JOT_TEXT);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
