/**
 * imposer-motion.test.ts — the choreography is a table, so it is testable.
 *
 * These assertions are the recipe table restated as behavior: what each curve
 * has to do at its ends, how much a given damping ratio is allowed to overshoot
 * by, that the relative timings hold, and that a hand's velocity carries into a
 * landing without being able to throw the card off the deck.
 *
 * Pure math over pure functions — no DOM, no store, no fixtures.
 */

import { describe, expect, test } from "bun:test";

import {
  MAX_INITIAL_VELOCITY,
  motionDurationMs,
  motionKeyframes,
  motionSolver,
  progressAt,
  velocityAlongTravel,
  velocityAt,
  type MotionRecipe,
} from "../imposer-motion";

/** The deck's shipped crossing window. */
const NOMINAL = 360;

const SPRINGS: MotionRecipe[] = ["crossing", "landing", "reveal"];
const ALL: MotionRecipe[] = [...SPRINGS, "divide-join"];

describe("every recipe's curve is a curve", () => {
  test("starts at 0 and ends at exactly 1", () => {
    for (const recipe of ALL) {
      const { progress } = motionKeyframes(recipe, { nominalMs: NOMINAL });
      expect(progress.length, `${recipe} has at least two ends`).toBeGreaterThanOrEqual(2);
      expect(progress[0], `${recipe} starts at rest`).toBe(0);
      expect(
        progress[progress.length - 1],
        `${recipe} lands exactly on its target`,
      ).toBe(1);
    }
  });

  test("a spring recipe is sampled finely enough to read as motion", () => {
    // The shape is sampled over the spring's own settle, so the count is a
    // property of the curve rather than of the window it is played over.
    // Enough stops that the chords between them are invisible.
    for (const recipe of SPRINGS) {
      const { progress } = motionKeyframes(recipe, { nominalMs: NOMINAL });
      expect(
        progress.length,
        `${recipe} is sampled finely`,
      ).toBeGreaterThanOrEqual(30);
    }
  });

  test("a spring accelerates from rest rather than jumping", () => {
    // The integrator's failure mode when it is pushed out of its accurate
    // range is a huge first step — the shape parameter exists to keep it in
    // range, and this is the assertion that says so.
    for (const recipe of SPRINGS) {
      const { progress } = motionKeyframes(recipe, { nominalMs: NOMINAL });
      expect(
        progress[1],
        `${recipe} leaves gently`,
      ).toBeLessThan(0.05);
      // The fastest part of the motion is somewhere in the middle, not at
      // the very start — a curve whose largest step is its first is one that
      // jumped and then crawled, which is the shape a badly-conditioned
      // integrator produces.
      const steps = progress
        .slice(1)
        .map((v, i) => v - progress[i]);
      const fastest = steps.indexOf(Math.max(...steps));
      expect(
        fastest,
        `${recipe} reaches its top speed after leaving, not at the first frame`,
      ).toBeGreaterThan(2);
    }
  });

  test("the fade is two stops, because a straight line has no shape to sample", () => {
    expect(motionKeyframes("divide-join", { nominalMs: NOMINAL }).progress).toEqual([
      0, 1,
    ]);
  });
});

describe("damping ratio governs overshoot", () => {
  test("the critically damped recipes never pass their target", () => {
    for (const recipe of ["crossing", "reveal"] as MotionRecipe[]) {
      const { progress } = motionKeyframes(recipe, { nominalMs: NOMINAL });
      // The last sample is clamped to 1 by construction; the interesting
      // claim is about everything before it.
      const peak = Math.max(...progress.slice(0, -1));
      expect(peak, `${recipe} does not overshoot`).toBeLessThanOrEqual(1.0001);
    }
  });

  test("the landing's weight shows when the hand throws it, not when it lets go still", () => {
    // ζ = 0.9 is only just underdamped: its theoretical overshoot from rest
    // is exp(-πζ/√(1-ζ²)) ≈ 0.15% of the travel, which is under a pixel on
    // any travel a deck has. So a card released MOTIONLESS onto its zone
    // arrives with no visible bounce, and that is what 0.9 means.
    const atRest = motionKeyframes("landing", { nominalMs: NOMINAL });
    expect(
      Math.max(...atRest.progress.slice(0, -1)),
      "a still release lands without a visible bounce",
    ).toBeLessThanOrEqual(1.0001);

    // The weight the recipe is for appears when there is momentum to carry:
    // a card let go mid-flick passes its zone and comes back.
    const thrown = motionKeyframes("landing", {
      nominalMs: NOMINAL,
      initialVelocity: 2.5,
    });
    const peak = Math.max(...thrown.progress);
    expect(peak, "a thrown release overshoots").toBeGreaterThan(1.01);
    expect(peak, "by well under a tenth of the travel").toBeLessThan(1.1);
  });

  test("a critically damped recipe launched at speed overshoots once, and does not ring", () => {
    // ζ = 1.0 promises no overshoot FROM REST. Launched with momentum toward
    // the target, any spring passes it — that is the momentum being honored,
    // not the damping failing, and it is what makes a velocity-matched
    // retarget continue the motion rather than restart it. What critical
    // damping still guarantees is that it comes back once and stays: no
    // second crossing, no ring.
    for (const recipe of ["crossing", "reveal"] as MotionRecipe[]) {
      const { progress } = motionKeyframes(recipe, {
        nominalMs: NOMINAL,
        initialVelocity: MAX_INITIAL_VELOCITY,
      });
      const peak = Math.max(...progress.slice(0, -1));
      expect(peak, `${recipe} carries its momentum past the target`).toBeGreaterThan(1);
      expect(peak, `${recipe} keeps the overshoot small`).toBeLessThan(1.1);
      // Count sign changes of (value - 1): a ringing spring crosses the
      // target repeatedly, a settling one crosses it at most once.
      let crossings = 0;
      for (let i = 1; i < progress.length - 1; i += 1) {
        const before = progress[i - 1] - 1;
        const after = progress[i] - 1;
        if (before < 0 && after > 0) crossings += 1;
        if (before > 0 && after < 0) crossings += 1;
      }
      expect(
        crossings,
        `${recipe} crosses its target at most twice — out and back`,
      ).toBeLessThanOrEqual(2);
    }
  });
});

describe("timing is relative to the crossing's nominal", () => {
  test("the table's multiples hold", () => {
    expect(motionDurationMs("crossing", NOMINAL)).toBe(NOMINAL);
    expect(motionDurationMs("reveal", NOMINAL)).toBe(NOMINAL);
    expect(motionDurationMs("landing", NOMINAL)).toBeCloseTo(NOMINAL * 0.85, 5);
    expect(motionDurationMs("divide-join", NOMINAL)).toBeCloseTo(
      NOMINAL * 0.6,
      5,
    );
  });

  test("turning the one knob retimes the whole table in proportion", () => {
    const slow = 720;
    for (const recipe of ALL) {
      expect(
        motionDurationMs(recipe, slow) / motionDurationMs(recipe, NOMINAL),
        `${recipe} scales with the nominal`,
      ).toBeCloseTo(2, 6);
    }
  });

  test("the shape sampled is a settled spring, not a spring cut off partway", () => {
    for (const recipe of SPRINGS) {
      const solver = motionSolver(recipe, { nominalMs: NOMINAL });
      expect(solver).not.toBeNull();
      // The sampling span is the spring's own settle time, so the curve
      // handed to a caller is a whole motion. A recipe whose spring never
      // settles would be sampled over a guess.
      expect(solver!.settleTimeMs(), `${recipe} settles at all`).not.toBeNull();
      // And what the eye actually waits for is the playback window, which
      // stays under a second at the shipped nominal.
      expect(
        motionDurationMs(recipe, NOMINAL),
        `${recipe} plays inside a second`,
      ).toBeLessThan(1000);
    }
  });

  test("the curve is arrived and flat at the end of its window", () => {
    for (const recipe of SPRINGS) {
      const { progress } = motionKeyframes(recipe, { nominalMs: NOMINAL });
      const tail = progress.slice(-4);
      for (const v of tail) {
        expect(v, `${recipe} is at its target through the tail`).toBeCloseTo(1, 2);
      }
    }
  });
});

describe("interruption carries momentum", () => {
  test("progress is read back off the curve it was launched with", () => {
    const curve = motionKeyframes("crossing", { nominalMs: NOMINAL });
    expect(progressAt(curve, 0)).toBe(0);
    expect(progressAt(curve, -50), "before the start is the start").toBe(0);
    expect(progressAt(curve, NOMINAL)).toBe(1);
    expect(progressAt(curve, NOMINAL * 10), "after the end is the end").toBe(1);
    const mid = progressAt(curve, NOMINAL / 2);
    expect(mid, "halfway through, the motion is under way").toBeGreaterThan(0);
    expect(mid, "and not yet arrived").toBeLessThan(1);
  });

  test("velocity is highest early and spent by the end", () => {
    const opts = { nominalMs: NOMINAL };
    const early = velocityAt("crossing", opts, NOMINAL * 0.15);
    const late = velocityAt("crossing", opts, NOMINAL);
    expect(early, "a settle leaves at speed").toBeGreaterThan(0);
    expect(Math.abs(late), "and arrives at rest").toBeLessThan(
      Math.abs(early) / 4,
    );
  });

  test("a fade has no velocity to inherit", () => {
    expect(velocityAt("divide-join", { nominalMs: NOMINAL }, 10)).toBe(0);
  });

  test("launching with velocity moves the curve, and stays bounded", () => {
    const atRest = motionKeyframes("landing", { nominalMs: NOMINAL });
    const thrown = motionKeyframes("landing", {
      nominalMs: NOMINAL,
      initialVelocity: 2.5,
    });
    const early = Math.floor(atRest.progress.length * 0.2);
    expect(
      thrown.progress[early],
      "a thrown card is further along early on",
    ).toBeGreaterThan(atRest.progress[early]);
    expect(
      thrown.progress[thrown.progress.length - 1],
      "and still lands exactly on its target",
    ).toBe(1);
  });

  test("the velocity clamp bounds the overshoot a flick can buy", () => {
    const wild = motionKeyframes("landing", {
      nominalMs: NOMINAL,
      initialVelocity: 500,
    });
    const clamped = motionKeyframes("landing", {
      nominalMs: NOMINAL,
      initialVelocity: MAX_INITIAL_VELOCITY,
    });
    expect(
      wild.progress,
      "an absurd velocity is the clamp's velocity",
    ).toEqual(clamped.progress);
    // Bounded, and bounded to something a deck can contain: under half a
    // travel past the target.
    expect(Math.max(...wild.progress)).toBeLessThan(1.5);
  });
});

describe("a pointer's velocity is projected onto the travel", () => {
  const travel = { x: 200, y: 0 };

  test("motion toward the destination is inherited", () => {
    expect(
      velocityAlongTravel({ x: 400, y: 0 }, travel),
      "400px/s along a 200px travel is two travels per second",
    ).toBeCloseTo(2, 6);
  });

  test("motion away from it is negative", () => {
    expect(velocityAlongTravel({ x: -400, y: 0 }, travel)).toBeCloseTo(-2, 6);
  });

  test("motion across it contributes nothing", () => {
    expect(velocityAlongTravel({ x: 0, y: 900 }, travel)).toBe(0);
  });

  test("a travel too short to have a direction inherits nothing", () => {
    expect(velocityAlongTravel({ x: 900, y: 900 }, { x: 0.5, y: 0 })).toBe(0);
  });

  test("the projection is clamped like every other launch velocity", () => {
    expect(velocityAlongTravel({ x: 100_000, y: 0 }, travel)).toBe(
      MAX_INITIAL_VELOCITY,
    );
  });
});
