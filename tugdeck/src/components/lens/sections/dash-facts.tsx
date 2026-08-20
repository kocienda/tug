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

/**
 * The name, the stage, the step, its title, and the review mark, in order.
 *
 * Every fact enters the DOM and nothing about its presentation is decided
 * here. Each fact is its own span; the container carries the same facts in
 * machine-readable form — `data-stage`, `data-step-current`,
 * `data-step-total`, `data-review`, `data-step-missing`, and the unitless
 * custom properties `--dash-step-current` / `--dash-step-total` — so
 * `dash-facts.css` can size, order, word, hide, or measure any of them
 * without a code change ([L06]). The counters' numerals stay TS-rendered text
 * so they are selectable, searchable, and visible to assistive tech; only the
 * wording *around* facts (`step `, `no step declared`) is CSS `content`.
 *
 * A fact with no value renders no span. The one exception is the missing-step
 * fact: a dash driving a plan with no declared step is the state this line
 * exists to catch, and saying nothing is how it went unnoticed before.
 */
export function DashFactsRun({
  name,
  stage,
  stepCurrent,
  stepTotal,
  stepTitle,
  hasPlan,
  review,
  markSize,
  trailing,
}: {
  /** The dash's name, or null where the surface already names it — the Cards
   *  sub-row rides under a title whose identity run carries `#<dash>`, and the
   *  same name twice within one row's height says nothing new. */
  name: string | null;
  stage: string | null;
  /** The step being worked, or null when the sender declared no counters. */
  stepCurrent: number | null;
  /** How many steps the plan holds, or null when none was declared. */
  stepTotal: number | null;
  /** What the current step *is* — the declaration's title, or null. */
  stepTitle: string | null;
  /** Whether the dash drives a plan — what makes a missing step worth saying. */
  hasPlan: boolean;
  review: string | null;
  markSize: number;
  /** What the surface adds after the shared run — the roster's project label. */
  trailing?: React.ReactNode;
}): React.ReactElement {
  const counted = stepCurrent !== null && stepTotal !== null;
  const stepMissing = hasPlan && stepCurrent === null;
  return (
    <span
      className="lens-dashes-facts"
      data-slot="lens-dashes-facts"
      {...(stage !== null ? { "data-stage": stage } : {})}
      {...(stepCurrent !== null
        ? { "data-step-current": String(stepCurrent) }
        : {})}
      {...(stepTotal !== null ? { "data-step-total": String(stepTotal) } : {})}
      {...(review !== null ? { "data-review": review } : {})}
      {...(stepMissing ? { "data-step-missing": "true" } : {})}
      style={
        {
          ...(stepCurrent !== null ? { "--dash-step-current": stepCurrent } : {}),
          ...(stepTotal !== null ? { "--dash-step-total": stepTotal } : {}),
        } as React.CSSProperties
      }
    >
      {name !== null ? <span className="lens-dashes-name">{name}</span> : null}
      {stage !== null ? (
        <span className="lens-dashes-stage">{stage}</span>
      ) : null}
      {counted ? (
        <span
          className="lens-dashes-step"
          aria-label={`step ${stepCurrent} of ${stepTotal}`}
        >
          {stepCurrent}/{stepTotal}
        </span>
      ) : null}
      {stepMissing ? (
        <span
          className="lens-dashes-step-missing"
          role="note"
          aria-label="no step declared"
        />
      ) : null}
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
