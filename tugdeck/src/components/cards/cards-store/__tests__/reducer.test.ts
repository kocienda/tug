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
      key: "s1:tools",
      collapsed: true,
    });
    expect(next.collapsedCardGroups).toEqual(["s1:tools"]);
  });

  it("expanding removes it", () => {
    const collapsed = reduce(fresh(), {
      type: "set_cards_group_collapsed",
      key: "s1:tools",
      collapsed: true,
    });
    const next = reduce(collapsed, {
      type: "set_cards_group_collapsed",
      key: "s1:tools",
      collapsed: false,
    });
    expect(next.collapsedCardGroups).toEqual([]);
  });

  it("idempotent collapse is a no-op (same-ref)", () => {
    const a = reduce(fresh(), {
      type: "set_cards_group_collapsed",
      key: "s1:files",
      collapsed: true,
    });
    expect(
      reduce(a, {
        type: "set_cards_group_collapsed",
        key: "s1:files",
        collapsed: true,
      }),
    ).toBe(a);
  });

  it("collapsing a group leaves the row order untouched", () => {
    const before = fresh();
    const next = reduce(before, {
      type: "set_cards_group_collapsed",
      key: "s1:files",
      collapsed: true,
    });
    expect(next.cardsRowOrder).toBe(before.cardsRowOrder);
  });
});

describe("CardsStore reducer — prune_to_spaces", () => {
  it("drops the folds of a workspace that is gone, and bare group names", () => {
    let s = fresh();
    for (const key of ["s1:files", "gone:tools", "sessions"]) {
      s = reduce(s, { type: "set_cards_group_collapsed", key, collapsed: true });
    }
    const next = reduce(s, {
      type: "prune_to_spaces",
      live: new Set(["s1"]),
    });
    expect(next.collapsedCardGroups).toEqual(["s1:files"]);
  });

  it("a prune that drops nothing is a no-op (same-ref)", () => {
    const s = reduce(fresh(), {
      type: "set_cards_group_collapsed",
      key: "s1:files",
      collapsed: true,
    });
    expect(
      reduce(s, { type: "prune_to_spaces", live: new Set(["s1"]) }),
    ).toBe(s);
  });

  it("drops a gone workspace's own fold and keeps a live one's", () => {
    let s = fresh();
    s = reduce(s, { type: "toggle_space_collapsed", spaceId: "s1" });
    s = reduce(s, { type: "toggle_space_collapsed", spaceId: "gone" });
    const next = reduce(s, { type: "prune_to_spaces", live: new Set(["s1"]) });
    expect(next.collapsedSpaces).toEqual(["s1"]);
    expect(next.collapsedCardGroups).toBe(s.collapsedCardGroups);
  });
});

describe("CardsStore reducer — toggle_space_collapsed", () => {
  it("folds an open workspace and opens a folded one", () => {
    const folded = reduce(fresh(), { type: "toggle_space_collapsed", spaceId: "s1" });
    expect(folded.collapsedSpaces).toEqual(["s1"]);
    const open = reduce(folded, { type: "toggle_space_collapsed", spaceId: "s1" });
    expect(open.collapsedSpaces).toEqual([]);
  });

  it("leaves the group folds untouched", () => {
    const before = fresh();
    const next = reduce(before, { type: "toggle_space_collapsed", spaceId: "s1" });
    expect(next.collapsedCardGroups).toBe(before.collapsedCardGroups);
  });
});

describe("CardsStore reducer — hydrate", () => {
  it("missing fields keep the existing in-state value (same-ref)", () => {
    const seeded: CardsState = {
      cardsRowOrder: EMPTY_CARDS_ROW_ORDER,
      cardsGroupOrder: ["tools"],
      collapsedCardGroups: ["files"],
      collapsedSpaces: ["s1"],
    };
    expect(reduce(seeded, { type: "hydrate" })).toBe(seeded);
  });

  it("applies every field it carries", () => {
    const next = reduce(fresh(), {
      type: "hydrate",
      cardsRowOrder: { sessions: ["s1"], files: ["f1"], tools: [] },
      cardsGroupOrder: ["tools", "files"],
      collapsedCardGroups: ["files"],
      collapsedSpaces: ["s1"],
    });
    expect(next.cardsRowOrder).toEqual({
      sessions: ["s1"],
      files: ["f1"],
      tools: [],
    });
    expect(next.cardsGroupOrder).toEqual(["tools", "files"]);
    expect(next.collapsedCardGroups).toEqual(["files"]);
    expect(next.collapsedSpaces).toEqual(["s1"]);
  });

  it("equal hydrate values do not bump the reference", () => {
    const seeded: CardsState = {
      cardsRowOrder: EMPTY_CARDS_ROW_ORDER,
      cardsGroupOrder: ["files", "tools"],
      collapsedCardGroups: [],
      collapsedSpaces: ["s1"],
    };
    const next = reduce(seeded, {
      type: "hydrate",
      cardsRowOrder: { sessions: [], files: [], tools: [] },
      cardsGroupOrder: ["files", "tools"],
      collapsedCardGroups: [],
      collapsedSpaces: ["s1"],
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
      collapsedSpaces: [],
    };
    const snap = toSnapshot(s);
    expect(snap.cardsRowOrder.sessions).toEqual(["s1"]);
    expect(snap.cardsGroupOrder).toEqual(["tools", "sessions"]);
    expect(snap.collapsedCardGroups).toEqual(["files"]);
  });
});
