/**
 * slot-facts — what a card's slot badge draws: the arrangement's slot count
 * and the slot the card's pane holds, or nothing when there is no position
 * to name.
 *
 * One rule for the badge that reads the deck itself (`card-slot-badge.tsx`)
 * and for the pane facts the shell publishes to a card that draws its own
 * chrome (`pane-chrome-projection.ts`), whose page holds no deck to read.
 *
 * @module lib/slot-facts
 */

import type { DeckState } from "../layout-tree";
import { findSidebarPanes } from "../deck-store-selectors";
import { slotCount } from "./layout-imposer";

/** The slot badge's two facts. */
export interface SlotFacts {
  count: number;
  held: number;
}

/**
 * The slot facts for `cardId`'s pane in `deck`: `undefined` when the deck
 * does not hold the card at all — the badge then asks the parked workspaces —
 * and `null` when it does and there is no position to name.
 */
export function slotFactsIn(deck: DeckState, cardId: string): SlotFacts | null | undefined {
  const host = deck.panes.find((pane) => pane.cardIds.includes(cardId));
  if (host === undefined) return undefined;
  const kind = deck.imposition.kind;
  // No imposition, or an imposition with one place in it: there is no position
  // to report, so there is no chip.
  if (kind === undefined || slotCount(kind) <= 1) return null;
  if (host.slot === undefined) return null;
  // A sidebar — the Cards card among them — is the imposition's fixed end rather
  // than a member of the chain it bounds. The same guard `SlotPicker` applies.
  if (findSidebarPanes(deck).some((entry) => entry.pane.id === host.id)) return null;
  return { count: slotCount(kind), held: host.slot };
}
