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
 *
 * A member draws its chrome in its own page and presses its edge there, and
 * the host tracks the gesture and reports each step to the shell
 * (`host-card-gesture.ts`). There is no pointer in the shell to capture, so
 * the seam's drag is driven by those reports (`driveColumnSeam`): the same
 * latch, bounds, pins and commit as a press on the seam itself, fed the
 * pointer's height.
 */

/** A seam drag in progress, driven by the pointer's viewport `clientY`. */
export interface ColumnSeamGesture {
  move(clientY: number): void;
  /** The release: commits the division the hand left, if it travelled. */
  release(clientY: number): void;
  /** Taken away: commits nothing, and the members stand where the record says. */
  cancel(): void;
}

/**
 * Begin the seam's drag for a press already in progress: under `pointerId`,
 * whose events the seam then listens to, or, with `null`, driven through the
 * gesture it answers. `null` when the seam has no division to move.
 */
export type ColumnSeamDragStart = (pointerId: number | null, clientY: number) => ColumnSeamGesture | null;

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
 * Start column `slot`'s seam `index` dragging from a press at `clientY` that
 * the host tracks, answering the gesture its reports drive; `null` when no
 * such seam is mounted or it has nothing to move.
 */
export function driveColumnSeam(slot: number, index: number, clientY: number): ColumnSeamGesture | null {
  return starts.get(keyOf(slot, index))?.(null, clientY) ?? null;
}
