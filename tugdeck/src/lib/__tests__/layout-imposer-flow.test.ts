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
  flowRevealOffset,
  flowStripPositions,
  imposeStyle,
  impositionLayout,
  FLOW_OFFSET_PROPERTY,
  FLOW_STRIP_PROPERTY,
  isImpositionLayout,
  type AllocatorInput,
  type FlowSlotExtent,
  type RailPolicy,
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

  test("flow leaves every rail at its preferred width", () => {
    // Every flow seam is the imposition gap by construction and independent of
    // the band, so no rail total scores better than any other on overlap,
    // shortfall or raggedness, and the key reduces to |T − Σ preferred|.
    expect(allocateSidebarWidths(crowded("flow"))).toEqual({
      left: lens.preferredWidth,
      right: overview.preferredWidth,
    });
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
