/**
 * dash-sigil.tsx — a dash's name, wearing its `^`.
 *
 * The standing rule is that a bound dash shows with its sigil everywhere a dash
 * is named, with no opt-out. Two hand-rolled spellings of `^` + name is exactly
 * how a rule like that drifts, so there is one, and both surfaces compose it:
 * `SessionDashMarker` in the session identity run, and the Dashes section's
 * eyebrow.
 *
 * The eyebrow cannot simply reuse `SessionDashMarker`: that component is
 * keyed by `sessionId` and resolves its dash *through* a session, which an unbound
 * dash by definition does not have. What the two genuinely share is this
 * markup — the run element, its sigil, its name, and the `data-review` tint
 * that rides the run itself and would otherwise be a second thing kept in step
 * by hand.
 *
 * Class names stay `tug-session-identity-dash*`: the styling did not move, only
 * the markup that carries it. `data-slot` is the caller's, so a test can tell
 * an identity run from an Unbound row.
 *
 * It lives in `tugways` rather than beside the Lens section that prompted it,
 * because `tug-session-identity` is a tugways component and a tugways file
 * importing a feature's is the layering backwards.
 *
 * @module components/tugways/dash-sigil
 */

import React from "react";

import { dashReviewPaints } from "@/lib/dash-review";

export interface DashSigilProps {
  /** The dash's short name, without the `^`. */
  name: string;
  /** The plan's review state, or null. Tints the run only when it paints. */
  review: string | null;
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
   * session citation gets, reached by the same selectors. A dash atom and a
   * session atom are siblings by construction rather than by two sets of
   * numbers kept equal by hand.
   *
   * This is the same borrowing the class names already do — the styling did
   * not move, only the markup carrying it.
   */
  atom?: boolean;
  /** Atom size, passed through to the skin's own `data-size` scale. */
  atomSize?: "sm" | "2xs";
}

export function DashSigil({
  name,
  review,
  slot,
  title,
  ariaLabel,
  atom = false,
  atomSize = "2xs",
}: DashSigilProps): React.ReactElement {
  const run = (
    <span
      className="tug-session-identity-dash"
      data-slot={slot}
      // Only `stale` and `never-reviewed` paint; a reviewed dash says nothing.
      data-review={
        review !== null && dashReviewPaints(review) ? review : undefined
      }
      title={title}
      aria-label={ariaLabel}
    >
      <span className="tug-session-identity-dash-sigil" aria-hidden="true">
        ^
      </span>
      <span className="tug-session-identity-dash-name">{name}</span>
    </span>
  );
  if (!atom) return run;
  return (
    <span className="tug-session-identity" data-tier="chip" data-size={atomSize}>
      {run}
    </span>
  );
}
