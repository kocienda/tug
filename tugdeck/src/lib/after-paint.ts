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
 */

/** The deadline behind the deferral: an occluded window never fires rAF. */
export const AFTER_PAINT_DEADLINE_MS = 50;

export function scheduleAfterPaint(fn: () => void): void {
  if (typeof requestAnimationFrame !== "function") {
    fn();
    return;
  }
  let done = false;
  const once = (): void => {
    if (done) return;
    done = true;
    fn();
  };
  requestAnimationFrame(() => {
    window.setTimeout(once, 0);
  });
  window.setTimeout(once, AFTER_PAINT_DEADLINE_MS);
}
