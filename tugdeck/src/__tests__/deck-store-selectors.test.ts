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
  paneFoldedOf,
  cardFoldedOf,
  placeMembers,
  slotStackOf,
} from "../deck-store-selectors";
import {
  allocatePlaceHeights,
  type PlaceMember,
} from "@/lib/layout-imposer";
import { registerCard, _resetForTest } from "../card-registry";


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

describe("paneFoldedOf / cardFoldedOf", () => {
  function foldedState(): DeckState {
    const s = baseState();
    return {
      ...s,
      panes: [
        { ...s.panes[0], folded: true },
        s.panes[1],
      ],
    };
  }

  test("an absent flag reads false", () => {
    expect(paneFoldedOf(baseState(), "pane-1")).toBe(false);
    expect(cardFoldedOf(baseState(), "card-a")).toBe(false);
  });

  test("a pane carrying the flag reads true", () => {
    expect(paneFoldedOf(foldedState(), "pane-1")).toBe(true);
  });

  test("a sibling pane without the flag still reads false", () => {
    expect(paneFoldedOf(foldedState(), "pane-2")).toBe(false);
  });

  test("a pane id naming no live pane reads false", () => {
    expect(paneFoldedOf(foldedState(), "pane-gone")).toBe(false);
  });

  test("every tab of a folded pane reads true — the flag is the box's", () => {
    expect(cardFoldedOf(foldedState(), "card-a")).toBe(true);
    expect(cardFoldedOf(foldedState(), "card-b")).toBe(true);
  });

  test("a card in an unfolded pane reads false", () => {
    expect(cardFoldedOf(foldedState(), "card-c")).toBe(false);
  });

  test("a card in no pane reads false", () => {
    expect(cardFoldedOf(foldedState(), "card-orphan")).toBe(false);
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

/** The run these fixtures' columns divide. Any positive number does: the
 *  assertions below are about membership, order and where the seams fall, and
 *  a seam fraction is the same fraction of any run. */
const COLUMN_RUN = 1000;

/** `deckColumnsOf` at that run — the one measurement these fixtures make. */
const columnsOf = (state: DeckState): ReturnType<typeof deckColumnsOf> =>
  deckColumnsOf(state, COLUMN_RUN);

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
    expect(columnsOf({ ...state, imposition: { sidebars: {} } })).toEqual([]);
  });

  test("one column per OCCUPIED slot, in slot order", () => {
    const columns = columnsOf(
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
    const columns = columnsOf(
      slottedState({
        "pane-a": { slot: 0, width: 800 },
        "pane-b": { slot: 0, width: 800 },
      }),
    );
    expect(columns[0].mode).toBe("stack");
    expect(columns[0].seams).toEqual([]);
    expect(columns[0].members.length).toBe(2);
  });

  test("a split column's seam sits where the ladder put its members", () => {
    const columns = columnsOf(
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
    // A share divides the RUN less its gaps ([P04]): 995px of the 1000px run,
    // of which the upper member takes three quarters — 746.25px, well clear
    // of the 180 floor. The gap's centre is half a gap past its bottom edge,
    // and the fraction the seam property carries is that centre over the run.
    expect(columns[0].seams).toEqual([0.74875]);
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
    expect(columnsOf(state)[0].members).toEqual(
      columnsOf(raised)[0].members,
    );
  });

  test("a stored order governs, and residue leaves no hole", () => {
    const columns = columnsOf(
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
    const columns = columnsOf(
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

  test("a split standing one card deep is a split, and reads A", () => {
    // The badge names the arrangement the slot is SET to, not what the
    // geometry is drawing. Splitting a slot that holds one card is a legal
    // act that commits `mode: "split"`, and the lone member goes on taking
    // the undivided run — so a badge gated on a second member reported the
    // user's Split as having done nothing, and only produced the letter when
    // a neighbour arrived. Membership churn reaches the same state from the
    // other side: a split slot that LOST a member is still split, waiting for
    // one to come back, and says so.
    const deck = state({ "pane-a": 0, "pane-b": 1 }, { 0: { mode: "split" } });
    expect(columnBadgeFactsOf(deck, "card-pane-a")).toEqual({
      kind: "split",
      count: 1,
      index: 0,
    });
    // And the slot next to it, set to nothing, is the control: one card deep
    // in a stacked place still reads `1`.
    expect(columnBadgeFactsOf(deck, "card-pane-b")).toEqual({
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

// ---------------------------------------------------------------------------
// placeMembers and the wall ([P05])
// ---------------------------------------------------------------------------

describe("placeMembers reads the folded flag", () => {
  const TIER = 173;
  const OPEN = 600;

  /** A card type shaped like the Session card: a tall open floor, a pinned
   *  folded tier. */
  function registerFoldable(): void {
    _resetForTest();
    registerCard({
      componentId: "foldable",
      contentFactory: () => null,
      defaultMeta: { title: "Foldable", closable: true },
      sizePolicy: {
        min: { width: 400, height: OPEN },
        preferred: { width: 600, height: 900 },
      },
      foldedSizePolicy: {
        min: { width: 400, height: TIER },
        max: { width: Number.POSITIVE_INFINITY, height: TIER },
        preferred: { width: 600, height: TIER },
      },
    });
  }

  /** Two panes in one slot, the first optionally folded. */
  function wallState(foldFirst: boolean): DeckState {
    const pane = (id: string, cardId: string, folded: boolean) => ({
      ...makePane(id, [cardId], cardId),
      slot: 0,
      ...(folded ? { folded: true as const } : {}),
    });
    return {
      cards: [makeCard("card-a", "foldable"), makeCard("card-b", "foldable")],
      panes: [
        pane("pane-a", "card-a", foldFirst),
        pane("pane-b", "card-b", false),
      ],
      activePaneId: "pane-a",
      imposition: { sidebars: {} },
      hasFocus: true,
    };
  }

  test("a folded column member is a share of zero, pinned at its tier", () => {
    registerFoldable();
    const members = placeMembers(
      wallState(true),
      "column",
      ["pane-a", "pane-b"],
      { "pane-a": 3, "pane-b": 1 },
    );
    expect(members[0].floor).toBe(TIER);
    expect(members[0].ceiling).toBe(TIER);
    // Zero WHATEVER the stored shares say — a folded card asks for no share.
    expect(members[0].weight).toBe(0);
  });

  test("an open member beside it keeps its own floor and its stored share", () => {
    registerFoldable();
    const members = placeMembers(
      wallState(true),
      "column",
      ["pane-a", "pane-b"],
      { "pane-a": 3, "pane-b": 1 },
    );
    expect(members[1].floor).toBe(OPEN);
    expect(members[1].ceiling).toBeUndefined();
    expect(members[1].weight).toBe(1);
  });

  test("the stored share comes back the moment the card is open again", () => {
    // The share is DERIVED from the flag on every allocation ([P05]), never
    // rewritten, so a fold and a show is not a gesture that costs the user
    // the division they made with the seams.
    registerFoldable();
    const members = placeMembers(
      wallState(false),
      "column",
      ["pane-a", "pane-b"],
      { "pane-a": 3, "pane-b": 1 },
    );
    expect(members[0].floor).toBe(OPEN);
    expect(members[0].ceiling).toBeUndefined();
    expect(members[0].weight).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// placeMembers and a sheet's reservation ([B01], [B07], [B08])
// ---------------------------------------------------------------------------

describe("placeMembers reads a reservation as a floor", () => {
  const FLOOR = 200;
  const RESERVED = 420;

  function registerPlain(): void {
    _resetForTest();
    registerCard({
      componentId: "plain",
      contentFactory: () => null,
      defaultMeta: { title: "Plain", closable: true },
      sizePolicy: {
        min: { width: 400, height: FLOOR },
        preferred: { width: 600, height: 900 },
      },
    });
  }

  /** Two panes in one slot, with whatever reservations are standing. */
  function splitState(
    sheetReservations?: Readonly<Record<string, number>>,
    folded = false,
  ): DeckState {
    const pane = (id: string, cardId: string, fold: boolean) => ({
      ...makePane(id, [cardId], cardId),
      slot: 0,
      ...(fold ? { folded: true as const } : {}),
    });
    return {
      cards: [makeCard("card-a", "plain"), makeCard("card-b", "plain")],
      panes: [
        pane("pane-a", "card-a", folded),
        pane("pane-b", "card-b", false),
      ],
      activePaneId: "pane-a",
      imposition: { sidebars: {} },
      hasFocus: true,
      ...(sheetReservations !== undefined ? { sheetReservations } : {}),
    };
  }

  function columnMembers(
    state: DeckState,
    shares?: Record<string, number>,
  ): PlaceMember[] {
    return placeMembers(state, "column", ["pane-a", "pane-b"], shares);
  }

  test("a reserving member's floor is the reservation, not its stack policy's", () => {
    registerPlain();
    const members = columnMembers(splitState({ "pane-b": RESERVED }));
    expect(members[1].floor).toBe(RESERVED);
    // Only the member that claimed. Its neighbour is untouched.
    expect(members[0].floor).toBe(FLOOR);
  });

  test("the floor is the GREATER of the two, so a claim under it changes nothing", () => {
    registerPlain();
    const members = columnMembers(splitState({ "pane-b": FLOOR - 50 }));
    expect(members[1].floor).toBe(FLOOR);
  });

  test("a FOLDED member reads no reservation — it pins at its tier", () => {
    // A folded card asks for no share of the run, so a claim on one would be a
    // contradiction rather than a case, and the branch is left alone.
    _resetForTest();
    registerCard({
      componentId: "plain",
      contentFactory: () => null,
      defaultMeta: { title: "Plain", closable: true },
      sizePolicy: {
        min: { width: 400, height: FLOOR },
        preferred: { width: 600, height: 900 },
      },
      foldedSizePolicy: {
        min: { width: 400, height: 173 },
        max: { width: Number.POSITIVE_INFINITY, height: 173 },
        preferred: { width: 600, height: 173 },
      },
    });
    const members = columnMembers(splitState({ "pane-a": RESERVED }, true));
    expect(members[0].floor).toBe(173);
    expect(members[0].ceiling).toBe(173);
  });

  test("a rail member is named by componentId, and claims under that name", () => {
    // The one thing the two places differ by: a sidebar card is a singleton,
    // so the reservation the sheet publishes is keyed the way `placeMembers`
    // looks it up, and nothing translates in between.
    _resetForTest();
    registerCard({
      componentId: "railcard",
      contentFactory: () => null,
      defaultMeta: { title: "Rail", closable: true },
      sizePolicy: {
        min: { width: 300, height: FLOOR },
        preferred: { width: 400, height: 900 },
      },
    });
    const state: DeckState = {
      cards: [makeCard("card-r", "railcard")],
      panes: [makePane("pane-r", ["card-r"], "card-r")],
      imposition: { sidebars: { railcard: { side: "right" } } },
      hasFocus: true,
      sheetReservations: { railcard: RESERVED },
    };
    const members = placeMembers(state, "rail", ["railcard"], undefined);
    expect(members[0].floor).toBe(RESERVED);
  });
});

describe("a reserving member's place divides around the claim", () => {
  // The composition this step exists for: `placeMembers` derives the floor and
  // `allocatePlaceHeights` honours it before it divides anything ([F07]), so
  // the claimant takes exactly what it asked for and the neighbour keeps the
  // rest. That is the whole of what separates this from the shape recorded
  // under the brief's non-goals, where the host took the entire run.
  const FLOOR = 200;
  const RESERVED = 420;
  const RUN = 1000;
  const SEAM = 8;

  function registerPlain(): void {
    _resetForTest();
    registerCard({
      componentId: "plain",
      contentFactory: () => null,
      defaultMeta: { title: "Plain", closable: true },
      sizePolicy: {
        min: { width: 400, height: FLOOR },
        preferred: { width: 600, height: 900 },
      },
    });
  }

  function splitState(
    sheetReservations?: Readonly<Record<string, number>>,
  ): DeckState {
    const pane = (id: string, cardId: string) => ({
      ...makePane(id, [cardId], cardId),
      slot: 0,
    });
    return {
      cards: [makeCard("card-a", "plain"), makeCard("card-b", "plain")],
      panes: [pane("pane-a", "card-a"), pane("pane-b", "card-b")],
      activePaneId: "pane-a",
      imposition: { sidebars: {} },
      hasFocus: true,
      ...(sheetReservations !== undefined ? { sheetReservations } : {}),
    };
  }

  function heightsOf(
    state: DeckState,
    shares?: Record<string, number>,
  ): readonly number[] {
    return allocatePlaceHeights(
      placeMembers(state, "column", ["pane-a", "pane-b"], shares),
      RUN,
      SEAM,
    ).heights;
  }

  test("the claimant stands at its reservation and the neighbour keeps the REST", () => {
    registerPlain();
    // The reported picture: the lower member's share of the run leaves it a
    // band too short for the picker, which is what the claim is for.
    const heights = heightsOf(splitState({ "pane-b": RESERVED }), {
      "pane-a": 3,
      "pane-b": 1,
    });
    expect(heights[1]).toBe(RESERVED);
    // Not its floor: everything the picker did not need is still the
    // neighbour's, which is the "only as much room as the sheet needs"
    // reading expressed in arithmetic that already existed.
    expect(heights[0]).toBe(RUN - SEAM - RESERVED);
    expect(heights[0]).toBeGreaterThan(FLOOR);
  });

  test("a member whose stored share already exceeds the claim does not move", () => {
    // [B07]: the reservation is a floor, not a target. A card that was already
    // big enough stays exactly where the hand's own division put it.
    registerPlain();
    const shares = { "pane-a": 1, "pane-b": 3 };
    const before = heightsOf(splitState(), shares);
    expect(before[1]).toBeGreaterThan(RESERVED);
    expect(heightsOf(splitState({ "pane-b": RESERVED }), shares)).toEqual(
      before,
    );
  });

  test("two claims that do not fit the run put the place in OVERFLOW", () => {
    // Nothing new: a run that cannot hold its floors is already a strip by
    // arithmetic, and a reservation reaches that standing by the one door
    // every other floor does.
    registerPlain();
    const standing = allocatePlaceHeights(
      placeMembers(
        splitState({ "pane-a": 700, "pane-b": 700 }),
        "column",
        ["pane-a", "pane-b"],
        { "pane-a": 1, "pane-b": 1 },
      ),
      RUN,
      SEAM,
    ).standing;
    expect(standing).toBe("overflow");
  });
});
