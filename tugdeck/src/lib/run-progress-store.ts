/**
 * Live progress for running tool calls — the engine's heartbeat and the
 * running command's own reports — kept beside the transcript, never in it.
 *
 * Two CODE_OUTPUT frames feed it. `tool_progress` is the engine's heartbeat
 * for a running call (about once a second, carrying the call's elapsed
 * seconds), which tugcode forwards. `run_progress` is a report the running
 * command posted about itself (`tugtool progress`, `tugtool test run`),
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
 * A report that names its **unit** (`file`, `test`, `phase`) carries the
 * run's unit rows, and the block draws it as a run panel rather than a line.
 * When such a call closes, its last report is kept as the call's **settled**
 * run, so the block can show how the run ended. Settled runs live as long as
 * the page: they are a view of a run, never part of the record, and a block
 * restored from the transcript without one renders its output as it always
 * did.
 */

/** Where a unit of a run stands. */
export type RunUnitStatus =
  | "pending"
  | "running"
  | "pass"
  | "fail"
  | "error"
  | "wedged"
  | "skipped";

const RUN_UNIT_STATUSES: ReadonlySet<string> = new Set<RunUnitStatus>([
  "pending",
  "running",
  "pass",
  "fail",
  "error",
  "wedged",
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

/** What is known about one running call, or about the card's unattached run. */
export interface RunProgress {
  /** The call it belongs to; `null` for the card-level slot. */
  toolUseId: string | null;
  label?: string;
  text?: string;
  done?: number;
  total?: number;
  failures?: number;
  /** What the run counts; present when the report is a run panel's. */
  unit?: string;
  /** How many units run at once. */
  jobs?: number;
  /** The run's unit rows, narrowed. */
  units?: readonly RunUnit[];
  /** When the latest report arrived (local ms). */
  reportAtMs?: number;
  /** The engine's elapsed reading at the latest heartbeat, in ms. */
  engineElapsedMs?: number;
  /** When the latest heartbeat arrived (local ms). */
  heartbeatAtMs?: number;
}

/** A CODE_OUTPUT `run_progress` frame, as tugcast publishes it. */
export interface RunProgressFrame {
  tool_use_id: string | null;
  label?: string;
  text?: string;
  done?: number;
  total?: number;
  failures?: number;
  unit?: string;
  jobs?: number;
  /** The reporter's rows, unread until {@link narrowRunUnits}. */
  units?: unknown;
  at_ms?: number;
}

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
export const RUN_PROGRESS_CAP = 64;
/** How many closed ids are remembered, to ignore their late frames. */
export const RUN_PROGRESS_CLOSED_CAP = 256;
/** How many settled runs are kept; the oldest goes first. */
export const RUN_SETTLED_CAP = 64;
/** A heartbeat younger than this reads as `live`. */
export const ENGINE_LIVE_MS = 10_000;

/** The map key the card-level slot is stored under. */
const CARD_KEY = "\u0000card";

function keyOf(key: string | null): string {
  return key === null ? CARD_KEY : key;
}

export class RunProgressStore {
  /** Insertion order is update order: an update deletes and re-sets. */
  private readonly entries = new Map<string, RunProgress>();
  private readonly closed = new Set<string>();
  /** A closed call's last unit report, kept so its block can show the end. */
  private readonly settled = new Map<string, RunProgress>();
  private readonly listeners = new Map<string, Set<() => void>>();

  /** Record the engine's heartbeat for a running call. */
  applyHeartbeat(toolUseId: string, elapsedSeconds: number, nowMs: number): void {
    if (this.closed.has(toolUseId)) return;
    const prev = this.entries.get(toolUseId);
    this.put(toolUseId, {
      ...(prev ?? { toolUseId }),
      engineElapsedMs: elapsedSeconds * 1000,
      heartbeatAtMs: nowMs,
    });
  }

  /**
   * Record a report. A `null` id lands in the card slot. A report for a
   * closed call is ignored unless `isRunningJob` says the call is a
   * background job still running.
   */
  applyReport(
    frame: RunProgressFrame,
    nowMs: number,
    isRunningJob: (toolUseId: string) => boolean = () => false,
  ): void {
    const id = frame.tool_use_id;
    if (id !== null && this.closed.has(id) && !isRunningJob(id)) return;
    const key = keyOf(id);
    const prev = this.entries.get(key);
    // A report replaces the previous report's fields whole — a field absent
    // now was not carried forward by the reporter, so it is not stale-kept
    // here — while the heartbeat fields ride along untouched.
    const unit = str(frame.unit);
    const units = unit === undefined ? undefined : narrowRunUnits(frame.units);
    this.put(key, {
      toolUseId: id,
      label: frame.label,
      text: frame.text,
      done: frame.done,
      total: frame.total,
      failures: frame.failures,
      ...(unit !== undefined ? { unit } : {}),
      ...(unit !== undefined && num(frame.jobs) !== undefined ? { jobs: num(frame.jobs) } : {}),
      ...(units !== undefined ? { units } : {}),
      reportAtMs: nowMs,
      engineElapsedMs: prev?.engineElapsedMs,
      heartbeatAtMs: prev?.heartbeatAtMs,
    });
  }

  /**
   * The call's `tool_result` arrived: forget it, and ignore its late frames.
   * A run that named its unit settles — its last report is kept for
   * {@link getSettled}.
   */
  close(toolUseId: string): void {
    this.closed.add(toolUseId);
    if (this.closed.size > RUN_PROGRESS_CLOSED_CAP) {
      const oldest = this.closed.values().next().value;
      if (oldest !== undefined) this.closed.delete(oldest);
    }
    const entry = this.entries.get(toolUseId);
    if (entry?.unit !== undefined) {
      this.settled.delete(toolUseId);
      this.settled.set(toolUseId, entry);
      if (this.settled.size > RUN_SETTLED_CAP) {
        const oldest = this.settled.keys().next().value;
        if (oldest !== undefined) {
          this.settled.delete(oldest);
          this.notify(oldest);
        }
      }
    }
    if (this.entries.delete(toolUseId)) this.notify(toolUseId);
  }

  /** A closed call's last unit report, or `null`. */
  getSettled(toolUseId: string): RunProgress | null {
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
  get(key: string | null): RunProgress | null {
    return this.entries.get(keyOf(key)) ?? null;
  }

  private put(key: string, entry: RunProgress): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
    if (this.entries.size > RUN_PROGRESS_CAP) {
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

/**
 * The one line a report reads as: `label · done/total · N fail · text`, each
 * part omitted when absent (`done` alone without a total; no failure part at
 * zero). A total known only from history arrives in `text` already marked
 * `~` by the reporter, never in `total`, which is always exact.
 */
export function formatRunProgressLine(p: RunProgress): string {
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
  p: RunProgress | null,
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
  p: RunProgress | null,
  nowMs: number,
): "live" | "quiet" | null {
  if (p?.heartbeatAtMs === undefined) return null;
  return nowMs - p.heartbeatAtMs < ENGINE_LIVE_MS ? "live" : "quiet";
}
