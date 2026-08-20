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

function pathList(paths: ReadonlyArray<string>): string {
  const shown = paths.slice(0, FACT_TOOLTIP_PATHS).join("\n");
  const rest = paths.length - FACT_TOOLTIP_PATHS;
  return rest > 0 ? `${shown}\n…and ${rest} more` : shown;
}

/**
 * The line's tone-colored facts, most urgent first — pure, so the ordering
 * and the wording are a table test rather than a DOM one.
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
  return facts;
}

/** The stages where a full counter means the walk is OVER rather than the
 *  last step being worked — `implementing (12/12)` is still step twelve. */
const STAGES_PAST_THE_WALK = new Set([
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

/** {@link dashWalkComplete} over a wire entry. */
export function dashStepsComplete(entry: DashChangesetEntry): boolean {
  return dashWalkComplete(entry.stage, entry.step_current, entry.step_total);
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

export function DashMetaLine({
  entry,
}: {
  entry: DashChangesetEntry;
}): React.ReactElement {
  const counted =
    entry.step_current !== undefined && entry.step_total !== undefined;
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
    >
      {counted ? (
        worker !== null ? (
          <SessionStepRing
            sessionId={worker}
            current={entry.step_current!}
            total={entry.step_total!}
            complete={complete}
          />
        ) : (
          <TugStepRing
            current={entry.step_current!}
            total={entry.step_total!}
            complete={complete}
          />
        )
      ) : null}
      {entry.stage !== undefined ? <DashStageMark stage={entry.stage} /> : null}
      {counted ? (
        <TugStepFraction
          current={entry.step_current!}
          total={entry.step_total!}
        />
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
