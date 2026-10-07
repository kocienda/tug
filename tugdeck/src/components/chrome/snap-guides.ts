/**
 * snap-guides.ts — the Option-held snap guides a pane edge gesture draws, and
 * the canvas-relative rects they snap against. [D03]
 *
 * Shared by the pane's own move and resize gestures (`tug-pane.tsx`) and by
 * the rail width draft `DeckCanvas` owns (`rail-width-draft.ts`): the guides
 * are one look and one geometry whichever layer is moving the edge.
 *
 * @module components/chrome/snap-guides
 */

import type { GuidePosition, Rect } from "@/snap";
import { SHOWN_PANE_FRAMES } from "@/components/chrome/space-layer";

/**
 * Width of a snap guide line in layout px. Must match the `border` width on
 * `.snap-guide-line-x` / `.snap-guide-line-y` in chrome.css so a right/bottom-edge
 * guide can be pulled back by exactly one line width to sit on the card's edge.
 */
const SNAP_GUIDE_LINE_PX = 2;

/** Per-edge offset (layout px) from a card frame's measured box to its visible
 *  border. See measureGuideEdgeOffsets. */
export interface GuideEdgeOffsets {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const ZERO_EDGE_OFFSETS: GuideEdgeOffsets = { left: 0, right: 0, top: 0, bottom: 0 };

/** The guide elements one gesture has drawn, reused frame to frame. */
export interface GuideElements {
  current: HTMLElement[];
}

/**
 * Measure how far each visible card edge (the `.tug-pane-chrome` border box) sits
 * from the measured `.tug-pane` frame box that snap geometry uses.
 *
 * The chrome is `border-box` with `width/height: 100%` + a 1px border, so its
 * border box normally coincides with the frame box and the offsets are zero.
 * Reading the actual delta (rather than assuming a box model) keeps snap guides
 * landing on the visible border exactly, whatever the border/box-sizing turns
 * out to be. All cards share this geometry, so one measurement per gesture
 * suffices. Returned in layout px (÷ zoom).
 */
export function measureGuideEdgeOffsets(frame: HTMLElement, zoom = 1): GuideEdgeOffsets {
  const chrome = frame.querySelector(".tug-pane-chrome");
  if (!chrome) return ZERO_EDGE_OFFSETS;
  const f = frame.getBoundingClientRect();
  const c = chrome.getBoundingClientRect();
  return {
    left: (c.left - f.left) / zoom,
    right: (c.right - f.right) / zoom,
    top: (c.top - f.top) / zoom,
    bottom: (c.bottom - f.bottom) / zoom,
  };
}

/**
 * Snapshot all `.tug-pane[data-pane-id]` elements as canvas-relative Rects.
 * Optionally excludes a pane by ID.
 *
 * `getBoundingClientRect` returns visual (post-`body { zoom }`) pixels, but card
 * frames are positioned with `style.left/top` in layout pixels. Dividing by
 * `zoom` yields layout-space rects so they line up with the moving frame's
 * position and size (which come from layout-space `style`/`offsetWidth`). All
 * snap math then runs in one consistent space.
 */
export function snapshotCardRects(
  canvasBounds: DOMRect | null,
  excludeId?: string,
  zoom = 1,
): { id: string; rect: Rect }[] {
  const results: { id: string; rect: Rect }[] = [];
  // Every pane is a snap candidate — including a pinned rail. A free pane
  // dragged with Option snaps its edge to the rail's edge just as it does to
  // any other card, so a card can be abutted to it. A rail exposes the same
  // `getBoundingClientRect` as any pane, so its rect needs no special case.
  const els = document.querySelectorAll<HTMLElement>(
    SHOWN_PANE_FRAMES,
  );
  els.forEach((el) => {
    const paneId = el.getAttribute("data-pane-id");
    if (!paneId || paneId === excludeId) return;
    const domRect = el.getBoundingClientRect();
    results.push({
      id: paneId,
      rect: {
        x: (domRect.left - (canvasBounds ? canvasBounds.left : 0)) / zoom,
        y: (domRect.top - (canvasBounds ? canvasBounds.top : 0)) / zoom,
        width: domRect.width / zoom,
        height: domRect.height / zoom,
      },
    });
  });
  return results;
}

/**
 * Render snap guide DOM elements from a list of guide positions. [D03]
 * Creates or reuses <div> elements with .snap-guide-line CSS classes.
 * Appends to container; removes excess guide elements.
 */
export function syncGuideElements(
  guideRef: GuideElements,
  guides: GuidePosition[],
  container: HTMLElement,
  edgeOffsets: GuideEdgeOffsets,
): void {
  // Guide positions are in layout space (snapshotCardRects divides the visual
  // measurements by zoom). They reference the measured `.tug-pane` frame edge;
  // `edgeOffsets` carries the measured delta to the visible `.tug-pane-chrome`
  // border so the line lands on the edge the user actually sees. The visible
  // border occupies a 1px band: at a left/top edge it runs forward from the
  // border-box origin, so the line (a 1px border that paints forward) sits at
  // the origin; at a right/bottom edge the band ends at the exclusive border-box
  // edge, so the line is pulled back one line-width to cover the band.
  for (let i = 0; i < guides.length; i++) {
    const guide = guides[i];
    let el = guideRef.current[i];
    if (!el) {
      el = document.createElement("div");
      el.classList.add("snap-guide-line");
      container.appendChild(el);
      guideRef.current.push(el);
    }
    // Reset axis classes
    el.classList.remove("snap-guide-line-x", "snap-guide-line-y");
    if (guide.axis === "x") {
      el.classList.add("snap-guide-line-x");
      const left = guide.cardEdge === "right"
        ? guide.position + edgeOffsets.right - SNAP_GUIDE_LINE_PX
        : guide.position + edgeOffsets.left;
      el.style.left = `${left}px`;
      el.style.top = "";
    } else {
      el.classList.add("snap-guide-line-y");
      const top = guide.cardEdge === "bottom"
        ? guide.position + edgeOffsets.bottom - SNAP_GUIDE_LINE_PX
        : guide.position + edgeOffsets.top;
      el.style.top = `${top}px`;
      el.style.left = "";
    }
  }
  // Remove excess guide elements
  while (guideRef.current.length > guides.length) {
    const excess = guideRef.current.pop();
    if (excess && excess.parentNode) {
      excess.parentNode.removeChild(excess);
    }
  }
}

/**
 * Remove all snap guide elements from the DOM and clear tracking ref. [D03]
 */
export function clearGuideElements(guideRef: GuideElements): void {
  for (const el of guideRef.current) {
    if (el.parentNode) {
      el.parentNode.removeChild(el);
    }
  }
  guideRef.current = [];
}
