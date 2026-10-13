/**
 * list-view-window-segments — `resolveEvictSegments`: the window plus at
 * most one measure segment, from the candidate window and the ledger.
 *
 * The rules pinned here are the ones that keep the transcript from mounting
 * every row: a row outside the window with no height, or a stale one, is
 * pending, and pending rows drain a capped run at a time, nearest the window
 * first. This reverses the earlier rules, under which a cold ledger
 * suspended eviction and rendered every row, a missing run mounted whole and
 * was never capped, and missing rows on both sides clamped the window over
 * the nearer run: a missing row now stands in its spacer at an estimate and
 * drains exactly as a stale one does.
 */

import { describe, expect, test } from "bun:test";

import { HeightIndex } from "../list-view-height-index";
import {
  MEASURE_SEGMENT_MAX_ROWS,
  resolveEvictSegments,
} from "../list-view-window";

/** A ledger with rows `[0, n)` measured at `h` px each. */
function measured(n: number, h = 100): HeightIndex {
  const idx = new HeightIndex();
  for (let i = 0; i < n; i += 1) idx.set(i, h);
  return idx;
}

/** Each row's height for the segment budget: measured, or a 100 px estimate. */
const heightOf = (idx: HeightIndex) => (i: number) => idx.get(i) ?? 100;

describe("resolveEvictSegments", () => {
  test("an empty ledger over 500 rows drains one capped run beside the window", () => {
    const idx = new HeightIndex();
    const r = resolveEvictSegments({ firstIndex: 240, lastIndex: 250 }, idx, 500, 10_000, heightOf(idx));
    // Rows 239 and 250 are equally near; the run below wins, and merges,
    // since it touches the window.
    expect(r).toEqual({
      kind: "evict",
      firstIndex: 240,
      lastIndex: 250 + MEASURE_SEGMENT_MAX_ROWS,
      segment: null,
    });
  });

  test("a window that holds every row evicts nothing and has no segment", () => {
    const idx = new HeightIndex();
    expect(resolveEvictSegments({ firstIndex: 0, lastIndex: 4 }, idx, 4, 500, heightOf(idx))).toEqual({
      kind: "evict",
      firstIndex: 0,
      lastIndex: 4,
      segment: null,
    });
  });

  test("an all-fresh ledger evicts with no segment", () => {
    const idx = measured(30);
    expect(resolveEvictSegments({ firstIndex: 10, lastIndex: 15 }, idx, 30, 500, heightOf(idx))).toEqual({
      kind: "evict",
      firstIndex: 10,
      lastIndex: 15,
      segment: null,
    });
  });

  test("one unmeasured row appended far below the window is a one-row segment, not a widening", () => {
    const idx = measured(30);
    expect(resolveEvictSegments({ firstIndex: 5, lastIndex: 9 }, idx, 31, 500, heightOf(idx))).toEqual({
      kind: "evict",
      firstIndex: 5,
      lastIndex: 9,
      segment: { firstIndex: 30, lastIndex: 31 },
    });
  });

  test("a 500-row missing run below is capped by rows", () => {
    const idx = measured(10);
    const r = resolveEvictSegments({ firstIndex: 2, lastIndex: 5 }, idx, 510, 10_000, heightOf(idx));
    expect(r).toEqual({
      kind: "evict",
      firstIndex: 2,
      lastIndex: 5,
      segment: { firstIndex: 10, lastIndex: 10 + MEASURE_SEGMENT_MAX_ROWS },
    });
  });

  test("a 500-row missing run below is capped by the budget, at the estimate", () => {
    const idx = measured(10);
    // Budget 250 px of 100 px estimates: rows 10 and 11.
    const r = resolveEvictSegments({ firstIndex: 2, lastIndex: 5 }, idx, 510, 250, heightOf(idx));
    expect(r).toEqual({ kind: "evict", firstIndex: 2, lastIndex: 5, segment: { firstIndex: 10, lastIndex: 12 } });
  });

  test("missing rows on both sides take the nearer run only, the window unclamped", () => {
    // Rows 0–1 prepended and unmeasured (far above), rows 28–29 appended
    // and unmeasured (near below), the window at 20–25.
    const idx = new HeightIndex();
    for (let i = 2; i < 28; i += 1) idx.set(i, 100);
    const r = resolveEvictSegments({ firstIndex: 20, lastIndex: 25 }, idx, 30, 500, heightOf(idx));
    expect(r).toEqual({ kind: "evict", firstIndex: 20, lastIndex: 25, segment: { firstIndex: 28, lastIndex: 30 } });
  });

  test("missing rows on both sides, the run above nearer, taken from its window end", () => {
    const idx = new HeightIndex();
    for (let i = 3; i < 25; i += 1) idx.set(i, 100);
    const r = resolveEvictSegments({ firstIndex: 5, lastIndex: 8 }, idx, 30, 500, heightOf(idx));
    expect(r).toEqual({ kind: "evict", firstIndex: 5, lastIndex: 8, segment: { firstIndex: 0, lastIndex: 3 } });
  });

  test("missing and stale rows drain together, nearest the window first", () => {
    const idx = measured(40, 10);
    idx.markAllStale();
    for (let i = 5; i < 35; i += 1) idx.set(i, 10); // fresh 5–34; stale 0–4 and 35–39
    idx.delete(36);
    idx.delete(37); // missing inside the stale run below
    const r = resolveEvictSegments({ firstIndex: 15, lastIndex: 25 }, idx, 40, 10_000, heightOf(idx));
    // Rows 4 and 35 are equally near; the run below wins, and its missing
    // rows drain with its stale ones as one run.
    expect(r).toEqual({ kind: "evict", firstIndex: 15, lastIndex: 25, segment: { firstIndex: 35, lastIndex: 40 } });
  });

  test("stale rows drain the nearest run, capped at MEASURE_SEGMENT_MAX_ROWS", () => {
    const idx = measured(40, 10);
    idx.markAllStale();
    for (let i = 10; i < 15; i += 1) idx.set(i, 10); // the window, measured fresh
    const r = resolveEvictSegments({ firstIndex: 10, lastIndex: 15 }, idx, 40, 10_000, heightOf(idx));
    // Rows 9 and 15 are equally near; the run below wins and merges, since it touches the window.
    expect(r).toEqual({ kind: "evict", firstIndex: 10, lastIndex: 15 + MEASURE_SEGMENT_MAX_ROWS, segment: null });
  });

  test("a stale run past a fresh gap is a separate segment, capped by rows", () => {
    const idx = measured(40, 10);
    idx.markAllStale();
    for (let i = 0; i < 20; i += 1) idx.set(i, 10); // everything above and the near rows below are fresh
    const r = resolveEvictSegments({ firstIndex: 10, lastIndex: 15 }, idx, 40, 10_000, heightOf(idx));
    expect(r).toEqual({
      kind: "evict",
      firstIndex: 10,
      lastIndex: 15,
      segment: { firstIndex: 20, lastIndex: 20 + MEASURE_SEGMENT_MAX_ROWS },
    });
  });

  test("a stale segment is capped at the budget, and takes at least one row", () => {
    const idx = measured(40, 300);
    idx.markAllStale();
    for (let i = 0; i < 20; i += 1) idx.set(i, 300);
    const two = resolveEvictSegments({ firstIndex: 10, lastIndex: 15 }, idx, 40, 650, heightOf(idx));
    expect(two).toEqual({ kind: "evict", firstIndex: 10, lastIndex: 15, segment: { firstIndex: 20, lastIndex: 22 } });
    const one = resolveEvictSegments({ firstIndex: 10, lastIndex: 15 }, idx, 40, 100, heightOf(idx));
    expect(one).toEqual({ kind: "evict", firstIndex: 10, lastIndex: 15, segment: { firstIndex: 20, lastIndex: 21 } });
  });

  test("the stale run above, when it is nearer, is taken from its window end", () => {
    const idx = measured(40, 10);
    idx.markAllStale();
    for (let i = 8; i < 40; i += 1) idx.set(i, 10); // fresh from row 8 down; 0–7 stale
    const r = resolveEvictSegments({ firstIndex: 20, lastIndex: 25 }, idx, 40, 25, heightOf(idx));
    // Budget 25 px of 10 px rows: rows 7, 6 (two rows, 20 px).
    expect(r).toEqual({ kind: "evict", firstIndex: 20, lastIndex: 25, segment: { firstIndex: 6, lastIndex: 8 } });
  });

  test("equally near stale runs prefer the one below", () => {
    const idx = measured(40, 10);
    idx.markAllStale();
    for (let i = 5; i < 35; i += 1) idx.set(i, 10); // stale 0–4 above and 35–39 below
    const r = resolveEvictSegments({ firstIndex: 15, lastIndex: 25 }, idx, 40, 10_000, heightOf(idx));
    expect(r).toEqual({ kind: "evict", firstIndex: 15, lastIndex: 25, segment: { firstIndex: 35, lastIndex: 40 } });
  });

  test("a missing run adjacent to the window merges into it", () => {
    const idx = measured(20);
    const r = resolveEvictSegments({ firstIndex: 15, lastIndex: 20 }, idx, 23, 500, heightOf(idx));
    expect(r).toEqual({ kind: "evict", firstIndex: 15, lastIndex: 23, segment: null });
  });
});
