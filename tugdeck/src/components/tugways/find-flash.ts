/**
 * find-flash — the ONE landing-flash affordance every find surface draws.
 *
 * A one-shot accent ring over the active match's rect: an absolutely
 * positioned child of the surface's SCROLLER, placed in content coordinates
 * so it scrolls with the content, clips at the surface's edge, and can
 * never paint over chrome or detach from moving content. The transcript
 * highlighter and the Text card's document engine both place their rings
 * through here — one geometry, one lifetime, one animation
 * (`.tugx-find-flash-overlay` in `transcript-find.css`, [L14]
 * reduced-motion aware).
 *
 * @module components/tugways/find-flash
 */

import { pageZoomFactor } from "@/lib/page-zoom-store";

/** Flash lifetime (mirrors the code-view find-flash window). */
export const FIND_FLASH_MS = 640;

const FLASH_OVERLAY_CLASS = "tugx-find-flash-overlay";

/** A live flash the caller can retract early (a newer flash replaces it). */
export interface FindFlashHandle {
  remove(): void;
}

/**
 * Place the ring over `rect` — VIEWPORT coordinates of the active match —
 * inside `scroller` (which must be a positioning context; both consumers'
 * scrollers are `position: relative`). Skips entirely (returns `null`) when
 * the rect lies outside the scroller's visible box: a match that could not
 * be revealed must not ring over chrome. The ring self-removes after
 * {@link FIND_FLASH_MS}.
 */
export function placeFindFlash(
  scroller: HTMLElement,
  rect: { left: number; top: number; width: number; height: number },
): FindFlashHandle | null {
  if (typeof document === "undefined") return null;
  const scrollerRect = scroller.getBoundingClientRect();
  const rectBottom = rect.top + rect.height;
  const rectRight = rect.left + rect.width;
  if (
    rectBottom < scrollerRect.top ||
    rect.top > scrollerRect.bottom ||
    rectRight < scrollerRect.left ||
    rect.left > scrollerRect.right
  ) {
    return null;
  }
  const overlay = document.createElement("div");
  overlay.className = FLASH_OVERLAY_CLASS;
  // The visibility test above stays in viewport px; the ring's box is
  // written in the scroller's layout px, so the rect terms are divided by
  // the zoom before they meet `client*` and `scroll*`.
  const f = pageZoomFactor();
  overlay.style.left = `${
    (rect.left - scrollerRect.left) / f - scroller.clientLeft + scroller.scrollLeft
  }px`;
  overlay.style.top = `${
    (rect.top - scrollerRect.top) / f - scroller.clientTop + scroller.scrollTop
  }px`;
  overlay.style.width = `${rect.width / f}px`;
  overlay.style.height = `${rect.height / f}px`;
  scroller.appendChild(overlay);
  const timer = setTimeout(() => overlay.remove(), FIND_FLASH_MS);
  return {
    remove: () => {
      clearTimeout(timer);
      overlay.remove();
    },
  };
}
