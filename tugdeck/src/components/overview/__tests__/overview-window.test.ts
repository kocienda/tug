/**
 * overview-window — the Overview column's spacer, tops and pin arithmetic.
 *
 * Heights are outer extents — a post's height plus the gap after it — and
 * every expected column height is the one the bare heights gave.
 */

import { describe, expect, test } from "bun:test";

import { createTopPostStore, overviewCellTops, overviewSpacerHeight, pinnedRangeFor } from "../overview-window";

describe("overviewSpacerHeight", () => {
  // Extents of posts whose bare heights are `h`, under `gap`.
  const ext = (h: number[], gap: number): number[] => h.map((x) => x + gap);

  test("no posts is no spacer", () => {
    expect(overviewSpacerHeight([], 12)).toBe(0);
  });

  test("one post is its own height, with no gap inside", () => {
    expect(overviewSpacerHeight(ext([80], 12), 12)).toBe(80);
  });

  test("many posts carry the gaps between them, not after the last", () => {
    expect(overviewSpacerHeight(ext([80, 40, 100], 12), 12)).toBe(80 + 40 + 100 + 2 * 12);
  });

  test("a spacer and its neighbours add up to the fully mounted column", () => {
    // Fully mounted: h0 g h1 g h2 g h3. Windowed over posts 1–2: h0 g S g h3.
    const h = [50, 70, 90, 30];
    const gap = 8;
    const full = overviewSpacerHeight(ext(h, gap), gap);
    const windowed =
      h[0]! + gap + overviewSpacerHeight(ext([h[1]!, h[2]!], gap), gap) + gap + h[3]!;
    expect(windowed).toBe(full);
    expect(full).toBe(50 + 70 + 90 + 30 + 3 * 8);
  });
});

describe("overviewCellTops", () => {
  test("tops start at the first margin and step by extent", () => {
    expect(overviewCellTops([58, 78, 98], 16, 0)).toEqual([16, 74, 152]);
  });

  test("tops are relative to the scrollport", () => {
    expect(overviewCellTops([58, 78, 98], 16, 100)).toEqual([-84, -26, 52]);
  });

  test("no posts, no tops", () => {
    expect(overviewCellTops([], 16, 0)).toEqual([]);
  });
});

describe("pinnedRangeFor", () => {
  const keys = ["a", "b", "c", "d", "e"];

  test("an anchor alone pins its post", () => {
    expect(pinnedRangeFor(keys, "c", null, null)).toEqual({ first: 2, last: 2 });
  });

  test("a selection made backwards pins the range between its endpoints", () => {
    expect(pinnedRangeFor(keys, "d", "b", null)).toEqual({ first: 1, last: 3 });
  });

  test("focus alone pins its post", () => {
    expect(pinnedRangeFor(keys, null, null, "e")).toEqual({ first: 4, last: 4 });
  });

  test("focus outside the selection widens the range", () => {
    expect(pinnedRangeFor(keys, "b", "c", "e")).toEqual({ first: 1, last: 4 });
  });

  test("nothing inside a post is no pin", () => {
    expect(pinnedRangeFor(keys, null, null, null)).toBeNull();
  });

  test("a key no longer in the column is ignored", () => {
    expect(pinnedRangeFor(keys, "gone", null, null)).toBeNull();
  });
});

describe("createTopPostStore", () => {
  test("starts empty and notifies only on a change", () => {
    const store = createTopPostStore();
    let heard = 0;
    const off = store.subscribe(() => {
      heard += 1;
    });
    expect(store.get()).toBeNull();
    store.set("a");
    store.set("a");
    expect(store.get()).toBe("a");
    expect(heard).toBe(1);
    store.set(null);
    expect(heard).toBe(2);
    off();
    store.set("b");
    expect(heard).toBe(2);
  });
});
