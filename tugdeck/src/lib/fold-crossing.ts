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
 * - the held height on the card root: the LARGER of the two
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
 * waiting on, or closed by, a settle that is not a fold. So the still crossing
 * announces its end under its OWN event, `STILL_CROSSING_END`, which nothing
 * waiting on a fold hears. What waits on it is the interior being held: a list
 * view owes its pin, its restore and its extent rebase while its frame wears
 * the mark, and catches up once when this event says the hold is off.
 *
 * The announcement is made where the mark is taken off, and nowhere else: the
 * one remover is shared by every path that lifts the hold — a beat's
 * completion, the window sweep, a retarget, the unmount, a fold's end, and the
 * Last pass's end of a mark `arm` opened for a frame that turned out not to
 * change height — so nothing owed is ever stranded behind a path that forgot
 * to say so.
 *
 * A still crossing can open at `arm`, in the store's notify, before React
 * commits the arrangement that changes the frame's height. The settle engine
 * predicts which frames that arrangement resizes and holds each at its First
 * content height there, so the commit's own frame change never reaches the
 * card's interior; the Last pass then re-marks (never lowering) or ends it.
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
 * Dispatched on the frame when a still crossing ends, by whichever path took
 * the mark off. Not cancelable, and does not bubble: it is the frame's own news.
 */
export const STILL_CROSSING_END = "tug-still-crossing-end";

/** Detail carried by the still crossing's end event. */
export interface StillCrossingEventDetail {
  /** The stamp the end closed, so a listener can tell one crossing's end from another's. */
  readonly id: number;
}

/**
 * Stamped on the frame beside `STILL_CROSSING_ATTR` when the interior is held
 * at its FINAL height rather than the larger of its two — a SETTLED still
 * crossing. The interior is already laid out where it will land, so nothing
 * inside it waits on the hold: a list view acts on its geometry at once
 * instead of owing its pin to the crossing's end. Not React state ([L06]).
 */
export const STILL_SETTLED_ATTR = "data-still-settled";

/**
 * Dispatched on the frame when a still crossing is settled — in the set-up,
 * before the first frame — so the interior pays what it would otherwise owe
 * to the land: the pin, the restore, the extent rebase and the re-window, all
 * against the geometry it lands at. Not cancelable, and does not bubble.
 */
export const STILL_CROSSING_SETTLED = "tug-still-crossing-settled";

/**
 * The height the interior is held at under the still crossing, written where
 * `FOLD_HELD_HEIGHT_PROP` is and for the same reason. Its own property so the
 * pane-level hold reads one name whatever opened the crossing.
 */
export const STILL_HELD_HEIGHT_PROP = "--tugx-still-held-height";

/**
 * The width the interior is held at under a still crossing whose frame's
 * width tweens, written beside `STILL_HELD_HEIGHT_PROP` and read only while
 * {@link STILL_WIDTH_ATTR} is on the frame. A crossing that carries no width
 * term leaves the root's own width alone.
 */
export const STILL_HELD_WIDTH_PROP = "--tugx-still-held-width";

/** Stamped on the frame while its still crossing holds a width as well. */
export const STILL_WIDTH_ATTR = "data-still-width";

/**
 * Stamped beside {@link STILL_WIDTH_ATTR} when the crossing carries no height
 * term: the box's height does not change, so the root keeps its own. A root
 * whose height is `auto` — a card that lets the content box do its scrolling
 * — held at the box's height would become its own scroller, the content box's
 * extent would collapse to the box, and the reader's place would clamp to the
 * top.
 */
export const STILL_HEIGHT_FREE_ATTR = "data-still-height-free";

/**
 * Declared by a card ROOT, never by the imposer: which edge its held picture
 * hangs from. Absent means the top. `"bottom"` hangs it from the content box's
 * bottom for the length of a still crossing that is not a fold, so content the
 * card keeps pinned to its bottom rides the frame's edge (`tug-pane.css`). The
 * card writes it from whatever says its content is pinned there — DOM zone, no
 * React state ([L06]) — and the imposer still measures nothing inside the card.
 */
export const STILL_ANCHOR_ATTR = "data-still-anchor";

/**
 * How long a settle that opens a fold crossing stands at First before its
 * first beat moves, in ms — the fold's prepare beat. One and a half 60Hz
 * frames: the frame after the commit's own, where the interior's answers to
 * the commit land (observers' rAF writes, the after-paint React notify), is
 * always inside it, and the frame after that never is. Scaled with every
 * other imposer duration by `--tug-timing`.
 */
export const FOLD_PREPARE_MS = 25;

/**
 * {@link FOLD_PREPARE_MS} for a settle that reveals an arrival: two and a half
 * 60Hz frames, so the frame where the revealed card is first laid out and the
 * frame where its passive effects' observers first deliver are both inside
 * it, and the one after that never is.
 */
export const ARRIVAL_PREPARE_MS = 42;

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

/**
 * The card roots under a content box — where a held height is written. The
 * content box's child is the portal slot and the slot's is the card host, both
 * `display: contents`, so the root is the first box below the clip.
 *
 * On the root and nowhere above it, because the property is registered
 * non-inheriting (`tug-pane.css`): written on the slot, as it once was, it was
 * inherited by every element in the card, and taking it off restyled all of
 * them — 8–15 ms on a real transcript, paid at the land, for a value only the
 * root reads.
 */
function heldTargetsOf(content: HTMLElement): HTMLElement[] {
  return Array.from(
    content.querySelectorAll<HTMLElement>(":scope [data-card-host] > *"),
  );
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

/**
 * Open or re-mark a SETTLED still crossing on `frame`, held at exactly
 * `finalHeightPx` — the content height the frame lands at.
 *
 * This is the land pre-paid. Held at the larger of its two heights, the
 * interior re-lays itself out at the land, when the hold comes off, and the
 * list view pays its owed pin there: on a real transcript that is the one
 * frame of 35–49 ms left in a height-bearing settle. Held at its final
 * height, the interior is laid out where it lands before the first frame,
 * and taking the hold off changes no geometry — though it still re-lays the
 * card out at the same size, so the settle takes it off two paints past the
 * land rather than in it.
 *
 * Unlike every other mark this one may LOWER a standing height. The rule
 * against lowering protects a picture laid out at an open height from being
 * re-laid-out mid-sweep; a settled hold has no such picture to protect, and
 * a retarget runs its own set-up, so it lays the interior out at its new
 * final height at once. Never for a fold, whose interior must stay laid out
 * open while it folds.
 *
 * The interior hears of it only through
 * {@link announceStillCrossingSettled}, which the caller makes once the
 * frame's own holds are written, so what the interior reads is the geometry
 * of the first frame.
 */
export function settleStillCrossing(
  frame: HTMLElement,
  finalHeightPx: number,
): number {
  // The standing record goes first so the mark below starts from nothing.
  STILL_KIND.held.delete(frame);
  frame.removeAttribute(STILL_CROSSING_ATTR);
  const id = markKind(STILL_KIND, frame, finalHeightPx);
  frame.setAttribute(STILL_SETTLED_ATTR, "");
  return id;
}

/**
 * Tell `frame`'s interior that its still crossing is settled, so it pays
 * what it would otherwise owe to the land now. A no-op on a frame that is not
 * settled.
 */
export function announceStillCrossingSettled(frame: HTMLElement): void {
  const stamp = frame.getAttribute(STILL_CROSSING_ATTR);
  if (stamp === null || !frame.hasAttribute(STILL_SETTLED_ATTR)) return;
  frame.dispatchEvent(
    new CustomEvent<StillCrossingEventDetail>(STILL_CROSSING_SETTLED, {
      detail: { id: Number(stamp) },
      cancelable: false,
      bubbles: false,
    }),
  );
}

/**
 * Whether `frame`'s interior is held at a height it will not land at — what
 * an interior asks before it acts on its geometry. A settled crossing holds
 * its interior where it lands, so it answers no.
 */
export function isInteriorHeld(frame: HTMLElement): boolean {
  return (
    frame.hasAttribute(STILL_CROSSING_ATTR) &&
    !frame.hasAttribute(STILL_SETTLED_ATTR)
  );
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
  // Any mark but a settle's holds a picture at an open height, so a frame it
  // re-marks is no longer settled; `settleStillCrossing` sets it after this.
  if (kind === STILL_KIND) {
    frame.removeAttribute(STILL_SETTLED_ATTR);
    // A width is held only by the settle that sets it, after this mark.
    releaseWidth(frame, kind.held.get(frame)?.box ?? contentBoxOf(frame));
  }
  const heightPx = heldHeightOnMark(standing, heldHeightPx);
  const content = contentBoxOf(frame);
  kind.held.set(frame, { box: content, heightPx });
  if (content !== null) {
    for (const root of heldTargetsOf(content)) {
      root.style.setProperty(kind.prop, `${heightPx}px`);
    }
  }
  frame.setAttribute(kind.attr, String(id));
  return id;
}

/**
 * Hold the interior of a still-crossing `frame` at `widthPx` as well as its
 * height — for a frame whose width tweens ([B05] of set-up-and-go-fixups).
 * `heightHeld` is whether the crossing carries a height term too; one that
 * does not leaves the root's own height alone ({@link STILL_HEIGHT_FREE_ATTR}).
 *
 * The height hold's argument holds on the other axis: a list view under a
 * widening frame re-windows its rows at every width it passes through, one
 * React commit per animation frame. Held at one definite width, the scrollport
 * does not resize and nothing is delivered. Call after the mark, which clears
 * any width a previous crossing held; the crossing's end takes it off.
 */
export function holdStillWidth(
  frame: HTMLElement,
  widthPx: number,
  heightHeld: boolean,
): void {
  const content = STILL_KIND.held.get(frame)?.box ?? contentBoxOf(frame);
  if (content === null || widthPx <= 0) return;
  for (const root of heldTargetsOf(content)) {
    root.style.setProperty(STILL_HELD_WIDTH_PROP, `${widthPx}px`);
  }
  frame.setAttribute(STILL_WIDTH_ATTR, "");
  if (!heightHeld) frame.setAttribute(STILL_HEIGHT_FREE_ATTR, "");
}

function releaseWidth(frame: HTMLElement, content: HTMLElement | null): void {
  if (!frame.hasAttribute(STILL_WIDTH_ATTR)) return;
  frame.removeAttribute(STILL_WIDTH_ATTR);
  frame.removeAttribute(STILL_HEIGHT_FREE_ATTR);
  if (content === null) return;
  for (const root of heldTargetsOf(content)) {
    root.style.removeProperty(STILL_HELD_WIDTH_PROP);
  }
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
 * omitted on the same two paths. Announces `STILL_CROSSING_END` when it closed
 * a mark, and leaves the fold's mark alone: a fold still running is ended by
 * its own door, which ends this too and announces both.
 */
export function endStillCrossing(
  frame: HTMLElement,
  crossingId?: number,
): void {
  endKind(STILL_KIND, frame, crossingId);
}

/**
 * Take one kind's mark and held height off `frame`. Returns the stamp it
 * closed, or `null` when it closed nothing.
 *
 * The still crossing's end is announced HERE, because this is the mark's only
 * remover: whichever door lifted the hold, the interior that owed its
 * reactions to it hears so once.
 */
function endKind(
  kind: CrossingKind,
  frame: HTMLElement,
  crossingId?: number,
): number | null {
  const stamp = frame.getAttribute(kind.attr);
  if (stamp === null) return null;
  if (crossingId !== undefined && Number(stamp) !== crossingId) return null;
  frame.removeAttribute(kind.attr);
  if (kind === STILL_KIND) frame.removeAttribute(STILL_SETTLED_ATTR);
  // The box the mark was written on, not the one the frame holds now: a pane
  // whose content box was replaced mid-crossing left the property on the old
  // element, and the new one never carried it.
  const content = kind.held.get(frame)?.box ?? contentBoxOf(frame);
  if (kind === STILL_KIND) releaseWidth(frame, content);
  kind.held.delete(frame);
  if (content !== null) {
    for (const root of heldTargetsOf(content)) {
      root.style.removeProperty(kind.prop);
    }
  }
  if (kind === STILL_KIND) {
    frame.dispatchEvent(
      new CustomEvent<StillCrossingEventDetail>(STILL_CROSSING_END, {
        detail: { id: Number(stamp) },
        cancelable: false,
        bubbles: false,
      }),
    );
  }
  return Number(stamp);
}

/**
 * The height of `frame`'s content box right now, or `null` when it has none.
 *
 * Read by the imposer on both sides of the commit — First in the arm, Last in
 * the tween pass — so the held height is the open one in either direction.
 *
 * In CSS px, which is what the number is written to `STILL_HELD_HEIGHT_PROP`
 * in and what a page zoom leaves unchanged. This is the one read every hold
 * shares ([B07]), so a fold, a settle and a sash drag all hold at the same
 * box they measured.
 */
export function contentBoxHeight(frame: HTMLElement): number | null {
  const content = contentBoxOf(frame);
  if (content === null) return null;
  return content.getBoundingClientRect().height;
}

/** {@link contentBoxHeight}'s twin on the inline axis. */
export function contentBoxWidth(frame: HTMLElement): number | null {
  const content = contentBoxOf(frame);
  if (content === null) return null;
  return content.getBoundingClientRect().width;
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
