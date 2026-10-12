/**
 * When the ingest host posts what it has pending.
 *
 * The host appends patches as the wire produces them and asks its flush
 * policy when to post them as one batch. The policy is injected, because the
 * one host class runs in two places: in the Worker it is paced to the display
 * period, so the page receives at most one batch per frame; on the calling
 * thread (unit tests) it posts at the end of every message the host handles,
 * so delivery stays synchronous and the tests keep their shape.
 */

/** The host's side of a flush policy. */
export interface FlushPolicy {
  /** A patch was appended. `immediate` asks for it to post now, carrying whatever is pending. */
  note(immediate: boolean): void;
  /** The host finished handling one message (a socket event, a timer, or a control). */
  endOfMessage(): void;
  /** A new display period. */
  setPeriod(periodMs: number): void;
  /** Disarm anything armed. */
  dispose(): void;
}

/** Posts at the end of every message the host handles. */
export class PerMessageFlush implements FlushPolicy {
  private pending = false;

  constructor(private readonly flush: () => void) {}

  note(): void {
    this.pending = true;
  }

  endOfMessage(): void {
    if (!this.pending) return;
    this.pending = false;
    this.flush();
  }

  setPeriod(): void {}

  dispose(): void {
    this.pending = false;
  }
}

/** The clock and timer a `Pacer` runs on; a test passes a manual one. */
export interface PacerClock {
  now(): number;
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const SYSTEM_CLOCK: PacerClock = {
  now: () => performance.now(),
  setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Posts one batch per display period, as a finisher: armed by the first
 * pending patch, it fires at the next multiple of the period since the last
 * flush, and nothing is armed while nothing is pending. An immediate patch
 * posts at once and carries whatever was pending with it.
 */
export class Pacer implements FlushPolicy {
  private handle: unknown = null;
  private lastFlush: number;

  constructor(
    private readonly flush: () => void,
    private periodMs: number,
    private readonly clock: PacerClock = SYSTEM_CLOCK,
  ) {
    this.lastFlush = clock.now();
  }

  /** Whether a flush is armed. */
  get armed(): boolean {
    return this.handle !== null;
  }

  note(immediate: boolean): void {
    if (immediate) {
      this.fire();
      return;
    }
    if (this.handle !== null) return;
    const now = this.clock.now();
    const periods = Math.max(1, Math.ceil((now - this.lastFlush) / this.periodMs));
    const delay = Math.max(0, this.lastFlush + periods * this.periodMs - now);
    this.handle = this.clock.setTimeout(() => {
      this.handle = null;
      this.fire();
    }, delay);
  }

  endOfMessage(): void {}

  setPeriod(periodMs: number): void {
    this.periodMs = periodMs;
  }

  dispose(): void {
    if (this.handle !== null) this.clock.clearTimeout(this.handle);
    this.handle = null;
  }

  private fire(): void {
    if (this.handle !== null) {
      this.clock.clearTimeout(this.handle);
      this.handle = null;
    }
    this.lastFlush = this.clock.now();
    this.flush();
  }
}
