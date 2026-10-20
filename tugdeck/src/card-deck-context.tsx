/**
 * CardDeckContext and DeckViewContext -- the React contexts a card reads its deck through.
 *
 * Every page that draws a card provides a `CardDeck`: the shell provides
 * `DeckManager`, and a body page provides its own. A page whose card lists
 * or moves the whole deck (`bodyDeck: "arrangement"`) also provides a
 * `DeckView`; every other body page provides none. The shell's whole deck,
 * `IDeckManagerStore`, stays behind `DeckManagerContext`, which only the
 * shell's root provides.
 */

import { createContext, useContext } from "react";
import type { CardDeck, DeckView } from "./card-deck";

/**
 * React context carrying the deck a card sees. Default value is null --
 * a card must be rendered inside a provider.
 */
export const CardDeckContext = createContext<CardDeck | null>(null);

/**
 * The deck a card sees. Throws if called outside a provider so mis-use
 * surfaces immediately rather than producing silent null-dereference bugs.
 */
export function useCardDeck(): CardDeck {
  const deck = useContext(CardDeckContext);
  if (deck === null) {
    throw new Error("useCardDeck must be used inside a CardDeckContext.Provider");
  }
  return deck;
}

/**
 * React context carrying the deck a listing card sees, on a page that
 * provides one: the shell, or a body drawing an arrangement kind.
 */
export const DeckViewContext = createContext<DeckView | null>(null);

/**
 * The deck a listing card sees, or null on a page that provides none (a
 * body drawing a kind that reads only its own card).
 */
export function useDeckView(): DeckView | null {
  return useContext(DeckViewContext);
}
