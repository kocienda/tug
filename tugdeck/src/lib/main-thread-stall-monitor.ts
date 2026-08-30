/**
 * main-thread-stall-monitor — a reading for the one defect no other
 * instrument in the deck can see: the main thread busy long enough that
 * the app stops answering.
 *
 * Every surface in Tug — every card, the Lens, Jots, the Overview, and
 * all keyboard and pointer routing — runs on one thread in one
 * `WKWebView`. A card that spends seconds reconstructing a restored
 * transcript is therefore not slow *in its own card*; it is the whole
 * app not answering, while the chrome still paints as if it were ready.
 *
 * This WebKit exposes no `longtask` entry type — its
 * `PerformanceObserver.supportedEntryTypes` is
 * `mark, measure, navigation, paint, resource` — so the stall has to be
 * read indirectly. A fixed-period timer that fires late by N ms was
 * blocked for N ms: nothing else could run either, including the
 * keystroke the user typed into a card that looked idle.
 *
 * The record goes to the deck trace's always-recorded set, because the
 * launch that stalls is exactly the launch nobody had an inspector open
 * for. Read it with `__deckTrace.dump()`.
 *
 * Tuglaws: [L10] — one responsibility (observe and record thread
 * stalls); no React, no state, no behavior.
 *
 * @module lib/main-thread-stall-monitor
 */

import { deckTrace } from "../deck-trace";

/** Timer period. Short enough to bound the error on a recorded stall. */
const TICK_MS = 50;

/**
 * Report threshold. A tick is expected `TICK_MS` after the last one;
 * anything beyond this much extra is a stall worth a record. Set above
 * ordinary timer jitter and one dropped frame, so a healthy deck records
 * nothing at all and a dump is all signal.
 */
const STALL_THRESHOLD_MS = 100;

/**
 * Start recording main-thread stalls. Returns a stop function; calling
 * `start` twice is a no-op past the first (the monitor is a singleton
 * observing a singleton thread).
 */
export function startMainThreadStallMonitor(): () => void {
  if (handle !== null) return stop;
  lastTickAt = now();
  handle = setInterval(tick, TICK_MS);
  return stop;
}

let handle: ReturnType<typeof setInterval> | null = null;
let lastTickAt = 0;

function tick(): void {
  const at = now();
  const gap = at - lastTickAt;
  lastTickAt = at;
  // A hidden window's timers are throttled by the engine (seconds, not
  // milliseconds), which would otherwise read as a continuous stall.
  // Nothing is waiting on the thread then, so there is no defect to
  // record — the gap is the engine's policy, not a block.
  if (typeof document !== "undefined" && document.visibilityState !== "visible") {
    return;
  }
  const stalled = gap - TICK_MS;
  if (stalled < STALL_THRESHOLD_MS) return;
  deckTrace.record({ kind: "main-thread-stall", ms: Math.round(stalled) });
}

function stop(): void {
  if (handle === null) return;
  clearInterval(handle);
  handle = null;
}

function now(): number {
  if (
    typeof performance !== "undefined" &&
    typeof performance.now === "function"
  ) {
    return performance.now();
  }
  return Date.now();
}
