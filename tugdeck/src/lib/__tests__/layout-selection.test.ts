/**
 * layout-selection.test.ts — the menu's `column` fact ([P05], Spec S02).
 *
 * The fact exists so a Window-menu item is live exactly when its chord would
 * act, which makes the interesting cases the ones where the two could part: a
 * layout selection standing somewhere other than the fronted card, a cursor in
 * the Cards list with the Cards card itself holding the keyboard, and the ends of a
 * column where the verb refuses.
 *
 * The deck is a `DeckState` fixture read through the same two queries
 * `DeckManager` answers — `getSnapshot` and the active pane's active card —
 * because the ladder and the column math are the code under test, not the
 * store's mutation paths. The selection store and the cursor are the real
 * module singletons.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  cardsSelectionStore,
  setLayoutCursorCard,
} from "../../components/cards/cards-selection-store";
import { CARDS_CARD_ID } from "../cards-card-id";
import { resolveColumnMenuFact } from "../layout-selection";
import type { IDeckManagerStore } from "../../deck-manager-store";
import type { CardState, DeckState, TugPaneState } from "../../layout-tree";

function makeCard(id: string, componentId = "session"): CardState {
  return { id, componentId, title: id, closable: true };
}

function makePane(
  id: string,
  cardId: string,
  slot: number | undefined,
): TugPaneState {
  return {
    id,
    position: { x: 0, y: 0 },
    size: { width: 400, height: 300 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["standard"],
    ...(slot === undefined ? {} : { slot }),
  };
}

/**
 * A three-up deck: two panes stacked in slot 0, one alone in slot 1, and the
 * Cards card on its rail. `columns` overrides the arrangement of slot 0.
 */
function threeUp(overrides: Partial<DeckState> = {}): DeckState {
  return {
    cards: [
      makeCard("card-a"),
      makeCard("card-b"),
      makeCard("card-c"),
      makeCard(CARDS_CARD_ID, CARDS_CARD_ID),
    ],
    panes: [
      makePane("pane-a", "card-a", 0),
      makePane("pane-b", "card-b", 0),
      makePane("pane-c", "card-c", 1),
      makePane("pane-cards", CARDS_CARD_ID, undefined),
    ],
    imposition: { kind: "three-up", sidebars: { cards: { side: "right" } } },
    hasFocus: true,
    ...overrides,
  };
}

/** The two queries the ladder asks a store, over a fixture snapshot. */
function storeOver(state: DeckState): IDeckManagerStore {
  return {
    getSnapshot: () => state,
    getFirstResponderCardId: () => {
      if (state.activePaneId === undefined) return null;
      const pane = state.panes.find((p) => p.id === state.activePaneId);
      return pane?.activeCardId ?? null;
    },
  } as unknown as IDeckManagerStore;
}

afterEach(() => {
  cardsSelectionStore.clear();
  setLayoutCursorCard(null);
});

describe("resolveColumnMenuFact", () => {
  test("a layout selection outranks the fronted card", () => {
    // The fronted card stands alone in slot 1, which is stacked; the selection
    // stands in slot 0, which is split. The menu has to follow the selection,
    // because the chord does — and the two slots' modes are what make the
    // difference visible, since the title the item carries is read off `mode`.
    const deck = storeOver(
      threeUp({
        activePaneId: "pane-c",
        imposition: {
          kind: "three-up",
          sidebars: { cards: { side: "right" } },
          columns: { 0: { mode: "split" } },
        },
      }),
    );
    expect(resolveColumnMenuFact(deck)?.mode).toBe("stack");
    cardsSelectionStore.pickOnly("card-a");
    expect(resolveColumnMenuFact(deck)?.mode).toBe("split");
  });

  test("the Cards list's cursor answers when the Cards card holds the keyboard", () => {
    // The first responder here is the Cards card — a rail, which drops out — so
    // without the cursor rung the fact would be null and the five items dark
    // while the user arrows through the very list they mean to act on.
    const deck = storeOver(threeUp({ activePaneId: "pane-cards" }));
    expect(resolveColumnMenuFact(deck)).toBeNull();
    setLayoutCursorCard("card-a");
    expect(resolveColumnMenuFact(deck)?.mode).toBe("stack");
  });

  test("no content card resolves to null, not to a false-filled fact", () => {
    // Null and all-false are different sentences: null is "there is nothing
    // to act on", which is what a deselected deck holds.
    expect(resolveColumnMenuFact(storeOver(threeUp()))).toBeNull();
  });

  test("a free deck has no column, whatever is selected", () => {
    const state = threeUp({ activePaneId: "pane-a" });
    const free = storeOver({ ...state, imposition: { sidebars: {} } });
    expect(resolveColumnMenuFact(free)).toBeNull();
  });

  test("a column of one has nowhere to travel, but still names its mode", () => {
    // `mode` is a fact about the place, not about how many cards fill it: a
    // slot one card deep is stacked until someone splits it, and splitting it
    // is a legal act the menu must be willing to name.
    const deck = storeOver(threeUp({ activePaneId: "pane-c" }));
    expect(resolveColumnMenuFact(deck)).toEqual({
      mode: "stack",
      canMoveUp: false,
      canMoveDown: false,
    });
  });

  test("a split column refuses at its ends, in member order", () => {
    const state = threeUp({
      activePaneId: "pane-a",
      imposition: {
        kind: "three-up",
        sidebars: { cards: { side: "right" } },
        columns: { 0: { mode: "split", order: ["pane-b", "pane-a"] } },
      },
    });
    // `pane-a` is the bottom member: it can rise, and it has nowhere to fall.
    expect(resolveColumnMenuFact(storeOver(state))).toEqual({
      mode: "split",
      canMoveUp: true,
      canMoveDown: false,
    });
    cardsSelectionStore.pickOnly("card-b");
    expect(resolveColumnMenuFact(storeOver(state))).toEqual({
      mode: "split",
      canMoveUp: false,
      canMoveDown: true,
    });
  });

  test("a stacked column travels in z, front-first", () => {
    // Stacked, nothing is above anything, so "up" is toward the front and the
    // order is the panes array reversed. `pane-b` is last in that array —
    // frontmost — so it cannot rise.
    const deck = storeOver(threeUp({ activePaneId: "pane-b" }));
    expect(resolveColumnMenuFact(deck)).toEqual({
      mode: "stack",
      canMoveUp: false,
      canMoveDown: true,
    });
  });
});
