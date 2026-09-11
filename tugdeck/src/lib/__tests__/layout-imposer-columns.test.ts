/**
 * layout-imposer-columns.test.ts — a slot is a place, and a place can be
 * divided.
 *
 * A column is the same arrangement a rail is — `{mode, order, shares}` — over
 * the panes standing in one numbered slot rather than the ones standing against
 * one edge. This file pins the three things that follow from "the same":
 *
 *  1. **The withers hold the rail's contract.** Re-stacking keeps order and
 *     shares, so a re-split lands where the user left it; equalizing removes
 *     the weights and keeps everything else; and each wither touches one slot,
 *     never its neighbours.
 *  2. **The division math is genuinely shared.** `allocatePlaceHeights` and
 *     `placeSharesFromHeights` take a place's members, not a side, so a column
 *     calls them unchanged. Asserted over column-shaped inputs, and
 *     round-tripped, so a later "let me specialize this for rails" shows up
 *     here rather than in a crooked split.
 *  3. **`effectiveColumnOrder` tolerates residue.** A column is keyed by pane
 *     id and nothing ever cleans it up, so naming a pane that is gone must be
 *     inert rather than a hole in the order.
 *
 * The one place a column deliberately differs from a rail is what a member is
 * called, and it is not cosmetic: a rail member is a componentId (a sidebar
 * card is a singleton), while a slot holds *panes*, each of which may be a tab
 * stack of several cards. Keying by card id would rename a member on a tab
 * switch. The keys here are pane ids throughout, and `#member-keys` below
 * states it once.
 */

import { describe, expect, test } from "bun:test";

import {
  columnMemberPins,
  columnModeOf,
  columnOffsetProperty,
  columnSeamProperty,
  allocatePlaceHeights,
  type PlaceAllocation,
  effectiveColumnOrder,
  flowRevealOffset,
  seamDragBounds,
  wallRevealOffset,
  IMPOSITION_GAP_BOTTOM_MAKER_PX,
  IMPOSITION_GAP_BOTTOM_PROPERTY,
  imposeStyle,
  isColumnMode,
  stripRevealOffset,
  placeSharesFromHeights,
  railWeightOf,
  type PlaceMember,
  sweptColumnOrders,
  withColumnMode,
  withColumnOrder,
  withColumnShares,
  type DeckImposition,
} from "@/lib/layout-imposer";

/** How the emitted expressions spell the bottom gap: the property, with the
 *  maker depth as its fallback. */
const GAP_BOTTOM = `var(${IMPOSITION_GAP_BOTTOM_PROPERTY}, ${IMPOSITION_GAP_BOTTOM_MAKER_PX}px)`;

/** A bare imposition — no columns, which is what every deck was before a slot
 *  could be divided. */
const bare = (): DeckImposition => ({
  kind: "three-up",
  sidebars: { tripwires: { side: "right" } },
});

describe("columnModeOf", () => {
  test("absent columns, an absent slot, and an absent mode all read as a stack", () => {
    expect(columnModeOf(bare(), 0)).toBe("stack");
    expect(columnModeOf({ columns: { 1: { mode: "split" } } }, 0)).toBe("stack");
    expect(columnModeOf({ columns: { 0: { order: ["p1"] } } }, 0)).toBe("stack");
  });

  test("a split slot reads as split", () => {
    expect(columnModeOf({ columns: { 2: { mode: "split" } } }, 2)).toBe("split");
  });

  test("a mode this build cannot read is not a split", () => {
    // The record arrives from a JSON blob. Anything that is not the word
    // "split" means the slot was not split, which is the only safe reading:
    // showing a division nobody chose is worse than showing the stack.
    const imposition = {
      columns: { 0: { mode: "sideways" } },
    } as unknown as DeckImposition;
    expect(columnModeOf(imposition, 0)).toBe("stack");
  });
});

describe("isColumnMode", () => {
  test("narrows exactly the two words", () => {
    expect(isColumnMode("stack")).toBe(true);
    expect(isColumnMode("split")).toBe(true);
    expect(isColumnMode("splt")).toBe(false);
    expect(isColumnMode(undefined)).toBe(false);
    expect(isColumnMode(null)).toBe(false);
    expect(isColumnMode(1)).toBe(false);
  });
});

describe("the column withers", () => {
  test("a first split writes only the mode, on only that slot", () => {
    const next = withColumnMode(bare(), 1, "split");
    expect(next.columns).toEqual({ 1: { mode: "split" } });
    // Everything else the imposition carries is untouched.
    expect(next.kind).toBe("three-up");
    expect(next.sidebars).toEqual({ tripwires: { side: "right" } });
  });

  test("re-stacking keeps the order and the shares", () => {
    // The rail's contract, and the reason it is worth having: a user who
    // stacks a column and splits it again gets the arrangement back, not a
    // default. A wither that dropped these would be indistinguishable until
    // the second split.
    const split = withColumnShares(
      withColumnOrder(withColumnMode(bare(), 0, "split"), 0, ["p2", "p1"]),
      0,
      { p2: 2 },
    );
    const stacked = withColumnMode(split, 0, "stack");
    expect(stacked.columns?.[0]).toEqual({
      mode: "stack",
      order: ["p2", "p1"],
      shares: { p2: 2 },
    });
    expect(withColumnMode(stacked, 0, "split").columns?.[0]).toEqual({
      mode: "split",
      order: ["p2", "p1"],
      shares: { p2: 2 },
    });
  });

  test("each wither leaves the other slots exactly as they stood", () => {
    const two = withColumnMode(withColumnMode(bare(), 0, "split"), 3, "split");
    const next = withColumnOrder(two, 0, ["p9"]);
    expect(next.columns?.[3]).toEqual({ mode: "split" });
    expect(next.columns?.[0]).toEqual({ mode: "split", order: ["p9"] });
  });

  test("the withers copy what they are handed", () => {
    // The caller's array and record are its own. A wither that stored the
    // reference would let a later mutation there rewrite committed state
    // behind the store's back — and without a notify, so nothing would
    // repaint until something unrelated did.
    const order = ["p1", "p2"];
    const shares = { p1: 2 };
    const next = withColumnShares(
      withColumnOrder(bare(), 0, order),
      0,
      shares,
    );
    order.push("p3");
    shares.p1 = 99;
    expect(next.columns?.[0]?.order).toEqual(["p1", "p2"]);
    expect(next.columns?.[0]?.shares).toEqual({ p1: 2 });
  });
});


describe("the division math is shared, not forked {#member-keys}", () => {
  // Column members are PANE ids. `allocatePlaceHeights` and
  // `placeSharesFromHeights` never look at what an id names — they take the
  // members and their appetites — which is exactly why one implementation
  // serves both places. These assertions are over column-shaped inputs so a
  // change that quietly makes the pair side-specific fails here.
  //
  // The members here declare no appetite of their own, which is what a pane
  // that has published nothing looks like: no floor to feed and no natural to
  // stop at, so the whole run reaches the water-fill and the division IS the
  // weights. That is the case these claims are about.
  const paneMembers = (
    ids: readonly string[],
    shares?: Readonly<Record<string, number>>,
  ): PlaceMember[] =>
    ids.map((id) => ({
      id,
      floor: 0,
      comfort: 0,
      natural: Number.POSITIVE_INFINITY,
      greedRank: 5,
      weight: railWeightOf(shares, id),
    }));
  const divide = (
    ids: readonly string[],
    shares?: Readonly<Record<string, number>>,
    run = 100,
  ): readonly number[] =>
    allocatePlaceHeights(paneMembers(ids, shares), run, 0).heights;

  test("an absent shares record divides the column equally", () => {
    expect(divide(["pane-a", "pane-b"])).toEqual([50, 50]);
  });

  test("weights over pane ids set the division", () => {
    expect(divide(["pane-a", "pane-b"], { "pane-a": 3, "pane-b": 1 })).toEqual([
      75, 25,
    ]);
  });

  test("a member the column does not name weighs 1", () => {
    // What `setColumnShares` dropping a bad weight has to mean downstream: an
    // unnamed member is a full share, so a dropped weight and a missing one
    // are the same thing.
    expect(divide(["pane-a", "pane-b"], { "pane-a": 1 })).toEqual([50, 50]);
  });

  test("heights and shares round-trip over a column", () => {
    // The allocator's fixed point ([P10]), over pane ids: the weights read back
    // out of a division reproduce that division exactly, which is what makes a
    // committed drag land where the hand let go of it.
    const order = ["pane-a", "pane-b", "pane-c"];
    const shares = { "pane-a": 2, "pane-b": 1, "pane-c": 1 };
    const heights = divide(order, shares, 400);
    expect(heights).toEqual([200, 100, 100]);
    const recovered = placeSharesFromHeights(
      paneMembers(order, shares),
      heights,
      400,
    );
    // Scaled to average 1 per member, so the ratios are what round-trips.
    expect(recovered["pane-a"] / recovered["pane-b"]).toBeCloseTo(2, 10);
    const again = allocatePlaceHeights(
      paneMembers(order, recovered),
      400,
      0,
    ).heights;
    for (let i = 0; i < heights.length; i += 1) {
      expect(again[i]).toBeCloseTo(heights[i], 9);
    }
  });

  test("a drag on one seam leaves the members it did not touch in ratio", () => {
    // The [P02] property, restated over a column: a drag moves ONE boundary, so
    // it changes only the two members that boundary sits between. Four members
    // and an uneven division, so there are two members the drag did not touch
    // and their ratio is not 1 — either alone would let a broken implementation
    // pass.
    const order = ["pane-a", "pane-b", "pane-c", "pane-d"];
    const shares = { "pane-a": 1, "pane-b": 1, "pane-c": 3, "pane-d": 1 };
    const before = divide(order, shares, 600);
    expect(before).toEqual([100, 100, 300, 100]);
    // The hand takes 60px off the first member and the second takes it — the
    // whole of what moving one boundary can do.
    const dragged = [40, 160, before[2], before[3]];
    const after = placeSharesFromHeights(
      paneMembers(order, shares),
      dragged,
      600,
    );
    expect(after["pane-c"] / after["pane-d"]).toBeCloseTo(3, 10);
    expect(after["pane-a"]).toBeLessThan(
      placeSharesFromHeights(paneMembers(order, shares), before, 600)[
        "pane-a"
      ],
    );
  });
});

describe("effectiveColumnOrder", () => {
  test("an unarranged slot takes the panes in the order handed in", () => {
    expect(effectiveColumnOrder(bare(), 0, ["p1", "p2"])).toEqual(["p1", "p2"]);
  });

  test("a stored order puts the members it names first, in its order", () => {
    const imposition = withColumnOrder(bare(), 0, ["p2", "p1"]);
    expect(effectiveColumnOrder(imposition, 0, ["p1", "p2"])).toEqual([
      "p2",
      "p1",
    ]);
  });

  test("residue is inert — a pane that is gone leaves no hole", () => {
    // A column is keyed by pane id and is never cleaned up ([L23]-style), so
    // an order naming a closed pane is the normal resting state rather than an
    // error. It must not leave a gap in the run or an undefined member.
    const imposition = withColumnOrder(bare(), 0, ["gone", "p2", "p1"]);
    expect(effectiveColumnOrder(imposition, 0, ["p1", "p2"])).toEqual([
      "p2",
      "p1",
    ]);
  });

  test("a pane the order does not name follows the ones it does", () => {
    // A card slotted into an already-split column joins at the bottom rather
    // than vanishing from the layout — the order is a preference over members
    // that come and go, not a membership list.
    const imposition = withColumnOrder(bare(), 0, ["p2"]);
    expect(effectiveColumnOrder(imposition, 0, ["p1", "p2", "p3"])).toEqual([
      "p2",
      "p1",
      "p3",
    ]);
  });

  test("a slot with no stored order is unaffected by its neighbour's", () => {
    const imposition = withColumnOrder(bare(), 1, ["p2", "p1"]);
    expect(effectiveColumnOrder(imposition, 0, ["p1", "p2"])).toEqual([
      "p1",
      "p2",
    ]);
  });
});

describe("columnSeamProperty", () => {
  test("names the slot and the gap", () => {
    expect(columnSeamProperty(0, 0)).toBe("--tug-slot-0-seam-0");
    expect(columnSeamProperty(4, 2)).toBe("--tug-slot-4-seam-2");
  });

  test("no two places share a property", () => {
    // The rails and the columns write into the same container element, so a
    // collision here would have a rail seam drag move a column member.
    const names = new Set<string>();
    for (let slot = 0; slot < 6; slot += 1) {
      for (let index = 0; index < 4; index += 1) {
        names.add(columnSeamProperty(slot, index));
      }
    }
    expect(names.size).toBe(24);
  });
});

describe("columnMemberPins", () => {
  test("an absent member takes the undivided run", () => {
    expect(columnMemberPins(undefined)).toEqual({
      top: "5px",
      bottom: GAP_BOTTOM,
    });
  });

  test("a column of one takes the undivided run", () => {
    // A slot the user split and then closed a card out of is a column of one,
    // and it must look exactly like a slot that was never split — otherwise
    // closing a card would leave the survivor pinned to a seam nothing draws.
    expect(columnMemberPins({ slot: 2, index: 0, count: 1, standing: "shared" })).toEqual(
      columnMemberPins(undefined),
    );
  });

  test("the first and last members pin to the run's own endpoints", () => {
    // Not to fractions. This is what makes a split read as a division of the
    // card the eye already knew: the top member and a stacked card share a top
    // edge to the pixel.
    const first = columnMemberPins({ slot: 0, index: 0, count: 2, standing: "shared" });
    const last = columnMemberPins({ slot: 0, index: 1, count: 2, standing: "shared" });
    expect(first.top).toBe("5px");
    expect(last.bottom).toBe(GAP_BOTTOM);
    expect(first.bottom).toContain("--tug-slot-0-seam-0");
    expect(last.top).toContain("--tug-slot-0-seam-0");
  });

  test("the seam read carries the equal-division fraction as its fallback", () => {
    // The property is unregistered and is written by an effect, so a frame can
    // render before it lands. Without the fallback that frame would collapse
    // rather than tile evenly.
    const lower = columnMemberPins({ slot: 0, index: 1, count: 2, standing: "shared" });
    expect(lower.top).toContain("var(--tug-slot-0-seam-0, 0.5)");
  });

  test("each member takes half a gap at the seam it meets", () => {
    // The air between two split members reads as the same rhythm as every
    // other seam on the deck: one gap total, half from each neighbour.
    const upper = columnMemberPins({ slot: 0, index: 0, count: 2, standing: "shared" });
    const lower = columnMemberPins({ slot: 0, index: 1, count: 2, standing: "shared" });
    expect(upper.bottom).toContain("2.5px");
    expect(lower.top).toContain("2.5px");
  });
});

describe("a column whose floors no longer fit overflows instead of dividing", () => {
  const RUN = `(100% - 5px - ${GAP_BOTTOM})`;
  // A strip whose members are all different heights — 300, 360, 420, … — which
  // is the whole of the new rule: a member's height is what the member asked
  // for, so no two of them need be the same.
  const stripOf = (count: number): number[] => {
    const coords = [0];
    for (let i = 0; i < count; i += 1) {
      coords.push(coords[i] + 300 + 60 * i + (i < count - 1 ? 5 : 0));
    }
    return coords;
  };
  const at = (slot: number, j: number, strip: number[]): string =>
    `var(--tug-slot-${slot}-strip-${j}, ${strip[j]}px)`;
  const offset = (slot: number, count: number, strip: number[]): string =>
    `min(var(--tug-slot-${slot}-column-offset, 0px), ` +
    `max(0px, ${at(slot, count, strip)} - ${RUN}))`;
  const member = (
    slot: number,
    index: number,
    count: number,
    strip: number[] = stripOf(count),
  ) => columnMemberPins({ slot, index, count, standing: "overflow", strip });

  // The standing is the allocator's answer now, and it is about ROOM rather
  // than about the count ([P01]). These say so from both directions: the same
  // count stands both ways depending on the run, and the boundary is exactly
  // where the floors and the seams stop fitting.
  const columnOf = (floors: readonly number[], run: number): PlaceAllocation =>
    allocatePlaceHeights(
      floors.map((floor, index) => ({
        id: `pane-${index}`,
        floor,
        comfort: floor,
        natural: floor,
        greedRank: 5,
        weight: 1,
      })),
      run,
      5,
    );

  test("the standing is decided by the floors against the run, not by the count", () => {
    // Two members can overflow and six can share. The old rule could say
    // neither: it saw the count and nothing else.
    expect(columnOf([600, 600], 900).standing).toBe("overflow");
    expect(columnOf([100, 100, 100, 100, 100, 100], 2000).standing).toBe(
      "shared",
    );
  });

  test("the boundary is exactly where the floors and the seams stop fitting", () => {
    // Three floors of 240 and two 5px seams need 730. At 730 the column
    // divides with nothing left over; a pixel short and it stacks.
    expect(columnOf([240, 240, 240], 730).standing).toBe("shared");
    expect(columnOf([240, 240, 240], 729).standing).toBe("overflow");
  });

  test("a place of one or none never overflows", () => {
    // Nothing to divide and no strip to scroll: the undivided member IS the
    // run, however tall it says it must be.
    expect(columnOf([], 100).standing).toBe("shared");
    expect(columnOf([9000], 100).standing).toBe("shared");
  });

  test("two members are byte-identical to what a column has always drawn", () => {
    // The whole promise of the boundary: nothing a user has ever seen changes
    // shape. Shares, seams and drags at N <= 2 are the code they always were.
    for (const index of [0, 1]) {
      const pins = columnMemberPins({ slot: 1, index, count: 2, standing: "shared" });
      expect(String(pins.top) + String(pins.bottom)).toContain(
        "--tug-slot-1-seam-0",
      );
    }
  });

  test("an overflowing member reads no seam at all", () => {
    // Division has stopped meaning anything, so the seam properties are not
    // read — and step 12 stops writing them and stops drawing their handles.
    for (const index of [0, 1, 2]) {
      const pins = columnMemberPins({ slot: 0, index, count: 3, standing: "overflow" });
      expect(String(pins.top) + String(pins.bottom)).not.toContain("seam");
    }
  });

  test("every member stands between its own two strip coordinates", () => {
    // Not a height the frame solves for — a height is `max(floor, comfort ·
    // weight)` now, which CSS cannot express — but the two coordinates the
    // allocator already put either side of the member.
    for (const count of [3, 4, 6]) {
      const strip = stripOf(count);
      const first = member(0, 0, count, strip);
      expect(first.top).toBe(
        `calc(5px + ${at(0, 0, strip)} - ${offset(0, count, strip)})`,
      );
      expect(first.bottom).toBe(
        `calc(100% - 5px - ${at(0, 1, strip)} + 5px + ${offset(0, count, strip)})`,
      );
    }
  });

  test("the last member's bottom carries no gap: its coordinate is the strip's end", () => {
    // Every other member's lower coordinate is the NEXT member's top, a gap
    // below its own bottom edge, so the gap is added back. The last one has no
    // next member: coordinate `n` is the strip's own end.
    const strip = stripOf(4);
    expect(member(2, 3, 4, strip).bottom).toBe(
      `calc(100% - 5px - ${at(2, 4, strip)} + 0px + ${offset(2, 4, strip)})`,
    );
  });

  test("members stack down the strip by their own heights, not by a multiple of one", () => {
    // The claim the old rule could not make: member 2 does not begin at twice
    // member 1's advance, because the members above it are not the same size.
    const strip = stripOf(4);
    expect(member(2, 1, 4, strip).top).toBe(
      `calc(5px + ${at(2, 1, strip)} - ${offset(2, 4, strip)})`,
    );
    expect(member(2, 2, 4, strip).top).toBe(
      `calc(5px + ${at(2, 2, strip)} - ${offset(2, 4, strip)})`,
    );
    expect(strip[2]).not.toBe(2 * strip[1]);
  });

  test("the clamp is measured against the strip's own end coordinate", () => {
    // The clamp's ceiling is `strip - run`, and the strip's length is now a
    // published number rather than N heights plus N-1 gaps — because the N
    // heights are no longer one height. Still stated in CSS, so widening the
    // window re-resolves the ceiling in reflow with no JS ([L06]).
    for (const count of [3, 6]) {
      const strip = stripOf(count);
      expect(member(0, 0, count, strip).top).toContain(
        `max(0px, var(--tug-slot-0-strip-${count}, ${strip[count]}px) - ${RUN})`,
      );
    }
  });

  test("a coordinate falls back to the number the allocation resolved it at", () => {
    // The strip properties are unregistered and an effect writes them, so a
    // frame can render before they land. It renders where the allocation put
    // it, which is the same discipline the seam fallbacks hold.
    const strip = stripOf(3);
    expect(member(1, 1, 3, strip).top).toContain(
      `var(--tug-slot-1-strip-1, ${strip[1]}px)`,
    );
  });

  test("each slot's strip slides on its own property", () => {
    expect(columnMemberPins({ slot: 0, index: 1, count: 3, standing: "overflow" }).top).toContain(
      "var(--tug-slot-0-column-offset, 0px)",
    );
    expect(columnMemberPins({ slot: 3, index: 1, count: 3, standing: "overflow" }).top).toContain(
      "var(--tug-slot-3-column-offset, 0px)",
    );
    expect(columnOffsetProperty(5)).toBe("--tug-slot-5-column-offset");
  });

  test("the offset falls back to zero, so a frame before the write stands at the top", () => {
    // Same contract the seam fallbacks hold: the property is unregistered and
    // an effect writes it, so a frame can render first. It must render at the
    // strip's top rather than collapse.
    expect(columnMemberPins({ slot: 0, index: 0, count: 3, standing: "overflow" }).top).toContain(
      ", 0px)",
    );
  });
});

describe("imposeStyle takes a column member", () => {
  const placement = { slot: 1, count: 3 };

  test("no member is byte-identical to the frame before columns existed", () => {
    expect(imposeStyle(placement, 800, undefined, {})).toEqual(
      imposeStyle(placement, 800),
    );
  });

  test("a member in a column of one is byte-identical too", () => {
    // The property the whole feature rests on: every deck that has never
    // split a slot, and every split slot that has dropped to one member,
    // produces exactly the frame it always did.
    expect(
      imposeStyle(placement, 800, undefined, {
        member: { slot: 1, index: 0, count: 1, standing: "shared" },
      }),
    ).toEqual(imposeStyle(placement, 800));
  });

  test("a split member takes its share of the run and none of the width", () => {
    const whole = imposeStyle(placement, 800);
    const member = imposeStyle(placement, 800, undefined, {
      member: { slot: 1, index: 1, count: 2, standing: "shared" },
    });
    // The horizontal pin is the slot's, untouched: a split divides the run,
    // never the band.
    expect(member.left).toBe(whole.left);
    expect(member.width).toBe(whole.width);
    expect(member.top).toContain("--tug-slot-1-seam-0");
    expect(member.bottom).toBe(GAP_BOTTOM);
  });

  test("a size-locked card centres inside its member's run, not the whole one", () => {
    // About is 320 x 360 by registration. In a split column it must centre in
    // the share it was given — centring it down the whole run would put it
    // through the seam and over its neighbour.
    const member = imposeStyle(placement, 800, { width: 320, height: 360 }, {
      member: { slot: 1, index: 1, count: 2, standing: "shared" },
    });
    expect(member.height).toBe("360px");
    expect(String(member.top)).toContain("--tug-slot-1-seam-0");
    expect(String(member.top)).toContain("360px");
  });
});

describe("sweptColumnOrders", () => {
  /** A pane, as the sweep reads one: an id and the slot it stands in. */
  const pane = (id: string, slot?: number): { id: string; slot?: number } =>
    slot === undefined ? { id } : { id, slot };

  test("drops a live member that has moved to another slot", () => {
    // The defect this exists for: `assignCardsToSlots` writes the new slot
    // onto the pane and hands the imposition back untouched, so the column it
    // left still names it — and invariant 9 refuses exactly that, which takes
    // the whole deck to the error overlay on the next validate.
    const imposition = withColumnOrder(
      withColumnMode(bare(), 0, "split"),
      0,
      ["p1", "p2", "p3"],
    );
    const swept = sweptColumnOrders(imposition, [
      pane("p1", 0),
      pane("p2", 1),
      pane("p3", 0),
    ]);
    expect(swept.columns?.[0]).toEqual({ mode: "split", order: ["p1", "p3"] });
  });

  test("a drop-created split stays honest when the arrival leaves again", () => {
    // The body-drop divide writes mode and order in one commit; dragging the
    // arrival away afterwards is an ordinary departure, and the sweep narrows
    // the created record the same way it narrows any column's — the sitter
    // keeps a one-member split rather than a record still naming the leaver.
    const imposition = withColumnOrder(
      withColumnMode(bare(), 1, "split"),
      1,
      ["sitter", "arrival"],
    );
    const swept = sweptColumnOrders(imposition, [
      pane("sitter", 1),
      pane("arrival", 2),
    ]);
    expect(swept.columns?.[1]).toEqual({ mode: "split", order: ["sitter"] });
  });

  test("keeps residue — a name with no live pane behind it", () => {
    // The same tolerance `effectiveColumnOrder` and invariant 9 both hold. A
    // closed pane's id is inert; only a LIVE pane standing elsewhere is a lie
    // about membership, and only that is worth rewriting the record over.
    const imposition = withColumnOrder(bare(), 0, ["p1", "gone"]);
    expect(sweptColumnOrders(imposition, [pane("p1", 0)])).toBe(imposition);
  });

  test("drops a member that left the chain entirely", () => {
    // A pane pulled out of the arrangement into a free pane carries no slot,
    // which is not slot 0 — the invariant reads that as standing outside the
    // chain and refuses it just the same.
    const imposition = withColumnOrder(bare(), 0, ["p1", "p2"]);
    const swept = sweptColumnOrders(imposition, [pane("p1", 0), pane("p2")]);
    expect(swept.columns?.[0]?.order).toEqual(["p1"]);
  });

  test("returns the same object when every member still stands where it is named", () => {
    // The commit path calls this on every geometry commit, and most of them
    // move nobody between slots. Identity is what keeps that free.
    const imposition = withColumnOrder(bare(), 0, ["p1", "p2"]);
    expect(sweptColumnOrders(imposition, [pane("p1", 0), pane("p2", 0)])).toBe(
      imposition,
    );
  });

  test("a deck with no columns is handed straight back", () => {
    const imposition = bare();
    expect(sweptColumnOrders(imposition, [pane("p1", 0)])).toBe(imposition);
  });

  test("mode and shares survive the sweep, and the other slots are untouched", () => {
    // The record is a preference, and a sweep is not a reset: the slot keeps
    // how it stands and how it divides, and a neighbour that lost nobody is
    // left exactly as it stood.
    const imposition = withColumnShares(
      withColumnOrder(
        withColumnMode(withColumnMode(bare(), 0, "split"), 1, "split"),
        0,
        ["p1", "p2"],
      ),
      0,
      { p1: 3, p2: 1 },
    );
    const swept = sweptColumnOrders(imposition, [pane("p1", 0), pane("p2", 2)]);
    expect(swept.columns?.[0]).toEqual({
      mode: "split",
      order: ["p1"],
      shares: { p1: 3, p2: 1 },
    });
    expect(swept.columns?.[1]).toEqual({ mode: "split" });
  });
});

describe("the reveal rule is one rule, read on either axis", () => {
  /** The run an overflowing column is seen through, and the strip of members
   *  behind it — a 900px canvas, so `run = 863` — over four members standing at
   *  their own comfort heights rather than at one shared one, which is what an
   *  overflowing strip is made of. */
  const HEIGHTS = [300, 360, 420, 480];
  const RUN = 900 - 5 - 32;
  const stripOf = (count: number): number =>
    HEIGHTS.slice(0, count).reduce((sum, height) => sum + height, 0) +
    (count - 1) * 5;
  const startOf = (index: number): number =>
    HEIGHTS.slice(0, index).reduce((sum, height) => sum + height, 0) + index * 5;

  test("flowRevealOffset is stripRevealOffset under flow's names", () => {
    // The extraction's whole claim. Asserted over the cases that separate the
    // branches — inside, before, after, and wider than the band — rather than
    // over one input, so a divergence in any arm shows up here.
    const cases = [
      { stripLeft: 0, extent: 400, stripWidth: 2000, band: 900, offset: 0 },
      { stripLeft: 1200, extent: 400, stripWidth: 2000, band: 900, offset: 0 },
      { stripLeft: 300, extent: 400, stripWidth: 2000, band: 900, offset: 800 },
      { stripLeft: 500, extent: 1400, stripWidth: 2000, band: 900, offset: 0 },
      { stripLeft: 900, extent: 300, stripWidth: 2000, band: 900, offset: 700 },
    ];
    for (const c of cases) {
      expect(flowRevealOffset(c)).toBe(
        stripRevealOffset({
          stripStart: c.stripLeft,
          extent: c.extent,
          stripLength: c.stripWidth,
          band: c.band,
          offset: c.offset,
        }),
      );
    }
  });

  test("a member already fully in the run reveals nothing", () => {
    // The property the activation commit rests on: an activation that reveals
    // nothing must write no geometry, or every raise would arm a settle.
    const at = (index: number, offset: number): number =>
      stripRevealOffset({
        stripStart: startOf(index),
        extent: HEIGHTS[index],
        stripLength: stripOf(4),
        band: RUN,
        offset,
      });
    expect(at(0, 0)).toBe(0);
    expect(at(1, 0)).toBe(0);
  });

  test("a member below the run slides the strip by the least that shows it", () => {
    // Member 2 of four starts at 670 and ends at 1090; the run is 863, so it
    // needs 227 of slide and takes exactly that — its bottom edge lands flush
    // and its top stays as low as it can.
    const offset = stripRevealOffset({
      stripStart: startOf(2),
      extent: HEIGHTS[2],
      stripLength: stripOf(4),
      band: RUN,
      offset: 0,
    });
    expect(offset).toBeCloseTo(startOf(2) + HEIGHTS[2] - RUN, 6);
  });

  test("a member above the run pins to its own top", () => {
    const offset = stripRevealOffset({
      stripStart: startOf(0),
      extent: HEIGHTS[0],
      stripLength: stripOf(4),
      band: RUN,
      offset: 400,
    });
    expect(offset).toBe(0);
  });

  test("a member taller than the run pins its top rather than its bottom", () => {
    // Reading starts at the top. Overflow members are never taller than the
    // run by construction, but a pinned card can be, and the rule answers for
    // it the way flow answers for a card wider than the band.
    const offset = stripRevealOffset({
      stripStart: 400,
      extent: 1200,
      stripLength: 2400,
      band: RUN,
      offset: 0,
    });
    expect(offset).toBe(400);
  });

  test("the answer is always inside the strip's own travel", () => {
    const tall = stripRevealOffset({
      stripStart: startOf(3),
      extent: HEIGHTS[3],
      stripLength: stripOf(4),
      band: RUN,
      offset: 0,
    });
    expect(tall).toBeLessThanOrEqual(stripOf(4) - RUN);
    // A strip shorter than the run has no travel at all.
    expect(
      stripRevealOffset({
        stripStart: 0,
        extent: HEIGHTS[0],
        stripLength: stripOf(2),
        band: RUN,
        offset: 200,
      }),
    ).toBe(0);
  });

  test("an unreadable position clamps what stands rather than inventing a slide", () => {
    expect(
      stripRevealOffset({
        stripStart: Number.NaN,
        extent: HEIGHTS[0],
        stripLength: stripOf(4),
        band: RUN,
        offset: 5000,
      }),
    ).toBeCloseTo(stripOf(4) - RUN, 6);
  });
});

// ---------------------------------------------------------------------------
// The wall ([P05], [P06])
// ---------------------------------------------------------------------------

describe("a wall of folded members", () => {
  /** The tier a folded Session card stands at, and an open one's floor. */
  const TIER = 160;
  const OPEN = 600;
  const SEAM = 5;
  /** A 900px canvas gives a column this much run: 900 − 5 − 32. */
  const RUN = 900 - 5 - 32;

  /** A folded member: floor pinned to ceiling, and no share of the run. */
  const folded = (id: string): PlaceMember => ({
    id,
    floor: TIER,
    ceiling: TIER,
    weight: 0,
  });
  /** An open member: its own floor, and whatever share it was given. */
  const open = (id: string, weight = 1): PlaceMember => ({
    id,
    floor: OPEN,
    weight,
  });

  // The four rows of the plan's own worked table, at a 900px run. They are
  // here as one test each rather than as a loop because what each row is FOR
  // is different: the first two are the two standings, the third is the
  // ceiling's whole reason, and the fourth is the wall the feature exists for.

  test("one folded and one open: shared, and the open card takes the rest", () => {
    const a = allocatePlaceHeights([folded("a"), open("b")], RUN, SEAM);
    expect(a.standing).toBe("shared");
    expect(a.heights[0]).toBeCloseTo(TIER, 6);
    // Not "six tenths" and not an equal share: the remainder, which is a
    // reading share rather than the whole column ([B07]).
    expect(a.heights[1]).toBeCloseTo(RUN - SEAM - TIER, 6);
    // Nothing dead beneath — the strip is the run.
    expect(a.stripLength).toBeCloseTo(RUN, 6);
  });

  test("two folded and one open: the floors stop fitting, so it overflows", () => {
    const a = allocatePlaceHeights(
      [folded("a"), folded("b"), open("c")],
      RUN,
      SEAM,
    );
    expect(a.standing).toBe("overflow");
    expect(a.heights).toEqual([TIER, TIER, OPEN]);
    // The strip runs past the run and scrolls behind it.
    expect(a.stripLength).toBeCloseTo(TIER * 2 + OPEN + SEAM * 2, 6);
    expect(a.stripLength).toBeGreaterThan(RUN);
  });

  test("ALL folded: the wall cannot fill its run, so it stands as a strip", () => {
    // The plan expected `shared` here, and shared is the one standing that
    // cannot produce this picture: a shared place pins its LAST member's
    // bottom to the run's own bottom (`memberPins`), so four cards would stand
    // at the tier and the fifth would run to the bottom of the canvas. A place
    // whose members cannot fill their run stands as a strip instead, and every
    // member pins to its own two strip coordinates.
    const a = allocatePlaceHeights(
      ["a", "b", "c", "d", "e"].map(folded),
      RUN,
      SEAM,
    );
    expect(a.standing).toBe("overflow");
    for (const height of a.heights) expect(height).toBeCloseTo(TIER, 6);
    // The surplus stays as run BENEATH the wall — a strip SHORTER than the run
    // it is seen through, which has no travel and so never scrolls.
    expect(a.stripLength).toBeCloseTo(TIER * 5 + SEAM * 4, 6);
    expect(a.stripLength).toBeLessThan(RUN);
  });

  test("one unbounded member is enough to keep the place dividing", () => {
    // The capacity rule must not catch an ordinary column: a single member
    // with no ceiling can absorb any surplus, so the place still shares.
    expect(
      allocatePlaceHeights([folded("a"), folded("b"), open("c")], RUN * 4, SEAM)
        .standing,
    ).toBe("shared");
  });

  test("ten folded: too many for the run, so the wall becomes a strip", () => {
    const a = allocatePlaceHeights(
      Array.from({ length: 10 }, (_, i) => folded(`p${i}`)),
      RUN,
      SEAM,
    );
    expect(a.standing).toBe("overflow");
    for (const height of a.heights) expect(height).toBeCloseTo(TIER, 6);
    expect(a.stripLength).toBeCloseTo(TIER * 10 + SEAM * 9, 6);
  });

  test("a stored share cannot outvote the ceiling", () => {
    // The share is derived from the flag on every allocation ([P05]), but a
    // member that arrived with both a weight and a ceiling must still hold: a
    // seam drag stored while the card was open is not a licence to stretch it
    // while it is folded.
    const a = allocatePlaceHeights(
      [{ ...folded("a"), weight: 9 }, open("b")],
      RUN,
      SEAM,
    );
    expect(a.heights[0]).toBeCloseTo(TIER, 6);
  });

  test("seamDragBounds beside a ceilinged member cannot exceed the ceiling", () => {
    const members = [folded("a"), open("b")];
    const a = allocatePlaceHeights(members, RUN, SEAM);
    const bounds = seamDragBounds(a, members, 0);
    // `a` may not grow past its tier however far the hand travels…
    expect(bounds.upper).toBeCloseTo(TIER, 6);
    // …and may not shrink below it either, because its floor is its ceiling.
    expect(bounds.lower).toBeCloseTo(TIER, 6);
  });

  test("seamDragBounds is unchanged where no member carries a ceiling", () => {
    const members = [open("a"), open("b")];
    const a = allocatePlaceHeights(members, RUN * 3, SEAM);
    const bounds = seamDragBounds(a, members, 0);
    const span = a.heights[0] + a.heights[1];
    expect(bounds.lower).toBeCloseTo(OPEN, 6);
    expect(bounds.upper).toBeCloseTo(span - OPEN, 6);
  });
});

describe("wallRevealOffset — where a wall lands when a card opens", () => {
  const SEAM = 5;
  const TIER = 160;
  const RUN = 900 - 5 - 32;
  /** Five folded members and one open one, as a strip: the wall's own shape. */
  const HEIGHTS = [TIER, TIER, 600, TIER, TIER];
  const stripLength =
    HEIGHTS.reduce((sum, h) => sum + h, 0) + (HEIGHTS.length - 1) * SEAM;
  const topOf = (index: number): number =>
    HEIGHTS.slice(0, index).reduce((sum, h) => sum + h, 0) + index * SEAM;

  test("the first member pins the strip at its origin", () => {
    // `leadExtent` is 0 and the arithmetic resolves to `-seam`, which clamps.
    expect(
      wallRevealOffset({
        stripStart: 0,
        leadExtent: 0,
        seam: SEAM,
        stripLength,
        band: RUN,
      }),
    ).toBe(0);
  });

  test("a middle member lands with its neighbour above in view", () => {
    // The rule's whole content ([B07]): the offset puts the member ABOVE the
    // opened one at the top of the band, so the reader keeps their place.
    const index = 2;
    const offset = wallRevealOffset({
      stripStart: topOf(index),
      leadExtent: HEIGHTS[index - 1],
      seam: SEAM,
      stripLength,
      band: RUN,
    });
    expect(offset).toBeCloseTo(topOf(index) - HEIGHTS[index - 1] - SEAM, 6);
    // And that is exactly the neighbour's own top.
    expect(offset).toBeCloseTo(topOf(index - 1), 6);
  });

  test("the last member clamps at the strip's end rather than past it", () => {
    const index = HEIGHTS.length - 1;
    expect(
      wallRevealOffset({
        stripStart: topOf(index),
        leadExtent: HEIGHTS[index - 1],
        seam: SEAM,
        stripLength,
        band: RUN,
      }),
    ).toBeCloseTo(Math.min(topOf(index - 1), stripLength - RUN), 6);
  });

  test("a wall that fits its run has no travel and answers 0", () => {
    // Spec S02's clamp degrades to zero in the shared regime, where there is
    // no strip to slide.
    expect(
      wallRevealOffset({
        stripStart: 330,
        leadExtent: TIER,
        seam: SEAM,
        stripLength: 500,
        band: RUN,
      }),
    ).toBe(0);
  });

  test("an unreadable position slides nothing", () => {
    expect(
      wallRevealOffset({
        stripStart: Number.NaN,
        leadExtent: TIER,
        seam: SEAM,
        stripLength,
        band: RUN,
      }),
    ).toBe(0);
  });
});
