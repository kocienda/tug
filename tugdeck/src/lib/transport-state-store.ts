/**
 * transport-state-store — the app-wide health of the WebSocket transport to
 * tugcast, as a {@link useSyncExternalStore}-compatible store ([L02]).
 *
 * Unlike `CodeSessionStore.transportState` (which is *per-card* and folds in a
 * "restoring" binding-ack phase), this is a single app-level reading of the
 * socket itself — `online` once a handshake completes, `offline` when the wire
 * drops, `reconnecting` while a backoff retry is scheduled. It is the channel
 * ConfigureTug reads to show a calm "Reconnecting…" body instead of a dead wizard
 * when the transport falls over mid-setup (dash/archive/onboarding-and-install.md#tugsetup-states).
 *
 * The store is *driven* from `main.tsx`, which already owns the
 * `ConnectionLifecycle` singleton and wires its other observers there — so this
 * module stays free of any import-order dependency on the lifecycle being
 * registered. It starts `online` (optimistic): the not-yet-connected case is
 * covered by ConfigureTug's probing body, and a real drop flips it `offline` /
 * `reconnecting`.
 *
 * @module lib/transport-state-store
 */

import { useSyncExternalStore } from "react";

/** App-level transport health. */
export type AppTransportState = "online" | "offline" | "reconnecting";

class TransportStateStore {
  private _state: AppTransportState = "online";
  private readonly _listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  };

  getSnapshot = (): AppTransportState => this._state;

  /** Apply a new transport state; notifies subscribers only on a real change. */
  set(next: AppTransportState): void {
    if (this._state === next) return;
    this._state = next;
    for (const listener of [...this._listeners]) listener();
  }
}

/** The process-wide transport-state store. Driven by `main.tsx`. */
export const transportStateStore = new TransportStateStore();

/** React read of the app transport state ([L02]). */
export function useAppTransportState(): AppTransportState {
  return useSyncExternalStore(
    transportStateStore.subscribe,
    transportStateStore.getSnapshot,
  );
}
