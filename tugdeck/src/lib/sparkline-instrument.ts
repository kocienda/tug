/**
 * sparkline-instrument — the session tape's picture, as a pure function of
 * the activity store's bins and the clock.
 *
 * ## The one pipeline
 *
 * There is no tape array, no epoch origin, and no transform. Each frame
 * CLEARS a viewport-sized canvas and draws the whole staircase from the
 * store's bins, placing each bin edge at
 *
 *     x = width − (displayNow − binEdge) · pxPerSec
 *
 * The rolling one-second sum, the response curve, the clamp and the held tail
 * are arithmetic inside the draw. A picture can only jump if two things
 * disagree about where it is, and there is now one thing: any frame that
 * draws at all is correct in full, so no wrong picture can outlive the next
 * frame. The instrument that this replaced kept a point array and a WAAPI
 * scroll in agreement across epochs, rebases, acks and a registration
 * self-check, and every shipped defect in it was a disagreement between those
 * two — never a fault in the drawing.
 *
 * ## Drawing half a second behind the clock
 *
 * `displayNow = now() − DISPLAY_LAG_BINS × binMs`. The right edge therefore
 * only ever shows bins that are CLOSED and delivered, which is what makes
 * "values are never revised" true by construction rather than by bookkeeping:
 * the still-open bin undercounts by whatever has not arrived yet, and reading
 * it would freeze that undercount into the picture. Half a second of lag on a
 * fifteen-second tape is not perceptible.
 *
 * ## The only state is a timer handle
 *
 * A store event starts the tick if it is off. Each tick draws, and if every
 * plotted value across the drawn window is equal — AND the window it is about
 * to become, with no further data, holds that same value — the picture is
 * flat and cannot change, so the tick stops itself. The next event starts it
 * again. A tick that stopped wrongly is restarted by the next event, and the
 * first frame after it is fully correct, so there is no state here that can
 * wedge.
 *
 * The drain half of that test is not a refinement, it is the whole of it. A
 * foreground tool credits a steady hum at 4 Hz, so the picture under it is a
 * flat line at the hum's level and the LAST of those events arrives while the
 * window is still full of it. Stopping on the drawn window alone would stop
 * there and never draw the decay that follows — a tape frozen at the hum's
 * level with no event coming to restart it, which is the stuck tape this
 * instrument exists to make unexpressible. So flatness asks what the picture
 * becomes once the rolling window has drained, and a rate channel's answer is
 * zero unless it is already there.
 *
 * ## DOM-free on purpose
 *
 * This module knows a 2D context, a clock and a pair of timers, all injected.
 * That is what lets the SAME class run inside the render worker against its
 * `OffscreenCanvas` and, where `transferControlToOffscreen` is unavailable, on
 * the main thread against an ordinary context — one implementation rather than
 * a second drawing path to keep in step with the first. It is also what lets
 * the unit suite drive it against a fake clock and a recording context.
 *
 * Laws: [L06] appearance is painted, never React state; [L13]'s carve-out for
 *       an instrument that redraws DATA onto a worker-owned canvas — it
 *       mutates no style and triggers no main-thread rendering update.
 *
 * @module lib/sparkline-instrument
 */

import type { SparklineColors } from "./sparkline-geometry";

/**
 * Response curve: maps the rate as a fraction of full scale (`x = rate /
 * fullScale`, ≥ 0 and MAY exceed 1) to a display height. The instrument
 * clamps the result into `[0, 1]`, so a curve may reach 1 exactly at `x = 1`
 * or asymptote toward it and never clip. `curve(0)` must be 0 so silence
 * reads a flat baseline. The curve library lives with the component.
 */
export type SparklineCurve = (x: number) => number;

/**
 * A curve as a VALUE — which is what lets the worker have one.
 *
 * The instrument runs on whichever thread owns the canvas, and a function
 * cannot be structured-cloned across a `postMessage`. So every curve in the
 * library below is tagged with the spec that produced it, and the spec is
 * what crosses; the worker resolves it back into the identical function on
 * its own side. A caller that hands the component a curve of its own making
 * is not tagged and simply draws on the main thread, against the same class.
 */
export type SparklineCurveSpec =
  | { kind: "linear" }
  | { kind: "gamma"; g: number }
  | { kind: "log"; knee: number }
  | { kind: "soft"; k: number };

/** A curve carrying the spec it was built from. */
export type TaggedSparklineCurve = SparklineCurve & {
  readonly spec: SparklineCurveSpec;
};

function tag(spec: SparklineCurveSpec, fn: SparklineCurve): TaggedSparklineCurve {
  return Object.assign(fn, { spec }) as TaggedSparklineCurve;
}

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
  linear: tag({ kind: "linear" }, (x) => x),
  gamma: (g: number): TaggedSparklineCurve =>
    tag({ kind: "gamma", g }, (x) => Math.pow(x, g)),
  log: (knee: number): TaggedSparklineCurve =>
    tag({ kind: "log", knee }, (x) => Math.log1p(x * knee) / Math.log1p(knee)),
  soft: (k: number): TaggedSparklineCurve =>
    tag({ kind: "soft", k }, (x) => 1 - Math.exp(-k * x)),
};

/** The spec a curve was built from, or null for one the caller made itself. */
export function sparklineCurveSpec(
  curve: SparklineCurve,
): SparklineCurveSpec | null {
  const spec = (curve as Partial<TaggedSparklineCurve>).spec;
  return spec ?? null;
}

/** Rebuild the function a spec names. The worker's side of the tag. */
export function resolveSparklineCurve(spec: SparklineCurveSpec): SparklineCurve {
  switch (spec.kind) {
    case "linear":
      return sparklineCurves.linear;
    case "gamma":
      return sparklineCurves.gamma(spec.g);
    case "log":
      return sparklineCurves.log(spec.knee);
    case "soft":
      return sparklineCurves.soft(spec.k);
  }
}

/**
 * How long a datum stays visible, in seconds — the ONE knob for the time
 * span. `pxPerSec` is derived from it and the element's width, so a datum
 * enters at the right edge and leaves at the left exactly this many seconds
 * later.
 */
export const SPARKLINE_VISIBLE_SECONDS = 15;

/** Window the plotted rate is summed over — a rolling per-second rate. */
export const SPARKLINE_RATE_WINDOW_MS = 1_000;

/**
 * Bins the picture is drawn behind the clock. Two, so the newest bin the
 * right edge can show is one that has been closed for a whole bin — long
 * enough for its frames to have arrived.
 */
export const SPARKLINE_DISPLAY_LAG_BINS = 2;

/**
 * Redraw cadence in ms (~15 Hz). At the session row's scroll rate — on the
 * order of 7 CSS px/s — that is at most one device pixel per step on a 2×
 * display, so the stepping is indistinguishable from a compositor scroll.
 * Revisit only if a much wider consumer makes a step visible; it is one
 * constant.
 */
export const SPARKLINE_TICK_MS = 66;

/** Everything about the instrument's box that does not change between draws. */
export interface SparklineInstrumentGeometry {
  /** The drawing surface's width in CSS px — the VISIBLE width, nothing more. */
  width: number;
  /** Box height in CSS px. */
  height: number;
  /** Device pixel ratio the backing store is scaled by. */
  dpr: number;
  /** y of the zero line. */
  baselineY: number;
  /** Pixels between the baseline and full scale. */
  amplitude: number;
  /** The time→x mapping: how far one second of tape is, in CSS px. */
  pxPerSec: number;
}

/**
 * The window of store bins the picture is drawn from — the whole message
 * between the main thread and the instrument, whichever thread hosts it.
 *
 * `bins` runs oldest→newest and ENDS at `headBin`, an absolute bin index
 * (`floor(ms / binMs)`) on the store's own wall-clock grid. Absolute is what
 * makes this a value rather than a protocol: both sides read `Date.now()`, so
 * there is no clock to convert and no origin to agree on.
 */
export interface SparklineBins {
  /** Absolute index (`floor(ms / binMs)`) of the newest bin in `bins`. */
  headBin: number;
  /** The window oldest→newest; `bins[bins.length - 1]` is `headBin`. */
  bins: readonly number[];
  /**
   * What time PAST the head holds. A rate channel's unsent time is silence,
   * so it reads zero and the plot decays; a gauge's is the level it was last
   * told about, which under the emitter's no-news-is-no-news contract is
   * still the truth. This is the one place the two channel kinds differ.
   */
  hold: boolean;
}

/** The seams a test replaces, plus the paint the instrument is pointed at. */
export interface SparklineInstrumentOptions {
  /** The surface to draw on. Either flavour of 2D context. */
  ctx: SparklineDrawContext;
  geometry: SparklineInstrumentGeometry;
  colors: SparklineColors;
  /** Bin width in ms — the store's grid, and the display lag's unit. */
  binMs: number;
  /** Rate (per {@link SPARKLINE_RATE_WINDOW_MS}) that reaches full height. */
  fullScale: number;
  /** Vertical response curve. */
  curve: SparklineCurve;
  /**
   * False under `prefers-reduced-motion`: the instrument draws once per store
   * event and never starts a tick. The picture is then a little behind
   * between events, which is the trade reduced motion asks for.
   */
  motion: boolean;
  /** The clock. `Date.now` in production, on both threads. */
  now: () => number;
  setInterval: (fn: () => void, ms: number) => number;
  clearInterval: (handle: number) => void;
  /** Redraw cadence; defaults to {@link SPARKLINE_TICK_MS}. */
  tickMs?: number;
  /**
   * The instrument's one fact, reported only when it MOVES — when the tick
   * starts or stops, or when the rest reading changes. Never per frame: a
   * message on every frame would put whoever is listening back in the loop
   * the worker exists to take them out of.
   */
  onState?: (state: SparklineInstrumentState) => void;
}

/** What an instrument will say about itself, from either thread. */
export interface SparklineInstrumentState {
  /** True while the redraw timer is running. */
  ticking: boolean;
  /** The newest plotted value as of the last draw, 0..1 of full scale. */
  newest: number;
  /**
   * True ⇔ the picture is flat AT ZERO, which is the one reading a stylesheet
   * can draw for itself — so a quiet instrument stays visible whatever the
   * paint path does.
   */
  atRest: boolean;
}

/** Either flavour of 2D context; the instrument uses the common subset. */
export type SparklineDrawContext =
  | CanvasRenderingContext2D
  | OffscreenCanvasRenderingContext2D;

/** Clamp into the display's `[0, 1]`, OUTSIDE the curve. */
function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/**
 * The plotted value for every bin the canvas can show, oldest→newest, ending
 * at the bin `displayNow` falls in, plus the values the picture is ABOUT to
 * take if no further data arrives.
 *
 * This is the whole of the instrument's arithmetic, and it is a pure function
 * of the arguments. Each entry is the rolling one-second sum ending at that
 * bin, taken as a fraction of full scale, shaped by the curve and then
 * clamped — the clamp outside the curve so a saturating curve can take x > 1
 * and roll off gently instead of being pre-clipped.
 *
 * Bins the window does not cover read zero (the store has not been running
 * long enough to have a past there, and inventing one would be a lie), and
 * bins past the head read `hold`'s answer.
 *
 * `drained` carries the far end of that: the plotted values for the bins one
 * whole rolling window into the future, where nothing of the present data is
 * left in the sum. It is never drawn — it is what the flatness test asks
 * before letting the tick stop.
 */
export function sparklinePlotValues(
  data: SparklineBins,
  displayBin: number,
  binMs: number,
  fullScale: number,
  curve: SparklineCurve,
  geometry: SparklineInstrumentGeometry,
): { firstBin: number; values: number[]; drained: number[] } {
  const { bins, headBin, hold } = data;
  const oldestBin = headBin - bins.length + 1;
  const held = hold && bins.length > 0 ? bins[bins.length - 1] : 0;
  const rawAt = (bin: number): number => {
    if (bin > headBin) return held;
    const i = bin - oldestBin;
    return i >= 0 && i < bins.length ? bins[i] : 0;
  };

  // Enough bins to cover the canvas from its left edge, plus one so the
  // leftmost visible segment starts off-canvas rather than at x = 0.
  const binsPerSec = 1000 / binMs;
  const visibleBins =
    Math.ceil((geometry.width / geometry.pxPerSec) * binsPerSec) + 1;
  const firstBin = displayBin - visibleBins;
  const rateBins = Math.max(1, Math.round(SPARKLINE_RATE_WINDOW_MS / binMs));

  const plotAt = (bin: number): number => {
    let sum = 0;
    for (let k = 0; k < rateBins; k++) sum += rawAt(bin - k);
    return clamp01(curve(sum / fullScale));
  };
  const values: number[] = [];
  for (let bin = firstBin; bin <= displayBin; bin++) values.push(plotAt(bin));
  const drained: number[] = [];
  for (let k = 1; k <= rateBins; k++) drained.push(plotAt(displayBin + k));
  return { firstBin, values, drained };
}

/**
 * Draw the whole picture: clear, then the staircase from `values`, filled to
 * the baseline and stroked.
 *
 * The shape is a SAMPLE-AND-HOLD STAIRCASE — each value is held flat across
 * its own bin and then steps — and the newest value is held flat PAST the
 * right edge, so the edge is always covered and a datum never pops into view
 * against blank canvas.
 */
export function drawSparklineInstrument(
  ctx: SparklineDrawContext,
  geometry: SparklineInstrumentGeometry,
  colors: SparklineColors,
  plot: { firstBin: number; values: readonly number[] },
  displayNow: number,
  binMs: number,
): void {
  const { dpr, width, height, baselineY, amplitude, pxPerSec } = geometry;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const { firstBin, values } = plot;
  if (values.length === 0) return;

  const xOf = (t: number): number => width - ((displayNow - t) / 1000) * pxPerSec;
  const yOf = (v: number): number => baselineY - v * amplitude;

  // One staircase, built once: the fill closes it to the baseline and the
  // stroke re-traces it, exactly as the area/line pair did.
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const bin = firstBin + i;
    const y = yOf(values[i]);
    xs.push(xOf(bin * binMs), xOf((bin + 1) * binMs));
    ys.push(y, y);
  }

  ctx.beginPath();
  ctx.moveTo(xs[0], ys[0]);
  for (let i = 1; i < xs.length; i++) ctx.lineTo(xs[i], ys[i]);

  ctx.globalAlpha = colors.areaAlpha;
  ctx.fillStyle = colors.area;
  ctx.lineTo(xs[xs.length - 1], baselineY);
  ctx.lineTo(xs[0], baselineY);
  ctx.closePath();
  ctx.fill();

  // Re-trace for the stroke: the fill's closing edges along the baseline are
  // not part of the line.
  ctx.beginPath();
  ctx.moveTo(xs[0], ys[0]);
  for (let i = 1; i < xs.length; i++) ctx.lineTo(xs[i], ys[i]);
  ctx.globalAlpha = colors.lineAlpha;
  ctx.strokeStyle = colors.line;
  ctx.lineWidth = colors.lineWidth;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/**
 * The instrument: a window of bins, a clock, and a timer handle.
 *
 * Nothing else is remembered between frames. `setBins` is the only input on
 * the hot path, and everything the picture shows is recomputed from it and
 * the clock at draw time.
 */
export class SparklineInstrument {
  private readonly opts: SparklineInstrumentOptions;
  private readonly tickMs: number;
  private data: SparklineBins | null = null;
  /** The only state: a timer handle, or null when the picture is still. */
  private timer: number | null = null;
  /** The last state reported, or null before the first. */
  private reported: SparklineInstrumentState | null = null;
  /** Newest plotted value at the last draw — the test surface's one fact. */
  private newest = 0;
  /** The rest reading at the last draw. */
  private atRest = false;

  constructor(opts: SparklineInstrumentOptions) {
    this.opts = opts;
    this.tickMs = opts.tickMs ?? SPARKLINE_TICK_MS;
  }

  /**
   * A store event: take the new window and draw it. Under motion this also
   * starts the tick unless the picture is already flat and settled; with
   * motion off this one draw IS the update.
   */
  setBins(data: SparklineBins): void {
    this.data = data;
    const { flat } = this.draw();
    if (this.opts.motion) {
      if (flat) this.stop();
      else this.start();
    }
    this.publish();
  }

  /** Theme or dominant-channel change: repaint in the new paint. */
  setColors(colors: SparklineColors): void {
    this.opts.colors = colors;
    this.draw();
  }

  /** Re-fit to a new box (a resize, or a device-pixel-ratio change). */
  setGeometry(geometry: SparklineInstrumentGeometry): void {
    this.opts.geometry = geometry;
    this.draw();
  }

  /** True while the redraw timer is running. */
  isTicking(): boolean {
    return this.timer !== null;
  }

  /** The newest plotted value as of the last draw, 0..1 of full scale. */
  newestValue(): number {
    return this.newest;
  }

  /** Stop the tick and drop the timer. Idempotent. */
  stop(): void {
    if (this.timer === null) return;
    this.opts.clearInterval(this.timer);
    this.timer = null;
  }

  /** The one fact, read directly — the main-thread host's route to it. */
  state(): SparklineInstrumentState {
    return { ticking: this.timer !== null, newest: this.newest, atRest: this.atRest };
  }

  dispose(): void {
    this.stop();
    this.data = null;
  }

  /**
   * One frame. Draws the picture for the current clock and reports whether it
   * is flat — the caller's cue to stop, since scrolling a flat line moves no
   * pixel.
   */
  draw(): { flat: boolean; newest: number } {
    const data = this.data;
    if (data === null) return { flat: true, newest: 0 };
    const { binMs, fullScale, curve, geometry, colors, ctx } = this.opts;
    const displayNow = this.opts.now() - SPARKLINE_DISPLAY_LAG_BINS * binMs;
    const displayBin = Math.floor(displayNow / binMs);
    const plot = sparklinePlotValues(
      data,
      displayBin,
      binMs,
      fullScale,
      curve,
      geometry,
    );
    drawSparklineInstrument(ctx, geometry, colors, plot, displayNow, binMs);

    const { values } = plot;
    this.newest = values.length === 0 ? 0 : values[values.length - 1];
    // Flat AND settled: nothing on screen differs from the newest value, and
    // nothing the rolling window still holds will move it once it drains.
    const flat =
      values.every((v) => v === this.newest) &&
      plot.drained.every((v) => v === this.newest);
    this.atRest = flat && this.newest === 0;
    return { flat, newest: this.newest };
  }

  /** Start the tick if it is off and the picture still has somewhere to go. */
  private start(): void {
    if (this.timer !== null) return;
    this.timer = this.opts.setInterval(() => this.tick(), this.tickMs);
  }

  /**
   * Draw, and stop on a flat picture. Stopping is safe precisely because it
   * is not a decision anything later depends on: the next store event starts
   * the tick again, and the first frame after that is a whole correct
   * picture.
   */
  private tick(): void {
    if (this.draw().flat) this.stop();
    this.publish();
  }

  /** Report the one fact, and only when it moved. */
  private publish(): void {
    const next = this.state();
    const last = this.reported;
    if (
      last !== null &&
      last.ticking === next.ticking &&
      last.atRest === next.atRest
    ) {
      return;
    }
    this.reported = next;
    this.opts.onState?.(next);
  }
}
