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


/** The tones a metadata fact can wear, loudest first. */
export type ArcMetaTone = "danger" | "caution" | "muted" | "subtle";

/** One tone-colored fact on the line, its detail on hover. */
export interface ArcMetaFact {
  key: string;
  label: string;
  tooltip: string;
  tone: ArcMetaTone;
}

/**
 * The lucide glyph a mark draws, named rather than imported.
 *
 * A name and not a component, because this module claims to be JSX-free and a
 * surface that reads only the numbers should not pull lucide in behind them.
 * The component the name stands for is resolved where the mark is drawn.
 */
export type ArcMetaGlyph = "circle-alert" | "triangle-alert" | "circle-check";

/**
 * Which glyph a tone wears when the line draws a mark instead of a sentence
 * ([B01]).
 *
 * Two of the four tones are alerts and the mark says which — a conflict
 * somebody has to resolve takes `CircleAlert`, a warning takes
 * `TriangleAlert`. Everything quieter is a receipt rather than an
 * interruption, so `subtle` (the verified fit) and `muted` alike take
 * `CircleCheck`: the slot is occupied whenever there is a fact at all
 * ([B02]), because an empty slot would mean either "nothing to report" or
 * "verified, all fine" and those are different facts.
 */
const TONE_GLYPHS: Record<ArcMetaTone, ArcMetaGlyph> = {
  danger: "circle-alert",
  caution: "triangle-alert",
  muted: "circle-check",
  subtle: "circle-check",
};

/** {@link TONE_GLYPHS} as a total function — the mark's whole reading. */
export function arcMetaGlyph(tone: ArcMetaTone): ArcMetaGlyph {
  return TONE_GLYPHS[tone];
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
 * `1 file` / `3 files` — the head of every clause that counts paths.
 *
 * One helper because a clause is a sentence: `base overlap (1)` could get
 * away with a parenthesised count, and `1 file also edited on main` cannot.
 */
function fileCount(n: number): string {
  return n === 1 ? "1 file" : `${n} files`;
}

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

/**
 * What is in the arc's way, loudest first — one clause each, in words a
 * person would say aloud ([B07]). Pure, so the ordering and the wording are a
 * table test rather than a DOM one.
 *
 * Four survive of the ten this used to derive, and the other six were deleted
 * rather than filtered, because no surface read them. The arc's own state is
 * not here at all: what the arc is doing is the phase clause's subject
 * (`arcReading`), where it stopped is the red cell on the strip, and the kind
 * is the cell set the strip draws. What is left is the *checkout's* standing
 * against the base, which is the one thing none of those say.
 *
 * A conflicted replay is a state somebody has to resolve, so it leads in
 * danger; base dirt overlapping the arc's own files is a warning about work
 * that is not the machine's to touch; a stale fit is a caution because the
 * tree a join would land is no longer the tree anybody verified; a current
 * fit is the quiet receipt that somebody did.
 *
 * The label is the whole clause and the tooltip is the evidence behind it —
 * the paths, or the two shas. `main` is `entry.base`, spelled as it is; "fit"
 * is `tugtool arc verify`'s word and stays in the hover, because on the line
 * `verified` / `unverified` is the whole of what a reader needs.
 */
export function arcMetaFacts(entry: ArcChangesetEntry): ArcMetaFact[] {
  const facts: ArcMetaFact[] = [];
  const conflicts = entry.replay_conflict_paths ?? [];
  const overlap = entry.base_overlap ?? [];
  const fit = entry.fit;
  if (conflicts.length > 0) {
    facts.push({
      key: "conflicts",
      label: `${fileCount(conflicts.length)} ${conflicts.length === 1 ? "conflicts" : "conflict"} with ${entry.base}`,
      tooltip: `Replaying onto ${entry.base} stops on:\n${pathList(conflicts)}`,
      tone: "danger",
    });
  }
  if (overlap.length > 0) {
    facts.push({
      key: "overlap",
      label: `${fileCount(overlap.length)} also edited on ${entry.base}`,
      tooltip: `Uncommitted work on ${entry.base} touches files this arc changes:\n${pathList(overlap)}`,
      tone: "caution",
    });
  }
  if (fit !== undefined && !fit.current) {
    facts.push({
      key: "fit",
      label: "unverified",
      tooltip: `Verified at ${short(fit.head)} onto ${short(fit.base)}; one of those has moved since.`,
      tone: "caution",
    });
  }
  if (fit !== undefined && fit.current) {
    facts.push({
      key: "fit",
      label: "verified",
      tooltip: `The tree a join would land was verified at ${short(fit.head)} onto ${short(fit.base)}.`,
      tone: "subtle",
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

