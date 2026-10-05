/**
 * flowNextStop — where a released swipe settles, and how far a flick carries.
 *
 * A lifted hand's speed is projected `FLOW_FLICK_COAST_S` × sensitivity
 * seconds on, and the strip lands on the stop ahead nearest that aim: never
 * behind the hand, never short of the first stop ahead, and never anywhere
 * the strip cannot scroll to.
 *
 * Pure math over a hand-built strip — no DOM, no store, no fixtures.
 */

import { describe, expect, test } from "bun:test";

import {
  FLOW_FLICK_COAST_S,
  FLOW_FLICK_SENSITIVITY,
  flowNextStop,
  type FlowStrip,
} from "@/lib/layout-imposer";

/** Eight 400px slots with 5px gaps: stops every 405px, through a band of 800,
 *  so the far clamp is 3235 - 800 = 2435. */
const EXTENT = 400;
const GAP = 5;
const PITCH = EXTENT + GAP;
const BAND = 800;
const positions = new Map<number, number>();
const extents = new Map<number, number>();
for (let slot = 0; slot < 8; slot++) {
  positions.set(slot, slot * PITCH);
  extents.set(slot, EXTENT);
}
const strip: FlowStrip = { positions, extents, width: 8 * EXTENT + 7 * GAP };
const FAR_END = strip.width - BAND;

/** A speed whose projection reaches `px` at the shipped sensitivity. */
const speedFor = (px: number): number =>
  px / (FLOW_FLICK_COAST_S * FLOW_FLICK_SENSITIVITY);

const stop = (offset: number, direction: number, velocity?: number, sensitivity?: number) =>
  flowNextStop({ strip, band: BAND, offset, direction, velocity, sensitivity });

describe("a release with no speed", () => {
  test("lands on the next stop ahead", () => {
    expect(stop(200, 1)).toBe(PITCH);
    expect(stop(1000, -1)).toBe(2 * PITCH);
  });
});

describe("a lifted hand's speed", () => {
  test("a slow hand lands on the next stop, as it always did", () => {
    expect(stop(200, 1, speedFor(120))).toBe(PITCH);
  });

  test("a hand too slow to reach the first stop is never left short of it", () => {
    expect(stop(200, 1, speedFor(10))).toBe(PITCH);
  });

  test("a quick hand skips to the stop ahead nearest its aim", () => {
    // Aim 200 + 800 = 1000: 810 is 190 away, 1215 is 215.
    expect(stop(200, 1, speedFor(800))).toBe(2 * PITCH);
    // Aim 200 + 1100 = 1300: 1215 is 85 away.
    expect(stop(200, 1, speedFor(1100))).toBe(3 * PITCH);
  });

  test("a flick past the far end lands on the far clamp", () => {
    expect(stop(200, 1, speedFor(10_000))).toBe(FAR_END);
  });

  test("a flick toward the near end skips the same way", () => {
    // From 1000 heading back — the offset falling, so the speed negative —
    // aim 1000 - 600 = 400: 405 is 5 away.
    expect(stop(1000, -1, -speedFor(600))).toBe(PITCH);
    expect(stop(1000, -1, -speedFor(10_000))).toBe(0);
  });

  test("speed against the direction carries nothing, and never backwards", () => {
    expect(stop(200, 1, -speedFor(5_000))).toBe(PITCH);
    expect(stop(1000, -1, speedFor(5_000))).toBe(2 * PITCH);
  });
});

describe("the sensitivity", () => {
  test("zero turns flicking off", () => {
    expect(stop(200, 1, speedFor(800), 0)).toBe(PITCH);
  });

  test("a higher value carries the same hand further", () => {
    // Aim 200 + 1600 = 1800: 1620 is 180 away, 2025 is 225.
    expect(stop(200, 1, speedFor(800), FLOW_FLICK_SENSITIVITY * 2)).toBe(4 * PITCH);
  });
});
