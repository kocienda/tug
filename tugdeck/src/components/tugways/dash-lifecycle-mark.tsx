/**
 * DashLifecycleMark — a dash's life at a glance: pill · glyph · fraction.
 *
 * The compact register of the lifecycle grammar, for the two surfaces where a
 * dash is not the subject — the session masthead's title line and the Lens's
 * session rows. There a session is the subject and the dash is one fact about
 * it, so the reading is three marks wide and cannot grow:
 *
 *   - one pill — the whole dash as a single stop of color, breathing while the
 *     work is live;
 *   - the {@link DashPhaseMark} — WHERE the dash is, as a glyph;
 *   - the step fraction, when the plan has steps to count.
 *
 * The order is the full register's, one scale down: the graphic that stands for
 * the whole life first, then the glyph naming the phase, then the count. The
 * pill is the mark's tie to the identity run it follows, so it is the mark that
 * touches it.
 *
 * The dash's NAME is not here. Both hosts already render it: the identity run's
 * own `^<dash>` sits immediately to the left, and a second spelling of a name
 * already on the line is a second thing to keep in step.
 *
 * The whole track — five cells and one tick per step — belongs to the surfaces
 * whose subject IS the dash: the Lens's Dashes section, the Changes shade's
 * dash lane, and the DASH placard. The track appeared on six surfaces at once
 * and on the two narrow ones it collided with the marks beside it; this is the
 * reading those two get instead. One grammar, two registers.
 *
 * Laws: [L06] phase and state are `data-*` the CSS paints; [L19] `.tsx`/`.css`
 * pair, `data-slot`; [L20] composes `DashPhaseMark`, `TugStepFraction`, and
 * `TugTooltip`.
 *
 * @module components/tugways/dash-lifecycle-mark
 */

import "./dash-lifecycle-mark.css";

import React from "react";

import { DashPhaseMark, dashPhaseWord } from "./dash-phase-mark";
import { TugStepFraction } from "./tug-step-fraction";
import { TugTooltip } from "./tug-tooltip";
import { dashCellState, type DashTrackModel } from "./tug-dash-track";

/**
 * The fraction the mark shows, or null when the plan has no steps.
 *
 * The step in progress while one is; otherwise how much of the plan is closed
 * — so a walked plan reads `10/10` rather than going blank at the moment the
 * reader most wants the number. Pure.
 */
export function dashMarkFraction(
  model: DashTrackModel,
): { current: number; total: number } | null {
  const steps = model.steps;
  if (steps === null) return null;
  return { current: steps.current ?? steps.done, total: steps.total };
}

export interface DashLifecycleMarkProps {
  model: DashTrackModel;
  /** `rail` beside other rails (the Lens's rows); `read` on a reading surface. */
  size?: "rail" | "read";
  /** The dash's name, for the accessible sentence. */
  name?: string;
  /**
   * The pair the six characters count, when the host has one of its own.
   *
   * The masthead counts the declared RUN — the selection somebody asked for —
   * which is a different number from the plan's own pair whenever a run is a
   * slice of a plan. Omitted, the mark counts the plan, which is what the pill
   * and the glyph beside it describe.
   */
  fraction?: { current: number; total: number } | null;
}

export function DashLifecycleMark({
  model,
  size = "rail",
  name,
  fraction: fractionOverride,
}: DashLifecycleMarkProps): React.ReactElement {
  const state = dashCellState(model, model.phase);
  const fraction =
    fractionOverride !== undefined ? fractionOverride : dashMarkFraction(model);
  const word = dashPhaseWord(model);
  const sentence =
    (name !== undefined ? `dash ${name} — ` : "") +
    word +
    (fraction !== null ? ` · step ${fraction.current} of ${fraction.total}` : "");
  return (
    // ONE tooltip, over the whole reading. The glyph is the part a reader is
    // most likely to point at and the least likely to decode unaided, so a
    // tooltip that covered only the pill left the one mark that needed a word
    // silent. Wrapping all three also keeps a single Radix slot: two nested
    // `asChild` tooltips is a thing this codebase has been bitten by.
    <TugTooltip content={sentence}>
      <span
        className="tug-dash-lifecycle-mark"
        data-slot="tug-dash-lifecycle-mark"
        data-size={size}
        data-phase={model.phase}
        data-stopped={model.stopped !== null ? "true" : undefined}
        aria-label={sentence}
      >
        <span
          className="tug-dash-lifecycle-mark-pill"
          data-slot="tug-dash-lifecycle-mark-pill"
          data-phase={model.phase}
          data-state={state}
        />
        {/* One pixel proud of the pill's own band, the same relation the
            full register's glyph keeps to the track. */}
        <DashPhaseMark model={model} size={size === "read" ? 11 : 9} tooltip={false} />
        {fraction !== null ? (
          <TugStepFraction current={fraction.current} total={fraction.total} />
        ) : null}
      </span>
    </TugTooltip>
  );
}
