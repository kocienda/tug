/**
 * The body's half of the turn latch: hand the card's `deck.cards` `turnLatch`
 * to its session store.
 *
 * tugcast keeps a per-session latch saying whether a turn is running and
 * which turn it last opened, and the shell carries it to every page as one
 * field of the card's `deck.cards` record. The card's own store is the one
 * place it means anything, since the store is what holds the card's belief
 * about its turn. So whenever the reading moves, or the store behind the card
 * changes, the current store is told; a call that would repeat the last one
 * to the same store is skipped.
 *
 * The follower lives as long as the page, which hosts one card, so the page's
 * teardown is its release ([L27]); it returns that release for a test.
 */

import { deckCards, type DeckCardFacts } from "../bus/declarations/deck";
import { cardServicesStore } from "../lib/card-services-store";
import type { ServerTurnLatch } from "../lib/code-session-store/events";

/** The one call {@link followServerTurn} makes of a store. */
export interface ServerTurnSink {
  noteServerTurn(latch: ServerTurnLatch | null, cardId: string): void;
}

/** What {@link followServerTurn} reads; the live stores unless a test supplies its own. */
export interface ServerTurnSources {
  cards: {
    subscribe(listener: () => void): () => void;
    getSnapshot(): Record<string, Pick<DeckCardFacts, "turnLatch"> | undefined>;
  };
  services: {
    subscribe(listener: () => void): () => void;
    storeFor(cardId: string): ServerTurnSink | null;
  };
}

const liveSources: ServerTurnSources = {
  cards: deckCards,
  services: {
    subscribe: (listener) => cardServicesStore.subscribe(listener),
    storeFor: (cardId) => cardServicesStore.getServices(cardId)?.codeSessionStore ?? null,
  },
};

/**
 * Feed `cardId`'s `turnLatch` to its session store now and on every move of
 * either. Returns the release of both subscriptions.
 */
export function followServerTurn(
  cardId: string,
  sources: ServerTurnSources = liveSources,
): () => void {
  let sentTo: ServerTurnSink | null = null;
  let sent: ServerTurnLatch | null | undefined;
  const apply = (): void => {
    const store = sources.services.storeFor(cardId);
    if (store === null) {
      sentTo = null;
      return;
    }
    const latch = sources.cards.getSnapshot()[cardId]?.turnLatch ?? null;
    if (store === sentTo && sent !== undefined && sameLatch(sent, latch)) return;
    store.noteServerTurn(latch === null ? null : { active: latch.active, turnId: latch.turnId }, cardId);
    sentTo = store;
    sent = latch;
  };
  const releaseCards = sources.cards.subscribe(apply);
  const releaseServices = sources.services.subscribe(apply);
  apply();
  return () => {
    releaseCards();
    releaseServices();
  };
}

function sameLatch(a: ServerTurnLatch | null, b: ServerTurnLatch | null): boolean {
  if (a === null || b === null) return a === b;
  return a.active === b.active && a.turnId === b.turnId;
}
