/**
 * use-z2-seat-hold.ts — keep Z2's seat the height of the strip it seats.
 *
 * For the length of a still crossing Z2 leaves the flow and rides the clip's
 * closing edge (`session-card.css`, the crossing rule after the strip's base
 * rule). The seat is the in-flow box it leaves behind, the strip's previous
 * sibling: it holds the strip's height so nothing in the column re-flows when
 * the strip goes, and it is the anchor the strip's rest position is read from.
 *
 * CSS has no way to say "as tall as my sibling", so the strip's border-box
 * height is published on the seat as `--tugx-z2-seat-height`. A
 * `ResizeObserver` reports it in layout px, which the deck root's View › Zoom
 * transform never enters, and it delivers before paint, so a strip that
 * changes height is matched by its seat in the same frame. It is read only
 * under the crossing mark; at rest the seat is empty and zero-height.
 *
 * A callback ref on the strip rather than an effect, so the observer follows
 * the strip's own mount whenever that is. Appearance through the DOM, never
 * React state ([L06]).
 */

import { useCallback, useRef, type RefObject } from "react";

export function useZ2SeatHold(
  seatRef: RefObject<HTMLElement | null>,
): (strip: HTMLElement | null) => void {
  const observerRef = useRef<ResizeObserver | null>(null);
  return useCallback(
    (strip: HTMLElement | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      const seat = seatRef.current;
      if (strip === null || seat === null) {
        seat?.style.removeProperty("--tugx-z2-seat-height");
        return;
      }
      const observer = new ResizeObserver((entries) => {
        const box = entries[entries.length - 1].borderBoxSize?.[0];
        const height = box !== undefined ? box.blockSize : strip.offsetHeight;
        seat.style.setProperty("--tugx-z2-seat-height", `${height}px`);
      });
      observer.observe(strip, { box: "border-box" });
      observerRef.current = observer;
    },
    [seatRef],
  );
}
