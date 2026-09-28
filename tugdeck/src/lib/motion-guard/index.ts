/**
 * The motion guard — the enforcement layer the animation doctrine lacked.
 *
 * The doctrine says motion never runs on the main thread, and until this
 * module there was nothing on the shipping surface that could *check*. The
 * guard is four pieces and one install:
 *
 *   - `registry.ts` — loop owners say when they are moving ([D7]);
 *   - `render-cost-probe.ts` — the page measures its own per-frame rendering
 *     update, armed by the registry's edges ([B01], [B03]);
 *   - `input-latency.ts` — input-to-next-paint, where the engine reports it;
 *   - `diagnostics.ts` — `window.__tugMotion`, so a release build can be
 *     asked what is ticking and which loop is paying for it ([B04]).
 *
 * `installMotionGuard()` is called unconditionally from `main.tsx`, in every
 * build. The cost at rest is one property assignment and one set of listeners:
 * with no motion anywhere the probe is disarmed, and a disarmed probe holds
 * no timer and schedules no rendering update.
 *
 *   - `breaker.ts` — the one piece that acts: three consecutive over-budget
 *     samples, or three reading updates at rest with nothing in flight and
 *     no gesture running, and every long-running loop on the deck is stilled
 *     through one CSS variable ([B07], [P06], [P07]).
 *
 * @module lib/motion-guard
 */

import { cardServicesStore } from "@/lib/card-services-store";

import { installMotionDiagnostics } from "./diagnostics";
import { installInputLatency } from "./input-latency";
import { onMotionEdge } from "./registry";
import { renderCostProbe } from "./render-cost-probe";
import { motionBreaker, nothingInFlight } from "./breaker";

export {
  acquireMotionHold,
  motionHolds,
  onMotionEdge,
  useMotionHold,
} from "./registry";
export {
  burst,
  renderCostProbe,
  restFromGaps,
  sampleFrame,
  sampleRest,
  summarize,
  RENDER_COST_BUDGET_MS,
  REST_STALL_FLOOR_MS,
  REST_UPDATES_BUDGET_PER_S,
  REST_WINDOW_MS,
  SAMPLE_INTERVAL_MS,
  type RenderCostSample,
  type RenderCostSummary,
  type RestReading,
} from "./render-cost-probe";
export {
  inputLatency,
  inputLatencySupported,
  type InputLatencyReading,
} from "./input-latency";
export { tugMotion, type TugMotionDiagnostics } from "./diagnostics";
export {
  observeOffscreen,
  offscreenPaused,
  offscreenPauseEnabled,
  offscreenWatched,
  setOffscreenPause,
  useOffscreenPause,
  OFFSCREEN_ATTRIBUTE,
} from "./offscreen";
export {
  liveMarks,
  observeOneLiveMark,
  useOneLiveMark,
  UNDERSTUDY_ATTRIBUTE,
  type LiveMarksReading,
} from "./one-live-mark";
export {
  motionBreaker,
  nothingInFlight,
  shouldTrip,
  shouldTripAtRest,
  type BreakerTripReason,
  BREAKER_LATCH_TRIPS,
  BREAKER_TRIP_SAMPLES,
  DEMOTED_ATTRIBUTE,
  IN_FLIGHT_PHASES,
  type MotionBreaker,
} from "./breaker";

let installed = false;

/** Wire the guard. Idempotent; called once from `main.tsx`. */
export function installMotionGuard(): void {
  if (installed) return;
  installed = true;

  // The probe follows the holds: something started moving, start reading;
  // everything stopped, stop reading. Nothing polls to find out which.
  onMotionEdge((holds) => {
    if (holds > 0) renderCostProbe.arm();
    else renderCostProbe.disarm();
  });

  // Every sample records what the deck was doing when it was taken, so the
  // breaker can tell a walk nobody asked for from a turn legitimately laying
  // out every frame. The store walk is the adapter; the condition is pure.
  renderCostProbe.setInFlightSource(() => {
    const phases: string[] = [];
    cardServicesStore.forEachCodeSessionStore((store) => {
      phases.push(store.getSnapshot().phase);
    });
    return !nothingInFlight(phases);
  });

  // A gesture is a settle: the canvas marks itself `data-imposer-settling`
  // for the settle's length, and the occlusion controller reads the same
  // mark. A sample taken under it is a deck with a reason to update every
  // frame, and the at-rest trip does not count it.
  renderCostProbe.setGestureSource(
    () => document.querySelector("[data-imposer-settling]") !== null,
  );

  motionBreaker.install();
  installInputLatency();
  installMotionDiagnostics();
}
