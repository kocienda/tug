/**
 * A `PacerClock` a test advances by hand: timers fire in deadline order as
 * `advance` passes them, each at its own deadline, and nothing fires on its
 * own.
 */

import type { PacerClock } from "../pacer";

export class ManualClock implements PacerClock {
  t = 0;
  private timers = new Map<number, { at: number; cb: () => void }>();
  private next = 1;

  now(): number {
    return this.t;
  }
  setTimeout(cb: () => void, ms: number): unknown {
    const id = this.next++;
    this.timers.set(id, { at: this.t + ms, cb });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  /** How many timers are armed. */
  get armed(): number {
    return this.timers.size;
  }
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      let due: [number, { at: number; cb: () => void }] | null = null;
      for (const entry of this.timers) if (entry[1].at <= target && (due === null || entry[1].at < due[1].at)) due = entry;
      if (due === null) break;
      this.timers.delete(due[0]);
      this.t = due[1].at;
      due[1].cb();
    }
    this.t = target;
  }
}
