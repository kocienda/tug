/**
 * page-zoom-store — the deck's half of a View › Zoom step: "before" goes
 * `zooming` with the target, "after" settles two frames later once nothing
 * holds it, and only the latest zoom of a double-tap settles the snapshot.
 * Frames are driven by hand; no DOM.
 */

import { describe, expect, test } from "bun:test";

import {
  PageZoomStore,
  installPageZoomBridge,
  normalizeFactor,
} from "../page-zoom-store";

/** A frame scheduler the test advances one frame at a time. */
function manualFrames(): { schedule: (cb: () => void) => void; frame: () => void } {
  let queue: Array<() => void> = [];
  return {
    schedule: (cb) => {
      queue.push(cb);
    },
    frame: () => {
      const run = queue;
      queue = [];
      for (const cb of run) cb();
    },
  };
}

/** Let resolved promises' continuations run. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("normalizeFactor", () => {
  test("rounds a host double onto the 1 % grid", () => {
    expect(normalizeFactor(0.7999999523162842)).toBe(0.8);
    expect(normalizeFactor(1.1000000000000001)).toBe(1.1);
  });

  test("anything but a positive finite number is no factor", () => {
    expect(normalizeFactor(undefined)).toBeNull();
    expect(normalizeFactor(0)).toBeNull();
    expect(normalizeFactor(Number.NaN)).toBeNull();
    expect(normalizeFactor("0.9")).toBeNull();
  });
});

describe("PageZoomStore", () => {
  test("starts with no factor, settled", () => {
    const store = new PageZoomStore(manualFrames().schedule);
    expect(store.getSnapshot()).toEqual({ factor: null, phase: "settled" });
  });

  test("a standing report sets the factor without a transition", () => {
    const store = new PageZoomStore(manualFrames().schedule);
    store.report(0.9);
    expect(store.getSnapshot()).toEqual({ factor: 0.9, phase: "settled" });
  });

  test("before goes zooming with the target; after settles on the second frame", async () => {
    const frames = manualFrames();
    const store = new PageZoomStore(frames.schedule);
    store.report(1);
    store.willChange(0.9);
    expect(store.getSnapshot()).toEqual({ factor: 0.9, phase: "zooming" });

    let resolved = false;
    void store.didApply(0.9).then(() => {
      resolved = true;
    });
    frames.frame();
    await flush();
    expect(store.isZooming()).toBe(true);
    expect(resolved).toBe(false);

    frames.frame();
    await flush();
    expect(store.getSnapshot()).toEqual({ factor: 0.9, phase: "settled" });
    expect(resolved).toBe(true);
  });

  test("a hold taken by the zoom's resize keeps after waiting until released", async () => {
    const frames = manualFrames();
    const store = new PageZoomStore(frames.schedule);
    store.willChange(0.8);
    let resolved = false;
    void store.didApply(0.8).then(() => {
      resolved = true;
    });
    frames.frame();
    // The canvas observed the new size in the first frame and armed its
    // re-tune.
    const release = store.hold();
    frames.frame();
    await flush();
    expect(store.isZooming()).toBe(true);

    release();
    // Settles after the re-tune's frame is painted, not inside it.
    frames.frame();
    await flush();
    expect(store.isZooming()).toBe(true);
    frames.frame();
    await flush();
    expect(store.isZooming()).toBe(false);
    expect(resolved).toBe(true);
  });

  test("a hold taken while settled is a no-op", async () => {
    const frames = manualFrames();
    const store = new PageZoomStore(frames.schedule);
    const release = store.hold();
    store.willChange(1.1);
    void store.didApply(1.1);
    frames.frame();
    frames.frame();
    await flush();
    expect(store.isZooming()).toBe(false);
    release();
  });

  test("a double-tap stays zooming until its second step settles", async () => {
    const frames = manualFrames();
    const store = new PageZoomStore(frames.schedule);
    store.willChange(0.9);
    let first = false;
    void store.didApply(0.9).then(() => {
      first = true;
    });
    frames.frame();
    store.willChange(0.8);
    void store.didApply(0.8);
    frames.frame();
    await flush();
    // The first step's after notice resolves for the host, but the deck is
    // still on its way to 80 %.
    expect(first).toBe(true);
    expect(store.getSnapshot()).toEqual({ factor: 0.8, phase: "zooming" });
    frames.frame();
    await flush();
    expect(store.getSnapshot()).toEqual({ factor: 0.8, phase: "settled" });
  });

  test("a standing report mid-zoom does not cut the zoom short", () => {
    const store = new PageZoomStore(manualFrames().schedule);
    store.willChange(0.9);
    store.report(1);
    expect(store.getSnapshot()).toEqual({ factor: 0.9, phase: "zooming" });
  });

  test("subscribers hear a change and nothing for a repeat", () => {
    const store = new PageZoomStore(manualFrames().schedule);
    let calls = 0;
    const off = store.subscribe(() => {
      calls += 1;
    });
    store.report(1);
    store.report(1);
    expect(calls).toBe(1);
    off();
  });
});

describe("installPageZoomBridge", () => {
  test("merges the receivers into an existing bridge object", async () => {
    const g = globalThis as unknown as { __tugBridge?: Record<string, unknown> };
    const saved = g.__tugBridge;
    const other = () => {};
    g.__tugBridge = { onNetworkPath: other };
    try {
      const frames = manualFrames();
      const store = new PageZoomStore(frames.schedule);
      installPageZoomBridge(store);
      const bridge = g.__tugBridge as Record<string, (arg: unknown) => unknown>;
      expect(bridge.onNetworkPath).toBe(other);
      bridge.onPageZoom({ factor: 1.2 });
      expect(store.getSnapshot()).toEqual({ factor: 1.2, phase: "settled" });
      bridge.onPageZoomWillChange({ factor: 1.1, from: 1.2 });
      expect(store.isZooming()).toBe(true);
      const done = bridge.onPageZoomDidApply(1.1) as Promise<void>;
      frames.frame();
      frames.frame();
      await done;
      expect(store.getSnapshot()).toEqual({ factor: 1.1, phase: "settled" });
    } finally {
      g.__tugBridge = saved;
    }
  });
});
