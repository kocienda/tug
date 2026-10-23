/**
 * ArcLifecycleLine — what an arc is DOING, as one line with no clock on it.
 *
 *   track · glyph · <Doing> [i/N]
 *
 * The track is {@link TugArcTrack}, the arc's whole life in a cap-height
 * strip; the glyph is {@link ArcPhaseMark}, which says outright the phase the
 * strip says by WHICH cell is lit.
 *
 * **The line is one clause: what the arc is doing** ([B00]). The reading is
 * {@link arcReading}, derived once and nowhere else — a verb in progress
 * (`Executing`, `Awaiting review`), or `Stopped · <why>` — with the fraction
 * *after* the verb, where it reads as the verb's object ([B02]). The kind is
 * the strip's own cell set and the stop is its red cell, so neither is a word
 * after the note. What stands between the arc and its base — fit, overlap,
 * conflicts — is not on the line: Tug resolves those at join itself.
 *
 * **The step's TITLE is not a run on this line.** It rode the reading during
 * implement, where it was a sentence in a slot sized for a word: on every host
 * but the placard it elided mid-word, and on the placard it restated the row
 * the list below already lights. It is the fraction's hover sentence instead
 * — `Step 3 of 6 — <title>`, and `Step 3 of 6` where the host has no title.
 * The mark that counts the steps is the mark that names the one in hand.
 *
 * There is no age: the ring, the track, and the phase dot say whether
 * anything is moving. And the line never leaves its box: the reading elides
 * first, and what still does not fit is clipped rather than overflowing.
 *
 * **Two overrides, both for a host that knows something the model does not.**
 * `note` replaces the reading's word — a receipt's frozen `Finished · 3
 * stages`. `mark` replaces the phase glyph — a settled dot for an arc whose
 * join is armed and waiting on a person. Neither is a prop every host threads,
 * which is the point of an override: the model answers for everyone else.
 *
 * **The whole run is CENTRED — track, then reading, as one unit.** The line
 * used to pack everything against its left edge, which was the right shape
 * when the reading carried a step's title and ran most of the width; it does
 * not any more, and a left-packed line left a long empty tail under an eyebrow
 * whose own two identities are anchored to the two edges. Centring the track
 * alone and setting the reading flush right pinned the graphic, but read as
 * two things obeying two different rules. So the graphic and the words travel
 * together, and the track shifts along the row as the reading's width changes.
 *
 * Laws: [L06] tones and scale are `data-*` the CSS paints; [L19]
 * `.tsx`/`.css` pair, `data-slot`; [L20] composes the track, the fraction, and
 * the tooltip.
 *
 * @module components/tugways/arc-lifecycle-line
 */

import "./arc-lifecycle-line.css";

import React from "react";
import { ArcPhaseMark } from "./arc-phase-mark";
import { arcReading, TugArcTrack, type ArcTrackModel } from "./tug-arc-track";
import { TugStepFraction } from "./tug-step-fraction";
import { TugTooltip } from "./tug-tooltip";

export interface ArcLifecycleLineProps {
  model: ArcTrackModel;
  /**
   * What the line says instead of {@link arcReading}'s word — the receipt
   * row's three outcomes and nothing else ([B08]).
   *
   * A receipt is a frozen record of a moment rather than a reading of the
   * arc now, so `Finished · 3 stages` and `Picked back up` are things only
   * that row can know. Every other host reads the model, which is why this is
   * an override rather than a prop each of them threads.
   */
  note?: string;
  /**
   * The step in hand, when the host holds one — the fraction's hover sentence,
   * never a run of its own ([D168]).
   */
  stepTitle?: string | null;
  /**
   * A mark of the host's own, standing where {@link ArcPhaseMark} stands —
   * the second override beside `note`, and for the same reason.
   *
   * The phase glyph says which phase the model is in. A host that has settled
   * something the model has no phase for — an arc whose join is armed and
   * waiting on a person rather than on work — knows a fact the model does not,
   * and an override is how it says so without every other caller having to
   * thread a prop it would always leave empty. Present, `ArcPhaseMark` is not
   * rendered: one mark stands at the head of the reading, never two.
   *
   * The line seats it on the track's cap band, as it seats the glyph. Its own
   * box — its size, its colour — is the caller's.
   */
  mark?: React.ReactNode;
}

export function ArcLifecycleLine({
  model,
  note,
  stepTitle = null,
  mark,
}: ArcLifecycleLineProps): React.ReactElement {
  const steps = model.steps;
  const reading = arcReading(model);
  const word = note ?? reading.word;
  return (
    <span
      className="tug-arc-lifecycle-line"
      data-slot="tug-arc-lifecycle-line"
      data-stopped={model.stopped !== null ? "true" : undefined}
    >
      <TugArcTrack model={model} />
      <span className="tug-arc-lifecycle-reading" data-slot="tug-arc-lifecycle-reading">
        {/* One pixel proud of the 9px cap band the track occupies, so the glyph
          reads as the strip's neighbour rather than as a taller mark set
          beside it — or the host's own mark in its place, on the same band. */}
        {mark !== undefined ? (
          <span className="tug-arc-lifecycle-mark-slot">{mark}</span>
        ) : (
          <ArcPhaseMark model={model} size={11} />
        )}
        {/* A tooltip is never a second copy of the word under the cursor. The
          reading elides first when the line runs out of room, so the bubble is
          for the words the ellipsis took away — `truncated` measures the
          span at the open edge and stays shut when the whole word fits. */}
        <TugTooltip content={word} truncated>
          <span className="tug-arc-lifecycle-note" data-slot="tug-arc-lifecycle-note">
            {word}
          </span>
        </TugTooltip>
        {/* After the verb, where the count reads as its object ([B02]) — and
          only while a step is in hand, which is what keeps a walked ledger
          under audit reading `Auditing` rather than `Auditing 6/6`. */}
        {reading.fraction !== null && steps !== null && steps.current !== null ? (
          <TugTooltip
            content={
              `Step ${steps.current} of ${steps.total}` +
              (stepTitle !== null && stepTitle.length > 0 ? ` — ${stepTitle}` : "")
            }
          >
            <TugStepFraction current={steps.current} total={steps.total} />
          </TugTooltip>
        ) : null}
      </span>
    </span>
  );
}
