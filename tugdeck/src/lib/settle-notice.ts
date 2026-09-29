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
 * A listener resolves the container the way every other surface resolves it —
 * by identity, through `paneCanvasOf` — rather than by walking a fixed number
 * of levels up from a pane frame. A pane frame is not a direct child of the
 * container: a workspace wrapper stands between them, and a listener bound to
 * that wrapper never hears a non-bubbling dispatch made on the container. The
 * dispatch stays non-bubbling because both ends name the same element: there
 * is no ancestor that would want the notice, and a bubbling one would reach
 * the document for nobody's benefit.
 */

/** Dispatched on the canvas container when a settle ends. Not cancelable: the settle is already over. */
export const IMPOSER_SETTLE_END = "tug-imposer-settle-end";

/**
 * Dispatched on the canvas container the moment a settle ARMS — the opening
 * the {@link IMPOSER_SETTLE_END} notice closes. It fires from the store
 * subscriber, before React has rendered the commit it belongs to, so a
 * listener runs on the outgoing DOM: what it writes is in place for the
 * settle's first frame. Not cancelable; the settle is already armed.
 *
 * The first listener is the transcript list view's relevance pin: for the
 * settle's length each ready cell keeps the `content-visibility` the engine
 * had decided, written inline on the cell. That used to be a stylesheet rule
 * keyed on the container's `data-imposer-settling`, and a rule that restyles
 * descendants on an ancestor's attribute makes the engine walk every
 * descendant of that ancestor when the attribute toggles — 25ms each way on
 * a six-session deck, inside the gesture's own task and again at the land.
 */
export const IMPOSER_SETTLE_START = "tug-imposer-settle-start";

export function dispatchImposerSettleStart(container: HTMLElement): void {
  container.dispatchEvent(
    new CustomEvent(IMPOSER_SETTLE_START, {
      cancelable: false,
      bubbles: false,
    }),
  );
}

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
