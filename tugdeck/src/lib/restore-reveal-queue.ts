/**
 * restore-reveal-queue.ts — when a restoring Session card may reveal its
 * transcript, and when the deck's busy cover is up.
 *
 * A cold restore's reveal — a card's first transcript list commit and the
 * settle behind it — is one uninterruptible stretch of main-thread work,
 * 150–450 ms per card on large transcripts, during which every keystroke is
 * lost. The deck says so with an app-wide cover whose whole lifetime is that
 * work and nothing else: it is armed when a reveal is enqueued, it must be on
 * screen before the first reveal runs (or it is never seen), and it lifts once
 * no reveal is queued or in flight. Nothing from the wire closes it. A card
 * still waiting on its relay never enqueues and so never holds it, which is
 * how the cover satisfies [L33] rather than being an exception to it.
 *
 * This module is the rule, and it is pure so the rule can be tested without a
 * deck: a state, the deck-owned events that move it, and the one card each
 * step admits. Time enters only as the `now` an event carries — a frame's or
 * a task's own clock — so there is no timer here and no wire input.
 *
 * The rule:
 *
 * - **enqueue** — a card whose initial replay completed joins the queue,
 *   once. The first enqueue onto a down cover arms it.
 * - **arm** — the cover is requested and counts frames. It is `up` after two
 *   frames (a double rAF: the frame that drew it, then the one that
 *   composited it), or after {@link COVER_COMPOSITE_BOUND_MS} if frames are
 *   not arriving, because a window whose frames have stopped (occluded) must
 *   not leave its cards unrevealed for as long as it stays hidden.
 * - **admit** — on a task, with the cover up, one queued card is admitted:
 *   the key card if it is queued, otherwise the oldest. One per task, so each
 *   reveal is its own task and the deck paints between them.
 * - **in flight** — an admitted reveal holds the cover until its card's first
 *   settle, because the settle frame follows the commit directly and is part
 *   of the same busy stretch. A settle that never comes is bounded by
 *   {@link REVEAL_SETTLE_BOUND_MS}.
 * - **release** — once nothing is queued or in flight, the cover lifts on the
 *   first frame at least {@link COVER_LINGER_MS} later, so reveals a frame or
 *   two apart sit under one appearance rather than blinking.
 * - **removal** — a card removed or errored leaves the queue, queued or in
 *   flight, and never holds the cover.
 *
 * @module lib/restore-reveal-queue
 */

/**
 * How long an armed cover waits for its two frames before reveals are
 * admitted anyway, in milliseconds.
 *
 * A liveness bound for a window whose frames have stopped: an occluded
 * window suspends rAF, and a rule that waited on frames alone would keep its
 * cards behind their restore strips for as long as the window stayed covered.
 * On a visible window two frames arrive in about 33 ms and this is never
 * reached. 100 ms is three frames of slack over that.
 */
export const COVER_COMPOSITE_BOUND_MS = 100;

/**
 * How long an admitted reveal holds the cover without settling, in
 * milliseconds.
 *
 * The settle is the deck's own work — the list's ResizeObserver delivering
 * the batch's heights — but a list that never reports (a card with no size,
 * a bug) must not hold an app-wide cover. Measured settles run 90–320 ms
 * after the commit on a five-card cold restore and up to 800 ms on the
 * release deck's own single-card restore; 2000 ms leaves that more than
 * double, and costs at most two inert seconds in the case it exists for.
 */
export const REVEAL_SETTLE_BOUND_MS = 2000;

/**
 * How long the cover stays up after the queue empties, in milliseconds —
 * about one frame budget, so the release lands on the second frame after the
 * last settle and a reveal enqueued in that frame is still under the same
 * appearance.
 */
export const COVER_LINGER_MS = 17;

/** The cover's three states. */
export type CoverPhase = "down" | "arming" | "up";

/** One admitted reveal, waiting on its settle. */
export interface InFlightReveal {
  readonly cardId: string;
  readonly admittedAt: number;
}

/** The queue's whole state. Immutable; every step returns a new one. */
export interface RevealQueueState {
  /** Cards whose reveal is queued, oldest first. */
  readonly queued: readonly string[];
  /** Admitted reveals not yet settled. */
  readonly inFlight: readonly InFlightReveal[];
  /** The key card — admitted first whenever it is queued. */
  readonly keyCardId: string | null;
  readonly cover: CoverPhase;
  /** When the cover was armed, while `arming`. */
  readonly armedAt: number | null;
  /** Frames seen since the cover was armed, while `arming`. */
  readonly framesSinceArm: number;
  /** When the queue last became empty with the cover still up. */
  readonly emptySince: number | null;
}

/** The deck-owned events that move the queue. */
export type RevealQueueEvent =
  | { type: "enqueue"; cardId: string; now: number }
  | { type: "key"; cardId: string | null }
  | { type: "frame"; now: number }
  | { type: "task"; now: number }
  | { type: "settled"; cardId: string; now: number }
  | { type: "removed"; cardId: string; now: number };

/** A step's result: the next state and the card it admits, if any. */
export interface RevealQueueStep {
  readonly state: RevealQueueState;
  readonly admit: string | null;
}

export const INITIAL_REVEAL_QUEUE: RevealQueueState = {
  queued: [],
  inFlight: [],
  keyCardId: null,
  cover: "down",
  armedAt: null,
  framesSinceArm: 0,
  emptySince: null,
};

/** Whether the deck should be showing the cover (arming or up). */
export function coverRequested(state: RevealQueueState): boolean {
  return state.cover !== "down";
}

/** Whether a card's reveal is queued or in flight. */
export function isRevealPending(state: RevealQueueState, cardId: string): boolean {
  return state.queued.includes(cardId) || state.inFlight.some((r) => r.cardId === cardId);
}

/** The cards under the cover — queued and in flight, in admission order. */
export function revealingCardIds(state: RevealQueueState): string[] {
  return [...state.inFlight.map((r) => r.cardId), ...state.queued];
}

function isEmpty(state: RevealQueueState): boolean {
  return state.queued.length === 0 && state.inFlight.length === 0;
}

/** Stamp `emptySince` when the queue has just drained under a raised cover. */
function markDrained(state: RevealQueueState, now: number): RevealQueueState {
  if (state.cover === "down" || !isEmpty(state) || state.emptySince !== null) return state;
  return { ...state, emptySince: now };
}

/** Drop in-flight reveals past their settle bound. */
function expireInFlight(state: RevealQueueState, now: number): RevealQueueState {
  const live = state.inFlight.filter((r) => now - r.admittedAt < REVEAL_SETTLE_BOUND_MS);
  if (live.length === state.inFlight.length) return state;
  return markDrained({ ...state, inFlight: live }, now);
}

/** Promote an arming cover whose composite bound has run out. */
function boundArming(state: RevealQueueState, now: number): RevealQueueState {
  if (state.cover !== "arming" || state.armedAt === null) return state;
  if (now - state.armedAt < COVER_COMPOSITE_BOUND_MS) return state;
  return { ...state, cover: "up", armedAt: null, framesSinceArm: 0 };
}

/** Lift a drained cover once the linger has passed. */
function maybeRelease(state: RevealQueueState, now: number): RevealQueueState {
  if (state.cover === "down" || !isEmpty(state) || state.emptySince === null) return state;
  if (now - state.emptySince < COVER_LINGER_MS) return state;
  return { ...state, cover: "down", armedAt: null, framesSinceArm: 0, emptySince: null };
}

function without(state: RevealQueueState, cardId: string): RevealQueueState {
  return {
    ...state,
    queued: state.queued.filter((id) => id !== cardId),
    inFlight: state.inFlight.filter((r) => r.cardId !== cardId),
  };
}

/** Advance the queue by one event. */
export function stepRevealQueue(
  state: RevealQueueState,
  event: RevealQueueEvent,
): RevealQueueStep {
  switch (event.type) {
    case "enqueue": {
      if (isRevealPending(state, event.cardId)) return { state, admit: null };
      let next: RevealQueueState = {
        ...state,
        queued: [...state.queued, event.cardId],
        emptySince: null,
      };
      if (next.cover === "down") {
        next = { ...next, cover: "arming", armedAt: event.now, framesSinceArm: 0 };
      }
      return { state: next, admit: null };
    }
    case "key":
      return { state: { ...state, keyCardId: event.cardId }, admit: null };
    case "frame": {
      let next = state;
      if (next.cover === "arming") {
        const frames = next.framesSinceArm + 1;
        next =
          frames >= 2
            ? { ...next, cover: "up", armedAt: null, framesSinceArm: 0 }
            : { ...next, framesSinceArm: frames };
      }
      next = boundArming(next, event.now);
      next = expireInFlight(next, event.now);
      next = maybeRelease(next, event.now);
      return { state: next, admit: null };
    }
    case "task": {
      let next = boundArming(state, event.now);
      next = expireInFlight(next, event.now);
      if (next.cover !== "up" || next.queued.length === 0) return { state: next, admit: null };
      const key = next.keyCardId;
      const admit = key !== null && next.queued.includes(key) ? key : next.queued[0];
      next = {
        ...next,
        queued: next.queued.filter((id) => id !== admit),
        inFlight: [...next.inFlight, { cardId: admit, admittedAt: event.now }],
      };
      return { state: next, admit };
    }
    case "settled": {
      if (!state.inFlight.some((r) => r.cardId === event.cardId)) return { state, admit: null };
      return { state: markDrained(without(state, event.cardId), event.now), admit: null };
    }
    case "removed": {
      if (!isRevealPending(state, event.cardId)) return { state, admit: null };
      let next = markDrained(without(state, event.cardId), event.now);
      // A cover still arming with nothing left to reveal never needs to show.
      if (next.cover === "arming" && isEmpty(next)) next = { ...INITIAL_REVEAL_QUEUE, keyCardId: next.keyCardId };
      return { state: next, admit: null };
    }
  }
}
