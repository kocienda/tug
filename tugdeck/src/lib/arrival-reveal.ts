/**
 * arrival-reveal.ts — when a card that arrived hidden is revealed.
 *
 * A card whose card at the instant it opens is a sheet is committed to its
 * column HIDDEN ([B01]): the real card, drawn where it will stand, laying out
 * and reporting its height while the user sees nothing move. The reveal is a
 * later commit that clears the mark and writes the height the hidden card
 * reported as its opening bid ([B04]). This module is the rule for WHEN that
 * commit is made, and it is pure so the rule can be tested without a deck.
 *
 * The rule has three inputs and one shape ([B03]): the card reveals at the
 * first of its content going QUIET — the card type's own word, through
 * {@link ArrivalQuiet}, since only it knows what its sheet is waiting on —
 * with a height already reported, or the BOUND expiring, so a source that
 * never settles cannot hold the card hostage. The bound is short by ruling
 * ([B05]): frames to a few hundred milliseconds, not the seconds a cold scan
 * takes, and when it expires the card reveals over what it has. Any later
 * frame that changes the sheet's height is an ordinary reservation from then
 * on, exactly as on any live card.
 *
 * The deck reads nothing card-specific here. The quiet source is declared by
 * the registration (`CardRegistration.arrivalQuiet`), the height report is the
 * sheet's own reservation, and the bound is the deck's; the deck composes the
 * three and the card type supplies one.
 *
 * @module lib/arrival-reveal
 */

/**
 * A card type's word on whether its opening sheet's content has stopped
 * moving — the one input to {@link arrivalRevealDue} the deck cannot answer
 * itself.
 *
 * `subscribe` fires the listener when the content has been DRAWN and the
 * answer may have changed — from the card's own layout effect, after the DOM
 * matches the data and the sheet has re-measured ([L04]), never from a
 * store's tick ahead of the render. The deck re-asks `isQuiet` on every fire
 * and never assumes a fire means quiet. A source with nothing to wait on
 * answers `true` from the first ask, and the card reveals on its first
 * height report.
 */
export interface ArrivalQuiet {
  subscribe(listener: () => void): () => void;
  isQuiet(): boolean;
}

/**
 * How long a hidden card waits for its content to go quiet before it reveals
 * over what it has, in milliseconds ([B03], [B05]).
 *
 * A liveness bound, not a height guess: it protects a project whose picker
 * never fills its list cap — where a late listing frame can still change the
 * sheet's height — from waiting the seconds a cold scan takes, at the price of
 * a possible late adjustment there. On a project whose phase-one rows already
 * fill the cap the quiet rule fires first and this number is never reached.
 *
 * Pinned at 250 from what the two paths actually wait on. On the `tug`
 * project, cold and warm alike, the listing's first frame is a ledger read
 * that arrives in tens of milliseconds with synopses aboard and more rows
 * than fill the cap, so the picker is quiet at that frame and the reveal
 * fires on the sheet's first height report — three or four frames after the
 * hidden commit, once the card has mounted and its sheet has measured. The
 * cold scan is phase two, which the cap rule never waits on, so this number
 * is not reached on either path there. Its floor is that first report: a
 * bound shorter than the mount-and-measure would reveal at the policy floor
 * and buy a third motion when the report lands. Its ceiling is the eye: a
 * column that sits still for a quarter second after the click reads as the
 * click landing, and one that sits for a second reads as nothing happening.
 * 250 leaves the report a dozen frames of slack under a wait nobody notices.
 * Observed values are in the arc's audit notes.
 */
export const ARRIVAL_REVEAL_BOUND_MS = 250;

/** The facts {@link arrivalRevealDue} decides over. */
export interface ArrivalRevealInput {
  /**
   * The sheet has reported a height at least once while hidden. Current by
   * the time a quiet fire reads it, because the fire follows the draw and
   * the draw re-measures the sheet first.
   */
  reported: boolean;
  /** The card type says its content is quiet ({@link ArrivalQuiet}). */
  quiet: boolean;
  /** {@link ARRIVAL_REVEAL_BOUND_MS} has elapsed since the hidden commit. */
  boundElapsed: boolean;
}

/**
 * Whether the reveal commit is due.
 *
 * Due when the content is quiet AND the sheet has reported — a quiet sheet
 * that has not yet mounted has nothing to measure — or when the bound has
 * elapsed, whatever the other two say: an expired bound reveals over whatever
 * the card has, including no panel at all, in which case the card arrives at
 * its policy floor and the first live report adjusts it.
 */
export function arrivalRevealDue(input: ArrivalRevealInput): boolean {
  if (input.boundElapsed) return true;
  return input.reported && input.quiet;
}
