/**
 * TugSparkline — a stock-ticker activity graph.
 *
 * Two rules, like ticker tape:
 *  1. Values are NEVER revised. The picture is drawn two bins behind the
 *     clock, so the right edge only ever shows bins that are closed and
 *     delivered; the pen holds the newest value flat to the edge, so the line
 *     is always full edge to edge and a quiet stretch is the held value, not
 *     a gap.
 *  2. New samples appear at the right edge and move left at a constant rate.
 *
 * WHAT THIS COMPONENT IS. A surface, and nothing else: it claims a canvas,
 * resolves the line's colour from computed style, hands the instrument a
 * window of bins whenever the store says something happened, and stamps two
 * attributes. It holds no picture, no origin and no timer. The picture is a
 * pure function of the store's bins and the clock, computed inside
 * `lib/sparkline-instrument.ts` on whichever thread owns the canvas —
 * normally the render worker, so the page is never woken by a tape.
 *
 * THE DATA EVENT IS THE ONLY THING THIS THREAD LISTENS TO. The caller's
 * `subscribeActivity` channel fires synchronously when data records; this
 * component reads the window and posts it. Between events it does nothing at
 * all: the redraw tick lives with the instrument, stops itself when the
 * picture cannot change, and starts again on the next event. An idle tape
 * costs this thread nothing because nothing here is running, not because
 * something detected quiet.
 *
 * NOTHING GATES ON VISIBILITY. The `IntersectionObserver` that used to stop
 * an off-screen tape is gone: what it saved was one small canvas redraw for a
 * session that is both working and scrolled out of view, and what it cost was
 * a tape that never woke again once its observer root stopped being an
 * ancestor — a card reparented by a dock, a stack flip or a minimize. Coming
 * back from a hidden page re-posts the window, which is a refresh rather than
 * a gate: there is no state to be wrong about.
 *
 * Laws: [L06] appearance is painted and DOM-attributed — the one piece of
 *       React state here is the device pixel ratio and the claim epoch
 *       beside it, both STRUCTURE ([L24]: they decide which canvas element
 *       exists, not how anything looks); [L03] setup in `useLayoutEffect`;
 *       [L13]'s carve-out for an
 *       instrument redrawing DATA onto a worker-owned canvas, named in
 *       `tuglaws/animation-doctrine.md`; [L19] `.tsx`/`.css` pair; [L26] a
 *       spent canvas is replaced by `key`, never re-transferred; [L27] the
 *       host entry, the store subscription, the theme subscription and the
 *       visibility listener are all released in the effect's cleanup.
 *
 * Decoupled from any data source: the caller passes `getSeries` (oldest→newest
 * bins), the bin width, and `subscribeActivity` — the data event every read is
 * downstream of.
 *
 * @module components/tugways/tug-sparkline
 */

import "./tug-sparkline.css";

import React, { useLayoutEffect, useRef, useState } from "react";

import {
  SPARKLINE_AREA_ALPHA,
  SPARKLINE_LINE_ALPHA,
  SPARKLINE_LINE_WIDTH,
  type SparklineColors,
} from "@/lib/sparkline-geometry";
import {
  createSparklineHost,
  routeSparklineWorkerMessage,
  type SparklineHost,
} from "@/lib/sparkline-host";
import {
  sparklineCurves,
  SPARKLINE_VISIBLE_SECONDS,
  type SparklineCurve,
  type SparklineInstrumentGeometry,
  type SparklineInstrumentState,
} from "@/lib/sparkline-instrument";
import { tugDevLogStore } from "@/lib/tug-dev-log-store/tug-dev-log-store";
import type { SparklineWorkerResponse } from "@/lib/workers/sparkline-render-worker";
import { subscribeThemeChange, unsubscribeThemeChange } from "@/theme-tokens";
import { isTugMotionEnabled } from "./scale-timing";

/**
 * Response curve: maps the rate as a fraction of full scale (`x = rate /
 * fullScale`, ≥ 0 and MAY exceed 1) to a display height. The instrument
 * clamps the result into `[0, 1]`, so a curve may either reach 1 exactly at
 * `x = 1` (a hard ceiling: everything past `fullScale` clips flat) or
 * asymptote toward 1 and never clip. This is the ONE place the vertical shape
 * lives — swap the curve to retune the feel without touching any geometry,
 * motion, or data.
 *
 * `curve(0)` must be 0 so silence reads a flat baseline. What we want here is
 * strong differentiation across the LOW/MID band (ordinary activity should use
 * most of the height and vary visibly) while the TOP rolls off gently so a
 * burst reads tall without slamming into a flat clip.
 */
export type { SparklineCurve };

/**
 * The curve library, re-exported from the instrument that applies it. Its
 * entries carry the spec they were built from, because the instrument runs on
 * whichever thread owns the canvas and a function cannot cross a
 * `postMessage` — see `lib/sparkline-instrument.ts`.
 */
export { sparklineCurves };

/**
 * The shared render worker, built on first use and kept for the page's life —
 * one thread for every instrument, not one per instrument. Null when the
 * platform cannot transfer a canvas, which routes every instance to the
 * on-main host.
 */
let renderWorker: Worker | null | undefined;

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
      routeSparklineWorkerMessage(event.data);
    };
  }
  return renderWorker;
}

/**
 * Resolve the paint from the element's own computed style, so the theme and
 * the channel tint own the colour and the canvas — which has no cascade — is
 * told what they decided.
 */
function resolveSparklineColors(container: HTMLElement | null): SparklineColors {
  if (container === null || typeof getComputedStyle !== "function") {
    return {
      line: "currentColor",
      area: "currentColor",
      lineAlpha: SPARKLINE_LINE_ALPHA,
      areaAlpha: SPARKLINE_AREA_ALPHA,
      lineWidth: SPARKLINE_LINE_WIDTH,
    };
  }
  const style = getComputedStyle(container);
  // Consumer knobs, read through the cascade: the activity card wants a
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
 * Every mounted instrument, by the container element it draws under.
 *
 * The instrument's one fact — ticking or not, the newest plotted value, the
 * rest reading — is deliberately outside React and outside the DOM, which is
 * what keeps an idle tape free. That also puts it out of reach of a real-app
 * test, and the claims worth testing in a real app (a stalled stream drains to
 * baseline through the REAL store, a reparented card keeps drawing) are
 * exactly the ones a DOM-free unit test cannot make. A `WeakMap` keyed on the
 * element costs nothing at rest, holds nothing alive, and is read only through
 * `window.__tug` — which does not exist outside test mode.
 */
const mountedHosts = new WeakMap<Element, SparklineHost>();

/** The instrument drawing under `container`, for the test surface. */
export function peekSparklineHost(container: Element): SparklineHost | null {
  return mountedHosts.get(container) ?? null;
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

/**
 * Every canvas whose control has been handed to the worker.
 *
 * A canvas may be transferred exactly ONCE, and a spent element answers
 * `getContext` with a throw as surely as it answers a second transfer with
 * one — so meeting a spent element is not a case either host can draw its way
 * out of, and a throw out of a `useLayoutEffect` takes down not one tape but
 * the whole render pass containing it. On the Cards card that is the entire
 * rail.
 *
 * The `key` below is what guarantees a fresh element for a fresh claim, and
 * this set is what makes the guarantee CHECKABLE rather than assumed. The key
 * is built from the geometry; the effect that claims also subscribes, so it
 * depends on the caller's callbacks too, and any of those moving without the
 * geometry moving runs the claim again on an element already spent. The
 * predecessor bought the same safety by splitting the claim into its own
 * geometry-scoped effect — a shape the one-effect surface gave up, and this
 * is what replaces it. A run that finds a spent canvas asks React for a new
 * one ([L26]) rather than drawing on a corpse.
 *
 * No live caller is known to trip this — every mount memoizes its callbacks,
 * and a rebound card was measured to remount the tape outright rather than
 * re-run the effect on it. So this is a guard on an unrecoverable failure,
 * not a fix for a reproduced one: the cost is a `WeakSet` lookup per claim,
 * and the failure it forecloses is a throw out of a layout effect.
 */
const spentCanvases = new WeakSet<HTMLCanvasElement>();

export function TugSparkline({
  getSeries,
  subscribeActivity,
  getColorChannel,
  binMs,
  fullScale,
  hold = false,
  curve = sparklineCurves.linear,
  width = 64,
  height = 22,
  className,
  title,
}: {
  /** Current window oldest→newest; the last element is the still-open bin. */
  getSeries: (nowMs: number) => number[];
  /**
   * The data event — the only thing this component listens to. `wake` must
   * fire synchronously with each data write that matters to this instrument
   * (the caller filters channels); every window this component posts is
   * downstream of one. An instrument whose events stop settles by
   * construction; the next event wakes it in the same tick.
   */
  subscribeActivity: (wake: () => void) => () => void;
  /**
   * Optional dominant-channel selector, sampled on each data event ([P05]).
   * Its return (a channel name, or null when idle) is stamped as
   * `data-activity-channel` on the container so theme CSS can tint the line by
   * what the session is doing; the caller owns hysteresis so the color doesn't
   * strobe. Omitted → the line keeps its default hue.
   */
  getColorChannel?: (nowMs: number) => string | null;
  /** Bin width in ms (used to size the rolling-rate window). */
  binMs: number;
  /** Rate (per RATE_WINDOW_MS) that reaches full height; larger clamps. Fixed. */
  fullScale: number;
  /**
   * What time PAST the window's newest bin holds, while no event arrives. A
   * rate channel's unsent time is silence, so the default decays to baseline;
   * a gauge's is the level it was last told about, which under the emitter's
   * no-news-is-no-news contract is still the truth — those callers pass true.
   */
  hold?: boolean;
  /** Vertical response curve; see {@link sparklineCurves}. Default: linear. */
  curve?: SparklineCurve;
  width?: number;
  height?: number;
  className?: string;
  /** Native hover tooltip. The graphic itself stays `aria-hidden`. */
  title?: string;
}): React.ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /**
   * The live host — the instrument, on whichever thread took it. A ref, not
   * state: nothing renders from it ([L06]).
   */
  const hostRef = useRef<SparklineHost | null>(null);
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
  /**
   * Which claim the canvas element below belongs to — STRUCTURE-ZONE state
   * ([L24]), exactly as `dpr` is: it decides which element exists, not how
   * anything looks. Bumped only when the effect meets a canvas it has already
   * spent, which retires that element and brings a fresh one for the claim
   * about to happen.
   */
  const [claimEpoch, setClaimEpoch] = useState(0);

  // The time→x mapping, derived from the single span knob and the width.
  const pxPerSec = width / SPARKLINE_VISIBLE_SECONDS;
  // The 1px line is drawn inside an overflow:hidden box. Painting the zero
  // baseline flush at the bottom edge (height - 0.5) leaves its stroke one
  // sub-pixel from the clip, so some bar heights / device-pixel ratios round
  // it away. Reserve a 1px floor so the baseline and the area's bottom always
  // stay inside the box.
  const FLOOR = 1;
  const baselineY = height - FLOOR - 0.5;
  const amplitude = height - FLOOR - 1;

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

  /**
   * Claim the canvas, put the instrument on a thread, and feed it.
   *
   * ONE effect, because there is one thing to set up. The old component split
   * the claim from the policy because the policy outlived a re-claim and had
   * to be re-registered against the new surface; an instrument holds nothing a
   * re-claim could invalidate — the next window posted is the whole picture
   * again — so a geometry change simply builds a new one.
   */
  useLayoutEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (canvas === null) return;
    if (spentCanvases.has(canvas)) {
      // This element's control is already with the worker, so neither host
      // can draw on it. Retire it; the render this schedules brings a fresh
      // canvas, and this effect runs again against that one.
      setClaimEpoch((epoch) => epoch + 1);
      return;
    }

    const geometry: SparklineInstrumentGeometry = {
      width,
      height,
      dpr,
      baselineY,
      amplitude,
      pxPerSec,
    };
    // Viewport-sized, and nothing more. The tape this replaced drew onto a
    // canvas nine viewport-widths wide and moved a window over it; the picture
    // is now recomputed for the window itself, so there is no off-screen
    // region to keep and nothing to scroll.
    canvas.width = Math.ceil(width * dpr);
    canvas.height = Math.ceil(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const host = createSparklineHost({
      canvas,
      geometry,
      colors: resolveSparklineColors(container),
      binMs,
      fullScale,
      curve,
      motion: isTugMotionEnabled(),
      worker: sparklineWorker(),
      transfer: (target: HTMLCanvasElement) => {
        const offscreen = tryTransferControl(target);
        if (offscreen !== null) spentCanvases.add(target);
        return offscreen;
      },
      onState: (state: SparklineInstrumentState) => {
        // The rest baseline is a stylesheet fact keyed on this attribute
        // ([L06]); the instrument reports it from its own picture, so it is
        // present exactly while the correct reading is a flat line at zero.
        container?.toggleAttribute("data-tape-rest", state.atRest);
      },
    });
    hostRef.current = host;
    if (container !== null) mountedHosts.set(container, host);

    /** Read the store and hand the instrument the window. */
    const post = (): void => {
      const now = Date.now();
      const bins = getSeries(now);
      if (getColorChannel !== undefined && container !== null) {
        // Appearance rides the DOM attribute, never React state ([L06]).
        const channel = getColorChannel(now);
        const current = container.getAttribute("data-activity-channel");
        if (channel !== current) {
          if (channel === null) container.removeAttribute("data-activity-channel");
          else container.setAttribute("data-activity-channel", channel);
          // The stamp is what the tint CSS selects on, so the resolved colour
          // has just changed under the canvas.
          host.setColors(resolveSparklineColors(container));
        }
      }
      host.setBins({ headBin: Math.floor(now / binMs), bins, hold });
    };

    // The first window, so a mount draws rather than waiting for an event: the
    // picture for a session that happens to be quiet is still a reading.
    post();
    const unsubscribe = subscribeActivity(post);

    // A theme swap changes the resolved `color` the canvas painted with. This
    // is a callback set, not a timer or an observer — it costs nothing at rest.
    const repaintColors = (): void => {
      host.setColors(resolveSparklineColors(container));
    };
    subscribeThemeChange(repaintColors);

    /**
     * Coming back from a hidden page: re-post the window. Timers are throttled
     * while a page is hidden, so the instrument's picture may be behind — and
     * one post is the whole correction, because the window IS the picture.
     * There is nothing here to gate, resync or reconcile.
     */
    const onVisibilityChange = (): void => {
      if (document.visibilityState === "visible") post();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      host.release();
      if (hostRef.current === host) hostRef.current = null;
      if (container !== null && mountedHosts.get(container) === host) {
        mountedHosts.delete(container);
      }
      unsubscribe();
      unsubscribeThemeChange(repaintColors);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [
    getSeries,
    getColorChannel,
    subscribeActivity,
    binMs,
    fullScale,
    hold,
    curve,
    width,
    height,
    dpr,
    baselineY,
    amplitude,
    pxPerSec,
    claimEpoch,
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
      {/* Keyed on the geometry it will be transferred with, RESOLUTION
          INCLUDED: a canvas can be handed to a worker once, so a geometry or
          ratio change must arrive as a new element rather than a second
          transfer of a spent one ([L26]).

          The [L26] audit, all three inputs: the remount is deliberate and the
          law permits it, because a canvas whose control has been transferred
          away is genuinely a spent entity — "a new entity has appeared" is the
          honest reading. The component type is still "canvas" and there is no
          renderer map in play. Critically the key sits on the canvas ALONE, so
          `.tug-sparkline` keeps its identity and the attributes stamped on it
          survive a resolution change. */}
      <canvas
        key={`${width}x${height}@${dpr}#${claimEpoch}`}
        ref={canvasRef}
        className="tug-sparkline-canvas"
      />
    </div>
  );
}
