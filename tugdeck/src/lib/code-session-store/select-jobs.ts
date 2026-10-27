/**
 * Background-jobs ledger — the camelCase mapping for the decoded
 * `task_started` / `task_updated` / `task_progress` IPC frames and the
 * pure helpers behind the Z2 `JOBS` cell.
 *
 * **Terminology guard.** Two unrelated "task" vocabularies cross this
 * store. The `TaskCreate` / `TaskUpdate` *tool calls* are the todo
 * list behind the TASKS cell ([D100], `select-task-list.ts`). The
 * `system/task_started` / `system/task_updated` *frames* handled here
 * are the background-job lifecycle (`Bash` / `Agent` with
 * `run_in_background: true`) behind the JOBS cell. Deck-side names use
 * the job vocabulary throughout; only wire-frame spellings keep
 * claude's `task_*` prefix.
 *
 * Wire shapes are pinned by the captured fixtures at
 * `tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/`
 * `v2.1.173-jobs-spike/` — notably: `task_started` fires for
 * foreground subagents too, with no backgrounded discriminant on the
 * frame, so consumers gate on the launching tool call via `toolUseId`
 * ({@link isJobLaunch}: backgrounded, or a `Monitor` watcher). A
 * monitor's only `task_notification` is terminal (mid-life events
 * wake claude via task-id-less re-inits), and its terminal statuses
 * agree with `task_updated`.
 *
 * @module lib/code-session-store/select-jobs
 */

import type { DecodedFrame } from "@tugproto/outbound-decoders";
import type { ToolUseMessage } from "./types";
import type {
  TaskStartedEvent,
  TaskUpdatedEvent,
  TaskProgressEvent,
} from "./events";

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

/**
 * Lifecycle of one background job. Wire mapping: `task_updated`'s
 * `"killed"` and `task_notification`'s `"stopped"` both read
 * {@link JobStatus} `"stopped"`; `"completed"` / `"failed"` map
 * directly.
 *
 * `"scheduled"` is the time-deferred state for wakeup / cron rows:
 * nothing is executing, the work is promised for a future time. It is
 * neither running nor terminal — a scheduled row pulses the cell (work
 * pending) but is excluded from the `finished/total` fraction, and
 * survives the popover's Clear like a running row.
 */
export type JobStatus =
  | "running"
  | "scheduled"
  | "completed"
  | "failed"
  | "stopped";

/**
 * Statuses that mean the job is no longer doing (or awaiting) work.
 * `"running"` and `"scheduled"` are both non-terminal — a scheduled
 * wakeup has work pending, so it must not be cleared or counted as
 * finished.
 */
export function isTerminalJobStatus(status: JobStatus): boolean {
  return status !== "running" && status !== "scheduled";
}

/** A row whose work is promised for a future time (wakeup / cron). */
export function isScheduledJobStatus(status: JobStatus): boolean {
  return status === "scheduled";
}

/**
 * One background job in the session-lifetime ledger. `jobId` is
 * claude's `task_id` (`backgroundTaskId` / `agentId` in the launch
 * echoes); for a `"cron"` row it is the cron id parsed from the
 * `CronCreate` echo (or a synthetic fallback). `source` is a
 * forward-compat discriminant — only `"claude"` ships; the shape
 * stays open for a possible tugexec future without consumers ever
 * switching on it.
 *
 * `firesAtMs` / `scheduleLabel` carry the `"scheduled"`-row payload:
 * a one-shot wakeup has a `firesAtMs` target (drives the derived
 * countdown), a cron has a `scheduleLabel` (its expression) and a
 * `null` `firesAtMs` (next-occurrence is deferred). "Fired late" /
 * "never fired" are derived from `firesAtMs` + `endedAtMs` at render
 * — there is no stored late flag.
 */
export interface JobItem {
  jobId: string;
  source: "claude";
  kind: "bash" | "agent" | "monitor" | "unknown" | "wakeup" | "cron" | "remote";
  toolUseId: string;
  description: string;
  outputFile?: string;
  status: JobStatus;
  startedAtMs: number;
  endedAtMs: number | null;
  /** One-shot wakeup target (ms); `null`/absent for crons + non-scheduled rows. */
  firesAtMs?: number | null;
  /** Human label for a recurring cron (e.g. its cron expression). */
  scheduleLabel?: string;
  /**
   * Live progress from the most recent `task_progress` tick, folded onto
   * a running agent row so the JOBS cell can show what it is doing.
   * Absent until the first tick (bash jobs and scheduled rows never emit
   * `task_progress`, so they keep it `undefined`). Cleared by nothing —
   * the last tick's snapshot stays on a terminal row as its final state.
   */
  progress?: JobProgress;
  /**
   * A background agent's child tool calls, accumulated from its
   * out-of-band transcript as tugcode tails it live (each a real
   * `ToolUseMessage`, keyed by `toolUseId`). A background agent's children
   * arrive *inter-turn* — after the launching turn already committed — so
   * they can't attach to a turn; they ride the job instead, and the Agent
   * block reads them here to render the same broken-out blocks live that a
   * resume reconstructs. Absent for bash/monitor/scheduled rows.
   */
  childCalls?: readonly ToolUseMessage[];
  /**
   * The agent's composed `structured_result` (final answer + stats) once
   * its transcript has been tailed to completion. The launching call's own
   * result is only the async-launch echo, so the Agent block prefers this
   * for the final answer + footer. Absent until produced.
   */
  agentStructuredResult?: unknown;
}

/**
 * Latest-wins snapshot of a running agent's progress, from
 * `task_progress`. `lastToolName` is the agent's most recent tool;
 * the usage fields are cumulative across the agent's lifetime.
 */
export interface JobProgress {
  lastToolName?: string;
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
}

const EMPTY_JOBS: readonly JobItem[] = Object.freeze([]);

/**
 * Reference-stable empty ledger — the reducer's initial value and the
 * result of clearing every row, so "no jobs" consumers can compare
 * with `Object.is`.
 */
export const EMPTY_JOBS_LEDGER: readonly JobItem[] = EMPTY_JOBS;

// ---------------------------------------------------------------------------
// Wire mapping (pure)
// ---------------------------------------------------------------------------

/**
 * Map a decoded `task_started` frame onto the camelCase
 * {@link TaskStartedEvent}. The decoder has checked the shape; this refuses
 * an empty `task_id` / `tool_use_id`, a value no job row can be keyed by,
 * by returning `undefined` so the frame is dropped.
 */
export function taskStartedEvent(
  frame: DecodedFrame<"task_started">,
): TaskStartedEvent | undefined {
  const { task_id: taskId, tool_use_id: toolUseId, subagent_type: subagentType } = frame;
  if (taskId.length === 0 || toolUseId.length === 0) return undefined;
  return {
    type: "task_started",
    taskId,
    toolUseId,
    description: frame.description,
    taskType: frame.task_type,
    ...(subagentType !== undefined ? { subagentType } : {}),
    ...tugSessionIdOf(frame),
  };
}

/**
 * Map a decoded `task_updated` frame onto the camelCase
 * {@link TaskUpdatedEvent}. tugcode has already flattened claude's
 * `patch` object onto the frame (`status` / `end_time`). An empty
 * `task_id` or `status` is refused, as in {@link taskStartedEvent}.
 */
export function taskUpdatedEvent(
  frame: DecodedFrame<"task_updated">,
): TaskUpdatedEvent | undefined {
  const { task_id: taskId, status } = frame;
  if (taskId.length === 0 || status.length === 0) return undefined;
  return {
    type: "task_updated",
    taskId,
    status,
    ...(frame.end_time !== undefined ? { endTime: frame.end_time } : {}),
    ...tugSessionIdOf(frame),
  };
}

/**
 * Map a decoded `task_progress` frame onto the camelCase
 * {@link TaskProgressEvent}. An empty `task_id` / `tool_use_id` is
 * refused; the progress detail (`last_tool_name`, `usage`) is optional
 * and camelCased here so a partial frame still folds.
 */
export function taskProgressEvent(
  frame: DecodedFrame<"task_progress">,
): TaskProgressEvent | undefined {
  const {
    task_id: taskId,
    tool_use_id: toolUseId,
    subagent_type: subagentType,
    last_tool_name: lastToolName,
    usage: rawUsage,
  } = frame;
  if (taskId.length === 0 || toolUseId.length === 0) return undefined;
  const usage = rawUsage
    ? {
        ...(rawUsage.total_tokens !== undefined
          ? { totalTokens: rawUsage.total_tokens }
          : {}),
        ...(rawUsage.tool_uses !== undefined
          ? { toolUses: rawUsage.tool_uses }
          : {}),
        ...(rawUsage.duration_ms !== undefined
          ? { durationMs: rawUsage.duration_ms }
          : {}),
      }
    : undefined;
  return {
    type: "task_progress",
    taskId,
    toolUseId,
    description: frame.description,
    ...(subagentType !== undefined ? { subagentType } : {}),
    ...(lastToolName !== undefined ? { lastToolName } : {}),
    ...(usage && Object.keys(usage).length > 0 ? { usage } : {}),
    ...tugSessionIdOf(frame),
  };
}

/**
 * tugcast's `tug_session_id` stamp, which no decoder declares and every
 * decoded frame carries through, as a spreadable field.
 */
function tugSessionIdOf(frame: object): { tug_session_id?: string } {
  const id = (frame as { tug_session_id?: unknown }).tug_session_id;
  return typeof id === "string" ? { tug_session_id: id } : {};
}

/**
 * Map a wire status string (`task_updated.status` /
 * `wake_started.wake_trigger.status`) onto a terminal {@link JobStatus}.
 * Returns `undefined` for unknown vocabulary — an unrecognized status
 * is dropped rather than guessed, so future non-terminal additions
 * can't wrongly finish a running row (Risk R01's defensive posture).
 */
export function terminalJobStatusFromWire(
  status: string,
): Exclude<JobStatus, "running"> | undefined {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "killed":
    case "stopped":
      return "stopped";
    default:
      return undefined;
  }
}

/** Map a `task_started.task_type` onto the job's kind. */
export function jobKindFromTaskType(taskType: string): JobItem["kind"] {
  if (taskType === "local_bash") return "bash";
  if (taskType === "local_agent") return "agent";
  return "unknown";
}

/**
 * The ledger's insert gate, shared by the `task_started` and
 * launch-echo insert paths: a tool call launches a trackable job when
 * it is explicitly backgrounded OR it is a `Monitor` — a watcher is
 * background activity by nature (no flag involved). The gate is
 * meaning-based ("is this background work?") rather than
 * mechanism-based ("is the flag set?"); foreground subagents and
 * async-subagent-internal tasks still fail it, the former by the flag,
 * the latter because their launching calls never appear in the deck's
 * stream.
 */
export function isJobLaunch(
  toolName: string,
  input: Record<string, unknown> | null,
): boolean {
  return input?.run_in_background === true || toolName === "Monitor";
}

/**
 * The ledger's second insert gate, beside {@link isJobLaunch}: was this
 * call *moved* to the background after it was launched in the
 * foreground? Claude Code moves a foreground Bash call that outlives
 * its `timeout` (and one a queued message has to get past, one a
 * subagent's cap stops, one the user backgrounds by hand) instead of
 * killing it, and the only tell is the call's own `tool_result`. A
 * moved call is background work from that moment, so it belongs in
 * JOBS as a launch does — but `isJobLaunch` reads the *input*, which
 * says nothing about it, so the move has its own gate that reads the
 * result ({@link parseMovedCallResult}). Only a Bash call can be moved:
 * a `task_started` naming a Bash call that is still pending — no
 * result yet — and was not launched as a job is the move's first edge,
 * and this is that reading.
 */
export function isMovedForegroundCall(
  toolName: string,
  input: Record<string, unknown> | null,
  status: ToolUseMessage["status"],
): boolean {
  return (
    toolName.toLowerCase() === "bash" &&
    status === "pending" &&
    !isJobLaunch(toolName, input)
  );
}

/**
 * Kind for a launch, from the launching tool's name first. The frame's
 * `task_type` cannot discriminate monitors — a watcher's script reports
 * `"local_bash"` (captured in `test-monitor-lifecycle-raw.jsonl`) — so
 * the tool name is the only honest source; `task_type` remains the
 * fallback for bash/agent.
 */
export function jobKindForLaunch(
  toolName: string,
  taskType: string,
): JobItem["kind"] {
  if (toolName === "Monitor") return "monitor";
  return jobKindFromTaskType(taskType);
}

// ---------------------------------------------------------------------------
// Launch-echo parsing (pure)
// ---------------------------------------------------------------------------

/** Parsed identity of a background launch from its `tool_result`. */
export interface BackgroundLaunchEcho {
  jobId: string;
  kind: JobItem["kind"];
  outputFile?: string;
}

/**
 * Extract the job identity from a background launch's `tool_result`
 * payload. Two echo families exist (v2.1.173-jobs-spike capture):
 *
 *  - Bash: a plain string — `"Command running in background with ID:
 *    <id>. Output is being written to: <path>. …"`.
 *  - Agent: an array of text blocks whose first lines read `"Async
 *    agent launched successfully.\nagentId: <id> (…)"` with a later
 *    `"output_file: <path>"` line.
 *  - Monitor: `"Monitor started (task <id>, timeout <n>ms)."` or
 *    `"Monitor started (task <id>, persistent — runs until TaskStop or
 *    session end)."` — no output file.
 *
 * Returns `undefined` when neither pattern matches — callers fall
 * back to the `task_started` insert path, so a drifted echo degrades
 * to "job appears when its frame lands" rather than breaking.
 */
export function parseBackgroundLaunchResult(
  result: unknown,
): BackgroundLaunchEcho | undefined {
  const text = launchEchoText(result);
  if (text === undefined) return undefined;
  // `(\S+?)\.(?=\s|$)` — the value runs to the sentence's final period
  // (lookahead, not consumed-first-dot), so a path like
  // `…/tasks/<id>.output.` keeps its `.output` extension.
  const bash = /Command running in background with ID: (\S+?)\.(?=\s|$)(?:\s+Output is being written to: (\S+?)\.(?=\s|$))?/.exec(
    text,
  );
  if (bash !== null) {
    return {
      jobId: bash[1],
      kind: "bash",
      ...(bash[2] !== undefined ? { outputFile: bash[2] } : {}),
    };
  }
  const monitor = /Monitor started \(task (\S+?)[,)]/.exec(text);
  if (monitor !== null) {
    return { jobId: monitor[1], kind: "monitor" };
  }
  const agent = /agentId: (\S+) /.exec(text);
  if (agent !== null && text.includes("Async agent launched successfully")) {
    const outFile = /output_file: (\S+)/.exec(text);
    return {
      jobId: agent[1],
      kind: "agent",
      ...(outFile !== null ? { outputFile: outFile[1] } : {}),
    };
  }
  return undefined;
}

/** Parsed identity of a moved call from its `tool_result`. */
export interface MovedCallEcho {
  jobId: string;
  outputFile: string;
}

/**
 * Extract the job identity from a *moved* call's `tool_result` — the
 * sentence Claude Code answers a foreground Bash call with when it moves
 * the call to the background instead of ending it. The match is on
 * shape, not wording: `moved to the background (ID: <id>)` (every reason
 * the harness gives ends that way: the timeout, a subagent's cap, a
 * message queued mid-call) or `backgrounded by user with ID: <id>`, and
 * `Output is being written to: <path>`. The sentence is not anchored at
 * the start — the output the command produced before the move precedes
 * it. The same reader lives Rust-side in `tugcore::moved_call`, and the
 * stream-json drift regression pins it to the live wire; this side is
 * pinned to the verbatim sentence read off that wire.
 *
 * Returns `undefined` for an ordinary result, including the
 * `run_in_background` launch echo (`Command running in background with
 * ID: …`), which {@link parseBackgroundLaunchResult} owns.
 */
export function parseMovedCallResult(
  result: unknown,
): MovedCallEcho | undefined {
  const text = launchEchoText(result);
  if (text === undefined) return undefined;
  const id =
    /moved to the background \(ID: ([^)\s]+)/.exec(text)?.[1] ??
    /backgrounded by user with ID: ([^.\s]+)/.exec(text)?.[1];
  if (id === undefined) return undefined;
  // The path is the token after the mark, less the sentence's closing
  // period, so `…/tasks/<id>.output.` keeps its `.output` extension — the
  // same reading as `tugcore::moved_call`, so the two sides never disagree
  // about whether a result was a move.
  const outputFile = /Output is being written to: (\S+)/.exec(text)?.[1].replace(/\.+$/, "");
  if (outputFile === undefined || outputFile.length === 0) return undefined;
  return { jobId: id, outputFile };
}

/** Collapse a `tool_result` content payload to searchable text. */
function launchEchoText(result: unknown): string | undefined {
  if (typeof result === "string") return result;
  if (Array.isArray(result)) {
    const parts: string[] = [];
    for (const block of result) {
      if (
        typeof block === "object" &&
        block !== null &&
        (block as Record<string, unknown>).type === "text" &&
        typeof (block as Record<string, unknown>).text === "string"
      ) {
        parts.push((block as Record<string, unknown>).text as string);
      }
    }
    return parts.length > 0 ? parts.join("\n") : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Ledger updates (pure)
// ---------------------------------------------------------------------------

/**
 * Insert-or-enrich a job keyed by `jobId`. A fresh id appends a
 * `running` row (insertion order is display order). An existing id
 * keeps its row — only absent `description` / `outputFile` fields are
 * filled in — so the `task_started` and launch-echo insert paths
 * compose idempotently in either arrival order.
 */
export function insertJob(
  jobs: readonly JobItem[],
  item: JobItem,
): readonly JobItem[] {
  const idx = jobs.findIndex((j) => j.jobId === item.jobId);
  if (idx === -1) return [...jobs, item];
  const existing = jobs[idx];
  const enriched: JobItem = {
    ...existing,
    description:
      existing.description.length > 0 ? existing.description : item.description,
    ...(existing.outputFile === undefined && item.outputFile !== undefined
      ? { outputFile: item.outputFile }
      : {}),
    ...(existing.kind === "unknown" && item.kind !== "unknown"
      ? { kind: item.kind }
      : {}),
  };
  if (
    enriched.description === existing.description &&
    enriched.outputFile === existing.outputFile &&
    enriched.kind === existing.kind
  ) {
    return jobs;
  }
  const next = jobs.slice();
  next[idx] = enriched;
  return next;
}

/**
 * Flip one `running` row to a terminal status. Unknown ids and
 * already-terminal rows are left untouched (first terminal flip wins
 * — the wire can deliver the same outcome via `task_updated`, the
 * wake trigger, and a `TaskStop` fold, in any order). Returns the
 * input array unchanged (same reference) when nothing flips.
 */
export function applyJobFlip(
  jobs: readonly JobItem[],
  jobId: string,
  status: Exclude<JobStatus, "running">,
  endedAtMs: number,
): readonly JobItem[] {
  const idx = jobs.findIndex((j) => j.jobId === jobId);
  if (idx === -1) return jobs;
  if (jobs[idx].status !== "running") return jobs;
  const next = jobs.slice();
  next[idx] = { ...jobs[idx], status, endedAtMs };
  return next;
}

/**
 * Fold a `task_progress` tick's detail onto its job row (latest wins).
 * A no-op when the row is unknown (the agent was foreground, so no
 * ledger row was inserted) or already terminal (a late tick must not
 * disturb a finished row's final snapshot). Returns the same array
 * reference when nothing changed, so `useSyncExternalStore` consumers
 * don't re-render on an ignored tick.
 */
export function applyJobProgress(
  jobs: readonly JobItem[],
  ev: TaskProgressEvent,
): readonly JobItem[] {
  const idx = jobs.findIndex((j) => j.jobId === ev.taskId);
  if (idx === -1) return jobs;
  if (jobs[idx].status !== "running") return jobs;
  const progress: JobProgress = {
    ...(ev.lastToolName !== undefined ? { lastToolName: ev.lastToolName } : {}),
    ...(ev.usage?.totalTokens !== undefined
      ? { totalTokens: ev.usage.totalTokens }
      : {}),
    ...(ev.usage?.toolUses !== undefined ? { toolUses: ev.usage.toolUses } : {}),
    ...(ev.usage?.durationMs !== undefined
      ? { durationMs: ev.usage.durationMs }
      : {}),
  };
  // An empty tick (no tool name, no usage) carries no new information.
  if (Object.keys(progress).length === 0) return jobs;
  const next = jobs.slice();
  next[idx] = { ...jobs[idx], progress };
  return next;
}

/**
 * Whether any job owns `parentToolUseId` as its launching call — i.e.
 * this is a tracked background agent. The reducer uses this to decide
 * that an inter-turn `parent_tool_use_id` child belongs on the job
 * ledger rather than being dropped (only background agents have a job;
 * a foreground agent returns its answer and never creates one).
 */
export function jobExistsForParent(
  jobs: readonly JobItem[],
  parentToolUseId: string,
): boolean {
  return jobs.some((j) => j.toolUseId === parentToolUseId);
}

/**
 * The job whose accumulated `childCalls` already contain `childToolUseId`,
 * or `undefined`. Lets the reducer route a child's later `tool_result` /
 * `tool_use_structured` to the same job that holds its `tool_use`.
 */
export function jobIdForChild(
  jobs: readonly JobItem[],
  childToolUseId: string,
): string | undefined {
  const job = jobs.find((j) =>
    (j.childCalls ?? []).some((c) => c.toolUseId === childToolUseId),
  );
  return job?.jobId;
}

/**
 * Append (or merge) a background agent's child `tool_use` onto its job's
 * `childCalls`, keyed by the launching call's `parentToolUseId`. An
 * existing child with the same `toolUseId` is merged (a re-emitted
 * tool_use only fills a richer `input`), so a redelivered frame — a
 * live/resume overlap — never duplicates a row.
 */
export function applyJobChildToolUse(
  jobs: readonly JobItem[],
  parentToolUseId: string,
  child: ToolUseMessage,
): readonly JobItem[] {
  const idx = jobs.findIndex((j) => j.toolUseId === parentToolUseId);
  if (idx === -1) return jobs;
  const existing = jobs[idx].childCalls ?? [];
  const at = existing.findIndex((c) => c.toolUseId === child.toolUseId);
  const nextChildren = existing.slice();
  if (at === -1) {
    nextChildren.push(child);
  } else {
    const prev = existing[at];
    nextChildren[at] = {
      ...prev,
      input:
        Object.keys((child.input ?? {}) as object).length > 0
          ? child.input
          : prev.input,
    };
  }
  const next = jobs.slice();
  next[idx] = { ...jobs[idx], childCalls: nextChildren };
  return next;
}

/**
 * Fold a child's terminal payload (`result` and/or `structuredResult`)
 * onto the matching `childCalls` entry, flipping its status to `done`
 * (or `error` when the patch says so) and recording its wall time when
 * the caller recovered one. No-op when no job owns the child.
 */
export function applyJobChildResult(
  jobs: readonly JobItem[],
  childToolUseId: string,
  patch: {
    result?: unknown;
    structuredResult?: unknown;
    status?: "done" | "error";
    toolWallMs?: number;
  },
): readonly JobItem[] {
  const idx = jobs.findIndex((j) =>
    (j.childCalls ?? []).some((c) => c.toolUseId === childToolUseId),
  );
  if (idx === -1) return jobs;
  const children = jobs[idx].childCalls ?? [];
  const nextChildren = children.map((c) =>
    c.toolUseId === childToolUseId
      ? {
          ...c,
          status: patch.status ?? ("done" as const),
          ...(patch.result !== undefined ? { result: patch.result } : {}),
          ...(patch.structuredResult !== undefined
            ? { structuredResult: patch.structuredResult }
            : {}),
          ...(patch.toolWallMs !== undefined
            ? { toolWallMs: patch.toolWallMs }
            : {}),
        }
      : c,
  );
  const next = jobs.slice();
  next[idx] = { ...jobs[idx], childCalls: nextChildren };
  return next;
}

/**
 * Fold the agent's own composed `structured_result` (final answer +
 * stats) onto its job, keyed by the launching call's `toolUseId`. No-op
 * when no job owns it.
 */
export function applyJobAgentStructured(
  jobs: readonly JobItem[],
  agentToolUseId: string,
  structuredResult: unknown,
): readonly JobItem[] {
  const idx = jobs.findIndex((j) => j.toolUseId === agentToolUseId);
  if (idx === -1) return jobs;
  const next = jobs.slice();
  next[idx] = { ...jobs[idx], agentStructuredResult: structuredResult };
  return next;
}

/**
 * Flip `running` rows to `stopped` — the stale-marking rule for a fresh
 * `session_init`: a respawned claude cannot have carried in-flight
 * background tasks across. `scheduled` rows SURVIVE: every tugcode
 * respawn path resumes (`--resume`), and on claude ≥ 2.1.204 the harness
 * scheduler re-fires a pending wakeup/cron in the resumed process
 * (probe-verified, `tugcode/probes/goal-loop/FINDINGS.md#q02-loop` —
 * reversing the 2.1.150-era finding that scheduled work died on resume).
 * The surviving row reconciles normally when its wake fires
 * (`flipEarliestElapsedScheduled`) or its fire time lapses unmet
 * (`reapElapsedScheduled`), so a genuinely-dead schedule still ages out
 * rather than pulsing forever.
 */
export function markRunningJobsStopped(
  jobs: readonly JobItem[],
  endedAtMs: number,
): readonly JobItem[] {
  if (!jobs.some((j) => j.status === "running")) return jobs;
  return jobs.map((j) =>
    j.status === "running" ? { ...j, status: "stopped", endedAtMs } : j,
  );
}

/**
 * Drop terminal rows; `running` and `scheduled` rows always survive
 * (clearing one would orphan it from the UI with no way to stop or
 * monitor it). An emptied ledger returns the shared frozen empty array.
 */
export function clearTerminalJobs(
  jobs: readonly JobItem[],
): readonly JobItem[] {
  const kept = jobs.filter((j) => !isTerminalJobStatus(j.status));
  if (kept.length === jobs.length) return jobs;
  return kept.length === 0 ? EMPTY_JOBS : kept;
}

// ---------------------------------------------------------------------------
// Display derivation (pure)
// ---------------------------------------------------------------------------

/**
 * Per-status counts plus the `finished/total` cell reading.
 *
 * `total` is the cell's *fraction* denominator — it counts only
 * non-scheduled rows, so a lone pending wakeup never reads "0/1". A
 * time-deferred promise is not an in-flight work unit; it surfaces via
 * the pulse + the "N scheduled" summary, and joins the fraction only
 * once it fires (becoming `completed`). `scheduled` is the separate
 * sub-count for that summary.
 */
export interface JobCounts {
  /** Non-scheduled rows — the `finished/total` fraction denominator. */
  total: number;
  /** ALL running rows, watchers included (`watching` is a subset). */
  running: number;
  /** Running rows of kind `"monitor"` — live watchers. */
  watching: number;
  /** Time-deferred rows (wakeup / cron) — pulse + summary only. */
  scheduled: number;
  completed: number;
  failed: number;
  stopped: number;
  /** Terminal rows — the cell's numerator. */
  finished: number;
}

/**
 * How many jobs are executing right now — the canonical answer to "is
 * this session still doing work?", used by any surface that has to
 * decide that without building the whole {@link JobCounts} struct.
 *
 * `"scheduled"` rows are excluded: a wakeup promised for a future time
 * is pending, not executing, and a session holding only those is
 * genuinely idle. A running `"monitor"` counts like any other kind —
 * the session has an errand outstanding either way.
 */
export function countRunningJobs(jobs: readonly JobItem[]): number {
  let running = 0;
  for (const j of jobs) if (j.status === "running") running += 1;
  return running;
}

export function countJobs(jobs: readonly JobItem[]): JobCounts {
  let running = 0;
  let watching = 0;
  let scheduled = 0;
  let completed = 0;
  let failed = 0;
  let stopped = 0;
  for (const j of jobs) {
    if (j.status === "running") {
      running += 1;
      if (j.kind === "monitor") watching += 1;
    } else if (j.status === "scheduled") scheduled += 1;
    else if (j.status === "completed") completed += 1;
    else if (j.status === "failed") failed += 1;
    else stopped += 1;
  }
  return {
    // Scheduled rows are excluded from the fraction denominator.
    total: jobs.length - scheduled,
    running,
    watching,
    scheduled,
    completed,
    failed,
    stopped,
    finished: completed + failed + stopped,
  };
}

/**
 * The JOBS cell's indicator pose. A pure function of the ledger only
 * — deliberately NO session-phase input: a background job genuinely
 * runs between turns, so an idle session must not demote a running
 * dot (the one semantic divergence from the TASKS cell).
 *
 *  - empty ledger    → `stopped` (quiet placeholder)
 *  - any running     → `running` (the one pose that claims execution)
 *  - else any failed → `aborted` (danger; holds until cleared or
 *                      superseded by a new job)
 *  - else scheduled  → `stopped` — a wakeup promised for a future time is
 *                      not executing, and the cell's count already reports
 *                      it. See `indicator-liveness`.
 *  - else            → `completed`
 */
export function jobsCellPose(
  jobs: readonly JobItem[],
): "stopped" | "running" | "completed" | "aborted" {
  if (jobs.length === 0) return "stopped";
  let anyFailed = false;
  let anyScheduled = false;
  for (const j of jobs) {
    if (j.status === "running") return "running";
    if (j.status === "failed") anyFailed = true;
    if (j.status === "scheduled") anyScheduled = true;
  }
  if (anyFailed) return "aborted";
  return anyScheduled ? "stopped" : "completed";
}

/**
 * The jobs launched by a turn — every ledger row whose launching
 * `toolUseId` is one of the turn's `tool_use` messages. The TIME cell
 * uses this to keep the request clock counting across the turn's
 * still-running background work.
 */
export function jobsOwnedByTurn(
  messages: ReadonlyArray<{ kind: string; toolUseId?: string }>,
  jobs: readonly JobItem[],
): readonly JobItem[] {
  if (jobs.length === 0) return [];
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.kind === "tool_use" && typeof m.toolUseId === "string") {
      ids.add(m.toolUseId);
    }
  }
  if (ids.size === 0) return [];
  return jobs.filter((j) => ids.has(j.toolUseId));
}

/** Narrow an agent structured result's `totalTokens`, else `undefined`. */
function structuredTotalTokens(value: unknown): number | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const t = (value as Record<string, unknown>).totalTokens;
  return typeof t === "number" && Number.isFinite(t) && t >= 0 ? t : undefined;
}

/**
 * Total tokens spent by the subagents a turn launched — the figure
 * Z1B folds into the turn's token count so "#aN tokens" covers the
 * whole response, not just the parent turn's own window delta (a
 * background agent burns its tokens in a separate context that never
 * enters the parent window, so the window walk alone under-reports).
 *
 * Per Agent `tool_use` in the turn, the best available source wins:
 *  1. the job's composed `agentStructuredResult.totalTokens` (live,
 *     genuine completion),
 *  2. the job's latest `task_progress` usage (live, still running —
 *     the figure climbs as ticks land),
 *  3. the call's own `structuredResult.totalTokens` (reload — the
 *     resume splice composes it onto the turn; the async-launch echo
 *     carries no `totalTokens`, so a mid-run launch echo contributes
 *     nothing rather than something wrong).
 */
export function agentTokensForTurn(
  messages: ReadonlyArray<ToolUseMessage | { kind: string }>,
  jobs: readonly JobItem[],
): number {
  let total = 0;
  for (const m of messages) {
    if (m.kind !== "tool_use") continue;
    const call = m as ToolUseMessage;
    const name = call.toolName.toLowerCase();
    if (name !== "agent" && name !== "task") continue;
    const job = jobs.find((j) => j.toolUseId === call.toolUseId);
    const tokens =
      structuredTotalTokens(job?.agentStructuredResult) ??
      job?.progress?.totalTokens ??
      structuredTotalTokens(call.structuredResult) ??
      0;
    total += tokens;
  }
  return total;
}

/**
 * Footer summary with zero-bucket drop — `"1 running, 1 watching,
 * 2 done, 1 failed"` (completed reads "done", stopped reads
 * "stopped"). Live watchers are split out of the running bucket as
 * "watching" so finite work and monitors read distinctly; the cell's
 * `finished/total` and pose treat them identically. An empty ledger
 * reads `"no jobs"`.
 */
export function composeJobsSummary(counts: JobCounts): string {
  const parts: string[] = [];
  const runningJobs = counts.running - counts.watching;
  if (runningJobs > 0) parts.push(`${runningJobs} running`);
  if (counts.watching > 0) parts.push(`${counts.watching} watching`);
  if (counts.scheduled > 0) parts.push(`${counts.scheduled} scheduled`);
  if (counts.completed > 0) parts.push(`${counts.completed} done`);
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  if (counts.stopped > 0) parts.push(`${counts.stopped} stopped`);
  return parts.length > 0 ? parts.join(", ") : "no jobs";
}
