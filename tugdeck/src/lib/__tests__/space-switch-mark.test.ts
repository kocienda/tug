/**
 * space-switch-mark — the switch epoch's mark lifts on its writer's bound.
 *
 * The canvas's effect is the mark's ordinary close, and it runs only when React
 * sees the active workspace id change. These tests pin the writer's own
 * deadline, which is what lifts the mark when that effect never runs — two
 * switches in one task that end where they began — over a stand-in canvas and
 * a clock turned by hand.
 */

import { describe, expect, test } from "bun:test";

import { AFTER_PAINT_DEADLINE_MS } from "@/lib/after-paint";
import { spaceEpochDeadlineMs } from "@/lib/space-settled";
import {
  SpaceSwitchMark,
  switchMarkDeadlineMs,
  type SwitchMarkTimers,
} from "@/lib/space-switch-mark";

const ATTR = "data-space-switching";

function standInCanvas() {
  const attrs = new Set<string>();
  return {
    attrs,
    setAttribute: (n: string) => void attrs.add(n),
    removeAttribute: (n: string) => void attrs.delete(n),
  };
}

function handClock(): SwitchMarkTimers & {
  pending: Map<number, { fn: () => void; ms: number }>;
  fire: () => void;
} {
  let next = 1;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  return {
    pending,
    setTimeout: (fn, ms) => {
      const id = next++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => {
      pending.delete(id);
    },
    fire: () => {
      const due = [...pending.values()];
      pending.clear();
      for (const t of due) t.fn();
    },
  };
}

describe("SpaceSwitchMark", () => {
  test("the mark lifts on the writer's deadline when nothing else takes it off", () => {
    const clock = handClock();
    const canvas = standInCanvas();
    const mark = new SpaceSwitchMark(ATTR, clock);

    // A switch away and back inside one task: React never sees the id move,
    // so the canvas's close never runs. Only the writer's deadline is left.
    mark.open(canvas, 900);
    mark.open(canvas, 900);
    expect(canvas.attrs.has(ATTR)).toBe(true);
    expect(clock.pending.size).toBe(1);

    clock.fire();
    expect(canvas.attrs.has(ATTR)).toBe(false);
    expect(mark.armed).toBe(false);
  });

  test("a new epoch takes over the deadline rather than adding a second", () => {
    const clock = handClock();
    const first = standInCanvas();
    const second = standInCanvas();
    const mark = new SpaceSwitchMark(ATTR, clock);
    mark.open(first, 900);
    mark.open(second, 900);
    expect(clock.pending.size).toBe(1);
    clock.fire();
    expect(second.attrs.has(ATTR)).toBe(false);
  });

  test("released, it leaves the mark to the canvas and arms nothing", () => {
    const clock = handClock();
    const canvas = standInCanvas();
    const mark = new SpaceSwitchMark(ATTR, clock);
    mark.open(canvas, 900);
    mark.release();
    expect(clock.pending.size).toBe(0);
    expect(canvas.attrs.has(ATTR)).toBe(true);
  });

  test("no canvas, no mark, no deadline", () => {
    const clock = handClock();
    const mark = new SpaceSwitchMark(ATTR, clock);
    mark.open(null, 900);
    expect(clock.pending.size).toBe(0);
    expect(mark.armed).toBe(false);
  });

  test("the writer's deadline stands behind the canvas's, past one after-paint deferral", () => {
    for (const timing of [0.5, 1, 4]) {
      expect(switchMarkDeadlineMs(timing)).toBeGreaterThan(
        spaceEpochDeadlineMs(timing) + AFTER_PAINT_DEADLINE_MS,
      );
    }
  });
});
