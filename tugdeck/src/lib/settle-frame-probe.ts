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
 * ## Three failures that look identical from outside
 *
 * The tween STARTED late — a long click task delayed the first rendering
 * opportunity, so the animation's `currentTime` is still zero when the first
 * tick lands — and the tween RAN but PAINTED late, where `currentTime` advanced
 * normally while the wall-clock gaps between ticks blew out. Only the
 * animation's own clock separates them, which is why every sample carries the
 * move animation's `currentTime` beside the tick's timestamp.
 *
 * The third is the one neither of those can see: the frame ARRIVED ON TIME
 * CARRYING THE WRONG POSE. Every tick landed inside a frame period and the
 * animation's clock advanced exactly as it should, and the frame was painting
 * a pose its own curve does not pass through at that instant — most often its
 * destination, during the window before the effect's local time resolves. A
 * gap counter reports a perfect run because the frames did arrive; an
 * animation clock reports a perfect run because the clock did advance. Only a
 * comparison of the pose the element COMPUTES against the pose its own curve
 * SAYS it should hold sees it, and that comparison is {@link
 * SettleFrameReading.offCurveTicks}.
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

/**
 * How far a frame's computed pose may sit from the pose its curve says it
 * should hold before the frame counts as painting off-curve.
 *
 * Half a CSS pixel, matching the half-pixel floor `pane-flip.ts`'s callers
 * already use: a measurement a hair different from the curve is not a change,
 * and a tolerance tighter than the floor the imposer itself rounds to would
 * report arithmetic as motion.
 *
 * It is a floor on the DISTANCE, not the whole of the comparison. The pose a
 * frame is held against is a one-tick window of its own curve rather than a
 * single instant, because the two readings the comparison is over are not
 * sampled from the same one — see {@link classifySettleFrames}. This constant
 * is what admits rounding; the window is what admits the skew.
 */
export const OFF_CURVE_TOLERANCE_PX = 0.5;

/** A 2D translate in CSS pixels. Every settle transform is strictly 2D. */
export type Translate = readonly [x: number, y: number];

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
   * The pose the element COMPUTES at this instant, in CSS px, or `null` when
   * it computes no transform at all.
   *
   * `null` is not an absence of a pose. An element computing no transform is
   * standing at its **committed** pose — for a FLIP, the destination — so the
   * comparison reads it as the identity `[0, 0]` rather than as incomparable.
   * A frame standing at its destination while its curve says its origin is the
   * whole defect this field exists to see.
   */
  readonly appliedTranslate: Translate | null;
  /**
   * The pose the frame's OWN CURVE says it should hold at this instant.
   *
   * Interpolated between the keyframe pair bracketing the effect's resolved
   * progress; keyframe 0 when the local time is unresolved — the pending
   * window, where reporting `null` would define the bar vacuous in exactly
   * the window this instrument exists to measure. `null` only when the frame
   * carries no transform-bearing effect at all, which is a question the
   * classifier answers with {@link SettleFramePaneSample.hasTransformEffect}
   * and this pane's own history rather than with a pose.
   */
  readonly curveTranslate: Translate | null;
  /**
   * The frame carries a transform-bearing effect at this tick at all, resolved
   * or not.
   *
   * Separated from {@link SettleFramePaneSample.curveTranslate} so the
   * classifier can tell "this frame's move has not appeared yet" — never
   * comparable — from "this frame's move is over", where the expected pose is
   * the identity and a residual translate is an opening pose outliving its
   * beat.
   */
  readonly hasTransformEffect: boolean;
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
   * resolved start time — the window between `el.animate()` and the
   * compositor having been handed the effect, read once per tick rather than
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
  /** The longest run of CONSECUTIVE off-curve ticks. */
  readonly longestOffCurveRunTicks: number;
  /**
   * That run's first tick, as a distance in ms from the first tick at which a
   * transform-bearing effect existed at all. `-1` when there is no run.
   *
   * This is what separates a boundary from the pending window, and neither
   * `offCurveTicks` nor `offCurvePaneIds` can: a run at an offset near zero is
   * the window before the first effect's local time resolved, and a run at an
   * offset near a beat's nominal duration is the seam between two beats.
   */
  readonly longestOffCurveRunOffsetMs: number;
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
  longestOffCurveRunTicks: 0,
  longestOffCurveRunOffsetMs: -1,
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
 *
 * **A pending move's ticks are not quiet, and that is the correction.** A
 * `moveCurrentTime` of `null` used to be the whole test for quiet, and the
 * pending window reads `null` there while being the single most contended
 * stretch of the run — it is the window a long click task holds the main
 * thread through. Deriving the display's period from those gaps would read the
 * long task as the display's rate and then report the run as smooth against
 * it. `movePending` is the reading that says the deck is mid-gesture even
 * though no clock has started, so a tick carrying it is excluded.
 */
function deriveFramePeriodMs(samples: readonly SettleFrameSample[]): number {
  const quietGaps: number[] = [];
  const allGaps: number[] = [];
  for (let i = 1; i < samples.length; i += 1) {
    const gap = samples[i].t - samples[i - 1].t;
    allGaps.push(gap);
    if (
      samples[i].moveCurrentTime === null &&
      !samples[i].movePending &&
      samples[i - 1].moveCurrentTime === null &&
      !samples[i - 1].movePending
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
 * **"First existed" counts the PENDING window, and the reason is narrower
 * than the one this module used to give.** The shipped claim was that a
 * play-pending animation's `currentTime` reads `null`, so `moveCurrentTime`
 * was blind through the whole window and the clock could only ever start at
 * the first tick the move was already running. **That claim is false, and it
 * was measured false here rather than reasoned about**: a forced-stall run on
 * a real WebKit deck reports a play-pending animation's `currentTime` as a
 * resolved `0`, never `null` (at0622's column legs, 2026-09-24). So the old
 * window did open at the pending window after all.
 *
 * `movePending || moveCurrentTime !== null` is kept anyway, because the two
 * readings answer different questions and only one of them is guaranteed: the
 * clock says a move exists on SOME pane, and `movePending` says one exists
 * with an unresolved start time. A deck where the only transform-bearing
 * effect is pending and reads `0` opens the window under either test; a
 * platform that ever reported `null` there — which the spec permits and this
 * measurement only rules out for one engine on one day — opens it under only
 * one. The opener is the one that does not depend on the answer.
 *
 * `offCurve` is decided HERE rather than on the sample, because two of Spec
 * S01's four cases need to know whether a pane carried a transform-bearing
 * effect at an EARLIER tick — a beat that has been and gone expects the
 * identity, and a pane that has never animated is not comparable at all. The
 * DOM reader records three facts per frame (`appliedTranslate`,
 * `curveTranslate`, `hasTransformEffect`) and this function carries the one
 * bit of per-pane history that turns them into a verdict.
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
  let effectFirstSeenAt: number | null = null;
  let minOpacity = 1;
  let minOpacityPaneId = "-";
  let fixedDescendants = 0;
  const violations = new Set<string>();
  let pendingTicks = 0;
  let offCurveTicks = 0;
  const offCurvePaneIds = new Set<string>();
  // Spec S01's cases 3 and 4 need this pane's own effect history across the
  // WHOLE run, not just the part of it already walked, so they are resolved in
  // one pass up front rather than carried as a bit.
  //
  // `firstEffectTick` is case 4 read forwards: before a pane's own beat has
  // appeared it is not comparable, because in a `["depart", "room", "arrive"]`
  // settle a survivor wears its opening pose through beats that run before its
  // own, and a `holdPlan.held` frame wears an inline inverse and never
  // animates at all.
  //
  // `lastEffectTick` is case 4 read BACKWARDS, and it is the half the shipped
  // carry-bit could not express. A pane between two of its own beats — held at
  // a resize beat's constant inline transform, waiting for the move beat that
  // will carry it — has carried an effect and is carrying none right now, so a
  // forward-only reading calls it a residue and reports every tick of the wait
  // off-curve. Measured on at0622's column split: a pane holding
  // `translate(0px, -605px)` between its beats, reported off-curve for 43
  // consecutive ticks while doing exactly what the settle asked of it. Only a
  // pane past its LAST effect owes the identity.
  const firstEffectTick = new Map<string, number>();
  const lastEffectTick = new Map<string, number>();
  const curveByPane = new Map<string, (Translate | null)[]>();
  for (let i = 0; i < samples.length; i += 1) {
    for (const frame of samples[i].frames) {
      let series = curveByPane.get(frame.paneId);
      if (series === undefined) {
        series = new Array<Translate | null>(samples.length).fill(null);
        curveByPane.set(frame.paneId, series);
      }
      series[i] = frame.curveTranslate;
      if (!frame.hasTransformEffect) continue;
      if (!firstEffectTick.has(frame.paneId)) firstEffectTick.set(frame.paneId, i);
      lastEffectTick.set(frame.paneId, i);
    }
  }
  let longestOffCurveRunTicks = 0;
  let longestOffCurveRunStartT: number | null = null;
  let currentRunTicks = 0;
  let currentRunStartT = 0;
  for (let tick = 0; tick < samples.length; tick += 1) {
    const sample = samples[tick];
    if (sample.movePending) pendingTicks += 1;
    let offCurveHere = false;
    if (sample.movePending || sample.moveCurrentTime !== null) {
      if (moveBornAt === null) moveBornAt = sample.t;
    }
    if (
      moveAdvancedAt === null &&
      sample.moveCurrentTime !== null &&
      sample.moveCurrentTime > 0
    ) {
      moveAdvancedAt = sample.t;
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
      if (frame.hasTransformEffect && effectFirstSeenAt === null) {
        effectFirstSeenAt = sample.t;
      }
      const first = firstEffectTick.get(frame.paneId);
      const last = lastEffectTick.get(frame.paneId);
      // Case 4, both ends. A pane whose own beat has not arrived, and a pane
      // waiting between two of its own, are both standing where something told
      // them to stand and neither is comparable to a curve.
      if (first === undefined || last === undefined) continue;
      if (tick < first) continue;
      if (!frame.hasTransformEffect && tick <= last) continue;

      // The poses this frame may be holding without being off its curve.
      //
      // **The window is ±1 tick, and that is a fact about the instrument
      // rather than a slackening of the bar.** `getComputedTiming().progress`
      // and `getComputedStyle().transform` are two clocks read in the same JS
      // tick that do not answer for the same instant: the progress is the
      // effect's time now, and the computed transform is what the last style
      // resolution produced for an animation the compositor is driving. On
      // at0622's four-up leg the gap measured 22px of a 1493px travel at
      // progress 0.16 — far under one frame of the curve's own speed, on a
      // frame that was travelling exactly as asked. A fixed half-pixel
      // comparison against a single instant reports that skew as a defect on
      // almost every tick of a fast beat, which is what it did.
      //
      // The test is CONTAINMENT in the segment those ticks span, not nearness
      // to one of them, and the difference is the whole of it. Three sampled
      // poses of a fast beat sit ~60px apart; a frame a third of a frame
      // behind lands BETWEEN two of them and is near neither. What "on its own
      // curve" means is that the pose is one the curve actually passes through
      // in that window, so the band is [min, max] of the neighbouring poses
      // per axis, widened by the rounding floor.
      //
      // It costs the bar nothing it is for: the defect it exists to catch is a
      // frame at its DESTINATION while its curve says its ORIGIN, which is the
      // whole travel outside the band rather than a fraction of one frame
      // inside it.
      const series = curveByPane.get(frame.paneId);
      const candidates: Translate[] = [];
      if (frame.hasTransformEffect) {
        for (const at of [tick - 1, tick, tick + 1]) {
          const pose = at >= 0 && at < samples.length ? series?.[at] : null;
          if (pose != null) candidates.push(pose);
        }
        // The LAST tick an effect exists has no tick after it to bound the
        // band from below, and the effect's own end value is the one pose the
        // three neighbours cannot supply. A curve's final keyframe is pinned
        // to the identity exactly so that ending is safe at any moment, so a
        // frame already wearing its destination on that tick has arrived a
        // fraction of a frame early rather than skipped its travel — and the
        // band has to admit it, or every settle reads one off-curve tick at
        // the beat's nominal duration. That reading is what this widening was
        // made from: `at0622`'s four-up and eight-up legs both put their
        // single off-curve tick at 365-369ms of a ~365ms move, on every pane
        // at once, which is the shape of an instrument that cannot see the
        // end of a curve rather than of a deck that stopped short of it.
        if (tick === last) candidates.push([0, 0]);
      } else {
        // Case 3: past its last beat, the frame is committed at Last and the
        // only pose it may compute is the identity — with the tick before it
        // admitted too, so the hand-off frame itself is not a defect.
        candidates.push([0, 0]);
        const handOff = tick - 1 >= 0 ? series?.[tick - 1] : null;
        if (handOff != null) candidates.push(handOff);
      }
      // A `null` applied translate is the identity: the element is standing at
      // its committed pose, which for a FLIP is the destination.
      const applied = frame.appliedTranslate ?? [0, 0];
      if (candidates.length === 0) continue;
      let onCurve = true;
      for (const axis of [0, 1] as const) {
        let lo = Infinity;
        let hi = -Infinity;
        for (const pose of candidates) {
          if (pose[axis] < lo) lo = pose[axis];
          if (pose[axis] > hi) hi = pose[axis];
        }
        if (
          applied[axis] < lo - OFF_CURVE_TOLERANCE_PX ||
          applied[axis] > hi + OFF_CURVE_TOLERANCE_PX
        ) {
          onCurve = false;
        }
      }
      if (!onCurve) {
        offCurveHere = true;
        offCurvePaneIds.add(frame.paneId);
      }
    }
    if (offCurveHere) offCurveTicks += 1;
    if (offCurveHere) {
      if (currentRunTicks === 0) currentRunStartT = sample.t;
      currentRunTicks += 1;
      if (currentRunTicks > longestOffCurveRunTicks) {
        longestOffCurveRunTicks = currentRunTicks;
        longestOffCurveRunStartT = currentRunStartT;
      }
    } else {
      currentRunTicks = 0;
    }
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
    longestOffCurveRunTicks,
    // Measured from the first tick a transform-bearing effect existed, so the
    // offset reads as a position along the settle rather than along the
    // probe's arming. A run with no effect ever seen cannot be placed.
    longestOffCurveRunOffsetMs:
      longestOffCurveRunStartT === null || effectFirstSeenAt === null
        ? -1
        : longestOffCurveRunStartT - effectFirstSeenAt,
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
function ownEffectsOf(frame: Element): ResolvedEffect[] {
  const own: ResolvedEffect[] = [];
  for (const animation of frame.getAnimations({ subtree: true })) {
    const effect = animation.effect;
    if (effect === null || !("target" in effect)) continue;
    const keyframeEffect = effect as KeyframeEffect;
    if (keyframeEffect.target !== frame) continue;
    if (!("getKeyframes" in keyframeEffect)) continue;
    const keyframes = keyframeEffect.getKeyframes();
    own.push({
      animation,
      effect: keyframeEffect,
      keyframes,
      carriesTransform: keyframes.some((keyframe) => "transform" in keyframe),
    });
  }
  return own;
}

/**
 * One of a frame's own effects, with its keyframes already resolved.
 *
 * `getKeyframes()` is the expensive call in this module and four separate
 * readers used to make it — the offending-property sweep, the move clock, the
 * pending read, and now the curve pose. Resolving once per effect and handing
 * the array around keeps the per-tick cost flat as the readers multiply, which
 * matters because the in-product record ({@link
 * SettleFrameReading} via `deck-canvas.tsx`) pays it inside the one window
 * [D9] forbids main-thread work in. The readers below each stay a named
 * function saying what it measures; none of them touches the DOM again.
 */
interface ResolvedEffect {
  readonly animation: Animation;
  readonly effect: KeyframeEffect;
  readonly keyframes: readonly Keyframe[];
  /** This effect animates `transform` — the MOVE beat, not the fade beside it. */
  readonly carriesTransform: boolean;
}

/**
 * A CSS transform string's translate components, or `null` when it names no
 * transform at all.
 *
 * `DOMMatrixReadOnly` parses the computed matrix and a keyframe's authored
 * transform list alike, and `m41`/`m42` are its translate terms. A 2D matrix
 * is guaranteed here because `pane-flip.ts` keeps every settle transform
 * strictly 2D; a 3D one would still read its x and y off the same two fields.
 *
 * A value this cannot parse — a percentage translate, which resolves against
 * the element's own box and has no meaning without it — reads as `null` rather
 * than throwing, because a probe that threw inside a rAF tick would take the
 * settle down with it.
 */
export function appliedTranslateOf(transform: string | null): Translate | null {
  if (transform === null) return null;
  const value = transform.trim();
  if (value === "" || value === "none") return null;
  try {
    const matrix = new DOMMatrixReadOnly(value);
    return [matrix.m41, matrix.m42];
  } catch {
    return null;
  }
}

/**
 * The pose this frame's own curve says it should hold right now.
 *
 * Spec S01's three comparable cases, in order:
 *
 * 1. **A resolved `progress`** — the keyframe pair bracketing it, interpolated
 *    linearly. `springSettleKeyframes` rides the spring in the keyframe
 *    OFFSETS under a plain `linear` keyword, so linear interpolation between
 *    adjacent keyframes *is* the curve rather than an approximation of it.
 * 2. **An unresolved `progress`** — the pending window — is **keyframe 0**,
 *    never `null`. The pose the curve holds at its start is what the frame
 *    owes the eye whether or not the platform is applying it yet, and
 *    reporting `null` here is what would make the bar vacuous by construction
 *    rather than by measurement: `fill: "none"` gives an unresolved local time
 *    exactly `progress === null`, which is the defect's own window.
 * 3. **No transform-bearing effect at all** — `null`, and the classifier
 *    decides from this pane's history whether that means "the beat is over,
 *    expect the identity" or "not comparable".
 */
export function curveTranslateOf(
  effects: readonly ResolvedEffect[],
): Translate | null {
  for (const resolved of effects) {
    if (!resolved.carriesTransform) continue;
    const poses: { offset: number; translate: Translate }[] = [];
    for (const keyframe of resolved.keyframes) {
      const transform = keyframe.transform;
      if (typeof transform !== "string") continue;
      const offset = keyframe.computedOffset;
      if (typeof offset !== "number") continue;
      // A keyframe naming `none` is an explicit pose — the identity — rather
      // than an absent one, which is why the curve side reads the parse's
      // `null` as `[0, 0]` and the applied side does the same downstream.
      poses.push({ offset, translate: appliedTranslateOf(transform) ?? [0, 0] });
    }
    if (poses.length === 0) continue;
    const progress = resolved.effect.getComputedTiming().progress;
    if (typeof progress !== "number") return poses[0].translate;
    if (progress <= poses[0].offset) return poses[0].translate;
    const last = poses[poses.length - 1];
    if (progress >= last.offset) return last.translate;
    for (let i = 1; i < poses.length; i += 1) {
      const to = poses[i];
      if (progress > to.offset) continue;
      const from = poses[i - 1];
      const span = to.offset - from.offset;
      const fraction = span === 0 ? 0 : (progress - from.offset) / span;
      return [
        from.translate[0] + (to.translate[0] - from.translate[0]) * fraction,
        from.translate[1] + (to.translate[1] - from.translate[1]) * fraction,
      ];
    }
    return last.translate;
  }
  return null;
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
function offendingPropertiesOf(effects: readonly ResolvedEffect[]): string[] {
  const found = new Set<string>();
  for (const resolved of effects) {
    for (const keyframe of resolved.keyframes) {
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
function moveCurrentTimeOf(effects: readonly ResolvedEffect[]): number | null {
  for (const resolved of effects) {
    if (!resolved.carriesTransform) continue;
    const currentTime = resolved.animation.currentTime;
    if (typeof currentTime === "number") return currentTime;
  }
  return null;
}

/**
 * Whether this frame is carrying a move whose start time is not yet resolved.
 *
 * What it measures is the window between `el.animate()` and the compositor
 * having been handed the effect. `el.animate()` returns a PLAY-PENDING
 * animation: its start time stays unresolved until the first update after the
 * animation is ready, and for a composited animation "ready" means the
 * compositor has it. `startTime === null` is that window, exactly.
 *
 * **A pending animation's `currentTime` reads `0`, not `null`** — measured on
 * a real WebKit deck under a forced stall rather than taken from this
 * module's former assertion, which said `null` and was wrong (at0622's column
 * legs, 2026-09-24). So {@link moveCurrentTimeOf} does NOT skip a pending
 * animation, and a caller holding only the clock sees a move that exists and
 * reads zero. What it still cannot see is WHY it reads zero: a move that has
 * not been handed to the compositor and a move on its very first frame are
 * the same number. `startTime` is the reading that separates them.
 *
 * It no longer decides anything about off-curve. Whether the frame is painting
 * the right pose is a measured comparison now ({@link curveTranslateOf}
 * against {@link appliedTranslateOf}), and a pending move whose frame happens
 * to be holding its origin is on-curve however long the window runs. This
 * stays because the window itself is a true reading and worth counting:
 * `pendingTicks` sizes it, and `firstPaintDelayMs` opens on it.
 */
function movePendingOf(effects: readonly ResolvedEffect[]): boolean {
  for (const resolved of effects) {
    if (!resolved.carriesTransform) continue;
    if (resolved.animation.startTime === null) return true;
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
    const effects = ownEffectsOf(frame);
    if (movePendingOf(effects)) movePending = true;
    if (moveCurrentTime === null) {
      moveCurrentTime = moveCurrentTimeOf(effects);
    }
    // One computed-style declaration per frame, read twice. `getComputedStyle`
    // is the expensive half of this tick — it flushes pending style — and
    // asking for the same element's declaration a second time to read
    // `transform` beside `opacity` would double that cost on the in-product
    // path for nothing.
    const computed = getComputedStyle(frame);
    frames.push({
      paneId,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      opacity: Number.parseFloat(computed.opacity),
      animations: effects.length,
      offendingProperties: offendingPropertiesOf(effects),
      appliedTranslate: appliedTranslateOf(computed.transform),
      curveTranslate: curveTranslateOf(effects),
      hasTransformEffect: effects.some((effect) => effect.carriesTransform),
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
