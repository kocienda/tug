/**
 * Process-wide registry for this page's decks.
 *
 * Mirrors `lib/card-lifecycle.ts`'s last-registration-wins singleton so
 * non-React code (the `selectionGuard` singleton, mounted from
 * `ResponderChainProvider`'s `useLayoutEffect`) can subscribe to deck
 * state changes without threading the store through context.
 *
 * Three slots, one per surface:
 * - the **card deck**, which every page that draws a card registers;
 * - the **deck view**, which the shell registers, and a body registers only
 *   for an arrangement kind;
 * - the **shell deck**, which only `DeckManager` registers. It is `null` in
 *   a body page, so a shell-only reader there answers nothing rather than
 *   reading a stand-in.
 *
 * The `DeckManager` constructor registers its deck in all three before
 * rendering the React tree, so they are available by the time any consumer
 * reads them.
 *
 * Intentionally nullable: tests that do not construct a `DeckManager`
 * see `null` and must no-op cleanly.
 */

import type { CardDeck, DeckView } from "../card-deck";
import type { IDeckManagerStore } from "../deck-manager-store";

let cardDeckRef: CardDeck | null = null;
let deckViewRef: DeckView | null = null;
let shellDeckRef: IDeckManagerStore | null = null;

/** Register the deck a card on this page sees. Last-wins. */
export function registerCardDeck(deck: CardDeck | null): void {
  cardDeckRef = deck;
}

/** The deck a card on this page sees, or `null` when none is registered. */
export function getCardDeck(): CardDeck | null {
  return cardDeckRef;
}

/** Register the deck a listing card on this page sees. Last-wins. */
export function registerDeckView(view: DeckView | null): void {
  deckViewRef = view;
}

/** The deck a listing card on this page sees, or `null` when none is registered. */
export function getDeckView(): DeckView | null {
  return deckViewRef;
}

/**
 * Register the shell's whole deck. Called by `DeckManager` only. Last-wins.
 * The shell's deck is also the card deck and the deck view of the page that
 * holds it, so this fills all three slots.
 */
export function registerShellDeck(deck: IDeckManagerStore | null): void {
  shellDeckRef = deck;
  deckViewRef = deck;
  cardDeckRef = deck;
}

/** The shell's whole deck, or `null` on a page that is not the shell. */
export function getShellDeck(): IDeckManagerStore | null {
  return shellDeckRef;
}
