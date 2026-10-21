/**
 * body-census — a body card's tier from its facts, the counts, and the
 * Layout card's lines.
 *
 * @covers tugdeck/src/lib/body-census.ts
 */

import { describe, expect, test } from "bun:test";
import { NO_BODIES, bodyTier, countTiers, countsLine, pressureLine, sameCounts, type BodyTierFacts } from "../body-census";

const placed = (active: boolean, layerShown: boolean): BodyTierFacts["placed"] => ({ active, layerShown });

describe("bodyTier", () => {
  test("an evicted card is evicted wherever it stands", () => {
    expect(bodyTier({ evicted: true, dormant: false, placed: placed(true, true) })).toBe("evicted");
    expect(bodyTier({ evicted: true, dormant: false, placed: null })).toBe("evicted");
  });

  test("the active card of a pane in the shown workspace is shown, even if its page has not woken", () => {
    expect(bodyTier({ evicted: false, dormant: false, placed: placed(true, true) })).toBe("shown");
    expect(bodyTier({ evicted: false, dormant: true, placed: placed(true, true) })).toBe("shown");
  });

  test("an inactive tab in the shown workspace is a sibling, or dormant once its page sleeps", () => {
    expect(bodyTier({ evicted: false, dormant: false, placed: placed(false, true) })).toBe("sibling");
    expect(bodyTier({ evicted: false, dormant: true, placed: placed(false, true) })).toBe("dormant");
  });

  test("a card out of the shown workspace is hidden, or dormant once its page sleeps", () => {
    expect(bodyTier({ evicted: false, dormant: false, placed: placed(true, false) })).toBe("hidden");
    expect(bodyTier({ evicted: false, dormant: true, placed: placed(true, false) })).toBe("dormant");
  });

  test("a card in no pane has no tier", () => {
    expect(bodyTier({ evicted: false, dormant: false, placed: null })).toBeNull();
  });
});

describe("counts", () => {
  test("count each tier and skip a card with none", () => {
    expect(countTiers(["shown", "shown", "sibling", null, "evicted", "dormant", "hidden"])).toEqual({
      shown: 2,
      sibling: 1,
      hidden: 1,
      dormant: 1,
      evicted: 1,
    });
    expect(countTiers([])).toEqual(NO_BODIES);
  });

  test("compare by value", () => {
    expect(sameCounts(countTiers(["shown"]), { ...NO_BODIES, shown: 1 })).toBe(true);
    expect(sameCounts(countTiers(["shown"]), NO_BODIES)).toBe(false);
  });
});

describe("the Layout card's lines", () => {
  test("the counts read in tier order, empty tiers left out", () => {
    expect(countsLine({ shown: 2, sibling: 0, hidden: 1, dormant: 3, evicted: 4 })).toBe("2 shown · 1 hidden · 3 dormant · 4 evicted");
    expect(countsLine(NO_BODIES)).toBe("none");
  });

  test("the pressure reads as none, or the level and its time", () => {
    expect(pressureLine(null)).toBe("none since launch");
    const line = pressureLine({ level: "warning", at: new Date(2026, 9, 21, 14, 3, 12).getTime() });
    expect(line.startsWith("warning at ")).toBe(true);
    expect(line).toContain("03");
    expect(line).toContain("12");
  });
});
