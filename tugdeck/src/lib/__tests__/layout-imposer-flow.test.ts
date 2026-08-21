/**
 * layout-imposer-flow.test.ts — flow geometry, and what flow does to the
 * allocator.
 *
 * Flow reads the deck's slots as ordinal positions in a strip rather than as
 * anchors at fractions of the band. Three things follow, and this file pins
 * each of them:
 *
 *  1. **The strip.** `flowStripPositions` is a running sum over the occupied
 *     slots, so no two of them can overlap however narrow the deck gets — the
 *     property the mode exists for. Unit-tested at its edges, and swept into a
 *     golden table so a retune shows up as a readable diff.
 *  2. **The reveal.** `flowRevealOffset` is `scrollRectToVisible` semantics: the
 *     MINIMAL move that brings the active card in, and no move at all when it
 *     is already there. The second half matters as much as the first — an
 *     activation that reveals nothing must commit no geometry.
 *  3. **The allocator degenerates.** Every flow seam is the imposition gap by
 *     construction, so the lexicographic objective collapses to its last term
 *     and every rail keeps its preferred width. The test below drives a
 *     configuration where fit drains a rail, so the short-circuit is asserted
 *     to be doing work rather than agreeing by luck.
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
  allocateSidebarWidths,
  clampFlowOffset,
  firstVisibleFlowSlot,
  slotsInBand,
  FLOW_CLIP_SLACK_PX,
  flowRevealOffset,
  flowStripPositions,
  hairlineOf,
  imposeStyle,
  SLIVER_PX,
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
    // The extents ride out with the positions so the Lens's committed miniature
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

describe("every slot the band is showing", () => {
  /** Four equal cards in a strip, seen through a band two of them wide. Slot
   *  lefts are 0, 105, 210, 315; the strip is 415 long. */
  const strip = flowStripPositions([
    { slot: 0, width: 100 },
    { slot: 1, width: 100 },
    { slot: 2, width: 100 },
    { slot: 3, width: 100 },
  ]);
  const BAND = 100 * 2 + IMPOSITION_GAP_PX;

  const shown = (band: number, offset: number): number[] =>
    [...slotsInBand({ strip, band, offset })].sort((a, b) => a - b);

  test("at rest the band shows the run it covers, and nothing beyond it", () => {
    expect(shown(BAND, 0)).toEqual([0, 1]);
  });

  test("a slot clipped at either edge is still a slot the reader can see", () => {
    // Half of slot 1 is off the left and half of slot 3 is off the right.
    expect(shown(BAND, 155)).toEqual([1, 2, 3]);
  });

  test("a slot wholly past the band is not shown", () => {
    expect(shown(100, 0)).toEqual([0]);
  });

  test("a band ending exactly on a slot's left edge does not show that slot", () => {
    // The band is [0, 105) and slot 1 starts at 105 — half-open at both ends,
    // so a boundary is a clean cut rather than a one-pixel claim.
    expect(shown(105, 0)).toEqual([0]);
  });

  test("a band starting exactly on a slot's right edge does not show it", () => {
    expect(shown(BAND, 100)).toEqual([1, 2]);
  });

  test("an unoccupied slot is never shown — it is not a member of the strip", () => {
    const sparse = flowStripPositions([
      { slot: 1, width: 100 },
      { slot: 4, width: 100 },
    ]);
    expect([...slotsInBand({ strip: sparse, band: 1000, offset: 0 })].sort()).toEqual(
      [1, 4],
    );
  });

  test("an empty strip shows nothing", () => {
    expect(
      slotsInBand({ strip: flowStripPositions([]), band: BAND, offset: 0 }).size,
    ).toBe(0);
  });

  test("a band that is not a measurement yet is not a picture of anything", () => {
    expect(slotsInBand({ strip, band: 0, offset: 0 }).size).toBe(0);
    expect(slotsInBand({ strip, band: -10, offset: 0 }).size).toBe(0);
    expect(slotsInBand({ strip, band: Number.NaN, offset: 0 }).size).toBe(0);
    expect(slotsInBand({ strip, band: BAND, offset: Number.NaN }).size).toBe(0);
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
    canvasWidth: band + RAIL_PX + IMPOSITION_GAP_PX * 3,
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
});

describe("the allocator in flow", () => {
  /** A rail with a comfort band the fit solver can spend. */
  const overview: RailPolicy = {
    preferredWidth: 400,
    minWidth: 240,
    comfortWidth: 320,
    greedRank: 1,
  };
  const lens: RailPolicy = {
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
    rails: { left: lens, right: overview },
    maxRailWidth: CONTENT_WIDTH_SLIM_PX,
  });

  test("fit drains a rail on this deck — the premise the flow assertion rests on", () => {
    const fit = allocateSidebarWidths(crowded("fit"));
    expect(fit).not.toBeNull();
    const drained =
      (fit?.left ?? 0) < lens.preferredWidth ||
      (fit?.right ?? 0) < overview.preferredWidth;
    expect(
      drained,
      "the fixture stopped crowding the chain; pick a narrower canvas",
    ).toBe(true);
  });

  /** One rail, three comfy cards (lefts 0, 805, 1610; strip 2410), and a canvas
   *  chosen so the band at the rail's preferred width ends THREE PIXELS inside
   *  the second card — the hairline under the Lens this objective exists for. */
  const hairlineDeck: AllocatorInput = {
    canvasWidth: 1243,
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

  test("an honest slice of a card is not a defect, and costs the rails nothing", () => {
    // Two WIDE cards (strip 2465) seen through a canvas whose nearest boundary
    // needs a 736px rail — past the 675px ceiling, so no boundary is reachable
    // at all. Minimising the cut would drag the rail from the 420 its owner set
    // to its 675 maximum to take 316px down to 61px: still cut, still not a
    // boundary, and the user's rail gone. A slice this size reads as the next
    // card, so it is not a defect, and the rails stay where they were put.
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
    const answer = allocateSidebarWidths(wideDeck) as RailWidths;
    expect(answer.left).toBe(420);
    expect(
      hairlineOf(stripPicture(wideDeck, answer).worstSliver),
      "graded clean: a slice this wide is a card, not an artifact",
    ).toBe(0);
    expect(
      stripPicture(wideDeck, answer).worstSliver,
      "and the raw measurement still reports what it really is",
    ).toBeGreaterThan(SLIVER_PX);
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
      canvasWidth: 2280,
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
      canvasWidth: 2280,
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

  test("flow clips the pane to the band, and fit does not clip at all", () => {
    // The band's edge is real ink: a flow pane's clip-path carries both band
    // edges as live var() expressions, phrased against the viewport because
    // inset() percentages resolve against the pane's own box. Fit keeps no
    // clip — its travel fractions hold every card inside the band already.
    const flow = imposeStyle(
      { slot: 1, count: 3, flow: { stripLeft: 805 } },
      800,
    );
    const clip = String(flow.clipPath);
    expect(clip.startsWith(`inset(${-FLOW_CLIP_SLACK_PX}px `)).toBe(true);
    expect(clip).toContain(FLOW_OFFSET_PROPERTY);
    expect(clip).toContain(FLOW_STRIP_PROPERTY);
    expect(clip).toContain("100vw");
    // The left clip is the clamped offset less the pane's strip position; the
    // right clip is the pane's far edge less the band's. Both rest at the
    // shadow slack rather than 0 so an uncut card keeps its shadow.
    expect(clip).toContain(`max(${-FLOW_CLIP_SLACK_PX}px, calc(`);
    expect(clip).toContain("- 805px)");
    expect(clip).toContain("calc(1605px - ");

    expect(imposeStyle({ slot: 1, count: 3 }, 800).clipPath).toBeUndefined();
  });

  test("a pinned card's clip is measured from its centred frame", () => {
    // A size-locked card is narrower than its slot and centred inside it, so
    // the clip's near edge is the slot's strip position plus the centring
    // offset, and the far edge is that plus the frame's own width.
    const clip = String(
      imposeStyle(
        { slot: 0, count: 2, flow: { stripLeft: 100 } },
        800,
        { width: 320 },
      ).clipPath,
    );
    expect(clip).toContain("- 340px)");
    expect(clip).toContain("calc(660px - ");
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
