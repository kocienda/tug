/**
 * The engine's re-audit row — parse it, and read it against the live wire.
 *
 * When a landing on the base makes a finished arc's audit stale, tugcast
 * re-audits it without spending a turn, and tells the card holding the arc
 * through one `/arc-reaudit <arc>` shell-ledger row that it rewrites at every
 * transition: waiting, running, and the ending. The row's output is a
 * line-oriented record — `key: value` lines, then one tab-separated `surface:`
 * line per surface at the terminal write — formatted once, on the server.
 *
 * The row is the durable half and the arc's `restamp` fact on the changeset
 * wire is the live half. {@link reauditView} decides which one a block draws
 * from: the wire while it still knows the row's run, the row once it does not.
 * Every sentence the block and the ARC popover show is composed here, as data
 * on the model, so neither face composes one twice.
 *
 * Pure: no store, no clock but the one passed in.
 *
 * @module lib/reaudit-row
 */

import type { ArcRestampSurfaceWire, ArcRestampWire } from "./changeset-types";

/** The states a row records. */
export type ReauditRowState =
  | "waiting"
  | "running"
  | "verified"
  | "seated"
  | "released"
  | "answered"
  | "interrupted";

const ROW_STATES: ReadonlySet<string> = new Set<ReauditRowState>([
  "waiting",
  "running",
  "verified",
  "seated",
  "released",
  "answered",
  "interrupted",
]);

/** One surface as a row or the wire carries it. */
export interface ReauditSurface {
  name: string;
  /** `pending` | `running` | `pass` | `fail` | `skipped`. */
  status: string;
  passed: number | null;
  total: number | null;
  /** Wall time in whole milliseconds, once it lands. */
  ms: number | null;
  /** When it started, RFC 3339 — the wire's only; a row records none. */
  startedAt: string | null;
  title: string | null;
  message: string | null;
}

/** One `/arc-reaudit` row, parsed. */
export interface ReauditRow {
  arc: string;
  runId: string;
  baseBranch: string;
  /** The base tip the re-audit is of, full. */
  baseSha: string;
  subject: string;
  /** The arc the tip joined, when the tip is a join's squash. */
  joined: string | null;
  state: ReauditRowState;
  why: string | null;
  started: string;
  ended: string | null;
  surfaces: ReauditSurface[];
}

/** Whether a shell row's command is a re-audit row. */
export function matchesReauditRow(command: string): boolean {
  return /^\/arc-reaudit\s+\S+/.test(command.trim());
}

function field(text: string): string | null {
  return text.length === 0 ? null : text;
}

function count(text: string): number | null {
  if (text.length === 0) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a row's output, or `null` when it is not one — a missing `arc`,
 * `run`, `base`, `state` or `started` line, or a state the row never writes.
 * A miss renders as a plain shell exchange, as the other receipts do.
 */
export function parseReauditRow(output: string): ReauditRow | null {
  const facts = new Map<string, string>();
  const surfaces: ReauditSurface[] = [];
  for (const line of output.split("\n")) {
    if (line.length === 0) continue;
    const colon = line.indexOf(": ");
    if (colon === -1) return null;
    const key = line.slice(0, colon);
    const value = line.slice(colon + 2);
    if (key === "surface") {
      const cells = value.split("\t");
      if (cells.length !== 7 || cells[0].length === 0) return null;
      surfaces.push({
        name: cells[0],
        status: cells[1],
        passed: count(cells[2]),
        total: count(cells[3]),
        ms: count(cells[4]),
        startedAt: null,
        title: field(cells[5]),
        message: field(cells[6]),
      });
    } else {
      facts.set(key, value);
    }
  }
  const arc = facts.get("arc");
  const runId = facts.get("run");
  const base = facts.get("base");
  const state = facts.get("state");
  const started = facts.get("started");
  if (
    arc === undefined ||
    runId === undefined ||
    base === undefined ||
    state === undefined ||
    started === undefined ||
    !ROW_STATES.has(state)
  ) {
    return null;
  }
  const space = base.indexOf(" ");
  return {
    arc,
    runId,
    baseBranch: space === -1 ? base : base.slice(0, space),
    baseSha: space === -1 ? "" : base.slice(space + 1),
    subject: facts.get("subject") ?? "",
    joined: field(facts.get("joined") ?? ""),
    state: state as ReauditRowState,
    why: field(facts.get("why") ?? ""),
    started,
    ended: field(facts.get("ended") ?? ""),
    surfaces,
  };
}

/** Where a re-audit's model stands. `finishing` and `interrupted` are the
 *  view's own readings; every other state is a row's or the wire's. */
export type ReauditViewState = ReauditRowState | "finishing";

/** What a re-audit block draws, top to bottom. */
export interface ReauditModel {
  arc: string;
  runId: string;
  state: ReauditViewState;
  /** The wire is drawing it, so its clock ticks. */
  live: boolean;
  /** The header's status word. */
  statusWord: string;
  /** `<base> moved to <sha> — <arc> joined`, or the subject. */
  headline: string;
  /** Where the run is, or the wait's sentence; null once it has ended. */
  phaseLine: string | null;
  surfaces: ReauditSurface[];
  /** The live clock's start (RFC 3339): the run's, or the wait's. */
  since: string | null;
  /** When the live run's horizon falls (RFC 3339). */
  deadline: string | null;
  /** The ending's sentence; null while live or finishing. */
  verdict: string | null;
}

const STATUS_WORDS: Readonly<Record<ReauditViewState, string>> = {
  waiting: "Waiting",
  running: "Re-auditing",
  finishing: "Finishing",
  verified: "Verified",
  seated: "Handed to audit",
  released: "Released",
  answered: "Answered",
  interrupted: "Interrupted",
};

/** The sentence a row left running reads once nothing knows its run. */
export const INTERRUPTED_VERDICT = "interrupted — Tug restarted before it finished";

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function headlineOf(
  base: string,
  sha: string,
  joined: string | null,
  subject: string,
): string {
  const moved = sha.length === 0 ? `${base} moved` : `${base} moved to ${shortSha(sha)}`;
  if (joined !== null) return `${moved} — ${joined} joined`;
  if (subject.length > 0) return `${moved} — "${subject}"`;
  return moved;
}

function phaseLineOf(phase: string | undefined, wire: ArcRestampWire): string | null {
  switch (phase) {
    case "replaying":
      return "replaying its rounds";
    case "verifying": {
      const n = wire.surfaces?.length ?? 0;
      return n === 0 ? "verifying" : `verifying ${n} ${n === 1 ? "surface" : "surfaces"}`;
    }
    case "marking":
      return "writing the audit mark";
    case "seating":
      return "handing it to the audit stage";
    case "waiting":
      return wire.waiting ?? "waiting";
    default:
      return null;
  }
}

function verdictOf(row: ReauditRow, state: ReauditViewState): string | null {
  const why = row.why ?? "";
  switch (state) {
    case "verified":
      return `verified on ${row.baseBranch} ${shortSha(row.baseSha)}`;
    case "seated":
      return `handed to the audit stage: ${why}`;
    case "released":
      return `released: ${why}`;
    case "answered":
      return `answered: ${why}`;
    case "interrupted":
      return INTERRUPTED_VERDICT;
    default:
      return null;
  }
}

function surfaceOfWire(row: ArcRestampSurfaceWire): ReauditSurface {
  return {
    name: row.name,
    status: row.status,
    passed: row.passed ?? null,
    total: row.total ?? null,
    ms: row.ms ?? null,
    startedAt: row.started_at ?? null,
    title: row.title ?? null,
    message: row.message ?? null,
  };
}

/**
 * The model a re-audit block draws for `row`, given the bound arc's live
 * `restamp` fact and name.
 *
 * - The arc is the row's and the wire's run is the row's: **live**, read
 *   from the wire — phase, trigger, surfaces, clocks, the wait.
 * - Otherwise a `waiting`/`running` row whose run the wire names as the one
 *   that last ended: **finishing**. The row's ending frame and the wire's
 *   beat travel apart, and the beat arrived first.
 * - Otherwise a `waiting`/`running` row: **interrupted** — nothing on the
 *   board knows its run, which after a restart is the truth.
 * - Otherwise the row's own record.
 */
export function reauditView(
  row: ReauditRow,
  restamp: ArcRestampWire | null,
  arcName: string | null,
): ReauditModel {
  const ours = arcName === row.arc ? restamp : null;
  const open = row.state === "waiting" || row.state === "running";
  if (ours !== null && ours.run_id === row.runId) {
    const waiting = ours.phase === "waiting";
    const state: ReauditViewState = waiting ? "waiting" : "running";
    const trigger = ours.trigger;
    return {
      arc: row.arc,
      runId: row.runId,
      state,
      live: true,
      statusWord: STATUS_WORDS[state],
      headline: headlineOf(
        row.baseBranch,
        trigger?.sha ?? row.baseSha,
        trigger === undefined ? row.joined : (trigger.arc ?? null),
        trigger?.subject ?? row.subject,
      ),
      phaseLine: phaseLineOf(ours.phase, ours),
      surfaces: (ours.surfaces ?? []).map(surfaceOfWire),
      since: (waiting ? ours.waiting_since : ours.running_since) ?? null,
      deadline: waiting ? null : (ours.deadline ?? null),
      verdict: null,
    };
  }
  const state: ReauditViewState = !open
    ? row.state
    : ours !== null && ours.last_run_id === row.runId
      ? "finishing"
      : "interrupted";
  return {
    arc: row.arc,
    runId: row.runId,
    state,
    live: false,
    statusWord: STATUS_WORDS[state],
    headline: headlineOf(row.baseBranch, row.baseSha, row.joined, row.subject),
    phaseLine: state === "finishing" ? "finishing" : null,
    surfaces: row.surfaces,
    since: null,
    deadline: null,
    verdict: verdictOf(row, state),
  };
}

/** `m:ss`, from whole seconds. */
export function clockText(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * The live footer: `elapsed m:ss · ends by hh:mm` for a run, `waiting m:ss`
 * for a wait; null for a model that is not live.
 */
export function reauditFooter(model: ReauditModel, nowMs: number): string | null {
  if (!model.live || model.since === null) return null;
  const since = Date.parse(model.since);
  if (Number.isNaN(since)) return null;
  const elapsed = clockText((nowMs - since) / 1000);
  if (model.state === "waiting") return `waiting ${elapsed}`;
  const deadline = model.deadline === null ? NaN : Date.parse(model.deadline);
  if (Number.isNaN(deadline)) return `elapsed ${elapsed}`;
  const at = new Date(deadline);
  const hhmm = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  return `elapsed ${elapsed} · ends by ${hhmm}`;
}

/** A surface's trailing figure: its wall time once it lands, its running
 *  elapsed while it runs, otherwise nothing. */
export function surfaceTime(surface: ReauditSurface, nowMs: number): string | null {
  if (surface.ms !== null) return clockText(surface.ms / 1000);
  if (surface.status === "running" && surface.startedAt !== null) {
    const since = Date.parse(surface.startedAt);
    if (!Number.isNaN(since)) return clockText((nowMs - since) / 1000);
  }
  return null;
}

/** What the ARC cell reads while the engine re-audits the arc. */
export interface ReauditCellReading {
  word: "Re-auditing" | "Waiting";
  pose: "running";
}

/** The ARC cell's reading of a `restamp` fact: `Waiting` for a wait,
 *  `Re-auditing` for a run going on, and null for neither. */
export function reauditCellReading(
  restamp: ArcRestampWire | null | undefined,
): ReauditCellReading | null {
  if (restamp === null || restamp === undefined) return null;
  if (restamp.phase === "waiting") return { word: "Waiting", pose: "running" };
  if (restamp.running_since !== undefined) return { word: "Re-auditing", pose: "running" };
  return null;
}

/**
 * The ARC cell's word, by precedence: a standing join offer reads the
 * register's word; a re-audit reads its own unless the arc has stopped, since
 * a stop is the reading nobody should have to open the placard to find; then
 * the step fraction while steps are walked; then the lifecycle's word.
 */
export function arcCellReadingWord({
  stopped,
  joinReady,
  joinWord,
  reaudit,
  fraction,
  word,
}: {
  stopped: boolean;
  joinReady: boolean;
  joinWord: string;
  reaudit: ReauditCellReading | null;
  fraction: { current: number; total: number } | null;
  word: string;
}): string {
  if (joinReady) return joinWord;
  if (reaudit !== null && !stopped) return reaudit.word;
  if (fraction !== null) return `${fraction.current}/${fraction.total}`;
  return word;
}

/**
 * The re-audit's model from the wire alone, for a face that holds no row —
 * the ARC popover. A row is synthesized from the wire's run, so the model is
 * the one {@link reauditView} composes for the block while it is live. Null
 * when the wire carries no run.
 */
export function reauditViewFromWire(
  restamp: ArcRestampWire | null | undefined,
  arc: string,
  baseBranch: string,
): ReauditModel | null {
  if (restamp === null || restamp === undefined || restamp.run_id === undefined) return null;
  const waiting = restamp.phase === "waiting";
  const row: ReauditRow = {
    arc,
    runId: restamp.run_id,
    baseBranch,
    baseSha: restamp.trigger?.sha ?? "",
    subject: restamp.trigger?.subject ?? "",
    joined: restamp.trigger?.arc ?? null,
    state: waiting ? "waiting" : "running",
    why: null,
    started: (waiting ? restamp.waiting_since : restamp.running_since) ?? "",
    ended: null,
    surfaces: [],
  };
  return reauditView(row, restamp, arc);
}
