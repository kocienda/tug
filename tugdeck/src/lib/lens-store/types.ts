/**
 * Public types for the Lens store — the persisted section-arrangement
 * state for the Lens panel (section order, the Sessions-section row order,
 * per-section collapse, and the preferred reopen width).
 *
 * The Lens's live geometry belongs to the deck layout blob — pane presence is
 * open/closed, `size.width` is the live width, and `imposition.lens` is the
 * side it holds. This store owns only the *arrangement* preferences and the
 * reopen width, which is a preference rather than live geometry.
 *
 * Conformance:
 *   - [L02] external store; React reads via `useSyncExternalStore`.
 *   - State persists across HMR / reloads via tugbank under the
 *     `dev.tugtool.lens` domain — never `localStorage`.
 *
 * @module lib/lens-store/types
 */

import type { CardsGroup } from "@/components/cards/cards-groups";

/**
 * Per-group row order for the Cards section. The group union is defined
 * where the taxonomy lives (`cards-groups.ts`) and imported here as a type
 * only, so the store's persisted shape cannot drift from the groups that
 * actually render.
 */
export type LensCardsRowOrder = Readonly<
  Record<CardsGroup, readonly string[]>
>;

/** Tugbank domain owning the Lens's persisted arrangement state. */
export const LENS_DOMAIN = "dev.tugtool.lens";

/** Individual key names within the domain. */
export const LENS_KEYS = {
  WIDTH_PX: "widthPx",
  SECTION_ORDER: "sectionOrder",
  /** @deprecated Read on hydrate to seed `CARDS_ROW_ORDER`; never written. */
  SESSION_ORDER: "sessionOrder",
  /** @deprecated Read on hydrate to seed `CARDS_ROW_ORDER`; never written. */
  TEXT_FILE_ORDER: "textFileOrder",
  CARDS_ROW_ORDER: "cardsRowOrder",
  CARDS_GROUP_ORDER: "cardsGroupOrder",
  CARDS_COLLAPSED_GROUPS: "cardsCollapsedGroups",
  COLLAPSED_SECTIONS: "collapsedSections",
} as const;

/**
 * Default reopen width in pixels — matches the historical dev-panel
 * width so an existing user's rail feels the same after the swap.
 */
export const DEFAULT_LENS_WIDTH_PX = 420;

/**
 * Minimum Lens width — narrow enough to not feel oppressive on a small
 * display, wide enough to keep section content legible.
 */
export const MIN_LENS_WIDTH_PX = 320;

/**
 * Public snapshot returned by `LensStore.getSnapshot()`. Stable
 * reference between dispatches that produce no observable change; the
 * `readonly string[]` fields keep their reference too when unchanged.
 */
export interface LensSnapshot {
  /** Preferred reopen width in pixels (the live width lives on the pane). */
  widthPx: number;
  /** Persisted section order, most-preferred first. Unknown kinds tolerated. */
  sectionOrder: readonly string[];
  /**
   * Persisted user order of the Cards section's pane rows, one list per group.
   *
   * A row's **order key** is the identity that should survive a close/reopen
   * cycle, which differs by what the row represents: the bound `tugSessionId`
   * for a single-card session pane, the card id for any other single-card
   * pane, and the pane id for a multi-card pane (the only stable identity a
   * stack has). Same sort rule as the lists it replaces — keys absent from
   * the list sort AFTER the ordered set, and stale keys are ignored.
   */
  cardsRowOrder: LensCardsRowOrder;
  /**
   * Persisted order of the Cards section's GROUPS — the runs themselves, moved
   * by carrying a group header. Empty until the user rearranges them, and
   * tolerant of drift in both directions: a name that is no longer a group is
   * ignored, and a group the list does not name renders in its built-in
   * position (`GROUP_ORDER` in `cards-groups.ts`), so adding a fourth group
   * never needs a migration.
   */
  cardsGroupOrder: readonly string[];
  /** Cards-section groups the user has collapsed. */
  collapsedCardGroups: readonly string[];
  /** Kinds the user has collapsed (band-only). */
  collapsedSections: readonly string[];
}
