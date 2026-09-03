/**
 * DefaultEffortStore — subscribable store for the *global* default reasoning
 * effort the Settings card's "Session Card" tab edits.
 *
 * Unlike the per-card effort (`use-effort.ts`), this is a single deck-wide
 * value: the level a brand-new card adopts on mount when it has nothing
 * persisted of its own. It carries no CSS/DOM side effects — it just reads and
 * writes one tugbank string at `dev.tugapp.effort/default`. Mirrors
 * `default-permission-mode-store.ts`.
 *
 * Writes go through `client.setLocalValue` (optimistic, and — crucially —
 * synchronously fires `onDomainChanged`, so every open card's `useTugbankValue`
 * reader reflects the new default immediately) plus a PUT to persist. Reads come
 * straight from the TugbankClient cache, so the panel's popup label is correct
 * from first paint with no async flash.
 *
 * **Laws:** [L02] useSyncExternalStore-compatible subscribe/getSnapshot.
 *
 * @module lib/default-effort-store
 */

import { getTugbankClient } from "./tugbank-singleton";
import { putDefaultEffort } from "@/settings-api";
import {
  DEFAULT_EFFORT_LEVEL,
  EFFORT_DEFAULT_DOMAIN,
  EFFORT_DEFAULT_KEY,
  EFFORT_LEVELS,
  parsePersistedEffort,
} from "./effort";

/** Whether `value` is a recognized effort level. */
function isEffortLevel(value: string): boolean {
  return (EFFORT_LEVELS as readonly string[]).includes(value);
}

export class DefaultEffortStore {
  private _level: string;
  private _listeners: Set<() => void> = new Set();
  private _unsubscribeTugbank: (() => void) | null = null;

  constructor() {
    this._level = this._readFromCache() ?? DEFAULT_EFFORT_LEVEL;

    const client = getTugbankClient();
    if (client) {
      this._unsubscribeTugbank = client.onDomainChanged((domain) => {
        if (domain !== EFFORT_DEFAULT_DOMAIN) return;
        const fresh = this._readFromCache() ?? DEFAULT_EFFORT_LEVEL;
        if (fresh !== this._level) {
          this._level = fresh;
          for (const listener of this._listeners) listener();
        }
      });
    }
  }

  private _readFromCache(): string | null {
    const client = getTugbankClient();
    if (!client) return null;
    return parsePersistedEffort(
      client.get(EFFORT_DEFAULT_DOMAIN, EFFORT_DEFAULT_KEY),
    );
  }

  /** Current default level. (L02 — useSyncExternalStore) */
  getSnapshot = (): string => this._level;

  /** Subscribe to changes. Returns unsubscribe. (L02) */
  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  };

  /**
   * Update the global default. Optimistically reflects locally and across open
   * cards via `setLocalValue`, then persists. A value that isn't a recognized
   * level is ignored rather than written.
   */
  set(level: string): void {
    if (!isEffortLevel(level) || level === this._level) return;
    this._level = level;
    for (const listener of this._listeners) listener();

    const client = getTugbankClient();
    if (client) {
      client.setLocalValue(EFFORT_DEFAULT_DOMAIN, EFFORT_DEFAULT_KEY, {
        kind: "string",
        value: level,
      });
    }
    putDefaultEffort(level);
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
