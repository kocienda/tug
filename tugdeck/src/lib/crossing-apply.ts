/**
 * What a list view writes when a still crossing over it settles or closes —
 * decided from the record its measure half took, as data.
 *
 * The list view's two crossing doors are split into a half that reads and a
 * half that writes ([P03] of the engine-time plan): the settle engine reads
 * every interior before it writes any, so the write half has to act on the
 * record it is handed rather than on the live scroller. Which writes it makes
 * — the extent rebase it owes, the pin, the restore, the size it records as
 * answered — is a function of that record and the list view's own refs, and
 * lives here so a test can pin it without a DOM.
 *
 * @module lib/crossing-apply
 */

import type { Measured } from "@/lib/fold-crossing";

/** The writes one door makes. */
export interface CrossingApplyPlan {
  /** Run the owed extent rebase from the record. */
  readonly rebase: boolean;
  /** Pin to the bottom (through `maybePinToBottom`'s own gate). */
  readonly pin: boolean;
  /** Re-apply a pending restore target. */
  readonly restore: boolean;
  /** The scrollport size to record as answered, or `null` to record none. */
  readonly answer: { readonly w: number; readonly h: number } | null;
  /** Re-window. */
  readonly tick: boolean;
}

/**
 * The writes a door makes, given the record and the list view's refs.
 *
 * - **settled** — a crossing held at the height it lands at, in the set-up:
 *   the land is paid now, so it pins, restores, records the size it answered
 *   and re-windows, whatever that size was.
 * - **closed** — a crossing that was not settled, ending at the land: it pays
 *   the same only when the scroller lands at a size other than the one last
 *   answered, and never against a size that was never answered (a list view
 *   that mounted inside the motion has had no delivery to land from).
 *
 * Either door runs an owed rebase, against a scrollport that has a height.
 */
export function planCrossingApply(
  door: "settled" | "closed",
  measured: Measured,
  refs: {
    readonly owedRebase: boolean;
    readonly answered: { readonly w: number; readonly h: number } | null;
  },
): CrossingApplyPlan {
  const rebase = refs.owedRebase && measured.clientHeight > 0;
  const size = { w: measured.w, h: measured.h };
  if (door === "settled") {
    return { rebase, pin: true, restore: true, answer: size, tick: true };
  }
  const answered = refs.answered;
  const changed =
    answered !== null && (answered.w !== size.w || answered.h !== size.h);
  return changed
    ? { rebase, pin: true, restore: true, answer: size, tick: true }
    : { rebase, pin: false, restore: false, answer: null, tick: false };
}
