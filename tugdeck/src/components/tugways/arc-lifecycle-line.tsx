/**
 * ArcLifecycleLine — what an arc is DOING, as one line with no clock on it.
 *
 *   track · glyph · fraction · note · facts
 *
 * The track is {@link TugArcTrack}, the arc's whole life in a cap-height
 * strip; the glyph is {@link ArcPhaseMark}, which says outright the phase the
 * strip says by WHICH cell is lit; the fraction is the step in progress over
 * the plan's count, and only while one is; the note is the phase in one word —
 * `brief`, `devise`, `review`, `implement`, `audit`, `join` — and
 * `stopped · <why>` when the arc stopped; the facts are the tone-colored words `arcMetaFacts`
 * derives, most urgent first, each with its detail on hover — the ones about
 * the arc's own standing (conflicts, overlap, fit), never the checkout's git
 * bookkeeping. The two arc facts are dropped too: the track already says the
 * arc is running, and the note already says it stopped. So is the kind: the
 * track draws a planned arc's devise and review cells and a plain arc's
 * neither, which is the kind said in the strip's own register, and a word
 * for it after the note was a stray adjective on whatever the note said
 * (`stopped · audit did not mark planned`).
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
 * **The whole run is CENTRED — track, then reading, as one unit.** The line
 * used to pack everything against its left edge, which was the right shape
 * when the note carried a step's title and ran most of the width; it does not
 * any more, and a left-packed line left a long empty tail under an eyebrow
 * whose own two identities are anchored to the two edges. Centring the track
 * alone and setting the reading flush right pinned the graphic, but read as
 * two things obeying two different rules. So the graphic and the words travel
 * together, and the track shifts along the row as the reading's width changes.
 *
 * One grammar, two scales — `rail` beside other rails, `read` on a surface
 * whose job is to be read.
 *
 * Laws: [L06] tones and scale are `data-*` the CSS paints; [L19]
 * `.tsx`/`.css` pair, `data-slot`; [L20] composes the track, the fraction, and
 * the tooltip.
 *
 * @module components/tugways/arc-lifecycle-line
 */

import "./arc-lifecycle-line.css";

import React from "react";

import type { ArcMetaFact } from "@/lib/arc-meta-facts";
import { ArcPhaseMark } from "./arc-phase-mark";
import { TugArcTrack, type ArcTrackModel } from "./tug-arc-track";
import { TugStepFraction } from "./tug-step-fraction";
import { TugTooltip } from "./tug-tooltip";

/** The note under the model — the phase in a word, or why the arc stopped. Pure. */
export function arcLifecycleNote(model: ArcTrackModel): string {
  if (model.stopped !== null) return `stopped · ${model.stopped}`;
  return model.phase;
}

/**
 * The facts the line drops.
 *
 * The arc's two are already the track's own subject — the strip draws the
 * stage and the note says when it stopped. The git bookkeeping — a dirty
 * worktree, a base that has moved, a replay that settled — is the checkout's
 * condition rather than the arc's state. It reaches the eye where a gesture
 * turns on it instead: the picker's `uncommitted`, the Replay item's label,
 * the discard confirmation, and the replay bulletin.
 *
 * The kind is the track's cell set, and its sentence is the Devise cell's
 * hover — a planned arc has that cell and a plain one does not.
 */
const NOT_ON_THE_LINE: ReadonlySet<string> = new Set([
  "arc",
  "arc-stopped",
  "kind",
  "uncommitted",
  "behind",
  "replayed",
]);

export function arcLifecycleFacts(facts: readonly ArcMetaFact[]): ArcMetaFact[] {
  return facts.filter((fact) => !NOT_ON_THE_LINE.has(fact.key));
}

export interface ArcLifecycleLineProps {
  model: ArcTrackModel;
  note: string;
  /**
   * The step in hand, when the host holds one — the fraction's hover sentence,
   * never a run of its own ([D168]).
   */
  stepTitle?: string | null;
  facts?: readonly ArcMetaFact[];
  size?: "rail" | "read";
}

export function ArcLifecycleLine({
  model,
  note,
  stepTitle = null,
  facts = [],
  size = "rail",
}: ArcLifecycleLineProps): React.ReactElement {
  const steps = model.steps;
  return (
    <span
      className="tug-arc-lifecycle-line"
      data-slot="tug-arc-lifecycle-line"
      data-size={size}
      data-stopped={model.stopped !== null ? "true" : undefined}
    >
      <TugArcTrack model={model} size={size} />
      <span className="tug-arc-lifecycle-reading" data-slot="tug-arc-lifecycle-reading">
        {/* One pixel proud of the cap band the track occupies (9px at read, 7 at
          rail), so the glyph reads as the strip's neighbour rather than as a
          taller mark set beside it. */}
        <ArcPhaseMark model={model} size={size === "read" ? 11 : 9} />
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
          <span className="tug-arc-lifecycle-note" data-slot="tug-arc-lifecycle-note">
            {note}
          </span>
        </TugTooltip>
        {arcLifecycleFacts(facts).map((fact) => (
          <TugTooltip key={fact.key} content={fact.tooltip}>
            <span
              className="tug-arc-lifecycle-fact"
              data-slot="tug-arc-lifecycle-fact"
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
