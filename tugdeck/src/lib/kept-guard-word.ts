/**
 * The word an evicted page left that its card's close guard asks, kept by
 * the shell for the card.
 *
 * A page that said its guard would ask, then was evicted, takes its word with
 * it: the detach clears its `card.holds` with everything else it held. The
 * card's close must still ask — its edits are set aside, waiting for the page
 * that brings it back — so the shell keeps the word in the card's own
 * shell-owned store (`card.guardAsks`, [D215]) and persists it in its own
 * card-keyed defaults domain, so a shell reload reads it back rather than
 * closing a dirty card at a deadline. The store outlives a page that fails
 * as it does one that is evicted: neither has answered for the card.
 *
 * The word is the card's until its next page has answered for itself: that
 * page's first `closeGuardAsks`, of either value, published once it has read
 * back what the evicted page set aside (`closeGuardAnswered`). A clean page
 * clears it, and its card's close keeps its deadline; a dirty one says `true`
 * itself. A `false` before the read-back is no answer, and leaves the word.
 * A page that has painted with no guard at all — the card's save mode
 * turned automatic while it was evicted — answers too: nothing it holds
 * asks, and the word goes.
 *
 * Whether a word needs writing is read from the durable copy's last known
 * state, not from the store: the store says what the card's close does now,
 * the durable copy only what its last write that landed said. A write that
 * failed leaves the copy unknown, so the card's next word is written again
 * whatever the store held.
 *
 * @module lib/kept-guard-word
 */

import type { CardHoldsValue } from "../bus/declarations/card";

export interface KeptGuardWordsDeps {
  /** The card's kept word, as the shell's store holds it. */
  get(cardId: string): boolean;
  /** Set the card's kept word in the shell's store. */
  set(cardId: string, asks: boolean): void;
  /** Write the card's kept word to the durable copy; settles `true` once it is written, `false` if it failed. */
  persist(cardId: string, asks: boolean): Promise<boolean>;
  /** Settles when an eviction has waited on its word's write as long as it will. */
  deadline(): Promise<void>;
  /** `cardId`'s word's write settled after its eviction stopped waiting on it. */
  late(cardId: string): void;
}

export interface KeptGuardWords {
  /** Whether `cardId`'s close asks on a word its gone page left. */
  asks(cardId: string): boolean;
  /**
   * `cardId`'s page was evicted, its last holds `holds`: a word that its
   * guard asks stays. Settles once the word is durable, or at the deadline
   * if its write has not settled by then.
   */
  evicted(cardId: string, holds: CardHoldsValue): Promise<void>;
  /** `cardId`'s page published `holds`: once they are its guard's answer, the kept word goes. */
  heard(cardId: string, holds: CardHoldsValue): void;
  /** `cardId` is closed: its word goes, durable copy and all. */
  closed(cardId: string): void;
}

/**
 * The shell's kept words, starting from the cards whose durable word stood
 * when the shell loaded (`persisted`).
 */
export function createKeptGuardWords(deps: KeptGuardWordsDeps, persisted: readonly string[]): KeptGuardWords {
  /** Each card's durable word as last written or asked, `null` once a write failed; absent is none. */
  const durable = new Map<string, boolean | null>();
  /** Each card's write in flight, which a word it already says waits on. */
  const writing = new Map<string, Promise<void>>();
  for (const cardId of persisted) {
    deps.set(cardId, true);
    durable.set(cardId, true);
  }
  const keep = (cardId: string, asks: boolean): Promise<void> => {
    if (deps.get(cardId) !== asks) deps.set(cardId, asks);
    if ((durable.get(cardId) ?? false) === asks) return writing.get(cardId) ?? Promise.resolve();
    durable.set(cardId, asks);
    const write = deps.persist(cardId, asks).then((landed) => {
      if (!landed && durable.get(cardId) === asks) durable.set(cardId, null);
      if (writing.get(cardId) === write) writing.delete(cardId);
    });
    writing.set(cardId, write);
    return write;
  };
  return {
    asks: (cardId) => deps.get(cardId),
    evicted(cardId, holds) {
      if (holds.closeGuardAsks !== true) return Promise.resolve();
      let settled = false;
      const written = keep(cardId, true).then(() => {
        settled = true;
      });
      const waited = deps.deadline().then(() => {
        if (!settled) void written.then(() => deps.late(cardId));
      });
      return Promise.race([written, waited]);
    },
    heard(cardId, holds) {
      if (holds.closeGuardAnswered) void keep(cardId, false);
    },
    closed(cardId) {
      void keep(cardId, false);
    },
  };
}
