/**
 * The instrument's whole contract, driven against a fake clock and a
 * recording context. Nothing here touches the DOM, because the instrument
 * does not: the same class runs in the render worker and on the main thread,
 * and this suite is what says the two cannot disagree.
 *
 * The properties under test are the ones the design rests on: the picture is
 * a pure function of `(bins, now)`; a flat, settled picture stops the tick and
 * a store event starts it again; and a picture drawn after any gap is the
 * picture a fresh mount would have drawn — which is what makes a wrong frame
 * impossible to keep.
 */

import { describe, expect, it } from "bun:test";

import {
  SPARKLINE_DISPLAY_LAG_BINS,
  SPARKLINE_TICK_MS,
  SparklineInstrument,
  sparklinePlotValues,
  type SparklineBins,
  type SparklineDrawContext,
  type SparklineInstrumentGeometry,
  type SparklineInstrumentOptions,
} from "../sparkline-instrument";
import type { SparklineColors } from "../sparkline-geometry";

const BIN_MS = 250;
const FULL_SCALE = 100;

const GEOMETRY: SparklineInstrumentGeometry = {
  width: 120,
  height: 22,
  dpr: 2,
  baselineY: 20.5,
  amplitude: 20,
  pxPerSec: 8,
};

const COLORS: SparklineColors = {
  line: "#fff",
  area: "#fff",
  lineAlpha: 0.85,
  areaAlpha: 0.16,
  lineWidth: 1,
};

/** Every call the instrument makes on its surface, in order, as strings. */
type Call = string;

function recordingContext(): { ctx: SparklineDrawContext; calls: Call[] } {
  const calls: Call[] = [];
  const note =
    (name: string) =>
    (...args: unknown[]): void => {
      calls.push(`${name}(${args.map((a) => String(a)).join(",")})`);
    };
  const ctx = {
    setTransform: note("setTransform"),
    clearRect: note("clearRect"),
    beginPath: note("beginPath"),
    moveTo: note("moveTo"),
    lineTo: note("lineTo"),
    closePath: note("closePath"),
    fill: note("fill"),
    stroke: note("stroke"),
    set globalAlpha(v: number) {
      calls.push(`globalAlpha=${v}`);
    },
    set fillStyle(v: string) {
      calls.push(`fillStyle=${v}`);
    },
    set strokeStyle(v: string) {
      calls.push(`strokeStyle=${v}`);
    },
    set lineWidth(v: number) {
      calls.push(`lineWidth=${v}`);
    },
    set lineJoin(v: string) {
      calls.push(`lineJoin=${v}`);
    },
    set lineCap(v: string) {
      calls.push(`lineCap=${v}`);
    },
  } as unknown as SparklineDrawContext;
  return { ctx, calls };
}

/** A hand-driven clock and interval pair — no real timer ever runs. */
function harness(
  overrides: Partial<SparklineInstrumentOptions> = {},
): {
  instrument: SparklineInstrument;
  calls: Call[];
  rests: boolean[];
  setNow: (ms: number) => void;
  advance: (ms: number) => void;
  running: () => boolean;
} {
  const { ctx, calls } = recordingContext();
  const rests: boolean[] = [];
  let clock = 0;
  let fn: (() => void) | null = null;
  let everyMs = 0;
  const instrument = new SparklineInstrument({
    ctx,
    geometry: GEOMETRY,
    colors: COLORS,
    binMs: BIN_MS,
    fullScale: FULL_SCALE,
    curve: (x) => x,
    motion: true,
    now: () => clock,
    setInterval: (f, ms) => {
      fn = f;
      everyMs = ms;
      return 1;
    },
    clearInterval: () => {
      fn = null;
    },
    onState: (state) => rests.push(state.atRest),
    ...overrides,
  });
  return {
    instrument,
    calls,
    rests,
    setNow: (ms) => {
      clock = ms;
    },
    /** Run the tick as many whole cadences as `ms` covers, moving the clock. */
    advance: (ms) => {
      const steps = Math.floor(ms / (everyMs || SPARKLINE_TICK_MS));
      for (let i = 0; i < steps; i++) {
        clock += everyMs || SPARKLINE_TICK_MS;
        fn?.();
      }
    },
    running: () => fn !== null,
  };
}

/** A window of `n` bins ending at the bin `atMs` falls in. */
function windowOf(values: number[], atMs: number, hold = false): SparklineBins {
  return { headBin: Math.floor(atMs / BIN_MS), bins: values, hold };
}

describe("sparklinePlotValues", () => {
  it("plots the rolling one-second sum of the bins behind each point", () => {
    // Four 250 ms bins make the one-second window, so a single bin of 25
    // against a full scale of 100 plots at a quarter height for four bins and
    // then falls away as it leaves the sum.
    const data = windowOf([0, 0, 0, 0, 25, 0, 0, 0, 0], 8 * BIN_MS);
    const plot = sparklinePlotValues(
      data,
      8,
      BIN_MS,
      FULL_SCALE,
      (x) => x,
      GEOMETRY,
    );
    const at = (bin: number): number => plot.values[bin - plot.firstBin];
    expect(at(3)).toBe(0);
    expect(at(4)).toBe(0.25);
    expect(at(7)).toBe(0.25);
    expect(at(8)).toBe(0);
  });

  it("clamps outside the curve so a saturating burst rolls off", () => {
    const data = windowOf([400], 0);
    const plot = sparklinePlotValues(
      data,
      0,
      BIN_MS,
      FULL_SCALE,
      (x) => x,
      GEOMETRY,
    );
    expect(plot.values[plot.values.length - 1]).toBe(1);
  });

  it("reads silence past the head on a rate channel", () => {
    const data = windowOf([100], 0, false);
    const plot = sparklinePlotValues(
      data,
      20,
      BIN_MS,
      FULL_SCALE,
      (x) => x,
      GEOMETRY,
    );
    expect(plot.values[plot.values.length - 1]).toBe(0);
    expect(plot.drained.every((v) => v === 0)).toBe(true);
  });

  it("reads the held level past the head on a gauge channel", () => {
    const data = windowOf([25], 0, true);
    const plot = sparklinePlotValues(
      data,
      20,
      BIN_MS,
      FULL_SCALE,
      (x) => x,
      GEOMETRY,
    );
    // Four held bins of 25 make the rolling sum 100 — full scale.
    expect(plot.values[plot.values.length - 1]).toBe(1);
    expect(plot.drained.every((v) => v === 1)).toBe(true);
  });

  it("reads zero before the window rather than inventing a past", () => {
    const data = windowOf([40, 40], 10 * BIN_MS, true);
    const plot = sparklinePlotValues(
      data,
      10,
      BIN_MS,
      FULL_SCALE,
      (x) => x,
      GEOMETRY,
    );
    expect(plot.values[0]).toBe(0);
  });
});

describe("SparklineInstrument drawing", () => {
  it("is a pure function of (bins, now) — same inputs, same draw calls", () => {
    const a = harness();
    const b = harness();
    const data = windowOf([0, 10, 20, 30, 20, 10, 0], 40 * BIN_MS);
    a.setNow(40 * BIN_MS);
    b.setNow(40 * BIN_MS);
    a.instrument.setBins(data);
    b.instrument.setBins({ ...data, bins: [...data.bins] });
    expect(a.calls).toEqual(b.calls);
    expect(a.calls.length).toBeGreaterThan(0);
  });

  it("clears the viewport-sized canvas before every frame", () => {
    const h = harness();
    h.setNow(40 * BIN_MS);
    h.instrument.setBins(windowOf([0, 10, 20], 40 * BIN_MS));
    expect(h.calls[0]).toBe("setTransform(2,0,0,2,0,0)");
    expect(h.calls[1]).toBe(`clearRect(0,0,${GEOMETRY.width},${GEOMETRY.height})`);
  });

  it("draws half a second behind the clock, so the open bin is never read", () => {
    // Bin 40 is still open at t = 40 × binMs. The lag means the newest bin the
    // picture can reach is two bins older, so a value landing in the open bin
    // changes nothing about the frame drawn at that instant.
    const h = harness();
    const now = 40 * BIN_MS;
    h.setNow(now);
    const openBinOnly = windowOf([0, 0, 0, 0, 0, 0, 0, 0, 0, 80], now);
    h.instrument.setBins(openBinOnly);
    const withOpenBin = [...h.calls];

    const g = harness();
    g.setNow(now);
    g.instrument.setBins(windowOf([0, 0, 0, 0, 0, 0, 0, 0, 0, 0], now));
    expect(withOpenBin).toEqual(g.calls);
    expect(SPARKLINE_DISPLAY_LAG_BINS).toBe(2);
  });

  it("draws the picture a fresh mount would draw, after any gap", () => {
    // The gap case is the one the old tape got wrong: a tape that slept
    // through a dormant spell had to reconstruct, and reconstruction is where
    // it diverged. Here there is nothing to reconstruct from — the picture is
    // recomputed from the bins every frame, so a long-idle instrument and a
    // brand-new one drawing the same window at the same clock agree exactly.
    const data = windowOf([0, 15, 30, 15, 0, 0, 5], 200 * BIN_MS);
    const slept = harness();
    slept.setNow(100 * BIN_MS);
    slept.instrument.setBins(windowOf([90, 90, 90], 100 * BIN_MS));
    slept.advance(60_000);
    slept.calls.length = 0;
    slept.setNow(200 * BIN_MS);
    slept.instrument.setBins(data);

    const fresh = harness();
    fresh.setNow(200 * BIN_MS);
    fresh.instrument.setBins({ ...data, bins: [...data.bins] });
    expect(slept.calls).toEqual(fresh.calls);
  });
});

describe("SparklineInstrument ticking", () => {
  it("starts on a store event and keeps drawing while the picture moves", () => {
    const h = harness();
    h.setNow(40 * BIN_MS);
    h.instrument.setBins(windowOf([0, 0, 0, 0, 60], 40 * BIN_MS));
    expect(h.instrument.isTicking()).toBe(true);
    const before = h.calls.length;
    h.advance(3 * SPARKLINE_TICK_MS);
    expect(h.calls.length).toBeGreaterThan(before);
  });

  it("stops itself once the picture is flat and cannot change", () => {
    const h = harness();
    const now = 40 * BIN_MS;
    h.setNow(now);
    h.instrument.setBins(windowOf([0, 0, 0, 0, 60], now));
    expect(h.instrument.isTicking()).toBe(true);
    // Long enough for the burst to leave both the picture and the rolling sum.
    h.advance(30_000);
    expect(h.instrument.isTicking()).toBe(false);
    expect(h.running()).toBe(false);
    expect(h.instrument.newestValue()).toBe(0);
  });

  it("does not stop on a steady hum that is still holding the window up", () => {
    // The stuck-tape shape: a foreground tool credits the same units every
    // bin, so the picture is flat at the hum's level while the LAST event
    // arrives. Stopping there would freeze the tape at that level with no
    // event coming to restart it.
    const h = harness();
    const now = 400 * BIN_MS;
    h.setNow(now);
    // Long enough to fill the canvas edge to edge, so the picture really is
    // flat rather than merely flat on its right-hand half.
    const hum = new Array<number>(80).fill(30);
    h.instrument.setBins(windowOf(hum, now));
    expect(h.instrument.newestValue()).toBe(1);
    expect(h.instrument.isTicking()).toBe(true);
    // No further events: the tick must run on and draw the decay to zero.
    h.advance(30_000);
    expect(h.instrument.newestValue()).toBe(0);
    expect(h.instrument.isTicking()).toBe(false);
  });

  it("stops on a gauge whose held level fills the window — it cannot move", () => {
    const h = harness();
    const now = 400 * BIN_MS;
    h.setNow(now);
    h.instrument.setBins(windowOf(new Array<number>(80).fill(25), now, true));
    expect(h.instrument.newestValue()).toBe(1);
    expect(h.instrument.isTicking()).toBe(false);
  });

  it("restarts on the next store event after it stopped", () => {
    const h = harness();
    h.setNow(40 * BIN_MS);
    h.instrument.setBins(windowOf([0, 0, 0, 0, 60], 40 * BIN_MS));
    h.advance(30_000);
    expect(h.instrument.isTicking()).toBe(false);
    const at = 200 * BIN_MS;
    h.setNow(at);
    h.instrument.setBins(windowOf([0, 0, 0, 0, 45], at));
    expect(h.instrument.isTicking()).toBe(true);
  });

  it("never ticks under reduced motion, and draws on every event instead", () => {
    const h = harness({ motion: false });
    h.setNow(40 * BIN_MS);
    h.instrument.setBins(windowOf([0, 0, 0, 0, 60], 40 * BIN_MS));
    expect(h.instrument.isTicking()).toBe(false);
    const before = h.calls.length;
    expect(before).toBeGreaterThan(0);
    h.setNow(41 * BIN_MS);
    h.instrument.setBins(windowOf([0, 0, 0, 0, 60, 60], 41 * BIN_MS));
    expect(h.calls.length).toBeGreaterThan(before);
  });

  it("stamps rest only when the picture becomes, or stops being, flat at zero", () => {
    const h = harness();
    const now = 40 * BIN_MS;
    h.setNow(now);
    h.instrument.setBins(windowOf([0, 0, 0, 0, 60], now));
    expect(h.rests).toEqual([false]);
    h.advance(30_000);
    expect(h.rests).toEqual([false, true]);
    const at = 200 * BIN_MS;
    h.setNow(at);
    h.instrument.setBins(windowOf([0, 0, 0, 0, 45], at));
    expect(h.rests).toEqual([false, true, false]);
  });

  it("stops and draws nothing more once disposed", () => {
    const h = harness();
    h.setNow(40 * BIN_MS);
    h.instrument.setBins(windowOf([0, 0, 0, 0, 60], 40 * BIN_MS));
    h.instrument.dispose();
    expect(h.instrument.isTicking()).toBe(false);
    const after = h.calls.length;
    h.instrument.draw();
    expect(h.calls.length).toBe(after);
  });
});
