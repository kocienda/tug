/**
 * join-offer-reveal — whether an *unbidden* Changes reveal may fire.
 *
 * A finished arc raises a standing join offer, and the Session card answers it
 * by opening the Changes room armed — the entry the user would have made by
 * hand. That entry is unbidden, so it is fenced: it fires only at a quiet
 * moment, only once per arc head, and only into a form that can show what it
 * opens.
 *
 * The predicate lives here, apart from the card, because it is the decision
 * rather than the plumbing. Every condition is a *dependency* of the effect
 * that calls it, never a peek at a ref — a deferral has to re-run on its own
 * when the turn settles, the composer empties, the shade closes, or the user
 * unfolds the card. Read as refs they would defer forever, since nothing would
 * wake the effect once the offer stopped changing.
 *
 * **Folded is the condition this module was written for ([B06]).** The Changes
 * shade is a view swap over the top column, and on a settled folded card that
 * column is the Z2 instrument row — so a shade raised there covers the fold
 * control with a scrim that keeps pointer events, and the act it offers lives
 * in Z5, which the fold has made zero-height and inert. The room would be open
 * behind a door nobody can reach. Deferring instead costs nothing, because
 * `folded` is a dependency: the user's own unfold re-runs the effect and the
 * room opens armed, exactly as it would have on an open card.
 *
 * The head must **not** be spent on a refusal. Spending it is what says "the
 * reader has seen this work", and a reveal that never happened showed them
 * nothing.
 *
 * @module lib/join-offer-reveal
 */

/** Everything the gate reads. All of it is passed; nothing is fetched. */
export interface JoinOfferRevealInput {
  /** Whether this arc head has already been revealed on this mount. */
  readonly alreadyRevealed: boolean;
  /** Whether a turn is in flight — entering would cover what is being read. */
  readonly turnInFlight: boolean;
  /** Whether any landing is already up. */
  readonly anyLandingActive: boolean;
  /** Whether the composer holds no user content. */
  readonly composerEmpty: boolean;
  /** Whether a shade is already showing. */
  readonly shadeShowing: boolean;
  /** Whether the card wears the folded form ([P01], [P03]). */
  readonly folded: boolean;
}

/**
 * Whether the passive reveal may fire now.
 *
 * `false` is always a *deferral* rather than a refusal: every input is a
 * dependency of the calling effect, so the answer is asked again the moment
 * any of them moves.
 */
export function shouldRevealJoinOffer(input: JoinOfferRevealInput): boolean {
  if (input.alreadyRevealed) return false;
  if (input.folded) return false;
  if (input.turnInFlight) return false;
  if (input.anyLandingActive) return false;
  if (!input.composerEmpty) return false;
  if (input.shadeShowing) return false;
  return true;
}
