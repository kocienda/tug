/**
 * TugRunPanel — a test batch, a unit suite or a build, drawn as it runs and
 * as it ended.
 *
 * A run counts **units** — a file, a test, a phase — and reports them as it
 * goes (`tugtool progress --unit …`, `tugtool test run`). The panel is one
 * shape for every run, in one column, top to bottom:
 *
 *   1. **Masthead** — the ring (running) or nothing (finished, where the
 *      verdict band leads), the label, the fraction with its unit word, the
 *      tally as words, and the run's facts: jobs and the projection while
 *      running, wall time once over.
 *   2. **Track** — a cell per unit in run order, coloured as it lands, up to
 *      {@link CELLS_UP_TO}; a density band past that, or whenever the report
 *      carries only some of its units, with each red as a mark.
 *   3. **In flight** — a lane per running unit, its name in full. A run
 *      counting phases shows every phase as a compact step row, its time on
 *      the right; a run counting tests shows the test it is on.
 *   4. **Reds, always open** — each failed or wedged unit, its first
 *      failure, and what the record said of it before this run.
 *   5. **Folds**, collapsed: what passed, the wall-time chart (one bar per
 *      unit, the recorded median a ghost tick), and the run's own output.
 *
 * {@link TugRunStrip} is the finished run as one line, for a collapsed block.
 *
 * Colour is never the only reading: every cell has a title, every row a mark
 * and a word, and the tally is words.
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

import React from "react";

import {
  CELLS_UP_TO,
  formatSecs,
  isRed,
  runPanelModel,
  unitWord,
  verdictSentence,
  type RunLane,
  type RunPanelModel,
  type RunPanelState,
} from "@/lib/run-panel-model";
import type { RunProgress, RunUnit, RunUnitStatus } from "@/lib/run-progress-store";

import { TugAccordion, TugAccordionItem } from "./tug-accordion";
import { TugMetaRun } from "./tug-meta-run";
import { TugProgressIndicator } from "./tug-progress-indicator";
import { TugStepFraction } from "./tug-step-fraction";
import { TugStepRow, type TugStepRowStatus } from "./tug-step-row";

export { CELLS_UP_TO };

/** The letter a status wears, so colour is never the only reading. */
const MARK: Record<RunUnitStatus, string> = {
  pending: "·",
  running: "›",
  pass: "✓",
  fail: "✗",
  error: "✗",
  wedged: "⏱",
  skipped: "–",
};

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
 */
export function TugRunTrack({
  m,
  dense = false,
}: {
  m: RunPanelModel;
  dense?: boolean;
}): React.ReactElement | null {
  if (m.track === "none") return null;
  if (m.track === "cells") {
    return (
      <div
        className="tug-run-panel-track"
        data-slot="tug-run-panel-track"
        data-dense={dense ? "" : undefined}
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
      data-dense={dense ? "" : undefined}
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

/**
 * One job slot: the unit it runs now, by name. No gauge and no elapsed
 * readout: the panel renders on a report rather than on a clock, so a bar or
 * a seconds count would stand frozen between reports, and a gauge that comes
 * and goes with each lane made the rows hop and cut the names short.
 */
function Lane({ lane }: { lane: RunLane }) {
  return (
    <div className="tug-run-panel-lane" data-slot="tug-run-panel-lane">
      <TugProgressIndicator variant="pulsing-dot" size={10} state="running" role="action" aria-label="running" />
      <span className="tug-run-panel-name">{lane.unit.name}</span>
    </div>
  );
}

function secsOfMedian(u: RunUnit): string | null {
  if (u.secs === undefined) return null;
  return u.median !== undefined ? `${u.secs}s (~${u.median}s)` : `${u.secs}s`;
}

/** A landed unit: mark, name, and `PASS · 2/2 · 5s (~5s)`. */
function LandedRow({ unit }: { unit: RunUnit }) {
  const slow = unit.median !== undefined && unit.secs !== undefined && unit.secs > unit.median * 1.5;
  const timing = secsOfMedian(unit);
  return (
    <div className="tug-run-panel-landed" data-slot="tug-run-panel-landed" data-status={unit.status}>
      <span className="tug-run-panel-mark" aria-hidden>{MARK[unit.status]}</span>
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

/** A red unit, always open: head, first failure, what the record said. */
function RedCard({ unit }: { unit: RunUnit }) {
  const timing = secsOfMedian(unit);
  return (
    <div className="tug-run-panel-red" data-slot="tug-run-panel-red" data-status={unit.status}>
      <div className="tug-run-panel-red-head">
        <span className="tug-run-panel-mark" aria-hidden>{MARK[unit.status]}</span>
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

/** Wall time per unit, thin bars in run order, the recorded median a ghost tick. */
function DurationChart({ units }: { units: readonly RunUnit[] }) {
  const landed = units.filter((u) => u.secs !== undefined);
  const max = Math.max(1, ...landed.map((u) => Math.max(u.secs ?? 0, u.median ?? 0)));
  return (
    <div className="tug-run-panel-durations" data-slot="tug-run-panel-durations" role="img" aria-label="wall time per unit">
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

function InFlight({ m, text }: { m: RunPanelModel; text: string | undefined }) {
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
  if (m.lanes.length > 0) {
    return (
      <div className="tug-run-panel-lanes" data-slot="tug-run-panel-lanes">
        {m.lanes.map((l) => <Lane key={`${l.unit.index ?? 0}-${l.unit.name}`} lane={l} />)}
      </div>
    );
  }
  if (m.verdict === "running" && text !== undefined && text.length > 0) {
    return (
      <div className="tug-run-panel-lanes" data-slot="tug-run-panel-now">
        <div className="tug-run-panel-now">
          <TugProgressIndicator variant="pulsing-dot" size={10} state="running" role="action" aria-label="running" />
          <span className="tug-run-panel-name">{text}</span>
        </div>
      </div>
    );
  }
  return null;
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
  const facts: React.ReactElement[] = [];
  if (m.jobs !== undefined && m.jobs > 1) facts.push(<span key="j">{m.jobs} jobs</span>);
  if (state === "running" && m.projectionSecs !== null) {
    facts.push(
      <span key="p" className="tug-run-panel-projection" title="from the recorded medians, over the job count">
        ~{formatSecs(m.projectionSecs)} to go
      </span>,
    );
  }
  if (state === "finished" && wallSecs !== undefined) facts.push(<span key="w">wall {formatSecs(wallSecs)}</span>);

  const landed = m.units.filter((u) => u.secs !== undefined);
  return (
    <div className="tug-run-panel" data-slot="tug-run-panel" data-state={state} data-verdict={m.verdict}>
      {state === "finished" && (
        <div className="tug-run-panel-verdict" data-slot="tug-run-panel-verdict" data-verdict={m.verdict}>
          <span className="tug-run-panel-verdict-word">{verdictWord(m)}</span>
          <span className="tug-run-panel-verdict-text">{verdictSentence(m)}</span>
        </div>
      )}

      <div className="tug-run-panel-masthead">
        {state === "running" && (
          <TugProgressIndicator
            variant="ring"
            size={22}
            role="action"
            state="running"
            {...(m.total !== undefined ? { value: m.done, max: m.total } : {})}
            aria-label="Progress"
          />
        )}
        {m.label.length > 0 && <span className="tug-run-panel-label">{m.label}</span>}
        <Fraction done={m.done} total={m.total} unit={m.unit} />
        <Tally m={m} />
        <span className="tug-run-panel-spacer" />
        {facts.length > 0 && <TugMetaRun parts={facts} />}
      </div>

      <TugRunTrack m={m} />

      {state === "running" && <InFlight m={m} text={run.text} />}
      {state === "finished" && m.unit === "phase" && <InFlight m={m} text={undefined} />}

      {m.reds.map((u) => <RedCard key={`${u.index ?? 0}-${u.name}`} unit={u} />)}

      {(m.greens.length > 0 || landed.length > 1 || output !== undefined) && m.unit !== "phase" && (
        <TugAccordion
          type="multiple"
          variant="plain"
          className="tug-run-panel-folds"
          {...(foldKey !== undefined ? { componentStatePreservationKey: foldKey } : {})}
        >
          {m.greens.length > 0 && (
            <TugAccordionItem value="passed" trigger={<FoldTitle label="Passed" count={String(m.greens.length)} />}>
              <div className="tug-run-panel-landed-list">
                {[...m.greens].reverse().map((u) => <LandedRow key={`${u.index ?? 0}-${u.name}`} unit={u} />)}
              </div>
            </TugAccordionItem>
          )}
          {state === "finished" && landed.length > 1 && (
            <TugAccordionItem value="wall" trigger={<FoldTitle label="Wall time" count="ghost tick is the recorded median" />}>
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
          className="tug-run-panel-folds"
          {...(foldKey !== undefined ? { componentStatePreservationKey: foldKey } : {})}
        >
          <TugAccordionItem value="output" trigger={<FoldTitle label="Output" />}>
            {output}
          </TugAccordionItem>
        </TugAccordion>
      )}
    </div>
  );
}

/** The verdict as the word a test runner says: PASS or FAIL. */
function verdictWord(m: RunPanelModel): string {
  return m.verdict === "red" ? "FAIL" : "PASS";
}

/** A finished run as one line — the verdict, the fraction, the track — for a collapsed block. */
export function TugRunStrip({
  run,
  callFailed = false,
  wallSecs,
}: {
  run: RunProgress;
  callFailed?: boolean;
  wallSecs?: number;
}): React.ReactElement {
  const m = runPanelModel(run, "finished", 0, { callFailed });
  return (
    <div className="tug-run-strip" data-slot="tug-run-strip" data-verdict={m.verdict}>
      <span className="tug-run-panel-verdict-word">{verdictWord(m)}</span>
      {m.label.length > 0 && <span className="tug-run-panel-label">{m.label}</span>}
      <Fraction done={m.done} total={m.total} unit={m.unit} />
      <TugRunTrack m={m} dense />
      {m.counts.red > 0 && (
        <span className="tug-run-panel-tally-word" data-status="fail">
          {m.counts.red} fail
        </span>
      )}
      <span className="tug-run-panel-spacer" />
      {wallSecs !== undefined && <span className="tug-run-strip-wall">{formatSecs(wallSecs)}</span>}
    </div>
  );
}

/** Whether a report is drawn as a run panel rather than the one line. */
export function isRunPanelReport(p: RunProgress | null): p is RunProgress & { unit: string } {
  return p !== null && p.unit !== undefined;
}

export { isRed };
