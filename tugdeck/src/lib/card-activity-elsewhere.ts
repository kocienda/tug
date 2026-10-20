/**
 * card-activity-elsewhere.ts — the session phase of a card mounted in another
 * page.
 *
 * Phase lives on a per-card `codeSessionStore`, and a page builds one only
 * for a card it shows ([B02]): the shell for every drawn card, a body page
 * for its own card and no other. So an arrangement body — the Layout card,
 * the Workspaces card — has no store for any card it lists, and the phase
 * dot beside each row would read idle for every other session.
 *
 * What each card's body reports to the shell as its phase (`card.facts`
 * `activity`, kept in `bodyFactsStore`) the shell projects into
 * `deck.cards`, which every body reads, and the body answers it here from
 * that replica, beside `cardIdentityElsewhere` ([B06]). The phase readers in
 * `use-session-phase.ts` answer from it for a card the page has no services
 * for. Nothing here is a session to drive: it is one short string per card,
 * read through.
 *
 * @module lib/card-activity-elsewhere
 */

import { otherDeckCard, otherDeckCards } from "./other-deck-cards";
import { Subscribable } from "./subscribable";

class ElsewhereActivities extends Subscribable {
  private readonly entries = new Map<string, string>();

  /** The phase key another page reported for `cardId`, or null: in a body, the shell's `deck.cards` entry. */
  get(cardId: string): string | null {
    return otherDeckCard(cardId)?.activity ?? this.entries.get(cardId) ?? null;
  }

  /** Take `cardId`'s reported phase; null forgets it. Notifies only on a change. */
  set(cardId: string, key: string | null): void {
    if ((this.entries.get(cardId) ?? null) === key) return;
    if (key === null) this.entries.delete(cardId);
    else this.entries.set(cardId, key);
    this.notify();
  }

  /** Every card with a reported phase, for a test or a census. */
  cardIds(): string[] {
    const others = Object.keys(otherDeckCards()).filter((id) => otherDeckCard(id)?.activity != null);
    return [...new Set([...this.entries.keys(), ...others])];
  }

  /** For tests. */
  _reset(): void {
    if (this.entries.size === 0) return;
    this.entries.clear();
    this.notify();
  }
}

export const cardActivityElsewhere = new ElsewhereActivities();
