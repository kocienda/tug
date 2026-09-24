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
    appliedTranslate: null,
    curveTranslate: null,
    hasTransformEffect: false,
    ...overrides,
  };
}

/**
 * A pane standing exactly where its own curve says it should.
 *
 * The default `pane()` carries no transform-bearing effect at all, which is
 * Spec S01's fourth case — never comparable. This is the on-curve pane for a
 * run that is actually animating: an effect present, and the applied pose
 * equal to the expected one.
 */
function onCurve(
  paneId: string,
  at: readonly [number, number],
  overrides: Partial<SettleFramePaneSample> = {},
): SettleFramePaneSample {
  return pane(paneId, {
    hasTransformEffect: true,
    appliedTranslate: at,
    curveTranslate: at,
    animations: 1,
    ...overrides,
  });
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
  /** Ticks from the head of the move that read `movePending` — the window. */
  pendingTicks?: number;
  panes?: (tick: number) => SettleFramePaneSample[];
}): SettleFrameSample[] {
  const {
    ticks,
    quiet,
    gapAt,
    zeroClockTicks = 0,
    pendingTicks = 0,
    panes,
  } = opts;
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
      movePending: moving && i < quiet + pendingTicks,
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

  test("a frame standing where its curve says is on-curve, and half a pixel out still is", () => {
    const exact = classifySettleFrames(
      run({
        ticks: 40,
        quiet: 10,
        panes: (tick) =>
          tick < 10 ? [pane("p1")] : [onCurve("p1", [12, 4])],
      }),
    );
    expect(exact.offCurveTicks, "the applied pose equals the expected one").toBe(
      0,
    );

    const inside = classifySettleFrames(
      run({
        ticks: 40,
        quiet: 10,
        panes: (tick) =>
          tick < 10
            ? [pane("p1")]
            : [onCurve("p1", [12, 4], { appliedTranslate: [12.4, 4] })],
      }),
    );
    expect(
      inside.offCurveTicks,
      "0.4px is inside the half-pixel floor pane-flip's callers round to",
    ).toBe(0);

    const outside = classifySettleFrames(
      run({
        ticks: 40,
        quiet: 10,
        panes: (tick) =>
          tick < 10
            ? [pane("p1")]
            : [onCurve("p1", [12, 4], { appliedTranslate: [12.6, 4] })],
      }),
    );
    expect(outside.offCurveTicks, "0.6px is off the curve").toBe(30);
    expect(outside.offCurvePaneIds).toEqual(["p1"]);
  });

  test("a pane that never carried a transform effect is never off-curve", () => {
    // Spec S01's fourth case: a `holdPlan.held` frame wears an inline inverse
    // and never animates, and a survivor in a three-beat settle wears its
    // opening pose through the beats that run before its own. Both compute a
    // translate nothing is carrying, and neither is a defect.
    const reading = classifySettleFrames(
      run({
        ticks: 40,
        quiet: 10,
        panes: (tick) => [
          tick < 10 ? pane("mover") : onCurve("mover", [0, 0]),
          pane("held", { appliedTranslate: [-300, 0] }),
        ],
      }),
    );

    expect(
      reading.offCurveTicks,
      "a pose with no curve to be off is not comparable",
    ).toBe(0);
    expect(reading.offCurvePaneIds).toEqual([]);
  });

  test("a pane whose beat has ended owes the identity, and a residual translate is off it", () => {
    // Spec S01's case 3: the effect appeared at tick 3 and is gone by tick 9.
    // TugAnimator commits and cancels, so the frame carries no effect — but it
    // is committed at Last, so the only pose it may compute is the identity.
    const withResidue = classifySettleFrames(
      run({
        ticks: 40,
        quiet: 0,
        panes: (tick) => [
          tick >= 3 && tick < 9
            ? onCurve("p1", [10, 0])
            : tick >= 9
              ? pane("p1", { appliedTranslate: [10, 0] })
              : pane("p1"),
        ],
      }),
    );
    expect(
      withResidue.offCurveTicks,
      "an opening pose outliving its own beat is the land() hop — from tick " +
        "10 rather than 9, because the hand-off tick itself is admitted: the " +
        "frame may still be reading the pose its own last effect held",
    ).toBe(30);

    const landed = classifySettleFrames(
      run({
        ticks: 40,
        quiet: 0,
        panes: (tick) => [
          tick >= 3 && tick < 9
            ? onCurve("p1", [10, 0])
            : tick >= 9
              ? pane("p1", { appliedTranslate: null })
              : pane("p1"),
        ],
      }),
    );
    expect(
      landed.offCurveTicks,
      "the same pane computing no transform is standing at Last",
    ).toBe(0);
  });

  test("a frame painting its destination while its curve says its origin is off-curve", () => {
    // The pending window, which is the defect itself: the effect exists, its
    // local time is unresolved so the expected pose is keyframe 0 — the
    // origin — and the element is computing the identity, which for a FLIP is
    // where the commit already put it.
    const reading = classifySettleFrames(
      run({
        ticks: 40,
        quiet: 10,
        pendingTicks: 4,
        panes: (tick) =>
          tick < 10
            ? [pane("p1")]
            : tick < 14
              ? [
                  pane("p1", {
                    hasTransformEffect: true,
                    animations: 1,
                    curveTranslate: [-200, 0],
                    appliedTranslate: [0, 0],
                  }),
                ]
              : [onCurve("p1", [-100, 0])],
      }),
    );

    expect(
      reading.offCurveTicks,
      "four ticks of the destination shown while the curve said the origin",
    ).toBe(4);
    expect(reading.longestOffCurveRunTicks).toBe(4);
  });

  test("a null applied translate reads as the identity on both sides of the comparison", () => {
    const atRest = classifySettleFrames(
      run({
        ticks: 40,
        quiet: 10,
        panes: (tick) =>
          tick < 10
            ? [pane("p1")]
            : [
                pane("p1", {
                  hasTransformEffect: true,
                  animations: 1,
                  curveTranslate: [0, 0],
                  appliedTranslate: null,
                }),
              ],
      }),
    );
    expect(
      atRest.offCurveTicks,
      "no transform computed and a curve saying the identity agree",
    ).toBe(0);

    const adrift = classifySettleFrames(
      run({
        ticks: 40,
        quiet: 10,
        panes: (tick) =>
          tick < 10
            ? [pane("p1")]
            : [
                pane("p1", {
                  hasTransformEffect: true,
                  animations: 1,
                  curveTranslate: [-200, 0],
                  appliedTranslate: null,
                }),
              ],
      }),
    );
    expect(
      adrift.offCurveTicks,
      "computing no transform is standing at the committed pose, not an absence of one — every tick but the last, which is the one tick the curve's pinned end pose is admitted on",
    ).toBe(29);
  });

  test("the longest off-curve run is the island, measured from the move's own start", () => {
    // An island at ticks 20-24 of a run whose move began at tick 10.
    const reading = classifySettleFrames(
      run({
        ticks: 40,
        quiet: 10,
        panes: (tick) => {
          if (tick < 10) return [pane("p1")];
          if (tick >= 20 && tick < 25) {
            return [onCurve("p1", [5, 0], { appliedTranslate: [50, 0] })];
          }
          return [onCurve("p1", [5, 0])];
        },
      }),
    );

    expect(reading.longestOffCurveRunTicks, "the island's length").toBe(5);
    expect(
      reading.longestOffCurveRunOffsetMs,
      "ten periods from the first tick a transform effect existed",
    ).toBe(PERIOD * 10);
  });

  test("the off-curve run offset is -1 on a clean run", () => {
    const reading = classifySettleFrames(
      run({
        ticks: 40,
        quiet: 10,
        panes: (tick) => (tick < 10 ? [pane("p1")] : [onCurve("p1", [5, 0])]),
      }),
    );

    expect(reading.offCurveTicks).toBe(0);
    expect(reading.longestOffCurveRunTicks).toBe(0);
    expect(
      reading.longestOffCurveRunOffsetMs,
      "no run means no offset, and zero would read as a run at the start",
    ).toBe(-1);
  });

  test("firstPaintDelayMs measures the pending window rather than skipping it", () => {
    // Three ticks with a move that exists and has not started — `movePending`
    // with a `currentTime` of 0 — before the clock advances. The shipped read
    // opened its window on `moveCurrentTime !== null` alone and so started
    // counting at the first tick the move was ALREADY running, which is why
    // this field could only ever report ~0 however wide the window was.
    const reading = classifySettleFrames(
      run({ ticks: 40, quiet: 10, zeroClockTicks: 3, pendingTicks: 3 }),
    );

    expect(
      reading.firstPaintDelayMs,
      "the wall-clock span of the three pending ticks",
    ).toBe(PERIOD * 3);
    expect(reading.pendingTicks, "and the window is counted separately").toBe(3);
  });

  test("firstPaintDelayMs is -1 when no transform-bearing effect ever appeared", () => {
    const reading = classifySettleFrames(run({ ticks: 40, quiet: 40 }));

    expect(reading.firstPaintDelayMs).toBe(-1);
    expect(reading.pendingTicks).toBe(0);
  });

  test("pendingTicks counts the window and says nothing about off-curve", () => {
    // The two are separate facts now: a move can be pending for four ticks and
    // the frame can be holding its origin through every one of them, which is
    // what a backwards fill buys and what a pendingness-derived `offCurve`
    // could never have reported.
    const reading = classifySettleFrames(
      run({
        ticks: 40,
        quiet: 10,
        pendingTicks: 4,
        panes: (tick) =>
          tick < 10 ? [pane("p1")] : [onCurve("p1", [-200, 0])],
      }),
    );

    expect(reading.pendingTicks, "the window is still measured").toBe(4);
    expect(
      reading.offCurveTicks,
      "and the frame held its start pose through all of it",
    ).toBe(0);
  });

  test("a frame already at its destination on its effect's LAST tick is on-curve", () => {
    // The curve's final keyframe is pinned to the identity, so a frame that
    // reaches it a fraction of a frame early on the tick the effect ends has
    // arrived rather than skipped its travel. There is no tick after it to
    // bound the band, so the end pose has to be admitted by name.
    const reading = classifySettleFrames(
      run({
        ticks: 40,
        quiet: 10,
        panes: (tick) => {
          if (tick < 10 || tick > 30) return [pane("p1")];
          const curve: [number, number] = [-200 + (tick - 10) * 9, 0];
          // The last tick carrying an effect computes the identity already.
          return tick === 30
            ? [onCurve("p1", curve, { appliedTranslate: [0, 0] })]
            : [onCurve("p1", curve)];
        },
      }),
    );

    expect(reading.offCurveTicks).toBe(0);
  });

  test("a frame at its destination BEFORE its effect's last tick is still off-curve", () => {
    // The widening above is one tick wide on purpose: the defect this bar
    // exists to catch is a frame wearing Last while its curve says it is still
    // travelling, and admitting the end pose everywhere would retire the bar.
    const reading = classifySettleFrames(
      run({
        ticks: 40,
        quiet: 10,
        panes: (tick) => {
          if (tick < 10 || tick > 30) return [pane("p1")];
          const curve: [number, number] = [-200 + (tick - 10) * 9, 0];
          return tick === 20
            ? [onCurve("p1", curve, { appliedTranslate: [0, 0] })]
            : [onCurve("p1", curve)];
        },
      }),
    );

    expect(reading.offCurveTicks).toBe(1);
  });

  test("the fixed-descendant count is the worst tick, not the last", () => {
    const samples = run({ ticks: 40, quiet: 10 }).map((sample, index) => ({
      ...sample,
      fixedDescendants: index === 12 ? 3 : 0,
    }));

    expect(classifySettleFrames(samples).fixedDescendants).toBe(3);
  });
});
