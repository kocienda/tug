/**
 * width-rungs.ts — width-driven collapse that a page zoom cannot move.
 *
 * A surface that sheds parts as it narrows used to ask `@container
 * (max-width: …)`. Under WebKit's page zoom that query is answered against
 * the container's width multiplied by the zoom factor, not against its CSS-px
 * box: a slim card's status strip is 657 px at every zoom, yet at 90 % the
 * query saw ~592 and hid a cell the layout had room for ([F15] of
 * view-zoom-performance-and-feedback). The layout at every zoom must be the
 * layout at 100 %, zoomed ([B09]), so the question is asked here instead.
 *
 * A `ResizeObserver`'s `contentRect` is the content box in CSS px — the same
 * box `container-type: inline-size` measured, and unchanged by a page zoom —
 * and its delivery lands after layout and before paint, so the collapse is in
 * the first frame the width is, exactly as the container query's was. The
 * answer is written as a space-separated attribute on the container, and the
 * CSS keys its collapse rules on it with `~=` ([L06]: DOM, never React state).
 *
 * @module lib/width-rungs
 */

import { useCallback, useRef } from "react";

/** One collapse step: `name` applies at or under `maxWidth` CSS px. */
export interface WidthRung {
  readonly name: string;
  readonly maxWidth: number;
}

/** The attribute the rungs are written to. */
export const WIDTH_RUNGS_ATTRIBUTE = "data-width-rungs";

/**
 * The names of every rung `width` is at or under, space-separated in the
 * order given — the value the attribute takes. `max-width` semantics: a rung
 * applies at its own width. A width of 0 is a box with no layout (a hidden
 * card) and applies nothing, so the standing answer survives the spell.
 */
export function rungsAt(width: number, rungs: readonly WidthRung[]): string | null {
  if (!(width > 0)) return null;
  return rungs
    .filter((rung) => width <= rung.maxWidth)
    .map((rung) => rung.name)
    .join(" ");
}

/**
 * A ref callback that keeps `el`'s {@link WIDTH_RUNGS_ATTRIBUTE} in step with
 * its content-box width. `rungs` must be a stable (module-level) array.
 */
export function useWidthRungs(
  rungs: readonly WidthRung[],
): (el: HTMLElement | null) => void {
  const observerRef = useRef<ResizeObserver | null>(null);
  return useCallback(
    (el: HTMLElement | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (el === null || typeof ResizeObserver === "undefined") return;
      const observer = new ResizeObserver((entries) => {
        const entry = entries[entries.length - 1];
        if (entry === undefined) return;
        const next = rungsAt(entry.contentRect.width, rungs);
        if (next === null) return;
        if (next === "") {
          if (el.hasAttribute(WIDTH_RUNGS_ATTRIBUTE)) {
            el.removeAttribute(WIDTH_RUNGS_ATTRIBUTE);
          }
        } else if (el.getAttribute(WIDTH_RUNGS_ATTRIBUTE) !== next) {
          el.setAttribute(WIDTH_RUNGS_ATTRIBUTE, next);
        }
      });
      observer.observe(el);
      observerRef.current = observer;
    },
    [rungs],
  );
}
