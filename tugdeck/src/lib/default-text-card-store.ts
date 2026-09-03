/**
 * DefaultTextCardStore — subscribable store for the *deck-wide*
 * Text Card defaults the Settings card's "Text Card" section edits.
 *
 * A single deck-wide value ({@link TextCardSettings}): the view settings
 * a brand-new Text card adopts on first open when it has nothing
 * persisted of its own. No CSS/DOM side effects — it
 * just reads and writes one tugbank json blob at
 * `dev.tugapp.text-card/settings`. Mirrors `DefaultModelStore` /
 * `EditorSettingsStore`.
 *
 * Writes go through `client.setLocalValue` (optimistic, and — crucially
 * — synchronously fires `onDomainChanged`, so every open card's
 * `useTugbankValue` reader reflects the new default immediately) plus a
 * PUT to persist. Reads come straight from the TugbankClient cache, so
 * the panel's controls are correct from first paint with no async flash.
 *
 * **Laws:** [L02] useSyncExternalStore-compatible subscribe/getSnapshot.
 *
 * @module lib/default-text-card-store
 */

import { getTugbankClient } from "./tugbank-singleton";
import { putTextCardDefaults } from "@/settings-api";
import {
  DEFAULT_TEXT_CARD_SETTINGS,
  TEXT_CARD_DEFAULTS_DOMAIN,
  TEXT_CARD_DEFAULTS_KEY,
  parseTextCardSettings,
  type TextCardSettings,
} from "./text-card-settings";

export class DefaultTextCardStore {
  private _defaults: TextCardSettings;
  private _listeners: Set<() => void> = new Set();
  private _unsubscribeTugbank: (() => void) | null = null;

  constructor() {
    this._defaults = this._readFromCache() ?? { ...DEFAULT_TEXT_CARD_SETTINGS };

    const client = getTugbankClient();
    if (client) {
      this._unsubscribeTugbank = client.onDomainChanged((domain) => {
        if (domain !== TEXT_CARD_DEFAULTS_DOMAIN) return;
        const fresh = this._readFromCache() ?? { ...DEFAULT_TEXT_CARD_SETTINGS };
        this._defaults = fresh;
        for (const listener of this._listeners) listener();
      });
    }
  }

  private _readFromCache(): TextCardSettings | null {
    const client = getTugbankClient();
    if (!client) return null;
    return parseTextCardSettings(
      client.get(TEXT_CARD_DEFAULTS_DOMAIN, TEXT_CARD_DEFAULTS_KEY),
    );
  }

  /** Current deck-wide defaults. (L02 — useSyncExternalStore) */
  getSnapshot = (): TextCardSettings => this._defaults;

  /** Subscribe to changes. Returns unsubscribe. (L02) */
  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  };

  /**
   * Update the deck-wide defaults. Optimistically reflects locally and
   * across open cards via `setLocalValue`, then persists.
   */
  set(partial: Partial<TextCardSettings>): void {
    const next = { ...this._defaults, ...partial };
    this._defaults = next;
    for (const listener of this._listeners) listener();

    const client = getTugbankClient();
    if (client) {
      client.setLocalValue(TEXT_CARD_DEFAULTS_DOMAIN, TEXT_CARD_DEFAULTS_KEY, {
        kind: "json",
        value: next,
      });
    }
    putTextCardDefaults(next);
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
