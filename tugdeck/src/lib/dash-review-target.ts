/**
 * dash-review-target — where a `/dash-review` invocation points, and what this card
 * last pointed it at.
 *
 * The review is an **ordinary turn on whatever model is selected**. There is no
 * borrow, no scheduling, and no machine: `/dash-review` submits the skill the
 * same way any other slash command does, and `dash-devise` either reviews the
 * plan itself (when it is already running on the review model) or stops and
 * hands the user a chip to click. Choosing the model is the user's act, before
 * they click — nothing here changes it in either direction.
 *
 * What survives is the part that was always honest work: resolving a bare
 * `/dash-review` to a plan, and remembering the last one so the next bare
 * invocation has an answer.
 *
 * @module lib/dash-review-target
 */

import { PLAN_REVIEW_LAST_DOMAIN } from "@/lib/model-domains";
import { getTugbankClient } from "@/lib/tugbank-singleton";

/** The skill the review turn invokes. */
export const REVIEW_PLAN_COMMAND = "tugplug:dash-review";

/**
 * Remember the plan this card just reviewed, so a later bare `/dash-review`
 * resolves to it.
 *
 * Optimistic `setLocalValue` + PUT, on `writePersistedModel`'s shape: the next
 * bare invocation reads the cache synchronously, and a card cannot wait on a
 * round-trip to know what it reviewed a moment ago.
 */
export function writeLastReviewedPlan(cardId: string, planPath: string): void {
  const client = getTugbankClient();
  if (client !== null) {
    client.setLocalValue(PLAN_REVIEW_LAST_DOMAIN, cardId, {
      kind: "string",
      value: planPath,
    });
  }
  const url = `/api/defaults/${PLAN_REVIEW_LAST_DOMAIN}/${encodeURIComponent(cardId)}`;
  fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "string", value: planPath }),
  }).catch((err) => {
    console.warn(`[dash-review] PUT failed for card ${cardId}:`, err);
  });
}

/** The plan this card last reviewed, or `null`. Cache read — never a fetch. */
export function readLastReviewedPlan(cardId: string): string | null {
  const entry = getTugbankClient()?.get(PLAN_REVIEW_LAST_DOMAIN, cardId);
  if (entry?.kind === "string" && typeof entry.value === "string") {
    const trimmed = entry.value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

/** What bare-form resolution has to work with. The card holds all of it. */
export interface PlanReviewTargetInput {
  /** The trimmed argument the user typed, `""` when they typed none. */
  args: string;
  /** The session's absolute project root. */
  projectDir: string;
  /** The plan this card last reviewed, or `null`. */
  lastReviewed: string | null;
  /** The bound dash's plan, **absolute**, when this card is bound to a dash
   *  that has one. */
  boundDash: { plan: string } | null;
}

/** Where a `/dash-review` invocation points, or a refusal. */
export type PlanReviewTarget = { path: string } | { refused: true };

/**
 * Resolve `/dash-review`'s target: explicit argument, else the plan this card
 * last reviewed, else the bound dash's plan, else refuse.
 *
 * **Last-reviewed beats the bound dash, deliberately.** The gesture's moment is
 * a plan devised and then edited, when the card usually has no dash yet; and a
 * card that *is* bound is frequently bound to a dash implementing some other
 * plan. Resolving to the dash first would silently review the wrong document —
 * which is the failure this whole lane exists to kill. The dash is not lost: it
 * is step 2, and it is the only answer a fresh card bound to a running dash has.
 *
 * The dash branch takes the plan's path verbatim: the server hands it over
 * absolute, resolved against the main repository root, and the deck composes
 * nothing. `projectDir` does not enter into it — a card's project directory may
 * itself be a linked worktree, and only the server knows the main root.
 *
 * Pure: the card has no filesystem, so nothing here stats, normalizes, or
 * round-trips. A path that does not exist is the review turn's report to make.
 */
export function resolvePlanReviewTarget(
  input: PlanReviewTargetInput,
): PlanReviewTarget {
  const explicit = input.args.trim();
  if (explicit.length > 0) {
    return { path: joinPath(input.projectDir, explicit) };
  }
  if (input.lastReviewed !== null) {
    return { path: input.lastReviewed };
  }
  if (input.boundDash !== null) {
    return { path: input.boundDash.plan };
  }
  return { refused: true };
}

/** Join a relative path onto a base; an absolute path passes through. */
function joinPath(base: string, path: string): string {
  if (path.startsWith("/")) return path;
  return `${base.replace(/\/+$/, "")}/${path}`;
}
