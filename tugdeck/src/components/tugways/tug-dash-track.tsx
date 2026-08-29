/**
 * TugDashTrack — a dash's whole life as one cap-height strip.
 *
 * Five cells in lifecycle order — brief · devise · review · implement · join —
 * with implement subdivided into one tick per plan step. A direct dash, which
 * has no arc, is brief · implement · join — the two cells an arc would have
 * filled are the ones it never had. Each cell wears one of four states the CSS
 * paints ([L06]): `pending`, `active`, `done`, `stopped`. A stop
 * is the one fact that outranks the rest: the cell it stopped in paints danger
 * and its tooltip says why, in the arc receipt's own words.
 *
 * The strip is the height of the line's cap, so it rides any line box an atom
 * already sits on — the masthead's title line, the Lens's meta line, the
 * transcript footer's status cell — without growing it. The ring beside it
 * stays the session's own indicator; this is the dash's.
 *
 * The model is derived, never sent: {@link dashTrackModel} reads the fields
 * the changeset feed already carries — `documents`, `arc`, `steps`, `stage` —
 * and {@link dashTrackModelFromEntry} adapts a wire entry to it. Both are pure,
 * so the derivation is a table test rather than a DOM one.
 *
 * Laws: [L06] state is `data-state`; [L19] `.tsx`/`.css` pair, `data-slot`;
 * [L20] composes `TugTooltip`, owns `--tugx-dash-track-*`.
 *
 * @module components/tugways/tug-dash-track
 */

import "./tug-dash-track.css";

import React from "react";

import { TugTooltip } from "./tug-tooltip";
import type { DashArcState, DashChangesetEntry, DashStep } from "@/lib/changeset-types";

/** The phases, in lifecycle order. */
export type DashPhase = "brief" | "devise" | "review" | "implement" | "check" | "join";
export const DASH_PHASES: readonly DashPhase[] = [
  "brief",
  "devise",
  "review",
  "implement",
  "check",
  "join",
];

/**
 * The phases a direct dash draws.
 *
 * A dash with no arc still has a brief: `dash create` is given a topic, and
 * that topic is what the work is against. What it never had is the devising
 * and the reviewing of a plan, so those two are the cells it does not draw.
 *
 * Leading with the ticks made the strip say two wrong things at once — the
 * first tick wore the endcap a whole cell should wear, and the join was left
 * as the one pill on a row of slivers. A brief cell brackets the ticks the way
 * the join does, and it is a fact rather than a spacer.
 *
 * The check cell is drawn on both routes, because both verify: what a run does
 * after its last commit is the same work whoever asked for it.
 */
const DIRECT_PHASES: readonly DashPhase[] = ["brief", "implement", "check", "join"];

/**
 * Each phase as a reading — Title Case, the register every named state in the
 * Z2 status row is set in (`Working`, `Disconnected`, `Waiting`). A cell that
 * spelled its state in lowercase beside four that do not would read as a
 * different kind of instrument.
 *
 * `stopped` is not a phase and has no entry: a stop is a fact ABOUT a phase,
 * and the surfaces that need the word have {@link DashTrackModel.stopped}.
 */
export const DASH_PHASE_LABELS: Record<DashPhase, string> = {
  brief: "Brief",
  devise: "Devise",
  review: "Review",
  implement: "Implement",
  check: "Check",
  join: "Join",
};

export type DashCellState = "pending" | "active" | "done" | "stopped";

/**
 * A tick's state. Only a tick can be withdrawn — a whole phase cannot — so the
 * fifth word rides its own union rather than widening {@link DashCellState}.
 */
export type DashTickState = DashCellState | "withdrawn";

/** What the feed says about a dash, as the derivation reads it. */
export interface DashTrackInput {
  /** Which documents exist. A brief is the planned route's own artifact. */
  documents?: { brief?: string; plan?: string } | undefined;
  /** Whether the plan above is a task list rather than a devised plan. */
  taskList?: boolean | undefined;
  arc?: DashArcState | null | undefined;
  /** The plan's ledger, in source order. */
  steps?: readonly DashStep[] | undefined;
  /** The derived git stage: `created` | `working` | `implementing` | `ready` | `built` | `audited` | `draft-ready` | `joining` | `landing`. */
  stage?: string | null | undefined;
  /**
   * Whether any session holding this dash is still working — mid-turn, or
   * waiting on a job it launched.
   *
   * The git stage says the last round is committed on a clean worktree, which
   * is all `ready` has ever meant; it cannot say whether the run that made
   * those commits has stopped. A test sweep launched after the final commit
   * runs for minutes with the dash reading `ready` the whole time, and the
   * strip lit the join cell over work nobody had finished.
   */
  holdersBusy?: boolean | undefined;
}

export interface DashTrackSteps {
  total: number;
  /**
   * How many steps are **closed** — `done` plus `withdrawn`. A withdrawn step
   * is over, so the fraction and the ticks on screen agree about how much of
   * the plan is behind the run.
   */
  done: number;
  /** The step in progress, 1-based, or null when none is. */
  current: number | null;
  /**
   * The 1-based positions of the withdrawn steps.
   *
   * A count cannot answer which tick is which: closed rows are no longer a
   * prefix, so with step 7 of 8 withdrawn and step 8 done, `done` alone paints
   * all eight alike and the withdrawal disappears.
   */
  withdrawn: ReadonlySet<number>;
  /**
   * The 1-based positions of the `done` steps.
   *
   * The same reason {@link withdrawn} is a set: a run that closes step 5 before
   * step 4 leaves `done` counting two rows that are not the first two, and
   * `n <= done` then paints the step in hand as finished — which is the one
   * reading this strip must never give.
   */
  closed: ReadonlySet<number>;
}

export interface DashTrackModel {
  /**
   * No arc is driving this dash: the work is being done in the user's own
   * conversation, against the task list that session wrote.
   *
   * A direct dash has a plan document like any other — its task list is one —
   * so the presence of a plan cannot tell the two apart. What can is the
   * **brief**, which only the planned route writes, and the arc itself.
   */
  direct: boolean;
  phase: DashPhase;
  /** Why the arc stopped, when it did. */
  stopped: string | null;
  steps: DashTrackSteps | null;
}

/**
 * The stages that mean the work is over and the join is what is left.
 *
 * Read off `stage`, which the server derives, and never off the presence of a
 * `join` record: the join engine computes a state for every dash it can reach,
 * so a dash three steps into its plan carries one too. Presence there says the
 * engine looked, not that the dash is done.
 */
const JOIN_STAGES: ReadonlySet<string> = new Set([
  "ready",
  "built",
  "audited",
  "draft-ready",
  "joining",
  "landing",
]);

export function dashTrackSteps(steps: readonly DashStep[] | undefined): DashTrackSteps | null {
  if (steps === undefined || steps.length === 0) return null;
  let current: number | null = null;
  let done = 0;
  const withdrawn = new Set<number>();
  const closed = new Set<number>();
  steps.forEach((s, i) => {
    if (s.status === "done") {
      done += 1;
      closed.add(i + 1);
    } else if (s.status === "withdrawn") {
      done += 1;
      withdrawn.add(i + 1);
    } else if (s.status === "in progress" && current === null) current = i + 1;
  });
  return { total: steps.length, done, current, withdrawn, closed };
}

/** The model, from what the feed carries. Pure. */
export function dashTrackModel(input: DashTrackInput): DashTrackModel {
  const documents = input.documents ?? {};
  const arc = input.arc ?? null;
  // Direct means no arc is driving, and neither document says otherwise: a
  // brief is the planned route's own artifact, and a plan devised against the
  // skeleton is a plan however it came to be recorded. A task list is not —
  // it is what the working session wrote for itself, and the server tells the
  // two apart by the document's own shape rather than by guessing.
  const direct =
    arc === null &&
    documents.brief === undefined &&
    (documents.plan === undefined || input.taskList === true);
  const steps = dashTrackSteps(input.steps);
  const stage = input.stage ?? null;
  const stopped = arc?.stopped ?? null;
  const begun = steps !== null && (steps.done > 0 || steps.current !== null);
  const walked = steps !== null && steps.done === steps.total;

  let phase: DashPhase;
  // An arc still rotating has not arrived, whatever git says. Between the
  // implement stage's last step and the audit stage being seated, the branch
  // is committed on a clean worktree and every git fact reads joinable — for
  // the seconds it takes the wheel to rotate, and with a whole stage still to
  // run. `holdersBusy` cannot cover that gap, because in it nobody is working.
  const arcRunning = arc !== null && arc.done !== true && arc.stopped === undefined;
  const arrived = (!arcRunning && stage !== null && JOIN_STAGES.has(stage)) || arc?.done === true;
  if (arrived) {
    // Arrived by its git facts, and the run that got it here is still going:
    // the checks a run ends with are the one part of it no commit records.
    phase = input.holdersBusy === true ? "check" : "join";
  } else if (direct) {
    // Before the first step starts there is nothing else to read: a direct
    // dash's plan is its task list, so the plan-means-review arm below would
    // seat it in a phase it does not have.
    phase = walked ? "check" : "implement";
  } else if (stopped !== null && arc?.stopped_stage !== undefined) {
    phase = arcPhase(arc.stopped_stage);
  } else if (arc?.stage !== undefined) {
    phase = walked ? "check" : arcPhase(arc.stage);
  } else if (begun || stage === "implementing") {
    phase = walked ? "check" : "implement";
  } else if (documents.plan !== undefined) {
    phase = "review";
  } else {
    phase = "brief";
  }
  return { direct, phase, stopped, steps };
}

function arcPhase(stage: string): DashPhase {
  // The arc's audit stage is the check cell: what it does — read the code
  // against the plan and fix what does not match — is the verification a
  // direct dash does for itself in the same place on the strip.
  if (stage === "audit") return "check";
  return stage === "devise" || stage === "review" || stage === "implement" ? stage : "implement";
}

/** {@link dashTrackModel} over a wire entry. */
export function dashTrackModelFromEntry(entry: DashChangesetEntry): DashTrackModel {
  return dashTrackModel({
    documents: entry.documents,
    arc: entry.arc,
    taskList: entry.task_list,
    steps: entry.steps,
    stage: entry.stage,
    holdersBusy: entry.holders_busy,
  });
}

/** The state one cell wears under the model. */
export function dashCellState(model: DashTrackModel, phase: DashPhase): DashCellState {
  const at = DASH_PHASES.indexOf(phase);
  const now = DASH_PHASES.indexOf(model.phase);
  if (at === now) return model.stopped !== null ? "stopped" : "active";
  return at < now ? "done" : "pending";
}

export function tickState(model: DashTrackModel, n: number): DashTickState {
  const steps = model.steps!;
  if (steps.withdrawn.has(n)) return "withdrawn";
  // The step in hand outranks the closed reading. Both are positional facts
  // off the ledger, so they cannot disagree about a truthful one — but a
  // ledger that does disagree is one where somebody is working the step, and
  // that is the reading to show.
  if (n === steps.current) return model.stopped !== null ? "stopped" : "active";
  if (steps.closed.has(n)) return "done";
  return "pending";
}

function cellTip(model: DashTrackModel, phase: DashPhase, state: DashCellState): string {
  const word =
    phase === "implement" && model.steps !== null
      ? `implement · ${model.steps.done} of ${model.steps.total} steps closed`
      : phase;
  return state === "stopped" ? `${word} — stopped: ${model.stopped}` : `${word} · ${state}`;
}

export interface TugDashTrackProps {
  model: DashTrackModel;
  /** `rail` beside other rails (the Lens, the footer); `read` on a reading surface. */
  size?: "rail" | "read";
  "aria-label"?: string;
}

export function TugDashTrack({
  model,
  size = "rail",
  "aria-label": ariaLabel,
}: TugDashTrackProps): React.ReactElement {
  // The track draws the phases the dash has, never the five with two struck
  // out: a direct dash did not skip devise and review, it never had them. It
  // did have a brief, so it draws one.
  const phases: readonly DashPhase[] = model.direct ? DIRECT_PHASES : DASH_PHASES;
  return (
    <span
      className="tug-dash-track"
      data-slot="tug-dash-track"
      data-size={size}
      data-phase={model.phase}
      data-direct={model.direct ? "true" : undefined}
      data-stopped={model.stopped !== null ? "true" : undefined}
      aria-label={ariaLabel ?? cellTip(model, model.phase, dashCellState(model, model.phase))}
    >
      {phases.map((phase) => {
        const state = dashCellState(model, phase);
        const ticks =
          phase === "implement" && model.steps !== null
            ? Array.from({ length: model.steps.total }, (_, i) => i + 1)
            : null;
        return (
          <TugTooltip key={phase} content={cellTip(model, phase, state)}>
            <span
              className="tug-dash-track-cell"
              data-slot="tug-dash-track-cell"
              data-phase={phase}
              data-state={state}
              data-steps={ticks !== null ? "true" : undefined}
            >
              {ticks !== null
                ? ticks.map((n) => (
                    <span key={n} className="tug-dash-track-tick" data-state={tickState(model, n)} />
                  ))
                : null}
            </span>
          </TugTooltip>
        );
      })}
    </span>
  );
}
