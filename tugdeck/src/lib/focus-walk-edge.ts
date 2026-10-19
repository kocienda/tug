/**
 * The walk edge: who takes the Tab walk past the last stop of this page's
 * key card, or before its first.
 *
 * A card whose content lives in another page has its Tab walk split across
 * two documents: its own stops in its body, the stops of its chrome in the
 * shell. So at the end of either page's walk the next stop may be the other
 * page's, and wrapping in place would leave the other half unreachable.
 * `advanceKeyViewFocus` (`components/tugways/focus-manager.ts`) consults this
 * when a base-mode step would wrap, and the page answers by what it is: a
 * body's walk always goes on in the shell (`focus.exit`), which takes it into
 * the card's chrome or hands it back at the end it came in by; the shell's
 * goes into the key card's body when the key card is one (the key-card
 * route, `bus/command-route.ts`). A page that takes the step does not wrap;
 * with no body to hand it to, the shell wraps as it always has.
 *
 * @module lib/focus-walk-edge
 */

import { keyCardWalkEdge } from "../bus/command-route";
import { focusExit } from "../bus/declarations/verbs";
import { page } from "../bus/page";

/** Offer a step off the walk's edge; whether the other page took it. */
export function takeFocusWalkEdge(direction: 1 | -1): boolean {
  if (page.isBody) {
    if (page.cardId === null) return false;
    focusExit.dispatch({ direction: direction === 1 ? "next" : "previous" });
    return true;
  }
  return keyCardWalkEdge(direction);
}
