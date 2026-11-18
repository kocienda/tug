/**
 * Live progress for running tool calls — the engine's heartbeat and the
 * running command's own reports — kept beside the transcript, never in it.
 *
 * Two CODE_OUTPUT frames feed it. `tool_progress` is the engine's heartbeat
 * for a running call (about once a second, carrying the call's elapsed
 * seconds), which tugcode forwards. `report` is a report the running
 * command posted about itself (`tugtool report`, `tugtool test run`),
 * which tugcast attached to a call — or to the card, with a `null` id, when
 * it could not tell which call it came from.
 *
 * Neither is part of the session's record: claude's JSONL has neither, and
 * the progress line is a view of a run rather than part of it. So the
 * `CodeSessionStore` diverts both here before its reducer sees them, and a
 * heartbeat a second re-renders only the leaf that shows it, rather than
 * rebuilding the session snapshot for every transcript subscriber. Each
 * consumer subscribes to one key through `useSyncExternalStore` [L02].
 *
 * A call's `tool_result` closes it. Frames for a closed call are ignored, so
 * a stale frame from the lag-replay buffer is inert — except a report for a
 * background job that is still running, whose call returned at once while
 * its command kept going.
 *
 * A call may carry several **runs** — a build's phases and then its files, a
 * verify and the test runs its surfaces wrap, a loop planned twice — and the
 * entry keeps them as a list, each keyed by the `run_id` tugcast sent (or
 * `label:<label>` when the frame carries none). A frame replaces its own run
 * whole and touches no other: a run's rows are its own. Which runs pair into
 * one panel and which is a child under another's row is the panel model's to
 * say, from the runs' `unit` and `under`; the store merges nothing.
 *
 * A run that names its **unit** (`file`, `test`, `phase`) carries its unit
 * rows, and the block draws a call with such a run as report panels rather
 * than a line. The entry's own line fields are the latest frame's, for the
 * one-line readers.
 *
 * When such a call closes, its entry is kept as the call's **settled** runs,
 * so the block can show how they ended. tugcast records them too, when the
 * call ends, and gives them back on replay after the line that carried the
 * call's `tool_result` ({@link ReportStore.restoreSettled}), so a reloaded
 * card draws the finished panel it drew live. Nothing evicts a settled
 * entry: the page holds every call it has drawn a panel for, and the ledger
 * keeps them as long as their session. A block restored from a transcript
 * with no recorded runs renders its output as it always did.
 */

import { isDecodeError } from "@tugproto/decode";
import { decodeOutbound, type ReportFrame as WireReportFrame } from "@tugproto/outbound-decoders";

/**
 * Where a unit of a run stands. `unreported` is never read from the wire: it
 * is what the panel's model makes of a listed unit still `pending` or
 * `running` when its run has finished — a cell nobody reported, said so
 * rather than guessed into a pass or a fail.
 */
export type RunUnitStatus =
  | "pending"
  | "running"
  | "pass"
  | "fail"
  | "error"
  | "stalled"
  | "skipped"
  | "unreported";

/** The statuses a reporter may send; `unreported` is the model's alone. */
const RUN_UNIT_STATUSES: ReadonlySet<string> = new Set<RunUnitStatus>([
  "pending",
  "running",
  "pass",
  "fail",
  "error",
  "stalled",
  "skipped",
]);

/** One unit of a run — a file, a test, a phase — as a report carries it. */
export interface RunUnit {
  name: string;
  status: RunUnitStatus;
  /** Its place in run order, 0-based; where its mark sits on the track. */
  index?: number;
  /** Tests passed and tests in the unit, once it has landed. */
  passed?: number;
  total?: number;
  /** Wall seconds at landing. */
  secs?: number;
  /** The recorded median of its recent wall times, in seconds. */
  median?: number;
  /** When a running unit started (epoch ms, the reporter's clock). */
  startedAtMs?: number;
  /** A red unit's first failure. */
  title?: string;
  message?: string;
  /** What the record says of this unit before this run. */
  history?: string;
}

/** One run's latest snapshot. */
export interface Run {
  /** The run's id; `label:<label>` for a reporter that minted none. */
  runId: string;
  label?: string;
  text?: string;
  done?: number;
  total?: number;
  failures?: number;
  /** What the run counts; present when the run is a report panel's. */
  unit?: string;
  /** How many units run at once. */
  jobs?: number;
  /** The run's unit rows, narrowed. */
  units?: readonly RunUnit[];
  /** Whether this run's units are runs of their own, which run under them. */
  nests?: boolean;
  /**
   * The reporter said the run is over. A finished run is green only when
   * every unit it listed landed and none is red; one that never says so is
   * never green.
   */
  finished?: boolean;
  /** The parent run and the slot of the unit this run ran under. */
  under?: { runId: string; slot: number };
  /** Its place among the call's runs, by first report, as tugcast numbered it. */
  ord?: number;
  seq?: number;
  /** tugcast's clock at the run's first report, else the local clock at first arrival. */
  firstAtMs?: number;
  /** The local clock at the latest arrival. */
  reportAtMs?: number;
}

/** What is known about one running call, or about the card's unattached line. */
export interface Report {
  /** The call it belongs to; `null` for the card-level slot. */
  toolUseId: string | null;
  /** Every run the call has reported, ordered by `ord`, then by first arrival. */
  runs: readonly Run[];
  /** The latest report's line fields, for the one-line readers. */
  label?: string;
  text?: string;
  done?: number;
  total?: number;
  failures?: number;
  unit?: string;
  /** When the latest report arrived (local ms). */
  reportAtMs?: number;
  /**
   * Why tugcast could tie the report to no call ("no open run", "2
   * candidates, no needle matched"); on the card-level slot only.
   */
  unattached?: string;
  /** The engine's elapsed reading at the latest heartbeat, in ms. */
  engineElapsedMs?: number;
  /** When the latest heartbeat arrived (local ms). */
  heartbeatAtMs?: number;
}

/**
 * A CODE_OUTPUT `report` frame's fields, as tugcast publishes them: the
 * wire's own type, less the tag and the session id the transport read
 * before the frame got here. Its rows are unread until
 * {@link narrowRunUnits}.
 */
export type ReportFrame = Omit<WireReportFrame, "type" | "tug_session_id">;

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * The reporter's rows as {@link RunUnit}s: a row with no name or an unknown
 * status is dropped, a field of the wrong type is absent. `undefined` when
 * there is no array at all.
 */
export function narrowRunUnits(raw: unknown): RunUnit[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: RunUnit[] = [];
  for (const r of raw) {
    if (typeof r !== "object" || r === null) continue;
    const row = r as Record<string, unknown>;
    const name = str(row.name);
    const status = row.status;
    if (name === undefined || typeof status !== "string" || !RUN_UNIT_STATUSES.has(status)) continue;
    const unit: RunUnit = { name, status: status as RunUnitStatus };
    const index = num(row.index);
    if (index !== undefined) unit.index = index;
    const passed = num(row.passed);
    if (passed !== undefined) unit.passed = passed;
    const total = num(row.total);
    if (total !== undefined) unit.total = total;
    const secs = num(row.secs);
    if (secs !== undefined) unit.secs = secs;
    const median = num(row.median);
    if (median !== undefined) unit.median = median;
    const started = num(row.started_at_ms);
    if (started !== undefined) unit.startedAtMs = started;
    const title = str(row.title);
    if (title !== undefined) unit.title = title;
    const message = str(row.message);
    if (message !== undefined) unit.message = message;
    const history = str(row.history);
    if (history !== undefined) unit.history = history;
    out.push(unit);
  }
  return out;
}

/** How many calls are tracked at once; the least recently updated goes. */
export const REPORT_CAP = 64;
/** How many closed ids are remembered, to ignore their late frames. */
export const REPORT_CLOSED_CAP = 256;
/** A heartbeat younger than this reads as `live`. */
export const ENGINE_LIVE_MS = 10_000;

/** The map key the card-level slot is stored under. */
const CARD_KEY = "\u0000card";

function keyOf(key: string | null): string {
  return key === null ? CARD_KEY : key;
}

export class ReportStore {
  /** Insertion order is update order: an update deletes and re-sets. */
  private readonly entries = new Map<string, Report>();
  private readonly closed = new Set<string>();
  /** A closed call's last unit report, kept so its block can show the end. */
  private readonly settled = new Map<string, Report>();
  private readonly listeners = new Map<string, Set<() => void>>();

  /** Record the engine's heartbeat for a running call. */
  applyHeartbeat(toolUseId: string, elapsedSeconds: number, nowMs: number): void {
    if (this.closed.has(toolUseId)) return;
    const prev = this.entries.get(toolUseId);
    this.put(toolUseId, {
      ...(prev ?? { toolUseId, runs: [] }),
      engineElapsedMs: elapsedSeconds * 1000,
      heartbeatAtMs: nowMs,
    });
  }

  /**
   * Record a report. A `null` id lands in the card slot. A report for a
   * closed call is ignored unless `isRunningJob` says the call is a
   * background job still running. The frame replaces its own run whole,
   * keeping when it first arrived, and leaves every other run as it was.
   * A frame whose `seq` is not above the one its run already holds is
   * older than what the store has, and is dropped whole: its run, and the
   * entry's line fields, stay as they were. A frame with no `seq` is applied.
   */
  applyReport(
    frame: ReportFrame,
    nowMs: number,
    isRunningJob: (toolUseId: string) => boolean = () => false,
  ): void {
    const id = frame.tool_use_id;
    if (id !== null && this.closed.has(id) && !isRunningJob(id)) return;
    const key = keyOf(id);
    const prev = this.entries.get(key);
    const run = runOfFrame(frame, nowMs);
    const held = prev?.runs.find((r) => r.runId === run.runId);
    if (run.seq !== undefined && held?.seq !== undefined && run.seq <= held.seq) return;
    const runs = withRun(prev?.runs ?? [], run);
    const unit = str(frame.unit);
    this.put(key, {
      toolUseId: id,
      runs,
      label: frame.label,
      text: frame.text,
      done: frame.done,
      total: frame.total,
      failures: frame.failures,
      ...(unit !== undefined ? { unit } : {}),
      ...(id === null && str(frame.unattached) !== undefined ? { unattached: str(frame.unattached) } : {}),
      reportAtMs: nowMs,
      engineElapsedMs: prev?.engineElapsedMs,
      heartbeatAtMs: prev?.heartbeatAtMs,
    });
  }

  /**
   * The call's `tool_result` arrived: forget it, and ignore its late frames.
   * A call any of whose runs named a unit settles — its runs are kept for
   * {@link getSettled}.
   */
  close(toolUseId: string): void {
    this.closed.add(toolUseId);
    if (this.closed.size > REPORT_CLOSED_CAP) {
      const oldest = this.closed.values().next().value;
      if (oldest !== undefined) this.closed.delete(oldest);
    }
    const entry = this.entries.get(toolUseId);
    if (entry !== undefined && entry.runs.some((r) => r.unit !== undefined)) {
      this.settled.delete(toolUseId);
      this.settled.set(toolUseId, entry);
    }
    if (this.entries.delete(toolUseId)) this.notify(toolUseId);
  }

  /**
   * A replayed call's runs as tugcast recorded them when it ended: each body
   * is narrowed exactly as a live `report` frame is, and the call's settled
   * entry is built from them. A settled entry the page already holds is the
   * one it drew live, and stays. The call's subscribers hear it, so a block
   * that rendered its output a moment earlier redraws as its panel.
   */
  restoreSettled(toolUseId: string, runBodies: readonly unknown[], nowMs: number): void {
    if (this.settled.has(toolUseId)) return;
    let runs: Run[] = [];
    let last: WireReportFrame | undefined;
    for (const body of runBodies) {
      if (typeof body !== "object" || body === null || Array.isArray(body)) continue;
      const frame = decodeOutbound("report", { ...body, type: "report", tool_use_id: toolUseId });
      if (isDecodeError(frame)) continue;
      // The run's last report is tugcast's `at_ms`, not this page's clock:
      // a child's wall time reads from its first report to its last.
      runs = withRun(runs, { ...runOfFrame(frame, nowMs), reportAtMs: num(frame.at_ms) ?? nowMs });
      last = frame;
    }
    if (last === undefined || !runs.some((r) => r.unit !== undefined)) return;
    const unit = str(last.unit);
    this.settled.set(toolUseId, {
      toolUseId,
      runs,
      label: last.label,
      text: last.text,
      done: last.done,
      total: last.total,
      failures: last.failures,
      ...(unit !== undefined ? { unit } : {}),
      reportAtMs: nowMs,
    });
    this.notify(toolUseId);
  }

  /** A closed call's runs as they ended, or `null`. */
  getSettled(toolUseId: string): Report | null {
    return this.settled.get(toolUseId) ?? null;
  }

  /** The transport closed or the session reset: nothing is running now. */
  clear(): void {
    const keys = [...this.entries.keys()];
    this.entries.clear();
    for (const key of keys) this.notify(key);
  }

  /** Subscribe to one call's entry (or the card slot, with `null`). */
  subscribe(key: string | null, cb: () => void): () => void {
    const k = keyOf(key);
    let set = this.listeners.get(k);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(k, set);
    }
    set.add(cb);
    return () => {
      const s = this.listeners.get(k);
      if (s === undefined) return;
      s.delete(cb);
      if (s.size === 0) this.listeners.delete(k);
    };
  }

  /** The entry, or `null`. The same object until the entry next changes. */
  get(key: string | null): Report | null {
    return this.entries.get(keyOf(key)) ?? null;
  }

  private put(key: string, entry: Report): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
    if (this.entries.size > REPORT_CAP) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
        this.notify(oldest);
      }
    }
    this.notify(key);
  }

  private notify(key: string): void {
    const set = this.listeners.get(key);
    if (set === undefined) return;
    for (const cb of [...set]) cb();
  }
}

/** The key a frame's run is held under: its id, else its label. */
export function runKeyOf(frame: Pick<ReportFrame, "run_id" | "label">): string {
  return str(frame.run_id) ?? `label:${frame.label ?? ""}`;
}

/**
 * The run a frame describes, whole: a field absent now was not carried
 * forward by the reporter, so it is not stale-kept. `firstAtMs` is tugcast's
 * when the frame carries it; {@link withRun} keeps an earlier one.
 */
function runOfFrame(frame: ReportFrame, nowMs: number): Run {
  const unit = str(frame.unit);
  const units = unit === undefined ? undefined : narrowRunUnits(frame.units);
  const under = frame.under;
  const ord = num(frame.run_ord);
  const seq = num(frame.seq);
  const firstAtMs = num(frame.first_at_ms);
  return {
    runId: runKeyOf(frame),
    label: frame.label,
    text: frame.text,
    done: frame.done,
    total: frame.total,
    failures: frame.failures,
    ...(unit !== undefined ? { unit } : {}),
    ...(unit !== undefined && num(frame.jobs) !== undefined ? { jobs: num(frame.jobs) } : {}),
    ...(units !== undefined ? { units } : {}),
    ...(unit !== undefined && frame.nests === true ? { nests: true } : {}),
    ...(unit !== undefined && frame.finished === true ? { finished: true } : {}),
    ...(under !== undefined && str(under.run_id) !== undefined && num(under.slot) !== undefined
      ? { under: { runId: under.run_id, slot: under.slot } }
      : {}),
    ...(ord !== undefined ? { ord } : {}),
    ...(seq !== undefined ? { seq } : {}),
    firstAtMs: firstAtMs ?? nowMs,
    reportAtMs: nowMs,
  };
}

/**
 * `runs` with `run` in its place: the run of that id replaced whole, keeping
 * the first arrival it already had, or `run` added. Ordered by `ord`, then
 * by first arrival, so a run tugcast has not numbered keeps its place.
 */
function withRun(runs: readonly Run[], run: Run): Run[] {
  const at = runs.findIndex((r) => r.runId === run.runId);
  const next =
    at < 0
      ? [...runs, run]
      : runs.map((r, i) => (i === at ? { ...run, firstAtMs: r.firstAtMs ?? run.firstAtMs } : r));
  return next
    .map((r, arrival) => ({ r, arrival }))
    .sort((a, b) => (a.r.ord ?? Infinity) - (b.r.ord ?? Infinity) || a.arrival - b.arrival)
    .map(({ r }) => r);
}

/**
 * The one line a report reads as: `label · done/total · N fail · text`, each
 * part omitted when absent (`done` alone without a total; no failure part at
 * zero). A total known only from history arrives in `text` already marked
 * `~` by the reporter, never in `total`, which is always exact.
 */
export function formatReportLine(p: Report): string {
  const parts: string[] = [];
  if (p.label !== undefined && p.label.length > 0) parts.push(p.label);
  if (p.done !== undefined) {
    parts.push(p.total !== undefined ? `${p.done}/${p.total}` : `${p.done}`);
  }
  if (p.failures !== undefined && p.failures > 0) parts.push(`${p.failures} fail`);
  if (p.text !== undefined && p.text.length > 0) parts.push(p.text);
  return parts.join(" · ");
}

/**
 * The running call's elapsed time: the engine's own reading carried forward
 * from its last heartbeat when there is one, else the local clock since the
 * call started. Floored at zero, and never carried backward: a render whose
 * `nowMs` is a tick older than the heartbeat it shows reads the heartbeat
 * itself, not a second short of it.
 */
export function liveElapsedMs(
  startedAtMs: number,
  p: Report | null,
  nowMs: number,
): number {
  if (p?.engineElapsedMs !== undefined && p.heartbeatAtMs !== undefined) {
    return Math.max(0, p.engineElapsedMs + Math.max(0, nowMs - p.heartbeatAtMs));
  }
  return Math.max(0, nowMs - startedAtMs);
}

/**
 * Whether the engine is still vouching for the call: `live` while its last
 * heartbeat is under {@link ENGINE_LIVE_MS} old, `quiet` once heartbeats were
 * seen and stopped, `null` when none ever arrived.
 */
export function engineLiveness(
  p: Report | null,
  nowMs: number,
): "live" | "quiet" | null {
  if (p?.heartbeatAtMs === undefined) return null;
  return nowMs - p.heartbeatAtMs < ENGINE_LIVE_MS ? "live" : "quiet";
}
