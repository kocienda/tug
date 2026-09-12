/**
 * The fold crossing — the window in which a Session card's frame tweens
 * between its open and folded heights.
 *
 * The imposer owns it, because the imposer is the only thing that knows both
 * sides of the commit: its FLIP pass measures every frame before the commit
 * (First) and after it (Last), so a frame whose `data-folded` differs between
 * the two and whose height term tweens IS a fold crossing, with no cache, no
 * watcher and no measurement inside the card at all
 * (`session-fold-still-interior` brief, [B04]).
 *
 * What the mark buys is a still interior. The card is laid out once at its OPEN
 * size and the pane's content box clips it, so nothing inside the card re-flows
 * while the frame's edge sweeps: a subtree with a definite height that does not
 * change is not dirtied by its ancestor's tween ([B01]). Two facts carry that,
 * and this module is the one place either is written:
 *
 * - `FOLD_CROSSING_ATTR` on the frame, for the tween's life. Every stylesheet
 *   that has to hold its open layout keys on it — `.tug-pane-content` turning
 *   `overflow: hidden` so the overflowing interior draws no scrollbar and takes
 *   no wheel, and the card root taking a definite height.
 * - `FOLD_HELD_HEIGHT_PROP` on the content box's children, which is the height
 *   the interior is held at: the LARGER of the two content heights, First on
 *   the fold in and Last on the unfold, since in both directions that is the
 *   open one ([F06]).
 *
 * The end is an event rather than a `transitionend` or a timer, because the
 * crossing's clock is the imposer's spring and nothing else in the card moves
 * on a clock of its own ([B03], [B05]). The card listens for it and writes what
 * CSS cannot — `inert` on the two regions, `data-fold="settled"` — so every
 * appearance change stays in CSS and the DOM ([L06]).
 *
 * The event shape is `lib/resize-episode.ts`'s: a `CustomEvent` on the frame
 * carrying an id, so a late end cannot close a newer crossing.
 */

/** Stamped on the frame for the length of a crossing. Observable to tests; not React state ([L06]). */
export const FOLD_CROSSING_ATTR = "data-fold-crossing";

/**
 * The open content height the interior is held at, in CSS pixels, written on
 * the content box's children so it inherits to the card root.
 *
 * On the children rather than on the content box itself because the content box
 * is the thing that SHRINKS: the held height belongs to the layout being held,
 * and reading it from the box whose height it is not would be one indirection
 * for a reader to unpick.
 */
export const FOLD_HELD_HEIGHT_PROP = "--tugx-fold-held-height";

/** Dispatched on the frame when a crossing ends. Not cancelable: the crossing is already over. */
export const FOLD_CROSSING_END = "tug-fold-crossing-end";

/** Detail carried by the crossing-end event. */
export interface FoldCrossingEventDetail {
  /** Identifies the crossing, so a late end cannot close a newer one. */
  readonly crossingId: number;
}

let nextCrossingId = 1;

/** The content box a crossing wrote the held height onto, so the end takes it off the same one. */
const heldBoxes = new WeakMap<HTMLElement, HTMLElement>();

/** The pane's content box — the element that clips the held interior. */
function contentBoxOf(frame: HTMLElement): HTMLElement | null {
  return frame.querySelector<HTMLElement>(".tug-pane-content");
}

/**
 * Open a crossing on `frame`, held at `heldHeightPx`.
 *
 * Idempotent in the sense that matters: a frame already carrying a mark is
 * re-marked in place with the new height and a fresh id, and NO end event is
 * dispatched. A retarget mid-fold is one crossing continuing at a new speed,
 * not one ending and another starting, and announcing an end there would land
 * the card in its terminal form while the edge is still travelling.
 *
 * Returns the crossing's id.
 */
export function markFoldCrossing(
  frame: HTMLElement,
  heldHeightPx: number,
): number {
  const id = nextCrossingId++;
  const content = contentBoxOf(frame);
  if (content !== null) {
    heldBoxes.set(frame, content);
    for (const child of content.children) {
      if (child instanceof HTMLElement) {
        child.style.setProperty(FOLD_HELD_HEIGHT_PROP, `${heldHeightPx}px`);
      }
    }
  }
  frame.setAttribute(FOLD_CROSSING_ATTR, String(id));
  return id;
}

/**
 * Take over the crossing already open on `frame`, under a fresh id, or `null`
 * when there is none.
 *
 * A settle that lands inside a crossing's window cancels the tween carrying it
 * and launches another to finish the travel. The crossing is the SAME crossing
 * — the edge has not stopped, and the interior must stay held — but the
 * cancelled tween's completion handler still holds the id it opened, and would
 * close the crossing out from under the tween that replaced it, landing the
 * card in its terminal form with the whole rest of the travel still to come.
 *
 * `markFoldCrossing` covers the case where the replacement settle is itself a
 * fold crossing, because a re-mark takes a fresh id. This covers the other and
 * far commoner one: the replacement settle is any OTHER deck change, which
 * does not re-mark, so nothing would otherwise invalidate the stale handler.
 *
 * The held height is left exactly as it was: the interior is still being held
 * at the same open box, and the new settle has no better number for it.
 */
export function adoptFoldCrossing(frame: HTMLElement): number | null {
  if (!frame.hasAttribute(FOLD_CROSSING_ATTR)) return null;
  const id = nextCrossingId++;
  frame.setAttribute(FOLD_CROSSING_ATTR, String(id));
  return id;
}

/**
 * Close the crossing on `frame`: take the mark and the held height off, and
 * announce the end.
 *
 * `crossingId` is the id `markFoldCrossing` returned, and passing it is what
 * makes a late end safe. A settle interrupted mid-fold cancels its tweens, and
 * their completion handlers land a microtask later — after the replacement
 * settle's tween pass has already re-marked the frame. Without the guard that
 * stale handler would clear a crossing that is still running and announce an
 * end while the edge is still travelling, landing the card in its terminal
 * form mid-sweep. With it, the stale handler is a no-op.
 *
 * Omit it only where the intent is "leave no frame marked whatever is
 * running" — the settle window's sweep and the effect's teardown.
 *
 * Safe to call on a frame with no crossing open, which is what lets every one
 * of those paths call it unconditionally.
 */
export function endFoldCrossing(
  frame: HTMLElement,
  crossingId?: number,
): void {
  const stamp = frame.getAttribute(FOLD_CROSSING_ATTR);
  if (stamp === null) return;
  if (crossingId !== undefined && Number(stamp) !== crossingId) return;
  frame.removeAttribute(FOLD_CROSSING_ATTR);
  // The box the mark was written on, not the one the frame holds now: a pane
  // whose content box was replaced mid-crossing left the property on the old
  // element, and the new one never carried it.
  const content = heldBoxes.get(frame) ?? contentBoxOf(frame);
  heldBoxes.delete(frame);
  if (content !== null) {
    for (const child of content.children) {
      if (child instanceof HTMLElement) {
        child.style.removeProperty(FOLD_HELD_HEIGHT_PROP);
      }
    }
  }
  frame.dispatchEvent(
    new CustomEvent<FoldCrossingEventDetail>(FOLD_CROSSING_END, {
      detail: { crossingId: Number(stamp) },
      cancelable: false,
      bubbles: false,
    }),
  );
}

/**
 * The height of `frame`'s content box right now, or `null` when it has none.
 *
 * Read by the imposer on both sides of the commit — First in the arm, Last in
 * the tween pass — so the held height is the open one in either direction.
 */
export function contentBoxHeight(frame: HTMLElement): number | null {
  const content = contentBoxOf(frame);
  if (content === null) return null;
  return content.getBoundingClientRect().height;
}

/**
 * Run `whenEnded` when the crossing on `frame` ends — the wait every surface
 * outside the card does when it has to land ON the fold rather than merely
 * after it, and the one implementation of it.
 *
 * One implementation because the two waiters are the two halves of one
 * handoff: the compaction cover rising back out of the Z2 row, and that row's
 * own occupant leaving as the edge sweeps down. Two copies of this would be
 * two opinions about which settles carry a crossing, and a copy that drifted
 * is a surface that never arrives or one that never leaves.
 *
 * The end is an event, because the crossing's clock is the imposer's spring
 * and a timer would be a second copy of it. The one case the event cannot
 * cover is a settle that carried no crossing for this frame — motion off, a
 * fold with nothing to tween — where no end is coming at all; ONE frame
 * answers that, and it is not a clock: the imposer marks in the same commit's
 * layout pass, which runs before paint, so a frame that is unmarked on the
 * next one was never crossing.
 *
 * Returns a cancel, which is what a caller torn down mid-crossing runs.
 */
export function afterFoldCrossing(
  frame: HTMLElement,
  whenEnded: () => void,
): () => void {
  const onEnd = (): void => {
    whenEnded();
  };
  frame.addEventListener(FOLD_CROSSING_END, onEnd, { once: true });
  let probe: number | null = window.requestAnimationFrame(() => {
    probe = null;
    if (frame.hasAttribute(FOLD_CROSSING_ATTR)) return;
    frame.removeEventListener(FOLD_CROSSING_END, onEnd);
    whenEnded();
  });
  return () => {
    frame.removeEventListener(FOLD_CROSSING_END, onEnd);
    if (probe !== null) window.cancelAnimationFrame(probe);
  };
}
