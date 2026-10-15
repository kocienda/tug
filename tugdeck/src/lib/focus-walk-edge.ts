/**
 * The walk edge: who takes the Tab walk past the last stop of this page's
 * key card, or before its first.
 *
 * A card whose content lives in another page has its Tab walk split across
 * two documents: its own stops in its body, the stops of its chrome in the
 * shell. So at the end of either page's walk the next stop may be the other
 * page's, and wrapping in place would leave the other half unreachable.
 * `advanceKeyViewFocus` (`components/tugways/focus-manager.ts`) consults this
 * when a base-mode step would wrap; an installed edge that answers `true`
 * has taken the step, and the walk does not wrap. With none installed a page
 * wraps as it always has.
 *
 * @module lib/focus-walk-edge
 */

/** Takes a step off the edge of the walk; returns whether it took it. */
export type FocusWalkEdge = (direction: 1 | -1) => boolean;

let walkEdge: FocusWalkEdge | null = null;

/** Install the page's walk edge. Returns the uninstall. */
export function setFocusWalkEdge(edge: FocusWalkEdge): () => void {
  walkEdge = edge;
  return () => {
    if (walkEdge === edge) walkEdge = null;
  };
}

/** Offer a step off the walk's edge; whether an installed edge took it. */
export function takeFocusWalkEdge(direction: 1 | -1): boolean {
  return walkEdge !== null && walkEdge(direction);
}
