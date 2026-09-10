/**
 * directional-focus.test.ts — the spatial reckoning, over constructed
 * arrangements, with no deck mounted.
 *
 * `resolveDirectionalFocus` is a function of `DeckState` and the two place runs
 * and nothing else, which is why it was worth pulling out of the handlers: every
 * question the geometry can be asked — split, stacked, ragged, rail-crossing,
 * and each of the four edges — is a shape built here and an id compared.
 *
 * Real registrations via `registerCard`, because `railMembersOf` derives a rail
 * from `layoutRole: "sidebar"` and sorts the side into **registration** order.
 * Registering is not setup ceremony: it is what makes a rail a rail.
 *
 * The runs are passed explicitly rather than measured. A run of `null` is a
 * place nobody has measured and its members stand at the equal division, so the
 * tests that care only about ordering pass `null` and the ones that care about
 * an uneven division pass a run and shares.
 */

import { beforeAll, describe, expect, test } from "bun:test";

import { registerCard } from "../../card-registry";
import type { CardState, DeckState, TugPaneState } from "../../layout-tree";
import type { PlaceRuns } from "../../deck-store-selectors";
import type { DeckImposition } from "../layout-imposer";
import {
  isFocusDirection,
  resolveDirectionalFocus,
  type FocusDirection,
  type FocusTravelSpan,
  type FocusTravelTarget,
} from "../directional-focus";

beforeAll(() => {
  // Two sidebars so a rail can hold two members and be crossed into at a
  // chosen band. Registration order is the order a side sorts into before its
  // stored order applies, so `railTop` before `railBottom` is deliberate.
  for (const componentId of ["railTop", "railBottom"]) {
    registerCard({
      componentId,
      contentFactory: () => null,
      defaultMeta: { title: componentId, closable: true },
      layoutRole: "sidebar",
    });
  }
  registerCard({
    componentId: "content",
    contentFactory: () => null,
    defaultMeta: { title: "Content", closable: true },
  });
});

function card(id: string, componentId = "content"): CardState {
  return { id, componentId, title: id, closable: true };
}

function pane(
  id: string,
  cardIds: string[],
  extra: Partial<TugPaneState> = {},
): TugPaneState {
  return {
    id,
    position: { x: 0, y: 0 },
    size: { width: 400, height: 300 },
    cardIds,
    activeCardId: cardIds[0],
    title: "",
    acceptsFamilies: ["standard"],
    ...extra,
  };
}

/** One content pane per card id, each in the slot it is listed under. The pane
 *  id is the card id prefixed, so a returned card id reads as itself. */
function columns(bySlot: Record<number, string[]>): {
  cards: CardState[];
  panes: TugPaneState[];
} {
  const cards: CardState[] = [];
  const panes: TugPaneState[] = [];
  for (const [slot, ids] of Object.entries(bySlot)) {
    for (const id of ids) {
      cards.push(card(id));
      panes.push(pane(`p-${id}`, [id], { slot: Number(slot) }));
    }
  }
  return { cards, panes };
}

function deck(
  cards: CardState[],
  panes: TugPaneState[],
  imposition: DeckImposition,
): DeckState {
  return {
    cards,
    panes,
    activePaneId: panes.length > 0 ? panes[panes.length - 1].id : undefined,
    imposition,
    hasFocus: true,
  };
}

/** Nothing measured — every place stands at the equal division. */
const UNMEASURED: PlaceRuns = { rail: null, column: null };

/** The arriving card id alone — what most of these ask about. */
function go(
  state: DeckState,
  from: string,
  direction: FocusDirection,
  runs: PlaceRuns = UNMEASURED,
): string | null {
  return resolveDirectionalFocus(state, runs, from, direction)?.cardId ?? null;
}

/** The whole target, for the tests that read the slot or the goal. */
function travel(
  state: DeckState,
  from: string,
  direction: FocusDirection,
  goal: FocusTravelSpan | null = null,
  runs: PlaceRuns = UNMEASURED,
): FocusTravelTarget | null {
  return resolveDirectionalFocus(state, runs, from, direction, goal);
}

describe("across the slots", () => {
  test("left and right step one slot, and the ends refuse", () => {
    const { cards, panes } = columns({ 0: ["a"], 1: ["b"], 2: ["c"] });
    const state = deck(cards, panes, { kind: "three-up", sidebars: {} });
    expect(go(state, "b", "left")).toBe("a");
    expect(go(state, "b", "right")).toBe("c");
    expect(go(state, "a", "left")).toBeNull();
    expect(go(state, "c", "right")).toBeNull();
  });

  test("an empty slot between two occupied ones is crossed, not landed in", () => {
    // Slot 1 holds nothing, so it is not a place: the nearest candidate beyond
    // slot 0 is slot 2, and the move goes there rather than refusing. A slot is
    // a place in an arrangement only while something stands in it.
    const { cards, panes } = columns({ 0: ["a"], 2: ["c"] });
    const state = deck(cards, panes, { kind: "three-up", sidebars: {} });
    expect(go(state, "a", "right")).toBe("c");
    expect(go(state, "c", "left")).toBe("a");
  });

  test("a slot past the band's edge is still a target", () => {
    // [D184]: the flow strip draws the whole arrangement while the reader is
    // using it, so a slot it has slid past is inside the mental model. Nothing
    // here reads `flowOffset` — travel is the caller's job, and the proof is
    // that an offset far past the strip changes no answer.
    const { cards, panes } = columns({ 0: ["a"], 1: ["b"] });
    const state = deck(cards, panes, {
      kind: "two-up",
      layout: "flow",
      sidebars: {},
    });
    const slid = { ...state, flowOffset: 4000 };
    expect(go(slid, "a", "right")).toBe("b");
    expect(go(slid, "b", "left")).toBe("a");
  });

  test("a free pane in no place is neither a source nor a target", () => {
    const { cards, panes } = columns({ 0: ["a"] });
    const state = deck(
      [...cards, card("loose")],
      [...panes, pane("p-loose", ["loose"])],
      { kind: "two-up", sidebars: {} },
    );
    expect(go(state, "loose", "left")).toBeNull();
    expect(go(state, "loose", "right")).toBeNull();
    // And nothing reaches it: slot 0's right has only the free pane beyond it.
    expect(go(state, "a", "right")).toBeNull();
  });

  test("a card id nothing hosts resolves to nothing", () => {
    const { cards, panes } = columns({ 0: ["a"] });
    const state = deck(cards, panes, { kind: "one-up", sidebars: {} });
    expect(go(state, "ghost", "left")).toBeNull();
  });
});

describe("inside a split column", () => {
  const split = (): DeckState => {
    const { cards, panes } = columns({ 0: ["top", "mid", "bot"] });
    return deck(cards, panes, {
      kind: "one-up",
      sidebars: {},
      columns: { 0: { mode: "split", order: ["p-top", "p-mid", "p-bot"] } },
    });
  };

  test("above and below walk the bands, and the ends refuse", () => {
    const state = split();
    expect(go(state, "mid", "above")).toBe("top");
    expect(go(state, "mid", "below")).toBe("bot");
    expect(go(state, "top", "above")).toBeNull();
    expect(go(state, "bot", "below")).toBeNull();
  });

  test("a vertical move never leaves the column it started in", () => {
    // No two places overlap in x, so the perpendicular-overlap rule confines a
    // vertical move to its own place. A neighbour slot is not below anything.
    const { cards, panes } = columns({ 0: ["a"], 1: ["b"] });
    const state = deck(cards, panes, { kind: "two-up", sidebars: {} });
    expect(go(state, "a", "below")).toBeNull();
    expect(go(state, "a", "above")).toBeNull();
  });
});

describe("a stacked column", () => {
  // Pane order is z order — `state.panes` is the array a raise reorders, so
  // the LAST pane listed is the frontmost.
  const stack = (): DeckState => {
    const { cards, panes } = columns({ 0: ["back", "front"], 1: ["side"] });
    return deck(cards, panes, { kind: "two-up", sidebars: {} });
  };

  test("above and below read as z, front and back", () => {
    // The `move-in-column` reading exactly ([P12]): nothing is above anything
    // when every member draws the same rect, so up is toward the front. The
    // chord is never dead on an unsplit slot.
    const state = stack();
    expect(go(state, "back", "above")).toBe("front");
    expect(go(state, "front", "above")).toBeNull();
    expect(go(state, "front", "below")).toBe("back");
    expect(go(state, "back", "below")).toBeNull();
  });

  test("entered laterally, it hands focus to its z-frontmost member", () => {
    const state = stack();
    expect(go(state, "side", "left")).toBe("front");
  });

  test("a lateral move out of a stack leaves from whichever member holds focus", () => {
    // Including the one behind: a background member's rect is the whole run,
    // so it is beside the neighbour exactly as the front one is.
    const state = stack();
    expect(go(state, "back", "right")).toBe("side");
    expect(go(state, "front", "right")).toBe("side");
  });

  test("a split column of one is one rect, in either mode", () => {
    // Membership churn never destroys an arrangement, so a slot that was split
    // and lost a member keeps `mode: "split"` waiting for it. Nothing about
    // that column draws divided, and nothing about it is stepped vertically.
    const { cards, panes } = columns({ 0: ["only"], 1: ["side"] });
    const state = deck(cards, panes, {
      kind: "two-up",
      sidebars: {},
      columns: { 0: { mode: "split" } },
    });
    expect(go(state, "only", "below")).toBeNull();
    expect(go(state, "side", "left")).toBe("only");
  });
});

describe("a ragged arrangement", () => {
  /**
   * Slot 0 split three ways at an even division, slot 1 split two ways. The
   * bands do not line up, which is the whole point:
   *
   *     slot 0            slot 1
   *     ┌────────┐        ┌────────┐
   *     │ a0     │ 0..⅓   │ b0     │ 0..½
   *     ├────────┤        │        │
   *     │ a1     │ ⅓..⅔   ├────────┤
   *     ├────────┤        │ b1     │ ½..1
   *     │ a2     │ ⅔..1   │        │
   *     └────────┘        └────────┘
   */
  const ragged = (): DeckState => {
    const { cards, panes } = columns({ 0: ["a0", "a1", "a2"], 1: ["b0", "b1"] });
    return deck(cards, panes, {
      kind: "two-up",
      sidebars: {},
      columns: {
        0: { mode: "split", order: ["p-a0", "p-a1", "p-a2"] },
        1: { mode: "split", order: ["p-b0", "p-b1"] },
      },
    });
  };

  test("the band with the greatest overlap wins the crossing", () => {
    const state = ragged();
    // a0 spans 0..⅓: all of it is inside b0's 0..½.
    expect(go(state, "a0", "right")).toBe("b0");
    // a2 spans ⅔..1: all of it is inside b1's ½..1.
    expect(go(state, "a2", "right")).toBe("b1");
    // a1 spans ⅓..⅔ and straddles the seam — ⅙ into each — so the tie breaks
    // to the topmost, which is the rule stated rather than an accident.
    expect(go(state, "a1", "right")).toBe("b0");
  });

  test("crossing back reads the same geometry from the other side", () => {
    const state = ragged();
    // b0 spans 0..½: ⅓ of it over a0, ⅙ over a1.
    expect(go(state, "b0", "left")).toBe("a0");
    // b1 spans ½..1: ⅙ over a1, ⅓ over a2.
    expect(go(state, "b1", "left")).toBe("a2");
  });

  test("no ragged division can leave a direction all-diagonal", () => {
    // The brief's open question — refuse, or fall back to nearest-center, when
    // nothing overlaps perpendicular — turns out to have no case to decide, and
    // this is the shape that says so. A split place's members TILE its run:
    // their spans are contiguous and cover it end to end, so every occupied
    // place covers 0..1 of its own strip and some member of it necessarily
    // overlaps any source span. Pushed as far apart as shares go — one member
    // in the top ninth of slot 0, its neighbour in the bottom ninth of slot 1 —
    // the crossing still lands, on the band the fill leaves in the way.
    const { cards, panes } = columns({ 0: ["a", "aFill"], 1: ["bFill", "b"] });
    const state = deck(cards, panes, {
      kind: "two-up",
      sidebars: {},
      columns: {
        // `a` takes the top ninth of slot 0, `b` the bottom ninth of slot 1.
        0: {
          mode: "split",
          order: ["p-a", "p-aFill"],
          shares: { "p-a": 1, "p-aFill": 8 },
        },
        1: {
          mode: "split",
          order: ["p-bFill", "p-b"],
          shares: { "p-bFill": 8, "p-b": 1 },
        },
      },
    });
    const runs: PlaceRuns = { rail: null, column: 900 };
    expect(go(state, "a", "right", runs)).toBe("bFill");
    expect(go(state, "b", "left", runs)).toBe("aFill");
    // So the refusal branch is the ARRANGEMENT'S EDGE and nothing else — there
    // is no place beyond, rather than no overlapping member in one.
    expect(go(state, "a", "left", runs)).toBeNull();
    expect(go(state, "b", "right", runs)).toBeNull();
  });
});

describe("crossing into a rail", () => {
  /** The left rail holds both sidebars; one content column stands beside it. */
  const railed = (side: "left" | "right"): DeckState => {
    const { cards, panes } = columns({ 0: ["a"] });
    return deck(
      [...cards, card("rt", "railTop"), card("rb", "railBottom")],
      [...panes, pane("p-rt", ["rt"]), pane("p-rb", ["rb"])],
      {
        kind: "one-up",
        sidebars: { railTop: { side }, railBottom: { side } },
      },
    );
  };

  test("a showing rail is on the left of every slot, and on the right", () => {
    const left = railed("left");
    expect(go(left, "a", "left")).toBe("rt");
    expect(go(left, "rt", "right")).toBe("a");
    const right = railed("right");
    expect(go(right, "a", "right")).toBe("rt");
    expect(go(right, "rb", "left")).toBe("a");
  });

  test("a rail is always divided, so its members step vertically", () => {
    // [D183]. There is no stacked reading of a rail to fall back on, and the
    // registration order (`railTop` before `railBottom`) is the vertical one.
    const state = railed("left");
    expect(go(state, "rt", "below")).toBe("rb");
    expect(go(state, "rb", "above")).toBe("rt");
    expect(go(state, "rt", "above")).toBeNull();
    expect(go(state, "rb", "below")).toBeNull();
  });

  test("an unpinned sidebar card is not a rail member", () => {
    // Released, the card is an ordinary free pane and the side is empty, so
    // there is nothing to the left of slot 0. Summoning a surface that is not
    // on the deck is the rail pair's job, not a focus move's.
    const state = railed("left");
    const released = {
      ...state,
      imposition: {
        ...state.imposition,
        sidebars: {
          railTop: { side: "left" as const, pinned: false },
          railBottom: { side: "left" as const, pinned: false },
        },
      },
    };
    expect(go(released, "a", "left")).toBeNull();
  });

  test("both rails stand, one at each end", () => {
    const { cards, panes } = columns({ 0: ["a"] });
    const state = deck(
      [...cards, card("rt", "railTop"), card("rb", "railBottom")],
      [...panes, pane("p-rt", ["rt"]), pane("p-rb", ["rb"])],
      {
        kind: "one-up",
        sidebars: { railTop: { side: "left" }, railBottom: { side: "right" } },
      },
    );
    expect(go(state, "a", "left")).toBe("rt");
    expect(go(state, "a", "right")).toBe("rb");
    // And each rail's single member spans its whole run, so the crossing
    // reaches the other one right through the column between them.
    expect(go(state, "rt", "right")).toBe("a");
    expect(go(state, "rb", "left")).toBe("a");
  });

  test("with nothing imposed, the two rails still face each other", () => {
    // A sidebar holds its side whether or not anything is arranged against it,
    // so a deck with no `kind` is still an arrangement of two places.
    const state = deck(
      [card("rt", "railTop"), card("rb", "railBottom")],
      [pane("p-rt", ["rt"]), pane("p-rb", ["rb"])],
      { sidebars: { railTop: { side: "left" }, railBottom: { side: "right" } } },
    );
    expect(go(state, "rt", "right")).toBe("rb");
    expect(go(state, "rb", "left")).toBe("rt");
  });
});

describe("the arrival is a card, not a pane", () => {
  test("focus lands on the target pane's front card", () => {
    // A member pane may be a tab stack. What the reader can see of it is its
    // front card, and that is what the keyboard arrives at.
    const state = deck(
      [card("a"), card("b1"), card("b2")],
      [
        pane("p-a", ["a"], { slot: 0 }),
        pane("p-b", ["b1", "b2"], { slot: 1, activeCardId: "b2" }),
      ],
      { kind: "two-up", sidebars: {} },
    );
    expect(go(state, "a", "right")).toBe("b2");
    // And a background tab of the source pane is still in that pane's place.
    expect(go(state, "b1", "left")).toBe("a");
  });
});

describe("isFocusDirection", () => {
  test("admits the four and nothing else", () => {
    for (const value of ["left", "right", "above", "below"]) {
      expect(isFocusDirection(value)).toBe(true);
    }
    for (const value of ["up", "down", "", 0, null, undefined, {}]) {
      expect(isFocusDirection(value)).toBe(false);
    }
  });
});

describe("the travel's memory", () => {
  /**
   * Slot 0 divided in three, slot 1 in two — the asymmetry that makes a
   * memory necessary rather than decorative. Crossing right from `a0` (0..⅓)
   * lands on `b0` (0..½); crossing back from `b0` with no memory reads b0's
   * own wider span and lands on `a0` only because it is the topmost of the two
   * bands b0 overlaps. From `a1` (⅓..⅔) the round trip is where it shows.
   */
  const ragged = (): DeckState => {
    const { cards, panes } = columns({ 0: ["a0", "a1", "a2"], 1: ["b0", "b1"] });
    return deck(cards, panes, {
      kind: "two-up",
      sidebars: {},
      columns: {
        0: { mode: "split", order: ["p-a0", "p-a1", "p-a2"] },
        1: { mode: "split", order: ["p-b0", "p-b1"] },
      },
    });
  };

  test("a lateral move carries its goal across unchanged", () => {
    const state = ragged();
    const out = travel(state, "a1", "right");
    // The run started here, so the goal it reports is a1's own band.
    expect(out?.cardId).toBe("b0");
    expect(out?.goal.top).toBeCloseTo(1 / 3, 6);
    expect(out?.goal.bottom).toBeCloseTo(2 / 3, 6);
    // And crossing back with that goal in hand returns to a1 — where a memory-
    // less crossing would have read b0's own 0..½ and answered a0.
    expect(travel(state, "b0", "left", out?.goal ?? null)?.cardId).toBe("a1");
    expect(travel(state, "b0", "left")?.cardId).toBe("a0");
  });

  test("a vertical move re-establishes the goal as its own band", () => {
    // The caret rule mirrored: motion ALONG the line the goal describes is what
    // resets it, so ↓ then → travels from where you now are rather than from
    // where a lateral run once began.
    const state = ragged();
    const down = travel(state, "a0", "below", { top: 0, bottom: 1 / 3 });
    expect(down?.cardId).toBe("a1");
    expect(down?.goal.top).toBeCloseTo(1 / 3, 6);
    expect(down?.goal.bottom).toBeCloseTo(2 / 3, 6);
  });

  test("a run of three crossings holds one line", () => {
    // ← ← then → → over three columns of different divisions: the goal is the
    // whole reason the return is a return and not a drift.
    const { cards, panes } = columns({
      0: ["x0", "x1", "x2"],
      1: ["y0", "y1"],
      2: ["z0", "z1", "z2", "z3"],
    });
    const state = deck(cards, panes, {
      kind: "three-up",
      sidebars: {},
      columns: {
        0: { mode: "split", order: ["p-x0", "p-x1", "p-x2"] },
        1: { mode: "split", order: ["p-y0", "p-y1"] },
        2: { mode: "split", order: ["p-z0", "p-z1", "p-z2", "p-z3"] },
      },
    });
    const start = "z2"; // spans ½..¾
    const first = travel(state, start, "left");
    expect(first?.cardId).toBe("y1"); // ½..1 holds all of ½..¾
    const second = travel(state, first!.cardId, "left", first!.goal);
    expect(second?.cardId).toBe("x1"); // ⅓..⅔ overlaps ½..⅔, more than x2 does
    const back = travel(state, second!.cardId, "right", second!.goal);
    expect(back?.cardId).toBe("y1");
    expect(travel(state, back!.cardId, "right", back!.goal)?.cardId).toBe(start);
  });
});

describe("the target names its place", () => {
  test("a column member reports its slot and a rail member reports none", () => {
    // What the band travel reads: a slot can be off-band and is traveled to, a
    // rail is pinned to an edge and never is.
    const { cards, panes } = columns({ 0: ["a"], 2: ["c"] });
    const state = deck(
      [...cards, card("rt", "railTop")],
      [...panes, pane("p-rt", ["rt"])],
      { kind: "three-up", sidebars: { railTop: { side: "left" } } },
    );
    expect(travel(state, "a", "right")?.slot).toBe(2);
    expect(travel(state, "c", "left")?.slot).toBe(0);
    expect(travel(state, "a", "left")?.slot).toBeNull();
    // And the pane rides along, so the caller needs no second lookup.
    expect(travel(state, "a", "right")?.paneId).toBe("p-c");
  });
});
