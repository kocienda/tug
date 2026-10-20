/**
 * deck-cards — every card the arrangement holds, as a page reads a card it
 * does not show.
 *
 * The shell publishes `deck.cards` (`bus/declarations/deck.ts`): one record
 * per card, its kind, title, identity, phase and session. A body page shows
 * one card, and its page stores — `cardSessionBindingStore`,
 * `cardTitleStore`, `cardIdentityElsewhere`, `cardActivityElsewhere` — hold
 * only that card's entries. Every other card's they answer from the replica
 * through `otherDeckCard` (`lib/other-deck-cards.ts`, apart so the stores
 * import it without importing this module's title rule), so nothing is
 * copied into them and nothing crosses twice. In the shell, which shows
 * every card, the read answers nothing and each store keeps its own.
 *
 * A tab and a picker row name a card the same way in both pages:
 * {@link deckCardTabTitle} over its record, which is the rule
 * `cardTitleTextFor` applies to the shell's own stores.
 *
 * @module lib/deck-cards
 */

import type { CardRegistration } from "../card-registry";
import type { DeckCardFacts } from "../bus/declarations/deck";
import { composePaneTitleBarText } from "./pane-title";

export type { DeckCardFacts } from "../bus/declarations/deck";

/** A tab's label, and a picker row's: the card's live override, else its parked title, else its kind's. */
export function deckCardTabTitle(entry: DeckCardFacts, registration: CardRegistration | undefined): string {
  return composePaneTitleBarText({
    metaTitle: registration?.defaultMeta.title ?? "",
    titleOverride: entry.title ?? entry.parkedTitle,
  });
}

/** A tab's icon: its kind's. */
export function deckCardIcon(_entry: DeckCardFacts, registration: CardRegistration | undefined): string | null {
  return registration?.defaultMeta.icon ?? null;
}

/** The facts of a record each page store answers from. */
export type DeckCardFacet = "binding" | "title" | "identity" | "activity";

const FACET_FIELDS: Record<DeckCardFacet, ReadonlyArray<keyof DeckCardFacts>> = {
  binding: ["binding"],
  title: ["title", "masthead"],
  identity: ["identity"],
  activity: ["activity"],
};

/** The facets that moved between two replicas for any card but `ownCardId`. */
export function movedFacets(
  prev: Record<string, DeckCardFacts>,
  next: Record<string, DeckCardFacts>,
  ownCardId: string | null,
): Set<DeckCardFacet> {
  const moved = new Set<DeckCardFacet>();
  const ids = new Set([...Object.keys(prev), ...Object.keys(next)]);
  ids.delete(ownCardId ?? "");
  for (const facet of Object.keys(FACET_FIELDS) as DeckCardFacet[]) {
    for (const id of ids) {
      const a = prev[id];
      const b = next[id];
      if (FACET_FIELDS[facet].some((field) => JSON.stringify(a?.[field] ?? null) !== JSON.stringify(b?.[field] ?? null))) {
        moved.add(facet);
        break;
      }
    }
  }
  return moved;
}
