/**
 * `visibleCardRing` / `stepCardRing` — the deck's lateral card ring.
 *
 * The ring is what Previous/Next Card walk, and it is the one part of card
 * navigation that is pure enough to pin exactly: a function of `DeckState`
 * and nothing else, so every membership and ordering question can be asked
 * against a real deck shape without mounting anything.
 *
 * Membership is the half that has already been wrong once. The first cut
 * excluded the rail by analogy to `move-to-slot` — an exclusion that is a
 * fact about *slots*, which a sidebar never takes — and the result was a
 * deck whose always-visible card was the only one the keyboard could not
 * reach laterally, while Jots (the other sidebar, with no such special case)
 * rode the ring normally. So the sidebar cases lead here.
 *
 * Real registrations via `registerCard`, real `DeckState` shapes. The
 * `layoutRole: "sidebar"` declaration is what `findSidebarPanes` derives a
 * rail from, so registering is not setup ceremony — it is the fact under
 * test.
 */

import { beforeAll, describe, expect, test } from "bun:test";

import { registerCard } from "../../card-registry";
import type { CardState, DeckState, TugPaneState } from "../../layout-tree";
import type { DeckImposition } from "../layout-imposer";
import { CARDS_CARD_ID } from "../cards-card-id";
import { stepCardRing, visibleCardCount, visibleCardRing } from "../card-ring";

beforeAll(() => {
  // The two shipped sidebars, plus an ordinary content card. Only
  // `layoutRole` and `componentId` are read by the ring.
  for (const componentId of [CARDS_CARD_ID, "jots"]) {
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

/** The shipped default: the rail pinned to the right rail. */
const RAIL_RIGHT: DeckImposition = { sidebars: { dashes: { side: "right" } } };

function deck(
  cards: CardState[],
  panes: TugPaneState[],
  imposition: DeckImposition = RAIL_RIGHT,
): DeckState {
  return {
    cards,
    panes,
    activePaneId: panes.length > 0 ? panes[panes.length - 1].id : undefined,
    imposition,
    hasFocus: true,
  };
}

describe("membership", () => {
  test("a pinned rail is on the ring", () => {
    // The regression this file exists for. The rail is a card the user reads
    // and types in, standing in plain sight; skipping it left the deck's
    // most-always-visible card unreachable by ⇧⌘[ / ⇧⌘].
    const state = deck(
      [card("a"), card("L", CARDS_CARD_ID)],
      [pane("p1", ["a"], { slot: 0 }), pane("pCards", ["L"])],
    );
    expect(visibleCardRing(state)).toContain("L");
    expect(visibleCardCount(state)).toBe(2);
  });

  test("both sidebars ride the ring, at their own ends", () => {
    // A rail is a place exactly as a slot is, so a rail's front is a ring
    // position exactly as a slot's front is — and the order is the deck's
    // own left-to-right reading.
    const state = deck(
      [card("J", "jots"), card("a"), card("L", CARDS_CARD_ID)],
      [
        pane("pJots", ["J"]),
        pane("p1", ["a"], { slot: 0 }),
        pane("pCards", ["L"]),
      ],
      { sidebars: { jots: { side: "left" }, cards: { side: "right" } } },
    );
    expect(visibleCardRing(state)).toEqual(["J", "a", "L"]);
  });

  test("a sidebar dragged off its pin is an ordinary free pane, still on the ring", () => {
    const unpinned = deck(
      [card("a"), card("L", CARDS_CARD_ID)],
      [pane("p1", ["a"], { slot: 0 }), pane("pCards", ["L"], { position: { x: 900, y: 0 } })],
      { sidebars: { cards: { side: "right", pinned: false } } },
    );
    expect(visibleCardRing(unpinned)).toContain("L");
  });

  test("a buried pane's cards are off the ring — that is the depth axis", () => {
    // Two panes in one slot: only the front one's card is visible, so the
    // lateral ring holds one position and the buried card is Previous/Next
    // Card in Stack's to reach.
    const state = deck(
      [card("front"), card("buried")],
      [pane("pBack", ["buried"], { slot: 0 }), pane("pFront", ["front"], { slot: 0 })],
    );
    expect(visibleCardRing(state)).toEqual(["front"]);
  });

  test("every tab of a visible pane is its own position", () => {
    const state = deck(
      [card("t1"), card("t2"), card("t3")],
      [pane("p1", ["t1", "t2", "t3"], { slot: 0 })],
    );
    expect(visibleCardRing(state)).toEqual(["t1", "t2", "t3"]);
  });
});

describe("order", () => {
  test("slots run by slot number, not by z-order", () => {
    // Structural, never measured: raising a pane must not reorder the ring,
    // or a walk would change direction under the user as they used it.
    const state = deck(
      [card("s0"), card("s1"), card("s2")],
      [
        pane("p2", ["s2"], { slot: 2 }),
        pane("p0", ["s0"], { slot: 0 }),
        pane("p1", ["s1"], { slot: 1 }),
      ],
    );
    expect(visibleCardRing(state)).toEqual(["s0", "s1", "s2"]);
  });

  test("free panes run left to right by stored position", () => {
    const state = deck(
      [card("right"), card("left")],
      [
        pane("pR", ["right"], { position: { x: 800, y: 0 } }),
        pane("pL", ["left"], { position: { x: 100, y: 0 } }),
      ],
    );
    expect(visibleCardRing(state)).toEqual(["left", "right"]);
  });
});

describe("stepping", () => {
  const state = deck(
    [card("a"), card("b"), card("L", CARDS_CARD_ID)],
    [
      pane("p1", ["a"], { slot: 0 }),
      pane("p2", ["b"], { slot: 1 }),
      pane("pCards", ["L"]),
    ],
  );

  test("forward wraps through the rail and back to the start", () => {
    expect(stepCardRing(state, "a", 1)).toBe("b");
    expect(stepCardRing(state, "b", 1)).toBe("L");
    expect(stepCardRing(state, "L", 1)).toBe("a");
  });

  test("backward is the exact inverse", () => {
    expect(stepCardRing(state, "a", -1)).toBe("L");
    expect(stepCardRing(state, "L", -1)).toBe("b");
    expect(stepCardRing(state, "b", -1)).toBe("a");
  });

  test("a one-position ring has nowhere to step", () => {
    const single = deck([card("only")], [pane("p1", ["only"], { slot: 0 })]);
    expect(stepCardRing(single, "only", 1)).toBeNull();
  });

  test("stepping from a buried card answers null rather than teleporting", () => {
    // The starting card is off the ring, so there is no "one step from
    // here". Moving anyway would jump the user somewhere they did not ask
    // for; the depth axis is how a buried card comes forward.
    const buried = deck(
      [card("front"), card("hidden"), card("other")],
      [
        pane("pBack", ["hidden"], { slot: 0 }),
        pane("pFront", ["front"], { slot: 0 }),
        pane("p2", ["other"], { slot: 1 }),
      ],
    );
    expect(stepCardRing(buried, "hidden", 1)).toBeNull();
  });

  test("a deselected deck has no starting point", () => {
    expect(stepCardRing(state, null, 1)).toBeNull();
  });
});
