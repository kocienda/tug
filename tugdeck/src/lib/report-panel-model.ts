/**
 * What a report panel shows, derived from one run — pure, so every reading
 * the panel makes is a function of the run and the clock, and testable
 * without a DOM.
 *
 * A call may carry several runs, and {@link reportPanels} groups them into
 * panels: a phase run beside a unit run under the same parent (or none) is
 * one panel, the phases its band; a run that ran under another run's unit is
 * that run's child; every other run with a unit is a panel of its own, in
 * the order the call's runs first reported.
 *
 * A child stays under the row it ran under for the life of the panel: open
 * while that unit runs, folded once the unit lands, and folded, never
 * dropped, when the panel is finished. A folded child is a finished run of
 * its own, so its verdict is its own rows', whatever its parent's call did.
 *
 * A run counts **units**: a file for an app-test batch, a test for a unit
 * suite, a phase for a build. The panel is one shape for all three; the unit
 * word names the fraction, and the one thing that varies with the count is
 * the track's form — a cell per unit up to {@link CELLS_UP_TO}, a density
 * band past that, and a band too whenever the report carries only some of
 * its units (a test run sends its reds, not its thousand greens).
 *
 * A finished panel claims no more than its rows show. A unit the last report
 * still had pending or running never reported, and is drawn `unreported`
 * rather than guessed into a pass or a fail by the call's exit status. The
 * verdict is green only for a run that said it finished, whose call did not
 * fail, with no reds and every unit landed; a run that ended any other way
 * without a red is `incomplete`, and its sentence says what is missing.
 *
 * A phase is the one exception: a phase did end with its call, so a run that
 * counts phases needs no word that it finished, and a phase the last report
 * still had running resolves by the call's own outcome — a build whose last
 * word was "re-sign" and whose call succeeded signed; one whose call failed
 * failed there.
 *
 * @module lib/report-panel-model
 */

import type { Report, Run, RunUnit, RunUnitStatus } from "./report-store";

/** Past this many units the track is a density band rather than cells. */
export const CELLS_UP_TO = 64;

export type ReportPanelState = "running" | "finished";

/** A unit whose status is a red. */
export function isRed(status: RunUnitStatus): boolean {
  return status === "fail" || status === "error" || status === "stalled";
}

/**
 * Units that are only ever reds: a type check counts its errors, and an error
 * never passes. Such a run has no denominator and nothing to tally as a pass,
 * so its masthead says the count alone — `3 errors`, `no errors`.
 */
const REDS_ONLY_UNITS: ReadonlySet<string> = new Set(["error"]);

export interface RunLane {
  unit: RunUnit;
  /** Seconds since it started, by the clock the panel was handed. */
  elapsedSecs: number;
}

export interface ReportPanelModel {
  /** The run this panel draws. */
  runId: string;
  /** The run's latest line. */
  text: string | undefined;
  /** The unit word, singular (`file`). */
  unit: string;
  label: string;
  done: number;
  /** Units in all, when the reporter knows. */
  total: number | undefined;
  jobs: number | undefined;
  /** The rows, run order, with a finished run's leftovers resolved. */
  units: RunUnit[];
  counts: {
    pass: number;
    red: number;
    fail: number;
    stalled: number;
    skipped: number;
    pending: number;
    /** Listed units a finished run never reported. */
    unreported: number;
  };
  /** One cell per unit, or a band. */
  track: "cells" | "band" | "none";
  /**
   * The band's segments, as fractions of the total: the passes, then the
   * reds, with the rest left as track. A band paints outcome, never bare
   * progress, so a run of one pass and one fail is half green and half red,
   * not a done bar full of green. `marks` says whether each red is also
   * ticked at its place in run order — only on a density band, where a run
   * is too long for its segments to say where the reds fell.
   */
  band: { pass: number; red: number; marks: boolean };
  /**
   * What the masthead says of the count, when a fraction and a tally would say
   * nothing true: `3 errors` for a run whose units are only reds, `no errors`
   * or `no tests` for a finished run that counted none. Null when the
   * fraction and the tally carry it.
   */
  countWords: string | null;
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
   * Green rows that carry a history line. A reporter amends a green row only
   * when the record had it red, so each is a recovery: a flake, or a fix.
   */
  recovered: RunUnit[];
  /** The phase rows a run carried beside its units, a finished phase landed. */
  phases: RunUnit[];
  /**
   * The runs that ran under this run's units — a surface's check, a loop's
   * runner — each a model of its own, in parent slot order then run order.
   */
  children: ChildPanel[];
  /** A red run's next act: the command, or the place, that names the reds. */
  nextAct: string | null;
  /**
   * `incomplete` is a run that ended with no red and is not green: it never
   * said it finished, or some of its units never reported.
   */
  verdict: "running" | "green" | "red" | "incomplete";
}

/** A run that ran under one of its parent's units. */
export interface ChildPanel {
  model: ReportPanelModel;
  /** The parent row it ran under, by index and by name. */
  underSlot: number;
  underName: string | null;
  /** Folded to its masthead: its parent unit has landed, or the panel is finished. */
  folded: boolean;
  /** Seconds from its first report to its last. */
  wallSecs: number | null;
  text: string | undefined;
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

/** The lines of a failure a red card shows before its fold. */
export const FAILURE_PREVIEW_LINES = 8;
/** The characters of a failure a red card shows before its fold. */
export const FAILURE_PREVIEW_CHARS = 640;

/** A failure's text as a red card first shows it. */
export interface FailurePreview {
  /** The title's share of the preview; absent when the unit has none. */
  title?: string;
  /** The message's share; absent when it has none or the title used the budget. */
  message?: string;
  /** Whether anything was held back, which is what earns the card its fold. */
  cut: boolean;
  /** The lines of the whole text, title and message together. */
  lines: number;
}

function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

/** `text` within a budget of lines and characters, ending in `…` when cut. */
function clipText(text: string, maxLines: number, maxChars: number): { text: string; cut: boolean } {
  const all = text.split("\n");
  let out = all.slice(0, maxLines).join("\n");
  let cut = all.length > maxLines;
  if (out.length > maxChars) {
    out = out.slice(0, maxChars);
    // Never leave half of a surrogate pair at the cut.
    const last = out.charCodeAt(out.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
    cut = true;
  }
  return { text: cut ? `${out.trimEnd()}…` : out, cut };
}

/**
 * The capped reading of a failure: title then message, under one budget of
 * lines and characters, so a command line of two hundred paths and a dump of
 * diagnostics are each a few lines until the reader asks for the rest. A
 * failure inside the budget comes back whole and `cut` is false. Pure, so
 * the cap is decided from the text and never from a measured box.
 */
export function failurePreview(
  title: string | undefined,
  message: string | undefined,
  maxLines: number = FAILURE_PREVIEW_LINES,
  maxChars: number = FAILURE_PREVIEW_CHARS,
): FailurePreview {
  const preview: FailurePreview = {
    cut: false,
    lines: countLines(title ?? "") + countLines(message ?? ""),
  };
  let lines = maxLines;
  let chars = maxChars;
  if (title !== undefined) {
    const t = clipText(title, lines, chars);
    preview.title = t.text;
    preview.cut = t.cut;
    lines -= countLines(t.text);
    chars -= t.text.length;
  }
  if (message !== undefined) {
    if (preview.cut || lines <= 0 || chars <= 0) {
      preview.cut = preview.cut || message.length > 0;
    } else {
      const m = clipText(message, lines, chars);
      preview.message = m.text;
      preview.cut = m.cut;
    }
  }
  return preview;
}

/** A phase still running at the call's close ended with it, as the call did. */
function resolvePhaseAtClose(u: RunUnit, callFailed: boolean): RunUnit {
  if (u.status !== "running") return u;
  return { ...u, status: callFailed ? "fail" : "pass" };
}

/** A unit still pending or running when its run ended never reported. */
function resolveUnreported(u: RunUnit): RunUnit {
  return u.status === "pending" || u.status === "running" ? { ...u, status: "unreported" } : u;
}

/** Whether a unit has landed: it reported how it ended. */
function landed(u: RunUnit): boolean {
  return u.status !== "pending" && u.status !== "running" && u.status !== "unreported";
}

export function reportPanelModel(
  p: Run,
  state: ReportPanelState,
  nowMs: number,
  opts: {
    callFailed?: boolean;
    /** The phase rows of the phase run this run is paired with. */
    phases?: readonly RunUnit[];
    /**
     * Runs that may have run under this one: those whose `under` names this
     * run are its children, and theirs are found in the same list.
     */
    children?: readonly Run[];
  } = {},
): ReportPanelModel {
  const callFailed = opts.callFailed === true;
  const phased = p.unit === "phase";
  const raw = [...(p.units ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const units =
    state !== "finished"
      ? raw
      : phased
        ? raw.map((u) => resolvePhaseAtClose(u, callFailed))
        : raw.map(resolveUnreported);
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

  const bandOf = (n: number): number => (total ? Math.min(1, Math.max(0, n / total)) : 0);
  const bandRed = bandOf(red);
  const band = {
    red: bandRed,
    pass: Math.min(bandOf(pass), 1 - bandRed),
    marks: total !== undefined && total > CELLS_UP_TO,
  };

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
    }
  }

  // The units started, so the phases before them are over: a phase still
  // marked running landed when the first unit began.
  const unitsBegan = units.some((u) => u.status !== "pending");
  const phases = [...(opts.phases ?? [])]
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((u) => (unitsBegan || state === "finished" ? resolvePhaseAtClose(u, callFailed && !unitsBegan) : u));

  // Green claims the run ended (said so, or is phases, which end with their
  // call), the call did not fail, nothing is red, and every unit landed: none
  // listed went unreported, and a run listing only some rows reached its total.
  // Phases end with their call, so the call's end lands a phased run's too.
  const unreported = count("unreported");
  const allLanded =
    phased || (full ? unreported === 0 : total === undefined || (p.done ?? 0) >= total);
  const verdict: ReportPanelModel["verdict"] =
    state === "running"
      ? "running"
      : red > 0 || callFailed
        ? "red"
        : (p.finished === true || phased) && allLanded
          ? "green"
          : "incomplete";

  const children = childPanels(p, units, state, nowMs, opts.children ?? []);

  return {
    runId: p.runId,
    text: p.text,
    unit: p.unit ?? "unit",
    label: p.label ?? "",
    done: p.done ?? units.filter(landed).length,
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
      unreported,
    },
    track,
    band,
    countWords: countWordsFor(p.unit ?? "unit", state, red, p.done ?? 0, total, units.length),
    listed: full,
    lanes,
    reds,
    greens,
    projectionSecs,
    unknownCount,
    recovered: greens.filter((u) => u.history !== undefined),
    phases,
    children,
    nextAct: verdict === "red" ? nextActFor(p.label ?? "", p.unit ?? "unit") : null,
    verdict,
  };
}

/** A run and the phase rows of the phase run it is paired with. */
interface RunGroup {
  run: Run;
  phases?: readonly RunUnit[];
}

/**
 * Runs that share one parent (or none), in list order, as panels: a phase run
 * pairs with the unit run under another label beside it — the one after it
 * first, a build before its files, else the one before — and rides it as its
 * phase band. Every other run is a group of its own.
 */
function groupRuns(runs: readonly Run[]): RunGroup[] {
  const pairs = (phase: Run, other: Run | undefined): other is Run =>
    other !== undefined && other.unit !== "phase" && other.label !== phase.label;
  const groups: RunGroup[] = [];
  const phasesFor = new Map<number, readonly RunUnit[]>();
  runs.forEach((run, i) => {
    if (run.unit !== "phase") {
      const phases = phasesFor.get(i);
      groups.push(phases !== undefined ? { run, phases } : { run });
      return;
    }
    const next = runs[i + 1];
    const prev = groups[groups.length - 1];
    if (pairs(run, next)) phasesFor.set(i + 1, run.units ?? []);
    else if (prev !== undefined && prev.phases === undefined && pairs(run, prev.run) && prev.run === runs[i - 1]) {
      prev.phases = run.units ?? [];
    } else groups.push({ run });
  });
  return groups;
}

/** Whether two runs ran under the same unit of the same parent, or both under none. */
function sameUnder(a: Run, b: Run): boolean {
  return a.under?.runId === b.under?.runId && a.under?.slot === b.under?.slot;
}

/** The children of `parent`, from `runs`, as their panels. */
function childPanels(
  parent: Run,
  units: readonly RunUnit[],
  state: ReportPanelState,
  nowMs: number,
  runs: readonly Run[],
): ChildPanel[] {
  const mine = runs
    .filter((r) => r.unit !== undefined && r.under?.runId === parent.runId)
    .map((r, order) => ({ r, order }))
    .sort((a, b) => (a.r.under?.slot ?? 0) - (b.r.under?.slot ?? 0) || a.order - b.order)
    .map(({ r }) => r);
  const out: ChildPanel[] = [];
  // Pairing holds among the children under one row, as it does at the top.
  for (let i = 0; i < mine.length; ) {
    let j = i + 1;
    while (j < mine.length && sameUnder(mine[j], mine[i])) j += 1;
    for (const group of groupRuns(mine.slice(i, j))) {
      const slot = group.run.under?.slot ?? 0;
      const row = units.find((u) => u.index === slot);
      const folded = state === "finished" || (row !== undefined && landed(row));
      const model = reportPanelModel(group.run, folded ? "finished" : "running", nowMs, {
        ...(group.phases !== undefined ? { phases: group.phases } : {}),
        children: runs,
      });
      const first = group.run.firstAtMs;
      const last = group.run.reportAtMs;
      out.push({
        model,
        underSlot: slot,
        underName: row?.name ?? null,
        folded,
        wallSecs: first !== undefined && last !== undefined ? Math.max(0, (last - first) / 1000) : null,
        text: group.run.text,
      });
    }
    i = j;
  }
  return out;
}

/**
 * A call's runs as the panels its block draws, in the order the runs first
 * reported. A run with no unit is no panel. A run under a run in the list is
 * that run's child, drawn in its panel; one whose parent is not in the list
 * is a panel of its own. A phase run pairs with the unit run beside it under
 * the same parent, as its phase band.
 *
 * The call's outcome is the last panel's alone: the call ended there, so its
 * exit status speaks for that run. An earlier run in the same call ended
 * before it, and its verdict is its own rows' and its own word that it
 * finished, as a child's is — a later run failing the call does not make an
 * earlier, finished, all-green run read FAIL.
 */
export function reportPanels(
  entry: Report,
  state: ReportPanelState,
  nowMs: number,
  opts: { callFailed?: boolean } = {},
): ReportPanelModel[] {
  const runs = entry.runs.filter((r) => r.unit !== undefined);
  const ids = new Set(runs.map((r) => r.runId));
  const top = runs.filter((r) => r.under === undefined || !ids.has(r.under.runId));
  const groups = groupRuns(top);
  return groups.map((group, i) =>
    reportPanelModel(group.run, state, nowMs, {
      callFailed: i === groups.length - 1 && opts.callFailed === true,
      ...(group.phases !== undefined ? { phases: group.phases } : {}),
      children: runs,
    }),
  );
}

function countWordsFor(
  unit: string,
  state: ReportPanelState,
  red: number,
  done: number,
  total: number | undefined,
  rows: number,
): string | null {
  if (REDS_ONLY_UNITS.has(unit)) {
    if (red > 0) return `${red} ${unitWord(unit, red)}`;
    return state === "finished" ? `no ${unitWord(unit, 0)}` : `no ${unitWord(unit, 0)} yet`;
  }
  const nothing = done === 0 && rows === 0 && (total === undefined || total === 0);
  return nothing && state === "finished" ? `no ${unitWord(unit, 0)}` : null;
}

/** The projection as the masthead says it: `~2m 05s left · 3 unknown`. */
export function projectionText(m: ReportPanelModel): string | null {
  if (m.projectionSecs === null) return null;
  const left = `~${formatSecs(m.projectionSecs)} left`;
  return m.unknownCount > 0 ? `${left} · ${m.unknownCount} unknown` : left;
}

/**
 * The verdict band's sentence: `2 of 25 files failed, 1 stalled · 1 skipped`,
 * or `25 files passed`. An incomplete run says what is missing — `3 of 5
 * files reported · 2 never reported` — and a red one with cells that never
 * reported says how many.
 */
export function verdictSentence(m: ReportPanelModel): string {
  const total = m.total ?? m.done;
  const word = unitWord(m.unit, total);
  const never = m.counts.unreported;
  if (m.verdict === "incomplete") {
    if (never > 0) {
      const reported = m.units.filter(landed).length;
      return `${reported} of ${total} ${word} reported · ${never} never reported`;
    }
    if (!m.listed && m.total !== undefined && m.done < m.total) {
      return `${m.done} of ${m.total} ${unitWord(m.unit, m.total)} reported`;
    }
    return "the run did not say it finished";
  }
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
  if (never > 0) parts.push(`${never} never reported`);
  return parts.join(" · ");
}
