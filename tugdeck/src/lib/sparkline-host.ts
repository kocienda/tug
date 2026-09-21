/**
 * sparkline-host — which thread the instrument runs on, and nothing else.
 *
 * There is ONE instrument implementation ({@link SparklineInstrument}) and two
 * places to put it. When the platform can transfer a canvas, the instrument
 * lives in the shared render worker and the page is never woken by a tape.
 * When it cannot, the same class runs here against an ordinary 2D context,
 * with the same injected clock and timers. What a platform without
 * transferable canvases loses is the thread, not the picture — and because it
 * is the same class rather than a parallel drawing path, there is nothing for
 * the two to disagree about.
 *
 * Callers see one handle either way: post a window of bins on every store
 * event, post colours and geometry when they change, and release it. The
 * handle knows nothing about time, because the instrument owns the tick on
 * whichever thread it landed on.
 *
 * @module lib/sparkline-host
 */

import type { SparklineColors } from "./sparkline-geometry";
import {
  SparklineInstrument,
  sparklineCurveSpec,
  type SparklineBins,
  type SparklineCurve,
  type SparklineInstrumentGeometry,
  type SparklineInstrumentState,
} from "./sparkline-instrument";
import type {
  SparklineWorkerRequest,
  SparklineWorkerResponse,
} from "./workers/sparkline-render-worker";

/** The one handle a mount holds, whichever thread ended up drawing. */
export interface SparklineHost {
  /** A store event: the whole window, and nothing about time. */
  setBins(data: SparklineBins): void;
  /** Theme or dominant-channel change. */
  setColors(colors: SparklineColors): void;
  /** A resize, or a device-pixel-ratio change. */
  setGeometry(geometry: SparklineInstrumentGeometry): void;
  /** Stop the tick and drop the entry ([L27]). */
  release(): void;
  /** Which thread took it — the dev log's fact, and the test surface's. */
  readonly thread: "worker" | "main";
  /**
   * The instrument's one fact: ticking or not, the newest plotted value, and
   * the rest reading. Read from the instrument on the main-thread path, and
   * from the last `state` message it sent on the worker path — the same
   * answer either way, because it is the instrument's own answer.
   */
  state(): SparklineInstrumentState;
  /**
   * The instrument itself, on the main-thread path only. The worker path
   * cannot hand one back across a thread boundary, and nothing is allowed to
   * need it: the instrument's one fact travels as {@link SparklineHost.state}.
   */
  readonly instrument: SparklineInstrument | null;
}

/** Everything a host needs, whichever side of the boundary it lands on. */
export interface SparklineHostOptions {
  /** The claimed canvas, already sized to the box. */
  canvas: HTMLCanvasElement;
  geometry: SparklineInstrumentGeometry;
  colors: SparklineColors;
  binMs: number;
  fullScale: number;
  curve: SparklineCurve;
  motion: boolean;
  /** The instrument's state, from whichever thread drew — only on change. */
  onState?: (state: SparklineInstrumentState) => void;
  /** The shared worker, or null to force the main-thread host. */
  worker: SparklineWorkerLike | null;
  /** Claim the canvas for the worker; null when it has already been spent. */
  transfer: (canvas: HTMLCanvasElement) => OffscreenCanvas | null;
  /** Injected so the main-thread host is drivable by a test. */
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => number;
  clearInterval?: (handle: number) => void;
}

/** The slice of `Worker` a host uses — a test hands it a recorder. */
export interface SparklineWorkerLike {
  postMessage(message: SparklineWorkerRequest, transfer?: Transferable[]): void;
}

let nextInstrumentId = 1;

/**
 * Where a worker-hosted instrument's state reports come home to. One shared
 * worker serves every instrument, so its messages arrive on one `onmessage`
 * and are routed by id. Entries are added here and removed by `release()`
 * ([L27]); a message for a released host is routed to nobody, which is the
 * correct outcome rather than an error.
 */
const stateRoutes = new Map<number, (state: SparklineInstrumentState) => void>();

/**
 * Route one worker message to its host. The component installs the worker's
 * `onmessage` and calls this; the map lives here because the routing table
 * and the entries that fill it are one thing.
 */
export function routeSparklineWorkerMessage(msg: SparklineWorkerResponse): void {
  if (msg.kind !== "state") return;
  stateRoutes.get(msg.id)?.(msg.state);
}

/** What an instrument says about itself before it has drawn anything. */
const UNDRAWN: SparklineInstrumentState = {
  ticking: false,
  newest: 0,
  atRest: false,
};

/**
 * Put an instrument on the best thread available for it.
 *
 * The worker takes it when there is a worker, the canvas can still be
 * transferred, and the curve is one of the library's — a curve the caller
 * built itself cannot be serialized, so it draws here instead, against the
 * identical class.
 */
export function createSparklineHost(opts: SparklineHostOptions): SparklineHost {
  const spec = sparklineCurveSpec(opts.curve);
  const offscreen =
    opts.worker === null || spec === null ? null : opts.transfer(opts.canvas);

  if (opts.worker !== null && spec !== null && offscreen !== null) {
    const worker = opts.worker;
    const id = nextInstrumentId++;
    // The worker's instrument is across a thread boundary, so its one fact is
    // mirrored here from the messages it sends rather than read on demand.
    // The mirror is only ever written by those messages: a second opinion
    // formed on this side is the class of bug this design exists to remove.
    let mirrored = UNDRAWN;
    worker.postMessage(
      {
        kind: "instrument-init",
        id,
        canvas: offscreen,
        geometry: opts.geometry,
        colors: opts.colors,
        binMs: opts.binMs,
        fullScale: opts.fullScale,
        curve: spec,
        motion: opts.motion,
      },
      [offscreen],
    );
    stateRoutes.set(id, (state) => {
      mirrored = state;
      opts.onState?.(state);
    });
    return {
      thread: "worker",
      instrument: null,
      state: () => mirrored,
      setBins(data) {
        worker.postMessage({ kind: "bins", id, data });
      },
      setColors(colors) {
        worker.postMessage({ kind: "instrument-colors", id, colors });
      },
      setGeometry(geometry) {
        worker.postMessage({ kind: "instrument-geometry", id, geometry });
      },
      release() {
        stateRoutes.delete(id);
        worker.postMessage({ kind: "dispose", id });
      },
    };
  }

  const ctx = opts.canvas.getContext("2d");
  const instrument =
    ctx === null
      ? null
      : new SparklineInstrument({
          ctx,
          geometry: opts.geometry,
          colors: opts.colors,
          binMs: opts.binMs,
          fullScale: opts.fullScale,
          curve: opts.curve,
          motion: opts.motion,
          onState: opts.onState,
          now: opts.now ?? (() => Date.now()),
          setInterval:
            opts.setInterval ??
            ((fn, ms) => window.setInterval(fn, ms)),
          clearInterval:
            opts.clearInterval ?? ((handle) => window.clearInterval(handle)),
        });
  return {
    thread: "main",
    instrument,
    state: () => instrument?.state() ?? UNDRAWN,
    setBins(data) {
      instrument?.setBins(data);
    },
    setColors(colors) {
      instrument?.setColors(colors);
    },
    setGeometry(geometry) {
      instrument?.setGeometry(geometry);
    },
    release() {
      instrument?.dispose();
    },
  };
}
