/**
 * deck-store-selectors.test.ts — unit tests for the pure predicates
 * in `deck-store-selectors.ts` ([A1]).
 *
 * These tests operate on hand-built `DeckState` fixtures rather than
 * spinning up a DeckManager, because the selector is pure by design.
 * Hook-level / subscription-level coverage lives next door in
 * `use-focus-destination.test.tsx`.
 */

import { describe, test, expect } from "bun:test";
import type { CardState, DeckState, TugPaneState } from "../layout-tree";
import {
  bullseyePaneIdOf,
  columnBadgeFactsOf,
  deckColumnsOf,
  deckFlowStrip,
  isFocusDestination,
  slotStackOf,
} from "../deck-store-selectors";


function makeCard(id: string, componentId = "probe"): CardState {
  return { id, componentId, title: id, closable: true };
}

function makePane(
  id: string,
  cardIds: string[],
  activeCardId: string,
): TugPaneState {
  return {
    id,
    position: { x: 0, y: 0 },
    size: { width: 400, height: 300 },
    cardIds,
    activeCardId,
    title: "",
    acceptsFamilies: ["standard"],
  };
}

function baseState(): DeckState {
  return {
    cards: [makeCard("card-a"), makeCard("card-b"), makeCard("card-c")],
    panes: [
      makePane("pane-1", ["card-a", "card-b"], "card-a"),
      makePane("pane-2", ["card-c"], "card-c"),
    ],
    activePaneId: "pane-1",
    imposition: { sidebars: { tripwires: { side: "right" } } },
    hasFocus: true,
  };
}

describe("isFocusDestination", () => {
  test("returns true when all three conditions hold (active pane, active card, foreground)", () => {
    expect(isFocusDestination("card-a", baseState())).toBe(true);
  });

  test("returns false when the app is not foreground (hasFocus === false)", () => {
    const state: DeckState = { ...baseState(), hasFocus: false };
    expect(isFocusDestination("card-a", state)).toBe(false);
  });

  test("returns false when the card's pane is not the active pane", () => {
    // card-c lives in pane-2, but activePaneId === "pane-1".
    expect(isFocusDestination("card-c", baseState())).toBe(false);
  });

  test("returns false when the pane is active but the card is not the pane's active card", () => {
    // card-b lives in pane-1 (active) but pane-1.activeCardId === "card-a".
    expect(isFocusDestination("card-b", baseState())).toBe(false);
  });

  test("returns false for an unknown cardId", () => {
    expect(isFocusDestination("not-a-card", baseState())).toBe(false);
  });

  test("returns false when activePaneId is undefined", () => {
    const state: DeckState = { ...baseState(), activePaneId: undefined };
    expect(isFocusDestination("card-a", state)).toBe(false);
  });

  test("is pure — the same inputs produce the same output", () => {
    const s = baseState();
    const a = isFocusDestination("card-a", s);
    const b = isFocusDestination("card-a", s);
    expect(a).toBe(b);
    expect(a).toBe(true);
  });

  test("flipping the active pane shifts the focus destination", () => {
    const s1 = baseState();
    expect(isFocusDestination("card-a", s1)).toBe(true);
    expect(isFocusDestination("card-c", s1)).toBe(false);

    const s2: DeckState = { ...s1, activePaneId: "pane-2" };
    expect(isFocusDestination("card-a", s2)).toBe(false);
    expect(isFocusDestination("card-c", s2)).toBe(true);
  });

  test("flipping pane.activeCardId within the active pane shifts the destination", () => {
    const s1 = baseState();
    expect(isFocusDestination("card-a", s1)).toBe(true);
    expect(isFocusDestination("card-b", s1)).toBe(false);

    const s2: DeckState = {
      ...s1,
      panes: s1.panes.map((p) =>
        p.id === "pane-1" ? { ...p, activeCardId: "card-b" } : p,
      ),
    };
    expect(isFocusDestination("card-a", s2)).toBe(false);
    expect(isFocusDestination("card-b", s2)).toBe(true);
  });
});

describe("slotStackOf", () => {
  function slottedState(): DeckState {
    const s = baseState();
    return {
      ...s,
      cards: [...s.cards, makeCard("card-d")],
      panes: [
        { ...makePane("pane-1", ["card-a", "card-b"], "card-a"), slot: 0 },
        { ...makePane("pane-2", ["card-c"], "card-c"), slot: 2 },
        { ...makePane("pane-3", ["card-d"], "card-d"), slot: 0 },
        makePane("pane-free", ["card-a"], "card-a"),
      ],
    };
  }

  test("returns the panes of a slot in array order (last topmost)", () => {
    const stack = slotStackOf(slottedState(), 0);
    expect(stack.map((p) => p.id)).toEqual(["pane-1", "pane-3"]);
  });

  test("returns a single-element stack for a slot one pane holds alone", () => {
    expect(slotStackOf(slottedState(), 2).map((p) => p.id)).toEqual(["pane-2"]);
  });

  test("returns [] for an unoccupied slot", () => {
    expect(slotStackOf(slottedState(), 1)).toEqual([]);
  });

  test("returns [] for an undefined slot — a free pane stands in no stack", () => {
    expect(slotStackOf(slottedState(), undefined)).toEqual([]);
  });

  test("excludes panes holding other slots and panes holding none", () => {
    const stack = slotStackOf(slottedState(), 0);
    expect(stack.some((p) => p.id === "pane-2")).toBe(false);
    expect(stack.some((p) => p.id === "pane-free")).toBe(false);
  });
});

describe("bullseyePaneIdOf", () => {
  function bullseyed(paneId: string): DeckState {
    return { ...baseState(), bullseyePaneId: paneId };
  }

  test("returns the id when the pane exists and hosts the first responder", () => {
    expect(bullseyePaneIdOf(bullseyed("pane-1"))).toBe("pane-1");
  });

  test("returns null when nothing is bullseyed", () => {
    expect(bullseyePaneIdOf(baseState())).toBeNull();
  });

  test("returns null when the pane was removed from the deck", () => {
    const state: DeckState = {
      ...bullseyed("pane-1"),
      cards: [makeCard("card-c")],
      panes: [makePane("pane-2", ["card-c"], "card-c")],
      activePaneId: "pane-2",
    };
    expect(bullseyePaneIdOf(state)).toBeNull();
  });

  test("returns null when activePaneId is undefined — the canvas-background deselect", () => {
    const state: DeckState = { ...bullseyed("pane-1"), activePaneId: undefined };
    expect(bullseyePaneIdOf(state)).toBeNull();
  });

  test("returns null when focus moved to another pane, leaving the raw id stale", () => {
    const state: DeckState = { ...bullseyed("pane-1"), activePaneId: "pane-2" };
    expect(bullseyePaneIdOf(state)).toBeNull();
    // The raw field is untouched — it is unreadable, not cleared.
    expect(state.bullseyePaneId).toBe("pane-1");
  });

  test("holds across a tab switch inside the bullseyed pane — the pane hosts the responder, not one card", () => {
    const state = bullseyed("pane-1");
    const switched: DeckState = {
      ...state,
      panes: state.panes.map((p) =>
        p.id === "pane-1" ? { ...p, activeCardId: "card-b" } : p,
      ),
    };
    expect(bullseyePaneIdOf(switched)).toBe("pane-1");
  });

  test("is pure — the same snapshot answers the same way twice", () => {
    const s = bullseyed("pane-1");
    expect(bullseyePaneIdOf(s)).toBe(bullseyePaneIdOf(s));
    expect(s.bullseyePaneId).toBe("pane-1");
  });
});

describe("deckColumnsOf", () => {
  /** A three-up deck whose slots hold the panes named, at the widths named. */
  function slottedState(
    slots: Record<string, { slot: number; width: number }>,
    imposition: Partial<DeckState["imposition"]> = {},
  ): DeckState {
    const ids = Object.keys(slots);
    return {
      cards: ids.map((id) => makeCard(`card-${id}`)),
      panes: ids.map((id) => ({
        ...makePane(id, [`card-${id}`], `card-${id}`),
        slot: slots[id].slot,
        size: { width: slots[id].width, height: 300 },
      })),
      imposition: {
        kind: "three-up",
        sidebars: { tripwires: { side: "right" } },
        ...imposition,
      },
      hasFocus: true,
    };
  }

  test("a free deck has no columns", () => {
    // A slot is a place in an arrangement, and a deck with no imposition has
    // none — not even for the panes carrying a stale slot from a previous one.
    const state = slottedState({ "pane-a": { slot: 0, width: 800 } });
    expect(deckColumnsOf({ ...state, imposition: { sidebars: {} } })).toEqual([]);
  });

  test("one column per OCCUPIED slot, in slot order", () => {
    const columns = deckColumnsOf(
      slottedState({
        "pane-c": { slot: 2, width: 800 },
        "pane-a": { slot: 0, width: 800 },
      }),
    );
    expect(columns.map((c) => c.slot)).toEqual([0, 2]);
    // Slot 1 is empty, and an empty place has nothing to arrange.
    expect(columns.every((c) => c.members.length === 1)).toBe(true);
  });

  test("a stacked column has no seams", () => {
    // A stack has no gaps to place: every member draws the same rect and
    // z-order decides which you see.
    const columns = deckColumnsOf(
      slottedState({
        "pane-a": { slot: 0, width: 800 },
        "pane-b": { slot: 0, width: 800 },
      }),
    );
    expect(columns[0].mode).toBe("stack");
    expect(columns[0].seams).toEqual([]);
    expect(columns[0].members.length).toBe(2);
  });

  test("a split column divides at its stored weights", () => {
    const columns = deckColumnsOf(
      slottedState(
        {
          "pane-a": { slot: 0, width: 800 },
          "pane-b": { slot: 0, width: 800 },
        },
        {
          columns: {
            0: {
              mode: "split",
              order: ["pane-a", "pane-b"],
              shares: { "pane-a": 3, "pane-b": 1 },
            },
          },
        },
      ),
    );
    expect(columns[0].members).toEqual(["pane-a", "pane-b"]);
    expect(columns[0].seams).toEqual([0.75]);
  });

  test("the fallback order is NOT the panes array's order", () => {
    // The panes array is z-order and `activateCard` rewrites it. Taking it
    // here would make two unarranged members of a split column trade places
    // when the user clicked the lower one. The same state with the array
    // reversed must read the same column.
    const state = slottedState(
      {
        "pane-b": { slot: 0, width: 800 },
        "pane-a": { slot: 0, width: 800 },
      },
      { columns: { 0: { mode: "split" } } },
    );
    const raised: DeckState = { ...state, panes: [...state.panes].reverse() };
    expect(deckColumnsOf(state)[0].members).toEqual(
      deckColumnsOf(raised)[0].members,
    );
  });

  test("a stored order governs, and residue leaves no hole", () => {
    const columns = deckColumnsOf(
      slottedState(
        {
          "pane-a": { slot: 0, width: 800 },
          "pane-b": { slot: 0, width: 800 },
        },
        {
          columns: {
            0: { mode: "split", order: ["closed-long-ago", "pane-b", "pane-a"] },
          },
        },
      ),
    );
    expect(columns[0].members).toEqual(["pane-b", "pane-a"]);
    // Two members, one seam — the gone pane contributes no gap.
    expect(columns[0].seams.length).toBe(1);
  });

  test("a slot past the kind's last one pulls in, and shares the column there", () => {
    // `clampSlot` is what places the pane, so the column has to be keyed by
    // the same clamped number or a pulled-in pane would arrange under a slot
    // it does not stand in.
    const columns = deckColumnsOf(
      slottedState({
        "pane-a": { slot: 2, width: 800 },
        "pane-b": { slot: 9, width: 800 },
      }),
    );
    expect(columns.map((c) => c.slot)).toEqual([2]);
    expect(columns[0].members.length).toBe(2);
  });
});

describe("a split column in flow", () => {
  test("contributes ONE extent to the strip: its widest member", () => {
    // [P11]: panes sharing a slot share its place in the strip. A split column
    // is still one slot, so it takes the width of the widest frame in it —
    // summing the members would open a gap the deck has nothing to put in.
    const state: DeckState = {
      cards: [makeCard("card-a"), makeCard("card-b"), makeCard("card-c")],
      panes: [
        { ...makePane("pane-a", ["card-a"], "card-a"), slot: 0, size: { width: 500, height: 300 } },
        { ...makePane("pane-b", ["card-b"], "card-b"), slot: 0, size: { width: 900, height: 300 } },
        { ...makePane("pane-c", ["card-c"], "card-c"), slot: 1, size: { width: 400, height: 300 } },
      ],
      imposition: {
        kind: "three-up",
        layout: "flow",
        sidebars: { tripwires: { side: "right" } },
        columns: { 0: { mode: "split", order: ["pane-a", "pane-b"] } },
      },
      hasFocus: true,
    };
    const strip = deckFlowStrip(state);
    expect(strip?.positions.get(0)).toBe(0);
    // 900 (the widest member) + one gap, not 500 + 900 + gaps.
    expect(strip?.positions.get(1)).toBe(905);
    // And slot 2, which nothing stands in, holds a card's width open behind
    // them: 905 + 400 + a gap. The strip is the arrangement, not the run.
    expect(strip?.positions.get(2)).toBe(1310);
    // The reserved extent is the widest card standing in the chain — 900, the
    // split column's wider member — not the deck's content preset: a place among
    // cards should look like the cards it is among.
    expect(strip?.extents.get(2)).toBe(900);
    expect(strip?.width).toBe(1310 + 900);
  });

  test("a card assigned past an empty slot stands where its number says", () => {
    // The whole of what the hold-open rule is for. Slot 1 is empty; the card
    // in slot 2 must stand at slot 2's place, not slide up into slot 1's.
    // Before this, the strip drew `1|3` and a chord naming slot 3 moved the
    // card nowhere the eye could follow, because its place was already the
    // second position in the run.
    const state: DeckState = {
      cards: [makeCard("card-a"), makeCard("card-b")],
      panes: [
        { ...makePane("pane-a", ["card-a"], "card-a"), slot: 0, size: { width: 600, height: 300 } },
        { ...makePane("pane-b", ["card-b"], "card-b"), slot: 2, size: { width: 600, height: 300 } },
      ],
      imposition: {
        kind: "three-up",
        layout: "flow",
        sidebars: { tripwires: { side: "right" } },
      },
      hasFocus: true,
    };
    const strip = deckFlowStrip(state);
    // Both cards are 600 wide, so the held-open slot 1 reserves 600 too.
    expect([...(strip?.positions.keys() ?? [])].sort()).toEqual([0, 1, 2]);
    expect(strip?.positions.get(1)).toBe(605);
    expect(strip?.positions.get(2)).toBe(605 + 600 + 5);
  });
});

describe("columnBadgeFactsOf", () => {
  /** A three-up deck: `slots` maps pane id → slot, one card per pane, with the
   *  column arrangement handed in whole. */
  function state(
    slots: Record<string, number>,
    columns: DeckState["imposition"]["columns"] = undefined,
  ): DeckState {
    const ids = Object.keys(slots);
    return {
      cards: ids.map((id) => makeCard(`card-${id}`)),
      panes: ids.map((id) => ({
        ...makePane(id, [`card-${id}`], `card-${id}`),
        slot: slots[id],
      })),
      imposition: {
        kind: "three-up",
        sidebars: { tripwires: { side: "right" } },
        ...(columns === undefined ? {} : { columns }),
      },
      hasFocus: true,
    };
  }

  test("a place one card deep is still a place, and it reads 1", () => {
    // The pane's own cluster has said so since its badge became
    // unconditional; a rail row that answered null for the same card said the
    // opposite about it.
    expect(
      columnBadgeFactsOf(state({ "pane-a": 0, "pane-b": 1 }), "card-pane-a"),
    ).toEqual({ kind: "stack", count: 1, index: 0 });
  });

  test("a stacked slot says how many cards share it", () => {
    expect(
      columnBadgeFactsOf(
        state({ "pane-a": 0, "pane-b": 0, "pane-c": 0 }),
        "card-pane-b",
      ),
    ).toEqual({ kind: "stack", count: 3, index: 1 });
  });

  test("each member of a stack says its own depth, front first", () => {
    // Later in the panes array is higher in the stack, so the LAST pane
    // holding the slot is the one you can see. Every member answered 0 once,
    // which meant a list of them drew the same badge three times and would
    // not say the one thing a reader of a list wants: which is in front.
    const deck = state({ "pane-a": 0, "pane-b": 0, "pane-c": 0 });
    expect(
      ["a", "b", "c"].map((id) => columnBadgeFactsOf(deck, `card-pane-${id}`)?.index),
    ).toEqual([2, 1, 0]);
  });

  test("a stored split standing one card deep is not a split", () => {
    // Membership churn never destroys the arrangement, so a slot that was
    // split and lost a member keeps `mode: "split"` waiting for it to come
    // back — and renders that one member across the whole undivided run
    // meanwhile. Reading `mode` alone put a band letter on a card that was not
    // in a band, and the card's own masthead (which gates on the same two
    // members the geometry does) said `stack` about the same place.
    const deck = state({ "pane-a": 0, "pane-b": 1 }, { 0: { mode: "split" } });
    expect(columnBadgeFactsOf(deck, "card-pane-a")).toEqual({
      kind: "stack",
      count: 1,
      index: 0,
    });
  });

  test("a split slot says which band, top to bottom", () => {
    const deck = state({ "pane-a": 0, "pane-b": 0 }, { 0: { mode: "split" } });
    // The fallback member order is the panes sorted by id, so pane-a is the
    // topmost band and pane-b the one below it.
    expect(columnBadgeFactsOf(deck, "card-pane-a")).toEqual({
      kind: "split",
      count: 2,
      index: 0,
    });
    expect(columnBadgeFactsOf(deck, "card-pane-b")).toEqual({
      kind: "split",
      count: 2,
      index: 1,
    });
  });

  test("a split of three reads its stored order, not the pane array", () => {
    const deck = state(
      { "pane-a": 0, "pane-b": 0, "pane-c": 0 },
      { 0: { mode: "split", order: ["pane-c", "pane-a", "pane-b"] } },
    );
    expect(columnBadgeFactsOf(deck, "card-pane-c")?.index).toBe(0);
    expect(columnBadgeFactsOf(deck, "card-pane-a")?.index).toBe(1);
    expect(columnBadgeFactsOf(deck, "card-pane-b")?.index).toBe(2);
  });

  test("no imposition, no place", () => {
    const deck = state({ "pane-a": 0, "pane-b": 0 });
    expect(
      columnBadgeFactsOf(
        { ...deck, imposition: { sidebars: {} } },
        "card-pane-a",
      ),
    ).toBeNull();
  });

  test("a card with no host pane answers nothing", () => {
    expect(
      columnBadgeFactsOf(state({ "pane-a": 0, "pane-b": 0 }), "card-nowhere"),
    ).toBeNull();
  });
});
