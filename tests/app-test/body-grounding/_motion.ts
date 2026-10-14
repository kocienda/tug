/**
 * _motion.ts — reading a body card across a gesture that moves its chrome.
 *
 * Rows 9 and 10 of the bar judge a fold, an unfold and a workspace switch
 * the way row 4 judges a slide: a per-animation-frame sampler of the
 * shell's own rects beside a composite burst of the window, the composite
 * read by colour ([B05]). What the rows forbid is the same in each — no
 * frame shows the bare window through an open hole, and on every frame
 * where the chrome moves the body card's content box is the lid, the
 * pane's own surface colour, never a body standing where the chrome was
 * and never the floor. This module is the sampler, the burst, and the
 * judgement; the rows are the gestures and the assertions around them.
 */

import { expect } from "bun:test";

import { note, type App } from "../_harness";
import type { BodyViewSnapshot, CaptureBurstReading } from "../_harness/client";
import { classifyFrame, describeFrames, framesDiffer, pollFor, readPalette, showsBareHole, type FrameClasses, type Palette } from "./_frames";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Sample {
  wall: number;
  frame: Rect;
  /** Null while the card has no placeholder — a folded card's content box is not rendered. */
  placeholder: Rect | null;
  /** The canvas wears `data-imposer-settling`: a settle is running. */
  settling: boolean;
  /** The placeholder wears `data-body-shown`: the lid is lifted. */
  shown: boolean;
}

/** How far the host's container may stand from the placeholder at rest. */
export const REST_TOLERANCE_PX = 2;
/** Kept clear of the pane's rounded corners when a region is read. */
export const CORNER_INSET_PX = 12;
/** A rect moved between two samples when an edge shifted by more than this. */
export const MOVED_PX = 0.5;
/** How much of the content box the lid must fill on a frame where the chrome moves. */
export const LID_SHARE = 0.9;
export const BURST_INTERVAL_MS = 33;

const CANVAS = "[data-deck-canvas-background]";

/** The pane holding `cardId`, whatever its pane is called; a folded card's root still stands. */
export const frameOf = (cardId: string): string => `.tug-pane:has([data-card-id="${cardId}"])`;
export const placeholderOf = (cardId: string): string => `[data-body-placeholder][data-card-id="${cardId}"]`;

export const rectOf = (app: App, selector: string): Promise<Rect | null> =>
  app.evalJS<Rect | null>(
    `(function () {
      var el = document.querySelector(${JSON.stringify(selector)});
      if (el === null) return null;
      var r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })()`,
  );

export const edgeGap = (a: Rect, b: Rect): number =>
  Math.max(
    Math.abs(a.x - b.x),
    Math.abs(a.y - b.y),
    Math.abs(a.x + a.width - (b.x + b.width)),
    Math.abs(a.y + a.height - (b.y + b.height)),
  );

export const intersect = (a: Rect, b: Rect): Rect => {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return { x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x), height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y) };
};

/** Arm a per-animation-frame sampler of `cardId`'s frame and placeholder rects, the settle mark and the lid. */
export async function armSampler(app: App, cardId: string): Promise<void> {
  await app.evalJS<null>(
    `(function () {
      var rec = (window.__bodyMotion = { samples: [], stop: false });
      var read = function (el) {
        var r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      };
      var tick = function () {
        if (rec.stop) return;
        var frame = document.querySelector(${JSON.stringify(frameOf(cardId))});
        var ph = document.querySelector(${JSON.stringify(placeholderOf(cardId))});
        var canvas = document.querySelector(${JSON.stringify(CANVAS)});
        if (frame !== null) {
          rec.samples.push({
            wall: Date.now(),
            frame: read(frame),
            placeholder: ph === null ? null : read(ph),
            settling: canvas !== null && canvas.hasAttribute("data-imposer-settling"),
            shown: ph !== null && ph.hasAttribute("data-body-shown"),
          });
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return null;
    })()`,
  );
}

export const samplerState = (app: App): Promise<{ saw: boolean; now: boolean; count: number }> =>
  app.evalJS<{ saw: boolean; now: boolean; count: number }>(
    `(function () {
      var r = window.__bodyMotion;
      var saw = false;
      for (var i = 0; i < r.samples.length; i++) if (r.samples[i].settling) { saw = true; break; }
      var last = r.samples[r.samples.length - 1];
      return { saw: saw, now: last !== undefined && last.settling, count: r.samples.length };
    })()`,
  );

export async function readSampler(app: App): Promise<Sample[]> {
  return app.evalJS<Sample[]>(`(function () { var r = window.__bodyMotion; r.stop = true; return r.samples; })()`);
}

/** The index of the latest sample taken at or before `wall`, or -1 before the first. */
export function sampleIndexAt(samples: readonly Sample[], wall: number): number {
  let found = -1;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].wall > wall) break;
    found = i;
  }
  return found;
}

export async function bodyOf(app: App, cardId: string): Promise<BodyViewSnapshot | null> {
  return (await app.bodies()).find((b) => b.cardId === cardId) ?? null;
}

/** The host's container stands on `cardId`'s placeholder, shown, with the lid lifted. */
export async function expectAtRest(app: App, cardId: string, label: string): Promise<Rect> {
  const placeholder = await rectOf(app, placeholderOf(cardId));
  const body = await bodyOf(app, cardId);
  expect(placeholder, `${label}: the placeholder stands`).not.toBeNull();
  expect(body?.visible, `${label}: the body is placed visible`).toBe(true);
  const gap = edgeGap(placeholder!, body!.frame);
  const lifted = await app.evalJS<boolean>(`document.querySelector(${JSON.stringify(placeholderOf(cardId))})?.hasAttribute("data-body-shown") ?? false`);
  note(`${label}: placeholder ${JSON.stringify(placeholder)}; host frame ${JSON.stringify(body!.frame)}; worst edge gap ${gap.toFixed(2)} px; lid lifted ${lifted}`);
  expect(gap, `${label}: the host's container stands on the placeholder`).toBeLessThanOrEqual(REST_TOLERANCE_PX);
  expect(lifted, `${label}: the lid is lifted`).toBe(true);
  return placeholder!;
}

/** The host's container for `cardId` is hidden, and the lid is on. */
export async function expectHidden(app: App, cardId: string, label: string): Promise<void> {
  const body = await pollFor(() => bodyOf(app, cardId), (b) => b !== null && !b.visible, 5_000);
  const lifted = await app.evalJS<boolean>(`document.querySelector(${JSON.stringify(placeholderOf(cardId))})?.hasAttribute("data-body-shown") ?? false`);
  note(`${label}: host ${JSON.stringify(body === null ? null : { visible: body.visible, frame: body.frame })}; lid lifted ${lifted}`);
  expect(body?.visible, `${label}: the body is hidden`).toBe(false);
  expect(lifted, `${label}: the lid is on`).toBe(false);
}

export interface Standing {
  palette: Palette;
  standing: FrameClasses;
  scale: number;
  contentWidth: number;
}

/** The palette from a probe of `cardId`'s standing body, whose content box fills with its own paint. */
export async function readStanding(app: App, cardId: string, placeholder: Rect): Promise<Standing> {
  const probeCrop = {
    x: Math.ceil(placeholder.x) + 2,
    y: Math.ceil(placeholder.y) + 2,
    width: Math.floor(placeholder.width) - 4,
    height: Math.floor(placeholder.height) - 4,
  };
  await app.captureBurst({ op: "arm", durationMs: 100, intervalMs: 50, crop: probeCrop });
  const probe = await pollFor(() => app.captureBurst({ op: "read" }) as Promise<CaptureBurstReading>, (r) => r.done, 3_000);
  const standingFrame = probe.frames[probe.frames.length - 1];
  const palette = await readPalette(app, probe.windowBackground, standingFrame);
  const standing = classifyFrame(standingFrame, palette);
  note(`${cardId}: palette ${JSON.stringify(palette)}; body standing: ${describeFrames([standing])}`);
  expect(standing.surface + standing.other, `${cardId}: the standing body fills its rect with its own paint`).toBeGreaterThan(0.95);
  return { palette, standing, scale: probe.scale, contentWidth: probe.contentWidth };
}

export interface Judged {
  frame: FrameClasses;
  whole: FrameClasses;
  path: string;
  inMotion: boolean;
}

export interface Verdict {
  judged: Judged[];
  motion: Judged[];
  bare: Judged[];
  offenders: Judged[];
  movingSamples: number;
  shownWhileMoving: number;
}

/**
 * Judge a burst over a gesture against the shell's samples: a frame is in
 * motion when the shell's record at its capture and at the sample before
 * both have the frame off its standing place and short of its landing, and
 * the composite itself has left the standing deck. On such a frame the part
 * of the placeholder inside the frame's own box — a fold clips the content
 * box as it closes — must be the lid; on every frame no bare hole shows.
 */
export function judge(
  label: string,
  reading: CaptureBurstReading,
  samples: readonly Sample[],
  gestureWall: number,
  before: Rect,
  after: Rect,
  palette: Palette,
  crop: Rect,
): Verdict {
  const scale = reading.scale;
  let movingSamples = 0;
  let shownWhileMoving = 0;
  for (let i = 1; i < samples.length; i++) {
    if (edgeGap(samples[i].frame, samples[i - 1].frame) <= MOVED_PX) continue;
    movingSamples += 1;
    if (samples[i].shown) shownWhileMoving += 1;
  }
  const standing = reading.frames.find((f) => f.wall >= gestureWall) ?? reading.frames[0];
  const moved = (k: number): boolean => k >= 0 && edgeGap(samples[k].frame, before) > MOVED_PX && edgeGap(samples[k].frame, after) > MOVED_PX;
  const judged: Judged[] = [];
  for (const f of reading.frames) {
    if (f.wall < gestureWall) continue;
    const i = sampleIndexAt(samples, f.wall);
    if (i < 0) continue;
    const s = samples[i];
    // The window server is a frame or two behind the shell, so the box the
    // chrome has certainly drawn by this capture is what the frame held
    // across the last three samples: an opening chrome's region is the
    // earlier, smaller box, a closing chrome's the later one.
    let held = s.frame;
    for (let k = Math.max(0, i - 2); k < i; k++) held = intersect(held, samples[k].frame);
    const box = s.placeholder === null ? { x: 0, y: 0, width: 0, height: 0 } : intersect(intersect(s.placeholder, held), crop);
    const region = {
      x: (box.x - crop.x + CORNER_INSET_PX) * scale,
      y: (box.y - crop.y + CORNER_INSET_PX) * scale,
      width: (box.width - 2 * CORNER_INSET_PX) * scale,
      height: (box.height - 2 * CORNER_INSET_PX) * scale,
    };
    const readable = region.width > 0 && region.height > 0;
    const inRect = readable ? classifyFrame(f, palette, 8, region) : null;
    const whole = classifyFrame(f, palette);
    const inMotion = moved(i) && moved(i - 1) && framesDiffer(f, standing);
    judged.push({ frame: inRect ?? { ...whole, surface: 1, other: 0, canvas: 0, grid: 0, bare: 0 }, whole, path: f.path, inMotion });
  }
  const motion = judged.filter((j) => j.inMotion);
  const bare = judged.filter((j) => showsBareHole(j.whole));
  const offenders = motion.filter((j) => j.frame.surface < LID_SHARE);
  const pct = (v: number): string => (v * 100).toFixed(2) + "%";
  const worst = motion.length > 0 ? motion.reduce((a, b) => (b.frame.surface < a.frame.surface ? b : a)) : null;
  note(
    `${label}: ${samples.length} shell samples, ${movingSamples} with the frame moving, ${shownWhileMoving} of those with the lid lifted; ` +
      `${judged.length} frames captured, ${motion.length} judged in motion` +
      (worst === null ? "" : `; the lid's smallest share of the content box ${pct(worst.frame.surface)} at ${Math.round(worst.frame.t)} ms (${describeFrames([worst.frame])})`) +
      `; ${bare.length} show a bare hole; ${offenders.length} under the lid bar`,
  );
  if (offenders.length > 0) note(`${label}: frames where the content box is not the lid\n${describeFrames(offenders.map((j) => j.frame))}`);
  return { judged, motion, bare, offenders, movingSamples, shownWhileMoving };
}
