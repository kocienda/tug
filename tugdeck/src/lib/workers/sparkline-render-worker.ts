/// <reference lib="webworker" />

/**
 * `sparkline-render-worker` — runs every sparkline INSTRUMENT off the main
 * thread.
 *
 * ## Why this exists as a worker
 *
 * The tape's motion was never the cost: the scroll is one WAAPI transform the
 * compositor runs on its own. The cost was the four-times-a-second geometry
 * write. Setting `points` on an SVG polyline invalidates style and schedules a
 * rendering update, so every live tape charged the main thread 4Hz whether or
 * not anything about the picture had changed — measured at 8 writes per second
 * for the two gauge rows alone, on a deck whose rendering updates cost ~10ms
 * each.
 *
 * `OffscreenCanvas` only goes off-thread when *owned* by a worker. The main
 * thread transfers control of each tape's canvas here at mount; from then on a
 * store event is one `postMessage` and the whole picture is computed and drawn
 * on this thread. The canvas commits straight to the compositor without waking
 * the page.
 *
 * ## The instrument owns the tick
 *
 * An instrument entry holds a {@link SparklineInstrument} against its own
 * `OffscreenCanvas`, and the REDRAW TIMER lives here with it. The main thread
 * posts `{headBin, bins, hold}` on store events only, and posts nothing
 * between them: the picture for any moment in between is computed on this
 * thread from those bins and this thread's own `Date.now()`. Both threads read
 * the same wall clock and the bin index is absolute, so there is no clock to
 * convert and no origin for the two sides to disagree about.
 *
 * What stays on the main thread is what needs the DOM or the stores: the
 * store subscription, resolving colors from computed style, and the rest
 * stamp — which this thread reports back as it moves, because only the main
 * thread can write an attribute.
 *
 * ## Wire protocol
 *
 * One shared worker instance for every instrument, keyed by `id`. The hot
 * path is one-directional by design — a reply on every sample would put the
 * main thread back in the loop it was taken out of.
 *
 *  - `instrument-init`      transfer the canvas and fix everything fixed
 *  - `bins`                 a store event: `{headBin, bins, hold}`
 *  - `instrument-colors`    theme or dominant-channel change
 *  - `instrument-geometry`  a resize or a device-pixel-ratio change
 *  - `dispose`              drop the entry, stopping its tick
 *
 * `state` is the instrument path's one outbound message, and it carries a
 * fact rather than an acknowledgement: nothing on this thread waits for a
 * reply, because nothing here is in agreement with anything over there. It is
 * posted when the tick starts or stops and when the rest reading moves —
 * never per frame.
 *
 * `bins` carries the WHOLE window every time rather than appending a sample.
 * The window is eighty numbers, a structured clone of which is far below the
 * cost of the style invalidation this design replaces, and sending all of it
 * means a message that arrives late, out of order, or not at all costs one
 * frame rather than a divergence: the next message is the whole truth again.
 *
 * Laws: [L06] appearance is painted, never React state; [L13]'s carve-out for
 *       an instrument redrawing DATA onto a worker-owned canvas — no style is
 *       mutated and no main-thread rendering update is scheduled.
 *
 * @module lib/workers/sparkline-render-worker
 */

import type { SparklineColors } from "../sparkline-geometry";
import {
  resolveSparklineCurve,
  SparklineInstrument,
  type SparklineBins,
  type SparklineCurveSpec,
  type SparklineInstrumentGeometry,
  type SparklineInstrumentState,
} from "../sparkline-instrument";

export type SparklineWorkerRequest =
  | {
      /** Claim a canvas for an instrument and fix everything it draws with. */
      kind: "instrument-init";
      id: number;
      canvas: OffscreenCanvas;
      geometry: SparklineInstrumentGeometry;
      colors: SparklineColors;
      binMs: number;
      fullScale: number;
      curve: SparklineCurveSpec;
      motion: boolean;
    }
  | {
      /** A store event: the whole window, and nothing about time. */
      kind: "bins";
      id: number;
      data: SparklineBins;
    }
  | { kind: "instrument-colors"; id: number; colors: SparklineColors }
  | {
      kind: "instrument-geometry";
      id: number;
      geometry: SparklineInstrumentGeometry;
    }
  | { kind: "dispose"; id: number };

/**
 * The instrument's one fact moved — the tick started or stopped, or the rest
 * reading changed. Only the main thread can write an attribute, so the
 * instrument reports and the component stamps.
 */
export type SparklineWorkerResponse = {
  kind: "state";
  id: number;
  state: SparklineInstrumentState;
};

const instruments = new Map<number, SparklineInstrument>();

self.onmessage = (event: MessageEvent<SparklineWorkerRequest>): void => {
  const msg = event.data;
  if (msg.kind === "instrument-init") {
    const ctx = msg.canvas.getContext("2d");
    if (ctx === null) return;
    instruments.set(
      msg.id,
      new SparklineInstrument({
        ctx,
        geometry: msg.geometry,
        colors: msg.colors,
        binMs: msg.binMs,
        fullScale: msg.fullScale,
        curve: resolveSparklineCurve(msg.curve),
        motion: msg.motion,
        now: () => Date.now(),
        setInterval: (fn, ms) => self.setInterval(fn, ms) as unknown as number,
        clearInterval: (handle) => self.clearInterval(handle),
        onState: (state) => {
          const moved: SparklineWorkerResponse = { kind: "state", id: msg.id, state };
          self.postMessage(moved);
        },
      }),
    );
    return;
  }
  if (msg.kind === "dispose") {
    instruments.get(msg.id)?.dispose();
    instruments.delete(msg.id);
    return;
  }
  const instrument = instruments.get(msg.id);
  if (instrument === undefined) return;
  if (msg.kind === "bins") instrument.setBins(msg.data);
  else if (msg.kind === "instrument-colors") instrument.setColors(msg.colors);
  else instrument.setGeometry(msg.geometry);
};
