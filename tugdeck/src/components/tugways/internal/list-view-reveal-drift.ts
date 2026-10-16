/**
 * list-view-reveal-drift — has someone other than a declared writer moved
 * the scroller under a live `revealRange`?
 *
 * Internal building block of `TugListView`. The reveal stands down the
 * moment the user takes the scroller, and it has two signals for that:
 * `SmartScroll.isUserScrolling`, and drift of the live `scrollTop` from
 * the reveal's armed baseline. Drift is the only signal the event-silent
 * native scrollbar raises, so it cannot be dropped.
 *
 * But the reveal is not the only declared writer of the scroller. The
 * list view's own corrections (prepend compensation, attributed clamps)
 * and an embedded editor placing its own match inside the transcript
 * (`FileBlock`'s CM6 scroll handler) all write `scrollTop` and declare
 * it — through `SmartScroll`'s routed writes or `noteExternalWrite`,
 * which advance `programmaticWriteSeq` and record the position the write
 * left. A baseline armed before such a write and never moved off it
 * reads that write as drift: the reveal settles `cancelled:user-scroll`
 * over a match the write itself put in view, and nobody scrolled.
 *
 * So the baseline follows the declared writes. When the write count has
 * advanced since the baseline was armed, it is re-based onto the
 * position the latest write left — NOT onto the live position, so a user
 * movement after that write still reads as drift. An animated write
 * leaves no position (`null`); the baseline then stays where it was and
 * any movement still counts, which is the conservative outcome.
 *
 * Pure: no DOM, no React.
 */

/** The reveal's baseline: where it last knew the scroller, and as of which write. */
export interface RevealDriftBaseline {
  /** `scrollTop` as last armed, or `null` before the reveal has armed one. */
  armedTop: number | null;
  /** `SmartScroll.programmaticWriteSeq` when `armedTop` was armed. */
  armedWriteSeq: number;
}

export interface RevealDriftInput extends RevealDriftBaseline {
  /** The live `scrollTop`. */
  scrollTop: number;
  /** `SmartScroll.programmaticWriteSeq` now. */
  writeSeq: number;
  /** `SmartScroll.lastWriteTop` now. */
  lastWriteTop: number | null;
  /** `SmartScroll.isUserScrolling` now. */
  userScrolling: boolean;
  /** Movement within this many px is jitter, not a mover. */
  thresholdPx: number;
}

export interface RevealDriftVerdict extends RevealDriftBaseline {
  /** The user has taken the scroller: settle the reveal `cancelled`. */
  cancel: boolean;
}

/**
 * Re-base the baseline over any declared write since it was armed, then
 * judge the live position against it. The returned baseline is the one
 * the caller keeps.
 */
export function judgeRevealDrift(input: RevealDriftInput): RevealDriftVerdict {
  let { armedTop, armedWriteSeq } = input;
  if (armedTop !== null && input.writeSeq !== armedWriteSeq) {
    if (input.lastWriteTop !== null) armedTop = input.lastWriteTop;
    armedWriteSeq = input.writeSeq;
  }
  const drifted =
    armedTop !== null && Math.abs(input.scrollTop - armedTop) > input.thresholdPx;
  return { armedTop, armedWriteSeq, cancel: input.userScrolling || drifted };
}
