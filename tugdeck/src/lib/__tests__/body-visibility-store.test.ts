/**
 * The body visibility store and its dormant clock, over a hand-driven clock.
 *
 * @covers tugdeck/src/lib/body-visibility-store.ts
 * @covers tugdeck/src/lib/dormant-after-pref.ts
 */

import { describe, expect, test } from "bun:test";
import { BodyVisibilityStore, type DormantClock } from "../body-visibility-store";
import {
  DEFAULT_DORMANT_AFTER_MS,
  dormantAfterLabel,
  parseBodyDelayMs,
  resolveDormantAfterMs,
} from "../dormant-after-pref";

/** A clock that only moves when the test says so. */
class ManualClock implements DormantClock {
  private t = 1_000_000;
  private next = 1;
  private readonly timers = new Map<number, { at: number; fire: () => void }>();

  now(): number {
    return this.t;
  }
  setTimeout(fire: () => void, ms: number): unknown {
    const id = this.next++;
    this.timers.set(id, { at: this.t + ms, fire });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  get pending(): number {
    return this.timers.size;
  }
  advance(ms: number): void {
    this.t += ms;
    for (const [id, timer] of [...this.timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at > this.t) continue;
      this.timers.delete(id);
      timer.fire();
    }
  }
}

function setup(delay = 60_000) {
  const clock = new ManualClock();
  const store = new BodyVisibilityStore(clock, delay);
  let notified = 0;
  store.subscribe(() => notified++);
  return { clock, store, notifications: () => notified };
}

describe("BodyVisibilityStore", () => {
  test("a page the host has said nothing to reads as shown and awake", () => {
    const { store, clock } = setup();
    expect(store.getSnapshot()).toEqual({ shown: true, since: 0, dormant: false });
    expect(clock.pending).toBe(0);
  });

  test("hidden for the delay goes dormant, and not a moment before", () => {
    const { store, clock, notifications } = setup(60_000);
    store.apply({ shown: false, since: clock.now() });
    expect(store.getSnapshot().shown).toBe(false);
    clock.advance(59_999);
    expect(store.getSnapshot().dormant).toBe(false);
    clock.advance(1);
    expect(store.getSnapshot().dormant).toBe(true);
    expect(notifications()).toBe(2);
  });

  test("the clock counts from the host's since, not from when the message arrived", () => {
    const { store, clock } = setup(60_000);
    store.apply({ shown: false, since: clock.now() - 50_000 });
    clock.advance(10_000);
    expect(store.getSnapshot().dormant).toBe(true);
  });

  test("shown before the delay cancels the clock", () => {
    const { store, clock } = setup(60_000);
    store.apply({ shown: false, since: clock.now() });
    clock.advance(30_000);
    store.apply({ shown: true, since: clock.now() });
    expect(clock.pending).toBe(0);
    clock.advance(60_000);
    expect(store.getSnapshot().dormant).toBe(false);
  });

  test("a dormant body shown again stays dormant until it wakes", () => {
    const { store, clock } = setup(1000);
    store.apply({ shown: false, since: clock.now() });
    clock.advance(1000);
    store.apply({ shown: true, since: clock.now() });
    expect(store.getSnapshot()).toMatchObject({ shown: true, dormant: true });
    store.wake();
    expect(store.getSnapshot()).toMatchObject({ shown: true, dormant: false });
    expect(clock.pending).toBe(0);
  });

  test("a body that wakes while still hidden starts a fresh clock from when it was hidden", () => {
    const { store, clock } = setup(1000);
    store.apply({ shown: false, since: clock.now() });
    clock.advance(1000);
    store.wake();
    // Hidden longer than the delay already: dormant again at once.
    clock.advance(0);
    expect(store.getSnapshot().dormant).toBe(true);
  });

  test("a repeated word changes nothing and notifies no one", () => {
    const { store, clock, notifications } = setup();
    const since = clock.now();
    store.apply({ shown: false, since });
    store.apply({ shown: false, since });
    expect(notifications()).toBe(1);
    expect(clock.pending).toBe(1);
  });

  test("a new delay re-arms a hidden body's clock against the time already spent hidden", () => {
    const { store, clock } = setup(60_000);
    store.apply({ shown: false, since: clock.now() });
    clock.advance(20_000);
    store.setDormantAfterMs(30_000);
    clock.advance(9_999);
    expect(store.getSnapshot().dormant).toBe(false);
    clock.advance(1);
    expect(store.getSnapshot().dormant).toBe(true);
  });

  test("a delay shortened past the time spent hidden makes the body dormant at once", () => {
    const { store, clock } = setup(60_000);
    store.apply({ shown: false, since: clock.now() });
    clock.advance(20_000);
    store.setDormantAfterMs(5_000);
    clock.advance(0);
    expect(store.getSnapshot().dormant).toBe(true);
  });

  test("a new delay on a shown body arms nothing", () => {
    const { store, clock } = setup();
    store.setDormantAfterMs(1000);
    expect(store.delayMs).toBe(1000);
    expect(clock.pending).toBe(0);
  });

  test("dispose stops the clock", () => {
    const { store, clock } = setup(1000);
    store.apply({ shown: false, since: clock.now() });
    store.dispose();
    clock.advance(5000);
    expect(store.getSnapshot().dormant).toBe(false);
  });
});

describe("the dormant-after preference", () => {
  test("a positive whole number of ms is the delay; anything else is no preference", () => {
    expect(parseBodyDelayMs({ kind: "i64", value: 2000 })).toBe(2000);
    expect(parseBodyDelayMs(undefined)).toBeNull();
    expect(parseBodyDelayMs({ kind: "i64", value: 0 })).toBeNull();
    expect(parseBodyDelayMs({ kind: "i64", value: -5 })).toBeNull();
    expect(parseBodyDelayMs({ kind: "f64", value: 1.5 })).toBeNull();
    expect(parseBodyDelayMs({ kind: "string", value: "60000" })).toBeNull();
  });

  test("no preference is a minute", () => {
    expect(resolveDormantAfterMs(null)).toBe(DEFAULT_DORMANT_AFTER_MS);
    expect(DEFAULT_DORMANT_AFTER_MS).toBe(60_000);
    expect(resolveDormantAfterMs(5000)).toBe(5000);
  });

  test("labels read as the row shows them", () => {
    expect(dormantAfterLabel(30_000)).toBe("30s");
    expect(dormantAfterLabel(60_000)).toBe("1m");
    expect(dormantAfterLabel(900_000)).toBe("15m");
    expect(dormantAfterLabel(2_500)).toBe("2.5s");
  });
});
