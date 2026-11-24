import { describe, expect, it } from "bun:test";

import { SessionActivityStore } from "../session-activity-store";

const S = "sess-1";

function newStore(): SessionActivityStore {
  // No connection — drive record() directly (the wire handler is exercised
  // via parseActivityFrame's own tests).
  return new SessionActivityStore(null);
}

describe("SessionActivityStore", () => {
  it("records a channel sample and reflects it in that channel's series", () => {
    const store = newStore();
    const now = 1_000;
    store.record(S, "text", 120, now);
    const series = store.series(S, "text", now);
    expect(series[series.length - 1]).toBe(120);
    // An absent channel yields an empty series, never throws.
    expect(store.series(S, "tokens", now)).toEqual([]);
    expect(store.series("nobody", "text", now)).toEqual([]);
  });

  it("composites per-bin across rate channels only", () => {
    const store = newStore();
    const now = 1_000;
    store.record(S, "text", 100, now);
    store.record(S, "tokens", 40, now);
    store.record(S, "tools", 10, now);
    // cpu is a gauge — a level, not work — so it is excluded from the composite.
    store.record(S, "cpu", 88, now);
    const composite = store.compositeSeries(S, now);
    expect(composite[composite.length - 1]).toBe(150);
  });

  it("machine work is a rate: it joins the composite and can take the hue", () => {
    const store = newStore();
    const now = 1_000;
    store.record(S, "text", 30, now);
    store.record(S, "machine", 600, now);
    const composite = store.compositeSeries(S, now);
    expect(composite[composite.length - 1]).toBe(630);
    // A session whose line is machine work reads as machine work.
    expect(store.dominant(S, now)).toBe("machine");
  });

  it("machine work wakes a composite listener", () => {
    const store = newStore();
    const woke: string[] = [];
    const unsubscribe = store.subscribeActivity(S, (channel) => {
      woke.push(channel);
    });
    store.record(S, "machine", 60, 1_000);
    expect(woke).toEqual(["machine"]);
    unsubscribe();
  });

  it("reports the dominant rate channel, and null when idle", () => {
    const store = newStore();
    const now = 1_000;
    expect(store.dominant(S, now)).toBeNull();
    store.record(S, "text", 30, now);
    store.record(S, "subagents", 500, now);
    expect(store.dominant(S, now)).toBe("subagents");
  });

  it("dominant hysteresis holds the incumbent through a single-sample challenger", () => {
    const store = newStore();
    // Establish `text` as the incumbent: it leads at t=1000.
    store.record(S, "text", 300, 1_000);
    expect(store.dominant(S, 1_000)).toBe("text");

    // A single subagent burst lands — larger in the window, but momentary.
    store.record(S, "subagents", 500, 1_050);
    // Shortly after (< the 500 ms hold), the incumbent still holds the color.
    expect(store.dominant(S, 1_100)).toBe("text");
    expect(store.dominant(S, 1_300)).toBe("text");

    // If the challenger sustains its lead past the hold window, it takes over.
    store.record(S, "subagents", 500, 1_400);
    store.record(S, "subagents", 500, 1_650);
    expect(store.dominant(S, 1_700)).toBe("subagents");
  });

  it("intensity rises with composite work and clamps to 1", () => {
    const store = newStore();
    const now = 1_000;
    expect(store.intensity(S, now)).toBe(0);
    store.record(S, "text", 300, now);
    const mid = store.intensity(S, now);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThanOrEqual(1);
    store.record(S, "text", 100_000, now);
    expect(store.intensity(S, now)).toBe(1);
  });

  it("membership snapshot ticks only on a new session / channel, not every sample", () => {
    const store = newStore();
    let ticks = 0;
    store.subscribe(() => {
      ticks += 1;
    });
    store.record(S, "text", 10, 0); // new session + new channel
    store.record(S, "text", 10, 0); // same channel — no membership change
    expect(ticks).toBe(1);
    store.record(S, "tokens", 5, 0); // new channel
    expect(ticks).toBe(2);
    expect(store.getSnapshot().sessions.get(S)).toEqual(["text", "tokens"]);
  });

  it("channels() lists a session's channels in canonical order (the card's row set)", () => {
    const store = newStore();
    const now = 1_000;
    // Record out of canonical order and across rate + gauge kinds.
    store.record(S, "cpu", 40, now);
    store.record(S, "text", 100, now);
    store.record(S, "machine", 60, now);
    store.record(S, "subagents", 5, now);
    store.record(S, "tokens", 20, now);
    // The Activity card maps `channels(session)` to its rows, so the order
    // is the canonical descriptor order regardless of arrival order.
    expect(store.channels(S)).toEqual(["text", "tokens", "subagents", "machine", "cpu"]);
    expect(store.getSnapshot().sessions.get(S)).toEqual([
      "text",
      "tokens",
      "subagents",
      "machine",
      "cpu",
    ]);
  });

  it("clearSession drops the session's meters and membership", () => {
    const store = newStore();
    store.record(S, "text", 10, 0);
    store.clearSession(S);
    expect(store.channels(S)).toEqual([]);
    expect(store.getSnapshot().sessions.has(S)).toBe(false);
  });

  it("subscribeActivity wakes on rate units with the channel, never on zeros", () => {
    const store = newStore();
    const woke: string[] = [];
    const unsubscribe = store.subscribeActivity(S, (channel) => {
      woke.push(channel);
    });
    // A zero-unit rate sample is silence, not activity.
    store.record(S, "text", 0, 1_250);
    expect(woke).toEqual([]);
    // Real rate work wakes, synchronously within record().
    store.record(S, "text", 120, 1_500);
    expect(woke).toEqual(["text"]);
    // Another session's activity never crosses over.
    store.record("other", "text", 120, 1_500);
    expect(woke).toEqual(["text"]);
    unsubscribe();
    store.record(S, "text", 120, 1_750);
    expect(woke).toEqual(["text"]);
  });

  it("gauge events pass the change gate: first sample, then epsilon moves only", () => {
    const store = newStore();
    const woke: string[] = [];
    store.subscribeActivity(S, (channel) => {
      woke.push(channel);
    });
    // First sample establishes the published reference — and is an event
    // (a consumer must learn the opening level).
    store.record(S, "cpu", 50, 1_000);
    expect(woke).toEqual(["cpu"]);
    // Sub-epsilon jitter (cpu fullScale 100 → epsilon 1) updates the meter
    // but wakes nothing.
    store.record(S, "cpu", 50.4, 1_250);
    store.record(S, "cpu", 49.7, 1_500);
    expect(woke).toEqual(["cpu"]);
    // Drift accumulates against the PUBLISHED reference, not the previous
    // sample — 0.6 steps ratchet across the threshold and fire once crossed.
    store.record(S, "cpu", 50.6, 1_750);
    expect(woke).toEqual(["cpu"]);
    store.record(S, "cpu", 51.2, 2_000);
    expect(woke).toEqual(["cpu", "cpu"]);
    // A real move fires immediately.
    store.record(S, "cpu", 80, 2_250);
    expect(woke).toEqual(["cpu", "cpu", "cpu"]);
  });

  it("activity listeners survive clearSession (a revived id still wakes)", () => {
    const store = newStore();
    let wakes = 0;
    store.subscribeActivity(S, () => {
      wakes += 1;
    });
    store.record(S, "text", 10, 1_000);
    expect(wakes).toBe(1);
    store.clearSession(S);
    store.record(S, "text", 10, 2_000);
    expect(wakes).toBe(2);
  });

  it("clearSession resets the gauge reference — a revived session republishes", () => {
    const store = newStore();
    const woke: string[] = [];
    store.subscribeActivity(S, (channel) => {
      woke.push(channel);
    });
    store.record(S, "cpu", 50, 1_000);
    expect(woke).toEqual(["cpu"]);
    store.clearSession(S);
    // Same level as before the clear: still an event, because the revived
    // session's consumers rebuilt from empty history.
    store.record(S, "cpu", 50, 2_000);
    expect(woke).toEqual(["cpu", "cpu"]);
  });

  it("raw() returns a held gauge value with its unit, null for rate/absent", () => {
    const store = newStore();
    const now = Date.now();
    store.record(S, "cpu", 42, now);
    expect(store.raw(S, "cpu")).toEqual({ value: 42, unit: "%" });
    // A rate channel has no held level.
    store.record(S, "text", 10, now);
    expect(store.raw(S, "text")).toBeNull();
  });
});
