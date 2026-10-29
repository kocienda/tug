/**
 * arc-meta-facts — what an arc's wire entry says about itself, as data.
 *
 * The pure derivations behind every arc surface's metadata reading: the four
 * tone-colored clauses saying what is in the arc's way, the step fraction the
 * row shows, and whether the declared walk is complete. What the arc is
 * *doing* is not here — that is `arcReading`, one clause derived once, and
 * these are what follows it. No JSX and no CSS, so a surface that needs only
 * the numbers — the masthead, the footer's accessible label — reads them
 * without pulling a component's stylesheet in behind them.
 *
 * @module lib/arc-meta-facts
 */

import type { ArcChangesetEntry } from "@/lib/changeset-types";

/**
 * What a planned arc's kind MEANS, in one sentence.
 *
 * The Devise cell of the track is the one place it is said: the strip already
 * draws the kind as its cell set, so the word is not a clause on the line,
 * and the sentence lives on the cell a reader hovers when they wonder why
 * this arc has six cells and another has four.
 */
export const PLANNED_KIND_SENTENCE =
  "Devised a plan and had it reviewed cold before the first step was walked.";

/** The stages where a full counter means the walk is OVER rather than the
 *  last step being worked — `implementing (12/12)` is still step twelve. */
const STAGES_PAST_THE_WALK = new Set([
  // A declared run whose final step is done reads `ready` ([D147]) — the
  // stage a finished walk rests at when nobody ever typed `mark built`.
  "ready",
  "built",
  "audited",
  // An audit the head or base has moved out from under: the walk is still
  // over, only the audit needs doing again.
  "audit-stale",
  "draft-ready",
  "joining",
  "landing",
]);

/**
 * Whether every step landed — the reading that turns the ring success. Pure,
 * so it is a table test. A full counter alone is not enough: on a stage still
 * inside the walk it means the last step is being worked, not finished.
 *
 * Two spellings of the same fact arrive at this question — the wire entry's
 * `step_current` and the session index's `stepCurrent` — so the rule takes
 * the bare values and each caller hands in its own.
 */
export function arcWalkComplete(
  stage: string | null | undefined,
  current: number | null | undefined,
  total: number | null | undefined,
): boolean {
  if (current === undefined || current === null) return false;
  if (total === undefined || total === null) return false;
  return current >= total && stage != null && STAGES_PAST_THE_WALK.has(stage);
}

/**
 * The pair the numerals render: the declared run's when the sender has one,
 * else the plan's.
 *
 * Two questions share one row, and this decides which the six characters
 * answer. A run of steps 5–7 was *asked for* as three steps, so it counts
 * `2/3`; the plan's own `6/10` is not lost — it is what the ring draws its
 * segments from, with this span lit across it. A generation that declared no
 * run (every arc-log written before runs were declared) has only the plan
 * pair, and falls back to exactly what it showed before.
 *
 * Takes bare values rather than an entry because two spellings arrive: the
 * wire's `run_position` and the session index's `runPosition`. Null when
 * neither pair is declared, which is how a counter renders nothing at all.
 */
export function arcGlanceFraction(
  runPosition: number | null | undefined,
  runLength: number | null | undefined,
  stepCurrent: number | null | undefined,
  stepTotal: number | null | undefined,
): { current: number; total: number } | null {
  if (
    runPosition !== undefined &&
    runPosition !== null &&
    runLength !== undefined &&
    runLength !== null
  ) {
    return { current: runPosition, total: runLength };
  }
  if (
    stepCurrent !== undefined &&
    stepCurrent !== null &&
    stepTotal !== undefined &&
    stepTotal !== null
  ) {
    return { current: stepCurrent, total: stepTotal };
  }
  return null;
}

/** {@link arcGlanceFraction} over a wire entry. */
export function arcEntryGlanceFraction(
  entry: ArcChangesetEntry,
): { current: number; total: number } | null {
  return arcGlanceFraction(
    entry.run_position,
    entry.run_length,
    entry.step_current,
    entry.step_total,
  );
}

/**
 * The run's span within the plan, for the ring's scope band — `undefined` when
 * no run is declared, which is what leaves the ring rendering as it always has.
 *
 * Derived rather than sent: the wire carries the run's position and length and
 * the plan's current step, and the run's first step is the one arithmetic that
 * follows from them. Sending a fourth number to say the same thing would give
 * the two a way to disagree.
 */
export function arcRunScope(
  runPosition: number | null | undefined,
  runLength: number | null | undefined,
  stepCurrent: number | null | undefined,
  stepTotal: number | null | undefined,
): { from: number; through: number } | undefined {
  if (
    runPosition === undefined ||
    runPosition === null ||
    runLength === undefined ||
    runLength === null ||
    stepCurrent === undefined ||
    stepCurrent === null ||
    stepTotal === undefined ||
    stepTotal === null
  ) {
    return undefined;
  }
  const from = stepCurrent - runPosition + 1;
  const through = from + runLength - 1;
  if (from < 1 || through > stepTotal) return undefined;
  return { from, through };
}

/** {@link arcWalkComplete} over a wire entry, against the pair it shows. */
export function arcStepsComplete(entry: ArcChangesetEntry): boolean {
  const glance = arcEntryGlanceFraction(entry);
  return arcWalkComplete(entry.stage, glance?.current, glance?.total);
}

/**
 * An arc's standing against its base, as the verb row reads it — whether a
 * replay has anything to do, and whether there is a range to diff. Null for
 * an arc that is documents alone, which has no base to stand against.
 */
export interface ArcBranchFacts {
  base: string;
  base_ahead?: number;
  worktree_dirty: boolean;
  replay_conflict_paths?: string[];
  /** Whether there is anything past the base to diff. */
  hasRange: boolean;
}

/** {@link ArcBranchFacts} off a wire entry. */
export function arcBranchFacts(entry: ArcChangesetEntry): ArcBranchFacts {
  return {
    base: entry.base,
    ...(entry.base_ahead !== undefined ? { base_ahead: entry.base_ahead } : {}),
    worktree_dirty: entry.worktree_dirty,
    ...(entry.replay_conflict_paths !== undefined
      ? { replay_conflict_paths: entry.replay_conflict_paths }
      : {}),
    // An arc with nothing past its base and a clean worktree has no range: a
    // diff of it would open an empty card.
    hasRange: entry.rounds > 0 || entry.worktree_dirty,
  };
}

