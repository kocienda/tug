/**
 * document-arc-entry — a branchless arc, as the track reads it.
 *
 * A `DocumentArcEntry` is an arc that exists only as documents: a brief, maybe
 * a plan, and no `tugarc/<name>` branch yet. This module turns one into the
 * `ArcTrackModel` every arc surface draws — once, so the Arcs card, the shade,
 * and the session index cannot each invent their own reading.
 *
 * **There is deliberately no adapter to `ArcChangesetEntry` here, and its
 * absence is the point.** One stood here and filled a branch entry's required
 * fields with zeros — `base: ""`, no worktree, no files — which made a
 * branchless arc structurally indistinguishable from a branched one at every
 * call site that took the wider type. Code asking a branch question then got
 * a silent empty answer instead of a compile error, and that is exactly how
 * the Z2 placard came to draw a different strip from the Arcs card for the
 * same arc. Its three callers turned out to want nothing the conversion
 * provided: two computed `arcMetaFacts`, which reads only branch fields and
 * so could only ever return `[]`, and the third passed it to an `unbind` that
 * ignored its argument. If a surface seems to need the conversion again, it
 * is asking a branch question of an arc that has no branch.
 *
 * The line this module holds is what the wire can honestly say. The
 * counters are real: `step_total` / `steps_done` / `steps_begun` are read off
 * the plan's own ledger, so reporting them is reporting. The step *titles* are
 * not on the wire at all, so nothing here synthesizes a `steps` array — a
 * placard that renders titles would be rendering invented ones.
 *
 * @module lib/document-arc-entry
 */

import type { DocumentArcEntry } from "@/lib/changeset-types";
import {
  type ArcTrackModel,
  arcTrackModel,
} from "@/components/tugways/tug-arc-track";

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
 *
 * The recorded kind goes through untouched, because the cell set is its to
 * decide here exactly as it is on a live arc: a plain arc's row is branchless
 * for the whole span between its door and the worktree its implement stage
 * takes, and that is the span where the old document sniff drew it devise and
 * review cells it never had.
 */
export function documentArcTrackModel(
  entry: DocumentArcEntry,
): ArcTrackModel {
  const base = arcTrackModel({
    documents: entry.documents,
    arc: entry.arc,
    arcKind: entry.arc_kind,
  });
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
