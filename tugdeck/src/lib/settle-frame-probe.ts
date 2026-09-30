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

/** A frame's border box in CSS px, as `getBoundingClientRect()` reports it. */
export interface PaneRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** One shown frame's geometry and motion state at one sampling instant. */
export interface SettleFramePaneSample {
  readonly paneId: string;
  /**
   * The frame's border box at this instant, or `null` when the sampler was
   * asked not to read it.
   *
   * `getBoundingClientRect()` is a forced LAYOUT, and the only reader of the
   * box is {@link SettleFrameReading.rectsChangedAfterLanding}, which the
   * product's own `settle-frames` row does not carry. So the bench probe asks
   * for it and the in-product record does not: on a fold whose `height` tween
   * lays the page out every frame anyway the read is free, and on the
   * compositor-only settle [D9] asks for it would be the one thing still
   * forcing a layout per tick. A `null` here is a sampler that declined the
   * read, never a frame with no box.
   */
  readonly rect: PaneRect | null;
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
  /**
   * The GESTURE → the first tick the run recorded. `-1` only when no tick ever
   * arrived.
   *
   * **This is the settle's lead, and it used to be a fact about an
   * animation.** The shipped definition was "the move animation's birth → the
   * first tick its `currentTime` had advanced", which reports `-1` on any
   * settle carrying no transform-bearing effect — and a session card's fold is
   * exactly that, a real `height` term with no move to be late. The instrument
   * called three folds healthy that way. The old definition is not lost; it
   * lives under {@link SettleFrameReading.moveFirstPaintDelayMs}, which is
   * where the late-START-versus-late-PAINT discrimination now reads from.
   *
   * `SpaceSwitchFrameReading.firstPaintDelayMs` is the SAME quantity from the
   * same origin, and the two are now comparable — which they were not before,
   * and the difference was written down in both modules as a warning.
   */
  readonly firstPaintDelayMs: number;
  /**
   * The gesture → the arm: the mutator's own preamble and the store's notify,
   * which is the part of {@link SettleFrameReading.firstPaintDelayMs} the
   * sampler's own arming could not see. `0` for a caller with no gesture
   * stamp, which is every settle but a fold's today.
   */
  readonly commitDelayMs: number;
  /**
   * Move start → the first tick at which its `currentTime` had advanced; `-1`
   * when no move animation ever existed.
   *
   * The old `firstPaintDelayMs`, under its own name. It answers a question the
   * gesture-origin field cannot: whether the tween STARTED late or RAN and
   * PAINTED late. Only the animation's own clock separates those, and a `-1`
   * here beside a real lead above is the signature of a settle whose whole
   * term is a paint property.
   */
  readonly moveFirstPaintDelayMs: number;
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
  /**
   * Ticks at which at least one frame was STRANDED: travelling on the tick
   * before and CUT OFF mid-travel, carrying no effect at all on this one, and
   * travelling again later, while standing at its committed pose.
   *
   * The double-hop [B01] closes, and the one failure `offCurveTicks` cannot
   * see by construction — a tick with no effect on it has no curve to compare
   * a pose against, so the classifier's case 4 skips it. What the reader sees
   * is the frame at the interrupted settle's END pose for one painted frame
   * before the replacement tween takes it back: mid → old end → mid → new
   * end. The bar is zero.
   *
   * **Cut off, not finished.** A pane whose own beat reached its end time
   * lands at the identity and carries no effect after it, which is the same
   * three facts a cut reads — so the previous tick's own CURVE is what
   * separates them: at its end pose the beat landed, mid-travel it vanished.
   * Without that reading a survivor whose room beat lands inside a still-open
   * recording and is then re-tweened by a close reports a strand on the tick
   * after landing, which is a landed frame ([F01]).
   */
  readonly strandedTicks: number;
  /** Every pane stranded at any tick. */
  readonly strandedPaneIds: readonly string[];
  /**
   * Every pane whose ORIGIN moved across the run while it carried no
   * transform-bearing effect at any tick — the cut ([B02]).
   *
   * The failure [F03] produces: two commits in one task, the second arm
   * discards the first's First rects, the coalesced Last pass plans nothing,
   * and the frames the first commit moved jump while their neighbours glide.
   * Invisible to every other clause, because a pane with no effect at any
   * tick never enters the curve comparison. Bench-probe only — the
   * in-product record declines the rect read, so the row reads this empty.
   */
  readonly cutPaneIds: readonly string[];
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
  commitDelayMs: 0,
  moveFirstPaintDelayMs: -1,
  minOpacity: 1,
  minOpacityPaneId: "-",
  rectsChangedAfterLanding: [],
  pendingTicks: 0,
  offCurveTicks: 0,
  offCurvePaneIds: [],
  strandedTicks: 0,
  strandedPaneIds: [],
  cutPaneIds: [],
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
 *
 * The `quiet` argument is how a caller says which ticks nothing was competing
 * with. It is per-tick rather than per-gap, and a gap counts as quiet only when
 * both of its ends are: a gap with one contended end was contended. A caller
 * that has no such reading passes nothing, and every tick counts as quiet,
 * which is the same answer the fallback chain gives.
 */
function deriveFramePeriodMs(
  ticks: readonly number[],
  quiet: readonly boolean[] | undefined,
): number {
  const quietGaps: number[] = [];
  const allGaps: number[] = [];
  for (let i = 1; i < ticks.length; i += 1) {
    const gap = ticks[i] - ticks[i - 1];
    allGaps.push(gap);
    if (quiet === undefined || (quiet[i] && quiet[i - 1])) {
      quietGaps.push(gap);
    }
  }
  return median(quietGaps) ?? median(allGaps) ?? FALLBACK_FRAME_PERIOD_MS;
}

/**
 * The cadence half of a frame reading: how fast the display runs, and which
 * gaps in the run were longer than one of its frames.
 *
 * It is the ONE definition of that computation ([P02]). Two instruments ask it:
 * {@link classifySettleFrames}, which reads a settle's per-pane samples and
 * carries a quiet flag per tick, and the switch record in
 * `space-switch-frames.ts`, which has nothing but the tick series. Both get
 * their `framePeriodMs`, `longestGapMs` and `gapsOverOneFrame` from here, so a
 * reading taken by one is comparable with a reading taken by the other. A
 * second copy of this arithmetic anywhere is the defect this function exists to
 * prevent — the numbers would drift apart silently, each looking plausible.
 */
export interface FrameCadenceReading {
  /** The display's period in ms, derived from the run — see below. */
  readonly framePeriodMs: number;
  readonly longestGapMs: number;
  /** Gaps over `framePeriodMs * GAP_TOLERANCE`. */
  readonly gapsOverOneFrame: number;
  /** The gap series itself, so a reader can see the shape and not only its summary. */
  readonly gaps: readonly number[];
  /** Tick count below {@link SUSPENSION_FLOOR_TICKS}; the whole reading is void. */
  readonly suspended: boolean;
}

/**
 * `originAt` is the instant the run was ASKED FOR, on the ticks' own clock —
 * the gesture, for a caller that has one. Given it, `ticks[0] - originAt`
 * enters the series as a LEADING GAP, counted by `longestGapMs` and
 * `gapsOverOneFrame` like any other.
 *
 * **It is a gap and not a tick, and the distinction is the whole of the
 * parameter.** The dead time before the first tick has no `ticks[i] -
 * ticks[i-1]` entry, so a freeze between the gesture and the first rendering
 * opportunity is invisible to this function by construction — 86–130 ms of
 * nothing, on a run the summary then calls smooth. Prepending the origin as a
 * synthetic `ticks[0]` would fix that and break something worse: the lead is
 * the single most contended stretch of the run, and
 * {@link deriveFramePeriodMs} would read it as the display's rate and then
 * report every real gap as comfortably inside a frame. So the lead reaches the
 * counters and never the period, which is the same treatment a pending tick
 * already gets and for the same reason.
 *
 * It lives HERE rather than in the caller because this function is the module's
 * one definition of "which gaps were longer than one frame". A settle that
 * prepended its own lead outside it would make `SettleFrameReading.longestGapMs`
 * and `SpaceSwitchFrameReading.longestGapMs` mean different things under one
 * name — the drift this function exists to prevent, on a new field.
 */
export function classifyFrameCadence(
  ticks: readonly number[],
  quiet?: readonly boolean[],
  originAt?: number,
): FrameCadenceReading {
  const framePeriodMs = deriveFramePeriodMs(ticks, quiet);
  const gaps: number[] = [];
  if (originAt !== undefined && ticks.length > 0) gaps.push(ticks[0] - originAt);
  for (let i = 1; i < ticks.length; i += 1) {
    gaps.push(ticks[i] - ticks[i - 1]);
  }
  let longestGapMs = 0;
  let gapsOverOneFrame = 0;
  for (const gap of gaps) {
    if (gap > longestGapMs) longestGapMs = gap;
    if (gap > framePeriodMs * GAP_TOLERANCE) gapsOverOneFrame += 1;
  }
  return {
    framePeriodMs,
    longestGapMs,
    gapsOverOneFrame,
    gaps,
    suspended: ticks.length < SUSPENSION_FLOOR_TICKS,
  };
}

function rectKey(rect: PaneRect): string {
  return `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`;
}

/**
 * Classify a run of ticks into the reading Spec S01 names.
 *
 * `armedAt` is when the sampler's pump started and `gestureAt` is when the user
 * asked for the settle, both on the ticks' own clock. A caller with no gesture
 * stamp passes its arm for both and gets `commitDelayMs: 0` — the same fallback
 * `classifySpaceSwitchFrames` already offers one. A caller with neither has no
 * origin at all, and the first tick stands in for one: a lead of zero is the
 * honest answer to "how long before the first frame" when nothing recorded the
 * question being asked.
 *
 * `firstPaintDelayMs` is `ticks[0] - gestureAt`, and the lead it names is also
 * prepended to the gap series ({@link classifyFrameCadence}) so `longestGapMs`
 * and `gapsOverOneFrame` contain it. A freeze before the first rendering
 * opportunity is the whole defect on a session card's fold, and every counter
 * here used to start after it.
 *
 * `moveFirstPaintDelayMs` is the distance from the tick at which the move
 * animation first EXISTED to the tick at which its `currentTime` had advanced
 * past zero.
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
  armedAt?: number,
  gestureAt: number = armedAt ?? Number.NaN,
): SettleFrameReading {
  if (samples.length === 0) return EMPTY_READING;

  // With no arm and no stamp the run has no origin but its own first tick, so
  // the lead is zero rather than a number measured from a clock nobody set.
  const originAt = Number.isFinite(gestureAt) ? gestureAt : samples[0].t;
  const commitDelayMs = armedAt === undefined ? 0 : armedAt - originAt;

  // The cadence half is {@link classifyFrameCadence}'s, shared with the switch
  // record so the two instruments cannot drift ([P02]). A settle's ticks carry
  // a quiet reading the switch record has no equivalent of, so it is passed
  // alongside rather than inferred from the timestamps.
  const cadence = classifyFrameCadence(
    samples.map((sample) => sample.t),
    samples.map(
      (sample) => sample.moveCurrentTime === null && !sample.movePending,
    ),
    originAt,
  );
  const { framePeriodMs, longestGapMs, gapsOverOneFrame } = cadence;

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
  let strandedTicks = 0;
  const strandedPaneIds = new Set<string>();
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
  // Which ticks this pane carried a transform-bearing effect at all, which is
  // what {@link SettleFrameReading.strandedTicks} reads backwards and
  // forwards from the tick it is judging.
  const effectByPane = new Map<string, boolean[]>();
  for (let i = 0; i < samples.length; i += 1) {
    for (const frame of samples[i].frames) {
      let series = curveByPane.get(frame.paneId);
      if (series === undefined) {
        series = new Array<Translate | null>(samples.length).fill(null);
        curveByPane.set(frame.paneId, series);
      }
      series[i] = frame.curveTranslate;
      let present = effectByPane.get(frame.paneId);
      if (present === undefined) {
        present = new Array<boolean>(samples.length).fill(false);
        effectByPane.set(frame.paneId, present);
      }
      present[i] = frame.hasTransformEffect;
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
    let strandedHere = false;
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
      if (!frame.hasTransformEffect && tick <= last) {
        // Case 4's blind spot, and the one tick [B01] is about.
        //
        // The skip is right for a pane WAITING between two of its own beats:
        // it is holding an inline pose something told it to hold, and there
        // is no curve to compare it against. It is wrong for a pane that was
        // TRAVELLING on the tick before, carries no effect on this one, and
        // travels again later — the tween did not pause, it vanished, and the
        // pane is painting a pose no curve in the settle passes through.
        //
        // Under a deferred React commit that is exactly what a retarget
        // produces: `arm` cancels the running tween, hands the residue back
        // and clears the flip on its own tick, and the Last pass that would
        // launch the replacement is a painted frame away. So the frame paints
        // once at the interrupted settle's END pose — the identity, since the
        // FLIP's committed pose IS the destination — and then hops back to
        // the mid pose the new tween inverts from. mid → old end → mid → new
        // end, on a tick carrying no effect, which is why no curve comparison
        // could ever see it.
        //
        // Held to the identity rather than counted for any effect-less tick:
        // a pane parked at a non-identity inline pose is being held, and a
        // hold is not the hop.
        //
        // And travelled-before is not enough on its own: a beat that reached
        // its end time also leaves a pane at the identity with no effect, and
        // a retarget later in the same recording puts an effect after it. The
        // discriminator is the PREVIOUS tick's curve — the pose the tween that
        // is now gone said it should hold — which is the end pose when the
        // beat landed and mid-travel when it was cancelled. A previous curve
        // that cannot be read at all is treated as a cut, so the narrowing
        // never hides a strand it cannot rule out.
        const held = frame.appliedTranslate;
        const atCommittedPose =
          held === null ||
          (Math.abs(held[0]) <= OFF_CURVE_TOLERANCE_PX &&
            Math.abs(held[1]) <= OFF_CURVE_TOLERANCE_PX);
        const present = effectByPane.get(frame.paneId);
        const travelledBefore = tick > 0 && present?.[tick - 1] === true;
        const previousCurve =
          tick > 0 ? (curveByPane.get(frame.paneId)?.[tick - 1] ?? null) : null;
        const cutOffMidTravel =
          previousCurve === null ||
          Math.abs(previousCurve[0]) > OFF_CURVE_TOLERANCE_PX ||
          Math.abs(previousCurve[1]) > OFF_CURVE_TOLERANCE_PX;
        if (atCommittedPose && travelledBefore && cutOffMidTravel) {
          strandedHere = true;
          strandedPaneIds.add(frame.paneId);
        }
        continue;
      }

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
    if (strandedHere) strandedTicks += 1;
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
  // changed with nothing carrying it. A sample taken without rects — the
  // in-product record — has nothing to say here and says nothing.
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
        if (frame.rect === null) continue;
        const key = rectKey(frame.rect);
        const seen = resting.get(frame.paneId);
        if (seen === undefined) resting.set(frame.paneId, key);
        else if (seen !== key) {
          rectsChangedAfterLanding.add(frame.paneId);
          resting.set(frame.paneId, key);
        }
      }
    }
  }

  // Every frame that MOVED across the run and never carried a tween — the cut
  // ([B02]).
  //
  // A frame the imposer moved without planning a beat for it is the whole of
  // what [F03] produces: the coalesced Last pass finds no First rect, plans
  // nothing, and the frame jumps to Last while every frame beside it glides.
  // No clause above can see it, and the reason is case 4 again — a pane with
  // no effect at any tick never enters the curve comparison at all, so the
  // reading that says "it arrived on time and on its curve" is a reading
  // about frames that HAD a curve.
  //
  // The ORIGIN alone, not the whole box. A frame that only resized — a
  // fold's `height`, a width preset — did not travel, and the beat carrying
  // a size term is not a transform. What this asks is whether a frame that
  // went somewhere was carried there.
  //
  // Rect-bearing samples only, like `rectsChangedAfterLanding` above: the
  // in-product record declines the read ([D9] would otherwise force a layout
  // per tick on a compositor-only settle), so this field is the bench
  // probe's and the row reads it empty.
  const cutPaneIds = new Set<string>();
  {
    const firstOrigin = new Map<string, readonly [number, number]>();
    const lastOrigin = new Map<string, readonly [number, number]>();
    const everAnimated = new Set<string>();
    for (const sample of samples) {
      for (const frame of sample.frames) {
        if (frame.hasTransformEffect) everAnimated.add(frame.paneId);
        if (frame.rect === null) continue;
        const origin = [frame.rect.x, frame.rect.y] as const;
        if (!firstOrigin.has(frame.paneId)) {
          firstOrigin.set(frame.paneId, origin);
        }
        lastOrigin.set(frame.paneId, origin);
      }
    }
    for (const [paneId, first] of firstOrigin) {
      if (everAnimated.has(paneId)) continue;
      const last = lastOrigin.get(paneId);
      if (last === undefined) continue;
      if (
        Math.abs(last[0] - first[0]) > OFF_CURVE_TOLERANCE_PX ||
        Math.abs(last[1] - first[1]) > OFF_CURVE_TOLERANCE_PX
      ) {
        cutPaneIds.add(paneId);
      }
    }
  }

  return {
    ticks: samples.length,
    framePeriodMs,
    longestGapMs,
    longestGapFrames: longestGapMs / framePeriodMs,
    gapsOverOneFrame,
    firstPaintDelayMs: samples[0].t - originAt,
    commitDelayMs,
    moveFirstPaintDelayMs:
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
    strandedTicks,
    strandedPaneIds: [...strandedPaneIds],
    cutPaneIds: [...cutPaneIds],
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
    suspended: cadence.suspended,
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
 *
 * **The rect read is off by default for the same reason, with a measurement
 * behind it.** Timed on a release deck of 19.6k elements and ten panes during
 * a session fold (`briefs/session-fold-frames-readings.md`), each of this
 * tick's three reads — the rect, the frame's own effects, the computed style
 * — costs the same 4–5 ms when it goes FIRST and nothing when it goes second
 * or third: the price is the style flush the first read forces, not any one
 * read's own work, and the subtree walk in {@link ownEffectsOf} is not the
 * expensive call this module's older comments assumed. The rect is the one
 * read that also forces LAYOUT, and the row it feeds nothing on the product
 * path, so it is the one that goes.
 */
export function sampleSettleFrame(
  root: ParentNode,
  options?: {
    readonly countFixedDescendants?: boolean;
    /** Read each frame's border box — a forced layout the row has no field for. */
    readonly readRects?: boolean;
  },
): SettleFrameSample {
  const countFixed = options?.countFixedDescendants === true;
  const readRects = options?.readRects === true;
  const frames: SettleFramePaneSample[] = [];
  let moveCurrentTime: number | null = null;
  let movePending = false;
  let fixedDescendants = 0;
  for (const frame of root.querySelectorAll<HTMLElement>(SHOWN_PANE_FRAMES)) {
    const paneId = frame.getAttribute("data-pane-id");
    if (paneId === null) continue;
    const rect = readRects ? frame.getBoundingClientRect() : null;
    const effects = ownEffectsOf(frame);
    if (movePendingOf(effects)) movePending = true;
    if (moveCurrentTime === null) {
      moveCurrentTime = moveCurrentTimeOf(effects);
    }
    // One computed-style declaration per frame, read twice. Whichever read
    // goes first in this tick pays the pending style flush and the rest are
    // free (measured — see the docblock), so asking for the same element's
    // declaration a second time to read `transform` beside `opacity` would
    // still be a second lookup for nothing.
    const computed = getComputedStyle(frame);
    frames.push({
      paneId,
      rect:
        rect === null
          ? null
          : { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
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
  /**
   * When {@link SettleFrameProbe.arm} started the pump, on the ticks' clock.
   *
   * The bench probe is armed by the harness and has no gesture stamp to read,
   * so its arm is the only origin it can offer — and it is an honest one: the
   * window it records opens there. It gets `commitDelayMs: 0` for the same
   * reason.
   */
  private armedAt: number | null = null;

  get armed(): boolean {
    return this.handle !== null;
  }

  arm(root?: ParentNode): void {
    if (this.handle !== null) return;
    this.root = root ?? document;
    this.samples = [];
    this.armedAt = performance.now();
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
      // in-product record does not ask for it — nor for the rects, which feed
      // `rectsChangedAfterLanding` and are a forced layout per tick.
      this.samples.push(
        sampleSettleFrame(scope, {
          countFixedDescendants: true,
          readRects: true,
        }),
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
    this.armedAt = null;
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
    return classifySettleFrames(this.samples, this.armedAt ?? undefined);
  }

  /** Hand back the raw samples — for a caller that wants the run, not the verdict. */
  takeSamples(): SettleFrameSample[] {
    return this.samples;
  }
}

export const settleFrameProbe = new SettleFrameProbe();
