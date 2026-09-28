/**
 * space-switch-frames.test.ts — the switch record, held as data.
 *
 * The three things this record claims that nothing else does: the budget count
 * is at an absolute 20 ms rather than at the display's period, the first-paint
 * delay is measured from the arming timestamp and so contains the freeze, and a
 * suspended run VOIDS the summary rather than reporting zeros that read as a
 * perfect switch.
 */

import { describe, expect, test } from "bun:test";

import {
  classifySpaceSwitchFrames,
  SWITCH_GAP_BUDGET_MS,
} from "../space-switch-frames";
import { SUSPENSION_FLOOR_TICKS } from "../settle-frame-probe";

const PERIOD = 16;

function ticks(count: number, from = 0, gaps: Record<number, number> = {}): number[] {
  const out = [from];
  for (let i = 1; i < count; i += 1) {
    out.push(out[i - 1] + (gaps[i] ?? PERIOD));
  }
  return out;
}

describe("classifySpaceSwitchFrames", () => {
  test("a smooth switch reports its period and nothing over budget", () => {
    const reading = classifySpaceSwitchFrames("space-b", 0, ticks(40));
    expect(reading.toSpaceId).toBe("space-b");
    expect(reading.ticks).toBe(40);
    expect(reading.framePeriodMs).toBe(PERIOD);
    expect(reading.longestGapMs).toBe(PERIOD);
    expect(reading.gapsOverBudget).toBe(0);
    expect(reading.suspended).toBe(false);
  });

  test("gapsOverBudget counts only gaps over 20ms, whatever the display does", () => {
    // Three gaps at 21 ms: over the absolute budget, and only 1.3× the period,
    // so `gapsOverOneFrame` at its 1.5 tolerance sees none of them. The two
    // counts answering differently on the same run is the point.
    const reading = classifySpaceSwitchFrames(
      "space-b",
      0,
      ticks(40, 0, { 10: 21, 20: 21, 30: 21 }),
    );
    expect(SWITCH_GAP_BUDGET_MS).toBe(20);
    expect(reading.gapsOverBudget).toBe(3);
    expect(reading.gapsOverOneFrame).toBe(0);
  });

  test("firstPaintDelayMs is measured from the armed timestamp", () => {
    // The freeze: armed at the swap commit, and the first rAF tick could not
    // run until the click task ended 280 ms later.
    const reading = classifySpaceSwitchFrames("space-b", 1000, ticks(40, 1280));
    expect(reading.firstPaintDelayMs).toBe(280);
    // No gesture given: the commit is the origin and the render phase is
    // invisible, which is the reading the record gave before it had one.
    expect(reading.commitDelayMs).toBe(0);
  });

  test("given the gesture, firstPaintDelayMs begins there and commitDelayMs is the render phase", () => {
    // The gesture at 1000, the swap commit 75 ms into React's render of the
    // canvas, and the first tick 150 ms after the gesture. The freeze is 150,
    // and a record that began at the commit would have called it 75.
    const reading = classifySpaceSwitchFrames(
      "space-b",
      1075,
      ticks(40, 1150),
      1000,
    );
    expect(reading.firstPaintDelayMs).toBe(150);
    expect(reading.commitDelayMs).toBe(75);
  });

  test("no tick at all reports -1 rather than a delay of zero", () => {
    const reading = classifySpaceSwitchFrames("space-b", 1000, []);
    expect(reading.firstPaintDelayMs).toBe(-1);
    expect(reading.suspended).toBe(true);
  });

  test("a suspended run voids the summary rather than reporting zeros", () => {
    // Four ticks 200 ms apart — what an occluded window produces. Left at zero,
    // `longestGapMs` and the two counts would read as a flawless switch.
    const reading = classifySpaceSwitchFrames(
      "space-b",
      0,
      ticks(SUSPENSION_FLOOR_TICKS - 6, 0, { 1: 200, 2: 200, 3: 200 }),
    );
    expect(reading.suspended).toBe(true);
    expect(reading.longestGapMs).toBe(-1);
    expect(reading.gapsOverOneFrame).toBe(-1);
    expect(reading.gapsOverBudget).toBe(-1);
    // The gap series survives, because it is the evidence the run was suspended
    // rather than rough, and the reader needs it to tell them apart.
    expect(reading.gaps.length).toBeGreaterThan(0);
    // And the first-paint delay survives too: it is measured from one tick, not
    // from the cadence, so a suspension does not make it meaningless.
    expect(reading.firstPaintDelayMs).toBe(0);
  });
});
