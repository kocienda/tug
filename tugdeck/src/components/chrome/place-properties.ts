/**
 * place-properties — the one door that writes a column's custom properties
 * onto the elements that read them.
 *
 * A slot's seams, offset and strip coordinates (`columnSeamProperty`,
 * `columnOffsetProperty`, `columnStripProperty` in `layout-imposer.ts`) used
 * to be written on the canvas and on every space layer, and inherited down to
 * the frames' `calc()`s. A changed custom property invalidates the computed
 * style of every descendant of the element it is written on, so a fold —
 * which moves one column's seams — re-resolved the style of the whole deck:
 * on an eight-card deck of real transcripts the first frame after the commit
 * paid a forced style resolve of 86–97 ms through the next geometry read
 * (`briefs/engine-time-in-the-motion-readings.md`). The flow offset was moved
 * off the ancestors for the same reason ([D204], `flow-offset.ts`); these
 * properties stay unregistered, because every reader supplies the geometry it
 * was rendered against as its `var()` fallback, and a registered property's
 * initial value would never let the fallback be reached.
 *
 * So each slot's properties are written on that slot's readers alone, and a
 * write that leaves a value standing invalidates nothing:
 *
 *   - under a layer, the imposed frames of that slot
 *     (`.tug-pane[data-imposed="<slot>"]`) — every layer carries its own
 *     deck's values, shown or not ([B02]);
 *   - under the canvas, that slot's column seams, which belong to the shown
 *     deck and stand directly under it, and the shown layer's frames of that
 *     slot, so a per-frame writer (a seam drag, a column autoscroll) moves
 *     both halves of what the eye sees in one call.
 *
 * A frame carries only its own slot's values, so a change to one column
 * invalidates that column's frames and nothing else. Every write is also kept
 * against its layer, because a seam's `var()` fallback is the EQUAL division
 * rather than the hand's: a frame that comes to stand in a slot without the
 * arrangement moving — mounted into a column, moved in from another slot —
 * adopts that slot's standing values in its own layout effect
 * ({@link adoptColumnProperties}) instead of falling back to a division
 * nobody chose.
 *
 * @module components/chrome/place-properties
 */

import { SPACE_LAYER_CLASS, SPACE_SHOWN_ATTRIBUTE } from "./space-layer";

/** A layer's readers of slot `slot`: its imposed frames standing there. */
function frameReadersOf(layer: ParentNode, slot: number): HTMLElement[] {
  return Array.from(
    layer.querySelectorAll<HTMLElement>(`.tug-pane[data-imposed="${slot}"]`),
  );
}

/**
 * Every element under `root` that reads slot `slot`'s properties: a layer's
 * frames, or, when `root` is the canvas, its own seams of that slot and the
 * shown layer's frames.
 */
export function columnReadersOf(
  root: Element,
  slot: number,
  canvas: boolean,
): HTMLElement[] {
  if (!canvas) return frameReadersOf(root, slot);
  const shown = root.querySelector(
    `.${SPACE_LAYER_CLASS}[${SPACE_SHOWN_ATTRIBUTE}]`,
  );
  return [
    ...Array.from(
      root.querySelectorAll<HTMLElement>(
        `:scope > .tug-place-seam[data-column-seam^="${slot}:"]`,
      ),
    ),
    ...(shown === null ? [] : frameReadersOf(shown, slot)),
  ];
}

/** Each layer's standing column values, by property name. */
const standing = new WeakMap<Element, Map<string, string>>();

/** The layer whose frames `root`'s writes reach: `root` itself, or the shown
 *  layer when `root` is the canvas. */
function layerOf(root: Element, canvas: boolean): Element | null {
  return canvas
    ? root.querySelector(`.${SPACE_LAYER_CLASS}[${SPACE_SHOWN_ATTRIBUTE}]`)
    : root;
}

/**
 * A slot's readers under `root`, resolved once, and a writer over them that
 * also keeps each value against the layer. `value === null` clears.
 */
export function columnWriter(
  root: Element,
  slot: number,
  canvas: boolean,
): (name: string, value: string | null) => void {
  const readers = columnReadersOf(root, slot, canvas);
  const layer = layerOf(root, canvas);
  let kept = layer === null ? undefined : standing.get(layer);
  if (layer !== null && kept === undefined) {
    kept = new Map();
    standing.set(layer, kept);
  }
  return (name, value) => {
    if (value === null) kept?.delete(name);
    else kept?.set(name, value);
    for (const el of readers) {
      if (value === null) el.style.removeProperty(name);
      else el.style.setProperty(name, value);
    }
  };
}

/**
 * Write slot `slot`'s standing values onto `frame`, which now stands there —
 * each one the frame does not already carry. Called from the frame's own
 * layout effect when its imposed slot changes.
 *
 * Only the missing ones, because a missing value is the whole case: a frame
 * new to the slot would fall back to the equal division. A frame that carries
 * the slot's values stood there before — back out of bullseye — and keeps
 * them, and an arrangement that moved while it was away is rewritten on it by
 * the layer's own write in the same commit, which runs after this effect.
 * Overwriting them here instead landed under the bullseye exit's land: a
 * forced layout and a list view's re-window in the hand-back frame
 * (`at0705-settle-bullseye.test.ts`, read with the window in front).
 */
export function adoptColumnProperties(frame: HTMLElement, slot: number): void {
  const layer = frame.closest(`.${SPACE_LAYER_CLASS}`);
  const kept = layer === null ? undefined : standing.get(layer);
  if (kept === undefined) return;
  const prefix = `--tug-slot-${slot}-`;
  for (const [name, value] of kept) {
    if (!name.startsWith(prefix)) continue;
    if (frame.style.getPropertyValue(name) !== "") continue;
    frame.style.setProperty(name, value);
  }
}

/**
 * Write one of slot `slot`'s properties onto everything the eye can see
 * reading it — the canvas's seams and the shown layer's frames. The door a
 * per-frame writer calls.
 */
export function writeCanvasColumnProperty(
  container: Element,
  slot: number,
  name: string,
  value: string | null,
): void {
  columnWriter(container, slot, true)(name, value);
}
