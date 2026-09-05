/**
 * TugArcTrack — an arc's whole life as one cap-height strip.
 *
 * Five cells in lifecycle order — brief · devise · review · implement · join —
 * with implement subdivided into one tick per plan step. That is a planned arc.
 * A plain arc — the short one — is brief · implement · join: the two cells a
 * settling would have filled are the ones it never had. Each cell wears one of
 * four states the CSS paints ([L06]): `pending`, `active`, `done`, `stopped`.
 * A stop is the one fact that outranks the rest: the cell it stopped in paints
 * danger and its tooltip says why, in the arc receipt's own words.
 *
 * The strip is the height of the line's cap, so it rides any line box an atom
 * already sits on — the masthead's title line, the rail's meta line, the
 * transcript footer's status cell — without growing it. The ring beside it
 * stays the session's own indicator; this is the arc's.
 *
 * The model is derived, never sent: {@link arcTrackModel} reads the fields
 * the changeset feed already carries — `documents`, `arc`, `steps`, `stage` —
 * and {@link arcTrackModelFromEntry} adapts a wire entry to it. Both are pure,
 * so the derivation is a table test rather than a DOM one.
 *
 * Laws: [L06] state is `data-state`; [L19] `.tsx`/`.css` pair, `data-slot`;
 * [L20] composes `TugTooltip`, owns `--tugx-arc-track-*`.
 *
 * @module components/tugways/tug-arc-track
 */

import "./tug-arc-track.css";

import React from "react";

import { TugTooltip } from "./tug-tooltip";
import type { ArcRunState, ArcChangesetEntry, ArcStep } from "@/lib/changeset-types";
import { PLANNED_KIND_SENTENCE } from "@/lib/arc-meta-facts";

/** The phases, in lifecycle order. */
export type ArcPhase = "brief" | "devise" | "review" | "implement" | "audit" | "join";
export const ARC_PHASES: readonly ArcPhase[] = [
  "brief",
  "devise",
  "review",
  "implement",
  "audit",
  "join",
];

/**
 * The phases a direct arc draws.
 *
 * An arc with no arc still has a brief: `arc create` is given a topic, and
 * that topic is what the work is against. What it never had is the devising
 * and the reviewing of a plan, so those two are the cells it does not draw.
 *
 * Leading with the ticks made the strip say two wrong things at once — the
 * first tick wore the endcap a whole cell should wear, and the join was left
 * as the one pill on a row of slivers. A brief cell brackets the ticks the way
 * the join does, and it is a fact rather than a spacer.
 *
 * The audit cell is drawn on both routes, because both verify: what a run does
 * after its last commit is the same work whoever asked for it.
 */
const DIRECT_PHASES: readonly ArcPhase[] = [
  "brief",
  "implement",
  "audit",
  "join",
];

export type ArcCellState = "pending" | "active" | "done" | "stopped";

/**
 * A tick's state. Only a tick can be withdrawn — a whole phase cannot — so the
 * fifth word rides its own union rather than widening {@link ArcCellState}.
 */
export type ArcTickState = ArcCellState | "withdrawn";

/** What the feed says about an arc, as the derivation reads it. */
export interface ArcTrackInput {
  /** Which documents exist. */
  documents?: { brief?: string; plan?: string } | undefined;
  /** Whether the plan above is a task list rather than a devised plan. */
  taskList?: boolean | undefined;
  /**
   * The arc's **recorded** kind, as its log wrote it when it opened. This is
   * what decides the cell set: `planned` draws the six, `plain` draws the
   * four, whatever the documents happen to say. Absent means the record does
   * not say — a pre-kind arc — and only then is the cell set derived.
   */
  arcKind?: "plain" | "planned" | undefined;
  arc?: ArcRunState | null | undefined;
  /** The plan's ledger, in source order. */
  steps?: readonly ArcStep[] | undefined;
  /** The derived git stage: `created` | `working` | `implementing` | `ready` | `built` | `audited` | `draft-ready` | `joining` | `landing`. */
  stage?: string | null | undefined;
  /**
   * Whether any session holding this arc is still working — mid-turn, or
   * waiting on a job it launched.
   *
   * The git stage says the last round is committed on a clean worktree, which
   * is all `ready` has ever meant; it cannot say whether the run that made
   * those commits has stopped. A test sweep launched after the final commit
   * runs for minutes with the arc reading `ready` the whole time, and the
   * strip lit the join cell over work nobody had finished.
   */
  holdersBusy?: boolean | undefined;
}

export interface ArcTrackSteps {
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

export interface ArcTrackModel {
  /**
   * No arc is driving this arc: the work is being done in the user's own
   * conversation, against the task list that session wrote.
   *
   * This is the *hand-worked* axis, and it is not the kind: it decides which
   * phase an arc reads as, never how many cells the strip draws. See
   * {@link planned} for the cell set, which the record answers directly.
   */
  direct: boolean;
  /**
   * Whether the strip draws the devise and review cells — the only two the
   * kinds differ by.
   *
   * Taken from the arc's recorded kind, which is the fact itself rather than
   * a reading of one. It used to be inferred from `direct`, on the premise
   * that a brief was the planned route's own artifact; both doors write a
   * brief now, and a wheel-driven arc always has a run record, so that
   * inference marked every arc planned and drew a plain one two cells it
   * never had. An arc whose log predates the record still falls back to it,
   * which is the only place the old derivation survives.
   */
  planned: boolean;
  phase: ArcPhase;
  /** Why the arc stopped, when it did. */
  stopped: string | null;
  /**
   * The stop's own sentence — the English for {@link stopped}'s log word,
   * composed server-side so no face keeps a second table of a vocabulary the
   * compiler already closes ([B06]). The line says the word; a hover says
   * this. `null` when the arc has not stopped, and for a word an older
   * server sent without its sentence.
   */
  stoppedWhy: string | null;
  /**
   * Whether anybody is working this arc right now — a run in flight, or a
   * holder mid-turn.
   *
   * Read by the two phases that are things done *to* an arc rather than by
   * it ([B04]): review and audit can sit for days with nobody reading the
   * plan, and without this bit the line said `Reviewing` over exactly that.
   * Every other phase reads the same live or at rest — implement between
   * turns is still implementing.
   */
  live: boolean;
  steps: ArcTrackSteps | null;
}

/**
 * The stages that mean the work is over and the join is what is left.
 *
 * Read off `stage`, which the server derives, and never off the presence of a
 * `join` record: the join engine computes a state for every arc it can reach,
 * so an arc three steps into its plan carries one too. Presence there says the
 * engine looked, not that the arc is done.
 */
const JOIN_STAGES: ReadonlySet<string> = new Set([
  "ready",
  "built",
  "audited",
  "draft-ready",
  "joining",
  "landing",
]);

export function arcTrackSteps(steps: readonly ArcStep[] | undefined): ArcTrackSteps | null {
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
export function arcTrackModel(input: ArcTrackInput): ArcTrackModel {
  const documents = input.documents ?? {};
  const arc = input.arc ?? null;
  // Direct means no arc is driving and neither document says otherwise: a
  // plan devised against the skeleton is a plan however it came to be
  // recorded, while a task list is what a working session wrote for itself,
  // and the server tells the two apart by the document's own shape. This
  // decides the phase arm below and nothing else — the cell set reads the
  // recorded kind, because a brief no longer distinguishes the routes.
  const direct =
    arc === null &&
    documents.brief === undefined &&
    (documents.plan === undefined || input.taskList === true);
  // The recorded kind answers the cell set outright. Only an arc whose log
  // never wrote one falls through to `direct`, which is the pre-kind arc's
  // fallback and the last place that inference is trusted.
  const planned = input.arcKind !== undefined ? input.arcKind === "planned" : !direct;
  const steps = arcTrackSteps(input.steps);
  const stage = input.stage ?? null;
  const stopped = arc?.stopped ?? null;
  const stoppedWhy = arc?.stopped_why ?? null;
  const begun = steps !== null && (steps.done > 0 || steps.current !== null);
  const walked = steps !== null && steps.done === steps.total;

  let phase: ArcPhase;
  // An arc still rotating has not arrived, whatever git says. Between the
  // implement stage's last step and the audit stage being seated, the branch
  // is committed on a clean worktree and every git fact reads joinable — for
  // the seconds it takes the wheel to rotate, and with a whole stage still to
  // run. `holdersBusy` cannot cover that gap, because in it nobody is working.
  const arcRunning = arc !== null && arc.done !== true && arc.stopped === undefined;
  const arrived = (!arcRunning && stage !== null && JOIN_STAGES.has(stage)) || arc?.done === true;
  // The same two facts `arrived` is told from, read the other way round: one
  // says the arc has got where it is going, this says somebody is moving it.
  const live = arcRunning || input.holdersBusy === true;
  // A stop is a fact about the phase it happened in, and the record names
  // that phase. It outranks the git reading: an audit that stopped has every
  // git fact saying joinable — the walk is committed on a clean worktree —
  // and lighting the join cell over it says the arc arrived somewhere it did
  // not. The stage the stop names is where the strip lights.
  const stoppedIn =
    stopped !== null && arc?.stopped_stage !== undefined && arc.done !== true
      ? stoppedPhase(arc.stopped_stage)
      : null;
  if (stoppedIn !== null) {
    phase = stoppedIn;
  } else if (arrived) {
    // Arrived by its git facts, and the run that got it here is still going:
    // the audit a run ends with is the one part of it no commit records.
    phase = input.holdersBusy === true ? "audit" : "join";
  } else if (direct) {
    // Before the first step starts there is nothing else to read: a direct
    // arc's plan is its task list, so the plan-means-review arm below would
    // seat it in a phase it does not have.
    phase = walked ? "audit" : "implement";
  } else if (arc?.stage !== undefined) {
    phase = walked ? "audit" : arcPhase(arc.stage);
  } else if (begun || stage === "implementing") {
    phase = walked ? "audit" : "implement";
  } else if (documents.plan !== undefined) {
    phase = "review";
  } else {
    phase = "brief";
  }
  return { direct, planned, phase, stopped, stoppedWhy, live, steps };
}

/**
 * The stages an arc record can name — the arc log's own `ArcStage`, each drawn
 * by the strip as a cell of the same word. The two readings below are the only
 * places a stage word becomes a phase, and they share this set so they cannot
 * come to disagree about which words the strip knows.
 */
const RECORD_STAGES: ReadonlySet<string> = new Set(["devise", "review", "implement", "audit"]);

/**
 * The cell a stop lights. `null` for a stage the strip does not draw, which
 * no record can currently name; the arms below the stop answer then, as they
 * did before the stop was read at all.
 */
function stoppedPhase(stage: string): ArcPhase | null {
  return RECORD_STAGES.has(stage) ? (stage as ArcPhase) : null;
}

function arcPhase(stage: string): ArcPhase {
  // The audit stage is the audit cell: what it does — read the code against
  // the plan and fix what does not match — is the verification a direct arc
  // does for itself in the same place on the strip.
  return stoppedPhase(stage) ?? "implement";
}

/**
 * What the arc is doing, in words a person would say aloud — the one
 * derivation every face that speaks the phase reads ([B08]).
 *
 * The word is the stage's own name inflected as a verb in progress, in the
 * Title Case the cells and the Z2 instrument are already set in, never the
 * enum key the line used to print. Two phases read differently at rest
 * ([B04]); see {@link ArcTrackModel.live}. A stop outranks all of it: the
 * line reads `Stopped · <word>`, with the reason word off the record
 * unchanged ([B05]) and its sentence waiting in {@link
 * ArcTrackModel.stoppedWhy}.
 *
 * The fraction rides **after** the verb, where it reads as the verb's object
 * ([B02]), and only while a step is actually in hand — so a walked ledger
 * under audit reads `Auditing` rather than `Auditing 6/6`.
 */
export interface ArcReading {
  /** The clause: `Implementing`, `Awaiting review`, `Stopped · stalled`. */
  word: string;
  /** `3/6` while a step is in hand, `null` otherwise. */
  fraction: string | null;
}

/**
 * The phase words, live and at rest.
 *
 * A table rather than a chain of conditions, so the four phases that read the
 * same either way say so by having the same word twice — which is the fact,
 * not an omission. `devise` never rests without stopping, and a stopped arc
 * never reaches this table at all.
 */
const ARC_PHASE_READINGS: Record<ArcPhase, { live: string; rest: string }> = {
  brief: { live: "Briefed", rest: "Briefed" },
  devise: { live: "Devising", rest: "Devising" },
  review: { live: "Reviewing", rest: "Awaiting review" },
  implement: { live: "Implementing", rest: "Implementing" },
  audit: { live: "Auditing", rest: "Awaiting audit" },
  // The work is over and the join is what is left. The register one line
  // below says what the join is doing, and the line must not say it twice
  // ([B01]).
  join: { live: "Finished", rest: "Finished" },
};

/** {@link ArcReading} for a model. Pure. */
export function arcReading(model: ArcTrackModel): ArcReading {
  if (model.stopped !== null) {
    return { word: `Stopped · ${model.stopped}`, fraction: null };
  }
  const reading = ARC_PHASE_READINGS[model.phase];
  const current = model.steps?.current ?? null;
  return {
    word: model.live ? reading.live : reading.rest,
    fraction: current !== null ? `${current}/${model.steps!.total}` : null,
  };
}

/**
 * The Z2 ARC cell's word, for the arc that has no numbers to show.
 *
 * The same vocabulary as the line, in the one register that cannot hold a
 * clause: the cell is 18ch and its reading is centred between two dots, so a
 * stop says `Stopped` and leaves its reason to the placard one press away.
 *
 * An arc with a branch and no ledger at all reads `Cut` — nothing else has
 * been declared, which is a past participle like every other resting word
 * here. It used to say `Working`, an -ing word for a phase the arc does not
 * have, which read as a claim somebody was at it. A hand-worked arc that
 * wrote itself a task list is not that arc: it has a ledger, so it shows a
 * fraction while it walks one and this cell's own phase word — `Awaiting
 * audit` — once it stops walking.
 */
export function arcCellWord(model: ArcTrackModel): string {
  if (model.stopped !== null) return "Stopped";
  if (model.direct && model.steps === null) return "Cut";
  return arcReading(model).word;
}

/** {@link arcTrackModel} over a wire entry. */
export function arcTrackModelFromEntry(entry: ArcChangesetEntry): ArcTrackModel {
  return arcTrackModel({
    documents: entry.documents,
    arc: entry.arc,
    taskList: entry.task_list,
    arcKind: entry.arc_kind,
    steps: entry.steps,
    stage: entry.stage,
    holdersBusy: entry.holders_busy,
  });
}

/** The state one cell wears under the model. */
export function arcCellState(model: ArcTrackModel, phase: ArcPhase): ArcCellState {
  const at = ARC_PHASES.indexOf(phase);
  const now = ARC_PHASES.indexOf(model.phase);
  if (at === now) return model.stopped !== null ? "stopped" : "active";
  return at < now ? "done" : "pending";
}

export function tickState(model: ArcTrackModel, n: number): ArcTickState {
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

/**
 * The past participle of each cell's own verb, for the two states that are
 * not the arc's present tense ([B09]).
 *
 * Held as a table rather than composed, so a reader learns the three forms
 * once — `Not yet <past participle>` before, the verb in progress during,
 * the participle after — and every cell says its own state in the same
 * grammar. The active form is not here: it is {@link ARC_PHASE_READINGS},
 * the same table the line's own clause reads, so a cell and the line beside
 * it cannot come to disagree about what the arc is doing.
 *
 * Two entries the strip never draws are spelled anyway rather than left as a
 * hole: brief is the first cell so nothing precedes it, and join is the last
 * so nothing follows it.
 */
const ARC_CELL_PARTICIPLES: Record<ArcPhase, { pending: string; done: string }> = {
  brief: { pending: "Not yet briefed", done: "Briefed" },
  devise: { pending: "Not yet devised", done: "Devised" },
  review: { pending: "Not yet reviewed", done: "Reviewed" },
  implement: { pending: "Not yet implemented", done: "Implemented" },
  audit: { pending: "Not yet audited", done: "Audited" },
  join: { pending: "Not yet joined", done: "Joined" },
};

/**
 * A cell's present tense — the line's own phase word, with the two
 * decorations a cell earns that the line does not.
 *
 * Implement counts what is behind it, because a cell whose ticks a reader is
 * squinting at is exactly where the count belongs; join says what is left,
 * because `Finished` alone on a cell reads as though the arc were over.
 *
 * `live` is a parameter rather than read off the model so the stopped form
 * can force it: a stop happened while somebody was at it, so a stopped
 * review cell reads `Reviewing — stopped: …` rather than `Awaiting review`.
 */
function arcCellActive(model: ArcTrackModel, phase: ArcPhase, live: boolean): string {
  const word = ARC_PHASE_READINGS[phase][live ? "live" : "rest"];
  if (phase === "join") return `${word} — the join is next`;
  if (phase === "implement" && model.steps !== null) {
    return `${word} · ${model.steps.done} of ${model.steps.total} steps closed`;
  }
  return word;
}

/**
 * One cell's hover sentence, in the three-form grammar of [B09].
 *
 * A stopped cell says what was being done and why it stopped, in the stop's
 * own **sentence** — the English the wire now carries beside the log's word,
 * which is what makes `lint` and `no stdin` readable at all ([B05]). An older
 * server sending the word alone falls back to it.
 *
 * The Devise cell of a planned arc also says what the kind means: the line
 * does not print the kind as a word (the cell set already draws it), so the
 * cell that exists BECAUSE the arc is planned is where the explanation
 * waits. A reader who wonders about the extra cells hovers a cell.
 */
export function arcCellTip(model: ArcTrackModel, phase: ArcPhase, state: ArcCellState): string {
  const participles = ARC_CELL_PARTICIPLES[phase];
  const steps = model.steps;
  let reading: string;
  if (state === "stopped") {
    const why = model.stoppedWhy ?? model.stopped ?? "";
    reading = `${arcCellActive(model, phase, true)} — stopped: ${why}`;
  } else if (state === "active") {
    reading = arcCellActive(model, phase, model.live);
  } else if (state === "pending") {
    reading = participles.pending;
  } else if (phase === "implement" && steps !== null) {
    reading = `${participles.done} · ${steps.total} ${steps.total === 1 ? "step" : "steps"}`;
  } else {
    reading = participles.done;
  }
  return phase === "devise" && model.planned ? `${reading}\n${PLANNED_KIND_SENTENCE}` : reading;
}

export interface TugArcTrackProps {
  model: ArcTrackModel;
  "aria-label"?: string;
}

export function TugArcTrack({
  model,
  "aria-label": ariaLabel,
}: TugArcTrackProps): React.ReactElement {
  // The track draws the phases the arc has, never the six with two struck
  // out: a plain arc did not skip devise and review, it never had them. It
  // did have a brief, so it draws one.
  const phases: readonly ArcPhase[] = model.planned ? ARC_PHASES : DIRECT_PHASES;
  return (
    <span
      className="tug-arc-track"
      data-slot="tug-arc-track"
      data-phase={model.phase}
      data-direct={model.direct ? "true" : undefined}
      data-stopped={model.stopped !== null ? "true" : undefined}
      aria-label={ariaLabel ?? arcCellTip(model, model.phase, arcCellState(model, model.phase))}
    >
      {phases.map((phase) => {
        const state = arcCellState(model, phase);
        const ticks =
          phase === "implement" && model.steps !== null
            ? Array.from({ length: model.steps.total }, (_, i) => i + 1)
            : null;
        return (
          <TugTooltip key={phase} content={arcCellTip(model, phase, state)}>
            <span
              className="tug-arc-track-cell"
              data-slot="tug-arc-track-cell"
              data-phase={phase}
              data-state={state}
              data-steps={ticks !== null ? "true" : undefined}
            >
              {ticks !== null
                ? ticks.map((n) => (
                    <span key={n} className="tug-arc-track-tick" data-state={tickState(model, n)} />
                  ))
                : null}
            </span>
          </TugTooltip>
        );
      })}
    </span>
  );
}
