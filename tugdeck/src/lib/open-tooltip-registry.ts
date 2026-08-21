/**
 * Sole-tooltip registry — one bubble on screen, ever.
 *
 * A tooltip answers "what is the thing under the pointer". There is only one
 * such thing, so there is only one answer, and two bubbles standing at once
 * is always a bug: they overlap, they describe different targets, and the
 * reader has no way to tell which one the pointer earned.
 *
 * ## Why Radix's own arbitration is not enough
 *
 * Radix already broadcasts a `tooltip.open` document event on every open and
 * closes every other open content from it. That works for the ordinary case —
 * hover one control, then another — and it is what keeps a row of toolbar
 * buttons honest. It cannot handle the case that produced this module: two
 * tooltips that open in the SAME tick. Radix registers the close listener from
 * an effect inside the tooltip's content, so a tooltip that has just decided to
 * open is not yet listening when the second one broadcasts, and neither hears
 * the other.
 *
 * Nested triggers make that the normal case, not a race. A History row wraps
 * its whole commit line in a tip and carries a session citation chip inside
 * that line with a tip of its own. `pointermove` bubbles, so one pointer motion
 * arms both open timers at the same instant, both fire in the same task, and
 * both bubbles paint.
 *
 * ## Specificity, not recency
 *
 * So the arbitration happens at the open EDGE, before anything renders, where
 * both parties are known synchronously. When a tooltip is standing and another
 * wants to open, one of them gives way:
 *
 *  - The newcomer's trigger CONTAINS the standing one's → the newcomer stands
 *    down. The bubble already up describes the smaller, more specific thing the
 *    pointer is actually on; the row's tip has nothing better to say about it.
 *  - Otherwise → the newcomer takes it and the standing one closes. Two
 *    unrelated controls, and the pointer has moved on.
 *
 * That rule reads the same in either arrival order, which is what makes it
 * independent of whose open timer happens to fire first.
 *
 * Appearance-zone infrastructure outside the React tree [L22]; `TugTooltip`
 * claims from its open-transition handler and releases on close and unmount.
 *
 * @module lib/open-tooltip-registry
 */

/** One tooltip's standing claim to the screen. */
export interface TooltipClaim {
  /** The element the bubble hangs from, for the containment test. */
  trigger: Element | null;
  /** Close this tooltip. Called when another claim displaces it. */
  close: () => void;
}

/** The one tooltip currently allowed to show, or null when none is up. */
let standing: TooltipClaim | null = null;

/**
 * Ask to be the one tooltip on screen.
 *
 * Returns `false` when the caller should not open — a more specific bubble
 * inside its own trigger is already answering. Returns `true` when the claim
 * is granted, having closed whatever was standing.
 */
export function claimSoleTooltip(claim: TooltipClaim): boolean {
  const held = standing;
  if (held === null || held === claim) {
    standing = claim;
    return true;
  }
  if (
    held.trigger !== null &&
    claim.trigger !== null &&
    claim.trigger !== held.trigger &&
    claim.trigger.contains(held.trigger)
  ) {
    return false;
  }
  // Take the claim BEFORE closing the previous holder: closing it runs its
  // release, which clears the registry only if it is still the holder.
  standing = claim;
  held.close();
  return true;
}

/** Give up the claim. A no-op for a tooltip that no longer holds it. */
export function releaseSoleTooltip(claim: TooltipClaim): void {
  if (standing === claim) standing = null;
}
