/**
 * DashStageMark — a dash's lifecycle stage as a glyph, its word on hover.
 *
 * `implementing` as a word spends ~90px of a title line the icon carries in
 * 13px, which is what makes room for the stage beside a name, a sigil, and a
 * step count inside a row that must not grow. The word is not lost: it rides
 * a tooltip, and the glyph carries it as its `aria-label`.
 *
 * One glyph per stage of the dash lifecycle, in lifecycle order. An
 * unrecognized stage from an older or newer sender falls back to the seed
 * glyph rather than throwing — the mark must never be able to break a row.
 *
 * Laws: [L06] the stage is a `data-*` the CSS can select on; [L19]
 * `.tsx`/`.css` pair, `data-slot`; [L20] composes `TugTooltip`.
 *
 * @module components/tugways/dash-stage-mark
 */

import "./dash-stage-mark.css";

import React from "react";
import {
  CircleCheck,
  FileCheck,
  GitMerge,
  Hammer,
  Package,
  ShieldCheck,
  Sprout,
  Wrench,
  type LucideIcon,
} from "lucide-react";

import { TugTooltip } from "./tug-tooltip";

/** The dash stages, each as a glyph, in lifecycle order. */
export const DASH_STAGE_ICONS: Record<string, LucideIcon> = {
  created: Sprout,
  working: Wrench,
  implementing: Hammer,
  ready: CircleCheck,
  built: Package,
  audited: ShieldCheck,
  "draft-ready": FileCheck,
  joining: GitMerge,
};

export function DashStageMark({
  stage,
  size = 13,
}: {
  /** The stage word from the changeset entry. */
  stage: string;
  /** The glyph's box, in px. */
  size?: number;
}): React.ReactElement {
  const Glyph = DASH_STAGE_ICONS[stage] ?? Sprout;
  return (
    <TugTooltip content={stage}>
      <span
        className="tug-dash-stage-mark"
        data-slot="tug-dash-stage-mark"
        data-stage={stage}
        aria-label={stage}
      >
        <Glyph size={size} />
      </span>
    </TugTooltip>
  );
}
