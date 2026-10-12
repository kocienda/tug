import { describe, expect, it } from "bun:test";

import { AFTER_PAINT_DEADLINE_MS } from "../after-paint";
import { FRAMELESS_TICK_MS, LivePublishTick } from "../live-publish-tick";

/** A tick over a manual frame queue and timer table; `frame: false` is a frameless host. */
function harness(frame = true) {
  const frames = new Map<number, () => void>();
  const timers = new Map<number, { cb: () => void; ms: number }>();
  let next = 1;
  const tick = new LivePublishTick({
    requestFrame: frame
      ? (cb) => {
          const id = next++;
          frames.set(id, cb);
          return id;
        }
      : null,
    cancelFrame: (handle) => {
      frames.delete(handle as number);
    },
    setTimeout: (cb, ms) => {
      const id = next++;
      timers.set(id, { cb, ms });
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
  });
  const fireFrame = (): void => {
    for (const [id, cb] of [...frames]) {
      frames.delete(id);
      cb();
    }
  };
  const fireTimers = (): void => {
    for (const [id, t] of [...timers]) {
      timers.delete(id);
      t.cb();
    }
  };
  return { tick, frames, timers, fireFrame, fireTimers };
}

describe("LivePublishTick", () => {
  it("runs every scheduled publish once on one frame, and a repeat is not added twice", () => {
    const h = harness();
    const calls: string[] = [];
    const a = (): void => void calls.push("a");
    const b = (): void => void calls.push("b");
    h.tick.schedule(a);
    h.tick.schedule(b);
    h.tick.schedule(a);
    expect(h.frames.size).toBe(1);
    expect(calls).toEqual([]);
    h.fireFrame();
    expect(calls).toEqual(["a", "b"]);
    expect(h.tick.size).toBe(0);
  });

  it("the frame releases the deadline, so nothing runs twice", () => {
    const h = harness();
    let n = 0;
    h.tick.schedule(() => (n += 1));
    expect([...h.timers.values()].map((t) => t.ms)).toEqual([AFTER_PAINT_DEADLINE_MS]);
    h.fireFrame();
    expect(h.timers.size).toBe(0);
    expect(n).toBe(1);
  });

  it("the deadline runs the tick when no frame comes, and releases the frame", () => {
    const h = harness();
    let n = 0;
    h.tick.schedule(() => (n += 1));
    h.fireTimers();
    expect(n).toBe(1);
    expect(h.frames.size).toBe(0);
  });

  it("cancelling the last publish disarms the tick", () => {
    const h = harness();
    const a = (): void => {};
    h.tick.schedule(a);
    h.tick.cancel(a);
    expect(h.frames.size).toBe(0);
    expect(h.timers.size).toBe(0);
  });

  it("a frameless host ticks on a one-frame timer", () => {
    const h = harness(false);
    let n = 0;
    h.tick.schedule(() => (n += 1));
    expect([...h.timers.values()].map((t) => t.ms)).toEqual([FRAMELESS_TICK_MS]);
    h.fireTimers();
    expect(n).toBe(1);
  });

  it("a throwing publish takes no other with it, and the first error is rethrown", () => {
    const h = harness();
    const calls: string[] = [];
    h.tick.schedule(() => {
      throw new Error("first");
    });
    h.tick.schedule(() => void calls.push("after"));
    expect(() => h.fireFrame()).toThrow("first");
    expect(calls).toEqual(["after"]);
    expect(h.tick.size).toBe(0);
  });
});
