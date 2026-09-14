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
import { IMPOSITION_GAP_PX, isSidebarPinned } from "@/lib/layout-imposer";
import type { DeckState } from "@/layout-tree";

/**
 * Gap kept between a sheet's bottom and the canvas bottom, in pixels.
 *
 * `tug-sheet.tsx`'s clamp is the only thing that enforces it and imports it
 * from here, which looks backwards until you read what it is a term OF: the
 * clamp caps a top-anchored panel against the CANVAS rather than against the
 * frame it stands in, so this gap is one of the terms a member's floor has to
 * carry ({@link memberFloorForSheetPanel}) and it lives beside that sum.
 */
export const SHEET_CANVAS_GAP = 32;

/**
 * What the pane's chrome puts between the frame's top and the sheet's clip: the
 * title bar (`CARD_TITLE_BAR_HEIGHT`, 36, `--tug-chrome-height`) and the 1px
 * `.tug-sheet-clip` drops below it (its `top: calc(chrome-height + 1px)`).
 *
 * Stated here rather than imported so a lib does not pull in a component
 * module — `components/chrome/tug-pane.tsx` reaches the deck manager, and a
 * lib the manager itself imports cannot reach back. A unit test pins this
 * against `CARD_TITLE_BAR_HEIGHT` so the copy cannot drift silently.
 */
export const PANE_TITLE_BAR_AND_CLIP_PX = 37;

/**
 * The member floor a sheet's panel needs, derived from the panel's own natural
 * height ([B03]).
 *
 * **The sheet reports what it knows and the deck does the arithmetic.** A
 * sheet measures its panel's box and its own top margin and reports that one
 * number; every other term between a panel and the member under it is the
 * deck's — the pane's title bar and the clip's drop above the panel, the gap
 * the clamp keeps against the canvas below it, less the gap the imposition
 * already leaves under a column's last member, which the clamp's canvas
 * reading gets for free. The card knows none of those and should not.
 *
 * This function exists because there were two answers to one question. The
 * measured reservation stored the sheet's number unchanged, so it was short by
 * exactly this sum and inert on any member already above it; the opening bid a
 * registration declares had the same sum done by hand in a doc-comment. Both
 * go through here now, so the two denominate the same quantity and the sum is
 * written once.
 */
export function memberFloorForSheetPanel(panelNaturalPx: number): number {
  return (
    panelNaturalPx +
    PANE_TITLE_BAR_AND_CLIP_PX +
    SHEET_CANVAS_GAP -
    IMPOSITION_GAP_PX
  );
}

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
 * Claim what a panel of `panelNaturalPx` needs from the member `cardId` stands
 * as, or drop the claim with a `null` height.
 *
 * The argument is the SHEET's number — its panel's natural height — and what
 * is stored is the MEMBER's floor, {@link memberFloorForSheetPanel} of it
 * ([B03]). That conversion is the whole of why the two are named differently:
 * a claim of the panel's own height is short by the chrome around it, and a
 * floor short of what the card needs is a floor that decides nothing.
 *
 * Silently does nothing for no card and no deck store — a card renders in the
 * gallery and in fixtures that bootstrap neither. A DROP on a card that stands
 * in nothing still lands, against the member the claim was made under: that is
 * the card torn down while its sheet was up, which is the case [B05] is about
 * and the one where the card can no longer be resolved.
 */
export function reserveSheetHeightForCard(
  cardId: string | null,
  panelNaturalPx: number | null,
): void {
  if (cardId === null) return;
  const deckStore = getDeckStore();
  if (deckStore === null) return;
  const standing = sheetReservationMemberIdOf(deckStore.getSnapshot(), cardId);
  if (panelNaturalPx === null) {
    const claimed = standing ?? claimedMemberByCardId.get(cardId);
    if (claimed === undefined) return;
    claimedMemberByCardId.delete(cardId);
    deckStore.setSheetReservation(claimed, null);
    return;
  }
  if (standing === null) return;
  claimedMemberByCardId.set(cardId, standing);
  deckStore.setSheetReservation(
    standing,
    memberFloorForSheetPanel(panelNaturalPx),
  );
}
