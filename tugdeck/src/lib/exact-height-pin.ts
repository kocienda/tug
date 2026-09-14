/**
 * exact-height-pin.ts — the gesture by which a card's declared exact height
 * becomes the height its member stands at.
 *
 * A card type whose open form has a tall floor because of surfaces not yet on
 * screen may declare what it is worth without them
 * (`CardRegistration.unboundExactHeightPx`), and the place its card stands in
 * then holds that member at exactly that height — floor, ceiling, and no share
 * of the run ([P01]). The Session card's picker is the one declaration today:
 * an unbound card is its picker and nothing else, so it opens at the picker's
 * height rather than at the transcript's 600px floor.
 *
 * `lib/sheet-reservation.ts`'s neighbour, deliberately shaped like it and
 * deliberately not merged with it. What the two share is the card → member
 * resolution, which is why this module CALLS
 * {@link sheetReservationMemberIdOf} rather than repeating it. What they do not
 * share is meaning: a reservation is a FLOOR a taller member ignores, and a pin
 * is a HEIGHT. Merging them would put two readings behind one gesture.
 *
 * The state is read fresh off the deck store at the moment the gesture runs,
 * and the honest answer with no store is to do nothing rather than to crash: a
 * card renders in the gallery and in tests that bootstrap no DeckManager, which
 * is exactly the guard `reserveSheetHeightForCard` states for itself.
 *
 * @module lib/exact-height-pin
 */

import { getDeckStore } from "@/lib/deck-store-registry";
import { sheetReservationMemberIdOf } from "@/lib/sheet-reservation";

/**
 * The member each card was last pinned under, so a drop can still name it once
 * the card has stopped standing in anything.
 *
 * `sheet-reservation.ts`'s own last-claimed map exists for this reason and so
 * does this one: a card torn down while its pin is up is removed from the deck
 * BEFORE the teardown that drops the pin runs — the state change is what
 * unmounts it — so resolving the card again at that moment answers nothing.
 * Without this the entry would
 * outlive every pane it could belong to, and `DeckState.exactMemberHeights`
 * would never come back to absent the way it says it does.
 *
 * Keyed by cardId and emptied by the drop itself, so it holds one entry per
 * card actually standing pinned.
 */
const pinnedMemberByCardId = new Map<string, string>();

/**
 * Record that `cardId` is standing pinned as `memberId`, without writing the
 * pin itself.
 *
 * `addCard` writes its pin INSIDE the commit that appends the pane ([B02]) —
 * one commit, so nothing re-targets the settle a commit later — which means it
 * does not go through {@link pinExactHeightForCard} and the map above would
 * never learn the member. This is the half of that gesture the map needs, and
 * the drop is then the ordinary one.
 */
export function noteExactHeightMember(cardId: string, memberId: string): void {
  pinnedMemberByCardId.set(cardId, memberId);
}

/**
 * Pin the member `cardId` stands as at `height`, or drop the pin with `null`.
 *
 * Silently does nothing for no card and no deck store, for the module header's
 * reason. A DROP on a card that stands in nothing still lands, against the
 * member the pin was written under: that is the card torn down while it was
 * pinned, and the one case where the card can no longer be resolved.
 */
export function pinExactHeightForCard(
  cardId: string | null,
  height: number | null,
): void {
  if (cardId === null) return;
  const deckStore = getDeckStore();
  if (deckStore === null) return;
  const standing = sheetReservationMemberIdOf(deckStore.getSnapshot(), cardId);
  if (height === null) {
    const pinned = standing ?? pinnedMemberByCardId.get(cardId);
    if (pinned === undefined) return;
    pinnedMemberByCardId.delete(cardId);
    deckStore.setMemberExactHeight(pinned, null);
    return;
  }
  if (standing === null) return;
  pinnedMemberByCardId.set(cardId, standing);
  deckStore.setMemberExactHeight(standing, height);
}
