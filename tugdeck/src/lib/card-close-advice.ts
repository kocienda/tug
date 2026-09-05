/**
 * card-close-advice.ts — what a card says about a close gesture aimed at it.
 *
 * The mirror image of `card-close-guard.ts`. A guard ADDS a decision to a
 * close gesture for a card holding unsaved state; advice speaks to the
 * confirm a card's TYPE already asks for — waiving it when the card is
 * holding nothing, and naming what is at stake when it is not.
 *
 * The Session card is the case. Its registration carries
 * `confirmClose: true` because a transcript is not recoverable, but a card
 * still sitting on the project picker has no transcript, and asking
 * "Close Card?" over an empty one is a guard with nothing behind it. The
 * same card with an unsent message in its composer is the opposite case:
 * the confirm stands, and it should say so rather than ask a generic
 * question about a card the user thinks is empty ([L31] — the holder
 * speaks the reason).
 *
 * Advice is a live call, not a flag: the pane asks at close time, so the
 * same card waives while it is empty and confirms the moment it holds a
 * turn or a draft. Nothing here enters React — read it from an event
 * handler, never from render ([L02]).
 *
 * Registration returns its own release ([L27]); the card releases on
 * unmount.
 *
 * @module lib/card-close-advice
 */

/** A card's answer about a close gesture aimed at it, right now. */
export interface CardCloseAdvice {
  /**
   * True when the card holds nothing the confirm would protect, so the
   * gesture closes immediately despite the card type's opt-in.
   */
  waive: boolean;
  /**
   * The confirm's copy when it does stand — the card naming what the
   * close would take. Absent (or null) takes the pane's own wording.
   * Ignored when `waive` is true, where there is no popover to word.
   */
  message?: string | null;
}

/** Answers for the card at the moment it is asked. */
export type CardCloseAdvisor = () => CardCloseAdvice;

const advisors = new Map<string, CardCloseAdvisor>();

/**
 * Register `advisor` for `cardId`. Returns a release that removes it —
 * call on unmount ([L27]). A re-registration replaces the prior advisor.
 */
export function registerCardCloseAdvice(
  cardId: string,
  advisor: CardCloseAdvisor,
): () => void {
  advisors.set(cardId, advisor);
  return () => {
    // Only remove if it is still ours — a later registration for the same
    // card id owns the slot now.
    if (advisors.get(cardId) === advisor) advisors.delete(cardId);
  };
}

/**
 * What `cardId` says about a close right now, or null when the card
 * registered no advisor — a card that says nothing keeps the confirm its
 * type asked for, worded by the pane.
 */
export function readCardCloseAdvice(cardId: string): CardCloseAdvice | null {
  return advisors.get(cardId)?.() ?? null;
}

/** Shorthand for the sites that only need the waive bit. */
export function cardWaivesCloseConfirm(cardId: string): boolean {
  return readCardCloseAdvice(cardId)?.waive === true;
}
