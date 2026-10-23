/**
 * The close decisions a body card did not answer, by card.
 *
 * A body card whose guard said it would not ask answers its close decision
 * at once (`close-decision.ts`), so one silent past the deadline is not
 * answering, and the close does not happen. That terminal state is the
 * user's to see, not the dev log's ([L33]): the shell flashes the card's
 * pane and stands a banner on it saying the card did not answer, with the
 * close gesture that skips the guard — Option-click on the close box — as
 * the way out. A close cancelled because the card's page went away while it
 * was asked is the same terminal state, and stands the same banner with that
 * reason. The banner stands until it is dismissed, the card is asked again,
 * or the card goes.
 *
 * Laws: [L02] read through `useSyncExternalStore`; [L06] the flash is the
 * pane's own DOM, driven by {@link CloseRefusalStore.onRefuse}.
 *
 * @module lib/close-refusal-store
 */

import { Subscribable } from "./subscribable";

/** Why a close was refused: the card's page was silent past the deadline, or went away while asked. */
export type CloseRefusalReason = "silent" | "gone";

export class CloseRefusalStore extends Subscribable {
  private readonly refused = new Map<string, CloseRefusalReason>();
  private readonly refuseListeners = new Set<(cardId: string) => void>();

  /** The card did not answer its close decision, for `reason`: say so on its pane. */
  refuse(cardId: string, reason: CloseRefusalReason = "silent"): void {
    this.refused.set(cardId, reason);
    for (const listener of [...this.refuseListeners]) listener(cardId);
    this.notify();
  }

  /** The refusal no longer stands: dismissed, asked again, or the card is gone. */
  clear(cardId: string): void {
    if (!this.refused.delete(cardId)) return;
    this.notify();
  }

  isRefused = (cardId: string): boolean => this.refused.has(cardId);

  /** Why `cardId`'s close was refused, or null while no refusal stands. */
  reasonOf = (cardId: string): CloseRefusalReason | null => this.refused.get(cardId) ?? null;

  /** Hear each refusal as it is made: the shell flashes the card's pane. */
  onRefuse(listener: (cardId: string) => void): () => void {
    this.refuseListeners.add(listener);
    return () => {
      this.refuseListeners.delete(listener);
    };
  }
}

export const closeRefusalStore = new CloseRefusalStore();

/** What the banner says. */
export const CLOSE_REFUSAL_LABEL = "Not closed";
export const CLOSE_REFUSAL_MESSAGES: Record<CloseRefusalReason, string> = {
  silent: "This card didn’t answer. Option-click the close box to close it without asking.",
  gone: "This card’s page went away. Option-click the close box to close it without asking.",
};
