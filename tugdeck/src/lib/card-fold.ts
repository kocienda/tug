/**
 * card-fold.ts — the one gesture that opens a folded card for a surface the
 * user asked for.
 *
 * A folded card shows its masthead and its Z2 row and nothing else, and
 * everything it raises while folded comes out of that row ([B01] of the
 * folded-card brief). What that rule does NOT cover is the surface the user
 * has just named — *AI Settings…*, *Show Usage*, *Rewind*, the Changes room, a
 * Z2 chip's sheet. There the fold is not a statement about what the card wants
 * to show; it is in the way. So the card opens first and the surface then
 * appears exactly where it does on an open card, with no notice and no second
 * click.
 *
 * The state read is deliberately FRESH off the deck store rather than a
 * rendered flag, for the reason every command reads its own state: the gesture
 * decides off the world at the moment it runs.
 *
 * @module lib/card-fold
 */

import { useCallback, useSyncExternalStore } from "react";

import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { dispatchCommand } from "@/command-dispatch";
import { cardFoldedOf } from "@/deck-store-selectors";
import { getDeckStore } from "@/lib/deck-store-registry";

/**
 * Whether `cardId`'s pane is folded, read fresh off the deck store.
 *
 * The one caller that needs the question rather than the gesture is the sheet
 * host, which decides between opening the fold and standing down to the Z2 row
 * by what the surface declares about itself.
 */
export function isCardFolded(cardId: string | null): boolean {
  if (cardId === null) return false;
  const deckStore = getDeckStore();
  if (deckStore === null) return false;
  return cardFoldedOf(deckStore.getSnapshot(), cardId);
}

/**
 * Open the fold on `cardId` if it is folded, for a surface the user asked for.
 *
 * Returns whether it unfolded — the caller's signal that a deferred reveal is
 * about to re-run under the open form, so doing the same thing twice is the
 * one mistake to avoid. `false` for a card that was already open, for no card
 * (a gallery or fixture render), and for no deck store.
 */
export function unfoldCardForBiddenSurface(cardId: string | null): boolean {
  if (!isCardFolded(cardId)) return false;
  dispatchCommand(TUG_ACTIONS.SET_CARD_FOLDED, { cardId, folded: false });
  return true;
}

/**
 * The same question as {@link isCardFolded}, as a React subscription — for the
 * one caller that has to ACT when the answer changes rather than read it once
 * at gesture time: an unbidden sheet that stood down while the card was folded
 * and is owed its presentation the moment the card opens.
 *
 * `getDeckStore()` is read inside both callbacks rather than closed over,
 * because a Session card renders in the gallery and in tests that bootstrap no
 * DeckManager — the honest answer there is not-folded rather than a crash
 * ([L02]).
 */
export function useIsCardFolded(cardId: string | null): boolean {
  const subscribe = useCallback((onStoreChange: () => void) => {
    const deckStore = getDeckStore();
    if (deckStore === null) return () => {};
    return deckStore.subscribe(onStoreChange);
  }, []);
  return useSyncExternalStore(
    subscribe,
    useCallback(() => isCardFolded(cardId), [cardId]),
  );
}
