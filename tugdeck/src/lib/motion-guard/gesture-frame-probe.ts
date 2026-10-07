/**
 * The gesture frame recorder — "how many frames did that gesture actually
 * deliver, and where did it stop?"
 *
 * It answers the one question a reading taken inside the app cannot: the app's
 * own `settle-frames` record opens when the canvas arms, which is already past
 * the gesture's own preamble, and it is written at a release nobody outside the
 * page can wait for. This recorder is armed from the SHELL, before the gesture,
 * by somebody who then goes and performs the gesture — so the rAF chain is
 * already ticking steadily when the fold lands and the dead time shows up as a
 * gap inside the series rather than in front of it.
 *
 * It is a BENCH PROBE behind the loopback eval door, the same standing
 * `geometry-chain-probe.ts` has: nothing arms it on load, the only caller on a
 * release build is `POST /api/eval` (loopback-only, gated on dev mode or the
 * per-instance `diag/eval` opt-in), and `disarm` drops every sample it was
 * keeping.
 *
 * ## It reads no DOM, and that is the whole of its accuracy
 *
 * The tick callback pushes one `DOMHighResTimeStamp` and nothing else — no
 * `getBoundingClientRect`, no `getComputedStyle`, no `getAnimations`. A probe
 * whose own cost lands inside the window it measures is measuring itself, and
 * the number under study here is a freeze of tens of milliseconds on a page
 * where a per-tick DOM walk is not free. `settle-frame-probe.ts`'s in-product
 * sampler makes the opposite trade deliberately, because what it is for is the
 * per-frame census; this one is for the cadence alone.
 *
 * ## The arithmetic is not here
 *
 * `classifyFrameCadence` is the module's one definition of "which gaps were
 * longer than one frame", and its own doc comment says a second copy is the
 * defect it exists to prevent. Everything this module adds is the one thing
 * that function cannot know: WHICH gap in the series brackets the gesture.
 *
 * @module lib/motion-guard/gesture-frame-probe
 */

import { pageZoomStore } from "@/lib/page-zoom-store";
import { classifyFrameCadence } from "@/lib/settle-frame-probe";

/**
 * How long an armed chain runs before it stops itself, in ms.
 *
 * It has to span an arm, a gesture somebody sends afterwards, and that
 * gesture's land — the whole point of arming first is that the gesture has not
 * happened yet, and a human or a second `tugtool` invocation has to happen in
 * between. Eight seconds is generous for that and still short enough that a
 * `read` somebody forgot to send leaves a loop running for seconds rather than
 * for the life of the instance, which [D1] forbids.
 */
export const GESTURE_WINDOW_DEFAULT_MS = 8000;

/** What `arm` and `disarm` answer. */
export interface GestureFrameArmReading {
  readonly armed: boolean;
  /** `performance.now()` at the arm, on the ticks' own clock. */
  readonly armedAt: number;
  readonly windowMs: number;
}

/**
 * The display mode a reading was taken at, as the page sees it.
 *
 * `screen.width`/`height` are the mode's logical size — 3200x1800 on a Studio
 * Display running the "looks like 3200x1800" scaled mode — and
 * `devicePixelRatio` is the backing multiplier over it. Together they name the
 * mode without anybody having to remember which one they were in.
 *
 * `zoomFactor` is View › Zoom. It is the deck root's transform, which never
 * moves `devicePixelRatio`, so without it a reading taken at 200 % is
 * indistinguishable from one at 100 %.
 */
export interface GestureFrameDisplay {
  readonly widthPx: number;
  readonly heightPx: number;
  readonly devicePixelRatio: number;
  readonly zoomFactor: number;
}

/** What `read` answers. */
export interface GestureFrameReading {
  readonly armedAt: number;
  /**
   * Which display mode the page was in when the series was recorded.
   *
   * A reading is taken at one mode and compared against a reading taken at
   * another, by a person running the same five commands twice with a trip
   * through System Settings in between. The one error that comparison admits is
   * labelling a reading with the wrong mode, and a number the page reports
   * itself is the only label that cannot be mislabelled.
   */
  readonly display: GestureFrameDisplay;
  /**
   * The store's stamp for the gesture under study, or `null` when none was
   * published since the arm.
   */
  readonly gestureAt: number | null;
  readonly ticks: number;
  /** The gap series in full — the shape is the evidence, not just its summary. */
  readonly gaps: readonly number[];
  readonly framePeriodMs: number;
  readonly longestGapMs: number;
  readonly gapsOverOneFrame: number;
  /**
   * The gap that BRACKETS the gesture, and the one number this recorder exists
   * for. `-1` when no stamp was published since the arm, or when the stamp
   * falls outside the recorded series entirely.
   *
   * **`ticks[0] - armedAt` is not this number.** The chain is armed by a shell
   * command and the gesture arrives afterwards — possibly seconds afterwards —
   * so by the time the fold lands the chain has been ticking steadily and
   * `ticks[0]` is about one frame after the arm, carrying no information about
   * the gesture at all. The dead time is a gap INSIDE the series: in
   * `120 59 11 12 14 17 …` the `120` is the gesture's frame.
   */
  readonly gestureGapMs: number;
  /** Where that gap sits in {@link GestureFrameReading.gaps}. `-1` with no gap. */
  readonly gestureGapIndex: number;
  /** Tick count below the cadence floor; the summary is void. */
  readonly suspended: boolean;
  /** The chain is still running — a `read` before the window elapsed. */
  readonly running: boolean;
}

/**
 * Where the gesture stamp comes from.
 *
 * The recorder cannot import the deck: `installMotionGuard()` runs before
 * `DeckManager` is constructed, which is deliberate — the guard's attribute has
 * to be on the document before the deck reads it. So the source is installed
 * afterwards by whoever has the store, and a recorder with no source reports
 * `gestureAt: null` rather than guessing.
 */
type GestureOriginSource = () => number | null;

let originSource: GestureOriginSource | null = null;

/** Install the store's gesture stamp as this recorder's origin. */
export function setGestureOriginSource(source: GestureOriginSource): void {
  originSource = source;
}

let handle: number | null = null;
let ticks: number[] = [];
let armedAt = 0;
let windowMs = GESTURE_WINDOW_DEFAULT_MS;

function stop(): void {
  if (handle !== null) {
    cancelAnimationFrame(handle);
    handle = null;
  }
}

/**
 * Start a rAF chain, clearing any prior series.
 *
 * Arming an already-armed recorder RESTARTS it rather than being ignored: the
 * series belongs to the reading somebody is about to take, and a second arm is
 * how they say the last one is over. That is the opposite of the settle
 * record's retarget guard, and for the opposite reason — nothing here is
 * retargeting, the arm is a person's deliberate act.
 */
export function armGestureFrames(
  ms: number = GESTURE_WINDOW_DEFAULT_MS,
): GestureFrameArmReading {
  stop();
  ticks = [];
  windowMs = ms > 0 ? ms : GESTURE_WINDOW_DEFAULT_MS;
  armedAt = performance.now();
  const tick = (t: number): void => {
    handle = null;
    ticks.push(t);
    if (t - armedAt >= windowMs) return;
    handle = requestAnimationFrame(tick);
  };
  handle = requestAnimationFrame(tick);
  return { armed: true, armedAt, windowMs };
}

/** Cancel the chain and drop the series. */
export function disarmGestureFrames(): GestureFrameArmReading {
  stop();
  ticks = [];
  return { armed: false, armedAt, windowMs };
}

/**
 * Classify one recorded series against the gesture that happened inside it.
 *
 * Pure, so the interesting half is testable as data without a browser. The
 * cadence is `classifyFrameCadence`'s and is NOT given an origin: this chain is
 * armed before the gesture, so the distance from the arm to the first tick is
 * one ordinary frame and prepending it would add a gap that means nothing.
 */
export function classifyGestureFrames(
  at: number,
  series: readonly number[],
  gestureAt: number | null,
  running: boolean,
  display: GestureFrameDisplay,
): GestureFrameReading {
  const cadence = classifyFrameCadence(series);
  let gestureGapIndex = -1;
  if (gestureAt !== null) {
    for (let i = 1; i < series.length; i += 1) {
      if (series[i - 1] <= gestureAt && gestureAt <= series[i]) {
        gestureGapIndex = i - 1;
        break;
      }
    }
  }
  return {
    armedAt: at,
    display,
    gestureAt,
    ticks: series.length,
    gaps: cadence.gaps,
    framePeriodMs: cadence.framePeriodMs,
    longestGapMs: cadence.longestGapMs,
    gapsOverOneFrame: cadence.gapsOverOneFrame,
    gestureGapMs: gestureGapIndex < 0 ? -1 : cadence.gaps[gestureGapIndex],
    gestureGapIndex,
    suspended: cadence.suspended,
    running,
  };
}

/** The page's own account of the mode it is being displayed at. */
function currentDisplay(): GestureFrameDisplay {
  return {
    widthPx: screen.width,
    heightPx: screen.height,
    devicePixelRatio: window.devicePixelRatio,
    zoomFactor: pageZoomStore.getFactor(),
  };
}

/** The `read` mode: classify what the armed chain has recorded so far. */
export function readGestureFrames(): GestureFrameReading {
  const stamped = originSource?.() ?? null;
  // A stamp from before the arm belongs to an earlier gesture, and the window
  // it would be placed in is one it never happened in. Dropped rather than
  // searched for, because a stamp outside the series produces a -1 anyway and
  // saying so here keeps the reason readable.
  const gestureAt = stamped !== null && stamped >= armedAt ? stamped : null;
  return classifyGestureFrames(
    armedAt,
    ticks,
    gestureAt,
    handle !== null,
    currentDisplay(),
  );
}
