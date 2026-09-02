/**
 * cards-column-badge.tsx — where a Cards card row's card stands inside its slot.
 *
 * The slot run beside it says which slot the card holds. This says the rest of
 * the coordinate: how many cards share that slot when it stacks, and which band
 * the card is when it splits. Nothing renders only when there is no place at
 * all to describe — a deck with no imposition, or a row whose card has no host
 * pane. A place one card deep is a place, and it reads `1` here exactly as it
 * does on that card's own masthead.
 *
 * A readout, not a control: the badge on the pane's own cluster is the door to
 * the member picker, and a Cards card row's door is the row itself.
 *
 * Laws: [L02] the deck state enters through `useSyncExternalStore` here, in a
 *       component of its own, rather than inside the cell that renders it —
 *       `CardsSessionRow` takes everything as props and subscribes to nothing.
 *
 * @module components/cards/cards-column-badge
 */

import "./cards-column-badge.css";

import React, { useSyncExternalStore } from "react";

import { getDeckStore } from "@/lib/deck-store-registry";
import { columnBadgeFactsOf } from "@/deck-store-selectors";
import { TugColumnBadge } from "@/components/tugways/tug-column-badge";

export function CardsColumnBadge({
  cardId,
}: {
  cardId: string;
}): React.ReactElement | null {
  const deckStore = getDeckStore();
  const deck = useSyncExternalStore(
    deckStore?.subscribe ?? (() => () => {}),
    deckStore !== null ? deckStore.getSnapshot : () => null,
    () => null,
  );

  if (deck === null) return null;
  const facts = columnBadgeFactsOf(deck, cardId);
  if (facts === null) return null;

  return (
    <TugColumnBadge
      className="cards-column-badge"
      data-testid="cards-column-badge"
      kind={facts.kind}
      count={facts.count}
      index={facts.index}
    />
  );
}
