/**
 * PaneTitleBarItemsStore — the per-card channel for a card to contribute
 * controls to its pane's title bar.
 *
 * This is the generic mechanism behind the `toggleMenu` pane affordance
 * (`pane-model.md`): the title bar's card-contributed controls are NOT
 * card-specific chrome baked into `TugPane`. Any card publishes its items
 * here; `CardTitleBar` subscribes for the active card and renders them,
 * and nothing when there are none. `tug-pane.tsx` imports only this store —
 * never a card-specific module ([L10]/[L25]).
 *
 * An item is worn one way and only one: a ghost icon button standing in the
 * title bar's control cluster, one press with no menu to open first. A second
 * shape — a row in a shared `⋮` popup — stood here until it was cut. A card's
 * verb the reader has to open a menu to see, inside a row that is itself
 * revealed on hover, was two gestures deep before it was a verb, and the one
 * family that ever used it (Go in Transcript) has its chords and its native
 * submenu. A card that wants a verb on its title bar gives it a glyph.
 *
 * The exact precedent is `card-title-store.ts`: a card publishes into a
 * per-card store, the pane subscribes and renders — no card coupling in
 * the chrome. Icons follow that store's rule too: a lucide icon NAME, which
 * the chrome resolves, so no component travels this channel.
 *
 * Laws: [L02] subscribable store consumed via `useSyncExternalStore`;
 * [L10]/[L25] chrome and content stay in their lanes with this store as
 * the channel; [L24] structure-zone state across the pane/card boundary.
 *
 * @module lib/pane-title-bar-items-store
 */

/**
 * A single title-bar item a card contributes — a COMMAND REFERENCE, not a
 * label and a callback.
 *
 * An item is a command ([L30] names one first in its list), so a card says
 * only *which* commands belong on its pane's title bar and in what order.
 * `CardTitleBar` resolves the item's title and its enablement from
 * `command-registry.ts` and invokes it with `dispatchCommand`, so an item can
 * never disagree with the same command's chord or its item in the native menu
 * bar.
 *
 * There is deliberately no `disabled` field. Enablement is the registry's
 * answer via `validate(chain)`; a card-supplied one would be the second
 * opinion the law forbids, and it would drift from ⌘S the first time a gate
 * changed. What the card decides is MEMBERSHIP — whether the item is in the
 * title bar at all — which is a different question and genuinely the card's.
 */
export interface PaneTitleBarItem {
  /** The command this item names — a `TUG_ACTIONS` value / command id. */
  commandId: string;
  /**
   * Lucide icon name, resolved against the `icons` map by the chrome (the
   * `card-title-store` rule). An item with no icon the chrome can resolve
   * renders nothing — a button is its glyph.
   */
  icon?: string;
  /**
   * What to say while the command validates disabled — "No file", not
   * "Reveal in Finder" greyed out with no explanation.
   *
   * This is NOT the second opinion `disabled` would be. Whether the command
   * is applicable stays the registry's answer, asked of the chain; this is
   * the card saying *why*, which is a fact only the card holds. A control
   * that dims without a reason is a dead end for the reader, and a button
   * that vanished instead would be a cluster the hand cannot learn.
   */
  unavailableHint?: string;
}

class PaneTitleBarItemsStore {
  private readonly _byCard = new Map<string, readonly PaneTitleBarItem[]>();
  private readonly _listeners = new Set<() => void>();

  /** Publish (or replace) the title-bar items for `cardId`. Passing `null`
   *  (or an empty array) clears them — no card-contributed control renders. */
  set(cardId: string, items: readonly PaneTitleBarItem[] | null): void {
    if (items === null || items.length === 0) {
      if (!this._byCard.has(cardId)) return;
      this._byCard.delete(cardId);
      this._notify();
      return;
    }
    this._byCard.set(cardId, items);
    this._notify();
  }

  /** Read the items for `cardId`, or `null` when none. */
  get(cardId: string | null): readonly PaneTitleBarItem[] | null {
    if (cardId === null) return null;
    return this._byCard.get(cardId) ?? null;
  }

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  };

  private _notify(): void {
    for (const listener of this._listeners) listener();
  }
}

export const paneTitleBarItemsStore = new PaneTitleBarItemsStore();
