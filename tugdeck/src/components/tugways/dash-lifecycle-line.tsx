/**
 * DashLifecycleLine — what a dash is DOING, as one line with no clock on it.
 *
 *   track · fraction · note · facts
 *
 * The track is {@link TugDashTrack}, the dash's whole life in a cap-height
 * strip; the fraction is the step in progress over the plan's count, and only
 * while one is; the note is one word for a phase that has nothing more to say
 * — `brief`, `devise`, `review`, `join` — the step's title during implement,
 * and `stopped · <why>` when the arc stopped; the facts are the tone-colored
 * words `dashMetaFacts` derives, most urgent first, each with its detail on
 * hover. The two arc facts are dropped here: the track already says the arc
 * is running, and the note already says it stopped.
 *
 * There is no age: the ring, the track, and the phase dot say whether
 * anything is moving. And the line never leaves its box: the note elides
 * first, and what still does not fit is clipped rather than overflowing.
 *
 * One grammar, two scales — `rail` beside other rails, `read` on a surface
 * whose job is to be read.
 *
 * Laws: [L06] tones and scale are `data-*` the CSS paints; [L19]
 * `.tsx`/`.css` pair, `data-slot`; [L20] composes the track, the fraction, and
 * the tooltip.
 *
 * @module components/tugways/dash-lifecycle-line
 */

import "./dash-lifecycle-line.css";

import React from "react";

import type { DashMetaFact } from "./dash-meta-line";
import { TugDashTrack, type DashTrackModel } from "./tug-dash-track";
import { TugStepFraction } from "./tug-step-ring";
import { TugTooltip } from "./tug-tooltip";

/** The note under the model. Pure. */
export function dashLifecycleNote(model: DashTrackModel, stepTitle: string | null): string {
  if (model.stopped !== null) return `stopped · ${model.stopped}`;
  if (model.phase === "implement" && stepTitle !== null) return stepTitle;
  return model.phase;
}

/** The facts the track and the note have not already said. */
const SAID_BY_TRACK: ReadonlySet<string> = new Set(["arc", "arc-stopped"]);

export function dashLifecycleFacts(facts: readonly DashMetaFact[]): DashMetaFact[] {
  return facts.filter((fact) => !SAID_BY_TRACK.has(fact.key));
}

export interface DashLifecycleLineProps {
  model: DashTrackModel;
  note: string;
  facts?: readonly DashMetaFact[];
  size?: "rail" | "read";
}

export function DashLifecycleLine({
  model,
  note,
  facts = [],
  size = "rail",
}: DashLifecycleLineProps): React.ReactElement {
  const steps = model.steps;
  return (
    <span
      className="tug-dash-lifecycle-line"
      data-slot="tug-dash-lifecycle-line"
      data-size={size}
      data-stopped={model.stopped !== null ? "true" : undefined}
    >
      <TugDashTrack model={model} size={size} />
      {steps !== null && steps.current !== null ? (
        <TugStepFraction current={steps.current} total={steps.total} />
      ) : null}
      <span className="tug-dash-lifecycle-note" data-slot="tug-dash-lifecycle-note" title={note}>
        {note}
      </span>
      {dashLifecycleFacts(facts).map((fact) => (
        <TugTooltip key={fact.key} content={fact.tooltip}>
          <span
            className="tug-dash-lifecycle-fact"
            data-slot="tug-dash-lifecycle-fact"
            data-fact={fact.key}
            data-tone={fact.tone}
          >
            {fact.label}
          </span>
        </TugTooltip>
      ))}
    </span>
  );
}
