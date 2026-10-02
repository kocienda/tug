/**
 * space-switch-mark.ts — the switch epoch's mark, written by the party that
 * guarantees its removal.
 *
 * `DeckManager.activateSpace` writes `data-space-switching` on the canvas in the
 * swap commit, before React hears about the switch, because React runs layout
 * effects child-first and every re-arm in the arriving layer has to see it. The
 * ordinary close is the canvas's: its switch effect watches the arriving layer
 * settle, sweeps the mark, and records the epoch's span.
 *
 * But that effect runs only when React sees the active workspace id CHANGE. Two
 * switches in one task that end where they began leave React with the id it
 * already had, the effect never runs, and the mark stands with nothing armed to
 * take it off — every settle on the deck then runs without tweens until the next
 * real switch. [L32] clause 1: the party that writes a hold owns its removal. So
 * the writer arms a deadline of its own when it writes the mark, set after the
 * canvas's own deadline so the ordinary close always gets there first and this
 * one only ever sweeps a mark nobody else would.
 *
 * @module lib/space-switch-mark
 */

import { AFTER_PAINT_DEADLINE_MS } from "./after-paint";
import {
  SPACE_EPOCH_DEADLINE_MARGIN_MS,
  spaceEpochDeadlineMs,
} from "./space-settled";

/**
 * The writer's deadline, in milliseconds: the canvas's own deadline, plus the
 * longest the canvas's effect can start after the write — React is told on the
 * far side of one painted frame, behind the after-paint door's deadline — plus
 * one more margin. `timing` is `getTugTiming()`.
 */
export function switchMarkDeadlineMs(timing: number): number {
  return (
    spaceEpochDeadlineMs(timing) +
    AFTER_PAINT_DEADLINE_MS +
    SPACE_EPOCH_DEADLINE_MARGIN_MS
  );
}

/** The slice of the canvas the mark writes. */
export interface SwitchMarkHost {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/** The timers the mark's deadline runs on — `window` in the deck. */
export interface SwitchMarkTimers {
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

export class SpaceSwitchMark {
  private deadline: number | null = null;

  constructor(
    private readonly attribute: string,
    private readonly timers: SwitchMarkTimers,
  ) {}

  /**
   * Open an epoch: write the mark on `host` and arm its removal `deadlineMs`
   * later. A previous epoch's deadline is released first — the mark now belongs
   * to this switch. A `null` host (no canvas mounted yet) gets no mark, and so
   * no deadline.
   */
  open(host: SwitchMarkHost | null, deadlineMs: number): void {
    this.release();
    if (host === null) return;
    host.setAttribute(this.attribute, "");
    this.deadline = this.timers.setTimeout(() => {
      this.deadline = null;
      host.removeAttribute(this.attribute);
    }, deadlineMs);
  }

  /** Release the pending deadline, leaving the mark where it stands ([L27]). */
  release(): void {
    if (this.deadline === null) return;
    this.timers.clearTimeout(this.deadline);
    this.deadline = null;
  }

  /** Whether a deadline is armed. */
  get armed(): boolean {
    return this.deadline !== null;
  }
}
