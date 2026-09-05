/**
 * ArcLifecycleBlock — an arc as a two-line block: who, then what.
 *
 * Line one is the identities and nothing else: the arc atom, a hairline, and
 * one worker atom per bound session (none is how *unbound* reads — it is the
 * absence of workers, not a stage). Line two is {@link ArcLifecycleLine},
 * which carries every reading of what the arc is DOING — the track, the phase
 * glyph, the fraction, the word, the facts. The Arcs card, the
 * Changes shade's collapsed arc row and the masthead's arc placard are this
 * one block, all three at the reading scale, so a reader who learned it once
 * has learned it everywhere, and the block never grows: two lines for every
 * phase, from the brief to the join.
 *
 * **One scale, wherever a whole arc is shown.** The Arcs card sized the block
 * as list ink for a while — sized to the section's other rows — and the track
 * came out too small to read as a graphic. An arc's block is the thing the
 * section exists for, not an entry in a list of names, so it is sized as such
 * wherever it appears.
 *
 * **The eyebrow says WHO, the line says WHAT.** The phase glyph led the arc's
 * name for a while, which put a reading of the arc's state on the line whose
 * subject is its identity — two lines each half about state. The glyph now
 * sits where the rest of the state lives, between the track and the word it
 * names.
 *
 * The trailing slot is the surface's own — a row menu, a fold cue — and rides
 * the eyebrow's end.
 *
 * The Arcs card is the first surface to fill it: an arc row whose entry carries
 * a ledger wears the tool-call header's fold cue there, and folds open to the
 * plan's own steps ([D176]).
 *
 * **Two layouts, one block.** `stack` is the default and the shape everything
 * above describes: two lines, for a surface whose subject IS the arc. `row`
 * sets the same two runs side by side for a one-line HEADER — the arc
 * receipt's, where the block is a caption over a body rather than the thing
 * being read — and drops the hairline, which is a rule between two lines and
 * has nothing to separate when they sit on one. What a layout never changes
 * is what the block says: both wear the same identities and the same line, so
 * the receipt's header and the Arcs card's row are one grammar seen twice.
 *
 * Laws: [L02] the worker atom's identity is its own subscription; [L19]
 * `.tsx`/`.css` pair, `data-slot`; [L20] composes the atom, the identity, and
 * the line, and publishes {@link ArcWorkerAtom} for the arc picker, which
 * wears the eyebrow's grammar without wearing the whole block.
 *
 * @module components/tugways/arc-lifecycle-block
 */

import "./arc-lifecycle-block.css";

import React from "react";

import { ArcLifecycleLine, type ArcLifecycleLineProps } from "./arc-lifecycle-line";
import { TugArcAtom } from "./tug-arc-atom";
import { TugSessionIdentity } from "./tug-session-identity";
import { useSessionIdentity } from "@/lib/session-identity";

export interface ArcLifecycleBlockProps extends ArcLifecycleLineProps {
  name: string;
  workers?: readonly string[];
  trailing?: React.ReactNode;
  /**
   * `stack` — two lines, for a surface whose subject is the arc (default).
   * `row` — one line, for a header that captions something else.
   * @selector [data-layout="stack"] | [data-layout="row"]
   * @default "stack"
   */
  layout?: "stack" | "row";
}

/**
 * One bound worker as a mini atom — the session's display name behind its live
 * dot, with no callsign and no arc run, because the atom beside it already
 * names the arc.
 *
 * Exported because the arc picker's row wears the same eyebrow grammar
 * without wearing the whole block: composing this is what keeps it from
 * re-declaring a chip identity by hand ([L20]).
 */
export function ArcWorkerAtom({ sessionId }: { sessionId: string }): React.ReactElement {
  const identity = useSessionIdentity(sessionId);
  return (
    <TugSessionIdentity
      identity={identity}
      tier="chip"
      arc={false}
      tooltip={false}
      data-slot="tug-arc-lifecycle-worker"
    />
  );
}

export function ArcLifecycleBlock({
  name,
  workers = [],
  trailing,
  model,
  note,
  stepTitle,
  facts,
  layout = "stack",
}: ArcLifecycleBlockProps): React.ReactElement {
  return (
    <span
      className="tug-arc-lifecycle-block"
      data-slot="tug-arc-lifecycle-block"
      data-arc={name}
      data-layout={layout}
    >
      <span className="tug-arc-lifecycle-eyebrow" data-slot="tug-arc-lifecycle-eyebrow">
        <TugArcAtom name={name} slot="tug-arc-lifecycle-name" />
        {layout === "stack" ? (
          <span className="tug-arc-lifecycle-rule" aria-hidden="true" />
        ) : null}
        {workers.map((sessionId) => (
          <ArcWorkerAtom key={sessionId} sessionId={sessionId} />
        ))}
        {trailing}
      </span>
      <ArcLifecycleLine
        model={model}
        {...(note !== undefined ? { note } : {})}
        {...(stepTitle !== undefined ? { stepTitle } : {})}
        {...(facts !== undefined ? { facts } : {})}
      />
    </span>
  );
}
