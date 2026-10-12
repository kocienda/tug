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
 *       the selector reads this call's job row alone, so a publish that
 *       leaves the row's identity alone re-renders nothing.
 *
 * @module lib/code-session-store/hooks/use-job-for-tool-use
 */

import { useCallback } from "react";
import { useSyncExternalStore } from "@/lib/gesture-scope";

import type { CodeSessionStore } from "@/lib/code-session-store";
import type { JobItem } from "@/lib/code-session-store/select-jobs";

/** Stable no-op subscribe for the no-session (gallery) mount. */
const noopSubscribe = (): (() => void) => () => {};

export function useJobForToolUse(
  session: CodeSessionStore | undefined,
  toolUseId: string,
): JobItem | undefined {
  const select = useCallback(
    (): JobItem | undefined =>
      session?.getSnapshot().jobs.find((j) => j.toolUseId === toolUseId),
    [session, toolUseId],
  );
  return useSyncExternalStore(session?.subscribe ?? noopSubscribe, select, select);
}
