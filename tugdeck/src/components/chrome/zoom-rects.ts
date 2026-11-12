/**
 * zoom-rects — classic Mac OS zoom rectangles, and the one-slot rect stash the
 * two sides of a zoom use to find each other.
 *
 * The update pill and the `UpdateTug` wizard share no parent, and the pill
 * unmounts in the same commit that mounts the wizard ([F01]) — so whichever
 * side arrives cannot measure the side that left. This module is the answer to
 * both halves of that: a **stash** the departing side writes and the arriving
 * side claims ([B03]), and a **run** of outline rectangles from a source rect to
 * a destination rect ([B02]).
 *
 * # The stash
 *
 * One slot, written by {@link stashZoomRect} and taken by {@link claimZoomRect}.
 * A claim empties it. A stash nobody claims is swept one tick after it was
 * written, which is what keeps a refused pill click ([F04]) or a close with no
 * returning pill ([F05]) from planting a zoom on some unrelated later mount. One
 * tick — a task, not a microtask — because the claimant's layout effect runs
 * inside React's flush of the same event, and a microtask would fire before it.
 *
 * # The run
 *
 * A run of rectangles — {@link ZOOM_RECT_COUNT} of them — planted once each at
 * their own interpolated geometry, and turned on and off on a schedule.
 * That is the `pill` run; the `sheet` run travels instead, and `ZoomRunKind`
 * says why. In the pill's, **nothing interpolates position or size**
 * ([B01]): a discrete frame sequence is what the original Finder drew ([F08]),
 * and it sidesteps the trap a scale transform on a 1px border springs, where the
 * stroke thickens with the box. The only animated property is opacity.
 *
 * Every rectangle's effect is created in the **same frame**, each with its own
 * delay, rather than chained on the previous one's `finished` — the sequencing
 * shape `tug-animator.ts` documents, and the reason it scales a delay by the
 * timing setting exactly as it scales a duration. A chain would cost a frame at
 * every hand-off.
 *
 * Spacing is eased so the rectangles **bunch toward the destination** ([B02],
 * [F08]): the parameter slows as it approaches 1, so the last few frames land
 * almost on top of one another. Each rectangle fades out over the trail's
 * length, so at any instant three are up at descending opacity and the leading
 * edge is the brightest.
 *
 * # Where the layer lives
 *
 * The canvas overlay root, which is also where the pill portals and where
 * `update-tug.tsx` points its Radix portal — so the layer, the scrim and the
 * wizard panel are siblings in one stacking context, and the layer's 99992
 * clears the scrim's 99990 and the content's 99991 ([B08]). The root is
 * `position: fixed; inset: 0` inside the deck root, so a child positioned
 * from `left`/`top` is positioned in the root's layout px: the coordinates
 * `getBoundingClientRect()` reports, divided by View › Zoom's factor.
 *
 * The root owns the lifecycle too: the module watches the canvas overlay
 * registry, and a canvas that goes away takes any standing rectangles with it
 * ([B08]).
 *
 * # Reduced motion
 *
 * When `isTugMotionEnabled()` is false, or the timing scale is zero, the run
 * plants nothing and reports that it planted nothing ([B09]). The caller's
 * contract is that it then sets no `data-zoom`, so the CSS delay keyed on that
 * attribute never applies and the 0s-animation hazard [F07] records never
 * arises. The snap is the zoom.
 *
 * The rectangles are `pointer-events: none` and pure decoration: a run can be
 * dropped at any moment and nothing waits on it ([B06], D6).
 *
 * Laws: [L13] programmatic, multi-element motion goes through TugAnimator;
 * [L14] TugAnimator stays out of Radix's enter and exit lifecycle — this module
 * touches neither.
 *
 * @module components/chrome/zoom-rects
 */

import "./zoom-rects.css";

import * as canvasOverlayRegistry from "@/lib/canvas-overlay-registry";
import { afterGesture } from "@/lib/gesture-scope";
import { layoutPxOf } from "@/lib/page-zoom-store";

import { animate } from "../tugways/tug-animator";
import { getTugTiming, isTugMotionEnabled } from "@/lib/scale-timing";

// ---------------------------------------------------------------------------
// The run's constants
// ---------------------------------------------------------------------------

/**
 * How many rectangles a run plants.
 *
 * Ten rather than [B02]'s starting eight, settled by eye. At eight the first
 * step off the pill is a leap — the pill is 174pt wide and the panel 560, so
 * an eighth of that gap is a bigger jump than any later one looks like — and
 * ten closes it without the destination turning into a smear. It also lands
 * one rectangle per frame at the run's length: ten stations over twelve slots
 * of a 200ms run is a slot of about one display frame, which is what the
 * original was, a box redrawn each time round the loop.
 */
const ZOOM_RECT_COUNT = 10;

/**
 * How many rectangles are up at once. Each rectangle's fade runs for this many
 * slots, so the trail is this deep and its oldest member is its faintest.
 *
 * Three, [B02]'s value, kept: a frozen still of the live run shows three
 * distinct stations with a clean brightness ramp between them, which is the
 * trail the original had. Two reads as a pair rather than a trail, and more
 * than three on a 200ms run is a thicket.
 */
const ZOOM_TRAIL_DEPTH = 3;

/**
 * The bunching exponent. The rectangle at index `i` sits at
 * `t = 1 - (1 - i/(n-1))^ZOOM_EASE_POWER` between source and destination, so the
 * parameter's rate falls to zero at the destination and the last frames crowd
 * together there. `1` would be even spacing; higher bunches harder.
 *
 * 1.25, settled by eye, and a long way down from [B02]'s starting 2.2. The
 * evidence the starting value rested on is [F08], which the brief marks **not
 * verified** and which says two things at once — that the steps accelerated
 * toward the destination, and that they bunched there. Bunching is the one the
 * pictures answer: at 2.2 the run leaps off the pill and then piles its last
 * four boxes within a few points of the panel's edge, which reads as the
 * motion dying rather than arriving. At 1 the nesting is even and clean but
 * has no settle at all. 1.25 keeps a trace of the settle and none of the
 * stall.
 */
const ZOOM_EASE_POWER = 1.25;

/**
 * The whole run's unscaled length, in ms. One `moderate`, per [B02].
 *
 * Cross-reference: `--tugx-zoom-run-duration` in `zoom-rects.css` must carry
 * the same number — it is what the arriving surfaces delay their reveal by, and
 * the stylesheet is the only place that delay is read from. Nothing on the TS
 * side needs the figure, so nothing on the TS side publishes it.
 */
const ZOOM_RUN_DURATION_MS = 200;

/**
 * The two kinds of run, which are two different constructions.
 *
 * - `pill` — the update pill and wizard, drawn in **stations**: the figures
 *   above, a rectangle planted per display frame and turned on and off in
 *   turn, in the pill's accent stroke.
 * - `sheet` — the workspace naming sheet, drawn in **travel**: a lead
 *   rectangle and its echoes, each one element that really moves from the
 *   source's box to the destination's. This reverses [B01] for the sheet, on
 *   purpose. Its trip, from a sidebar control to a centred panel, is long and
 *   crosses a busy deck with no scrim behind it, and stations fail there in
 *   three ways no figure tunes out (tried on the user's deck at 400ms, 600ms
 *   and 450ms, 2026-11-12): position advances in jumps of tens of pixels; the
 *   station clock and the display's refresh are two unsynchronised 16.7ms
 *   ticks, so some frames light two boxes and some none, and a late frame
 *   swallows a station whole; and a lit box fades where it was planted, so
 *   the trail is residue behind the lead rather than something following it.
 *
 *   In travel, position is a function of time: every frame draws where each
 *   box is at that instant, at any refresh rate, and a late frame costs one
 *   longer step and leaves nothing stale. The echoes run the lead's own
 *   animation, each starting `lagMs` after the one ahead at a lower
 *   strength, so they start stacked on the source, spread at speed, close up
 *   as the lead slows, and land stacked on the destination — where the stack
 *   is the arriving panel's outline, and fades out as the panel fades in.
 *
 *   The box's `left`/`top`/`width`/`height` are what animate, not a scale
 *   transform, which would thicken and thin the stroke with the box. That is
 *   layout on every frame, for a handful of absolutely positioned boxes in
 *   the overlay page, which has nothing else to lay out.
 *
 *   Cross-reference: `--tugx-zoom-sheet-landing` in `zoom-rects.css` must
 *   equal the landing, `travelMs + lagMs * (strengths.length - 1)`.
 */
export type ZoomRunKind = "pill" | "sheet";

interface StationFigures {
  readonly style: "stations";
  readonly count: number;
  readonly durationMs: number;
  /** How many slots each rectangle is up for. */
  readonly trail: number;
  /** The spacing's bunching exponent; `1` is even. */
  readonly ease: number;
}

interface TravelFigures {
  readonly style: "travel";
  /** How long one rectangle takes from source to destination. */
  readonly travelMs: number;
  /** How far behind the one ahead each echo starts. */
  readonly lagMs: number;
  /** The lead's strength, then each echo's. Its length is how many travel. */
  readonly strengths: readonly number[];
  /** The stack's fade once the last echo has landed. */
  readonly fadeMs: number;
  /** The trip's pacing: off the source gently, onto the destination gently. */
  readonly easing: string;
}

const ZOOM_RUN_FIGURES: { readonly pill: StationFigures; readonly sheet: TravelFigures } = {
  pill: {
    style: "stations",
    count: ZOOM_RECT_COUNT,
    durationMs: ZOOM_RUN_DURATION_MS,
    trail: ZOOM_TRAIL_DEPTH,
    ease: ZOOM_EASE_POWER,
  },
  // Lands at 360 + 3 × 30 = 450ms; the fade is shorter than the panel's 150ms
  // fade-in so the stack is gone before the scrim, which waits on the panel.
  sheet: {
    style: "travel",
    travelMs: 360,
    lagMs: 30,
    strengths: [1, 0.6, 0.35, 0.15],
    fadeMs: 100,
    easing: "cubic-bezier(0.4, 0, 0.2, 1)",
  },
};

/** When a travelling run's last echo lands, unscaled. */
function landingMs(figures: TravelFigures): number {
  return figures.travelMs + figures.lagMs * (figures.strengths.length - 1);
}

/**
 * A run's whole unscaled length, in ms, to its last rectangle going out — for
 * a caller that sequences its own motion after the run. TugAnimator scales a
 * delay by the timing setting, so the figure is passed to it bare.
 */
export function zoomRunDurationMs(kind: ZoomRunKind): number {
  const figures = ZOOM_RUN_FIGURES[kind];
  return figures.style === "stations" ? figures.durationMs : landingMs(figures) + figures.fadeMs;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A viewport rectangle, in the coordinates `getBoundingClientRect()` reports.
 * The layer's `position: fixed; inset: 0` box positions its children in the
 * deck root's layout px, so the one conversion is where a run writes its
 * rectangles' styles (`layoutPxOf`).
 */
export interface ZoomRect {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

// ---------------------------------------------------------------------------
// The stash
// ---------------------------------------------------------------------------

let stashedRect: ZoomRect | null = null;
/** Bumped by every stash and claim, so a sweep only clears the stash it was armed for. */
let stashGeneration = 0;

/** Measure `el` and stash its rect for whichever side arrives next ([B03]). */
export function stashZoomRect(el: Element): void {
  const box = el.getBoundingClientRect();
  stashedRect = {
    top: box.top,
    left: box.left,
    width: box.width,
    height: box.height,
  };
  const generation = ++stashGeneration;
  // One task after the gesture's held React tells are released, not one task
  // after the stash: a pointer gesture holds the claimant's commit past the
  // next paint (`gesture-scope.ts`), so a sweep timed from the stash fires
  // before the claimant mounts and its claim finds nothing. Under no pending
  // scope `afterGesture` runs inline and this is one task, as before — not one
  // microtask, because the claimant's layout effect runs inside React's flush
  // of the event that stashed, and a microtask would beat it.
  afterGesture(() => {
    setTimeout(() => {
      if (generation === stashGeneration) stashedRect = null;
    }, 0);
  });
}

/**
 * Take the stashed rect, emptying the slot. Returns `null` when there is
 * nothing to claim, which is the ordinary case for a wizard raised by the Tug
 * menu or by Sparkle ([B04]) and for a pill mounting on its own.
 */
export function claimZoomRect(): ZoomRect | null {
  const claimed = stashedRect;
  stashedRect = null;
  stashGeneration += 1;
  return claimed;
}

// ---------------------------------------------------------------------------
// The layer
// ---------------------------------------------------------------------------

let layer: HTMLDivElement | null = null;
let unsubscribeFromCanvas: (() => void) | null = null;

/**
 * The run in flight, by token. A run that lands checks that it is still the
 * current one before it sweeps, so a run started while an older one was still
 * fading does not have its rectangles removed by the older one's completion.
 */
let runToken = 0;

/**
 * Create the layer on first use, parent it to the canvas overlay root, and
 * start watching the registry. Returns `null` when no root is registered —
 * there is no canvas to decorate, so there is no run.
 */
function ensureLayer(): HTMLDivElement | null {
  const root = canvasOverlayRegistry.getRoot();
  if (root === null) return null;
  if (layer !== null && layer.parentNode === root) return layer;
  if (layer !== null) layer.remove();
  const el = document.createElement("div");
  el.className = "tugx-zoom-rects-layer";
  el.dataset.slot = "zoom-rects";
  root.appendChild(el);
  layer = el;

  // A canvas that goes away takes any standing rectangles with it ([B08]). The
  // layer would go with the root's own removal, but the module's handle to it
  // has to be dropped too, and a run still in flight has to stop sweeping a
  // layer that is no longer anybody's.
  unsubscribeFromCanvas = canvasOverlayRegistry.subscribe(() => {
    if (canvasOverlayRegistry.getRoot() !== root) clearZoomRects();
  });

  return el;
}

/**
 * Remove every rectangle standing, and retire the layer. Called before a new
 * run plants, when a run lands, and when the canvas unmounts.
 */
export function clearZoomRects(): void {
  runToken += 1;
  if (layer !== null) {
    layer.remove();
    layer = null;
  }
  if (unsubscribeFromCanvas !== null) {
    unsubscribeFromCanvas();
    unsubscribeFromCanvas = null;
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** Linear interpolation between two numbers. */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * The eased parameter for the rectangle at `index` of `count`. Runs 0 → 1, with
 * its rate falling to zero at 1 so the frames bunch at the destination.
 */
function bunchedParameter(index: number, count: number, power: number): number {
  const u = count <= 1 ? 1 : index / (count - 1);
  return 1 - Math.pow(1 - u, power);
}

/**
 * Run the rectangles from `from` to `to`.
 *
 * Returns `true` when rectangles were planted and `false` when reduced motion or
 * a zero timing scale means the run is a no-op ([B09]) — the caller uses the
 * answer to decide whether to set `data-zoom` on the arriving element.
 *
 * Pure decoration: nothing is returned to await, and dropping the run costs the
 * caller nothing ([B06]).
 */
export function runZoomRects(from: ZoomRect, to: ZoomRect, kind: ZoomRunKind = "pill"): boolean {
  if (!isTugMotionEnabled()) return false;
  const timing = getTugTiming();
  if (timing === 0) return false;

  // A new run clears whatever the last one left standing ([B08]). This bumps
  // the token, so the token read below is the new run's.
  clearZoomRects();
  const host = ensureLayer();
  if (host === null) return false;
  const token = runToken;
  host.dataset.kind = kind;
  const figures = ZOOM_RUN_FIGURES[kind];

  const finishes =
    figures.style === "stations" ? plantStations(host, from, to, figures) : plantTravel(host, from, to, figures);

  void Promise.allSettled(finishes).then(() => {
    if (runToken === token) clearZoomRects();
  });

  return true;
}

/** A rectangle element for the layer, not yet placed. */
function makeRect(index: number): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "tugx-zoom-rect";
  el.dataset.slot = "zoom-rect";
  el.dataset.index = String(index);
  return el;
}

/** `rect` as the four inline lengths a rectangle is placed with, in layout px. */
function placement(rect: ZoomRect): { left: string; top: string; width: string; height: string } {
  return {
    left: `${layoutPxOf(rect.left)}px`,
    top: `${layoutPxOf(rect.top)}px`,
    width: `${layoutPxOf(rect.width)}px`,
    height: `${layoutPxOf(rect.height)}px`,
  };
}

/** The `pill` construction: a rectangle per station, lit in turn. */
function plantStations(host: HTMLElement, from: ZoomRect, to: ZoomRect, figures: StationFigures): Promise<void>[] {
  const { count, durationMs, trail, ease } = figures;

  // The run's unscaled clock, in slots. A rectangle lights at its own slot and
  // is gone `trail` slots later, so the last one goes out at slot
  // `count - 1 + trail` and the whole run is that many slots long.
  const slotCount = count - 1 + trail;
  const slotMs = durationMs / slotCount;
  const lifeMs = slotMs * trail;

  const rects: HTMLDivElement[] = [];
  for (let i = 0; i < count; i += 1) {
    const t = bunchedParameter(i, count, ease);
    const el = makeRect(i);
    Object.assign(
      el.style,
      placement({
        left: lerp(from.left, to.left, t),
        top: lerp(from.top, to.top, t),
        width: lerp(from.width, to.width, t),
        height: lerp(from.height, to.height, t),
      }),
    );
    host.appendChild(el);
    rects.push(el);
  }

  // Every effect is created here, in this frame, each holding itself off with
  // its own delay. The stylesheet's `opacity: 0` is what the rectangle wears
  // while it waits — the animation fills forwards only, so nothing paints
  // before its slot arrives, and the frame's arrival is the discrete pop the
  // original had rather than a fade-in.
  return rects.map(
    (el, i) =>
      animate(el, [{ opacity: 1 }, { opacity: 0 }], {
        duration: lifeMs,
        delay: i * slotMs,
        easing: "linear",
      }).finished,
  );
}

/** The `sheet` construction: a lead and its echoes, each travelling the whole trip. */
function plantTravel(host: HTMLElement, from: ZoomRect, to: ZoomRect, figures: TravelFigures): Promise<void>[] {
  const { travelMs, lagMs, strengths, fadeMs, easing } = figures;
  const start = placement(from);
  const end = placement(to);
  const landing = landingMs(figures);

  // Faintest first, so the lead paints over its echoes where they stack.
  const finishes: Promise<void>[] = [];
  for (let i = strengths.length - 1; i >= 0; i -= 1) {
    const el = makeRect(i);
    Object.assign(el.style, start);
    host.appendChild(el);

    // The trip. `both`: on the source through its own lag, on the destination
    // from its landing until the layer is retired.
    animate(el, [start, end], { duration: travelMs, delay: i * lagMs, easing, fill: "both" }).finished.catch(() => {
      /* a run dropped mid-trip is nothing to report */
    });

    // The strength. `both` again: its own strength from the first frame, over
    // the stylesheet's resting `opacity: 0`, until the whole stack has landed;
    // then every member fades together.
    finishes.push(
      animate(el, [{ opacity: strengths[i] }, { opacity: 0 }], {
        duration: fadeMs,
        delay: landing,
        easing: "linear",
        fill: "both",
      }).finished,
    );
  }
  return finishes;
}
