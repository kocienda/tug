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
import { nothingInFlight } from "@/lib/motion-guard/breaker";

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

