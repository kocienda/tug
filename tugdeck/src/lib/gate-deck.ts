/**
 * What the app-modal wizards ask of the deck, and nothing more.
 *
 * The setup wizard (`configure-tug.tsx`) and the update wizard
 * (`update-tug.tsx`) are mounted in the overlay page wherever the host keeps
 * one ([B07]), and in the shell only where it does not. Neither reads the
 * arrangement: the setup wizard counts the deck's work cards and opens the
 * first session, and the update wizard ends the turns in flight. So they read
 * the deck through this narrow seam instead of `useCardDeck()`, and each page
 * supplies it from what it holds — the shell from its own deck, the overlay
 * from `deck.cards` and the shell's verbs.
 *
 * @module lib/gate-deck
 */

import { createContext, useContext } from "react";
import { useSyncExternalStore } from "./gesture-scope";

export interface GateDeck {
  /** How many cards the deck holds that are not rails: whether the deck already holds work. */
  readonly workCards: { subscribe(listener: () => void): () => void; getSnapshot(): number };
  /** Open a Session card, spawned in `projectDir`, or presenting its picker when `projectDir` is empty. */
  openFirstSession(projectDir: string): void;
  /** End every turn in flight; resolves once the deck has answered, or given up asking. */
  interruptLiveSessions(): Promise<unknown>;
}

export const GateDeckContext = createContext<GateDeck | null>(null);

/** The page's gate deck. Mounted wherever a wizard is. */
export function useGateDeck(): GateDeck {
  const deck = useContext(GateDeckContext);
  if (deck === null) throw new Error("useGateDeck must be used within a GateDeckContext");
  return deck;
}

/** The deck's work-card count, read in React ([L02]). */
export function useWorkCardCount(): number {
  const deck = useGateDeck();
  return useSyncExternalStore(deck.workCards.subscribe, deck.workCards.getSnapshot);
}
