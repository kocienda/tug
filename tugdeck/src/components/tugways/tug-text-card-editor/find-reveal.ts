/**
 * find-reveal — how far a find landing may move the Text card's view.
 *
 * A typed query lands on the first match at or after the reader's anchor,
 * and the anchor is the first line the reader can see — so on a file where
 * most lines match, the landing is the scrollport's top line, which is
 * usually clipped by a fraction of a line. Calling that line "off screen"
 * and centring it ran the view half a viewport ABOVE the reader on the
 * first keystroke (215 px on a 620 px card), which reads exactly like the
 * view losing its place.
 *
 * So the landing has three answers, decided from the match's rect against
 * the scrollport's:
 *
 *  - **`"none"`** — the match is wholly inside the scrollport. Select it
 *    and leave the page alone.
 *  - **`"nearest"`** — the match is partly inside: clipped at the top or
 *    bottom edge, or vertically visible but panned out sideways. The reader
 *    is already looking at it, so the view moves only as far as showing it
 *    whole takes — a fraction of a line, or a horizontal pan.
 *  - **`"center"`** — no part of it is on screen. That is a genuine jump,
 *    and it lands where `findNext`/`findPrevious` land: the vertical centre.
 *
 * @module components/tugways/tug-text-card-editor/find-reveal
 */

/** A rect in one coordinate space — the viewport's, for both arguments. */
export interface FindRevealRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export type FindReveal = "none" | "nearest" | "center";

/**
 * The reveal a find landing at `match` needs inside `port`. A `null` match
 * (CM6 could not place the position — it is outside the rendered viewport)
 * is off screen by definition.
 */
export function findRevealFor(
  match: FindRevealRect | null,
  port: FindRevealRect,
): FindReveal {
  if (match === null) return "center";
  const fullyInY = match.top >= port.top && match.bottom <= port.bottom;
  const fullyInX = match.left >= port.left && match.right <= port.right;
  if (fullyInY && fullyInX) return "none";
  // Strict on both edges: a rect that only touches the scrollport's edge
  // shows the reader nothing of the match.
  const overlapsY = match.bottom > port.top && match.top < port.bottom;
  return overlapsY ? "nearest" : "center";
}
