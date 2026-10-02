/**
 * after-paint — run a callback on the task after the next painted frame.
 *
 * The one door for work that must LEAVE the gesture's task: a WAAPI tween
 * created in a task is play-pending until that task's rendering update, so
 * anything heavy that runs before the task ends (a React commit, a menu-state
 * projection) lands in the tween's first frame. rAF runs before that frame's
 * rendering update, and a zero timer queued inside it runs after, so the
 * callback lands on the far side of one paint. A deadline timer stands behind
 * it for a window whose rAF is suspended ([L32]).
 *
 * Without `requestAnimationFrame` (a unit test, a worker) the callback runs
 * synchronously: there is no frame to land beyond.
 *
 * The door returns its release ([L27]): the cancel clears the frame callback
 * and both timers, and the caller calls it on teardown. Whichever path fires
 * first releases the other, so a deadline that wins in an occluded window
 * leaves no frame callback queued behind it to drain as a burst on unocclusion.
 */

/** The deadline behind the deferral: an occluded window never fires rAF. */
export const AFTER_PAINT_DEADLINE_MS = 50;

/** Releases a scheduled after-paint callback; idempotent, and safe after it ran. */
export type CancelAfterPaint = () => void;

const NOOP_CANCEL: CancelAfterPaint = () => {};

export function scheduleAfterPaint(fn: () => void): CancelAfterPaint {
  if (typeof requestAnimationFrame !== "function") {
    fn();
    return NOOP_CANCEL;
  }
  let frame: number | null = null;
  let paintTimer: number | null = null;
  let deadlineTimer: number | null = null;
  const release = (): void => {
    if (frame !== null) cancelAnimationFrame(frame);
    if (paintTimer !== null) window.clearTimeout(paintTimer);
    if (deadlineTimer !== null) window.clearTimeout(deadlineTimer);
    frame = paintTimer = deadlineTimer = null;
  };
  const once = (): void => {
    release();
    fn();
  };
  frame = requestAnimationFrame(() => {
    frame = null;
    paintTimer = window.setTimeout(once, 0);
  });
  deadlineTimer = window.setTimeout(once, AFTER_PAINT_DEADLINE_MS);
  return release;
}
