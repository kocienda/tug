/**
 * ArcLifecycleLine — what an arc is DOING, as one line with no clock on it.
 *
 *   track · glyph · <Doing> [i/N] · <what is in the way>
 *
 * The track is {@link TugArcTrack}, the arc's whole life in a cap-height
 * strip; the glyph is {@link ArcPhaseMark}, which says outright the phase the
 * strip says by WHICH cell is lit.
 *
 * **The line is one clause: what the arc is doing, then what is in its way**
 * ([B00]). Both halves are derived once and nowhere else. The first is
 * {@link arcReading} — a verb in progress (`Executing`, `Awaiting
 * review`), or `Stopped · <why>` — with the fraction *after* the verb, where
 * it reads as the verb's object ([B02]). The second is the loudest of
 * `arcMetaFacts`' clauses, with a `·` between them, the same mark the join
 * register one line below uses.
 *
 * **One trouble clause, never two** ([B03]). Two of these at rail width
 * pushed the row off its edge, and a reader who sees red hovers it — so
 * every applicable clause's sentence is stacked into the one clause's hover,
 * and nothing is lost by painting one.
 *
 * **And on a host that has somewhere to put the sentences, the clause is a
 * MARK** ([B06]). A sentence here is `flex: 0 0 auto` and the reading beside
 * it is the line's only elastic run, so any width the trouble wants is taken
 * from the phase word, down to `I…` — the precedence backwards, the
 * subordinate clause outbidding the subject. `troublePlacement="mark"` puts a
 * fixed-width, tone-colored glyph in the slot instead, which cannot bid for
 * that width whatever the fact says, and the host renders every applicable
 * sentence in full below its steps. It is an opt-in and not a flip: a host
 * with nothing under its block would be demoting the reading to hover.
 *
 * The line used to append three mechanisms in source order with no
 * connective: the phase's enum key, `arcMetaFacts`' tooltip-column labels,
 * and the kind as a bare adjective. The kind is the strip's own cell set, the
 * stop is its red cell, and the phase is the clause's subject — so none of
 * the three is a word after the note any more.
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
import { CircleAlert, CircleCheck, TriangleAlert, type LucideIcon } from "lucide-react";

import {
  arcMetaGlyph,
  type ArcMetaFact,
  type ArcMetaGlyph,
} from "@/lib/arc-meta-facts";
import { ArcPhaseMark } from "./arc-phase-mark";
import { arcReading, TugArcTrack, type ArcTrackModel } from "./tug-arc-track";
import { TugStepFraction } from "./tug-step-fraction";
import { TugTooltip } from "./tug-tooltip";

/**
 * The loudest clause, wearing every applicable clause's sentence ([B03]).
 *
 * `arcMetaFacts` already ranks them, so the first is the one to paint. The
 * rest are not dropped — their sentences stack into its hover, separated by a
 * blank line because each one may itself be a heading over a list of paths.
 * Pure, so the stacking is a table test.
 */
export function arcTroubleClause(facts: readonly ArcMetaFact[]): ArcMetaFact | null {
  const loudest = facts[0];
  if (loudest === undefined) return null;
  if (facts.length === 1) return loudest;
  return { ...loudest, tooltip: facts.map((fact) => fact.tooltip).join("\n\n") };
}

/** The glyph each {@link arcMetaGlyph} name stands for, resolved here. */
const TROUBLE_MARK_GLYPHS: Record<ArcMetaGlyph, LucideIcon> = {
  "circle-alert": CircleAlert,
  "triangle-alert": TriangleAlert,
  "circle-check": CircleCheck,
};

/** A hair under the phase glyph's 11px, so the mark reads as the smaller of
 *  the two marks on the line rather than as a second phase. */
const TROUBLE_MARK_SIZE = 10;

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
  facts?: readonly ArcMetaFact[];
  /**
   * Where the host puts what is in the arc's way ([B06]).
   *
   * `clause` — the loudest fact's sentence, on the line, after a `·`. The
   * default, and the only thing a host with nothing below its block can do.
   *
   * `mark` — a tone-colored glyph in the clause's slot, and the sentences
   * rendered by the host underneath, in {@link ArcTroubleNotes}. A sentence
   * on this line is incompressible and the reading beside it is not, so a
   * host that paints one is spending the phase word's width on a fact about
   * the checkout; a fixed-width glyph cannot bid for that width whatever the
   * fact says.
   *
   * Opt-in rather than a flip, because it is only honest for a host that
   * HAS somewhere to put the sentences: the transcript's stage notes and the
   * arc receipt's header are single blocks with nothing under them, and
   * turning the clause into a glyph there would demote the reading to hover.
   * @selector [data-trouble="clause"] | [data-trouble="mark"]
   * @default "clause"
   */
  troublePlacement?: "clause" | "mark";
}

export function ArcLifecycleLine({
  model,
  note,
  stepTitle = null,
  mark,
  facts = [],
  troublePlacement = "clause",
}: ArcLifecycleLineProps): React.ReactElement {
  const steps = model.steps;
  const reading = arcReading(model);
  const word = note ?? reading.word;
  const trouble = arcTroubleClause(facts);
  return (
    <span
      className="tug-arc-lifecycle-line"
      data-slot="tug-arc-lifecycle-line"
      data-trouble={troublePlacement}
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
        {trouble !== null ? (
          troublePlacement === "mark" ? (
            // The whole clause as one glyph, and no separator: a `·` is a
            // connective between two runs of words, and a mark needs none
            // between itself and the fraction. The hover is the clause's
            // verbatim — every applicable sentence, stacked — because a host
            // that shows its notes folded shut still owes the reading ([B09]).
            <TugTooltip content={trouble.tooltip}>
              <span
                className="tug-arc-lifecycle-fact-mark"
                data-slot="tug-arc-lifecycle-fact-mark"
                data-fact={trouble.key}
                data-tone={trouble.tone}
                role="img"
                aria-label={trouble.label}
              >
                {React.createElement(TROUBLE_MARK_GLYPHS[arcMetaGlyph(trouble.tone)], {
                  size: TROUBLE_MARK_SIZE,
                  "aria-hidden": true,
                })}
              </span>
            </TugTooltip>
          ) : (
            <>
              {/* The mark the join register one line below uses, between the
                two clauses and nowhere else. */}
              <span
                className="tug-arc-lifecycle-sep"
                data-slot="tug-arc-lifecycle-sep"
                aria-hidden="true"
              >
                ·
              </span>
              <TugTooltip content={trouble.tooltip}>
                <span
                  className="tug-arc-lifecycle-fact"
                  data-slot="tug-arc-lifecycle-fact"
                  data-fact={trouble.key}
                  data-tone={trouble.tone}
                >
                  {trouble.label}
                </span>
              </TugTooltip>
            </>
          )
        ) : null}
      </span>
    </span>
  );
}
