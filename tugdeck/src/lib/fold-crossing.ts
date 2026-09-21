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
 * change is not dirtied by its ancestor's tween ([B01]). Two facts carry it for
 * a fold, and this module is the one place either is written:
 *
 * - `FOLD_CROSSING_ATTR` on the frame, for the tween's life. What is about
 *   folding keys on it; the hold itself — `.tug-pane-content` turning
 *   `overflow: hidden` so the overflowing interior draws no scrollbar and takes
 *   no wheel, and the card root taking a definite height — keys on the still
 *   crossing's mark below, which a fold sets beside this one.
 * - the held height on the content box's children: the LARGER of the two
 *   content heights, First on the fold in and Last on the unfold, since in both
 *   directions that is the open one ([F06]). The number the hold resolves
 *   against is `STILL_HELD_HEIGHT_PROP`; `FOLD_HELD_HEIGHT_PROP` carries the
 *   fold's own copy of it beside that one, and nothing reads it.
 *
 * The end is an event rather than a `transitionend` or a timer, because the
 * crossing's clock is the imposer's spring and nothing else in the card moves
 * on a clock of its own ([B03], [B05]). The card listens for it and writes what
 * CSS cannot — `inert` on the two regions, `data-fold="settled"` — so every
 * appearance change stays in CSS and the DOM ([L06]).
 *
 * The event shape is `lib/resize-episode.ts`'s: a `CustomEvent` on the frame
 * carrying an id, so a late end cannot close a newer crossing.
 *
 * ## The still crossing — the same hold, for any height tween
 *
 * The argument above never depended on the fold. It depends on a height tween
 * over a subtree that is expensive to lay out, and a stack, a split, a join
 * and a leave are all that. So the hold has a general form with its own mark
 * and its own held height — `STILL_CROSSING_ATTR` and `STILL_HELD_HEIGHT_PROP`
 * — and doors shaped exactly like the fold's. A fold is one kind of still
 * crossing: `markFoldCrossing` sets both marks and `endFoldCrossing` ends both.
 *
 * Two marks rather than one widened, because everything that reads the fold's
 * reads it as "a fold": the card's terminal-state effect, `afterFoldCrossing`'s
 * two waiters. A stack that set the fold's mark would have a compaction cover
 * waiting on, or closed by, a settle that is not a fold. The still crossing
 * therefore announces nothing — it is a layout hold, and nobody lands on it.
 *
 * A re-mark never lowers a held height, in either form. On a retarget the
 * imposer measures First mid-tween, at an intermediate height, so the larger
 * of ITS two heights can be smaller than the box the interior is already held
 * at; taking it would re-lay the interior out once in mid-sweep, which is the
 * one thing the hold exists to prevent.
 */

/** Stamped on the frame for the length of a crossing. Observable to tests; not React state ([L06]). */
export const FOLD_CROSSING_ATTR = "data-fold-crossing";

/**
 * The open content height a FOLD holds the interior at, in CSS pixels, written
 * on the content box's children so it inherits to the card root.
 *
 * No stylesheet reads it. The hold itself reads
 * {@link STILL_HELD_HEIGHT_PROP}, which a fold sets beside this one and which
 * is the number the pane's rule resolves against — so changing what is written
 * here changes no pixels. It stays because the fold's two facts travel
 * together: a reader or a test asking "what was this fold held at?" asks the
 * fold's own property rather than the general one, which any other crossing
 * sharing the window may have raised.
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

/** Stamped on the frame for the length of any held height tween, a fold's included. Observable to tests; not React state ([L06]). */
export const STILL_CROSSING_ATTR = "data-still-crossing";

/**
 * The height the interior is held at under the still crossing, written where
 * `FOLD_HELD_HEIGHT_PROP` is and for the same reason. Its own property so the
 * pane-level hold reads one name whatever opened the crossing.
 */
export const STILL_HELD_HEIGHT_PROP = "--tugx-still-held-height";

/**
 * Declared by a card ROOT, never by the imposer: which edge its held picture
 * hangs from. Absent means the top. `"bottom"` hangs it from the content box's
 * bottom for the length of a still crossing that is not a fold, so content the
 * card keeps pinned to its bottom rides the frame's edge (`tug-pane.css`). The
 * card writes it from whatever says its content is pinned there — DOM zone, no
 * React state ([L06]) — and the imposer still measures nothing inside the card.
 */
export const STILL_ANCHOR_ATTR = "data-still-anchor";

let nextCrossingId = 1;

/** What a standing crossing wrote, so a re-mark can refuse to lower it and the end takes it off the same box. */
interface Held {
  /** The content box the held height was written onto. */
  readonly box: HTMLElement | null;
  readonly heightPx: number;
}

/** One kind of crossing: the frame attribute, the held-height property, and what stands on each frame. */
interface CrossingKind {
  readonly attr: string;
  readonly prop: string;
  readonly held: WeakMap<HTMLElement, Held>;
}

const FOLD_KIND: CrossingKind = {
  attr: FOLD_CROSSING_ATTR,
  prop: FOLD_HELD_HEIGHT_PROP,
  held: new WeakMap(),
};

const STILL_KIND: CrossingKind = {
  attr: STILL_CROSSING_ATTR,
  prop: STILL_HELD_HEIGHT_PROP,
  held: new WeakMap(),
};

/**
 * The height a mark holds the interior at: the new one, unless a crossing is
 * already standing at a larger one. `standingPx` is `null` when the frame is
 * not held.
 */
export function heldHeightOnMark(
  standingPx: number | null,
  nextPx: number,
): number {
  return standingPx === null ? nextPx : Math.max(standingPx, nextPx);
}

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
  markKind(STILL_KIND, frame, heldHeightPx);
  return markKind(FOLD_KIND, frame, heldHeightPx);
}

/**
 * Open a still crossing on `frame`, held at `heldHeightPx` — the general form
 * of `markFoldCrossing`, for a height tween that is not a fold. The fold's
 * mark is left exactly as it stands, present or absent.
 *
 * Re-marks in place under a fresh id, like the fold's, and never lowers a
 * standing held height. Returns the crossing's id.
 */
export function markStillCrossing(
  frame: HTMLElement,
  heldHeightPx: number,
): number {
  return markKind(STILL_KIND, frame, heldHeightPx);
}

function markKind(
  kind: CrossingKind,
  frame: HTMLElement,
  heldHeightPx: number,
): number {
  const id = nextCrossingId++;
  // A standing height counts only while the mark is on the frame: a record
  // outliving its mark would hold the next crossing at a stale box.
  const standing = frame.hasAttribute(kind.attr)
    ? (kind.held.get(frame)?.heightPx ?? null)
    : null;
  const heightPx = heldHeightOnMark(standing, heldHeightPx);
  const content = contentBoxOf(frame);
  kind.held.set(frame, { box: content, heightPx });
  if (content !== null) {
    for (const child of content.children) {
      if (child instanceof HTMLElement) {
        child.style.setProperty(kind.prop, `${heightPx}px`);
      }
    }
  }
  frame.setAttribute(kind.attr, String(id));
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
  return adoptKind(FOLD_KIND, frame);
}

/**
 * `adoptFoldCrossing` for the still crossing: the replacement settle takes the
 * standing hold over under a fresh id, so the cancelled tween's completion
 * cannot release an interior whose edge is still travelling.
 */
export function adoptStillCrossing(frame: HTMLElement): number | null {
  return adoptKind(STILL_KIND, frame);
}

function adoptKind(kind: CrossingKind, frame: HTMLElement): number | null {
  if (!frame.hasAttribute(kind.attr)) return null;
  const id = nextCrossingId++;
  frame.setAttribute(kind.attr, String(id));
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
  const stamp = endKind(FOLD_KIND, frame, crossingId);
  if (stamp === null) return;
  // A fold is a still crossing, so its end is the still crossing's end too.
  // Unguarded, because the id that just matched is the fold's: whoever holds
  // the live fold id holds the live crossing.
  endKind(STILL_KIND, frame);
  frame.dispatchEvent(
    new CustomEvent<FoldCrossingEventDetail>(FOLD_CROSSING_END, {
      detail: { crossingId: stamp },
      cancelable: false,
      bubbles: false,
    }),
  );
}

/**
 * Close the still crossing on `frame`: take the mark and the held height off.
 * `crossingId` guards a late end exactly as `endFoldCrossing`'s does, and is
 * omitted on the same two paths. Announces nothing, and leaves the fold's mark
 * alone: a fold still running is ended by its own door, which ends this too.
 */
export function endStillCrossing(
  frame: HTMLElement,
  crossingId?: number,
): void {
  endKind(STILL_KIND, frame, crossingId);
}

/** Take one kind's mark and held height off `frame`. Returns the stamp it closed, or `null` when it closed nothing. */
function endKind(
  kind: CrossingKind,
  frame: HTMLElement,
  crossingId?: number,
): number | null {
  const stamp = frame.getAttribute(kind.attr);
  if (stamp === null) return null;
  if (crossingId !== undefined && Number(stamp) !== crossingId) return null;
  frame.removeAttribute(kind.attr);
  // The box the mark was written on, not the one the frame holds now: a pane
  // whose content box was replaced mid-crossing left the property on the old
  // element, and the new one never carried it.
  const content = kind.held.get(frame)?.box ?? contentBoxOf(frame);
  kind.held.delete(frame);
  if (content !== null) {
    for (const child of content.children) {
      if (child instanceof HTMLElement) {
        child.style.removeProperty(kind.prop);
      }
    }
  }
  return Number(stamp);
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
