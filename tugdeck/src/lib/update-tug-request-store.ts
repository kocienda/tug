/**
 * update-tug-request-store — the deck-local door into UpdateTug ([L02]).
 *
 * UpdateTug has two doors and both of them only raise it ([B01]). One is the
 * host's: `revealCount` rides the update snapshot, bumped by the Tug-menu item
 * and by Sparkle's own `showUpdateInFocus`, and it needs no store because it is
 * already state on a snapshot the wizard reads. The other is the pill, which is
 * a click in the deck answering nothing across the bridge — so it has nowhere to
 * live but here ([B06]: the snapshot gains nothing and the seven actions stay
 * seven).
 *
 * Two pieces of state, and they are not the two `configure-tug-request-store`
 * carries. That store's `onDemand` flag exists because its wizard can be
 * *required*, so "open because the user asked" has to be told apart from "open
 * because setup is not done". An update is never required, so there is no such
 * distinction to keep here:
 *
 *   - `nonce` — a monotonic "the pill was clicked" signal. A nonce rather than a
 *     boolean, for the same reason ConfigureTug's is: repeated asks each fire,
 *     with nothing to reset between them.
 *   - `open` — whether the wizard is on screen. It lives here rather than in
 *     `UpdateTug`'s own `useState` because the **pill** has to read it: the pill
 *     shows only while an update is live *and* the wizard is closed ([B02]), and
 *     the two components have no parent between them to pass a prop through.
 *     UpdateTug is still the only writer.
 *
 * @module lib/update-tug-request-store
 */

import { useSyncExternalStore } from "react";

class UpdateTugRequestStore {
  private _nonce = 0;
  private _open = false;
  private readonly _listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  };

  getNonce = (): number => this._nonce;

  getOpen = (): boolean => this._open;

  request(): void {
    this._nonce += 1;
    this.emit();
  }

  setOpen(open: boolean): void {
    if (this._open === open) return;
    this._open = open;
    this.emit();
  }

  private emit(): void {
    for (const listener of [...this._listeners]) listener();
  }
}

const updateTugRequestStore = new UpdateTugRequestStore();

/**
 * Ask for the update wizard — the pill's click, and the only caller that is not
 * the host. Raises the wizard and answers Sparkle nothing.
 */
export function requestUpdateTug(): void {
  updateTugRequestStore.request();
}

/** React read of the request nonce ([L02]); changes on each request. */
export function useUpdateTugRequest(): number {
  return useSyncExternalStore(
    updateTugRequestStore.subscribe,
    updateTugRequestStore.getNonce,
  );
}

/**
 * Record whether the wizard is on screen. UpdateTug's own call, and nobody
 * else's — the pill reads this and never writes it.
 */
export function setUpdateTugOpen(open: boolean): void {
  updateTugRequestStore.setOpen(open);
}

/** React read of whether the wizard is on screen ([L02]). */
export function useUpdateTugOpen(): boolean {
  return useSyncExternalStore(
    updateTugRequestStore.subscribe,
    updateTugRequestStore.getOpen,
  );
}
