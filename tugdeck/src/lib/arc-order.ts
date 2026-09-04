/**
 * The one order arcs are listed in, wherever they are listed.
 *
 * Nearest-to-done first, then freshest, then by name. The Arcs card settled
 * this order first ([P02], Table T01) — the actionable arc is the one about to
 * land rather than the one just created — and the Changes shade's arc lane
 * lists its unbound arcs in the same order, because a person reading either
 * surface wants the same row on top. One implementation, two surfaces: a
 * comparator copied into the lane would be a second order the moment either
 * was tuned.
 *
 * Lives in `lib/` rather than on the Arcs card because the card already
 * imports from the shade's row menu, and a shade importing the card back
 * would close a cycle around a pure function.
 *
 * @module lib/arc-order
 */

import type { ArcChangesetEntry } from "@/lib/changeset-types";

/**
 * How far along an arc is, as a sortable rank.
 *
 * `joining` tops the table because it is the state that most needs a person.
 * Exported so its test can be a table test rather than a DOM assertion.
 */
export const ARC_STAGE_RANK: Record<string, number> = {
  joining: 6,
  "draft-ready": 5,
  audited: 4,
  built: 3,
  implementing: 2,
  working: 1,
  created: 0,
};

/** An absent or unrecognized stage sorts last, and never throws: an older or
 *  newer sender must not be able to break a list's render. */
function stageRank(stage: string | null | undefined): number {
  return stage == null ? -1 : (ARC_STAGE_RANK[stage] ?? -1);
}

/**
 * Two ISO-8601 UTC instants, newest first, with absent sorting **last**.
 *
 * A raw string comparison is the whole implementation: the timestamps are UTC
 * with a fixed-width layout, so lexical order is chronological order and no
 * `Date` is ever parsed here. Absent-last keeps arcs created before creation
 * wrote a birth record from claiming the top of every stage band.
 */
function compareIsoDesc(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return b.localeCompare(a);
}

/**
 * The total order over arc entries: stage rank descending, then freshest
 * first, then by name.
 */
export function compareArcEntries(
  a: ArcChangesetEntry,
  b: ArcChangesetEntry,
): number {
  const byStage = stageRank(b.stage) - stageRank(a.stage);
  if (byStage !== 0) return byStage;
  const byAge = compareIsoDesc(a.last_activity, b.last_activity);
  if (byAge !== 0) return byAge;
  return a.display_name.localeCompare(b.display_name);
}
