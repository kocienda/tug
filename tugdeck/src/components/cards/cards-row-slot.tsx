/**
 * cards-row-slot.tsx — where a Cards card row's card stands, as the masthead says it.
 *
 * The row wears the same slot badge the card's own masthead does: one
 * numbered chip, quiet at rest, which opens every place in the arrangement
 * when pressed and sends the card to the one picked. The stack badge that
 * follows it (`CardsSlotBadge`) finishes the coordinate. The row's width no
 * longer grows with the deck's slot count, which is what the chip-per-place
 * run it replaced cost.
 *
 * **The badge is handed its facts.** In a body page the card deck holds only
 * the page's own card, so a badge left to read it would find nothing for the
 * row's card. The Workspaces card reads the deck view, which holds the live
 * deck and every parked workspace, so the facts come from there — the live
 * deck first, then the parked workspace that holds the card.
 *
 * **A selected row moves its selection.** When the row's card is one of
 * several selected in the Cards list, a slot picked from its popup carries
 * every selected card there — the same group the ⌘-digit chord moves,
 * resolved through the chord's own narrowing at the moment of the press. A
 * row outside the selection moves only its own card.
 *
 * **A row with no slot keeps the badge's width.** The masthead draws no badge
 * where there is no place to name, and neither does the row; but a list's
 * trailing column has to stay ruled down the rail, so the badge's box is held
 * open and left empty (`cards-row-slot.css`). The reserve is held only where
 * the card's own deck has more than one place: a one-up deck draws no badge on
 * any row, so there is no column to rule and nothing renders at all.
 *
 * Laws: [L02] the deck view and its parked workspaces enter through
 *       `useSyncExternalStore` (by way of `useStoreDerived`); the selection is
 *       read at press time, never subscribed, because nothing on the row draws
 *       it; [L20] the composed badge keeps its own tokens.
 *
 * @module components/cards/cards-row-slot
 */

import "./cards-row-slot.css";

import React, { useCallback, useMemo } from "react";

import { dispatchCommand } from "@/command-dispatch";
import { getDeckView } from "@/lib/deck-store-registry";
import { contentCardsInLayoutSelection } from "@/lib/layout-selection";
import { cardsSelectionStore } from "@/lib/cards-selection-store";
import { slotFactsIn, type SlotFacts } from "@/lib/slot-facts";
import { slotCount } from "@/lib/layout-imposer";
import type { DeckState } from "@/layout-tree";
import { useStoreDerived } from "@/lib/use-store-derived";
import { CardSlotBadge } from "@/components/tugways/card-slot-badge";

/** Where a card stands in one deck: whether that deck has places, and its slot. */
interface RowPlace {
  places: boolean;
  facts: SlotFacts | null;
}

/** `undefined` when `deck` does not hold the card. */
function placeIn(deck: DeckState, cardId: string): RowPlace | undefined {
  const facts = slotFactsIn(deck, cardId);
  if (facts === undefined) return undefined;
  const kind = deck.imposition.kind;
  return { places: kind !== undefined && slotCount(kind) > 1, facts };
}

export function CardsRowSlot({ cardId }: { cardId: string }): React.ReactElement | null {
  const deckView = getDeckView();
  const live = useStoreDerived(deckView, (deck) =>
    deck === null ? undefined : placeIn(deck, cardId),
  );
  const spacesStore = useMemo(
    () =>
      deckView === null
        ? null
        : { subscribe: deckView.subscribeSpaces, getSnapshot: deckView.getSpacesSnapshot },
    [deckView],
  );
  const parked = useStoreDerived(spacesStore, (spaces): RowPlace | undefined => {
    if (spaces === null) return undefined;
    for (const deck of spaces.mountedDecks.values()) {
      const place = placeIn(deck, cardId);
      if (place !== undefined) return place;
    }
    return undefined;
  });
  const place = live !== undefined ? live : parked;

  const assign = useCallback(
    (slot: number) => {
      const selection = cardsSelectionStore.getSnapshot();
      const movesGroup = selection.ids.length > 1 && selection.ids.includes(cardId);
      const deck = getDeckView();
      const cardIds =
        movesGroup && deck !== null ? contentCardsInLayoutSelection(deck) : [];
      if (cardIds.length > 1) dispatchCommand("assign-slot", { cardIds, slot });
      else dispatchCommand("assign-slot", { cardId, slot });
    },
    [cardId],
  );

  if (place === undefined || !place.places) return null;
  return (
    <span className="cards-row-slot" data-testid="cards-row-slot">
      <CardSlotBadge cardId={cardId} facts={place.facts} onAssign={assign} />
    </span>
  );
}
