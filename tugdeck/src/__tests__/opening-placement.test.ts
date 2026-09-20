/**
 * opening-placement.test.ts — the deck reading an opening card takes, and the
 * ranking that chooses its slot, over synthetic states.
 *
 * Every slot class (empty, stack, split, wall), both anchors (an origin and
 * the deck), both layouts, the band's whole / touched / whole-arrangement
 * fallbacks, the origin's own slot excluded, and the all-split fallback that
 * ranks walls last.
 */

import { describe, test, expect } from "bun:test";
import type { CardState, DeckState, TugPaneState } from "../layout-tree";
import type { ImpositionKind } from "../lib/layout-imposer";
import { deckFlowStrip } from "../deck-store-selectors";
import {
  chooseOpeningSlot,
  readOpeningDeck,
  type OpeningDeck,
} from "../lib/opening-placement";

const RUN = 1000;
const WIDTH = 800;

type SlotSpec = "empty" | "stack" | "split" | "wall";

function card(id: string): CardState {
  return { id, componentId: "probe", title: id, closable: true };
}

function pane(id: string, slot: number, folded?: true): TugPaneState {
  return {
    id,
    position: { x: 0, y: 0 },
    size: { width: WIDTH, height: 300 },
    cardIds: [`card-${id}`],
    activeCardId: `card-${id}`,
    title: "",
    acceptsFamilies: ["standard"],
    slot,
    ...(folded !== undefined ? { folded } : {}),
  };
}

/**
 * A fit deck of `kind` whose slots stand as `specs` says: a stack holds one pane,
 * a split two, and a wall two with the upper one folded.
 */
function deckOf(
  kind: ImpositionKind,
  specs: readonly SlotSpec[],
  extra: Partial<DeckState["imposition"]> = {},
): DeckState {
  const panes: TugPaneState[] = [];
  const columns: NonNullable<DeckState["imposition"]["columns"]> = {};
  specs.forEach((spec, slot) => {
    if (spec === "empty") return;
    if (spec === "stack") {
      panes.push(pane(`s${slot}`, slot));
      return;
    }
    panes.push(pane(`s${slot}a`, slot, spec === "wall" ? true : undefined));
    panes.push(pane(`s${slot}b`, slot));
    columns[slot] = { mode: "split" };
  });
  return {
    cards: panes.flatMap((p) => p.cardIds.map(card)),
    panes,
    imposition: { kind, layout: "fit", sidebars: {}, columns, ...extra },
    hasFocus: true,
  };
}

function read(state: DeckState, band = 0): OpeningDeck {
  const deck = readOpeningDeck(state, { run: RUN, band });
  if (deck === null) throw new Error("no deck");
  return deck;
}

const fromOrigin = (deck: OpeningDeck, slot: number) =>
  chooseOpeningSlot(deck, { kind: "origin", slot })?.slot;
const fromDeck = (deck: OpeningDeck) =>
  chooseOpeningSlot(deck, { kind: "deck" })?.slot;

describe("readOpeningDeck", () => {
  test("a free deck has no slots to choose among", () => {
    const state = deckOf("three-up", ["stack"]);
    expect(
      readOpeningDeck(
        { ...state, imposition: { sidebars: {} } },
        { run: RUN, band: 0 },
      ),
    ).toBeNull();
  });

  test("every slot the kind defines is classified", () => {
    const deck = read(deckOf("four-up", ["empty", "stack", "split", "wall"]));
    expect(deck.slots.map((s) => s.class)).toEqual([
      "empty",
      "stack",
      "split",
      "wall",
    ]);
    expect(deck.slots[0].members).toEqual([]);
    expect(deck.slots[2].members).toEqual(["s2a", "s2b"]);
    expect(deck.band).toBeNull();
  });

  test("a slot held only by an arriving card is not empty", () => {
    const state = deckOf("three-up", ["empty", "stack", "empty"]);
    const deck = read({
      ...state,
      cards: [...state.cards, card("card-arr")],
      panes: [...state.panes, pane("arr", 2)],
      arriving: { arr: true },
    });
    expect(deck.slots[2].class).toBe("stack");
    expect(deck.slots[2].members).toEqual([]);
    // The truly empty slot 0 beats the held slot 2, though right would win.
    expect(fromOrigin(deck, 1)).toBe(0);
  });

  test("a split column with nothing folded is not a wall", () => {
    const deck = read(deckOf("two-up", ["split", "stack"]));
    expect(deck.slots[0].class).toBe("split");
  });

  test("the fit anchor is the arrangement's middle, cheating left", () => {
    expect(read(deckOf("three-up", [])).deckAnchor).toBe(1);
    expect(read(deckOf("four-up", [])).deckAnchor).toBe(1);
  });

  test("an arriving pane is not standing, but its slot is not empty", () => {
    const state = deckOf("two-up", ["stack"]);
    const deck = read({ ...state, arriving: { s0: true } });
    expect(deck.slots[0].members).toEqual([]);
    expect(deck.slots[0].class).toBe("stack");
  });
});

describe("chooseOpeningSlot — from an origin", () => {
  test("empty beats stack at equal distance", () => {
    // Origin at 2; a stack at 1 and an empty slot at 3.
    const deck = read(deckOf("four-up", ["stack", "stack", "stack", "empty"]));
    expect(fromOrigin(deck, 2)).toBe(3);
  });

  test("right beats left between two stacked neighbours", () => {
    const deck = read(deckOf("three-up", ["stack", "stack", "stack"]));
    expect(fromOrigin(deck, 1)).toBe(2);
  });

  test("distance outranks class and direction", () => {
    // Origin at 1: the stack at 2 is nearer than the empty slot at 3; with 2
    // split, the stack at 0 is still nearer, even though it lies left.
    const deck = read(deckOf("four-up", ["stack", "stack", "stack", "empty"]));
    expect(fromOrigin(deck, 1)).toBe(2);
    const split = read(deckOf("four-up", ["stack", "stack", "split", "empty"]));
    expect(fromOrigin(split, 1)).toBe(0);
  });

  test("a split right neighbour is skipped", () => {
    const deck = read(deckOf("three-up", ["stack", "stack", "split"]));
    expect(fromOrigin(deck, 1)).toBe(0);
  });

  test("the origin's own slot is never chosen", () => {
    // The origin's stack is the only qualifying slot, at distance zero; the
    // card goes to the split instead of covering the card that opened it.
    const deck = read(deckOf("two-up", ["stack", "split"]));
    const choice = chooseOpeningSlot(deck, { kind: "origin", slot: 0 });
    expect(choice?.slot).toBe(1);
    expect(choice?.class).toBe("split");
  });

  test("an origin open ranks the whole arrangement in flow", () => {
    // The band shows slot 0 alone; the nearest empty slot is off screen.
    const state = deckOf("three-up", ["stack", "stack", "empty"], {
      layout: "flow",
    });
    const strip = deckFlowStrip(state);
    const band = (strip?.extents.get(0) ?? 0) + 1;
    expect(fromOrigin(read(state, band), 0)).toBe(1);
    expect(fromOrigin(read(state, band), 1)).toBe(2);
  });
});

describe("chooseOpeningSlot — from the deck", () => {
  test("the anchor slot is itself a candidate", () => {
    const deck = read(deckOf("three-up", ["stack", "stack", "stack"]));
    expect(fromDeck(deck)).toBe(1);
  });

  test("a split anchor sends the card to the nearest qualifying slot", () => {
    const deck = read(deckOf("three-up", ["stack", "split", "empty"]));
    expect(fromDeck(deck)).toBe(2);
  });

  test("a split anchor with two equal neighbours takes the right one", () => {
    const deck = read(deckOf("three-up", ["stack", "split", "stack"]));
    expect(fromDeck(deck)).toBe(2);
  });

  describe("in flow", () => {
    /** A five-up flow deck, with the band placed by `show` over its strip. */
    function flowDeck(
      specs: readonly SlotSpec[],
      show: (strip: NonNullable<ReturnType<typeof deckFlowStrip>>) => {
        offset: number;
        band: number;
      },
    ): OpeningDeck {
      const base = deckOf("five-up", specs, { layout: "flow" });
      const strip = deckFlowStrip(base);
      if (strip === null) throw new Error("no strip");
      const { offset, band } = show(strip);
      return read({ ...base, flowOffset: offset }, band);
    }
    const left = (s: NonNullable<ReturnType<typeof deckFlowStrip>>, n: number) =>
      s.positions.get(n) as number;
    const right = (s: NonNullable<ReturnType<typeof deckFlowStrip>>, n: number) =>
      left(s, n) + (s.extents.get(n) as number);

    test("the band's middle anchors, and whole slots are the candidates", () => {
      // The band holds 2..4 whole; the empty slot 0 is off screen.
      const deck = flowDeck(
        ["empty", "stack", "stack", "stack", "stack"],
        (s) => ({ offset: left(s, 2), band: right(s, 4) - left(s, 2) }),
      );
      expect(deck.band?.whole).toEqual([2, 3, 4]);
      expect(deck.deckAnchor).toBe(3);
      expect(fromDeck(deck)).toBe(3);
    });

    test("a clipped slot answers when no whole one qualifies", () => {
      // Whole: 2 (split). Clipped: 1 (stack) and 3 (split).
      const deck = flowDeck(
        ["empty", "stack", "split", "split", "empty"],
        (s) => ({
          offset: left(s, 2) - 10,
          band: right(s, 2) - left(s, 2) + 20,
        }),
      );
      expect(deck.band?.whole).toEqual([2]);
      expect(deck.band?.touched).toEqual([1, 3]);
      expect(fromDeck(deck)).toBe(1);
    });

    test("the whole arrangement answers when the band shows only splits", () => {
      const deck = flowDeck(
        ["stack", "split", "split", "split", "empty"],
        (s) => ({ offset: left(s, 2), band: right(s, 2) - left(s, 2) }),
      );
      expect(fromDeck(deck)).toBe(4);
    });

    test("an all-split deck lands on the split the band shows", () => {
      const deck = flowDeck(
        ["split", "split", "split", "split", "split"],
        (s) => ({ offset: left(s, 3), band: right(s, 3) - left(s, 3) }),
      );
      expect(fromDeck(deck)).toBe(3);
    });
  });
});

describe("chooseOpeningSlot — when nothing qualifies", () => {
  test("the nearest split takes the arrival, right on a tie", () => {
    const deck = read(deckOf("three-up", ["split", "split", "split"]));
    const choice = chooseOpeningSlot(deck, { kind: "origin", slot: 1 });
    expect(choice).toEqual({
      slot: 2,
      class: "split",
      members: ["s2a", "s2b"],
      wall: false,
    });
  });

  test("a wall ranks after every ordinary split, however near", () => {
    const deck = read(deckOf("four-up", ["split", "split", "wall", "split"]));
    expect(fromOrigin(deck, 1)).toBe(0);
    expect(fromDeck(read(deckOf("three-up", ["split", "wall", "split"])))).toBe(2);
  });

  test("a deck of walls still opens, and says the arrival lands in one", () => {
    const deck = read(deckOf("two-up", ["wall", "wall"]));
    const choice = chooseOpeningSlot(deck, { kind: "origin", slot: 0 });
    expect(choice?.slot).toBe(1);
    expect(choice?.wall).toBe(true);
    expect(choice?.members).toEqual(["s1a", "s1b"]);
  });

  test("an arrangement with no slot but the origin's has no answer", () => {
    const deck = read(deckOf("one-up", ["stack"]));
    expect(chooseOpeningSlot(deck, { kind: "origin", slot: 0 })).toBeNull();
    expect(fromDeck(deck)).toBe(0);
  });
});
