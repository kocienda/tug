/**
 * lens-escape.ts — what an Escape over the Lens's Cards context means, in one
 * place.
 *
 * The precedence is stated in `tuglaws/focus-language.md`: the attached filter's
 * text, then the layout selection, then focus out of the Lens. Three handlers
 * can answer the press — the Cards list while it holds the keyboard, the Lens's
 * own `CANCEL_DIALOG` responder, and the deck root's conditional clear — and the
 * bug this module exists to prevent is those three disagreeing, which is exactly
 * what the user sees as "Escape does something different every time".
 *
 * The list's own path runs the same rungs structurally (its key behavior yields
 * to the filter shadow before clearing, and its clear is
 * `lensSelectionStore.clear`), so it does not call in here; the two chain
 * backstops do, and they get the whole table rather than one rung of it.
 *
 * @module components/lens/lens-escape
 */

import { sectionAttachedFilter } from "./lens-section-content";
import { sectionFocusGroup } from "./lens-section-registry";
import { lensSelectionStore } from "./lens-selection-store";
import { CARDS_SECTION_KIND } from "./sections/cards-section";

/** Which rung of the table this press lands on. */
export type LensEscapeRung = "filter" | "selection" | "focus-out";

/** The rung an Escape would take right now, without taking it. */
export function lensEscapeRung(): LensEscapeRung {
  const field = sectionAttachedFilter(
    sectionFocusGroup(CARDS_SECTION_KIND),
  ).field();
  if (field?.hasQuery() === true) return "filter";
  if (lensSelectionStore.getSnapshot().ids.length > 0) return "selection";
  return "focus-out";
}

/**
 * Run the shrinking half of the table — clear the filter, else clear the
 * selection. Returns the rung it spent the press on, or `"focus-out"` when
 * there was nothing to shrink and the caller owns what happens next (the Lens
 * responder re-dispatches `FOCUS_LENS`; the deck root has nothing to do,
 * because its entry is only registered while a selection stands).
 */
export function shrinkLensState(): LensEscapeRung {
  const field = sectionAttachedFilter(
    sectionFocusGroup(CARDS_SECTION_KIND),
  ).field();
  if (field?.hasQuery() === true && field.clearQuery()) return "filter";
  if (lensSelectionStore.getSnapshot().ids.length > 0) {
    lensSelectionStore.clear();
    return "selection";
  }
  return "focus-out";
}
