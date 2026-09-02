/**
 * cards-groups.ts — which group a card's pane row files under in the Cards card.
 *
 * The Cards card is a mirror of the deck canvas, and it buckets pane
 * rows into three groups: Sessions, Files, Tools. The bucket is read off the
 * card registry rather than from a table kept here, so a card type declares its
 * own Cards card home the same way it declares its type-picker category.
 *
 * Resolution runs in three steps, first hit wins:
 *
 *   1. an explicit `cardsGroup` on the registration
 *   2. `category.label === "Files"` → `"files"` (the type-picker taxonomy
 *      already says so — the Diff card is registered exactly this way)
 *   3. `"tools"`
 *
 * The final fallback makes coverage total by construction: a card type cannot
 * be registered without resolving somewhere. `__tests__/cards-groups.test.ts`
 * then pins the specific mapping for every registration so drift is caught.
 *
 * @module components/cards/cards-groups
 */

import type { CardRegistration } from "@/card-registry";

/** A group in the Cards card. */
export type CardsGroup = "sessions" | "files" | "tools";

/**
 * The order groups render in before the user has moved any. Sessions above
 * Files reproduces the order the two retired sections stood in, so the section
 * reads as a refinement of what was there rather than a rearrangement.
 */
export const GROUP_ORDER: readonly CardsGroup[] = [
  "sessions",
  "files",
  "tools",
];

/** Whether `name` is a live group — the guard the persisted order is read through. */
export function isCardsGroup(name: string): name is CardsGroup {
  return (GROUP_ORDER as readonly string[]).includes(name);
}

/**
 * The groups in the order they render, given the user's persisted arrangement.
 *
 * Tolerant in both directions, so the persisted list never needs a migration: a
 * name that is no longer a group is dropped, and a group the list does not
 * mention trails the ones it does, in declaration order. Trailing rather than
 * slotting in beside a declared neighbour is deliberate — once the user has
 * rearranged, declaration order says nothing about where they would want a new
 * group, and the bottom is the one place that never displaces an arrangement
 * they made. It is also where a group they have never seen is easiest to find.
 */
export function orderedGroups(
  persisted: readonly string[],
): readonly CardsGroup[] {
  const named: CardsGroup[] = [];
  for (const name of persisted) {
    if (isCardsGroup(name) && !named.includes(name)) named.push(name);
  }
  if (named.length === 0) return GROUP_ORDER;
  return [...named, ...GROUP_ORDER.filter((g) => !named.includes(g))];
}

/** Display titles for the group header rows. */
export const GROUP_TITLES: Readonly<Record<CardsGroup, string>> = {
  sessions: "Sessions",
  files: "Files",
  tools: "Tools",
};

/**
 * The group `reg`'s cards file under, or `"none"` for a card that has no Cards card
 * representation at all (the Cards card itself — the mirror does not reflect itself).
 */
export function resolveCardsGroup(
  reg: CardRegistration,
): CardsGroup | "none" {
  if (reg.cardsGroup !== undefined) return reg.cardsGroup;
  if (reg.category?.label === "Files") return "files";
  return "tools";
}
