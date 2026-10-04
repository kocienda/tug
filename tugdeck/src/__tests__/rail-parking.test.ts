/**
 * rail-parking.test.ts — a rail hidden whole parks its members.
 *
 * A hide writes the side's memory and closes nothing: the members' panes and
 * cards stay in the deck, and every reader that asks "which members stand on
 * this rail" — its membership, its width, the band's inset — reads them as
 * absent. These are the pure halves of that, over constructed decks:
 * `isSidebarStanding`, the rail derivation's seats, and a save → reload that
 * must bring a parked rail back parked.
 *
 * Real registrations via `registerCard`, because a rail is derived from
 * `layoutRole: "sidebar"` and sorted into registration order.
 */

import { beforeAll, describe, expect, test } from "bun:test";

import { registerCard } from "../card-registry";
import type { CardState, DeckState, TugPaneState } from "../layout-tree";
import {
  isSidebarParked,
  isSidebarStanding,
  parkedSidebarPaneIds,
  railMembersOf,
  railMembersToPark,
  sidebarRailsOf,
} from "../deck-store-selectors";
import { isSidebarSeated, withRailHidden } from "../lib/layout-imposer";
import { deserialize, serialize } from "../serialization";

beforeAll(() => {
  for (const componentId of ["parkTop", "parkBottom", "parkNew"]) {
    registerCard({
      componentId,
      contentFactory: () => null,
      defaultMeta: { title: componentId, closable: true },
      layoutRole: "sidebar",
    });
  }
  registerCard({
    componentId: "parkContent",
    contentFactory: () => null,
    defaultMeta: { title: "Content", closable: true },
  });
});

function card(id: string, componentId: string): CardState {
  return { id, componentId, title: id, closable: true };
}

function pane(id: string, cardId: string, extra: Partial<TugPaneState> = {}): TugPaneState {
  return {
    id,
    position: { x: 0, y: 0 },
    size: { width: 320, height: 600 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["standard"],
    ...extra,
  };
}

/** A two-member left rail beside one slotted content card. */
function railDeck(): DeckState {
  return {
    cards: [card("c-top", "parkTop"), card("c-bottom", "parkBottom"), card("c-1", "parkContent")],
    panes: [
      pane("p-top", "c-top", { acceptsFamilies: [] }),
      pane("p-bottom", "c-bottom", { acceptsFamilies: [] }),
      pane("p-1", "c-1", { slot: 0 }),
    ],
    activePaneId: "p-1",
    imposition: {
      kind: "one-up",
      sidebars: {
        parkTop: { side: "left", pinned: true },
        parkBottom: { side: "left", pinned: true },
      },
    },
    hasFocus: true,
  } as DeckState;
}

/** `railDeck` with its left rail hidden whole. */
function parkedDeck(): DeckState {
  const deck = railDeck();
  return {
    ...deck,
    imposition: withRailHidden(deck.imposition, "left", ["parkTop", "parkBottom"]),
  };
}

describe("isSidebarStanding", () => {
  test("a present card that no memory names stands", () => {
    const deck = railDeck();
    expect(isSidebarStanding(deck, "parkTop")).toBe(true);
    expect(isSidebarParked(deck, "parkTop")).toBe(false);
  });

  test("a present card its side's memory names is parked, not standing", () => {
    const deck = parkedDeck();
    expect(isSidebarStanding(deck, "parkTop")).toBe(false);
    expect(isSidebarParked(deck, "parkTop")).toBe(true);
    expect([...parkedSidebarPaneIds(deck)].sort()).toEqual(["p-bottom", "p-top"]);
  });

  test("an absent card is neither, memory or not", () => {
    const deck = parkedDeck();
    const closed = {
      ...deck,
      cards: deck.cards.filter((c) => c.id !== "c-top"),
      panes: deck.panes.filter((p) => p.id !== "p-top"),
    };
    expect(isSidebarStanding(closed, "parkTop")).toBe(false);
    expect(isSidebarParked(closed, "parkTop")).toBe(false);
  });
});

describe("a parked member takes no seat", () => {
  test("the rail seats both members while standing", () => {
    const deck = railDeck();
    expect(railMembersOf(deck, "left").map((m) => m.componentId)).toEqual([
      "parkTop",
      "parkBottom",
    ]);
    expect(sidebarRailsOf(deck, { rail: null, column: null }).map((r) => r.side)).toEqual([
      "left",
    ]);
  });

  test("parked, the side has no rail and so insets the band by nothing", () => {
    const deck = parkedDeck();
    expect(isSidebarSeated(deck.imposition, "parkTop")).toBe(false);
    expect(railMembersOf(deck, "left")).toEqual([]);
    expect(sidebarRailsOf(deck, { rail: null, column: null })).toEqual([]);
  });

  test("clearing the memory seats the same panes again", () => {
    const parked = parkedDeck();
    const shown = { ...parked, imposition: withRailHidden(parked.imposition, "left", []) };
    expect(railMembersOf(shown, "left").map((m) => m.paneId)).toEqual(["p-top", "p-bottom"]);
  });
});

describe("what a hide parks", () => {
  test("a standing rail parks its members, back to front", () => {
    expect(railMembersToPark(railDeck(), "left")).toEqual(["parkTop", "parkBottom"]);
  });

  test("a side with nothing seated has nothing to hide", () => {
    expect(railMembersToPark(parkedDeck(), "left")).toEqual([]);
    expect(railMembersToPark(railDeck(), "right")).toEqual([]);
  });

  test("a card standing beside a parked rail parks with it, and stands nobody", () => {
    // `parkNew` was summoned onto the left side while the rail was hidden:
    // seated, beside two parked members. Hiding the side must keep naming
    // the parked two, or they would stand at the hide.
    const parked = parkedDeck();
    const deck: DeckState = {
      ...parked,
      cards: [...parked.cards, card("c-new", "parkNew")],
      panes: [...parked.panes, pane("p-new", "c-new", { acceptsFamilies: [] })],
      imposition: {
        ...parked.imposition,
        sidebars: { ...parked.imposition.sidebars, parkNew: { side: "left", pinned: true } },
      },
    };
    const members = railMembersToPark(deck, "left");
    expect(members).toEqual(["parkTop", "parkBottom", "parkNew"]);
    const hidden = { ...deck, imposition: withRailHidden(deck.imposition, "left", members) };
    expect(railMembersOf(hidden, "left")).toEqual([]);
  });
});

describe("a parked rail through a save and a reload", () => {
  test("its members' panes, cards, and the memory all survive, so it comes back parked", () => {
    const deck = parkedDeck();
    const json = JSON.stringify(
      serialize({ activeSpaceId: "s1", spaces: [{ id: "s1", name: "One", deck }] }),
    );
    const restored = deserialize(json, 1600, 1000).spaces[0].deck;
    expect(restored.panes.map((p) => p.id).sort()).toEqual(["p-1", "p-bottom", "p-top"]);
    expect(restored.cards.map((c) => c.id).sort()).toEqual(["c-1", "c-bottom", "c-top"]);
    expect(restored.imposition.rails?.left?.hidden).toEqual(["parkTop", "parkBottom"]);
    expect(isSidebarParked(restored, "parkTop")).toBe(true);
    expect(isSidebarParked(restored, "parkBottom")).toBe(true);
  });
});
