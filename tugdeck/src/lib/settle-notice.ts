/**
 * The settle's end — the one notice the deck sends when the imposer's
 * choreography is over and every frame is standing where it belongs.
 *
 * A settle is the imposer's spring, and its clock is that spring: a beat can
 * be retargeted mid-travel, a chain can gain a beat the pass before it did not
 * plan, and reduced motion ends the whole thing in one commit. Anything
 * outside the canvas that wants to act ON the settle's end therefore cannot
 * have a clock of its own — a timer would be a second copy of the imposer's,
 * and a copy that drifted is a surface that re-measures while the edge is
 * still travelling. So the end is an event, exactly as the fold crossing's is
 * (`lib/fold-crossing.ts`, [B03]).
 *
 * It is dispatched on the **container** rather than on each frame, because a
 * settle-end is one fact about the deck. Every sheet up on the canvas wants
 * the same notice at the same instant, and a per-frame dispatch would mean
 * per-pane bookkeeping on both ends for a fact neither end distinguishes. One
 * dispatch, one listener per sheet.
 *
 * This module is the one writer of it. `deck-canvas.tsx` calls
 * `dispatchImposerSettleEnd` at every point it takes `data-imposer-settling`
 * off, so "the settle is over" and "the notice went out" are one condition
 * rather than two that can disagree.
 *
 * The listener resolves the container as the pane frame's `parentElement`,
 * which is sound because every pane frame renders as a direct child of the
 * canvas container — the same resolution both of `tug-sheet.tsx`'s clamp
 * effects already make when they read the canvas box. The dispatch is
 * non-bubbling for that reason: there is no ancestor that would want it, and a
 * bubbling notice would reach the document for nobody's benefit.
 */

/** Dispatched on the canvas container when a settle ends. Not cancelable: the settle is already over. */
export const IMPOSER_SETTLE_END = "tug-imposer-settle-end";

/**
 * Announce that the settle on `container` has ended.
 *
 * Safe to call whether or not anything was listening, and safe to call more
 * than once for one settle: a listener's answer is a measure, and the clamp
 * measures this arms are idempotent — an extra one costs a layout read.
 */
export function dispatchImposerSettleEnd(container: HTMLElement): void {
  container.dispatchEvent(
    new CustomEvent(IMPOSER_SETTLE_END, {
      cancelable: false,
      bubbles: false,
    }),
  );
}
