/**
 * gesture-frame-probe.test.ts — the gesture classifier, held as data.
 *
 * The rAF chain needs a browser; the half that decides WHICH gap the gesture
 * happened in does not, and it is the half that can be wrong in a way nobody
 * notices. A classifier that reported `ticks[0] - armedAt` as the gesture's gap
 * would answer every reading with about one frame and look healthy on a deck
 * that froze for a tenth of a second — which is exactly the failure this
 * recorder was built after.
 */

import { describe, expect, test } from "bun:test";

import { SUSPENSION_FLOOR_TICKS } from "@/lib/settle-frame-probe";
import type { GestureFrameDisplay } from "../gesture-frame-probe";
import { classifyGestureFrames } from "../gesture-frame-probe";

const PERIOD = 16;

/**
 * A Studio Display's "looks like 3200x1800" scaled mode over a 6400x3600
 * backing. The classifier carries the mode rather than reading it, so the half
 * that decides which gap holds the gesture stays testable without a browser,
 * and a reading can never be labelled with a mode it was not taken at.
 */
const DISPLAY: GestureFrameDisplay = {
  widthPx: 3200,
  heightPx: 1800,
  devicePixelRatio: 2,
  zoomFactor: 1,
};

/**
 * A steady series of `count` ticks at 16ms from `t0`, with one gap widened.
 *
 * The recorder is armed before the gesture, so the shape a real reading has is
 * a quiet run, one long gap where the gesture landed, and a quiet run after —
 * `120 59 11 12 14 17 …` in the finding this was built from.
 */
function series(
  count: number,
  widen?: { index: number; ms: number },
  t0 = 1000,
): number[] {
  const ticks: number[] = [t0];
  for (let i = 1; i < count; i += 1) {
    const extra = widen !== undefined && widen.index === i - 1 ? widen.ms : 0;
    ticks.push(ticks[i - 1] + PERIOD + extra);
  }
  return ticks;
}

describe("classifyGestureFrames", () => {
  test("the gesture's gap is the one that brackets its stamp, not the first", () => {
    // Ticks at 1000, 1016, 1032, then a 120ms stall, then steady again. The
    // gesture landed inside the stall.
    const ticks = series(20, { index: 2, ms: 104 });
    const gestureAt = ticks[2] + 5;

    const reading = classifyGestureFrames(
      990,
      ticks,
      gestureAt,
      false,
      DISPLAY,
    );

    expect(
      reading.gestureGapIndex,
      "the third gap is the one the stamp falls inside",
    ).toBe(2);
    expect(
      reading.gestureGapMs,
      "and it is 120ms — the dead time, not the arm's own first frame",
    ).toBe(PERIOD + 104);
    expect(
      reading.gaps[reading.gestureGapIndex],
      "the index points into the series a reader is shown",
    ).toBe(reading.gestureGapMs);
  });

  test("the display's period is read off the run and the stall is a gap, not the rate", () => {
    const ticks = series(20, { index: 2, ms: 104 });
    const reading = classifyGestureFrames(
      990,
      ticks,
      ticks[2] + 5,
      false,
      DISPLAY,
    );

    expect(reading.framePeriodMs, "the median gap, not the worst").toBe(PERIOD);
    expect(reading.longestGapMs).toBe(PERIOD + 104);
    expect(reading.gapsOverOneFrame, "exactly the one stall").toBe(1);
    expect(reading.ticks).toBe(20);
  });

  test("a stamp before the first tick reports -1 rather than guessing", () => {
    const ticks = series(20);
    const reading = classifyGestureFrames(990, ticks, 995, false, DISPLAY);

    expect(
      reading.gestureGapMs,
      "the gesture happened before anything was recorded, so no gap holds it",
    ).toBe(-1);
    expect(reading.gestureGapIndex).toBe(-1);
    expect(reading.gestureAt, "the stamp itself is still reported").toBe(995);
  });

  test("a stamp after the last tick reports -1 too", () => {
    const ticks = series(20);
    const reading = classifyGestureFrames(
      990,
      ticks,
      ticks[ticks.length - 1] + 50,
      false,
      DISPLAY,
    );

    expect(reading.gestureGapMs).toBe(-1);
    expect(reading.gestureGapIndex).toBe(-1);
  });

  test("no stamp at all reports -1 and says so with a null origin", () => {
    const reading = classifyGestureFrames(
      990,
      series(20),
      null,
      false,
      DISPLAY,
    );

    expect(reading.gestureAt, "nothing was published since the arm").toBe(null);
    expect(reading.gestureGapMs).toBe(-1);
    expect(reading.gestureGapIndex).toBe(-1);
    expect(
      reading.longestGapMs,
      "the cadence is still a reading — only the gesture is unplaceable",
    ).toBe(PERIOD);
  });

  test("a series under the suspension floor voids the summary", () => {
    // An occluded window suspends rAF outright and produces a handful of ticks
    // with enormous gaps, which reads as a perfect deck if nothing says so.
    const ticks = series(SUSPENSION_FLOOR_TICKS - 1);
    const reading = classifyGestureFrames(
      990,
      ticks,
      ticks[1] + 1,
      false,
      DISPLAY,
    );

    expect(reading.suspended).toBe(true);
    expect(reading.ticks).toBe(SUSPENSION_FLOOR_TICKS - 1);
  });

  test("an empty series is a reading rather than a throw", () => {
    const reading = classifyGestureFrames(990, [], 1000, false, DISPLAY);

    expect(reading.ticks).toBe(0);
    expect(reading.gaps).toEqual([]);
    expect(reading.gestureGapMs).toBe(-1);
    expect(reading.suspended).toBe(true);
  });

  test("a read taken while the chain is still running says so", () => {
    const reading = classifyGestureFrames(990, series(20), null, true, DISPLAY);

    expect(
      reading.running,
      "a reader who takes the reading early must know the series is not final",
    ).toBe(true);
  });

  test("the display mode rides the reading, so a mode cannot be mislabelled", () => {
    // The same gesture is read at two display modes and the two series are
    // compared. That comparison's one failure mode is a person writing the
    // wrong mode beside a series, and a number the page reported itself cannot
    // be written wrong.
    const reading = classifyGestureFrames(
      990,
      series(20),
      null,
      false,
      DISPLAY,
    );

    expect(reading.display).toEqual(DISPLAY);
  });
});
