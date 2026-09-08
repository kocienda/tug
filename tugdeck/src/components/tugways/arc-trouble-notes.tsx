/**
 * ArcTroubleNotes — what is in an arc's way, in full, below its steps.
 *
 * One row per applicable clause of {@link arcMetaFacts}, in the ranking that
 * derivation already gives them: the conflict somebody has to resolve, the
 * base dirt over the arc's own files, the fit nobody has re-verified or the
 * receipt that somebody has. Nothing is derived here — the sentence is the
 * fact's `label`, and the tone is the fact's `tone`.
 *
 * **Every applicable fact, not just the loudest** ([B05]). The lifecycle line
 * paints one clause and stacks the rest into its hover, because two clauses at
 * rail width pushed the row off its edge. Below the last step there is no such
 * pressure: the notes have the block's full width and a line each, so a
 * conflicted, overlapping, unverified arc finally reads all three instead of
 * one-and-a-bubble. The line's one-clause rule is untouched where it was
 * adopted; it is superseded here, where the constraint behind it does not
 * apply.
 *
 * **The evidence stays on hover.** A fact's `tooltip` is its paths or its two
 * shas — up to eight paths for the conflict clause — and eight paths inline
 * would swallow the placard the notes sit in. So the sentence is on the row
 * and the evidence is one hover away, exactly as it is on the line.
 *
 * **A list, not a frame.** What this owns is the column and the rows in it;
 * the inset, the surface, and whatever fold decides to mount it are the
 * host's. It renders nothing at all when there is no fact, so a host that has
 * decided to show its notes unconditionally can mount it unconditionally.
 *
 * Laws: [L02] every value arrives as a prop — this file reads no store;
 * [L06] the tone paints through `data-tone`, never React state; [L19]
 * `.tsx` / `.css` pair, docstring, `data-slot`; [L20] the composed
 * `TugTooltip` keeps its own tokens.
 *
 * @tug-pairings TugTooltip
 *
 * @module components/tugways/arc-trouble-notes
 */

import "./arc-trouble-notes.css";

import React from "react";

import type { ArcMetaFact } from "@/lib/arc-meta-facts";
import { TugTooltip } from "./tug-tooltip";

export function ArcTroubleNotes({
  facts,
}: {
  /** {@link arcMetaFacts}' clauses, in its ranking. */
  facts: readonly ArcMetaFact[];
}): React.ReactElement | null {
  if (facts.length === 0) return null;
  return (
    <span className="arc-trouble-notes" data-slot="arc-trouble-notes">
      {facts.map((fact) => (
        <TugTooltip key={fact.key} content={fact.tooltip}>
          <span
            className="arc-trouble-note"
            data-slot="arc-trouble-note"
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
