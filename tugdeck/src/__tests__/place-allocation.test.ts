/**
 * place-allocation.test.ts — the member heights a place's allocation gives,
 * read back through the door every site now asks.
 *
 * Every site that used to derive a member height for itself now asks
 * `railAllocationOf` / `columnAllocationOf`, and the numbers below are the
 * ladder's ([P03]): every member at its floor, and what the run has left over
 * divided by the stored weights. They are pinned here because the numbers a
 * place draws are exactly what a move like this can quietly break, and because
 * the remaining steps change some of them on purpose: when they move, this
 * file is where the intent is stated.
 *
 * The probe cards declare no size policy, so each takes the default floor of
 * 180px and no comfort or natural height above it. That is deliberately the
 * state every card is in until the appetite declarations land: the ladder's
 * middle two stages have nothing to do, and the whole of the run above the
 * floors is the discretionary pool.
 *
 * The signature term is pinned beside them for the reason it exists: what a
 * settle interpolates is frames, so a term that missed a height change would
 * cut a motion the deck should cross.
 */

import { describe, test, expect } from "bun:test";

import type { CardState, DeckState, TugPaneState } from "../layout-tree";
import { registerCard } from "../card-registry";
import {
  columnAllocationOf,
  placeAllocationTerm,
  placeMemberAppetites,
  placeRunsMoved,
  railAllocationOf,
} from "../deck-store-selectors";
import { IMPOSITION_GAP_PX, RAIL_SEAM_PX } from "../lib/layout-imposer";

const RUN = 1000;

/** The floor `getStackSizePolicy` gives a card that declares no minimum. */
const DEFAULT_FLOOR = 180;

/** What a shared place of `count` probe members has left to divide once every
 *  floor and every seam is paid. */
function poolOf(count: number, seam: number): number {
  return RUN - count * DEFAULT_FLOOR - (count - 1) * seam;
}

// A rail's membership is read through the registry — a side's order is
// registration order before the imposition's stored order is applied — so a
// rail fixture has to be registered to stand anywhere at all. Three sidebar
// cards declaring nothing, so each takes the default floor and no appetite
// above it — the state every card is in until the declarations arrive.
const RAIL_IDS = ["probe-a", "probe-b", "probe-c"] as const;
for (const componentId of RAIL_IDS) {
  registerCard({
    componentId,
    contentFactory: () => null,
    defaultMeta: { title: componentId, closable: true },
    layoutRole: "sidebar",
  });
}

function pane(id: string, cardIds: string[], slot?: number): TugPaneState {
  return {
    id,
    position: { x: 0, y: 0 },
    size: { width: 400, height: 300 },
    cardIds,
    activeCardId: cardIds[0],
    title: "",
    acceptsFamilies: ["standard"],
    ...(slot === undefined ? {} : { slot }),
  };
}

function card(id: string, componentId: string): CardState {
  return { id, componentId, title: id, closable: true };
}

/** A deck whose right rail holds `componentIds`, split, at `shares`. */
function railState(
  componentIds: readonly string[],
  shares?: Record<string, number>,
): DeckState {
  return {
    cards: componentIds.map((componentId) =>
      card(`card-${componentId}`, componentId),
    ),
    panes: componentIds.map((componentId) =>
      pane(`pane-${componentId}`, [`card-${componentId}`]),
    ),
    imposition: {
      kind: "three-up",
      sidebars: Object.fromEntries(
        componentIds.map((componentId) => [
          componentId,
          { side: "right", pinned: true },
        ]),
      ),
      rails: {
        right: { mode: "split", order: [...componentIds], ...(shares ? { shares } : {}) },
      },
    },
    activePaneId: null,
    hasFocus: true,
  } as unknown as DeckState;
}

/** A deck whose slot 0 holds `paneIds`, split, at `shares`. */
function columnState(
  paneIds: readonly string[],
  shares?: Record<string, number>,
): DeckState {
  return {
    cards: paneIds.map((id) => card(`card-${id}`, "probe")),
    panes: paneIds.map((id) => pane(id, [`card-${id}`], 0)),
    imposition: {
      kind: "three-up",
      sidebars: {},
      columns: {
        0: { mode: "split", order: [...paneIds], ...(shares ? { shares } : {}) },
      },
    },
    activePaneId: null,
    hasFocus: true,
  } as unknown as DeckState;
}

describe("a place divides its run by the allocation ladder", () => {
  test("a rail of three shares the run, because three floors fit in it", () => {
    // The count says nothing ([P01]): three floors of 180 need 540 of the
    // 1000px run, so the rail divides it. Nothing left to feed above the
    // floors but the pool, and equal weights split it three ways.
    const allocation = railAllocationOf(
      railState([...RAIL_IDS]),
      "right",
      RUN,
    );
    expect(allocation).not.toBeNull();
    expect(allocation?.standing).toBe("shared");
    const share = DEFAULT_FLOOR + poolOf(3, RAIL_SEAM_PX) / 3;
    for (const height of allocation?.heights ?? []) {
      expect(height).toBeCloseTo(share, 6);
    }
    expect(allocation?.tops[0]).toBe(0);
    expect(allocation?.tops[1]).toBeCloseTo(share + RAIL_SEAM_PX, 6);
    // A sharing place's strip IS its run.
    expect(allocation?.stripLength).toBeCloseTo(RUN, 6);
  });

  test("a rail of two divides the pool at its stored weights", () => {
    const allocation = railAllocationOf(
      railState(RAIL_IDS.slice(0, 2), { "probe-a": 3, "probe-b": 1 }),
      "right",
      RUN,
    );
    expect(allocation?.standing).toBe("shared");
    // 3:1 of the POOL rather than of the run ([P04]): both members keep their
    // floor whatever the weights say, and only what is left over is divided.
    const pool = poolOf(2, RAIL_SEAM_PX);
    expect(allocation?.heights).toEqual([
      DEFAULT_FLOOR + (pool * 3) / 4,
      DEFAULT_FLOOR + pool / 4,
    ]);
    expect(allocation?.stripLength).toBe(RUN);
  });

  test("a column of two divides the same way, a card gap apart", () => {
    const allocation = columnAllocationOf(
      columnState(["p1", "p2"], { p1: 3, p2: 1 }),
      0,
      RUN,
    );
    expect(allocation?.standing).toBe("shared");
    // The one difference from the rail: the gap between two column members is
    // paid out of the run before the pool is measured.
    const pool = poolOf(2, IMPOSITION_GAP_PX);
    expect(allocation?.heights).toEqual([
      DEFAULT_FLOOR + (pool * 3) / 4,
      DEFAULT_FLOOR + pool / 4,
    ]);
    expect(allocation?.stripLength).toBe(RUN);
  });

  test("a stacked rail and an unmeasured run have no allocation", () => {
    const stacked = railState(RAIL_IDS.slice(0, 2));
    const state: DeckState = {
      ...stacked,
      imposition: {
        ...stacked.imposition,
        rails: { right: { mode: "stack" } },
      },
    };
    expect(railAllocationOf(state, "right", RUN)).toBeNull();
    expect(railAllocationOf(stacked, "right", null)).toBeNull();
    expect(railAllocationOf(stacked, "right", 0)).toBeNull();
    // And a side nobody stands on.
    expect(railAllocationOf(stacked, "left", RUN)).toBeNull();
  });
});

describe("the arrangement signature's allocation term", () => {
  test("moves when a member's height moves by a pixel", () => {
    const before = railAllocationOf(railState(RAIL_IDS.slice(0, 2), { "probe-a": 3, "probe-b": 1 }), "right", RUN);
    const after = railAllocationOf(
      railState(RAIL_IDS.slice(0, 2), { "probe-a": 3.03, "probe-b": 1 }),
      "right",
      RUN,
    );
    // 3.03 : 1 of the pool puts the upper member at 661.2px — a whole pixel
    // taller than the 660 it stood at, and the term has to say so or the
    // settle would cut a motion it should cross.
    expect(Math.round(before?.heights[0] ?? 0)).toBe(660);
    expect(Math.round(after?.heights[0] ?? 0)).toBe(661);
    expect(placeAllocationTerm(after)).not.toBe(placeAllocationTerm(before));
  });

  test("holds still for a sub-pixel change", () => {
    const before = railAllocationOf(railState(RAIL_IDS.slice(0, 2), { "probe-a": 3, "probe-b": 1 }), "right", RUN);
    const after = railAllocationOf(
      railState(RAIL_IDS.slice(0, 2), { "probe-a": 3.002, "probe-b": 1 }),
      "right",
      RUN,
    );
    // 660.08px: the member moved, but not by a pixel anybody draws.
    expect(after?.heights[0]).toBeCloseTo(660.08, 2);
    expect(Math.round(after?.heights[0] ?? 0)).toBe(660);
    expect(placeAllocationTerm(after)).toBe(placeAllocationTerm(before));
  });

  test("a place with no allocation contributes the empty term", () => {
    expect(placeAllocationTerm(null)).toBe("-:");
  });
});

describe("a run that moved is a run the deck has to re-allocate against", () => {
  // [P11]. The standing and the shared heights both depend on the run now, so
  // a window resize that changes only the height changes the answer while
  // nothing else in the deck moves. This is the decision that notices.
  test("an unmeasured run has not moved", () => {
    // At boot nothing has been measured, and the first measurement is what a
    // later comparison is against — not a change in itself.
    expect(
      placeRunsMoved({ rail: null, column: null }, { rail: 900, column: 900 }),
    ).toBe(false);
    expect(
      placeRunsMoved({ rail: null, column: 900 }, { rail: 900, column: 900 }),
    ).toBe(false);
  });

  test("either run moving by a pixel is a move", () => {
    expect(
      placeRunsMoved({ rail: 900, column: 900 }, { rail: 899, column: 900 }),
    ).toBe(true);
    expect(
      placeRunsMoved({ rail: 900, column: 900 }, { rail: 900, column: 901 }),
    ).toBe(true);
  });

  test("a sub-pixel change is not", () => {
    // Nothing anybody draws moved, and re-allocating would arm a settle over
    // frames already where they belong.
    expect(
      placeRunsMoved(
        { rail: 900, column: 900 },
        { rail: 900.4, column: 899.7 },
      ),
    ).toBe(false);
    expect(
      placeRunsMoved({ rail: 900, column: 900 }, { rail: 900, column: 900 }),
    ).toBe(false);
  });
});

describe("a member's appetite is what its cards declared, folded", () => {
  // The settled mirror of `cardAppetiteStore` ([P05]) — the same shape
  // `DeckState.appetites` carries, keyed by componentId.
  const appetites = {
    "probe-a": { comfort: 300, natural: 700 },
    "probe-b": { comfort: 400, natural: 500 },
  };

  function stateWithAppetites(): DeckState {
    return {
      ...railState([...RAIL_IDS]),
      appetites,
    } as unknown as DeckState;
  }

  test("a card that declared nothing reads its floor for both tiers", () => {
    // `probe-c` publishes no appetite. It asks for nothing beyond the box it
    // needs to paint, which is the state every card is in until it declares.
    const [, , third] = placeMemberAppetites(
      stateWithAppetites(),
      "rail",
      [...RAIL_IDS],
      undefined,
    );
    expect(third.floor).toBe(DEFAULT_FLOOR);
    expect(third.comfort).toBe(DEFAULT_FLOOR);
    expect(third.natural).toBe(DEFAULT_FLOOR);
  });

  test("a declaration is read, and one below the floor cannot lower it", () => {
    const [first, second] = placeMemberAppetites(
      stateWithAppetites(),
      "rail",
      [...RAIL_IDS],
      undefined,
    );
    expect(first).toMatchObject({ floor: DEFAULT_FLOOR, comfort: 300, natural: 700 });
    expect(second).toMatchObject({ floor: DEFAULT_FLOOR, comfort: 400, natural: 500 });
  });

  test("a pane's cards fold by max, because a stack is one box", () => {
    // A tab stack shows one card at a time and stands in one box, so the box
    // has to suit whichever tab is forward — the greediest of them.
    const base = railState([...RAIL_IDS]);
    const state = {
      ...base,
      cards: [...base.cards, card("card-extra", "probe-b")],
      panes: base.panes.map((p) =>
        p.id === "pane-probe-a"
          ? { ...p, cardIds: [...p.cardIds, "card-extra"] }
          : p,
      ),
      appetites,
    } as unknown as DeckState;
    const [first] = placeMemberAppetites(state, "rail", [...RAIL_IDS], undefined);
    expect(first.comfort).toBe(400);
    expect(first.natural).toBe(700);
  });

  test("a natural below its own comfort is raised to it", () => {
    // The ladder reads `natural` as the ceiling on `comfort`'s step, so the two
    // rungs would otherwise disagree about the same member. A publisher that
    // got them the wrong way round costs a taller box, never an invalid
    // allocation.
    const state = {
      ...railState([...RAIL_IDS]),
      appetites: { "probe-a": { comfort: 500, natural: 200 } },
    } as unknown as DeckState;
    const [first] = placeMemberAppetites(state, "rail", [...RAIL_IDS], undefined);
    expect(first.comfort).toBe(500);
    expect(first.natural).toBe(500);
  });

  test("a stream's Infinity natural survives the fold", () => {
    // The Overview declares one: it is never finished, so there is no height at
    // which it wants nothing more. The water-fill's cap must never bind on it.
    const state = {
      ...railState([...RAIL_IDS]),
      appetites: { "probe-a": { comfort: 300, natural: Infinity } },
    } as unknown as DeckState;
    const [first] = placeMemberAppetites(state, "rail", [...RAIL_IDS], undefined);
    expect(first.natural).toBe(Infinity);
  });

  test("the allocation caps a member at its natural and gives the rest away", () => {
    // The whole point, read through the door every consumer asks: `probe-b`
    // stops at 250 and the room it did not want goes to the member that did.
    const state = {
      ...railState([...RAIL_IDS]),
      appetites: {
        "probe-b": { comfort: 200, natural: 250 },
        "probe-c": { comfort: 200, natural: Infinity },
      },
    } as unknown as DeckState;
    const allocation = railAllocationOf(state, "right", RUN);
    expect(allocation?.standing).toBe("shared");
    const [a, b, c] = allocation?.heights ?? [];
    expect(a).toBeCloseTo(DEFAULT_FLOOR, 6);
    expect(b).toBeCloseTo(250, 6);
    expect(c).toBeCloseTo(RUN - 2 * RAIL_SEAM_PX - DEFAULT_FLOOR - 250, 6);
    expect(a + b + c).toBeCloseTo(RUN - 2 * RAIL_SEAM_PX, 6);
    expect(c).toBeGreaterThan(b);
  });
});
