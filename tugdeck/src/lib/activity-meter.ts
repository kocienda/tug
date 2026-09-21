/**
 * Activity meters — the per-channel rolling-bin records behind the
 * {@link SessionActivityStore} ([P02]). Two aggregation kinds:
 *
 *  - **rate** (`text | tokens | tools | subagents`): work accumulated into
 *    fixed 250 ms wall-clock bins. `series` returns the per-bin counts
 *    oldest→newest; the sparkline sums the trailing window into a
 *    per-second rate. Advancing past idle bins zero-fills them, so a
 *    stalled turn decays to a flat line on its own. This is the
 *    ThroughputMeter behavior the deck used to derive locally, relocated
 *    intact so the compact strip's feel is unchanged.
 *
 *  - **gauge** (`cpu | memory | disk`): a level, not a flow. The gauge
 *    **sample-and-holds indefinitely** under the emitter's
 *    no-news-is-no-news contract: tugcast publishes a gauge only when it
 *    changes, and publishes a final zero when a session's subtree dies,
 *    so an unchanged level simply receives no frames — the hold is the
 *    truth, and there is no TTL to decay it into a lie.
 *
 * NOT React state: both are high-churn, mutated per sample and read
 * imperatively by consumers woken from the store's activity events,
 * painted outside React ([L02], [L06], [P03]).
 *
 * @module lib/activity-meter
 */

/** Width of one bin, in ms (4 Hz) — matches tugcode's `activity_delta` flush. */
export const ACTIVITY_BIN_MS = 250;
/**
 * Bins retained. The window serves two consumers, and the LARGER one sets it:
 * the rolling ~1s rate needs only a handful of trailing bins, but the
 * sparkline draws its WHOLE picture from these bins on every frame, so the
 * window must cover everything the screen shows at once. That span is the
 * visible 15 s plus the display lag the instrument draws behind the clock
 * (two bins, 500 ms) — a window shorter than the sum would FABRICATE
 * emptiness at the left edge over a span the screen is currently showing.
 * 80 bins is 20 s: the shown span with four and a half seconds of slack.
 */
export const ACTIVITY_WINDOW_BINS = 80;

/** Shared surface both meter kinds expose to the store. */
export interface ActivityMeterLike {
  record(value: number, atMs: number): void;
  /** Window snapshot oldest→newest as of `nowMs`. */
  series(nowMs: number): number[];
  /** Latest held value, or null when there is none (gauge) / for rates. */
  raw(nowMs: number): number | null;
}

/**
 * Rate meter: fixed-bin accumulation with zero-fill-on-advance decay.
 * Structurally the former `ThroughputMeter`, generalized to any rate
 * channel.
 */
export class RateMeter implements ActivityMeterLike {
  private readonly bins: Float64Array;
  private readonly binMs: number;
  /** Absolute index (floor(ms/binMs)) of the newest bin; -1 until first use. */
  private headBin = -1;

  constructor(
    binMs: number = ACTIVITY_BIN_MS,
    windowBins: number = ACTIVITY_WINDOW_BINS,
  ) {
    this.binMs = binMs;
    this.bins = new Float64Array(windowBins);
  }

  record(units: number, atMs: number): void {
    if (!(units > 0)) return;
    const bin = Math.floor(atMs / this.binMs);
    this.advanceTo(bin);
    this.bins[this.indexFor(bin)] += units;
  }

  series(nowMs: number): number[] {
    this.advanceTo(Math.floor(nowMs / this.binMs));
    const n = this.bins.length;
    const out = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      const bin = this.headBin - (n - 1) + i;
      out[i] = bin < 0 ? 0 : this.bins[this.indexFor(bin)];
    }
    return out;
  }

  /** Rates have no held "current value"; the series carries their shape. */
  raw(): number | null {
    return null;
  }

  private advanceTo(bin: number): void {
    if (this.headBin < 0) {
      this.headBin = bin;
      return;
    }
    if (bin <= this.headBin) return;
    const n = this.bins.length;
    const gap = bin - this.headBin;
    if (gap >= n) {
      this.bins.fill(0);
    } else {
      for (let k = 1; k <= gap; k++) {
        this.bins[this.indexFor(this.headBin + k)] = 0;
      }
    }
    this.headBin = bin;
  }

  private indexFor(bin: number): number {
    const n = this.bins.length;
    return ((bin % n) + n) % n;
  }
}

/**
 * Gauge meter: sample-and-hold over the same absolute-wall-clock bin grid
 * `RateMeter` uses, so a gauge channel has a PAST and the sparkline can draw
 * it. The emitter's contract is "no news is no news": tugcast's resource
 * sampler publishes a gauge channel only when its value changes, and
 * publishes one final zero frame when a session's subtree dies — so between
 * frames the held level IS the truth, and a time-based decay here would turn
 * a steady reading into a lie. Hold-forward is that contract expressed on
 * the grid: every bin from a sample's own up to the bin being read carries
 * that sample's level, until the next sample moves it or the emitter's final
 * zero brings it down. Nothing expires on its own.
 *
 * Bins BEFORE the first sample stay zero rather than adopting the first
 * level: a level the meter had not yet been told about is not a level it may
 * draw, and smearing the first sample backwards over the whole window would
 * invent a past.
 */
export class GaugeMeter implements ActivityMeterLike {
  private readonly levels: Float64Array;
  private readonly binMs: number;
  /** Absolute index (floor(ms/binMs)) of the newest bin; -1 until first use. */
  private headBin = -1;
  private latestValue: number | null = null;

  constructor(
    binMs: number = ACTIVITY_BIN_MS,
    windowBins: number = ACTIVITY_WINDOW_BINS,
  ) {
    this.binMs = binMs;
    this.levels = new Float64Array(windowBins);
  }

  record(value: number, atMs: number): void {
    if (!Number.isFinite(value)) return;
    const bin = Math.floor(atMs / this.binMs);
    this.advanceTo(bin);
    // A sample older than the head lands nowhere: the bins it would have
    // filled are already written, and rewriting them would revise values the
    // screen has shown. The held level still moves, which is what `raw` reads.
    if (bin >= this.headBin) this.levels[this.indexFor(bin)] = value;
    this.latestValue = value;
  }

  series(nowMs: number): number[] {
    this.advanceTo(Math.floor(nowMs / this.binMs));
    const n = this.levels.length;
    const out = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      const bin = this.headBin - (n - 1) + i;
      out[i] = bin < 0 ? 0 : this.levels[this.indexFor(bin)];
    }
    return out;
  }

  raw(_nowMs: number): number | null {
    return this.latestValue;
  }

  /**
   * Carry the held level forward to `bin`, filling every bin crossed. This is
   * the one place the hold becomes data; a bin, once written, is never
   * revised.
   */
  private advanceTo(bin: number): void {
    if (this.headBin < 0) {
      this.headBin = bin;
      return;
    }
    if (bin <= this.headBin) return;
    const n = this.levels.length;
    const held = this.latestValue ?? 0;
    const gap = bin - this.headBin;
    if (gap >= n) {
      this.levels.fill(held);
    } else {
      for (let k = 1; k <= gap; k++) {
        this.levels[this.indexFor(this.headBin + k)] = held;
      }
    }
    this.headBin = bin;
  }

  private indexFor(bin: number): number {
    const n = this.levels.length;
    return ((bin % n) + n) % n;
  }
}
