/**
 * The shell's arrangement, projected for the bodies that read it.
 *
 * A card whose registration says `bodyDeck: "arrangement"` — the Cards card,
 * the Layout card — reads more than its own card: every pane, every
 * workspace, the band's width. In the shell those are the deck's; in a body
 * they are not there at all. So the shell projects them into the arrangement
 * stores (`bus/declarations/arrangement.ts`), one projector per store, and
 * the body's deck answers the card's reads from the replicas
 * ({@link arrangementSnapshot} and the spaces fields). What every page reads
 * of a card it does not show — its kind, title, identity, phase, session —
 * goes to every body as one record per card ({@link projectDeckCards}).
 *
 * Everything here is plain JSON over plain data.
 *
 * @module lib/body-arrangement
 */

import type { DeckState } from "../layout-tree";
import type { IDeckManagerStore } from "../deck-manager-store";
import type { ArrangementDeckValue, ArrangementSpaces } from "../bus/declarations/arrangement";
import type { DeckCardFacts } from "../bus/declarations/deck";

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

/** Every card the arrangement holds — every workspace's — in a stable order, with its kind. */
function arrangementCards(deck: ArrangementDeck): Array<{ id: string; componentId: string }> {
  const spacesSnapshot = deck.getSpacesSnapshot();
  const states: DeckState[] = [deck.getSnapshot()];
  for (const space of spacesSnapshot.spaces) {
    if (space.id === spacesSnapshot.activeSpaceId) continue;
    const parked = deck.getSpaceDeck(space.id);
    if (parked !== null) states.push(parked);
  }
  const cards = new Map<string, string>();
  for (const state of states) for (const card of state.cards) if (!cards.has(card.id)) cards.set(card.id, card.componentId);
  return [...cards].map(([id, componentId]) => ({ id, componentId }));
}

/** Every card the arrangement holds — every workspace's — in a stable order. */
export function arrangementCardIds(deck: ArrangementDeck): string[] {
  return arrangementCards(deck).map((card) => card.id);
}

/** What {@link projectDeckCards} reads of each card beyond the deck. */
export type DeckCardReaders = { [K in Exclude<keyof DeckCardFacts, "componentId">]: (cardId: string) => DeckCardFacts[K] };

/** `deck.cards`: every card the arrangement holds, by id, with what the shell knows of it. */
export function projectDeckCards(deck: ArrangementDeck, readers: DeckCardReaders): Record<string, DeckCardFacts> {
  const out: Record<string, DeckCardFacts> = {};
  for (const { id, componentId } of arrangementCards(deck)) {
    out[id] = {
      componentId,
      title: readers.title(id),
      masthead: readers.masthead(id),
      identity: readers.identity(id),
      activity: readers.activity(id),
      binding: readers.binding(id),
      parkedTitle: readers.parkedTitle(id),
      waivesClose: readers.waivesClose(id),
    };
  }
  return out;
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
