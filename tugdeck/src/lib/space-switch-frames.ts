/**
 * The frame record for one workspace switch — "how did the 600 ms after the
 * swap actually paint?"
 *
 * `space-switch-timing` already says how long the synchronous switch took, and
 * it cannot see the part that matters most: `activateSpace` returns, the click
 * task keeps running through React's render and every arriving layout effect,
 * and no frame is served until that task ends. A `totalMs` of 6 ms sits happily
 * beside a screen frozen for 300 ms. This record is the other side of that
 * span — one `DOMHighResTimeStamp` per rAF tick from the swap commit onward,
 * classified into how late the first frame was and how rough the frames after
 * it were.
 *
 * It is a BENCH READING, opt-in on the same criterion the other two switch
 * records use: a measurement under study rather than evidence of a defect. A
 * developer enables it with `__deckTrace.enable(true)`. The sampler reads
 * NOTHING off the DOM — a probe whose own cost lands inside the window it
 * measures is measuring itself.
 *
 * The cadence arithmetic is not here. `classifyFrameCadence` in
 * `settle-frame-probe.ts` is the one definition of "what is the display's
 * period, and which gaps were longer than one of its frames", and a settle
 * reading and a switch reading are only comparable because they both ask it.
 *
 * @module lib/space-switch-frames
 */

import {
  classifyFrameCadence,
  FALLBACK_FRAME_PERIOD_MS,
  SUSPENSION_FLOOR_TICKS,
} from "@/lib/settle-frame-probe";

/**
 * How long after the swap commit the sampler keeps ticking.
 *
 * 600 ms is the span the rough patch lives in on the user's own deck — the
 * freeze, the first painted frame, and the compositing rebuild that follows it
 * are all inside it — and it is the span the arc's acceptance reading is taken
 * over. A longer window would mostly record an idle deck.
 */
export const SPACE_SWITCH_FRAME_WINDOW_MS = 600;

/**
 * The gap over which a frame counts as dropped for the acceptance criterion.
 *
 * Not derived from the display's period, unlike `gapsOverOneFrame`: this is the
 * bar the arc committed to in absolute terms ("no frame gap over 20 ms in the
 * 600 ms after arrival"), so it stays a constant. The two counts answer
 * different questions and both are reported — `gapsOverOneFrame` is "was this
 * rough for THIS display", `gapsOverBudget` is "was this rough enough for a
 * reader to see".
 */
export const SWITCH_GAP_BUDGET_MS = 20;

/** The reading one switch's tick series classifies to — Spec S01's fields. */
export interface SpaceSwitchFrameReading {
  /** The workspace arrived at, the key every switch record correlates on. */
  readonly toSpaceId: string;
  readonly ticks: number;
  readonly framePeriodMs: number;
  /**
   * The GESTURE to the FIRST rAF tick.
   *
   * This is the number that contains the freeze. A rAF callback cannot run
   * until the click task that queued it ends, so the distance from the commit
   * to the first tick is the whole of the render, the commit and every arriving
   * layout effect — the span `space-switch-timing`'s `paintMs - totalMs`
   * excludes by construction, because it begins where the synchronous span
   * ends.
   *
   * **Measured from the gesture, and the difference is not small.** As first
   * written the origin was the swap commit — the canvas's layout effect on the
   * commit that moved the shown attribute — on the reading that the commit was
   * inside the click task and so nothing could have painted before it. Both
   * halves are true, and the number was still wrong by about 75 ms on a
   * three-workspace deck: React's whole render phase runs between the store's
   * notify and that commit, so the origin sat most of the way through the
   * freeze it was meant to contain. The origin is now the store's own stamp,
   * taken as `activateSpace` is entered, and {@link commitDelayMs} says how
   * far behind it the commit landed. A caller with no stamp passes the armed
   * timestamp and gets the old reading, with `commitDelayMs` at zero.
   *
   * **This is not `SettleFrameReading.firstPaintDelayMs`**, which measures a
   * move animation's birth to the first tick whose `currentTime` had advanced.
   * Same name, same module family, different origin, and the two are never
   * comparable. The one-definition discipline that put the cadence arithmetic
   * in one place is undone as surely by a coincidence of naming as by a second
   * classifier, so the difference is written here rather than left to be
   * discovered.
   *
   * `-1` when no tick ever arrived.
   */
  readonly firstPaintDelayMs: number;
  /**
   * The gesture to the swap commit — React's render phase of the switch, and
   * the part of {@link firstPaintDelayMs} the sampler's own arming could not
   * see. Zero when the classifier was given no gesture timestamp.
   */
  readonly commitDelayMs: number;
  /** Voided to `-1` when {@link SpaceSwitchFrameReading.suspended}. */
  readonly longestGapMs: number;
  /** Voided to `-1` when {@link SpaceSwitchFrameReading.suspended}. */
  readonly gapsOverOneFrame: number;
  /**
   * Gaps over {@link SWITCH_GAP_BUDGET_MS}. Voided to `-1` when
   * {@link SpaceSwitchFrameReading.suspended}.
   */
  readonly gapsOverBudget: number;
  /** The gap series, so a reader sees the shape and not only its summary. */
  readonly gaps: readonly number[];
  /**
   * Tick count below `SUSPENSION_FLOOR_TICKS`; the summary is void.
   *
   * An occluded window suspends `requestAnimationFrame` outright, and a
   * suspended run reports a handful of ticks and no gaps at all — which reads
   * as a perfect switch if the counts are left at zero. They are voided to `-1`
   * instead, so a reading taken under occlusion cannot be mistaken for a pass.
   */
  readonly suspended: boolean;
}

/**
 * Classify one switch's tick series.
 *
 * `armedAt` is the swap-commit timestamp the sampler was armed with, on the
 * same `performance.now()` clock as the ticks. `ticks` are in arrival order.
 * `gestureAt` is the store's stamp for when the switch was asked for, on the
 * same clock; it is the origin of `firstPaintDelayMs`, and it defaults to
 * `armedAt` for a caller that has none.
 */
export function classifySpaceSwitchFrames(
  toSpaceId: string,
  armedAt: number,
  ticks: readonly number[],
  gestureAt: number = armedAt,
): SpaceSwitchFrameReading {
  const cadence = classifyFrameCadence(ticks);
  const firstPaintDelayMs = ticks.length === 0 ? -1 : ticks[0] - gestureAt;
  const commitDelayMs = armedAt - gestureAt;

  if (cadence.suspended) {
    return {
      toSpaceId,
      ticks: ticks.length,
      framePeriodMs: FALLBACK_FRAME_PERIOD_MS,
      firstPaintDelayMs,
      commitDelayMs,
      longestGapMs: -1,
      gapsOverOneFrame: -1,
      gapsOverBudget: -1,
      gaps: cadence.gaps,
      suspended: true,
    };
  }

  let gapsOverBudget = 0;
  for (const gap of cadence.gaps) {
    if (gap > SWITCH_GAP_BUDGET_MS) gapsOverBudget += 1;
  }

  return {
    toSpaceId,
    ticks: ticks.length,
    framePeriodMs: cadence.framePeriodMs,
    firstPaintDelayMs,
    commitDelayMs,
    longestGapMs: cadence.longestGapMs,
    gapsOverOneFrame: cadence.gapsOverOneFrame,
    gapsOverBudget,
    gaps: cadence.gaps,
    suspended: false,
  };
}

/** Re-exported so a reader of this module need not chase the floor. */
export { SUSPENSION_FLOOR_TICKS };
