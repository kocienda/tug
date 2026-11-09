import { describe, expect, test } from "bun:test";

import { aheadOrder, nextAhead, type AheadFacts } from "../body-make-ahead";

const base: AheadFacts = {
  activeSpaceId: "home",
  spaceOrder: ["home", "a", "b", "c"],
  recency: ["home"],
  mounted: new Set(["home"]),
  cards: [{ cardId: "h1", spaceId: "home", state: "painted", timeEvicted: false }],
  unhanded: [],
};

describe("body-make-ahead", () => {
  test("parked spaces go the most recently shown first, then the rest in the list's order", () => {
    expect(aheadOrder({ ...base, recency: ["home", "c", "gone"] })).toEqual(["c", "a", "b"]);
  });

  test("nothing is made while a page is loading", () => {
    expect(nextAhead({ ...base, cards: [{ cardId: "h1", spaceId: "home", state: "creating", timeEvicted: false }] })).toBeNull();
    expect(nextAhead({ ...base, cards: [{ cardId: "h1", spaceId: "home", state: "ready", timeEvicted: false }] })).toBeNull();
  });

  test("an unmounted parked space is mounted first", () => {
    expect(nextAhead(base)).toEqual({ kind: "mount", spaceId: "a" });
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
    };
    expect(nextAhead(f)).toEqual({ kind: "mount", spaceId: "b" });
  });

  test("with every space made, nothing", () => {
    expect(nextAhead({ ...base, mounted: new Set(["home", "a", "b", "c"]) })).toBeNull();
  });
});
