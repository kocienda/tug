/**
 * chrome-under-bodies.test.ts — a back card paints nothing inside a front
 * card's body.
 *
 * [F16]: the shell page stands above every body, so where two panes
 * overlap the pane behind would paint its border and content over the
 * body of the pane in front, which the user saw as back borders drawn over
 * front cards. The placer now cuts every pane behind a visible body at
 * that body's rect (`lib/body-placement.ts`).
 *
 * A body card and a Text card stand in a three-up fit on a window too
 * narrow for the band, so their panes overlap; the Text card's file is
 * lines of block glyphs, so wherever its editor paints it paints ink. With
 * the body card focused — raised in front — the overlap inside the body's
 * content box reads as the body's own paint with no ink of the Text card;
 * with the Text card focused — in front — the same region reads as the
 * Text card's ink, which is what the shell's stacking says and what shows
 * the reading can tell the two apart.
 *
 * @foreground
 * @covers tugdeck/src/lib/body-placement.ts
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note, type App } from "../_harness";
import type { CaptureBurstReading } from "../_harness/client";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "../streaming-stub-fixture";
import { focusBody, pollFor, sessionPane, spawnStub, waitForBody } from "./_bodies";
import { classifyFrame, describeFrames, near, parseRgb, type FrameClasses } from "./_frames";
import { CORNER_INSET_PX, expectAtRest, frameOf, intersect, readStanding, rectOf, type Rect } from "./_motion";

const TEST_NAME = "body-grounding-chrome-under-bodies";
const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const A = "cub-a";
const T = "cub-text";
const TEXT_EDITOR = `[data-card-id="${T}"] [data-slot="tug-text-card-editor"] .cm-content`;
/** T's pane, which wears the cut as its inline clip. */
const PANE_OF_T = `.tug-pane:has([data-card-id="${T}"])`;
/** The box read at each top corner of the content box, in page px. */
const CORNER_PX = 14;
/** Where the corner box starts: at the content box's own edge, where a rounding would show the floor first. */
const EDGE_PX = 0;

function deck(): Record<string, unknown> {
  return {
    cards: [
      { id: A, componentId: "session", title: "A", closable: true },
      { id: T, componentId: "text", title: "Text", closable: true },
    ],
    panes: [
      sessionPane(A, 0),
      {
        id: `${T}-pane`,
        position: { x: 40, y: 40 },
        size: { width: 640, height: 480 },
        cardIds: [T],
        activeCardId: T,
        title: "",
        acceptsFamilies: ["standard"],
        slot: 1,
      },
    ],
    activePaneId: `${A}-pane`,
    imposition: { kind: "three-up", layout: "fit", sidebars: {} },
    hasFocus: true,
  };
}

/** The overlap of A's content box with T's frame, inset from the corners, in composite px over `crop`. */
async function overlapRegion(app: App, crop: Rect, scale: number): Promise<{ box: Rect; region: Rect } | null> {
  const placeholder = await rectOf(app, `${frameOf(A)} [data-body-placeholder]`);
  const text = await rectOf(app, frameOf(T));
  if (placeholder === null || text === null) return null;
  const box = intersect(intersect(placeholder, text), crop);
  if (box.width <= 2 * CORNER_INSET_PX || box.height <= 2 * CORNER_INSET_PX) return null;
  return {
    box,
    region: {
      x: (box.x - crop.x + CORNER_INSET_PX) * scale,
      y: (box.y - crop.y + CORNER_INSET_PX) * scale,
      width: (box.width - 2 * CORNER_INSET_PX) * scale,
      height: (box.height - 2 * CORNER_INSET_PX) * scale,
    },
  };
}

/** The overlap strip and the part of A's content box T never covers, read from one frame: their classes and fills. */
async function readOverlap(app: App, label: string, crop: Rect, clear: Rect, standing: Awaited<ReturnType<typeof readStanding>>): Promise<{ strip: FrameClasses; own: FrameClasses; corners: FrameClasses[] }> {
  const overlap = await overlapRegion(app, crop, standing.scale);
  expect(overlap, `${label}: A's content box and T's frame overlap`).not.toBeNull();
  await app.captureBurst({ op: "arm", durationMs: 100, intervalMs: 50, crop });
  const reading = await pollFor(() => app.captureBurst({ op: "read" }) as Promise<CaptureBurstReading>, (r) => r.done, 3_000);
  const frame = reading.frames[reading.frames.length - 1];
  const strip = classifyFrame(frame, standing.palette, 8, overlap!.region);
  const ownBox = intersect(clear, crop);
  const own = classifyFrame(frame, standing.palette, 8, {
    x: (ownBox.x - crop.x + CORNER_INSET_PX) * standing.scale,
    y: (ownBox.y - crop.y + CORNER_INSET_PX) * standing.scale,
    width: (ownBox.width - 2 * CORNER_INSET_PX) * standing.scale,
    height: (ownBox.height - 2 * CORNER_INSET_PX) * standing.scale,
  });
  const clip = await app.evalJS<string>(`document.querySelector(${JSON.stringify(PANE_OF_T)})?.style.clipPath ?? ""`);
  // The content box's top corners: square under the masthead, so the body's
  // own paint reaches into them and no floor shows through a rounding there.
  // Read from the box's own edge: a radius of a few points showed as a few per cent of floor here.
  const placeholder = (await rectOf(app, `${frameOf(A)} [data-body-placeholder]`))!;
  const corner = (x: number): FrameClasses =>
    classifyFrame(frame, standing.palette, 8, { x: (x - crop.x) * standing.scale, y: (placeholder.y + EDGE_PX - crop.y) * standing.scale, width: CORNER_PX * standing.scale, height: CORNER_PX * standing.scale });
  const corners = [corner(placeholder.x + EDGE_PX), corner(placeholder.x + placeholder.width - EDGE_PX - CORNER_PX)];
  note(`${label}: overlap ${JSON.stringify(overlap!.box)} reads ${describeFrames([strip])}; A's own part reads ${describeFrames([own])}; top corners read ${describeFrames(corners)}; T's pane clip ${JSON.stringify(clip.slice(0, 80))}${clip.length > 80 ? "…" : ""}`);
  return { strip, own, corners };
}

describe.skipIf(!SHOULD_RUN)("body-grounding: a back card's chrome stays under a front card's body", () => {
  test(
    "the Text card behind the body card paints nothing inside the body's rect, and in front of it paints over it",
    async () => {
      const stubDir = stubDirectory();
      const textDir = mkdtempSync(join(tmpdir(), "tug-cub-text-"));
      const textFile = join(textDir, "blocks.txt");
      writeFileSync(textFile, Array.from({ length: 120 }, () => "█".repeat(110)).join("\n") + "\n");
      const app = await launchTugApp({
        testName: TEST_NAME,
        foreground: true,
        bodies: true,
        env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
      });
      try {
        await app.seedDeckState({
          state: deck(),
          cardStates: { [T]: { content: { path: textFile, anchor: { line: 1, ch: 0 }, scrollTop: 0 } } },
          focusCardId: A,
        });
        await spawnStub(app, A, stubDir, 2);
        await waitForBody(app, A);
        await app.waitForCondition<boolean>(`document.querySelectorAll(${JSON.stringify(`${TEXT_EDITOR} .cm-line`)}).length > 5`, { timeoutMs: 30_000 });
        await focusBody(app, A);
        await Bun.sleep(600);
        const start = await expectAtRest(app, A, "A in front");
        const text = (await rectOf(app, frameOf(T)))!;
        note(`A's content box ${JSON.stringify(start)}; T's frame ${JSON.stringify(text)}; z A ${await app.evalJS<string>(`getComputedStyle(document.querySelector(${JSON.stringify(frameOf(A))})).zIndex`)}, T ${await app.evalJS<string>(`getComputedStyle(document.querySelector(${JSON.stringify(frameOf(T))})).zIndex`)}`);
        expect(text.x < start.x + start.width, "T's frame overlaps A's content box").toBe(true);
        // The palette from the part of A's body T does not cover.
        const clear = { x: start.x, y: start.y, width: Math.max(40, text.x - start.x), height: start.height };
        const standing = await readStanding(app, A, clear);
        const crop = { x: 0, y: Math.floor(start.y), width: standing.contentWidth, height: Math.ceil(start.height) };

        // ---- A in front: the overlap is A's body, no ink of T ----
        const behind = await readOverlap(app, "T behind A", crop, clear, standing);
        expect(await app.evalJS<boolean>(`(document.querySelector(${JSON.stringify(PANE_OF_T)})?.style.clipPath ?? "").indexOf("evenodd") >= 0`), "T's pane wears the cut").toBe(true);
        expect(behind.strip.other, "no ink of the Text card shows inside A's body").toBeLessThan(0.05);
        expect(near(parseRgb(behind.strip.fill), parseRgb(behind.own.fill), 8), "the strip is the body's own paint, the colour the rest of the body has in the same frame").toBe(true);
        for (const [i, c] of behind.corners.entries()) {
          expect(c.canvas + c.grid + c.bare, `the content box's top-${i === 0 ? "left" : "right"} corner is square: no floor shows through it`).toBeLessThan(0.02);
        }

        // ---- T in front: the overlap is T's ink ----
        await app.nativeClickAtElement(`${TEXT_EDITOR} .cm-line`);
        await pollFor(() => app.getFocusedCardId(), (id) => id === T, 3_000);
        await Bun.sleep(600);
        const front = await readOverlap(app, "T in front of A", crop, clear, standing);
        expect(await app.evalJS<string>(`document.querySelector(${JSON.stringify(PANE_OF_T)})?.style.clipPath ?? ""`), "T's pane wears no cut in front").toBe("");
        expect(front.strip.other, "the Text card's ink shows over A's body when T is in front").toBeGreaterThan(0.2);
        expect(near(parseRgb(front.strip.fill), parseRgb(front.own.fill), 8), "and the strip is no longer the body's paint").toBe(false);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
