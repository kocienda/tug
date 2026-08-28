/**
 * DashLifecycleLine — what a dash is DOING, as one line with no clock on it.
 *
 *   track · glyph · fraction · note · facts
 *
 * The track is {@link TugDashTrack}, the dash's whole life in a cap-height
 * strip; the glyph is {@link DashPhaseMark}, which says outright the phase the
 * strip says by WHICH cell is lit; the fraction is the step in progress over
 * the plan's count, and only while one is; the note is the phase in one word —
 * `brief`, `devise`, `review`, `implement`, `join` — and `stopped · <why>`
 * when the arc stopped; the facts are the tone-colored words `dashMetaFacts`
 * derives, most urgent first, each with its detail on hover — the ones about
 * the dash's own standing (conflicts, overlap, fit), never the checkout's git
 * bookkeeping. The two arc facts are dropped too: the track already says the
 * arc is running, and the note already says it stopped.
 *
 * **The step's TITLE is not a run on this line.** It rode the note during
 * implement, where it was a sentence in a slot sized for a word: on every host
 * but the placard it elided mid-word, and on the placard it restated the row
 * the list below already lights. It is the fraction's hover sentence instead —
 * the mark that counts the steps is the mark that names the one in hand.
 *
 * There is no age: the ring, the track, and the phase dot say whether
 * anything is moving. And the line never leaves its box: the note elides
 * first, and what still does not fit is clipped rather than overflowing.
 *
 * **The track is CENTRED and the reading is flush right.** The line used to
 * pack everything against its left edge, which was the right shape when the
 * note carried a step's title and ran most of the width. It does not any more,
 * so a left-packed line left a long empty tail under an eyebrow whose own two
 * identities are anchored to the two edges. Three columns instead: the graphic
 * in the middle of the row, and the glyph, fraction, word and facts gathered
 * at the end, under the worker atom above them.
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

import type { DashMetaFact } from "@/lib/dash-meta-facts";
import { DashPhaseMark } from "./dash-phase-mark";
import { TugDashTrack, type DashTrackModel } from "./tug-dash-track";
import { TugStepFraction } from "./tug-step-fraction";
import { TugTooltip } from "./tug-tooltip";

/** The note under the model — the phase in a word, or why the arc stopped. Pure. */
export function dashLifecycleNote(model: DashTrackModel): string {
  if (model.stopped !== null) return `stopped · ${model.stopped}`;
  return model.phase;
}

/**
 * The facts the line drops.
 *
 * The arc's two are already the track's own subject — the strip draws the
 * stage and the note says when it stopped. The git bookkeeping — a dirty
 * worktree, a base that has moved, a replay that settled — is the checkout's
 * condition rather than the dash's state. It reaches the eye where a gesture
 * turns on it instead: the picker's `uncommitted`, the Replay item's label,
 * the discard confirmation, and the replay bulletin.
 */
const NOT_ON_THE_LINE: ReadonlySet<string> = new Set([
  "arc",
  "arc-stopped",
  "uncommitted",
  "behind",
  "replayed",
]);

export function dashLifecycleFacts(facts: readonly DashMetaFact[]): DashMetaFact[] {
  return facts.filter((fact) => !NOT_ON_THE_LINE.has(fact.key));
}

export interface DashLifecycleLineProps {
  model: DashTrackModel;
  note: string;
  /**
   * The step in hand, when the host holds one — the fraction's hover sentence,
   * never a run of its own ([D168]).
   */
  stepTitle?: string | null;
  facts?: readonly DashMetaFact[];
  size?: "rail" | "read";
}

export function DashLifecycleLine({
  model,
  note,
  stepTitle = null,
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
      <span className="tug-dash-lifecycle-reading" data-slot="tug-dash-lifecycle-reading">
        {/* One pixel proud of the cap band the track occupies (9px at read, 7 at
          rail), so the glyph reads as the strip's neighbour rather than as a
          taller mark set beside it. */}
        <DashPhaseMark model={model} size={size === "read" ? 11 : 9} />
        {steps !== null && steps.current !== null ? (
          stepTitle !== null && stepTitle.length > 0 ? (
            <TugTooltip content={`step ${steps.current} of ${steps.total} · ${stepTitle}`}>
              <TugStepFraction current={steps.current} total={steps.total} />
            </TugTooltip>
          ) : (
            <TugStepFraction current={steps.current} total={steps.total} />
          )
        ) : null}
        {/* A tooltip is never a second copy of the word under the cursor. The
          note elides first when the line runs out of room, so the bubble is
          for the reading the ellipsis took away — `truncated` measures the
          span at the open edge and stays shut when the whole note fits. */}
        <TugTooltip content={note} truncated>
          <span className="tug-dash-lifecycle-note" data-slot="tug-dash-lifecycle-note">
            {note}
          </span>
        </TugTooltip>
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
    </span>
  );
}
