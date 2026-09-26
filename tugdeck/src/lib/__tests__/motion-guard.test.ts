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
import { burst, summarize } from "@/lib/motion-guard/render-cost-probe";
import {
  nothingInFlight,
  shouldTrip,
  BREAKER_TRIP_SAMPLES,
} from "@/lib/motion-guard/breaker";
import type { RenderCostSample } from "@/lib/motion-guard/render-cost-probe";

/** A sample, named by the two things the breaker reads off it. */
function sample(costMs: number, inFlight = false): RenderCostSample {
  return { t: 0, costMs, inFlight };
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

  test("one in-flight sample in the run clears it", () => {
    // A streaming transcript legitimately lays out every frame ([D4]). The
    // run has to be clean, not merely mostly clean.
    expect(
      shouldTrip([sample(9), sample(11, true), sample(8)], 6),
    ).toBe(false);
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
