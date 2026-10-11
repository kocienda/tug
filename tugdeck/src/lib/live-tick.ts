/**
 * Live-tick external store — one shared interval; every session-clock
 * renderer subscribes via `useSyncExternalStore` per [L02].
 *
 * A store, so it lives in `lib`. The telemetry renderers re-export
 * {@link useLiveTick}; a module outside the session card's tree (the block
 * header's elapsed slot) imports it from here, so it does not pull the
 * renderers' chrome imports in with it.
 *
 * @module lib/live-tick
 */

import { createSubscribable } from "@/lib/subscribable";
import { useSyncExternalStore } from "@/lib/gesture-scope";

/**
 * Module-scoped 1Hz tick. Lazy-started on first subscribe; stopped
 * when the last subscriber unsubscribes. The "snapshot" is the last
 * tick wall-clock ms; renderers read it (or `Date.now()` directly,
 * which is fine because `useSyncExternalStore` only re-renders when
 * the snapshot reference changes — and the snapshot changes once per
 * tick).
 */
const tickListeners = createSubscribable();
let tickTimer: ReturnType<typeof setInterval> | null = null;
let tickValue = 0;

function startTick(): void {
  if (tickTimer !== null) return;
  tickValue = Date.now();
  tickTimer = setInterval(() => {
    tickValue = Date.now();
    tickListeners.notify();
  }, 1_000);
}

function stopTickIfIdle(): void {
  if (tickListeners.listenerCount === 0 && tickTimer !== null) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

function subscribeTick(listener: () => void): () => void {
  const unsubscribe = tickListeners.subscribe(listener);
  startTick();
  return () => {
    unsubscribe();
    stopTickIfIdle();
  };
}

function getTick(): number {
  return tickValue;
}

/**
 * Hook returning the current 1Hz tick value. Renderers that need a
 * live clock subscribe; the underlying interval starts on first
 * subscription and stops when nothing subscribes.
 *
 * Exported for the Jobs popover's per-row elapsed readout — the leaf
 * `JobElapsedValue` component mounts only while the popover is open,
 * so an idle session with running jobs pays no tick until the user
 * actually looks.
 */
export function useLiveTick(): number {
  return useSyncExternalStore(subscribeTick, getTick, getTick);
}
