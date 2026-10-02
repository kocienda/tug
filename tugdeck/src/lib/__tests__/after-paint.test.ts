/**
 * after-paint — the door's release ([L27]).
 *
 * The door hands back a cancel that clears its frame callback and both
 * timers, and whichever path fires first releases the other. The clock here
 * is turned by hand, with every registration keyed by id, so the test reads
 * what is still queued rather than whether a guard swallowed it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AFTER_PAINT_DEADLINE_MS, scheduleAfterPaint } from "@/lib/after-paint";

describe("scheduleAfterPaint", () => {
  let nextId = 1;
  const frames = new Map<number, () => void>();
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let saved: Record<string, unknown> = {};

  /** Run every queued frame callback. */
  function frame(): void {
    const due = [...frames.entries()];
    frames.clear();
    for (const [, cb] of due) cb();
  }

  /** Run every queued timer whose delay is at most `ms`. */
  function elapse(ms: number): void {
    for (const [id, t] of [...timers.entries()]) {
      if (t.ms > ms || !timers.has(id)) continue;
      timers.delete(id);
      t.fn();
    }
  }

  beforeEach(() => {
    const g = globalThis as unknown as Record<string, unknown>;
    saved = {
      requestAnimationFrame: g.requestAnimationFrame,
      cancelAnimationFrame: g.cancelAnimationFrame,
      window: g.window,
    };
    g.requestAnimationFrame = (cb: () => void) => {
      const id = nextId++;
      frames.set(id, cb);
      return id;
    };
    g.cancelAnimationFrame = (id: number) => {
      frames.delete(id);
    };
    g.window = {
      setTimeout: (fn: () => void, ms = 0) => {
        const id = nextId++;
        timers.set(id, { fn, ms });
        return id;
      },
      clearTimeout: (id: number) => {
        timers.delete(id);
      },
    };
  });

  afterEach(() => {
    frames.clear();
    timers.clear();
    const g = globalThis as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete g[key];
      else g[key] = value;
    }
  });

  test("runs once, on the task after the painted frame", () => {
    let runs = 0;
    scheduleAfterPaint(() => runs++);
    expect(runs).toBe(0);
    frame();
    expect(runs).toBe(0);
    elapse(0);
    expect(runs).toBe(1);
    // The deadline went with the paint path: nothing is left queued.
    expect(frames.size).toBe(0);
    expect(timers.size).toBe(0);
  });

  test("a cancel before either path fires releases everything", () => {
    let runs = 0;
    const cancel = scheduleAfterPaint(() => runs++);
    expect(frames.size).toBe(1);
    expect(timers.size).toBe(1);
    cancel();
    expect(frames.size).toBe(0);
    expect(timers.size).toBe(0);
    frame();
    elapse(AFTER_PAINT_DEADLINE_MS);
    expect(runs).toBe(0);
  });

  test("a cancel after the frame releases the paint timer and the deadline", () => {
    let runs = 0;
    const cancel = scheduleAfterPaint(() => runs++);
    frame();
    expect(timers.size).toBe(2);
    cancel();
    expect(timers.size).toBe(0);
    elapse(AFTER_PAINT_DEADLINE_MS);
    expect(runs).toBe(0);
  });

  test("a deadline that wins cancels the frame callback it stood behind", () => {
    let runs = 0;
    scheduleAfterPaint(() => runs++);
    // An occluded window: no frame fires, the deadline does.
    elapse(AFTER_PAINT_DEADLINE_MS);
    expect(runs).toBe(1);
    expect(frames.size).toBe(0);
    expect(timers.size).toBe(0);
  });

  test("a cancel after the callback ran is a no-op", () => {
    let runs = 0;
    const cancel = scheduleAfterPaint(() => runs++);
    elapse(AFTER_PAINT_DEADLINE_MS);
    cancel();
    cancel();
    expect(runs).toBe(1);
  });

  test("onFrame reports the frame, and a shortened deadline is the one queued", () => {
    let runs = 0;
    let framed = 0;
    scheduleAfterPaint(() => runs++, { onFrame: () => framed++, deadlineMs: 12 });
    expect([...timers.values()].map((t) => t.ms)).toEqual([12]);
    frame();
    expect(framed).toBe(1);
    expect(runs).toBe(0);
    elapse(0);
    expect(runs).toBe(1);
  });

  test("onFrame is not called when the deadline wins", () => {
    let framed = 0;
    scheduleAfterPaint(() => {}, { onFrame: () => framed++ });
    elapse(AFTER_PAINT_DEADLINE_MS);
    frame();
    expect(framed).toBe(0);
  });
});
