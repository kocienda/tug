/**
 * `useLifecycleState` — subscribes a session-card component to its
 * `CodeSessionStore` and projects the matrix-row lifecycle
 * snapshot. Every zone that coordinates on lifecycle (Z5's submit
 * button, the transcript-replay paint gate, Z2 / Z4) reads this one
 * hook so the matrix has a single executable source of truth.
 *
 * Composition:
 *   1. `useSyncExternalStore` on the `CodeSessionStore` — the [L02]
 *      boundary for external state.
 *   2. `deriveLifecycleSnapshot(storeSnapshot, previous)` — the pure
 *      matrix projection, threaded with the previous result from a
 *      per-card `useRef` so [DT09] reference stability holds per card
 *      (a module-level cache would thrash when two cards stream at
 *      once).
 *
 * Conformance:
 *   - [L02] — `useSyncExternalStore` is the only external-state
 *     subscription; `lifecycle-state.ts` itself is pure.
 *   - [DT09] — see `lifecycle-state.ts`.
 *
 * The hook's React glue (`useSyncExternalStore` + the `useRef` render
 * cache) is left to real-app / integration coverage per the project's
 * no-fake-DOM rule; the pure `deriveLifecycleSnapshot` it wraps is
 * unit-tested exhaustively in `__tests__/lifecycle-state.test.ts`.
 *
 * @module lib/code-session-store/hooks/use-lifecycle-state
 */

import { useRef } from "react";
import { useSyncExternalStore } from "@/lib/gesture-scope";

import type { CodeSessionStore } from "@/lib/code-session-store";

import {
  deriveLifecycleSnapshot,
  type SessionLifecycleSnapshot,
} from "../lifecycle-state";

/**
 * Subscribe to `store` and return the current matrix-row lifecycle
 * snapshot. The returned reference is stable ([DT09]) across renders
 * that change no matrix-relevant signal — a streaming `assistant_delta`
 * re-runs the hook but yields the same snapshot object, so zones that
 * only consume lifecycle do not re-render.
 */
export function useLifecycleState(
  store: CodeSessionStore,
): SessionLifecycleSnapshot {
  const storeSnapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
  );
  // Per-component (= per-card) memo of the last stable snapshot,
  // threaded into `deriveLifecycleSnapshot` as `previous`. Writing a
  // ref during render is sound here: the value is a pure function of
  // the render's inputs, so a double-invoked render recomputes the
  // identical result.
  const previousRef = useRef<SessionLifecycleSnapshot | undefined>(undefined);
  const snapshot = deriveLifecycleSnapshot(storeSnapshot, previousRef.current);
  previousRef.current = snapshot;
  return snapshot;
}
