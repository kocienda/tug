/**
 * ArcPhaseMark — where an arc is, as one glyph.
 *
 * One glyph per phase the track draws — brief · devise · review · implement ·
 * audit · join — and one more for a stop, which outranks all of them.
 *
 * It is keyed on the **lifecycle phase**, not on the git stage. An earlier
 * mark of this kind read `stage`, and an arc has no stage until `arc create`
 * cuts a branch — so the glyph was blank for exactly the half of an arc's life
 * that happens in documents, which is the half a reader most needs a word for.
 * The phase comes off {@link ArcTrackModel}, which is derived from what the
 * feed already carries, so the mark and the track beside it cannot disagree.
 *
 * The word is not lost: it rides the tooltip and the `aria-label`.
 *
 * Laws: [L06] phase and stop are `data-*` the CSS paints; [L19] `.tsx`/`.css`
 * pair, `data-slot`; [L20] composes `TugTooltip`.
 *
 * @module components/tugways/arc-phase-mark
 */

import "./arc-phase-mark.css";

import React from "react";
import {
  Compass,
  FileText,
  FlaskConical,
  GitMerge,
  Hammer,
  OctagonX,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";

import { TugTooltip } from "./tug-tooltip";
import type { ArcPhase, ArcTrackModel } from "./tug-arc-track";

/** One glyph per phase, in lifecycle order. */
export const ARC_PHASE_ICONS: Record<ArcPhase, LucideIcon> = {
  brief: FileText,
  devise: Compass,
  review: ShieldCheck,
  implement: Hammer,
  audit: FlaskConical,
  join: GitMerge,
};

/** The sentence the mark carries — the phase, or why the arc stopped. */
export function arcPhaseWord(model: ArcTrackModel): string {
  return model.stopped !== null ? `stopped · ${model.stopped}` : model.phase;
}

export interface ArcPhaseMarkProps {
  model: ArcTrackModel;
  /** The glyph's box, in px. */
  size?: number;
  /** Suppress the hover sentence where the host already carries one. */
  tooltip?: boolean;
}

export function ArcPhaseMark({
  model,
  size = 12,
  tooltip = true,
}: ArcPhaseMarkProps): React.ReactElement {
  const stopped = model.stopped !== null;
  const Glyph: LucideIcon = stopped ? OctagonX : ARC_PHASE_ICONS[model.phase];
  const word = arcPhaseWord(model);
  const mark = (
    <span
      className="tug-arc-phase-mark"
      data-slot="tug-arc-phase-mark"
      data-phase={model.phase}
      data-stopped={stopped ? "true" : undefined}
      aria-label={word}
    >
      <Glyph size={size} />
    </span>
  );
  return tooltip ? <TugTooltip content={word}>{mark}</TugTooltip> : mark;
}
