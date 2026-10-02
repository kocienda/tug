/**
 * useTugbankValue — `useSyncExternalStore` reader for tugbank-cache values.
 *
 * Replaces the `useState<T>(() => parse(client.get(domain, key)))` pattern
 * for one-shot reads of tugbank cache state. That pattern reads external
 * state into React state via useState's lazy initial value, which violates
 * [L02] ("External state enters React through `useSyncExternalStore` only").
 * Lazy initial values don't carve out an exception — they're still external
 * state being copied into React's `useState` cell.
 *
 * Contract:
 *   - `subscribe`: registers a `client.onDomainChanged` callback filtered to
 *     `domain`, returns the unregister.
 *   - `getSnapshot`: reads `client.get(domain, key)` and runs `parse`. The
 *     result is cached against the underlying `TaggedValue` reference, so
 *     the snapshot returns reference-stable values when the underlying
 *     cache entry is unchanged. (Without caching, `parse` would build a
 *     fresh object each call and `useSyncExternalStore` would loop.)
 *   - When the client is null (main.tsx hasn't initialized it yet),
 *     returns `fallback`. The cache subscribes the moment the client appears.
 */

import { useCallback } from "react";
import { useSyncExternalStore } from "@/lib/gesture-scope";

import { getTugbankClient } from "./tugbank-singleton";
import type { TaggedValue } from "./tugbank-client";

/**
 * Per-(domain,key) parse cache. Keyed on the underlying `TaggedValue`
 * reference — when the cache entry is replaced, the WeakMap miss
 * triggers a fresh parse; when it stays the same, we return the
 * memoized parsed value, preserving snapshot reference stability.
 *
 * WeakMap because TaggedValue references are short-lived; the GC
 * sweeps stale parsed values automatically.
 */
const _parseCache = new WeakMap<TaggedValue, unknown>();

export function useTugbankValue<T>(
  domain: string,
  key: string,
  parse: (entry: TaggedValue | undefined) => T,
  fallback: T,
): T {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const client = getTugbankClient();
      if (!client) return () => {};
      return client.onDomainChanged((d) => {
        if (d === domain) onChange();
      });
    },
    [domain],
  );

  const getSnapshot = useCallback((): T => {
    const client = getTugbankClient();
    if (!client) return fallback;
    const entry = client.get(domain, key);
    if (entry === undefined) return fallback;
    const cached = _parseCache.get(entry);
    if (cached !== undefined) return cached as T;
    const parsed = parse(entry);
    _parseCache.set(entry, parsed);
    return parsed;
  }, [domain, key, parse, fallback]);

  return useSyncExternalStore(subscribe, getSnapshot);
}
