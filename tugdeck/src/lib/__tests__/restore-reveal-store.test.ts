/**
 * restore-reveal-store.test.ts — the driver around the reveal-queue rule:
 * that it feeds the rule real frames and tasks, admits through
 * `isAdmitted`, publishes the cover, and lets its bounds fire without
 * frames.
 *
 * A fake scheduler stands in for rAF and timers, so each test advances the
 * deck's clock by hand and reads back what the store published.
 */

import { describe, expect, test } from "bun:test";

import { RestoreRevealStore, type RevealScheduler } from "@/lib/restore-reveal-store";
import { COVER_COMPOSITE_BOUND_MS, REVEAL_SETTLE_BOUND_MS } from "@/lib/restore-reveal-queue";

class FakeScheduler implements RevealScheduler {
  t = 0;
  private frames: Array<() => void> = [];
  private timers: Array<{ at: number; cb: () => void; live: boolean }> = [];

  now = (): number => this.t;
  requestFrame = (cb: () => void): void => {
    this.frames.push(cb);
  };
  setTimer = (cb: () => void, ms: number): (() => void) => {
    const timer = { at: this.t + ms, cb, live: true };
    this.timers.push(timer);
    return () => {
      timer.live = false;
    };
  };

  /** Run one frame 16.7 ms on, then any timers now due. */
  frame(): void {
    this.t += 16.7;
    const due = this.frames;
    this.frames = [];
    for (const cb of due) cb();
    this.runTimers();
  }

  /** Advance the clock with no frames (an occluded window), running timers. */
  advance(ms: number): void {
    this.t += ms;
    this.runTimers();
  }

  /**
   * Run the timers due now, each as its own task. A timer one of them sets
   * runs on a later call, as a real `setTimeout(0)` set inside a task does.
   */
  runTimers(): void {
    const due = this.timers
      .filter((x) => x.live && x.at <= this.t)
      .sort((a, b) => a.at - b.at);
    for (const timer of due) {
      if (!timer.live) continue;
      timer.live = false;
      timer.cb();
    }
  }

  get pendingFrames(): number {
    return this.frames.length;
  }
}

function setup(): { store: RestoreRevealStore; clock: FakeScheduler; notified: () => number } {
  const clock = new FakeScheduler();
  const store = new RestoreRevealStore(clock);
  let count = 0;
  store.subscribe(() => {
    count += 1;
  });
  return { store, clock, notified: () => count };
}

describe("RestoreRevealStore", () => {
  test("an enqueue publishes the cover; admission waits for two frames", () => {
    const { store, clock } = setup();
    store.enqueue("A");
    expect(store.getSnapshot()).toEqual({ cover: true, cardIds: ["A"] });
    expect(store.isAdmitted("A")).toBe(false);

    clock.frame();
    expect(store.isAdmitted("A")).toBe(false);
    clock.frame(); // composited; the admitting task is due in the same turn
    expect(store.isAdmitted("A")).toBe(true);
  });

  test("one admission per task, key card first", () => {
    const { store, clock } = setup();
    store.enqueue("A");
    store.enqueue("B");
    store.setKeyCard("B");
    clock.frame();
    clock.frame();
    // The frame's task admitted exactly one, and it was the key card.
    expect(store.isAdmitted("B")).toBe(true);
    expect(store.isAdmitted("A")).toBe(false);
    clock.advance(0);
    expect(store.isAdmitted("A")).toBe(true);
  });

  test("the cover lifts on a frame after the last settle, and the frame chain stops", () => {
    const { store, clock } = setup();
    store.enqueue("A");
    clock.frame();
    clock.frame();
    store.settled("A");
    expect(store.isAdmitted("A")).toBe(false);
    expect(store.getSnapshot().cover).toBe(true);
    clock.frame();
    clock.frame();
    expect(store.getSnapshot()).toEqual({ cover: false, cardIds: [] });
    // No rAF is held once the cover is down.
    clock.frame();
    expect(clock.pendingFrames).toBe(0);
  });

  test("with frames stopped, the composite bound still admits", () => {
    const { store, clock } = setup();
    store.enqueue("A");
    clock.advance(COVER_COMPOSITE_BOUND_MS - 1);
    expect(store.isAdmitted("A")).toBe(false);
    clock.advance(1);
    expect(store.isAdmitted("A")).toBe(true);
  });

  test("a reveal that never settles is let go at the settle bound", () => {
    const { store, clock } = setup();
    store.enqueue("A");
    clock.frame();
    clock.frame();
    expect(store.isAdmitted("A")).toBe(true);
    clock.advance(REVEAL_SETTLE_BOUND_MS);
    expect(store.isAdmitted("A")).toBe(false);
    expect(store.getSnapshot().cardIds).toEqual([]);
    clock.frame();
    clock.frame();
    expect(store.getSnapshot().cover).toBe(false);
  });

  test("a removed card leaves at once and never holds the cover", () => {
    const { store, clock } = setup();
    store.enqueue("A");
    store.removed("A");
    expect(store.getSnapshot()).toEqual({ cover: false, cardIds: [] });
    clock.frame();
    clock.advance(COVER_COMPOSITE_BOUND_MS);
    expect(store.isAdmitted("A")).toBe(false);
  });

  test("an unchanged snapshot keeps its identity", () => {
    const { store } = setup();
    store.enqueue("A");
    const first = store.getSnapshot();
    store.enqueue("A");
    expect(store.getSnapshot()).toBe(first);
  });
});
