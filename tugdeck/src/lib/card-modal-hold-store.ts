/**
 * `cardModalHoldStore` — which cards are currently held by a modal run, and
 * how each one refuses.
 *
 * A pane-modal sheet covers its card's body, and for most sheets that is the
 * whole of modality: a picker the user opened can be dismissed, superseded by
 * another picker, or abandoned by closing the card, and none of that costs
 * anything. A **run** is different. While `/compact` is in flight the card has
 * exactly two honest ways forward — the run completing, or the user canceling
 * it — and every other door the chrome leaves open is a way to lose sight of a
 * run that is still going.
 *
 * A hold is what a run puts on its card while it needs that. It is not a lock
 * in the sense of a thing that silently swallows gestures: it carries the
 * **reason** the card is refusing and the holder's own {@link CardModalHold.refuse}
 * — one voice, so the ✕, ⌘W, Escape, and a superseding `showSheet` all report
 * the same refusal in the same place rather than each inventing its own ([L31]).
 * A door that finds a hold calls {@link refuseCardModalHold} and stops; the
 * holder says why.
 *
 * **One hold per card.** Holds do not nest and do not count: a card is either
 * running something modal or it is not, and a second claim replaces the first
 * (the sheet host that claims is itself single-flight). Release is keyed on the
 * record, so a stale release from a torn-down holder cannot drop the hold a
 * live one has since taken.
 *
 * Module-level singleton, matching the other card-scoped helper stores ([L02]
 * external state reaches React through `useSyncExternalStore`).
 *
 * @module lib/card-modal-hold-store
 */

import { useCallback, useSyncExternalStore } from "react";

export interface CardModalHold {
  /**
   * Why the card is refusing, in the wording the holder would use — short
   * enough for a bulletin, and the same string wherever a door reports it.
   */
  readonly reason: string;
  /**
   * Speak the refusal. Called by whichever door was pressed, so the answer
   * comes from the run that is actually refusing rather than from the chrome
   * that happened to be touched. A holder with nothing to add may leave this a
   * no-op, but it is never the *only* thing a door does — a door with no
   * visible refusal is a door that should not have been pressable.
   */
  readonly refuse: () => void;
}

/** Every card currently held, keyed by card id. */
export type CardModalHolds = ReadonlyMap<string, CardModalHold>;

const NO_HOLDS: CardModalHolds = new Map();

/** Whether `holds` has this card held. */
export function isCardHeld(
  holds: CardModalHolds,
  cardId: string | undefined | null,
): boolean {
  if (cardId === undefined || cardId === null) return false;
  return holds.has(cardId);
}

class CardModalHoldStore {
  private state: CardModalHolds = NO_HOLDS;
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Stable between notifications — safe for `useSyncExternalStore`. */
  getSnapshot = (): CardModalHolds => this.state;

  /** This card's hold, or `null` when it has none. */
  getFor = (cardId: string | null): CardModalHold | null =>
    cardId === null ? null : (this.state.get(cardId) ?? null);

  /**
   * Take the hold on `cardId`, returning its release. The release is keyed on
   * the record it was handed out for: a holder tearing down after another has
   * claimed the card releases nothing, so a card cannot be left unheld while a
   * run is still going.
   */
  hold(cardId: string, hold: CardModalHold): () => void {
    this.write(cardId, hold);
    return () => {
      if (this.state.get(cardId) !== hold) return;
      const next = new Map(this.state);
      next.delete(cardId);
      this.state = next;
      this.emit();
    };
  }

  private write(cardId: string, hold: CardModalHold): void {
    const next = new Map(this.state);
    next.set(cardId, hold);
    this.state = next;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export const cardModalHoldStore = new CardModalHoldStore();

/**
 * Report the refusal for `cardId` and say whether there was one. `true` means
 * the door is closed and the holder has spoken; `false` means the card is free
 * and the caller should carry on with the gesture.
 */
export function refuseCardModalHold(cardId: string | null): boolean {
  const held = cardModalHoldStore.getFor(cardId);
  if (held === null) return false;
  held.refuse();
  return true;
}

/** Stable no-op subscribe for a surface with no card to be held. */
const NOOP_SUBSCRIBE = (): (() => void) => () => {};

/** Stable `false` for the same. */
const NEVER_HELD = (): boolean => false;

/**
 * Whether THIS card is held by a modal run — the card-scoped door onto the
 * store, and the one every rendering surface should use.
 *
 * The snapshot is this card's boolean rather than the holds map, for the reason
 * {@link useIsCompactingCard} carries the same shape: the map's identity turns
 * on every write to any card, and the chrome reading this is a title bar that
 * every pane on the deck has one of. A boolean compares equal across an
 * unrelated card's run and React bails out. A surface with no card id
 * registers no listener at all.
 */
export function useCardModalHold(cardId: string | undefined | null): boolean {
  return useSyncExternalStore(
    cardId === undefined || cardId === null
      ? NOOP_SUBSCRIBE
      : cardModalHoldStore.subscribe,
    useCallback(
      () => isCardHeld(cardModalHoldStore.getSnapshot(), cardId),
      [cardId],
    ),
    NEVER_HELD,
  );
}
