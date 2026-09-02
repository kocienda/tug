/**
 * Pure reducer for the Cards store. No side effects, no DOM, no tugbank — the
 * class wrapper drives persistence on top of this reducer.
 *
 * Reference stability: when an event produces no observable change the
 * reducer returns the SAME state reference (and each list keeps its own
 * reference) so `useSyncExternalStore` consumers don't observe spurious
 * notifications.
 *
 * @module components/cards/cards-store/reducer
 */

import type { CardsGroup } from "@/components/cards/cards-groups";
import type { CardsRowOrder, CardsSnapshot } from "./types";

/**
 * Reducer-internal state. Currently identical to the public snapshot,
 * kept distinct so future internal fields don't leak through
 * `getSnapshot`.
 */
export interface CardsState {
  cardsRowOrder: CardsRowOrder;
  cardsGroupOrder: readonly string[];
  collapsedCardGroups: readonly string[];
}

export type CardsEvent =
  | {
      type: "set_cards_row_order";
      group: CardsGroup;
      order: readonly string[];
    }
  | { type: "set_cards_group_order"; order: readonly string[] }
  | {
      type: "set_cards_group_collapsed";
      group: CardsGroup;
      collapsed: boolean;
    }
  | {
      /**
       * Apply hydrated values from tugbank. Each field is optional — a
       * missing key keeps the existing in-state value. Malformed values
       * (e.g. a non-array `cardsGroupOrder`) are rejected by the reader
       * before reaching here.
       */
      type: "hydrate";
      cardsRowOrder?: CardsRowOrder;
      cardsGroupOrder?: readonly string[];
      collapsedCardGroups?: readonly string[];
    };

export function createInitialState(): CardsState {
  return {
    cardsRowOrder: EMPTY_CARDS_ROW_ORDER,
    cardsGroupOrder: [],
    collapsedCardGroups: [],
  };
}

/** Every group present and empty — the shape a fresh install starts from. */
export const EMPTY_CARDS_ROW_ORDER: CardsRowOrder = {
  sessions: [],
  files: [],
  tools: [],
};

/**
 * Merge one group's list into a row-order record, keeping BOTH the record's
 * and every other group's list reference when nothing observable changed.
 * Per-group stability is what lets a run that reads a single group re-render
 * only when that group actually moved.
 */
function withGroupOrder(
  record: CardsRowOrder,
  group: CardsGroup,
  order: readonly string[],
): CardsRowOrder {
  if (listsEqual(record[group], order)) return record;
  return { ...record, [group]: [...order] };
}

/** Value-equality over a row-order record, group by group. */
function rowOrdersEqual(a: CardsRowOrder, b: CardsRowOrder): boolean {
  if (a === b) return true;
  return (
    listsEqual(a.sessions, b.sessions) &&
    listsEqual(a.files, b.files) &&
    listsEqual(a.tools, b.tools)
  );
}

/** Shallow value-equality for two string lists. */
function listsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Toggle a name's membership in a list. Returns the SAME reference when
 * the membership already matches the desired state.
 */
function withMembership(
  list: readonly string[],
  name: string,
  member: boolean,
): readonly string[] {
  const present = list.includes(name);
  if (present === member) return list;
  if (member) return [...list, name];
  return list.filter((k) => k !== name);
}

/**
 * Pure reducer. Returns the same state reference when an event
 * produces no observable change.
 */
export function reduce(state: CardsState, event: CardsEvent): CardsState {
  switch (event.type) {
    case "set_cards_row_order": {
      const next = withGroupOrder(
        state.cardsRowOrder,
        event.group,
        event.order,
      );
      if (next === state.cardsRowOrder) return state;
      return { ...state, cardsRowOrder: next };
    }

    case "set_cards_group_order": {
      if (listsEqual(state.cardsGroupOrder, event.order)) return state;
      return { ...state, cardsGroupOrder: [...event.order] };
    }

    case "set_cards_group_collapsed": {
      const next = withMembership(
        state.collapsedCardGroups,
        event.group,
        event.collapsed,
      );
      if (next === state.collapsedCardGroups) return state;
      return { ...state, collapsedCardGroups: next };
    }

    case "hydrate": {
      let next = state;
      const bump = (): void => {
        next = next === state ? { ...state } : next;
      };
      if (
        event.cardsRowOrder !== undefined &&
        !rowOrdersEqual(state.cardsRowOrder, event.cardsRowOrder)
      ) {
        bump();
        next.cardsRowOrder = {
          sessions: [...event.cardsRowOrder.sessions],
          files: [...event.cardsRowOrder.files],
          tools: [...event.cardsRowOrder.tools],
        };
      }
      if (
        event.cardsGroupOrder !== undefined &&
        !listsEqual(state.cardsGroupOrder, event.cardsGroupOrder)
      ) {
        bump();
        next.cardsGroupOrder = [...event.cardsGroupOrder];
      }
      if (
        event.collapsedCardGroups !== undefined &&
        !listsEqual(state.collapsedCardGroups, event.collapsedCardGroups)
      ) {
        bump();
        next.collapsedCardGroups = [...event.collapsedCardGroups];
      }
      return next;
    }

    default:
      return state;
  }
}

/**
 * Project the reducer state into the public snapshot. Returns the same
 * reference when the input is unchanged so `useSyncExternalStore`
 * consumers stay quiescent.
 */
export function toSnapshot(state: CardsState): CardsSnapshot {
  return state;
}
