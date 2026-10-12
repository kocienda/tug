/**
 * live-publish-tick — the one frame every streaming store publishes on.
 *
 * A session store coalesces its same-phase text deltas so a token burst costs
 * React one render per frame rather than one per token. Each store used to do
 * that on its own trailing 16 ms timer, which is neither aligned to the frame
 * nor shared: with N sessions streaming, React was told N times per frame at
 * N unrelated moments. Every store now hands its pending publish to this
 * tick, which runs them all together on one `requestAnimationFrame` — one
 * frame-aligned pass that tells React once per store, inside one task.
 *
 * Only the coalesced publishes ride it. A store's structural publishes —
 * phase changes, tool results, errors, control frames — stay synchronous, and
 * one of those cancels the store's pending entry here, since it carries
 * everything reduced so far.
 *
 * A deadline timer stands behind the frame, because rAF never fires in an
 * occluded window, and a background card's transcript must not freeze. The
 * deadline is the after-paint door's ([L32]), and whichever fires first
 * releases the other. Without `requestAnimationFrame` (a unit test, a worker)
 * a one-frame timer stands in for the frame, the cadence the per-store timer
 * had.
 */

import { AFTER_PAINT_DEADLINE_MS } from "./after-paint";

/** What the tick schedules on, injectable for tests. */
export interface PublishTickSource {
  /** `null` when there is no frame to wait for. */
  requestFrame: ((cb: () => void) => unknown) | null;
  cancelFrame: (handle: unknown) => void;
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

/** The stand-in for a frame where there is none: one display frame. */
export const FRAMELESS_TICK_MS = 16;

const DEFAULT_SOURCE: PublishTickSource = {
  requestFrame:
    typeof requestAnimationFrame === "function"
      ? (cb) => requestAnimationFrame(cb)
      : null,
  cancelFrame: (handle) => cancelAnimationFrame(handle as number),
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class LivePublishTick {
  private readonly pending = new Set<() => void>();
  private frame: unknown | null = null;
  private deadline: unknown | null = null;

  constructor(private readonly source: PublishTickSource = DEFAULT_SOURCE) {}

  /** Run `flush` on the next tick; a flush already pending is not added twice. */
  schedule(flush: () => void): void {
    this.pending.add(flush);
    if (this.frame !== null || this.deadline !== null) return;
    const { requestFrame } = this.source;
    if (requestFrame !== null) {
      this.frame = requestFrame(() => this.run());
      this.deadline = this.source.setTimeout(() => this.run(), AFTER_PAINT_DEADLINE_MS);
    } else {
      this.deadline = this.source.setTimeout(() => this.run(), FRAMELESS_TICK_MS);
    }
  }

  /** Drop `flush` from the next tick; the tick disarms when nothing is left. */
  cancel(flush: () => void): void {
    if (!this.pending.delete(flush)) return;
    if (this.pending.size === 0) this.disarm();
  }

  /** How many publishes the next tick carries. */
  get size(): number {
    return this.pending.size;
  }

  private disarm(): void {
    if (this.frame !== null) this.source.cancelFrame(this.frame);
    if (this.deadline !== null) this.source.clearTimeout(this.deadline);
    this.frame = null;
    this.deadline = null;
  }

  /**
   * Run every pending publish once, each guarded, so one store's throw takes
   * no other with it; the first error is rethrown once all have run.
   */
  private run(): void {
    this.disarm();
    const due = [...this.pending];
    this.pending.clear();
    let first: { error: unknown } | null = null;
    for (const flush of due) {
      try {
        flush();
      } catch (error) {
        if (first === null) first = { error };
        else console.error("[live-publish-tick] a further publish threw", error);
      }
    }
    if (first !== null) throw first.error;
  }
}

/** The tick every `CodeSessionStore` shares. */
export const livePublishTick = new LivePublishTick();
