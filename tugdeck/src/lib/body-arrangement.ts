/**
 * The shell's arrangement, projected for the bodies that read it.
 *
 * A card whose registration says `bodyDeck: "arrangement"` — the Cards card,
 * the Layout card — reads more than its own card: every pane, every
 * workspace, the band's width, and the session identity and title of every
 * card it lists. In the shell those are the deck's and the app stores'; in a
 * body they are not there at all. So the shell projects them into the
 * arrangement stores (`bus/declarations/arrangement.ts`), one projector per
 * store, and the body's deck bridge answers the card's reads from the
 * replicas ({@link arrangementSnapshot} and the spaces fields). Every card's
 * binding and reported phase go to every body the same way.
 *
 * Everything here is plain JSON over plain data.
 *
 * @module lib/body-arrangement
 */

import type { DeckState } from "../layout-tree";
import type { CardIdentityFacts } from "../card-registry";
import type { IDeckManagerStore } from "../deck-manager-store";
import type { CardSessionBinding } from "./card-session-binding-store";
import type {
  ArrangementCardFacts,
  ArrangementDeckValue,
  ArrangementSpaces,
  ArrangementTitle,
} from "../bus/declarations/arrangement";

/** What the projectors read from the shell's deck. */
export type ArrangementDeck = Pick<
  IDeckManagerStore,
  | "getSnapshot"
  | "getSpacesSnapshot"
  | "getSpaceDeck"
  | "spaceHoldsLiveSessions"
  | "spaceCardCount"
  | "getBandWidth"
  | "getColumnRunHeight"
  | "getRailRunHeight"
>;

/**
 * Every card the arrangement holds — every workspace's — in a stable order.
 */
export function arrangementCardIds(deck: ArrangementDeck): string[] {
  const spacesSnapshot = deck.getSpacesSnapshot();
  const states: DeckState[] = [deck.getSnapshot()];
  for (const space of spacesSnapshot.spaces) {
    if (space.id === spacesSnapshot.activeSpaceId) continue;
    const parked = deck.getSpaceDeck(space.id);
    if (parked !== null) states.push(parked);
  }
  const cardIds = new Set<string>();
  for (const state of states) for (const card of state.cards) cardIds.add(card.id);
  return [...cardIds];
}

/** Each of `cardIds` `read` answers non-null for, keyed by card. */
function collect<T>(cardIds: readonly string[], read: (cardId: string) => T | null | undefined): Record<string, T> {
  const out: Record<string, T> = {};
  for (const cardId of cardIds) {
    const value = read(cardId);
    if (value !== null && value !== undefined) out[cardId] = value;
  }
  return out;
}

/** `deck.cardBindings`: the binding of every card the arrangement holds that has one. */
export function projectBindings(
  deck: ArrangementDeck,
  bindings: (cardId: string) => CardSessionBinding | undefined,
): Record<string, CardSessionBinding> {
  return collect(arrangementCardIds(deck), bindings);
}

/**
 * `deck.cardActivities`: the reported phase of every card the arrangement
 * holds that has one. A card whose body has not reported is absent, never
 * idle by assumption.
 */
export function projectActivities(
  deck: ArrangementDeck,
  activities: (cardId: string) => string | null,
): Record<string, string> {
  return collect(arrangementCardIds(deck), activities);
}

/** `arrangement.deck`: the live deck and its band. */
export function projectArrangementDeck(deck: ArrangementDeck): ArrangementDeckValue {
  return {
    deck: deck.getSnapshot(),
    bandWidth: deck.getBandWidth(),
    columnRunHeight: deck.getColumnRunHeight(),
    railRunHeight: deck.getRailRunHeight(),
  };
}

/** `arrangement.spaces`: every workspace, and every workspace's deck but the live one. */
export function projectArrangementSpaces(deck: ArrangementDeck): ArrangementSpaces {
  const spacesSnapshot = deck.getSpacesSnapshot();
  const decks: Record<string, DeckState> = {};
  const liveSessions: Record<string, number> = {};
  const cardCounts: Record<string, number> = {};
  for (const space of spacesSnapshot.spaces) {
    liveSessions[space.id] = deck.spaceHoldsLiveSessions(space.id);
    cardCounts[space.id] = deck.spaceCardCount(space.id);
    if (space.id === spacesSnapshot.activeSpaceId) continue;
    const parked = deck.getSpaceDeck(space.id);
    if (parked !== null) decks[space.id] = parked;
  }
  return {
    activeSpaceId: spacesSnapshot.activeSpaceId,
    spaces: spacesSnapshot.spaces.map((s) => ({
      id: s.id,
      name: s.name,
      ...(s.theme !== undefined ? { theme: s.theme } : {}),
    })),
    mountedSpaceIds: [...spacesSnapshot.mountedSpaceIds],
    decks,
    liveSessions,
    cardCounts,
  };
}

/** `arrangement.cardFacts`: the title and live identity of every card the arrangement holds, and of no other. */
export function projectArrangementCardFacts(
  deck: ArrangementDeck,
  titles: (cardId: string) => ArrangementTitle | null,
  identities: (cardId: string) => CardIdentityFacts | null,
): ArrangementCardFacts {
  const cardIds = arrangementCardIds(deck);
  return { titles: collect(cardIds, titles), identities: collect(cardIds, identities) };
}

/**
 * The arrangement's deck as the body holding `cardId` sees it: the shell's,
 * with the pane holding the card re-keyed to the body's own pane id, which is
 * the id the body's card host registers its elements under.
 * The pane-keyed marks that name it — the active pane, the bullseye, the
 * arrival — follow it.
 */
export function arrangementSnapshot(deck: DeckState, cardId: string, bodyPaneId: string): DeckState {
  const own = deck.panes.find((p) => p.cardIds.includes(cardId))?.id;
  if (own === undefined) return deck;
  const rekey = (id: string): string => (id === own ? bodyPaneId : id);
  return {
    ...deck,
    panes: deck.panes.map((p) => (p.id === own ? { ...p, id: bodyPaneId } : p)),
    ...(deck.activePaneId !== undefined ? { activePaneId: rekey(deck.activePaneId) } : {}),
    ...(deck.bullseyePaneId !== undefined ? { bullseyePaneId: rekey(deck.bullseyePaneId) } : {}),
    ...(deck.arriving !== undefined
      ? { arriving: Object.fromEntries(Object.keys(deck.arriving).map((id) => [rekey(id), true as const])) }
      : {}),
  };
}
