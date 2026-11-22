/**
 * Public types for the Cards store — the persisted presentation state of the
 * Cards card's rows: their order within each group, the order of the groups
 * themselves, which groups the user has collapsed, and which workspaces.
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

/**
 * How the card arranges its rows. `workspaces` mirrors the deck: one header
 * per workspace with its Sessions, Files and Tools under it. `activity` puts
 * the things first and their place second: one flat Sessions list and one
 * flat Files list across every workspace, newest first.
 */
export type CardsView = "workspaces" | "activity";

/** Every view, in the order the card's `View:` popup offers them. */
export const CARDS_VIEWS: readonly CardsView[] = ["workspaces", "activity"];

/** Whether a persisted value names a view this build knows. */
export function isCardsView(value: unknown): value is CardsView {
  return value === "workspaces" || value === "activity";
}

/** Individual key names within the domain. */
export const CARDS_KEYS = {
  CARDS_ROW_ORDER: "cardsRowOrder",
  CARDS_GROUP_ORDER: "cardsGroupOrder",
  CARDS_COLLAPSED_GROUPS: "cardsCollapsedGroups",
  CARDS_COLLAPSED_SPACES: "cardsCollapsedSpaces",
  CARDS_FILTER_QUERY: "cardsFilterQuery",
  CARDS_VIEW: "cardsView",
  CARDS_ACTIVITY_COLLAPSED_GROUPS: "cardsActivityCollapsedGroups",
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
  /**
   * Groups the user has collapsed, one entry per workspace and group — the
   * run key `groupRunKey(spaceId, group)`. A fold is per workspace, so the
   * same group can be open in one and folded in another.
   */
  collapsedCardGroups: readonly string[];
  /**
   * Workspaces the user has folded shut, by space id. Expanded is the default,
   * so an empty list is the whole list open; every workspace can be in it, the
   * active one included ([B02]). Persisted, so a relaunch brings the list
   * back the way the user left it.
   */
  collapsedSpaces: readonly string[];
  /**
   * The filter field's query. One fact for the deck, not one per card: every
   * workspace mounts its own Workspaces card, and a list that filtered
   * differently in each would hand the reader a different list at every
   * switch. Empty is no filter. Persisted beside the folds, which is also how
   * every card's page hears a query typed in another.
   */
  filterQuery: string;
  /**
   * Which arrangement the card shows. One fact for the deck, like the filter:
   * every workspace mounts its own Workspaces card, and a switch of workspace
   * that also switched the view would read as the card forgetting. Persisted
   * beside the folds, so the card reopens in the view it was left in.
   */
  view: CardsView;
  /**
   * The Activity view's folded groups, by bare group name (`sessions`,
   * `files`). Apart from {@link collapsedCardGroups} because Activity's two
   * groups belong to no workspace: folding Files in Activity says nothing
   * about any workspace's Files, and the reverse.
   */
  activityCollapsedGroups: readonly string[];
}
