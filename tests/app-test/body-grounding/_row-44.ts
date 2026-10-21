/**
 * _row-44.ts — row 44's helpers: a workspace switch onto cards whose pages
 * have not painted, read frame by frame.
 *
 * Each piece launches on two workspaces from a seeded layout, arms a burst of
 * window captures over the whole window, switches, and waits for the cards'
 * pages to paint. From the first frame that differs from the standing
 * workspace on, every frame is judged per pane: its title band holds the
 * title's ink against the band's own surface, and its box is not the floor —
 * mostly the canvas colour, which no card's surface is.
 *
 * Not a test: no `describe` here.
 */

import { copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { note, type App } from "../_harness";
import type { CaptureBurstReading } from "../_harness/client";
import { decodePngFile } from "../_harness/png";
import { bodyOf, pollFor } from "./_bodies";
import { asRgbJs, framesDiffer, near, parseRgb, type FrameRegion, type Rgb } from "./_frames";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 60_000;
export const ACTIVE_SPACE = "window.tugdeck.diag.getSpaces().activeSpaceId";

const BURST_MS = 1_200;
const BURST_INTERVAL_MS = 16;
/** How long the burst reads the standing workspace before the switch. */
const STANDING_MS = 120;
/** The title line, from a pane's top edge, in points: inside the one-line bar every masthead begins with. */
const TITLE_TOP = 6;
const TITLE_HEIGHT = 20;
/** How far from the band's own surface a pixel must lie to be the title's ink; the floor's grid lies far nearer the canvas. */
const INK_REACH = 60;
/** A title band with less ink than this is not showing a title. */
const TITLE_INK_MIN = 0.01;
/** A pane box more than this much the canvas colour is the floor through the pane. */
const FLOOR_SHARE_MAX = 0.5;
const TOLERANCE = 8;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A text card's deck of one pane per card, imposed side by side. */
export function textDeck(cardIds: readonly string[]): Record<string, unknown> {
  return {
    cards: cardIds.map((id) => ({ id, componentId: "text", title: id, closable: true })),
    panes: cardIds.map((id, slot) => ({
      id: `${id}-pane`,
      position: { x: 60, y: 60 },
      size: { width: 700, height: 500 },
      cardIds: [id],
      activeCardId: id,
      title: "",
      acceptsFamilies: ["standard"],
      slot,
    })),
    activePaneId: `${cardIds[0]}-pane`,
    imposition: { kind: cardIds.length > 1 ? "two-up" : "one-up", layout: "fit", sidebars: {} },
    hasFocus: true,
  };
}

/** The shell's pane frame for `cardId`, in viewport points, or null while it has no box. */
export const paneRect = (app: App, cardId: string): Promise<Rect | null> =>
  // card-dom: shell — the pane stand-in is the shell's.
  app.evalJS<Rect | null>(
    `(function () {
      var el = document.querySelector('.tug-pane[data-pane-id="${cardId}-pane"]');
      if (el === null) return null;
      var r = el.getBoundingClientRect();
      return r.width > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
    })()`,
  );

export async function activate(app: App, spaceId: string): Promise<void> {
  await app.evalJS<null>(`(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(spaceId)} }), null)`);
  await pollFor(() => app.evalJS<string>(ACTIVE_SPACE), (id) => id === spaceId, 5_000);
}

function clamp(region: FrameRegion, width: number, height: number): [number, number, number, number] {
  return [
    Math.max(0, Math.floor(region.x)),
    Math.max(0, Math.floor(region.y)),
    Math.min(width, Math.ceil(region.x + region.width)),
    Math.min(height, Math.ceil(region.y + region.height)),
  ];
}

type Png = ReturnType<typeof decodePngFile>;

/** The share of `region`'s pixels lying farther than {@link INK_REACH} from the region's commonest colour: ink on its surface. */
export function inkShare(png: Png, region: FrameRegion): number {
  const [x0, y0, x1, y1] = clamp(region, png.width, png.height);
  const counts = new Map<number, number>();
  const pixels: Rgb[] = [];
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = (y * png.width + x) * 4;
      const p = { r: png.rgba[i], g: png.rgba[i + 1], b: png.rgba[i + 2] };
      pixels.push(p);
      const key = (p.r << 16) | (p.g << 8) | p.b;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  let fillKey = 0;
  let most = -1;
  for (const [key, count] of counts) if (count > most) [fillKey, most] = [key, count];
  const fill = { r: (fillKey >> 16) & 255, g: (fillKey >> 8) & 255, b: fillKey & 255 };
  const ink = pixels.filter((p) => !near(p, fill, INK_REACH)).length;
  return ink / Math.max(1, pixels.length);
}

/** The share of `region`'s pixels within {@link TOLERANCE} of the canvas colour, sampled every fourth pixel. */
export function canvasShare(png: Png, region: FrameRegion, canvas: Rgb): number {
  const [x0, y0, x1, y1] = clamp(region, png.width, png.height);
  let hits = 0;
  let n = 0;
  for (let y = y0; y < y1; y += 4) {
    for (let x = x0; x < x1; x += 4) {
      const i = (y * png.width + x) * 4;
      n += 1;
      if (near({ r: png.rgba[i], g: png.rgba[i + 1], b: png.rgba[i + 2] }, canvas, TOLERANCE)) hits += 1;
    }
  }
  return hits / Math.max(1, n);
}

/**
 * Switch to `spaceId` under a burst, wait for every card's page to paint,
 * read each card's pane box — the arrangement's, which a pane has only
 * while its workspace is shown — and judge each frame from the first
 * switched one. Answers the frames that
 * failed, after noting the reading — and on a red, keeping the first red
 * frame and the settled one under the temp directory to look at.
 */
export async function readSwitch(
  app: App,
  spaceId: string,
  cardIds: readonly string[],
  label: string,
  /**
   * What each pane's title band must show: the card's `title`, which the
   * shell holds for a card whose page has spoken — or only its `chrome`,
   * for a card that has never had a page, whose title its page computes.
   */
  band: "title" | "chrome" = "title",
): Promise<string[]> {
  const width = await app.evalJS<number>("window.innerWidth");
  const height = await app.evalJS<number>("window.innerHeight");
  await app.captureBurst({ op: "arm", durationMs: BURST_MS, intervalMs: BURST_INTERVAL_MS, crop: { x: 0, y: 0, width, height } });
  await Bun.sleep(STANDING_MS);
  const choseWall = Date.now();
  await app.evalJS<null>(`(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(spaceId)} }), null)`);
  for (const id of cardIds) {
    const b = await pollFor(() => bodyOf(app, id), (s) => s?.state === "ready" && s.painted === true && s.visible && !s.covered, 10_000);
    note(`${label} ${id}: painted and shown ${Date.now() - choseWall} ms after the switch, start ${b?.start ?? "?"}`);
    if (b?.painted !== true || b.visible !== true) return [`${id}: its page never painted and showed`];
  }
  const rects: Record<string, Rect> = {};
  for (const id of cardIds) {
    const rect = await pollFor(() => paneRect(app, id), (r) => r !== null, 5_000);
    if (rect === null) return [`${id}: its pane has no box`];
    rects[id] = rect;
  }
  const reading = await pollFor(
    () => app.captureBurst({ op: "read" }) as Promise<CaptureBurstReading>,
    (r) => r.done,
    BURST_MS + 5_000,
  );
  if (!reading.done) return ["the burst did not finish"];
  const last = reading.frames[reading.frames.length - 1];
  const before = reading.frames.filter((f) => f.wall < choseWall);
  if (before.length === 0) return ["no frame of the standing workspace was captured before the switch"];
  const standing = before[before.length - 1];
  const start = reading.frames.findIndex((f) => f.wall >= choseWall && framesDiffer(f, standing));
  if (start < 0) return ["the switch never reached the composite within the burst"];
  const switched = reading.frames.slice(start);
  const canvas = parseRgb(await app.evalJS<string>(asRgbJs(`getComputedStyle(document.body).getPropertyValue('--tug7-surface-global-primary-normal-canvas-rest')`)));
  const scale = reading.scale;
  const px = (r: Rect): FrameRegion => ({ x: r.x * scale, y: r.y * scale, width: r.width * scale, height: r.height * scale });

  const worst: Record<string, { ink: number; floor: number }> = {};
  const bad: string[] = [];
  let firstBad: { path: string; ms: number } | null = null;
  for (const f of switched) {
    const png = decodePngFile(f.path);
    for (const id of cardIds) {
      const r = rects[id];
      const titleRegion = px({ x: r.x + 8, y: r.y + TITLE_TOP, width: r.width - 16, height: TITLE_HEIGHT });
      // A band the floor shows through is the canvas; a band in the card's
      // chrome is not, whatever it says.
      const ink = band === "title" ? inkShare(png, titleRegion) : 1 - canvasShare(png, titleRegion, canvas);
      const floor = canvasShare(png, px({ x: r.x + 4, y: r.y + 4, width: r.width - 8, height: r.height - 8 }), canvas);
      const w = (worst[id] ??= { ink: 1, floor: 0 });
      w.ink = Math.min(w.ink, ink);
      w.floor = Math.max(w.floor, floor);
      if (ink < TITLE_INK_MIN || floor > FLOOR_SHARE_MAX) {
        bad.push(`${id} at ${Math.round(f.wall - choseWall)} ms: title band ${band} ${(ink * 100).toFixed(1)}%, box canvas ${(floor * 100).toFixed(1)}%`);
        firstBad ??= { path: f.path, ms: Math.round(f.wall - choseWall) };
      }
    }
  }
  note(
    `${label}: ${switched.length} frames from the first switched one at ${Math.round(switched[0].wall - choseWall)} ms; ` +
      cardIds.map((id) => `${id} least title band ${band} ${(worst[id].ink * 100).toFixed(1)}%, most box canvas ${(worst[id].floor * 100).toFixed(1)}%`).join("; "),
  );
  if (bad.length > 0) note(`${label}: frames without a title or showing the floor: ${bad.slice(0, 10).join("; ")}${bad.length > 10 ? ` (+${bad.length - 10} more)` : ""}`);
  if (firstBad !== null) {
    // The burst's frames are swept with the app; keep the first red one and the settled one to look at.
    const keptBad = join(tmpdir(), `${label}-first-red-frame.png`);
    const keptLast = join(tmpdir(), `${label}-settled-frame.png`);
    copyFileSync(firstBad.path, keptBad);
    copyFileSync(last.path, keptLast);
    note(`${label}: kept the first red frame (${firstBad.ms} ms) at ${keptBad} and the settled frame at ${keptLast}`);
  }
  return bad;
}
