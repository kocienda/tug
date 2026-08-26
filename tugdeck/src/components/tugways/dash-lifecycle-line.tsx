/**
 * DashLifecycleLine — what a dash is DOING, as one line with no clock on it.
 *
 *   track · fraction · note · facts
 *
 * The track is {@link TugDashTrack}, the dash's whole life in a cap-height
 * strip; the fraction is the step in progress over the plan's count, and only
 * while one is; the note is the current step's title, else the draft's
 * subject, else what the phase is doing; the facts are the tone-colored words
 * `dashMetaFacts` already derives, most urgent first, each with its detail on
 * hover. There is no age: the ring, the track, and the phase dot say whether
 * anything is moving, and a `2m` beside them was a fact nobody acted on.
 *
 * One grammar, two scales — `rail` beside other rails, `read` on a surface
 * whose job is to be read — the same split `DashMetaLine` drew.
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

/** The note under the model: the phase's own word when the surface has none. */
export function dashLifecycleNote(model: DashTrackModel, stepTitle: string | null, draftSubject: string | null): string {
  if (model.stopped !== null) return `arc stopped · ${model.phase} — ${model.stopped}`;
  if (model.phase === "implement" && stepTitle !== null) return stepTitle;
  if (model.phase === "join" && draftSubject !== null) return draftSubject;
  switch (model.phase) {
    case "brief":
      return "brief written";
    case "devise":
      return "devising the plan";
    case "review":
      return "reviewing the plan";
    case "implement":
      return model.poke ? (draftSubject ?? "working") : "implementing";
    case "join":
      return "ready to join";
  }
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
      <span className="tug-dash-lifecycle-note" data-slot="tug-dash-lifecycle-note">
        {note}
      </span>
      {facts.map((fact) => (
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
