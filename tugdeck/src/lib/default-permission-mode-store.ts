/**
 * DefaultPermissionModeStore — subscribable store for the *global* default
 * permission mode the Settings card's "Session Card" tab edits.
 *
 * Unlike the per-card mode (`use-permission-mode.ts`), this is a single
 * deck-wide value: the mode a brand-new card adopts on mount when it has
 * nothing persisted of its own. It carries no CSS/DOM side effects — it just
 * reads and writes one tugbank string at
 * `dev.tugapp.permission-mode/default`.
 *
 * Writes go through `client.setLocalValue` (optimistic, and — crucially —
 * synchronously fires `onDomainChanged`, so every open card's
 * `useTugbankValue` reader reflects the new default immediately) plus a PUT to
 * persist. Reads come straight from the TugbankClient cache, so the panel's
 * popup label is correct from first paint with no async flash.
 *
 * **Laws:** [L02] useSyncExternalStore-compatible subscribe/getSnapshot.
 *
 * @module lib/default-permission-mode-store
 */

import { getTugbankClient } from "./tugbank-singleton";
import { putDefaultPermissionMode } from "@/settings-api";
import {
  PERMISSION_MODE_DEFAULT_DOMAIN,
  PERMISSION_MODE_DEFAULT_KEY,
  isPermissionMode,
  parsePersistedPermissionMode,
} from "./permission-mode";
import type { PermissionMode } from "@tugproto/inbound";

/** The mode new cards spawn with when nothing else is configured. */
export const DEFAULT_PERMISSION_MODE: PermissionMode = "default";

export class DefaultPermissionModeStore {
  private _mode: PermissionMode;
  private _listeners: Set<() => void> = new Set();
  private _unsubscribeTugbank: (() => void) | null = null;

  constructor() {
    this._mode = this._readFromCache() ?? DEFAULT_PERMISSION_MODE;

    const client = getTugbankClient();
    if (client) {
      this._unsubscribeTugbank = client.onDomainChanged((domain) => {
        if (domain !== PERMISSION_MODE_DEFAULT_DOMAIN) return;
        const fresh = this._readFromCache() ?? DEFAULT_PERMISSION_MODE;
        if (fresh !== this._mode) {
          this._mode = fresh;
          for (const listener of this._listeners) listener();
        }
      });
    }
  }

  private _readFromCache(): PermissionMode | null {
    const client = getTugbankClient();
    if (!client) return null;
    return parsePersistedPermissionMode(
      client.get(PERMISSION_MODE_DEFAULT_DOMAIN, PERMISSION_MODE_DEFAULT_KEY),
    );
  }

  /** Current default mode. (L02 — useSyncExternalStore) */
  getSnapshot = (): PermissionMode => this._mode;

  /** Subscribe to changes. Returns unsubscribe. (L02) */
  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  };

  /**
   * Update the global default. Optimistically reflects locally and across
   * open cards via `setLocalValue`, then persists. A value that isn't a real
   * mode is ignored rather than written.
   */
  set(mode: string): void {
    if (!isPermissionMode(mode) || mode === this._mode) return;
    this._mode = mode;
    for (const listener of this._listeners) listener();

    const client = getTugbankClient();
    if (client) {
      client.setLocalValue(PERMISSION_MODE_DEFAULT_DOMAIN, PERMISSION_MODE_DEFAULT_KEY, {
        kind: "string",
        value: mode,
      });
    }
    putDefaultPermissionMode(mode);
  }

  /** Dispose subscriptions. */
  dispose(): void {
    if (this._unsubscribeTugbank) {
      this._unsubscribeTugbank();
      this._unsubscribeTugbank = null;
    }
    this._listeners.clear();
  }
}
