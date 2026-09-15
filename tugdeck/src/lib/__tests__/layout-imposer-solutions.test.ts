/**
 * layout-imposer-solutions.test.ts — the space allocator's whole solution
 * space, enumerated.
 *
 * The allocator is a total function of (canvas width, imposition kind,
 * occupied slots and their widths, rail policies), and for any fixed discrete
 * configuration its answer is piecewise-linear in canvas width with a handful
 * of computable breakpoints. That is small enough to *check exhaustively*
 * rather than to spot-check, so this file does two things:
 *
 *  1. **The invariant sweep** — the strong net. Every configuration below is
 *     solved at every breakpoint (±1px, where the answer's slope changes) and
 *     across a coarse canvas sweep, and every point is asserted against the
 *     invariant order the solver implements: totality, bounds, greed
 *     soundness, tiling, monotonicity in canvas width, and tie fairness. These
 *     are PROPERTIES, so they survive an intentional retune of the numbers.
 *  2. **The golden table** — the drift net. A deterministic representative
 *     slice is serialized and compared against a checked-in JSON file, so ANY
 *     behavioral change, intended or not, shows up in review as a readable
 *     diff.
 *
 * Regenerate the golden deliberately:
 *
 * ```
 * cd tugdeck && IMPOSER_GOLDEN_UPDATE=1 bun test src/lib/__tests__/layout-imposer-solutions.test.ts
 * ```
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  CONTENT_WIDTH_COMFY_PX,
  CONTENT_WIDTH_SLIM_PX,
  CONTENT_WIDTH_WIDE_PX,
  IMPOSITION_GAP_PX,
  IMPOSITION_KINDS,
  allocateSidebarWidths,
  RAIL_BOUNDARY_BUDGET_PX,
  seamPicture,
  slotCount,
  solveSidebarWidths,
  stripPicture,
  travelFraction,
  type AllocatorInput,
  type ImpositionKind,
  type RailPolicy,
  type RailWidths,
  type SidebarSide,
} from "@/lib/layout-imposer";
import {
  COMFORT_OVERVIEW_WIDTH_PX,
  DEFAULT_OVERVIEW_WIDTH_PX,
  MIN_OVERVIEW_WIDTH_PX,
} from "@/lib/overview-measure";

const GAP = IMPOSITION_GAP_PX;
/** The ceiling the deck passes, for every rail. */
const CEILING = CONTENT_WIDTH_SLIM_PX;
/** The rank an unranked card takes (`card-registry`'s `DEFAULT_GREED_RANK`),
 *  spelled out because the imposer is pure and never reads the registry. */
const UNRANKED = 9;

/* ---------------------------------------------------------------------------
 * The configuration space (List L01)
 * ---------------------------------------------------------------------------*/

/** One rail fixture: what stands on each side, and the member floors a folded
 *  rail must never fall below. */
interface RailFixture {
  name: string;
  rails: { left?: RailPolicy; right?: RailPolicy };
  /** The per-side member floors this fixture's policies were folded from. */
  memberFloors: { left?: readonly number[]; right?: readonly number[] };
}

/** The Overview's real registered policy — the widths this plan derives from
 *  its type, imported rather than re-hardcoded so a retune of the measure
 *  moves this sweep with it. */
const OVERVIEW: RailPolicy = {
  preferredWidth: DEFAULT_OVERVIEW_WIDTH_PX,
  minWidth: MIN_OVERVIEW_WIDTH_PX,
  comfortWidth: COMFORT_OVERVIEW_WIDTH_PX,
  greedRank: 1,
};
/** A rail with no comfort band — comfort sits on the hard floor, which is what
 *  every card that registers no comfort width resolves to. */
const bare = (policy: Omit<RailPolicy, "comfortWidth">): RailPolicy => ({
  ...policy,
  comfortWidth: policy.minWidth,
});
const CARDS: RailPolicy = bare({
  preferredWidth: 420,
  minWidth: 320,
  greedRank: 2,
});
const JOTS: RailPolicy = bare({
  preferredWidth: 420,
  minWidth: 320,
  greedRank: 3,
});
/** A rail the user has dragged wide: preference is theirs, and the solver
 *  reads it from the durable store, so a dragged width is an ordinary input. */
const DRAGGED: RailPolicy = bare({
  preferredWidth: 600,
  minWidth: 320,
  greedRank: UNRANKED,
});

/**
 * The Overview after its owner has dragged it NARROWER than its comfort
 * measure — which the hard floor lets them do, and which the allocator must
 * honor. The comfort floor may never grow this rail back toward 512: doing so
 * would widen it against an explicit choice and deepen the very overlap the
 * user was presumably trying to relieve.
 */
const DRAGGED_UNDER_COMFORT: RailPolicy = {
  preferredWidth: 450,
  minWidth: MIN_OVERVIEW_WIDTH_PX,
  comfortWidth: COMFORT_OVERVIEW_WIDTH_PX,
  greedRank: 1,
};

/** The stacking fold `deck-manager`'s `_sidebarRails` performs. */
function foldRail(members: readonly RailPolicy[]): RailPolicy {
  return {
    preferredWidth: Math.max(...members.map((m) => m.preferredWidth)),
    minWidth: Math.max(...members.map((m) => m.minWidth)),
    comfortWidth: Math.max(...members.map((m) => m.comfortWidth)),
    greedRank: Math.min(...members.map((m) => m.greedRank)),
  };
}

const RAIL_FIXTURES: readonly RailFixture[] = [
  {
    name: "overview-right",
    rails: { right: OVERVIEW },
    memberFloors: { right: [OVERVIEW.minWidth] },
  },
  {
    name: "cards-left",
    rails: { left: CARDS },
    memberFloors: { left: [CARDS.minWidth] },
  },
  {
    name: "jots-right",
    rails: { right: JOTS },
    memberFloors: { right: [JOTS.minWidth] },
  },
  {
    name: "overview-jots-stacked-right",
    rails: { right: foldRail([OVERVIEW, JOTS]) },
    memberFloors: { right: [OVERVIEW.minWidth, JOTS.minWidth] },
  },
  {
    name: "cards-left+overview-right",
    rails: { left: CARDS, right: OVERVIEW },
    memberFloors: { left: [CARDS.minWidth], right: [OVERVIEW.minWidth] },
  },
  {
    name: "jots-left+overview-right",
    rails: { left: JOTS, right: OVERVIEW },
    memberFloors: { left: [JOTS.minWidth], right: [OVERVIEW.minWidth] },
  },
  {
    name: "equal-rank-pair",
    rails: {
      left: bare({ preferredWidth: 400, minWidth: 320, greedRank: 5 }),
      right: bare({ preferredWidth: 400, minWidth: 320, greedRank: 5 }),
    },
    memberFloors: { left: [320], right: [320] },
  },
  {
    name: "dragged-left+overview-right",
    rails: { left: DRAGGED, right: OVERVIEW },
    memberFloors: { left: [DRAGGED.minWidth], right: [OVERVIEW.minWidth] },
  },
  {
    name: "overview-dragged-under-comfort-right",
    rails: { right: DRAGGED_UNDER_COMFORT, left: CARDS },
    memberFloors: {
      left: [CARDS.minWidth],
      right: [DRAGGED_UNDER_COMFORT.minWidth],
    },
  },
];

type Occupancy = { name: string; occupied: { slot: number; width: number }[] };

/** Every non-empty subset of the kind's slots, each at a uniform card width,
 *  plus one alternating slim/wide pattern per subset of two or more. */
function occupanciesFor(kind: ImpositionKind): Occupancy[] {
  const slots = slotCount(kind);
  const out: Occupancy[] = [];
  for (let mask = 1; mask < 1 << slots; mask += 1) {
    const taken: number[] = [];
    for (let slot = 0; slot < slots; slot += 1) {
      if ((mask & (1 << slot)) !== 0) taken.push(slot);
    }
    for (const [label, width] of [
      ["slim", CONTENT_WIDTH_SLIM_PX],
      ["comfy", CONTENT_WIDTH_COMFY_PX],
      ["wide", CONTENT_WIDTH_WIDE_PX],
    ] as const) {
      out.push({
        name: `${mask}:${label}`,
        occupied: taken.map((slot) => ({ slot, width })),
      });
    }
    if (taken.length >= 2) {
      out.push({
        name: `${mask}:mixed`,
        occupied: taken.map((slot, i) => ({
          slot,
          width: i % 2 === 0 ? CONTENT_WIDTH_SLIM_PX : CONTENT_WIDTH_WIDE_PX,
        })),
      });
    }
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * The breakpoints
 * ---------------------------------------------------------------------------*/

/** The sides carrying a rail, in the order the solver reads them. */
function sidesOf(rails: AllocatorInput["rails"]): SidebarSide[] {
  const sides: SidebarSide[] = [];
  if (rails.left !== undefined) sides.push("left");
  if (rails.right !== undefined) sides.push("right");
  return sides;
}

/**
 * The bounds the solver derives for one rail.
 *
 * `floor` is the HARD floor — the width below which the card cannot paint, and
 * the only number the answer is truly bounded by. `comfortFloor` is the
 * narrowest the rail is comfortable at, clamped from above by the rail's own
 * preference: a rail the user dragged below its comfort measure keeps the drag
 * as its effective comfort floor, so comfort can never re-inflate a choice the
 * user made.
 */
function boundsOf(policy: RailPolicy): {
  floor: number;
  comfortFloor: number;
  ceiling: number;
  preferred: number;
} {
  const floor = Math.ceil(policy.minWidth);
  const ceiling = Math.max(Math.round(CEILING), floor);
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

/**
 * A split of `total` across the sides the answer carries. Every split of a
 * given total reads the SAME picture (the separation property — `resolveSpan`
 * insets by `railWidth + gap` per side, so the band depends on the total and
 * never on how it is divided), so this is arbitrary as long as it is
 * deterministic and carries the right number of sides.
 */
function spread(total: number, sides: readonly SidebarSide[]): RailWidths {
  const widths: RailWidths = {};
  const each = total / sides.length;
  for (const side of sides) widths[side] = each;
  return widths;
}

/** What the chain looks like when the rails total `total`. */
function pictureAt(
  input: AllocatorInput,
  total: number,
): { worstError: number; worstOverlap: number; worstShortfall: number } {
  return seamPicture(input, spread(total, sidesOf(input.rails)));
}

/**
 * The canvas widths where a configuration's answer changes slope.
 *
 * `T*` is linear in canvas width with slope 1 (`T* = canvas − gap·(R+2) − B*`),
 * so a rail TOTAL maps to a canvas by adding back the constant. `B*` is read
 * off `solveSidebarWidths` at a reference canvas rather than recomputed here,
 * so this cannot drift from the solver's own fit. The interesting totals are
 * Σ floors, Σ preferred, Σ ceilings, and each partial-fill boundary in both
 * the drain order and the fill order.
 */
function breakpointCanvases(input: AllocatorInput): number[] {
  const sides = sidesOf(input.rails);
  const bounds = sides.map((side) => boundsOf(input.rails[side] as RailPolicy));
  const ranks = sides.map((side) => (input.rails[side] as RailPolicy).greedRank);
  const sum = (of: (b: (typeof bounds)[number]) => number): number =>
    bounds.reduce((running, b) => running + of(b), 0);

  const totals = new Set<number>([
    sum((b) => b.floor),
    sum((b) => b.preferred),
    sum((b) => b.ceiling),
  ]);
  // Drain order (least greedy first) and fill order (greediest first): each
  // rail's give / capacity, accumulated, is a boundary of the piecewise fill.
  const order = sides.map((_, i) => i);
  const drain = [...order].sort((a, b) => ranks[b] - ranks[a]);
  const fill = [...order].sort((a, b) => ranks[a] - ranks[b]);
  let running = sum((b) => b.preferred);
  for (const i of drain) {
    running -= bounds[i].preferred - bounds[i].floor;
    totals.add(running);
  }
  running = sum((b) => b.preferred);
  for (const i of fill) {
    running += bounds[i].ceiling - bounds[i].preferred;
    totals.add(running);
  }

  const reference = 2000;
  const solved = solveSidebarWidths({ ...input, canvasWidth: reference });
  if (solved === null) return [];
  // `solved = canvas − gap·(R+2) − B*`, so the canvas wanting total `T` is
  // `T + (reference − solved)`.
  const offset = reference - solved;
  const canvases: number[] = [];
  for (const total of totals) {
    for (const delta of [-1, 0, 1]) canvases.push(total + offset + delta);
  }
  return canvases;
}

/** The coarse sweep every configuration is also checked across. */
const SWEEP: readonly number[] = Array.from(
  { length: 32 },
  (_, i) => 700 + i * 100,
);

/* ---------------------------------------------------------------------------
 * The invariants (List L02)
 * ---------------------------------------------------------------------------*/

/**
 * The chain the allocator scores: EVERY slot the kind defines, the widest pane
 * standing at it or the vacancy's extent where none does.
 *
 * Written out here rather than imported, because an oracle that shared the
 * production helper would agree with it by construction and check nothing.
 * The rule it restates is `chainOf`'s: an empty slot holds its share of the
 * band, so it is a member of the chain like any other.
 */
function filledChain(
  input: AllocatorInput,
): readonly { slot: number; width: number }[] {
  const widest = new Map<number, number>();
  for (const entry of input.occupied) {
    const held = widest.get(entry.slot);
    if (held === undefined || entry.width > held) widest.set(entry.slot, entry.width);
  }
  const vacancy =
    input.emptyExtent ?? Math.max(0, ...[...widest.values()], 0);
  const chain: { slot: number; width: number }[] = [];
  for (let slot = 0; slot < slotCount(input.kind); slot += 1) {
    const width = widest.get(slot) ?? vacancy;
    if (width > 0) chain.push({ slot, width });
  }
  return chain;
}

/** Whether the chain admits an EXACT tiling at the fitted band — every seam
 *  lands on the gap in the linear model, and no card is wider than the band,
 *  so `imposeRect`'s travel clamp does not part company with that model. */
function chainTilesExactly(input: AllocatorInput, widths: RailWidths): boolean {
  const chain = filledChain(input);
  if (chain.length < 2) return false;
  const railTotal = (widths.left ?? 0) + (widths.right ?? 0);
  const railCount = sidesOf(input.rails).length;
  const band = input.canvasWidth - railTotal - GAP * (railCount + 2);
  const count = slotCount(input.kind);
  for (const entry of chain) if (entry.width > band) return false;
  for (let j = 0; j < chain.length - 1; j += 1) {
    const near = chain[j];
    const far = chain[j + 1];
    const fNear = travelFraction({ slot: near.slot, count });
    const fFar = travelFraction({ slot: far.slot, count });
    const seam =
      (fFar - fNear) * band + fNear * near.width - fFar * far.width - near.width;
    if (Math.abs(seam - GAP) > 1.5) return false;
  }
  return true;
}

/**
 * Which regime the answer came out of — the unit the per-regime monotonicity
 * invariant runs within ([P16]).
 *
 * The branch half is whether the rails stand under their comfort measure:
 * `hard` when the answer's total is below Σ comfortFloor, `comfort` when it is
 * not. There is no third branch, because there are no longer two domains — the
 * scan runs the rails' whole legal range and comfort is a term inside the key.
 *
 * The second half is whether the answer sits ON the range's low end or above
 * it. Both halves are boundaries the design deliberately has: the branch flips
 * at the canvas where the picture stops paying for the measure, and the pin
 * releases when moving the total stops being able to improve the picture at
 * all — at which point the last term of the key takes over and the rails go
 * back to the widths their owner chose. Neither is a continuous move, and
 * neither can be.
 */
type ComfortBranch = "comfort" | "hard";
type Regime = `${ComfortBranch}:${"pinned" | "free"}`;

/** Assert every invariant at one point of the space. */
function assertInvariants(
  input: AllocatorInput,
  fixture: RailFixture,
  where: string,
): { answer: RailWidths; regime: Regime } {
  const sides = sidesOf(input.rails);
  const widths = allocateSidebarWidths(input);

  // 1 — totality.
  expect(widths, `${where}: a standing rail is always answered for`).not.toBeNull();
  const answer = widths as RailWidths;

  for (const side of sides) {
    const policy = input.rails[side] as RailPolicy;
    const bounds = boundsOf(policy);
    const width = answer[side];
    expect(typeof width, `${where}: ${side} is answered`).toBe("number");

    // 2 — bounds.
    expect(width as number).toBeGreaterThanOrEqual(bounds.floor);
    expect(width as number).toBeLessThanOrEqual(bounds.ceiling);

    // 6 — a stacked rail clears every member's floor.
    for (const floor of fixture.memberFloors[side] ?? []) {
      expect(width as number).toBeGreaterThanOrEqual(floor);
    }
  }

  // 3 — greed soundness, both directions.
  for (const near of sides) {
    for (const far of sides) {
      const greedy = input.rails[near] as RailPolicy;
      const modest = input.rails[far] as RailPolicy;
      if (greedy.greedRank >= modest.greedRank) continue;
      const greedyBounds = boundsOf(greedy);
      const modestBounds = boundsOf(modest);
      const greedyWidth = answer[near] as number;
      const modestWidth = answer[far] as number;
      if (modestWidth > modestBounds.preferred) {
        expect(
          greedyWidth,
          `${where}: ${far} grew past its preference, so ${near} must be at its ceiling`,
        ).toBe(greedyBounds.ceiling);
      }
      if (greedyWidth < greedyBounds.preferred) {
        expect(
          modestWidth,
          `${where}: ${near} gave width, so ${far} must be at its floor`,
        ).toBe(modestBounds.floor);
      }
    }
  }

  // 4 — tiling: when the target is reachable and the chain admits an exact
  // fit, the answer produces one. The allowance is the rounding residual the
  // solver deliberately leaves with the band's travel.
  const bounds = sides.map((side) => boundsOf(input.rails[side] as RailPolicy));
  const floorTotal = bounds.reduce((sum, b) => sum + b.floor, 0);
  const ceilingTotal = bounds.reduce((sum, b) => sum + b.ceiling, 0);
  const solved = solveSidebarWidths(input);
  const picture = seamPicture(input, answer);
  if (
    solved !== null &&
    solved >= floorTotal &&
    solved <= ceilingTotal &&
    chainTilesExactly(input, answer)
  ) {
    const allowance = 2 + sides.length;
    expect(picture.worstError, `${where}: a reachable exact fit tiles`).toBeLessThanOrEqual(
      allowance,
    );
    expect(picture.worstOverlap).toBeLessThanOrEqual(allowance);
  }

  // ---- The crowded-regime invariants (List L03) ----
  //
  // These are stated against what was ACHIEVABLE, never against what the
  // algorithm attempted. Phase 1's tiling invariant was guarded by its own
  // solver's success condition, so every failing configuration was excluded by
  // construction and 1.46M assertions proved nothing about the failure the
  // user saw on sight.
  //
  // THE ORACLE IS TWO EVALUATIONS, NOT A SCAN — and it is a SUFFICIENT
  // WITNESS, not a complete one.
  //
  // A seam is usually non-increasing in the rails' total (a bigger total is a
  // smaller band), which would put the minimum overlap at the domain's low end
  // and make one evaluation there the whole answer. `imposeRect`'s travel
  // clamp can REVERSE that, though, not merely flatten it: on three-up with a
  // 675 card in slot 1 and a 1230 card in slot 2 at canvas 1300, a 400px rail
  // occludes by 780 and a 675px rail by 675, because shrinking the band drains
  // the near card's travel to zero faster than it moves the far card in.
  //
  // So these read "a total at the domain's low end removes the overlap" rather
  // than "some total does". A witness there is proof the answer was reachable;
  // no witness there proves nothing either way. That keeps the assertions
  // SOUND (they can never fail on an answer that was in fact the best
  // available) and cheap enough to run at every point of the enumeration —
  // and they have teeth regardless, because they are exactly what the landed
  // Phase 1 solver failed.
  const comfortTotal = bounds.reduce((sum, b) => sum + b.comfortFloor, 0);
  const atHardFloor = pictureAt(input, floorTotal);
  const atComfortFloor = pictureAt(input, comfortTotal);
  const branch: ComfortBranch =
    sides.reduce((sum, side) => sum + (answer[side] as number), 0) <
    comfortTotal
      ? "hard"
      : "comfort";

  // 1 — no avoidable overlap.
  if (atHardFloor.worstOverlap === 0) {
    expect(
      picture.worstOverlap,
      `${where}: a total in reach removes the overlap, so the answer must`,
    ).toBe(0);
  }

  // 2 — no avoidable crowding, over the WHOLE REACHABLE RANGE. If any total
  // down to the hard floors puts every seam at or over the gap, the answer is
  // one of those.
  //
  // This was once scoped to the comfort domain, on the argument that a cramped
  // seam is not occlusion and comfort is spent only on occlusion. That
  // argument is wrong, and scoping the assertion to fit it hid a real defect
  // for a whole phase: on a three-up deck of slim cards the tiling total can
  // land a few pixels UNDER the comfort floors, and an overlap-only rule then
  // pinned the rails at comfort and painted every interior seam at 2px for want
  // of six pixels of rail. Cramped rhythm IS the chain failing to read as
  // arranged — the symptom this phase was opened to fix — and the reachable
  // range is what "avoidable" has to mean, or the invariant only ever asks the
  // solver to justify itself where it already agrees with itself.
  //
  // The allowance is the rounding residual the solver deliberately leaves with
  // the band's travel — at most one pixel per rail, and a pixel of seam slack
  // is invisible where a cramped chain is not.
  if (atHardFloor.worstOverlap === 0 && atHardFloor.worstShortfall === 0) {
    expect(
      picture.worstShortfall,
      `${where}: an uncramped total is in reach, so the answer must not cramp`,
    ).toBeLessThanOrEqual(sides.length);
  }

  // 3 — comfort is spent for a reason, and spent BY THE PIXEL.
  //
  //  a) The rails stand below their comfort measure only when the range down
  //     there reaches a strictly better picture than the whole comfort domain
  //     can. This used to read "a better TIER", and that is the rule the
  //     content-first key replaced: a lap closing from 126px to 70px is a
  //     better picture and not a better tier, and it is exactly the repair a
  //     deck too small for its cards wants.
  //  b) It is not spent one pixel further than that buys. Standing wider must
  //     never read better — so a rail can never be drained for raggedness or
  //     for nothing.
  //
  // Both halves are answered by SCANNING, not by evaluating the floors: the
  // travel clamp in `imposeRect` pins a card that has run out of room, which
  // flattens the picture's dependence on the band and, with unequal card
  // widths, can locally reverse it. A widest-band-is-best shortcut would be
  // right almost always, and the scan costs nothing here because it runs only
  // where a rail actually came out under its measure.
  const pictureKey = (p: {
    worstOverlap: number;
    worstShortfall: number;
  }): readonly number[] => [p.worstOverlap, p.worstShortfall];
  const better = (a: readonly number[], b: readonly number[]): boolean => {
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return a[i] < b[i];
    }
    return false;
  };
  /** The best picture any total in `[lo, hi]` paints; `null` when empty. */
  const bestPicture = (lo: number, hi: number): readonly number[] | null => {
    if (hi < lo) return null;
    let best = pictureKey(pictureAt(input, lo));
    for (let t = lo + 1; t <= hi; t += 1) {
      const candidate = pictureKey(pictureAt(input, t));
      if (better(candidate, best)) best = candidate;
    }
    return best;
  };
  const chosenTotal = sides.reduce(
    (sum, side) => sum + (answer[side] as number),
    0,
  );
  if (sides.some((side) => {
    const { comfortFloor } = boundsOf(input.rails[side] as RailPolicy);
    return (answer[side] as number) < comfortFloor;
  })) {
    const below = bestPicture(floorTotal, comfortTotal - 1);
    const within = bestPicture(comfortTotal, ceilingTotal);
    expect(
      below !== null && (within === null || better(below, within)),
      `${where}: comfort was given up, so giving it up must have bought a better picture`,
    ).toBe(true);
    // The rounding residual the solver leaves with the band's travel is at
    // most a pixel per rail, so a pixel wider is allowed to read the same.
    expect(
      better(
        pictureKey(pictureAt(input, chosenTotal + sides.length + 1)),
        pictureKey(pictureAt(input, chosenTotal)),
      ),
      `${where}: comfort was given up further than the picture paid for`,
    ).toBe(false);
  }

  // 7 (List L03) — comfort never re-inflates a drag. The comfort floor sits at
  // or below the rail's own preference, so the comfort domain can never begin
  // above the total the user chose: a rail dragged narrower than its comfort
  // measure is never grown back toward it.
  //
  // Stated structurally, on the floor rather than on the answer, because the
  // answer may legitimately exceed a preference for a reason that has nothing
  // to do with comfort — a surplus feeds a rail past what it wants when the
  // picture wants the width, which is the greed order working. What must never
  // happen is COMFORT doing the pushing.
  for (const side of sides) {
    const railBounds = boundsOf(input.rails[side] as RailPolicy);
    expect(
      railBounds.comfortFloor,
      `${where}: ${side}'s comfort floor must not outrank its own preference`,
    ).toBeLessThanOrEqual(railBounds.preferred);
  }

  // 7 (List L02) — tie fairness: equal ranks with equal bounds get equal widths.
  if (sides.length === 2) {
    const left = input.rails.left as RailPolicy;
    const right = input.rails.right as RailPolicy;
    const leftBounds = boundsOf(left);
    const rightBounds = boundsOf(right);
    if (
      left.greedRank === right.greedRank &&
      leftBounds.floor === rightBounds.floor &&
      leftBounds.ceiling === rightBounds.ceiling &&
      leftBounds.preferred === rightBounds.preferred
    ) {
      expect(
        Math.abs((answer.left as number) - (answer.right as number)),
        `${where}: tied rails with equal bounds split evenly`,
      ).toBeLessThanOrEqual(1);
    }
  }

  const domainLow = branch === "hard" ? floorTotal : comfortTotal;
  const answerTotal = sides.reduce((sum, side) => sum + (answer[side] as number), 0);
  return {
    answer,
    // The rounding residual the solver leaves with the band's travel is at most
    // one pixel per rail, so "on the low end" is read to that tolerance.
    regime: `${branch}:${
      Math.abs(answerTotal - domainLow) <= sides.length ? "pinned" : "free"
    }`,
  };
}

/* ---------------------------------------------------------------------------
 * The sweep
 * ---------------------------------------------------------------------------*/

describe("the allocator's solution space", () => {
  test("every invariant holds at every point of the enumeration", () => {
    const started = performance.now();
    let points = 0;
    for (const kind of IMPOSITION_KINDS) {
      for (const occupancy of occupanciesFor(kind)) {
        for (const fixture of RAIL_FIXTURES) {
          const base: AllocatorInput = {
            canvasWidth: 0,
            kind,
            layout: "fit",
            occupied: occupancy.occupied,
            rails: fixture.rails,
            maxRailWidth: CEILING,
          };
          const canvases = [
            ...new Set([
              ...SWEEP,
              ...breakpointCanvases({ ...base, canvasWidth: 2000 }),
            ]),
          ]
            .filter((canvas) => canvas > 0)
            .sort((a, b) => a - b);

          let previous: RailWidths = {};
          let previousRegime: Regime | null = null;
          for (const canvasWidth of canvases) {
            const where = `${kind}/${occupancy.name}/${fixture.name}@${canvasWidth}`;
            const { answer, regime } = assertInvariants(
              { ...base, canvasWidth },
              fixture,
              where,
            );
            // 5 — monotonicity in canvas width, per rail, PER REGIME. The
            // comfort rule is a binary spend, and a binary spend has a
            // boundary: at the first canvas where a zero-overlap total becomes
            // reachable the rails jump — that is the solve made visible, and
            // an assertion that forbade it would be asserting the bug back in.
            // So the run resets whenever the branch changes, and nothing is
            // asserted across the crossing itself.
            if (regime !== previousRegime) {
              previous = {};
              previousRegime = regime;
            }
            for (const side of sidesOf(fixture.rails)) {
              const was = previous[side];
              if (was !== undefined) {
                expect(
                  answer[side] as number,
                  `${where}: ${side} never narrows as the canvas grows within one ${regime} run`,
                ).toBeGreaterThanOrEqual(was);
              }
              previous[side] = answer[side];
            }
            points += 1;
          }
        }
      }
    }
    // The enumeration is the assertion; this pins that it actually ran the
    // space rather than an empty loop.
    expect(points).toBeGreaterThan(50_000);

    // The solver runs on every settled resize, and the sweep that chooses its
    // total is the one part of it that could get expensive. This is an
    // order-of-magnitude guard, not a benchmark — it sits far enough above
    // the ~13s this takes to be immune to a busy machine and still catch a
    // search that grew a factor of ten. One allocate is 0.1ms at its worst,
    // which is what buys the exhaustive sweep; what this guards is that the
    // sweep stays over the rails' range and does not acquire a second one.
    expect(performance.now() - started).toBeLessThan(45_000);
  }, 60_000);

  test("the scan finds what a 1px exhaustive search finds", () => {
    // The solver's sweep is exhaustive, so this is a check that its KEY is the
    // one written down rather than a check on its resolution: on a
    // representative subset, the total the solver chose scores exactly as well
    // as the best total an independently written 1px sweep of the same range
    // can find. It caught the search that this replaced — a 16px stride that
    // stepped over a valley 268px from where it settled. Scores, not totals —
    // two totals that paint the
    // same picture and sit the same distance from the user's widths are the
    // same answer, and the tie-break between them is arbitrary by design.
    let compared = 0;
    for (const kind of IMPOSITION_KINDS) {
      for (const occupancy of occupanciesFor(kind)) {
        for (const fixture of RAIL_FIXTURES) {
          for (const canvasWidth of [1400, 2200, 3000, 3800]) {
            const input: AllocatorInput = {
              canvasWidth,
              kind,
              layout: "fit",
              occupied: occupancy.occupied,
              rails: fixture.rails,
              maxRailWidth: CEILING,
            };
            const sides = sidesOf(fixture.rails);
            const bounds = sides.map((side) =>
              boundsOf(input.rails[side] as RailPolicy),
            );
            const floorTotal = bounds.reduce((sum, b) => sum + b.floor, 0);
            const comfortTotal = bounds.reduce((sum, b) => sum + b.comfortFloor, 0);
            const ceilingTotal = bounds.reduce((sum, b) => sum + b.ceiling, 0);
            const preferredTotal = bounds.reduce((sum, b) => sum + b.preferred, 0);
            const answer = allocateSidebarWidths(input) as RailWidths;
            const chosen = sides.reduce(
              (sum, side) => sum + (answer[side] as number),
              0,
            );

            // There is ONE domain — every width the rails may legally stand
            // at — and one key over it, so the cross-check is a plain 1px
            // sweep of `[Σ floor, Σ ceiling]`. Comfort is a TERM in that key
            // rather than a boundary in front of it, and it sits where the
            // solver puts it: under the two picture readings the content
            // cards own, over the raggedness that is a matter of degree.
            const domainLow = floorTotal;
            const key = (total: number): readonly number[] => {
              const p = pictureAt(input, total);
              return [
                p.worstOverlap,
                p.worstShortfall,
                Math.max(0, comfortTotal - total),
                p.worstError,
                Math.abs(total - preferredTotal),
              ];
            };
            let best = key(domainLow);
            for (let t = domainLow + 1; t <= ceilingTotal; t += 1) {
              const candidate = key(t);
              for (let i = 0; i < candidate.length; i += 1) {
                if (candidate[i] === best[i]) continue;
                if (candidate[i] < best[i]) best = candidate;
                break;
              }
            }
            const scored = key(chosen);
            const where = `${kind}/${occupancy.name}/${fixture.name}@${canvasWidth}`;
            // The rounding residual the solver leaves with the band's travel
            // costs at most one pixel per rail on each picture reading.
            for (let i = 0; i < 4; i += 1) {
              expect(
                scored[i],
                `${where}: the scan's answer is no worse than exhaustive on term ${i}`,
              ).toBeLessThanOrEqual(best[i] + sides.length);
            }
            compared += 1;
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(1_000);
  }, 60_000);

  test("the flow scan finds what a 1px exhaustive search finds", () => {
    // The fit cross-check above, run against flow's own objective. Flow scores
    // one picture term rather than three — whether the candidate bought a
    // boundary within budget — then comfort, then the same
    // distance-from-preferred tiebreak, so the same exhaustive sweep has to be
    // shown to find the same answer here too.
    let compared = 0;
    let repaired = 0;
    for (const kind of IMPOSITION_KINDS) {
      for (const occupancy of occupanciesFor(kind)) {
        for (const fixture of RAIL_FIXTURES) {
          for (const canvasWidth of [1400, 2200, 3000, 3800]) {
            const input: AllocatorInput = {
              canvasWidth,
              kind,
              layout: "flow",
              occupied: occupancy.occupied,
              rails: fixture.rails,
              maxRailWidth: CEILING,
            };
            const sides = sidesOf(fixture.rails);
            const bounds = sides.map((side) =>
              boundsOf(input.rails[side] as RailPolicy),
            );
            const floorTotal = bounds.reduce((sum, b) => sum + b.floor, 0);
            const comfortTotal = bounds.reduce(
              (sum, b) => sum + b.comfortFloor,
              0,
            );
            const ceilingTotal = bounds.reduce((sum, b) => sum + b.ceiling, 0);
            const preferredTotal = bounds.reduce((sum, b) => sum + b.preferred, 0);
            const answer = allocateSidebarWidths(input) as RailWidths;
            const chosen = sides.reduce(
              (sum, side) => sum + (answer[side] as number),
              0,
            );

            const sliverAt = (total: number): number =>
              stripPicture(input, spread(total, sides)).worstSliver;
            // The key as written down: a boundary bought within budget reads
            // 0, everything else reads the cut the deck keeps at Σ preferred,
            // then comfort, then distance. Written independently of the
            // solver's own, over the whole legal range.
            const unpaid = sliverAt(preferredTotal);
            const key = (total: number): readonly number[] => [
              Math.abs(total - preferredTotal) <= RAIL_BOUNDARY_BUDGET_PX &&
              sliverAt(total) === 0
                ? 0
                : unpaid,
              Math.max(0, comfortTotal - total),
              Math.abs(total - preferredTotal),
            ];
            let best = key(floorTotal);
            for (let t = floorTotal + 1; t <= ceilingTotal; t += 1) {
              const candidate = key(t);
              for (let i = 0; i < candidate.length; i += 1) {
                if (candidate[i] === best[i]) continue;
                if (candidate[i] < best[i]) best = candidate;
                break;
              }
            }
            const scored = key(chosen);
            const where = `${kind}/${occupancy.name}/${fixture.name}@${canvasWidth}`;
            // The first term is a decision, not a measure, so no rounding
            // allowance applies to it: the solver either bought the boundary
            // the exhaustive sweep found or it did not. The rounding residual
            // the solver leaves with the band's travel — at most a pixel per
            // rail — can only move a boundary total by that much, and a paid
            // boundary is read at the widths actually answered.
            expect(
              scored[0] === 0 || best[0] !== 0,
              `${where}: the exhaustive sweep bought a boundary (cut ${unpaid} at preferred) and the solver did not`,
            ).toBe(true);
            if (best[0] === 0 && unpaid > 0) repaired += 1;
            compared += 1;
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(1_000);
    // The premise: on thousands of these points a cut deck HAD a boundary
    // within budget, so the assertion above is doing work rather than agreeing
    // that nothing can be fixed anywhere. Roughly a fifth of the space at the
    // starting budget; a fixed count rather than a share so a retune of the
    // budget reads here as a number moving, not as a premise failing.
    expect(repaired).toBeGreaterThan(2_000);
  }, 60_000);

  test("flow ends on a boundary it could afford, and otherwise leaves the rails alone", () => {
    // The claim the whole objective rests on, stated directly over the
    // enumeration: wherever some total within budget of Σ preferred — and
    // inside the rails' legal range — lands the band on a slot boundary, the
    // answer lands there too. And wherever none does, the rails stand at the
    // widths the user chose: a cut the budget will not pay for is left as it
    // is, never moved to make it look like something else.
    let checked = 0;
    let declined = 0;
    for (const kind of IMPOSITION_KINDS) {
      for (const occupancy of occupanciesFor(kind)) {
        for (const fixture of RAIL_FIXTURES) {
          for (const canvasWidth of [1600, 2400, 3200]) {
            const input: AllocatorInput = {
              canvasWidth,
              kind,
              layout: "flow",
              occupied: occupancy.occupied,
              rails: fixture.rails,
              maxRailWidth: CEILING,
            };
            const sides = sidesOf(fixture.rails);
            const bounds = sides.map((side) =>
              boundsOf(input.rails[side] as RailPolicy),
            );
            const floorTotal = bounds.reduce((sum, b) => sum + b.floor, 0);
            const ceilingTotal = bounds.reduce((sum, b) => sum + b.ceiling, 0);
            const preferredTotal = bounds.reduce((sum, b) => sum + b.preferred, 0);
            const lo = Math.max(floorTotal, preferredTotal - RAIL_BOUNDARY_BUDGET_PX);
            const hi = Math.min(ceilingTotal, preferredTotal + RAIL_BOUNDARY_BUDGET_PX);
            let affordable = false;
            for (let t = lo; t <= hi && !affordable; t += 1) {
              if (stripPicture(input, spread(t, sides)).worstSliver === 0) {
                affordable = true;
              }
            }
            const answer = allocateSidebarWidths(input) as RailWidths;
            const where = `${kind}/${occupancy.name}/${fixture.name}@${canvasWidth}`;
            const cut = stripPicture(input, answer).worstSliver;
            const chosen = sides.reduce(
              (sum, side) => sum + (answer[side] as number),
              0,
            );
            if (affordable) {
              expect(
                cut,
                `${where}: a boundary was within budget, so nothing is left cut to ${cut}px`,
              ).toBe(0);
              checked += 1;
            } else {
              // The rounding residual the solver leaves with the band's travel
              // is at most a pixel per rail.
              expect(
                Math.abs(chosen - preferredTotal),
                `${where}: no boundary within budget, so the rails stay at Σ preferred`,
              ).toBeLessThanOrEqual(sides.length);
              declined += 1;
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(500);
    expect(declined).toBeGreaterThan(50);
  });

  test("no rail standing is the only shape with no answer", () => {
    for (const kind of IMPOSITION_KINDS) {
      for (const occupancy of occupanciesFor(kind).slice(0, 4)) {
        expect(
          allocateSidebarWidths({
            canvasWidth: 1600,
            kind,
            occupied: occupancy.occupied,
            rails: {},
            maxRailWidth: CEILING,
          }),
        ).toBeNull();
      }
    }
  });
});

/* ---------------------------------------------------------------------------
 * The golden table
 * ---------------------------------------------------------------------------*/

const GOLDEN_PATH = join(import.meta.dir, "golden", "imposer-solutions.json");
const FLOW_GOLDEN_PATH = join(
  import.meta.dir,
  "golden",
  "imposer-solutions-flow.json",
);

interface GoldenRow {
  config: string;
  canvas: number;
  left: number | null;
  right: number | null;
}

/** The representative slice: every rail fixture × every kind, at one
 *  occupancy each (all slots, comfy — the shape a full deck actually stands
 *  in), across that configuration's own breakpoints. */
function goldenRows(): GoldenRow[] {
  const rows: GoldenRow[] = [];
  for (const kind of IMPOSITION_KINDS) {
    const slots = slotCount(kind);
    const occupied = Array.from({ length: slots }, (_, slot) => ({
      slot,
      width: CONTENT_WIDTH_COMFY_PX,
    }));
    for (const fixture of RAIL_FIXTURES) {
      const base: AllocatorInput = {
        canvasWidth: 2000,
        kind,
        layout: "fit",
        occupied,
        rails: fixture.rails,
        maxRailWidth: CEILING,
      };
      const canvases = [...new Set(breakpointCanvases(base))]
        .filter((canvas) => canvas > 0)
        .sort((a, b) => a - b);
      for (const canvas of canvases.length > 0 ? canvases : [2000]) {
        const answer = allocateSidebarWidths({ ...base, canvasWidth: canvas });
        rows.push({
          config: `${kind}/${fixture.name}`,
          canvas,
          left: answer?.left ?? null,
          right: answer?.right ?? null,
        });
      }
    }
  }
  return rows.sort((a, b) =>
    a.config === b.config
      ? a.canvas - b.canvas
      : a.config < b.config
        ? -1
        : 1,
  );
}

/**
 * The same slice in flow, with the picture each answer paints carried beside
 * it. `sliver` is the point of the table: a retune that moved a rail by a pixel
 * and a retune that stopped repairing a cut look identical in the widths alone,
 * and are not remotely the same change.
 *
 * A SEPARATE file from the fit table on purpose. The two modes now answer
 * different questions, and a shared table would make a flow-only change churn
 * the fit rows' diff — which is exactly the drift-reading this net exists to
 * keep legible.
 */
function flowGoldenRows(): (GoldenRow & { sliver: number })[] {
  const rows: (GoldenRow & { sliver: number })[] = [];
  for (const kind of IMPOSITION_KINDS) {
    const slots = slotCount(kind);
    const occupied = Array.from({ length: slots }, (_, slot) => ({
      slot,
      width: CONTENT_WIDTH_COMFY_PX,
    }));
    for (const fixture of RAIL_FIXTURES) {
      const base: AllocatorInput = {
        canvasWidth: 2000,
        kind,
        layout: "flow",
        occupied,
        rails: fixture.rails,
        maxRailWidth: CEILING,
      };
      for (const canvas of [1400, 1800, 2200, 2600, 3000, 3400]) {
        const input = { ...base, canvasWidth: canvas };
        const answer = allocateSidebarWidths(input);
        rows.push({
          config: `${kind}/${fixture.name}`,
          canvas,
          left: answer?.left ?? null,
          right: answer?.right ?? null,
          sliver:
            answer === null ? -1 : stripPicture(input, answer).worstSliver,
        });
      }
    }
  }
  return rows.sort((a, b) =>
    a.config === b.config
      ? a.canvas - b.canvas
      : a.config < b.config
        ? -1
        : 1,
  );
}

describe("the golden table", () => {
  test("the checked-in table is what the solver produces", () => {
    const rows = goldenRows();
    const serialized = `${JSON.stringify(rows, null, 2)}\n`;
    if (process.env.IMPOSER_GOLDEN_UPDATE === "1") {
      writeFileSync(GOLDEN_PATH, serialized);
    }
    const golden = readFileSync(GOLDEN_PATH, "utf8");
    expect(
      serialized,
      "the solver's answers moved — review the diff, then regenerate with IMPOSER_GOLDEN_UPDATE=1",
    ).toBe(golden);
  });

  test("the checked-in flow table is what the solver produces", () => {
    const serialized = `${JSON.stringify(flowGoldenRows(), null, 2)}\n`;
    if (process.env.IMPOSER_GOLDEN_UPDATE === "1") {
      writeFileSync(FLOW_GOLDEN_PATH, serialized);
    }
    const golden = readFileSync(FLOW_GOLDEN_PATH, "utf8");
    expect(
      serialized,
      "flow's answers moved — review the diff, then regenerate with IMPOSER_GOLDEN_UPDATE=1",
    ).toBe(golden);
  });
});
