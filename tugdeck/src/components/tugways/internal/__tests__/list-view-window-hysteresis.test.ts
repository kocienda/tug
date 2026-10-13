/**
 * list-view-window — pixel-margin / hysteresis tests.
 *
 * Covers the mount-band, retain-band, and `prevRange` semantics the
 * eviction mode depends on: a cell enters the window at the mount
 * margin, stays until it clears the wider retain margin, and never
 * flips state on a jittering scroll offset. Pure function, no DOM.
 */

import { describe, expect, test } from "bun:test";

import { computeWindow } from "../list-view-window";

/** 100 rows of 100px each — a 10,000px document. */
const ROW = 100;
const ROWS = 100;
const fixed = () => ROW;

const base = {
  itemCount: ROWS,
  viewportHeight: 500,
  overscanCount: 0,
  estimatedHeightForIndex: fixed,
};

describe("computeWindow — pixel margins", () => {
  test("without margins the cell-count path is unchanged", () => {
    const legacy = computeWindow({ ...base, scrollTop: 2000, overscanCount: 2 });
    // Visible rows 20..24, overscan 2 → [18, 27).
    expect(legacy.firstIndex).toBe(18);
    expect(legacy.lastIndex).toBe(27);
    expect(legacy.topSpacerHeight).toBe(1800);
    expect(legacy.bottomSpacerHeight).toBe(7300);
    expect(legacy.totalHeight).toBe(10000);
  });

  test("mount margin extends the window by whole rows on both sides", () => {
    const r = computeWindow({ ...base, scrollTop: 2000, mountMarginPx: 500 });
    // Mount band [1500, 3000) → rows 15..29.
    expect(r.firstIndex).toBe(15);
    expect(r.lastIndex).toBe(30);
    expect(r.topSpacerHeight).toBe(1500);
    expect(r.bottomSpacerHeight).toBe(7000);
  });

  test("overscan still applies as a cell-count floor on top of the margins", () => {
    const r = computeWindow({
      ...base,
      scrollTop: 2000,
      overscanCount: 3,
      mountMarginPx: 500,
    });
    expect(r.firstIndex).toBe(12);
    expect(r.lastIndex).toBe(33);
  });

  test("a margin taller than the document clamps to the full range", () => {
    const r = computeWindow({ ...base, scrollTop: 2000, mountMarginPx: 99_999 });
    expect(r.firstIndex).toBe(0);
    expect(r.lastIndex).toBe(ROWS);
    expect(r.topSpacerHeight).toBe(0);
    expect(r.bottomSpacerHeight).toBe(0);
  });
});

describe("computeWindow — retention hysteresis", () => {
  test("a previously-windowed row outside the mount band is retained inside the retain band", () => {
    const r = computeWindow({
      ...base,
      scrollTop: 2000,
      mountMarginPx: 500,
      retainMarginPx: 1000,
      prevRange: { first: 10, last: 40 },
    });
    // Mount band gives 15..29; retain band [1000, 3500) covers 10..34,
    // so the prior window's rows 10..14 and 30..34 stay.
    expect(r.firstIndex).toBe(10);
    expect(r.lastIndex).toBe(35);
    expect(r.topSpacerHeight).toBe(1000);
    expect(r.bottomSpacerHeight).toBe(6500);
  });

  test("a previously-windowed row beyond the retain band is dropped", () => {
    const r = computeWindow({
      ...base,
      scrollTop: 2000,
      mountMarginPx: 500,
      retainMarginPx: 1000,
      prevRange: { first: 0, last: 5 },
    });
    // Rows 0..4 sit above the retain band's top (1000px) — no overlap,
    // so retention contributes nothing.
    expect(r.firstIndex).toBe(15);
    expect(r.lastIndex).toBe(30);
  });

  test("retention never splits the window — a distant prevRange clamps outward", () => {
    const r = computeWindow({
      ...base,
      scrollTop: 2000,
      mountMarginPx: 500,
      retainMarginPx: 1000,
      prevRange: { first: 33, last: 34 },
    });
    // Row 33 is inside the retain band; the window widens to reach it
    // rather than rendering two disjoint runs.
    expect(r.firstIndex).toBe(15);
    expect(r.lastIndex).toBe(34);
  });

  test("prevRange is ignored when no margins are supplied", () => {
    const r = computeWindow({
      ...base,
      scrollTop: 2000,
      prevRange: { first: 0, last: 90 },
    });
    expect(r.firstIndex).toBe(20);
    expect(r.lastIndex).toBe(25);
  });

  test("retainMarginPx below mountMarginPx is raised to it (no shrinking band)", () => {
    const r = computeWindow({
      ...base,
      scrollTop: 2000,
      mountMarginPx: 500,
      retainMarginPx: 0,
      prevRange: { first: 0, last: ROWS },
    });
    expect(r.firstIndex).toBe(15);
    expect(r.lastIndex).toBe(30);
  });
});

describe("computeWindow — no oscillation", () => {
  test("a scroll jittering across a row boundary holds the window steady", () => {
    const knobs = { mountMarginPx: 500, retainMarginPx: 1000 };
    // Settle first: feed each result forward as the next prevRange.
    let range = { first: 0, last: 0 };
    for (let i = 0; i < 4; i += 1) {
      const r = computeWindow({ ...base, ...knobs, scrollTop: 2000, prevRange: range });
      range = { first: r.firstIndex, last: r.lastIndex };
    }
    // Jitter one pixel either side of the row-15 mount boundary. A 1px
    // move may legitimately pull one more row into the mount band; what
    // must never happen is a row leaving the window and coming back —
    // that is the mount/unmount churn the retain band exists to stop.
    const offsets = [1999, 2001, 1999, 2001, 2000, 1999];
    for (const scrollTop of offsets) {
      const prev = range;
      const r = computeWindow({ ...base, ...knobs, scrollTop, prevRange: prev });
      range = { first: r.firstIndex, last: r.lastIndex };
      expect(range.first).toBeLessThanOrEqual(prev.first);
      expect(range.last).toBeGreaterThanOrEqual(prev.last);
    }
    // And it settles rather than creeping — one boundary row at each end
    // (rows 14 and 30 are the ones a ±1px band edge can reach), then done.
    expect(range).toEqual({ first: 14, last: 31 });
  });

  test("a sustained scroll does move the window (hysteresis is not a freeze)", () => {
    const knobs = { mountMarginPx: 500, retainMarginPx: 1000 };
    let range = { first: 15, last: 30 };
    const far = computeWindow({ ...base, ...knobs, scrollTop: 6000, prevRange: range });
    range = { first: far.firstIndex, last: far.lastIndex };
    // Mount band [5500, 7000) → rows 55..69; nothing of the old window
    // survives the retain band [5000, 7500).
    expect(range).toEqual({ first: 55, last: 70 });
  });
});

describe("computeWindow — margins composed with pins", () => {
  test("the pinned range clamps outward past the retain band", () => {
    const r = computeWindow({
      ...base,
      scrollTop: 2000,
      mountMarginPx: 500,
      retainMarginPx: 1000,
      prevRange: { first: 15, last: 30 },
      pinnedRange: { first: 3, last: 3 },
    });
    expect(r.firstIndex).toBe(3);
    expect(r.lastIndex).toBe(30);
    expect(r.topSpacerHeight).toBe(300);
  });

  test("an out-of-order pinned range still clamps correctly under margins", () => {
    const r = computeWindow({
      ...base,
      scrollTop: 2000,
      mountMarginPx: 500,
      pinnedRange: { first: 80, last: 60 },
    });
    expect(r.firstIndex).toBe(15);
    expect(r.lastIndex).toBe(81);
  });
});

describe("computeWindow — degenerate inputs under margins", () => {
  test("empty data source returns the empty window", () => {
    const r = computeWindow({
      ...base,
      itemCount: 0,
      scrollTop: 0,
      mountMarginPx: 500,
      prevRange: { first: 0, last: 10 },
    });
    expect(r.firstIndex).toBe(0);
    expect(r.lastIndex).toBe(0);
    expect(r.totalHeight).toBe(0);
  });

  test("negative margins are treated as zero", () => {
    const r = computeWindow({
      ...base,
      scrollTop: 2000,
      mountMarginPx: -500,
      retainMarginPx: -900,
      prevRange: { first: 0, last: ROWS },
    });
    expect(r.firstIndex).toBe(20);
    expect(r.lastIndex).toBe(25);
  });

  test("scrolled past the end, margins clamp to the tail", () => {
    const r = computeWindow({
      ...base,
      scrollTop: 99_000,
      mountMarginPx: 500,
    });
    expect(r.lastIndex).toBe(ROWS);
    expect(r.firstIndex).toBe(ROWS - 1);
    expect(r.bottomSpacerHeight).toBe(0);
  });

  test("a zero-height viewport still renders the margin band", () => {
    const r = computeWindow({
      ...base,
      scrollTop: 2000,
      viewportHeight: 0,
      mountMarginPx: 300,
    });
    // Band [1700, 2300) → rows 17..22.
    expect(r.firstIndex).toBe(17);
    expect(r.lastIndex).toBe(23);
  });

  test("prevRange indices outside the data source are ignored", () => {
    const r = computeWindow({
      ...base,
      scrollTop: 2000,
      mountMarginPx: 500,
      retainMarginPx: 1000,
      prevRange: { first: 500, last: 900 },
    });
    expect(r.firstIndex).toBe(15);
    expect(r.lastIndex).toBe(30);
  });
});
