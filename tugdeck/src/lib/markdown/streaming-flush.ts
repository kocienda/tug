/**
 * streaming-flush — when a streaming markdown block reconciles.
 *
 * A streaming block coalesces its store's emissions onto one
 * `requestAnimationFrame` and reconciles with the store's current text when
 * it fires. That frame is a parse, a DOM rewrite and an annotation pass, and
 * with three or four sessions streaming it lands inside every frame a settle
 * is painting. So the frame checks the settle's motion gate first: while the
 * gate is closed it reconciles nothing and re-arms for the gate's release
 * instead, through the same queue the gate hands its held React tells to.
 * The release runs the deferred reconcile once, reading the store's text as
 * it stands then, so every delta that arrived during the motion lands in one
 * reconcile. Emissions that arrive while a reconcile is deferred schedule
 * nothing further.
 *
 * A block in a card's own page never meets that gate: the page's gate is
 * never held, so it streams through the shell's settles and nothing pops at
 * their release. The deferral is for a card rendered in the shell's page, and
 * the pop it leaves at the release is no longer a snap the animation doctrine
 * accepts (`tuglaws/animation-doctrine.md`, the set-up solves the end state).
 * Under reduced motion the gate never closes, and the flush is the plain rAF
 * coalescer it always was.
 *
 * A deferred reconcile cannot be taken back out of the gate's queue, so
 * `dispose` leaves it there as a no-op: a block unmounted mid-motion
 * reconciles nothing at the release.
 */

import { type GestureScope, gestureScope } from "@/lib/gesture-scope";

/** What a streaming block calls: on each emission, and at unmount. */
export interface StreamingFlush {
  /** An emission arrived: reconcile at the next frame, or at the gate's release. */
  request(): void;
  /** Cancel what is scheduled; a reconcile already deferred to the gate becomes a no-op. */
  dispose(): void;
}

/** The frame scheduler and the gate, injectable for tests. */
export interface StreamingFlushDeps {
  requestFrame: (cb: () => void) => number;
  cancelFrame: (id: number) => void;
  scope: Pick<GestureScope, "isMotionHeld" | "enqueue">;
}

const DEFAULT_DEPS: StreamingFlushDeps = {
  requestFrame: (cb) => requestAnimationFrame(cb),
  cancelFrame: (id) => cancelAnimationFrame(id),
  scope: gestureScope,
};

/** Coalesce `reconcile` onto one frame per burst, deferred past a closed motion gate. */
export function createStreamingFlush(
  reconcile: () => void,
  deps: StreamingFlushDeps = DEFAULT_DEPS,
): StreamingFlush {
  let frame: number | null = null;
  let deferred = false;
  let disposed = false;

  const onFrame = (): void => {
    frame = null;
    if (disposed) return;
    if (deps.scope.isMotionHeld()) {
      deferred = true;
      deps.scope.enqueue(() => {
        deferred = false;
        if (!disposed) reconcile();
      });
      return;
    }
    reconcile();
  };

  return {
    request(): void {
      if (disposed || frame !== null || deferred) return;
      frame = deps.requestFrame(onFrame);
    },
    dispose(): void {
      disposed = true;
      if (frame !== null) {
        deps.cancelFrame(frame);
        frame = null;
      }
    },
  };
}
