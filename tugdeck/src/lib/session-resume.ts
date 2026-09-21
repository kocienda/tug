/**
 * session-resume.ts — the one place that decides whether a session can be
 * resumed.
 *
 * A leaf: no imports, so the identity menu, the annotation registry and the
 * citation pill can all read the rule without importing each other.
 *
 * It exists because three surfaces offer the same gesture over the same
 * session, and a second copy of the expression is how a pill and the
 * right-click menu ON that pill come to disagree about whether one session can
 * be resumed — the pill offering a resume the menu greys out, over the same
 * ink, in the same frame.
 *
 * @module lib/session-resume
 */

/** The facts a resume decision rests on. */
export interface SessionResumeFacts {
  /** The ledger's state, or null when nothing has said. */
  state: string | null;
  /**
   * Whether the session's holder is a background owner rather than a deck
   * card. Read from the SAME source as {@link state}: the two are one fact —
   * "live, and held by nobody a user can be sent to" — and taking `state`
   * from the resolver while taking this from the listing store refuses the
   * gesture for every session the listing has not reached yet.
   */
  background: boolean;
  /** The session's project directory; `""` when nothing knows it. */
  projectDir: string;
}

/**
 * Whether a session can be resumed onto a card.
 *
 * Two conditions, and both are about whether the gesture can be PERFORMED
 * rather than about whether it would be nice to offer:
 *
 *  - **Not held elsewhere.** A live session claimed by a deck card belongs to
 *    that card, and a second claim is not a resume. The exception is the one
 *    adoption exists for: a live session held by a **background owner** has no
 *    card to send the user to, so seating it is the only way to reach it, and
 *    the supervisor admits such a session without re-spawning it.
 *  - **A project directory.** A resume has to open somewhere, and a session
 *    with no recorded project dir names no such place.
 */
export function isSessionResumable(facts: SessionResumeFacts): boolean {
  const heldElsewhere = facts.state === "live" && !facts.background;
  return !heldElsewhere && facts.projectDir.length > 0;
}
