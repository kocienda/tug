/**
 * logout-store — a one-shot "log out was requested" signal ([L02]).
 *
 * Logout is app-level (it stops every session and reopens ConfigureTug), so it
 * can't hang off a Session card the way per-card slash surfaces do. Both triggers —
 * the File-menu "Log out…" control action and the `/logout` slash command —
 * call {@link requestLogout}, which bumps a monotonic nonce; the app-level
 * `TugLogout` orchestrator watches it and runs the confirm → logout flow. A
 * nonce (not a boolean) so repeated requests each fire and there is no state to
 * "consume"/reset.
 *
 * @module lib/logout-store
 */

import { useSyncExternalStore } from "@/lib/gesture-scope";


class LogoutStore {
  private _nonce = 0;
  private readonly _listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  };

  getSnapshot = (): number => this._nonce;

  request(): void {
    this._nonce += 1;
    for (const listener of [...this._listeners]) listener();
  }
}

const logoutStore = new LogoutStore();

/** Request a logout (from the File menu or the `/logout` slash command). */
export function requestLogout(): void {
  logoutStore.request();
}

/** React read of the logout-request nonce ([L02]); changes on each request. */
export function useLogoutRequest(): number {
  return useSyncExternalStore(logoutStore.subscribe, logoutStore.getSnapshot);
}
