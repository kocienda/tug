/**
 * page-zoom-store — the deck's half of a View › Zoom step: a step goes
 * `zooming` and writes the root's scale in the same task, settles two frames
 * later once nothing holds it, and only the latest step of a double-tap
 * settles the snapshot. The two conversion helpers read the factor the deck
 * is drawn at. Frames and the writer are driven by hand; no DOM.
 */

import { describe, expect, test } from "bun:test";

import {
  PAGE_ZOOM_LEVELS,
  PageZoomStore,
  installPageZoomBridge,
  layoutPxAt,
  normalizeFactor,
  pageZoomLevelOf,
  requestPageZoom,
  viewportPxAt,
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

/** A writer that records every factor put on the page. */
function recordingWriter(): { write: (factor: number) => void; written: number[] } {
  const written: number[] = [];
  return { write: (factor) => written.push(factor), written };
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

describe("layoutPxAt / viewportPxAt", () => {
  test("a viewport reading is the layout length times the factor", () => {
    expect(layoutPxAt(558.4, 0.8)).toBeCloseTo(698, 9);
    expect(layoutPxAt(1396, 2)).toBe(698);
    expect(viewportPxAt(698, 0.5)).toBe(349);
    expect(layoutPxAt(viewportPxAt(137, 0.7), 0.7)).toBeCloseTo(137, 9);
  });
});

describe("PageZoomStore", () => {
  test("starts at 1.0, settled, having written nothing", () => {
    const writer = recordingWriter();
    const store = new PageZoomStore(manualFrames().schedule, writer.write);
    expect(store.getSnapshot()).toEqual({ factor: 1, phase: "settled" });
    expect(writer.written).toEqual([]);
  });

  test("a standing report writes the factor without a transition", () => {
    const writer = recordingWriter();
    const store = new PageZoomStore(manualFrames().schedule, writer.write);
    store.report(0.9);
    expect(store.getSnapshot()).toEqual({ factor: 0.9, phase: "settled" });
    expect(writer.written).toEqual([0.9]);
    // Every frontendReady re-reports; the same factor writes nothing again.
    store.report(0.9);
    expect(writer.written).toEqual([0.9]);
  });

  test("the helpers convert at the factor the deck is drawn at", () => {
    const store = new PageZoomStore(manualFrames().schedule, () => {});
    expect(store.layoutPxOf(100)).toBe(100);
    store.report(0.5);
    expect(store.layoutPxOf(100)).toBe(200);
    expect(store.viewportPxOf(100)).toBe(50);
  });

  test("a step goes zooming and writes in one task; settles on the second frame", async () => {
    const frames = manualFrames();
    const writer = recordingWriter();
    const store = new PageZoomStore(frames.schedule, writer.write);
    const seen: Array<{ factor: number; phase: string; written: number }> = [];
    store.subscribe(() => {
      seen.push({ ...store.getSnapshot(), written: writer.written.length });
    });

    let resolved = false;
    void store.apply(0.9).then(() => {
      resolved = true;
    });
    // Zooming before the write, written before the task ends.
    expect(seen).toEqual([{ factor: 0.9, phase: "zooming", written: 0 }]);
    expect(writer.written).toEqual([0.9]);
    expect(store.getFactor()).toBe(0.9);

    frames.frame();
    await flush();
    expect(store.isZooming()).toBe(true);
    expect(resolved).toBe(false);

    frames.frame();
    await flush();
    expect(store.getSnapshot()).toEqual({ factor: 0.9, phase: "settled" });
    expect(resolved).toBe(true);
  });

  test("a hold keeps the step from resolving until released and painted", async () => {
    const frames = manualFrames();
    const store = new PageZoomStore(frames.schedule, () => {});
    let resolved = false;
    void store.apply(0.8).then(() => {
      resolved = true;
    });
    const release = store.hold();
    frames.frame();
    frames.frame();
    await flush();
    expect(resolved).toBe(false);
    expect(store.isZooming()).toBe(true);

    release();
    frames.frame();
    await flush();
    expect(resolved).toBe(false);
    frames.frame();
    await flush();
    expect(resolved).toBe(true);
    expect(store.isZooming()).toBe(false);
  });

  test("a hold taken while settled is a no-op", () => {
    const store = new PageZoomStore(manualFrames().schedule, () => {});
    const release = store.hold();
    release();
    expect(store.isZooming()).toBe(false);
  });

  test("a double-tap stays zooming until its second step settles", async () => {
    const frames = manualFrames();
    const writer = recordingWriter();
    const store = new PageZoomStore(frames.schedule, writer.write);
    void store.apply(0.9);
    frames.frame();
    void store.apply(0.8);
    expect(writer.written).toEqual([0.9, 0.8]);
    frames.frame();
    await flush();
    // The first step's two frames are in; it resolves but does not settle.
    expect(store.getSnapshot()).toEqual({ factor: 0.8, phase: "zooming" });
    frames.frame();
    await flush();
    expect(store.getSnapshot()).toEqual({ factor: 0.8, phase: "settled" });
  });

  test("a standing report mid-step is ignored", () => {
    const writer = recordingWriter();
    const store = new PageZoomStore(manualFrames().schedule, writer.write);
    void store.apply(0.7);
    store.report(1);
    expect(store.getFactor()).toBe(0.7);
    expect(writer.written).toEqual([0.7]);
  });

  test("a step back to 1.0 writes 1.0", () => {
    const writer = recordingWriter();
    const store = new PageZoomStore(manualFrames().schedule, writer.write);
    store.report(0.5);
    void store.apply(1);
    expect(writer.written).toEqual([0.5, 1]);
  });
});

describe("installPageZoomBridge", () => {
  test("merges both receivers into the shared bridge object", async () => {
    const g = globalThis as unknown as { __tugBridge?: Record<string, unknown> };
    const before = g.__tugBridge;
    const other = (): void => {};
    g.__tugBridge = { onOther: other };
    try {
      const frames = manualFrames();
      const writer = recordingWriter();
      const store = new PageZoomStore(frames.schedule, writer.write);
      installPageZoomBridge(store);
      const bridge = g.__tugBridge as {
        onOther: unknown;
        onPageZoom: (r: Record<string, unknown>) => void;
        onPageZoomApply: (f: unknown) => Promise<void>;
      };
      expect(bridge.onOther).toBe(other);
      bridge.onPageZoom({ factor: 1.2 });
      expect(store.getFactor()).toBe(1.2);
      const done = bridge.onPageZoomApply(1.3);
      expect(writer.written).toEqual([1.2, 1.3]);
      frames.frame();
      frames.frame();
      await done;
      expect(store.getSnapshot()).toEqual({ factor: 1.3, phase: "settled" });
    } finally {
      g.__tugBridge = before;
    }
  });
});

describe("the zoom levels", () => {
  test("ascend from the lower bound to the upper with 100 % among them", () => {
    expect(PAGE_ZOOM_LEVELS[0]).toBe(0.5);
    expect(PAGE_ZOOM_LEVELS[PAGE_ZOOM_LEVELS.length - 1]).toBe(2);
    expect(PAGE_ZOOM_LEVELS).toContain(1);
    for (let i = 1; i < PAGE_ZOOM_LEVELS.length; i += 1) {
      expect(PAGE_ZOOM_LEVELS[i]).toBeGreaterThan(PAGE_ZOOM_LEVELS[i - 1]);
    }
  });

  test("a factor is read as its level within rounding, and between levels as none", () => {
    expect(pageZoomLevelOf(0.9)).toBe(0.9);
    expect(pageZoomLevelOf(0.6700000000000001)).toBe(0.67);
    expect(pageZoomLevelOf(0.7)).toBeNull();
  });

  test("a level is requested of the host's `pageZoom` handler, and nothing happens with no host", () => {
    const g = globalThis as Record<string, unknown>;
    const before = g.webkit;
    const posted: unknown[] = [];
    try {
      delete g.webkit;
      expect(() => requestPageZoom(0.8)).not.toThrow();
      g.webkit = { messageHandlers: { pageZoom: { postMessage: (v: unknown) => posted.push(v) } } };
      requestPageZoom(0.8);
      expect(posted).toEqual([{ factor: 0.8 }]);
    } finally {
      g.webkit = before;
    }
  });
});
