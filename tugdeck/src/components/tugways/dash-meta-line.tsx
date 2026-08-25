/**
 * DashMetaLine — everything a dash is DOING, in one controlled line.
 *
 * The one metadata grammar every collapsed dash surface wears:
 *
 *   ring · stage icon · count · note · age · divergence facts
 *
 * The Lens's Dashes section renders it under each dash's eyebrow, and the
 * Changes shade's collapsed dash row renders the same element under the
 * worker's atom — one language in both places, so a reader who learned the
 * line once has learned it everywhere. The eyebrow above it holds the
 * IDENTITIES (the dash atom, the worker); this line holds the WORK.
 *
 * One language, two scales. The Lens renders the rail scale (`2xs`), a fact
 * glanced at beside other rails; the shade renders the reading scale (`sm`),
 * because the shade is the surface you came to read and a line a step smaller
 * than the register beneath it reads as a footnote to its own block.
 *
 * The ring is phase-toned when a live session is on the dash (the first bound
 * session's phase, through {@link SessionStepRing}) and quiet otherwise; a
 * plan fully walked reads success either way. The stage is a glyph with its
 * word on hover; the note is the current step's title, else the join draft's
 * subject, else the honest "no plan adopted". The divergence facts are
 * tone-colored words, most urgent first, each carrying its detail on hover.
 *
 * Laws: [L02] callers hand in the entry their own subscription produced;
 * [L06] tones are `data-tone` attributes the CSS paints; [L19] `.tsx`/`.css`
 * pair, `data-slot`; [L20] composes the ring, mark, and fraction components.
 *
 * @module components/tugways/dash-meta-line
 */

import "./dash-meta-line.css";

import React from "react";

import { DashStageMark } from "./dash-stage-mark";
import { SessionStepRing } from "./session-step-ring";
import { TugStepRing, TugStepFraction } from "./tug-step-ring";
import { TugTooltip } from "./tug-tooltip";
import { formatDashAge } from "@/lib/dash-age";
import type { DashChangesetEntry } from "@/lib/changeset-types";

/** The tones a metadata fact can wear, loudest first. */
export type DashMetaTone = "danger" | "caution" | "muted" | "subtle";

/** One tone-colored fact on the line, its detail on hover. */
export interface DashMetaFact {
  key: string;
  label: string;
  tooltip: string;
  tone: DashMetaTone;
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
 * The line's tone-colored facts, most urgent first — pure, so the ordering
 * and the wording are a table test rather than a DOM one.
 *
 * A stopped arc leads: it is the one fact on the line that means *nothing is
 * advancing this dash and nobody has been told* — the arc rotates on a server
 * tick, so unlike every other fact here there is no gesture whose absence
 * explains the stillness. A running arc says so quietly at the other end,
 * because a stage in flight is the ordinary case and needs no urgency; the
 * arc's terminal `done` says nothing at all, since the join offer is what
 * speaks then ([P12]).
 *
 * A conflicted replay is a state somebody has to resolve; base dirt
 * overlapping the dash's own files is a warning about work that is not the
 * machine's to touch; uncommitted worktree bytes are ordinary mid-run and
 * worth a quiet word; being behind is usually transient (the engine is
 * probably replaying as you read); a settled replay is the quiet receipt that
 * history moved under this dash and nothing asked you about it.
 */
export function dashMetaFacts(entry: DashChangesetEntry): DashMetaFact[] {
  const facts: DashMetaFact[] = [];
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
      tooltip: `The arc stopped${stage !== undefined ? ` in its ${stage} stage` : ""}: ${arc.stopped}\nResume it with \`tugutil dash run ${entry.display_name}\`.`,
      tone: "danger",
    });
  }
  if (conflicts.length > 0) {
    facts.push({
      key: "conflicts",
      label: `replay conflicts (${conflicts.length})`,
      tooltip: `Replaying this dash onto ${entry.base} conflicts in:\n${pathList(conflicts)}`,
      tone: "danger",
    });
  }
  if (overlap.length > 0) {
    facts.push({
      key: "overlap",
      label: `base overlap (${overlap.length})`,
      tooltip: `Uncommitted work on ${entry.base} touches files this dash also changes:\n${pathList(overlap)}`,
      tone: "caution",
    });
  }
  if (fit !== undefined && !fit.current) {
    facts.push({
      key: "fit",
      label: "fit unverified",
      tooltip: `The fit was verified at ${short(fit.head)} onto ${short(fit.base)}; one of those has moved since.\nVerify it again with \`tugutil dash verify ${entry.display_name}\`.`,
      tone: "caution",
    });
  }
  if (entry.worktree_dirty) {
    facts.push({
      key: "uncommitted",
      label: "uncommitted",
      tooltip: "The dash worktree has uncommitted changes.",
      tone: "muted",
    });
  }
  if (ahead > 0) {
    facts.push({
      key: "behind",
      label: `base +${ahead}`,
      tooltip: `${entry.base} has gained ${ahead === 1 ? "1 commit" : `${ahead} commits`} this dash does not have yet.`,
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
      tooltip: `A dash arc is running this dash; its ${arc.stage} stage is in flight.`,
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
export function dashWalkComplete(
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
 * run (every dash-log written before runs were declared) has only the plan
 * pair, and falls back to exactly what it showed before.
 *
 * Takes bare values rather than an entry because two spellings arrive: the
 * wire's `run_position` and the session index's `runPosition`. Null when
 * neither pair is declared, which is how a counter renders nothing at all.
 */
export function dashGlanceFraction(
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

/** {@link dashGlanceFraction} over a wire entry. */
export function dashEntryGlanceFraction(
  entry: DashChangesetEntry,
): { current: number; total: number } | null {
  return dashGlanceFraction(
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
export function dashRunScope(
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

/** {@link dashWalkComplete} over a wire entry, against the pair it shows. */
export function dashStepsComplete(entry: DashChangesetEntry): boolean {
  const glance = dashEntryGlanceFraction(entry);
  return dashWalkComplete(entry.stage, glance?.current, glance?.total);
}

/** The note's lead: the current step's title, else the join draft's subject.
 *  Null means the line says nothing there (the no-plan case says so aloud). */
export function dashMetaNote(entry: DashChangesetEntry): string | null {
  if (entry.step_title !== undefined && entry.step_title.length > 0) {
    return entry.step_title;
  }
  const subject = entry.draft?.message.split("\n", 1)[0]?.trim() ?? "";
  return subject.length > 0 ? subject : null;
}

/** The read scale's marks: the miniature ring and the stage glyph, each a
 *  step up from the rail defaults so they sit on an `sm` line box. */
const READ_RING_BOX = 16;
const READ_STAGE_SIZE = 15;

export function DashMetaLine({
  entry,
  size = "2xs",
}: {
  entry: DashChangesetEntry;
  /**
   * The line's type scale. `2xs` is the rail's — a fact glanced at in the
   * Lens beside other rails. `sm` is the reading scale, for a surface whose
   * whole job is to be read (the Changes shade): the marks step up with the
   * type so the line stays one system.
   */
  size?: "2xs" | "sm";
}): React.ReactElement {
  const read = size === "sm";
  const counted =
    entry.step_current !== undefined && entry.step_total !== undefined;
  // The numerals count the declared run; the ring keeps the plan's pair and
  // lights the run's span across it.
  const glance = dashEntryGlanceFraction(entry);
  const scope = dashRunScope(
    entry.run_position,
    entry.run_length,
    entry.step_current,
    entry.step_total,
  );
  const complete = dashStepsComplete(entry);
  const worker = (entry.bound_sessions ?? [])[0] ?? null;
  const note = dashMetaNote(entry);
  // Read at render, with no ticker: the value changes at most hourly at these
  // units, and the aggregate's own recompute repaints the line.
  const age = formatDashAge(entry.last_activity ?? null, Date.now());
  return (
    <span
      className="tug-dash-meta-line"
      data-slot="tug-dash-meta-line"
      data-dash={entry.display_name}
      data-size={size}
    >
      {counted ? (
        worker !== null ? (
          <SessionStepRing
            sessionId={worker}
            current={entry.step_current!}
            total={entry.step_total!}
            complete={complete}
            {...(scope !== undefined ? { scope } : {})}
            {...(read ? { size: READ_RING_BOX } : {})}
          />
        ) : (
          <TugStepRing
            current={entry.step_current!}
            total={entry.step_total!}
            complete={complete}
            {...(scope !== undefined ? { scope } : {})}
            {...(read ? { size: READ_RING_BOX } : {})}
          />
        )
      ) : null}
      {entry.stage !== undefined ? (
        <DashStageMark
          stage={entry.stage}
          {...(read ? { size: READ_STAGE_SIZE } : {})}
        />
      ) : null}
      {glance !== null ? (
        <TugStepFraction current={glance.current} total={glance.total} />
      ) : null}
      {note !== null ? (
        <span className="tug-dash-meta-note">{note}</span>
      ) : entry.plan_path === undefined ? (
        <span className="tug-dash-meta-note" data-empty="true">
          no plan adopted
        </span>
      ) : null}
      {age !== null ? <span className="tug-dash-meta-age">{age}</span> : null}
      {dashMetaFacts(entry).map((fact) => (
        <TugTooltip key={fact.key} content={fact.tooltip}>
          <span
            className="tug-dash-meta-fact"
            data-slot="tug-dash-meta-fact"
            data-fact={fact.key}
            data-tone={fact.tone}
          >
            {fact.label}
          </span>
        </TugTooltip>
      ))}
    </span>
  );
}
