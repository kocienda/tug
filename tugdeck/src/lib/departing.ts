/**
 * The DEPARTING mark's pure helpers — how a closed pane stays in the
 * published deck for the one settle that carries it out, and how a reader
 * that lists or counts sees past it.
 *
 * The deck manager's working deck is the STANDING deck: it never holds a
 * departing pane, so no mutation can count, re-slot or re-divide one. The
 * closed panes wait in a record beside it, and the snapshot the store
 * publishes is the two composed ({@link composeDeparting}). Every reader
 * outside the manager therefore gets the composed deck, and splits by what it
 * asks:
 *
 * - a reader that LISTS or COUNTS panes or cards — the solver's chokepoints,
 *   rail membership, the ring, the menus, the lists — begins with
 *   {@link standingDeck}, so a departing pane is invisible to it;
 * - a reader that looks up ONE pane or card by id stays on the composed deck,
 *   so a departing card's own content still finds itself, unchanged, for the
 *   length of its fade.
 *
 * Pure: no DOM, no store.
 */

import type { CardState, DeckState, TugPaneState } from "../layout-tree";

/** One closed pane held for its settle, as the deck manager records it. */
export interface DepartingEntry {
  readonly pane: TugPaneState;
  readonly cards: readonly CardState[];
  /** The pane's index in `panes` when it was marked; composition re-inserts it there (clamped). */
  readonly index: number;
}

/**
 * `standing` with every entry's pane re-inserted at its index, its cards
 * appended, and `departing` naming them. Identity when `entries` is empty.
 *
 * `entries` is in marking order. Each entry's index was read from the
 * standing deck as it stood when that pane closed, which already lacked every
 * earlier entry, so the entries are re-inserted LATEST FIRST: that undoes the
 * closes in reverse and puts every pane back at the position it left, which
 * is what `buildZIndexMap` reads its stacking from. An index past the end is
 * clamped to it.
 */
export function composeDeparting(
  standing: DeckState,
  entries: readonly DepartingEntry[],
): DeckState {
  if (entries.length === 0) return standing;
  const panes = [...standing.panes];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    panes.splice(Math.min(Math.max(entry.index, 0), panes.length), 0, entry.pane);
  }
  const departing: Record<string, true> = { ...standing.departing };
  for (const entry of entries) departing[entry.pane.id] = true;
  return {
    ...standing,
    panes,
    cards: [...standing.cards, ...entries.flatMap((entry) => entry.cards)],
    departing,
  };
}

const standingMemo = new WeakMap<DeckState, DeckState>();

/**
 * `state` without its departing panes, their cards, and the `departing`
 * field — the deck as if every close had already landed. Identity when
 * `state.departing` is absent, and the same object across calls on one
 * `state`, so a reader that memoizes on its deck's identity keeps doing so.
 *
 * Use it at the entry of any reader that lists or counts. A reader that looks
 * one pane or card up by id should not: the departing card's own content
 * reads itself that way.
 */
export function standingDeck(state: DeckState): DeckState {
  const marks = state.departing;
  if (marks === undefined) return state;
  const memo = standingMemo.get(state);
  if (memo !== undefined) return memo;
  const leaving = new Set<string>();
  for (const pane of state.panes) {
    if (marks[pane.id] === true) for (const cardId of pane.cardIds) leaving.add(cardId);
  }
  const { departing: _departing, ...rest } = state;
  const standing: DeckState = {
    ...rest,
    panes: state.panes.filter((pane) => marks[pane.id] !== true),
    cards: state.cards.filter((card) => !leaving.has(card.id)),
  };
  standingMemo.set(state, standing);
  return standing;
}

const asIfStandingMemo = new WeakMap<DeckState, DeckState>();

/**
 * `state` with the `departing` field removed and the panes kept — the deck as
 * if every departing pane still stood. Identity when absent.
 *
 * This is the deck a departing pane's own by-id facts are read over, so its
 * badge and placement do not change in the middle of its fade.
 */
export function withDepartingStanding(state: DeckState): DeckState {
  if (state.departing === undefined) return state;
  const memo = asIfStandingMemo.get(state);
  if (memo !== undefined) return memo;
  const { departing: _departing, ...rest } = state;
  asIfStandingMemo.set(state, rest);
  return rest;
}

/** True when `paneId` is marked departing in `state`. */
export function isPaneDeparting(state: DeckState, paneId: string): boolean {
  return state.departing?.[paneId] === true;
}
