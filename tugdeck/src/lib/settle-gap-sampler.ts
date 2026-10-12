/**
 * settle-gap-sampler — the one frame record a settle keeps on every deck.
 *
 * The settle's own frame record (`settle-frames`) is armed by name, because it
 * reads a computed style per shown frame per tick; on a deck nobody is
 * measuring it runs nothing. So a user who says "it sometimes drops frames"
 * has, on their own deck, no row to point at. This sampler is that row at the
 * cheapest it can be: while the settling mark is on, one rAF per frame and
 * one subtraction, and a `settle-gap` row — always recorded — when two frames
 * are further apart than one display period. Nothing runs at rest: it is
 * started by the commit that puts the mark on and stopped by the one that
 * takes it off, on every path ([D1]).
 *
 * The gap is read between frame timestamps, and the display's period is
 * learned from them rather than assumed at 60 Hz: it is the median of the last
 * {@link PERIOD_RING} gaps, kept across windows — the settle record's own
 * estimator. Not the smallest gap: WebKit delivers a late frame and the one
 * catching up behind it a few ms apart, and a period learned off that pair
 * read 2–5 ms and called every ordinary frame late. Not the lower quartile
 * either: early in a streaming deck's first settle a quarter of the gaps are
 * catch-ups, and it read 4–6 ms there. The median stands clear of both the
 * catch-ups and the long gaps while each is under half the ring. The gap from the mark going
 * on to the first frame is the settle's lead, a budget rather than a defect,
 * and is not read; every gap after it is inside the motion.
 *
 * A row carries the beat the gap fell in — the engine knows its beats, not the
 * gesture that asked for them; the `settle-arm` row before it in the ring says
 * which arrangement that was — and how far into the window it fell.
 */

import { FALLBACK_FRAME_PERIOD_MS, GAP_TOLERANCE } from "./settle-frame-probe";

/** How many recent gaps the period is learned from. */
export const PERIOD_RING = 32;

/** How many gaps the ring needs before its reading replaces the 60 Hz fallback. */
export const PERIOD_MIN_GAPS = 8;

/** The quantile of the ring read as the period: the median. */
const PERIOD_QUANTILE = 0.5;

/** The row one long gap records. */
export interface SettleGapRow {
  /** The beat in force when the late frame arrived, or `"set-up"` before one. */
  beat: string;
  /** The gap between the two frames, in ms. */
  gapMs: number;
  /** The display period the gap was judged against, in ms. */
  periodMs: number;
  /** How far into the window the late frame arrived, from its first frame. */
  offsetMs: number;
}

/** What the sampler runs on and writes to, injectable for tests. */
export interface SettleGapSource {
  /** `null` where there is no frame to wait for, which samples nothing. */
  requestFrame: (cb: (at: number) => void) => number | null;
  cancelFrame: (id: number) => void;
  record: (row: SettleGapRow) => void;
}

export class SettleGapSampler {
  private frame: number | null = null;
  private last: number | null = null;
  private first: number | null = null;
  private beatOf: () => string = () => "set-up";
  /** The last {@link PERIOD_RING} gaps, from every window, oldest overwritten. */
  private readonly gaps: number[] = [];
  private nextGap = 0;

  constructor(private readonly source: SettleGapSource) {}

  /**
   * Sample frames until {@link stop}. A start while running keeps the window
   * and takes the new beat reader: a retarget is the same motion window.
   */
  start(beatOf: () => string): void {
    this.beatOf = beatOf;
    if (this.frame !== null) return;
    this.last = null;
    this.first = null;
    this.frame = this.source.requestFrame(this.tick);
  }

  /** Stop sampling; idempotent, so every path that takes the mark off may call it. */
  stop(): void {
    if (this.frame !== null) this.source.cancelFrame(this.frame);
    this.frame = null;
    this.last = null;
    this.first = null;
  }

  /** Whether a window is being sampled. */
  get running(): boolean {
    return this.frame !== null;
  }

  private readonly tick = (at: number): void => {
    this.frame = this.source.requestFrame(this.tick);
    const last = this.last;
    this.last = at;
    if (last === null) {
      this.first = at;
      return;
    }
    const gap = at - last;
    if (gap <= 0) return;
    const period = this.period();
    if (gap > period * GAP_TOLERANCE) {
      this.source.record({
        beat: this.beatOf(),
        gapMs: gap,
        periodMs: period,
        offsetMs: at - (this.first ?? last),
      });
    }
    if (this.gaps.length < PERIOD_RING) this.gaps.push(gap);
    else this.gaps[this.nextGap] = gap;
    this.nextGap = (this.nextGap + 1) % PERIOD_RING;
  };

  /**
   * The display's period as the ring reads it, or the 60 Hz fallback before
   * it can. Public because the ingest Worker paces its batches to it, and
   * learns it from the settle engine each time a settle's sampling stops.
   */
  periodMs(): number {
    return this.period();
  }

  private period(): number {
    if (this.gaps.length < PERIOD_MIN_GAPS) return FALLBACK_FRAME_PERIOD_MS;
    const sorted = [...this.gaps].sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) * PERIOD_QUANTILE)];
  }
}
