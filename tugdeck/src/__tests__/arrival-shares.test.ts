/**
 * arrival-shares.test.ts — what a newcomer to a split column is worth, and
 * what the sitters it lands among keep ([B01]–[B04], `arrival-even-division`).
 *
 * `arrivalSharesOf` is the weight the arrival writes, and it is tested here
 * over member specs rather than through a deck for the reason
 * `deck-store-selectors.test.ts` tests `placeMembers` that way: the rule is
 * pure over `(members, arrivingId, run, seam)`, and the DeckManager around it
 * needs a canvas to measure a run at all.
 *
 * Every case asserts the HEIGHTS the stored shares produce rather than the
 * shares themselves, because the heights are what the rule is about and the
 * shares are one encoding of them — the record exists so that the next
 * re-division agrees with what the eye saw, and a round-trip through the
 * allocator is the only statement of that worth making.
 */

import { describe, expect, test } from "bun:test";

import {
  allocatePlaceHeights,
  arrivalSharesOf,
  IMPOSITION_GAP_PX,
  type PlaceMember,
} from "../lib/layout-imposer";

const SEAM = IMPOSITION_GAP_PX;
/** The harness canvas's column run, near enough — the screenshot's own. */
const RUN = 1041;
/** A folded Session card's tier, and the whole of what it claims. */
const TIER = 144;

/** The heights `members` stand at once the arrival's shares are stored. */
function heightsAfterArrival(
  members: readonly PlaceMember[],
  arrivingId: string,
  run = RUN,
): readonly number[] {
  const shares = arrivalSharesOf(members, arrivingId, run, SEAM);
  return allocatePlaceHeights(
    members.map((member) => ({ ...member, weight: shares[member.id] })),
    run,
    SEAM,
  ).heights;
}

/** A member with a floor and no ceiling — every ordinary card. */
function open(id: string, floor: number, weight?: number): PlaceMember {
  return { id, floor, ...(weight !== undefined ? { weight } : {}) };
}

/** A folded member: floor and ceiling at its tier, and no share of the run. */
function folded(id: string, tier: number): PlaceMember {
  return { id, floor: tier, ceiling: tier, weight: 0 };
}

describe("arrivalSharesOf: the newcomer divides what nobody claimed", () => {
  test("a folded sitter claims its TIER and the newcomer takes the rest", () => {
    // The screenshot: a folded Session card above a fresh one on a tall
    // column. The sitter's ceiling claims 144px of 1041 and every pixel it
    // does not claim is the newcomer's — where the arrival used to stand at
    // its declared 618 with a dead band beneath it ([F01]).
    const members = [folded("pane-a", TIER), open("pane-b", 618)];
    const heights = heightsAfterArrival(members, "pane-b");
    expect(heights[0]).toBeCloseTo(TIER, 6);
    expect(heights[1]).toBeCloseTo(RUN - SEAM - TIER, 6);
  });

  test("a WALL of folded sitters keeps its tiers and the newcomer takes everything beneath", () => {
    // The same reading with more than one sitter, which is the case the
    // allocator answers directly: a wall claims its tiers, and the run left
    // over beneath it goes to the arrival.
    const members = [
      folded("pane-a", TIER),
      folded("pane-b", TIER),
      open("pane-c", 618),
    ];
    const heights = heightsAfterArrival(members, "pane-c");
    expect(heights[0]).toBeCloseTo(TIER, 6);
    expect(heights[1]).toBeCloseTo(TIER, 6);
    expect(heights[2]).toBeCloseTo(RUN - 2 * SEAM - 2 * TIER, 6);
  });

  test("an UNWEIGHED sitter claims nothing and divides the run with the newcomer", () => {
    // Re-pointed deliberately ([B01], [B07]), which is the only way a pinned
    // decision moves. This case used to assert that a sitter standing at the
    // whole column claims the whole column, leaving the newcomer its own floor
    // and nothing more — and that read a DEFAULT as though it were a decision.
    // A card alone in a column draws at the whole run because there was nobody
    // to divide with, not because anybody chose it the whole run, and an
    // arrival is exactly the moment that stops being true. Nobody has weighed
    // either member here, so the run divides in two.
    const members = [open("pane-a", 150), open("pane-b", 618)];
    const heights = heightsAfterArrival(members, "pane-b", 2000);
    expect(heights[0]).toBeCloseTo((2000 - SEAM) / 2, 6);
    expect(heights[1]).toBeCloseTo((2000 - SEAM) / 2, 6);
  });

  test("three unweighed sitters taking a fourth come out in QUARTERS", () => {
    // [B02] read at a larger count: the sentence that divides a column of one
    // sitter in two divides a column of three in four. Nobody has divided this
    // place, so an arrival divides it, and the count is not a case.
    const members = [
      open("pane-a", 100),
      open("pane-b", 100),
      open("pane-c", 100),
      open("pane-d", 100),
    ];
    const heights = heightsAfterArrival(members, "pane-d", 2000);
    const quarter = (2000 - 3 * SEAM) / 4;
    for (const height of heights) expect(height).toBeCloseTo(quarter, 6);
  });

  test("a column too short for an even division falls back to the floors", () => {
    // The boundary on the case above, and the at0571 geometry it used to pin:
    // the newcomer's 618px floor is more than half of the 1041 run less its
    // seam, so the even division is not representable and the allocator's
    // floor pass answers instead — the newcomer at its floor and the sitter
    // with the rest, which is what this run has always answered.
    const members = [open("pane-a", 150), open("pane-b", 618)];
    const heights = heightsAfterArrival(members, "pane-b");
    expect(heights[1]).toBeCloseTo(618, 6);
    expect(heights[0]).toBeCloseTo(RUN - SEAM - 618, 6);
    // Emphatically NOT its floor: a sitter does not collapse to make room
    // nobody asked it for.
    expect(heights[0]).toBeGreaterThan(150);
  });

  test("the unnamed default hands the newcomer a fraction nobody chose; this hands it its need", () => {
    // [F08], in arithmetic, and the case that makes the rule falsifiable in
    // both directions. Against two sitters the hand has sashed to 3:1, an
    // unnamed newcomer weighs 1 and takes a quarter of the run for no stated
    // reason. Weighted, it takes exactly the floor it needs and the sitters
    // keep the rest — still at 3:1, so neither of them pays for the arrival
    // alone.
    const members = [
      open("pane-a", 100, 3),
      open("pane-b", 100, 1),
      open("pane-c", 100),
    ];
    const unnamed = allocatePlaceHeights(members, 1000, SEAM).heights;
    expect(unnamed[2]).toBeCloseTo(198, 6);
    const heights = heightsAfterArrival(members, "pane-c", 1000);
    expect(heights[2]).toBeCloseTo(100, 6);
    expect(heights[0] / heights[1]).toBeCloseTo(3, 6);
    expect(heights[0] + heights[1]).toBeCloseTo(1000 - 2 * SEAM - 100, 6);
  });

  test("the stored record REPRODUCES the heights, so the next re-division agrees", () => {
    // Why the answer comes back through the inverse rather than as weights of
    // its own: allocating from the record a second time — the resize, the
    // relaunch, the sheet going — gives the same picture.
    const members = [folded("pane-a", TIER), open("pane-b", 618)];
    const shares = arrivalSharesOf(members, "pane-b", RUN, SEAM);
    const weighted = members.map((member) => ({
      ...member,
      weight: shares[member.id],
    }));
    const once = allocatePlaceHeights(weighted, RUN, SEAM).heights;
    expect(once[0]).toBeCloseTo(TIER, 6);
    expect(once[1]).toBeCloseTo(RUN - SEAM - TIER, 6);
    // And with the bid gone — the measurement having superseded it, or the
    // sheet having closed — the newcomer keeps what it took rather than
    // falling back to its stack floor.
    const unbid = [weighted[0], { ...weighted[1], floor: 600 }];
    expect(allocatePlaceHeights(unbid, RUN, SEAM).heights[1]).toBeCloseTo(
      once[1],
      6,
    );
  });
});

describe("arrivalSharesOf: what it declines to answer", () => {
  test("a place of one member has no division to write", () => {
    expect(arrivalSharesOf([open("pane-a", 300)], "pane-a", RUN, SEAM)).toEqual(
      {},
    );
  });

  test("an arriving id the place does not hold writes nothing", () => {
    const members = [open("pane-a", 300), open("pane-b", 300)];
    expect(arrivalSharesOf(members, "pane-z", RUN, SEAM)).toEqual({});
  });

  test("a run that cannot hold the floors writes nothing", () => {
    // Those heights are floors rather than a division ([P04]), and a weight
    // inverted out of them is one the allocator would never give back.
    const members = [open("pane-a", 700), open("pane-b", 700)];
    expect(arrivalSharesOf(members, "pane-b", 1000, SEAM)).toEqual({});
  });

  test("a run the canvas cannot state writes nothing", () => {
    const members = [open("pane-a", 300), open("pane-b", 300)];
    expect(arrivalSharesOf(members, "pane-b", 0, SEAM)).toEqual({});
    expect(arrivalSharesOf(members, "pane-b", Number.NaN, SEAM)).toEqual({});
  });
});
