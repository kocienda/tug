/**
 * The motion registry — who says the deck is moving.
 *
 * The animation doctrine's [D7] is the event clock: a surface is told it is
 * live by the thing that made it live, and nothing asks
 * `document.getAnimations()` on a timer to find out. The registry is that
 * telling, reduced to a counter. A loop owner takes a hold when its loop
 * starts and drops it when the loop stops; the count's 0→1 and 1→0 edges are
 * the only two facts anybody downstream needs.
 *
 * The one consumer today is the render-cost probe ([P01], [P02]): it arms on
 * the rising edge and disarms on the falling one, so a deck with no motion
 * takes no sample, schedules no rendering update, and holds no timer. The
 * circuit breaker joins on the same edges.
 *
 * ## Why a count rather than a boolean
 *
 * Several glyphs breathe at once and they start and stop independently. A
 * boolean would have the last one to stop clearing a flag the others still
 * need, and the first one to start re-arming a probe that is already armed.
 * The count makes both idempotent, and the edge listeners fire exactly once
 * per transition rather than once per owner.
 *
 * ## The hold is a closure, and it is idempotent
 *
 * `acquireMotionHold` hands back the release rather than an id, because an id
 * is a thing a caller can lose, double-release, or release from the wrong
 * cleanup. A release called twice is a no-op, which is what lets the pulsing
 * dot — whose release runs from two places, the static-mode demotion and the
 * unmount cleanup — carry one closure without either path having to know
 * whether the other already ran.
 *
 * A caller that never releases is a bug the registry cannot see. The hook
 * below is the safe form wherever the owner is a component.
 *
 * @module lib/motion-guard/registry
 */

import * as React from "react";

type MotionEdgeListener = (holds: number) => void;

let holdCount = 0;
const edgeListeners = new Set<MotionEdgeListener>();

function fireEdge(): void {
  for (const listener of Array.from(edgeListeners)) {
    listener(holdCount);
  }
}

/**
 * Take a motion hold. The returned closure releases it, and is idempotent.
 *
 * The 0→1 edge fires every {@link onMotionEdge} listener; so does the 1→0
 * edge. Acquiring a second hold while one is out fires nothing.
 */
export function acquireMotionHold(): () => void {
  holdCount += 1;
  if (holdCount === 1) fireEdge();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holdCount -= 1;
    if (holdCount === 0) fireEdge();
  };
}

/** How many holds are out. Diagnostics and tests; nothing renders it. */
export function motionHolds(): number {
  return holdCount;
}

/**
 * Subscribe to the 0→1 and 1→0 edges. Returns an unsubscribe.
 *
 * The listener is called with the count after the transition, so `0` is the
 * falling edge and any positive number is the rising one.
 */
export function onMotionEdge(listener: MotionEdgeListener): () => void {
  edgeListeners.add(listener);
  return () => {
    edgeListeners.delete(listener);
  };
}

/**
 * Hold motion for as long as `active` is true.
 *
 * A layout effect rather than an effect ([L03]): the hold is a registration
 * the probe's arming depends on, and the loop it stands for starts in the same
 * commit. Running it after paint would leave the probe disarmed across the
 * first frames of exactly the motion it exists to measure.
 */
export function useMotionHold(active: boolean): void {
  React.useLayoutEffect(() => {
    if (!active) return;
    return acquireMotionHold();
  }, [active]);
}
