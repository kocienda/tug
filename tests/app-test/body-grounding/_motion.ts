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
import type { BodyViewSnapshot, CaptureBurstReading, HostFrameReading } from "../_harness/client";
import { classifyFrame, describeFrames, FLOOR_BY_CANVAS, framesDiffer, pollFor, settleFor, readPalette, showsBareHole, type FrameClasses, type Palette } from "./_frames";
import { focusBody } from "./_bodies";

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
  /** Where the host's container should stand: the card's stand-in frame outset by the apron. Null as above. */
  view: Rect | null;
  /** The canvas wears `data-imposer-settling`: a settle is running. */
  settling: boolean;
  /** The shell's last placement posts the card shown (`placeCards`): what the host shows. */
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

/**
 * Whether the shell's last placement posts `cardId` shown, as page script:
 * the placer's own record of what it told the host (`lastPosted`), which a
 * per-frame sampler reads beside the stand-ins.
 */
export const postedShownJs = (cardId: string): string => `(function () {
  var p = window.tugdeck && window.tugdeck.diag.getBodyPlacement();
  var last = p && p.lastPosted;
  if (!last) return false;
  for (var i = 0; i < last.bodies.length; i++) if (last.bodies[i].cardId === ${JSON.stringify(cardId)}) return last.bodies[i].visible === true;
  return false;
})()`;

/** Wait until the host shows `cardId`'s view, placed visible and opaque. */
export async function hostShows(app: App, cardId: string, timeoutMs = 5_000): Promise<boolean> {
  const b = await settleFor(() => app.bodies().then((all) => all.find((s) => s.cardId === cardId) ?? null), (s) => s !== null && s.visible && s.opacity >= 0.99, timeoutMs);
  return b !== null && b.visible && b.opacity >= 0.99;
}

/** The pane holding `cardId`, whatever its pane is called; a folded card's root still stands. */
export const frameOf = (cardId: string): string => `.tug-pane:has([data-card-id="${cardId}"])`;
export const placeholderOf = (cardId: string): string => `[data-body-placeholder][data-card-id="${cardId}"]`;

/** How far a card's view reaches past its pane: `CARD_APRON_PX`. */
export const CARD_APRON_PX = 10;

/**
 * The page-side expression for where `cardId`'s view should stand: its
 * stand-in frame outset by the apron, since the card's view is the whole
 * pane. Null while the card has no placeholder.
 */
const viewRectJs = (cardId: string): string => `(function () {
  var ph = document.querySelector(${JSON.stringify(placeholderOf(cardId))});
  if (ph === null) return null;
  var frame = ph.closest(".tug-pane");
  if (frame === null) return null;
  var r = frame.getBoundingClientRect();
  var a = ${CARD_APRON_PX};
  return { x: r.x - a, y: r.y - a, width: r.width + 2 * a, height: r.height + 2 * a };
})()`;

/** Where the host's container for `cardId` should stand, read in the shell (`viewRectJs`). */
export const viewRectOf = (app: App, cardId: string): Promise<Rect | null> => app.evalJS<Rect | null>(viewRectJs(cardId));

/**
 * The page-side expression for the region `cardId`'s paint is judged in: its
 * pane rect, which is its stand-in frame — chrome and content, without the
 * apron. Null while the card has no placeholder.
 */
const regionRectJs = (cardId: string): string => `(function () {
  var ph = document.querySelector(${JSON.stringify(placeholderOf(cardId))});
  if (ph === null) return null;
  var frame = ph.closest(".tug-pane");
  if (frame === null) return null;
  var r = frame.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
})()`;

/** The region `cardId`'s paint is judged in, read in the shell (`regionRectJs`). */
export const regionRectOf = (app: App, cardId: string): Promise<Rect | null> => app.evalJS<Rect | null>(regionRectJs(cardId));

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

/** Arm a per-animation-frame sampler of `cardId`'s frame and placeholder rects, the settle mark and whether it is posted shown. */
export async function armSampler(app: App, cardId: string): Promise<void> {
  // card-dom: shell — callers read stand-in frames and placeholders, the shell's own.
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
        var view = ${viewRectJs(cardId)};
        var region = ${regionRectJs(cardId)};
        var canvas = document.querySelector(${JSON.stringify(CANVAS)});
        if (frame !== null) {
          rec.samples.push({
            wall: Date.now(),
            frame: read(frame),
            placeholder: region,
            view: view,
            settling: canvas !== null && canvas.hasAttribute("data-imposer-settling"),
            shown: ph !== null && ${postedShownJs(cardId)},
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
  // card-dom: shell — the stand-in frame and the placeholder are the shell's.
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
  // card-dom: shell — the sampler's own record, in the shell.
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

/** The host's container stands on `cardId`'s placeholder, shown, and the shell posts it shown. */
export async function expectAtRest(app: App, cardId: string, label: string): Promise<Rect> {
  const placeholder = await viewRectOf(app, cardId);
  const region = await regionRectOf(app, cardId);
  const body = await bodyOf(app, cardId);
  expect(placeholder, `${label}: the placeholder stands`).not.toBeNull();
  expect(body?.visible, `${label}: the body is placed visible`).toBe(true);
  const gap = edgeGap(placeholder!, body!.frame);
  // card-dom: shell — the placer's record of what it posted, in the shell.
  const posted = await app.evalJS<boolean>(postedShownJs(cardId));
  note(`${label}: placeholder ${JSON.stringify(placeholder)}; host frame ${JSON.stringify(body!.frame)}; worst edge gap ${gap.toFixed(2)} px; posted shown ${posted}`);
  expect(gap, `${label}: the host's container stands on the placeholder`).toBeLessThanOrEqual(REST_TOLERANCE_PX);
  expect(posted, `${label}: the shell posts it shown`).toBe(true);
  return region!;
}

/** The host's container for `cardId` is hidden, and the shell posts it hidden. */
export async function expectHidden(app: App, cardId: string, label: string): Promise<void> {
  const body = await settleFor(() => bodyOf(app, cardId), (b) => b !== null && !b.visible, 5_000);
  // card-dom: shell — the placer's record of what it posted, in the shell.
  const posted = await app.evalJS<boolean>(postedShownJs(cardId));
  note(`${label}: host ${JSON.stringify(body === null ? null : { visible: body.visible, frame: body.frame })}; posted shown ${posted}`);
  expect(body?.visible, `${label}: the body is hidden`).toBe(false);
  expect(posted, `${label}: the shell posts it hidden`).toBe(false);
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
  const probe = await settleFor(() => app.captureBurst({ op: "read" }) as Promise<CaptureBurstReading>, (r) => r.done, 3_000);
  const standingFrame = probe.frames[probe.frames.length - 1];
  const palette = await readPalette(app, probe.windowBackground, standingFrame);
  const standing = classifyFrame(standingFrame, palette);
  note(`${cardId}: palette ${JSON.stringify(palette)}; body standing: ${describeFrames([standing])}`);
  // The card's region is its chrome as well as its content, and its title
  // band's tint lies inside the grid's reach, as a rail's ink does: it is
  // read by the canvas and the bare window alone.
  expect(FLOOR_BY_CANVAS.own(standing), `${cardId}: the standing body fills its rect with its own paint`).toBeGreaterThan(0.95);
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

// ---------------------------------------------------------------------------
// A body the host carries through the beats
// ---------------------------------------------------------------------------

/** The host's body snapshot with the beat fields the `bodies` verb carries. */
type CarriedSnapshot = BodyViewSnapshot & { presentedFrame?: Rect; beatsPlanId?: number | null };

/** One reading of where the render server has a body's container. */
export interface Presented {
  /** The midpoint of the round trip that read it. */
  wall: number;
  frame: Rect;
  planId: number | null;
}

/**
 * Poll the host's presented frame of `cardId` — its presentation layer, read
 * back as a viewport rect — until `stop()` holds or `maxMs` passes.
 */
export async function pollPresented(app: App, cardId: string, stop: () => boolean, maxMs = 8_000): Promise<Presented[]> {
  const out: Presented[] = [];
  const deadline = Date.now() + maxMs;
  while (!stop() && Date.now() < deadline) {
    const t0 = Date.now();
    const body = (await bodyOf(app, cardId)) as CarriedSnapshot | null;
    const t1 = Date.now();
    if (body?.presentedFrame !== undefined) out.push({ wall: (t0 + t1) / 2, frame: body.presentedFrame, planId: body.beatsPlanId ?? null });
  }
  return out;
}

/** One plan the placer ran, and what the host has said of it. */
export interface PlanReport {
  /** The settle count the plan was run at. */
  run: number;
  planId: number | null;
  planned: string[];
  /** Where the plan lands each planned body. */
  landings?: Record<string, Rect>;
  refused: string[];
  reasons: Record<string, string>;
  landed: { cardId: string; lateMs: number | null }[];
  cancelled: string[];
}

/** The placer's account of its beat plans (`tugdeck.diag.getBodyPlacement()`). */
export interface PlanDiag {
  runs: number;
  last: PlanReport | null;
  /** The last few plans, oldest first, ending with `last`: a settle re-armed mid-tween plans again. */
  plans: PlanReport[];
  inFlight: string[];
}

export const planDiag = (app: App): Promise<PlanDiag> =>
  app.evalJS<PlanDiag>(`(function () {
    var d = window.tugdeck.diag.getBodyPlacement();
    return { runs: d ? d.planRuns : 0, last: d ? d.lastPlan : null, plans: d ? d.recentPlans : [], inFlight: d ? d.inFlight : [] };
  })()`);

export interface CarriedVerdict {
  /** Composite frames judged in motion. */
  motion: number;
  /** In-motion frames whose content box shows more floor than the bar allows. */
  floorOffenders: Judged[];
  floorBar: number;
  /** Frames anywhere in the burst showing the bare window. */
  bare: number;
  /** Shell samples where the frame moved and the lid was on. */
  lidOnWhileMoving: number;
  movingSamples: number;
  fastestStep: number;
  /** Host readings taken while the chrome moved, and the worst edge gap between them and the placeholder. */
  tracked: number;
  worstTrackPx: number;
  trackBarPx: number;
}

/** The host's presented frame read nearest before `wall`, or null before the first. */
function presentedAt(presented: readonly Presented[], wall: number): Rect | null {
  let found: Rect | null = null;
  for (const p of presented) {
    if (p.wall > wall) break;
    found = p.frame;
  }
  return found;
}

/** Where the host's container should stand at `wall`, linear between the shell's samples either side. */
function viewAt(samples: readonly Sample[], wall: number): Rect | null {
  const i = sampleIndexAt(samples, wall);
  if (i < 0) return null;
  const a = samples[i].view;
  const next = samples[i + 1];
  if (a === null) return null;
  if (next === undefined || next.view === null || next.wall === samples[i].wall) return a;
  const f = (wall - samples[i].wall) / (next.wall - samples[i].wall);
  const b = next.view;
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, width: a.width + (b.width - a.width) * f, height: a.height + (b.height - a.height) * f };
}

/**
 * Judge a gesture whose body the host carries: the lid stays lifted while
 * the chrome moves, no frame shows the bare window, the content box shows
 * no more floor than the leading or trailing strip two frames of travel
 * would uncover (horizontal travel as a share of the box's width, vertical
 * travel — a fold — as a share of its height, at that frame), and the
 * host's presented frame stands within two frames of travel of the
 * placeholder on every reading taken while the chrome moved.
 *
 * The lid and a session body's page are one colour — the pane surface — so
 * the composite cannot say which of the two fills the box; the shell's own
 * record of the lid can, and the floor share says the box is filled at all.
 */
export function judgeCarried(
  label: string,
  reading: CaptureBurstReading,
  samples: readonly Sample[],
  presented: readonly Presented[],
  gestureWall: number,
  before: Rect,
  after: Rect,
  palette: Palette,
  crop: Rect,
): CarriedVerdict {
  const scale = reading.scale;
  let movingSamples = 0;
  let lidOnWhileMoving = 0;
  let fastestStep = 0;
  let fastestStepX = 0;
  let fastestStepY = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1].placeholder;
    const b = samples[i].placeholder;
    if (a === null || b === null) continue;
    const step = edgeGap(a, b);
    if (step <= MOVED_PX) continue;
    movingSamples += 1;
    fastestStep = Math.max(fastestStep, step);
    fastestStepX = Math.max(fastestStepX, Math.abs(a.x - b.x), Math.abs(a.x + a.width - (b.x + b.width)));
    fastestStepY = Math.max(fastestStepY, Math.abs(a.y - b.y), Math.abs(a.y + a.height - (b.y + b.height)));
    if (!samples[i].shown) lidOnWhileMoving += 1;
  }
  const moved = (k: number): boolean => {
    const p = k >= 0 ? samples[k].placeholder : null;
    return p !== null && edgeGap(p, before) > MOVED_PX && edgeGap(p, after) > MOVED_PX;
  };
  const standing = reading.frames.find((f) => f.wall >= gestureWall) ?? reading.frames[0];
  const barFor = (box: Rect): number =>
    Math.min(0.5, 2 * Math.max(fastestStepX / Math.max(1, box.width), fastestStepY / Math.max(1, box.height)) + 0.02);
  const floorBar = barFor(before);
  const bars = new Map<Judged, number>();
  const judged: Judged[] = [];
  let bare = 0;
  for (const f of reading.frames) {
    if (f.wall < gestureWall) continue;
    const whole = classifyFrame(f, palette);
    if (showsBareHole(whole)) bare += 1;
    const i = sampleIndexAt(samples, f.wall);
    if (i < 0 || samples[i].placeholder === null) continue;
    // The card is judged where the host has it: its view is the card, the
    // shell's stand-in a model the user never sees, so the question is
    // whether the card's own paint fills the view, inset by its apron.
    const held = presentedAt(presented, f.wall);
    const box = intersect(
      held === null
        ? samples[i].placeholder!
        : { x: held.x + CARD_APRON_PX, y: held.y + CARD_APRON_PX, width: held.width - 2 * CARD_APRON_PX, height: held.height - 2 * CARD_APRON_PX },
      crop,
    );
    const region = {
      x: (box.x - crop.x + CORNER_INSET_PX) * scale,
      y: (box.y - crop.y + CORNER_INSET_PX) * scale,
      width: (box.width - 2 * CORNER_INSET_PX) * scale,
      height: (box.height - 2 * CORNER_INSET_PX) * scale,
    };
    if (!(region.width > 0 && region.height > 0)) continue;
    const inMotion = moved(i) && moved(i - 1) && framesDiffer(f, standing);
    const entry = { frame: classifyFrame(f, palette, 8, region), whole, path: f.path, inMotion };
    judged.push(entry);
    bars.set(entry, barFor(box));
  }
  const motion = judged.filter((j) => j.inMotion);
  // Floor is canvas paint that carries the grid: a body that lost focus
  // recedes toward the canvas colour, but no body draws the grid's lines.
  // And it is mostly canvas with the lines through it: a box that reads as
  // grid with no canvas around it is a neighbouring pane's surface, which a
  // DOM rect judged under fast travel reaches past the shell's paint lag.
  const floorOf = (j: Judged): number =>
    (j.frame.grid > 0.002 && j.frame.canvas >= j.frame.grid ? j.frame.canvas + j.frame.grid : 0) + j.frame.bare;
  const floorOffenders = motion.filter((j) => floorOf(j) > (bars.get(j) ?? floorBar));
  let tracked = 0;
  let worstTrackPx = 0;
  for (const p of presented) {
    const i = sampleIndexAt(samples, p.wall);
    if (!(moved(i) && moved(i - 1))) continue;
    const at = viewAt(samples, p.wall);
    if (at === null) continue;
    tracked += 1;
    worstTrackPx = Math.max(worstTrackPx, edgeGap(p.frame, at));
  }
  const trackBarPx = 2 * fastestStep;
  const pct = (v: number): string => (v * 100).toFixed(2) + "%";
  const worstFloor = motion.length > 0 ? motion.reduce((a, b) => (floorOf(b) > floorOf(a) ? b : a)) : null;
  note(
    `${label}: ${samples.length} shell samples, ${movingSamples} with the placeholder moving (fastest step ${fastestStep.toFixed(1)} px), ${lidOnWhileMoving} of those with the lid on; ` +
      `${judged.length} frames captured, ${motion.length} judged in motion` +
      (worstFloor === null ? "" : `; the most floor in the content box ${pct(floorOf(worstFloor))} at ${Math.round(worstFloor.frame.t)} ms (${describeFrames([worstFloor.frame])}), bar ${pct(floorBar)}`) +
      `; ${bare} show a bare hole; host read ${presented.length} times, ${tracked} while the chrome moved, worst edge gap to the placeholder ${worstTrackPx.toFixed(1)} px (bar ${trackBarPx.toFixed(1)} px)`,
  );
  if (floorOffenders.length > 0) note(`${label}: frames where the content box shows the floor\n${describeFrames(floorOffenders.map((j) => j.frame))}`);
  return { motion: motion.length, floorOffenders, floorBar, bare, lidOnWhileMoving, movingSamples, fastestStep, tracked, worstTrackPx, trackBarPx };
}

/**
 * The share of host ticks on which the sampled body's presentation moved,
 * over the span the host moved it: from the first tick off its opening
 * position to the last tick short of its closing one. A stall inside the
 * motion — the render server not advancing the layer — is a tick that did
 * not move.
 */
export function advancedRatio(samples: readonly { t: number; x: number; y: number }[]): { ratio: number; ticks: number; spanMs: number } {
  if (samples.length < 3) return { ratio: 0, ticks: samples.length, spanMs: 0 };
  const same = (a: { x: number; y: number }, b: { x: number; y: number }): boolean => a.x === b.x && a.y === b.y;
  const first = samples.findIndex((s) => !same(s, samples[0]));
  let last = -1;
  for (let i = samples.length - 1; i >= 0; i--) {
    if (!same(samples[i], samples[samples.length - 1])) {
      last = i + 1;
      break;
    }
  }
  if (first < 0 || last <= first) return { ratio: 0, ticks: 0, spanMs: 0 };
  let moved = 0;
  let pairs = 0;
  for (let i = first; i <= last; i++) {
    pairs += 1;
    if (!same(samples[i], samples[i - 1])) moved += 1;
  }
  return { ratio: moved / pairs, ticks: pairs, spanMs: samples[last].t - samples[first - 1].t };
}

/**
 * How long a carried gesture's composite burst and host frame meter run: a
 * settle runs about 400 ms, so this covers its set-up, motion and land with
 * room, and the leg waits it out before reading the meter.
 */
const CARRY_BURST_MS = 1_500;
/** How long a carried gesture's settle may take. */
const CARRY_SETTLE_MS = 6_000;
/** The share of host ticks the presentation must advance on across its motion. */
const ADVANCED_BAR = 0.95;
/** How far the container may stand from the placeholder at rest, in px: the pixel. */
const REST_PX = 1;

/** The container, presented and placed, stands on the placeholder to the pixel. */
export async function expectPresentedAtRest(app: App, cardId: string, label: string): Promise<void> {
  const placeholder = await viewRectOf(app, cardId);
  const body = (await bodyOf(app, cardId)) as (Awaited<ReturnType<typeof bodyOf>> & { presentedFrame?: Rect; beatsPlanId?: number | null }) | null;
  expect(placeholder, `${label}: the placeholder stands`).not.toBeNull();
  expect(body?.presentedFrame, `${label}: the host reports a presented frame`).toBeDefined();
  const placed = edgeGap(placeholder!, body!.frame);
  const presented = edgeGap(placeholder!, body!.presentedFrame!);
  note(`${label}: placeholder ${JSON.stringify(placeholder)}; presented ${JSON.stringify(body!.presentedFrame)}; placed gap ${placed.toFixed(2)} px, presented gap ${presented.toFixed(2)} px; beats ${body!.beatsPlanId}`);
  expect(placed, `${label}: the placed container stands on the placeholder to the pixel`).toBeLessThanOrEqual(REST_PX);
  expect(presented, `${label}: the presented container stands on the placeholder to the pixel`).toBeLessThanOrEqual(REST_PX);
  expect(body!.beatsPlanId ?? null, `${label}: no beats are left running`).toBeNull();
}

/**
 * One gesture that moves body cards without resizing them, judged as the
 * host carrying them: arm the shell's sampler, the host's display link on
 * `card`'s container and the composite burst over `crop`; run `js`; read the
 * host's presented frame until the settle is over; then judge. `onSettled`
 * runs the moment the settle is seen over, before anything else is read, for
 * a row that reads what happened under the settle while it is fresh.
 */
export async function carryLeg(
  app: App,
  card: string,
  moved: readonly string[],
  label: string,
  js: string,
  standing: Standing,
  crop: Rect,
  onSettled?: () => Promise<void>,
): Promise<void> {
  const before = await expectAtRest(app, card, `${label}: before`);
  const runsBefore = (await planDiag(app)).runs;
  await armSampler(app, card);
  const meter = (await app.hostFrames({ op: "arm", windowMs: CARRY_BURST_MS, layer: card })) as { armed: true };
  expect(meter.armed, `${label}: the host's frame meter armed`).toBe(true);
  await app.captureBurst({ op: "arm", durationMs: CARRY_BURST_MS, intervalMs: BURST_INTERVAL_MS, crop });
  const gestureWall = Date.now();
  await app.evalJS<null>(`(${js}, null)`);
  let polling = true;
  const presentedRead = pollPresented(app, card, () => !polling, CARRY_SETTLE_MS + 2_000);
  const settle = await settleFor(() => samplerState(app), (s) => s.saw && !s.now, CARRY_SETTLE_MS);
  polling = false;
  const presented = await presentedRead;
  note(`${label}: settle seen ${settle.saw}, running ${settle.now}`);
  await onSettled?.();

  const plan = await settleFor(
    () => planDiag(app),
    (p) => p.runs > runsBefore && moved.every((id) => p.last?.landed.some((l) => l.cardId === id) ?? false),
    3_000,
  );
  note(`${label}: ${plan.runs - runsBefore} plan run(s); last plan ${JSON.stringify(plan.last)}`);
  for (const id of moved) note(`${label}: ${id} came to rest at ${JSON.stringify(await rectOf(app, placeholderOf(id)))}`);
  for (const id of moved) {
    expect(plan.last?.planned.includes(id), `${label}: ${id} is carried by the host`).toBe(true);
    expect(plan.last?.landed.some((l) => l.cardId === id), `${label}: the host said ${id} landed`).toBe(true);
  }
  expect(plan.last?.cancelled ?? [], `${label}: no carried body was cancelled`).toEqual([]);

  // The body card the gesture focused away from is focused again, so the
  // landed frame reads as the body's own paint.
  await focusBody(app, card, { composer: false });
  await Bun.sleep(300);
  const after = await expectAtRest(app, card, `${label}: after`);
  for (const id of moved) await expectPresentedAtRest(app, id, `${label}: ${id} at rest`);
  const travelled = edgeGap(before, after);
  note(`${label}: ${card} travelled ${travelled.toFixed(1)} px`);
  expect(travelled, `${label}: the gesture moved the card`).toBeGreaterThan(20);

  const samples = await readSampler(app);
  const reading = await settleFor(() => app.captureBurst({ op: "read" }) as Promise<CaptureBurstReading>, (r) => r.done, CARRY_BURST_MS + 5_000);
  expect(reading.done, `${label}: the burst finished`).toBe(true);
  const v = judgeCarried(label, reading, samples, presented, gestureWall, before, after, standing.palette, crop);
  expect(v.motion, `${label}: frames were captured while the chrome moved`).toBeGreaterThan(3);
  expect(v.lidOnWhileMoving, `${label}: the card stays posted shown in every sample where the frame moved`).toBe(0);
  expect(v.bare, `${label}: no frame shows the bare window`).toBe(0);
  expect(v.floorOffenders.length, `${label}: on every frame where the chrome moves the body fills its content box`).toBe(0);
  expect(v.tracked, `${label}: the host was read while the chrome moved`).toBeGreaterThan(0);
  expect(v.worstTrackPx, `${label}: the host's container stands within two frames of travel of the placeholder`).toBeLessThanOrEqual(v.trackBarPx);

  const wait = gestureWall + CARRY_BURST_MS + 150 - Date.now();
  if (wait > 0) await Bun.sleep(wait);
  const host = (await app.hostFrames({ op: "read" })) as HostFrameReading;
  const advance = advancedRatio(host.samples ?? []);
  note(
    `${label}: host ticks ${host.ticks}/${host.expectedTicks}, missed ${host.missed}, worst gap ${host.worstGapMs.toFixed(1)} ms, period ${host.periodMs.toFixed(2)} ms; ` +
      `${card}'s presentation moved on ${(advance.ratio * 100).toFixed(1)}% of ${advance.ticks} ticks over ${advance.spanMs.toFixed(0)} ms`,
  );
  expect(advance.ticks, `${label}: the host saw ${card}'s presentation move`).toBeGreaterThan(3);
  expect(advance.ratio, `${label}: ${card}'s presentation advanced on at least ${ADVANCED_BAR * 100}% of host ticks across its motion`).toBeGreaterThanOrEqual(ADVANCED_BAR);
}

/**
 * Make a gesture without judging it — the set-up for a leg that reads its
 * inverse — and wait for its settle to be over and `card` at rest, focused.
 */
export async function setUpGesture(app: App, card: string, label: string, run: (app: App) => Promise<unknown>): Promise<void> {
  await armSampler(app, card);
  await run(app);
  const settle = await settleFor(() => samplerState(app), (v) => v.saw && !v.now, CARRY_SETTLE_MS);
  note(`${label} (set-up): settle seen ${settle.saw}, running ${settle.now}`);
  await focusBody(app, card, { composer: false });
  await Bun.sleep(300);
  await expectAtRest(app, card, `${label} (set-up): after`);
}

/** The palette from `card`'s standing body, and a crop across the window at its content box's top. */
export async function standUp(app: App, card: string): Promise<{ standing: Standing; crop: Rect }> {
  const start = await expectAtRest(app, card, `${card}: at the start`);
  const standing = await readStanding(app, card, start);
  const frame = (await rectOf(app, frameOf(card)))!;
  const crop = { x: 0, y: Math.floor(frame.y), width: standing.contentWidth, height: Math.min(320, Math.floor(start.y + start.height - frame.y)) };
  note(`${card}: crop ${JSON.stringify(crop)} at scale ${standing.scale}`);
  return { standing, crop };
}
