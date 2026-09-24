/**
 * Settle frame probe — a diagnostic that answers "did the card's motion arrive
 * on time?"
 *
 * `cut-detector.ts` is the same instrument one question over: it asks whether a
 * card moved without moving, and this asks whether the move the deck promised
 * was delivered frame by frame. A settle whose first painted frame lands three
 * display frames after the animation started has not travelled to the eye — the
 * picture arrives already mostly moved, and the reader sees a cut even though
 * every rect the detector samples is on a tween ([P01], [P02]).
 *
 * It is a BENCH PROBE, not a product surface. The animation doctrine bans
 * per-frame JS in shipping paths and requires a settled surface to hold zero
 * timers; both hold here because the loop exists only between {@link
 * SettleFrameProbe.arm} and {@link SettleFrameProbe.disarm}, and disarming drops
 * every sample it was keeping. Nothing arms it on load — the app-test harness
 * and the dev panel are the only doors.
 *
 * The classification is pure and lives apart from the DOM reader
 * ({@link classifySettleFrames} over {@link SettleFrameSample}), so the
 * interesting half — "is this gap longer than two frames", "was the first
 * painted frame within one frame of the animation's start" — is testable as
 * data without a browser. `[P08]`'s in-product frame record reads the same
 * classifier, which is why the sample type is the contract rather than the
 * reading.
 *
 * ## Two failures that look identical from outside
 *
 * The tween STARTED late — a long click task delayed the first rendering
 * opportunity, so the animation's `currentTime` is still zero when the first
 * tick lands — and the tween RAN but PAINTED late, where `currentTime` advanced
 * normally while the wall-clock gaps between ticks blew out. Only the
 * animation's own clock separates them, which is why every sample carries the
 * move animation's `currentTime` beside the tick's timestamp.
 *
 * @module lib/settle-frame-probe
 */

import { SHOWN_PANE_FRAMES } from "@/components/chrome/space-layer";

/**
 * The properties a settling deck is allowed to animate.
 *
 * Everything else is a paint-property animation on a frame that is mid-settle,
 * which is the whole defect `[P08]`'s guard lands on in Step 8. The probe
 * records them from the first day so the reading does not change shape when the
 * assertion arrives.
 */
export const COMPOSITOR_PROPERTIES: readonly string[] = ["transform", "opacity"];

/**
 * Keyframe keys that describe the keyframe rather than a property it animates.
 *
 * `getKeyframes()` hands back the resolved keyframe objects, which carry the
 * timing metadata inline beside the animated properties. Reading the metadata
 * as a property would report every effect on the deck as offending.
 */
const KEYFRAME_METADATA_KEYS: readonly string[] = [
  "offset",
  "computedOffset",
  "easing",
  "composite",
];

/**
 * Below this many ticks the whole reading is void.
 *
 * A window the compositor has stopped serving — occluded, minimised, behind
 * another window — suspends `requestAnimationFrame` outright, and the probe
 * then reports a handful of ticks with enormous gaps between them. That is
 * indistinguishable from a deck that dropped every frame, and it is also what
 * an app-test whose harness window got covered produces. The classifier says so
 * in a field rather than leaving each caller to infer it from a small number.
 */
export const SUSPENSION_FLOOR_TICKS = 10;

/**
 * How much longer than a frame period a gap must be before it counts as one
 * frame missed.
 *
 * A live rAF loop's gaps jitter around the display's period by a few percent,
 * so a strict `> framePeriodMs` test would count most of a perfectly smooth
 * run. The imposer's own FLIP floors its terms for the same reason.
 */
export const GAP_TOLERANCE = 1.5;

/** The frame period assumed when the run carries too few gaps to derive one. */
export const FALLBACK_FRAME_PERIOD_MS = 1000 / 60;

/** One shown frame's geometry and motion state at one sampling instant. */
export interface SettleFramePaneSample {
  readonly paneId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** The frame's computed opacity at this instant. */
  readonly opacity: number;
  /** How many animations were running on the frame element at this instant. */
  readonly animations: number;
  /**
   * Every property this frame's own effects animate that is not `transform` or
   * `opacity` — `[P08]`'s subject, recorded from the first day.
   */
  readonly offendingProperties: readonly string[];
  /**
   * The frame carries a transform-bearing effect that has NOT STARTED, and is
   * therefore painting its base style — which for a FLIP is the DESTINATION.
   *
   * The move beat inverts: keyframe 0 is `translate(first - last)`, so the
   * pose that holds a frame at its ORIGIN is the animation's own first
   * keyframe. Under `fill: none` an animation whose local time is unresolved
   * applies NOTHING, and `el.animate()` returns an animation that is
   * play-pending — its start time unresolved until the next update after it is
   * ready, which for a COMPOSITED animation means after the compositor has
   * been handed it. Every tick inside that window paints the frame where the
   * commit already put it: at the end of the travel, with none of it shown.
   *
   * Invisible to every other field here. A gap counter sees frames arriving on
   * time, because they did arrive; they simply arrived carrying the wrong pose.
   */
  readonly offCurve: boolean;
}

/** One rAF tick's raw sample. Pure data — no DOM in the classifier's input. */
export interface SettleFrameSample {
  /** `DOMHighResTimeStamp` of the tick. */
  readonly t: number;
  /**
   * The move animation's `currentTime`, or `null` when no frame on the deck is
   * running a transform-bearing effect at this instant.
   */
  readonly moveCurrentTime: number | null;
  /**
   * A transform-bearing effect exists somewhere on the deck but has no
   * resolved start time — the pending window {@link
   * SettleFramePaneSample.offCurve} is about, read once per tick rather than
   * per frame so a run can be summarised as "N ticks with a move nobody could
   * see".
   */
  readonly movePending: boolean;
  readonly frames: readonly SettleFramePaneSample[];
  /** Elements under any shown frame computing `position: fixed` — R01's runtime half. */
  readonly fixedDescendants: number;
}

/** What the classifier answers, and what both the test and `[P09]` read. */
export interface SettleFrameReading {
  readonly ticks: number;
  /** Derived from the run's own quiet ticks, never assumed. */
  readonly framePeriodMs: number;
  readonly longestGapMs: number;
  /** {@link SettleFrameReading.longestGapMs} in display frames. */
  readonly longestGapFrames: number;
  readonly gapsOverOneFrame: number;
  /** Move start → the first tick at which its `currentTime` had advanced. */
  readonly firstPaintDelayMs: number;
  readonly minOpacity: number;
  readonly minOpacityPaneId: string;
  readonly rectsChangedAfterLanding: readonly string[];
  /**
   * Ticks at which a move existed and had not started ([Q-pop]).
   *
   * The whole of the pop, as a number. Zero is the bar: a settle whose tween
   * is pending for even one tick has shown the reader one frame of the
   * destination before any of the travel.
   */
  readonly pendingTicks: number;
  /** Ticks at which at least one frame painted off its own curve. */
  readonly offCurveTicks: number;
  /** Every pane that painted off-curve at any tick. */
  readonly offCurvePaneIds: readonly string[];
  /** `"paneId:property"` for every paint-property animation seen — `[P08]`. */
  readonly violations: readonly string[];
  readonly fixedDescendants: number;
  /** Tick count below {@link SUSPENSION_FLOOR_TICKS}; the whole reading is void. */
  readonly suspended: boolean;
}

/** The reading a run with no ticks at all classifies to. */
const EMPTY_READING: SettleFrameReading = {
  ticks: 0,
  framePeriodMs: FALLBACK_FRAME_PERIOD_MS,
  longestGapMs: 0,
  longestGapFrames: 0,
  gapsOverOneFrame: 0,
  firstPaintDelayMs: -1,
  minOpacity: 1,
  minOpacityPaneId: "-",
  rectsChangedAfterLanding: [],
  pendingTicks: 0,
  offCurveTicks: 0,
  offCurvePaneIds: [],
  violations: [],
  fixedDescendants: 0,
  suspended: true,
};

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The display's frame period, read off the run rather than hard-coded.
 *
 * The bar is "no gap longer than two frames at the display's rate", and the
 * display's rate is not a constant: a ProMotion panel, an external monitor and
 * a throttled window all run this loop at different periods. The QUIET ticks —
 * those before any move animation exists — are the ones that say what the
 * period is, because they are the ones nothing is competing with. A run that
 * was already settling when the probe armed has no quiet ticks, so the whole
 * run's gaps answer instead; a run with fewer than two ticks has nothing to
 * say and gets the 60Hz fallback.
 */
function deriveFramePeriodMs(samples: readonly SettleFrameSample[]): number {
  const quietGaps: number[] = [];
  const allGaps: number[] = [];
  for (let i = 1; i < samples.length; i += 1) {
    const gap = samples[i].t - samples[i - 1].t;
    allGaps.push(gap);
    if (
      samples[i].moveCurrentTime === null &&
      samples[i - 1].moveCurrentTime === null
    ) {
      quietGaps.push(gap);
    }
  }
  return (
    median(quietGaps) ?? median(allGaps) ?? FALLBACK_FRAME_PERIOD_MS
  );
}

function rectKey(frame: SettleFramePaneSample): string {
  return `${Math.round(frame.x)},${Math.round(frame.y)},${Math.round(frame.width)},${Math.round(frame.height)}`;
}

/**
 * Classify a run of ticks into the reading Spec S01 names.
 *
 * `firstPaintDelayMs` is the distance from the tick at which the move animation
 * first EXISTED to the tick at which its `currentTime` had advanced past zero.
 * An animation that is born and advances in the same tick reports zero; one
 * whose first three ticks all read `currentTime: 0` reports the wall-clock cost
 * of those three ticks, which is the "the tween started late" half of
 * (#why-intermittent). A run in which no move animation ever appeared reports
 * `-1` — there was no move to be late.
 *
 * `rectsChangedAfterLanding` is the settle's own promise read backwards: once
 * the last animation on the deck has ended, no frame's rect may change again.
 * A frame that moves after the landing moved without a tween carrying it, which
 * is a cut wearing a settle's clothes.
 */
export function classifySettleFrames(
  samples: readonly SettleFrameSample[],
): SettleFrameReading {
  if (samples.length === 0) return EMPTY_READING;

  const framePeriodMs = deriveFramePeriodMs(samples);

  let longestGapMs = 0;
  let gapsOverOneFrame = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const gap = samples[i].t - samples[i - 1].t;
    if (gap > longestGapMs) longestGapMs = gap;
    if (gap > framePeriodMs * GAP_TOLERANCE) gapsOverOneFrame += 1;
  }

  let moveBornAt: number | null = null;
  let moveAdvancedAt: number | null = null;
  let minOpacity = 1;
  let minOpacityPaneId = "-";
  let fixedDescendants = 0;
  const violations = new Set<string>();
  let pendingTicks = 0;
  let offCurveTicks = 0;
  const offCurvePaneIds = new Set<string>();
  for (const sample of samples) {
    if (sample.movePending) pendingTicks += 1;
    let offCurveHere = false;
    if (sample.moveCurrentTime !== null) {
      if (moveBornAt === null) moveBornAt = sample.t;
      if (moveAdvancedAt === null && sample.moveCurrentTime > 0) {
        moveAdvancedAt = sample.t;
      }
    }
    if (sample.fixedDescendants > fixedDescendants) {
      fixedDescendants = sample.fixedDescendants;
    }
    for (const frame of sample.frames) {
      if (frame.opacity < minOpacity) {
        minOpacity = frame.opacity;
        minOpacityPaneId = frame.paneId;
      }
      for (const property of frame.offendingProperties) {
        violations.add(`${frame.paneId}:${property}`);
      }
      if (frame.offCurve) {
        offCurveHere = true;
        offCurvePaneIds.add(frame.paneId);
      }
    }
    if (offCurveHere) offCurveTicks += 1;
  }

  // The landing is the last tick at which anything on the deck was animating.
  // Everything after it is the deck at rest, and a rect that changes there
  // changed with nothing carrying it.
  let landingIndex = -1;
  for (let i = samples.length - 1; i >= 0; i -= 1) {
    if (samples[i].frames.some((frame) => frame.animations > 0)) {
      landingIndex = i;
      break;
    }
  }
  const rectsChangedAfterLanding = new Set<string>();
  if (landingIndex >= 0) {
    const resting = new Map<string, string>();
    for (let i = landingIndex + 1; i < samples.length; i += 1) {
      for (const frame of samples[i].frames) {
        const key = rectKey(frame);
        const seen = resting.get(frame.paneId);
        if (seen === undefined) resting.set(frame.paneId, key);
        else if (seen !== key) {
          rectsChangedAfterLanding.add(frame.paneId);
          resting.set(frame.paneId, key);
        }
      }
    }
  }

  return {
    ticks: samples.length,
    framePeriodMs,
    longestGapMs,
    longestGapFrames: longestGapMs / framePeriodMs,
    gapsOverOneFrame,
    firstPaintDelayMs:
      moveBornAt === null
        ? -1
        : moveAdvancedAt === null
          ? samples[samples.length - 1].t - moveBornAt
          : moveAdvancedAt - moveBornAt,
    minOpacity,
    minOpacityPaneId,
    rectsChangedAfterLanding: [...rectsChangedAfterLanding],
    pendingTicks,
    offCurveTicks,
    offCurvePaneIds: [...offCurvePaneIds],
    violations: [...violations],
    fixedDescendants,
    suspended: samples.length < SUSPENSION_FLOOR_TICKS,
  };
}

/**
 * The effects running on `frame` itself and on its own pseudo-elements.
 *
 * `getAnimations({ subtree: true })` reaches every descendant, which is more
 * than [D9]'s subject; `getAnimations()` alone misses the frame's own pseudos,
 * which is less. The filter in between is `effect.target === frame`, and it is
 * exact rather than approximate: a `KeyframeEffect` on a pseudo-element
 * reports the ORIGINATING element as its `target` and names the pseudo
 * separately in `pseudoElement`, so the frame's `::before` and `::after` pass
 * this test and a child's effects do not.
 */
function ownEffectsOf(frame: Element): Animation[] {
  const own: Animation[] = [];
  for (const animation of frame.getAnimations({ subtree: true })) {
    const effect = animation.effect;
    if (effect === null || !("target" in effect)) continue;
    if ((effect as KeyframeEffect).target !== frame) continue;
    own.push(animation);
  }
  return own;
}

/**
 * Every property an element's own effects animate that is not a compositor
 * property.
 *
 * Read from the resolved keyframes rather than from the CSS, because a
 * transition and a WAAPI animation both land here and only one of them has a
 * rule to read.
 *
 * **The effects this is handed are the frame's own AND its pseudo-elements',
 * and getting that set right is the whole of {@link ownEffectsOf}'s work.**
 * A bare `getAnimations()` excludes an element's own pseudo-elements, and the
 * frame dim is `.tug-pane::after` — so this guard was blind to the exact
 * layers this arc put the recede on, and would have reported a clean deck
 * whatever arrived there. Sweeping the whole subtree is the opposite
 * mistake: a spinner deep in a card's body is not the settle's motion, and
 * reporting it would leave `violations` non-empty on every healthy deck,
 * which is how a guard gets loosened until it means nothing.
 */
function offendingPropertiesOf(animations: readonly Animation[]): string[] {
  const found = new Set<string>();
  for (const animation of animations) {
    const effect = animation.effect;
    if (effect === null || !("getKeyframes" in effect)) continue;
    for (const keyframe of (effect as KeyframeEffect).getKeyframes()) {
      for (const key of Object.keys(keyframe)) {
        if (KEYFRAME_METADATA_KEYS.includes(key)) continue;
        if (COMPOSITOR_PROPERTIES.includes(key)) continue;
        found.add(key);
      }
    }
  }
  return [...found];
}

/**
 * The `currentTime` of the effect carrying this frame's MOVE, or `null`.
 *
 * The move beat is the transform-bearing one. A frame mid-settle may be running
 * an opacity beat beside it — the arrive fade — and reading that one's clock
 * would answer a question about the wrong animation.
 */
function moveCurrentTimeOf(animations: readonly Animation[]): number | null {
  for (const animation of animations) {
    const effect = animation.effect;
    if (effect === null || !("getKeyframes" in effect)) continue;
    const carriesTransform = (effect as KeyframeEffect)
      .getKeyframes()
      .some((keyframe) => "transform" in keyframe);
    if (!carriesTransform) continue;
    const currentTime = animation.currentTime;
    if (typeof currentTime === "number") return currentTime;
  }
  return null;
}

/**
 * Whether this frame is carrying a move that has NOT STARTED.
 *
 * `startTime === null` is the read, and it is the one {@link
 * moveCurrentTimeOf} cannot make: a play-pending animation's `currentTime` is
 * `null` too, so that function's `typeof === "number"` guard skips it and the
 * caller cannot tell a pending move from no move at all. Every tick of the
 * pending window therefore reads as "the deck is not animating", which is why
 * `firstPaintDelayMs` has been `0` on every run ever recorded — it starts its
 * clock at the first tick it can SEE the animation, which is already the first
 * tick the animation has started.
 */
function movePendingOf(animations: readonly Animation[]): boolean {
  for (const animation of animations) {
    const effect = animation.effect;
    if (effect === null || !("getKeyframes" in effect)) continue;
    const carriesTransform = (effect as KeyframeEffect)
      .getKeyframes()
      .some((keyframe) => "transform" in keyframe);
    if (!carriesTransform) continue;
    if (animation.startTime === null) return true;
  }
  return false;
}

/**
 * Read one tick's sample off the DOM under `root`.
 *
 * The fixed-descendant sweep is R01's runtime half and costs one
 * `getComputedStyle` walk per tick over a class that should be empty: an
 * element computing `position: fixed` under a promoted frame is positioned
 * against the frame rather than the viewport, which is the containing-block
 * trap `[B02]` exists to keep shut.
 *
 * **That sweep is off by default, and the default is the load-bearing half.**
 * It walks EVERY element under every shown frame and asks each one for its
 * computed style — a cost proportional to how much transcript a card is
 * holding, paid once per rendering opportunity. On a bench run against empty
 * seeded cards that is nothing; on a real deck of loaded sessions it is the
 * largest main-thread term inside the settle window, which is the one window
 * [D9] forbids main-thread work in. The in-product record ({@link
 * SettleFrameReading} via `deck-canvas.tsx`) reads none of it — Spec S03's
 * row carries no `fixedDescendants` field — so it asks for the reading
 * without it, and the probe the app-test drives asks for it by name.
 */
export function sampleSettleFrame(
  root: ParentNode,
  options?: { readonly countFixedDescendants?: boolean },
): SettleFrameSample {
  const countFixed = options?.countFixedDescendants === true;
  const frames: SettleFramePaneSample[] = [];
  let moveCurrentTime: number | null = null;
  let movePending = false;
  let fixedDescendants = 0;
  for (const frame of root.querySelectorAll<HTMLElement>(SHOWN_PANE_FRAMES)) {
    const paneId = frame.getAttribute("data-pane-id");
    if (paneId === null) continue;
    const rect = frame.getBoundingClientRect();
    const animations = ownEffectsOf(frame);
    const pendingHere = movePendingOf(animations);
    if (pendingHere) movePending = true;
    if (moveCurrentTime === null) {
      moveCurrentTime = moveCurrentTimeOf(animations);
    }
    frames.push({
      paneId,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      opacity: Number.parseFloat(getComputedStyle(frame).opacity),
      animations: animations.length,
      offendingProperties: offendingPropertiesOf(animations),
      offCurve: pendingHere,
    });
    if (countFixed) {
      for (const descendant of frame.querySelectorAll<HTMLElement>("*")) {
        if (getComputedStyle(descendant).position === "fixed") {
          fixedDescendants += 1;
        }
      }
    }
  }
  return {
    t: performance.now(),
    moveCurrentTime,
    movePending,
    frames,
    fixedDescendants,
  };
}

/**
 * The armed sampler. One instance per document; {@link SettleFrameProbe.arm}
 * starts a frame loop and {@link SettleFrameProbe.disarm} ends it and forgets
 * everything it collected.
 */
class SettleFrameProbe {
  private handle: number | null = null;
  private samples: SettleFrameSample[] = [];
  private root: ParentNode | null = null;
  private stallMs = 0;

  get armed(): boolean {
    return this.handle !== null;
  }

  arm(root?: ParentNode): void {
    if (this.handle !== null) return;
    this.root = root ?? document;
    this.samples = [];
    const tick = (): void => {
      const scope = this.root;
      if (scope === null) return;
      if (this.stallMs > 0) {
        const until = performance.now() + this.stallMs;
        this.stallMs = 0;
        // A deliberate long task, planted on the main thread inside the settle
        // window. `[D5]`'s forcing probe: without it, every green reading this
        // instrument takes is unfalsifiable, because a sampler that silently
        // stopped observing and a deck that genuinely stopped dropping frames
        // produce the same zeros.
        while (performance.now() < until) {
          /* hold the thread */
        }
      }
      // The bench probe is the reading that wants the fixed-descendant sweep:
      // it is R01's runtime half and the app-test asserts it is zero. The
      // in-product record does not ask for it.
      this.samples.push(
        sampleSettleFrame(scope, { countFixedDescendants: true }),
      );
      this.handle = requestAnimationFrame(tick);
    };
    this.handle = requestAnimationFrame(tick);
  }

  disarm(): void {
    if (this.handle !== null) {
      cancelAnimationFrame(this.handle);
      this.handle = null;
    }
    this.root = null;
    this.stallMs = 0;
    // The samples go with the loop, which is what this module's header
    // promises: disarming drops every sample it was keeping. `take()` is
    // called before `disarm()`, never after it.
    this.samples = [];
  }

  /**
   * Plant a long task of `ms` on the NEXT sampled tick.
   *
   * Scheduled rather than run inline so the caller's own call returns first and
   * the stall lands where a real one would — inside the settle window, between
   * two rendering opportunities — rather than in front of the gesture that
   * started it.
   */
  forceStall(ms: number): void {
    this.stallMs = ms;
  }

  /** Classify everything recorded so far. The samples are kept. */
  take(): SettleFrameReading {
    return classifySettleFrames(this.samples);
  }

  /** Hand back the raw samples — for a caller that wants the run, not the verdict. */
  takeSamples(): SettleFrameSample[] {
    return this.samples;
  }
}

export const settleFrameProbe = new SettleFrameProbe();
