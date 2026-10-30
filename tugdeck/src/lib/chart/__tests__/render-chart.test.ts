/**
 * `takeEntrance` — the pure decision behind a chart's once-per-source
 * entrance: true once per hash, false while not shown without spending the
 * hash, and the oldest hash forgotten past the bound.
 */

import { describe, expect, test } from "bun:test";

import { ENTRANCE_LIMIT, takeEntrance } from "../render-chart";

describe("takeEntrance", () => {
  test("true exactly once per hash", () => {
    const set = new Set<string>();
    expect(takeEntrance(set, "h1", true)).toBe(true);
    expect(takeEntrance(set, "h1", true)).toBe(false);
    expect(takeEntrance(set, "h2", true)).toBe(true);
    expect([...set]).toEqual(["h1", "h2"]);
  });

  test("false in the dark, and the hash is not spent", () => {
    const set = new Set<string>();
    expect(takeEntrance(set, "h1", false)).toBe(false);
    expect(set.size).toBe(0);
    // Shown later, the chart still enters.
    expect(takeEntrance(set, "h1", true)).toBe(true);
    // And once entered, a dark render still answers false without change.
    expect(takeEntrance(set, "h1", false)).toBe(false);
    expect([...set]).toEqual(["h1"]);
  });

  test("evicts the oldest past the limit", () => {
    const set = new Set<string>();
    for (let i = 0; i < ENTRANCE_LIMIT; i++) takeEntrance(set, `h${i}`, true);
    expect(set.size).toBe(ENTRANCE_LIMIT);
    expect(takeEntrance(set, "fresh", true)).toBe(true);
    expect(set.size).toBe(ENTRANCE_LIMIT);
    expect(set.has("h0")).toBe(false);
    expect(set.has("h1")).toBe(true);
    // The evicted hash may enter again.
    expect(takeEntrance(set, "h0", true)).toBe(true);
    expect(set.has("h1")).toBe(false);
  });

  test("a smaller limit is honoured", () => {
    const set = new Set<string>();
    expect(takeEntrance(set, "a", true, 2)).toBe(true);
    expect(takeEntrance(set, "b", true, 2)).toBe(true);
    expect(takeEntrance(set, "c", true, 2)).toBe(true);
    expect([...set]).toEqual(["b", "c"]);
  });
});
