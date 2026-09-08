/**
 * layout-imposer-census.test.ts — the allocator census.
 *
 * The space allocator reads every layout constant there is — the card gap, the
 * rail gutter and edge inset, the content-width presets, each rail's size
 * policy — and a change to any of them moves the deck onto a different row of
 * the same objective. Nothing about the code can keep the allocator
 * "coordinated" with those constants by discipline; only a test that reads
 * every one of them and sweeps the space they describe can. This is that
 * test: the sweep that found the clipped card, made permanent.
 *
 * It enumerates kind × content-width preset × rail count (none, one side,
 * both), in fit and in flow, across a fine sweep of canvas widths, and asserts
 * the one rule each mode is held to:
 *
 *  - **Flow: a boundary when one is within budget, an honest slice otherwise.**
 *    At the widths the user chose, the band's far edge either cuts a card or it
 *    does not. If it does, the two boundaries are known in closed form — grow
 *    the rails until the band ends on the cut card's near edge, or shrink them
 *    until it reaches the far one — and each has a price in rail width. When a
 *    price is within `RAIL_BOUNDARY_BUDGET_PX` and the total it names is one
 *    the rails may legally stand at, the answer ends the band on a boundary.
 *    When no boundary is affordable the rails stay at the widths the user
 *    chose, and the slice the band leaves is at least
 *    {@link RESIDUAL_READABLE_MIN_PX} wide whenever it was the budget rather
 *    than a floor that refused the boundary — a cut the allocator declined to
 *    pay for reads as the next card, never as an artifact.
 *
 *  - **Fit: no overlap and no shortfall under comfort.** The strip never
 *    overflows in fit, so there is no residual to price; what a gap or preset
 *    change can break there is the tiling. Wherever some legal total tiles the
 *    chain with nothing occluded and no seam under the gap, the answer does
 *    too — and it does so without spending comfort that a total inside the
 *    comfort domain would not have had to spend.
 *
 * The census is written against the objective's own closed form for the
 * boundary prices ({@link stripPicture}) and against an independent exhaustive
 * sweep for fit, so a change that moves an answer off a boundary it could have
 * paid for fails here on the day it lands, whichever constant moved it.
 */

import { describe, expect, test } from "bun:test";

import {
  CONTENT_WIDTH_PRESETS,
  CONTENT_WIDTH_PX,
  CONTENT_WIDTH_SLIM_PX,
  IMPOSITION_KINDS,
  RAIL_BOUNDARY_BUDGET_PX,
  allocateSidebarWidths,
  seamPicture,
  slotCount,
  stripPicture,
  type AllocatorInput,
  type ContentWidth,
  type ImpositionKind,
  type RailPolicy,
  type RailWidths,
  type SidebarSide,
} from "@/lib/layout-imposer";

/**
 * The narrowest slice of a card that still reads as a card rather than as a
 * rendering artifact: below this, what shows past the band is a rounded corner
 * and the edge of a shadow, with no content in it.
 *
 * This is the census's bar, not the objective's — the objective has no
 * threshold, only a budget. What the census holds is that the budget is never
 * set so low that a cut the allocator declined to pay for could be a hairline:
 * a boundary the budget refuses is at least the budget away, so the slice it
 * leaves is at least that wide, and the budget must clear this number.
 */
export const RESIDUAL_READABLE_MIN_PX = 32;

/** The ceiling the deck passes: a rail may be as wide as a slim card. */
const CEILING = CONTENT_WIDTH_SLIM_PX;

/** The rails from the sweep that found the clipped card: each prefers 420
 *  over a 320 floor; one has a comfort band, the other has none. */
const LEFT_RAIL: RailPolicy = {
  preferredWidth: 420,
  minWidth: 320,
  comfortWidth: 380,
  greedRank: 1,
};
const RIGHT_RAIL: RailPolicy = {
  preferredWidth: 420,
  minWidth: 320,
  comfortWidth: 320,
  greedRank: 2,
};

const RAIL_COUNTS: { name: string; rails: AllocatorInput["rails"] }[] = [
  { name: "no-rail", rails: {} },
  { name: "left", rails: { left: LEFT_RAIL } },
  { name: "both", rails: { left: LEFT_RAIL, right: RIGHT_RAIL } },
];

/** Every ten pixels from a canvas too narrow for one comfy card to one wide
 *  enough that a six-up strip of slim cards fits with both rails standing. */
const CANVASES: readonly number[] = Array.from(
  { length: (4600 - 1200) / 10 + 1 },
  (_, i) => 1200 + i * 10,
);

function sidesOf(rails: AllocatorInput["rails"]): SidebarSide[] {
  const sides: SidebarSide[] = [];
  if (rails.left !== undefined) sides.push("left");
  if (rails.right !== undefined) sides.push("right");
  return sides;
}

/** The integer bounds the allocator derives from a policy, restated here so
 *  the census agrees with it about which totals are legal. */
function boundsOf(policy: RailPolicy): {
  floor: number;
  comfortFloor: number;
  ceiling: number;
  preferred: number;
} {
  const floor = Math.ceil(policy.minWidth);
  const ceiling = Math.max(CEILING, floor);
  const preferred = Math.min(
    Math.max(Math.round(policy.preferredWidth), floor),
    ceiling,
  );
  return {
    floor,
    comfortFloor: Math.max(
      floor,
      Math.min(Math.ceil(policy.comfortWidth), preferred),
    ),
    ceiling,
    preferred,
  };
}

function spread(total: number, sides: readonly SidebarSide[]): RailWidths {
  const widths: RailWidths = {};
  for (const side of sides) widths[side] = total / sides.length;
  return widths;
}

function totalOf(widths: RailWidths, sides: readonly SidebarSide[]): number {
  return sides.reduce((sum, side) => sum + (widths[side] as number), 0);
}

function fullDeck(
  kind: ImpositionKind,
  preset: ContentWidth,
): { slot: number; width: number }[] {
  return Array.from({ length: slotCount(kind) }, (_, slot) => ({
    slot,
    width: CONTENT_WIDTH_PX[preset],
  }));
}

interface Row {
  where: string;
  input: AllocatorInput;
  sides: SidebarSide[];
  floorTotal: number;
  comfortTotal: number;
  ceilingTotal: number;
  preferredTotal: number;
}

function* rows(layout: "fit" | "flow"): Generator<Row> {
  for (const kind of IMPOSITION_KINDS) {
    for (const preset of CONTENT_WIDTH_PRESETS) {
      for (const railCount of RAIL_COUNTS) {
        const sides = sidesOf(railCount.rails);
        const bounds = sides.map((side) =>
          boundsOf(railCount.rails[side] as RailPolicy),
        );
        const sum = (of: (b: (typeof bounds)[number]) => number): number =>
          bounds.reduce((running, b) => running + of(b), 0);
        for (const canvasWidth of CANVASES) {
          yield {
            where: `${layout}/${kind}/${preset}/${railCount.name}@${canvasWidth}`,
            input: {
              canvasWidth,
              kind,
              layout,
              occupied: fullDeck(kind, preset),
              rails: railCount.rails,
              maxRailWidth: CEILING,
            },
            sides,
            floorTotal: sum((b) => b.floor),
            comfortTotal: sum((b) => b.comfortFloor),
            ceilingTotal: sum((b) => b.ceiling),
            preferredTotal: sum((b) => b.preferred),
          };
        }
      }
    }
  }
}

describe("the allocator census", () => {
  test("the budget clears the readable minimum", () => {
    // A boundary the budget refuses is at least the budget away in rail width,
    // so the slice it leaves is at least that wide. The budget is the one
    // tunable in the flow objective, and this is the floor under it.
    expect(RAIL_BOUNDARY_BUDGET_PX).toBeGreaterThanOrEqual(
      RESIDUAL_READABLE_MIN_PX,
    );
  });

  test("flow ends on a boundary when one is within budget, and leaves an honest slice otherwise", () => {
    let paid = 0;
    let declined = 0;
    let unreachable = 0;
    let clean = 0;
    for (const row of rows("flow")) {
      const { where, input, sides } = row;
      const answer = allocateSidebarWidths(input);
      if (sides.length === 0) {
        expect(answer, `${where}: no rail standing has no answer`).toBeNull();
        continue;
      }
      expect(answer, `${where}: a standing rail always has an answer`).not.toBeNull();
      const widths = answer as RailWidths;

      // The closed form, read at the widths the user chose: the cut the band
      // makes there, and what each of the two boundaries costs in rail width.
      const atPreferred = stripPicture(
        input,
        spread(row.preferredTotal, sides),
      );
      const growTotal =
        atPreferred.growPrice === null
          ? null
          : Math.ceil(row.preferredTotal + atPreferred.growPrice);
      const shrinkTotal =
        atPreferred.shrinkPrice === null
          ? null
          : Math.floor(row.preferredTotal - atPreferred.shrinkPrice);
      const legal = (total: number | null): total is number =>
        total !== null && total >= row.floorTotal && total <= row.ceilingTotal;
      const affordable = [growTotal, shrinkTotal].some(
        (total) =>
          legal(total) &&
          Math.abs(total - row.preferredTotal) <= RAIL_BOUNDARY_BUDGET_PX,
      );
      const cheapest = Math.min(
        atPreferred.growPrice ?? Infinity,
        atPreferred.shrinkPrice ?? Infinity,
      );

      const sliver = stripPicture(input, widths).worstSliver;
      const moved = Math.abs(totalOf(widths, sides) - row.preferredTotal);

      if (atPreferred.worstSliver === 0) {
        // Nothing to pay for: the rails stand where their owner put them.
        expect(sliver, `${where}: a clean band at preferred stays clean`).toBe(0);
        expect(moved, `${where}: a clean band moves no rail`).toBe(0);
        clean += 1;
      } else if (affordable) {
        expect(
          sliver,
          `${where}: a boundary was within budget (grow ${atPreferred.growPrice}, shrink ${atPreferred.shrinkPrice}), so the band ends on it`,
        ).toBe(0);
        // The rounding residual the solver leaves with the band's travel is at
        // most a pixel per rail.
        expect(
          moved,
          `${where}: a paid boundary costs no more than the budget`,
        ).toBeLessThanOrEqual(RAIL_BOUNDARY_BUDGET_PX + sides.length);
        paid += 1;
      } else {
        // No boundary is affordable: the rails stay at the widths the user
        // chose, and the cut is an honest slice, never a manufactured one.
        expect(
          moved,
          `${where}: no boundary within budget, so the rails stay where their owner put them`,
        ).toBeLessThanOrEqual(sides.length);
        if (cheapest > RAIL_BOUNDARY_BUDGET_PX) {
          // The budget refused it, not a floor: the slice is readable.
          expect(
            sliver,
            `${where}: a cut the budget declined to pay for reads as a card`,
          ).toBeGreaterThanOrEqual(RESIDUAL_READABLE_MIN_PX);
          declined += 1;
        } else {
          unreachable += 1;
        }
      }
    }
    // The premise: every branch of the rule was exercised, so the sweep is
    // asserting the objective rather than agreeing with an empty space.
    expect(paid).toBeGreaterThan(500);
    expect(declined).toBeGreaterThan(500);
    expect(clean).toBeGreaterThan(500);
    expect(unreachable).toBeGreaterThan(0);
  }, 120_000);

  test("fit tiles the chain whenever some legal total can, and spends no comfort a comfortable total would not", () => {
    let tiled = 0;
    let untileable = 0;
    for (const row of rows("fit")) {
      const { where, input, sides } = row;
      const answer = allocateSidebarWidths(input);
      if (sides.length === 0) {
        expect(answer, `${where}: no rail standing has no answer`).toBeNull();
        continue;
      }
      const widths = answer as RailWidths;
      const picture = seamPicture(input, widths);
      const broken = picture.worstOverlap > 0 || picture.worstShortfall > 0;
      if (!broken) {
        tiled += 1;
        continue;
      }
      // An independent exhaustive sweep: is there any legal total that tiles?
      let comfortableTiles = false;
      let anyTiles = false;
      for (let total = row.floorTotal; total <= row.ceilingTotal; total += 1) {
        const at = seamPicture(input, spread(total, sides));
        if (at.worstOverlap === 0 && at.worstShortfall === 0) {
          anyTiles = true;
          if (total >= row.comfortTotal) comfortableTiles = true;
        }
      }
      expect(
        anyTiles,
        `${where}: overlap ${picture.worstOverlap}, shortfall ${picture.worstShortfall}, but a legal total tiles the chain`,
      ).toBe(false);
      expect(comfortableTiles).toBe(false);
      untileable += 1;
    }
    expect(tiled).toBeGreaterThan(500);
    expect(untileable).toBeGreaterThan(0);
  }, 120_000);
});
