/**
 * block-reorder.test.ts — `moveInArray`, the arithmetic under every drag.
 *
 * The hook itself is DOM and pointer work that belongs to an app-test; this
 * is the one part of it that is a pure function of two indices, and it is
 * where an off-by-one in a reorder actually lives. It moved here with the
 * function when the rail's section registry — which used to hold it, back
 * when reordering the rail's bands was the reorder the deck had — was
 * deleted.
 */

import { describe, expect, it } from "bun:test";

import { moveInArray } from "@/components/tugways/block-reorder";

describe("block-reorder — moveInArray", () => {
  it("moves an item down", () => {
    expect(moveInArray(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
  });
  it("moves an item up", () => {
    expect(moveInArray(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
  });
  it("clamps an out-of-range target", () => {
    expect(moveInArray(["a", "b", "c"], 0, 99)).toEqual(["b", "c", "a"]);
  });
  it("does not mutate the input", () => {
    const input = ["a", "b", "c"];
    moveInArray(input, 0, 2);
    expect(input).toEqual(["a", "b", "c"]);
  });
});
