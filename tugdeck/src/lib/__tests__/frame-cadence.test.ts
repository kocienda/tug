/**
 * frame-cadence.test.ts — the one cadence definition, held as data.
 *
 * `classifyFrameCadence` is shared by the settle reading and the switch record
 * ([P02]), so a change here moves two instruments at once. The runs below are
 * synthesised at a 16 ms period with a named defect planted in each — including
 * the exact shape the brief's recording measured, one 68 ms gap in an otherwise
 * smooth run — so a classifier that stops noticing one of them fails here.
 */

import { describe, expect, test } from "bun:test";

import {
  classifyFrameCadence,
  FALLBACK_FRAME_PERIOD_MS,
  SUSPENSION_FLOOR_TICKS,
} from "../settle-frame-probe";

const PERIOD = 16;

/** A tick series at `PERIOD`, with `gaps` substituted at the named indices. */
function ticks(count: number, gaps: Record<number, number> = {}): number[] {
  const out = [0];
  for (let i = 1; i < count; i += 1) {
    out.push(out[i - 1] + (gaps[i] ?? PERIOD));
  }
  return out;
}

describe("classifyFrameCadence", () => {
  test("a smooth run reports the display's period and no missed frames", () => {
    const reading = classifyFrameCadence(ticks(40));
    expect(reading.framePeriodMs).toBe(PERIOD);
    expect(reading.longestGapMs).toBe(PERIOD);
    expect(reading.gapsOverOneFrame).toBe(0);
    expect(reading.gaps.length).toBe(39);
    expect(reading.suspended).toBe(false);
  });

  test("one 68ms gap — the shape the recording measured — is one missed frame", () => {
    const reading = classifyFrameCadence(ticks(40, { 20: 68 }));
    // The median is still the display's period: one outlier cannot move it,
    // which is the whole reason the derivation is a median rather than a mean.
    expect(reading.framePeriodMs).toBe(PERIOD);
    expect(reading.longestGapMs).toBe(68);
    expect(reading.gapsOverOneFrame).toBe(1);
    expect(reading.gaps).toContain(68);
  });

  test("a run under the suspension floor says so", () => {
    const reading = classifyFrameCadence(ticks(SUSPENSION_FLOOR_TICKS - 1));
    expect(reading.suspended).toBe(true);
  });

  test("a single-tick run has nothing to say and takes the fallback", () => {
    const reading = classifyFrameCadence([12]);
    expect(reading.framePeriodMs).toBe(FALLBACK_FRAME_PERIOD_MS);
    expect(reading.longestGapMs).toBe(0);
    expect(reading.gaps).toEqual([]);
    expect(reading.suspended).toBe(true);
  });

  test("an empty run takes the fallback rather than dividing by nothing", () => {
    const reading = classifyFrameCadence([]);
    expect(reading.framePeriodMs).toBe(FALLBACK_FRAME_PERIOD_MS);
    expect(reading.gapsOverOneFrame).toBe(0);
    expect(reading.suspended).toBe(true);
  });

  /**
   * The quiet argument's whole purpose. A run whose contended stretch is long
   * would report the long gaps as the display's rate and then call itself
   * smooth against it — so the period comes from the quiet gaps only, and a gap
   * with one contended end is not quiet.
   */
  test("the period is derived from the quiet gaps, not the contended ones", () => {
    // Twelve ticks: the first six quiet at 16 ms, the rest contended at 64 ms.
    const series = [0, 16, 32, 48, 64, 80, 144, 208, 272, 336, 400, 464];
    const quiet = [true, true, true, true, true, true, false, false, false, false, false, false];
    const reading = classifyFrameCadence(series, quiet);
    expect(reading.framePeriodMs).toBe(PERIOD);
    expect(reading.gapsOverOneFrame).toBe(6);
  });

  /**
   * The origin's whole purpose. The dead time before `ticks[0]` has no
   * `ticks[i] - ticks[i-1]` entry, so a freeze between the gesture and the
   * first rendering opportunity was invisible here by construction — and it is
   * the one number a fold's record exists to carry.
   */
  test("an origin enters the series as a leading gap", () => {
    const series = ticks(20);
    const reading = classifyFrameCadence(series, undefined, -90);
    expect(reading.gaps[0], "the lead leads the series").toBe(90);
    expect(reading.gaps.length, "one gap more than the ticks have between them").toBe(20);
    expect(reading.longestGapMs).toBe(90);
    expect(reading.gapsOverOneFrame).toBe(1);
  });

  test("the leading gap never becomes the display's period", () => {
    const series = ticks(20);
    const reading = classifyFrameCadence(series, undefined, -90);
    expect(
      reading.framePeriodMs,
      "the lead is the most contended stretch of the run, so it says nothing about the display",
    ).toBe(PERIOD);
  });

  test("no origin leaves the series exactly as it was", () => {
    const series = ticks(20);
    expect(classifyFrameCadence(series).gaps).toEqual(
      classifyFrameCadence(series, undefined, undefined).gaps,
    );
  });

  test("a run with no quiet gap at all falls back to all of them", () => {
    const series = ticks(20);
    const reading = classifyFrameCadence(series, series.map(() => false));
    expect(reading.framePeriodMs).toBe(PERIOD);
    expect(reading.gapsOverOneFrame).toBe(0);
  });
});
