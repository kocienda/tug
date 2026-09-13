/**
 * sheet-reservation.ts — the one gesture by which a sheet's stated height
 * becomes a floor under the card it stands on.
 *
 * A modal surface whose natural height is content-bounded may declare that
 * height ([B02] of the sheet-reservation brief), and the place its host card
 * stands in then holds the card's floor at it for as long as the sheet is up
 * ([B01]) — so a picker on a member of a split column or rail opens at the
 * size it needs, the neighbour keeps whatever the picker did not take, and the
 * card settles back into its stored share when the sheet goes.
 *
 * The claim is keyed by the MEMBER, which for a card in a slot is the pane
 * hosting it and for a card pinned to a rail is its componentId — the two
 * ways `placeMembers` names one ([B04]). Resolving the card to its member is
 * the whole of what this module does, and it is here rather than at the call
 * site for the reason `card-fold.ts` is: the state is read fresh off the deck
 * store at the moment the gesture runs, and a card renders in the gallery and
 * in tests that bootstrap no DeckManager, where the honest answer is to do
 * nothing rather than to crash.
 *
 * @module lib/sheet-reservation
 */

import { isSidebarCard } from "@/card-registry";
import { getDeckStore } from "@/lib/deck-store-registry";
import { isSidebarPinned } from "@/lib/layout-imposer";
import type { DeckState } from "@/layout-tree";

/**
 * The member each card last claimed under, so a drop can still name it once
 * the card has stopped standing in anything.
 *
 * A card torn down while its sheet is up is removed from the deck BEFORE the
 * teardown that clears the claim runs — the state change is what unmounts it —
 * so resolving the card again at that moment answers nothing. Without this the
 * entry would outlive every pane it could belong to, and the field would never
 * come back to absent the way {@link DeckState.sheetReservations} says it does.
 *
 * Keyed by cardId and emptied by the drop itself, so it holds one entry per
 * sheet that is actually up.
 */
const claimedMemberByCardId = new Map<string, string>();

/**
 * The member `cardId` stands as, the way `placeMembers` names one: its
 * componentId when the card is a sidebar card pinned to a rail, and otherwise
 * the pane hosting it. `null` when the card stands in nothing.
 *
 * Pure and exported for the reason `sheetReservationsWith` is: it is the whole
 * of what the gesture decides, and it is testable without a DeckManager while
 * the gesture around it is not.
 */
export function sheetReservationMemberIdOf(
  state: DeckState,
  cardId: string,
): string | null {
  const card = state.cards.find((c) => c.id === cardId);
  if (
    card !== undefined &&
    isSidebarCard(card.componentId) &&
    isSidebarPinned(state.imposition, card.componentId)
  ) {
    return card.componentId;
  }
  return state.panes.find((p) => p.cardIds.includes(cardId))?.id ?? null;
}

/**
 * Claim `height` pixels for the member `cardId` stands as, or drop the claim
 * with a `null` height.
 *
 * Silently does nothing for no card and no deck store — a card renders in the
 * gallery and in fixtures that bootstrap neither. A DROP on a card that stands
 * in nothing still lands, against the member the claim was made under: that is
 * the card torn down while its sheet was up, which is the case [B05] is about
 * and the one where the card can no longer be resolved.
 */
export function reserveSheetHeightForCard(
  cardId: string | null,
  height: number | null,
): void {
  if (cardId === null) return;
  const deckStore = getDeckStore();
  if (deckStore === null) return;
  const standing = sheetReservationMemberIdOf(deckStore.getSnapshot(), cardId);
  if (height === null) {
    const claimed = standing ?? claimedMemberByCardId.get(cardId);
    if (claimed === undefined) return;
    claimedMemberByCardId.delete(cardId);
    deckStore.setSheetReservation(claimed, null);
    return;
  }
  if (standing === null) return;
  claimedMemberByCardId.set(cardId, standing);
  deckStore.setSheetReservation(standing, height);
}
