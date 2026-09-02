/**
 * Pure-logic tests for the Cards store reducer. Covers the group row order,
 * the group order, collapse membership, and hydrate — including the "no-op
 * events return the same state reference" contract `useSyncExternalStore`
 * needs to keep subscribers quiescent.
 */

import { describe, it, expect } from "bun:test";

import {
  createInitialState,
  EMPTY_CARDS_ROW_ORDER,
  reduce,
  toSnapshot,
  type CardsState,
} from "@/components/cards/cards-store/reducer";

function fresh(): CardsState {
  return createInitialState();
}

describe("CardsStore reducer — set_cards_row_order", () => {
  it("replaces one group's order", () => {
    const next = reduce(fresh(), {
      type: "set_cards_row_order",
      group: "files",
      order: ["a", "b"],
    });
    expect(next.cardsRowOrder.files).toEqual(["a", "b"]);
  });

  it("leaves the other groups' lists at the SAME reference", () => {
    const before = fresh();
    const next = reduce(before, {
      type: "set_cards_row_order",
      group: "files",
      order: ["a"],
    });
    expect(next.cardsRowOrder.sessions).toBe(before.cardsRowOrder.sessions);
    expect(next.cardsRowOrder.tools).toBe(before.cardsRowOrder.tools);
  });

  it("an equal order is a no-op (same-ref)", () => {
    const a = reduce(fresh(), {
      type: "set_cards_row_order",
      group: "sessions",
      order: ["s1", "s2"],
    });
    expect(
      reduce(a, {
        type: "set_cards_row_order",
        group: "sessions",
        order: ["s1", "s2"],
      }),
    ).toBe(a);
  });

  it("copies the incoming order so a later mutation cannot reach state", () => {
    const incoming = ["a", "b"];
    const next = reduce(fresh(), {
      type: "set_cards_row_order",
      group: "tools",
      order: incoming,
    });
    incoming.push("c");
    expect(next.cardsRowOrder.tools).toEqual(["a", "b"]);
  });
});

describe("CardsStore reducer — set_cards_group_order", () => {
  it("replaces the order", () => {
    const next = reduce(fresh(), {
      type: "set_cards_group_order",
      order: ["tools", "sessions"],
    });
    expect(next.cardsGroupOrder).toEqual(["tools", "sessions"]);
  });

  it("equal order is a no-op (same-ref)", () => {
    const a = reduce(fresh(), {
      type: "set_cards_group_order",
      order: ["files", "tools"],
    });
    expect(
      reduce(a, { type: "set_cards_group_order", order: ["files", "tools"] }),
    ).toBe(a);
  });

  it("copies the input array (no aliasing)", () => {
    const input = ["files"];
    const next = reduce(fresh(), {
      type: "set_cards_group_order",
      order: input,
    });
    input.push("tools");
    expect(next.cardsGroupOrder).toEqual(["files"]);
  });
});

describe("CardsStore reducer — set_cards_group_collapsed", () => {
  it("collapsing adds the group", () => {
    const next = reduce(fresh(), {
      type: "set_cards_group_collapsed",
      group: "tools",
      collapsed: true,
    });
    expect(next.collapsedCardGroups).toEqual(["tools"]);
  });

  it("expanding removes it", () => {
    const collapsed = reduce(fresh(), {
      type: "set_cards_group_collapsed",
      group: "tools",
      collapsed: true,
    });
    const next = reduce(collapsed, {
      type: "set_cards_group_collapsed",
      group: "tools",
      collapsed: false,
    });
    expect(next.collapsedCardGroups).toEqual([]);
  });

  it("idempotent collapse is a no-op (same-ref)", () => {
    const a = reduce(fresh(), {
      type: "set_cards_group_collapsed",
      group: "files",
      collapsed: true,
    });
    expect(
      reduce(a, {
        type: "set_cards_group_collapsed",
        group: "files",
        collapsed: true,
      }),
    ).toBe(a);
  });

  it("collapsing a group leaves the row order untouched", () => {
    const before = fresh();
    const next = reduce(before, {
      type: "set_cards_group_collapsed",
      group: "files",
      collapsed: true,
    });
    expect(next.cardsRowOrder).toBe(before.cardsRowOrder);
  });
});

describe("CardsStore reducer — hydrate", () => {
  it("missing fields keep the existing in-state value (same-ref)", () => {
    const seeded: CardsState = {
      cardsRowOrder: EMPTY_CARDS_ROW_ORDER,
      cardsGroupOrder: ["tools"],
      collapsedCardGroups: ["files"],
    };
    expect(reduce(seeded, { type: "hydrate" })).toBe(seeded);
  });

  it("applies every field it carries", () => {
    const next = reduce(fresh(), {
      type: "hydrate",
      cardsRowOrder: { sessions: ["s1"], files: ["f1"], tools: [] },
      cardsGroupOrder: ["tools", "files"],
      collapsedCardGroups: ["files"],
    });
    expect(next.cardsRowOrder).toEqual({
      sessions: ["s1"],
      files: ["f1"],
      tools: [],
    });
    expect(next.cardsGroupOrder).toEqual(["tools", "files"]);
    expect(next.collapsedCardGroups).toEqual(["files"]);
  });

  it("equal hydrate values do not bump the reference", () => {
    const seeded: CardsState = {
      cardsRowOrder: EMPTY_CARDS_ROW_ORDER,
      cardsGroupOrder: ["files", "tools"],
      collapsedCardGroups: [],
    };
    const next = reduce(seeded, {
      type: "hydrate",
      cardsRowOrder: { sessions: [], files: [], tools: [] },
      cardsGroupOrder: ["files", "tools"],
      collapsedCardGroups: [],
    });
    expect(next).toBe(seeded);
  });

  it("copies the hydrated row order per group (no aliasing)", () => {
    const incoming = { sessions: ["s1"], files: [], tools: [] };
    const next = reduce(fresh(), { type: "hydrate", cardsRowOrder: incoming });
    incoming.sessions.push("s2");
    expect(next.cardsRowOrder.sessions).toEqual(["s1"]);
  });
});

describe("CardsStore reducer — toSnapshot", () => {
  it("reflects all state fields", () => {
    const s: CardsState = {
      cardsRowOrder: { sessions: ["s1"], files: [], tools: ["t1"] },
      cardsGroupOrder: ["tools", "sessions"],
      collapsedCardGroups: ["files"],
    };
    const snap = toSnapshot(s);
    expect(snap.cardsRowOrder.sessions).toEqual(["s1"]);
    expect(snap.cardsGroupOrder).toEqual(["tools", "sessions"]);
    expect(snap.collapsedCardGroups).toEqual(["files"]);
  });
});
