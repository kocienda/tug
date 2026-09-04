/**
 * arc-sigil.tsx — an arc's name, wearing its `^`.
 *
 * The standing rule is that a bound arc shows with its sigil everywhere an arc
 * is named, with no opt-out. Two hand-rolled spellings of `^` + name is exactly
 * how a rule like that drifts, so there is one, and both surfaces compose it:
 * `SessionArcMarker` in the session identity run, and the Arcs section's
 * eyebrow.
 *
 * The eyebrow cannot simply reuse `SessionArcMarker`: that component is
 * keyed by `sessionId` and resolves its arc *through* a session, which an unbound
 * arc by definition does not have. What the two genuinely share is this
 * markup — the run element, its sigil, and its name — which would otherwise be
 * a second thing kept in step by hand.
 *
 * The sigil CHARACTER is a third party's too: the composer's session chip is a
 * Canvas bake and can render no elements at all, so it appends the same `^` as
 * text. That spelling lives in `lib/arc-sigil-text.ts` and both read it.
 *
 * An arc's name is just a name here. The run carried a review tint once, and
 * it read as inexplicable for the reason it was: a session's identity line
 * says what the session IS, a plan's review hygiene is not that, and nothing
 * beside the tint said what the color meant. The Changes shade's plan-document
 * row keeps its own tint, on a surface that spells the review state out in
 * words next to the mark — a reader who can decode it.
 *
 * Class names stay `tug-session-identity-arc*`: the styling did not move, only
 * the markup that carries it. `data-slot` is the caller's, so a test can tell
 * an identity run from an Unbound row.
 *
 * It lives in `tugways` rather than beside the Arcs card that prompted it,
 * because `tug-session-identity` is a tugways component and a tugways file
 * importing a feature's is the layering backwards.
 *
 * @module components/tugways/arc-sigil
 */

import React from "react";

import { ARC_SIGIL } from "@/lib/arc-sigil-text";

export interface ArcSigilProps {
  /** The arc's short name, without the `^`. */
  name: string;
  /**
   * The name run's content, when the surface paints those characters itself
   * rather than merely printing them — a filter's marks over the ones it
   * matched. `name` still travels, because it is what the run is about; this
   * only decides how the characters are drawn.
   */
  nameContent?: React.ReactNode;
  /** The run's `data-slot` — how each surface names its own copy. */
  slot: string;
  /** The run's hover sentence, when the surface has one to give. */
  title?: string;
  ariaLabel?: string;
  /**
   * Render the run as an **atom** — the citation register — rather than as
   * bare presence.
   *
   * The pill is not authored here and has no values of its own: the wrapper
   * wears `tug-session-identity` + `data-tier="chip"`, so the enclosure is the
   * settled session-atom skin in `tug-session-identity.css`, the same rules a
   * session citation gets, reached by the same selectors. An arc atom and a
   * session atom are siblings by construction rather than by two sets of
   * numbers kept equal by hand.
   *
   * This is the same borrowing the class names already do — the styling did
   * not move, only the markup carrying it.
   */
  atom?: boolean;
}

export function ArcSigil({
  name,
  nameContent,
  slot,
  title,
  ariaLabel,
  atom = false,
}: ArcSigilProps): React.ReactElement {
  const run = (
    <span
      className="tug-session-identity-arc"
      data-slot={slot}
      title={title}
      aria-label={ariaLabel}
    >
      <span className="tug-session-identity-arc-sigil" aria-hidden="true">
        {ARC_SIGIL}
      </span>
      <span className="tug-session-identity-arc-name">{nameContent ?? name}</span>
    </span>
  );
  if (!atom) return run;
  return (
    <span className="tug-session-identity" data-tier="chip">
      {run}
    </span>
  );
}
