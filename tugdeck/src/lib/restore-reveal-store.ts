/**
 * restore-reveal-store.ts — the deck's one reveal queue, driven.
 *
 * {@link stepRevealQueue} is the rule; this is the driver around it. It
 * holds the queue's state for the whole deck, feeds the rule the deck-owned
 * events it decides over — a frame, a task, a card's settle or removal — and
 * publishes two things through `subscribe` / `getSnapshot` ([L02]): whether
 * the busy cover is requested, and which cards are under it. A Session card
 * reads {@link RestoreRevealStore.isAdmitted} to learn when its first list
 * mount may run.
 *
 * What it schedules, and why each is bounded:
 *
 * - **frames** — a rAF chain, only while the cover is requested. It is the
 *   cover's own clock (composite, linger, release) and ends with the cover.
 * - **a task** — one `setTimeout(0)` while a card is queued under a raised
 *   cover, so each admission is its own task and the deck paints between
 *   reveals.
 * - **a deadline** — one `setTimeout` at the nearest of the composite bound
 *   (while arming) and the earliest in-flight settle bound. It fires a task
 *   event, which is how a window whose frames have stopped still admits and
 *   still expires. Re-armed only when that nearest deadline moves.
 *
 * Nothing here waits on the wire: a card enqueues only after its replay has
 * completed, so every wait this store holds is on the deck's own work ([L33]).
 *
 * @module lib/restore-reveal-store
 */

import {
  COVER_COMPOSITE_BOUND_MS,
  INITIAL_REVEAL_QUEUE,
  REVEAL_SETTLE_BOUND_MS,
  coverRequested,
  revealingCardIds,
  stepRevealQueue,
  type RevealQueueEvent,
  type RevealQueueState,
} from "./restore-reveal-queue";

/** What the cover renders from. Identity changes only when a field does. */
export interface RestoreRevealSnapshot {
  /** The cover is requested — arming or up. */
  readonly cover: boolean;
  /** The cards queued or in flight, in admission order. */
  readonly cardIds: readonly string[];
}

/** The scheduling primitives the store needs, injectable for tests. */
export interface RevealScheduler {
  now(): number;
  requestFrame(cb: () => void): void;
  setTimer(cb: () => void, ms: number): () => void;
}

const DOM_SCHEDULER: RevealScheduler = {
  now: () => performance.now(),
  requestFrame: (cb) => {
    requestAnimationFrame(() => cb());
  },
  setTimer: (cb, ms) => {
    const id = setTimeout(cb, ms);
    return () => clearTimeout(id);
  },
};

const EMPTY_SNAPSHOT: RestoreRevealSnapshot = { cover: false, cardIds: [] };

export class RestoreRevealStore {
  private state: RevealQueueState = INITIAL_REVEAL_QUEUE;
  private snapshot: RestoreRevealSnapshot = EMPTY_SNAPSHOT;
  private readonly admitted = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private framePending = false;
  private cancelTask: (() => void) | null = null;
  private cancelDeadline: (() => void) | null = null;
  private deadlineAt: number | null = null;

  constructor(private readonly scheduler: RevealScheduler = DOM_SCHEDULER) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): RestoreRevealSnapshot => this.snapshot;

  /**
   * Whether a card's reveal has been admitted and its first list mount may
   * run. True from admission until the card's settle or removal; the card
   * latches its own mount, so the reveal does not unmount when this falls.
   */
  isAdmitted(cardId: string): boolean {
    return this.admitted.has(cardId);
  }

  /** A card's initial replay completed; queue its reveal. */
  enqueue(cardId: string): void {
    this.apply({ type: "enqueue", cardId, now: this.scheduler.now() });
  }

  /** The card admitted first whenever it is queued — the deck's focused card. */
  setKeyCard(cardId: string | null): void {
    if (this.state.keyCardId === cardId) return;
    this.apply({ type: "key", cardId });
  }

  /** The card's list raised its first settle; its reveal is over. */
  settled(cardId: string): void {
    this.admitted.delete(cardId);
    this.apply({ type: "settled", cardId, now: this.scheduler.now() });
  }

  /** The card unmounted, errored, or will not reveal; it leaves the queue. */
  removed(cardId: string): void {
    this.admitted.delete(cardId);
    this.apply({ type: "removed", cardId, now: this.scheduler.now() });
  }

  private apply(event: RevealQueueEvent): void {
    const step = stepRevealQueue(this.state, event);
    this.state = step.state;
    if (step.admit !== null) this.admitted.add(step.admit);
    // A card whose bound expired is no longer in flight; let go of it.
    for (const id of this.admitted) {
      if (!this.state.inFlight.some((r) => r.cardId === id)) this.admitted.delete(id);
    }
    this.schedule();
    this.publish(step.admit !== null);
  }

  private publish(force: boolean): void {
    const cover = coverRequested(this.state);
    const cardIds = revealingCardIds(this.state);
    const prev = this.snapshot;
    const same =
      prev.cover === cover &&
      prev.cardIds.length === cardIds.length &&
      prev.cardIds.every((id, i) => id === cardIds[i]);
    if (same && !force) return;
    if (!same) this.snapshot = cover || cardIds.length > 0 ? { cover, cardIds } : EMPTY_SNAPSHOT;
    for (const listener of [...this.listeners]) listener();
  }

  private schedule(): void {
    const s = this.state;
    if (coverRequested(s) && !this.framePending) {
      this.framePending = true;
      this.scheduler.requestFrame(() => {
        this.framePending = false;
        this.apply({ type: "frame", now: this.scheduler.now() });
      });
    }
    if (s.cover === "up" && s.queued.length > 0 && this.cancelTask === null) {
      this.cancelTask = this.scheduler.setTimer(() => {
        this.cancelTask = null;
        this.apply({ type: "task", now: this.scheduler.now() });
      }, 0);
    }
    this.scheduleDeadline();
  }

  /** One timer at the nearest bound the rule would act on. */
  private scheduleDeadline(): void {
    const s = this.state;
    let at: number | null = null;
    if (s.cover === "arming" && s.armedAt !== null) at = s.armedAt + COVER_COMPOSITE_BOUND_MS;
    for (const r of s.inFlight) {
      const expiry = r.admittedAt + REVEAL_SETTLE_BOUND_MS;
      if (at === null || expiry < at) at = expiry;
    }
    if (at === this.deadlineAt) return;
    this.cancelDeadline?.();
    this.cancelDeadline = null;
    this.deadlineAt = at;
    if (at === null) return;
    const delay = Math.max(0, at - this.scheduler.now());
    this.cancelDeadline = this.scheduler.setTimer(() => {
      this.cancelDeadline = null;
      this.deadlineAt = null;
      this.apply({ type: "task", now: this.scheduler.now() });
    }, delay);
  }
}

/** The deck's one queue. */
export const restoreRevealStore = new RestoreRevealStore();
