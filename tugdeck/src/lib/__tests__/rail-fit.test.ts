/**
 * rail-fit.test.ts — the arithmetic of *Resize Sidebars to Fit* ([B08]).
 *
 * The verb's DOM read has no unit-testable half — it is a `getBoundingClientRect`
 * on a card that is standing — but the division is pure, and the one thing it
 * has to get right is that it fills the run exactly in both of its regimes,
 * so its answer converts to shares and allocates straight back ([P10]).
 */

import { describe, expect, test } from "bun:test";

import { fitHeights, OVERVIEW_RUN_FRACTION } from "@/lib/rail-fit";
import {
  allocatePlaceHeights,
  placeSharesFromHeights,
  type PlaceMember,
} from "@/lib/layout-imposer";

/** A rail's seam, as the deck draws it — the gap the heights do not fill. */
const SEAM = 4;

const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);

describe("fitHeights", () => {
  test("the naturals fit: everyone at its natural plus its share of the slack", () => {
    const heights = fitHeights(
      [
        { floor: 100, natural: 300 },
        { floor: 100, natural: 100 },
      ],
      1000,
      SEAM,
    );
    // 596 to divide, 400 asked for, 196 slack shared 3:1.
    expect(sum(heights)).toBeCloseTo(996, 9);
    expect(heights[0] / heights[1]).toBeCloseTo(3, 9);
  });

  test("the naturals do not fit: floors first, then the room asked for above them", () => {
    const heights = fitHeights(
      [
        { floor: 200, natural: 800 },
        { floor: 200, natural: 400 },
      ],
      1000,
      SEAM,
    );
    // 996 to divide, 400 in floors, 596 left over shared 600:200.
    expect(sum(heights)).toBeCloseTo(996, 9);
    expect(heights[0]).toBeCloseTo(200 + (596 * 3) / 4, 9);
    expect(heights[1]).toBeCloseTo(200 + 596 / 4, 9);
    expect(heights[1]).toBeGreaterThan(200);
  });

  test("a natural under the member's own floor reads as the floor", () => {
    const heights = fitHeights(
      [
        { floor: 400, natural: 10 },
        { floor: 100, natural: 400 },
      ],
      1000,
      SEAM,
    );
    expect(heights[0]).toBeGreaterThanOrEqual(400);
    expect(sum(heights)).toBeCloseTo(996, 9);
  });

  test("floors that do not fit the run stand as they are — the strip ([B06])", () => {
    const heights = fitHeights(
      [
        { floor: 400, natural: 900 },
        { floor: 400, natural: 900 },
      ],
      600,
      SEAM,
    );
    expect(heights).toEqual([400, 400]);
  });

  test("the answer converts to shares and allocates straight back ([P10])", () => {
    const members: PlaceMember[] = [
      { id: "cards", floor: 240 },
      { id: "jots", floor: 240 },
      { id: "layout", floor: 240 },
    ];
    const run = 1200;
    const heights = fitHeights(
      [
        { floor: 240, natural: 600 },
        { floor: 240, natural: 240 },
        { floor: 240, natural: 300 },
      ],
      run,
      SEAM,
    );
    const shares = placeSharesFromHeights(members, heights, run, SEAM);
    const stood = allocatePlaceHeights(
      members.map((member) => ({ ...member, weight: shares[member.id] })),
      run,
      SEAM,
    );
    for (let i = 0; i < heights.length; i += 1) {
      expect(stood.heights[i]).toBeCloseTo(heights[i], 6);
    }
  });
});

describe("Overview's natural", () => {
  test("is three quarters of the run ([B10])", () => {
    expect(OVERVIEW_RUN_FRACTION).toBe(0.75);
  });
});
