/**
 * DefaultModelStore — subscribable store for the *global* default model
 * selector the Settings card's "Session Card" tab edits.
 *
 * Unlike the per-card model (`use-model.ts`), this is a single deck-wide value:
 * the model a brand-new card adopts on mount when it has nothing persisted of
 * its own. It carries no CSS/DOM side effects — it just reads and writes one
 * tugbank string at `dev.tugapp.model/default`. Mirrors
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
 * @module lib/default-model-store
 */

import { getTugbankClient } from "./tugbank-singleton";
import { putDefaultModel } from "@/settings-api";
import {
  DEFAULT_MODEL_SELECTOR,
  MODEL_DEFAULT_DOMAIN,
  MODEL_DEFAULT_KEY,
  isModelSelector,
  parsePersistedModel,
} from "./model";

/**
 * Write the deck-wide default selector: optimistic `setLocalValue` (which
 * synchronously fires `onDomainChanged`, so an open {@link DefaultModelStore}
 * and every card's reader reflect it at once) plus the PUT. Exported so the
 * unavailable-model bulletin can repair a stale deck default at its source
 * without holding a store instance.
 */
export function writePersistedDefaultModel(selector: string): void {
  const client = getTugbankClient();
  if (client) {
    client.setLocalValue(MODEL_DEFAULT_DOMAIN, MODEL_DEFAULT_KEY, {
      kind: "string",
      value: selector,
    });
  }
  putDefaultModel(selector);
}

export class DefaultModelStore {
  private _selector: string;
  private _listeners: Set<() => void> = new Set();
  private _unsubscribeTugbank: (() => void) | null = null;

  constructor() {
    this._selector = this._readFromCache() ?? DEFAULT_MODEL_SELECTOR;

    const client = getTugbankClient();
    if (client) {
      this._unsubscribeTugbank = client.onDomainChanged((domain) => {
        if (domain !== MODEL_DEFAULT_DOMAIN) return;
        const fresh = this._readFromCache() ?? DEFAULT_MODEL_SELECTOR;
        if (fresh !== this._selector) {
          this._selector = fresh;
          for (const listener of this._listeners) listener();
        }
      });
    }
  }

  private _readFromCache(): string | null {
    const client = getTugbankClient();
    if (!client) return null;
    return parsePersistedModel(client.get(MODEL_DEFAULT_DOMAIN, MODEL_DEFAULT_KEY));
  }

  /** Current default selector. (L02 — useSyncExternalStore) */
  getSnapshot = (): string => this._selector;

  /** Subscribe to changes. Returns unsubscribe. (L02) */
  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  };

  /**
   * Update the global default. Optimistically reflects locally and across open
   * cards via `setLocalValue`, then persists. A value that isn't a real
   * selector is ignored rather than written.
   */
  set(selector: string): void {
    if (!isModelSelector(selector) || selector === this._selector) return;
    this._selector = selector;
    for (const listener of this._listeners) listener();
    writePersistedDefaultModel(selector);
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
