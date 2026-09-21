/**
 * Both hosts, against the one instrument.
 *
 * The property these tests exist for is that there is no second drawing path:
 * the worker host forwards a window of bins and nothing else, and the
 * main-thread host runs the same class with the same injected seams. A
 * platform without transferable canvases loses the thread, not the picture.
 */

import { describe, expect, it } from "bun:test";

import {
  createSparklineHost,
  routeSparklineWorkerMessage,
  type SparklineHostOptions,
  type SparklineWorkerLike,
} from "../sparkline-host";
import { sparklineCurves, type SparklineBins } from "../sparkline-instrument";
import type { SparklineColors } from "../sparkline-geometry";
import type { SparklineWorkerRequest } from "../workers/sparkline-render-worker";

const COLORS: SparklineColors = {
  line: "#fff",
  area: "#fff",
  lineAlpha: 0.85,
  areaAlpha: 0.16,
  lineWidth: 1,
};

const GEOMETRY = {
  width: 120,
  height: 22,
  dpr: 2,
  baselineY: 20.5,
  amplitude: 20,
  pxPerSec: 8,
};

const BINS: SparklineBins = { headBin: 400, bins: [0, 10, 40], hold: false };

/** A canvas stand-in: `getContext` answers, `transfer` is the caller's. */
function fakeCanvas(calls: string[]): HTMLCanvasElement {
  const ctx = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "setTransform" || prop === "clearRect") {
          return (): void => {
            calls.push(prop);
          };
        }
        return (): void => {};
      },
      set() {
        return true;
      },
    },
  );
  return { getContext: () => ctx } as unknown as HTMLCanvasElement;
}

function recordingWorker(): {
  worker: SparklineWorkerLike;
  posted: SparklineWorkerRequest[];
} {
  const posted: SparklineWorkerRequest[] = [];
  return {
    posted,
    worker: {
      postMessage(message) {
        posted.push(message);
      },
    },
  };
}

function baseOptions(
  overrides: Partial<SparklineHostOptions> = {},
): SparklineHostOptions {
  return {
    canvas: fakeCanvas([]),
    geometry: GEOMETRY,
    colors: COLORS,
    binMs: 250,
    fullScale: 100,
    curve: sparklineCurves.gamma(0.6),
    motion: true,
    worker: null,
    transfer: () => ({}) as OffscreenCanvas,
    now: () => 100 * 250,
    setInterval: () => 1,
    clearInterval: () => {},
    ...overrides,
  };
}

describe("createSparklineHost on the worker", () => {
  it("claims the canvas and sends the curve as a spec, not a function", () => {
    const { worker, posted } = recordingWorker();
    const host = createSparklineHost(baseOptions({ worker }));
    expect(host.thread).toBe("worker");
    const init = posted[0];
    expect(init.kind).toBe("instrument-init");
    if (init.kind !== "instrument-init") throw new Error("unreachable");
    expect(init.curve).toEqual({ kind: "gamma", g: 0.6 });
    expect(init.binMs).toBe(250);
    expect(init.geometry).toEqual(GEOMETRY);
  });

  it("posts the window on a store event and nothing about time", () => {
    const { worker, posted } = recordingWorker();
    const host = createSparklineHost(baseOptions({ worker }));
    posted.length = 0;
    host.setBins(BINS);
    expect(posted).toEqual([{ kind: "bins", id: expect.any(Number), data: BINS }]);
  });

  it("forwards colours, geometry and the release", () => {
    const { worker, posted } = recordingWorker();
    const host = createSparklineHost(baseOptions({ worker }));
    posted.length = 0;
    host.setColors(COLORS);
    host.setGeometry({ ...GEOMETRY, dpr: 1 });
    host.release();
    expect(posted.map((m) => m.kind)).toEqual([
      "instrument-colors",
      "instrument-geometry",
      "dispose",
    ]);
  });

  it("routes the worker's rest stamp back to its own host, and only while live", () => {
    const { worker, posted } = recordingWorker();
    const rests: boolean[] = [];
    const host = createSparklineHost(
      baseOptions({ worker, onState: (state) => rests.push(state.atRest) }),
    );
    const init = posted[0];
    if (init.kind !== "instrument-init") throw new Error("unreachable");
    routeSparklineWorkerMessage({
      kind: "state",
      id: init.id,
      state: { ticking: false, newest: 0, atRest: true },
    });
    expect(rests).toEqual([true]);
    // The mirror is the worker's own answer, read back without a second
    // opinion formed on this side.
    expect(host.state().atRest).toBe(true);
    host.release();
    routeSparklineWorkerMessage({
      kind: "state",
      id: init.id,
      state: { ticking: true, newest: 0.5, atRest: false },
    });
    expect(rests).toEqual([true]);
  });

  it("falls back to the main thread when the canvas cannot be claimed", () => {
    const { worker, posted } = recordingWorker();
    const host = createSparklineHost(
      baseOptions({ worker, transfer: () => null }),
    );
    expect(host.thread).toBe("main");
    expect(posted).toEqual([]);
  });

  it("falls back to the main thread for a curve the caller built itself", () => {
    const { worker, posted } = recordingWorker();
    // Untagged: there is no spec to send, so the instrument draws here
    // instead — the same class, against a main-thread context.
    const host = createSparklineHost(
      baseOptions({ worker, curve: (x) => x * x }),
    );
    expect(host.thread).toBe("main");
    expect(posted).toEqual([]);
  });
});

describe("createSparklineHost on the main thread", () => {
  it("runs the instrument against the canvas's own context", () => {
    const calls: string[] = [];
    const host = createSparklineHost(baseOptions({ canvas: fakeCanvas(calls) }));
    expect(host.thread).toBe("main");
    expect(host.instrument).not.toBeNull();
    host.setBins(BINS);
    expect(calls).toContain("clearRect");
  });

  it("ticks with the injected timers and stops on release", () => {
    let running = false;
    const host = createSparklineHost(
      baseOptions({
        setInterval: () => {
          running = true;
          return 7;
        },
        clearInterval: (handle) => {
          expect(handle).toBe(7);
          running = false;
        },
      }),
    );
    host.setBins({ headBin: 100, bins: [0, 0, 90], hold: false });
    expect(running).toBe(true);
    expect(host.instrument?.isTicking()).toBe(true);
    host.release();
    expect(running).toBe(false);
    expect(host.instrument?.isTicking()).toBe(false);
  });

  it("reports rest from the same callback the worker path reports it on", () => {
    const rests: boolean[] = [];
    const host = createSparklineHost(
      baseOptions({ onState: (state) => rests.push(state.atRest) }),
    );
    host.setBins({ headBin: 100, bins: new Array<number>(80).fill(0), hold: false });
    expect(rests).toEqual([true]);
    expect(host.state()).toEqual({ ticking: false, newest: 0, atRest: true });
  });
});
