/**
 * The arc's fit, as one sentence — what the last green verify said about the
 * tree a join would land, read before the join is pressed.
 *
 * The join gate is reconcile-clean alone, so nothing at the join re-runs the
 * arc's checks. The all-clear is the audit's `tugtool arc verify`, and this is
 * how that all-clear is seen: verified and current, verified but stale naming
 * which endpoint moved, or never verified. It says; it gates nothing.
 *
 * @module lib/arc-fit
 */

import type { ArcChangesetEntry } from "@/lib/changeset-types";

/** The three readings of an arc's fit. */
export type ArcFitReading = "current" | "stale" | "never";

export interface ArcFitSentence {
  reading: ArcFitReading;
  text: string;
}

/** A sha as the fold shows one. */
const short = (sha: string): string => sha.slice(0, 7);

/** The fit fact off the arc's entry, as the one sentence the face renders. */
export function arcFitSentence(
  fit: ArcChangesetEntry["fit"] | undefined,
): ArcFitSentence {
  if (fit === undefined) {
    return {
      reading: "never",
      text: "Not verified — no verify has passed on this arc.",
    };
  }
  const pair = `Verified at ${short(fit.head)} onto ${short(fit.base)}`;
  if (fit.current) {
    return { reading: "current", text: `${pair}, and both still stand.` };
  }
  const head = fit.head_moved === true;
  const base = fit.base_moved === true;
  const moved =
    head && base
      ? "the arc and the base have both moved since"
      : head
        ? "the arc has moved since"
        : base
          ? "the base has moved since"
          : "that pair no longer stands";
  return { reading: "stale", text: `${pair}, but ${moved}.` };
}
