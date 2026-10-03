/**
 * rail-width.test.ts — a rail is one width, bounded by its own limits.
 *
 * Pure: the commit `DeckManager.setRailWidth` makes is `withRailWidth` over
 * the deck's panes, and the bounds the drag reads are `railWidthLimitsOf`.
 */
import { describe, expect, test } from "bun:test";

import type { TugPaneState } from "../../layout-tree";
import {
  RAIL_LIMIT_GIVE_PX,
  aimRailWidth,
  clampRailWidth,
  parseRailTravel,
  railWidthLimitsOf,
  railTravelOf,
  railTravelShift,
  withRailWidth,
} from "../rail-width";

function pane(id: string, width: number, extra: Partial<TugPaneState> = {}): TugPaneState {
  return {
    id,
    position: { x: 0, y: 0 },
    size: { width, height: 900 },
    cardIds: [`card-${id}`],
    activeCardId: `card-${id}`,
    title: "",
    acceptsFamilies: [],
    ...extra,
  };
}

describe("railWidthLimitsOf", () => {
  test("the floor is the rail's floor and the ceiling is the allocator's", () => {
    expect(railWidthLimitsOf(320, 675)).toEqual({ min: 320, max: 675 });
  });

  test("a floor above the ceiling wins, so the bounds never invert", () => {
    expect(railWidthLimitsOf(700, 675)).toEqual({ min: 700, max: 700 });
  });
});

describe("clampRailWidth", () => {
  const limits = railWidthLimitsOf(320, 675);

  test("a width inside the limits stands as asked", () => {
    expect(clampRailWidth(360, limits)).toBe(360);
  });

  test("a width past either limit lands on it", () => {
    expect(clampRailWidth(200, limits)).toBe(320);
    expect(clampRailWidth(900, limits)).toBe(675);
  });
});

describe("aimRailWidth", () => {
  const limits = railWidthLimitsOf(320, 675);

  test("between the limits the edge follows the hand exactly", () => {
    expect(aimRailWidth(500, limits)).toEqual({ width: 500, shown: 500, limit: null });
    expect(aimRailWidth(675, limits)).toEqual({ width: 675, shown: 675, limit: null });
  });

  test("past the ceiling the edge gives with diminishing returns, and commits the ceiling", () => {
    const near = aimRailWidth(675 + 10, limits);
    const far = aimRailWidth(675 + 200, limits);
    expect(near.width).toBe(675);
    expect(near.limit).toBe("ceiling");
    expect(near.shown).toBeGreaterThan(675);
    expect(near.shown).toBeLessThan(685);
    expect(far.shown).toBeGreaterThan(near.shown);
    expect(far.shown).toBeLessThan(675 + RAIL_LIMIT_GIVE_PX);
  });

  test("past the floor the edge gives inward, and commits the floor", () => {
    const aim = aimRailWidth(320 - 100, limits);
    expect(aim.width).toBe(320);
    expect(aim.limit).toBe("floor");
    expect(aim.shown).toBeLessThan(320);
    expect(aim.shown).toBeGreaterThan(320 - RAIL_LIMIT_GIVE_PX);
  });
});

describe("withRailWidth", () => {
  const members = new Set(["pCards", "pJots", "pLayout"]);

  test("every member of the rail lands at the width, and nothing else moves", () => {
    const chain = pane("p1", 400, { slot: 0 });
    const panes = [
      chain,
      pane("pCards", 420),
      pane("pJots", 420),
      pane("pLayout", 480),
    ];
    const { panes: next, resized } = withRailWidth(panes, members, 360);

    for (const id of members) {
      expect(next.find((p) => p.id === id)?.size).toEqual({ width: 360, height: 900 });
    }
    expect(next[0]).toBe(chain);
    expect(resized.map((p) => p.id).sort()).toEqual(["pCards", "pJots", "pLayout"]);
  });

  test("a member already at the width is left as it was and is not reported", () => {
    const standing = pane("pJots", 360);
    const { panes: next, resized } = withRailWidth(
      [pane("pCards", 420), standing],
      members,
      360,
    );
    expect(next[1]).toBe(standing);
    expect(resized.map((p) => p.id)).toEqual(["pCards"]);
  });

  test("a member whose width moves gives up its width-preset stamp", () => {
    const { panes: next } = withRailWidth(
      [pane("pCards", 420, { widthPreset: "slim" })],
      members,
      360,
    );
    expect(next[0].widthPreset).toBeUndefined();
  });
});

describe("railTravelOf / parseRailTravel", () => {
  test("a fit placement carries its travel fraction and slot width", () => {
    const stamp = railTravelOf({ slot: 2, count: 3 }, 400);
    expect(parseRailTravel(stamp)).toEqual({ kind: "fit", fraction: 1, slotWidth: 400 });
  });

  test("a flow placement carries only that it is on the strip", () => {
    expect(parseRailTravel(railTravelOf({ slot: 0, count: 3, flow: { stripLeft: 10 } }, 400))).toEqual({
      kind: "flow",
    });
  });

  test("anything else is not a stamp", () => {
    expect(parseRailTravel(null)).toBeNull();
    expect(parseRailTravel("fit:x:400")).toBeNull();
    expect(parseRailTravel("")).toBeNull();
  });
});

describe("railTravelShift", () => {
  const fitStart = { band: 1000, flow: null };

  test("a left rail's growth carries a slot-0 card by the whole growth", () => {
    const travel = { kind: "fit", fraction: 0, slotWidth: 300 } as const;
    expect(railTravelShift(travel, "left", fitStart, 60)).toBe(60);
    expect(railTravelShift(travel, "left", fitStart, -40)).toBe(-40);
  });

  test("a last-slot card stands still under a left rail, which only spends its slack", () => {
    const travel = { kind: "fit", fraction: 1, slotWidth: 300 } as const;
    expect(railTravelShift(travel, "left", fitStart, 60)).toBe(0);
  });

  test("under a right rail a card moves by its fraction of the slack the band lost", () => {
    const travel = { kind: "fit", fraction: 0.5, slotWidth: 300 } as const;
    expect(railTravelShift(travel, "right", fitStart, 60)).toBe(-30);
    expect(railTravelShift(travel, "right", fitStart, -60)).toBe(30);
  });

  test("a card already wider than the band's slack holds at the near edge", () => {
    // band 1000, slot 990: 10px of slack, and growth of 60 spends it all.
    const travel = { kind: "fit", fraction: 1, slotWidth: 990 } as const;
    expect(railTravelShift(travel, "right", fitStart, 60)).toBe(-10);
  });

  test("on flow, a left rail carries the strip, less what the offset's clamp gives back", () => {
    // Strip 1400 under a band of 1000: up to 400 of offset may stand. With 380
    // standing, narrowing the band by 60 raises the clamp to 460, so the
    // offset stays 380 and the strip moves with the inset alone.
    const start = { band: 1000, flow: { offset: 380, strip: 1400 } };
    expect(railTravelShift({ kind: "flow" }, "left", start, 60)).toBe(60);
    // Widening the band by 60 lowers the clamp to 340: 40px of offset is
    // given back, so the strip moves right by that much less the inset.
    expect(railTravelShift({ kind: "flow" }, "left", start, -60)).toBe(-60 + 40);
  });

  test("on flow, a right rail moves the strip only through the clamp", () => {
    const start = { band: 1000, flow: { offset: 380, strip: 1400 } };
    expect(railTravelShift({ kind: "flow" }, "right", start, 60)).toBe(0);
    expect(railTravelShift({ kind: "flow" }, "right", start, -60)).toBe(40);
  });

  // A rail widened until the rails cover the canvas leaves a band of no width
  // — 200px overlapped here — and a press on its edge must still narrow it
  // back. The drag starts from that signed band; the travel terms clamp it.
  describe("from a band of no width", () => {
    const covered = { band: -200, flow: null };

    test("a fit card stays put until the band reopens past its slot", () => {
      const travel = { kind: "fit", fraction: 0.5, slotWidth: 300 } as const;
      // Narrowed by 100: the band is still -100, so there is no slack yet.
      expect(railTravelShift(travel, "right", covered, -100)).toBe(0);
      // Narrowed by 600: the band is 400, 100px of slack, half of it this card's.
      expect(railTravelShift(travel, "right", covered, -600)).toBe(50);
    });

    test("a left rail still carries a slot-0 card by the whole of its narrowing", () => {
      const travel = { kind: "fit", fraction: 0, slotWidth: 300 } as const;
      expect(railTravelShift(travel, "left", covered, -600)).toBe(-600);
    });

    test("on flow, the offset holds until the band reopens past the clamp", () => {
      const start = { band: -200, flow: { offset: 380, strip: 1400 } };
      expect(railTravelShift({ kind: "flow" }, "right", start, -600)).toBe(0);
      // Narrowed by 1300: the band is 1100, the clamp is 300, 80px given back.
      expect(railTravelShift({ kind: "flow" }, "right", start, -1300)).toBe(80);
    });
  });
});
