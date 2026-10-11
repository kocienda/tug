/**
 * DefaultCardSettingsStore — subscribable store for the *deck-wide* defaults
 * one card kind adopts, edited in the Settings card.
 *
 * `DefaultTextCardStore` is the original and this is that store with the card
 * kind lifted into a constructor argument, so a new kind's defaults panel is a
 * spec rather than another ninety lines of the same shape.
 *
 * Writes go through `client.setLocalValue` (optimistic, and — crucially —
 * synchronously fires `onDomainChanged`, so every open card's
 * `useTugbankValue` reader reflects the new default immediately) plus a PUT to
 * persist. Reads come straight from the TugbankClient cache, so the panel's
 * controls are correct from first paint with no async flash.
 *
 * Laws: [L02] useSyncExternalStore-compatible subscribe/getSnapshot.
 *
 * @module lib/default-card-settings-store
 */

import { Subscribable } from "./subscribable";
import { getTugbankClient } from "./tugbank-singleton";
import { putCardSettingsDefaults } from "@/settings-api";
import type { TaggedValue } from "./tugbank-client";

/** What a card kind must say for its deck-wide defaults to be editable. */
export interface DefaultCardSettingsSpec<T> {
  /** tugbank domain holding the deck-wide defaults. */
  defaultsDomain: string;
  /** Key under that domain. */
  defaultsKey: string;
  /** Narrow an untrusted stored blob; `null` when there is no usable value. */
  parse: (entry: TaggedValue | undefined) => T | null;
  /** The built-in values, used until something is stored. */
  builtIn: T;
}

export class DefaultCardSettingsStore<T extends object> extends Subscribable {
  private readonly _spec: DefaultCardSettingsSpec<T>;
  private _defaults: T;
  private _unsubscribeTugbank: (() => void) | null = null;

  constructor(spec: DefaultCardSettingsSpec<T>) {
    super();
    this._spec = spec;
    this._defaults = this._readFromCache() ?? { ...spec.builtIn };

    const client = getTugbankClient();
    if (client) {
      this._unsubscribeTugbank = client.onDomainChanged((domain) => {
        if (domain !== spec.defaultsDomain) return;
        this._defaults = this._readFromCache() ?? { ...spec.builtIn };
        this.notify();
      });
    }
  }

  private _readFromCache(): T | null {
    const client = getTugbankClient();
    if (!client) return null;
    return this._spec.parse(
      client.get(this._spec.defaultsDomain, this._spec.defaultsKey),
    );
  }

  /** Current deck-wide defaults. ([L02] — useSyncExternalStore) */
  getSnapshot = (): T => this._defaults;

  /**
   * Update the deck-wide defaults. Optimistically reflects locally and across
   * open cards via `setLocalValue`, then persists.
   */
  set(partial: Partial<T>): void {
    const next = { ...this._defaults, ...partial };
    this._defaults = next;
    this.notify();

    const client = getTugbankClient();
    if (client) {
      client.setLocalValue(this._spec.defaultsDomain, this._spec.defaultsKey, {
        kind: "json",
        value: next,
      });
    }
    putCardSettingsDefaults(this._spec.defaultsDomain, this._spec.defaultsKey, next);
  }

  /** Dispose subscriptions. */
  dispose(): void {
    if (this._unsubscribeTugbank) {
      this._unsubscribeTugbank();
      this._unsubscribeTugbank = null;
    }
    this.clearListeners();
  }
}
