/**
 * row-20-drag-hole.test.ts — a body card that crossed a Text card leaves no
 * hole in it.
 *
 * A pane behind a body wears a cut at the body's rect, and a gesture that
 * carries the body across it moves the cut with it. When the gesture ends,
 * the cut must be the one the landed deck calls for — a hole only where a
 * visible body stands in front of the pane — and nothing a frame of the
 * gesture gave it. Three ends are read, on the shape the user's deck has (a
 * four-up flow at slim content width, zoom 0.9, so a drop slides the band):
 * a body card dragged by its handle across the Text card beside it, with the
 * hand travelling below the card's resting height, and dropped in the empty
 * slot past it; the same drag cancelled with Escape over the Text card; and
 * the body card assigned to that slot, which a settle carries across the
 * Text card on the host.
 *
 * At rest, every pane's cut is checked against the placer's posted bodies
 * and the pane's own box, and the Text card's region outside any body in
 * front of it is read by composite colour: its own surface, never the floor.
 * The Text card's file is blank, so its region is its own surface — read off
 * a composite of it standing, before the gesture — wherever its pane paints,
 * and floor (canvas and grid) wherever a hole is.
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
import { asRgbJs, classifyFrame, describeFrames, fillOf, parseRgb, type Rgb } from "./_frames";

const TEST_NAME = "body-grounding-row-20-drag-hole";
const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const A = "r20-a";
const T = "r20-t";
const E = "r20-e";
const ZOOM = 0.9;
/** How much of the Text card's uncovered region may read as floor: none, past the classifier's edge noise. */
const FLOOR_SHARE = 0.01;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const frameOf = (cardId: string): string => `.tug-pane:has([data-card-id="${cardId}"])`;
const handleOf = (cardId: string): string => `${frameOf(cardId)} .tug-pane-title-bar .tug-pane-grab-handle`;

const rectOf = (app: App, selector: string): Promise<Rect | null> =>
  app.evalJS<Rect | null>(
    `(function () {
      var el = document.querySelector(${JSON.stringify(selector)});
      if (el === null) return null;
      var r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })()`,
  );

const textPane = (id: string, slot: number): Record<string, unknown> => ({
  id: `${id}-pane`,
  position: { x: 40, y: 40 },
  size: { width: 640, height: 480 },
  cardIds: [id],
  activeCardId: id,
  title: "",
  acceptsFamilies: ["standard"],
  slot,
});

/**
 * Every pane whose cut disagrees with the landed deck: a pane wears a cut
 * exactly when a visible posted body in front of it (higher z) meets its box.
 */
const MISCUT = `(function () {
  var d = window.tugdeck.diag.getBodyPlacement();
  var bodies = d && d.lastPosted ? d.lastPosted.bodies : [];
  var out = [];
  document.querySelectorAll(".tug-pane").forEach(function (p) {
    var r = p.getBoundingClientRect();
    var z = parseInt(getComputedStyle(p).zIndex, 10) || 0;
    var front = bodies.some(function (b) {
      return b.visible && b.z > z && b.width > 0 && b.height > 0 &&
        b.x < r.x + r.width && b.x + b.width > r.x && b.y < r.y + r.height && b.y + b.height > r.y;
    });
    var cut = (p.style.clipPath || "") !== "";
    if (front !== cut) out.push({ pane: p.getAttribute("data-pane-id"), front: front, clip: p.style.clipPath });
  });
  return out;
})()`;

/** The horizontal span of `r` no visible posted body in front of it covers, as the widest free run. */
const FREE_SPAN = (selector: string): string => `(function () {
  var p = document.querySelector(${JSON.stringify(selector)});
  var r = p.getBoundingClientRect();
  var z = parseInt(getComputedStyle(p).zIndex, 10) || 0;
  var d = window.tugdeck.diag.getBodyPlacement();
  var covered = (d && d.lastPosted ? d.lastPosted.bodies : []).filter(function (b) {
    return b.visible && b.z > z && b.x < r.x + r.width && b.x + b.width > r.x;
  }).map(function (b) { return [Math.max(r.x, b.x), Math.min(r.x + r.width, b.x + b.width)]; });
  var best = [r.x, r.x];
  var edges = [r.x];
  covered.forEach(function (c) { edges.push(c[0], c[1]); });
  edges.push(r.x + r.width);
  edges.sort(function (a, b) { return a - b; });
  for (var i = 0; i + 1 < edges.length; i++) {
    var mid = (edges[i] + edges[i + 1]) / 2;
    var inside = covered.some(function (c) { return mid > c[0] && mid < c[1]; });
    if (!inside && edges[i + 1] - edges[i] > best[1] - best[0]) best = [edges[i], edges[i + 1]];
  }
  return { x: best[0], y: r.y, width: best[1] - best[0], height: r.height };
})()`;

/** The commonest colour of a crop inside `frame`, standing: the card's own surface as the composite shows it. */
async function standingSurface(app: App, frame: Rect): Promise<Rgb> {
  const crop = { x: Math.ceil(frame.x) + 40, y: Math.ceil(frame.y) + 120, width: 120, height: 120 };
  await app.captureBurst({ op: "arm", durationMs: 100, intervalMs: 50, crop });
  const reading = await pollFor(() => app.captureBurst({ op: "read" }) as Promise<CaptureBurstReading>, (r) => r.done, 3_000);
  return fillOf(reading.frames[reading.frames.length - 1]);
}

describe.skipIf(!SHOULD_RUN)("body-grounding row 20: a drag leaves no hole", () => {
  for (const leg of ["drop", "cancel", "crossing"] as const) test(
    `the Text card a body crossed is whole at rest (${leg})`,
    async () => {
      const say = (text: string): void => note(`${leg}: ${text}`);
      const stubDir = stubDirectory();
      const dir = mkdtempSync(join(tmpdir(), "tug-r20-text-"));
      const file = join(dir, "blank.txt");
      writeFileSync(file, "\n".repeat(120));
      const app = await launchTugApp({
        testName: `${TEST_NAME}-${leg}`,
        foreground: true,
        env: { TUG_BODY_VIEWS: "1", [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
      });
      try {
        await app.seedDeckState({
          state: {
            cards: [
              { id: A, componentId: "session", title: "A", closable: true },
              { id: T, componentId: "text", title: "T", closable: true },
              { id: E, componentId: "text", title: "E", closable: true },
            ],
            panes: [sessionPane(A, 0), textPane(T, 1), textPane(E, 3)],
            activePaneId: `${A}-pane`,
            imposition: { kind: "four-up", layout: "flow", contentWidth: "slim", sidebars: {} },
            hasFocus: true,
          },
          cardStates: {
            [T]: { content: { path: file, anchor: { line: 1, ch: 0 }, scrollTop: 0 } },
            [E]: { content: { path: file, anchor: { line: 1, ch: 0 }, scrollTop: 0 } },
          },
          focusCardId: A,
        });
        await spawnStub(app, A, stubDir, 2);
        await waitForBody(app, A);
        await focusBody(app, A, { composer: false });
        const took = await app.setPageZoom(ZOOM);
        expect(took, `View › Zoom took ${ZOOM}`).toBeCloseTo(ZOOM, 3);
        await Bun.sleep(1_000);

        const aFrame = (await rectOf(app, frameOf(A)))!;
        const tFrame = (await rectOf(app, frameOf(T)))!;
        const handle = (await rectOf(app, handleOf(A)))!;
        say(`A ${JSON.stringify(aFrame)}; T ${JSON.stringify(tFrame)}`);
        const step = tFrame.x - aFrame.x;
        expect(step, "the Text card stands to the right of the body card").toBeGreaterThan(100);
        const surface = await standingSurface(app, tFrame);
        say(`the Text card's own surface by composite ${JSON.stringify(surface)}`);

        const from = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
        if (leg === "crossing") {
          await app.evalJS<null>(`(window.__tug.dispatchControlAction("assign-slot", { cardId: ${JSON.stringify(A)}, slot: 2 }), null)`);
        } else {
          const over = { x: from.x + step, y: from.y + 260 };
          const to = { x: from.x + 2 * step + 40, y: from.y + 260 };
          await app.nativeDragWithoutRelease(from, leg === "cancel" ? over : to, {
            interpolationSteps: 24,
            interpolationDelayMs: 30,
            mouseDownDelayMs: 80,
          });
          await Bun.sleep(300);
          if (leg === "cancel") {
            const cut = await app.evalJS<string>(`document.querySelector(${JSON.stringify(frameOf(T))}).style.clipPath`);
            say(`the Text card's cut with the body held over it: ${cut.slice(0, 160)}`);
            expect(cut, "the body held over the Text card cuts it").not.toBe("");
            await app.nativeKey("Escape");
            await Bun.sleep(200);
            await app.nativeMouseUp(over);
          } else {
            await app.nativeMouseUp(to);
          }
        }
        const rested = await pollFor(
          () =>
            app.evalJS<boolean>(
              `document.querySelector("[data-pointer-owned]") === null && document.querySelector("[data-gesture]") === null && document.querySelector("[data-imposer-settling]") === null`,
            ),
          (v) => v,
          8_000,
        );
        expect(rested, "the gesture ended and the deck settled").toBe(true);
        await Bun.sleep(800);

        const slots = await app.evalJS<unknown>(`window.tugdeck.diag.getDeckState().panes.map(function (p) { return p.id + ":" + p.slot; })`);
        say(`slots at rest ${JSON.stringify(slots)}; A ${JSON.stringify(await rectOf(app, frameOf(A)))}; T ${JSON.stringify(await rectOf(app, frameOf(T)))}`);
        if (leg !== "cancel") expect(JSON.stringify(slots), "the body card moved to the empty slot").toContain(`${A}-pane:2`);
        const miscut = await app.evalJS<unknown[]>(MISCUT);
        say(`panes whose cut disagrees with the landed deck: ${JSON.stringify(miscut)}`);
        expect(miscut, "every pane's cut at rest is the landed deck's").toEqual([]);

        // The Text card's region no body stands in front of, by composite.
        const free = await app.evalJS<Rect>(FREE_SPAN(frameOf(T)));
        const crop = {
          x: Math.ceil(free.x) + 12,
          y: Math.ceil(free.y) + 60,
          width: Math.floor(free.width) - 24,
          height: Math.min(600, Math.floor(free.height) - 80),
        };
        expect(crop.width, "some of the Text card stands clear of every body").toBeGreaterThan(60);
        await app.captureBurst({ op: "arm", durationMs: 100, intervalMs: 50, crop });
        const reading = await pollFor(() => app.captureBurst({ op: "read" }) as Promise<CaptureBurstReading>, (r) => r.done, 3_000);
        const shot = reading.frames[reading.frames.length - 1];
        const canvas = parseRgb(
          await app.evalJS<string>(asRgbJs(`getComputedStyle(document.body).getPropertyValue('--tug7-surface-global-primary-normal-canvas-rest')`)),
        );
        const classes = classifyFrame(shot, { surface, canvas, bare: parseRgb(reading.windowBackground) }, 8);
        say(`the Text card's clear region ${JSON.stringify(crop)}: ${describeFrames([classes])}`);
        // The floor is canvas paint with its grid in it; the grid class alone,
        // with no canvas beside it, is the card's own near-canvas paint (its
        // gutter, its line highlight) and not a hole.
        expect(classes.canvas + classes.bare, "the Text card's clear region shows no floor").toBeLessThanOrEqual(FLOOR_SHARE);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
