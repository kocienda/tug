/**
 * TugRunPanel — a test batch, a unit suite or a build, drawn as it runs and
 * as it ended.
 *
 * A run counts **units** — a file, a test, a phase — and reports them as it
 * goes (`tugtool progress --unit …`, `tugtool test run`). The panel is one
 * shape for every run, in one column, top to bottom:
 *
 *   1. **Masthead** — the verdict word, PASS or FAIL, once the run is over;
 *      the label, the fraction with its unit word, the tally as words, and
 *      the run's facts: jobs and the projection
 *      while running, wall time once over. A test run's line before it has a
 *      count (a crate compiling) is a fact too.
 *   2. **Track** — a cell per unit in run order, coloured as it lands, in one
 *      row whose cells shrink as the count grows, up to {@link CELLS_UP_TO};
 *      a density band past that, or whenever the report carries only some of
 *      its units, with each red as a mark.
 *   3. **In flight** — a row per unit in flight, its name in full; a row is
 *      never emptied while the run goes, so the panel does not jump between
 *      units. A run counting phases shows every phase as a compact step row,
 *      its time on the right. A run counting tests has no row here: it lists
 *      only its reds, so the masthead's fraction and the band are its
 *      progress, and its total is the runner's own count, never an estimate.
 *   4. **Reds** — the most recent failed or wedged unit open as a card, its
 *      first failure and what the record said of it before this run, and
 *      every earlier red folded under it, newest first, one tap away. While
 *      the run goes they land at the foot, under the folds, so a red
 *      arriving changes the card and the fold's count and moves nothing
 *      above them; once over they lead the body.
 *   5. **Folds**, collapsed: what passed (standing from the first report,
 *      for a run that lists its units — a test run counts its passes and has
 *      none to fold), the wall-time chart (one bar per unit, the recorded
 *      median a ghost tick, said in the chart's own tooltip), and the run's
 *      own output. Every fold is one line of its own text.
 *
 * {@link TugRunStrip} is the finished run for a collapsed block: rows 1 and 2,
 * and row 4 when the run went red, so the running panel, the strip and the
 * expanded result all open on the same two rows and a red one says what
 * failed without being opened.
 *
 * Colour is never the only reading: every cell has a title, every row's dot
 * is labelled and stands beside a word, and the tally is words.
 *
 * Laws: [L06] appearance via CSS and data attributes — status is
 *       `data-status`, a bar's length an inline width; [L16] every color
 *       rule declares its surface; [L19] `.tsx`/`.css` pair, `data-slot`;
 *       [L20] composes the step row, meta run and accordion,
 *       and owns `--tugx-run-*`.
 *
 * @module components/tugways/tug-run-panel
 */

import "./tug-run-panel.css";

import React, { useRef } from "react";

import {
  CELLS_UP_TO,
  formatSecs,
  isRed,
  laneSlots,
  runPanelModel,
  unitWord,
  verdictSentence,
  type RunPanelModel,
  type RunPanelState,
} from "@/lib/run-panel-model";
import type { RunProgress, RunUnit, RunUnitStatus } from "@/lib/run-progress-store";

import { TugAccordion, TugAccordionItem } from "./tug-accordion";
import { TugMetaRun } from "./tug-meta-run";
import {
  TugProgressIndicator,
  type TugProgressIndicatorRole,
  type TugProgressIndicatorState,
} from "./tug-progress-indicator";
import { TugStepFraction } from "./tug-step-fraction";
import { TugStepRow, type TugStepRowStatus } from "./tug-step-row";

export { CELLS_UP_TO };

/**
 * The dot a unit wears, by status: the same pulsing dot in every row, which
 * breathes only while the unit runs and stands still in its verdict's colour
 * once the result is in. One glyph in one box, so a row's lead never changes
 * size as its unit lands.
 */
const DOT: Record<RunUnitStatus, { role: TugProgressIndicatorRole; state: TugProgressIndicatorState }> = {
  pending: { role: "inherit", state: "stopped" },
  running: { role: "action", state: "running" },
  pass: { role: "success", state: "completed" },
  fail: { role: "danger", state: "aborted" },
  error: { role: "danger", state: "aborted" },
  wedged: { role: "caution", state: "aborted" },
  skipped: { role: "inherit", state: "stopped" },
};

/** The 10px dot at the head of a unit's row, still or breathing by its status. */
function UnitDot({ status }: { status: RunUnitStatus }) {
  const { role, state } = DOT[status];
  return <TugProgressIndicator variant="pulsing-dot" size={10} role={role} state={state} aria-label={WORD[status]} />;
}

/** The word a status wears, so colour is never the only reading. */
const WORD: Record<RunUnitStatus, string> = {
  pending: "pending",
  running: "running",
  pass: "PASS",
  fail: "FAIL",
  error: "ERROR",
  wedged: "WEDGED",
  skipped: "skipped",
};

const STEP_STATUS: Record<RunUnitStatus, TugStepRowStatus> = {
  pending: "pending",
  running: "busy",
  pass: "done",
  fail: "error",
  error: "error",
  wedged: "error",
  skipped: "pending",
};

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function Fraction({ done, total, unit }: { done: number; total: number | undefined; unit: string }) {
  return (
    <span className="tug-run-panel-fraction" data-slot="tug-run-panel-fraction">
      {total !== undefined ? (
        <TugStepFraction current={done} total={total} />
      ) : (
        <span className="tug-run-panel-count">{done}</span>
      )}
      <span className="tug-run-panel-unit">{unitWord(unit, total ?? done)}</span>
    </span>
  );
}

function Tally({ m }: { m: RunPanelModel }) {
  const failed = m.counts.red - m.counts.wedged;
  return (
    <span className="tug-run-panel-tally" data-slot="tug-run-panel-tally">
      <span className="tug-run-panel-tally-word" data-status={m.counts.pass > 0 ? "pass" : undefined}>
        {m.counts.pass} pass
      </span>
      {failed > 0 && (
        <span className="tug-run-panel-tally-word" data-status="fail">{failed} fail</span>
      )}
      {m.counts.wedged > 0 && (
        <span className="tug-run-panel-tally-word" data-status="wedged">{m.counts.wedged} wedged</span>
      )}
      {m.counts.skipped > 0 && (
        <span className="tug-run-panel-tally-word">{m.counts.skipped} skipped</span>
      )}
    </span>
  );
}

/**
 * The track: a cell per unit, or a band. A cell's `data-status` is what the
 * stylesheet paints; the band's fill is the done fraction and each red a mark
 * at its place in run order.
 *
 * The cells are one row at every count: each is 16px wide while the row has
 * room and shrinks toward 3px as the count grows, with the gap tightening past
 * {@link MANY_CELLS}, so more units cost width and never another row. Past
 * {@link CELLS_UP_TO} a cell is too thin to read and the band takes over.
 */
export function TugRunTrack({ m }: { m: RunPanelModel }): React.ReactElement | null {
  if (m.track === "none") return null;
  if (m.track === "cells") {
    return (
      <div
        className="tug-run-panel-track"
        data-slot="tug-run-panel-track"
        data-many={m.units.length > MANY_CELLS ? "" : undefined}
        role="img"
        aria-label={`${m.done} of ${m.total} ${unitWord(m.unit, m.total ?? 0)} done, ${m.counts.red} red`}
      >
        {m.units.map((u) => (
          <span
            key={`${u.index ?? 0}-${u.name}`}
            className="tug-run-panel-cell"
            data-status={u.status}
            title={`${u.name} · ${WORD[u.status]}${u.secs !== undefined ? ` · ${u.secs}s` : ""}`}
          />
        ))}
      </div>
    );
  }
  const total = m.total ?? 1;
  return (
    <div
      className="tug-run-panel-band"
      data-slot="tug-run-panel-band"
      role="img"
      aria-label={`${m.done} of ${total} ${unitWord(m.unit, total)} done, ${m.counts.red} red`}
    >
      <span className="tug-run-panel-band-fill" style={{ width: `${Math.min(1, m.done / total) * 100}%` }} />
      {m.reds.map((u) => (
        <span
          key={`${u.index ?? 0}-${u.name}`}
          className="tug-run-panel-band-mark"
          data-status={u.status}
          style={{ left: `${Math.min(1, (u.index ?? 0) / total) * 100}%` }}
          title={u.name}
        />
      ))}
    </div>
  );
}

/** Past this many cells the track's gap tightens, so the cells keep their width longer. */
const MANY_CELLS = 24;

/**
 * One in-flight row: the unit it shows, by name. A running unit wears the
 * breathing dot; a unit that landed while no other has taken its row wears
 * the same dot, still, in its verdict's colour, so the row is never blank
 * between one unit and the next and its lead never changes size. No gauge
 * and no elapsed readout: a gauge that came and went with each unit made the
 * rows hop and cut the names short.
 */
function SlotRow({ name, unit }: { name: string; unit: RunUnit | undefined }) {
  const status = unit?.status ?? "running";
  return (
    <div className="tug-run-panel-lane" data-slot="tug-run-panel-lane" data-status={status}>
      <UnitDot status={status} />
      <span className="tug-run-panel-name">{name}</span>
    </div>
  );
}

function secsOfMedian(u: RunUnit): string | null {
  if (u.secs === undefined) return null;
  return u.median !== undefined ? `${u.secs}s (~${u.median}s)` : `${u.secs}s`;
}

/** A landed unit: dot, name, and `PASS · 2/2 · 5s (~5s)`. */
function LandedRow({ unit }: { unit: RunUnit }) {
  const slow = unit.median !== undefined && unit.secs !== undefined && unit.secs > unit.median * 1.5;
  const timing = secsOfMedian(unit);
  return (
    <div className="tug-run-panel-landed" data-slot="tug-run-panel-landed" data-status={unit.status}>
      <UnitDot status={unit.status} />
      <span className="tug-run-panel-name">{unit.name}</span>
      <TugMetaRun
        parts={[
          <span key="w" className="tug-run-panel-word">{WORD[unit.status]}</span>,
          unit.total !== undefined ? <span key="c">{unit.passed ?? 0}/{unit.total}</span> : null,
          timing !== null ? <span key="s" data-over={slow ? "" : undefined}>{timing}</span> : null,
        ]}
      />
    </div>
  );
}

/** A red unit: head, first failure, what the record said. */
function RedCard({ unit }: { unit: RunUnit }) {
  const timing = secsOfMedian(unit);
  return (
    <div className="tug-run-panel-red" data-slot="tug-run-panel-red" data-status={unit.status}>
      <div className="tug-run-panel-red-head">
        <UnitDot status={unit.status} />
        <span className="tug-run-panel-name">{unit.name}</span>
        <span className="tug-run-panel-word">{WORD[unit.status]}</span>
        <span className="tug-run-panel-spacer" />
        {timing !== null && <span className="tug-run-panel-red-secs">{timing}</span>}
      </div>
      {unit.title !== undefined && <div className="tug-run-panel-red-title">{unit.title}</div>}
      {unit.message !== undefined && <div className="tug-run-panel-red-message">{unit.message}</div>}
      {unit.history !== undefined && <div className="tug-run-panel-red-history">{unit.history}</div>}
    </div>
  );
}

/**
 * The reds: the most recent one open, the earlier ones folded under it. A
 * run that goes red many times would otherwise stack a card per failure and
 * push everything else off the screen, and the one a reader acts on next is
 * the one that just landed. Run order is landing order, so the last red is
 * the most recent; the fold lists the rest newest first.
 */
function Reds({ reds, foldKey }: { reds: readonly RunUnit[]; foldKey: string | undefined }) {
  const latest = reds[reds.length - 1];
  if (latest === undefined) return null;
  const earlier = reds.slice(0, -1).reverse();
  return (
    <div className="tug-run-panel-reds" data-slot="tug-run-panel-reds">
      <RedCard unit={latest} />
      {earlier.length > 0 && (
        <TugAccordion
          type="multiple"
          variant="plain"
          density="compact"
          className="tug-run-panel-folds tug-run-panel-earlier-reds"
          {...(foldKey !== undefined ? { componentStatePreservationKey: `${foldKey}-earlier-reds` } : {})}
        >
          <TugAccordionItem
            value="earlier-reds"
            trigger={<FoldTitle label="Earlier failures" count={String(earlier.length)} />}
          >
            <div className="tug-run-panel-red-list">
              {earlier.map((u) => <RedCard key={`${u.index ?? 0}-${u.name}`} unit={u} />)}
            </div>
          </TugAccordionItem>
        </TugAccordion>
      )}
    </div>
  );
}

/** Wall time per unit, thin bars in run order, the recorded median a ghost tick. */
function DurationChart({ units }: { units: readonly RunUnit[] }) {
  const landed = units.filter((u) => u.secs !== undefined);
  const max = Math.max(1, ...landed.map((u) => Math.max(u.secs ?? 0, u.median ?? 0)));
  return (
    <div
      className="tug-run-panel-durations"
      data-slot="tug-run-panel-durations"
      role="img"
      aria-label="wall time per unit; the ghost tick is the recorded median"
      title="ghost tick: the recorded median"
    >
      {landed.map((u) => (
        <div
          key={`${u.index ?? 0}-${u.name}`}
          className="tug-run-panel-dur"
          data-status={u.status}
          title={`${u.name} · ${u.secs}s${u.median !== undefined ? ` (median ${u.median}s)` : ""}`}
        >
          <span className="tug-run-panel-dur-name">{u.name}</span>
          <span className="tug-run-panel-dur-track">
            <span className="tug-run-panel-dur-bar" style={{ width: `${((u.secs ?? 0) / max) * 100}%` }} />
            {u.median !== undefined && (
              <span className="tug-run-panel-dur-tick" style={{ left: `${(u.median / max) * 100}%` }} />
            )}
          </span>
          <span className="tug-run-panel-dur-val">{u.secs}s</span>
        </div>
      ))}
    </div>
  );
}

function FoldTitle({ label, count }: { label: string; count?: string }) {
  return (
    <span className="tug-run-panel-fold-title">
      <span>{label}</span>
      {count !== undefined && <span className="tug-run-panel-fold-count">{count}</span>}
    </span>
  );
}

/**
 * What is running. A phased run is its step rows. Any other run is a set of
 * rows, one per unit in flight, kept by {@link laneSlots} so a row is never
 * emptied or removed while the run goes on — the rows grow to the most units
 * that ran at once and hold that height to the end. A run that names no
 * units in flight shows its progress line on one row, keeping the last line
 * it had rather than going blank.
 */
function InFlight({ m, text }: { m: RunPanelModel; text: string | undefined }) {
  // Not appearance state: what each row showed last, which the next render
  // reads to keep the rows where they were. laneSlots is idempotent, so a
  // second render pass writes the same thing.
  const slots = useRef<string[]>([]);
  const lastText = useRef("");
  if (m.unit === "phase") {
    return (
      <ol className="tug-run-panel-phases" data-slot="tug-run-panel-phases">
        {m.units.map((u) => {
          const lane = m.lanes.find((l) => l.unit === u);
          const detail =
            lane !== undefined
              ? u.median !== undefined
                ? `${formatSecs(lane.elapsedSecs)} of ~${formatSecs(u.median)}`
                : formatSecs(lane.elapsedSecs)
              : u.secs !== undefined
                ? formatSecs(u.secs)
                : undefined;
          return (
            <TugStepRow
              key={`${u.index ?? 0}-${u.name}`}
              status={STEP_STATUS[u.status]}
              label={u.name}
              density="compact"
              detailPlacement="trailing"
              busyRole="action"
              {...(detail !== undefined ? { detail } : {})}
            />
          );
        })}
      </ol>
    );
  }
  slots.current = laneSlots(
    slots.current,
    m.lanes.map((l) => l.unit.name),
  );
  if (slots.current.length > 0) {
    return (
      <div className="tug-run-panel-lanes" data-slot="tug-run-panel-lanes">
        {slots.current.map((name, i) => (
          <SlotRow key={i} name={name} unit={m.units.find((u) => u.name === name)} />
        ))}
      </div>
    );
  }
  if (text !== undefined && text.length > 0) lastText.current = text;
  return (
    <div className="tug-run-panel-lanes" data-slot="tug-run-panel-now">
      <SlotRow name={lastText.current || "starting"} unit={undefined} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

export interface TugRunPanelProps {
  run: RunProgress;
  state: RunPanelState;
  /** The clock the lanes' elapsed reads against (ms). */
  nowMs: number;
  /** Finished: whether the call itself failed. */
  callFailed?: boolean;
  /** Finished: the call's wall time, in seconds. */
  wallSecs?: number;
  /** Finished: the run's own output, folded at the foot. */
  output?: React.ReactNode;
  /** Keys the folds' open state in the card's saved bag. */
  foldKey?: string;
}

/**
 * The masthead: the label, the fraction, the tally, the facts — and, once
 * the run is over, the verdict word in front of them. While the run goes
 * there is no lead: the block's own dot, the count and the track already
 * say it is running, and a ring said it a fourth time. The panel and the
 * strip both open with it.
 */
function Masthead({
  m,
  state,
  wallSecs,
  text,
}: {
  m: RunPanelModel;
  state: RunPanelState;
  wallSecs: number | undefined;
  /** Running: the report's line, shown when the run has no rows to show it on. */
  text?: string | undefined;
}): React.ReactElement {
  const facts: React.ReactElement[] = [];
  if (state === "running" && text !== undefined && text.length > 0 && text !== "running") {
    facts.push(<span key="t" className="tug-run-panel-now-text">{text}</span>);
  }
  if (m.jobs !== undefined && m.jobs > 1) facts.push(<span key="j">{m.jobs} jobs</span>);
  if (state === "running" && m.projectionSecs !== null) {
    facts.push(
      <span key="p" className="tug-run-panel-projection" title="from the recorded medians, over the job count">
        ~{formatSecs(m.projectionSecs)} to go
      </span>,
    );
  }
  if (state === "finished" && wallSecs !== undefined) facts.push(<span key="w">wall {formatSecs(wallSecs)}</span>);
  return (
    <div className="tug-run-panel-masthead">
      {state === "finished" && <span className="tug-run-panel-verdict-word">{verdictWord(m)}</span>}
      {m.label.length > 0 && <span className="tug-run-panel-label">{m.label}</span>}
      <Fraction done={m.done} total={m.total} unit={m.unit} />
      <Tally m={m} />
      <span className="tug-run-panel-spacer" />
      {facts.length > 0 && <TugMetaRun parts={facts} />}
    </div>
  );
}

export function TugRunPanel({
  run,
  state,
  nowMs,
  callFailed = false,
  wallSecs,
  output,
  foldKey,
}: TugRunPanelProps): React.ReactElement {
  const m = runPanelModel(run, state, nowMs, { callFailed });
  const landed = m.units.filter((u) => u.secs !== undefined);
  const running = state === "running";
  // A test run counts its passes and lists only its reds: it has no in-flight
  // rows, and no passing rows to fold. The masthead's fraction and the band
  // are its progress, and a line it has before it counts (a crate compiling)
  // rides the masthead, where it moves nothing.
  const counted = m.unit === "test";
  const passedFold = m.listed && (running || m.greens.length > 0);
  const reds = <Reds reds={m.reds} foldKey={foldKey} />;
  // The panel opens with the strip's two rows, so a finished block that
  // collapses to its strip keeps them where they were. While the run goes,
  // everything below them holds its place: the in-flight rows never empty,
  // the Passed fold stands from the first report, and reds land at the foot,
  // where arriving moves nothing above, and only the most recent stands open.
  // Once over, the reds lead the body.
  return (
    <div className="tug-run-panel" data-slot="tug-run-panel" data-state={state} data-verdict={m.verdict}>
      <Masthead m={m} state={state} wallSecs={wallSecs} text={counted && m.total === undefined ? run.text : undefined} />
      <TugRunTrack m={m} />

      {!running && (
        <div className="tug-run-panel-verdict" data-slot="tug-run-panel-verdict" data-verdict={m.verdict}>
          {verdictSentence(m)}
        </div>
      )}

      {running && !counted && <InFlight m={m} text={run.text} />}
      {!running && m.unit === "phase" && <InFlight m={m} text={undefined} />}

      {!running && reds}

      {(passedFold || (state === "finished" && landed.length > 1) || output !== undefined) && m.unit !== "phase" && (
        <TugAccordion
          type="multiple"
          variant="plain"
          density="compact"
          className="tug-run-panel-folds"
          {...(foldKey !== undefined ? { componentStatePreservationKey: foldKey } : {})}
        >
          {passedFold && (
            <TugAccordionItem value="passed" trigger={<FoldTitle label="Passed" count={String(m.greens.length)} />}>
              <div className="tug-run-panel-landed-list">
                {[...m.greens].reverse().map((u) => <LandedRow key={`${u.index ?? 0}-${u.name}`} unit={u} />)}
              </div>
            </TugAccordionItem>
          )}
          {state === "finished" && landed.length > 1 && (
            <TugAccordionItem value="wall" trigger={<FoldTitle label="Wall time" />}>
              <DurationChart units={m.units} />
            </TugAccordionItem>
          )}
          {output !== undefined && (
            <TugAccordionItem value="output" trigger={<FoldTitle label="Output" />}>
              {output}
            </TugAccordionItem>
          )}
        </TugAccordion>
      )}
      {m.unit === "phase" && output !== undefined && (
        <TugAccordion
          type="multiple"
          variant="plain"
          density="compact"
          className="tug-run-panel-folds"
          {...(foldKey !== undefined ? { componentStatePreservationKey: foldKey } : {})}
        >
          <TugAccordionItem value="output" trigger={<FoldTitle label="Output" />}>
            {output}
          </TugAccordionItem>
        </TugAccordion>
      )}
      {running && reds}
    </div>
  );
}

/** The verdict as the word a test runner says: PASS or FAIL. */
function verdictWord(m: RunPanelModel): string {
  return m.verdict === "red" ? "FAIL" : "PASS";
}

/**
 * A finished run for a collapsed block: the panel's own masthead and track,
 * at the panel's own sizes, and under them the failure detail when the run
 * went red — the most recent red open, the earlier ones folded, as the panel
 * shows them — so a collapsed red block says what failed without opening.
 * It is what the running panel becomes when it settles — the ring turns into
 * the verdict word, the in-flight rows and the passed fold go — and what the
 * expanded panel opens with, so moving between the three changes no row the
 * eye was already reading.
 */
export function TugRunStrip({
  run,
  callFailed = false,
  wallSecs,
  foldKey,
}: {
  run: RunProgress;
  callFailed?: boolean;
  wallSecs?: number;
  /** Keys the earlier-failures fold's open state in the card's saved bag. */
  foldKey?: string;
}): React.ReactElement {
  const m = runPanelModel(run, "finished", 0, { callFailed });
  return (
    <div
      className="tug-run-panel tug-run-strip"
      data-slot="tug-run-strip"
      data-state="finished"
      data-verdict={m.verdict}
    >
      <Masthead m={m} state="finished" wallSecs={wallSecs} />
      <TugRunTrack m={m} />
      <Reds reds={m.reds} foldKey={foldKey} />
    </div>
  );
}

/** Whether a report is drawn as a run panel rather than the one line. */
export function isRunPanelReport(p: RunProgress | null): p is RunProgress & { unit: string } {
  return p !== null && p.unit !== undefined;
}

export { isRed };
