/**
 * The crossing solve, read over a stepped clock: it ends the episode only
 * once the host's resize lands (or its fallback runs out), says solved only
 * after a quiet frame and never before the second, waits out any reflow a
 * list view still owes, and a cancel stops it.
 */

import { describe, expect, test } from "bun:test";

import { runCrossingSolve, SOLVE_QUIET_FRAME_CAP, SOLVE_RESIZE_FALLBACK_MS } from "../crossing-solve";

/**
 * A page whose clock, frames, timers and resize advance by hand. A list view
 * on it owes a reflow for its first `owedFlushes` frames' flushes.
 */
function page(busyUntil = Number.NEGATIVE_INFINITY, owedFlushes = 0) {
  let t = 0;
  let nextId = 1;
  let flushes = 0;
  const frames = new Map<number, () => void>();
  const timers = new Map<number, { at: number; cb: () => void }>();
  let resize: (() => void) | null = null;
  const log: string[] = [];
  const solved: { resizeMissed: boolean; frames: number }[] = [];
  const cancel = runCrossingSolve({
    now: () => t,
    raf: (cb) => {
      const id = nextId++;
      frames.set(id, cb);
      return id;
    },
    cancelRaf: (id) => frames.delete(id),
    setTimer: (cb, ms) => {
      const id = nextId++;
      timers.set(id, { at: t + ms, cb });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    onResize: (cb) => {
      resize = cb;
      return () => {
        resize = null;
      };
    },
    endEpisode: () => log.push(`episode end at ${t}`),
    // Busy (a delivery or a commit) until `busyUntil`; quiet after.
    quietSince: (since) => since >= busyUntil,
    flushReflows: () => {
      flushes += 1;
    },
    reflowOwed: () => flushes <= owedFlushes,
    solved: (facts) => solved.push(facts),
  });
  return {
    cancel,
    log,
    solved,
    flushes: () => flushes,
    resize(at: number) {
      t = at;
      resize?.();
    },
    advance(to: number) {
      t = to;
      for (const [id, timer] of [...timers]) {
        if (timer.at > to) continue;
        timers.delete(id);
        timer.cb();
      }
    },
    frame(at: number) {
      t = at;
      const [id, cb] = [...frames][0] ?? [];
      if (id === undefined || cb === undefined) return;
      frames.delete(id);
      cb();
    },
    pending: () => frames.size + timers.size + (resize === null ? 0 : 1),
  };
}

describe("runCrossingSolve", () => {
  test("the episode ends at the host's resize, and the page is solved two quiet frames on", () => {
    const p = page();
    p.frame(16.7);
    expect(p.log).toEqual([]);
    p.resize(20);
    expect(p.log).toEqual(["episode end at 20"]);
    p.frame(33.3);
    expect(p.solved).toEqual([]);
    p.frame(50);
    expect(p.solved).toEqual([{ resizeMissed: false, frames: 2 }]);
    expect(p.pending()).toBe(0);
  });

  test("a frame a delivery or a commit ran in is not the quiet one", () => {
    const p = page(55);
    p.resize(20);
    p.frame(33.3);
    p.frame(50);
    p.frame(66.7);
    expect(p.solved).toEqual([]);
    p.frame(83.3);
    expect(p.solved).toEqual([{ resizeMissed: false, frames: 4 }]);
  });

  test("a quiet frame is not solved while a list view still owes its reflow", () => {
    // The width change's debounce and drain: quiet frames, and the page is
    // not laid out until the drain has nothing left.
    const p = page(Number.NEGATIVE_INFINITY, 4);
    p.resize(20);
    p.frame(33.3);
    p.frame(50);
    p.frame(66.7);
    p.frame(83.3);
    expect(p.solved).toEqual([]);
    p.frame(100);
    expect(p.solved).toEqual([{ resizeMissed: false, frames: 5 }]);
  });

  test("every frame it waits asks the list views to answer their width change now", () => {
    const p = page(Number.NEGATIVE_INFINITY, 2);
    p.resize(20);
    p.frame(33.3);
    expect(p.flushes()).toBe(1);
    p.frame(50);
    p.frame(66.7);
    expect(p.flushes()).toBe(3);
    expect(p.solved).toEqual([{ resizeMissed: false, frames: 3 }]);
  });

  test("with no resize the fallback solves, and says so", () => {
    const p = page();
    p.advance(SOLVE_RESIZE_FALLBACK_MS - 1);
    expect(p.log).toEqual([]);
    p.advance(SOLVE_RESIZE_FALLBACK_MS);
    expect(p.log).toEqual([`episode end at ${SOLVE_RESIZE_FALLBACK_MS}`]);
    p.frame(116.7);
    p.frame(133.3);
    expect(p.solved).toEqual([{ resizeMissed: true, frames: 2 }]);
  });

  test("a page that never goes quiet says solved at the cap rather than pumping frames for ever", () => {
    const p = page(Number.POSITIVE_INFINITY);
    p.resize(0);
    for (let i = 1; i <= SOLVE_QUIET_FRAME_CAP; i++) p.frame(i * 16.7);
    expect(p.solved).toEqual([{ resizeMissed: false, frames: SOLVE_QUIET_FRAME_CAP }]);
    expect(p.pending()).toBe(0);
  });

  test("a cancel before the resize ends nothing and leaves nothing pending", () => {
    const p = page();
    p.cancel();
    expect(p.pending()).toBe(0);
    p.resize(20);
    p.advance(500);
    expect(p.log).toEqual([]);
    expect(p.solved).toEqual([]);
  });

  test("a cancel mid-wait stops the frames", () => {
    const p = page();
    p.resize(20);
    p.frame(33.3);
    p.cancel();
    expect(p.pending()).toBe(0);
    expect(p.solved).toEqual([]);
  });
});
