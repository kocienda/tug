/**
 * close-successor.ts — which card a close hands the reader.
 *
 * A close is an activation ([P12]): the slot empties and the deck settles onto
 * a card. This is the one function that says which card that is, and it is a
 * **spatial** answer — the survivor that takes the closing pane's place in the
 * arrangement, not whichever pane happens to have been raised most recently.
 * The reckoning itself is {@link resolveDirectionalFocus}'s ([D184]); this
 * module is the order it is asked in and the one exclusion it owes.
 *
 * **A rail member is never the answer.** A target standing in no slot
 * (`slot === null`) is a sidebar card, and handing the first responder to the
 * Cards rail because it was raised last is how a close reads as having
 * activated nothing: the reader closed one card of several and wants another
 * of them, not the furniture beside them.
 *
 * @module lib/close-successor
 */

import type { DeckState } from "../layout-tree";
import { findSidebarPanes, type PlaceRuns } from "../deck-store-selectors";
import {
  resolveDirectionalFocus,
  type FocusDirection,
} from "./directional-focus";

/**
 * The order a close asks the arrangement for its successor.
 *
 * Down first because that is the direction the arrangement itself settles: in
 * a split column the members below rise into the vacated band, and in a
 * stacked one "below" is the next card in z, which the close brings to the
 * front. Up is the same answer for the bottom member of a place. Only when the
 * closing pane was its place's whole population does the reckoning leave the
 * place at all, and then it goes right before left, so a deck read left to
 * right hands the reader onward rather than back.
 */
const CLOSE_SUCCESSOR_DIRECTIONS: readonly FocusDirection[] = [
  "below",
  "above",
  "right",
  "left",
];

/**
 * The card `closingPaneId`'s close should hand the first responder to, or
 * `null` when there is nobody to hand it to.
 *
 * Call it with the state the close has not yet mutated — the closing pane
 * still standing — because the place being vacated is the whole reference the
 * spatial answer is reckoned from.
 *
 * The fallback is the most-recently-raised remaining **content** pane, for a
 * deck with no imposition at all: there are no places to reckon over and the
 * free pane being closed stands in none, so the z-order answer is the only one
 * available. Only a deck whose every survivor is a rail falls past that to a
 * rail member, and then only because the alternative is handing the deck to
 * nobody.
 */
export function resolveCloseSuccessor(
  state: DeckState,
  runs: PlaceRuns,
  closingPaneId: string,
): string | null {
  const closing = state.panes.find((pane) => pane.id === closingPaneId);
  if (closing === undefined) return null;

  for (const direction of CLOSE_SUCCESSOR_DIRECTIONS) {
    const target = resolveDirectionalFocus(
      state,
      runs,
      closing.activeCardId,
      direction,
    );
    if (target === null || target.slot === null) continue;
    if (target.paneId === closingPaneId) continue;
    return target.cardId;
  }

  const railPaneIds = new Set(
    findSidebarPanes(state).map(({ pane }) => pane.id),
  );
  const remaining = state.panes.filter((pane) => pane.id !== closingPaneId);
  for (let i = remaining.length - 1; i >= 0; i--) {
    if (!railPaneIds.has(remaining[i].id)) return remaining[i].activeCardId;
  }
  return remaining[remaining.length - 1]?.activeCardId ?? null;
}
