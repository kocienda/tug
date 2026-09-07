import { describe, expect, test } from "bun:test";

import {
  IMPOSITION_GAP_BOTTOM_MAKER_PX,
  IMPOSITION_GAP_BOTTOM_PROPERTY,
  impositionGapBottomPx,
  setImpositionGapBottom,
  IMPOSITION_GAP_PX,
  IMPOSITION_KINDS,
  RAIL_EDGE_INSET_PX,
  RAIL_EDGE_INSET_PROPERTY,
  RAIL_GUTTER_PX,
  RAIL_GUTTER_PROPERTY,
  railGapBottomPx,
  railSpanInset,
  railSpanInsetPx,
  clampSlot,
  allocateSidebarWidths,
  solveSidebarWidths,
  effectiveRailOrder,
  railModeOf,
  isRailMode,
  railSeamFractions,
  railSeamProperty,
  railSharesFromFractions,
  withRailMode,
  withRailOrder,
  withRailShares,
  withoutRailShares,
  seamPicture,
  imposeRect,
  imposeStyle,
  imposeSidebarStyle,
  railOffsetProperty,
  isImpositionKind,
  resolveContentWidthPx,
  resolvePlacement,
  resolveSpan,
  CONTENT_WIDTH_SLIM_PX,
  CONTENT_WIDTH_COMFY_PX,
  CONTENT_WIDTH_WIDE_PX,
  CONTENT_WIDTH_PRESETS,
  slotCount,
  travelFraction,
  type DeckImposition,
  type ImposerSpan,
  type ImposedPlacement,
  type ImpositionKind,
  type RailPolicy,
} from "@/lib/layout-imposer";

const GAP = IMPOSITION_GAP_PX;
/** How the emitted expressions spell the bottom gap: the property, with the
 *  maker depth as its fallback. Stated once here, as it is stated once in the
 *  imposer, so a build that keeps a different band changes neither. */
const GAP_BOTTOM = `var(${IMPOSITION_GAP_BOTTOM_PROPERTY}, ${IMPOSITION_GAP_BOTTOM_MAKER_PX}px)`;
/** How the emitted expressions spell the rail edge inset — the rail's
 *  stand-off from the window edge on its outer side and top — on the same
 *  pattern: the property, with the numeric twin as its fallback. */
const EDGE = `var(${RAIL_EDGE_INSET_PROPERTY}, ${RAIL_EDGE_INSET_PX}px)`;
/** How they spell the rail's bottom pin: the bottom gap less the card gap
 *  plus the edge inset — the strip's clearance in a maker build, and flush in
 *  a release one. */
const RAIL_BOTTOM = `calc(${GAP_BOTTOM} - ${GAP}px + ${EDGE})`;
/** What one standing rail costs the canvas besides its width: its edge inset
 *  and its gutter, which are the rail's own lengths rather than the card gap.
 *  A one-rail canvas is `rail + RAIL_AIR + GAP + band` (the band keeps one
 *  gap at its far end); a two-rail canvas is `rails + 2·RAIL_AIR + band`. */
const RAIL_AIR = RAIL_EDGE_INSET_PX + RAIL_GUTTER_PX;

/**
 * A rail policy with no comfort band above its hard floor — `comfortWidth`
 * defaults to `minWidth`, which is what every card that registers no comfort
 * width resolves to, and which makes the allocator's comfort tier empty for
 * that rail. Cases that care about the two-tier drain pass their own
 * `comfortWidth`.
 */
const rail = (policy: {
  preferredWidth: number;
  minWidth: number;
  greedRank: number;
  comfortWidth?: number;
}): RailPolicy => ({
  ...policy,
  comfortWidth: policy.comfortWidth ?? policy.minWidth,
});

/** The rank a rail takes when nothing has ranked it — the registry's
 *  `DEFAULT_GREED_RANK`, spelled out here rather than imported, because the
 *  imposer is a pure module that knows nothing about the card registry and
 *  neither does its test. */
const UNRANKED = 9;

/** The allocator's one-rail reading: a single right-side rail, answered as a
 *  plain width. Greed rank is immaterial with one rail — nothing to order
 *  against — so it takes the registry's default. The ceiling defaults to slim
 *  (675), the one the deck passes whatever Card Width is set, because a
 *  sidebar is a reading surface. */
function allocateOneRail(input: {
  canvasWidth: number;
  kind: ImpositionKind;
  occupied: readonly { slot: number; width: number }[];
  preferredWidth: number;
  minWidth: number;
  comfortWidth?: number;
  greedRank?: number;
  maxRailWidth?: number;
}): number | null {
  const widths = allocateSidebarWidths({
    canvasWidth: input.canvasWidth,
    kind: input.kind,
    occupied: input.occupied,
    rails: {
      right: rail({
        preferredWidth: input.preferredWidth,
        minWidth: input.minWidth,
        comfortWidth: input.comfortWidth,
        greedRank: input.greedRank ?? UNRANKED,
      }),
    },
    maxRailWidth: input.maxRailWidth ?? CONTENT_WIDTH_SLIM_PX,
  });
  return widths?.right ?? null;
}

/** @see allocateOneRail */
function solveOneRail(input: {
  canvasWidth: number;
  kind: ImpositionKind;
  occupied: readonly { slot: number; width: number }[];
  preferredWidth: number;
  minWidth: number;
}): number | null {
  return solveSidebarWidths({
    canvasWidth: input.canvasWidth,
    kind: input.kind,
    occupied: input.occupied,
    rails: {
      right: rail({
        preferredWidth: input.preferredWidth,
        minWidth: input.minWidth,
        greedRank: UNRANKED,
      }),
    },
    maxRailWidth: CONTENT_WIDTH_SLIM_PX,
  });
}

/** A 1000×800 canvas with no rail — the simplest span to hand-compute against. */
const FULL: ImposerSpan = { x: 0, width: 1000, height: 800 };
/** The same canvas with a 260px rail holding the left. The inset is the
 *  rail's width plus its edge inset and gutter, less the gap the span keeps
 *  on its own — `railSpanInsetPx`. */
const RAIL_LEFT: ImposerSpan = {
  x: railSpanInsetPx(260),
  width: 1000 - railSpanInsetPx(260),
  height: 800,
};
/** The same canvas with a 260px rail holding the right. */
const RAIL_RIGHT: ImposerSpan = {
  x: 0,
  width: 1000 - railSpanInsetPx(260),
  height: 800,
};

/** Terse placement literal for the geometry cases. */
const at = (slot: number, count: number): ImposedPlacement => ({ slot, count });

describe("kinds", () => {
  test("slotCount matches the name", () => {
    expect(slotCount("one-up")).toBe(1);
    expect(slotCount("two-up")).toBe(2);
    expect(slotCount("three-up")).toBe(3);
    expect(slotCount("four-up")).toBe(4);
    expect(slotCount("five-up")).toBe(5);
    expect(slotCount("six-up")).toBe(6);
  });

  test("IMPOSITION_KINDS ascends by slot count", () => {
    expect(IMPOSITION_KINDS.map(slotCount)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("isImpositionKind narrows only the kinds offered", () => {
    for (const kind of IMPOSITION_KINDS) expect(isImpositionKind(kind)).toBe(true);
    for (const bogus of ["seven-up", "", "TWO-UP", null, undefined, 2, {}]) {
      expect(isImpositionKind(bogus)).toBe(false);
    }
  });
});

describe("gaps", () => {
  test("the horizontal gap is the one the drag snap holds", () => {
    expect(IMPOSITION_GAP_PX).toBe(5);
  });

  test("the rail's two lengths are named apart from the card gap", () => {
    // A pinned rail is a panel of the window: flush to the edge, and one
    // wider gutter from the first card than the card gap — the shape and the
    // air are what tell a rail from a card, and neither moves the deck's own
    // rhythm, which stays the card gap everywhere else.
    expect(RAIL_EDGE_INSET_PX).toBe(0);
    expect(RAIL_GUTTER_PX).toBe(12);
    expect(RAIL_GUTTER_PX).toBeGreaterThan(IMPOSITION_GAP_PX);
    expect(RAIL_EDGE_INSET_PROPERTY).toBe("--tug-rail-edge-inset");
    expect(RAIL_GUTTER_PROPERTY).toBe("--tug-rail-gutter");
  });

  test("a rail's span inset is its width plus its air, less the span's own gap", () => {
    expect(railSpanInsetPx(260)).toBe(
      RAIL_EDGE_INSET_PX + 260 + RAIL_GUTTER_PX - IMPOSITION_GAP_PX,
    );
    // The CSS twin states the same identity over the same names, with the
    // numeric twins as each property's fallback.
    expect(railSpanInset("var(--w)")).toBe(
      `calc(var(${RAIL_EDGE_INSET_PROPERTY}, ${RAIL_EDGE_INSET_PX}px) + var(--w)` +
        ` + var(${RAIL_GUTTER_PROPERTY}, ${RAIL_GUTTER_PX}px) - ${IMPOSITION_GAP_PX}px)`,
    );
  });

  test("a maker's bottom gap is deeper, and clears the dev-info strip", () => {
    // The strip sits 8px above the canvas bottom and stands about 19px tall.
    // The bottom gap has to clear that and still leave an ordinary gap of air.
    expect(IMPOSITION_GAP_BOTTOM_MAKER_PX).toBeGreaterThanOrEqual(8 + 19 + GAP);
    expect(IMPOSITION_GAP_BOTTOM_MAKER_PX).toBeGreaterThan(IMPOSITION_GAP_PX);
  });

  test("the maker depth is what an unsettled page imposes to", () => {
    expect(impositionGapBottomPx()).toBe(IMPOSITION_GAP_BOTTOM_MAKER_PX);
  });

  test("a release build keeps the same air at the foot as at the sides", () => {
    expect(setImpositionGapBottom(false)).toBe(true);
    expect(impositionGapBottomPx()).toBe(IMPOSITION_GAP_PX);
    // The rail runs flush to the foot where there is no strip to clear, and
    // keeps the strip's own clearance — no gap of air — where there is one.
    expect(railGapBottomPx()).toBe(RAIL_EDGE_INSET_PX);
    // Settling twice to the same answer is not a change, so it asks for no
    // re-imposition.
    expect(setImpositionGapBottom(false)).toBe(false);
    expect(setImpositionGapBottom(true)).toBe(true);
    expect(impositionGapBottomPx()).toBe(IMPOSITION_GAP_BOTTOM_MAKER_PX);
  });
});

describe("clampSlot", () => {
  test("clamps above the last slot", () => {
    expect(clampSlot("two-up", 3)).toBe(1);
    expect(clampSlot("three-up", 7)).toBe(2);
    expect(clampSlot("four-up", 4)).toBe(3);
    expect(clampSlot("six-up", 9)).toBe(5);
  });

  test("clamps below zero", () => {
    expect(clampSlot("three-up", -1)).toBe(0);
    expect(clampSlot("three-up", -1000)).toBe(0);
  });

  test("floors fractional slots and rejects non-finite ones", () => {
    expect(clampSlot("four-up", 2.9)).toBe(2);
    expect(clampSlot("four-up", Number.NaN)).toBe(0);
    expect(clampSlot("four-up", Number.POSITIVE_INFINITY)).toBe(0);
  });

  test("leaves in-range slots alone", () => {
    expect(clampSlot("four-up", 0)).toBe(0);
    expect(clampSlot("four-up", 2)).toBe(2);
  });
});

describe("resolveSpan", () => {
  const canvas = { width: 1000, height: 800 };

  test("no rail spans the whole canvas", () => {
    expect(resolveSpan(canvas, [])).toEqual(FULL);
  });

  test("a left-side rail insets the span's origin by its span inset", () => {
    expect(resolveSpan(canvas, [{ side: "left", width: 260 }])).toEqual(RAIL_LEFT);
  });

  test("a right-side rail insets the span's width only", () => {
    expect(resolveSpan(canvas, [{ side: "right", width: 260 }])).toEqual(RAIL_RIGHT);
  });

  test("rails on both sides inset the band from both", () => {
    expect(
      resolveSpan(canvas, [
        { side: "left", width: 260 },
        { side: "right", width: 300 },
      ]),
    ).toEqual({
      x: railSpanInsetPx(260),
      width: 1000 - railSpanInsetPx(260) - railSpanInsetPx(300),
      height: 800,
    });
  });

  // The inset count is not a constant: it is one rail's air per STANDING
  // rail. This is the identity the allocator's band solve reads off rather
  // than writing its own, so a closed rail can never leave a phantom inset in
  // the arithmetic.
  test("each standing rail contributes exactly its own air", () => {
    const bandOf = (rails: Parameters<typeof resolveSpan>[1]): number =>
      resolveSpan(canvas, rails).width - GAP * 2;
    expect(bandOf([])).toBe(1000 - GAP * 2);
    expect(bandOf([{ side: "right", width: 260 }])).toBe(
      1000 - 260 - RAIL_AIR - GAP,
    );
    expect(
      bandOf([
        { side: "left", width: 260 },
        { side: "right", width: 300 },
      ]),
    ).toBe(1000 - 560 - RAIL_AIR * 2);
  });

  test("same-side cards share one rail, so a side is passed once", () => {
    // Two cards stacked on the right stand in ONE rail at one width — the
    // caller folds them, and passing the side twice would inset the band twice
    // for a picture with one edge in it.
    const stacked = resolveSpan(canvas, [{ side: "right", width: 300 }]);
    expect(stacked.width).toBe(1000 - railSpanInsetPx(300));
  });
});

describe("resolvePlacement", () => {
  test("the count is the kind's, whatever the deck holds", () => {
    expect(resolvePlacement("two-up", 0).count).toBe(2);
    expect(resolvePlacement("three-up", 0).count).toBe(3);
    expect(resolvePlacement("four-up", 0).count).toBe(4);
  });

  test("a placement is the slot and the count, and nothing about the rail", () => {
    expect(resolvePlacement("three-up", 1)).toEqual({ slot: 1, count: 3 });
  });

  test("an out-of-range slot clamps to the kind", () => {
    expect(resolvePlacement("two-up", 9).slot).toBe(1);
    expect(resolvePlacement("two-up", -4).slot).toBe(0);
    expect(resolvePlacement("four-up", 2.9).slot).toBe(2);
  });
});

describe("travelFraction", () => {
  test("slot 0 has travelled none of the band", () => {
    expect(travelFraction(at(0, 2))).toBe(0);
    expect(travelFraction(at(0, 4))).toBe(0);
  });

  test("the last slot has travelled all of it — that is why it meets the rail", () => {
    expect(travelFraction(at(1, 2))).toBe(1);
    expect(travelFraction(at(3, 4))).toBe(1);
  });

  test("one-up's single slot takes half the travel — the card centers", () => {
    expect(travelFraction(at(0, 1))).toBe(0.5);
    expect(resolvePlacement("one-up", 3)).toEqual({ slot: 0, count: 1 });
  });

  test("the slots in between space evenly", () => {
    expect(travelFraction(at(1, 3))).toBeCloseTo(0.5, 9);
    expect(travelFraction(at(1, 4))).toBeCloseTo(1 / 3, 9);
    expect(travelFraction(at(2, 4))).toBeCloseTo(2 / 3, 9);
  });
});

describe("imposeRect", () => {
  test("slot 0 sits a gap in from the span's near edge", () => {
    expect(imposeRect(at(0, 2), 400, FULL).position.x).toBe(GAP);
    expect(imposeRect(at(0, 4), 400, FULL).position.x).toBe(GAP);
  });

  test("the last slot's far edge lands a gap short of the band's", () => {
    for (const [count, width] of [[2, 400], [3, 300], [4, 220]] as const) {
      const r = imposeRect(at(count - 1, count), width, FULL);
      expect(r.position.x + r.size.width).toBe(FULL.width - GAP);
    }
  });

  test("a slot's place depends on the pane's own width and nothing else", () => {
    // The placement carries no reading of the deck at all — there is no input
    // here for a sibling opening, closing, or resizing to arrive through. This
    // is the property the whole model rests on: a slot is a place in the
    // arrangement, never a place in a queue.
    const slotOne = at(1, 2);
    expect(imposeRect(slotOne, 400, FULL).position.x).toBe(
      imposeRect(resolvePlacement("two-up", 1), 400, FULL).position.x,
    );
    // Two-up, 990 of band, a 400 card: 590 of travel.
    expect(imposeRect(slotOne, 400, FULL).position.x).toBe(GAP + 590);
  });

  test("one-up centers the card, with the slack split evenly", () => {
    // 990 of band, a 400 card: 590 of travel, half of it on each side.
    const r = imposeRect(resolvePlacement("one-up", 0), 400, FULL);
    expect(r.position.x).toBe(GAP + 295);
    expect(r.position.x - GAP).toBe(FULL.width - GAP - (r.position.x + r.size.width));
  });

  test("slots with room space evenly across the band", () => {
    const xs = [0, 1, 2].map(
      (k) => imposeRect(at(k, 3), 300, FULL).position.x,
    );
    expect(xs).toEqual([5, 350, 695]);
    // Equal air between neighbours, rather than pooled at one end.
    expect(xs[1] - (xs[0] + 300)).toBe(xs[2] - (xs[1] + 300));
  });

  test("a crowded band overlaps instead of running past it", () => {
    // Three 500s in a 990 band: 510 too many, shared over two intervals.
    const rects = [0, 1, 2].map((k) => imposeRect(at(k, 3), 500, FULL));
    expect(rects.map((r) => r.position.x)).toEqual([5, 250, 495]);
    const overlaps = [0, 1].map(
      (i) => rects[i].position.x + rects[i].size.width - rects[i + 1].position.x,
    );
    expect(overlaps).toEqual([255, 255]);
    for (const r of rects) expect(r.size.width).toBe(500);
    const last = rects[2];
    expect(last.position.x + last.size.width).toBe(FULL.width - GAP);
  });

  test("four-up shares the crowding three ways", () => {
    const rects = [0, 1, 2, 3].map((k) => imposeRect(at(k, 4), 500, FULL));
    const overlaps = [0, 1, 2].map(
      (i) => rects[i].position.x + rects[i].size.width - rects[i + 1].position.x,
    );
    // 990 of band, a 500 card: 490 of travel over three intervals.
    for (const o of overlaps) expect(o).toBeCloseTo(500 - 490 / 3, 9);
    const last = rects[3];
    expect(last.position.x + last.size.width).toBeCloseTo(FULL.width - GAP, 9);
  });

  // A kind is a slot COUNT and nothing else — one rule places all of them — so
  // an arrangement added to the picker needs no geometry of its own. This runs
  // over whatever the imposer currently offers, so the day a seven-up appears
  // it is held to the same two ends.
  test("every kind's chain runs the band end to end", () => {
    for (const kind of IMPOSITION_KINDS) {
      const n = slotCount(kind);
      // One-up is the documented exception: its single anchor has no ends to
      // space against, so it takes half the travel and stands centered.
      if (n === 1) continue;
      const width = (FULL.width - GAP * 2) / n;
      const rects = Array.from({ length: n }, (_, k) =>
        imposeRect(resolvePlacement(kind, k), width, FULL),
      );
      expect(rects[0].position.x).toBe(GAP);
      const last = rects[n - 1];
      expect(last.position.x + last.size.width).toBeCloseTo(FULL.width - GAP, 9);
    }
  });

  test("an overlapping arrangement never reaches under the rail", () => {
    const last = imposeRect(at(2, 3), 500, RAIL_RIGHT);
    const railNearEdge = RAIL_RIGHT.x + RAIL_RIGHT.width;
    expect(last.position.x + last.size.width).toBe(railNearEdge - GAP);
  });

  test("a left-side rail numbers left to right too — slot 0 is beside it", () => {
    const a = imposeRect(at(0, 2), 300, RAIL_LEFT);
    const b = imposeRect(at(1, 2), 300, RAIL_LEFT);
    // Slot 1 is the leftmost position on this deck, which is the one against
    // the rail. The rail's side moves the band, never the numbering.
    expect(a.position.x).toBe(RAIL_LEFT.x + GAP);
    // The last slot's right edge lands a gap short of the canvas's right.
    expect(b.position.x + b.size.width).toBe(995);
  });

  test("a right-docked rail leaves slot 0 exactly where a closed one does", () => {
    expect(imposeRect(at(0, 2), 300, RAIL_RIGHT).position.x).toBe(
      imposeRect(at(0, 2), 300, FULL).position.x,
    );
  });

  test("a card wider than the band has no travel, so every slot is the far edge", () => {
    for (const k of [0, 1]) {
      const rect = imposeRect(at(k, 2), 1400, FULL);
      expect(rect.position.x).toBe(GAP);
      expect(rect.size.width).toBe(1400);
    }
  });

  test("the run is the span height less the top gap and the deeper bottom", () => {
    const rect = imposeRect(at(0, 2), 321, RAIL_LEFT);
    expect(rect.position.y).toBe(IMPOSITION_GAP_PX);
    expect(rect.size.height).toBe(
      RAIL_LEFT.height - IMPOSITION_GAP_PX - impositionGapBottomPx(),
    );
  });

  test("width is a pass-through for every span", () => {
    for (const span of [FULL, RAIL_LEFT, RAIL_RIGHT]) {
      for (const w of [1, 120, 640, 4000]) {
        expect(imposeRect(at(0, 2), w, span).size.width).toBe(w);
      }
    }
  });
});

describe("imposeStyle", () => {
  const BAND =
    "(100% - var(--tug-imposer-inset-left, 0px)" +
    " - var(--tug-imposer-inset-right, 0px) - 5px * 2)";

  test("a left-numbered pane pins its left edge against the left inset", () => {
    expect(imposeStyle(at(1, 2), 300)).toEqual({
      width: "300px",
      height: "auto",
      top: "5px",
      bottom: GAP_BOTTOM,
      left:
        "calc(0% + var(--tug-imposer-inset-left, 0px) + 5px + " +
        `1 * max(0px, ${BAND} - 300px))`,
    });
  });

  test("slot 0 has travelled nothing, so it carries no max() at all", () => {
    const style = imposeStyle(at(0, 3), 400);
    expect(style.left).toBe("calc(0% + var(--tug-imposer-inset-left, 0px) + 5px + 0px)");
    expect(style.left).not.toContain("max(");
  });

  // The pin's SHAPE is the same on every deck and in every slot — only the
  // inset terms and the fraction differ. That is what a rail flip has to
  // interpolate; a pin that turned around and measured from `100%` would be
  // swapping a percentage for a bare length, which has nothing to cross.
  test("every pin has the same shape: `left`, from the left inset", () => {
    for (const slot of [0, 1, 2]) {
      const style = imposeStyle(at(slot, 3), 400);
      expect(style.transform).toBeUndefined();
      expect(style.right).toBeUndefined();
      expect(String(style.left)).toStartWith(
        "calc(0% + var(--tug-imposer-inset-left, 0px) + 5px + ",
      );
    }
  });

  test("the width is always the pane's own, verbatim", () => {
    expect(imposeStyle(at(0, 2), 987).width).toBe("987px");
  });

  // A size-locked card (About) is placed, not sized. `bottom` has to go:
  // leaving it beside a fixed `height` would over-constrain the box and the
  // browser would drop one of the three, which is exactly the stretch the
  // pin exists to prevent.
  test("a pinned height replaces the run rather than riding inside it", () => {
    const style = imposeStyle(at(0, 3), 800, { height: 360 });
    expect(style.height).toBe("360px");
    expect(style.bottom).toBeUndefined();
    expect(style.top).toBe(`calc(5px + max(0px, (100% - 5px - ${GAP_BOTTOM} - 360px) / 2))`);
  });

  // The whole point of the slot/frame split: the travel is computed from the
  // SLOT's 800, not the card's 320, so the card lands where an ordinary card
  // would — and then steps half the difference in to sit in the middle of it.
  test("a pinned width takes an ordinary card's slot and centres in it", () => {
    const style = imposeStyle(at(0, 3), 800, { width: 320, height: 360 });
    expect(style.width).toBe("320px");
    // Slot 0 has no travel, so the centring term is the whole offset.
    expect(style.left).toBe(
      "calc(0% + var(--tug-imposer-inset-left, 0px) + 5px + 0px + 240px)",
    );
  });

  test("the travel a pinned card gets is its slot's, not its own", () => {
    // The last slot of a three-up: the card must end up exactly where an 800
    // card would, plus the 240 that centres it in that 800.
    const pinned = imposeStyle(at(2, 3), 800, { width: 320, height: 360 });
    const ordinary = imposeStyle(at(2, 3), 800);
    expect(pinned.left).toBe(`${String(ordinary.left).slice(0, -1)} + 240px)`);
  });

  test("a card wider than its slot pins at the near edge, never negative", () => {
    const style = imposeStyle(at(0, 2), 300, { width: 900 });
    expect(style.width).toBe("900px");
    // The centring term is clamped to 0, not the -300 the raw halving gives.
    expect(style.left).toEndWith("+ 0px + 0px)");
  });

  test("a pinned rect centres on both axes, and clamps at the near edges", () => {
    // FULL is 1000 × 800: a run of 800 - 5 - 32 = 763, so a 363-tall card
    // leaves 400 of slack and takes 200 of it above. A 320 card in an 800
    // slot takes 240 of the 480 to its left.
    const centred = imposeRect(at(0, 3), 800, FULL, { width: 320, height: 363 });
    expect(centred.size).toEqual({ width: 320, height: 363 });
    expect(centred.position).toEqual({ x: GAP + 240, y: GAP + 200 });
    // Larger than the slot on either axis: no negative offset, so it starts at
    // the near edge rather than hanging off the canvas.
    const overhang = imposeRect(at(0, 3), 320, FULL, {
      width: 900,
      height: 2000,
    });
    expect(overhang.position).toEqual({ x: GAP, y: GAP });
  });

  test("a pinned card's slot is still an ordinary slot", () => {
    // The slot itself has not moved: the pinned card's centre sits on the
    // centre of the box an ordinary card of the slot's width would occupy.
    const slot = imposeRect(at(1, 3), 800, FULL);
    const pinned = imposeRect(at(1, 3), 800, FULL, { width: 320, height: 360 });
    expect(pinned.position.x + pinned.size.width / 2).toBe(
      slot.position.x + slot.size.width / 2,
    );
    expect(pinned.position.y + pinned.size.height / 2).toBe(
      slot.position.y + slot.size.height / 2,
    );
  });
});

describe("imposeSidebarStyle", () => {
  /** A side's width expression: its own rail property, with the React-known
   *  width as the fallback. Same shape on both sides, different property —
   *  two rails standing at once need two numbers. */
  const widthOf = (side: "left" | "right", px = 420): string =>
    `var(--tug-sidebar-width-${side}, ${px}px)`;
  const pinOf = (side: "left" | "right", px = 420): string =>
    `calc(var(--tugx-rail-side) * (100% - ${widthOf(side, px)} - ${EDGE})` +
    ` + (1 - var(--tugx-rail-side)) * ${EDGE})`;

  test("pins a rail to its side, the edge inset in on three edges and deeper below", () => {
    expect(imposeSidebarStyle("left", 420) as Record<string, unknown>).toEqual({
      width: widthOf("left"),
      height: "auto",
      top: EDGE,
      "--tugx-rail-side": 0,
      left: pinOf("left"),
      bottom: RAIL_BOTTOM,
    });
    expect(imposeSidebarStyle("right", 420) as Record<string, unknown>).toEqual({
      width: widthOf("right"),
      height: "auto",
      top: EDGE,
      "--tugx-rail-side": 1,
      left: pinOf("right"),
      bottom: RAIL_BOTTOM,
    });
  });

  test("both sides pin with `left`, so the flip is one property's value", () => {
    for (const side of ["left", "right"] as const) {
      const style = imposeSidebarStyle(side, 420);
      expect(style.right).toBeUndefined();
      expect(typeof style.left).toBe("string");
    }
  });

  // The side is carried by an animatable number, and `left` is ONE expression
  // that reads it, identical on both sides. Emitting the two anchors as two
  // values of `left` instead gives a bare length against a percentage, which
  // has nothing to interpolate, so the flip cuts.
  test("the flip changes only the rail number, never the pin's shape", () => {
    const left = imposeSidebarStyle("left", 420);
    const right = imposeSidebarStyle("right", 420);
    // Same expression, differing only in which side's width property it reads.
    expect(String(left.left).replace("-left,", "-right,")).toBe(
      String(right.left),
    );
    expect(String(left.left)).toContain("var(--tugx-rail-side)");
    expect(
      (left as Record<string, unknown>)["--tugx-rail-side"],
    ).toBe(0);
    expect(
      (right as Record<string, unknown>)["--tugx-rail-side"],
    ).toBe(1);
  });

  // The width a drag rewrites is a property, and the pin is written over the
  // SAME expression: on the right rail the pin is `100% - width - gap`, so a
  // width that moved without the pin moving would move the pinned edge — the
  // one edge the rail holds. One property feeding both makes that impossible.
  test("the width is a property the pin reads, over the pane's own as fallback", () => {
    const style = imposeSidebarStyle("left", 987);
    expect(style.width).toBe(widthOf("left", 987));
    expect(String(style.left)).toContain(widthOf("left", 987));
  });

  test("the fallback is the pane's own width, so an unwritten property changes nothing", () => {
    for (const w of [260, 420, 987]) {
      expect(imposeSidebarStyle("right", w).width).toBe(
        widthOf("right", w),
      );
    }
  });

  test("each side reads its own width property, so two rails cannot share one", () => {
    expect(imposeSidebarStyle("left", 420).width).toBe(widthOf("left"));
    expect(imposeSidebarStyle("right", 420).width).toBe(widthOf("right"));
  });
});

describe("a stacked rail's members are geometrically identical", () => {
  test("every member takes the same pins — the whole run, each", () => {
    // The pins are the ones a lone rail has always had, and a second card on
    // the side does not change them while the side is stacked: same pin, same
    // width, same run, and z-order decides which of the two you are looking at.
    for (const side of ["left", "right"] as const) {
      const style = imposeSidebarStyle(side, 420);
      expect(style.top).toBe(EDGE);
      expect(style.bottom).toBe(RAIL_BOTTOM);
    }
  });

  test("two members on one side are geometrically identical", () => {
    // A stack of two is two frames the browser cannot tell apart except by
    // z-order — which is exactly what makes the title bar's stack badge the
    // only way to reach the one behind.
    const first = imposeSidebarStyle("right", 420);
    const second = imposeSidebarStyle("right", 420);
    expect(first).toEqual(second);
  });

  test("the style carries no vertical term a stack could vary", () => {
    // A stacked member has no per-member vertical math: these are the rail's
    // own two pins, and only a `member` placement turns them into fractions
    // of the run read off a seam property.
    const style = imposeSidebarStyle("right", 420);
    expect(style.top).toBe(EDGE);
    expect(style.bottom).toBe(RAIL_BOTTOM);
    expect(style.top).not.toContain("seam");
    expect(style.bottom).not.toContain("seam");
  });

  test("a rail of one is stacked geometry however it is asked for", () => {
    // Split is a property of the side, so a split side that is down to one
    // member still renders that member across the whole run ([P06]).
    const bare = imposeSidebarStyle("right", 420);
    expect(
      imposeSidebarStyle("right", 420, {
        member: { side: "right", index: 0, count: 1 },
      }),
    ).toEqual(bare);
  });
});

describe("a split rail divides the run between its members", () => {
  const RUN = `(100% - ${EDGE} - ${RAIL_BOTTOM})`;
  const seam = (side: "left" | "right", j: number, fallback: number): string =>
    `var(--tug-rail-${side}-seam-${j}, ${fallback})`;
  const split = (side: "left" | "right", index: number, count: number) =>
    imposeSidebarStyle(side, 420, { member: { side, index, count } });

  test("two members meet at one seam, half a gap each side of it", () => {
    const top = split("right", 0, 2);
    const bottom = split("right", 1, 2);
    expect(top.top).toBe(EDGE);
    expect(top.bottom).toBe(
      `calc(${RAIL_BOTTOM} + (1 - ${seam("right", 0, 0.5)}) * ${RUN} + 2.5px)`,
    );
    expect(bottom.top).toBe(
      `calc(${EDGE} + ${seam("right", 0, 0.5)} * ${RUN} + 2.5px)`,
    );
    expect(bottom.bottom).toBe(RAIL_BOTTOM);
  });

  test("the rail's own endpoints are the pins an unsplit rail has", () => {
    // A split reads as a division of the card the user already knew, so the
    // first member's top and the last member's bottom land on the pixel.
    expect(split("right", 0, 2).top).toBe(EDGE);
    expect(split("right", 1, 2).bottom).toBe(RAIL_BOTTOM);
  });

  test("the var fallbacks are the equal division, so a frame rendering before the properties land still tiles", () => {
    expect(String(split("right", 1, 2).top)).toContain(
      "var(--tug-rail-right-seam-0, 0.5)",
    );
    expect(String(split("right", 0, 2).bottom)).toContain(
      "var(--tug-rail-right-seam-0, 0.5)",
    );
  });

  test("width, left, and the rail number are untouched by the division", () => {
    // One rail, one width: splitting divides the run and nothing else.
    const stacked = imposeSidebarStyle("right", 420) as Record<string, unknown>;
    const member = split("right", 1, 3) as Record<string, unknown>;
    expect(member.width).toBe(stacked.width);
    expect(member.left).toBe(stacked.left);
    expect(member.height).toBe("auto");
    expect(member["--tugx-rail-side"]).toBe(1);
  });

  test("each side reads its own seam properties", () => {
    expect(String(split("left", 1, 2).top)).toContain("--tug-rail-left-seam-0");
    expect(String(split("right", 1, 2).top)).toContain(
      "--tug-rail-right-seam-0",
    );
  });
});

describe("a rail of three or more overflows instead of dividing", () => {
  const RUN = `(100% - ${EDGE} - ${RAIL_BOTTOM})`;
  const MEMBER = `(${RUN} / 2.5)`;
  const strip = (count: number): string =>
    `(${count} * ${MEMBER} + ${(count - 1) * 5}px)`;
  const offset = (side: "left" | "right", count: number): string =>
    `min(var(--tug-rail-${side}-offset, 0px), ` +
    `max(0px, ${strip(count)} - ${RUN}))`;
  const member = (side: "left" | "right", index: number, count: number) =>
    imposeSidebarStyle(side, 420, { member: { side, index, count } });

  test("two members are byte-identical to what a rail has always drawn", () => {
    // The whole promise of the boundary: nothing a user has ever seen changes
    // shape. Shares, seams and drags at N <= 2 are the code they always were.
    for (const index of [0, 1]) {
      const pins = member("left", index, 2);
      expect(String(pins.top) + String(pins.bottom)).toContain(
        "--tug-rail-left-seam-0",
      );
    }
  });

  test("an overflowing member reads no seam at all", () => {
    // Division has stopped meaning anything, so the seam properties are not
    // read — and the canvas stops writing them and stops drawing their handles.
    for (const index of [0, 1, 2]) {
      const pins = member("right", index, 3);
      expect(String(pins.top) + String(pins.bottom)).not.toContain("seam");
    }
  });

  test("every member takes the same height: the run over 2.5", () => {
    // Two whole members and the half that says there is more below — the
    // column's rule, over the other kind of place.
    for (const count of [3, 4, 6]) {
      const first = member("left", 0, count);
      expect(first.top).toBe(`calc(${EDGE} + 0px - ${offset("left", count)})`);
      expect(first.bottom).toBe(
        `calc(100% - ${EDGE} - 0px - ${MEMBER} + ${offset("left", count)})`,
      );
    }
  });

  test("members stack down the strip a member plus a gap apart", () => {
    // The seam between stacked members is the card gap, not the rail's
    // length: a strip's rhythm is the deck's.
    expect(member("right", 1, 4).top).toBe(
      `calc(${EDGE} + 1 * (${MEMBER} + 5px) - ${offset("right", 4)})`,
    );
    expect(member("right", 2, 4).top).toBe(
      `calc(${EDGE} + 2 * (${MEMBER} + 5px) - ${offset("right", 4)})`,
    );
  });

  test("the strip a member's clamp is measured against grows with the count", () => {
    // Stated in CSS, so widening the window re-resolves the ceiling in reflow
    // with no JS ([L06]) — the reason the clamp is written here at all.
    expect(String(member("left", 0, 3).top)).toContain(`3 * ${MEMBER} + 10px`);
    expect(String(member("left", 0, 6).top)).toContain(`6 * ${MEMBER} + 25px`);
  });

  test("each side's strip slides on its own property", () => {
    expect(String(member("left", 1, 3).top)).toContain(
      "var(--tug-rail-left-offset, 0px)",
    );
    expect(String(member("right", 1, 3).top)).toContain(
      "var(--tug-rail-right-offset, 0px)",
    );
    expect(railOffsetProperty("left")).toBe("--tug-rail-left-offset");
    expect(railOffsetProperty("right")).toBe("--tug-rail-right-offset");
  });

  test("the offset falls back to zero, so a frame before the write stands at the top", () => {
    // The same contract the seam fallbacks hold: the property is unregistered
    // and an effect writes it, so a frame can render first. It must render at
    // the strip's top rather than collapse.
    expect(String(member("left", 0, 3).top)).toContain(", 0px)");
  });

  test("width, left and the rail number survive the overflow untouched", () => {
    // A place's standing divides the RUN and nothing else — the same claim the
    // shared split makes, restated where the pins change shape entirely.
    const stacked = imposeSidebarStyle("right", 420) as Record<string, unknown>;
    const overflowing = member("right", 1, 4) as Record<string, unknown>;
    expect(overflowing.width).toBe(stacked.width);
    expect(overflowing.left).toBe(stacked.left);
    expect(overflowing.height).toBe("auto");
    expect(overflowing["--tugx-rail-side"]).toBe(1);
  });
});

describe("railSeamProperty", () => {
  test("names one property per side per gap", () => {
    expect(railSeamProperty("left", 0)).toBe("--tug-rail-left-seam-0");
    expect(railSeamProperty("right", 2)).toBe("--tug-rail-right-seam-2");
  });
});

describe("railSeamFractions", () => {
  test("no seams below two members", () => {
    expect(railSeamFractions([], undefined)).toEqual([]);
    expect(railSeamFractions(["cards"], undefined)).toEqual([]);
  });

  test("absent shares divide equally", () => {
    expect(railSeamFractions(["cards", "jots"], undefined)).toEqual([0.5]);
    const thirds = railSeamFractions(["cards", "jots", "overview"], undefined);
    expect(thirds[0]).toBeCloseTo(1 / 3, 10);
    expect(thirds[1]).toBeCloseTo(2 / 3, 10);
  });

  test("weights set the division", () => {
    expect(railSeamFractions(["cards", "jots"], { cards: 3, jots: 1 })).toEqual([
      0.75,
    ]);
  });

  test("an unnamed member weighs 1", () => {
    expect(railSeamFractions(["cards", "jots"], { cards: 3 })).toEqual([0.75]);
  });

  test("renormalizes over the members actually standing", () => {
    // Jots closed: the record still names it, but the rail divides what it has
    // between the two that are there ([P06]).
    const shares = { cards: 1, jots: 2, overview: 1 };
    expect(railSeamFractions(["cards", "overview"], shares)).toEqual([0.5]);
  });

  test("a degenerate weight reads as 1 rather than as an error", () => {
    for (const bad of [0, -4, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(railSeamFractions(["cards", "jots"], { cards: bad })).toEqual([0.5]);
    }
  });

  test("fractions are strictly increasing and inside the run", () => {
    const order = ["a", "b", "c", "d"];
    const fractions = railSeamFractions(order, { a: 1, b: 0.001, c: 5, d: 2 });
    expect(fractions).toHaveLength(3);
    let previous = 0;
    for (const fraction of fractions) {
      expect(fraction).toBeGreaterThan(previous);
      expect(fraction).toBeLessThan(1);
      previous = fraction;
    }
  });
});

describe("railSharesFromFractions", () => {
  test("round-trips against railSeamFractions", () => {
    for (const order of [
      ["cards", "jots"],
      ["cards", "jots", "overview"],
    ]) {
      for (const shares of [
        undefined,
        { [order[0]]: 3, [order[1]]: 1 },
        { [order[0]]: 0.5, [order[1]]: 2.25 },
      ]) {
        const fractions = railSeamFractions(order, shares);
        const recovered = railSharesFromFractions(order, fractions);
        const again = railSeamFractions(order, recovered);
        expect(again).toHaveLength(fractions.length);
        for (let j = 0; j < fractions.length; j += 1) {
          expect(again[j]).toBeCloseTo(fractions[j], 9);
        }
      }
    }
  });

  test("an equal division comes back as the all-ones record an absent one means", () => {
    const order = ["cards", "jots", "overview"];
    const recovered = railSharesFromFractions(
      order,
      railSeamFractions(order, undefined),
    );
    for (const id of order) expect(recovered[id]).toBeCloseTo(1, 9);
  });

  test("moving one seam leaves every untouched member's ratio exactly as it was", () => {
    // The [P02] property, and the reason this is a function rather than a line
    // of gesture code: dragging the top seam of a three-member rail must not
    // move the bottom member's share of the run.
    const order = ["cards", "jots", "overview"];
    const shares = { cards: 1, jots: 2, overview: 3 };
    const before = railSeamFractions(order, shares);
    const after = [before[0] + 0.1, before[1]];
    const recovered = railSharesFromFractions(order, after);
    // The untouched member's segment is unchanged, so its ratio to the run is.
    const recoveredFractions = railSeamFractions(order, recovered);
    expect(recoveredFractions[1]).toBeCloseTo(before[1], 9);
  });

  test("every weight is positive, even from degenerate fractions", () => {
    const order = ["cards", "jots", "overview"];
    for (const fractions of [
      [0, 0],
      [1, 1],
      [0.9, 0.2],
      [Number.NaN, Number.NaN],
      [],
    ]) {
      const shares = railSharesFromFractions(order, fractions);
      for (const id of order) {
        expect(shares[id]).toBeGreaterThan(0);
        expect(Number.isFinite(shares[id])).toBe(true);
      }
    }
  });

  test("a rail of one is one whole share", () => {
    expect(railSharesFromFractions(["cards"], [])).toEqual({ cards: 1 });
    expect(railSharesFromFractions([], [])).toEqual({});
  });
});

describe("effectiveRailOrder", () => {
  const imposition = (
    sidebars: DeckImposition["sidebars"],
    rails?: DeckImposition["rails"],
  ): DeckImposition => ({ sidebars, rails });

  test("with no stored order, the caller's order stands, filtered to the side", () => {
    const state = imposition({
      cards: { side: "right" },
      jots: { side: "right" },
    });
    expect(effectiveRailOrder(state, "right", ["cards", "jots"])).toEqual([
      "cards",
      "jots",
    ]);
    expect(effectiveRailOrder(state, "left", ["cards", "jots"])).toEqual([]);
  });

  test("a card on the other side is not on this rail", () => {
    const state = imposition({
      cards: { side: "left" },
      jots: { side: "right" },
    });
    expect(effectiveRailOrder(state, "left", ["cards", "jots"])).toEqual(["cards"]);
    expect(effectiveRailOrder(state, "right", ["cards", "jots"])).toEqual([
      "jots",
    ]);
  });

  test("cards default to the right, so an empty map rails them there", () => {
    const state = imposition({});
    expect(effectiveRailOrder(state, "right", ["cards", "jots"])).toEqual([
      "cards",
      "jots",
    ]);
  });

  test("the stored order wins", () => {
    const state = imposition(
      { cards: { side: "right" }, jots: { side: "right" } },
      { right: { mode: "split", order: ["jots", "cards"] } },
    );
    expect(effectiveRailOrder(state, "right", ["cards", "jots"])).toEqual([
      "jots",
      "cards",
    ]);
  });

  test("a stored order is not perturbed by the caller's list changing order", () => {
    // The [R06] twin: the caller's list is z-sensitive at its source, and a
    // stored order is what makes a split rail's vertical order immune to that.
    const state = imposition(
      { cards: { side: "right" }, jots: { side: "right" } },
      { right: { mode: "split", order: ["jots", "cards"] } },
    );
    expect(effectiveRailOrder(state, "right", ["cards", "jots"])).toEqual(
      effectiveRailOrder(state, "right", ["jots", "cards"]),
    );
  });

  test("ids the order names but the rail does not hold are filtered out", () => {
    // Jots closed, or moved to the other side: the record keeps its place for
    // when it returns, and the rail lays out the members it has.
    const state = imposition(
      { cards: { side: "right" }, jots: { side: "left" } },
      { right: { mode: "split", order: ["jots", "cards"] } },
    );
    expect(effectiveRailOrder(state, "right", ["cards", "jots"])).toEqual([
      "cards",
    ]);
  });

  test("a member the order does not name is appended, in the order given", () => {
    const state = imposition(
      {
        cards: { side: "right" },
        jots: { side: "right" },
        overview: { side: "right" },
      },
      { right: { mode: "split", order: ["jots"] } },
    );
    expect(
      effectiveRailOrder(state, "right", ["cards", "jots", "overview"]),
    ).toEqual(["jots", "cards", "overview"]);
  });

  test("a returning member lands back where the order says, not at the end", () => {
    // A closed card has no standing pane, so the caller hands it in no longer;
    // the record still names it, and reopening puts it back at its place.
    const state = imposition(
      { cards: { side: "right" }, jots: { side: "right" } },
      { right: { mode: "split", order: ["jots", "cards"] } },
    );
    expect(effectiveRailOrder(state, "right", ["cards"])).toEqual(["cards"]);
    expect(effectiveRailOrder(state, "right", ["cards", "jots"])).toEqual([
      "jots",
      "cards",
    ]);
  });
});

describe("rail arrangement accessors", () => {
  const base: DeckImposition = {
    sidebars: { cards: { side: "right" }, jots: { side: "right" } },
  };

  test("an absent record reads as a stack on both sides", () => {
    expect(railModeOf(base, "left")).toBe("stack");
    expect(railModeOf(base, "right")).toBe("stack");
    expect(railModeOf({ sidebars: {}, rails: { right: {} } }, "right")).toBe(
      "stack",
    );
  });

  test("withRailMode records the side's mode without touching the other", () => {
    const split = withRailMode(base, "right", "split");
    expect(railModeOf(split, "right")).toBe("split");
    expect(railModeOf(split, "left")).toBe("stack");
    expect(railModeOf(base, "right")).toBe("stack");
  });

  test("re-stacking keeps order and shares, so a re-split lands where the user left it", () => {
    const split = withRailShares(
      withRailOrder(withRailMode(base, "right", "split"), "right", [
        "jots",
        "cards",
      ]),
      "right",
      { jots: 2, cards: 1 },
    );
    const stacked = withRailMode(split, "right", "stack");
    expect(stacked.rails?.right?.order).toEqual(["jots", "cards"]);
    expect(stacked.rails?.right?.shares).toEqual({ jots: 2, cards: 1 });
    expect(railModeOf(withRailMode(stacked, "right", "split"), "right")).toBe(
      "split",
    );
  });

  test("withoutRailShares equalizes and keeps mode and order", () => {
    const split = withRailShares(
      withRailOrder(withRailMode(base, "right", "split"), "right", [
        "jots",
        "cards",
      ]),
      "right",
      { jots: 2, cards: 1 },
    );
    const equalized = withoutRailShares(split, "right");
    expect(equalized.rails?.right?.shares).toBeUndefined();
    expect(equalized.rails?.right?.order).toEqual(["jots", "cards"]);
    expect(railModeOf(equalized, "right")).toBe("split");
    expect(withoutRailShares(base, "right")).toBe(base);
  });

  test("isRailMode narrows only the two modes", () => {
    expect(isRailMode("stack")).toBe(true);
    expect(isRailMode("split")).toBe(true);
    for (const bad of ["Split", "", 1, null, undefined, {}]) {
      expect(isRailMode(bad)).toBe(false);
    }
  });
});

describe("the arrangement clears the rail by exactly one gutter", () => {
  // The derivation the pinned-rail geometry rests on: with the rail on the
  // right at width W, its near edge sits at `canvasW - edge inset - W`, and
  // the last slot's card must land one gutter short of that. The band's far
  // end from the canvas edge is still the card gap.
  const CANVAS = { width: 1000, height: 800 };

  for (const W of [260, 420, 500]) {
    test(`a ${W}px right-side rail leaves the last slot one gutter off it`, () => {
      const span = resolveSpan(CANVAS, [{ side: "right", width: W }]);
      const rect = imposeRect(at(1, 2), 240, span);
      expect(rect.position.x + rect.size.width).toBe(
        CANVAS.width - RAIL_EDGE_INSET_PX - W - RAIL_GUTTER_PX,
      );
      expect(imposeRect(at(0, 2), 240, span).position.x).toBe(GAP);
    });

    test(`a ${W}px left-side rail leaves slot 1 one gutter off it`, () => {
      const span = resolveSpan(CANVAS, [{ side: "left", width: W }]);
      // Slot 1 is the leftmost position, so on this deck it is the one against
      // the rail; the last slot runs to the canvas's right edge.
      expect(imposeRect(at(0, 2), 240, span).position.x).toBe(
        RAIL_EDGE_INSET_PX + W + RAIL_GUTTER_PX,
      );
      const last = imposeRect(at(1, 2), 240, span);
      expect(last.position.x + last.size.width).toBe(CANVAS.width - GAP);
    });
  }
});

describe("the CSS and numeric forms agree", () => {
  // The style's calc is what the browser evaluates. This reproduces it by hand
  // — including the `max()` that pins an over-wide pane to the far edge — and
  // checks it lands where `imposeRect` says it should.
  function evaluatePin(
    placement: ImposedPlacement,
    paneWidth: number,
    span: ImposerSpan,
    canvasWidth: number,
  ): number {
    const insetLeft = span.x;
    const insetRight = canvasWidth - span.x - span.width;
    const band = canvasWidth - insetLeft - insetRight - GAP * 2;
    const offset = travelFraction(placement) * Math.max(0, band - paneWidth);
    return insetLeft + GAP + offset;
  }

  const CASES: Array<[ImposerSpan, number]> = [
    [FULL, 1000],
    [RAIL_RIGHT, 1000],
    [RAIL_LEFT, 1000],
  ];

  for (const [name, widths] of [
    ["an arrangement with room", [300, 220, 260]],
    ["a crowded arrangement", [500, 500, 500]],
  ] as const) {
    test(`${name} matches imposeRect everywhere`, () => {
      for (const [span, canvasWidth] of CASES) {
        widths.forEach((width, slot) => {
          const placement = resolvePlacement("three-up", slot);
          expect(evaluatePin(placement, width, span, canvasWidth)).toBeCloseTo(
            imposeRect(placement, width, span).position.x,
            9,
          );
        });
      }
    });
  }
});

describe("the space allocator", () => {
  /** The motivating shape: three cards of one width at an even stride. Three
   *  cards and two gaps want a band of exactly 2410.
   *
   *  Written as a FULL three-up rather than as five-up with slots 0, 2 and 4
   *  filled, which is how it read while the allocator's chain was the occupied
   *  slots alone. The two are the same geometry — `travelFraction` gives 0,
   *  0.5 and 1 either way, so every constant below is unchanged — but they are
   *  no longer the same INPUT: the chain is now every slot the kind defines,
   *  so five-up with two holes is a chain of five and wants a band of 4020. */
  const THREE_UP_RUN = [
    { slot: 0, width: 800 },
    { slot: 1, width: 800 },
    { slot: 2, width: 800 },
  ];
  /** The band that tiles the shape above exactly, and the rail width that
   *  produces it on a canvas of width W: `W - rail air - gap - band`. */
  const EXACT_BAND = 3 * 800 + 2 * GAP;
  const railWidthFor = (canvasWidth: number): number =>
    canvasWidth - RAIL_AIR - GAP - EXACT_BAND;
  /** The inverse: the canvas on which a rail of `lensWidth` tiles exactly. */
  const canvasFor = (lensWidth: number): number =>
    lensWidth + RAIL_AIR + GAP + EXACT_BAND;

  /** Every seam in the chain, measured through `imposeRect` at a given rail
   *  width — the geometry the allocator's answer actually produces. */
  function seamsAt(
    canvasWidth: number,
    lensWidth: number,
    occupied: readonly { slot: number; width: number }[],
    kind: "three-up",
  ): number[] {
    const span = resolveSpan({ width: canvasWidth, height: 800 }, [
      { side: "right", width: lensWidth },
    ]);
    const rects = occupied.map((o) =>
      imposeRect(resolvePlacement(kind, o.slot), o.width, span),
    );
    const seams: number[] = [];
    for (let i = 0; i < rects.length - 1; i += 1) {
      seams.push(
        rects[i + 1].position.x - (rects[i].position.x + rects[i].size.width),
      );
    }
    return seams;
  }

  test("the exact-tiling case lands every seam on the gap", () => {
    const canvasWidth = canvasFor(400);
    const width = allocateOneRail({
      canvasWidth,
      kind: "three-up",
      occupied: THREE_UP_RUN,
      preferredWidth: 400,
      minWidth: 320,
    });
    expect(width).toBe(railWidthFor(canvasWidth));
    for (const seam of seamsAt(canvasWidth, width ?? 0, THREE_UP_RUN, "three-up")) {
      expect(seam).toBeCloseTo(GAP, 9);
    }
  });

  test("gaps grow the rail and overlaps shrink it", () => {
    const preferredWidth = 420;
    // A deck 20px wider than the exact fit spreads the cards: the rail takes
    // the surplus.
    const roomy = canvasFor(preferredWidth) + 20;
    expect(seamsAt(roomy, preferredWidth, THREE_UP_RUN, "three-up")[0]).toBeGreaterThan(GAP);
    const grown = allocateOneRail({
      canvasWidth: roomy,
      kind: "three-up",
      occupied: THREE_UP_RUN,
      preferredWidth,
      minWidth: 320,
    });
    expect(grown).toBe(440);
    expect(grown).toBeGreaterThan(preferredWidth);

    // And 20px narrower overlaps them: the rail gives the difference back.
    const crowded = canvasFor(preferredWidth) - 20;
    expect(seamsAt(crowded, preferredWidth, THREE_UP_RUN, "three-up")[0]).toBeLessThan(GAP);
    const shrunk = allocateOneRail({
      canvasWidth: crowded,
      kind: "three-up",
      occupied: THREE_UP_RUN,
      preferredWidth,
      minWidth: 320,
    });
    expect(shrunk).toBe(400);
    expect(shrunk).toBeLessThan(preferredWidth);
  });

  test("irregular WIDTHS take the narrowest rail, not the least-squares fit", () => {
    // Irregular OCCUPANCY no longer exists as an input: the chain is every
    // slot the kind defines, so a hole is a vacancy at the vacancy's extent
    // and the stride stays even. What can still be irregular is the cards'
    // own widths, and that is what this reads — a slim card either side of a
    // wide one, which no band tiles at all.
    //
    // So the least-squares fit does not remove the error, it spreads it, and
    // it lands outside the rail's range entirely. Sum-of-squares scores an
    // overlap and a gap alike; on screen they are not remotely the same thing.
    // The three cards end to end want a band of 2840; this canvas leaves
    // 332px LESS than that after one rail's air, so the exact fit is a rail
    // of −332.
    const canvasWidth = 800 + 1230 + 800 + 2 * GAP - 332 + RAIL_AIR + GAP;
    const input = {
      canvasWidth,
      kind: "three-up" as const,
      occupied: [
        { slot: 0, width: 800 },
        { slot: 1, width: 1230 },
        { slot: 2, width: 800 },
      ],
      preferredWidth: 400,
      minWidth: 320,
    };

    // The closed form still says what it always said, and is still worth
    // reading — it is just no longer the answer, and here it is not even a
    // width: a negative rail is what "no band tiles this" looks like in the
    // fit's own arithmetic.
    expect(solveOneRail(input)).toBe(-332);

    // The answer is the narrowest rail the policy allows, because on a deck
    // this crowded every pixel of rail is a pixel of band, and every pixel of
    // band is occlusion removed. Nothing here can tile — the rail cannot buy a
    // clean picture at any width — so it buys the least bad one instead of
    // sitting at a compromise the browser never paints.
    expect(allocateOneRail(input)).toBe(320);
    const pictureAt = (right: number) =>
      seamPicture(
        {
          canvasWidth,
          kind: "three-up",
          occupied: input.occupied,
          rails: {
            right: rail({ preferredWidth: 400, minWidth: 320, greedRank: UNRANKED }),
          },
          maxRailWidth: CONTENT_WIDTH_SLIM_PX,
        },
        { right },
      );
    // 321px of occlusion is still a bad deck. It is 40px better than the width
    // the rail's owner chose, and every pixel of that is a card edge the user
    // can see.
    expect(pictureAt(320).worstOverlap).toBe(321);
    expect(pictureAt(400).worstOverlap).toBe(361);
  });

  test("growth is bounded by the slim width, and reaches it", () => {
    // A rail may stand as wide as a slim content card — a fixed ceiling,
    // however far that is from the width the user chose. Past the ceiling the
    // answer is the ceiling, at every distance: a target the rails cannot
    // reach is still a direction they move in as far as they may.
    const maxRailWidth = CONTENT_WIDTH_SLIM_PX;
    const solve = (canvasWidth: number): number | null =>
      allocateOneRail({
        canvasWidth,
        kind: "three-up",
        occupied: THREE_UP_RUN,
        preferredWidth: 420,
        minWidth: 320,
        maxRailWidth,
      });

    expect(solve(canvasFor(maxRailWidth))).toBe(maxRailWidth);
    for (const over of [1, 5, 400]) {
      expect(solve(canvasFor(maxRailWidth + over))).toBe(maxRailWidth);
    }
  });

  test("surplus grows the rail past its preference, up to the ceiling", () => {
    // The width the user chose is where the fill STARTS, not a cap on it. The
    // deleted grade capped an untileable slack at the chosen width and left
    // the deck's slack pooled between the cards instead; the geometry wants
    // the width, so the rail takes it.
    const input = {
      canvasWidth: canvasFor(560),
      kind: "three-up" as const,
      occupied: THREE_UP_RUN,
      preferredWidth: 420,
      minWidth: 320,
    };
    expect(allocateOneRail(input)).toBe(560);
    // Idempotent — the answer is a pure function of the inputs, and the rail's
    // own standing width is not one of them.
    expect(allocateOneRail(input)).toBe(560);
  });

  test("the hard floor is the only floor, and it holds", () => {
    // The fit wants 300, under the 320 floor: the rail gives everything it
    // has and stops there. What the chain does with the 20px it did not get
    // is the chain's business — a floor is a width below which the card
    // cannot be painted at all.
    expect(
      allocateOneRail({
        canvasWidth: canvasFor(300),
        kind: "three-up",
        occupied: THREE_UP_RUN,
        preferredWidth: 420,
        minWidth: 320,
      }),
    ).toBe(320);
  });

  test("a floor above the ceiling beats the ceiling", () => {
    // A rail whose card cannot paint under 700 stands at 700 even though the
    // deck's policy caps rails at the slim width: a maximum is a policy about
    // how wide the deck may stand a rail, and a minimum is a width below which
    // there is nothing to look at.
    expect(
      allocateOneRail({
        canvasWidth: canvasFor(300),
        kind: "three-up",
        occupied: THREE_UP_RUN,
        preferredWidth: 420,
        minWidth: 700,
      }),
    ).toBe(700);
  });

  test("the floor clips the low end of the range", () => {
    // A solve of 310 is clipped to the 320 floor — the nearest the rail may
    // stand to the fit.
    expect(
      allocateOneRail({
        canvasWidth: canvasFor(310),
        kind: "three-up",
        occupied: THREE_UP_RUN,
        preferredWidth: 340,
        minWidth: 320,
      }),
    ).toBe(320);
    // 330 clears the floor and is taken exactly.
    expect(
      allocateOneRail({
        canvasWidth: canvasFor(330),
        kind: "three-up",
        occupied: THREE_UP_RUN,
        preferredWidth: 340,
        minWidth: 320,
      }),
    ).toBe(330);
  });

  test("duplicate slots fold to the widest pane standing there", () => {
    const canvasWidth = canvasFor(400);
    const stacked = allocateOneRail({
      canvasWidth,
      kind: "three-up",
      occupied: [
        { slot: 0, width: 800 },
        { slot: 0, width: 640 },
        { slot: 2, width: 800 },
        { slot: 4, width: 800 },
      ],
      preferredWidth: 400,
      minWidth: 320,
    });
    expect(stacked).toBe(railWidthFor(canvasWidth));
  });

  test("the order of the occupied list does not matter", () => {
    const canvasWidth = canvasFor(400);
    const shuffled = allocateOneRail({
      canvasWidth,
      kind: "three-up",
      occupied: [THREE_UP_RUN[2], THREE_UP_RUN[0], THREE_UP_RUN[1]],
      preferredWidth: 400,
      minWidth: 320,
    });
    expect(shuffled).toBe(railWidthFor(canvasWidth));
  });

  test("no seam to solve for still answers, at the chosen width", () => {
    const base = {
      canvasWidth: 2845,
      kind: "three-up" as const,
      preferredWidth: 400,
      minWidth: 320,
    };
    // An empty deck and one-up (one slot, so one member however many cards
    // clamp onto it) leave the chain without a pair of neighbours. There is no
    // fit to make, so the rail stands at the width the user chose — which is
    // read from their own durable setting, never from a past answer, so
    // snapping to it can only ever restore their choice.
    expect(allocateOneRail({ ...base, occupied: [] })).toBe(400);
    expect(
      allocateOneRail({ ...base, kind: "one-up", occupied: THREE_UP_RUN }),
    ).toBe(400);
    // ONE CARD IN A THREE-UP IS NOT ONE OF THEM, and that is the arrangement
    // rule stated from the other side: the deck is holding two more places,
    // the chain is three members wide, and the rails are solved for the deck
    // the user asked for rather than for the one card standing in it. Which is
    // the whole point — a card opening into a place the arrangement was
    // already holding finds the rails already the right width, instead of
    // resizing both edges of the deck as it lands.
    expect(allocateOneRail({ ...base, occupied: [{ slot: 0, width: 800 }] })).toBe(
      allocateOneRail({ ...base, occupied: THREE_UP_RUN }),
    );
    // The chosen width is still held between the rail's own bounds.
    expect(
      allocateOneRail({ ...base, occupied: [], preferredWidth: 900 }),
    ).toBe(CONTENT_WIDTH_SLIM_PX);
    expect(
      allocateOneRail({ ...base, occupied: [], preferredWidth: 100 }),
    ).toBe(320);
  });

  test("a non-finite input leaves the rail alone", () => {
    const base = {
      canvasWidth: 2845,
      kind: "three-up" as const,
      occupied: THREE_UP_RUN,
      preferredWidth: 400,
      minWidth: 320,
    };
    expect(allocateOneRail({ ...base, canvasWidth: Number.NaN })).toBeNull();
    expect(allocateOneRail({ ...base, minWidth: Number.NaN })).toBeNull();
    expect(allocateOneRail({ ...base, comfortWidth: Number.NaN })).toBeNull();
    // A rank that is not a number would make the greed sort nondeterministic,
    // so it is refused at the same gate as every other bad number.
    expect(allocateOneRail({ ...base, greedRank: Number.NaN })).toBeNull();
    expect(
      allocateOneRail({
        ...base,
        occupied: [{ slot: 0, width: Number.NaN }, { slot: 2, width: 800 }],
      }),
    ).toBeNull();
    expect(allocateOneRail({ ...base, maxRailWidth: Number.NaN })).toBeNull();
  });

  test("with no rail standing there is nothing to allocate", () => {
    expect(
      allocateSidebarWidths({
        canvasWidth: 2845,
        kind: "three-up",
        occupied: THREE_UP_RUN,
        rails: {},
        maxRailWidth: CONTENT_WIDTH_SLIM_PX,
      }),
    ).toBeNull();
  });
});

describe("the total is chosen by the picture it paints", () => {
  // The crowded deck the picture-directed chooser exists for: three comfy
  // cards side by side in three-up, the Overview holding the right at its
  // 56ch comfort measure over a 400px hard floor, the Cards card on the left.
  //
  // A least-squares total is flat across ~1800px of canvas here, because it
  // saturates against the floors — which is why the deck looked, from the
  // outside, as though the allocator did not run on a window resize at all.
  const OVERVIEW = rail({
    preferredWidth: 580,
    minWidth: 400,
    comfortWidth: 512,
    greedRank: 1,
  });
  const CARDS = rail({ preferredWidth: 420, minWidth: 320, greedRank: 2 });
  const THREE_COMFY = [0, 1, 2].map((slot) => ({ slot, width: 800 }));
  /** The canvas on which the two rails tile this deck at a given total. */
  const canvasFor = (railTotal: number): number =>
    railTotal + RAIL_AIR * 2 + (3 * 800 + 2 * GAP);
  const at = (canvasWidth: number) => ({
    canvasWidth,
    kind: "three-up" as const,
    occupied: THREE_COMFY,
    rails: { left: CARDS, right: OVERVIEW },
    maxRailWidth: CONTENT_WIDTH_SLIM_PX,
  });
  const answerAt = (canvasWidth: number) =>
    allocateSidebarWidths(at(canvasWidth)) as { left: number; right: number };

  test("a canvas that can be tiled is tiled, by spending comfort", () => {
    // The repair, stated as one case. A rail total of 770 tiles this deck
    // exactly; the rails can reach it; the 56ch comfort floor forbade it, and
    // the deck sat on 26px of occlusion rather than give up 62px of measure.
    // Comfort is spent precisely because spending it removes the overlap.
    expect(answerAt(canvasFor(770))).toEqual({ left: 320, right: 450 });
    const picture = seamPicture(at(canvasFor(770)), { left: 320, right: 450 });
    expect(picture.worstOverlap).toBe(0);
    expect(picture.worstError).toBe(0);
    expect(picture.worstShortfall).toBe(0);
  });

  test("comfort is spent to REDUCE an overlap it cannot remove", () => {
    // Three 800px cards genuinely do not fit on a 2000–3000px canvas at any
    // rail total. The rails go to their hard floors anyway, because every
    // pixel they give up is a pixel of card the user gets back: at 3000 the
    // lap closes from 126px to 70px for 112px of Overview measure.
    //
    // This is the content-first rule, and it is the one the old tier gate got
    // wrong. That gate asked whether surrendering comfort reached a better
    // CLASS of picture — clean, cramped, occluded — and here it does not, so
    // the rails held their measure and the cards stayed 126px on top of one
    // another. The cards are the subject; the rails are the frame.
    for (const canvasWidth of [2000, canvasFor(570)]) {
      expect(answerAt(canvasWidth)).toEqual({ left: 320, right: 400 });
    }
    expect(
      seamPicture(at(canvasFor(570)), answerAt(canvasFor(570))).worstOverlap,
    ).toBe(70);
  });

  test("a hopeless deck returns the rails to their preferences", () => {
    // At 1400 every total scores the same overlap — the panes have run out of
    // travel, so moving the rails does not move a seam. With nothing to buy,
    // the last term of the key decides and the rails go back to the widths
    // their owner chose. Nothing is spent, because nothing would be bought.
    expect(answerAt(1400)).toEqual({ left: 420, right: 580 });
  });

  test("a roomy canvas leaves comfort alone and feeds the greediest rail", () => {
    const roomy = canvasFor(970);
    expect(answerAt(roomy)).toEqual({ left: 390, right: 580 });
    expect(seamPicture(at(roomy), answerAt(roomy)).worstOverlap).toBe(0);
  });

  test("the answer tracks the canvas instead of saturating", () => {
    // The direct pin on "it doesn't seem to run on resize". The landed
    // Phase 1 answer was 320/512 for EVERY canvas from 1700 to 3100 and took
    // three distinct values across the whole coarse sweep.
    const coarse = new Set<string>();
    for (let canvasWidth = 1400; canvasWidth <= 3400; canvasWidth += 100) {
      coarse.add(JSON.stringify(answerAt(canvasWidth)));
    }
    expect(coarse.size).toBeGreaterThanOrEqual(5);

    // And in the band where zero-overlap totals are reachable, the answer
    // tracks the window pixel for pixel rather than in steps.
    const fine = new Set<string>();
    for (let canvasWidth = 3150; canvasWidth <= 3350; canvasWidth += 10) {
      fine.add(JSON.stringify(answerAt(canvasWidth)));
    }
    expect(fine.size).toBeGreaterThanOrEqual(15);
  });

  test("comfort never re-inflates a width the user dragged", () => {
    // The Overview dragged to 450 — below its 512 comfort measure, which the
    // user is entitled to do. On a crowded deck the comfort floor must not
    // grow it back: that would widen the rail against an explicit choice AND
    // deepen the overlap by the same pixels.
    const dragged = rail({
      preferredWidth: 450,
      minWidth: 400,
      comfortWidth: 512,
      greedRank: 1,
    });
    const crowded = {
      canvasWidth: 3000,
      kind: "three-up" as const,
      occupied: THREE_COMFY,
      rails: { left: CARDS, right: dragged },
      maxRailWidth: CONTENT_WIDTH_SLIM_PX,
    };
    const answer = allocateSidebarWidths(crowded) as {
      left: number;
      right: number;
    };
    expect(answer.right).toBeLessThanOrEqual(450);
    expect(answer.left + answer.right).toBeLessThanOrEqual(450 + 420);
  });

  test("a deficit drains comfort before it drains the hard floor", () => {
    // Both tiers, in reverse greed order within each: the Cards rail gives up its
    // whole range before the Overview gives up a pixel of measure, and the
    // Overview reaches its hard floor last of all.
    const drained = answerAt(canvasFor(770));
    expect(drained.left).toBe(320);
    expect(drained.right).toBeGreaterThan(400);
  });
});

describe("greed order decides which rail is the wide one", () => {
  /** The plan's worked example: a full two-up of 800px cards. One 5px seam
   *  between them wants a band of exactly 1605, so with two rails standing the
   *  fit wants a rail TOTAL of `canvas − 1605 − 2·rail air`.
   *
   *  Written as a full two-up rather than as three-up with slots 0 and 2 —
   *  same travel fractions, same arithmetic, but the chain is now every slot
   *  the kind defines, so a three-up with a hole in the middle is a chain of
   *  THREE and wants a band of 2410. */
  const TWO_CARDS = [
    { slot: 0, width: 800 },
    { slot: 1, width: 800 },
  ] as const;
  /** The canvas whose fit wants the two rails to total `total`. */
  const canvasFor = (total: number): number => total + RAIL_AIR * 2 + 1605;

  /** The Overview: the greediest rail, at the ch-derived magnitudes the plan's
   *  example uses. Fed first, drained last. */
  const OVERVIEW = rail({ preferredWidth: 560, minWidth: 496, greedRank: 1 });
  /** The Cards card: greedier than Jots, less greedy than the Overview. */
  const CARDS = rail({ preferredWidth: 420, minWidth: 320, greedRank: 2 });

  const solve = (
    canvasWidth: number,
    left = CARDS,
    right = OVERVIEW,
    occupied: readonly { slot: number; width: number }[] = TWO_CARDS,
  ) =>
    allocateSidebarWidths({
      canvasWidth,
      kind: "two-up",
      occupied,
      rails: { left, right },
      maxRailWidth: CONTENT_WIDTH_SLIM_PX,
    });

  test("the fit's own total is the target, taken verbatim", () => {
    // Σ preferred is 980, and a canvas whose fit wants exactly that leaves
    // every rail at the width its owner chose.
    expect(solve(canvasFor(980))).toEqual({ left: 420, right: 560 });
    expect(canvasFor(980)).toBe(2609);
  });

  test("a deficit drains the least greedy rail first, to its floor", () => {
    // 100px short: the Cards rail gives all of it and lands on its floor while the
    // Overview does not move. The greediest rail gives width only after every
    // other rail is standing on its floor.
    expect(solve(canvasFor(880))).toEqual({ left: 320, right: 560 });
    // 164px short: the Cards rail is already spent, so the Overview gives the rest —
    // exactly down to its own floor, and no further.
    expect(solve(canvasFor(816))).toEqual({ left: 320, right: 496 });
  });

  test("a deficit past every floor stands both rails on their floors", () => {
    // The plan's worked case: the fit wants 805 of rail and the floors total
    // 816, so the target clamps UP and the 11px the rails refuse to give is
    // carried by the chain instead — the cards overlap by 6px at the single
    // interior seam, reported honestly rather than repaired.
    const canvasWidth = canvasFor(805);
    expect(solve(canvasWidth)).toEqual({ left: 320, right: 496 });
    const picture = seamPicture(
      {
        canvasWidth,
        kind: "two-up",
        occupied: TWO_CARDS,
        rails: { left: CARDS, right: OVERVIEW },
        maxRailWidth: CONTENT_WIDTH_SLIM_PX,
      },
      { left: 320, right: 496 },
    );
    expect(picture.worstOverlap).toBe(6);
  });

  test("a surplus feeds the greediest rail first, to its ceiling", () => {
    // 200px spare: the Overview takes the 115 that carries it to the slim
    // ceiling before the Cards rail grows a pixel, and it takes the rest.
    // BOTH rails end above their preferences — the fill is bounded by the
    // target and the ceiling, never by a preference.
    expect(solve(canvasFor(1180))).toEqual({
      left: 505,
      right: CONTENT_WIDTH_SLIM_PX,
    });
    expect(canvasFor(1180)).toBe(2809);
  });

  test("the two rails answer with different widths", () => {
    // The rule that every standing rail takes ONE shared width is deleted: a
    // rail carries its own policy, and two rails with different policies
    // stand at different widths.
    const widths = solve(canvasFor(980));
    expect(widths?.left).not.toBe(widths?.right);
  });

  test("reversing the sides reverses the answer, not the order", () => {
    // Greed is the rail's, not the side's.
    expect(solve(canvasFor(880), OVERVIEW, CARDS)).toEqual({
      left: 560,
      right: 320,
    });
  });

  test("equal ranks split the difference evenly", () => {
    const twin = rail({ preferredWidth: 400, minWidth: 320, greedRank: 5 });
    expect(solve(canvasFor(900), twin, { ...twin })).toEqual({
      left: 450,
      right: 450,
    });
    expect(solve(canvasFor(700), twin, { ...twin })).toEqual({
      left: 350,
      right: 350,
    });
  });

  test("a tied rail that hits its bound hands the remainder to its twin", () => {
    // Both rails rank 5, but the left one starts 25px under the ceiling. It
    // takes those 25 and the other 75 go to the right rail — the tier's split
    // is even until a member runs out of room, and then it is not.
    const near = rail({ preferredWidth: 650, minWidth: 320, greedRank: 5 });
    const far = rail({ preferredWidth: 400, minWidth: 320, greedRank: 5 });
    expect(solve(canvasFor(1150), near, far)).toEqual({
      left: CONTENT_WIDTH_SLIM_PX,
      right: 475,
    });
  });

  test("with no chain to fit, every rail snaps to its own chosen width", () => {
    // Fewer than two occupied slots is no seam and nothing to solve. Each
    // rail answers with its preference, held between its own bounds — not
    // with a shared number, and not with a refusal.
    expect(
      solve(canvasFor(980), CARDS, OVERVIEW, [{ slot: 0, width: 800 }]),
    ).toEqual({ left: 420, right: 560 });
    expect(solve(canvasFor(980), CARDS, OVERVIEW, [])).toEqual({
      left: 420,
      right: 560,
    });
  });

  test("the answer tiles the chain measured through both rails", () => {
    // The seam test is asked of the two-rail picture: a span built from one
    // rail would be reading a band one rail too wide.
    const canvasWidth = canvasFor(980);
    const widths = solve(canvasWidth);
    const span = resolveSpan({ width: canvasWidth, height: 800 }, [
      { side: "left", width: widths?.left ?? 0 },
      { side: "right", width: widths?.right ?? 0 },
    ]);
    const rects = TWO_CARDS.map((o) =>
      imposeRect(resolvePlacement("two-up", o.slot), o.width, span),
    );
    const seam =
      rects[1].position.x - (rects[0].position.x + rects[0].size.width);
    expect(seam).toBeCloseTo(GAP, 9);
  });

  test("moving width between the rails leaves every seam where it was", () => {
    // The separation property, which is why greed can never trade against
    // picture quality: the band depends on the rails' TOTAL and not on how
    // that total is divided, so the greed order picks which rail is wide
    // without touching a single seam.
    const canvasWidth = canvasFor(980);
    const input = {
      canvasWidth,
      kind: "two-up" as const,
      occupied: TWO_CARDS,
      rails: { left: CARDS, right: OVERVIEW },
      maxRailWidth: CONTENT_WIDTH_SLIM_PX,
    };
    const even = seamPicture(input, { left: 490, right: 490 });
    const lopsided = seamPicture(input, { left: 320, right: 660 });
    expect(lopsided).toEqual(even);
  });
});

describe("the stacking folds a rail is built from", () => {
  // `deck-manager.ts`'s `_sidebarRails` folds a side's members into ONE
  // policy: widest preference, tightest (largest) floors — hard and comfort
  // alike — and greediest (smallest) rank. These assert the arithmetic those
  // folds produce, so a rail carrying
  // a prose reader and a modest stackmate cannot silently become modest.
  const fold = (members: readonly RailPolicy[]): RailPolicy => ({
    preferredWidth: Math.max(...members.map((m) => m.preferredWidth)),
    minWidth: Math.max(...members.map((m) => m.minWidth)),
    comfortWidth: Math.max(...members.map((m) => m.comfortWidth)),
    greedRank: Math.min(...members.map((m) => m.greedRank)),
  });

  const OVERVIEW = rail({
    preferredWidth: 560,
    minWidth: 440,
    comfortWidth: 496,
    greedRank: 1,
  });
  const JOTS = rail({ preferredWidth: 420, minWidth: 320, greedRank: 3 });
  const CARDS = rail({ preferredWidth: 420, minWidth: 320, greedRank: 2 });

  test("a stacked rail takes the wider preference and the tighter floors", () => {
    // Both floors fold the same way, and independently: the rail must satisfy
    // its most demanding member's hard floor AND its most demanding member's
    // comfort floor.
    expect(fold([OVERVIEW, JOTS])).toEqual({
      preferredWidth: 560,
      minWidth: 440,
      comfortWidth: 496,
      greedRank: 1,
    });
  });

  test("a rail carrying the greediest card is greedy wherever it stands", () => {
    // Overview + Jots on the left against the Cards card on the right: the left rail
    // is rank 1, so Cards drains first even though Jots alone would not
    // outrank it.
    const widths = allocateSidebarWidths({
      canvasWidth: 880 + RAIL_AIR * 2 + 1605,
      kind: "two-up",
      occupied: [
        { slot: 0, width: 800 },
        { slot: 1, width: 800 },
      ],
      rails: { left: fold([OVERVIEW, JOTS]), right: CARDS },
      maxRailWidth: CONTENT_WIDTH_SLIM_PX,
    });
    expect(widths).toEqual({ left: 560, right: 320 });
  });

  test("a stacked rail never falls below any member's floor", () => {
    const widths = allocateSidebarWidths({
      canvasWidth: 700 + RAIL_AIR * 2 + 1605,
      kind: "two-up",
      occupied: [
        { slot: 0, width: 800 },
        { slot: 1, width: 800 },
      ],
      rails: { left: fold([OVERVIEW, JOTS]), right: CARDS },
      maxRailWidth: CONTENT_WIDTH_SLIM_PX,
    });
    expect(widths?.left).toBeGreaterThanOrEqual(OVERVIEW.minWidth);
    expect(widths?.left).toBeGreaterThanOrEqual(JOTS.minWidth);
  });
});

describe("the rails' inset count follows how many of them stand", () => {
  const THREE_UP_RUN = [
    { slot: 0, width: 800 },
    { slot: 1, width: 800 },
    { slot: 2, width: 800 },
  ] as const;
  const EXACT_BAND = 3 * 800 + 2 * GAP;

  test("a left-only rail is solved with the left-only inset count", () => {
    // One rail, so one rail's air and the band's own far gap — not the two
    // rails' air a bilateral deck spends.
    const widths = allocateSidebarWidths({
      canvasWidth: 420 + RAIL_AIR + GAP + EXACT_BAND,
      kind: "three-up",
      occupied: THREE_UP_RUN,
      rails: { left: rail({ preferredWidth: 400, minWidth: 320, greedRank: 2 }) },
      maxRailWidth: CONTENT_WIDTH_SLIM_PX,
    });
    expect(widths).toEqual({ left: 420 });
  });

  test("two rails spend their air twice, and the total is what tiles", () => {
    const twin = rail({ preferredWidth: 400, minWidth: 320, greedRank: 5 });
    const widths = allocateSidebarWidths({
      canvasWidth: 840 + RAIL_AIR * 2 + EXACT_BAND,
      kind: "three-up",
      occupied: THREE_UP_RUN,
      rails: { left: twin, right: { ...twin } },
      maxRailWidth: CONTENT_WIDTH_SLIM_PX,
    });
    expect(widths).toEqual({ left: 420, right: 420 });
  });
});

describe("content width presets", () => {
  test("the three widths are the values the brief fixed", () => {
    // Pinned as numbers, not as an alias of the constants: `wide` is the one
    // the brief marks adjustable, so a retune should be a deliberate edit here
    // rather than something a refactor can slide past.
    expect(CONTENT_WIDTH_SLIM_PX).toBe(675);
    expect(CONTENT_WIDTH_COMFY_PX).toBe(800);
    expect(CONTENT_WIDTH_WIDE_PX).toBe(1230);
  });

  test("the pickers' order is narrow to wide", () => {
    expect(CONTENT_WIDTH_PRESETS).toEqual(["slim", "comfy", "wide"]);
  });

  test("a preset resolves to its own pixels when the pane's floor is below it", () => {
    expect(resolveContentWidthPx("slim", 320)).toBe(675);
    expect(resolveContentWidthPx("comfy", 675)).toBe(800);
    expect(resolveContentWidthPx("wide", 800)).toBe(1230);
  });

  test("a floor above the preset wins — Settings' 720 beats slim", () => {
    // `movePane` writes the rect it is handed without clamping, so a preset
    // narrower than the pane's own minimum has to be lifted here or the stored
    // geometry and the painted frame would disagree.
    expect(resolveContentWidthPx("slim", 720)).toBe(720);
    // …and only where it actually binds: the same floor is under comfy.
    expect(resolveContentWidthPx("comfy", 720)).toBe(800);
  });

  test("the floor never widens a pane past the preset it was given", () => {
    for (const preset of CONTENT_WIDTH_PRESETS) {
      expect(resolveContentWidthPx(preset, 0)).toBe(
        resolveContentWidthPx(preset, 1),
      );
    }
  });

  test("a ceiling below the preset wins — About is locked at 320", () => {
    // The deck-wide default reaches every content pane, size-locked cards
    // included, so the ceiling has to bind for the same reason the floor does.
    for (const preset of CONTENT_WIDTH_PRESETS) {
      expect(resolveContentWidthPx(preset, 320, 320)).toBe(320);
    }
  });

  test("a ceiling above the preset does not bind", () => {
    expect(resolveContentWidthPx("slim", 480, 1600)).toBe(675);
    expect(resolveContentWidthPx("wide", 480, 1600)).toBe(1230);
  });

  test("an impossible policy resolves to the floor, never below it", () => {
    // A registration whose max is under its min is malformed; the floor is the
    // one bound a pane can never paint below, so it is the one that survives.
    expect(resolveContentWidthPx("slim", 720, 400)).toBe(720);
  });
});
