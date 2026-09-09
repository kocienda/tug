/**
 * layout-imposer-heights-census.test.ts — every height a place can hand out,
 * swept, and the invariants that must hold over all of them.
 *
 * This is a census rather than a set of examples: it allocates every
 * combination of run, member count, seam, appetite mix and stored share the
 * arc cares about, and asserts one named invariant per test over the whole
 * sweep. A failure names the invariant it broke and prints the rows that broke
 * it, so the message says what is untrue rather than which example moved.
 *
 * It sweeps a LAYOUT axis ([B12]): every row is allocated once as a fit place
 * and once as a flow one, and the invariants say which of the two they are
 * about. Fit divides its run by the stored shares, bounded below by the floors,
 * and fills it exactly; flow stands every member at its own `natural · weight`;
 * and the round trip through `placeSharesFromHeights` is the identity under
 * both.
 *
 * A fitting place's heights are a function of its SHARES and its floors, never
 * of its comforts or naturals ([B01]): a seam moves only when the hand moves
 * it, and content that outgrows a share scrolls inside its card. The appetites
 * are read at exactly one moment — the seed, which is what a place with no
 * record stands at and what a membership change or Fit to Content writes — and
 * the seed is tested on its own below, as a pure function of the appetites.
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
  seedPlaceShares,
  seedSharedHeights,
  type PlaceAllocation,
  type PlaceLayout,
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

/** No record at all (the seed), an equal division, one member the user made
 *  three times as large, and one the user pushed all the way down — a zero is
 *  a share, not an absence. */
const WEIGHT_SETS: readonly {
  name: string;
  weights: readonly (number | undefined)[];
}[] = [
  { name: "absent", weights: [undefined, undefined, undefined, undefined, undefined] },
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
const LAYOUTS: readonly PlaceLayout[] = ["fit", "flow"];

interface Row {
  label: string;
  members: PlaceMemberAppetite[];
  run: number;
  seam: number;
  layout: PlaceLayout;
  allocation: PlaceAllocation;
  /** Whether the row carries a stored record — the rows whose fit heights are
   *  a division by shares — or none, whose fit heights are the seed. */
  recorded: boolean;
  /** The standing the layout calls for — what (b) asserts, and what the other
   *  invariants are keyed on, so the census states the settled rule rather
   *  than whatever the allocator happens to answer today. */
  expected: PlaceStanding;
}

function membersFor(
  count: number,
  weights: readonly (number | undefined)[],
) {
  const members: PlaceMemberAppetite[] = [];
  for (let i = 0; i < count; i += 1) {
    const mix = MIXES[i % MIXES.length];
    members.push({
      id: `m${i}`,
      floor: mix.floor,
      comfort: mix.comfort,
      natural: mix.natural,
      greedRank: mix.greedRank,
      ...(weights[i] === undefined ? {} : { weight: weights[i] }),
    });
  }
  return members;
}

/** A flowing place is a strip by choice, and a fitting one whose floors do not
 *  fit its run is a strip by arithmetic ([B07]) — that exception is the whole
 *  of what fit's `Σ floor + (n − 1) · seam ≤ run` decides. One member has
 *  nothing to divide and always shares. */
function standingFromLayout(
  members: readonly PlaceMemberAppetite[],
  run: number,
  seam: number,
  layout: PlaceLayout,
): PlaceStanding {
  if (members.length < 2) return "shared";
  if (layout === "flow") return "overflow";
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
        for (const layout of LAYOUTS) {
          const members = membersFor(count, set.weights);
          const expected = standingFromLayout(members, run, seam, layout);
          ROWS.push({
            label: `${expected} ${layout} run=${run} seam=${seam} n=${count} weights=${set.name} mixes=${members
              .map((_, i) => MIXES[i % MIXES.length].name)
              .join("/")}`,
            members,
            run,
            seam,
            layout,
            allocation: allocatePlaceHeights(members, run, seam, layout),
            recorded: set.name !== "absent",
            expected,
          });
        }
      }
    }
  }
}

const DIVIDED = ROWS.filter((row) => row.members.length >= 2);

/** The failures a sweep found, trimmed to what a reader can act on: the count
 *  is the scale of the breakage, the split between the standings says WHICH
 *  rule is broken — the division or the strip's fixed height — and the first
 *  few rows are how to reproduce it. */
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

/**
 * The division a set of shares means over `run`, bounded by the floors —
 * restated here independently of the allocator, so (j) is a claim about the
 * rule rather than about the code agreeing with itself. Each member's target
 * is its share of the run less the seams; a member whose target is under its
 * floor stands at the floor and the rest divide what is left, repeated until
 * nobody new drops under.
 */
function divisionOf(
  members: readonly PlaceMemberAppetite[],
  run: number,
  seam: number,
): number[] {
  const weights = members.map((member) => member.weight ?? 1);
  const heights = members.map((member) => member.floor);
  let active = members.map((_, i) => i);
  let room = run - (members.length - 1) * seam;
  for (;;) {
    const total = active.reduce((sum, i) => sum + weights[i], 0);
    const targets = active.map((i) =>
      total > 0 ? (room * weights[i]) / total : room / active.length,
    );
    const floored = active.filter(
      (i, k) => targets[k] < members[i].floor - EPSILON,
    );
    if (floored.length === 0) {
      active.forEach((i, k) => {
        heights[i] = targets[k];
      });
      return heights;
    }
    for (const i of floored) room -= members[i].floor;
    const held = new Set(floored);
    active = active.filter((i) => !held.has(i));
    if (active.length === 0) return heights;
  }
}

describe("the vertical census", () => {
  test("(0) the sweep reaches both layouts, both standings, and both kinds of record", () => {
    // A census whose invariants are all scoped by layout is only as strong as
    // the rows it actually holds: every one of the cells below is a claim
    // some later test in this file makes, and an empty cell would let that
    // test pass by having nothing to check.
    const cell = (layout: PlaceLayout, standing: PlaceStanding): number =>
      DIVIDED.filter(
        (row) => row.layout === layout && row.expected === standing,
      ).length;
    expect(cell("fit", "shared")).toBeGreaterThan(0);
    expect(cell("fit", "overflow")).toBeGreaterThan(0);
    expect(cell("flow", "overflow")).toBeGreaterThan(0);
    // Flow is a strip whatever its run: there is no such thing as a sharing
    // flow place, and that absence is the layout axis's own claim ([B04]).
    expect(cell("flow", "shared")).toBe(0);
    expect(
      DIVIDED.filter((row) => row.layout === "fit" && !row.recorded).length,
    ).toBeGreaterThan(0);
    expect(
      DIVIDED.filter((row) => row.layout === "fit" && row.recorded).length,
    ).toBeGreaterThan(0);
  });

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

  test("(b) the standing follows the layout, and fit's floors are its one exception", () => {
    const failures: string[] = [];
    for (const row of DIVIDED) {
      if (row.allocation.standing !== row.expected) {
        failures.push(
          `${row.label}: stood ${row.allocation.standing}, ${row.layout} calls for ${row.expected}`,
        );
      }
      if (row.allocation.layout !== row.layout) {
        failures.push(
          `${row.label}: allocation carries layout ${row.allocation.layout}`,
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

  test("(d) a fitting place that could not fit its floors overflows its run", () => {
    const failures: string[] = [];
    for (const row of DIVIDED) {
      // Fit's rows only. A flowing place's strip is as long as its members
      // make it and no longer: three short cards on a tall display leave
      // honest vacancy at the foot rather than stretching to fill it ([B08]),
      // so "longer than the run" is a claim about fit's fallback alone.
      if (row.layout !== "fit") continue;
      if (row.expected !== "overflow") continue;
      if (row.allocation.stripLength <= row.run) {
        failures.push(
          `${row.label}: strip ${row.allocation.stripLength.toFixed(2)} does not exceed run ${row.run}`,
        );
      }
    }
    expect(reportOf(failures)).toEqual([]);
  });

  test("(j) a recorded fit place stands at its shares over the run, bounded by the floors", () => {
    // The rule itself ([B01], [B11]): the heights are the shares, and nothing
    // about a comfort or a natural enters. `divisionOf` is the rule restated
    // here, so the census is not the allocator agreeing with itself.
    const failures: string[] = [];
    for (const row of DIVIDED) {
      if (row.expected !== "shared" || !row.recorded) continue;
      const wanted = divisionOf(row.members, row.run, row.seam);
      if (!heightsMatch(row.allocation.heights, wanted)) {
        failures.push(
          `${row.label}: got ${row.allocation.heights.map((h) => h.toFixed(2)).join(",")} rather than the division ${wanted.map((h) => h.toFixed(2)).join(",")}`,
        );
      }
    }
    expect(reportOf(failures)).toEqual([]);
  });

  test("(k) a recorded fit place's heights do not move when its appetites do", () => {
    // Content never moves a seam ([B01]). The same shares over members whose
    // comforts and naturals have all changed allocate to the same heights —
    // which is the whole of what makes a collapse inside a card, or a fold,
    // leave the control that was pressed where it was.
    const failures: string[] = [];
    for (const row of DIVIDED) {
      if (row.layout !== "fit" || row.expected !== "shared" || !row.recorded) {
        continue;
      }
      const grown = row.members.map((member) => ({
        ...member,
        comfort: member.floor + 50,
        natural: Number.isFinite(member.natural) ? member.natural * 3 : 700,
      }));
      const again = allocatePlaceHeights(grown, row.run, row.seam, "fit");
      if (!heightsMatch(again.heights, row.allocation.heights)) {
        failures.push(
          `${row.label}: appetites moved and the heights went ${row.allocation.heights.map((h) => h.toFixed(2)).join(",")} → ${again.heights.map((h) => h.toFixed(2)).join(",")}`,
        );
      }
    }
    expect(reportOf(failures)).toEqual([]);
  });

  test("(l) a fit place with no record stands at the seed, and the seed's shares reproduce it", () => {
    // An absent record is a place nobody has divided: it allocates from the
    // appetites once, and the deck writes `seedPlaceShares` into the record so
    // that nothing later re-derives it. The two have to agree to the pixel, or
    // the write itself would move a seam.
    const failures: string[] = [];
    for (const row of DIVIDED) {
      if (row.layout !== "fit" || row.expected !== "shared" || row.recorded) {
        continue;
      }
      const seed = seedSharedHeights(row.members, row.run, row.seam);
      if (!heightsMatch(row.allocation.heights, seed)) {
        failures.push(
          `${row.label}: got ${row.allocation.heights.map((h) => h.toFixed(2)).join(",")} rather than the seed ${seed.map((h) => h.toFixed(2)).join(",")}`,
        );
        continue;
      }
      const shares = seedPlaceShares(row.members, row.run, row.seam);
      const written = allocatePlaceHeights(
        withWeights(row.members, shares),
        row.run,
        row.seam,
        "fit",
      );
      if (!heightsMatch(written.heights, seed)) {
        failures.push(
          `${row.label}: the written seed allocates to ${written.heights.map((h) => h.toFixed(2)).join(",")} rather than ${seed.map((h) => h.toFixed(2)).join(",")}`,
        );
      }
    }
    expect(reportOf(failures)).toEqual([]);
  });

  test("(i) a flowing member stands at its own natural times its weight", () => {
    // Flow's whole promise ([B08]), swept: nothing about the run enters a
    // member's height except for a stream, whose natural is endless and which
    // therefore reads the run as one screen of itself. The floor still binds,
    // and an absent record weighs 1.
    const failures: string[] = [];
    for (const row of DIVIDED) {
      if (row.layout !== "flow") continue;
      for (let i = 0; i < row.members.length; i += 1) {
        const member = row.members[i];
        const natural = Number.isFinite(member.natural)
          ? member.natural
          : row.run;
        const wanted = Math.max(member.floor, natural * (member.weight ?? 1));
        if (Math.abs(row.allocation.heights[i] - wanted) > EPSILON) {
          failures.push(
            `${row.label}: member ${i} got ${row.allocation.heights[i].toFixed(2)} rather than max(floor ${member.floor}, natural ${natural} × weight ${member.weight ?? 1}) = ${wanted.toFixed(2)}`,
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
        row.layout,
        row.run,
        row.seam,
      );
      const again = allocatePlaceHeights(
        withWeights(row.members, shares),
        row.run,
        row.seam,
        row.layout,
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
          // What the drag actually reaches, which is not the same gesture in
          // both standings: a shared place trades the span between the two
          // members either side of the seam, and a flowing one resizes the
          // member above it and lengthens the strip, leaving its neighbour at
          // the height it declared ([B08]).
          if (row.allocation.standing === "shared") {
            probed[index + 1] = span - probe;
          }
          const shares = placeSharesFromHeights(
            row.members,
            probed,
            row.layout,
            row.run,
            row.seam,
          );
          const again = allocatePlaceHeights(
            withWeights(row.members, shares),
            row.run,
            row.seam,
            row.layout,
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

  test("(m) a shared seam trades between the floors and nothing narrower", () => {
    // The division is the hand's, so the only thing that bounds a drag is a
    // floor ([B01]): the upper member may go down to its own and up to what
    // leaves its neighbour at its own. A comfort or a natural narrowing that
    // range would be the allocator holding a seam the user is dragging.
    const failures: string[] = [];
    for (const row of DIVIDED) {
      if (row.allocation.standing !== "shared") continue;
      const heights = row.allocation.heights;
      for (let index = 0; index < row.members.length - 1; index += 1) {
        const { lower, upper } = seamDragBounds(row.allocation, row.members, index);
        const span = heights[index] + heights[index + 1];
        const wantedLower = row.members[index].floor;
        const wantedUpper = span - row.members[index + 1].floor;
        if (
          Math.abs(lower - wantedLower) > EPSILON ||
          Math.abs(upper - wantedUpper) > EPSILON
        ) {
          failures.push(
            `${row.label}: seam ${index} bounded [${lower.toFixed(2)}, ${upper.toFixed(2)}] rather than [${wantedLower.toFixed(2)}, ${wantedUpper.toFixed(2)}]`,
          );
        }
      }
    }
    expect(reportOf(failures)).toEqual([]);
  });
});

// ---- The seed: the ladder, one stage at a time ----
//
// The seed is the one moment content is read ([B03]), and it is a pure
// function of the appetites: what a fitting place stands at before any hand
// has divided it, and what Fit to Content puts it back to. It is tested here on
// its own, over `seedSharedHeights`, rather than through the allocator — the
// allocator reaches it only for a place with no record, and the record is what
// every other test in this file is about.

/** A member with an appetite and nothing else about it. */
function appetite(
  id: string,
  floor: number,
  comfort: number,
  natural: number,
  greedRank: number,
): PlaceMemberAppetite {
  return { id, floor, comfort, natural, greedRank };
}

describe("the seed fills a shared run stage by stage", () => {
  test("(e) nobody is past natural while anybody is still short of it", () => {
    const failures: string[] = [];
    for (const row of DIVIDED) {
      if (row.layout !== "fit" || row.expected !== "shared") continue;
      const heights = seedSharedHeights(row.members, row.run, row.seam);
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
      if (row.layout !== "fit" || row.expected !== "shared") continue;
      const required =
        row.members.reduce((sum, member) => sum + member.floor, 0) +
        (row.members.length - 1) * row.seam;
      const pool = row.run - required;
      const wanted = row.members.reduce(
        (sum, member) => sum + (member.comfort - member.floor),
        0,
      );
      if (pool >= wanted) continue;
      const heights = seedSharedHeights(row.members, row.run, row.seam);
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

  test("(n) the seed ignores the stored shares", () => {
    // A seed is what a place gets when there is no record, or when the hand
    // asked for the division content would make. Either way the record is not
    // an input, so the same appetites seed the same heights whatever they
    // wear.
    const failures: string[] = [];
    for (const row of DIVIDED) {
      if (row.layout !== "fit" || row.expected !== "shared" || !row.recorded) {
        continue;
      }
      const bare = row.members.map(({ weight: _weight, ...member }) => member);
      const worn = seedSharedHeights(row.members, row.run, row.seam);
      const naked = seedSharedHeights(bare, row.run, row.seam);
      if (!heightsMatch(worn, naked)) {
        failures.push(
          `${row.label}: the seed read the shares — ${worn.map((h) => h.toFixed(2)).join(",")} against ${naked.map((h) => h.toFixed(2)).join(",")}`,
        );
      }
    }
    expect(reportOf(failures)).toEqual([]);
  });

  test("floors first, and the slack whole to the greediest when nothing wants more", () => {
    // Three cards declaring only a floor: the ladder's middle two stages have
    // nothing to do, and stage 4 hands the whole remainder to one of them.
    // Every rank is 5, so position breaks the tie and the first card takes it;
    // the other two stand at exactly the natural they declared, which is what
    // puts both seams on a content boundary.
    const heights = seedSharedHeights(
      [
        appetite("a", 240, 240, 240, 5),
        appetite("b", 240, 240, 240, 5),
        appetite("c", 240, 240, 240, 5),
      ],
      2000,
      0,
    );
    expect(heights[0]).toBeCloseTo(2000 - 480, 6);
    expect(heights[1]).toBeCloseTo(240, 6);
    expect(heights[2]).toBeCloseTo(240, 6);
  });

  test("the greed rank decides which card holds the slack, not the order", () => {
    // The same run, and the only thing that moved is a rank: the greediest
    // card takes the whole of it wherever it stands in the place.
    const heights = seedSharedHeights(
      [
        appetite("a", 240, 240, 240, 5),
        appetite("b", 240, 240, 240, 2),
        appetite("c", 240, 240, 240, 5),
      ],
      2000,
      0,
    );
    expect(heights[0]).toBeCloseTo(240, 6);
    expect(heights[1]).toBeCloseTo(2000 - 480, 6);
    expect(heights[2]).toBeCloseTo(240, 6);
  });

  test("a member at its natural height takes no more, and the rest split the surplus", () => {
    // The fixed member's natural height is 400 and it gets exactly 400. The
    // two whose naturals are endless divide everything above their comforts
    // evenly, which is the whole of what stage 3 is for.
    const heights = seedSharedHeights(
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
    const heights = seedSharedHeights(
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

  test("seedPlaceShares is empty where there is nothing to divide", () => {
    // One member has no division; floors that do not fit the run stand the
    // place as a strip, and a strip has no seed to write.
    expect(seedPlaceShares([appetite("a", 240, 240, 240, 5)], 900, 0)).toEqual(
      {},
    );
    expect(
      seedPlaceShares(
        [appetite("a", 500, 500, 500, 5), appetite("b", 500, 500, 500, 5)],
        900,
        0,
      ),
    ).toEqual({});
  });
});

// ---- The division, one claim at a time ----

describe("a recorded fit place divides its run by its shares", () => {
  const sharing = (
    id: string,
    floor: number,
    weight: number,
  ): PlaceMemberAppetite => ({
    id,
    floor,
    comfort: floor,
    natural: floor,
    greedRank: 5,
    weight,
  });

  test("the shares divide the run itself, not a pool above the floors", () => {
    // 3:1 over a run of 1000 is 750 and 250, and both clear the 240 floor.
    // Under the retired rule the floors were fed first and the weights divided
    // the 520 left over, which would have given 630 and 370.
    const { heights } = allocatePlaceHeights(
      [sharing("a", 240, 3), sharing("b", 240, 1)],
      1000,
      0,
    );
    expect(heights[0]).toBeCloseTo(750, 6);
    expect(heights[1]).toBeCloseTo(250, 6);
  });

  test("a share that would take a member under its floor stops at the floor", () => {
    // 3:1 over 600 asks 150 of the second member, which is under its 240
    // floor: it stands at 240 and the first takes the 360 that are left.
    const { heights } = allocatePlaceHeights(
      [sharing("a", 240, 3), sharing("b", 240, 1)],
      600,
      0,
    );
    expect(heights[0]).toBeCloseTo(360, 6);
    expect(heights[1]).toBeCloseTo(240, 6);
  });

  test("a zero share holds a member at its floor", () => {
    const { heights } = allocatePlaceHeights(
      [sharing("a", 240, 0), sharing("b", 240, 1)],
      1000,
      0,
    );
    expect(heights[0]).toBeCloseTo(240, 6);
    expect(heights[1]).toBeCloseTo(760, 6);
  });

  test("an all-zero record divides evenly, the only reading a total of nothing has", () => {
    const { heights } = allocatePlaceHeights(
      [sharing("a", 240, 0), sharing("b", 240, 0)],
      1000,
      0,
    );
    expect(heights[0]).toBeCloseTo(500, 6);
    expect(heights[1]).toBeCloseTo(500, 6);
  });

  test("the seams come off the run before it is divided", () => {
    const { heights } = allocatePlaceHeights(
      [sharing("a", 0, 1), sharing("b", 0, 1), sharing("c", 0, 1)],
      330,
      15,
    );
    for (const height of heights) expect(height).toBeCloseTo(100, 6);
  });
});
