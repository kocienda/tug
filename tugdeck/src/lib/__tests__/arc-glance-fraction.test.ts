/**
 * Which pair the numerals count, and where the ring lights its band.
 *
 * Two questions share an arc row. "How far through what was asked?" is the
 * declared run — the selection an invocation named, which the task list mirrors
 * and the join arms from. "How far through the document?" is the plan. The
 * numerals answer the first; the ring draws the second and lights the first
 * across it.
 *
 * Both are pure functions of four numbers, so this is a table test. The scope
 * derivation is the one piece of arithmetic on the client, and it exists only
 * because sending the run's first step as a fifth number would give the wire a
 * way to contradict itself.
 */

import { describe, test, expect } from "bun:test";

import {
  arcGlanceFraction,
  arcRunScope,
} from "@/lib/arc-meta-facts";

describe("the pair the numerals count", () => {
  test("a declared run wins over the plan's own counters", () => {
    // The case that opened this work: `Steps 1-3` of a ten-step plan showed
    // `1/10` on the masthead while the task list showed three tasks.
    expect(arcGlanceFraction(1, 3, 1, 10)).toEqual({ current: 1, total: 3 });
  });

  test("a mid-plan run counts from its own start, not the plan's", () => {
    // Steps 5-7 with step 6 open is the second of three, never `6/7`.
    expect(arcGlanceFraction(2, 3, 6, 10)).toEqual({ current: 2, total: 3 });
  });

  test("no declared run falls back to the plan pair, exactly as before", () => {
    expect(arcGlanceFraction(null, null, 4, 9)).toEqual({
      current: 4,
      total: 9,
    });
    expect(arcGlanceFraction(undefined, undefined, 4, 9)).toEqual({
      current: 4,
      total: 9,
    });
  });

  test("a half-sent run pair is not a pair, and falls back", () => {
    expect(arcGlanceFraction(2, null, 6, 10)).toEqual({
      current: 6,
      total: 10,
    });
    expect(arcGlanceFraction(null, 3, 6, 10)).toEqual({
      current: 6,
      total: 10,
    });
  });

  test("neither pair declared renders no counter at all", () => {
    expect(arcGlanceFraction(null, null, null, null)).toBeNull();
    expect(
      arcGlanceFraction(undefined, undefined, undefined, undefined),
    ).toBeNull();
  });
});

describe("the run's span across the plan", () => {
  test("a run at the plan's head starts there", () => {
    // Steps 1-3 of ten: the band covers the first three segments.
    expect(arcRunScope(1, 3, 1, 10)).toEqual({ from: 1, through: 3 });
  });

  test("a mid-plan run sits where it belongs in the document", () => {
    // Step 6 is the second of a 5-7 run, so the band is 5 through 7 — which is
    // the fact no fraction and no sentence conveys.
    expect(arcRunScope(2, 3, 6, 10)).toEqual({ from: 5, through: 7 });
  });

  test("a run spanning the whole plan covers every segment", () => {
    // The shape every one-step app-test fixture produces, and the shape that
    // keeps the ring rendering exactly as it did before this existed.
    expect(arcRunScope(1, 1, 1, 1)).toEqual({ from: 1, through: 1 });
    expect(arcRunScope(3, 10, 3, 10)).toEqual({ from: 1, through: 10 });
  });

  test("no declared run means no band", () => {
    expect(arcRunScope(null, null, 4, 9)).toBeUndefined();
    expect(arcRunScope(undefined, undefined, undefined, undefined)).toBeUndefined();
  });

  test("a span that would fall outside the plan is refused, not clamped", () => {
    // Numbers that cannot describe a real selection are a sender disagreeing
    // with itself; drawing a half-band over them would dress it up as a fact.
    expect(arcRunScope(5, 3, 2, 10)).toBeUndefined();
    expect(arcRunScope(1, 12, 1, 10)).toBeUndefined();
  });
});
