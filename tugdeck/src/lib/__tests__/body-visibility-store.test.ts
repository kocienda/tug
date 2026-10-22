/**
 * The body visibility store and its dormant clock, over a hand-driven clock.
 *
 * @covers tugdeck/src/lib/body-visibility-store.ts
 */

import { describe, expect, test } from "bun:test";
import { BodyVisibilityStore, DORMANT_AFTER_MS, type DormantClock } from "../body-visibility-store";

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

describe("the dormant delay", () => {
  test("is a minute, and the clock runs to it unless told otherwise", () => {
    expect(DORMANT_AFTER_MS).toBe(60_000);
    expect(new BodyVisibilityStore().delayMs).toBe(DORMANT_AFTER_MS);
  });
});
