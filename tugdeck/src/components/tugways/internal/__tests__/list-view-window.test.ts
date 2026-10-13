/**
 * list-view-window — pure-function tests.
 *
 * Pins the windowing math against documented edge cases. No React,
 * no DOM — just the function.
 */

import { describe, expect, test } from "bun:test";

import {
  computeWindow,
  offsetForIndex,
  resolveRowAnchorScrollTop,
} from "../list-view-window";

const fixed = (h: number) => () => h;

describe("computeWindow — basic cases", () => {
  test("renders a window centered on scrollTop, with overscan", () => {
    const r = computeWindow({
      itemCount: 20,
      scrollTop: 200,
      viewportHeight: 100,
      overscanCount: 1,
      estimatedHeightForIndex: fixed(40),
    });
    // Items at offsets 200, 240, 280 (top inside [200, 300]) — 5, 6, 7
    // are visible (item 7's top at 280 is inside). With overscan 1,
    // include items 4 and 8: range is [4, 9). Top spacer = 4 cells;
    // bottom spacer = 11 cells (indices 9..19).
    expect(r.firstIndex).toBe(4);
    expect(r.lastIndex).toBe(9);
    expect(r.topSpacerHeight).toBe(160); // 4 cells * 40
    expect(r.bottomSpacerHeight).toBe(440); // 11 cells * 40
    expect(r.totalHeight).toBe(800);
  });

  test("renders cells at scrollTop=0 with overscan only below the visible region", () => {
    const r = computeWindow({
      itemCount: 20,
      scrollTop: 0,
      viewportHeight: 100,
      overscanCount: 2,
      estimatedHeightForIndex: fixed(40),
    });
    // Items 0 (0-40), 1 (40-80), 2 (80-120, top=80<100) are visible.
    // Overscan 2 above clamps to 0 (no negative indices); overscan 2
    // below extends to indices 3 and 4 → range [0, 5).
    expect(r.firstIndex).toBe(0);
    expect(r.lastIndex).toBe(5);
    expect(r.topSpacerHeight).toBe(0);
    expect(r.bottomSpacerHeight).toBe(600); // 15 cells * 40
  });

  test("zero overscan ⇒ window is exactly the visible range", () => {
    const r = computeWindow({
      itemCount: 10,
      scrollTop: 80,
      viewportHeight: 80,
      overscanCount: 0,
      estimatedHeightForIndex: fixed(40),
    });
    // Visible region is [80, 160]; that covers items 2 and 3.
    expect(r.firstIndex).toBe(2);
    expect(r.lastIndex).toBe(4);
  });

  test("totalHeight equals the sum of per-index heights", () => {
    const heights = [10, 20, 30, 40, 50];
    const r = computeWindow({
      itemCount: heights.length,
      scrollTop: 0,
      viewportHeight: 1000,
      overscanCount: 0,
      estimatedHeightForIndex: (i) => heights[i],
    });
    expect(r.totalHeight).toBe(150);
    expect(r.firstIndex).toBe(0);
    expect(r.lastIndex).toBe(5);
  });

  test("variable per-index heights produce correct spacer math", () => {
    // heights: [10, 20, 30, 40, 50, 60, 70, 80] — total 360.
    const heights = [10, 20, 30, 40, 50, 60, 70, 80];
    // Cumulative offsets: [0, 10, 30, 60, 100, 150, 210, 280, 360]
    // scrollTop=100 lands at start of item 4; viewport 100 reaches
    // 200, which is inside item 5 (offset 150–210).
    const r = computeWindow({
      itemCount: heights.length,
      scrollTop: 100,
      viewportHeight: 100,
      overscanCount: 0,
      estimatedHeightForIndex: (i) => heights[i],
    });
    expect(r.firstIndex).toBe(4);
    expect(r.lastIndex).toBe(6);
    expect(r.topSpacerHeight).toBe(100); // sum of [10..40]
    expect(r.bottomSpacerHeight).toBe(150); // sum of [70, 80] -- wait, indices 6 and 7
    expect(r.totalHeight).toBe(360);
  });
});

describe("computeWindow — edges", () => {
  test("itemCount === 0 ⇒ empty window, zero spacers", () => {
    const r = computeWindow({
      itemCount: 0,
      scrollTop: 0,
      viewportHeight: 100,
      overscanCount: 1,
      estimatedHeightForIndex: fixed(40),
    });
    expect(r.firstIndex).toBe(0);
    expect(r.lastIndex).toBe(0);
    expect(r.topSpacerHeight).toBe(0);
    expect(r.bottomSpacerHeight).toBe(0);
    expect(r.totalHeight).toBe(0);
  });

  test("itemCount === 1 ⇒ renders the single cell, no overscan into negative or past end", () => {
    const r = computeWindow({
      itemCount: 1,
      scrollTop: 0,
      viewportHeight: 100,
      overscanCount: 5,
      estimatedHeightForIndex: fixed(40),
    });
    expect(r.firstIndex).toBe(0);
    expect(r.lastIndex).toBe(1);
    expect(r.topSpacerHeight).toBe(0);
    expect(r.bottomSpacerHeight).toBe(0);
    expect(r.totalHeight).toBe(40);
  });

  test("scrollTop past the document end ⇒ window clamps to the last item", () => {
    const r = computeWindow({
      itemCount: 5,
      scrollTop: 9999,
      viewportHeight: 100,
      overscanCount: 0,
      estimatedHeightForIndex: fixed(40),
    });
    // Past-end: the visible-window walk found nothing, so the result
    // clamps to the final index.
    expect(r.firstIndex).toBe(4);
    expect(r.lastIndex).toBe(5);
    expect(r.topSpacerHeight).toBe(160); // 4 cells * 40
    expect(r.bottomSpacerHeight).toBe(0);
  });

  test("viewportHeight === 0 ⇒ window degenerates to a single cell at the scroll offset (plus overscan)", () => {
    const r = computeWindow({
      itemCount: 10,
      scrollTop: 80,
      viewportHeight: 0,
      overscanCount: 1,
      estimatedHeightForIndex: fixed(40),
    });
    // scrollTop 80 lands at start of item 2; with viewport 0, only
    // item 2 is "visible." Overscan adds 1 above and 1 below.
    expect(r.firstIndex).toBe(1);
    expect(r.lastIndex).toBe(4);
  });

  test("overscanCount > itemCount ⇒ clamps to [0, itemCount), no negative indices", () => {
    const r = computeWindow({
      itemCount: 3,
      scrollTop: 0,
      viewportHeight: 100,
      overscanCount: 100,
      estimatedHeightForIndex: fixed(40),
    });
    expect(r.firstIndex).toBe(0);
    expect(r.lastIndex).toBe(3);
  });

  test("negative scrollTop ⇒ treated as zero (defensive against rubber-band scrolls)", () => {
    const r = computeWindow({
      itemCount: 10,
      scrollTop: -50,
      viewportHeight: 100,
      overscanCount: 0,
      estimatedHeightForIndex: fixed(40),
    });
    expect(r.firstIndex).toBe(0);
    expect(r.lastIndex).toBeGreaterThan(0);
  });

  test("zero-height items ⇒ window math doesn't divide by zero or loop infinitely", () => {
    const r = computeWindow({
      itemCount: 5,
      scrollTop: 0,
      viewportHeight: 100,
      overscanCount: 0,
      estimatedHeightForIndex: fixed(0),
    });
    // All cells are at offset 0; the visible region [0, 100]
    // contains every cell. The window should span the whole list.
    expect(r.firstIndex).toBe(0);
    expect(r.lastIndex).toBe(5);
    expect(r.topSpacerHeight).toBe(0);
    expect(r.bottomSpacerHeight).toBe(0);
    expect(r.totalHeight).toBe(0);
  });
});

describe("offsetForIndex", () => {
  test("returns 0 for index 0, regardless of itemCount", () => {
    expect(offsetForIndex(0, 10, fixed(40))).toBe(0);
  });

  test("returns the cumulative height of preceding cells", () => {
    expect(offsetForIndex(3, 10, fixed(40))).toBe(120);
  });

  test("variable heights ⇒ accurate prefix sum", () => {
    const heights = [10, 20, 30, 40, 50];
    expect(offsetForIndex(3, heights.length, (i) => heights[i])).toBe(60);
  });

  test("negative index clamps to 0", () => {
    expect(offsetForIndex(-5, 10, fixed(40))).toBe(0);
  });

  test("index >= itemCount clamps to totalHeight", () => {
    expect(offsetForIndex(99, 5, fixed(40))).toBe(200); // 5 * 40
  });

  test("itemCount === 0 ⇒ always 0", () => {
    expect(offsetForIndex(3, 0, fixed(40))).toBe(0);
  });
});

describe("computeWindow — pinnedRange ([L23] selection/focus pin)", () => {
  const base = {
    itemCount: 100,
    scrollTop: 2000, // viewport covers items 50..52 at h=40
    viewportHeight: 100,
    overscanCount: 1,
    estimatedHeightForIndex: fixed(40),
  };

  test("a pin below the window widens it downward; spacers follow", () => {
    const plain = computeWindow(base);
    const pinned = computeWindow({ ...base, pinnedRange: { first: 80, last: 82 } });
    expect(pinned.firstIndex).toBe(plain.firstIndex);
    expect(pinned.lastIndex).toBe(83);
    expect(pinned.topSpacerHeight).toBe(plain.topSpacerHeight);
    expect(pinned.bottomSpacerHeight).toBe((100 - 83) * 40);
    expect(pinned.totalHeight).toBe(plain.totalHeight);
  });

  test("a pin above the window widens it upward", () => {
    const pinned = computeWindow({ ...base, pinnedRange: { first: 5, last: 7 } });
    expect(pinned.firstIndex).toBe(5);
    expect(pinned.topSpacerHeight).toBe(5 * 40);
  });

  test("a pin inside the window changes nothing", () => {
    const plain = computeWindow(base);
    const pinned = computeWindow({
      ...base,
      pinnedRange: { first: plain.firstIndex, last: plain.lastIndex - 1 },
    });
    expect(pinned).toEqual(plain);
  });

  test("a pin straddling the window covers both sides", () => {
    const pinned = computeWindow({ ...base, pinnedRange: { first: 10, last: 90 } });
    expect(pinned.firstIndex).toBe(10);
    expect(pinned.lastIndex).toBe(91);
  });

  test("out-of-range pin bounds clamp to [0, itemCount)", () => {
    const pinned = computeWindow({ ...base, pinnedRange: { first: -10, last: 500 } });
    expect(pinned.firstIndex).toBe(0);
    expect(pinned.lastIndex).toBe(100);
    expect(pinned.topSpacerHeight).toBe(0);
    expect(pinned.bottomSpacerHeight).toBe(0);
  });

  test("null pin behaves exactly as omitted", () => {
    expect(computeWindow({ ...base, pinnedRange: null })).toEqual(
      computeWindow(base),
    );
  });
});

describe("resolveRowAnchorScrollTop", () => {
  test("puts the row's anchor line at the scrollport top", () => {
    expect(resolveRowAnchorScrollTop(1200, 35, 5000)).toBe(1235);
  });

  test("clamps at zero above the first row", () => {
    // A reader above the first row's top (the first margin) cannot be held
    // at a negative scroll.
    expect(resolveRowAnchorScrollTop(8, -20, 5000)).toBe(0);
  });

  test("clamps at the bottom of the scroll range", () => {
    expect(resolveRowAnchorScrollTop(4900, 300, 5000)).toBe(5000);
  });

  test("an unbounded maximum clamps only at zero", () => {
    expect(resolveRowAnchorScrollTop(9000, 40, Number.POSITIVE_INFINITY)).toBe(9040);
  });
});
