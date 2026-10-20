/**
 * The placard's height guard: how far a placard may grow off its anchor
 * before it reaches the edge it grows toward. The component (`TugPlacard`)
 * and the overlay's drawn surface (`overlay/overlay-surface-drawer.ts`) both
 * write it, so it lives in `lib`, and `components/tugways/tug-placard.tsx`
 * re-exports it.
 *
 * @module lib/placard-available-height
 */

import { layoutPxOf, layoutRectOf } from "./page-zoom-store";

/** Inset (px) kept short of the edge the guard measures toward. */
const AVAILABLE_EDGE_INSET = 8;

/**
 * Write `--radix-popover-content-available-height` onto the placard from the
 * gap between its anchored edge and the edge it grows toward, so a composed
 * `TugPopupList` scroller never overflows ([R01]). The anchored edge is the one
 * the caller's CSS pins (`bottom:` upward, `top:` downward), so this value is
 * stable across height changes and cannot feed a layout loop.
 */
export function applyAvailableHeight(
  panel: HTMLDivElement,
  growth: "up" | "down",
  boundEl: HTMLElement | null | undefined,
): void {
  applyAvailableHeightWithin(panel, growth, boundEl == null ? null : layoutRectOf(boundEl));
}

/**
 * {@link applyAvailableHeight} against a bound already measured, in layout
 * px — the overlay's case, which is told where the canvas stands rather than
 * holding it.
 */
export function applyAvailableHeightWithin(
  panel: HTMLDivElement,
  growth: "up" | "down",
  bound: { top: number; bottom: number } | null,
): void {
  // Layout px throughout: the value is a CSS length, and the window and the
  // rects are divided by the zoom to meet it.
  const box = layoutRectOf(panel);
  const windowBottom = layoutPxOf(window.innerHeight);
  // The bound's edge in the growth direction — but never past the window,
  // which the bound (a canvas taller than the window, scrolled) can be.
  const floor = bound === null ? windowBottom : Math.min(bound.bottom, windowBottom);
  const ceiling = bound === null ? 0 : Math.max(bound.top, 0);
  const available =
    growth === "down"
      ? Math.max(0, floor - box.top - AVAILABLE_EDGE_INSET)
      : Math.max(0, box.bottom - ceiling - AVAILABLE_EDGE_INSET);
  panel.style.setProperty(
    "--radix-popover-content-available-height",
    `${available}px`,
  );
}
