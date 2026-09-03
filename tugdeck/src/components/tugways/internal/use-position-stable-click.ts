/**
 * `usePositionStableClick` — preserve a click target's screen position
 * across state-driven layout changes that *do not change the document's
 * total height*.
 *
 * **Scope.** This hook handles cases where the click triggers a
 * layout reflow around the target but the scrollport's `scrollHeight`
 * is unchanged (or grows). Examples: a Find toggle that mounts a
 * find row, a view-mode swap that changes hunk grid layout, an icon
 * swap. The hook compensates by adjusting `scrollTop` so the
 * target's screen position is restored.
 *
 * **This hook does NOT handle collapsing fold cues.** When a fold cue
 * collapses a body, the document's `scrollHeight` shrinks. If the
 * user has scrolled past where the new `maxScrollTop` would be, the
 * browser clamps `scrollTop` — and no `scrollTop` write can move the
 * target back to its pre-click viewport Y, because the position we'd
 * need is past the end of the now-shorter document. The accepted
 * outcome is the natural browser clamp: the document is honestly
 * shorter, the viewport lands at the new bottom, the user re-scrolls
 * if they want to read what's still above. An earlier Phase E.3
 * experiment added a persistent ~80cqh tail spacer to absorb the
 * shrinkage (raising `maxScrollTop` enough that common-sized
 * collapses didn't clamp) but the spacer was always-visible empty
 * space in every transcript — a constant cost paid for a rare
 * benefit. The spacer was retired (Step 20.3.5 of
 * `arc/session-assistant-turns.md`) and the natural clamp is the
 * current contract.
 *
 * The fix is purely imperative and lives entirely on the call-stack
 * of the click handler:
 *
 *   1. **Snapshot.** Read `target.getBoundingClientRect()` BEFORE the
 *      state mutation runs.
 *   2. **Flush.** Run the mutator inside `flushSync` so all React
 *      state updates the mutator triggers commit synchronously — by
 *      the time `flushSync` returns, the DOM is at its post-mutation
 *      layout.
 *   3. **Simple-delta compensation.** Measure the target's new
 *      viewport Y. If it shifted, write
 *      `scrollportRef.current.scrollTop += newTop - oldTop`. For
 *      buttons not inside a sticky ancestor (or sticky containers
 *      whose pin regime doesn't change), this fully restores the
 *      pre-click visual position.
 *   4. **Sticky-aware re-compensation.** Re-measure. If the button
 *      is STILL off by more than a tolerance, walk up to find the
 *      nearest `position: sticky` ancestor and compute the exact
 *      scrollTop that places it back at its pre-click viewport Y via
 *      the sticky positioning formula:
 *        - Natural regime (desired sticky Y > sticky top offset):
 *            scrollTop = sticky.docY - desiredStickyY
 *        - Clamped regime (desired sticky Y < sticky top offset):
 *            scrollTop = stickyParent.docBottom − desiredStickyY −
 *                        stickyHeight
 *      The target's offset within the sticky ancestor is invariant
 *      across scrollTop changes (it's a child of sticky), so placing
 *      sticky at the desired Y places the target back at the
 *      snapshot Y.
 *
 * Tuglaws conformance — read these before reaching for an alternative:
 *
 *  - **[L04]** No parent-triggered child setState pattern crossed by
 *    a measurement. The hook lives in the same component that owns
 *    the state being mutated; the synchronous `flushSync` boundary
 *    guarantees the DOM is at its post-mutation layout before the
 *    measurement runs. No "stale child DOM" timing hazard.
 *  - **[L05]** NO `requestAnimationFrame` anywhere. The compensation
 *    runs on the click event's call-stack, synchronously, before
 *    paint. rAF timing is not involved.
 *  - **[L06]** Appearance state flows through DOM, not React. The
 *    rect snapshot is a local const inside the click handler. The
 *    scroll compensation is a direct `scrollTop` write. There is NO
 *    React state inside this hook — no generation counter, no flag
 *    state, no useState anywhere. The pre-Phase-E.3-refactor version
 *    used a `useState` generation counter to trigger a
 *    `useLayoutEffect` between render and paint; that pattern routed
 *    appearance compensation through React's render cycle, violating
 *    L06 in spirit even though the counter was never rendered.
 *  - **[L07]** Live ref reads inside the click handler — no closures
 *    over stale state.
 *  - **[L23]** Preserves a stronger user-visible invariant ("click
 *    point stays under cursor") at the cost of a weaker one ("numeric
 *    scrollTop is preserved by the browser"). The user-visible thing
 *    is what the user sees and where they are pointing; numeric scroll
 *    offset is an implementation detail that serves that surface.
 *  - **[L24]** Local const for the snapshot. Direct DOM write for the
 *    adjustment. No structural state. Zone boundaries respected.
 *
 * @module components/tugways/internal/use-position-stable-click
 */

import React from "react";
import { flushSync } from "react-dom";

export interface UsePositionStableClickOptions {
  /**
   * Ref to the click-target DOM element — usually the button the user
   * pressed. The hook reads its bounding rect to compute the
   * pre/post-state delta.
   */
  targetRef: React.RefObject<HTMLElement | null>;

  /**
   * Ref to the outer scrollport whose `scrollTop` will be adjusted.
   * Pass `useOuterScrollport()`'s return value wrapped in a ref. The
   * hook degrades to "run the mutator, no compensation" when this
   * ref is null at click time (standalone composition).
   */
  scrollportRef: React.RefObject<HTMLElement | null>;
}

/**
 * Tolerance (px) below which we consider the button "back at" the
 * snapshot position and stop compensating. Absorbs subpixel rounding
 * without leaving a visible gap.
 */
const POSITION_TOLERANCE_PX = 0.5;

/**
 * Walk up the ancestor chain from `el`, returning the nearest element
 * (inclusive of `el` itself) whose computed `position` is `sticky`,
 * or `null` if none found before reaching the document root.
 */
function findStickyAncestor(el: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = el;
  while (node !== null) {
    const style = window.getComputedStyle(node);
    if (style.position === "sticky") return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * Parse the sticky element's `top` offset (e.g. "36px") into a
 * number. Defaults to 0 if `top` is `auto` or unparseable.
 */
function parseStickyTopOffset(stickyEl: HTMLElement): number {
  const style = window.getComputedStyle(stickyEl);
  const topStr = style.top;
  if (topStr === "" || topStr === "auto") return 0;
  const n = parseFloat(topStr);
  return Number.isFinite(n) ? n : 0;
}

export interface UsePositionStableClickResult {
  /**
   * Click wrapper: invoke from an onClick handler, passing the state
   * mutator that would otherwise run directly. The wrapper performs
   * the full snapshot → flushSync → measure → adjust sequence
   * synchronously on the click's call-stack, so the corrected scroll
   * position lands before the next paint.
   *
   * Calling with no target (ref unset) silently runs the mutator
   * without compensation. Calling with no scrollport (provider not
   * above) runs the mutator inside flushSync but skips the scroll
   * adjustment.
   */
  stableClick: (mutator: () => void) => void;
}

export function usePositionStableClick(
  options: UsePositionStableClickOptions,
): UsePositionStableClickResult {
  const { targetRef, scrollportRef } = options;

  const stableClick = React.useCallback(
    (mutator: () => void): void => {
      const target = targetRef.current;
      if (target === null) {
        // No measurable target — run the mutator and degrade gracefully.
        mutator();
        return;
      }

      // Snapshot the target's current viewport Y. Local const, never
      // routed through React state.
      const oldTop = target.getBoundingClientRect().top;

      // Force the mutator's state updates to commit synchronously so
      // the DOM is at the post-mutation layout before we measure
      // again. Without this, React batches the updates and commits
      // asynchronously after the click handler returns — the
      // measurement below would still reflect the pre-mutation
      // layout and the compensation would be a no-op.
      flushSync(() => {
        mutator();
      });

      const scrollport = scrollportRef.current;
      if (scrollport === null) return;

      // ---- Pass 1: simple-delta compensation -------------------------
      //
      // For targets not inside a sticky ancestor, or where the
      // sticky regime is unchanged across pre/post, this single
      // pass suffices.
      let newRect = target.getBoundingClientRect();
      let delta = newRect.top - oldTop;
      if (Math.abs(delta) < POSITION_TOLERANCE_PX) return;
      scrollport.scrollTop += delta;

      // ---- Pass 2: sticky-aware re-compensation ----------------------
      //
      // Re-measure after the delta write. If the button is still
      // off, the simple delta couldn't move it — almost always
      // because the target sits inside a sticky element whose pin
      // regime is decoupled from scrollTop. Compute the exact
      // scrollTop that places the sticky ancestor back at its
      // pre-click viewport Y via the sticky positioning formula.
      newRect = target.getBoundingClientRect();
      delta = newRect.top - oldTop;
      if (Math.abs(delta) < POSITION_TOLERANCE_PX) return;

      const sticky = findStickyAncestor(target);
      if (sticky === null) return;
      const stickyParent = sticky.parentElement;
      if (stickyParent === null) return;

      // Constant offset between target and sticky ancestor — the
      // target sits inside sticky (or AS sticky, when offset is 0).
      const stickyRect = sticky.getBoundingClientRect();
      const targetOffsetWithinSticky = newRect.top - stickyRect.top;

      // Desired sticky position: where would sticky be if the target
      // were back at oldTop?
      const desiredStickyY = oldTop - targetOffsetWithinSticky;

      const stickyTopOffset = parseStickyTopOffset(sticky);
      const stickyHeight = stickyRect.height;
      const currentScrollTop = scrollport.scrollTop;

      let newScrollTop: number;
      if (desiredStickyY > stickyTopOffset) {
        // NATURAL regime — sticky scrolls with its container, hasn't
        // engaged the pin yet. Sticky's viewport_Y = sticky.docY −
        // scrollTop. Solve for scrollTop.
        const stickyDocY = stickyRect.top + currentScrollTop;
        newScrollTop = stickyDocY - desiredStickyY;
      } else {
        // CLAMPED regime — sticky has run out of container room and
        // sits at (parent.bottom_viewport − sticky.height). Solve
        // for scrollTop that yields the desired sticky viewport_Y.
        // (The pinned regime is handled by the simple-delta pass:
        // if pre and post are both pinned, delta is zero. If we
        // reach this branch, the desired regime is clamped.)
        const stickyParentRect = stickyParent.getBoundingClientRect();
        const stickyParentDocBottom =
          stickyParentRect.bottom + currentScrollTop;
        newScrollTop =
          stickyParentDocBottom - desiredStickyY - stickyHeight;
      }

      // Clamp to the scrollport's actual scroll range. The browser
      // clamps anyway; the explicit clamp lets us avoid setting a
      // negative scrollTop or beyond the scrollable max.
      const maxScrollTop =
        scrollport.scrollHeight - scrollport.clientHeight;
      scrollport.scrollTop = Math.max(
        0,
        Math.min(newScrollTop, maxScrollTop),
      );
    },
    [targetRef, scrollportRef],
  );

  return { stableClick };
}
