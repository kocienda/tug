import { describe, expect, it } from "bun:test";

import { AFTER_PAINT_DEADLINE_MS, type AfterPaintOptions } from "../after-paint";
import {
  flushThrough,
  GestureScope,
  installGestureScope,
  wrapSubscribe,
  wrappedSubscribeFor,
} from "../gesture-scope";

/**
 * A scope whose release is captured rather than scheduled: `flushes[i]` is the
 * i-th scheduled release, `frames[i]` fires its frame, `opts[i]` is what it was
 * scheduled with, and `cancelled[i]` says whether the scope took it back.
 */
function harness(motion = true) {
  const flushes: Array<() => void> = [];
  const frames: Array<() => void> = [];
  const opts: AfterPaintOptions[] = [];
  const cancelled: boolean[] = [];
  const clock = { now: 0 };
  const scope = new GestureScope(
    (flush, o) => {
      const i = flushes.length;
      flushes.push(flush);
      frames.push(() => o.onFrame?.());
      opts.push(o);
      cancelled.push(false);
      return () => {
        cancelled[i] = true;
      };
    },
    () => motion,
    () => clock.now,
  );
  return { scope, flushes, frames, opts, cancelled, clock };
}

function thrower(message: string): () => void {
  return () => {
    throw new Error(message);
  };
}

describe("GestureScope", () => {
  it("runs a tell inline with nothing pending, holds it after open, and coalesces repeats", () => {
    const { scope, flushes } = harness();
    const calls: string[] = [];
    const cb = () => calls.push("cb");
    scope.tell(cb);
    expect(calls).toEqual(["cb"]);

    scope.open("pointer");
    scope.tell(cb);
    scope.tell(cb);
    expect(calls).toEqual(["cb"]);
    expect(flushes.length).toBe(1);

    flushes[0]();
    expect(calls).toEqual(["cb", "cb"]);
    expect(scope.isPending()).toBe(false);
  });

  it("joins a pending scope whose frame has not fired, rather than scheduling a second release", () => {
    const { scope, flushes } = harness();
    scope.open("pointer");
    scope.open("prelaunch");
    expect(flushes.length).toBe(1);
  });

  it("re-arms the release past the next paint when an open arrives after the frame, within the deadline", () => {
    const { scope, flushes, frames, opts, cancelled, clock } = harness();
    scope.open("pointer");
    expect(opts[0].deadlineMs).toBe(AFTER_PAINT_DEADLINE_MS);
    clock.now = 17;
    frames[0]();
    scope.open("pointer");

    expect(flushes.length).toBe(2);
    expect(cancelled).toEqual([true, false]);
    // The deadline counts from the hold's first open, not this one.
    expect(opts[1].deadlineMs).toBe(AFTER_PAINT_DEADLINE_MS - 17);

    // The second release's frame has not fired, so a third open joins it.
    scope.open("pointer");
    expect(flushes.length).toBe(2);

    const calls: string[] = [];
    scope.tell(() => calls.push("cb"));
    flushes[1]();
    expect(calls).toEqual(["cb"]);
    expect(scope.isPending()).toBe(false);
  });

  it("joins after the frame once the hold has spent its deadline, so React is not starved", () => {
    const { scope, flushes, frames, cancelled, clock } = harness();
    scope.open("pointer");
    clock.now = AFTER_PAINT_DEADLINE_MS;
    frames[0]();
    scope.open("pointer");
    expect(flushes.length).toBe(1);
    expect(cancelled).toEqual([false]);
  });

  it("starts a fresh hold, with a fresh deadline, after a release", () => {
    const { scope, flushes, frames, opts, clock } = harness();
    scope.open("pointer");
    frames[0]();
    flushes[0]();
    clock.now = 500;
    scope.open("pointer");
    expect(opts[1].deadlineMs).toBe(AFTER_PAINT_DEADLINE_MS);
    frames[1]();
    clock.now = 510;
    scope.open("pointer");
    expect(opts[2].deadlineMs).toBe(AFTER_PAINT_DEADLINE_MS - 10);
  });

  it("releases held callbacks and afterGesture work in insertion order", () => {
    const { scope } = harness();
    const calls: string[] = [];
    scope.open("pointer");
    scope.tell(() => calls.push("a"));
    scope.enqueue(() => calls.push("q"));
    scope.tell(() => calls.push("b"));
    scope.release();
    expect(calls).toEqual(["a", "b", "q"]);
  });

  it("runs afterGesture work inline when no scope is pending", () => {
    const { scope } = harness();
    const calls: string[] = [];
    scope.enqueue(() => calls.push("q"));
    expect(calls).toEqual(["q"]);
  });

  it("is idempotent on release, as the deadline and the paint timer both fire", () => {
    const { scope } = harness();
    let n = 0;
    scope.open("pointer");
    scope.tell(() => (n += 1));
    scope.enqueue(() => (n += 10));
    scope.release();
    scope.release();
    expect(n).toBe(11);
  });

  it("runs a tell inline under withBypass while pending", () => {
    const { scope } = harness();
    const calls: string[] = [];
    scope.open("pointer");
    scope.withBypass(() => scope.tell(() => calls.push("now")));
    expect(calls).toEqual(["now"]);
  });

  it("schedules a fresh release when a released callback re-opens", () => {
    const { scope, flushes } = harness();
    scope.open("pointer");
    scope.tell(() => scope.open("pointer"));
    scope.release();
    expect(scope.isPending()).toBe(true);
    expect(flushes.length).toBe(2);
  });

  it("opens nothing with motion off, so a tell stays inline", () => {
    const { scope, flushes } = harness(false);
    const calls: string[] = [];
    scope.open("pointer");
    scope.tell(() => calls.push("cb"));
    expect(calls).toEqual(["cb"]);
    expect(scope.isPending()).toBe(false);
    expect(flushes.length).toBe(0);
  });

  it("drain runs the held set and the queue but leaves the scope pending", () => {
    const { scope } = harness();
    const calls: string[] = [];
    scope.open("pointer");
    scope.tell(() => calls.push("a"));
    scope.enqueue(() => calls.push("q"));
    scope.drain();
    expect(calls).toEqual(["a", "q"]);
    expect(scope.isPending()).toBe(true);

    scope.tell(() => calls.push("b"));
    expect(calls).toEqual(["a", "q"]);
    scope.release();
    expect(calls).toEqual(["a", "q", "b"]);
  });

  it("runs every held tell and queued body when one throws, then rethrows the first error", () => {
    const { scope } = harness();
    const calls: string[] = [];
    scope.open("pointer");
    scope.tell(() => calls.push("a"));
    scope.tell(thrower("first"));
    scope.tell(() => calls.push("b"));
    scope.enqueue(() => calls.push("q"));
    expect(() => scope.release()).toThrow("first");
    expect(calls).toEqual(["a", "b", "q"]);
    expect(scope.isPending()).toBe(false);
    // Nothing is left behind to run a second time.
    scope.release();
    expect(calls).toEqual(["a", "b", "q"]);
  });

  it("drain survives a throw the same way, and the scope stays pending", () => {
    const { scope } = harness();
    const calls: string[] = [];
    scope.open("pointer");
    scope.enqueue(thrower("queued"));
    scope.enqueue(() => calls.push("q"));
    expect(() => scope.drain()).toThrow("queued");
    expect(calls).toEqual(["q"]);
    expect(scope.isPending()).toBe(true);
    // The bypass unwound: a tell is held again.
    scope.tell(() => calls.push("held"));
    expect(calls).toEqual(["q"]);
  });
});

describe("flushThrough", () => {
  it("drains the held set and the afterGesture queue before the body, and leaves the scope pending", () => {
    const { scope } = harness();
    const calls: string[] = [];
    scope.open("pointer");
    scope.tell(() => calls.push("tell"));
    scope.enqueue(() => calls.push("queued"));
    const result = flushThrough(scope, () => {
      calls.push("body");
      return 7;
    });
    expect(result).toBe(7);
    expect(calls).toEqual(["tell", "queued", "body"]);
    expect(scope.isPending()).toBe(true);
  });

  it("runs the body even when the drain throws, then rethrows the drain's error", () => {
    const { scope } = harness();
    const calls: string[] = [];
    scope.open("pointer");
    scope.tell(thrower("drain"));
    expect(() => flushThrough(scope, () => calls.push("body"))).toThrow("drain");
    expect(calls).toEqual(["body"]);
  });

  it("lets the body's own error win over the drain's", () => {
    const { scope } = harness();
    scope.open("pointer");
    scope.tell(thrower("drain"));
    const original = console.error;
    console.error = () => {};
    try {
      expect(() => flushThrough(scope, thrower("body"))).toThrow("body");
    } finally {
      console.error = original;
    }
  });
});

describe("wrapSubscribe", () => {
  it("delivers a store change through the scope and forgets it on unsubscribe", () => {
    const { scope } = harness();
    let listener: (() => void) | null = null;
    let unsubscribed = false;
    const subscribe = (cb: () => void) => {
      listener = cb;
      return () => {
        unsubscribed = true;
      };
    };
    let changes = 0;
    const unsubscribe = wrapSubscribe(subscribe, scope)(() => (changes += 1));

    listener!();
    expect(changes).toBe(1);

    scope.open("pointer");
    listener!();
    expect(changes).toBe(1);

    unsubscribe();
    expect(unsubscribed).toBe(true);
    scope.release();
    expect(changes).toBe(1);
  });
});

describe("wrappedSubscribeFor", () => {
  it("maps the same subscribe to the same wrapper", () => {
    const subscribe = (_cb: () => void) => () => {};
    const other = (_cb: () => void) => () => {};
    expect(wrappedSubscribeFor(subscribe)).toBe(wrappedSubscribeFor(subscribe));
    expect(wrappedSubscribeFor(other)).not.toBe(wrappedSubscribeFor(subscribe));
  });
});

describe("installGestureScope", () => {
  it("adds capture listeners for the five pointer events and removes exactly those", () => {
    const added: Array<[string, unknown, unknown]> = [];
    const removed: Array<[string, unknown, unknown]> = [];
    const target = {
      addEventListener: (type: string, fn: unknown, options: unknown) => added.push([type, fn, options]),
      removeEventListener: (type: string, fn: unknown, options: unknown) => removed.push([type, fn, options]),
    } as unknown as EventTarget;

    const remove = installGestureScope(target);
    expect(added.map(([type]) => type)).toEqual(["pointerdown", "mousedown", "pointerup", "mouseup", "click"]);
    expect(added.every(([, , options]) => options === true)).toBe(true);
    expect(removed).toEqual([]);

    remove();
    expect(removed).toEqual(added);
  });
});
