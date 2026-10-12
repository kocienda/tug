/**
 * `useSessionFields` — subscribes a component to the named fields of its
 * `CodeSessionStore`'s snapshot, and to nothing else.
 *
 * A whole-snapshot subscription re-renders its component on every publish,
 * and the snapshot publishes for every structural change a streaming turn
 * makes: a tool row, a minted message, a cost line. A component that draws
 * the phase and the transcript has no business re-rendering for a tool row
 * in the active turn, so it names the fields it draws and the selector hands
 * back the previous selection whenever every one of them is unchanged.
 *
 * The comparison is by identity, field by field. The reducer keeps each
 * snapshot field's reference until that field changes, so identity is the
 * honest test: equal references are an unchanged field, and a new reference
 * is a field that moved.
 *
 * Conformance:
 *   - [L02] — `useSyncExternalStore` is the only external-state subscription.
 *   - The pure {@link selectSessionFields} is unit-tested; the React glue is
 *     left to real-app coverage per the project's no-fake-DOM rule.
 *
 * @module lib/code-session-store/hooks/use-session-fields
 */

import { useCallback, useRef } from "react";
import { useSyncExternalStore } from "@/lib/gesture-scope";

import type { CodeSessionSnapshot, CodeSessionStore } from "@/lib/code-session-store";

const NOOP_SUBSCRIBE = (): (() => void) => () => {};

/**
 * `snapshot`'s `keys`, or `previous` when it holds every one of them with
 * the same identity.
 */
export function selectSessionFields<K extends keyof CodeSessionSnapshot>(
  snapshot: CodeSessionSnapshot,
  keys: ReadonlyArray<K>,
  previous: Pick<CodeSessionSnapshot, K> | undefined,
): Pick<CodeSessionSnapshot, K> {
  if (previous !== undefined && keys.every((key) => previous[key] === snapshot[key])) {
    return previous;
  }
  const next = {} as Pick<CodeSessionSnapshot, K>;
  for (const key of keys) next[key] = snapshot[key];
  return next;
}

/**
 * Subscribe to `store` and return the fields `keys` names. The selection
 * keeps its identity across every publish that moves none of them, so the
 * caller re-renders only when a field it draws changes. Pass `keys` as a
 * module-level constant. A null `store` (the gallery, a standalone mount)
 * selects `null`.
 */
export function useSessionFields<K extends keyof CodeSessionSnapshot>(
  store: CodeSessionStore,
  keys: ReadonlyArray<K>,
): Pick<CodeSessionSnapshot, K>;
export function useSessionFields<K extends keyof CodeSessionSnapshot>(
  store: CodeSessionStore | null | undefined,
  keys: ReadonlyArray<K>,
): Pick<CodeSessionSnapshot, K> | null;
export function useSessionFields<K extends keyof CodeSessionSnapshot>(
  store: CodeSessionStore | null | undefined,
  keys: ReadonlyArray<K>,
): Pick<CodeSessionSnapshot, K> | null {
  // Per-component memo of the last selection. Writing it inside the selector
  // is sound: the result is a pure function of the store snapshot and the
  // previous result, so repeated reads of one snapshot return one object.
  const previousRef = useRef<Pick<CodeSessionSnapshot, K> | undefined>(undefined);
  const select = useCallback((): Pick<CodeSessionSnapshot, K> | null => {
    if (store == null) return null;
    const selection = selectSessionFields(store.getSnapshot(), keys, previousRef.current);
    previousRef.current = selection;
    return selection;
  }, [store, keys]);
  return useSyncExternalStore(store?.subscribe ?? NOOP_SUBSCRIBE, select, select);
}
