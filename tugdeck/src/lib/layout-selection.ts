/**
 * layout-selection.ts — what a layout verb acts on.
 *
 * Slot assignment, width presets, and the geometry commands that follow all ask
 * the same question, and they ask it here so there is one answer. The ladder:
 *
 * 1. The Lens's layout selection, filtered to cards the deck still holds.
 * 2. Failing that, the row the Cards list's cursor is standing on — while the
 *    keyboard is actually in that list, and not otherwise.
 * 3. Failing that, the deck's first responder — the single-card behavior that
 *    predates the selection, now the degenerate case rather than the rule.
 * 4. Failing that, nothing.
 *
 * Rungs 1 and 2 are what make the chords work with keyboard focus in the Lens.
 * The first responder there is the Lens card itself — a rail — so a handler
 * reading only rung 3 refuses every slot chord typed while the Cards list has
 * focus, which is exactly when the user is most likely to type one.
 *
 * Rung 2 exists because a cursor is a statement. Arrowing down to a row and
 * pressing ⌘2 is not an ambiguous gesture that needs a selection made first;
 * the row under the caret is plainly what the user means, and requiring a
 * Space beforehand would make the keyboard the one way of working that has to
 * announce itself twice.
 *
 * The registry filter is a read-time guard, not a cache: the selection store
 * prunes on deck changes, but a verb can be dispatched from a keystroke that
 * raced a card's teardown, and a verb acting on a ghost id is worse than a verb
 * acting on fewer cards.
 *
 * @module lib/layout-selection
 */

import { isSidebarCard } from "@/card-registry";
import {
  getLayoutCursorCard,
  lensSelectionStore,
  type LensSelectionStore,
} from "@/components/lens/lens-selection-store";
import { tugDevLogStore } from "@/lib/tug-dev-log-store/tug-dev-log-store";
import type { IDeckManagerStore } from "@/deck-manager-store";

/**
 * The card ids the next layout verb applies to, in selection order.
 *
 * Callers filter for their own eligibility (a rail has no slot to take); this
 * resolves *which cards*, not *which cards may*.
 */
export function resolveLayoutSelection(
  deck: IDeckManagerStore,
  selection: LensSelectionStore = lensSelectionStore,
): readonly string[] {
  const live = new Set(deck.getSnapshot().cards.map((c) => c.id));
  const selected = selection.getSnapshot().ids.filter((id) => live.has(id));
  if (selected.length > 0) return selected;
  const cursor = getLayoutCursorCard();
  if (cursor !== null && live.has(cursor)) return [cursor];
  const firstResponder = deck.getFirstResponderCardId();
  if (firstResponder !== null && live.has(firstResponder)) {
    return [firstResponder];
  }
  return [];
}

/**
 * The layout selection, narrowed to cards a geometry verb can actually place.
 *
 * A rail pins to a deck edge and insets the band — it is the imposition's fixed
 * end, not the chain's to arrange — so it drops out here rather than refusing
 * the whole gesture. That is what lets a slot chord work on a selection that
 * happens to include the Lens instead of dying on it.
 *
 * An empty answer is a refusal, and a refusal says so: it writes to the dev log
 * rather than returning silently, so a chord that appears to do nothing can be
 * told apart from a chord that never arrived.
 */
export function contentCardsInLayoutSelection(
  deck: IDeckManagerStore,
  selection: LensSelectionStore = lensSelectionStore,
): readonly string[] {
  const cards = deck.getSnapshot().cards;
  const resolved = resolveLayoutSelection(deck, selection);
  const content = resolved.filter((id) => {
    const card = cards.find((c) => c.id === id);
    return card !== undefined && !isSidebarCard(card.componentId);
  });
  if (content.length === 0) {
    tugDevLogStore.debug("layout-selection", "no content card to act on", {
      resolved: resolved.length,
      firstResponder: deck.getFirstResponderCardId(),
    });
  }
  return content;
}
