/**
 * other-deck-cards — the read every page store makes for a card the page
 * does not show.
 *
 * In a body, another card's binding, title, identity and phase are the
 * shell's, in the `deck.cards` replica; the stores that hold this page's own
 * card's answer another card's id from here (`lib/deck-cards.ts` says why).
 * In the shell, which shows every card, it answers nothing.
 *
 * @module lib/other-deck-cards
 */

import { deckCards, type DeckCardFacts } from "../bus/declarations/deck";
import { page } from "../bus/page";
import { installedPageBus } from "../bus/page-bus";

const NO_CARDS: Record<string, DeckCardFacts> = {};

/** The `deck.cards` replica in a body; nothing in the shell, or before the page's bus is up. */
export function otherDeckCards(): Record<string, DeckCardFacts> {
  if (!page.isBody) return NO_CARDS;
  const bus = installedPageBus();
  return bus === null ? NO_CARDS : deckCards.on(bus).getSnapshot();
}

/** What the shell holds of `cardId`, for a body that does not show it; null for the page's own card, and in the shell. */
export function otherDeckCard(cardId: string | null): DeckCardFacts | null {
  if (cardId === null || cardId === page.cardId) return null;
  return otherDeckCards()[cardId] ?? null;
}
