/**
 * `focus-reveal` — bring a keyboard-focused element into view.
 *
 * The focus engine never lets the browser scroll: every DOM focus write it
 * issues passes `{ preventScroll: true }`, because scroll-position writes
 * belong to the owning surface / SmartScroll ([D07]). That leaves a hole the
 * surfaces were each patching by hand: a keyboard move that lands the key view
 * on a stop below the fold rings an element the user cannot see.
 *
 * This module closes it with one cooperative reveal, called by the engine when
 * a KEYBOARD key view changes ({@link FocusContext.setKeyView}). It is not a
 * `scrollIntoView`: that reasons about one scrollport's geometry, fights the
 * transcript's follow-bottom pin, and happily parks its target under a stuck
 * sticky header. Instead {@link revealFocusTarget}:
 *
 *  - walks every scrollable ancestor from the target outward, innermost first,
 *    re-measuring after each write (an outer scroll moves the target);
 *  - scrolls each by the MINIMUM delta that brings the target inside — so an
 *    already-visible target costs nothing and no write is ever gratuitous;
 *  - insets the scrollport by any sticky chrome parked over its edges, so the
 *    target lands BELOW a stuck header rather than under it;
 *  - leaves {@link RING_GAP_PX} of air on the leading edge, because the focus
 *    ring paints outside the border box (`--tugx-focus-ring-offset` +
 *    `--tugx-focus-ring-width`, `focus-ring.css`) and a flush landing clips it;
 *  - releases follow-bottom on any scroller that registered a
 *    {@link Scroller} façade before writing, so SmartScroll's next pin does not
 *    yank the reveal back to the live edge.
 *
 * Laws:
 *  - [L06] a scroll write is appearance: DOM only, no React state crossed.
 *  - [D07] the engine still issues no focus-driven browser scroll; this is an
 *    explicit, surface-cooperative reveal that routes through the registered
 *    `SmartScroll` façade rather than around it.
 *
 * @module components/tugways/focus-reveal
 */

import { scrollerForElement } from "./internal/scroller-context";
import { smartScrollForElement } from "@/lib/smart-scroll";

/**
 * Air left between the revealed target's leading edge and the scrollport (or a
 * stuck header) — the focus ring's halo plus a couple of pixels, so the ring is
 * never clipped by the edge it was just scrolled past.
 */
const RING_GAP_PX = 6;

/** Deltas under this are layout noise, not a reveal. */
const EPSILON_PX = 1;

/**
 * Scroll `el` into view in every scrollable ancestor, minimally.
 *
 * Self-gating: an element already fully visible in each of its scrollports
 * produces no writes at all, so callers may invoke it unconditionally on every
 * keyboard focus move.
 */
export function revealFocusTarget(el: HTMLElement): void {
  if (typeof window === "undefined") return;
  if (!el.isConnected) return;
  for (let node = el.parentElement; node !== null; node = node.parentElement) {
    if (!isScrollable(node)) continue;
    revealWithin(node, el);
  }
}

/** Whether `node` can scroll its overflow on either axis. */
function isScrollable(node: HTMLElement): boolean {
  const style = window.getComputedStyle(node);
  const canScrollY =
    (style.overflowY === "auto" || style.overflowY === "scroll") &&
    node.scrollHeight > node.clientHeight;
  const canScrollX =
    (style.overflowX === "auto" || style.overflowX === "scroll") &&
    node.scrollWidth > node.clientWidth;
  return canScrollY || canScrollX;
}

/** Scroll one scrollport by the minimum delta that reveals `target`. */
function revealWithin(scroller: HTMLElement, target: HTMLElement): void {
  const port = scroller.getBoundingClientRect();
  // `clientTop` / `clientLeft` are the border widths: the scrollport's content
  // box starts inside them, and `clientHeight` / `clientWidth` already exclude
  // both the borders and any classic scrollbar gutter.
  const portTop = port.top + scroller.clientTop;
  const portBottom = portTop + scroller.clientHeight;
  const portLeft = port.left + scroller.clientLeft;
  const portRight = portLeft + scroller.clientWidth;

  const rect = target.getBoundingClientRect();
  const band = stickyBand(scroller, target, portTop, portBottom);
  const deltaY = revealDelta(
    rect.top,
    rect.bottom,
    band.top + RING_GAP_PX,
    band.bottom - RING_GAP_PX,
  );
  const deltaX = revealDelta(rect.left, rect.right, portLeft, portRight);

  if (Math.abs(deltaY) >= EPSILON_PX || Math.abs(deltaX) >= EPSILON_PX) {
    // Cooperative: a scroller following its live edge would re-pin over this
    // write on its next growth tick, so release the follow first.
    scrollerForElement(scroller)?.disengage("focus-reveal");
  }
  if (Math.abs(deltaY) >= EPSILON_PX) {
    scroller.scrollTop += deltaY;
    // Declare the raw write. Disengaging follow-bottom above is
    // invisible to the list view's displacement bracket, which reasons
    // about position rather than intent: a commit landing between this
    // write and its (deferred) scroll event would find the scroller
    // somewhere no baseline explains and read a deliberate reveal as a
    // browser clamp.
    smartScrollForElement(scroller)?.noteExternalWrite();
  }
  if (Math.abs(deltaX) >= EPSILON_PX) scroller.scrollLeft += deltaX;
}

/**
 * The signed scroll delta that brings `[start, end]` inside `[low, high]`,
 * or `0` when it already is.
 *
 * A target TALLER than the band can never be brought inside, so the question
 * is only whether the user can see any of it. If it already overlaps the band
 * the answer is yes and the reveal is a no-op: a thing part of which is on
 * screen needs no scroll, and aligning it to `low` would move the page under
 * the reader to satisfy a geometry nothing was asking about. That is what a
 * roving list's container is — always taller than its port once it overflows
 * — and aligning it parked the list's top at the port on every reveal.
 *
 * A taller-than-band target that is wholly outside the band is still brought
 * in by its LEADING edge rather than centered: the leading edge is the one the
 * user reads from, and it is where the ring lives.
 */
function revealDelta(
  start: number,
  end: number,
  low: number,
  high: number,
): number {
  if (end - start > high - low && start < high && end > low) return 0;
  if (start < low) return start - low;
  if (end > high) return Math.min(end - high, start - low);
  return 0;
}

/**
 * The band of `scroller` that is actually free to show content — the port
 * inset by whatever sticky chrome is parked over its edges.
 *
 * Only the target's own ancestor chain is examined (and only each ancestor's
 * direct children), which is both bounded and sufficient: chrome that can
 * cover the target is by construction pinned by a box the target sits inside —
 * the transcript entry's `__pin` rail and the block's `.tool-call-header` over
 * their respective ancestors. Stacked chrome accumulates, so the lowest header
 * bottom (and the highest footer top) wins.
 *
 * A sticky element counts as chrome over an edge when it sits in that half of
 * the port and precedes / follows the target in document order — the same test
 * whether it is currently pinned or merely near the edge it pins to. Treating a
 * not-yet-pinned header as chrome costs a few pixels of extra scroll; missing a
 * pinned one leaves the target under it, invisible.
 */
function stickyBand(
  scroller: HTMLElement,
  target: HTMLElement,
  portTop: number,
  portBottom: number,
): { top: number; bottom: number } {
  const middle = (portTop + portBottom) / 2;
  const band = { top: portTop, bottom: portBottom };
  for (
    let node = target.parentElement;
    node !== null && node !== scroller;
    node = node.parentElement
  ) {
    for (const child of node.children) {
      if (!(child instanceof HTMLElement)) continue;
      if (child === target || child.contains(target)) continue;
      if (window.getComputedStyle(child).position !== "sticky") continue;
      const r = child.getBoundingClientRect();
      const where = child.compareDocumentPosition(target);
      const beforeTarget = (where & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      if (beforeTarget) {
        if (r.bottom > band.top && r.top < middle) band.top = r.bottom;
      } else {
        if (r.top < band.bottom && r.bottom > middle) band.bottom = r.top;
      }
    }
  }
  return band;
}
