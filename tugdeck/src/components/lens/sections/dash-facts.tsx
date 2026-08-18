/**
 * dash-facts.tsx — a dash's facts as one row run, and the review mark inside it.
 *
 * The run's consumer is the dash line nested under the session working it in
 * the Cards section — what this session is doing, said in dash grammar. The
 * Unbound Dashes section used to render the identical run, which is what made
 * the two surfaces a duplication rather than a division of labour; it now
 * composes its own row from these pieces, because an unbound dash's row answers a
 * different question and has a different shape.
 *
 * `DashReviewMark` stays shared: the review advisory means the same thing
 * wherever it paints, and two spellings of it is how that drifts.
 */

import "./dash-facts.css";

import React from "react";
import { FileClock, FileQuestion } from "lucide-react";

import { TugTooltip } from "@/components/tugways/tug-tooltip";
import { dashReviewPaints, dashReviewTooltip } from "@/lib/dash-review";

/**
 * The advisory mark a dash's plan review wears.
 *
 * Absent unless there is something to say — only `stale` and `never-reviewed`
 * paint at all. A Lens row spans projects on one line, so the tooltip names the
 * state and not the plan's path; the path is the Changes shade's to show.
 */
export function DashReviewMark({
  review,
  size,
}: {
  review: string;
  /** The glyph's box, in px — each surface sizes it off its own row's mark. */
  size: number;
}): React.ReactElement {
  const Glyph = review === "stale" ? FileClock : FileQuestion;
  return (
    <TugTooltip content={dashReviewTooltip(review, null)}>
      <span
        className="lens-dashes-review"
        data-slot="lens-dashes-review"
        data-review={review}
        aria-label={dashReviewTooltip(review, null)}
      >
        <Glyph size={size} />
      </span>
    </TugTooltip>
  );
}

/** The name, the stage, the step, its title, and the review mark, in order. */
export function DashFactsRun({
  name,
  stage,
  steps,
  stepTitle,
  review,
  markSize,
  trailing,
}: {
  /** The dash's name, or null where the surface already names it — the Cards
   *  sub-row rides under a title whose identity run carries `#<dash>`, and the
   *  same name twice within one row's height says nothing new. */
  name: string | null;
  stage: string | null;
  /** `step i/N`, preformatted, or null when the sender declared no counters. */
  steps: string | null;
  /** What the current step *is* — the declaration's title, or null. */
  stepTitle: string | null;
  review: string | null;
  markSize: number;
  /** What the surface adds after the shared run — the roster's project label. */
  trailing?: React.ReactNode;
}): React.ReactElement {
  return (
    <span className="lens-dashes-facts">
      {name !== null ? <span className="lens-dashes-name">{name}</span> : null}
      {stage !== null ? (
        <span className="lens-dashes-stage">{stage}</span>
      ) : null}
      {steps !== null ? <span className="lens-dashes-step">{steps}</span> : null}
      {stepTitle !== null ? (
        <span className="lens-dashes-step-title">{stepTitle}</span>
      ) : null}
      {dashReviewPaints(review) ? (
        <DashReviewMark review={review!} size={markSize} />
      ) : null}
      {trailing}
    </span>
  );
}
