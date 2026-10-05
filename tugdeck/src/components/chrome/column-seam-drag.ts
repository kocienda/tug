/**
 * column-seam-drag.ts — a split column's seam drag, reachable from the edges
 * of the members it divides.
 *
 * In a split column a member's height is its share of the run, so dragging
 * the member's inner top or bottom edge IS dragging the seam it borders: the
 * same bounds, the same cascade past a floor, the same pins while the hand
 * holds it, and the same commit through the column's shares. Rather than a
 * second gesture that agrees with the seam's by construction, the seam
 * registers its own drag here and the member's edge starts it.
 *
 * Keyed by slot and boundary: boundary `index` divides members `index` and
 * `index + 1`. Only the shown deck's columns mount seams, so one key names one
 * seam.
 */

/** Begin the seam's drag for a press already in progress. */
export type ColumnSeamDragStart = (pointerId: number, clientY: number) => void;

const starts = new Map<string, ColumnSeamDragStart>();

function keyOf(slot: number, index: number): string {
  return `${slot}:${index}`;
}

/**
 * Register the drag of column `slot`'s seam `index`. Returns the
 * unregistration, which removes the entry only if it is still this one — a
 * remount that registered first must not be undone by the unmount after it.
 */
export function registerColumnSeamDrag(
  slot: number,
  index: number,
  start: ColumnSeamDragStart,
): () => void {
  const key = keyOf(slot, index);
  starts.set(key, start);
  return () => {
    if (starts.get(key) === start) starts.delete(key);
  };
}

/**
 * Start column `slot`'s seam `index` dragging under the press `pointerId`.
 * `false` when no such seam is mounted, which leaves the press with nothing
 * to move — the honest answer for an edge whose seam is not there.
 */
export function startColumnSeamDrag(
  slot: number,
  index: number,
  pointerId: number,
  clientY: number,
): boolean {
  const start = starts.get(keyOf(slot, index));
  if (start === undefined) return false;
  start(pointerId, clientY);
  return true;
}
