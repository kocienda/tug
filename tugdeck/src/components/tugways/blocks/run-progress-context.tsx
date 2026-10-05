/**
 * The one way a component reads live run progress: a per-key
 * `useSyncExternalStore` subscription to the session's
 * {@link RunProgressStore} [L02].
 *
 * The transcript provides the store once, through {@link RunProgressContext},
 * so a tool block reads its own call's entry with {@link useRunProgress} and
 * re-renders only when that entry changes. Outside a provider (gallery and
 * standalone mounts) there is no store, and every read is `null`. A surface
 * that is not under the transcript — the JOBS placard — is handed the store
 * as a prop and reads it with {@link useRunProgressFrom}.
 */

import React, { useCallback, useContext } from "react";

import { useSyncExternalStore } from "@/lib/gesture-scope";

import type { RunProgress, RunProgressStore } from "@/lib/run-progress-store";

export const RunProgressContext = React.createContext<RunProgressStore | null>(null);

const NOOP_UNSUBSCRIBE = (): void => {};

/** Read one key's entry from `store`; `null` for a `null` store. */
export function useRunProgressFrom(
  store: RunProgressStore | null | undefined,
  key: string | null,
): RunProgress | null {
  const subscribe = useCallback(
    (cb: () => void) => (store ? store.subscribe(key, cb) : NOOP_UNSUBSCRIBE),
    [store, key],
  );
  const read = useCallback(() => (store ? store.get(key) : null), [store, key]);
  return useSyncExternalStore(subscribe, read, read);
}

/** Read one key's entry from the transcript's store. */
export function useRunProgress(key: string | null): RunProgress | null {
  return useRunProgressFrom(useContext(RunProgressContext), key);
}
