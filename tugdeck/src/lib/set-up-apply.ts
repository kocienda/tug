/**
 * The set-up's apply list — where a write that wants the settle's post-commit
 * geometry waits while a settle is in its set-up.
 *
 * A settle's set-up runs from its `arm`, in the store's notify, to the Last
 * pass, the commit's layout effect that plans the motion. The Last pass is
 * read then written: every geometry read the set-up needs is taken in one
 * read phase against the layout the commit produced, and every write follows
 * it. A reader that runs anywhere else in that span — a focus reveal on the
 * notify, a restore heartbeat in a child's layout effect — reads over writes
 * the commit or a sibling just made, and pays a whole-document layout of its
 * own. So while the set-up is pending such a reader is queued here instead,
 * and runs in the Last pass's apply phase, after the read phase, where its
 * layout is the one the pass already pays for.
 *
 * Pending is the set-up's span, not the motion gate's: the gate closes at the
 * END of the Last pass, so a reader asking `gestureScope.isMotionHeld()` in
 * the set-up hears no. Outside a set-up {@link deferToSetUp} declines and the
 * caller runs as it always did.
 *
 * One request per key: a second request under the same key replaces the
 * first, because each of these is "bring this thing up to date", and only the
 * latest one means anything when it runs.
 *
 * A set-up that never reaches its Last pass — an arm whose commit changed
 * nothing the engine carries — is ended three paints later by a backstop, so
 * nothing queued here can wait past the frames it was for.
 */

import { scheduleAfterPaint, type CancelAfterPaint } from "@/lib/after-paint";

let pending = false;
let queue = new Map<unknown, () => void>();
let cancelBackstop: CancelAfterPaint | null = null;

/** Open the set-up: from here to {@link endSetUp}, {@link deferToSetUp} queues. Idempotent. */
export function beginSetUp(): void {
  pending = true;
  cancelBackstop?.();
  cancelBackstop = scheduleAfterPaint(() => {
    cancelBackstop = scheduleAfterPaint(() => {
      cancelBackstop = scheduleAfterPaint(() => {
        cancelBackstop = null;
        endSetUp();
      });
    });
  });
}

/** Whether a settle's set-up is pending — armed, its Last pass not yet run. */
export function isSetUpPending(): boolean {
  return pending;
}

/**
 * Queue `fn` for the set-up's apply phase under `key`, and return `true`; or,
 * outside a set-up, queue nothing and return `false`, and the caller runs it
 * now. A later request under the same key replaces an earlier one.
 */
export function deferToSetUp(key: unknown, fn: () => void): boolean {
  if (!pending) return false;
  queue.delete(key);
  queue.set(key, fn);
  return true;
}

/**
 * Close the set-up and run what it queued, in the order it was asked for.
 *
 * `applyFirst` runs between the two, with the set-up already closed, so what
 * it calls runs at once rather than queuing behind itself: the Last pass's own
 * apply — each settled interior paying its pin and its restore — goes there,
 * ahead of the readers that waited on it.
 */
export function endSetUp(applyFirst?: () => void): void {
  pending = false;
  cancelBackstop?.();
  cancelBackstop = null;
  const due = [...queue.values()];
  queue = new Map();
  try {
    applyFirst?.();
  } finally {
    for (const fn of due) {
      try {
        fn();
      } catch (err) {
        console.error("set-up apply", err);
      }
    }
  }
}
