/**
 * Whether anyone can see this body, and whether it has gone dormant.
 *
 * The host decides what shows and tells each body page through
 * `onBodyVisibility` (`host/declarations/lifecycle.ts`): shown while its
 * container paints, a sibling behind its pane's active card included; hidden
 * once the host has hidden it, a parked or folded body. This store keeps that
 * fact for the page's readers, and runs the clock it implies: a body hidden
 * for `dormantAfterMs` goes dormant by itself.
 *
 * Dormant is sticky in one direction. Being shown again cancels a clock that
 * has not fired, but a body that has gone dormant stays dormant until it says
 * it has caught up ({@link BodyVisibilityStore.wake}), because the frames
 * between the show and the catch-up are still the stale ones.
 *
 * Host plumbing for one page, so not a bus store: no other page reads a
 * body's visibility, and a replica would make every page a reader of every
 * other's for no reader.
 *
 * The clock is injected, so the store and its timing are plain unit tests.
 *
 * Laws: [L02] read through `useSyncExternalStore`; [L22] the body's own
 * dormancy work subscribes to the store directly.
 *
 * @module lib/body-visibility-store
 */

import type { BodyVisibility } from "../host/declarations/lifecycle";
import { DEFAULT_DORMANT_AFTER_MS } from "./dormant-after-pref";
import { Subscribable } from "./subscribable";

/** What the store says of the page. */
export interface BodyVisibilitySnapshot {
  /** Whether the host has the body shown. */
  readonly shown: boolean;
  /** When `shown` last changed, wall-clock ms (the host's `since`). */
  readonly since: number;
  /** Hidden past `dormantAfterMs`, and not yet caught up since. */
  readonly dormant: boolean;
}

/** The clock the dormant timer runs on: wall-clock ms and one-shot timers. */
export interface DormantClock {
  now(): number;
  setTimeout(fire: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const SYSTEM_CLOCK: DormantClock = {
  now: () => Date.now(),
  setTimeout: (fire, ms) => setTimeout(fire, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Before the host has said anything the page is taken as shown: a bound page is being looked at. */
const INITIAL: BodyVisibilitySnapshot = { shown: true, since: 0, dormant: false };

export class BodyVisibilityStore extends Subscribable {
  private snapshot: BodyVisibilitySnapshot = INITIAL;
  private timer: unknown = null;

  constructor(
    private readonly clock: DormantClock = SYSTEM_CLOCK,
    private dormantAfterMs: number = DEFAULT_DORMANT_AFTER_MS,
  ) {
    super();
  }

  getSnapshot = (): BodyVisibilitySnapshot => this.snapshot;

  /** The delay the clock runs to. */
  get delayMs(): number {
    return this.dormantAfterMs;
  }

  /** The host's word. Hidden arms the clock from `since`; shown cancels it. */
  apply(visibility: BodyVisibility): void {
    const current = this.snapshot;
    if (current.shown === visibility.shown && current.since === visibility.since) return;
    this.snapshot = { ...current, shown: visibility.shown, since: visibility.since };
    this.rearm();
    this.notify();
  }

  /**
   * A new delay. A hidden body's clock is re-armed against it, still counted
   * from when it was hidden, so a delay shortened past the time already spent
   * hidden makes it dormant at once.
   */
  setDormantAfterMs(ms: number): void {
    if (ms === this.dormantAfterMs) return;
    this.dormantAfterMs = ms;
    this.rearm();
  }

  /** The body has caught up: it leaves dormant. A no-op on a body that is not. */
  wake(): void {
    if (!this.snapshot.dormant) return;
    this.snapshot = { ...this.snapshot, dormant: false };
    this.rearm();
    this.notify();
  }

  /** Stop the clock, for a page going away. */
  dispose(): void {
    this.disarm();
  }

  private rearm(): void {
    this.disarm();
    const { shown, since, dormant } = this.snapshot;
    if (shown || dormant) return;
    const remaining = Math.max(0, this.dormantAfterMs - (this.clock.now() - since));
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      if (this.snapshot.shown || this.snapshot.dormant) return;
      this.snapshot = { ...this.snapshot, dormant: true };
      this.notify();
    }, remaining);
  }

  private disarm(): void {
    if (this.timer === null) return;
    this.clock.clearTimeout(this.timer);
    this.timer = null;
  }
}

/** This page's store. Only a body page is ever told anything; the shell's reads as shown. */
export const bodyVisibilityStore = new BodyVisibilityStore();
