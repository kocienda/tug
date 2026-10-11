/**
 * subscribable — the shared subscribe-and-notify every store adopts.
 *
 * The contract React reads through `useSyncExternalStore`: subscribe returns
 * the unsubscribe, unsubscribing twice is harmless, and the listener set may
 * change under a notify without corrupting it.
 */

import { describe, expect, test } from "bun:test";
import { createSubscribable, Subscribable } from "@/lib/subscribable";

describe("Subscribable", () => {
  test("notify calls every subscribed listener", () => {
    const s = createSubscribable();
    const calls: string[] = [];
    s.subscribe(() => calls.push("a"));
    s.subscribe(() => calls.push("b"));
    s.notify();
    expect(calls).toEqual(["a", "b"]);
    expect(s.listenerCount).toBe(2);
  });

  test("the returned unsubscribe removes only its listener", () => {
    const s = createSubscribable();
    const calls: string[] = [];
    const offA = s.subscribe(() => calls.push("a"));
    s.subscribe(() => calls.push("b"));
    offA();
    s.notify();
    expect(calls).toEqual(["b"]);
    expect(s.listenerCount).toBe(1);
  });

  test("unsubscribing twice is a no-op", () => {
    const s = createSubscribable();
    const calls: string[] = [];
    const offA = s.subscribe(() => calls.push("a"));
    s.subscribe(() => calls.push("b"));
    offA();
    offA();
    s.notify();
    expect(calls).toEqual(["b"]);
    expect(s.listenerCount).toBe(1);
  });

  test("a listener unsubscribing during its own notify runs once and leaves the rest intact", () => {
    const s = createSubscribable();
    const calls: string[] = [];
    s.subscribe(() => calls.push("before"));
    const off = s.subscribe(() => {
      calls.push("self");
      off();
    });
    s.subscribe(() => calls.push("after"));
    s.notify();
    expect(calls).toEqual(["before", "self", "after"]);
    calls.length = 0;
    s.notify();
    expect(calls).toEqual(["before", "after"]);
  });

  test("a listener subscribed during a notify hears the next one, not this one", () => {
    const s = createSubscribable();
    const calls: string[] = [];
    s.subscribe(() => {
      calls.push("first");
      s.subscribe(() => calls.push("late"));
    });
    s.notify();
    expect(calls).toEqual(["first"]);
  });

  test("subscribe works unbound, as useSyncExternalStore calls it", () => {
    const s = new Subscribable();
    const { subscribe } = s;
    let n = 0;
    const off = subscribe(() => n++);
    s.notify();
    off();
    s.notify();
    expect(n).toBe(1);
  });

  test("a subclass overrides notify and reaches the base through super", () => {
    class Store extends Subscribable {
      cache: number | null = 1;
      override notify(): void {
        this.cache = null;
        super.notify();
      }
    }
    const store = new Store();
    let seen: number | null | undefined;
    store.subscribe(() => {
      seen = store.cache;
    });
    store.notify();
    expect(seen).toBeNull();
  });

  test("notifyCatching hands a throw to onError and still calls the rest", () => {
    const s = createSubscribable();
    const calls: string[] = [];
    const errors: unknown[] = [];
    s.subscribe(() => calls.push("a"));
    s.subscribe(() => {
      throw new Error("boom");
    });
    s.subscribe(() => calls.push("c"));
    s.notifyCatching((error) => errors.push(error));
    expect(calls).toEqual(["a", "c"]);
    expect(errors.length).toBe(1);
    expect((errors[0] as Error).message).toBe("boom");
  });

  test("notifyCatching names the listener that threw and its position", () => {
    const s = createSubscribable();
    const seen: Array<[unknown, () => void, number]> = [];
    s.subscribe(() => {});
    function broken(): void {
      throw new Error("boom");
    }
    s.subscribe(broken);
    s.notifyCatching((error, listener, index) => seen.push([error, listener, index]));
    expect(seen.length).toBe(1);
    expect(seen[0][1]).toBe(broken);
    expect(seen[0][2]).toBe(1);
  });

  test("clearListeners drops every listener", () => {
    const s = createSubscribable();
    let n = 0;
    s.subscribe(() => n++);
    s.subscribe(() => n++);
    s.clearListeners();
    s.notify();
    expect(n).toBe(0);
    expect(s.listenerCount).toBe(0);
  });
});
