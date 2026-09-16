/**
 * close-guard-walk.ts — one walk over a set of cards' close guards.
 *
 * Two gestures destroy several cards at once: closing a pane that holds
 * tabs, and deleting a workspace that holds cards. Both owe the user the
 * same thing — every card that would lose unsaved work gets its own sheet,
 * shown while that card is the one on screen, and any Cancel abandons the
 * whole gesture. The pane grew that sequence first, inside
 * `resolveCloseGuard`; the workspace delete needed it too, and a second
 * copy is how two surfaces come to disagree about which cards get asked.
 *
 * So the sequence lives here and both callers pass their own way of
 * fronting a card. The pane fronts by selecting a tab within itself; the
 * delete fronts by dispatching `focus-session-card`, which reaches a card
 * anywhere in the deck. Neither detail belongs to the walk.
 *
 * The two properties worth stating, because both are load-bearing and
 * neither is obvious:
 *
 *   - **`null` is not `"close"`.** A walk over cards whose guards are all
 *     clean returns `null`, which tells the caller nothing was asked — the
 *     pane uses that to fall through to its own "Close N Tabs?" popover, so
 *     a stray click on a multi-tab pane is still caught. Returning a
 *     resolver that answers `"close"` would swallow that protection.
 *   - **Each guard is re-resolved at visit time.** An earlier decision can
 *     replace or release a later card's guard — Save All, or a card that
 *     cleaned itself — and a list of guard objects captured up front would
 *     prompt for work that is no longer unsaved.
 *
 * @module lib/close-guard-walk
 */

import {
  getCardCloseGuard,
  type CardCloseDecision,
} from "./card-close-guard";

/**
 * Compose the close decision for `ids`, in the order given.
 *
 * Returns `null` when no card among them registers a guard that
 * `needsDecision()` — nothing would be asked, so the caller keeps whatever
 * confirmation it would otherwise have shown. Otherwise returns a resolver
 * that visits each guarded card in turn, fronting a dirty one before its
 * sheet, and answers `"cancel"` at the first card that cancels.
 *
 * @param ids     The cards the gesture would destroy, in the order they
 *                should be visited.
 * @param front   Bring a card to the front so its sheet is seen over its own
 *                content. Called only for a card that `needsDecision()` and
 *                is not already front.
 * @param isFront Whether a card is already the one on screen. Read live at
 *                each visit rather than captured, so the walk sees the
 *                fronting it has itself performed.
 */
export function closeGuardWalk(
  ids: readonly string[],
  front: (cardId: string) => void,
  isFront: (cardId: string) => boolean,
): CardCloseDecision | null {
  const guarded = ids.filter((id) => getCardCloseGuard(id) !== null);
  if (guarded.length === 0) return null;
  if (!guarded.some((id) => getCardCloseGuard(id)?.needsDecision() === true)) {
    return null;
  }
  return async () => {
    for (const id of guarded) {
      // Re-resolve at visit time: an earlier decision (e.g. Save) may have
      // replaced or released this card's guard.
      const guard = getCardCloseGuard(id);
      if (!guard) continue;
      if (guard.needsDecision() && !isFront(id)) front(id);
      if ((await guard.run()) === "cancel") return "cancel";
    }
    return "close";
  };
}
