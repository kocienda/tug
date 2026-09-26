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
 * **Nothing interpolates position or size**
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
 * `position: fixed; inset: 0`, so a child positioned from `left`/`top` is
 * positioned in the very coordinates `getBoundingClientRect()` reports.
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

import { animate } from "../tugways/tug-animator";
import { getTugTiming, isTugMotionEnabled } from "../tugways/scale-timing";

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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A viewport rectangle, in the coordinates `getBoundingClientRect()` reports —
 * which are also the coordinates the layer's `position: fixed; inset: 0` box
 * positions its children in, so no conversion happens anywhere.
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
let sweepTimer: ReturnType<typeof setTimeout> | null = null;

/** Measure `el` and stash its rect for whichever side arrives next ([B03]). */
export function stashZoomRect(el: Element): void {
  const box = el.getBoundingClientRect();
  stashedRect = {
    top: box.top,
    left: box.left,
    width: box.width,
    height: box.height,
  };
  if (sweepTimer !== null) clearTimeout(sweepTimer);
  // One task later, not one microtask: the claimant's layout effect runs inside
  // React's flush of the very event that stashed, and a microtask would beat it.
  sweepTimer = setTimeout(() => {
    sweepTimer = null;
    stashedRect = null;
  }, 0);
}

/**
 * Take the stashed rect, emptying the slot. Returns `null` when there is
 * nothing to claim, which is the ordinary case for a wizard raised by the Tug
 * menu or by Sparkle ([B04]) and for a pill mounting on its own.
 */
export function claimZoomRect(): ZoomRect | null {
  const claimed = stashedRect;
  stashedRect = null;
  if (sweepTimer !== null) {
    clearTimeout(sweepTimer);
    sweepTimer = null;
  }
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
function bunchedParameter(index: number, count: number): number {
  const u = count <= 1 ? 1 : index / (count - 1);
  return 1 - Math.pow(1 - u, ZOOM_EASE_POWER);
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
export function runZoomRects(from: ZoomRect, to: ZoomRect): boolean {
  if (!isTugMotionEnabled()) return false;
  const timing = getTugTiming();
  if (timing === 0) return false;

  // A new run clears whatever the last one left standing ([B08]). This bumps
  // the token, so the token read below is the new run's.
  clearZoomRects();
  const host = ensureLayer();
  if (host === null) return false;
  const token = runToken;

  // The run's unscaled clock, in slots. A rectangle lights at its own slot and
  // is gone `ZOOM_TRAIL_DEPTH` slots later, so the last one goes out at slot
  // `count - 1 + trail` and the whole run is that many slots long.
  const slotCount = ZOOM_RECT_COUNT - 1 + ZOOM_TRAIL_DEPTH;
  const slotMs = ZOOM_RUN_DURATION_MS / slotCount;
  const lifeMs = slotMs * ZOOM_TRAIL_DEPTH;

  const rects: HTMLDivElement[] = [];
  for (let i = 0; i < ZOOM_RECT_COUNT; i += 1) {
    const t = bunchedParameter(i, ZOOM_RECT_COUNT);
    const el = document.createElement("div");
    el.className = "tugx-zoom-rect";
    el.dataset.slot = "zoom-rect";
    el.dataset.index = String(i);
    el.style.left = `${lerp(from.left, to.left, t)}px`;
    el.style.top = `${lerp(from.top, to.top, t)}px`;
    el.style.width = `${lerp(from.width, to.width, t)}px`;
    el.style.height = `${lerp(from.height, to.height, t)}px`;
    host.appendChild(el);
    rects.push(el);
  }

  // Every effect is created here, in this frame, each holding itself off with
  // its own delay. The stylesheet's `opacity: 0` is what the rectangle wears
  // while it waits — the animation fills forwards only, so nothing paints
  // before its slot arrives, and the frame's arrival is the discrete pop the
  // original had rather than a fade-in.
  const finishes = rects.map((el, i) =>
    animate(el, [{ opacity: 1 }, { opacity: 0 }], {
      duration: lifeMs,
      delay: i * slotMs,
      easing: "linear",
    }).finished,
  );

  void Promise.allSettled(finishes).then(() => {
    if (runToken === token) clearZoomRects();
  });

  return true;
}
