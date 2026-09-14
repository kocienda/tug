/**
 * TugSparkline — a stock-ticker activity graph.
 *
 * Two rules, like ticker tape:
 *  1. Values are NEVER revised. A point, once shown, is permanent; the pen
 *     holds the newest value flat to the right edge (the geometry's held
 *     tail), so the line is always full edge to edge without ever stopping
 *     short — a quiet stretch is the held value, not a gap.
 *  2. New samples write at the right edge and scroll left at a constant rate.
 *
 * THE DATA EVENT IS THE ONLY CLOCK. The tape never polls: the caller's
 * `subscribeActivity` channel fires synchronously when data records, and
 * every point the tape appends is downstream of one of those events. The
 * only timers are finishers for work an event started, and each terminates
 * by construction: a settle burst that keeps sampling at {@link SAMPLE_MS}
 * until the plotted value stops moving (a rate's rolling window draining to
 * baseline after the last datum — it empties in ~1s; a held gauge settles
 * on the first tick), and one flat-off timeout that retires the scroll once
 * the last change has scrolled fully off screen. An idle tape holds zero
 * timers and zero animations because nothing is running, not because
 * something detected quiet.
 *
 * The scroll is a single continuous WAAPI `translateX` composited on the
 * GPU (Smoothie Charts' time→x mapping, adapted off its rAF loop — see
 * THIRD_PARTY_NOTICES.md, MIT). There is no per-frame redraw loop: between
 * appends the compositor does the motion. The animation is created ONCE per
 * mount and never recreated; each epoch the scroll time-rebases by writing
 * `startTime`, so coordinates stay bounded without any teardown.
 *
 * ONE CLOCK. The tape's own axis and the scroll's position are the same
 * function of `performance.now()`. The animation's origin is written from the
 * very clock reading the tape starts with, which is what makes the time→x map
 * in `lib/sparkline-geometry.ts` and the transform agree exactly rather than by
 * accident — a pending start time, resolved at some later rendering update,
 * used to leave a per-instance horizontal offset for a whole epoch. Wall clock
 * survives at exactly one named seam inside `SparklineTape`, because the
 * activity meters bin on absolute wall-clock indices and that is what decays a
 * stalled stream to baseline.
 *
 * THE SCROLL NEVER MOVES AHEAD OF ITS PIXELS — AND THE PIXELS NEVER BLANK
 * BEHIND THE SCROLL. An origin change is painted first and applied only when
 * the surface acknowledges those pixels exist — one path, no fast path, with
 * a watchdog so a lost acknowledgement cannot freeze (or, on a wake,
 * permanently pause) the tape. The proposal is drawn WITHOUT clearing, into
 * its own region of the canvas, so the picture the unmoved transform is
 * showing survives the whole acknowledgement window; ordinary paints hold
 * their fire meanwhile and the commit flushes them. And a stopped scroll is
 * never resumed from its held position — the clock ran on while it was
 * paused — it is RE-REGISTERED by writing the committed origin back as the
 * animation's start time. The full protocol is Spec S01, in
 * `lib/sparkline-tape.ts`.
 *
 * WHERE THE POLICY IS. Everything above is a statement about *when* — when to
 * append, when to stop, when the epoch rebases, when the tape may go inert.
 * None of it needs the DOM, and all of it is in `lib/sparkline-tape.ts`, which
 * this component drives through a {@link SparklineSurface}. What is left here
 * is the surface itself: claiming the canvas, the WAAPI scroll, the visibility
 * gate, resolving colours from computed style, and the worker wiring.
 *
 * TWO DORMANCIES, NOT ONE (Spec S02). *Flat dormancy* is the no-event state:
 * once every recognized change has scrolled off, a scrolling line that isn't
 * changing is pixel-identical to a static one, so the scroll stops and the tape
 * is inert until the next event. Change is judged in PLOT PIXELS
 * ({@link DEADBAND_PX} against the value at the last recognized change), so a
 * gauge holding a steady level — or jittering beneath what the plot can draw —
 * is as dormant as a zero rate; the reference only advances on recognized
 * change, so slow drift accumulates and eventually trips it rather than
 * ratcheting under the threshold forever.
 *
 * *Hidden pause* is different in kind: the element is off screen, so the
 * picture is ARBITRARY rather than flat, and the tape is stopped WITHOUT being
 * disturbed — no origin move, no repaint, no rebuild. Collapsing the two is
 * what made the Cards card judder, because its rows cross the intersection boundary
 * constantly and each crossing rebased a picture that could not survive being
 * translated. The gate accordingly observes the nearest scroll container with a
 * generous margin and waits out a flap before believing it.
 *
 * Neither dormancy delays real activity: the wake rebuilds the tape from the
 * caller's own binned history in the tick the event fires, and re-registers
 * through the same acknowledged path. (Rule 1's "values are never revised"
 * applies to the on-screen tape; a dormant rebuild reconstructs state nobody
 * was shown.)
 *
 * REGISTRATION IS VERIFIED, NOT ASSUMED. On each live tick — and only while the
 * document is visible, because a stalled timeline would otherwise turn the cure
 * into a 4 Hz rebase storm — the scroll's actual position is compared against
 * the clock's. A sub-pixel divergence is ignored, a tiny one is corrected in
 * place, and anything the eye could catch goes back through the acknowledged
 * path.
 *
 * The sampled value is a rolling ~1s output rate, so it rises smoothly with
 * activity and falls to zero (baseline) when output stops.
 *
 * WHERE THE PIXELS ARE MADE. The tape is a `<canvas>` whose context is
 * transferred to a shared render worker, so the four-times-a-second geometry
 * write happens off the main thread and commits to the compositor without
 * waking the page. The geometry itself lives in `lib/sparkline-geometry.ts` and
 * is shared with the on-main fallback, so there is only ever one staircase
 * implementation. Control may be transferred once per element, so the canvas
 * is keyed on its geometry AND the live device pixel ratio: a resolution change
 * arrives as a new element, and the claim that follows repaints immediately so
 * no idle tape is left blank by it.
 *
 * Laws: [L13] motion is a WAAPI transform, never an rAF/timer-driven frame
 *       loop (the timer samples data, it does not animate); [L06] appearance
 *       is painted and DOM-attributed — the one piece of React state here is
 *       the device pixel ratio, which is STRUCTURE ([L24]: it decides which
 *       canvas element exists, not how anything looks); [L03] setup in
 *       `useLayoutEffect`; [L19] `.tsx`/`.css` pair; [L21] adapted algorithm
 *       noticed; [L26] a spent canvas is replaced by `key`, never
 *       re-transferred; [L27] the worker entry, the observer, the theme
 *       subscription, the visibility listener, and the animation are all
 *       released in the effects' cleanups.
 *
 * Decoupled from any data source: the caller passes `getSeries` (oldest→newest
 * bins), the bin width, and `subscribeActivity` — the data-event clock every
 * read is downstream of.
 *
 * @module components/tugways/tug-sparkline
 */

import "./tug-sparkline.css";

import React, { useLayoutEffect, useRef, useState } from "react";

import {
  drawSparkline,
  SPARKLINE_AREA_ALPHA,
  SPARKLINE_LINE_ALPHA,
  SPARKLINE_LINE_WIDTH,
  type SparklineColors,
  type SparklineGeometry,
  type SparklinePoint,
} from "@/lib/sparkline-geometry";
import {
  DORMANT_AFTER_MS,
  EPOCH_S,
  SparklineTape,
  VISIBLE_SECONDS,
  type SparklineCurve,
  type SparklineSurface,
} from "@/lib/sparkline-tape";
import { tugDevLogStore } from "@/lib/tug-dev-log-store/tug-dev-log-store";
import type {
  SparklineWorkerRequest,
  SparklineWorkerResponse,
} from "@/lib/workers/sparkline-render-worker";
import { subscribeThemeChange, unsubscribeThemeChange } from "@/theme-tokens";
import { isTugMotionEnabled } from "./scale-timing";

/**
 * Response curve: maps the rate as a fraction of full scale (`x = rate /
 * fullScale`, ≥ 0 and MAY exceed 1) to a display height. The tape clamps the
 * result into `[0, 1]`, so a curve may either reach 1 exactly at `x = 1` (a
 * hard ceiling: everything past `fullScale` clips flat) or asymptote toward 1
 * and never clip. This is the ONE place the vertical shape lives — swap the
 * curve to retune the feel without touching any geometry, motion, or data.
 *
 * `curve(0)` must be 0 so silence reads a flat baseline. What we want here is
 * strong differentiation across the LOW/MID band (ordinary activity should use
 * most of the height and vary visibly) while the TOP rolls off gently so a
 * burst reads tall without slamming into a flat clip.
 */
export type { SparklineCurve };

/**
 * The curve library. To try a different feel, point the caller's `curve` prop
 * at another entry (or add one here). `x` is `rate / fullScale`.
 *
 *  - `linear`   — no shaping; a fast burst clips the instant it passes full
 *                 scale. The original behavior.
 *  - `gamma(g)` — power curve `x^g`. `g < 1` is STEEP through the low/mid band
 *                 (great differentiation there) and concave into the top, which
 *                 rounds off just below full scale. Reaches 1 at `x = 1`, so
 *                 pick `fullScale` above real bursts for headroom. Smaller `g`
 *                 = steeper low end. This is the current feel.
 *  - `log(knee)`— logarithmic: equal height per DOUBLING of rate. Spends its
 *                 steepness on the very-low end and flattens the mid band, so
 *                 large `knee` reads FLAT for ordinary activity — usually the
 *                 wrong trade here. Kept for comparison.
 *  - `soft(k)`  — saturating soft-knee `1 − e^(−k·x)`. NEVER clips (asymptotes
 *                 to 1); slope `k` at the origin sets low/mid steepness. Here
 *                 `fullScale` is a characteristic scale, not a ceiling. Use
 *                 when even extreme spikes must stay on-screen without a flat
 *                 top — at the cost of bursts differentiating less up high.
 */
export const sparklineCurves = {
  linear: ((x) => x) as SparklineCurve,
  gamma:
    (g: number): SparklineCurve =>
    (x) =>
      Math.pow(x, g),
  log:
    (knee: number): SparklineCurve =>
    (x) =>
      Math.log1p(x * knee) / Math.log1p(knee),
  soft:
    (k: number): SparklineCurve =>
    (x) =>
      1 - Math.exp(-k * x),
};

/**
 * The shared render worker, built on first use and kept for the page's life —
 * one thread for every tape, not one per tape. Null when the platform cannot
 * transfer a canvas, which routes every instance to the on-main fallback.
 */
let renderWorker: Worker | null | undefined;
let nextSparklineId = 1;
/**
 * Where a rebase paint's acknowledgement goes home to. One shared worker
 * serves every tape, so its replies arrive on one `onmessage` and are routed
 * by sparkline id. Entries are added by {@link makePainter} and removed by the
 * painter's `release()` ([L27]) — a paint whose painter has been released is
 * therefore acked by nobody, which is what the tape's watchdog exists for.
 */
const ackRoutes = new Map<number, (ack: number) => void>();

function sparklineWorker(): Worker | null {
  if (renderWorker !== undefined) return renderWorker;
  renderWorker =
    typeof Worker !== "undefined" &&
    typeof HTMLCanvasElement !== "undefined" &&
    typeof HTMLCanvasElement.prototype.transferControlToOffscreen === "function"
      ? new Worker(
          new URL("@/lib/workers/sparkline-render-worker.ts", import.meta.url),
          { type: "module" },
        )
      : null;
  if (renderWorker !== null) {
    renderWorker.onmessage = (event: MessageEvent<SparklineWorkerResponse>): void => {
      const msg = event.data;
      if (msg.kind !== "painted") return;
      ackRoutes.get(msg.id)?.(msg.ack);
    };
  }
  return renderWorker;
}

/**
 * A claimed canvas plus whichever thread is drawing on it. The two paths are
 * the same code either way — `lib/sparkline-geometry.ts` owns the staircase —
 * so a platform without transferable canvases loses the thread, not the
 * picture.
 */
interface Painter {
  /**
   * `ack` non-null ⇒ call the painter's `onAck` once those pixels exist, and
   * do it ASYNCHRONOUSLY. Ordinary sample paints pass null and are answered by
   * nobody, which keeps the 4 Hz path one-directional.
   */
  draw(
    tape: readonly SparklinePoint[],
    t0: number,
    now: number,
    ack: number | null,
    clear: boolean,
  ): void;
  /** Re-read the resolved color and weights, then repaint. */
  refreshColors(t0: number): void;
  release(): void;
}

/**
 * Read what the cascade still owns. The line and area were `currentColor`
 * with fixed opacities in CSS; a canvas has no cascade, so the resolved values
 * are read here and re-posted only when they can have changed — a theme swap,
 * or the dominant-channel stamp moving the container's `color`. Reading
 * computed style forces a style resolution, which is precisely what this
 * conversion exists to keep off the sample loop.
 */
function resolveSparklineColors(container: HTMLElement | null): SparklineColors {
  const fallback: SparklineColors = {
    line: "currentColor",
    area: "currentColor",
    lineAlpha: SPARKLINE_LINE_ALPHA,
    areaAlpha: SPARKLINE_AREA_ALPHA,
    lineWidth: SPARKLINE_LINE_WIDTH,
  };
  if (container === null) return fallback;
  const style = getComputedStyle(container);
  // Weight knobs a consumer may retune — the activity card's rows draw a
  // brighter line over a quieter fill than the compact strip does. Declared
  // nowhere by default, so an ancestor's override always wins and the
  // fallback lives at point of use.
  const num = (prop: string, dflt: number): number => {
    const raw = style.getPropertyValue(prop).trim();
    if (raw === "") return dflt;
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : dflt;
  };
  return {
    line: style.color,
    area: style.color,
    lineAlpha: num("--tugx-sparkline-line-alpha", SPARKLINE_LINE_ALPHA),
    areaAlpha: num("--tugx-sparkline-area-alpha", SPARKLINE_AREA_ALPHA),
    lineWidth: num("--tugx-sparkline-line-width", SPARKLINE_LINE_WIDTH),
  };
}

/**
 * The scroll container the element is clipped by, or null for the viewport.
 *
 * This is the `IntersectionObserver`'s `root`, and it has to be, because
 * `rootMargin` expands the ROOT's rect. With the default viewport root a
 * generous margin buys nothing at all for a row clipped by an intermediate
 * scroller — the row leaves the list's box long before it leaves the window,
 * and that boundary is the one it flaps across.
 */
function nearestScrollableAncestor(el: Element): Element | null {
  for (let node = el.parentElement; node !== null; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") {
      return node;
    }
  }
  return null;
}

/**
 * Every mounted tape, by the container element it draws under.
 *
 * The tape's state — which dormancy it is in, which origin it paints from, what
 * the pen is holding — is deliberately outside React and outside the DOM, which
 * is what keeps an idle tape free. That also puts it out of reach of a real-app
 * test, and the claims worth testing in a real app (a stalled stream drains to
 * baseline through the REAL store, a scroll cycle does not tear the scroll down)
 * are exactly the ones a DOM-free unit test cannot make. A `WeakMap` keyed on
 * the element costs nothing at rest, holds nothing alive, and is read only
 * through `window.__tug` — which does not exist outside test mode.
 */
const mountedTapes = new WeakMap<Element, SparklineTape>();

/** The tape drawing under `container`, for the test surface. */
export function peekSparklineTape(container: Element): SparklineTape | null {
  return mountedTapes.get(container) ?? null;
}

/** The presentation-to-backing-store ratio the canvas must be sized against. */
function readDevicePixelRatio(): number {
  if (typeof window === "undefined") return 1;
  return window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
}

/** Claim the canvas for the worker, or null if it has already been spent. */
function tryTransferControl(canvas: HTMLCanvasElement): OffscreenCanvas | null {
  try {
    return canvas.transferControlToOffscreen();
  } catch (error) {
    tugDevLogStore.error("sparkline", "canvas transfer failed; drawing on main", {
      error: String(error),
    });
    return null;
  }
}

function makePainter(
  canvas: HTMLCanvasElement,
  container: HTMLElement | null,
  geometry: SparklineGeometry,
  onAck: (ack: number) => void,
): Painter {
  let colors = resolveSparklineColors(container);
  const worker = sparklineWorker();

  // A canvas's control may be transferred exactly ONCE, and a second attempt
  // throws `InvalidStateError` — out of a `useLayoutEffect`, which does not
  // fail one sparkline but the whole render pass containing it. On the Cards card
  // that is the entire rail. The `key` is supposed to guarantee a fresh
  // element, but "supposed to" is not a reason to let a throw escape: under
  // double-invoked effects, or any future dependency that changes without also
  // changing the key, this is the only thing standing between a spent canvas
  // and a blank rail. The fallback draws the identical geometry, so what is
  // lost is the worker thread, not the picture.
  const offscreen = worker === null ? null : tryTransferControl(canvas);
  if (worker !== null && offscreen !== null) {
    const id = nextSparklineId++;
    const init: SparklineWorkerRequest = {
      kind: "init",
      id,
      canvas: offscreen,
      colors,
      ...geometry,
    };
    worker.postMessage(init, [offscreen]);
    ackRoutes.set(id, onAck);
    return {
      draw(tape, t0, now, ack, clear) {
        worker.postMessage({
          kind: "tape",
          id,
          points: tape.slice(),
          t0,
          now,
          clear,
          ...(ack === null ? {} : { ack }),
        } satisfies SparklineWorkerRequest);
      },
      refreshColors(t0) {
        colors = resolveSparklineColors(container);
        worker.postMessage({
          kind: "colors",
          id,
          colors,
          t0,
        } satisfies SparklineWorkerRequest);
      },
      release() {
        ackRoutes.delete(id);
        worker.postMessage({ kind: "dispose", id } satisfies SparklineWorkerRequest);
      },
    };
  }

  const ctx = canvas.getContext("2d");
  let last: { tape: readonly SparklinePoint[]; t0: number } = { tape: [], t0: 0 };
  let released = false;
  return {
    draw(tape, t0, now, ack, clear) {
      last = { tape, t0 };
      if (ctx !== null) drawSparkline(ctx, geometry, colors, tape, t0, clear);
      if (ack === null) return;
      // This branch draws SYNCHRONOUSLY, so acking from here would re-enter
      // the tape's own paint() call and move the scroll from inside it. Defer
      // it. This is not belt-and-braces — the tape asserts against a
      // re-entrant ack precisely so a future reader cannot "simplify" the
      // microtask away.
      queueMicrotask(() => {
        if (!released) onAck(ack);
      });
    },
    refreshColors(t0) {
      colors = resolveSparklineColors(container);
      if (ctx !== null) drawSparkline(ctx, geometry, colors, last.tape, t0);
    },
    release() {
      released = true;
    },
  };
}

export function TugSparkline({
  getSeries,
  getColorChannel,
  subscribeActivity,
  binMs,
  fullScale,
  curve = sparklineCurves.linear,
  width = 64,
  height = 22,
  className,
  title,
}: {
  /** Current window oldest→newest; the last element is the still-open bin. */
  getSeries: (nowMs: number) => number[];
  /**
   * The data-event clock — the tape's ONLY clock. `wake` must fire
   * synchronously with each data write that matters to this tape (the
   * caller filters channels); every append, the settle burst, and the
   * scroll's retirement are all downstream of it. A tape whose events stop
   * goes inert by construction; the next event wakes it in the same tick.
   */
  subscribeActivity: (wake: () => void) => () => void;
  /**
   * Optional dominant-channel selector, sampled on the same loop as
   * `getSeries` ([P05]). Its return (a channel name, or null when idle) is
   * stamped as `data-activity-channel` on the container so theme CSS can
   * tint the line by what the session is doing; the caller owns hysteresis
   * so the color doesn't strobe. Omitted → the line keeps its default hue.
   */
  getColorChannel?: (nowMs: number) => string | null;
  /** Bin width in ms (used to size the rolling-rate window). */
  binMs: number;
  /** Rate (per RATE_WINDOW_MS) that reaches full height; larger clamps. Fixed. */
  fullScale: number;
  /** Vertical response curve; see {@link sparklineCurves}. Default: linear. */
  curve?: SparklineCurve;
  width?: number;
  height?: number;
  className?: string;
  /** Native hover tooltip. The graphic itself stays `aria-hidden`. */
  title?: string;
}): React.ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /**
   * The painter, claimed by the effect below and used by the tape effect
   * after it. A ref, not state — nothing renders from it ([L06]).
   */
  const painterRef = useRef<Painter | null>(null);
  /**
   * The live tape. Held in a ref because the canvas-claim effect below needs
   * to route acknowledgements to it, and that effect does not re-run when the
   * tape effect does. Nothing renders from it ([L06]).
   */
  const tapeRef = useRef<SparklineTape | null>(null);
  /**
   * The live device pixel ratio — STRUCTURE-ZONE state ([L24]): it decides
   * which canvas element exists, not how anything looks, so `useState` is the
   * right mechanism and [L06] is not in play.
   *
   * It has to be state rather than a render-time read of `window` because a
   * resolution change has to re-render to take effect, and it has to be the
   * ratio itself rather than an invalidation counter so the `key` and the
   * geometry are computed from one value and cannot disagree.
   */
  const [dpr, setDpr] = useState(readDevicePixelRatio);

  // Scroll speed derived from the single time-span knob and the width.
  const pxPerSec = width / VISIBLE_SECONDS;
  const epochPx = EPOCH_S * pxPerSec;
  const svgWidth = Math.ceil(width + epochPx + 8);
  // The 1px line is drawn inside an overflow:hidden box. Painting the zero
  // baseline flush at the bottom edge (height - 0.5) leaves its stroke one
  // sub-pixel from the clip, so some bar heights / device-pixel ratios round
  // it away. Reserve a 1px floor so the baseline and the area's bottom always
  // stay inside the box.
  const FLOOR = 1;
  const baselineY = height - FLOOR - 0.5;
  const amplitude = height - FLOOR - 1;

  /**
   * Claim the canvas. This is its own effect, scoped to the geometry alone,
   * because `transferControlToOffscreen` may be called exactly once per
   * element — folded into the tape effect it would throw the second time a
   * caller passed a fresh `getSeries`. The canvas carries a `key` built from
   * the same geometry, so the only run that could meet a spent element is one
   * where React has already replaced it.
   */
  /**
   * Track the live resolution. `devicePixelRatio` is read once at claim time
   * and would otherwise never be read again: drag the window to a display at a
   * different scale factor, or apply page zoom (which moves
   * `devicePixelRatio` in WebKit, and persists per bundle), and the backing
   * store stays permanently mismatched to the presentation size — a soft,
   * resampled tape with no way back short of a reload.
   *
   * The query matches the CURRENT ratio, so `change` fires exactly when it
   * stops being current, and the effect re-installs against the new one.
   */
  useLayoutEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const query = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const onChange = (): void => setDpr(readDevicePixelRatio());
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [dpr]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;

    const geometry: SparklineGeometry = {
      width,
      svgWidth,
      height,
      dpr,
      baselineY,
      amplitude,
      pxPerSec,
      retainMs: DORMANT_AFTER_MS,
    };
    canvas.width = Math.ceil(svgWidth * dpr);
    canvas.height = Math.ceil(height * dpr);
    canvas.style.width = `${svgWidth}px`;
    canvas.style.height = `${height}px`;

    const painter = makePainter(canvas, containerRef.current, geometry, (ack) => {
      tapeRef.current?.onPainted(ack);
    });
    painterRef.current = painter;

    // A re-claim leaves a live tape with a canvas it has never drawn on, and
    // both halves of that are load-bearing.
    //
    // `cancelRebase` — releasing the old painter unregistered its ack route, so
    // a rebase in flight would be acknowledged by nobody. On a hidden-wake,
    // where the resume is ordered after the origin moves, that leaves the
    // scroll paused forever. The tape re-proposes on its next tick.
    //
    // `repaint` — the new worker entry starts with an EMPTY tape, and the tape
    // effect below does not re-run for a resolution change. A live tape would
    // recover within one settle tick; a flat-dormant or hidden-paused one —
    // which is most of the Cards card, most of the time — would stay blank until its
    // next activity, possibly forever. Without this the fix would blank every
    // idle tape it was meant to sharpen.
    tapeRef.current?.cancelRebase();
    tapeRef.current?.repaint();

    return () => {
      painter.release();
      painterRef.current = null;
    };
  }, [width, height, svgWidth, pxPerSec, baselineY, amplitude, dpr]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const track = trackRef.current;
    if (track === null) return;

    const motion = isTugMotionEnabled();
    /**
     * The tape's clock, and the only one this component reads. Monotonic, and
     * sharing the document's time origin with `document.timeline` — which is
     * what lets the scroll's `startTime` be written from it directly, so the
     * time→x map in `sparkline-geometry.ts` and the transform become the same
     * function. Wall clock lives behind one named seam inside `SparklineTape`.
     */
    const clock = (): number => performance.now();
    let anim: Animation | null = null;
    let tape: SparklineTape | null = null;

    /**
     * The scroll's actual position, or null when there is nothing running to
     * read one from — which the tape treats as "not registered at all".
     */
    const animPosition = (): number | null => {
      if (anim === null || anim.playState !== "running") return null;
      const current = anim.currentTime;
      return typeof current === "number" ? current : null;
    };

    /**
     * Compare where the scroll IS against where the clock says it should be,
     * and correct it. A tiny divergence is written straight onto the animation;
     * anything the eye could catch goes back through the ack-gated rebase.
     *
     * GATED ON VISIBILITY, and that gate is not defensive padding.
     * `document.timeline.currentTime` is the current FRAME time, not a live
     * clock: it advances at rendering updates and stops entirely when WebKit
     * suspends rendering for an occluded window, while `performance.now()` runs
     * on. Ungated, the check would then read a divergence growing without
     * bound and return `rebase` every 250 ms for the whole occlusion — and each
     * of those writes a `startTime` AHEAD of the stalled timeline, dropping the
     * animation into its before-phase where a `fill: "forwards"` effect does
     * not apply and the element snaps to `translateX(0)` over epoch-end pixels.
     * That is this component's own defect, re-manufactured at 4 Hz. One
     * property read removes the whole failure mode; the `visibilitychange`
     * resync below then does the single correction that was actually needed.
     */
    const checkRegistration = (): void => {
      if (anim === null || tape === null) return;
      if (document.visibilityState !== "visible") return;
      const verdict = tape.checkRegistration(animPosition());
      if (verdict.kind === "ok") return;
      if (verdict.kind === "nudge") {
        anim.startTime = verdict.startTimeMs;
        return;
      }
      tape.resyncRegistration();
    };

    /**
     * The output port. Every method resolves `painterRef.current` AT CALL
     * TIME, matching what the closure used to do: the surface is built here,
     * in the tape effect, while the painter is owned by the canvas-claim
     * effect above and may be replaced under a live tape. Capturing the
     * painter in this closure would type-check, pass every test, and paint
     * onto a released canvas the first time the geometry changed.
     */
    const surface: SparklineSurface = {
      paint(points, t0, ack, clear) {
        painterRef.current?.draw(points, t0, clock(), ack, clear);
      },
      setEpochStart(timelineMs) {
        // An exact write, not a cancel-and-recreate: `startTime` resolves the
        // animation's origin with no pending-start slop, keeps the same
        // Animation object (so the compositor keeps the layer and nothing can
        // be orphaned), and — because it also clears any hold time — restarts
        // a paused scroll on its own. That side effect is the surface's whole
        // resume story: the tape never replays from a held position, because
        // the clock runs on while a tape is paused and a hold-relative
        // `play()` would come back mis-registered by the entire quiet spell.
        if (anim !== null) anim.startTime = timelineMs;
      },
      pause() {
        anim?.pause();
      },
      stampChannel(channel, t0) {
        // Appearance rides the DOM attribute, never React state ([L06]).
        if (container !== null) {
          if (channel === null) container.removeAttribute("data-activity-channel");
          else container.setAttribute("data-activity-channel", channel);
        }
        // The stamp is what the tint CSS selects on, so the resolved color
        // has just changed under the canvas. A null `t0` means a rebase is in
        // flight and the tape will flush the repaint at its commit.
        if (t0 !== null) painterRef.current?.refreshColors(t0);
      },
      setRest(atRest) {
        // The rest baseline is a stylesheet fact keyed on this attribute
        // ([L06]); the tape stamps it from its own points, so it is present
        // exactly while the correct picture is a flat line.
        container?.toggleAttribute("data-tape-rest", atRest);
      },
      refreshColors(t0) {
        painterRef.current?.refreshColors(t0);
      },
    };

    // The scroll: ONE animation, created here and never recreated. A rollover
    // is a `startTime` write, so there is no teardown to race and no orphaned
    // `onfinish` to guard against. The origin is set explicitly from the same
    // clock reading the tape starts with, which removes the "begins at the
    // next rendering update" slop a pending start would otherwise leave as a
    // permanent horizontal offset for the whole epoch.
    const origin = clock();
    if (motion) {
      anim = track.animate(
        [{ transform: "translateX(0)" }, { transform: `translateX(${-epochPx}px)` }],
        { duration: EPOCH_S * 1000, easing: "linear", fill: "forwards" },
      );
      anim.startTime = origin;
      if (anim.pending) {
        tugDevLogStore.debug("sparkline", "start time still pending after write");
      }
      // A redundant nudge into the tape's own rollover check — never its only
      // path, because a paused animation never finishes.
      anim.onfinish = () => tape?.onEpochFinished();
    }

    tape = new SparklineTape(surface, {
      now: clock,
      getSeries,
      getColorChannel,
      binMs,
      fullScale,
      curve,
      amplitude,
      pxPerSec,
      motion,
      setInterval: (fn, ms) => window.setInterval(fn, ms),
      clearInterval: (handle) => window.clearInterval(handle),
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (handle) => window.clearTimeout(handle),
      // The dev panel (Opt-Cmd-/) is where gate churn is read: scroll the Cards card
      // rail hard and this log should stay quiet. Never `console.warn`.
      onTransition: (from, to) => {
        tugDevLogStore.debug("sparkline", `${from} → ${to}`);
      },
      onLiveTick: checkRegistration,
    });
    const live = tape;
    tapeRef.current = live;
    if (container !== null) mountedTapes.set(container, live);
    live.start(origin);

    const unsubscribe = subscribeActivity(() => live.onActivity());

    // Visibility gate: the component reports RAW intersection and nothing
    // else — how long out of view before the tape stops is a dormancy policy
    // question, and it lives with the rest of the dormancy policy.
    //
    // The root is the nearest scroller, not the viewport, and the two settings
    // are one decision: `rootMargin` grows the ROOT's rect, so a margin against
    // the viewport would do nothing for a row clipped by a list in the middle.
    // Paired, they keep a row that is merely near the list's clip edge from
    // being called off-screen at all.
    const observer =
      container !== null && typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver(
            (entries) => {
              const entry = entries[entries.length - 1];
              if (entry === undefined) return;
              live.setVisible(entry.isIntersecting);
            },
            {
              root: nearestScrollableAncestor(container),
              rootMargin: "160px 0px",
              threshold: 0,
            },
          )
        : null;
    if (observer !== null && container !== null) observer.observe(container);

    // A theme swap changes the resolved `color` the canvas painted with.
    // This is a callback set, not a timer or an observer — it costs nothing
    // at rest.
    const repaintColors = (): void => {
      // Through the tape, not straight to the painter: mid-rebase the canvas
      // holds two origins' pixels and a colour repaint must wait for the
      // commit, which is the tape's call to make.
      live.refreshColors();
    };
    subscribeThemeChange(repaintColors);

    /**
     * The single recovery for everything that happened while the page was
     * hidden. Nothing corrects itself in there — the self-check is gated off
     * and the tape's clocks may have parted company — so coming back is where
     * both get put right: the wall-clock offset is re-derived (a sleep/wake or
     * an NTP step moves wall clock relative to the monotonic one), and one
     * registration check runs.
     *
     * The divergence is recorded because it is the answer to a question the
     * design deliberately refused to depend on: whether the document timeline
     * stalls while the window is occluded. The number lands in the dev panel
     * and in the app-test's diagnostics rather than staying a guess.
     */
    const onVisibilityChange = (): void => {
      if (document.visibilityState !== "visible") return;
      live.resyncWallClock();
      const position = animPosition();
      if (position !== null) {
        const divergenceMs = position - (clock() - live.committedT0());
        tugDevLogStore.debug(
          "sparkline",
          `visible: registration off by ${divergenceMs.toFixed(1)}ms`,
        );
      }
      checkRegistration();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      live.stop();
      if (tapeRef.current === live) tapeRef.current = null;
      if (container !== null && mountedTapes.get(container) === live) {
        mountedTapes.delete(container);
      }
      observer?.disconnect();
      unsubscribe();
      unsubscribeThemeChange(repaintColors);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      // The one cancel in the component's life, at unmount ([L27]).
      if (anim !== null) {
        anim.onfinish = null;
        anim.cancel();
      }
    };
  }, [
    getSeries,
    getColorChannel,
    subscribeActivity,
    binMs,
    fullScale,
    curve,
    width,
    height,
    amplitude,
    pxPerSec,
    epochPx,
  ]);

  return (
    <div
      ref={containerRef}
      className={className ? `tug-sparkline ${className}` : "tug-sparkline"}
      data-slot="tug-sparkline"
      style={{ width, height }}
      title={title}
      aria-hidden
    >
      <div ref={trackRef} className="tug-sparkline-track">
        {/* Keyed on the geometry it will be transferred with, RESOLUTION
            INCLUDED: a canvas can be handed to a worker once, so a geometry or
            ratio change must arrive as a new element rather than a second
            transfer of a spent one ([L26]).

            The [L26] audit, all three inputs: the remount is deliberate and the
            law permits it, because a canvas whose control has been transferred
            away is genuinely a spent entity — "a new entity has appeared" is
            the honest reading. The component type is still "canvas" and there
            is no renderer map in play. Critically the key sits on the <canvas>
            ALONE: `.tug-sparkline` and `.tug-sparkline-track` keep their
            identity, so the tape, the animation, and the observer all survive a
            resolution change untouched. */}
        <canvas
          key={`${svgWidth}x${height}@${dpr}`}
          ref={canvasRef}
          className="tug-sparkline-canvas"
        />
      </div>
    </div>
  );
}
