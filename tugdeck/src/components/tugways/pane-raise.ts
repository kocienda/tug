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
 * The lift is RANKED by raise order, not flat ([B03]). Two frames can hold an
 * overhanging surface at once — a sheet on one card and a folded card's Z2
 * placard hanging off another — and on one flat value they tie, at which point
 * paint order decides and the card standing later in the deck array wins
 * whichever surface the user raised last. So each raised frame publishes its
 * position in the raise order as `--tugx-pane-raise-rank`, and the CSS rule
 * adds it to the base token. This is a different axis from the deck's
 * focus-order z map, which is still neither consulted nor changed ([B04]): the
 * rank orders only the frames currently holding an overhang, and releasing the
 * last one puts the frame back on its array-order z untouched.
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
 * The raised frames in raise order, oldest first — the list the ranks are
 * assigned from. An array rather than a `WeakMap` because the ranks are
 * relative and every one of them moves when any frame joins or leaves, which
 * means this has to be iterable. It holds a strong reference for exactly as
 * long as a frame is raised, and {@link normalizeRanks} drops any frame that
 * left the document without its release being called, so a pane torn down
 * under an open surface is not kept alive by this. Dropping a frame from the
 * ORDER is all that purge does: the ref-count is the balance between a raise
 * and its release and belongs to neither the order nor the document, and a
 * `WeakMap` entry keyed on a node nothing else holds is collected anyway.
 */
const RAISED_FRAMES: HTMLElement[] = [];

/** The custom property the `tug-pane.css` lift rule adds to its base token. */
const RANK_PROPERTY = "--tugx-pane-raise-rank";

/**
 * The highest rank a frame may take, as an offset off `--tug-z-pane-sheet-open`
 * (8900). The ceiling is the drop-zone indicator at 8950, which has to keep
 * painting over a raised pane (`tugdeck/styles/chrome.css`, [B02]) — so the
 * band is 8900..8949 and the top of it is 49. A deck never holds fifty
 * overhanging surfaces at once; if one somehow did, the newest frames tie at
 * the top rather than climbing out of the band.
 */
const MAX_RANK = 49;

/**
 * Publish every raised frame's rank from its position in the raise order,
 * dropping any frame that has left the document on the way through. Ranks are
 * dense from 0, so the ordinary case of ONE raised frame is the flat
 * `--tug-z-pane-sheet-open` the lift has always been.
 */
function normalizeRanks(): void {
  for (let i = RAISED_FRAMES.length - 1; i >= 0; i -= 1) {
    const frame = RAISED_FRAMES[i];
    if (frame !== undefined && !frame.isConnected) {
      RAISED_FRAMES.splice(i, 1);
    }
  }
  RAISED_FRAMES.forEach((frame, i) => {
    frame.style.setProperty(RANK_PROPERTY, `${Math.min(i, MAX_RANK)}`);
  });
}

/**
 * Mark a pane frame as holding an overhanging surface, and return the balanced
 * release. The attribute is read only by `tug-pane.css`, which lifts the frame
 * above every peer pane while it is set.
 *
 * EVERY raise moves the frame to the top of the order, including a frame that
 * is already raised. A second surface going up on a frame is the user acting
 * on that frame, and the rule is the last raise wins — so a card already
 * holding a placard that opens a sheet comes up over a peer raised in between,
 * which keeping the earlier rank would not do. The ref-count is untouched by
 * this: it counts surfaces, the order ranks frames.
 */
export function raisePaneAbovePeers(frame: HTMLElement): () => void {
  PANE_RAISE_COUNTS.set(frame, (PANE_RAISE_COUNTS.get(frame) ?? 0) + 1);
  const held = RAISED_FRAMES.indexOf(frame);
  if (held !== -1) RAISED_FRAMES.splice(held, 1);
  RAISED_FRAMES.push(frame);
  frame.setAttribute("data-sheet-open", "");
  normalizeRanks();
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
    const at = RAISED_FRAMES.indexOf(frame);
    if (at !== -1) RAISED_FRAMES.splice(at, 1);
    frame.style.removeProperty(RANK_PROPERTY);
    frame.removeAttribute("data-sheet-open");
    normalizeRanks();
  };
}
