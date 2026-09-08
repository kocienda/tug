/**
 * layout-imposer-heights-census.test.ts — every height a place can hand out,
 * swept, and the invariants that must hold over all of them.
 *
 * This is a census rather than a set of examples: it allocates every
 * combination of run, member count, seam, appetite mix and stored weight the
 * arc cares about, and asserts one named invariant per test over the whole
 * sweep. A failure names the invariant it broke and prints the rows that broke
 * it, so the message says what is untrue rather than which example moved.
 *
 * It was written RED, against a stub that answered as the deck answered before
 * the allocator existed — the standing from the member count, an overflowing
 * member at a fixed fraction of the run — so that the invariants the two proxy
 * rules contradicted were the specification the allocator was then written
 * against. Both are retired now and the census is green over all of them:
 *
 *  - **(b)** a place's standing is decided by its floors against its run, not
 *    by counting its members;
 *  - **(c)** a sharing place's strip IS its run;
 *  - **(g)** the allocator and `placeSharesFromHeights` are inverses, which is
 *    what makes a committed seam drag land where the user let go of it;
 *  - **(h)** every height inside `seamDragBounds` is a fixed point of that
 *    round trip, which is the same claim over the reachable set of a drag.
 *
 * The appetite mixes are fixed and named rather than random, so a failing row
 * is reproducible from its label alone.
 */

import { describe, expect, test } from "bun:test";

import {
  allocatePlaceHeights,
  IMPOSITION_GAP_PX,
  placeSharesFromHeights,
  RAIL_SEAM_PX,
  railWeightOf,
  seamDragBounds,
  type PlaceAllocation,
  type PlaceMemberAppetite,
  type PlaceStanding,
} from "../layout-imposer";

const EPSILON = 1e-6;

/** The appetite shapes the sweep draws from, assigned round-robin by index. */
const MIXES: readonly {
  name: string;
  floor: number;
  comfort: number;
  natural: number;
  greedRank: number;
}[] = [
  { name: "floor-only", floor: 240, comfort: 240, natural: 240, greedRank: 2 },
  { name: "comfortable", floor: 240, comfort: 320, natural: 400, greedRank: 3 },
  { name: "hungry", floor: 240, comfort: 320, natural: Infinity, greedRank: 1 },
  { name: "tall-floor", floor: 600, comfort: 600, natural: 600, greedRank: 9 },
  { name: "fixed", floor: 180, comfort: 400, natural: 400, greedRank: 2 },
];

/** Equal division, one member the user made three times as greedy, and one the
 *  user pushed all the way down — a zero is a weight, not an absence. */
const WEIGHT_SETS: readonly { name: string; weights: readonly number[] }[] = [
  { name: "equal", weights: [1, 1, 1, 1, 1] },
  { name: "heavy-first", weights: [3, 1, 1, 1, 1] },
  { name: "zeroed-first", weights: [0, 1, 1, 1, 1] },
];

const RUNS: readonly number[] = Array.from(
  { length: 27 },
  (_, i) => 400 + i * 100,
);
const SEAMS: readonly number[] = [RAIL_SEAM_PX, IMPOSITION_GAP_PX];
const COUNTS: readonly number[] = [1, 2, 3, 4, 5];

interface Row {
  label: string;
  members: PlaceMemberAppetite[];
  run: number;
  seam: number;
  allocation: PlaceAllocation;
  /** The standing the floors call for — what (b) asserts, and what the other
   *  invariants are keyed on, so the census states the settled rule rather
   *  than whatever the allocator happens to answer today. */
  expected: PlaceStanding;
}

function membersFor(count: number, weights: readonly number[]) {
  const members: PlaceMemberAppetite[] = [];
  for (let i = 0; i < count; i += 1) {
    const mix = MIXES[i % MIXES.length];
    members.push({
      id: `m${i}`,
      floor: mix.floor,
      comfort: mix.comfort,
      natural: mix.natural,
      greedRank: mix.greedRank,
      weight: weights[i],
    });
  }
  return members;
}

/** `Σ floor + (n − 1) · seam ≤ run` is the whole of the standing rule; one
 *  member has nothing to divide and always shares. */
function standingFromFloors(
  members: readonly PlaceMemberAppetite[],
  run: number,
  seam: number,
): PlaceStanding {
  if (members.length < 2) return "shared";
  const required =
    members.reduce((sum, member) => sum + member.floor, 0) +
    (members.length - 1) * seam;
  return required <= run ? "shared" : "overflow";
}

const ROWS: Row[] = [];
for (const run of RUNS) {
  for (const seam of SEAMS) {
    for (const count of COUNTS) {
      for (const set of WEIGHT_SETS) {
        const members = membersFor(count, set.weights);
        const expected = standingFromFloors(members, run, seam);
        ROWS.push({
          label: `${expected} run=${run} seam=${seam} n=${count} weights=${set.name} mixes=${members
            .map((_, i) => MIXES[i % MIXES.length].name)
            .join("/")}`,
          members,
          run,
          seam,
          allocation: allocatePlaceHeights(members, run, seam),
          expected,
        });
      }
    }
  }
}

const DIVIDED = ROWS.filter((row) => row.members.length >= 2);

/** The failures a sweep found, trimmed to what a reader can act on: the count
 *  is the scale of the breakage, the split between the standings says WHICH
 *  rule is broken — the ladder or the strip's fixed height — and the first few
 *  rows are how to reproduce it. */
function reportOf(failures: readonly string[]): readonly string[] {
  if (failures.length === 0) return [];
  const shared = failures.filter((line) => line.startsWith("shared")).length;
  return [
    `${failures.length} row(s) broke it: ${shared} shared, ${failures.length - shared} overflow`,
    ...failures.slice(0, 5),
  ];
}

/** The members again, wearing the weights a set of shares means. */
function withWeights(
  members: readonly PlaceMemberAppetite[],
  shares: Record<string, number>,
): PlaceMemberAppetite[] {
  return members.map((member) => ({
    ...member,
    weight: railWeightOf(shares, member.id),
  }));
}

function heightsMatch(
  actual: readonly number[],
  wanted: readonly number[],
): boolean {
  if (actual.length !== wanted.length) return false;
  return actual.every((height, i) => Math.abs(height - wanted[i]) <= EPSILON);
}

describe("the vertical census", () => {
  test("(a) no member is ever shorter than its floor", () => {
    const failures: string[] = [];
    for (const row of DIVIDED) {
      const short = row.allocation.heights.findIndex(
        (height, i) => height < row.members[i].floor - EPSILON,
      );
      if (short >= 0) {
        failures.push(
          `${row.label}: member ${short} got ${row.allocation.heights[short].toFixed(2)} under floor ${row.members[short].floor}`,
        );
      }
    }
    expect(reportOf(failures)).toEqual([]);
  });

  test("(b) the standing is decided by the floors against the run", () => {
    const failures: string[] = [];
    for (const row of DIVIDED) {
      if (row.allocation.standing !== row.expected) {
        failures.push(
          `${row.label}: stood ${row.allocation.standing}, floors call for ${row.expected}`,
        );
      }
    }
    expect(reportOf(failures)).toEqual([]);
  });

  test("(c) a sharing place's strip is its run, and nothing hangs below it", () => {
    const failures: string[] = [];
    for (const row of ROWS) {
      if (row.expected !== "shared") continue;
      const { stripLength, tops, heights } = row.allocation;
      if (Math.abs(stripLength - row.run) > EPSILON) {
        failures.push(
          `${row.label}: strip ${stripLength.toFixed(2)} against run ${row.run}`,
        );
        continue;
      }
      const over = tops.findIndex(
        (top, i) => top + heights[i] > row.run + EPSILON,
      );
      if (over >= 0) {
        failures.push(
          `${row.label}: member ${over} ends at ${(tops[over] + heights[over]).toFixed(2)} past run ${row.run}`,
        );
      }
    }
    expect(reportOf(failures)).toEqual([]);
  });

  test("(d) an overflowing place's strip is longer than its run", () => {
    const failures: string[] = [];
    for (const row of DIVIDED) {
      if (row.expected !== "overflow") continue;
      if (row.allocation.stripLength <= row.run) {
        failures.push(
          `${row.label}: strip ${row.allocation.stripLength.toFixed(2)} does not exceed run ${row.run}`,
        );
      }
    }
    expect(reportOf(failures)).toEqual([]);
  });

  test("(e) nobody is past natural while anybody is still short of it", () => {
    const failures: string[] = [];
    for (const row of DIVIDED) {
      if (row.expected !== "shared") continue;
      const heights = row.allocation.heights;
      const short = row.members.some(
        (member, i) => heights[i] < member.natural - EPSILON,
      );
      if (!short) continue;
      const over = row.members.findIndex(
        (member, i) => heights[i] > member.natural + EPSILON,
      );
      if (over >= 0) {
        failures.push(
          `${row.label}: member ${over} is past natural ${row.members[over].natural} at ${heights[over].toFixed(2)} while another is short`,
        );
      }
    }
    expect(reportOf(failures)).toEqual([]);
  });

  test("(f) comfort goes to the greedier member first", () => {
    const failures: string[] = [];
    for (const row of DIVIDED) {
      if (row.expected !== "shared") continue;
      const required =
        row.members.reduce((sum, member) => sum + member.floor, 0) +
        (row.members.length - 1) * row.seam;
      const pool = row.run - required;
      const wanted = row.members.reduce(
        (sum, member) => sum + (member.comfort - member.floor),
        0,
      );
      if (pool >= wanted) continue;
      const heights = row.allocation.heights;
      for (let i = 0; i < row.members.length; i += 1) {
        for (let j = 0; j < row.members.length; j += 1) {
          if (row.members[i].greedRank >= row.members[j].greedRank) continue;
          if (heights[j] <= row.members[j].floor + EPSILON) continue;
          if (heights[i] >= row.members[i].comfort - EPSILON) continue;
          failures.push(
            `${row.label}: member ${j} (rank ${row.members[j].greedRank}) rose above its floor while member ${i} (rank ${row.members[i].greedRank}) sits at ${heights[i].toFixed(2)} under comfort ${row.members[i].comfort}`,
          );
        }
      }
    }
    expect(reportOf(failures)).toEqual([]);
  });

  test("(g) the allocator and placeSharesFromHeights are inverses", () => {
    const failures: string[] = [];
    for (const row of DIVIDED) {
      const heights = row.allocation.heights;
      const shares = placeSharesFromHeights(
        row.members,
        heights,
        row.allocation.standing,
      );
      const again = allocatePlaceHeights(
        withWeights(row.members, shares),
        row.run,
        row.seam,
      );
      if (!heightsMatch(again.heights, heights)) {
        failures.push(
          `${row.label}: ${heights.map((h) => h.toFixed(2)).join(",")} round-tripped to ${again.heights.map((h) => h.toFixed(2)).join(",")}`,
        );
      }
    }
    expect(reportOf(failures)).toEqual([]);
  });

  test("(h) every height a seam drag can reach is a fixed point", () => {
    const failures: string[] = [];
    for (const row of DIVIDED) {
      const heights = row.allocation.heights;
      for (let index = 0; index < row.members.length - 1; index += 1) {
        const { lower, upper } = seamDragBounds(
          row.allocation,
          row.members,
          index,
        );
        const held = heights[index];
        if (held < lower - EPSILON || held > upper + EPSILON) {
          failures.push(
            `${row.label}: seam ${index} holds ${held.toFixed(2)} outside its own bounds [${lower.toFixed(2)}, ${upper.toFixed(2)}]`,
          );
          continue;
        }
        const span = heights[index] + heights[index + 1];
        for (const probe of [lower, (lower + upper) / 2, upper]) {
          const probed = heights.slice();
          probed[index] = probe;
          probed[index + 1] = span - probe;
          const shares = placeSharesFromHeights(
            row.members,
            probed,
            row.allocation.standing,
          );
          const again = allocatePlaceHeights(
            withWeights(row.members, shares),
            row.run,
            row.seam,
          );
          if (!heightsMatch(again.heights, probed)) {
            failures.push(
              `${row.label}: seam ${index} at ${probe.toFixed(2)} allocated back as ${again.heights.map((h) => h.toFixed(2)).join(",")} rather than ${probed.map((h) => h.toFixed(2)).join(",")}`,
            );
            break;
          }
        }
      }
    }
    expect(reportOf(failures)).toEqual([]);
  });
});

// ---- The ladder, one stage at a time ----

/** A member with an appetite and nothing else about it. */
function appetite(
  id: string,
  floor: number,
  comfort: number,
  natural: number,
  greedRank: number,
  weight = 1,
): PlaceMemberAppetite {
  return { id, floor, comfort, natural, greedRank, weight };
}

describe("the ladder fills a shared run stage by stage", () => {
  test("floors first, and the remainder by weight when nothing wants more", () => {
    // Three cards declaring only a floor: the ladder's middle two stages have
    // nothing to do, and stage 4 divides what is left equally.
    const { heights, standing } = allocatePlaceHeights(
      [
        appetite("a", 240, 240, 240, 5),
        appetite("b", 240, 240, 240, 5),
        appetite("c", 240, 240, 240, 5),
      ],
      2000,
      0,
    );
    expect(standing).toBe("shared");
    for (const height of heights) expect(height).toBeCloseTo(2000 / 3, 6);
  });

  test("a member at its natural height takes no more, and the rest split the surplus", () => {
    // The fixed member's natural height is 400 and it gets exactly 400. The
    // two whose naturals are endless divide everything above their comforts,
    // which is the whole of what stage 4 is for.
    const { heights } = allocatePlaceHeights(
      [
        appetite("fixed", 240, 400, 400, 2),
        appetite("hungry-1", 240, 320, Infinity, 1),
        appetite("hungry-2", 240, 320, Infinity, 1),
      ],
      2000,
      0,
    );
    expect(heights[0]).toBeCloseTo(400, 6);
    expect(heights[1]).toBeCloseTo(800, 6);
    expect(heights[2]).toBeCloseTo(800, 6);
  });

  test("comfort goes to the greediest first, and the last rank takes what is left", () => {
    // A 900px run over three floors of 240 leaves 180 of comfort to hand out
    // and 480 of comfort asked for. Rank 1 is fed to its 400, rank 2 takes the
    // 20 that remain, and rank 3 stands at its floor — somebody has to be
    // short, and the registry's greed rank is the statement of who.
    const { heights } = allocatePlaceHeights(
      [
        appetite("mid", 240, 400, 400, 2),
        appetite("last", 240, 400, 400, 3),
        appetite("first", 240, 400, 400, 1),
      ],
      900,
      0,
    );
    expect(heights[2]).toBeCloseTo(400, 6);
    expect(heights[0]).toBeCloseTo(260, 6);
    expect(heights[1]).toBeCloseTo(240, 6);
  });

  test("the discretionary pool is what the weights divide, not the run", () => {
    // 3:1 over a pool of 1000 − 480 = 520, so the upper member takes 390 of it
    // and the lower 130 — never 750 and 250, which is what dividing the run
    // itself would give and what every member's floor forbids.
    const { heights } = allocatePlaceHeights(
      [
        appetite("a", 240, 240, Infinity, 5, 3),
        appetite("b", 240, 240, Infinity, 5, 1),
      ],
      1000,
      0,
    );
    expect(heights[0]).toBeCloseTo(240 + 390, 6);
    expect(heights[1]).toBeCloseTo(240 + 130, 6);
  });

  test("a zero weight holds a member at the floor of the stage it is in", () => {
    // Zero is a legal weight and means no share of the pool ([P04]). The other
    // member takes the whole of it.
    const { heights } = allocatePlaceHeights(
      [
        appetite("a", 240, 240, Infinity, 5, 0),
        appetite("b", 240, 240, Infinity, 5, 1),
      ],
      1000,
      0,
    );
    expect(heights[0]).toBeCloseTo(240, 6);
    expect(heights[1]).toBeCloseTo(760, 6);
  });
});
