/**
 * `useJobsState` — read the session-lifetime background-jobs ledger
 * from a `CodeSessionStore` snapshot.
 *
 * The ledger lives ON the snapshot (`CodeSessionSnapshot.jobs`,
 * reference-stable across quiescent rebuilds), so the hook is a thin
 * `useSyncExternalStore` selector — no derivation, no memo. Unlike
 * `useTaskListState` there is no turn-scoped visibility gate: jobs are
 * session-lifetime by design (a background shell genuinely runs
 * *between* turns), cleared only by session reset or the popover's
 * Clear action.
 *
 * Laws: [L02] external state through `useSyncExternalStore`.
 *
 * @module lib/code-session-store/hooks/use-jobs-state
 */

import { useCallback } from "react";
import { useSyncExternalStore } from "@/lib/gesture-scope";

import type { CodeSessionStore } from "@/lib/code-session-store";
import type { JobItem } from "@/lib/code-session-store/select-jobs";

/** Subscribe to the store and return the current jobs ledger. */
export function useJobsState(store: CodeSessionStore): readonly JobItem[] {
  const getJobs = useCallback(() => store.getSnapshot().jobs, [store]);
  return useSyncExternalStore(store.subscribe, getJobs, getJobs);
}
