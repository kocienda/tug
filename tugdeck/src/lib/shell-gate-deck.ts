/**
 * The shell's answer to {@link GateDeck}: its own deck, read and asked
 * directly. The overlay's answer (`overlay/overlay-gate-deck.ts`) reaches
 * these same calls through the bus.
 *
 * @module lib/shell-gate-deck
 */

import type { CardDeck } from "../card-deck";
import { countWorkCards } from "../deck-store-selectors";
import { getConnection } from "./connection-singleton";
import type { GateDeck } from "./gate-deck";
import { fireFreshSpawn } from "./session-restore";

/**
 * Open the setup wizard's first session on `deck`: a Session card spawned in
 * `projectDir`, or presenting its picker when there is none to spawn in.
 * `fireFreshSpawn` sends the `new`-mode frame and holds the card on the quiet
 * restoring backdrop for the bind round-trip, so the picker never flashes.
 */
export function openFirstSession(deck: CardDeck, projectDir: string): void {
  const connection = getConnection();
  // A card that opens straight into a spawn never shows its picker, so it
  // opens BOUND — nothing is measured for it and it lands in the call — and
  // only a card with nothing to spawn opens as the picker.
  const spawns = connection !== null && projectDir !== "";
  const cardId = deck.addCard("session", undefined, spawns ? { opening: "bound" } : undefined);
  if (cardId !== null && connection !== null && spawns) {
    fireFreshSpawn(cardId, crypto.randomUUID(), projectDir, connection, "restore-open");
  }
}

export function createShellGateDeck(deck: CardDeck): GateDeck {
  return {
    workCards: {
      subscribe: (listener) => deck.subscribe(() => listener()),
      getSnapshot: () => countWorkCards(deck.getSnapshot()),
    },
    openFirstSession: (projectDir) => openFirstSession(deck, projectDir),
    interruptLiveSessions: () => deck.interruptLiveSessions(),
  };
}
