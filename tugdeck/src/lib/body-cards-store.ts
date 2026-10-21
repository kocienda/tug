/**
 * Which of the shell's cards are bodies, and where each body is in its life.
 *
 * A card enters at its hand-off (`creating`), and the host's
 * `onBodyState` moves it on: `ready` when the body's card is mounted and
 * quiet, `painted` when its first frame of real content has gone to the
 * compositor, `failed` when the body never answered, `evicted` when the host
 * gave its process up under memory pressure and the card waits, its facts
 * standing, for a placement to want it shown again. A card leaves when it
 * is destroyed or when its body fails and the shell takes the card back.
 * `CardHost` reads membership to decide between the card's content and the
 * body's placeholder; the placer shows a body only once it is `painted`;
 * nothing here knows what a body is for.
 *
 * Laws: [L02] read through `useSyncExternalStore`; [L24] structure zone.
 *
 * @module lib/body-cards-store
 */

import type { ArrivalQuiet } from "./arrival-reveal";
import { Subscribable } from "./subscribable";

export type BodyCardState = "creating" | "ready" | "painted" | "failed" | "evicted";

export class BodyCardsStore extends Subscribable {
  private readonly states = new Map<string, BodyCardState>();
  /** Cards that draw their own chrome whose page has put its first chrome frame on screen. */
  private readonly chrome = new Set<string>();
  /**
   * Evicted cards asked for again because a placement wants them shown: the
   * host stands the card's last frame over the new body until it paints, so
   * the placer shows the card from the hand-off rather than from its paint.
   */
  private readonly revived = new Set<string>();
  private ids: readonly string[] = [];

  /** Mark `cardId` a body card, in `creating`. A card already marked keeps its state. */
  mark(cardId: string): void {
    if (this.states.has(cardId)) return;
    this.states.set(cardId, "creating");
    this.changed();
  }

  /** Move a body card's state. A card that is not a body card is ignored. */
  setState(cardId: string, state: BodyCardState): void {
    const prev = this.states.get(cardId);
    if (prev === undefined || prev === state) return;
    this.states.set(cardId, state);
    // A page starting again, or gone, has no chrome on screen.
    if (state === "creating" || state === "failed" || state === "evicted") this.chrome.delete(cardId);
    // A revived card that has painted, or failed, stands on its own again.
    if (state === "painted" || state === "failed" || state === "evicted") this.revived.delete(cardId);
    this.changed();
  }

  /** `cardId`, evicted, is being asked for again to be shown ({@link revived}). */
  markRevived(cardId: string): void {
    if (this.states.get(cardId) !== "evicted" || this.revived.has(cardId)) return;
    this.revived.add(cardId);
    this.changed();
  }

  /** Whether `cardId` is an evicted card coming back, shown from its hand-off under the host's cover. */
  revivedNow = (cardId: string): boolean => this.revived.has(cardId);

  /**
   * The host has shown the first frame of `cardId`'s page with its chrome:
   * a card that draws its own pane's chrome may show from here, before its
   * content has painted, under its own content lid (`body-chrome-frame.tsx`).
   */
  markChromeShown(cardId: string): void {
    if (!this.states.has(cardId) || this.chrome.has(cardId)) return;
    this.chrome.add(cardId);
    this.changed();
  }

  chromeShown = (cardId: string): boolean => this.chrome.has(cardId);

  /** The card is no longer a body card. */
  drop(cardId: string): void {
    this.chrome.delete(cardId);
    this.revived.delete(cardId);
    if (!this.states.delete(cardId)) return;
    this.changed();
  }

  has = (cardId: string): boolean => this.states.has(cardId);

  stateOf = (cardId: string): BodyCardState | null => this.states.get(cardId) ?? null;

  /** Every body card, in hand-off order. Stable by identity until the set changes. */
  cardIds = (): readonly string[] => this.ids;

  /** For tests. */
  _reset(): void {
    this.states.clear();
    this.chrome.clear();
    this.revived.clear();
    this.changed();
  }

  private changed(): void {
    this.ids = Object.freeze([...this.states.keys()]);
    this.notify();
  }
}

export const bodyCardsStore = new BodyCardsStore();

/**
 * A bound body card's arrival quiet: quiet once its body has PAINTED — its
 * first frame of content composited, which `ready` alone is not — or once it
 * has failed and the card is the shell's again. Painted, because the reveal
 * this gates carries the body in on the frame's arrive beat
 * (`card-plan.ts`), and only a painted body can be shown with its
 * tracks; a body revealed at `ready` could be shown before it had drawn. A card
 * not yet handed off is not quiet — the deck's bound covers a hand-off that
 * never comes.
 */
export function bodyReadyQuiet(cardId: string, store: BodyCardsStore = bodyCardsStore): ArrivalQuiet {
  let failed = false;
  return {
    subscribe: (listener) =>
      store.subscribe(() => {
        if (store.stateOf(cardId) === "failed") failed = true;
        listener();
      }),
    isQuiet: () => {
      const state = store.stateOf(cardId);
      return state === "painted" || state === "failed" || failed;
    },
  };
}
