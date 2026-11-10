/**
 * holdThroughSettleTail — a claimed scroller keeps its anchor past its
 * episode's end, for the tail, and lets go early the moment the reader takes
 * the scroller back. The clock is a fake one; the scroller is a bare
 * `EventTarget`. No DOM.
 */

import { describe, expect, test } from "bun:test";

import {
  RESIZE_SETTLE_TAIL_MS,
  SETTLE_TAIL_INTENT_EVENTS,
  holdThroughSettleTail,
  type SettleTailRelease,
  type SettleTailTimers,
} from "../resize-episode";

function fakeTimers(): SettleTailTimers & { fire: () => void; pending: () => number; lastMs: () => number } {
  const live = new Map<number, () => void>();
  let next = 1;
  let ms = -1;
  return {
    set: (cb, delay) => {
      ms = delay;
      const id = next++;
      live.set(id, cb);
      return id;
    },
    clear: (handle) => {
      live.delete(handle as number);
    },
    fire: () => {
      for (const [id, cb] of [...live]) {
        live.delete(id);
        cb();
      }
    },
    pending: () => live.size,
    lastMs: () => ms,
  };
}

describe("holdThroughSettleTail", () => {
  test("holds for the tail, then releases once as settled", () => {
    const timers = fakeTimers();
    const released: SettleTailRelease[] = [];
    holdThroughSettleTail(new EventTarget(), (why) => released.push(why), timers);
    expect(released).toEqual([]);
    expect(timers.lastMs()).toBe(RESIZE_SETTLE_TAIL_MS);
    timers.fire();
    expect(released).toEqual(["settled"]);
  });

  test("every intent event lets go at once, as intent, and the timer goes with it", () => {
    for (const type of SETTLE_TAIL_INTENT_EVENTS) {
      const timers = fakeTimers();
      const scroller = new EventTarget();
      const released: SettleTailRelease[] = [];
      holdThroughSettleTail(scroller, (why) => released.push(why), timers);
      scroller.dispatchEvent(new Event(type));
      expect(released).toEqual(["intent"]);
      expect(timers.pending()).toBe(0);
      // A second intent, after the release, is nobody's business.
      scroller.dispatchEvent(new Event(type));
      expect(released).toEqual(["intent"]);
    }
  });

  test("a scroll is not intent: the tail's own re-landing writes one", () => {
    const timers = fakeTimers();
    const scroller = new EventTarget();
    const released: SettleTailRelease[] = [];
    holdThroughSettleTail(scroller, (why) => released.push(why), timers);
    scroller.dispatchEvent(new Event("scroll"));
    expect(released).toEqual([]);
  });

  test("the cancel releases nothing and leaves no timer or listener behind", () => {
    const timers = fakeTimers();
    const scroller = new EventTarget();
    const released: SettleTailRelease[] = [];
    const cancel = holdThroughSettleTail(scroller, (why) => released.push(why), timers);
    cancel();
    expect(timers.pending()).toBe(0);
    scroller.dispatchEvent(new Event("wheel"));
    timers.fire();
    expect(released).toEqual([]);
    cancel();
  });
});
