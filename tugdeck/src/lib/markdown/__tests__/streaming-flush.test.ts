import { describe, expect, it } from "bun:test";

import { GestureScope } from "@/lib/gesture-scope";

import { createStreamingFlush } from "../streaming-flush";

/**
 * A flush over a real scope whose pointer release is captured, and a frame
 * queue the test fires by hand. `motion` says whether the scope's motion is
 * enabled, the reduced-motion switch.
 */
function harness(motion = true) {
  const scope = new GestureScope(
    () => () => {},
    () => motion,
    () => 0,
  );
  const frames = new Map<number, () => void>();
  let nextId = 1;
  const cancelled: number[] = [];
  let reconciles = 0;
  const flush = createStreamingFlush(
    () => {
      reconciles += 1;
    },
    {
      requestFrame: (cb) => {
        const id = nextId++;
        frames.set(id, cb);
        return id;
      },
      cancelFrame: (id) => {
        cancelled.push(id);
        frames.delete(id);
      },
      scope,
    },
  );
  const fireFrames = (): void => {
    const due = [...frames.values()];
    frames.clear();
    for (const cb of due) cb();
  };
  return {
    scope,
    flush,
    fireFrames,
    frames,
    cancelled,
    reconciles: () => reconciles,
  };
}

describe("createStreamingFlush", () => {
  it("coalesces a burst onto one frame and reconciles once in it", () => {
    const h = harness();
    h.flush.request();
    h.flush.request();
    h.flush.request();
    expect(h.frames.size).toBe(1);
    expect(h.reconciles()).toBe(0);
    h.fireFrames();
    expect(h.reconciles()).toBe(1);
    // The next burst schedules a fresh frame.
    h.flush.request();
    expect(h.frames.size).toBe(1);
  });

  it("defers the reconcile while the motion gate is closed, and the release runs it once", () => {
    const h = harness();
    const release = h.scope.holdMotion(10_000);
    h.flush.request();
    h.fireFrames();
    expect(h.reconciles()).toBe(0);
    // Deltas during the motion schedule no frame: the deferred reconcile covers them.
    h.flush.request();
    h.flush.request();
    expect(h.frames.size).toBe(0);
    release();
    expect(h.reconciles()).toBe(1);
    // After the release a delta schedules a frame again.
    h.flush.request();
    expect(h.frames.size).toBe(1);
    h.fireFrames();
    expect(h.reconciles()).toBe(2);
  });

  it("reconciles at once under a pointer scope alone; only the motion gate defers", () => {
    const h = harness();
    h.scope.open("pointer");
    h.flush.request();
    h.fireFrames();
    expect(h.reconciles()).toBe(1);
  });

  it("never defers under reduced motion, where the gate does not close", () => {
    const h = harness(false);
    h.scope.holdMotion(10_000);
    h.flush.request();
    h.fireFrames();
    expect(h.reconciles()).toBe(1);
  });

  it("a block disposed while its reconcile is deferred reconciles nothing at the release", () => {
    const h = harness();
    const release = h.scope.holdMotion(10_000);
    h.flush.request();
    h.fireFrames();
    h.flush.dispose();
    release();
    expect(h.reconciles()).toBe(0);
  });

  it("dispose cancels a scheduled frame and ignores later requests", () => {
    const h = harness();
    h.flush.request();
    h.flush.dispose();
    expect(h.cancelled).toEqual([1]);
    h.flush.request();
    expect(h.frames.size).toBe(0);
    expect(h.reconciles()).toBe(0);
  });
});
