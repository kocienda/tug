/**
 * opening-bid.ts — the gesture by which a card's declared height becomes the
 * floor its member opens at, for the length of the arrival window.
 *
 * A card type whose open form is a sheet declares so
 * (`CardRegistration.openingForm`); the deck commits that card HIDDEN at the
 * seat it will take, the sheet lays out and reports its height there, and the
 * reveal commit writes that report as the bid — from which the place its card
 * stands in holds that member at no less than the reported height, one
 * contributor to the member's floor, with its weight kept ([B01], [B04]). The
 * Session card's picker is the one declaration today: an unbound card is its
 * picker and nothing else, so it opens at the picker's own height rather than
 * at the transcript's 600px floor, and takes more where its column has more
 * to give.
 *
 * **It is a BID rather than a height, and that is the whole of its life
 * ([B02]).** Its one legitimate job is to be known BEFORE `addCard` commits,
 * so the arrival is one motion and nothing re-targets the settle a beat later.
 * The sheet standing on the member is the thing that actually knows what the
 * card needs, so a measurement at least as high supersedes the bid and clears
 * it — in `setSheetReservation`'s own commit — and the sheet going clears it
 * whatever it was. That is why a bid too SMALL costs one settle rather than
 * clipping the card forever, and why nothing has to remember to take a bid
 * down: the thing that replaces it is what ends it. `sheetClaimWith` is the
 * rule and says why a claim below a standing bid supersedes nothing — a
 * member does not shrink under a sheet that still stands on it ([F07]).
 *
 * `lib/sheet-reservation.ts`'s neighbour, deliberately shaped like it and
 * deliberately not merged with it. What the two share is the card → member
 * resolution, which is why this module CALLS
 * {@link sheetReservationMemberIdOf} rather than repeating it. What they do not
 * share is WHERE the number comes from: a reservation is measured off a sheet
 * that is on screen, and this one is declared by a registration before
 * anything of the card has been laid out. Both are floors ([B01]).
 *
 * The state is read fresh off the deck store at the moment the gesture runs,
 * and the honest answer with no store is to do nothing rather than to crash: a
 * card renders in the gallery and in tests that bootstrap no DeckManager, which
 * is exactly the guard `reserveSheetHeightForCard` states for itself.
 *
 * @module lib/opening-bid
 */

import { getDeckStore } from "@/lib/deck-store-registry";
import { sheetReservationMemberIdOf } from "@/lib/sheet-reservation";

/**
 * The member each card last bid under, so a drop can still name it once the
 * card has stopped standing in anything.
 *
 * `sheet-reservation.ts`'s own last-claimed map exists for this reason and so
 * does this one: a card torn down while its bid stands is removed from the deck
 * BEFORE the teardown that drops the bid runs — the state change is what
 * unmounts it — so resolving the card again at that moment answers nothing.
 * Without this the entry would
 * outlive every pane it could belong to, and `DeckState.openingBids`
 * would never come back to absent the way it says it does.
 *
 * Keyed by cardId and emptied by the drop. An entry can outlive the bid it
 * names — the sheet's own claim supersedes a bid without going through this
 * module — and that costs nothing: the drop it leads to is an identity no-op
 * against a record that no longer holds the member.
 */
const bidMemberByCardId = new Map<string, string>();

/**
 * The members whose standing bid has already been reported against by a live
 * sheet — one entry per member, set by the FIRST report and cleared whenever
 * the bid is cleared.
 *
 * The bit exists because [P04] is a statement about the first report and
 * nothing after it: the reveal commit's number and the panel's own next
 * reading are supposed to be the same number, so a disagreement there is a
 * defect in the reveal rather than a tuning problem, and it is
 * recorded rather than committed. Every LATER report is an honest reservation
 * update from a panel that has genuinely changed ([P05]) and takes today's
 * supersede rule untouched — a picker that grows a row after its sessions load
 * is telling the truth, and holding it to the arrival's number would clip it.
 *
 * Per member rather than per card, because the member is what the bid and the
 * reservation are both keyed by, and the bid's whole life is the member's.
 */
const reportedMembers = new Set<string>();

/**
 * Whether `memberId`'s standing bid has already been reported against, marking
 * it reported in the same breath.
 *
 * Test-and-set in one call rather than a read and a write, because the caller
 * is inside a commit and the two halves have no meaningful moment between
 * them: every path that asks this question is the path that spends the answer.
 */
export function openingBidReportedFor(memberId: string): boolean {
  if (reportedMembers.has(memberId)) return true;
  reportedMembers.add(memberId);
  return false;
}

/**
 * Forget that `memberId` was reported against, so a bid written after this one
 * gets its own first report.
 *
 * Called wherever a bid is cleared. A member that is bid for twice — a card
 * torn down and another opened in the same place — is two arrivals and owes
 * two comparisons, and a bit that outlived its bid would spend the second
 * arrival's comparison before it happened.
 */
export function clearOpeningBidReport(memberId: string): void {
  reportedMembers.delete(memberId);
}

/**
 * Record that `cardId`'s bid stands under `memberId`, without writing the bid
 * itself.
 *
 * `addCard` writes its bid INSIDE the commit that appends the pane ([B02]) —
 * one commit, so nothing re-targets the settle a commit later — which means it
 * does not go through {@link openingBidForCard} and the map above would
 * never learn the member. This is the half of that gesture the map needs, and
 * the drop is then the ordinary one.
 */
export function noteOpeningBidMember(cardId: string, memberId: string): void {
  bidMemberByCardId.set(cardId, memberId);
}

/**
 * Bid `height` for the member `cardId` stands as, or drop its bid with `null`.
 *
 * Silently does nothing for no card and no deck store, for the module header's
 * reason. A DROP on a card that stands in nothing still lands, against the
 * member the bid was written under: that is the card torn down before any
 * measurement superseded its bid, and the one case where the card can no
 * longer be resolved.
 */
export function openingBidForCard(
  cardId: string | null,
  height: number | null,
): void {
  if (cardId === null) return;
  const deckStore = getDeckStore();
  if (deckStore === null) return;
  const standing = sheetReservationMemberIdOf(deckStore.getSnapshot(), cardId);
  if (height === null) {
    const bid = standing ?? bidMemberByCardId.get(cardId);
    if (bid === undefined) return;
    bidMemberByCardId.delete(cardId);
    clearOpeningBidReport(bid);
    deckStore.setOpeningBid(bid, null);
    return;
  }
  if (standing === null) return;
  bidMemberByCardId.set(cardId, standing);
  deckStore.setOpeningBid(standing, height);
}
