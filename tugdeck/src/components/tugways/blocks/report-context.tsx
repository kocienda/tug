/**
 * The one way a component reads live run progress: a per-key
 * `useSyncExternalStore` subscription to the session's
 * {@link ReportStore} [L02].
 *
 * The transcript provides the store once, through {@link ReportContext},
 * so a tool block reads its own call's entry with {@link useReport} and
 * re-renders only when that entry changes. Outside a provider (gallery and
 * standalone mounts) there is no store, and every read is `null`. A surface
 * that is not under the transcript — the JOBS placard — is handed the store
 * as a prop and reads it with {@link useReportFrom}.
 */

import React, { useCallback, useContext } from "react";

import { useSyncExternalStore } from "@/lib/gesture-scope";

import type { Report, ReportStore } from "@/lib/report-store";

export const ReportContext = React.createContext<ReportStore | null>(null);

const NOOP_UNSUBSCRIBE = (): void => {};

/** Read one key's entry from `store`; `null` for a `null` store. */
export function useReportFrom(
  store: ReportStore | null | undefined,
  key: string | null,
): Report | null {
  const subscribe = useCallback(
    (cb: () => void) => (store ? store.subscribe(key, cb) : NOOP_UNSUBSCRIBE),
    [store, key],
  );
  const read = useCallback(() => (store ? store.get(key) : null), [store, key]);
  return useSyncExternalStore(subscribe, read, read);
}

/** Read one key's entry from the transcript's store. */
export function useReport(key: string | null): Report | null {
  return useReportFrom(useContext(ReportContext), key);
}

/** Read a closed call's settled run from the transcript's store. */
export function useSettledRun(key: string): Report | null {
  const store = useContext(ReportContext);
  const subscribe = useCallback(
    (cb: () => void) => (store ? store.subscribe(key, cb) : NOOP_UNSUBSCRIBE),
    [store, key],
  );
  const read = useCallback(() => (store ? store.getSettled(key) : null), [store, key]);
  return useSyncExternalStore(subscribe, read, read);
}
