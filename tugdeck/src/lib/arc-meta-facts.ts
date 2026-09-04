/**
 * arc-meta-facts — what an arc's wire entry says about itself, as data.
 *
 * The pure derivations behind every arc surface's metadata reading: the
 * tone-colored divergence facts, the step fraction the row shows, whether the
 * declared walk is complete, and the note's lead. No JSX and no CSS, so a
 * surface that needs only the numbers — the masthead, the footer's accessible
 * label — reads them without pulling a component's stylesheet in behind them.
 *
 * @module lib/arc-meta-facts
 */

import type { ArcChangesetEntry } from "@/lib/changeset-types";


/** The tones a metadata fact can wear, loudest first. */
export type ArcMetaTone = "danger" | "caution" | "muted" | "subtle";

/** One tone-colored fact on the line, its detail on hover. */
export interface ArcMetaFact {
  key: string;
  label: string;
  tooltip: string;
  tone: ArcMetaTone;
}

/** At most this many paths in a fact's tooltip; the count carries the rest. */
const FACT_TOOLTIP_PATHS = 8;

/** A sha as a tooltip shows it. */
function short(sha: string): string {
  return sha.slice(0, 9);
}

function pathList(paths: ReadonlyArray<string>): string {
  const shown = paths.slice(0, FACT_TOOLTIP_PATHS).join("\n");
  const rest = paths.length - FACT_TOOLTIP_PATHS;
  return rest > 0 ? `${shown}\n…and ${rest} more` : shown;
}

/**
 * What a planned arc's kind MEANS, in one sentence. The kind fact carries it,
 * and so does the Devise cell of the track: the lifecycle line drops the fact
 * (the strip already draws the kind as its cell set), so the sentence lives
 * on the cell a reader hovers when they wonder why this arc has six cells and
 * another has four.
 */
export const PLANNED_KIND_SENTENCE =
  "Devised a plan and had it reviewed cold before the first step was walked.";

/**
 * The line's tone-colored facts, most urgent first — pure, so the ordering
 * and the wording are a table test rather than a DOM one.
 *
 * A stopped arc leads: it is the one fact on the line that means *nothing is
 * advancing this arc and nobody has been told* — the arc rotates on a server
 * tick, so unlike every other fact here there is no gesture whose absence
 * explains the stillness. A running arc says so quietly at the other end,
 * because a stage in flight is the ordinary case and needs no urgency; the
 * arc's terminal `done` says nothing at all, since the join offer is what
 * speaks then ([P12]).
 *
 * A conflicted replay is a state somebody has to resolve; base dirt
 * overlapping the arc's own files is a warning about work that is not the
 * machine's to touch; uncommitted worktree bytes are ordinary mid-run and
 * worth a quiet word; being behind is usually transient (the engine is
 * probably replaying as you read); a settled replay is the quiet receipt that
 * history moved under this arc and nothing asked you about it.
 *
 * The recorded kind comes last, quietest of all: it is a standing property of
 * the arc rather than anything about its present state, so it yields to every
 * fact that describes what is happening now. Only `planned` is said. Plain is
 * the unmarked kind, in prose and here alike, and an absent kind means the
 * record does not say — never that it is plain.
 */
export function arcMetaFacts(entry: ArcChangesetEntry): ArcMetaFact[] {
  const facts: ArcMetaFact[] = [];
  const conflicts = entry.replay_conflict_paths ?? [];
  const overlap = entry.base_overlap ?? [];
  const ahead = entry.base_ahead ?? 0;
  const settled = entry.last_replay;
  const fit = entry.fit;
  const arc = entry.arc;
  if (arc !== undefined && arc.stopped !== undefined) {
    const stage = arc.stopped_stage ?? arc.stage;
    facts.push({
      key: "arc-stopped",
      label: stage !== undefined ? `arc stopped · ${stage}` : "arc stopped",
      // The fact, and only the fact. It used to end by naming the CLI verb,
      // which is implementation leaking into something the user reads — the
      // resume is the **Resume** button on the stop's own receipt ([B09]).
      tooltip: `The arc stopped${stage !== undefined ? ` in its ${stage} stage` : ""}: ${arc.stopped}`,
      tone: "danger",
    });
  }
  if (conflicts.length > 0) {
    facts.push({
      key: "conflicts",
      label: `replay conflicts (${conflicts.length})`,
      tooltip: `Replaying this arc onto ${entry.base} conflicts in:\n${pathList(conflicts)}`,
      tone: "danger",
    });
  }
  if (overlap.length > 0) {
    facts.push({
      key: "overlap",
      label: `base overlap (${overlap.length})`,
      tooltip: `Uncommitted work on ${entry.base} touches files this arc also changes:\n${pathList(overlap)}`,
      tone: "caution",
    });
  }
  if (fit !== undefined && !fit.current) {
    facts.push({
      key: "fit",
      label: "fit unverified",
      tooltip: `The fit was verified at ${short(fit.head)} onto ${short(fit.base)}; one of those has moved since.\nVerify it again with \`tugtool arc verify ${entry.display_name}\`.`,
      tone: "caution",
    });
  }
  if (entry.worktree_dirty) {
    facts.push({
      key: "uncommitted",
      label: "uncommitted",
      tooltip: "The arc worktree has uncommitted changes.",
      tone: "muted",
    });
  }
  if (ahead > 0) {
    facts.push({
      key: "behind",
      label: `base +${ahead}`,
      tooltip: `${entry.base} has gained ${ahead === 1 ? "1 commit" : `${ahead} commits`} this arc does not have yet.`,
      tone: "muted",
    });
  }
  if (
    ahead === 0 &&
    conflicts.length === 0 &&
    settled !== undefined &&
    settled !== ""
  ) {
    facts.push({
      key: "replayed",
      label: "replayed",
      tooltip: `Replayed ${settled}`,
      tone: "subtle",
    });
  }
  if (fit !== undefined && fit.current) {
    facts.push({
      key: "fit",
      label: "fit verified",
      tooltip: `The tree a join would land was verified at ${short(fit.head)} onto ${short(fit.base)}.`,
      tone: "subtle",
    });
  }
  if (
    arc !== undefined &&
    arc.stopped === undefined &&
    arc.done !== true &&
    arc.stage !== undefined
  ) {
    facts.push({
      key: "arc",
      label: `arc · ${arc.stage}`,
      tooltip:
        `This arc is running; its ${arc.stage} stage is in flight.` +
        (arc.note !== undefined ? `\nLatest: ${arc.note}` : ""),
      tone: "subtle",
    });
  }
  if (entry.arc_kind === "planned") {
    facts.push({
      key: "kind",
      label: "planned",
      tooltip: PLANNED_KIND_SENTENCE,
      tone: "muted",
    });
  }
  return facts;
}

/** The stages where a full counter means the walk is OVER rather than the
 *  last step being worked — `implementing (12/12)` is still step twelve. */
const STAGES_PAST_THE_WALK = new Set([
  // A declared run whose final step is done reads `ready` ([D147]) — the
  // stage a finished walk rests at when nobody ever typed `mark built`.
  "ready",
  "built",
  "audited",
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

/** The note's lead: the current step's title, else the join draft's subject.
 *  Null means the line says nothing there (the no-plan case says so aloud). */
export function arcMetaNote(entry: ArcChangesetEntry): string | null {
  if (entry.step_title !== undefined && entry.step_title.length > 0) {
    return entry.step_title;
  }
  const subject = entry.draft?.message.split("\n", 1)[0]?.trim() ?? "";
  return subject.length > 0 ? subject : null;
}
