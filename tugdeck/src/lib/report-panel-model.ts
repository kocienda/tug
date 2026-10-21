/**
 * What a report panel shows, derived from one report — pure, so every reading
 * the panel makes is a function of the report and the clock, and testable
 * without a DOM.
 *
 * A run counts **units**: a file for an app-test batch, a test for a unit
 * suite, a phase for a build. The panel is one shape for all three; the unit
 * word names the fraction, and the one thing that varies with the count is
 * the track's form — a cell per unit up to {@link CELLS_UP_TO}, a density
 * band past that, and a band too whenever the report carries only some of
 * its units (a test run sends its reds, not its thousand greens).
 *
 * Finished, a unit the last report still had running resolves by the call's
 * own outcome: a build whose last word was "re-sign" and whose call
 * succeeded signed; one whose call failed failed there.
 *
 * @module lib/report-panel-model
 */

import type { Report, RunUnit, RunUnitStatus } from "./report-store";

/** Past this many units the track is a density band rather than cells. */
export const CELLS_UP_TO = 64;

export type ReportPanelState = "running" | "finished";

/** A unit whose status is a red. */
export function isRed(status: RunUnitStatus): boolean {
  return status === "fail" || status === "error" || status === "stalled";
}

export interface RunLane {
  unit: RunUnit;
  /** Seconds since it started, by the clock the panel was handed. */
  elapsedSecs: number;
}

export interface ReportPanelModel {
  /** The unit word, singular (`file`). */
  unit: string;
  label: string;
  done: number;
  /** Units in all, when the reporter knows. */
  total: number | undefined;
  jobs: number | undefined;
  /** The rows, run order, with a finished run's leftovers resolved. */
  units: RunUnit[];
  counts: { pass: number; red: number; fail: number; stalled: number; skipped: number; pending: number };
  /** One cell per unit, or a band. */
  track: "cells" | "band" | "none";
  /**
   * Whether the report lists every unit as a row — an app-test batch's files,
   * a build's phases. A test run lists only its reds and counts the rest, so
   * it has no passing rows to fold and no in-flight rows to show.
   */
  listed: boolean;
  lanes: RunLane[];
  reds: RunUnit[];
  greens: RunUnit[];
  /** Seconds left, from the recorded medians; null when it cannot be known. */
  projectionSecs: number | null;
  /** Units still to land whose time no median knows, guessed at the typical one. */
  unknownCount: number;
  /**
   * Where on the bar the run would stand had it kept to its medians: the
   * share of its expected wall time — spent plus {@link projectionSecs} —
   * already spent. A fill behind the mark is a run slower than its record.
   */
  paceFraction: number | null;
  /**
   * Green rows that carry a history line. A reporter amends a green row only
   * when the record had it red, so each is a recovery: a flake, or a fix.
   */
  recovered: RunUnit[];
  /** The phase rows a run carried beside its units, a finished phase landed. */
  phases: RunUnit[];
  /** A red run's next act: the command, or the place, that names the reds. */
  nextAct: string | null;
  verdict: "running" | "green" | "red";
}

/**
 * The one thing to do on a red: what names the reds without a re-run. An
 * app-test batch's are in its own report's Failures section; every other run
 * that counts tests or files went through `tugtool test run`, which recorded
 * them for `tugtool test last --failures`. A run counting anything else — a
 * build's phases, a verify's surfaces — shows its reds inline and has none.
 */
export function nextActFor(label: string, unit: string): string | null {
  if (label === "app-test") return "see the Failures section";
  if (unit === "test" || unit === "file") return "tugtool test last --failures";
  return null;
}

/**
 * The in-flight rows as slots: what each row shows, given what it showed
 * last and what is running now. A row whose unit still runs keeps it; a
 * newly started unit takes the first row whose unit has landed, else a new
 * row at the end. A row is never emptied and never removed — a landed unit
 * stays on its row until another unit takes it — so the rows hold their
 * height between one unit and the next, and grow only to the most units
 * that ran at once.
 */
export function laneSlots(prev: readonly string[], running: readonly string[]): string[] {
  const live = new Set(running);
  const slots = [...prev];
  for (const name of running) {
    if (slots.includes(name)) continue;
    const free = slots.findIndex((s) => !live.has(s));
    if (free >= 0) slots[free] = name;
    else slots.push(name);
  }
  return slots;
}

/** The plural a fraction reads: `25 files`, `1 test`. */
export function unitWord(unit: string, n: number): string {
  return n === 1 ? unit : `${unit}s`;
}

/** `5s`, `2m 05s`. */
export function formatSecs(s: number): string {
  const whole = Math.max(0, Math.round(s));
  if (whole < 60) return `${whole}s`;
  return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, "0")}s`;
}

function resolveFinished(u: RunUnit, callFailed: boolean): RunUnit {
  if (u.status !== "running") return u;
  return { ...u, status: callFailed ? "fail" : "pass" };
}

export function reportPanelModel(
  p: Report,
  state: ReportPanelState,
  nowMs: number,
  opts: { callFailed?: boolean } = {},
): ReportPanelModel {
  const callFailed = opts.callFailed === true;
  const raw = [...(p.units ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const units = state === "finished" ? raw.map((u) => resolveFinished(u, callFailed)) : raw;
  const total = p.total;
  const count = (s: RunUnitStatus): number => units.filter((u) => u.status === s).length;
  const reds = units.filter((u) => isRed(u.status));
  const greens = units.filter((u) => u.status === "pass");
  const full = total !== undefined && units.length === total;

  // The fail count is the reporter's when it says one — a test run carries
  // only its first reds as rows, and the tally is the news past that.
  const redRows = reds.length;
  const red = Math.max(redRows, p.failures ?? 0);
  const pass = full ? greens.length : Math.max(0, (p.done ?? 0) - red);

  const track: ReportPanelModel["track"] =
    total === undefined || total === 0 ? "none" : full && total <= CELLS_UP_TO ? "cells" : "band";

  const lanes: RunLane[] =
    state === "running"
      ? units
          .filter((u) => u.status === "running")
          .map((u) => ({
            unit: u,
            elapsedSecs: u.startedAtMs !== undefined ? Math.max(0, (nowMs - u.startedAtMs) / 1000) : 0,
          }))
      : [];

  let projectionSecs: number | null = null;
  let unknownCount = 0;
  let paceFraction: number | null = null;
  if (state === "running" && full) {
    const known = units.map((u) => u.median).filter((m): m is number => m !== undefined);
    const typical = known.length > 0 ? known.reduce((a, b) => a + b, 0) / known.length : undefined;
    if (typical !== undefined) {
      let left = 0;
      for (const u of units) {
        if (u.status !== "pending" && u.status !== "running") continue;
        if (u.median === undefined) unknownCount += 1;
        if (u.status === "pending") left += u.median ?? typical;
        else {
          const lane = lanes.find((l) => l.unit === u);
          left += Math.max(0, (u.median ?? typical) - (lane?.elapsedSecs ?? 0));
        }
      }
      projectionSecs = left / Math.max(1, p.jobs ?? 1);
      const starts = units.map((u) => u.startedAtMs).filter((s): s is number => s !== undefined);
      if (starts.length > 0) {
        const spent = Math.max(0, (nowMs - Math.min(...starts)) / 1000);
        paceFraction = spent + projectionSecs > 0 ? spent / (spent + projectionSecs) : null;
      }
    }
  }

  // The units started, so the phases before them are over: a phase still
  // marked running landed when the first unit began.
  const unitsBegan = units.some((u) => u.status !== "pending");
  const phases = [...(p.phases ?? [])]
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((u) => (unitsBegan || state === "finished" ? resolveFinished(u, callFailed && !unitsBegan) : u));

  const verdict: ReportPanelModel["verdict"] =
    state === "running" ? "running" : red > 0 || callFailed ? "red" : "green";

  return {
    unit: p.unit ?? "unit",
    label: p.label ?? "",
    done: p.done ?? units.filter((u) => u.status !== "pending" && u.status !== "running").length,
    total,
    jobs: p.jobs,
    units,
    counts: {
      pass,
      red,
      fail: count("fail") + count("error"),
      stalled: count("stalled"),
      skipped: count("skipped"),
      pending: count("pending"),
    },
    track,
    listed: full,
    lanes,
    reds,
    greens,
    projectionSecs,
    unknownCount,
    paceFraction,
    recovered: greens.filter((u) => u.history !== undefined),
    phases,
    nextAct: verdict === "red" ? nextActFor(p.label ?? "", p.unit ?? "unit") : null,
    verdict,
  };
}

/** The projection as the masthead says it: `~2m 05s left · 3 unknown`. */
export function projectionText(m: ReportPanelModel): string | null {
  if (m.projectionSecs === null) return null;
  const left = `~${formatSecs(m.projectionSecs)} left`;
  return m.unknownCount > 0 ? `${left} · ${m.unknownCount} unknown` : left;
}

/**
 * The verdict band's sentence: `2 of 25 files failed, 1 stalled · 1 skipped`,
 * or `25 files passed`. A run that stopped short says how many never ran.
 */
export function verdictSentence(m: ReportPanelModel): string {
  const total = m.total ?? m.done;
  const word = unitWord(m.unit, total);
  const parts: string[] = [];
  if (m.counts.red > 0) {
    const failed = m.counts.red - m.counts.stalled;
    const lead =
      failed > 0
        ? `${failed} of ${total} ${word} failed`
        : `${m.counts.stalled} of ${total} ${word} stalled`;
    parts.push(failed > 0 && m.counts.stalled > 0 ? `${lead}, ${m.counts.stalled} stalled` : lead);
  } else {
    parts.push(`${m.counts.pass} ${unitWord(m.unit, m.counts.pass)} passed`);
  }
  if (m.recovered.length > 0) parts.push(`${m.recovered.length} recovered`);
  if (m.counts.skipped > 0) parts.push(`${m.counts.skipped} skipped`);
  if (m.counts.pending > 0 && m.track === "cells") parts.push(`${m.counts.pending} not run`);
  return parts.join(" · ");
}
