/**
 * settle-frame-probe.test.ts — the classifier, held as data.
 *
 * The probe's interesting half is a function over plain samples, which is the
 * whole reason `[P01]` builds it as a module rather than as an eval string: the
 * questions it answers — "is this gap longer than two frames", "was the first
 * painted frame within one frame of the animation's start" — are decidable
 * without a browser, and a browser is the one place they are expensive to ask.
 *
 * Every run below is synthesised at a 16ms period with a named defect planted
 * in it, so a change to the classifier that stops noticing one of them fails
 * here rather than in an app-test nobody can reproduce.
 */

import { describe, expect, test } from "bun:test";

import {
  classifySettleFrames,
  FALLBACK_FRAME_PERIOD_MS,
  SUSPENSION_FLOOR_TICKS,
  type SettleFramePaneSample,
  type SettleFrameSample,
} from "../settle-frame-probe";

const PERIOD = 16;

function pane(
  paneId: string,
  overrides: Partial<SettleFramePaneSample> = {},
): SettleFramePaneSample {
  return {
    paneId,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    opacity: 1,
    animations: 0,
    offendingProperties: [],
    offCurve: false,
    ...overrides,
  };
}

/**
 * A run of `ticks` ticks at a steady 16ms, quiet for the first `quiet` of them
 * and then running a move animation whose clock advances one period per tick.
 *
 * The quiet head is what the classifier derives the display's period from, so
 * every fixture needs one unless it is deliberately testing a run that has none.
 */
function run(opts: {
  ticks: number;
  quiet: number;
  gapAt?: { index: number; extraMs: number };
  zeroClockTicks?: number;
  panes?: (tick: number) => SettleFramePaneSample[];
}): SettleFrameSample[] {
  const { ticks, quiet, gapAt, zeroClockTicks = 0, panes } = opts;
  const samples: SettleFrameSample[] = [];
  let t = 0;
  let clock = 0;
  for (let i = 0; i < ticks; i += 1) {
    if (i > 0) {
      t += PERIOD + (gapAt !== undefined && gapAt.index === i ? gapAt.extraMs : 0);
    }
    const moving = i >= quiet;
    if (moving && i >= quiet + zeroClockTicks) clock += PERIOD;
    samples.push({
      t,
      moveCurrentTime: moving ? clock : null,
      movePending: false,
      frames: panes?.(i) ?? [pane("p1", { animations: moving ? 1 : 0 })],
      fixedDescendants: 0,
    });
  }
  return samples;
}

describe("classifySettleFrames", () => {
  test("a clean run reports a derived period and no gaps", () => {
    const reading = classifySettleFrames(run({ ticks: 40, quiet: 10 }));

    expect(reading.suspended, "a 40-tick run is not suspended").toBe(false);
    expect(
      reading.framePeriodMs,
      "the period is read off the quiet head, not assumed",
    ).toBe(PERIOD);
    expect(reading.gapsOverOneFrame, "nothing was missed").toBe(0);
    expect(
      reading.longestGapFrames,
      "the longest gap is one frame",
    ).toBeCloseTo(1, 5);
    expect(reading.firstPaintDelayMs, "the tween advanced at birth").toBe(0);
    expect(reading.minOpacity, "nothing faded").toBe(1);
    expect(reading.violations, "nothing animated a paint property").toEqual([]);
    expect(reading.rectsChangedAfterLanding, "nothing moved at rest").toEqual(
      [],
    );
  });

  test("a run carrying one three-frame gap reports it in frames", () => {
    const reading = classifySettleFrames(
      run({ ticks: 40, quiet: 10, gapAt: { index: 14, extraMs: PERIOD * 2 } }),
    );

    expect(reading.suspended).toBe(false);
    expect(reading.framePeriodMs, "one long gap does not move the median").toBe(
      PERIOD,
    );
    expect(reading.longestGapMs, "the gap is three periods wide").toBe(
      PERIOD * 3,
    );
    expect(reading.longestGapFrames, "reported in display frames").toBeCloseTo(
      3,
      5,
    );
    expect(reading.gapsOverOneFrame, "exactly one gap was over a frame").toBe(1);
  });

  test("a run whose first paint is late separates a late START from a late PAINT", () => {
    // The tween exists for three ticks before its clock moves — the long-task
    // signature, where the animation was created and then nothing rendered.
    const reading = classifySettleFrames(
      run({ ticks: 40, quiet: 10, zeroClockTicks: 3 }),
    );

    expect(
      reading.firstPaintDelayMs,
      "three quiet periods between the move's birth and its first advance",
    ).toBe(PERIOD * 3);
    expect(
      reading.gapsOverOneFrame,
      "and the wall clock never blew out — this is the OTHER failure",
    ).toBe(0);
  });

  test("a run with no move animation at all reports -1 rather than zero", () => {
    const reading = classifySettleFrames(run({ ticks: 40, quiet: 40 }));

    expect(
      reading.firstPaintDelayMs,
      "there was no move to be late; zero would read as a perfect one",
    ).toBe(-1);
  });

  test("too few ticks voids the whole reading", () => {
    const reading = classifySettleFrames(
      run({ ticks: SUSPENSION_FLOOR_TICKS - 1, quiet: 2 }),
    );

    expect(
      reading.suspended,
      "an occluded window suspends rAF and produces exactly this",
    ).toBe(true);
  });

  test("no samples at all classify to a void reading rather than throwing", () => {
    const reading = classifySettleFrames([]);

    expect(reading.ticks).toBe(0);
    expect(reading.suspended).toBe(true);
    expect(reading.framePeriodMs).toBe(FALLBACK_FRAME_PERIOD_MS);
  });

  test("an offending property is reported as paneId:property, once", () => {
    const reading = classifySettleFrames(
      run({
        ticks: 40,
        quiet: 10,
        panes: (tick) => [
          pane("p1", { animations: tick >= 10 ? 1 : 0 }),
          pane("p2", {
            animations: tick >= 10 ? 1 : 0,
            offendingProperties: tick >= 10 ? ["boxShadow"] : [],
          }),
        ],
      }),
    );

    expect(
      reading.violations,
      "the pane and the property it animated, deduped across ticks",
    ).toEqual(["p2:boxShadow"]);
  });

  test("every offending property gets its own entry, splittable at the first colon", () => {
    const reading = classifySettleFrames(
      run({
        ticks: 40,
        quiet: 10,
        panes: (tick) => [
          pane("p1", {
            animations: tick >= 10 ? 2 : 0,
            offendingProperties: tick >= 10 ? ["height", "backgroundColor"] : [],
          }),
        ],
      }),
    );

    // Both guards read this field and both parse it the same way: [D9]'s
    // runtime guard writes one `settle-motion-violation` row per entry,
    // splitting at the FIRST colon into pane and property. A property name
    // carries no colon, so the split is exact — this is the claim that keeps
    // it that way, because a second entry silently folded into the first
    // would under-report a frame animating two things at once.
    expect(reading.violations.length, "one entry per property").toBe(2);
    expect(
      reading.violations.map((v) => {
        const colon = v.indexOf(":");
        return { paneId: v.slice(0, colon), property: v.slice(colon + 1) };
      }),
    ).toEqual([
      { paneId: "p1", property: "height" },
      { paneId: "p1", property: "backgroundColor" },
    ]);
  });

  test("a frame that moves after the landing is named", () => {
    const reading = classifySettleFrames(
      run({
        ticks: 40,
        quiet: 10,
        panes: (tick) => [
          // Animating through tick 29, at rest afterwards.
          pane("p1", { animations: tick >= 10 && tick < 30 ? 1 : 0 }),
          // And p2 jumps 40px at tick 35, with nothing carrying it.
          pane("p2", { x: tick >= 35 ? 40 : 0 }),
        ],
      }),
    );

    expect(
      reading.rectsChangedAfterLanding,
      "a rect that changes once the deck is at rest changed uncarried",
    ).toEqual(["p2"]);
  });

  test("the lowest opacity is reported with where it was seen", () => {
    const reading = classifySettleFrames(
      run({
        ticks: 40,
        quiet: 10,
        panes: (tick) => [
          pane("p1"),
          pane("p2", { opacity: tick === 20 ? 0.25 : 1 }),
        ],
      }),
    );

    expect(reading.minOpacity).toBe(0.25);
    expect(reading.minOpacityPaneId).toBe("p2");
  });

  test("a run with no quiet head still derives a period from its own gaps", () => {
    const reading = classifySettleFrames(run({ ticks: 40, quiet: 0 }));

    expect(
      reading.framePeriodMs,
      "the probe armed mid-settle; the run's own gaps answer",
    ).toBe(PERIOD);
  });

  test("the fixed-descendant count is the worst tick, not the last", () => {
    const samples = run({ ticks: 40, quiet: 10 }).map((sample, index) => ({
      ...sample,
      fixedDescendants: index === 12 ? 3 : 0,
    }));

    expect(classifySettleFrames(samples).fixedDescendants).toBe(3);
  });
});
