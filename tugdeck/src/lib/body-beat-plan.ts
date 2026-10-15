/**
 * body-beat-plan.ts — the beat plan: what a settle tells the host so a body
 * moves with its chrome.
 *
 * A body card's content is its own web view, beneath the shell page and
 * placed by the host (`body-placement.ts`), so a chrome beat that carries a
 * pane carries only the pane's chrome: the body under it stays where it was
 * placed. The beat plan closes that gap. At the moment a settle plans its
 * chrome beats it posts the host one `beatPlan`: for each body inside a
 * carried frame, the viewport rect it starts and ends each beat at, the
 * beat's timing on the one clock both sides share, and the progress samples
 * the chrome beat itself was built from. The host runs those as Core
 * Animation on the body's container, so the render server moves body and
 * chrome on the same curve from the same start.
 *
 * Everything here is pure and reads no DOM: the settle engine and the placer
 * gather the inputs, and this module decides who is planned and where each
 * beat goes.
 *
 * ## The rect walk
 *
 * A body's placeholder fills its pane's content box, so its viewport rect is
 * its frame's visual rect inset by a constant: masthead and border on top,
 * border on the other three sides. The planner walks each frame's beats in
 * order with a running frame rect that starts at First, applies each beat's
 * terms to it, and insets the rect before and after each beat to give the
 * body's `from` and `to`. The walk must land on the frame's Last rect, or the
 * body is refused: a plan that ends somewhere other than where the chrome
 * ends would leave the body off its pane.
 *
 * ## Who is planned
 *
 * A body is planned only when it was placed visible, is still shown, stands
 * in a carried frame, and every beat of that frame maps to a rect. Anything
 * else is refused, and the caller hides a refused body under its frame for
 * the motion, as it did before there was a plan. A body that arrives,
 * departs, folds or parks is never planned: the commit-time hide and the lid
 * keep those.
 *
 * ## Units
 *
 * Every rect a plan carries is viewport px, which is what the host places in.
 * The settle engine measures in layout px (`layoutRectOf` divides every
 * component of a client rect by the page-zoom factor), so the caller scales
 * its First and Last rects to viewport px with {@link viewportRect}, and the
 * planner scales the terms' sizes by the same `factor`.
 *
 * Laws: [L06] the plan is appearance, computed in the settle's planning and
 * posted to the host, never React state; [D211] nothing here reads layout.
 */

import { type BodyPlacement, type PaneBox, type PlaceBodies, PANE_CLIP_REACH_PX } from "./body-placement";
import type { BeatKind, SettleTerms } from "./pane-flip";

// ---------------------------------------------------------------------------
// The wire form
// ---------------------------------------------------------------------------

/** A viewport rect, in px. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A keyword easing a two-sample beat (a fade) carries in place of samples. */
export type BeatEasing = "linear" | "ease" | "ease-in" | "ease-out" | "ease-in-out";

/** One beat of one body. */
export interface BodyBeat {
  readonly kind: BeatKind;
  /** From the plan's `startWallMs`, already scaled by `getTugTiming()`. */
  readonly delayMs: number;
  /** Scaled. */
  readonly durationMs: number;
  readonly from: Rect;
  readonly to: Rect;
  /** Start and end opacity; omitted means 1 → 1. */
  readonly opacity?: readonly [number, number];
  /** Evenly spaced in time, first 0 and last 1; may overshoot. Two values = a fade. */
  readonly progress: readonly number[];
  /** For a two-value `progress`: the chrome's keyword easing. */
  readonly easing?: BeatEasing;
}

/** One body's beats in a plan. */
export interface BodyBeats {
  readonly cardId: string;
  /** The viewport rect at rest after the plan: the host's model value. */
  readonly landing: Rect;
  /** Present when the body's box changes size. */
  readonly crossing?: { readonly width: number; readonly height: number };
  readonly beats: readonly BodyBeat[];
}

/** The `beatPlan` message body, shell → host. */
export interface BeatPlan {
  /** Monotonic per shell page. */
  readonly planId: number;
  /** `shellWallMs(T)`: the settle's t = 0 on the wall clock, ms. */
  readonly startWallMs: number;
  readonly bodies: readonly BodyBeats[];
}

/**
 * The wall-clock time of a document-timeline time `t`, in ms.
 *
 * `document.timeline.currentTime` is in `performance.now()` terms in a
 * WKWebView's main frame, so `performance.timeOrigin + t` is when `t` happens
 * on the wall clock, which is the one clock the host can also read. Every
 * conversion goes through here so there is one place to change it: if a
 * reading shows `performance.now()` drifting from `Date.now()` (a monotonic
 * clock that does not advance across sleep), the alternative is
 * `Date.now() + (t - performance.now())`, sampled at posting.
 */
export function shellWallMs(t: number): number {
  return performance.timeOrigin + t;
}

/** A layout-px rect from `layoutRectOf`, as viewport px at page-zoom `factor`: all four components, no origin term. */
export function viewportRect(layout: Rect, factor: number): Rect {
  return { x: layout.x * factor, y: layout.y * factor, width: layout.width * factor, height: layout.height * factor };
}

// ---------------------------------------------------------------------------
// The planner
// ---------------------------------------------------------------------------

/** How far two rects may differ and still be the same place, in px. */
const SAME_PX = 0.5;

/** One beat of a carried frame, as the settle engine scheduled it. */
export interface FrameBeat {
  readonly kind: BeatKind;
  /** The beat's FLIP terms, in layout px. Depart and arrive carry none that move the frame. */
  readonly terms: SettleTerms;
  readonly delayMs: number;
  readonly durationMs: number;
  readonly progress: readonly number[];
  readonly easing?: BeatEasing;
  readonly opacity?: readonly [number, number];
}

/** One frame a settle carries. */
export interface CarriedFrame {
  readonly paneId: string;
  /** The frame's visual rect before the settle, viewport px. */
  readonly first: Rect;
  /** Its rect at rest after it, viewport px. */
  readonly last: Rect;
  readonly beats: readonly FrameBeat[];
}

/** How far a body's placeholder stands inside its frame's visual rect, px. */
export interface Insets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface PlanInput {
  readonly frames: readonly CarriedFrame[];
  /** The placer's last posted placement. */
  readonly placement: PlaceBodies | null;
  readonly insets: ReadonlyMap<string, Insets>;
  /** Each carried pane's body cards: those whose placeholder it holds. */
  readonly bodiesInFrame: ReadonlyMap<string, readonly string[]>;
  /** Whether a body is still shown by the deck's facts (`hiddenSince`'s rule). */
  readonly stillShown: (cardId: string) => boolean;
  /** The page-zoom factor the terms' layout px scale by. */
  readonly factor: number;
  /** Whether a body whose box changes size is planned (with `crossing`) or refused. */
  readonly allowCrossing?: boolean;
}

export interface PlanOutput {
  readonly plan: BodyBeats[];
  /** Every body in a carried frame the planner did not plan, in frame order. */
  readonly refused: string[];
  /** Why each refused body was refused, for the trace. */
  readonly reasons: Readonly<Record<string, string>>;
}

function inset(r: Rect, i: Insets): Rect {
  return { x: r.x + i.left, y: r.y + i.top, width: r.width - i.left - i.right, height: r.height - i.top - i.bottom };
}

function sameRect(a: Rect, b: Rect): boolean {
  return (
    Math.abs(a.x - b.x) < SAME_PX &&
    Math.abs(a.y - b.y) < SAME_PX &&
    Math.abs(a.width - b.width) < SAME_PX &&
    Math.abs(a.height - b.height) < SAME_PX
  );
}

function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x - SAME_PX &&
    inner.y >= outer.y - SAME_PX &&
    inner.x + inner.width <= outer.x + outer.width + SAME_PX &&
    inner.y + inner.height <= outer.y + outer.height + SAME_PX
  );
}

/**
 * The frame's rect after one beat, from the rect before it. A beat that moves
 * the frame (`dx`, `dy` or a smear) takes it to Last's origin, top-left
 * anchored as `springSettleKeyframes` measures; a smear also takes Last's
 * width. A real `width` or `height` term takes the term's target, in viewport
 * px. A fade moves nothing.
 */
function applyBeat(running: Rect, beat: FrameBeat, last: Rect, factor: number): Rect {
  if (beat.kind === "depart" || beat.kind === "arrive") return running;
  const { dx, dy, sx = 1, width, height } = beat.terms;
  let next: Rect = running;
  if (dx !== 0 || dy !== 0 || sx !== 1) {
    next = { ...next, x: last.x, y: last.y };
    if (sx !== 1) next = { ...next, width: last.width };
  }
  if (width !== undefined) next = { ...next, width: width[1] * factor };
  if (height !== undefined) next = { ...next, height: height[1] * factor };
  return next;
}

/** A fade's opacity: the beat's own, or what its kind means. */
function opacityOf(beat: FrameBeat): readonly [number, number] | undefined {
  if (beat.opacity !== undefined) return beat.opacity;
  if (beat.kind === "depart") return [1, 0];
  if (beat.kind === "arrive") return [0, 1];
  return undefined;
}

/** The frame's beats in time order, its running rect before and after each, or why it cannot be walked. */
function walkFrame(frame: CarriedFrame, factor: number): { steps: { beat: FrameBeat; from: Rect; to: Rect }[] } | { reason: string } {
  if (frame.beats.length === 0) return { reason: "the frame carries no beat" };
  const ordered = [...frame.beats].sort((a, b) => a.delayMs - b.delayMs);
  let running = frame.first;
  const steps: { beat: FrameBeat; from: Rect; to: Rect }[] = [];
  for (const beat of ordered) {
    if (beat.progress.length < 2) return { reason: `a ${beat.kind} beat has fewer than two progress samples` };
    const to = applyBeat(running, beat, frame.last, factor);
    steps.push({ beat, from: running, to });
    running = to;
  }
  if (!sameRect(running, frame.last)) {
    return { reason: `the walk ends at ${JSON.stringify(running)}, not the frame's Last ${JSON.stringify(frame.last)}` };
  }
  return { steps };
}

/**
 * Plan the bodies a settle carries.
 *
 * A body is planned when it was placed visible, is still shown, stands in a
 * carried frame whose beats walk to the frame's Last rect, and its posted
 * rect lies inside the frame's First rect once inset (a stale placement is
 * refused rather than animated from the wrong place). Without
 * `allowCrossing`, a body whose box changes size is refused; with it, the
 * body carries `crossing` at its landing size. Every other body in a carried
 * frame is refused.
 */
export function planBodyBeats(input: PlanInput): PlanOutput {
  const plan: BodyBeats[] = [];
  const refused: string[] = [];
  const reasons: Record<string, string> = {};
  const refuse = (cardId: string, reason: string): void => {
    refused.push(cardId);
    reasons[cardId] = reason;
  };
  const posted = new Map<string, BodyPlacement>((input.placement?.bodies ?? []).map((b) => [b.cardId, b]));

  for (const frame of input.frames) {
    const cardIds = input.bodiesInFrame.get(frame.paneId) ?? [];
    if (cardIds.length === 0) continue;
    const walk = walkFrame(frame, input.factor);
    for (const cardId of cardIds) {
      if ("reason" in walk) {
        refuse(cardId, walk.reason);
        continue;
      }
      const placed = posted.get(cardId);
      if (placed === undefined || !placed.visible) {
        refuse(cardId, "not placed visible");
        continue;
      }
      if (!input.stillShown(cardId)) {
        refuse(cardId, "hidden since the placement");
        continue;
      }
      const insets = input.insets.get(cardId);
      if (insets === undefined) {
        refuse(cardId, "no insets");
        continue;
      }
      if (!contains(inset(frame.first, insets), placed)) {
        refuse(cardId, "its placement is not inside the frame's First rect");
        continue;
      }
      const beats: BodyBeat[] = walk.steps.map(({ beat, from, to }) => {
        const opacity = opacityOf(beat);
        return {
          kind: beat.kind,
          delayMs: beat.delayMs,
          durationMs: beat.durationMs,
          from: inset(from, insets),
          to: inset(to, insets),
          ...(opacity !== undefined ? { opacity } : {}),
          progress: beat.progress,
          ...(beat.easing !== undefined ? { easing: beat.easing } : {}),
        };
      });
      const start = beats[0].from;
      const landing = beats[beats.length - 1].to;
      const resized = Math.abs(landing.width - start.width) >= SAME_PX || Math.abs(landing.height - start.height) >= SAME_PX;
      if (resized && input.allowCrossing !== true) {
        refuse(cardId, "its box changes size");
        continue;
      }
      plan.push({
        cardId,
        landing,
        ...(resized ? { crossing: { width: landing.width, height: landing.height } } : {}),
        beats,
      });
    }
  }
  return { plan, refused, reasons };
}

// ---------------------------------------------------------------------------
// The moving back-pane cut
// ---------------------------------------------------------------------------

/**
 * The window of one beat on the plan's clock: the cut is keyed to the beat
 * that moves the geometry, one keyframe per progress sample.
 */
export interface CutBeat {
  readonly delayMs: number;
  readonly durationMs: number;
  readonly progress: readonly number[];
}

/** A pane that wears a cut: its box as last measured and, when it moves, its own beats (visual rects, viewport px). */
export interface CutPane {
  readonly box: PaneBox;
  readonly beats?: readonly BodyBeat[];
}

/** A front body over the pane: one that moves (its plan entry) or one that stands still (its rect). */
export type CutFront = BodyBeats | Rect;

/** One keyframe of the cut. */
export interface CutKeyframe {
  readonly offset: number;
  readonly clipPath: string;
}

/**
 * A carried frame's own visual rect, beat by beat, as {@link BodyBeat}s: the
 * walk {@link planBodyBeats} insets for its bodies, uninset, for a pane
 * whose cut has to move with it. Null when the walk misses the frame's Last,
 * where its bodies are refused too.
 */
export function frameRectBeats(frame: CarriedFrame, factor: number): BodyBeat[] | null {
  const walk = walkFrame(frame, factor);
  if ("reason" in walk) return null;
  return walk.steps.map(({ beat, from, to }) => ({
    kind: beat.kind,
    delayMs: beat.delayMs,
    durationMs: beat.durationMs,
    from,
    to,
    progress: beat.progress,
    ...(beat.easing !== undefined ? { easing: beat.easing } : {}),
  }));
}

/** A beat that changes its rect: one that moves or resizes it, not a fade. */
function movesGeometry(beat: BodyBeat): boolean {
  return beat.kind !== "depart" && beat.kind !== "arrive" && !sameRect(beat.from, beat.to);
}

/**
 * The window a pane's cut is keyed to, from every beat that moves the
 * geometry around it. One window when they all share it — a settle's move
 * beat, which is every carried motion today — keyed at its own samples, so
 * the cut between keyframes is linear exactly where the host's track is.
 * Beats on different windows span one window, sampled every display period
 * (`periodMs`, scaled time), which the cut then follows to within a
 * period's travel. Null when no beat moves anything.
 */
export function cutWindow(beats: readonly BodyBeat[], periodMs: number): CutBeat | null {
  const moving = beats.filter(movesGeometry);
  if (moving.length === 0) return null;
  const first = moving[0];
  if (moving.every((b) => b.delayMs === first.delayMs && b.durationMs === first.durationMs)) {
    return { delayMs: first.delayMs, durationMs: first.durationMs, progress: first.progress };
  }
  const start = Math.min(...moving.map((b) => b.delayMs));
  const end = Math.max(...moving.map((b) => b.delayMs + b.durationMs));
  const steps = Math.max(1, Math.ceil((end - start) / Math.max(1, periodMs)));
  return { delayMs: start, durationMs: end - start, progress: Array.from({ length: steps + 1 }, (_, i) => i / steps) };
}

/** Where a track's rect is at plan time `t`: the beat holding `t`, a held gap, or the ends. */
function rectAt(start: Rect, beats: readonly BodyBeat[], t: number): Rect {
  let rect = start;
  for (const beat of [...beats].sort((a, b) => a.delayMs - b.delayMs)) {
    if (t <= beat.delayMs) return rect;
    if (t >= beat.delayMs + beat.durationMs) {
      rect = beat.to;
      continue;
    }
    const p = progressAt(beat.progress, (t - beat.delayMs) / beat.durationMs);
    return lerpRect(beat.from, beat.to, p);
  }
  return rect;
}

/** A sampled curve's value at fraction `f` of its time, linear between samples. */
function progressAt(progress: readonly number[], f: number): number {
  const n = progress.length - 1;
  const at = Math.min(Math.max(f, 0), 1) * n;
  const i = Math.min(Math.floor(at), n - 1);
  return progress[i] + (progress[i + 1] - progress[i]) * (at - i);
}

function lerpRect(a: Rect, b: Rect, p: number): Rect {
  return {
    x: a.x + (b.x - a.x) * p,
    y: a.y + (b.y - a.y) * p,
    width: a.width + (b.width - a.width) * p,
    height: a.height + (b.height - a.height) * p,
  };
}

function frontAt(front: CutFront, t: number): Rect {
  if (!("beats" in front)) return front;
  const first = front.beats.length > 0 ? front.beats[0].from : front.landing;
  return rectAt(first, front.beats, t);
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function hasArea(r: Rect): boolean {
  return r.width > 0 && r.height > 0;
}

const n2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * An even-odd `path()` with the outer ring and exactly one rectangle per hole,
 * each clamped to `bounds` and kept even when the clamp leaves it no area, so
 * every keyframe of a cut has the same commands and `path()` interpolates.
 */
function constantCut(holes: readonly Rect[], bounds: Rect): string {
  const r = PANE_CLIP_REACH_PX;
  const sub = holes.map((h) => {
    const x1 = Math.min(Math.max(h.x, bounds.x), bounds.x + bounds.width);
    const y1 = Math.min(Math.max(h.y, bounds.y), bounds.y + bounds.height);
    const x2 = Math.max(x1, Math.min(h.x + h.width, bounds.x + bounds.width));
    const y2 = Math.max(y1, Math.min(h.y + h.height, bounds.y + bounds.height));
    return `M${n2(x1)} ${n2(y1)}H${n2(x2)}V${n2(y2)}H${n2(x1)}Z`;
  });
  return `path(evenodd, "M${-r} ${-r}H${r}V${r}H${-r}Z${sub.join("")}")`;
}

/**
 * The cut a pane wears while `beat` moves the geometry: one keyframe per
 * progress sample, each the outer ring plus one rectangle per front body,
 * mapped into the pane's own px from both rects at that sample. A front body
 * that has left the pane is clamped to zero area and kept, so the commands
 * never change between keyframes.
 *
 * `reachMs` widens each hole to every rect the front takes from `reachMs`
 * before its sample to `reachMs` after it. The cut is a main-thread
 * animation and the body and the chrome are the compositor's, so the cut
 * stands up to a frame off them in time; a reach of one display period
 * keeps the pane off the body whichever way it is off, at the cost of a
 * sliver of what lies beneath beside the body's edge, a period's travel at
 * most.
 *
 * `null` when no front body meets the pane at any sample: the pane needs no
 * cut. `"union"` when two front bodies overlap inside the pane at any sample,
 * where even-odd would cancel the doubly covered part: the caller wears
 * {@link sweptUnionCut} instead.
 */
export function paneCutKeyframes(pane: CutPane, fronts: readonly CutFront[], beat: CutBeat, reachMs = 0): CutKeyframe[] | "union" | null {
  const box = pane.box;
  if (!(box.width > 0 && box.height > 0 && box.layoutWidth > 0) || fronts.length === 0) return null;
  const zoom = box.width / box.layoutWidth;
  const paneStart: Rect = { x: box.x, y: box.y, width: box.width, height: box.height };
  // While a settle carries the pane its layout box is its Last one, and its
  // transform scales that box to the rect the walk has reached, axis by
  // axis; a pane whose size never changes keeps the zoom as its scale.
  const end = rectAt(paneStart, pane.beats ?? [], Infinity);
  const bounds: Rect = { x: 0, y: 0, width: end.width / zoom, height: end.height / zoom };
  const steps = beat.progress.length - 1;
  const frames: CutKeyframe[] = [];
  let meets = false;
  for (let i = 0; i <= steps; i++) {
    const offset = steps > 0 ? i / steps : 0;
    const t = beat.delayMs + offset * beat.durationMs;
    const at = rectAt(paneStart, pane.beats ?? [], t);
    const rects = fronts.map((f) => frontAt(f, t));
    const inside = rects.map((r) => {
      const x1 = Math.max(r.x, at.x);
      const y1 = Math.max(r.y, at.y);
      const x2 = Math.min(r.x + r.width, at.x + at.width);
      const y2 = Math.min(r.y + r.height, at.y + at.height);
      return { x: x1, y: y1, width: Math.max(0, x2 - x1), height: Math.max(0, y2 - y1) };
    });
    for (let a = 0; a < inside.length; a++) {
      if (!hasArea(inside[a])) continue;
      meets = true;
      for (let b = a + 1; b < inside.length; b++) {
        if (hasArea(inside[b]) && overlaps(inside[a], inside[b])) return "union";
      }
    }
    // Each hole in the pane's own px, swept across the reach either side.
    const holes = fronts.map((f, k) => {
      const spans = reachMs > 0 ? [t - reachMs, t, t + reachMs] : [t];
      const local = spans.map((s) => {
        const r = s === t ? rects[k] : frontAt(f, s);
        const p = s === t ? at : rectAt(paneStart, pane.beats ?? [], s);
        const sx = p.width / bounds.width;
        const sy = p.height / bounds.height;
        return { x1: (r.x - p.x) / sx, y1: (r.y - p.y) / sy, x2: (r.x + r.width - p.x) / sx, y2: (r.y + r.height - p.y) / sy };
      });
      const x1 = Math.min(...local.map((l) => l.x1));
      const y1 = Math.min(...local.map((l) => l.y1));
      return { x: x1, y: y1, width: Math.max(...local.map((l) => l.x2)) - x1, height: Math.max(...local.map((l) => l.y2)) - y1 };
    });
    frames.push({ offset, clipPath: constantCut(holes, bounds) });
  }
  return meets ? frames : null;
}

/**
 * The static cut a pane wears for a whole motion when the moving cut cannot
 * be keyframed: the swept union of each front body's First and Last rects
 * (the box spanning both, which holds every rect a straight walk between
 * them passes through), cut into disjoint cells so even-odd does not close
 * what two of them cover twice, in the pane's own px. `""` when nothing
 * meets the pane.
 */
export function sweptUnionCut(pane: PaneBox, fronts: readonly { readonly first: Rect; readonly last: Rect }[]): string {
  if (!(pane.width > 0 && pane.height > 0 && pane.layoutWidth > 0)) return "";
  const scale = pane.width / pane.layoutWidth;
  const swept = fronts.map(({ first, last }) => {
    const x1 = Math.min(first.x, last.x);
    const y1 = Math.min(first.y, last.y);
    const x2 = Math.max(first.x + first.width, last.x + last.width);
    const y2 = Math.max(first.y + first.height, last.y + last.height);
    return { x1, y1, x2, y2 };
  }).filter((r) => r.x2 > r.x1 && r.y2 > r.y1 && r.x1 < pane.x + pane.width && r.x2 > pane.x && r.y1 < pane.y + pane.height && r.y2 > pane.y);
  if (swept.length === 0) return "";
  const xs = [...new Set(swept.flatMap((r) => [r.x1, r.x2]))].sort((a, b) => a - b);
  const ys = [...new Set(swept.flatMap((r) => [r.y1, r.y2]))].sort((a, b) => a - b);
  const r = PANE_CLIP_REACH_PX;
  const sub: string[] = [];
  for (let j = 0; j + 1 < ys.length; j++) {
    for (let i = 0; i + 1 < xs.length; i++) {
      const cx = (xs[i] + xs[i + 1]) / 2;
      const cy = (ys[j] + ys[j + 1]) / 2;
      if (!swept.some((s) => cx > s.x1 && cx < s.x2 && cy > s.y1 && cy < s.y2)) continue;
      const hx1 = (xs[i] - pane.x) / scale;
      const hy1 = (ys[j] - pane.y) / scale;
      const hx2 = (xs[i + 1] - pane.x) / scale;
      const hy2 = (ys[j + 1] - pane.y) / scale;
      sub.push(`M${n2(hx1)} ${n2(hy1)}H${n2(hx2)}V${n2(hy2)}H${n2(hx1)}Z`);
    }
  }
  return `path(evenodd, "M${-r} ${-r}H${r}V${r}H${-r}Z${sub.join("")}")`;
}
