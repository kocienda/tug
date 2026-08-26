/**
 * DashLifecycleBlock — a dash as a two-line block: who, then what.
 *
 * Line one is the identities: the dash atom, a hairline, and one worker atom
 * per bound session (none is how *unbound* reads — it is the absence of
 * workers, not a stage). Line two is {@link DashLifecycleLine}. The Lens's
 * Dashes section and the Changes shade's collapsed dash row are this one block
 * at the rail and reading scales, so a reader who learned it once has learned
 * it everywhere, and the block never grows: two lines for every phase, from
 * the brief to the join.
 *
 * The trailing slot is the surface's own — a row menu, a fold cue — and rides
 * the eyebrow's end.
 *
 * Laws: [L02] the worker atom's identity is its own subscription; [L19]
 * `.tsx`/`.css` pair, `data-slot`; [L20] composes the atom, the identity, and
 * the line, and publishes {@link DashWorkerAtom} for the dash picker, which
 * wears the eyebrow's grammar without wearing the whole block.
 *
 * @module components/tugways/dash-lifecycle-block
 */

import "./dash-lifecycle-block.css";

import React from "react";

import { DashLifecycleLine, type DashLifecycleLineProps } from "./dash-lifecycle-line";
import { TugDashAtom } from "./tug-dash-atom";
import { TugSessionIdentity } from "./tug-session-identity";
import { useSessionIdentity } from "@/lib/session-identity";

export interface DashLifecycleBlockProps extends DashLifecycleLineProps {
  name: string;
  review?: string | null;
  workers?: readonly string[];
  trailing?: React.ReactNode;
}

/**
 * One bound worker as a mini atom — the session's display name behind its live
 * dot, with no callsign and no dash run, because the atom beside it already
 * names the dash.
 *
 * Exported because the dash picker's row wears the same eyebrow grammar
 * without wearing the whole block: composing this is what keeps it from
 * re-declaring a chip identity by hand ([L20]).
 */
export function DashWorkerAtom({ sessionId, size }: { sessionId: string; size: "sm" | "2xs" }): React.ReactElement {
  const identity = useSessionIdentity(sessionId);
  return (
    <TugSessionIdentity
      identity={identity}
      tier="chip"
      size={size}
      dash={false}
      tooltip={false}
      data-slot="tug-dash-lifecycle-worker"
    />
  );
}

export function DashLifecycleBlock({
  name,
  review = null,
  workers = [],
  trailing,
  model,
  note,
  facts,
  size = "rail",
}: DashLifecycleBlockProps): React.ReactElement {
  const atomSize = size === "read" ? "sm" : "2xs";
  return (
    <span className="tug-dash-lifecycle-block" data-slot="tug-dash-lifecycle-block" data-dash={name} data-size={size}>
      <span className="tug-dash-lifecycle-eyebrow" data-slot="tug-dash-lifecycle-eyebrow">
        <TugDashAtom name={name} review={review} size={atomSize} slot="tug-dash-lifecycle-name" />
        <span className="tug-dash-lifecycle-rule" aria-hidden="true" />
        {workers.map((sessionId) => (
          <DashWorkerAtom key={sessionId} sessionId={sessionId} size={atomSize} />
        ))}
        {trailing}
      </span>
      <DashLifecycleLine model={model} note={note} {...(facts !== undefined ? { facts } : {})} size={size} />
    </span>
  );
}
