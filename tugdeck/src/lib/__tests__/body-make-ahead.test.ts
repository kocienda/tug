import { describe, expect, test } from "bun:test";

import { aheadOrder, nextAhead, pendingAhead, switchSettled, type AheadFacts } from "../body-make-ahead";

const base: AheadFacts = {
  activeSpaceId: "home",
  spaceOrder: ["home", "a", "b", "c"],
  recency: ["home"],
  mounted: new Set(["home"]),
  cards: [{ cardId: "h1", spaceId: "home", state: "painted", timeEvicted: false }],
  unhanded: [],
  switching: false,
};

describe("body-make-ahead", () => {
  test("a pending workspace's cards are made at once, while another page loads", () => {
    const f: AheadFacts = {
      ...base,
      mounted: new Set(["home", "new"]),
      cards: [
        { cardId: "h1", spaceId: "home", state: "creating", timeEvicted: false },
        { cardId: "n1", spaceId: "new", state: "unmade", timeEvicted: false },
        { cardId: "n2", spaceId: "new", state: "creating", timeEvicted: false },
      ],
      unhanded: [{ cardId: "n0", spaceId: "new" }],
    };
    expect(pendingAhead(f, "new")).toEqual({ kind: "make", spaceId: "new", cardIds: ["n0", "n1"] });
    // The ordinary pass, which waits for nothing to be loading, makes nothing.
    expect(nextAhead(f)).toBeNull();
  });

  test("a pending workspace is never in the ordinary pass's order", () => {
    const f: AheadFacts = { ...base, spaceOrder: ["home"], mounted: new Set(["home", "new"]), unhanded: [{ cardId: "n0", spaceId: "new" }] };
    expect(aheadOrder(f)).toEqual([]);
    expect(nextAhead(f)).toBeNull();
  });

  test("nothing is made for no pending workspace, or one with every page asked for", () => {
    expect(pendingAhead(base, undefined)).toBeNull();
    const f: AheadFacts = { ...base, mounted: new Set(["home", "new"]), cards: [...base.cards, { cardId: "n1", spaceId: "new", state: "painted", timeEvicted: false }] };
    expect(pendingAhead(f, "new")).toBeNull();
  });

  test("parked spaces go the most recently shown first, then the rest in the list's order", () => {
    expect(aheadOrder({ ...base, recency: ["home", "c", "gone"] })).toEqual(["c", "a", "b"]);
  });

  test("nothing is made while a page is loading", () => {
    expect(nextAhead({ ...base, cards: [{ cardId: "h1", spaceId: "home", state: "creating", timeEvicted: false }] })).toBeNull();
    expect(nextAhead({ ...base, cards: [{ cardId: "h1", spaceId: "home", state: "ready", timeEvicted: false }] })).toBeNull();
  });

  test("the pass mounts nothing: a parked space not mounted is passed over", () => {
    expect(nextAhead({ ...base, unhanded: [{ cardId: "a0", spaceId: "a" }] })).toBeNull();
  });

  test("a mounted space's unmade cards are made, and one the host's clock evicted", () => {
    const f: AheadFacts = {
      ...base,
      mounted: new Set(["home", "a"]),
      cards: [
        ...base.cards,
        { cardId: "a1", spaceId: "a", state: "unmade", timeEvicted: false },
        { cardId: "a2", spaceId: "a", state: "evicted", timeEvicted: true },
        { cardId: "a3", spaceId: "a", state: "painted", timeEvicted: false },
      ],
    };
    expect(nextAhead(f)).toEqual({ kind: "make", spaceId: "a", cardIds: ["a1", "a2"] });
  });

  test("a mounted space's cards not yet handed off are made first", () => {
    const f: AheadFacts = {
      ...base,
      mounted: new Set(["home", "a"]),
      cards: [...base.cards, { cardId: "a1", spaceId: "a", state: "unmade", timeEvicted: false }],
      unhanded: [{ cardId: "a0", spaceId: "a" }],
    };
    expect(nextAhead(f)).toEqual({ kind: "make", spaceId: "a", cardIds: ["a0", "a1"] });
  });

  test("a card pressure evicted is not made again, and the pass moves on", () => {
    const f: AheadFacts = {
      ...base,
      mounted: new Set(["home", "a"]),
      cards: [...base.cards, { cardId: "a1", spaceId: "a", state: "evicted", timeEvicted: false }],
      unhanded: [{ cardId: "b0", spaceId: "b" }],
    };
    const g: AheadFacts = { ...f, mounted: new Set(["home", "a", "b"]) };
    expect(nextAhead(g)).toEqual({ kind: "make", spaceId: "b", cardIds: ["b0"] });
  });

  test("with every space made, nothing", () => {
    expect(nextAhead({ ...base, mounted: new Set(["home", "a", "b", "c"]) })).toBeNull();
  });

  test("a switch that has not settled makes nothing ahead", () => {
    const f: AheadFacts = { ...base, mounted: new Set(["home", "a"]), unhanded: [{ cardId: "a0", spaceId: "a" }] };
    expect(nextAhead(f)).toEqual({ kind: "make", spaceId: "a", cardIds: ["a0"] });
    expect(nextAhead({ ...f, switching: true })).toBeNull();
  });

  test("a switch settles once none of the arriving workspace's pages is loading", () => {
    const at = (state: NonNullable<AheadFacts["cards"][number]["state"]>) =>
      switchSettled({ activeSpaceId: "a", cards: [
        { cardId: "a1", spaceId: "a", state, timeEvicted: false },
        { cardId: "a2", spaceId: "a", state: "painted", timeEvicted: false },
      ] });
    expect(at("creating")).toBe(false);
    expect(at("ready")).toBe(false);
    for (const state of ["painted", "failed", "evicted", "unmade"] as const) expect(at(state)).toBe(true);
  });

  test("a parked workspace's loading page does not hold a switch", () => {
    expect(switchSettled({ activeSpaceId: "a", cards: [
      { cardId: "a1", spaceId: "a", state: "painted", timeEvicted: false },
      { cardId: "b1", spaceId: "b", state: "creating", timeEvicted: false },
    ] })).toBe(true);
  });
});
