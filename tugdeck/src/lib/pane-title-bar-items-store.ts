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
 * An item is worn one of two ways. By default it is a ghost icon button in the
 * title bar's rollup, one press with no menu to open first — the shape a verb
 * the card offers every time it is open wants. A `placement: "menu"` item is
 * a row in a `⋯` menu standing beside the place badge, outside the rollup, and
 * is for a rail: a rail has no rollup, and its verbs are occasional ones that
 * a confirm guards rather than a press a hand repeats (the Overview's Clear).
 * An earlier `⋮` popup inside the rollup was cut because it put a verb two
 * gestures deep behind a hover; this menu is visible at rest.
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

import { Subscribable } from "./subscribable";

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
  /**
   * The registry's enablement answer, asked in the page that holds the
   * card's chain — set only for a body card's items, whose responders the
   * shell's chain does not hold. Absent, the title bar asks its own chain.
   * Not a card's opinion: the body computes it with `validateCommand`.
   */
  enabled?: boolean;
  /** Absent, a button in the rollup; `"menu"`, a row in the bar's `⋯` menu. */
  placement?: "menu";
  /**
   * For a menu row whose command the reader should confirm: the chrome raises
   * a confirm popover off the `⋯` with this copy, and dispatches the command
   * only on Confirm.
   */
  confirm?: { message: string; confirmLabel: string };
}

class PaneTitleBarItemsStore extends Subscribable {
  private readonly _byCard = new Map<string, readonly PaneTitleBarItem[]>();

  /** Publish (or replace) the title-bar items for `cardId`. Passing `null`
   *  (or an empty array) clears them — no card-contributed control renders. */
  set(cardId: string, items: readonly PaneTitleBarItem[] | null): void {
    if (items === null || items.length === 0) {
      if (!this._byCard.has(cardId)) return;
      this._byCard.delete(cardId);
      this.notify();
      return;
    }
    this._byCard.set(cardId, items);
    this.notify();
  }

  /** Read the items for `cardId`, or `null` when none. */
  get(cardId: string | null): readonly PaneTitleBarItem[] | null {
    if (cardId === null) return null;
    return this._byCard.get(cardId) ?? null;
  }
}

export const paneTitleBarItemsStore = new PaneTitleBarItemsStore();
