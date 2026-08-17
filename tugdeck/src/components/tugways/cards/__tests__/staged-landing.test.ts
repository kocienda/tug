/**
 * staged-landing — both beats of a parked landing, and the deadline behind them.
 *
 * The regression this pins: a landing parked on `sheetDidHide` and never run,
 * because the hide rides an effect that can fail to flip. The watchdog turns
 * that from a lost gesture into a late one, and the null-swap is what keeps
 * "late" from also meaning "twice".
 *
 * Timers are injected rather than faked globally, so the run order under test
 * is the one the assertions state.
 */

import { describe, expect, it } from "bun:test";

import { createStagedLanding } from "../staged-landing";

/** A hand-driven timer queue: nothing fires until the test says so. */
function timers(): {
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (id: number) => void;
  /** Fire every pending timer whose delay is <= `ms`, soonest first. */
  advance: (ms: number) => void;
  pending: () => number;
} {
  let nextId = 1;
  const queue = new Map<number, { fn: () => void; at: number }>();
  let now = 0;
  return {
    setTimer: (fn, ms) => {
      const id = nextId++;
      queue.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimer: (id) => {
      queue.delete(id);
    },
    advance: (ms) => {
      now += ms;
      const due = [...queue.entries()]
        .filter(([, t]) => t.at <= now)
        .sort((a, b) => a[1].at - b[1].at);
      for (const [id, timer] of due) {
        queue.delete(id);
        timer.fn();
      }
    },
    pending: () => queue.size,
  };
}

describe("createStagedLanding", () => {
  it("runs the landing on the hide, and disarms the deadline", () => {
    const t = timers();
    let faults = 0;
    let runs = 0;
    const staging = createStagedLanding({
      onFault: () => {
        faults += 1;
      },
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });

    staging.stage(() => {
      runs += 1;
    });
    staging.sheetDidHide();
    expect(runs).toBe(0); // still inside the post-hide beat
    t.advance(150);
    expect(runs).toBe(1);
    expect(faults).toBe(0);

    // The deadline was disarmed by the hide, so nothing is left to fire.
    t.advance(5000);
    expect(runs).toBe(1);
    expect(t.pending()).toBe(0);
  });

  it("lands anyway when the hide never comes, and says so", () => {
    const t = timers();
    let faults = 0;
    let runs = 0;
    const staging = createStagedLanding({
      onFault: () => {
        faults += 1;
      },
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });

    staging.stage(() => {
      runs += 1;
    });
    t.advance(1000);
    expect(runs).toBe(1);
    expect(faults).toBe(1);
  });

  it("does not run twice when the hide arrives after the deadline", () => {
    const t = timers();
    let runs = 0;
    const staging = createStagedLanding({
      onFault: () => {},
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });

    staging.stage(() => {
      runs += 1;
    });
    t.advance(1000);
    expect(runs).toBe(1);

    staging.sheetDidHide();
    t.advance(150);
    expect(runs).toBe(1);
  });

  it("a hide with nothing parked is inert", () => {
    const t = timers();
    const staging = createStagedLanding({
      onFault: () => {},
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    staging.sheetDidHide();
    t.advance(1000);
    expect(t.pending()).toBe(0);
  });

  it("parks fresh for a second landing after the first one ran", () => {
    const t = timers();
    const ran: string[] = [];
    const staging = createStagedLanding({
      onFault: () => {},
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });

    staging.stage(() => ran.push("first"));
    staging.sheetDidHide();
    t.advance(150);

    staging.stage(() => ran.push("second"));
    staging.sheetDidHide();
    t.advance(150);
    expect(ran).toEqual(["first", "second"]);
  });

  it("staging over a parked landing rearms the deadline rather than stacking it", () => {
    const t = timers();
    let faults = 0;
    const ran: string[] = [];
    const staging = createStagedLanding({
      onFault: () => {
        faults += 1;
      },
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });

    staging.stage(() => ran.push("first"));
    staging.stage(() => ran.push("second"));
    t.advance(1000);
    // One deadline, one landing — the second press replaced the first.
    expect(ran).toEqual(["second"]);
    expect(faults).toBe(1);
  });

  it("dispose releases both timers and drops what is parked ([L27])", () => {
    const t = timers();
    let runs = 0;
    const staging = createStagedLanding({
      onFault: () => {},
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });

    staging.stage(() => {
      runs += 1;
    });
    staging.dispose();
    t.advance(5000);
    expect(runs).toBe(0);
    expect(t.pending()).toBe(0);

    // And a landing already handed to the post-hide beat is released too.
    const second = createStagedLanding({
      onFault: () => {},
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    second.stage(() => {
      runs += 1;
    });
    second.sheetDidHide();
    second.dispose();
    t.advance(5000);
    expect(runs).toBe(0);
    expect(t.pending()).toBe(0);
  });
});
