/**
 * press-travel.ts — where a press stops being a click.
 *
 * One number, in one place, because two components independently interpret the
 * same pointer stream and must not come to different answers about it. The
 * pane's drag machine (`components/chrome/tug-pane.tsx`) latches a drag when
 * the pointer travels this far; the deck's gesture interpreter
 * (`gesture-interpreter.ts`) decides on release whether the press was a click,
 * and therefore whether the deck reveals the card it activated. Those are the
 * same verdict about the same gesture, reached by two listeners on the same
 * `pointerup` — and until this module existed the threshold was typed twice,
 * with a comment in the second one acknowledging the first ([F06], [B04]).
 *
 * A leaf: it imports nothing, so either side can take it without a cycle.
 *
 * This is the whole of what the two share. Unifying the two press trackers
 * into one gesture engine is a larger change and is deliberately not this
 * module's business — see the brief's non-goals.
 */

/**
 * How far the pointer must travel before a press becomes a gesture — on a
 * pane's title bar (drag), on a resize handle, on a rail's deck-facing edge,
 * and in the interpreter's read of a release.
 *
 * Under this, the press is a click: it focuses the pane, reveals the card it
 * activated, and commits nothing. The distinction matters most for a pane
 * whose geometry is derived — a slotted card, or a pinned rail — because
 * committing a move or a resize is what releases it from the arrangement, and
 * that should take an actual drag.
 */
export const DRAG_MOVE_THRESHOLD_PX = 3;
