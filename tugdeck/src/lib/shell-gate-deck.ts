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
import { openHelpInCard } from "./open-help-in-card";
import { getTugbankClient } from "./tugbank-singleton";
import { putGettingStartedSeen, readGettingStartedSeen } from "../settings-api";

/**
 * This launch has shown the card. The tugbank flag answers every later launch;
 * this answers a second ask in this one, before the write has come back.
 */
let gettingStartedShown = false;

/**
 * Stand the Getting Started card on `deck`, the first time setup opens a
 * session and never again: afterwards its door is Help ▸ Getting Started.
 * False when it has been shown already, or when there is no tugbank to
 * remember that it was — a card nothing can retire would come back at every
 * setup.
 */
export function showGettingStartedOnce(deck: CardDeck): boolean {
  const client = getTugbankClient();
  if (gettingStartedShown || client === null || readGettingStartedSeen(client)) return false;
  gettingStartedShown = true;
  putGettingStartedSeen(true);
  openHelpInCard(deck, { doc: "getting-started" });
  return true;
}

/**
 * Open the setup wizard's first session on `deck`: a Session card spawned in
 * `projectDir`, or presenting its picker when there is none to spawn in. The
 * first time, the Getting Started card stands beside it.
 * `fireFreshSpawn` sends the `new`-mode frame and holds the card on the quiet
 * restoring backdrop for the bind round-trip, so the picker never flashes.
 */
export function openFirstSession(deck: CardDeck, projectDir: string): void {
  const connection = getConnection();
  // The walk goes down first, so the session opens beside it and is the card
  // that holds the keyboard: the guide is read, the session is typed into.
  showGettingStartedOnce(deck);
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
