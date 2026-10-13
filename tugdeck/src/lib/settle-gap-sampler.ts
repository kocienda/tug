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
 * and is not read.
 *
 * A row carries the beat in force at both ends of its gap — the engine knows
 * its beats, not the gesture that asked for them; the `settle-arm` row before
 * it in the ring says which arrangement that was — and how far into the
 * window it fell. Both ends, because the first sampled frame precedes the
 * deferred React commit: the set-up (that commit, the Last pass, layout, the
 * beats' creation) falls inside the first gap and ends where a beat launches,
 * so a row labelled only by the beat in force at its late frame charged the
 * set-up's cost to the beat that followed it. A row that starts in `set-up` is
 * the set-up's cost and is classed `lead`, the budget set-up-and-go allows; any
 * other row is inside the motion and classed `judder`, which is the class the
 * one-period bar is read over. A row that crosses from one beat to another is
 * still mid-motion, so it is a judder too: the bar is not loosened by where a
 * late frame happened to straddle a launch.
 *
 * The ring has a second consumer: the ingest Worker paces its batches to the
 * period it learns (`postDisplayPeriod` in `settle-engine.ts`, posted where a
 * settle's sampling stops). So before the first settle a faster display is
 * paced at the 60 Hz fallback, which errs toward the slower cadence.
 */

import { FALLBACK_FRAME_PERIOD_MS, GAP_TOLERANCE } from "./settle-frame-probe";

/** How many recent gaps the period is learned from. */
export const PERIOD_RING = 32;

/** How many gaps the ring needs before its reading replaces the 60 Hz fallback. */
export const PERIOD_MIN_GAPS = 8;

/** The quantile of the ring read as the period: the median. */
const PERIOD_QUANTILE = 0.5;

/**
 * A row's class: `lead` for a gap that starts in the set-up, a budget;
 * `judder` for one inside the motion, which the one-period bar reads.
 */
export type SettleGapClass = "lead" | "judder";

/** The beat a gap that starts before any beat has launched is read in. */
export const SET_UP_BEAT = "set-up";

/** The class of a gap that starts in `startBeat`. */
export function gapClassOf(startBeat: string): SettleGapClass {
  return startBeat === SET_UP_BEAT ? "lead" : "judder";
}

/** The row one long gap records. */
export interface SettleGapRow {
  /** The beat in force at the frame before the gap, or `"set-up"` before one. */
  startBeat: string;
  /** The beat in force when the late frame arrived. */
  endBeat: string;
  /** Whether the gap is the set-up's cost or a judder inside the motion. */
  class: SettleGapClass;
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
  private beatOf: () => string = () => SET_UP_BEAT;
  /** The beat in force at the last sampled frame: the start beat of the next gap. */
  private lastBeat: string = SET_UP_BEAT;
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
    const startBeat = this.lastBeat;
    const endBeat = this.beatOf();
    this.last = at;
    this.lastBeat = endBeat;
    if (last === null) {
      this.first = at;
      return;
    }
    const gap = at - last;
    if (gap <= 0) return;
    const period = this.period();
    if (gap > period * GAP_TOLERANCE) {
      this.source.record({
        startBeat,
        endBeat,
        class: gapClassOf(startBeat),
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
