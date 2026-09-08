/**
 * layout-imposer-flow.test.ts — flow geometry, and what flow does to the
 * allocator.
 *
 * Flow reads the deck's slots as ordinal positions in a strip rather than as
 * anchors at fractions of the band. Three things follow, and this file pins
 * each of them:
 *
 *  1. **The strip.** `flowStripPositions` is a running sum over the slots, so
 *     no two of them can overlap however narrow the deck gets — the property
 *     the mode exists for. Given a vacancy the sum runs over EVERY slot the
 *     kind defines, so an empty one holds a card's width open and the
 *     arrangement reads by its own numbering; without one it runs over the
 *     occupied slots alone. Unit-tested at its edges, and swept into a golden
 *     table so a retune shows up as a readable diff.
 *  2. **The reveal.** `flowRevealOffset` is `scrollRectToVisible` semantics: the
 *     MINIMAL move that brings the active card in, and no move at all when it
 *     is already there. The second half matters as much as the first — an
 *     activation that reveals nothing must commit no geometry.
 *  3. **The allocator prices the band's far edge.** Every flow seam is the
 *     imposition gap by construction, so the only thing the rails can get
 *     wrong is where the band ends. A cut has two boundaries in closed form,
 *     each with a price in rail width; one within `RAIL_BOUNDARY_BUDGET_PX` is
 *     bought, and otherwise the rails stay where their owner put them and the
 *     cut is an honest slice. The tests below drive a hairline that is bought,
 *     a clipped card that the retired threshold manufactured and the price
 *     repairs, and a wide cut whose boundary no budget reaches.
 *
 * Regenerate the golden deliberately:
 *
 * ```
 * cd tugdeck && IMPOSER_GOLDEN_UPDATE=1 bun test src/lib/__tests__/layout-imposer-flow.test.ts
 * ```
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  CONTENT_WIDTH_COMFY_PX,
  CONTENT_WIDTH_SLIM_PX,
  CONTENT_WIDTH_WIDE_PX,
  DEFAULT_IMPOSITION_LAYOUT,
  IMPOSITION_GAP_PX,
  RAIL_EDGE_INSET_PX,
  RAIL_GUTTER_PX,
  allocateSidebarWidths,
  clampFlowOffset,
  firstVisibleFlowSlot,
  flowCenterOffset,
  flowRevealOffset,
  stripCenterOffset,
  flowStripPositions,
  vacancyExtent,
  imposeStyle,
  RAIL_BOUNDARY_BUDGET_PX,
  impositionLayout,
  stripPicture,
  FLOW_OFFSET_PROPERTY,
  FLOW_STRIP_PROPERTY,
  isImpositionLayout,
  type AllocatorInput,
  type FlowSlotExtent,
  type RailPolicy,
  type RailWidths,
} from "@/lib/layout-imposer";

const GAP = IMPOSITION_GAP_PX;
/** What one standing rail costs the canvas besides its width: its edge inset
 *  and its gutter. A one-rail canvas is `rail + RAIL_AIR + GAP + band`, the
 *  band keeping one card gap at its far end. */
const RAIL_AIR = RAIL_EDGE_INSET_PX + RAIL_GUTTER_PX;

/** The strip's positions as a plain array, in slot order — the shape every
 *  assertion below reads, and what the golden table serializes. */
const strip = (
  occupied: readonly FlowSlotExtent[],
): { slots: { slot: number; left: number }[]; width: number } => {
  const { positions, width } = flowStripPositions(occupied);
  return {
    slots: [...positions.entries()]
      .map(([slot, left]) => ({ slot, left }))
      .sort((a, b) => a.slot - b.slot),
    width,
  };
};

describe("the mode bit", () => {
  test("absent reads as fit, so every deck that predates the mode is unmoved", () => {
    expect(DEFAULT_IMPOSITION_LAYOUT).toBe("fit");
    expect(impositionLayout({})).toBe("fit");
    expect(impositionLayout({ layout: undefined })).toBe("fit");
    expect(impositionLayout({ layout: "flow" })).toBe("flow");
  });

  test("the guard admits exactly the two modes", () => {
    expect(isImpositionLayout("fit")).toBe(true);
    expect(isImpositionLayout("flow")).toBe(true);
    for (const value of ["", "FIT", "strip", null, undefined, 0, {}]) {
      expect(isImpositionLayout(value)).toBe(false);
    }
  });
});

describe("the strip", () => {
  test("an empty deck has no strip at all", () => {
    expect(strip([])).toEqual({ slots: [], width: 0 });
  });

  test("one card is the whole strip, and the strip is its width", () => {
    expect(strip([{ slot: 0, width: 800 }])).toEqual({
      slots: [{ slot: 0, left: 0 }],
      width: 800,
    });
  });

  test("adjacent slots stand one gap apart, and the strip has no trailing gap", () => {
    expect(
      strip([
        { slot: 0, width: 800 },
        { slot: 1, width: 675 },
        { slot: 2, width: 1230 },
      ]),
    ).toEqual({
      slots: [
        { slot: 0, left: 0 },
        { slot: 1, left: 800 + GAP },
        { slot: 2, left: 800 + GAP + 675 + GAP },
      ],
      width: 800 + GAP + 675 + GAP + 1230,
    });
  });

  test("an unoccupied slot contributes nothing, not even a gap", () => {
    // Slots 0, 2 and 5 of a six-up deck stand as a run of three: the strip is
    // a sequence, and an empty slot is not a member of it.
    const sparse = strip([
      { slot: 0, width: 400 },
      { slot: 2, width: 400 },
      { slot: 5, width: 400 },
    ]);
    const dense = strip([
      { slot: 0, width: 400 },
      { slot: 1, width: 400 },
      { slot: 2, width: 400 },
    ]);
    expect(sparse.slots.map((entry) => entry.left)).toEqual(
      dense.slots.map((entry) => entry.left),
    );
    expect(sparse.width).toBe(dense.width);
  });

  test("input order does not matter — the strip is ordered by slot index", () => {
    expect(
      strip([
        { slot: 2, width: 300 },
        { slot: 0, width: 100 },
        { slot: 1, width: 200 },
      ]).slots,
    ).toEqual([
      { slot: 0, left: 0 },
      { slot: 1, left: 100 + GAP },
      { slot: 2, left: 100 + GAP + 200 + GAP },
    ]);
  });

  test("a slot's extent is its widest member — a stack contributes one place", () => {
    // Panes sharing a slot share its anchor in flow exactly as in fit: the
    // mode removes collisions between slots, not within one.
    expect(
      strip([
        { slot: 0, width: 675 },
        { slot: 0, width: 1230 },
        { slot: 0, width: 800 },
        { slot: 1, width: 400 },
      ]),
    ).toEqual({
      slots: [
        { slot: 0, left: 0 },
        { slot: 1, left: 1230 + GAP },
      ],
      width: 1230 + GAP + 400,
    });
  });

  test("the strip names each slot's extent, folded and cleaned the same way", () => {
    // The extents ride out with the positions so the Layout card's committed miniature
    // draws the strip the frames stand on rather than re-deriving it by
    // subtracting a gap it assumes. Every fold the positions do, these do:
    // duplicates take the widest, unreadable widths drop, negatives read zero.
    const { extents } = flowStripPositions([
      { slot: 0, width: 675 },
      { slot: 0, width: 1230 },
      { slot: 1, width: -50 },
      { slot: 2, width: Number.NaN },
      { slot: 3, width: 400 },
    ]);
    expect([...extents].sort(([a], [b]) => a - b)).toEqual([
      [0, 1230],
      [1, 0],
      [3, 400],
    ]);
  });

  test("extents and positions describe one strip — each left is the running sum", () => {
    const occupied = [
      { slot: 0, width: CONTENT_WIDTH_WIDE_PX },
      { slot: 2, width: CONTENT_WIDTH_SLIM_PX },
      { slot: 4, width: CONTENT_WIDTH_COMFY_PX },
    ];
    const { positions, extents, width } = flowStripPositions(occupied);
    let running = 0;
    for (const { slot } of occupied) {
      expect(positions.get(slot)).toBe(running);
      running += (extents.get(slot) as number) + GAP;
    }
    expect(width).toBe(running - GAP);
  });

  test("unreadable widths drop and negative ones read as zero", () => {
    expect(
      strip([
        { slot: 0, width: Number.NaN },
        { slot: 1, width: -50 },
        { slot: 2, width: 300 },
      ]),
    ).toEqual({
      slots: [
        { slot: 1, left: 0 },
        { slot: 2, left: GAP },
      ],
      width: GAP + 300,
    });
  });

  describe("a vacancy holds its place", () => {
    // The rule flow used to have was that an empty slot contributed nothing,
    // not even a gap — so cards in slots 0, 1 and 3 stood as a run of three
    // and the deck drew itself `1|2|4`. Given a vacancy every slot the kind
    // defines takes a place, which is what fit has always done: a fit anchor
    // is a travel fraction, and an empty one has always kept its share of the
    // band.
    const RESERVED = 800;

    test("what a vacancy reserves is the widest card in the chain", () => {
      // Not the deck's content preset: the reserved room is DRAWN — a gap
      // between frames and a segment in the strip — and a gap sized to a preset
      // the user has overridden reads as wrong however defensible the number
      // is. A place among cards should look like the cards it is among.
      expect(
        vacancyExtent(
          [
            { slot: 0, width: 600 },
            { slot: 2, width: 900 },
          ],
          RESERVED,
        ),
      ).toBe(900);
    });

    test("an empty chain has nothing to match, so it takes the fallback", () => {
      expect(vacancyExtent([], RESERVED)).toBe(RESERVED);
      expect(vacancyExtent([{ slot: 0, width: Number.NaN }], RESERVED)).toBe(
        RESERVED,
      );
    });

    test("an empty slot reserves a card's width between its neighbours", () => {
      const { positions, extents, width } = flowStripPositions(
        [
          { slot: 0, width: 600 },
          { slot: 2, width: 600 },
        ],
        { count: 3, extent: RESERVED },
      );
      expect([...positions.keys()].sort()).toEqual([0, 1, 2]);
      expect(extents.get(1)).toBe(RESERVED);
      expect(positions.get(1)).toBe(600 + GAP);
      // And the card behind it stands past the reserved room, not on top of
      // where it would have been.
      expect(positions.get(2)).toBe(600 + GAP + RESERVED + GAP);
      expect(width).toBe(600 + GAP + RESERVED + GAP + 600);
    });

    test("a trailing empty slot stands too — the kind is what says how many", () => {
      const { positions, width } = flowStripPositions(
        [{ slot: 0, width: 600 }],
        { count: 3, extent: RESERVED },
      );
      expect([...positions.keys()].sort()).toEqual([0, 1, 2]);
      expect(width).toBe(600 + GAP + RESERVED + GAP + RESERVED);
    });

    test("an occupied slot keeps its own extent, never the reserved one", () => {
      const { extents } = flowStripPositions(
        [{ slot: 1, width: 1234 }],
        { count: 2, extent: RESERVED },
      );
      expect(extents.get(0)).toBe(RESERVED);
      expect(extents.get(1)).toBe(1234);
    });

    test("without a vacancy the strip is the occupied run alone", () => {
      // The form a caller holding only an occupancy list can honestly ask for,
      // and the reading every existing caller of the bare signature gets.
      const { positions } = flowStripPositions([
        { slot: 0, width: 600 },
        { slot: 2, width: 600 },
      ]);
      expect([...positions.keys()].sort()).toEqual([0, 2]);
      expect(positions.get(2)).toBe(600 + GAP);
    });
  });

  test("occupied slots never overlap, however narrow the deck", () => {
    // The property the whole mode exists for, asserted pairwise rather than
    // trusted: every card's right edge is at or before the next card's left.
    const occupied = [
      { slot: 0, width: CONTENT_WIDTH_WIDE_PX },
      { slot: 1, width: CONTENT_WIDTH_COMFY_PX },
      { slot: 2, width: CONTENT_WIDTH_WIDE_PX },
      { slot: 3, width: CONTENT_WIDTH_SLIM_PX },
    ];
    const { positions } = flowStripPositions(occupied);
    for (const near of occupied) {
      for (const far of occupied) {
        if (near.slot >= far.slot) continue;
        const nearRight = (positions.get(near.slot) as number) + near.width;
        expect(nearRight).toBeLessThanOrEqual(positions.get(far.slot) as number);
      }
    }
  });
});

describe("the offset clamp", () => {
  const stripWidth = 2000;

  test("a strip shorter than the band has no travel at all", () => {
    expect(clampFlowOffset(500, 800, 1200)).toBe(0);
    expect(clampFlowOffset(-500, 800, 1200)).toBe(0);
  });

  test("the offset never runs past the strip's right edge", () => {
    expect(clampFlowOffset(9999, stripWidth, 1200)).toBe(800);
    expect(clampFlowOffset(400, stripWidth, 1200)).toBe(400);
  });

  test("a non-finite offset reads as the strip's origin", () => {
    expect(clampFlowOffset(Number.NaN, stripWidth, 1200)).toBe(0);
  });
});

describe("the reveal rule", () => {
  const band = 1000;
  const stripWidth = 3000;

  test("a card already fully in view moves nothing", () => {
    // The half that keeps activation from committing geometry it does not owe.
    expect(
      flowRevealOffset({
        stripLeft: 500,
        extent: 400,
        stripWidth,
        band,
        offset: 300,
      }),
    ).toBe(300);
  });

  test("a card off the left edge brings its left edge flush", () => {
    expect(
      flowRevealOffset({
        stripLeft: 200,
        extent: 400,
        stripWidth,
        band,
        offset: 900,
      }),
    ).toBe(200);
  });

  test("a card off the right edge moves the minimum that lands it flush right", () => {
    expect(
      flowRevealOffset({
        stripLeft: 1800,
        extent: 400,
        stripWidth,
        band,
        offset: 0,
      }),
    ).toBe(1800 + 400 - band);
  });

  test("a card wider than the band pins its left edge", () => {
    // It cannot be brought fully in, so reading starts where reading starts.
    expect(
      flowRevealOffset({
        stripLeft: 1200,
        extent: 1400,
        stripWidth,
        band,
        offset: 0,
      }),
    ).toBe(1200);
  });

  test("the answer is clamped to the strip's bounds", () => {
    // The last card of a strip barely longer than the band cannot pull the
    // viewport past the strip's end.
    expect(
      flowRevealOffset({
        stripLeft: 900,
        extent: 300,
        stripWidth: 1200,
        band,
        offset: 0,
      }),
    ).toBe(200);
  });

  test("the reveal is idempotent — revealing a revealed card moves nothing", () => {
    const first = flowRevealOffset({
      stripLeft: 1800,
      extent: 400,
      stripWidth,
      band,
      offset: 0,
    });
    expect(
      flowRevealOffset({
        stripLeft: 1800,
        extent: 400,
        stripWidth,
        band,
        offset: first,
      }),
    ).toBe(first);
  });
});

describe("the centering rule", () => {
  const band = 1000;
  const stripWidth = 3000;

  test("a member's middle lands on the band's middle", () => {
    expect(
      flowCenterOffset({ stripLeft: 1200, extent: 400, stripWidth, band }),
    ).toBe(1200 + 200 - 500);
  });

  test("a member already fully in view still travels", () => {
    // The whole difference from the reveal, in one assertion: the same inputs
    // that make `flowRevealOffset` return the standing offset unchanged move
    // the band here, because a named place is a destination and not a
    // deficiency in the current one.
    const standing = 300;
    expect(
      flowRevealOffset({
        stripLeft: 500,
        extent: 400,
        stripWidth,
        band,
        offset: standing,
      }),
      "the reveal sits still",
    ).toBe(standing);
    expect(
      flowCenterOffset({ stripLeft: 500, extent: 400, stripWidth, band }),
      "and the centering does not",
    ).toBe(500 + 200 - 500);
  });

  test("the answer does not depend on where the band stands", () => {
    // Stated directly, because it is the property the gesture is FOR: the
    // signature has no offset in it at all, so two readers at opposite ends of
    // the strip who name slot 4 end up at the same place.
    const wanted = flowCenterOffset({
      stripLeft: 1200,
      extent: 400,
      stripWidth,
      band,
    });
    expect(
      flowCenterOffset({ stripLeft: 1200, extent: 400, stripWidth, band }),
    ).toBe(wanted);
  });

  test("the near end cannot reach the middle, and is pinned flush", () => {
    // Centering the first member would show emptiness before it, so the clamp
    // answers 0 — the gesture gives back less travel at the ends by design.
    expect(
      flowCenterOffset({ stripLeft: 0, extent: 400, stripWidth, band }),
    ).toBe(0);
  });

  test("the far end is pinned flush too", () => {
    expect(
      flowCenterOffset({ stripLeft: 2600, extent: 400, stripWidth, band }),
    ).toBe(stripWidth - band);
  });

  test("a member wider than the band centers its overflow evenly", () => {
    // Nothing special-cased: the middle of a 1400-wide member is still its
    // middle, so the band sits over the center of it and equal amounts hang
    // off both edges.
    expect(
      flowCenterOffset({ stripLeft: 1000, extent: 1400, stripWidth, band }),
    ).toBe(1000 + 700 - 500);
  });

  test("a strip shorter than its band has no travel to give", () => {
    expect(
      flowCenterOffset({
        stripLeft: 400,
        extent: 300,
        stripWidth: 800,
        band,
      }),
    ).toBe(0);
  });

  test("a non-finite place reads as the strip's origin", () => {
    expect(
      flowCenterOffset({
        stripLeft: Number.NaN,
        extent: 400,
        stripWidth,
        band,
      }),
    ).toBe(0);
  });

  test("flowCenterOffset is stripCenterOffset under flow's names", () => {
    const flow = { stripLeft: 1200, extent: 400, stripWidth, band };
    expect(flowCenterOffset(flow)).toBe(
      stripCenterOffset({
        stripStart: flow.stripLeft,
        extent: flow.extent,
        stripLength: flow.stripWidth,
        band: flow.band,
      }),
    );
  });
});

describe("the slot the band is showing", () => {
  /** Four equal cards in a strip, seen through a band two of them wide. */
  const strip = flowStripPositions([
    { slot: 0, width: 100 },
    { slot: 1, width: 100 },
    { slot: 2, width: 100 },
    { slot: 3, width: 100 },
  ]);
  const BAND = 100 * 2 + IMPOSITION_GAP_PX;

  test("an empty strip has no leftmost anything", () => {
    expect(
      firstVisibleFlowSlot({ strip: flowStripPositions([]), band: BAND, offset: 0 }),
    ).toBeUndefined();
  });

  test("at rest the band is showing slot 0", () => {
    expect(firstVisibleFlowSlot({ strip, band: BAND, offset: 0 })).toBe(0);
  });

  test("scrolled to a slot's own edge, that slot answers", () => {
    const left = strip.positions.get(2) as number;
    expect(firstVisibleFlowSlot({ strip, band: BAND, offset: left })).toBe(2);
  });

  test("a slot clipped at the near edge is not the answer — the next whole one is", () => {
    // Half of slot 1 is off the left. Slot 1 is what the deck is scrolled
    // *into*; slot 2 is the first the band holds entire.
    const offset = (strip.positions.get(1) as number) + 50;
    expect(firstVisibleFlowSlot({ strip, band: BAND, offset })).toBe(2);
  });

  test("when nothing fits whole, the clipped slot the band touches answers", () => {
    // A band narrower than one card can never hold a slot entire, so the
    // fallback is what the eye is on rather than slot 0.
    const offset = (strip.positions.get(2) as number) + 20;
    expect(firstVisibleFlowSlot({ strip, band: 60, offset })).toBe(2);
  });

  test("an unoccupied slot is not a place — the strip's own members answer", () => {
    const sparse = flowStripPositions([
      { slot: 1, width: 100 },
      { slot: 4, width: 100 },
    ]);
    expect(firstVisibleFlowSlot({ strip: sparse, band: BAND, offset: 0 })).toBe(1);
  });

  test("a band that is not a measurement yet falls back to the first slot", () => {
    expect(firstVisibleFlowSlot({ strip, band: 0, offset: 400 })).toBe(0);
  });
});

describe("the band's far edge", () => {
  /** One rail, so a band is one subtraction away from a canvas width:
   *  `band = canvas − (rail + gap) − 2 × gap`. Inverted here so each case can
   *  state the band it means rather than the canvas that produces it. */
  const RAIL_PX = 300;
  const rail: RailPolicy = {
    preferredWidth: RAIL_PX,
    minWidth: RAIL_PX,
    comfortWidth: RAIL_PX,
    greedRank: 1,
  };
  const railWidths = { left: RAIL_PX };

  const forBand = (
    band: number,
    occupied: readonly FlowSlotExtent[],
  ): AllocatorInput => ({
    canvasWidth: band + RAIL_PX + RAIL_AIR + GAP,
    kind: "four-up",
    layout: "flow",
    occupied: [...occupied],
    rails: { left: rail },
    maxRailWidth: CONTENT_WIDTH_SLIM_PX,
  });

  /** Four slim cards: lefts 0, 680, 1360, 2040; strip 2715 long. */
  const FOUR_SLIM: readonly FlowSlotExtent[] = [
    { slot: 0, width: CONTENT_WIDTH_SLIM_PX },
    { slot: 1, width: CONTENT_WIDTH_SLIM_PX },
    { slot: 2, width: CONTENT_WIDTH_SLIM_PX },
    { slot: 3, width: CONTENT_WIDTH_SLIM_PX },
  ];
  const sliver = (band: number): number =>
    stripPicture(forBand(band, FOUR_SLIM), railWidths).worstSliver;

  test("an edge on a slot's near edge cuts nothing", () => {
    expect(sliver(680)).toBe(0);
  });

  test("an edge on a slot's far edge cuts nothing", () => {
    expect(sliver(CONTENT_WIDTH_SLIM_PX)).toBe(0);
  });

  test("an edge in the gap between two slots cuts nothing", () => {
    expect(sliver(CONTENT_WIDTH_SLIM_PX + 2)).toBe(0);
  });

  test("three pixels of a card peeking reads as three", () => {
    // The failure this whole objective exists for: a hairline of slot 1 past
    // the band's end, three pixels of rail away from clean.
    expect(sliver(683)).toBe(3);
  });

  test("three pixels of a card hidden reads as three too", () => {
    // Slot 1 spans 680..1355. The measure is symmetric: a hairline withheld is
    // the same ugliness, and the same three pixels from a boundary.
    expect(sliver(1352)).toBe(3);
  });

  test("a card cut near its middle reads as the smaller piece", () => {
    // 300px of slot 1 shown, 375px hidden.
    expect(sliver(980)).toBe(300);
  });

  test("a strip inside its band has no far edge to cut with", () => {
    expect(sliver(3000)).toBe(0);
  });

  test("an empty strip is nothing to cut", () => {
    expect(stripPicture(forBand(800, []), railWidths).worstSliver).toBe(0);
  });

  test("a band that is not a measurement yet cuts nothing", () => {
    expect(sliver(0)).toBe(0);
  });

  test("the objective reads the held-open strip, at whatever it is told it holds", () => {
    // The objective scores where the band's far edge cuts the strip, so it has
    // to be reading the strip the deck DRAWS. The deck holds every slot of the
    // kind open (`deckFlowStrip`), so an empty slot moves every slot after it.
    //
    // Slots 0 and 2 hold slim cards; slots 1 and 3 stand empty. TOLD the
    // vacancy is 800, slot 2's near edge is 675 + 5 + 800 + 5 = 1485, and a
    // band of 1488 cuts three pixels off it.
    const held: AllocatorInput = {
      ...forBand(1488, [
        { slot: 0, width: CONTENT_WIDTH_SLIM_PX },
        { slot: 2, width: CONTENT_WIDTH_SLIM_PX },
      ]),
      emptyExtent: 800,
    };
    expect(stripPicture(held, railWidths).worstSliver).toBe(3);

    // Told NOTHING, the slot is still held open — the extent is derived from
    // the widest card standing, which is `vacancyExtent`'s own rule and the
    // same one `chainOf` falls back on. So the vacancy is 675 wide, slot 2
    // starts at 1360, and the same band cuts 128px into it. What must never
    // happen is the objective reading the occupied run ALONE and finding a
    // clean gap where the deck draws a card: an allocator scoring that would
    // spend rail width on a picture nobody sees.
    const { emptyExtent: _dropped, ...derived } = held;
    expect(stripPicture(derived, railWidths).worstSliver).toBe(128);
  });
});

describe("the allocator in flow", () => {
  /** A rail with a comfort band the fit solver can spend. */
  const overview: RailPolicy = {
    preferredWidth: 400,
    minWidth: 240,
    comfortWidth: 320,
    greedRank: 1,
  };
  const cards: RailPolicy = {
    preferredWidth: 420,
    minWidth: 320,
    comfortWidth: 320,
    greedRank: 2,
  };

  /** A deck too narrow for its chain: in fit the seams overlap, which is
   *  exactly the picture the allocator spends rail width to fix. */
  const crowded = (layout?: "fit" | "flow"): AllocatorInput => ({
    canvasWidth: 2400,
    kind: "three-up",
    ...(layout !== undefined ? { layout } : {}),
    occupied: [
      { slot: 0, width: CONTENT_WIDTH_COMFY_PX },
      { slot: 1, width: CONTENT_WIDTH_COMFY_PX },
      { slot: 2, width: CONTENT_WIDTH_COMFY_PX },
    ],
    rails: { left: cards, right: overview },
    maxRailWidth: CONTENT_WIDTH_SLIM_PX,
  });

  test("fit drains a rail on this deck — the premise the flow assertion rests on", () => {
    const fit = allocateSidebarWidths(crowded("fit"));
    expect(fit).not.toBeNull();
    const drained =
      (fit?.left ?? 0) < cards.preferredWidth ||
      (fit?.right ?? 0) < overview.preferredWidth;
    expect(
      drained,
      "the fixture stopped crowding the chain; pick a narrower canvas",
    ).toBe(true);
  });

  /** One rail, three comfy cards (lefts 0, 805, 1610; strip 2410), and a canvas
   *  chosen so the band at the rail's preferred width ends THREE PIXELS inside
   *  the second card — the hairline under the Layout card this objective exists for. */
  const hairlineDeck: AllocatorInput = {
    // A 420px rail over a band of 808: three pixels past slot 1's near edge.
    canvasWidth: 420 + RAIL_AIR + GAP + 808,
    kind: "three-up",
    layout: "flow",
    occupied: [
      { slot: 0, width: CONTENT_WIDTH_COMFY_PX },
      { slot: 1, width: CONTENT_WIDTH_COMFY_PX },
      { slot: 2, width: CONTENT_WIDTH_COMFY_PX },
    ],
    rails: {
      left: {
        preferredWidth: 420,
        minWidth: 300,
        comfortWidth: 380,
        greedRank: 1,
      },
    },
    maxRailWidth: CONTENT_WIDTH_SLIM_PX,
  };

  test("flow spends rail width to clear a hairline", () => {
    expect(
      stripPicture(hairlineDeck, { left: 420 }).worstSliver,
      "the premise: at the width its owner chose, the band cuts 3px of a card",
    ).toBe(3);
    const answer = allocateSidebarWidths(hairlineDeck) as RailWidths;
    expect(
      answer.left,
      "three more pixels of rail put the band on that card's near edge",
    ).toBe(423);
    expect(stripPicture(hairlineDeck, answer).worstSliver).toBe(0);
  });

  test("flow keeps its comfort when the fix is reachable above the floors", () => {
    const answer = allocateSidebarWidths(hairlineDeck) as RailWidths;
    expect(answer.left).toBeGreaterThanOrEqual(380);
  });

  test("a boundary beyond the budget is not bought, and the slice it leaves is honest", () => {
    // Two WIDE cards (strip 2465) seen through a canvas whose nearest boundary
    // needs a 736px rail — 316px of rail away, past the 675px ceiling and far
    // past the budget, so no boundary is affordable at all. Minimising the cut
    // would drag the rail from the 420 its owner set to its 675 maximum to take
    // 316px down to 61px: still cut, still not a boundary, and the user's rail
    // gone. Under the budget that move is simply not on offer: the rails stay
    // where they were put, and the slice reads as the next card.
    const wideDeck: AllocatorInput = {
      canvasWidth: 1986,
      kind: "two-up",
      layout: "flow",
      occupied: [
        { slot: 0, width: CONTENT_WIDTH_WIDE_PX },
        { slot: 1, width: CONTENT_WIDTH_WIDE_PX },
      ],
      rails: {
        left: {
          preferredWidth: 420,
          minWidth: 300,
          comfortWidth: 380,
          greedRank: 1,
        },
      },
      maxRailWidth: CONTENT_WIDTH_SLIM_PX,
    };
    const picture = stripPicture(wideDeck, { left: 420 });
    expect(
      Math.min(picture.growPrice as number, picture.shrinkPrice as number),
      "the premise: the cheapest boundary is beyond the budget",
    ).toBeGreaterThan(RAIL_BOUNDARY_BUDGET_PX);
    const answer = allocateSidebarWidths(wideDeck) as RailWidths;
    expect(answer.left).toBe(420);
    expect(
      stripPicture(wideDeck, answer).worstSliver,
      "the cut is reported as what it is, and it is wider than any budget",
    ).toBeGreaterThan(RAIL_BOUNDARY_BUDGET_PX);
  });

  test("a boundary a few tens of pixels away is bought, whatever the cut measures", () => {
    // The row that was clipping a card in the app. Three slim cards (strip
    // 2035) behind two rails of 420: the band at those widths is 2006 and the
    // strip runs 29px past it. Under the retired threshold a 29px cut was a
    // "hairline" and the rails were WIDENED until it read 32 — the cheapest
    // move that cleared the threshold, and a manufactured slice the reader
    // sees as a clipped card. The boundary is 29px of rail the other way.
    const clipping: AllocatorInput = {
      canvasWidth: 2870,
      kind: "three-up",
      layout: "flow",
      occupied: [0, 1, 2].map((slot) => ({ slot, width: CONTENT_WIDTH_SLIM_PX })),
      rails: {
        left: { preferredWidth: 420, minWidth: 320, comfortWidth: 380, greedRank: 1 },
        right: { preferredWidth: 420, minWidth: 320, comfortWidth: 320, greedRank: 2 },
      },
      maxRailWidth: CONTENT_WIDTH_SLIM_PX,
    };
    const before = stripPicture(clipping, { left: 420, right: 420 });
    expect(before.worstSliver, "the premise: 29px of the third card is cut").toBe(29);
    expect(before.shrinkPrice, "and the strip fits if the rails give up 29px").toBe(29);
    const answer = allocateSidebarWidths(clipping) as RailWidths;
    expect(
      (answer.left as number) + (answer.right as number),
      "the rails give up exactly that",
    ).toBe(840 - 29);
    expect(stripPicture(clipping, answer).worstSliver).toBe(0);

    // Ten pixels wider, the cut is 39: not a hairline by any threshold, and
    // still 39px of rail from a boundary. The threshold left it; the price
    // takes it.
    const wider = { ...clipping, canvasWidth: 2860 };
    expect(stripPicture(wider, { left: 420, right: 420 }).worstSliver).toBe(39);
    const answerWider = allocateSidebarWidths(wider) as RailWidths;
    expect(stripPicture(wider, answerWider).worstSliver).toBe(0);
  });

  test("flow surrenders comfort only to reach a boundary it otherwise cannot", () => {
    // One rail, so the band is one subtraction from the canvas. Three comfy
    // cards stand at 0, 805 and 1610; the band's far edge is on a boundary at
    // 1605 (slot 1's far edge, rail 660) and at 1610 (slot 2's near edge, rail
    // 655). The comfort floor is set at 665 so NEITHER is inside the comfort
    // domain, and the hard floor at 600 so both are below it.
    const pinched: RailPolicy = {
      preferredWidth: 670,
      minWidth: 600,
      comfortWidth: 665,
      greedRank: 1,
    };
    const deck: AllocatorInput = {
      // At the rail's preferred 670 the band is 1595: ten pixels short of
      // the two-card boundary at 1605.
      canvasWidth: 670 + RAIL_AIR + GAP + 1595,
      kind: "three-up",
      layout: "flow",
      occupied: [
        { slot: 0, width: CONTENT_WIDTH_COMFY_PX },
        { slot: 1, width: CONTENT_WIDTH_COMFY_PX },
        { slot: 2, width: CONTENT_WIDTH_COMFY_PX },
      ],
      rails: { left: pinched },
      maxRailWidth: CONTENT_WIDTH_SLIM_PX,
    };
    const answer = allocateSidebarWidths(deck) as RailWidths;
    expect(stripPicture(deck, answer).worstSliver).toBe(0);
    expect(
      answer.left,
      "below its comfort floor, and at the boundary nearest the width its owner chose",
    ).toBe(660);
  });

  test("flow keeps Σ preferred when no total in range reaches a boundary", () => {
    // A rail pinned to one width has one candidate total, so the scan cannot
    // improve the picture. The answer degrades to that width rather than
    // refusing — and the cut it leaves is the overflow affordance.
    const pinned: RailPolicy = {
      preferredWidth: 300,
      minWidth: 300,
      comfortWidth: 300,
      greedRank: 1,
    };
    const deck: AllocatorInput = {
      canvasWidth: 300 + RAIL_AIR + GAP + 1965,
      kind: "three-up",
      layout: "flow",
      occupied: [
        { slot: 0, width: CONTENT_WIDTH_COMFY_PX },
        { slot: 1, width: CONTENT_WIDTH_COMFY_PX },
        { slot: 2, width: CONTENT_WIDTH_COMFY_PX },
      ],
      rails: { left: pinned },
      maxRailWidth: 300,
    };
    const answer = allocateSidebarWidths(deck) as RailWidths;
    expect(answer.left).toBe(300);
    expect(
      stripPicture(deck, answer).worstSliver,
      "a cut it cannot repair is still reported rather than hidden",
    ).toBeGreaterThan(0);
  });

  test("an absent layout allocates as fit", () => {
    expect(allocateSidebarWidths(crowded())).toEqual(
      allocateSidebarWidths(crowded("fit")) as never,
    );
  });
});

describe("the CSS expression", () => {
  const FIT_LEFT =
    "calc(0% + var(--tug-imposer-inset-left, 0px) + 5px + 0.5 * " +
    "max(0px, (100% - var(--tug-imposer-inset-left, 0px) - " +
    "var(--tug-imposer-inset-right, 0px) - 5px * 2) - 800px))";

  test("fit's left is byte-identical to what it has always been", () => {
    // Flow is an added branch, not a rewrite: a placement carrying no strip
    // standing takes the travel-fraction expression unchanged, spelled out
    // here so a refactor of the shared terms cannot quietly move fit.
    expect(imposeStyle({ slot: 1, count: 3 }, 800).left).toBe(FIT_LEFT);
  });

  test("flow's left is the strip position less the clamped offset", () => {
    expect(imposeStyle({ slot: 1, count: 3, flow: { stripLeft: 805 } }, 800).left)
      .toBe(
        "calc(0% + var(--tug-imposer-inset-left, 0px) + 5px + 805px - " +
          "min(var(--tug-imposer-flow-offset, 0px), " +
          "max(0px, var(--tug-imposer-flow-strip, 0px) - " +
          "(100% - var(--tug-imposer-inset-left, 0px) - " +
          "var(--tug-imposer-inset-right, 0px) - 5px * 2))))",
      );
  });

  test("the clamp is in the expression, so a resize needs no JS", () => {
    // The property names are exported rather than spelled inline at the two
    // ends, so the canvas cannot write one name while the frames read another.
    const left = String(
      imposeStyle({ slot: 0, count: 2, flow: { stripLeft: 0 } }, 400).left,
    );
    expect(left).toContain(FLOW_OFFSET_PROPERTY);
    expect(left).toContain(FLOW_STRIP_PROPERTY);
    expect(left).toContain("100%");
  });

  test("neither mode clips the pane at all", () => {
    // The band used to stop a flow pane's ink by cutting it — a `clip-path`
    // built from both band edges, phrased against the viewport because
    // inset() percentages resolve against the pane's own box. It stops by
    // OCCLUSION now: the rail is opaque, it outranks every free card, and the
    // five pixels of margin no rail can stand in are covered by the margin
    // caps. So the flow branch emits no clip, exactly as fit never did, and
    // this is the pin against one coming back. [B01]
    expect(
      imposeStyle({ slot: 1, count: 3, flow: { stripLeft: 805 } }, 800)
        .clipPath,
    ).toBeUndefined();
    expect(imposeStyle({ slot: 1, count: 3 }, 800).clipPath).toBeUndefined();
    // Including a size-locked card, which used to carry a clip measured from
    // its centred frame rather than from its slot.
    expect(
      imposeStyle({ slot: 0, count: 2, flow: { stripLeft: 100 } }, 800, {
        width: 320,
      }).clipPath,
    ).toBeUndefined();
  });

  test("a size-locked card is still centred in its slot, in either mode", () => {
    const pinned = { width: 320 };
    expect(String(imposeStyle({ slot: 0, count: 2 }, 800, pinned).left)).toContain(
      "+ 240px",
    );
    expect(
      String(
        imposeStyle({ slot: 0, count: 2, flow: { stripLeft: 0 } }, 800, pinned)
          .left,
      ),
    ).toContain("+ 240px");
  });
});

/* ---------------------------------------------------------------------------
 * The golden table
 * ---------------------------------------------------------------------------*/

const GOLDEN_PATH = join(import.meta.dir, "golden", "imposer-flow.json");

/** The occupancy fixtures the sweep runs: what stands where, and how wide. */
const OCCUPANCIES: { name: string; occupied: FlowSlotExtent[] }[] = [
  { name: "empty", occupied: [] },
  { name: "one-comfy", occupied: [{ slot: 0, width: CONTENT_WIDTH_COMFY_PX }] },
  {
    name: "three-comfy",
    occupied: [0, 1, 2].map((slot) => ({
      slot,
      width: CONTENT_WIDTH_COMFY_PX,
    })),
  },
  {
    name: "mixed-widths",
    occupied: [
      { slot: 0, width: CONTENT_WIDTH_SLIM_PX },
      { slot: 1, width: CONTENT_WIDTH_WIDE_PX },
      { slot: 2, width: CONTENT_WIDTH_COMFY_PX },
    ],
  },
  {
    name: "sparse-six-up",
    occupied: [
      { slot: 0, width: CONTENT_WIDTH_COMFY_PX },
      { slot: 3, width: CONTENT_WIDTH_SLIM_PX },
      { slot: 5, width: CONTENT_WIDTH_WIDE_PX },
    ],
  },
  {
    name: "stacked-slot",
    occupied: [
      { slot: 0, width: CONTENT_WIDTH_SLIM_PX },
      { slot: 0, width: CONTENT_WIDTH_WIDE_PX },
      { slot: 1, width: CONTENT_WIDTH_COMFY_PX },
    ],
  },
  {
    name: "six-wide",
    occupied: [0, 1, 2, 3, 4, 5].map((slot) => ({
      slot,
      width: CONTENT_WIDTH_WIDE_PX,
    })),
  },
];

/** The bands the reveal is computed against: narrower than one card, a couple
 *  of cards wide, and wider than any strip here. */
const BANDS = [600, 1400, 2600, 9000];

interface GoldenRow {
  config: string;
  band: number;
  stripWidth: number;
  lefts: number[];
  /** The offset that reveals each occupied slot, starting from rest. */
  reveals: number[];
}

function goldenRows(): GoldenRow[] {
  const rows: GoldenRow[] = [];
  for (const fixture of OCCUPANCIES) {
    const { positions, width } = flowStripPositions(fixture.occupied);
    const extents = new Map<number, number>();
    for (const entry of fixture.occupied) {
      extents.set(
        entry.slot,
        Math.max(extents.get(entry.slot) ?? 0, entry.width),
      );
    }
    const slots = [...positions.keys()].sort((a, b) => a - b);
    for (const band of BANDS) {
      rows.push({
        config: fixture.name,
        band,
        stripWidth: width,
        lefts: slots.map((slot) => positions.get(slot) as number),
        reveals: slots.map((slot) =>
          flowRevealOffset({
            stripLeft: positions.get(slot) as number,
            extent: extents.get(slot) as number,
            stripWidth: width,
            band,
            offset: 0,
          }),
        ),
      });
    }
  }
  return rows;
}

describe("the golden table", () => {
  test("the checked-in table is what the strip produces", () => {
    const serialized = `${JSON.stringify(goldenRows(), null, 2)}\n`;
    if (process.env.IMPOSER_GOLDEN_UPDATE === "1") {
      writeFileSync(GOLDEN_PATH, serialized);
    }
    const golden = readFileSync(GOLDEN_PATH, "utf8");
    expect(
      serialized,
      "the strip's answers moved — review the diff, then regenerate with IMPOSER_GOLDEN_UPDATE=1",
    ).toBe(golden);
  });
});
