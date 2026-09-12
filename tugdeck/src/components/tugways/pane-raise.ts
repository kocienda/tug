/**
 * pane-raise.ts — lift a pane frame above every peer while a surface it holds
 * is overhanging.
 *
 * A pane frame carries no `overflow`, `transform` or `contain` (`tug-pane.css`
 * forbids adding any), so a panel portaled into it can hang past the frame's
 * own edges. What it cannot do on its own is PAINT there: a peer pane standing
 * later in the deck's focus order has a higher z-index and covers the
 * overhang. The lift is the answer — one attribute on the frame, one rule in
 * `tug-pane.css` (`.tug-pane[data-sheet-open]:not([data-sidebar-pane])`), and
 * the ref-count here.
 *
 * The attribute keeps the name the sheet gave it. Two surfaces use the lift
 * now — a pane-modal sheet, and a Z2 placard on a folded card hanging below
 * its frame — and a third name for the same DOM flag would only mean two
 * spellings of one fact for every reader and every test. What matters is that
 * they share ONE attribute, ONE rule and ONE count, so a sheet and a placard
 * up over the same frame release it in either order without the first to close
 * clearing the flag out from under the second.
 *
 * @module components/tugways/pane-raise
 */

/**
 * How many overhanging surfaces each pane frame currently holds.
 *
 * A `WeakMap` because the key is a DOM node whose pane may be closed at any
 * time, and nothing here should be what keeps it alive.
 */
const PANE_RAISE_COUNTS = new WeakMap<HTMLElement, number>();

/**
 * Mark a pane frame as holding an overhanging surface, and return the balanced
 * release. The attribute is read only by `tug-pane.css`, which lifts the frame
 * above every peer pane while it is set.
 */
export function raisePaneAbovePeers(frame: HTMLElement): () => void {
  PANE_RAISE_COUNTS.set(frame, (PANE_RAISE_COUNTS.get(frame) ?? 0) + 1);
  frame.setAttribute("data-sheet-open", "");
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (PANE_RAISE_COUNTS.get(frame) ?? 1) - 1;
    if (remaining > 0) {
      PANE_RAISE_COUNTS.set(frame, remaining);
      return;
    }
    PANE_RAISE_COUNTS.delete(frame);
    frame.removeAttribute("data-sheet-open");
  };
}
