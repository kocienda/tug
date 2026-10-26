/**
 * owed-reflow.ts — the reflows a page's list views owe after a width change,
 * where a crossing solve can see them.
 *
 * A list view answers a change of its scroller's width late, on purpose: it
 * waits out a debounce so a drag's every tick is one reflow, then marks its
 * measured heights stale and drains them, a capped segment per commit,
 * holding the reader in place as they land (`tug-list-view.tsx`). A crossing
 * solve (`body/crossing-solve.ts`) must not call the page laid out while any
 * of that is still to come: a solve that read a quiet frame inside the
 * debounce said solved, and the drain then landed under the motion, the
 * transcript jumping by its rows mid-move. Its resize is one step, not a
 * drag, so it asks every list to answer it now and waits until none owes
 * anything.
 *
 * Laws: [L06] (nothing here is React state; the solve reads it imperatively).
 *
 * @module lib/owed-reflow
 */

/** One list view's owed reflow. */
export interface OwedReflow {
  /** Answer a width change still inside its debounce, now. */
  readonly flush: () => void;
  /** Whether a width change is still unanswered or its drain still running. */
  readonly owed: () => boolean;
}

const reflows = new Set<OwedReflow>();

/** Register `reflow` for the life of its list view; returns the release. */
export function registerOwedReflow(reflow: OwedReflow): () => void {
  reflows.add(reflow);
  return () => {
    reflows.delete(reflow);
  };
}

/** Answer every width change a list view is still debouncing. */
export function flushOwedReflows(): void {
  for (const reflow of [...reflows]) reflow.flush();
}

/** Whether any list view on the page still owes a reflow. */
export function reflowOwed(): boolean {
  for (const reflow of reflows) if (reflow.owed()) return true;
  return false;
}
