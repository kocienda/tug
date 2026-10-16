/**
 * What a run panel shows, derived from one report — pure, so every reading
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
 * @module lib/run-panel-model
 */

import type { RunProgress, RunUnit, RunUnitStatus } from "./run-progress-store";

/** Past this many units the track is a density band rather than cells. */
export const CELLS_UP_TO = 64;

export type RunPanelState = "running" | "finished";

/** A unit whose status is a red. */
export function isRed(status: RunUnitStatus): boolean {
  return status === "fail" || status === "error" || status === "wedged";
}

export interface RunLane {
  unit: RunUnit;
  /** Seconds since it started, by the clock the panel was handed. */
  elapsedSecs: number;
}

export interface RunPanelModel {
  /** The unit word, singular (`file`). */
  unit: string;
  label: string;
  done: number;
  /** Units in all, when the reporter knows. */
  total: number | undefined;
  jobs: number | undefined;
  /** The rows, run order, with a finished run's leftovers resolved. */
  units: RunUnit[];
  counts: { pass: number; red: number; fail: number; wedged: number; skipped: number; pending: number };
  /** One cell per unit, or a band. */
  track: "cells" | "band" | "none";
  lanes: RunLane[];
  reds: RunUnit[];
  greens: RunUnit[];
  /** Seconds left, from the recorded medians; null when it cannot be known. */
  projectionSecs: number | null;
  verdict: "running" | "green" | "red";
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

export function runPanelModel(
  p: RunProgress,
  state: RunPanelState,
  nowMs: number,
  opts: { callFailed?: boolean } = {},
): RunPanelModel {
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

  const track: RunPanelModel["track"] =
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
  if (state === "running" && full) {
    const known = units.map((u) => u.median).filter((m): m is number => m !== undefined);
    const typical = known.length > 0 ? known.reduce((a, b) => a + b, 0) / known.length : undefined;
    if (typical !== undefined) {
      let left = 0;
      for (const u of units) {
        if (u.status === "pending") left += u.median ?? typical;
        else if (u.status === "running") {
          const lane = lanes.find((l) => l.unit === u);
          left += Math.max(0, (u.median ?? typical) - (lane?.elapsedSecs ?? 0));
        }
      }
      projectionSecs = left / Math.max(1, p.jobs ?? 1);
    }
  }

  const verdict: RunPanelModel["verdict"] =
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
      wedged: count("wedged"),
      skipped: count("skipped"),
      pending: count("pending"),
    },
    track,
    lanes,
    reds,
    greens,
    projectionSecs,
    verdict,
  };
}

/**
 * The verdict band's sentence: `2 of 25 files failed, 1 wedged · 1 skipped`,
 * or `25 files passed`. A run that stopped short says how many never ran.
 */
export function verdictSentence(m: RunPanelModel): string {
  const total = m.total ?? m.done;
  const word = unitWord(m.unit, total);
  const parts: string[] = [];
  if (m.counts.red > 0) {
    const failed = m.counts.red - m.counts.wedged;
    const lead =
      failed > 0
        ? `${failed} of ${total} ${word} failed`
        : `${m.counts.wedged} of ${total} ${word} wedged`;
    parts.push(failed > 0 && m.counts.wedged > 0 ? `${lead}, ${m.counts.wedged} wedged` : lead);
  } else {
    parts.push(`${m.counts.pass} ${unitWord(m.unit, m.counts.pass)} passed`);
  }
  if (m.counts.skipped > 0) parts.push(`${m.counts.skipped} skipped`);
  if (m.counts.pending > 0 && m.track === "cells") parts.push(`${m.counts.pending} not run`);
  return parts.join(" · ");
}
