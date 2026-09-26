/**
 * Input latency — the second gauge, where the engine offers it.
 *
 * The render cost ([P01]) is the number the doctrine is written in. This is
 * the number the complaint is written in: "lag responding to my commands and
 * actions". `PerformanceEventTiming` reports, per input event, the interval
 * from the event's hardware timestamp to the next paint after its handlers
 * ran — input-to-next-paint, the thing a finger measures.
 *
 * It costs nothing at rest: the observer fires only when input happens, and
 * holds no timer of its own ([B09], [P08]).
 *
 * The `event` entry type is not universal, and whether this WebKit build
 * exposes it is a question the brief left open and this module answers at
 * runtime by feature-detecting `PerformanceObserver.supportedEntryTypes`.
 * Where it is absent the reading reports `supported: false` and the render
 * cost stands alone.
 *
 * @module lib/motion-guard/input-latency
 */

import { summarize } from "./render-cost-probe";

/** How many entries the ring keeps. */
export const INPUT_RING_LIMIT = 64;

/**
 * Entries shorter than this are not worth recording — an event that resolved
 * inside one frame is an event nobody felt. It is also what keeps the ring
 * from being flooded by a scroll.
 */
export const INPUT_DURATION_THRESHOLD_MS = 16;

export interface InputLatencyEntry {
  /** The event type: `pointerdown`, `keydown`, … */
  name: string;
  startTime: number;
  /** Input-to-next-paint, in milliseconds, quantized by the engine to 8 ms. */
  duration: number;
}

export interface InputLatencyReading {
  /** Whether this engine reports `event` performance entries at all. */
  supported: boolean;
  /** The last {@link INPUT_RING_LIMIT} entries, oldest first. */
  entries: InputLatencyEntry[];
  /** p95 over those entries; `null` when there are none. */
  p95: number | null;
}

let supported = false;
let observer: PerformanceObserver | null = null;
let ring: InputLatencyEntry[] = [];

/** Whether this engine reports `event` entries. Feature-detected, not guessed. */
export function inputLatencySupported(): boolean {
  if (typeof PerformanceObserver === "undefined") return false;
  const types = PerformanceObserver.supportedEntryTypes;
  return Array.isArray(types) && types.includes("event");
}

/**
 * Install the observer, if the engine has one to install. Idempotent.
 */
export function installInputLatency(): void {
  if (observer !== null) return;
  supported = inputLatencySupported();
  if (!supported) return;
  observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      ring.push({
        name: entry.name,
        startTime: entry.startTime,
        duration: entry.duration,
      });
      if (ring.length > INPUT_RING_LIMIT) ring.shift();
    }
  });
  // `durationThreshold` is not in every lib.dom; the option is part of the
  // Event Timing spec and unknown options are ignored by engines that lack it.
  observer.observe({
    type: "event",
    durationThreshold: INPUT_DURATION_THRESHOLD_MS,
  } as PerformanceObserverInit);
}

/** The current reading. Safe before install: reports unsupported and empty. */
export function inputLatency(): InputLatencyReading {
  const entries = Array.from(ring);
  return {
    supported,
    entries,
    p95:
      entries.length === 0
        ? null
        : summarize(entries.map((entry) => entry.duration)).p95,
  };
}

/** Drop every recorded entry. Diagnostics `reset()` and tests. */
export function clearInputLatency(): void {
  ring = [];
}
