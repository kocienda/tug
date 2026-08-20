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
 *  2. **The seam math is genuinely shared.** `railSeamFractions` and
 *     `railSharesFromFractions` take an arrangement's parts, not a side, so a
 *     column calls them unchanged. Asserted over column-shaped inputs, and
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
  columnSeamProperty,
  effectiveColumnOrder,
  imposeStyle,
  isColumnMode,
  railSeamFractions,
  railSharesFromFractions,
  sweptColumnOrders,
  withColumnMode,
  withColumnOrder,
  withColumnShares,
  withoutColumnShares,
  type DeckImposition,
} from "@/lib/layout-imposer";

/** A bare imposition — no columns, which is what every deck was before a slot
 *  could be divided. */
const bare = (): DeckImposition => ({
  kind: "three-up",
  sidebars: { lens: { side: "right" } },
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
    expect(next.sidebars).toEqual({ lens: { side: "right" } });
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

  test("withoutColumnShares drops the weights and keeps mode and order", () => {
    const split = withColumnShares(
      withColumnOrder(withColumnMode(bare(), 2, "split"), 2, ["p1", "p2"]),
      2,
      { p1: 3 },
    );
    expect(withoutColumnShares(split, 2).columns?.[2]).toEqual({
      mode: "split",
      order: ["p1", "p2"],
    });
  });

  test("withoutColumnShares returns the SAME imposition when there is nothing to drop", () => {
    // Identity is the signal `equalizeColumn` reads to decide whether it has
    // anything to commit — an equalize on an already-equal column must not arm
    // a settle. A fresh object that merely compares equal would arm one.
    const already = withColumnMode(bare(), 0, "split");
    expect(withoutColumnShares(already, 0)).toBe(already);
    expect(withoutColumnShares(bare(), 5)).not.toBeUndefined();
  });
});

describe("the seam math is shared, not forked {#member-keys}", () => {
  // Column members are PANE ids. `railSeamFractions` and
  // `railSharesFromFractions` never look at what an id names — they take the
  // order and the weights — which is exactly why one implementation serves
  // both places. These assertions are over column-shaped inputs so a change
  // that quietly makes the pair side-specific fails here.
  test("an absent shares record divides the column equally", () => {
    expect(railSeamFractions(["pane-a", "pane-b"], undefined)).toEqual([0.5]);
  });

  test("weights over pane ids set the division", () => {
    expect(
      railSeamFractions(["pane-a", "pane-b"], { "pane-a": 3, "pane-b": 1 }),
    ).toEqual([0.75]);
  });

  test("a member the column does not name weighs 1", () => {
    // What `setColumnShares` dropping a bad weight has to mean downstream: an
    // unnamed member is a full share, so a dropped weight and a missing one
    // are the same thing.
    expect(railSeamFractions(["pane-a", "pane-b"], { "pane-a": 1 })).toEqual([
      0.5,
    ]);
  });

  test("fractions and shares round-trip over a column", () => {
    const order = ["pane-a", "pane-b", "pane-c"];
    const shares = { "pane-a": 2, "pane-b": 1, "pane-c": 1 };
    const fractions = railSeamFractions(order, shares);
    const recovered = railSharesFromFractions(order, fractions);
    // Scaled to average 1 per member, so the ratios are what round-trips.
    const ratio = recovered["pane-a"] / recovered["pane-b"];
    expect(ratio).toBeCloseTo(2, 10);
    expect(railSeamFractions(order, recovered)).toEqual(fractions);
  });

  test("a drag on one seam leaves the members it did not touch in ratio", () => {
    // The [P02] property, restated over a column: segment lengths ARE the
    // weights, so moving ONE seam changes only the two members it sits
    // between. Four members and an uneven division, so there are two members
    // the drag did not touch and their ratio is not 1 — either alone would let
    // a broken implementation pass.
    const order = ["pane-a", "pane-b", "pane-c", "pane-d"];
    const shares = { "pane-a": 1, "pane-b": 1, "pane-c": 3, "pane-d": 1 };
    const before = railSeamFractions(order, shares);
    const dragged = [0.05, before[1], before[2]];
    const after = railSharesFromFractions(order, dragged);
    expect(after["pane-c"] / after["pane-d"]).toBeCloseTo(3, 10);
    // And the drag did what it was asked: the first member shrank.
    expect(after["pane-a"]).toBeLessThan(
      railSharesFromFractions(order, before)["pane-a"],
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
      bottom: "32px",
    });
  });

  test("a column of one takes the undivided run", () => {
    // A slot the user split and then closed a card out of is a column of one,
    // and it must look exactly like a slot that was never split — otherwise
    // closing a card would leave the survivor pinned to a seam nothing draws.
    expect(columnMemberPins({ slot: 2, index: 0, count: 1 })).toEqual(
      columnMemberPins(undefined),
    );
  });

  test("the first and last members pin to the run's own endpoints", () => {
    // Not to fractions. This is what makes a split read as a division of the
    // card the eye already knew: the top member and a stacked card share a top
    // edge to the pixel.
    const first = columnMemberPins({ slot: 0, index: 0, count: 3 });
    const last = columnMemberPins({ slot: 0, index: 2, count: 3 });
    expect(first.top).toBe("5px");
    expect(last.bottom).toBe("32px");
    expect(first.bottom).toContain("--tug-slot-0-seam-0");
    expect(last.top).toContain("--tug-slot-0-seam-1");
  });

  test("a middle member reads the seam either side of it", () => {
    const middle = columnMemberPins({ slot: 1, index: 1, count: 3 });
    expect(middle.top).toContain("--tug-slot-1-seam-0");
    expect(middle.bottom).toContain("--tug-slot-1-seam-1");
  });

  test("every seam read carries the equal-division fraction as its fallback", () => {
    // The property is unregistered and is written by an effect, so a frame can
    // render before it lands. Without the fallback that frame would collapse
    // rather than tile evenly.
    const middle = columnMemberPins({ slot: 0, index: 1, count: 4 });
    expect(middle.top).toContain("var(--tug-slot-0-seam-0, 0.25)");
    expect(middle.bottom).toContain("var(--tug-slot-0-seam-1, 0.5)");
  });

  test("each member takes half a gap at every seam it meets", () => {
    // The air between two split members reads as the same rhythm as every
    // other seam on the deck: one gap total, half from each neighbour.
    const middle = columnMemberPins({ slot: 0, index: 1, count: 3 });
    expect(middle.top).toContain("2.5px");
    expect(middle.bottom).toContain("2.5px");
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
        member: { slot: 1, index: 0, count: 1 },
      }),
    ).toEqual(imposeStyle(placement, 800));
  });

  test("a split member takes its share of the run and none of the width", () => {
    const whole = imposeStyle(placement, 800);
    const member = imposeStyle(placement, 800, undefined, {
      member: { slot: 1, index: 1, count: 2 },
    });
    // The horizontal pin is the slot's, untouched: a split divides the run,
    // never the band.
    expect(member.left).toBe(whole.left);
    expect(member.width).toBe(whole.width);
    expect(member.top).toContain("--tug-slot-1-seam-0");
    expect(member.bottom).toBe("32px");
  });

  test("a size-locked card centres inside its member's run, not the whole one", () => {
    // About is 320 x 360 by registration. In a split column it must centre in
    // the share it was given — centring it down the whole run would put it
    // through the seam and over its neighbour.
    const member = imposeStyle(placement, 800, { width: 320, height: 360 }, {
      member: { slot: 1, index: 1, count: 2 },
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
