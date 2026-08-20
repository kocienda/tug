/**
 * The drop-zone drag's one piece of visible feedback: an outline standing in
 * the zone the release would land in ([P09]).
 *
 * Imperative DOM from end to end — created on demand, moved by writing custom
 * properties, removed at the drop ([L06]). React never sees it, because it
 * changes on a pointer's clock rather than on a commit's, and routing a
 * per-frame appearance change through state is the thing [L06] exists to
 * forbid.
 *
 * One element, not one per zone: exactly one zone is indicated at any moment,
 * so a second element could only ever be a stale first one.
 */

import type { Rect } from "../snap";
import { ZONE_INDICATOR_INSET_PX } from "./drop-zones";

const INDICATOR_CLASS = "tug-drop-zone-indicator";

/**
 * Show the indicator at `rect` inside `canvas`, or take it away when `rect` is
 * null — the zone-less states being a ⌘-held drag ([P13]) and the end of the
 * gesture.
 *
 * The rect is in the canvas's own layout coordinates, the space every other
 * drag measurement is already in, so nothing here divides by zoom a second
 * time.
 */
export function indicateDropZone(
  canvas: HTMLElement | null,
  rect: Rect | null,
): void {
  if (canvas === null) return;
  const existing = canvas.querySelector<HTMLElement>(`.${INDICATOR_CLASS}`);
  if (rect === null) {
    existing?.remove();
    return;
  }
  const el = existing ?? document.createElement("div");
  if (existing === null) {
    el.classList.add(INDICATOR_CLASS);
    canvas.appendChild(el);
  }
  const inset = ZONE_INDICATOR_INSET_PX;
  el.style.left = `${rect.x + inset}px`;
  el.style.top = `${rect.y + inset}px`;
  el.style.width = `${Math.max(0, rect.width - inset * 2)}px`;
  el.style.height = `${Math.max(0, rect.height - inset * 2)}px`;
}
