import { describe, expect, it } from "bun:test";

import {
  ACTIVITY_BIN_MS,
  ACTIVITY_WINDOW_BINS,
  GaugeMeter,
  RateMeter,
} from "../activity-meter";

const B = 250;

describe("RateMeter", () => {
  it("accumulates units into the bin for their timestamp", () => {
    const m = new RateMeter(B, 5);
    m.record(10, 0);
    m.record(5, 100); // same bin as t=0
    m.record(20, 250); // next bin
    const s = m.series(250);
    // window of 5 bins ending at bin 1: [.. , bin0=15, bin1=20]
    expect(s[s.length - 1]).toBe(20);
    expect(s[s.length - 2]).toBe(15);
  });

  it("zero-fills idle bins so a stalled stream decays to a flat line", () => {
    const m = new RateMeter(B, 4);
    m.record(40, 0);
    // Advance well past the window with no records.
    const s = m.series(10 * B);
    expect(s.every((v) => v === 0)).toBe(true);
  });

  it("ignores non-positive records", () => {
    const m = new RateMeter(B, 3);
    m.record(0, 0);
    m.record(-5, 0);
    expect(m.series(0).every((v) => v === 0)).toBe(true);
  });

  it("has no held raw value", () => {
    expect(new RateMeter(B, 3).raw()).toBeNull();
  });
});

describe("GaugeMeter", () => {
  it("holds the last value indefinitely — no news is no news", () => {
    const m = new GaugeMeter(B, 4);
    m.record(143, 1_000);
    // Long after the last sample: the emitter only publishes on change,
    // so the held level remains the truth until a new sample moves it.
    const s = m.series(500_000);
    expect(s.every((v) => v === 143)).toBe(true);
    expect(m.raw(500_000)).toBe(143);
  });

  it("falls to zero only when the emitter says so (the final zero frame)", () => {
    const m = new GaugeMeter(B, 4);
    m.record(143, 1_000);
    m.record(0, 60_000);
    // The final zero moves the newest bin and the held level; the bins behind
    // it keep the level the session actually had — the fall is a step in the
    // picture, not an erasure of the past.
    const s = m.series(60_000);
    expect(s[s.length - 1]).toBe(0);
    expect(s.slice(0, -1).every((v) => v === 143)).toBe(true);
    expect(m.raw(60_000)).toBe(0);
  });

  it("holds a level across a gap without smearing it over the window", () => {
    // The [F08] regression: a gauge row used to have no past at all, so every
    // read filled the whole window with the current level. The level now
    // occupies exactly the bins it was held through, and the bins before the
    // first sample stay zero rather than inventing a past.
    const m = new GaugeMeter(B, 8);
    m.record(50, 0);
    expect(m.series(4 * B)).toEqual([0, 0, 0, 50, 50, 50, 50, 50]);
  });

  it("steps to the new level at the bin the sample arrived in", () => {
    const m = new GaugeMeter(B, 6);
    m.record(50, 0);
    m.record(90, 2 * B);
    // Bins -2..3 at head bin 3: two before the first sample, then 50 held
    // through bin 1, then 90 from its own bin onward.
    expect(m.series(3 * B)).toEqual([0, 0, 50, 50, 90, 90]);
  });

  it("tracks the newest sample, replacing the prior level", () => {
    const m = new GaugeMeter(B, 4);
    m.record(50, 0);
    m.record(90, 500);
    expect(m.raw(600)).toBe(90);
  });

  it("ignores non-finite samples", () => {
    const m = new GaugeMeter(B, 4);
    m.record(Number.NaN, 0);
    expect(m.raw(0)).toBeNull();
    expect(m.series(0).every((v) => v === 0)).toBe(true);
  });

  it("indexes on the same absolute wall-clock grid as RateMeter", () => {
    // Both meters must answer for the same bin when read at one clock, or a
    // card's gauge rows would be drawn a bin apart from its rate rows.
    const rate = new RateMeter(B, 6);
    const gauge = new GaugeMeter(B, 6);
    const t = 1_763_000_000_000;
    rate.record(7, t);
    gauge.record(7, t);
    const r = rate.series(t);
    const g = gauge.series(t);
    expect(r[r.length - 1]).toBe(7);
    expect(g[g.length - 1]).toBe(7);
  });
});

describe("the retained window", () => {
  it("covers the visible span plus the instrument's display lag", () => {
    // The window is what the sparkline draws its whole picture from, so it
    // must reach back past the left edge of what is on screen: 15 s visible
    // plus the two-bin lag the instrument draws behind the clock.
    const visibleMs = 15_000;
    const displayLagMs = 2 * ACTIVITY_BIN_MS;
    expect(ACTIVITY_WINDOW_BINS * ACTIVITY_BIN_MS).toBeGreaterThanOrEqual(
      visibleMs + displayLagMs,
    );
  });
});
