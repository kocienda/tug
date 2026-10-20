/**
 * The overlay's answer to {@link GateDeck}: the deck the shell holds, read
 * from `deck.cards` and asked through the shell's verbs, since the overlay
 * holds no deck of its own.
 *
 * The work-card count is every card the arrangement holds that is not a
 * rail, in any workspace — whether the app already holds work, which is the
 * question the setup wizard asks of it.
 *
 * @module overlay/overlay-gate-deck
 */

import { deckInterruptLiveSessions } from "../bus/declarations/arrangement";
import { deckCards } from "../bus/declarations/deck";
import { overlayOpenFirstSession } from "../bus/declarations/overlay";
import { INTERRUPT_LIVE_SESSIONS_HORIZON_MS } from "../body/body-card-deck";
import { isSidebarCard } from "../card-registry";
import type { GateDeck } from "../lib/gate-deck";

/** How many of `cards` are not rails. */
export function workCardsOf(cards: Readonly<Record<string, { componentId: string }>>): number {
  let count = 0;
  for (const card of Object.values(cards)) if (!isSidebarCard(card.componentId)) count += 1;
  return count;
}

export function createOverlayGateDeck(): GateDeck {
  return {
    workCards: {
      subscribe: (listener) => deckCards.subscribe(listener),
      getSnapshot: () => workCardsOf(deckCards.getSnapshot()),
    },
    openFirstSession: (projectDir) => overlayOpenFirstSession.dispatch({ projectDir }),
    interruptLiveSessions: () =>
      deckInterruptLiveSessions.ask({}, { horizon: { ms: INTERRUPT_LIVE_SESSIONS_HORIZON_MS } }),
  };
}
