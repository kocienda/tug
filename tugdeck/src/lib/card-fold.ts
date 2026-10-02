/**
 * card-fold.ts — the fold's card-side gestures: the toggle every door lands
 * on, the guard a card may set in front of it, and the one gesture that opens
 * a folded card for a surface the user asked for.
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

import { useCallback } from "react";
import { useSyncExternalStore } from "@/lib/gesture-scope";

import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { dispatchCommand } from "@/command-dispatch";
import { cardFoldedOf } from "@/deck-store-selectors";
import { getDeckStore } from "@/lib/deck-store-registry";
import { openFoldedBody } from "@/lib/folded-body";

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
 *
 * A card in the generic folded form is opened at once rather than at the
 * unfold's commit, because the surface it was opened for focuses itself in
 * this same gesture and an `inert` body would refuse it; and the unfold is
 * marked as bidden, so the fold's own keyboard hand-back stands aside for the
 * surface ({@link takeBiddenUnfold}).
 */
export function unfoldCardForBiddenSurface(cardId: string | null): boolean {
  if (!isCardFolded(cardId)) return false;
  if (cardId !== null) {
    openFoldedBody(cardId);
    biddenUnfolds.add(cardId);
  }
  dispatchCommand(TUG_ACTIONS.SET_CARD_FOLDED, { cardId, folded: false });
  return true;
}

const biddenUnfolds = new Set<string>();

/**
 * Whether `cardId`'s current unfold was made for a bidden surface, clearing
 * the mark. Read once, by the unfold's keyboard hand-back: a surface the user
 * asked for places its own focus, and handing the keyboard to the card's
 * content after it would take the caret straight back out of it.
 */
export function takeBiddenUnfold(cardId: string): boolean {
  return biddenUnfolds.delete(cardId);
}

/**
 * What a card says before its pane folds. Returns whether the fold may go
 * ahead; on the way to `true` it does whatever closing the card's open form
 * needs (a Session card drops its find bar, its sheet and its shade), and a
 * `false` is a refusal the guard has already explained or that needs none.
 */
export type CardFoldGuard = () => boolean;

const foldGuards = new Map<string, CardFoldGuard>();

/**
 * Register `cardId`'s fold guard, returning the unregister.
 *
 * The fold is the pane's ([B05]) and most cards have nothing to say before it:
 * their body is clipped, not closed. A card that DOES — the Session card,
 * whose open form has surfaces standing on a transcript about to fold away,
 * and whose unbound form has nothing to fold — registers here, and
 * {@link toggleCardFold} asks before it writes. Unregistering removes the
 * guard only if it is still the one standing, so a card whose bound and
 * unbound forms trade places in one commit cannot clear its successor's.
 */
export function registerCardFoldGuard(
  cardId: string,
  guard: CardFoldGuard,
): () => void {
  foldGuards.set(cardId, guard);
  return () => {
    if (foldGuards.get(cardId) === guard) foldGuards.delete(cardId);
  };
}

/**
 * Toggle `cardId`'s pane between its open and folded forms — the one body of
 * `toggle-card-fold`, whichever door it came through.
 *
 * Folding asks the card's guard first; unfolding asks nothing, because what
 * was closed on the way down was closed deliberately and re-opening it would
 * be the card guessing. A rail is refused further down, by `setPaneFolded`.
 */
export function toggleCardFold(cardId: string): void {
  const folded = isCardFolded(cardId);
  if (!folded) {
    const guard = foldGuards.get(cardId);
    if (guard !== undefined && !guard()) return;
  }
  dispatchCommand(TUG_ACTIONS.SET_CARD_FOLDED, { cardId, folded: !folded });
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
