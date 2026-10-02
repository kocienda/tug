/**
 * `useJobForToolUse` — the background-job row (if any) launched by a
 * given `toolUseId`, live from the session's jobs ledger.
 *
 * An async agent's own tool calls never stream to the parent, so its
 * block body would otherwise sit empty for the whole run. This hook lets
 * the agent block read the job's live `task_progress` (its most recent
 * tool + cumulative usage) and its elapsed lifetime, and paint them
 * in-body while it works. Returns `undefined` outside a session (the
 * gallery / standalone mount) or when no job matches this call.
 *
 * Laws: [L02] external state enters React through `useSyncExternalStore`;
 *       the store's `subscribe` / `getSnapshot` are bound arrow fields,
 *       so they pass straight through with no per-render identity churn.
 *
 * @module lib/code-session-store/hooks/use-job-for-tool-use
 */

import { useMemo } from "react";
import { useSyncExternalStore } from "@/lib/gesture-scope";

import type { CodeSessionStore } from "@/lib/code-session-store";
import type { JobItem } from "@/lib/code-session-store/select-jobs";

/** Stable no-op subscribe for the no-session (gallery) mount. */
const noopSubscribe = (): (() => void) => () => {};
/** Paired snapshot for the no-session mount — always `null`. */
const noopSnapshot = (): null => null;

export function useJobForToolUse(
  session: CodeSessionStore | undefined,
  toolUseId: string,
): JobItem | undefined {
  const snapshot = useSyncExternalStore(
    session?.subscribe ?? noopSubscribe,
    session?.getSnapshot ?? noopSnapshot,
    session?.getSnapshot ?? noopSnapshot,
  );
  return useMemo(
    () => snapshot?.jobs.find((j) => j.toolUseId === toolUseId),
    [snapshot, toolUseId],
  );
}
