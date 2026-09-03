/**
 * document-arc-entry — a branchless arc, in the shapes the surfaces read.
 *
 * A `DocumentArcEntry` is an arc that exists only as documents: a brief, maybe
 * a plan, and no `tugarc/<name>` branch yet. Every surface that names an arc
 * reads a `ArcChangesetEntry` and a `ArcTrackModel`, and this module is the
 * one place that turns the documents-only row into both — once, so the Arcs card,
 * the shade, and the session index cannot each invent their own reading.
 *
 * The line the two functions hold is what the wire can honestly say. The
 * counters are real: `step_total` / `steps_done` / `steps_begun` are read off
 * the plan's own ledger, so reporting them is reporting. The step *titles* are
 * not on the wire at all, so nothing here synthesizes a `steps` array — a
 * placard that renders titles would be rendering invented ones.
 *
 * @module lib/document-arc-entry
 */

import type {
  ArcChangesetEntry,
  DocumentArcEntry,
} from "@/lib/changeset-types";
import {
  type ArcTrackModel,
  arcTrackModel,
} from "@/components/tugways/tug-arc-track";

/**
 * A documents-only arc in the entry shape every arc surface reads.
 *
 * The empty values are not placeholders standing in for facts that exist
 * elsewhere — they are what a branchless arc honestly has. There is no base
 * it diverges from, no worktree to be dirty, no rounds, and no changed files,
 * because there is no branch. Every consumer of this shape reads the fields a
 * documents-only arc really carries: its identity, its documents, its review
 * verdict, its arc, and its bound sessions.
 */
export function documentArcAsEntry(
  entry: DocumentArcEntry,
): ArcChangesetEntry {
  return {
    kind: "arc",
    owner_id: entry.owner_id,
    display_name: entry.display_name,
    documents: entry.documents,
    ...(entry.review !== undefined ? { review: entry.review } : {}),
    ...(entry.arc !== undefined ? { arc: entry.arc } : {}),
    ...(entry.bound_sessions !== undefined
      ? { bound_sessions: entry.bound_sessions }
      : {}),
    base: "",
    rounds: 0,
    worktree: "",
    worktree_dirty: false,
    files: [],
  };
}

/**
 * The track model for a documents-only arc — what every surface passes to the
 * track and the line for one, never `arcTrackModelFromEntry` over the adapted
 * entry.
 *
 * The adapter above carries no `steps`, and with no steps, no stage and no arc
 * the phase ladder reads `review` for every arc that has a plan — including
 * one already half walked. The counts fix that, and they are the wire's own:
 * a plan with one row done and one in progress is being implemented, whether
 * or not a branch exists yet. `steps_begun` is the same field the row's
 * gesture keys off, so the track and the button agree by construction.
 *
 * An arc's own stage still outranks the counts, exactly as the shared ladder
 * has it: it only falls through to the counted rungs when no arc has spoken.
 */
export function documentArcTrackModel(
  entry: DocumentArcEntry,
): ArcTrackModel {
  const base = arcTrackModel({ documents: entry.documents, arc: entry.arc });
  const steps =
    entry.step_total === 0
      ? null
      : {
          total: entry.step_total,
          done: entry.steps_done,
          current:
            entry.steps_begun > entry.steps_done ? entry.steps_done + 1 : null,
          // Always empty here, and honestly so: a document-only arc's wire
          // entry carries counters, never per-row statuses, so the positions
          // are not knowable on this surface. Nor can one arise — `step_in`
          // refuses a withdrawal on an arc with no branch and no live
          // worktree, so a document-only plan cannot acquire a withdrawn row
          // through the verb at all.
          withdrawn: new Set<number>(),
          // A count is all this surface has, so the closed positions are the
          // prefix it implies. That is exactly as much as a counter can say,
          // and with no withdrawals possible here it cannot be wrong.
          closed: new Set(
            Array.from({ length: entry.steps_done }, (_, i) => i + 1),
          ),
        };
  const arc = entry.arc;
  const arcSpoke =
    arc !== undefined &&
    (arc.done === true ||
      arc.stage !== undefined ||
      (arc.stopped !== undefined && arc.stopped_stage !== undefined));
  const begun = steps !== null && (steps.done > 0 || steps.current !== null);
  return {
    ...base,
    phase: !arcSpoke && begun ? "implement" : base.phase,
    steps,
  };
}
