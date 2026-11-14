/**
 * split-newcomer-seating.test.ts — a card arriving into a split slot lands
 * at the bottom, always ([D194]).
 *
 * `withMemberSeated` is the one rule, and every path that seats a pane in a
 * slot — `addCard`, `assignCardsToSlots`, `movePaneToSlot` — hands it the
 * slot's current reading and takes the answer. Pure over `(imposition,
 * members, paneId, index?)`, so the rule is tested here without a deck.
 *
 * The fallback this replaces sorted unnamed members by pane id, which put the
 * second card opened into a split above or below the first on the toss of
 * two uuids. The cases below are the ones that used to be a coin toss.
 */

import { describe, expect, test } from "bun:test";

import {
  effectiveSlotOrder,
  withMemberSeated,
  type DeckImposition,
} from "../lib/layout-imposer";

/** A two-up whose slot 0 is split with the members named, top to bottom. */
function splitSlot(order: readonly string[]): DeckImposition {
  return {
    kind: "two-up",
    sidebars: {},
    slots: { 0: { mode: "split", order: [...order] } },
  };
}

describe("withMemberSeated", () => {
  test("a newcomer to a split slot is seated at the bottom", () => {
    const seated = withMemberSeated(splitSlot(["a"]), 0, ["a", "n"], "n");
    expect(seated.slots?.[0]?.order).toEqual(["a", "n"]);
  });

  test("the second newcomer lands under the first, whatever their ids sort to", () => {
    // "m" sorts before "n": the old fallback would have drawn it ABOVE.
    const first = withMemberSeated(splitSlot(["a"]), 0, ["a", "n"], "n");
    const members = effectiveSlotOrder(first, 0, ["a", "m", "n"].sort());
    const second = withMemberSeated(first, 0, members, "m");
    expect(second.slots?.[0]?.order).toEqual(["a", "n", "m"]);
  });

  test("a split slot with no stored order names its sitters, then the newcomer", () => {
    // A legacy blob: split, nothing named. The sitters keep the fallback's
    // reading (sorted by id) and the arrival goes under them.
    const legacy: DeckImposition = {
      kind: "two-up",
      sidebars: {},
      slots: { 0: { mode: "split" } },
    };
    const seated = withMemberSeated(legacy, 0, ["b", "c", "a"], "a");
    expect(seated.slots?.[0]?.order).toEqual(["b", "c", "a"]);
  });

  test("a drop that named an index is honored", () => {
    const seated = withMemberSeated(splitSlot(["a", "b"]), 0, ["a", "b", "n"], "n", 0);
    expect(seated.slots?.[0]?.order).toEqual(["n", "a", "b"]);
    const clamped = withMemberSeated(splitSlot(["a", "b"]), 0, ["a", "b", "n"], "n", 99);
    expect(clamped.slots?.[0]?.order).toEqual(["a", "b", "n"]);
  });

  test("an indexed arrival beside one sitter divides the slot ([P07])", () => {
    const stacked: DeckImposition = { kind: "two-up", sidebars: {} };
    const seated = withMemberSeated(stacked, 0, ["a", "n"], "n", 0);
    expect(seated.slots?.[0]).toEqual({ mode: "split", order: ["n", "a"] });
  });

  test("an unindexed arrival into a stack stays a stack", () => {
    // A stack's order is z, and nothing here may write it.
    const stacked: DeckImposition = { kind: "two-up", sidebars: {} };
    expect(withMemberSeated(stacked, 0, ["a", "n"], "n")).toBe(stacked);
    const deep: DeckImposition = {
      kind: "two-up",
      sidebars: {},
      slots: { 0: { mode: "stack" } },
    };
    expect(withMemberSeated(deep, 0, ["a", "b", "n"], "n", 1)).toBe(deep);
  });

  test("a pane alone in its slot is seated against nothing", () => {
    const alone = splitSlot([]);
    expect(withMemberSeated(alone, 0, ["n"], "n")).toBe(alone);
  });
});
