// tugcode/src/__tests__/timer-set.test.ts
//
// `TimerSet`: keyed timers the session manager clears in one call.

import { describe, expect, test } from "bun:test";

import { TimerSet } from "../timer-set.ts";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("TimerSet", () => {
  test("a timeout fires once and its entry is gone by the time the callback runs", async () => {
    const timers = new TimerSet();
    const seen: boolean[] = [];
    timers.setTimeout("t", () => seen.push(timers.has("t")), 1);
    expect(timers.has("t")).toBe(true);
    await tick(10);
    expect(seen).toEqual([false]);
    expect(timers.keys()).toEqual([]);
  });

  test("arming a key again replaces the timer armed under it", async () => {
    const timers = new TimerSet();
    const fired: string[] = [];
    timers.setTimeout("t", () => fired.push("first"), 1);
    timers.setTimeout("t", () => fired.push("second"), 1);
    await tick(10);
    expect(fired).toEqual(["second"]);
  });

  test("clear cancels one key and leaves the others armed", async () => {
    const timers = new TimerSet();
    const fired: string[] = [];
    timers.setTimeout("a", () => fired.push("a"), 1);
    timers.setTimeout("b", () => fired.push("b"), 1);
    timers.clear("a");
    await tick(10);
    expect(fired).toEqual(["b"]);
  });

  test("clearAll cancels timeouts and intervals alike", async () => {
    const timers = new TimerSet();
    const fired: string[] = [];
    timers.setTimeout("once", () => fired.push("once"), 5);
    timers.setInterval("every", () => fired.push("every"), 1, { unref: true });
    await tick(3);
    timers.clearAll();
    const count = fired.length;
    await tick(15);
    expect(fired.length).toBe(count);
    expect(fired).not.toContain("once");
    expect(timers.keys()).toEqual([]);
  });
});
