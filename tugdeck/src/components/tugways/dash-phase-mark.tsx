/**
 * DashPhaseMark — where a dash is, as one glyph.
 *
 * Five glyphs for the five phases the track draws — brief · devise · review ·
 * implement · join — and a sixth for a stop, which outranks all of them.
 *
 * It is keyed on the **lifecycle phase**, not on the git stage. An earlier
 * mark of this kind read `stage`, and a dash has no stage until `dash create`
 * cuts a branch — so the glyph was blank for exactly the half of a dash's life
 * that happens in documents, which is the half a reader most needs a word for.
 * The phase comes off {@link DashTrackModel}, which is derived from what the
 * feed already carries, so the mark and the track beside it cannot disagree.
 *
 * The word is not lost: it rides the tooltip and the `aria-label`.
 *
 * Laws: [L06] phase and stop are `data-*` the CSS paints; [L19] `.tsx`/`.css`
 * pair, `data-slot`; [L20] composes `TugTooltip`.
 *
 * @module components/tugways/dash-phase-mark
 */

import "./dash-phase-mark.css";

import React from "react";
import {
  Compass,
  FileText,
  GitMerge,
  Hammer,
  OctagonX,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";

import { TugTooltip } from "./tug-tooltip";
import type { DashPhase, DashTrackModel } from "./tug-dash-track";

/** One glyph per phase, in lifecycle order. */
export const DASH_PHASE_ICONS: Record<DashPhase, LucideIcon> = {
  brief: FileText,
  devise: Compass,
  review: ShieldCheck,
  implement: Hammer,
  join: GitMerge,
};

/** The sentence the mark carries — the phase, or why the arc stopped. */
export function dashPhaseWord(model: DashTrackModel): string {
  return model.stopped !== null ? `stopped · ${model.stopped}` : model.phase;
}

export interface DashPhaseMarkProps {
  model: DashTrackModel;
  /** The glyph's box, in px. */
  size?: number;
  /** Suppress the hover sentence where the host already carries one. */
  tooltip?: boolean;
}

export function DashPhaseMark({
  model,
  size = 12,
  tooltip = true,
}: DashPhaseMarkProps): React.ReactElement {
  const stopped = model.stopped !== null;
  const Glyph: LucideIcon = stopped ? OctagonX : DASH_PHASE_ICONS[model.phase];
  const word = dashPhaseWord(model);
  const mark = (
    <span
      className="tug-dash-phase-mark"
      data-slot="tug-dash-phase-mark"
      data-phase={model.phase}
      data-stopped={stopped ? "true" : undefined}
      aria-label={word}
    >
      <Glyph size={size} />
    </span>
  );
  return tooltip ? <TugTooltip content={word}>{mark}</TugTooltip> : mark;
}
