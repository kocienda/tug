import { describe, expect, it } from "bun:test";

import { GestureScope, installGestureScope, wrapSubscribe, wrappedSubscribeFor } from "../gesture-scope";

/** A scope whose release is captured rather than scheduled. */
function harness(motion = true) {
  const flushes: Array<() => void> = [];
  const scope = new GestureScope((flush) => flushes.push(flush), () => motion);
  return { scope, flushes };
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

  it("joins a pending scope rather than scheduling a second release", () => {
    const { scope, flushes } = harness();
    scope.open("pointer");
    scope.open("prelaunch");
    expect(flushes.length).toBe(1);
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

  it("drainHeld runs the held set but leaves the scope pending and the queue unrun", () => {
    const { scope } = harness();
    const calls: string[] = [];
    scope.open("pointer");
    scope.tell(() => calls.push("a"));
    scope.enqueue(() => calls.push("q"));
    scope.drainHeld();
    expect(calls).toEqual(["a"]);
    expect(scope.isPending()).toBe(true);

    scope.tell(() => calls.push("b"));
    expect(calls).toEqual(["a"]);
    scope.release();
    expect(calls).toEqual(["a", "b", "q"]);
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
