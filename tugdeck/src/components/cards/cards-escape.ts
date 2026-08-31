/**
 * cards-escape.ts — what an Escape over the Cards card means, in one place.
 *
 * The precedence is stated in `tuglaws/focus-language.md`: the attached
 * filter's text, then the layout selection, then focus out of the card. Three
 * handlers can answer the press — the Cards list while it holds the keyboard,
 * the card's own `CANCEL_DIALOG` responder, and the deck root's conditional
 * clear — and the bug this module exists to prevent is those three
 * disagreeing, which is exactly what the user sees as "Escape does something
 * different every time".
 *
 * The list's own path runs the same rungs structurally (its key behavior yields
 * to the filter shadow before clearing, and its clear is
 * `cardsSelectionStore.clear`), so it does not call in here; the two chain
 * backstops do, and they get the whole table rather than one rung of it.
 *
 * The filter rung reaches the field through a module-scope slot rather than
 * through React, because a selection outlives the card: the deck root answers
 * for an Escape pressed after a slot chord took the keyboard away, at which
 * point nothing on the chain can see the field. The card publishes its binding
 * here while it is mounted and withdraws it on unmount, so a query the user
 * cannot see is never cleared on their behalf.
 *
 * @module components/cards/cards-escape
 */

import type { AttachedFilterBinding } from "@/components/tugways/attached-filter";
import { cardsSelectionStore } from "./cards-selection-store";

let binding: AttachedFilterBinding | null = null;

/** Publish (or, with `null`, withdraw) the Cards card's filter binding. */
export function setCardsFilterBinding(next: AttachedFilterBinding | null): void {
  binding = next;
}

/** Which rung of the table this press lands on. */
export type CardsEscapeRung = "filter" | "selection" | "focus-out";

/** The rung an Escape would take right now, without taking it. */
export function cardsEscapeRung(): CardsEscapeRung {
  if (binding?.field()?.hasQuery() === true) return "filter";
  if (cardsSelectionStore.getSnapshot().ids.length > 0) return "selection";
  return "focus-out";
}

/**
 * Run the shrinking half of the table — clear the filter, else clear the
 * selection. Returns the rung it spent the press on, or `"focus-out"` when
 * there was nothing to shrink and the caller owns what happens next.
 */
export function shrinkCardsState(): CardsEscapeRung {
  const field = binding?.field() ?? null;
  if (field?.hasQuery() === true && field.clearQuery()) return "filter";
  if (cardsSelectionStore.getSnapshot().ids.length > 0) {
    cardsSelectionStore.clear();
    return "selection";
  }
  return "focus-out";
}
