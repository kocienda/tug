/**
 * canvas-deck-fields — the deck snapshot as the canvas reads it.
 *
 * `DeckCanvas` and the pane controllers it runs read every `DeckState` field
 * but one, through destructured locals, `deriveLayerArrangement`'s `deck.`
 * reads, the settle engine's `state.` reads and the selectors they import. So
 * their read cannot narrow to a fact; it can only drop the commits that move a
 * field none of them reads. That field is `hasFocus` — window focus and blur —
 * which only `isFocusDestination` reads, and no chrome module imports it.
 *
 * The list names what is EXCLUDED, not what is read. A field added to
 * `DeckState` later is compared by default, so forgetting the list costs one
 * render and can never serve the canvas a stale field.
 * `canvas-deck-fields.test.ts` pins that no listed field is read by the
 * canvas's modules.
 *
 * Kept beside the canvas, not in it, so the occlusion controller reads the
 * same equality without importing the canvas.
 *
 * @module components/chrome/canvas-deck-fields
 */

import type { DeckState } from "@/layout-tree";

/** The `DeckState` fields no canvas module reads. */
export const CANVAS_UNREAD_FIELDS: readonly (keyof DeckState)[] = ["hasFocus"];

const UNREAD: ReadonlySet<string> = new Set(CANVAS_UNREAD_FIELDS);

/**
 * Two snapshots are equal to the canvas when every own key of either, outside
 * `CANVAS_UNREAD_FIELDS`, is identical. A key present on one side only is a
 * difference.
 */
export function canvasDeckEqual(a: DeckState, b: DeckState): boolean {
  if (a === b) return true;
  const ra = a as unknown as Record<string, unknown>;
  const rb = b as unknown as Record<string, unknown>;
  for (const key of Object.keys(ra)) {
    if (UNREAD.has(key)) continue;
    if (!Object.prototype.hasOwnProperty.call(rb, key) || ra[key] !== rb[key]) return false;
  }
  for (const key of Object.keys(rb)) {
    if (UNREAD.has(key)) continue;
    if (!Object.prototype.hasOwnProperty.call(ra, key)) return false;
  }
  return true;
}

/** The canvas's derivation: the snapshot itself, narrowed by `canvasDeckEqual`. */
export function canvasDeck(snapshot: DeckState | null): DeckState {
  return snapshot as DeckState;
}
