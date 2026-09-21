/**
 * close-successor.test.ts — which card a close hands the reader.
 *
 * `resolveCloseSuccessor` is a function of `DeckState`, the two place runs and
 * the id of the pane about to go, so every question it can be asked is an
 * arrangement built here and an id compared — no deck mounted, no close run.
 *
 * The harness is `directional-focus.test.ts`'s, for the same reason: the rule
 * under test is that one's reckoning asked in an order, and a shape built two
 * ways would be two shapes. Real registrations via `registerCard`, because
 * `railMembersOf` derives a rail from `layoutRole: "sidebar"` — registering is
 * what makes a rail a rail.
 *
 * The regression that motivated the whole thing is the third describe: a deck
 * whose rail was raised last used to hand the close to the rail, so the reader
 * closed one of several cards and watched the furniture light up instead.
 */

import { beforeAll, describe, expect, test } from "bun:test";

import { registerCard } from "../../card-registry";
import type { CardState, DeckState, TugPaneState } from "../../layout-tree";
import type { PlaceRuns } from "../../deck-store-selectors";
import type { DeckImposition } from "../layout-imposer";
import { resolveCloseSuccessor } from "../close-successor";

beforeAll(() => {
  for (const componentId of ["closeRailTop", "closeRailBottom"]) {
    registerCard({
      componentId,
      contentFactory: () => null,
      defaultMeta: { title: componentId, closable: true },
      layoutRole: "sidebar",
    });
  }
  registerCard({
    componentId: "closeContent",
    contentFactory: () => null,
    defaultMeta: { title: "Content", closable: true },
  });
});

function card(id: string, componentId = "closeContent"): CardState {
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

/** The card the close of `cardId`'s pane hands over. */
function successorOfClosing(state: DeckState, cardId: string): string | null {
  const host = state.panes.find((p) => p.cardIds.includes(cardId));
  return resolveCloseSuccessor(state, UNMEASURED, host?.id ?? "missing");
}

describe("inside the closing card's own place", () => {
  /** Slot 0 split three ways, top to bottom; slot 1 holds one card. */
  const split = (): DeckState => {
    const { cards, panes } = columns({ 0: ["a", "b", "c"], 1: ["d"] });
    return deck(cards, panes, {
      kind: "two-up",
      sidebars: {},
      columns: { 0: { mode: "split", order: ["p-a", "p-b", "p-c"] } },
    });
  };

  test("a split column hands over to the member below", () => {
    // The band below rises into the one being vacated, so it is the card
    // standing where the reader is looking.
    expect(successorOfClosing(split(), "a")).toBe("b");
    expect(successorOfClosing(split(), "b")).toBe("c");
  });

  test("the bottom member hands over upward", () => {
    // Nothing below it, so the settle runs the other way.
    expect(successorOfClosing(split(), "c")).toBe("b");
  });

  test("a stacked column hands over to the card behind", () => {
    // Every member draws the same rect, so "below" is z: closing the front
    // card brings the next one forward, which is exactly the successor.
    const { cards } = columns({ 0: ["a", "b"] });
    const panes = [
      pane("p-a", ["a"], { slot: 0 }),
      pane("p-b", ["b"], { slot: 0 }),
    ];
    // Last in `panes` is z-frontmost, so `b` is in front and `a` behind it.
    const state = deck(cards, panes, { kind: "one-up", sidebars: {} });
    expect(successorOfClosing(state, "b")).toBe("a");
  });
});

describe("across the arrangement", () => {
  test("a place's last member hands over to the slot beside it", () => {
    const { cards, panes } = columns({ 0: ["a"], 1: ["b"], 2: ["c"] });
    const state = deck(cards, panes, { kind: "three-up", sidebars: {} });
    // Right before left: a deck read left to right hands the reader onward.
    expect(successorOfClosing(state, "a")).toBe("b");
    expect(successorOfClosing(state, "b")).toBe("c");
    // And the rightmost has only the way back.
    expect(successorOfClosing(state, "c")).toBe("b");
  });

  test("the last card standing hands over to nobody", () => {
    const { cards, panes } = columns({ 0: ["a"] });
    const state = deck(cards, panes, { kind: "one-up", sidebars: {} });
    expect(successorOfClosing(state, "a")).toBeNull();
  });

  test("a pane that is not in the deck has no successor", () => {
    const { cards, panes } = columns({ 0: ["a"], 1: ["b"] });
    const state = deck(cards, panes, { kind: "two-up", sidebars: {} });
    expect(resolveCloseSuccessor(state, UNMEASURED, "p-nothing")).toBeNull();
  });
});

describe("a rail is never the successor", () => {
  const railed = (): DeckState => {
    const { cards, panes } = columns({ 0: ["a"], 1: ["b"] });
    return deck(
      [...cards, card("rt", "closeRailTop")],
      // The rail pane last in `panes` is the regression's whole shape: it was
      // raised most recently, so the old z-order rule handed it the close.
      [...panes, pane("p-rt", ["rt"])],
      { kind: "two-up", sidebars: { closeRailTop: { side: "left" } } },
    );
  };

  test("a close beside a raised rail hands over to the other content card", () => {
    expect(successorOfClosing(railed(), "b")).toBe("a");
  });

  test("the leftmost card crosses the rail rather than landing in it", () => {
    // `left` from slot 0 is the rail, which is refused; the reckoning has
    // already answered `right` by then, so the card beside it wins.
    expect(successorOfClosing(railed(), "a")).toBe("b");
  });

  test("closing the last content card falls back to the rail rather than nobody", () => {
    const state = deck(
      [card("a"), card("rt", "closeRailTop")],
      [pane("p-a", ["a"], { slot: 0 }), pane("p-rt", ["rt"])],
      { kind: "one-up", sidebars: { closeRailTop: { side: "left" } } },
    );
    // The exclusion is a preference, not a refusal: with every survivor a rail
    // the alternative is handing the deck to nobody.
    expect(successorOfClosing(state, "a")).toBe("rt");
  });
});

describe("with nothing imposed", () => {
  test("free panes fall back to the most recently raised content pane", () => {
    // No imposition means no places to reckon over, so the z-order answer is
    // the only one available — and it skips the rail the same way.
    const state = deck(
      [card("a"), card("b"), card("rt", "closeRailTop")],
      [pane("p-a", ["a"]), pane("p-b", ["b"]), pane("p-rt", ["rt"])],
      { sidebars: { closeRailTop: { side: "left" } } },
    );
    expect(successorOfClosing(state, "a")).toBe("b");
    expect(successorOfClosing(state, "b")).toBe("a");
  });
});
