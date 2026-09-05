/**
 * Public types for the Cards store — the persisted presentation state of the
 * Cards card's rows: their order within each group, the order of the groups
 * themselves, and which groups the user has collapsed.
 *
 * Nothing here is geometry. A card's live placement belongs to the deck layout
 * blob, and the width the Cards rail reopens at belongs to `sidebarWidthStore`
 * — at `dev.tugapp.cards` / `widthPx`, the same domain this store writes to,
 * so the two agree by construction rather than by coincidence.
 *
 * Conformance:
 *   - [L02] external store; React reads via `useSyncExternalStore`.
 *   - State persists across HMR / reloads via tugbank under the
 *     `dev.tugapp.cards` domain — never `localStorage`.
 *
 * @module components/cards/cards-store/types
 */

import type { CardsGroup } from "@/components/cards/cards-groups";

/**
 * Per-group row order for the Cards card. The group union is defined where the
 * taxonomy lives (`cards-groups.ts`) and imported here as a type only, so the
 * store's persisted shape cannot drift from the groups that actually render.
 */
export type CardsRowOrder = Readonly<Record<CardsGroup, readonly string[]>>;

/** Tugbank domain owning the Cards card's persisted presentation state. */
export const CARDS_DOMAIN = "dev.tugapp.cards";

/** Individual key names within the domain. */
export const CARDS_KEYS = {
  CARDS_ROW_ORDER: "cardsRowOrder",
  CARDS_GROUP_ORDER: "cardsGroupOrder",
  CARDS_COLLAPSED_GROUPS: "cardsCollapsedGroups",
} as const;

/**
 * Public snapshot returned by `CardsStore.getSnapshot()`. Stable reference
 * between dispatches that produce no observable change; the
 * `readonly string[]` fields keep their reference too when unchanged.
 */
export interface CardsSnapshot {
  /**
   * Persisted user order of the card's pane rows, one list per group.
   *
   * A row's **order key** is the identity that should survive a close/reopen
   * cycle, which differs by what the row represents: the bound `tugSessionId`
   * for a single-card session pane, the card id for any other single-card
   * pane, and the pane id for a multi-card pane (the only stable identity a
   * stack has). Keys absent from the list sort AFTER the ordered set, and
   * stale keys are ignored.
   */
  cardsRowOrder: CardsRowOrder;
  /**
   * Persisted order of the GROUPS — the runs themselves, moved by carrying a
   * group header. Empty until the user rearranges them, and tolerant of drift
   * in both directions: a name that is no longer a group is ignored, and a
   * group the list does not name renders in its built-in position
   * (`GROUP_ORDER` in `cards-groups.ts`), so adding a fourth group never needs
   * a migration.
   */
  cardsGroupOrder: readonly string[];
  /** Groups the user has collapsed. */
  collapsedCardGroups: readonly string[];
}
