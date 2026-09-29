/**
 * use-store-derived — a `useSyncExternalStore` over a DERIVATION of a store's
 * snapshot, re-rendering only when the derived value changes.
 *
 * The plain hook hands a component the whole snapshot, and a component that
 * reads the whole snapshot re-renders on every commit — a flow slide that
 * changed one offset re-rendered the Layout card's eighty-four place marks,
 * inside the settle window the slide was animating through. This hook lets
 * the component say which facts it draws: `derive` maps the snapshot to those
 * facts, and when the rebuilt value is structurally equal to the last one the
 * last REFERENCE is returned, so React sees nothing new and renders nothing
 * ([L02]).
 *
 * `derive` must be a function of the snapshot alone. It is re-run only when
 * the snapshot's identity changes; a derivation that also read a prop would
 * go stale when the prop changed and the store did not. Combine props with the
 * derived value in a `useMemo` outside.
 *
 * `derive` may read the store's other accessors — a measured run height, a
 * band width — exactly as the `useMemo` bodies it replaces did; they are part
 * of what the deck's picture is, and every commit that changes them commits.
 *
 * @module lib/use-store-derived
 */

import { useCallback, useRef, useSyncExternalStore } from "react";

import { deepEqual } from "./deep-equal";

/** The two doors a store needs to be derived from. */
export interface DerivableStore<S> {
  subscribe: (callback: () => void) => () => void;
  getSnapshot: () => S;
}

const NOOP_UNSUBSCRIBE = (): void => {};
const NOOP_SUBSCRIBE = (): (() => void) => NOOP_UNSUBSCRIBE;

export function useStoreDerived<S, T>(
  store: DerivableStore<S> | null,
  derive: (snapshot: S | null) => T,
  equal: (a: T, b: T) => boolean = deepEqual,
): T {
  const deriveRef = useRef(derive);
  deriveRef.current = derive;
  const equalRef = useRef(equal);
  equalRef.current = equal;
  const cache = useRef<{ snapshot: S | null; value: T } | null>(null);

  const getSnapshot = useCallback((): T => {
    const snapshot = store === null ? null : store.getSnapshot();
    const cached = cache.current;
    if (cached !== null && cached.snapshot === snapshot) return cached.value;
    const next = deriveRef.current(snapshot);
    const value =
      cached !== null && equalRef.current(cached.value, next)
        ? cached.value
        : next;
    cache.current = { snapshot, value };
    return value;
  }, [store]);

  const subscribe = useCallback(
    (callback: () => void): (() => void) =>
      store === null ? NOOP_SUBSCRIBE() : store.subscribe(callback),
    [store],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
