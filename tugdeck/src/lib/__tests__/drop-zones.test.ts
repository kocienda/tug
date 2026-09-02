/**
 * The drop-zone engine's pure half, over synthetic geometry.
 *
 * Everything here feeds rects in by hand rather than measuring a canvas, which
 * is the whole point of the module being pure: the vocabulary a card sees, the
 * tile each zone would land it in, and which zone a pointer is asking for are
 * all answerable without a pointer, a DOM, or a deck.
 */

import { describe, expect, it } from "bun:test";
import type { DeckState } from "../../layout-tree";
import type { Rect } from "../../snap";
import {
  PLACE_OVERFLOW_VISIBLE_MEMBERS,
  IMPOSITION_GAP_PX,
} from "../layout-imposer";
import {
  AUTOSCROLL_MARGIN_PX,
  AUTOSCROLL_RATE_PX_PER_SEC,
  ZONE_HYSTERESIS_PX,
  autoscrollDelta,
  autoscrollKey,
  dropZoneKey,
  enumerateDropZones,
  hitRectOf,
  pickLiveZone,
  type AutoscrollTarget,
  type DropZone,
  type DropZoneMeasurements,
} from "../drop-zones";

// ---- Fixtures ----

const RUN_TOP = 10;
const RUN_HEIGHT = 600;
const SLOT_X = [0, 400, 800];
const SLOT_WIDTH = 380;

function pane(id: string, slot?: number) {
  return {
    id,
    position: { x: 0, y: 0 },
    size: { width: SLOT_WIDTH, height: RUN_HEIGHT },
    cardIds: [`card-${id}`],
    activeCardId: `card-${id}`,
    title: id,
    acceptsFamilies: ["standard"],
    ...(slot !== undefined ? { slot } : {}),
  };
}

function deck(
  panes: ReturnType<typeof pane>[],
  imposition: Omit<DeckState["imposition"], "sidebars"> = { kind: "three-up" },
): DeckState {
  return {
    cards: panes.map((p) => ({
      id: p.activeCardId,
      componentId: "gallery",
      title: p.title,
      closable: true,
    })),
    panes,
    imposition: { sidebars: {}, ...imposition },
    hasFocus: true,
  };
}

function slotRect(slot: number): Rect {
  return { x: SLOT_X[slot], y: RUN_TOP, width: SLOT_WIDTH, height: RUN_HEIGHT };
}

/** Members of a split column, stacked down the slot's run at the given
 *  heights — the geometry the imposer would have produced. */
function splitRects(slot: number, heights: readonly number[]): Rect[] {
  const rects: Rect[] = [];
  let y = RUN_TOP;
  for (const height of heights) {
    rects.push({ x: SLOT_X[slot], y, width: SLOT_WIDTH, height });
    y += height + IMPOSITION_GAP_PX;
  }
  return rects;
}

function measured(overrides: Partial<DropZoneMeasurements> = {}): DropZoneMeasurements {
  return {
    slots: new Map(),
    panes: new Map(),
    tabBars: new Map(),
    rails: [],
    ...overrides,
  };
}

function keys(zones: readonly DropZone[]): string[] {
  return zones.map(dropZoneKey);
}

// ---- Vocabulary ----

describe("a card only ever sees the places its own kind can stand in", () => {
  it("a lone content card sees its own slot, a neighbour's halves, and the empty anchor", () => {
    // p2 stands alone in slot 1, so dropping there divides ([P07]): the slot
    // advertises the two positions the split will make, not a whole-slot
    // join. The card's own slot and the empty anchor keep their whole-slot
    // zones — nothing to divide in either.
    const state = deck([pane("p1", 0), pane("p2", 1)]);
    const { zones, origin } = enumerateDropZones(
      state,
      "p1",
      measured({
        slots: new Map([
          [0, slotRect(0)],
          [1, slotRect(1)],
          [2, slotRect(2)],
        ]),
        panes: new Map([
          ["p1", slotRect(0)],
          ["p2", slotRect(1)],
        ]),
      }),
    );
    expect(keys(zones)).toEqual([
      "slot:0",
      "column:1:0",
      "column:1:1",
      "slot:2",
    ]);
    expect(origin).not.toBeNull();
    expect(dropZoneKey(origin!)).toBe("slot:0");
    // The two positions preview the halves the commit's seam will cut, and
    // their bands meet at the run's midpoint.
    const half = (RUN_HEIGHT - IMPOSITION_GAP_PX) / 2;
    const upper = zones[1];
    const lower = zones[2];
    expect(upper.rect.y).toBeCloseTo(RUN_TOP, 6);
    expect(upper.rect.height).toBeCloseTo(half, 6);
    expect(lower.rect.y).toBeCloseTo(RUN_TOP + half + IMPOSITION_GAP_PX, 6);
    expect(lower.rect.y + lower.rect.height).toBeCloseTo(
      RUN_TOP + RUN_HEIGHT,
      6,
    );
    expect(hitRectOf(upper).y + hitRectOf(upper).height).toBeCloseTo(
      hitRectOf(lower).y,
      6,
    );
  });

  it("a stacked slot advertises itself as one zone, not one per member", () => {
    const state = deck([pane("p1", 0), pane("p2", 1), pane("p3", 1)]);
    const { zones } = enumerateDropZones(
      state,
      "p1",
      measured({
        slots: new Map([
          [0, slotRect(0)],
          [1, slotRect(1)],
        ]),
        panes: new Map([
          ["p1", slotRect(0)],
          ["p2", slotRect(1)],
          ["p3", slotRect(1)],
        ]),
      }),
    );
    expect(keys(zones)).toEqual(["slot:0", "slot:1"]);
  });

  it("an empty slot with no measured anchor advertises nothing", () => {
    const state = deck([pane("p1", 0)]);
    const { zones } = enumerateDropZones(
      state,
      "p1",
      measured({
        slots: new Map([[0, slotRect(0)]]),
        panes: new Map([["p1", slotRect(0)]]),
      }),
    );
    expect(keys(zones)).toEqual(["slot:0"]);
  });

  it("a free pane on an imposed deck is arrangeable nowhere", () => {
    const state = deck([pane("p1"), pane("p2", 1)]);
    const set = enumerateDropZones(
      state,
      "p1",
      measured({
        slots: new Map([[1, slotRect(1)]]),
        panes: new Map([["p2", slotRect(1)]]),
      }),
    );
    expect(set.zones).toEqual([]);
    expect(set.origin).toBeNull();
  });

  it("an unimposed deck advertises nothing at all", () => {
    const state = deck([pane("p1", 0)], {});
    const set = enumerateDropZones(
      state,
      "p1",
      measured({ slots: new Map([[0, slotRect(0)]]) }),
    );
    expect(set.zones).toEqual([]);
    expect(set.origin).toBeNull();
  });

  it("a sidebar card sees its rail's positions and no content slot", () => {
    const state = deck([pane("p1", 0), pane("tripwires")]);
    const railRects = splitRects(0, [280, 300]);
    const set = enumerateDropZones(
      state,
      "tripwires",
      measured({
        slots: new Map([[0, slotRect(0)]]),
        panes: new Map([
          ["p1", slotRect(0)],
          ["tripwires", railRects[0]],
          ["notes", railRects[1]],
        ]),
        tabBars: new Map([["p1", { x: 0, y: RUN_TOP, width: SLOT_WIDTH, height: 30 }]]),
        rails: [{ side: "right", members: ["tripwires", "notes"] }],
      }),
    );
    expect(keys(set.zones)).toEqual(["rail:right:0", "rail:right:1"]);
    expect(dropZoneKey(set.origin!)).toBe("rail:right:0");
  });

  it("tab bars are zones for a content card and never for a sidebar card", () => {
    const state = deck([pane("p1", 0), pane("p2", 1), pane("tripwires")]);
    const tabBars = new Map([
      ["p2", { x: SLOT_X[1], y: RUN_TOP, width: SLOT_WIDTH, height: 30 }],
    ]);
    const panes = new Map([
      ["p1", slotRect(0)],
      ["p2", slotRect(1)],
      ["tripwires", slotRect(2)],
    ]);
    const content = enumerateDropZones(
      state,
      "p1",
      measured({ slots: new Map([[1, slotRect(1)]]), panes, tabBars }),
    );
    expect(keys(content.zones)).toContain("tab:p2");

    const sidebar = enumerateDropZones(
      state,
      "tripwires",
      measured({
        slots: new Map([[1, slotRect(1)]]),
        panes,
        tabBars,
        rails: [{ side: "right", members: ["tripwires"] }],
      }),
    );
    expect(keys(sidebar.zones)).toEqual(["rail:right:0"]);
  });
});

// ---- Own-column positions ----

describe("a split column advertises one position per place a member can stand", () => {
  const split = { kind: "three-up" as const, columns: { 0: { mode: "split" as const } } };

  it("a two-member column offers both positions and starts on the card's own", () => {
    const state = deck([pane("p1", 0), pane("p2", 0)], split);
    const rects = splitRects(0, [250, 345]);
    const { zones, origin } = enumerateDropZones(
      state,
      "p1",
      measured({
        slots: new Map(),
        panes: new Map([
          ["p1", rects[0]],
          ["p2", rects[1]],
        ]),
      }),
    );
    expect(keys(zones)).toEqual(["column:0:0", "column:0:1"]);
    expect(dropZoneKey(origin!)).toBe("column:0:0");
  });

  it("the tiles are the division the commit would produce, shares travelling with the card", () => {
    // p1 holds a quarter share, p2 three quarters. The measured rects are what
    // `memberPins` draws for those shares: fractions of the 600 run, half a
    // gap surrendered at the seam.
    const state = deck([pane("p1", 0), pane("p2", 0)], {
      kind: "three-up",
      columns: { 0: { mode: "split", shares: { p1: 0.5, p2: 1.5 } } },
    });
    const half = IMPOSITION_GAP_PX / 2;
    const rects = splitRects(0, [
      RUN_HEIGHT / 4 - half,
      (RUN_HEIGHT * 3) / 4 - half,
    ]);
    const { zones } = enumerateDropZones(
      state,
      "p1",
      measured({
        panes: new Map([
          ["p1", rects[0]],
          ["p2", rects[1]],
        ]),
      } as Partial<DropZoneMeasurements>),
    );
    // Position 0 is where p1 already stands — the fraction arithmetic lands
    // on the measured rect to the pixel, because both come from the same
    // seam fractions.
    expect(zones[0].rect.y).toBeCloseTo(rects[0].y, 6);
    expect(zones[0].rect.height).toBeCloseTo(rects[0].height, 6);
    // Position 1 puts p1 below p2, and p1's QUARTER share travels with it:
    // the seam of the candidate order [p2, p1] falls at three quarters of the
    // run, so the tile is quarter-height at the bottom — never p1's place cut
    // at p2's measured height.
    expect(zones[1].rect.y).toBeCloseTo(
      RUN_TOP + (RUN_HEIGHT * 3) / 4 + half,
      6,
    );
    expect(zones[1].rect.height).toBeCloseTo(RUN_HEIGHT / 4 - half, 6);
  });

  it("an overflowing column's positions are the run/2.5 strip", () => {
    const state = deck([pane("p1", 0), pane("p2", 0), pane("p3", 0)], split);
    const memberH = RUN_HEIGHT / PLACE_OVERFLOW_VISIBLE_MEMBERS;
    const rects = splitRects(0, [memberH, memberH, memberH]);
    const { zones } = enumerateDropZones(
      state,
      "p1",
      measured({
        panes: new Map([
          ["p1", rects[0]],
          ["p2", rects[1]],
          ["p3", rects[2]],
        ]),
      } as Partial<DropZoneMeasurements>),
    );
    expect(keys(zones)).toEqual(["column:0:0", "column:0:1", "column:0:2"]);
    for (const [i, zone] of zones.entries()) {
      expect(zone.rect.height).toBeCloseTo(memberH, 6);
      expect(zone.rect.y).toBeCloseTo(RUN_TOP + i * (memberH + IMPOSITION_GAP_PX), 6);
    }
  });

  it("a foreign split column advertises one more position than it has members", () => {
    const state = deck([pane("p1", 0), pane("p2", 1), pane("p3", 1)], {
      kind: "three-up",
      columns: { 1: { mode: "split" } },
    });
    const rects = splitRects(1, [300, 295]);
    const { zones, origin } = enumerateDropZones(
      state,
      "p1",
      measured({
        slots: new Map([[0, slotRect(0)]]),
        panes: new Map([
          ["p1", slotRect(0)],
          ["p2", rects[0]],
          ["p3", rects[1]],
        ]),
      }),
    );
    expect(keys(zones)).toEqual([
      "slot:0",
      "column:1:0",
      "column:1:1",
      "column:1:2",
    ]);
    expect(dropZoneKey(origin!)).toBe("slot:0");
  });

  it("arriving in a two-member column makes it three, so the tiles overflow", () => {
    // The column divides its run between two members today. A third arriving
    // stops the division ([P08]), so the zones must be drawn against the rule
    // that will govern after the drop — not the one governing before it.
    const state = deck([pane("p1", 0), pane("p2", 1), pane("p3", 1)], {
      kind: "three-up",
      columns: { 1: { mode: "split" } },
    });
    const rects = splitRects(1, [300, 295]);
    const { zones } = enumerateDropZones(
      state,
      "p1",
      measured({
        slots: new Map([[0, slotRect(0)]]),
        panes: new Map([
          ["p1", slotRect(0)],
          ["p2", rects[0]],
          ["p3", rects[1]],
        ]),
      }),
    );
    const run = 300 + IMPOSITION_GAP_PX + 295;
    const memberH = run / PLACE_OVERFLOW_VISIBLE_MEMBERS;
    const columnZones = zones.filter((zone) => zone.kind === "column-index");
    expect(columnZones).toHaveLength(3);
    for (const zone of columnZones) {
      expect(zone.rect.height).toBeCloseTo(memberH, 6);
    }
  });

  it("arriving in a one-member column previews the halves the drop makes", () => {
    // The zone is a preview of the world after the drop: the standing member
    // shrinks to share its run, so the tiles are the two equal halves the
    // commit's seam will divide at — never the arrival stacked below the
    // member's current height, hanging off the run's bottom edge.
    const state = deck([pane("p1", 0), pane("p2", 1)], {
      kind: "three-up",
      columns: { 1: { mode: "split" } },
    });
    const { zones } = enumerateDropZones(
      state,
      "p1",
      measured({
        slots: new Map([[0, slotRect(0)]]),
        panes: new Map([
          ["p1", slotRect(0)],
          ["p2", slotRect(1)],
        ]),
      }),
    );
    const columnZones = zones.filter((zone) => zone.kind === "column-index");
    expect(columnZones).toHaveLength(2);
    const half = (RUN_HEIGHT - IMPOSITION_GAP_PX) / 2;
    expect(columnZones[0].rect.y).toBeCloseTo(RUN_TOP, 6);
    expect(columnZones[0].rect.height).toBeCloseTo(half, 6);
    expect(columnZones[1].rect.y).toBeCloseTo(
      RUN_TOP + half + IMPOSITION_GAP_PX,
      6,
    );
    expect(columnZones[1].rect.height).toBeCloseTo(half, 6);
    // Nothing hangs: the last tile's bottom edge is the run's own.
    const last = columnZones[1].rect;
    expect(last.y + last.height).toBeCloseTo(RUN_TOP + RUN_HEIGHT, 6);
    // And the halves are what ask for the positions, so the switch to the
    // bottom position happens at the run's middle, not the member's.
    const x = SLOT_X[1] + SLOT_WIDTH / 2;
    const live = pickLiveZone(zones, { x, y: RUN_TOP + half + 30 }, zones[0]);
    expect(dropZoneKey(live!)).toBe("column:1:1");
  });
});

// ---- Where a position is asked for ----

describe("a position is asked for at the tile the preview draws", () => {
  // The column p2 (300 tall from RUN_TOP) over p3 (295 tall), and p1 arriving
  // from slot 0. Three positions under the overflow rule, whose tiles stack
  // the run/2.5 strip — and the run divides at each tile's top edge, so the
  // region that asks for a position is the region the indicator draws for it.
  const RUN = 300 + IMPOSITION_GAP_PX + 295;
  const MEMBER_H = RUN / PLACE_OVERFLOW_VISIBLE_MEMBERS;
  const STRIDE = MEMBER_H + IMPOSITION_GAP_PX;

  function arriving() {
    const state = deck([pane("p1", 0), pane("p2", 1), pane("p3", 1)], {
      kind: "three-up",
      columns: { 1: { mode: "split" } },
    });
    const rects = splitRects(1, [300, 295]);
    return enumerateDropZones(
      state,
      "p1",
      measured({
        slots: new Map([[0, slotRect(0)]]),
        panes: new Map([
          ["p1", slotRect(0)],
          ["p2", rects[0]],
          ["p3", rects[1]],
        ]),
      }),
    );
  }

  it("the bands divide the run at the tiles' top edges", () => {
    const columnZones = arriving().zones.filter(
      (zone) => zone.kind === "column-index",
    );
    const bands = columnZones.map(hitRectOf);
    expect(bands[0].y).toBeCloseTo(RUN_TOP, 6);
    expect(bands[0].y + bands[0].height).toBeCloseTo(RUN_TOP + STRIDE, 6);
    expect(bands[1].y).toBeCloseTo(RUN_TOP + STRIDE, 6);
    expect(bands[1].y + bands[1].height).toBeCloseTo(RUN_TOP + 2 * STRIDE, 6);
    expect(bands[2].y).toBeCloseTo(RUN_TOP + 2 * STRIDE, 6);
    // The last band stretches past the run's bottom edge to the hanging
    // tile's own, so the position the strip advertises below the run is
    // askable over the whole of its drawn tile.
    expect(bands[2].y + bands[2].height).toBeCloseTo(
      RUN_TOP + 2 * STRIDE + MEMBER_H,
      6,
    );
  });

  it("crossing into a drawn tile is what moves the indication", () => {
    // The rule the bands encode: a pointer standing inside the last tile is
    // asking for the last position, however little of the run lies below it.
    const { zones, origin } = arriving();
    const x = SLOT_X[1] + SLOT_WIDTH / 2;
    const below = pickLiveZone(
      zones,
      { x, y: RUN_TOP + 2 * STRIDE + 20 },
      origin,
    );
    expect(dropZoneKey(below!)).toBe("column:1:2");
    const above = pickLiveZone(
      zones,
      { x, y: RUN_TOP + 2 * STRIDE - 30 },
      origin,
    );
    expect(dropZoneKey(above!)).toBe("column:1:1");
  });

  it("a rail's positions are asked for the same way", () => {
    // No shares, so every candidate order divides the measured run in half —
    // a two-member rail is division-true like a two-member column.
    const state = deck([pane("s1"), pane("s2")], {
      kind: "three-up",
    });
    const rects = splitRects(0, [200, 180]);
    const run = 200 + 180 + IMPOSITION_GAP_PX;
    const half = IMPOSITION_GAP_PX / 2;
    const { zones } = enumerateDropZones(
      state,
      "s1",
      measured({
        panes: new Map([
          ["s1", rects[0]],
          ["s2", rects[1]],
        ]),
        rails: [{ side: "left", members: ["s1", "s2"] }],
      }),
    );
    const bands = zones.map(hitRectOf);
    expect(bands).toHaveLength(2);
    // The bands divide at the drawn tiles' top edges: half the run plus the
    // seam's half gap.
    expect(bands[0].y + bands[0].height).toBeCloseTo(
      RUN_TOP + run / 2 + half,
      6,
    );
    // And the last band's end is the run's own bottom edge — nothing hangs.
    expect(bands[1].y + bands[1].height).toBeCloseTo(RUN_TOP + run, 6);
  });

  it("an overflowing rail's positions are the run/2.5 strip", () => {
    // Three members, so the side stands under the overflow rule a column has
    // always stood under: every tile the same height, stacked a gap apart down
    // a strip that runs past the run's bottom edge.
    const state = deck([pane("s1"), pane("s2"), pane("s3")], {
      kind: "three-up",
    });
    const run = 200 + 150 + 180 + 2 * IMPOSITION_GAP_PX;
    const memberH = run / PLACE_OVERFLOW_VISIBLE_MEMBERS;
    const rects = splitRects(0, [memberH, memberH, memberH]);
    const { zones } = enumerateDropZones(
      state,
      "s1",
      measured({
        panes: new Map([
          ["s1", rects[0]],
          ["s2", rects[1]],
          ["s3", rects[2]],
        ]),
        rails: [{ side: "left", members: ["s1", "s2", "s3"] }],
      }),
    );
    expect(zones).toHaveLength(3);
    zones.forEach((zone, index) => {
      expect(zone.rect.height).toBeCloseTo(memberH, 6);
      expect(zone.rect.y).toBeCloseTo(
        RUN_TOP + index * (memberH + IMPOSITION_GAP_PX),
        6,
      );
    });
    // The last tile hangs below the run, which is the affordance.
    const last = zones[2].rect;
    expect(last.y + last.height).toBeGreaterThan(RUN_TOP + run);
  });

  it("a rail member's share travels with it to every previewed position", () => {
    // s2 carries a double weight. Dragging s1 (weight 1), the last position's
    // tile begins where s2's two thirds leave off, and the tile is s1's own
    // third.
    const state = deck([pane("s1"), pane("s2")], {
      kind: "three-up",
    });
    const rects = splitRects(0, [200, 180]);
    const run = 200 + 180 + IMPOSITION_GAP_PX;
    const half = IMPOSITION_GAP_PX / 2;
    const { zones } = enumerateDropZones(
      state,
      "s1",
      measured({
        panes: new Map([
          ["s1", rects[0]],
          ["s2", rects[1]],
        ]),
        rails: [
          {
            side: "left",
            members: ["s1", "s2"],
            shares: { s1: 1, s2: 2 },
          },
        ],
      }),
    );
    const last = zones[1].rect;
    expect(last.y).toBeCloseTo(RUN_TOP + (run * 2) / 3 + half, 6);
    expect(last.y + last.height).toBeCloseTo(RUN_TOP + run, 6);
  });
});

// ---- Indication ----

describe("the indication moves once the pointer has committed to it", () => {
  const a: DropZone = {
    kind: "column-index",
    slot: 0,
    index: 0,
    rect: { x: 0, y: 0, width: 100, height: 100 },
  };
  const b: DropZone = {
    kind: "column-index",
    slot: 0,
    index: 1,
    rect: { x: 0, y: 200, width: 100, height: 100 },
  };

  it("with no incumbent the nearest zone is live", () => {
    expect(dropZoneKey(pickLiveZone([a, b], { x: 50, y: 20 }, null)!)).toBe(
      "column:0:0",
    );
    expect(dropZoneKey(pickLiveZone([a, b], { x: 50, y: 280 }, null)!)).toBe(
      "column:0:1",
    );
  });

  it("a pointer at the midpoint keeps the incumbent", () => {
    const midpoint = { x: 50, y: 150 };
    expect(dropZoneKey(pickLiveZone([a, b], midpoint, a)!)).toBe("column:0:0");
    expect(dropZoneKey(pickLiveZone([a, b], midpoint, b)!)).toBe("column:0:1");
  });

  it("the challenger takes over only once it beats the incumbent by the margin", () => {
    // Centers are 100px apart on y; the challenger's advantage grows 2px for
    // every 1px the pointer travels past the midpoint.
    const shy = { x: 50, y: 150 + (ZONE_HYSTERESIS_PX / 2 - 1) };
    const past = { x: 50, y: 150 + (ZONE_HYSTERESIS_PX / 2 + 1) };
    expect(dropZoneKey(pickLiveZone([a, b], shy, a)!)).toBe("column:0:0");
    expect(dropZoneKey(pickLiveZone([a, b], past, a)!)).toBe("column:0:1");
  });

  it("an incumbent that is no longer advertised yields to the nearest", () => {
    expect(dropZoneKey(pickLiveZone([b], { x: 50, y: 20 }, a)!)).toBe(
      "column:0:1",
    );
  });

  it("an incumbent is matched by place, not by rect — autoscroll moves tiles", () => {
    const slid: DropZone = { ...a, rect: { x: 0, y: -40, width: 100, height: 100 } };
    const live = pickLiveZone([slid, b], { x: 50, y: 60 }, a);
    expect(dropZoneKey(live!)).toBe("column:0:0");
    expect(live!.rect.y).toBe(-40);
  });

  it("a pointer inside a zone asks for that zone, however tall it is", () => {
    // The case center distance alone gets wrong, and the deck is full of it: a
    // slot's run is most of the window, so its center is far from its own top
    // edge. A pointer resting on the title bar of the card standing in slot 1
    // measures NEARER to the middle of slot 0's upper member than to the middle
    // of the slot it is physically inside — and a release there would land the
    // card in a column the user never pointed at.
    const tall: DropZone = {
      kind: "slot",
      slot: 1,
      rect: { x: 460, y: 5, width: 380, height: 1220 },
    };
    const neighbour: DropZone = {
      kind: "column-index",
      slot: 0,
      index: 0,
      rect: { x: 5, y: 5, width: 380, height: 607 },
    };
    const onTheTitleBar = { x: 650, y: 20 };
    expect(
      dropZoneKey(pickLiveZone([neighbour, tall], onTheTitleBar, null)!),
    ).toBe("slot:1");
    expect(
      dropZoneKey(pickLiveZone([neighbour, tall], onTheTitleBar, neighbour)!),
      "and it wins against an incumbent too — being inside is not a tie to break",
    ).toBe("slot:1");
  });

  it("a tab bar beats the tile it sits inside", () => {
    const tile: DropZone = {
      kind: "slot",
      slot: 1,
      rect: { x: 0, y: 0, width: 400, height: 600 },
    };
    const bar: DropZone = {
      kind: "tab-bar",
      paneId: "p2",
      rect: { x: 0, y: 0, width: 400, height: 30 },
    };
    expect(dropZoneKey(pickLiveZone([tile, bar], { x: 200, y: 15 }, null)!)).toBe(
      "tab:p2",
    );
  });

  it("no zones means no indication", () => {
    expect(pickLiveZone([], { x: 0, y: 0 }, null)).toBeNull();
  });
});

describe("a strip advances while the pointer holds at its edge", () => {
  const band = { bandStart: 5, bandEnd: 605 };

  it("the middle of the band is still", () => {
    expect(
      autoscrollDelta({ ...band, pointer: 300, elapsedMs: 16 }),
    ).toBe(0);
  });

  it("the far margin advances and the near one retreats", () => {
    const far = autoscrollDelta({
      ...band,
      pointer: band.bandEnd - AUTOSCROLL_MARGIN_PX + 1,
      elapsedMs: 16,
    });
    const near = autoscrollDelta({
      ...band,
      pointer: band.bandStart + AUTOSCROLL_MARGIN_PX - 1,
      elapsedMs: 16,
    });
    expect(far).toBeGreaterThan(0);
    expect(near).toBeLessThan(0);
    expect(far).toBeCloseTo(-near, 6);
  });

  it("the margin is a boundary, not a gradient", () => {
    // Inside by a hair moves; outside by a hair does not. A rate that ramped
    // with proximity would make the first one tiny instead of full ([Q01]
    // holds the feel open, but the RULE is a threshold).
    expect(
      autoscrollDelta({ ...band, pointer: band.bandEnd - AUTOSCROLL_MARGIN_PX - 1, elapsedMs: 16 }),
    ).toBe(0);
    expect(
      autoscrollDelta({ ...band, pointer: band.bandEnd - AUTOSCROLL_MARGIN_PX + 1, elapsedMs: 16 }),
    ).toBeCloseTo((AUTOSCROLL_RATE_PX_PER_SEC * 16) / 1000, 6);
  });

  it("travel is a rate times a time, so a slow frame is not a slow scroll", () => {
    const one = autoscrollDelta({ ...band, pointer: 600, elapsedMs: 16 });
    const four = autoscrollDelta({ ...band, pointer: 600, elapsedMs: 64 });
    expect(four).toBeCloseTo(one * 4, 6);
  });

  it("a frame with no time in it moves nothing", () => {
    expect(autoscrollDelta({ ...band, pointer: 600, elapsedMs: 0 })).toBe(0);
    expect(autoscrollDelta({ ...band, pointer: 600, elapsedMs: -8 })).toBe(0);
  });

  it("each strip keeps its own running offset across one drag", () => {
    const column: AutoscrollTarget = {
      kind: "column", slot: 2, axis: "y",
      bandStart: 5, bandEnd: 605, offset: 0, maxOffset: 400,
    };
    const flow: AutoscrollTarget = {
      kind: "flow", axis: "x",
      bandStart: 5, bandEnd: 1200, offset: 0, maxOffset: 900,
    };
    expect(autoscrollKey(column)).toBe("column:2");
    expect(autoscrollKey(flow)).toBe("flow");
    expect(autoscrollKey({ ...column, slot: 0 })).not.toBe(autoscrollKey(column));
  });
});
