/**
 * The motion guard's arithmetic and its edges.
 *
 * Two of the guard's three halves are pure and belong here: the summary the
 * render cost is reported through, and the hold counter whose edges arm and
 * disarm the probe. The third half — the sampling itself — is a rendering
 * update, and there is no in-process DOM substrate that has one. A fake clock
 * would prove that `setTimeout` fires, which is not the question; the app-test
 * tripwire is where a real frame gets measured.
 *
 * What the edge tests are guarding against is the defect a boolean would have:
 * several glyphs breathing at once, the last one to stop clearing a flag the
 * others still need, or a double release from the pulsing dot's two cleanup
 * paths taking the count negative and leaving the probe armed forever.
 */

import { describe, test, expect } from "bun:test";

import {
  acquireMotionHold,
  motionHolds,
  onMotionEdge,
} from "@/lib/motion-guard/registry";
import {
  burst,
  restFromGaps,
  summarize,
  REST_STALL_FLOOR_MS,
} from "@/lib/motion-guard/render-cost-probe";
import {
  nothingInFlight,
  shouldTrip,
  shouldTripAtRest,
  BREAKER_TRIP_SAMPLES,
} from "@/lib/motion-guard/breaker";
import type { RenderCostSample } from "@/lib/motion-guard/render-cost-probe";

/** A sample, named by the things the breaker reads off it. */
function sample(
  costMs: number,
  inFlight = false,
  updatesPerSecond = 0,
  gesture = false,
): RenderCostSample {
  return { t: 0, costMs, inFlight, gesture, updatesPerSecond };
}

/** A sample at rest with a given updates-per-second reading. */
function resting(updatesPerSecond: number): RenderCostSample {
  return sample(1, false, updatesPerSecond);
}

describe("summarize", () => {
  test("an empty reading summarizes as zeros, not NaN", () => {
    // A reader that renders the summary before the first sample lands should
    // print numbers rather than three NaNs.
    expect(summarize([])).toEqual({ p50: 0, p95: 0, max: 0 });
  });

  test("a single reading is its own p50, p95 and max", () => {
    expect(summarize([4.25])).toEqual({ p50: 4.25, p95: 4.25, max: 4.25 });
  });

  test("nearest-rank over a sorted copy", () => {
    const values = [10, 1, 5, 2, 3, 4, 6, 7, 8, 9];
    expect(summarize(values)).toEqual({ p50: 5, p95: 10, max: 10 });
  });

  test("the input is never reordered", () => {
    // The caller keeps the burst in the order the frames came in — the shape
    // of a run over time is half of what a reader is looking at.
    const values = [3, 1, 2];
    summarize(values);
    expect(values).toEqual([3, 1, 2]);
  });

  test("p95 is a rank, and `max` is what names a lone outlier", () => {
    // Nineteen cheap frames and one 40 ms walk: nearest rank puts p95 at the
    // 19th of 20, which is still cheap. That is the point of reporting all
    // three — a single polluted frame reads on `max` and moves no percentile,
    // which is exactly the reading the breaker must not trip on ([R03]).
    expect(summarize([...Array(19).fill(1), 40])).toEqual({
      p50: 1,
      p95: 1,
      max: 40,
    });
    // Thicken the tail to two frames in twenty and p95 moves with it.
    expect(summarize([...Array(18).fill(1), 40, 40]).p95).toBe(40);
  });
});

describe("restFromGaps", () => {
  test("an empty chain reads as zeros, not NaN", () => {
    expect(restFromGaps([], 1000)).toEqual({
      updatesPerSecond: 0,
      busyMsPerSecond: 0,
      windowMs: 1000,
      ticks: 0,
      medianGapMs: 0,
      maxGapMs: 0,
      floorMs: REST_STALL_FLOOR_MS,
    });
  });

  test("a chain with nothing between its fires reads zero updates", () => {
    // Six hundred one-millisecond gaps with the ordinary jitter of a
    // coarsened clock: the deck's own loops are resident and nothing held
    // the thread.
    const gaps = Array.from({ length: 600 }, (_, i) => (i % 7 === 0 ? 2 : 1));
    const reading = restFromGaps(gaps, 1000);
    expect(reading.updatesPerSecond).toBe(0);
    expect(reading.busyMsPerSecond).toBe(0);
    expect(reading.medianGapMs).toBe(1);
    expect(reading.maxGapMs).toBe(2);
    expect(reading.ticks).toBe(600);
  });

  test("a stall is a gap more than the floor past the median, and each one counts once", () => {
    // Sixty rendering updates of 7 ms a second, on a chain that otherwise
    // fires every millisecond: the disease the gauge exists to read.
    const gaps: number[] = [];
    for (let i = 0; i < 60; i += 1) {
      gaps.push(8);
      for (let j = 0; j < 9; j += 1) gaps.push(1);
    }
    const reading = restFromGaps(gaps, 1000);
    expect(reading.updatesPerSecond).toBe(60);
    // Seven milliseconds past the median, sixty times.
    expect(reading.busyMsPerSecond).toBe(420);
    expect(reading.maxGapMs).toBe(8);
  });

  test("a gap at the floor is jitter, one past it is an update", () => {
    const at = Array.from({ length: 100 }, () => 1);
    at[50] = 1 + REST_STALL_FLOOR_MS;
    expect(restFromGaps(at, 1000).updatesPerSecond).toBe(0);
    const past = Array.from({ length: 100 }, () => 1);
    past[50] = 1 + REST_STALL_FLOOR_MS + 1;
    expect(restFromGaps(past, 1000).updatesPerSecond).toBe(1);
  });

  test("the count is normalized to a second, whatever the window", () => {
    // Thirty stalls over half a second is sixty a second; the window a
    // caller asked for is not the unit the reading is in.
    const gaps: number[] = [];
    for (let i = 0; i < 30; i += 1) gaps.push(1, 1, 1, 9);
    expect(restFromGaps(gaps, 500).updatesPerSecond).toBe(60);
    expect(restFromGaps(gaps, 500).windowMs).toBe(500);
  });

  test("the floor is the caller's when it says so", () => {
    const gaps = [1, 1, 1, 4, 1, 1, 1, 4];
    expect(restFromGaps(gaps, 1000, 2).updatesPerSecond).toBe(2);
    expect(restFromGaps(gaps, 1000, 3).updatesPerSecond).toBe(0);
  });

  test("the input is never reordered", () => {
    const gaps = [3, 1, 2];
    restFromGaps(gaps, 1000);
    expect(gaps).toEqual([3, 1, 2]);
  });
});

describe("burst", () => {
  test("burst(0) resolves to an empty array without touching the frame clock", async () => {
    // No `requestAnimationFrame` exists in this process, so a `burst(0)` that
    // reached for one would throw rather than return.
    expect(await burst(0)).toEqual([]);
  });
});

describe("the hold counter's edges", () => {
  test("holds start at zero and balance back to zero", () => {
    expect(motionHolds()).toBe(0);
    const release = acquireMotionHold();
    expect(motionHolds()).toBe(1);
    release();
    expect(motionHolds()).toBe(0);
  });

  test("an edge fires exactly once per transition, however many owners", () => {
    const edges: number[] = [];
    const unsubscribe = onMotionEdge((holds) => edges.push(holds));

    const first = acquireMotionHold();
    const second = acquireMotionHold();
    const third = acquireMotionHold();
    // Three owners moving, one rising edge: the probe is armed once.
    expect(edges).toEqual([1]);

    first();
    second();
    // Two of the three have stopped and the deck is still moving.
    expect(edges).toEqual([1]);

    third();
    // The last one stops and the probe disarms.
    expect(edges).toEqual([1, 0]);

    unsubscribe();
  });

  test("a double release is a no-op", () => {
    const edges: number[] = [];
    const unsubscribe = onMotionEdge((holds) => edges.push(holds));

    const release = acquireMotionHold();
    release();
    release();
    release();

    // Not -2, and not a second falling edge: the pulsing dot's demotion path
    // and its unmount cleanup both call the same closure.
    expect(motionHolds()).toBe(0);
    expect(edges).toEqual([1, 0]);

    unsubscribe();
  });

  test("a released hold does not suppress a later owner's rising edge", () => {
    const edges: number[] = [];
    const unsubscribe = onMotionEdge((holds) => edges.push(holds));

    acquireMotionHold()();
    const second = acquireMotionHold();
    expect(edges).toEqual([1, 0, 1]);
    second();

    unsubscribe();
  });

  test("an unsubscribed listener hears nothing further", () => {
    const edges: number[] = [];
    const unsubscribe = onMotionEdge((holds) => edges.push(holds));
    unsubscribe();
    acquireMotionHold()();
    expect(edges).toEqual([]);
  });
});

describe("nothingInFlight", () => {
  test("an empty deck has nothing in flight", () => {
    expect(nothingInFlight([])).toBe(true);
  });

  test("the three phases that are not a turn", () => {
    // A session waiting on the user breathes a dot and moves no DOM, which is
    // exactly the state where an over-budget frame is the loop's bill. So
    // `awaiting_approval` is NOT in flight, and that is the load-bearing one.
    expect(nothingInFlight(["idle"])).toBe(true);
    expect(nothingInFlight(["awaiting_approval"])).toBe(true);
    expect(nothingInFlight(["errored"])).toBe(true);
  });

  test("the six phases that are", () => {
    for (const phase of [
      "submitting",
      "awaiting_first_token",
      "streaming",
      "tool_work",
      "replaying",
      "waking",
    ]) {
      expect(nothingInFlight([phase])).toBe(false);
    }
  });

  test("one busy session among many is enough", () => {
    expect(
      nothingInFlight(["idle", "awaiting_approval", "streaming", "idle"]),
    ).toBe(false);
  });

  test("a phase nobody has heard of is not in flight", () => {
    // The set names what IS a turn rather than what is not, so a phase added
    // to `CodeSessionPhase` without a thought here reads as quiet — which
    // fails toward demoting a deck rather than toward never demoting one.
    expect(nothingInFlight(["some_future_phase"])).toBe(true);
  });
});

/**
 * The gate reads cost and nothing else, and it did not always.
 *
 * It used to require that nothing was in flight when a sample was taken, on
 * the reasoning that a streaming transcript legitimately lays out every frame
 * ([D4]) and the walk worth catching is the one with nothing to show for it.
 * `tugtool deck motion probe` settled it on the release deck: **0 trips
 * across more than eighty motion holds**, with 17, 19, 24 and 39 ms samples
 * in the ring — all over budget, all discarded, because in flight is this
 * deck's normal state.
 *
 * The cases below that pin the new behaviour were written as its opposite,
 * and they are rewritten rather than deleted, because the reading that was
 * clearing those runs is the finding. `inFlight` still rides every sample and
 * the `motion-demoted` trace row; {@link nothingInFlight} is untouched and its
 * own cases above still hold. The flag lost its vote, not its job.
 */
describe("shouldTrip", () => {
  test("fewer samples than the run needs is never a trip", () => {
    // The probe arms on a rising motion edge, so a deck that has only just
    // started moving has not said anything yet.
    expect(shouldTrip([sample(99), sample(99)], 6)).toBe(false);
    expect(shouldTrip([], 6)).toBe(false);
  });

  test("a clean over-budget run trips", () => {
    expect(shouldTrip([sample(9), sample(11), sample(8)], 6)).toBe(true);
  });

  test("only the last `needed` samples are read", () => {
    // Everything before the run is history: a deck that was fine, then was
    // not, is the case this exists for.
    expect(
      shouldTrip([sample(1), sample(1), sample(9), sample(11), sample(8)], 6),
    ).toBe(true);
  });

  test("a mixed run does not trip", () => {
    expect(shouldTrip([sample(9), sample(2), sample(11)], 6)).toBe(false);
  });

  test("an in-flight sample counts toward the run like any other", () => {
    // The inversion. An over-budget frame taken while a session was streaming
    // is not the stream's alibi for the loops — the app's work triggers the
    // walk and the running loops set its price, so that frame is the loops'
    // bill arriving when the deck can least afford it.
    expect(shouldTrip([sample(9), sample(11, true), sample(8)], 6)).toBe(true);
  });

  test("a run that was entirely in flight trips", () => {
    // The release deck's actual shape, and the one the old gate could never
    // fire on: every sample over budget, every sample taken mid-turn.
    expect(
      shouldTrip([sample(17, true), sample(19, true), sample(24, true)], 6),
    ).toBe(true);
  });

  test("in flight does not make an under-budget sample count", () => {
    // The gate reads cost and nothing else — which cuts both ways. Dropping
    // the flag must not turn a cheap frame into a trip.
    expect(shouldTrip([sample(9), sample(2, true), sample(11)], 6)).toBe(false);
  });

  test("a sample exactly at the budget is not over it", () => {
    expect(shouldTrip([sample(6), sample(6), sample(6)], 6)).toBe(false);
    expect(shouldTrip([sample(6.1), sample(6.1), sample(6.1)], 6)).toBe(true);
  });

  test("the budget moves and the same run reads the other way", () => {
    const run = [sample(9), sample(11), sample(8)];
    expect(shouldTrip(run, 6)).toBe(true);
    expect(shouldTrip(run, 20)).toBe(false);
  });

  test("the default run length is the breaker's", () => {
    const two = [sample(9), sample(11)];
    expect(shouldTrip(two, 6)).toBe(BREAKER_TRIP_SAMPLES <= 2);
    expect(shouldTrip(two, 6, 2)).toBe(true);
  });

  test("a run length of zero is not a trip on an empty reading", () => {
    // `every` over an empty slice is vacuously true, which would make a
    // misconfigured breaker demote a deck that has never sampled anything.
    expect(shouldTrip([sample(1)], 6, 0)).toBe(false);
  });
});

/**
 * The second condition, and the one that keeps its gates.
 *
 * Cost lost its in-flight vote because the loops' bill arrives whether or
 * not the deck is busy. Updates at rest are the opposite reading: a busy
 * deck schedules an update every frame for a reason, so the only reading
 * that convicts is one taken with nothing in flight and no gesture running,
 * three samples in a row.
 */
describe("shouldTripAtRest", () => {
  test("fewer samples than the run needs is never a trip", () => {
    expect(shouldTripAtRest([resting(60), resting(60)], 10)).toBe(false);
    expect(shouldTripAtRest([], 10)).toBe(false);
  });

  test("three samples reading a loop at rest trip", () => {
    expect(shouldTripAtRest([resting(60), resting(58), resting(61)], 10)).toBe(true);
  });

  test("a resident deck's noise does not", () => {
    // A store sweep and a telemetry commit are stalls the chain sees, and a
    // handful a second is the reading of a deck whose loops are resident.
    expect(shouldTripAtRest([resting(3), resting(0), resting(5)], 10)).toBe(false);
  });

  test("a sample taken in flight breaks the run", () => {
    expect(
      shouldTripAtRest([resting(60), sample(1, true, 60), resting(60)], 10),
    ).toBe(false);
  });

  test("a sample taken under a gesture breaks the run", () => {
    expect(
      shouldTripAtRest(
        [resting(60), sample(1, false, 60, true), resting(60)],
        10,
      ),
    ).toBe(false);
  });

  test("only the last `needed` samples are read", () => {
    expect(
      shouldTripAtRest(
        [sample(1, true, 60), resting(60), resting(60), resting(60)],
        10,
      ),
    ).toBe(true);
  });

  test("a sample exactly at the budget is not over it", () => {
    expect(shouldTripAtRest([resting(10), resting(10), resting(10)], 10)).toBe(false);
    expect(shouldTripAtRest([resting(11), resting(11), resting(11)], 10)).toBe(true);
  });

  test("the cost of the frame has no vote here", () => {
    // An expensive frame is the other condition's business; a cheap update
    // sixty times a second is still a loop on the main thread.
    expect(
      shouldTripAtRest([sample(30, false, 60), sample(0, false, 60), sample(1, false, 60)], 10),
    ).toBe(true);
  });

  test("a run length of zero is not a trip on an empty reading", () => {
    // The same vacuous-`every` guard as the cost condition's.
    expect(shouldTripAtRest([resting(60)], 10, 0)).toBe(false);
  });
});
