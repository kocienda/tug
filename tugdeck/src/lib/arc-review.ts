/**
 * arc-review.ts — what an arc's plan review state means to a surface.
 *
 * The state itself is computed on the server and rides the dash changeset entry
 * as one string ([P03]); nothing here parses a plan. What lives here is the
 * shared reading of that string, so the three surfaces that paint the mark —
 * the Arcs card row, the Changes shade's dash row, and the masthead dash chip
 * — cannot disagree about which states paint or about what they mean.
 *
 * **Only `stale` and `never-reviewed` paint.** A mark that is always present is
 * not a mark: `reviewed` and an absent field are the quiet, common case, and a
 * surface renders nothing for them.
 *
 * **And nothing paints on a task list.** A dash worked directly writes its own
 * steps and is never devised against the skeleton, so no review was ever going
 * to cover it — `never-reviewed` there is not an unmet obligation, it is a
 * stage the dash does not have, and a caution-toned word for it read as a
 * warning about work nobody owed.
 *
 * The mark is advisory and gates nothing ([P07]) — the gate that matters is
 * `arc-implement`'s setup, which refuses to walk an unreviewed plan long
 * before anything reaches a landing.
 *
 * @module lib/arc-review
 */

/** The two states that paint, in the spellings `tugtool plan status` reports. */
export const ARC_REVIEW_PAINTS = ["stale", "never-reviewed"] as const;

/**
 * Does this review state say anything worth a mark?
 *
 * `taskList` is the dash's `task_list` bit where the surface has it; a surface
 * reading a sender that carries no such bit passes nothing and gets the
 * pre-existing answer.
 */
export function arcReviewPaints(
  review: string | null | undefined,
  taskList: boolean = false,
): boolean {
  return (
    !taskList &&
    review !== null &&
    review !== undefined &&
    (ARC_REVIEW_PAINTS as readonly string[]).includes(review)
  );
}

/**
 * What the mark's tooltip says.
 *
 * The two painting states get different words because they call for different
 * responses: a plan that moved past its review wants a re-review, while a plan
 * nothing ever vouched for wants a first one. `planPath` is named only where
 * the surface is this project's own room and the path is actionable — the Arcs card
 * spans projects on one line, so it passes none.
 */
export function arcReviewTooltip(
  review: string,
  planPath: string | null,
): string {
  const lead =
    review === "stale"
      ? "Plan has changed since its last review"
      : "Plan has never been reviewed";
  return planPath === null ? lead : `${lead} — ${planPath}`;
}
