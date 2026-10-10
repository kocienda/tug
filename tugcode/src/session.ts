// Session lifecycle management via direct claude CLI spawning

import { PermissionManager, type PermissionMode } from "./permissions.ts";
import {
  writeLine,
  writeLineAndExit,
  emitErrorFrame,
  errorFrame,
} from "./ipc.ts";
import {
  sendControlRequest,
  sendControlResponse,
  formatPermissionAllow,
  formatPermissionDeny,
  formatQuestionAnswer,
  generateRequestId,
} from "./control.ts";
import {
  parseInitializeControlResponse,
  readControlResponseRequestId,
  enumeratePluginCommands,
  mergePluginCommands,
} from "./capabilities.ts";
import type {
  UserMessage,
  ToolApproval,
  QuestionAnswer,
  PermissionModeMessage,
  OutboundMessage,
  ControlRequestForward,
  ActivityDelta,
  WakeStarted,
  ContentBlock,
  RewindPreview,
  SessionRewind,
  ReplayWindow,
  ReplayLineageEntry,
  ReplayRelocationOrigin,
  SideQuestion,
  SideQuestionAnswer,
  InterruptNoop,
  StopAllWorkDone,
  SessionStageSpec,
} from "./types.ts";
import { IPC_VERSION } from "./types.ts";
import { existsSync, realpathSync } from "node:fs";
import { logSessionLifecycle } from "./session-lifecycle-log.ts";
import {
  type ReplayTelemetry,
  extractTaskNotificationWake,
} from "./replay.ts";
import { ClaudeHome, claudeHomeFromEnv } from "./claude-home.ts";
import { ContextBreakdownEmitter } from "./context-breakdown.ts";
import { SubagentTailer } from "./subagent-tail.ts";
import {
  type ClaudeSpawnConfig,
  buildClaudeArgs,
  buildClaudeSpawnEnv,
  readPluginPrompts,
  resolveClaudePath,
  resolvePluginDir,
} from "./spawn-config.ts";

// Spawn configuration lives in its own module; re-exported so importers of
// `session.ts` are unchanged.
export {
  type ClaudeSpawnConfig,
  PLUGIN_PROMPT_FILES,
  buildClaudeArgs,
  buildClaudeSpawnEnv,
  readPluginPrompts,
  resolvePluginDir,
  tugDataRoot,
} from "./spawn-config.ts";
import {
  type JsonlReadResult,
  defaultJsonlReader,
  defaultJsonlWriter,
  jsonlPathFor,
} from "./journal.ts";

// Journal reading lives in its own module; re-exported so importers of
// `session.ts` are unchanged.
export {
  type ConversationTruncation,
  type JsonlReadResult,
  buildContentBlocksFromLegacyJournal,
  computeConversationTruncation,
  defaultJsonlReader,
  defaultJsonlWriter,
  defaultSessionsDbPath,
  extractUserMessageTextCounts,
  jsonlPathFor,
  readSubagentTranscripts,
  recordTimestampMs,
  subagentsDirFor,
} from "./journal.ts";
import {
  type EventMappingContext,
  buildBackgroundTasksChangedMessage,
  buildTaskProgressMessage,
  buildTaskStartedMessage,
  buildTaskUpdatedMessage,
  buildWakeStartedMessage,
  extractAsyncLaunch,
  mapStreamEvent,
  routeTopLevelEvent,
  streamingUsageFrame,
  terseWakeSummary,
} from "./event-mapping.ts";

// Event mapping lives in its own module; re-exported so importers of
// `session.ts` are unchanged.
export {
  type AsyncLaunch,
  type EventMappingContext,
  type EventMappingResult,
  type ResultMetadata,
  type ToolInputProgressSummary,
  type TopLevelRoutingResult,
  buildBackgroundTasksChangedMessage,
  buildTaskProgressMessage,
  buildTaskStartedMessage,
  buildTaskUpdatedMessage,
  buildWakeStartedMessage,
  extractAsyncLaunch,
  mapStreamEvent,
  parseGoalFeedbackText,
  parseToolInputProgress,
  payloadHexPreview,
  routeTopLevelEvent,
  terseWakeSummary,
} from "./event-mapping.ts";
import { ActiveTurn } from "./active-turn.ts";

// ActiveTurn lives in its own module; re-exported so importers of
// `session.ts` are unchanged.
export { ActiveTurn } from "./active-turn.ts";
import {
  CLAUDE_EOF_GRACE_MS,
  ClaudeProcess,
  type ClaudeSpawner,
  type ClaudeSubprocess,
} from "./claude-process.ts";

// The process types live with ClaudeProcess; re-exported so importers of
// `session.ts` are unchanged.
export type { ClaudeSpawner, ClaudeSubprocess } from "./claude-process.ts";
import { ReplayRunner } from "./replay-runner.ts";
import { Rewind } from "./rewind.ts";
import { TimerSet } from "./timer-set.ts";

/** The keys the manager arms its process-bound timers under. */
const TIMER = {
  activityFlush: "activity-flush",
  interruptEscalation: "interrupt-escalation",
  resultWatchdog: "result-watchdog",
  resumeHandshake: "resume-handshake",
} as const;

// The replay constants live with ReplayRunner; re-exported so importers of
// `session.ts` are unchanged.
export {
  REPLAY_HARD_TIMEOUT_MS,
  REPLAY_LIVE_BUFFER_MAX,
} from "./replay-runner.ts";

interface PendingRequest<T> {
  resolve: (value: T) => void;
  reject: (err: Error) => void;
}

// ---------------------------------------------------------------------------
// Permission deny — canonical SDK rejection text
// ---------------------------------------------------------------------------

/**
 * Canonical permission-deny message the SDK's own built-in interactive
 * prompts send when the user denies a tool call. We mirror it verbatim
 * so the AI receives the same STOP directive it's trained to honor —
 * passing a shorter string (e.g. "User denied") into the SDK leaves the
 * AI without any "STOP and wait" instruction and it proceeds with
 * follow-up tool calls (verified bug, 2026-05-23 session
 * `f39f74c6-80cb-4378-b1a3-fa7a8af7862f`). The SDK forwards the
 * `message` field of our `tool_approval` response verbatim into the
 * `tool_result.content` the AI sees, so the literal text matters.
 */
const CANONICAL_PERMISSION_DENY_MESSAGE =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

// ---------------------------------------------------------------------------
// Respawn and send timing
// ---------------------------------------------------------------------------

/**
 * Health gate for the resume-mode `initialize` handshake. A `--resume`
 * spawn with a stale id prints "No conversation found" and exits well
 * inside ~1s (the supervisor's eager-spawn contract leans on the same
 * fast-exit); a spawn still alive after this delay is a healthy resume,
 * safe to handshake without perturbing the early-exit watcher's view of
 * a failing spawn. See `sendInitializeHandshake`.
 */
export const RESUME_INITIALIZE_DELAY_MS = 2_000;

/**
 * Cap on how long a `/rewind` respawn waits for its `initialize` handshake
 * ack before the `rewind_result` goes out anyway ([#step-7-2]). The ack is
 * what makes the sheet's progress state honest: it means "rewound AND the
 * resumed claude has loaded", so the sheet stays up — indeterminate — for the
 * whole opaque window rather than dismissing onto a session that cannot yet
 * answer. A claude that never acks (crashed on the respawn) must not strand
 * the sheet, so the wait is bounded; the rewind itself already succeeded on
 * disk by then, and the ack reports that truthfully.
 */
export const REWIND_READY_TIMEOUT_MS = 20_000;

/**
 * How long `stop_all_work` waits for the respawn's handshake before answering
 * anyway. Inside tugcast's own ceiling on the stop, so a slow resume answers
 * `done` with the jobs honestly gone rather than letting the wait expire.
 */
export const STOP_ALL_WORK_READY_TIMEOUT_MS = 15_000;

/**
 * Cap on each of the two waits a submit sits behind before it can reach
 * claude's stdin: the cold-boot readiness gate (`claudeReadyPromise`) and
 * the respawn gate. A cold `--resume` spawn is 5–10 s of silent binary load
 * and JSONL read, and a respawn is a kill plus one of those, so the bound is
 * generous — it is a horizon, not a performance budget, and it exists so the
 * wait ends in a frame rather than never.
 *
 * **This does not bound claude's silence, and must not be made to.** The 30 s
 * spawn watchdog {@link SessionManager.spawnClaudeAndWatch}'s docstring
 * describes was removed for a good reason: its only proxy for "claude is
 * hung" flipped on user input, so it read as "user idle for 30 s" and killed
 * healthy sessions. What is bounded here is the *deck-visible send path* —
 * two promises tugcode itself owns and can see the state of — and the expiry
 * emits a frame and returns without touching the claude process at all.
 */
export const SEND_HORIZON_MS = 30_000;

/**
 * Resolve `true` if `promise` settles within `timeoutMs`, `false` on expiry.
 * A rejection propagates rather than reading as expiry: the caller's
 * pre-existing rejection path is a different answer from "the wait ran out",
 * and conflating them would hide a throw behind a horizon.
 */
async function settlesWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const expiry = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([promise.then(() => true), expiry]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Turn and process timing
// ---------------------------------------------------------------------------

/**
 * Activity-flush cadence ([Q06]). 250 ms matches the deck meter's bin so the
 * consumer math is unchanged: one `activity_delta` per bin per live turn.
 */
const ACTIVITY_FLUSH_MS = 250;

/**
 * Cancel-escalation grace. `handleInterrupt` first sends the in-band
 * `interrupt` control-request (the graceful path — a healthy claude ends the
 * turn and emits its own `result`). If the turn hasn't ended within this
 * window claude is wedged and can't service its own stdin, so tugcode
 * escalates to an OS-level force-terminate + resume-respawn. The user's cancel
 * must always win; 2s is comfortably longer than a healthy interrupt
 * round-trip.
 */
const INTERRUPT_ACK_GRACE_MS = 2000;

/**
 * Result-liveness watchdog. Claude closes each assistant message with a
 * `message_delta` carrying a terminal `stop_reason`, then emits its turn-final
 * `result` almost immediately. If a terminal stop is seen but no `result`
 * lands within this window the turn is wedged post-content (the 2026-07-22
 * commit-xp hang: final text delivered, `result` never arrived, cancel
 * powerless). Force-terminate and resume-respawn rather than spin forever.
 * Generous enough that a slow final flush never trips it.
 */
const RESULT_WATCHDOG_MS = 12000;

/**
 * How long a user message's write to claude's stdin may stay pending before
 * claude is treated as wedged. Bun's `FileSink.write` and `flush` return a
 * promise when the pipe is full, which means claude is not reading its stdin;
 * one message can carry a 5 MB image, so without a bound a wedged claude is
 * an unbounded queue with no signal to anyone. The window is the result
 * watchdog's, because expiry takes the same recovery a stalled turn takes —
 * {@link SessionManager.forceTerminateAndRespawn} — and a healthy claude
 * drains even the largest message in a fraction of it.
 */
const STDIN_WRITE_TIMEOUT_MS = RESULT_WATCHDOG_MS;

/** A `FileSink` result is a byte count, or a promise of one while the pipe is full. */
function isPending<T>(result: T | Promise<T>): result is Promise<T> {
  return result instanceof Promise;
}

/**
 * The `message_delta.delta.stop_reason` values that close an assistant message
 * for good — the turn's `result` must follow. `tool_use` is deliberately
 * excluded: it opens another tool-loop iteration, not the turn's end, so it
 * must never arm the result watchdog.
 */
const TERMINAL_STOP_REASONS: ReadonlySet<string> = new Set([
  "end_turn",
  "stop_sequence",
  "max_tokens",
]);

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

/**
 * Manages claude CLI process lifecycle, message identity, and streaming.
 * Spawns claude with --output-format stream-json --input-format stream-json
 * per D01/D02.
 */
export class SessionManager {
  /**
   * The claude subprocess: the live child, its stdout drain and stderr
   * reader, and the kill ladder. The manager decides when to launch and
   * tear it down; {@link ClaudeProcess} does the process work.
   */
  private readonly claude: ClaudeProcess;
  /** The live claude child; `null` between spawn lifecycles. */
  private get claudeProcess(): ClaudeSubprocess | null {
    return this.claude.child;
  }
  private set claudeProcess(child: ClaudeSubprocess | null) {
    this.claude.child = child;
  }
  /** The Claude Code CLI version; see {@link ClaudeProcess.claudeCodeVersion}. */
  private get claudeCodeVersion(): string | null {
    return this.claude.claudeCodeVersion;
  }
  private set claudeCodeVersion(version: string | null) {
    this.claude.claudeCodeVersion = version;
  }
  /**
   * The currently-in-flight turn. Opened either by
   * {@link handleUserMessage} (the idle case — no turn running) or by
   * the stdout drain (a buffered follow-on turn — see
   * {@link handleClaudeLine}); closed by the drain when claude's
   * `result` lands or its stdout EOFs. The stdout drain dispatches
   * every parsed claude event into this field's value; when it's
   * `null`, events route through {@link handleInterTurnEvent} unless a
   * turn input is pending. Single-threaded JS guarantees the drain and
   * `handleUserMessage` see a consistent view without locks.
   */
  private activeTurn: ActiveTurn | null = null;
  /**
   * Every timer armed on behalf of the live claude process, cleared in one
   * call by {@link killAndCleanup} so a respawn inherits none of them:
   *
   * - `activity-flush` — the 250 ms activity-flush interval ([Q06], [P13]).
   *   Started lazily the first time a turn dispatches an event and left
   *   running (unref'd, so it never blocks process exit) until the process
   *   is torn down; each tick flushes the live turn's accumulator as an
   *   `activity_delta`, a no-op between turns. The final decaying bin is
   *   emitted by an explicit trailing flush at turn end (before
   *   `activeTurn` is cleared), so a short turn that ends within a bin
   *   still reports its work.
   * - `interrupt-escalation` — armed by {@link handleInterrupt} after the
   *   in-band interrupt control-request; fires
   *   {@link forceTerminateAndRespawn} if a wedged claude doesn't end the
   *   turn within {@link INTERRUPT_ACK_GRACE_MS}. Cleared the moment the
   *   turn completes by any path.
   * - `result-watchdog` — armed when a terminal `stop_reason` is seen with
   *   no `result` yet; fires {@link forceTerminateAndRespawn} after
   *   {@link RESULT_WATCHDOG_MS}. Cleared on `result` or a fresh
   *   `message_start` (a new iteration means claude kept working).
   * - `resume-handshake` — the {@link RESUME_INITIALIZE_DELAY_MS} health
   *   gate before a resume spawn's `initialize` handshake.
   *
   * Timers that settle a promise somebody awaits (the send horizons, the
   * spawn-ready wait, the replay budget, the kill ladder's graces) stay
   * local to the operation that arms them: clearing one from outside would
   * strand its await.
   */
  private readonly timers = new TimerSet();
  /**
   * FIFO of user messages written to claude's stdin while a turn was
   * already in flight — submitted but not yet bracketed by an
   * `ActiveTurn`. claude buffers a mid-turn `user_message` and runs it
   * as a separate follow-on turn with its own `result`; the stdout
   * drain opens an `ActiveTurn` for that turn and claims the head of
   * this FIFO as the turn's user-message payload. Empty in the common,
   * non-overlapping case (one turn fully completes before the next
   * `handleUserMessage`), so the drain-open path in
   * {@link handleClaudeLine} is dormant in normal operation.
   *
   * Exception: when claude *merges* a mid-turn message into the
   * running turn — it does this at an agent-loop iteration boundary; see
   * `tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/v2.1.181-steering-spike/queued-command-mechanism.md`
   * — no follow-on turn is produced and
   * the merged message's entry is left stale here. tugcode cannot
   * distinguish merge from buffer at submit time (claude emits no
   * signal for it), so a stale entry mislabels at most one later
   * turn's replay-synthetic `add_user_message` text; the wire
   * `turn_complete` bracketing is unaffected. Threading the user's
   * merge-vs-queue intent down from tugdeck is a follow-on concern.
   */
  private pendingTurnInputs: Array<{
    content: ReadonlyArray<ContentBlock>;
  }> = [];
  /**
   * True once the stdout drain has observed EOF on claude's stdout.
   * Read by {@link handleUserMessage} as a fast-path check before
   * installing an `ActiveTurn` — if claude's stdout has already
   * closed, no events will dispatch into the turn and the await on
   * its completion would block forever. The handler emits the
   * canonical end-of-stream error frame and returns instead. Reset
   * by {@link startStdoutDrain} when a fresh claude is spawned.
   */
  private claudeStdoutEofObserved: boolean = false;
  /**
   * True once {@link reattachAfterEof} has tried (and failed) to bring a
   * fresh claude up for the current EOF episode. One attempt per episode:
   * a respawn that cannot spawn will not spawn on the next submit either,
   * and retrying it per keystroke-batch would turn a dead session into a
   * fork bomb. Reset alongside {@link claudeStdoutEofObserved} by
   * {@link startStdoutDrain}, so a claude that *does* come up restores the
   * one attempt the next EOF is entitled to.
   */
  private eofReattachAttempted: boolean = false;
  private permissionManager: PermissionManager;
  /**
   * The session's current reasoning-effort level ([#step-4]), or `null` when
   * no `--effort` override is in force. tugcode owns the `--effort` flag, so
   * this is the authority for the effort surfaced in `session_capabilities`
   * and re-applied on every (re)spawn. Set by {@link handleEffortChange},
   * which respawns claude to apply it (there is no live `set_effort` control
   * subtype in 2.1.158 — [R07]).
   */
  private currentEffort: string | null = null;
  /**
   * The model selector the user has chosen (`sonnet`, `fable`, …), or `null`
   * for the account default (which needs no `--model` flag).
   *
   * Unlike model *setting*, which is a live `set_model` control request to the
   * running process, model *survival* is tugcode's job: every respawn tugcode
   * performs for its own reasons — an `--effort` change, an `--add-dir`, a
   * fork, a continue — starts a process that knows nothing of the control
   * requests the old one received. Without this record those respawns silently
   * drop the user's model back to the account default. Recorded by
   * {@link handleModelChange} and re-applied by {@link liveSpawnConfig}.
   */
  private currentModel: string | null = null;
  /**
   * The name of the arc this session's claude runs under, or null when it
   * runs under none.
   *
   * Recorded here beside {@link currentModel} rather than in
   * {@link liveSpawnConfig}, which carries spawn *flags* and not environment:
   * the variable must survive tugcode's own respawns (an `--effort` change, an
   * `/add-dir`) exactly as the model does, and {@link spawnClaude} reads it
   * into the child's environment on every one.
   *
   * Per-arc, not per-card: a fresh session started with no stage clears it, so
   * the first plain `/new` after an arc spawns without `TUG_ARC`.
   */
  private currentArc: string | null = null;
  /**
   * Working directories added via `/add-dir` ([#step-13c]), in add order. Like
   * {@link currentEffort}, tugcode owns the `--add-dir` flags and re-applies
   * these on every (re)spawn (claude has no live add-directory control verb
   * over the bridge). {@link handleAddDirectory} appends + respawns to apply.
   */
  private additionalDirectories: string[] = [];
  /**
   * Optional `/context`-style breakdown emitter. Injected by main.ts
   * after reading the user's Claude Code settings; null in tests and
   * any caller that doesn't supply one. When present, the dispatcher
   * invokes its lifecycle methods on `system:init`, `result`
   * (cost_update), and `system:compact_boundary` events, and on every
   * inbound user message (for calibration anchor data).
   */
  private contextBreakdownEmitter: ContextBreakdownEmitter | null = null;
  private seq: number = 0;
  // Legacy pending maps kept for reference; control flow is now via control_response writes.
  private pendingApprovals = new Map<string, PendingRequest<"allow" | "deny">>();
  private pendingQuestions = new Map<string, PendingRequest<Record<string, string>>>();
  // Stores raw control_requests by request_id for correlation with IPC messages.
  private pendingControlRequests = new Map<string, Record<string, unknown>>();
  private projectDir: string;
  /**
   * The one identifier for this session. Generated by tugdeck (for a
   * fresh spawn) or picked from the tugbank `sessions` record (for a
   * resume), passed to tugcast on `spawn_session`, and forwarded to
   * tugcode via `--session-id`. Claude uses it as its own session id
   * (`claude --session-id <id>` for fresh, `claude --resume <id>` for
   * resume), and tugcode keys the sessions record by it.
   */
  private sessionId: string;
  /**
   * `"new"` spawns claude with `--session-id <id>` (claiming the id);
   * `"resume"` spawns claude with `--resume <id>` (loading an existing
   * conversation). Both modes share the same `initialize()` path; the
   * only mode-specific thing is the claude flag, plus a background
   * watcher that surfaces resume failures via `resume_failed` IPC.
   */
  private sessionMode: "new" | "resume";
  /**
   * The persisted claude session id, threaded in from tugcast via
   * `--resume-session <id>`. Set when tugcast's tugbank record carries
   * a `claude_session_id` for this card; `null` for fresh spawns and
   * for resume spawns whose claude id was never captured (pre-
   * `session_init` crash, or an older tugbank record).
   *
   * In resume mode, this id wins over `sessionId` for the claude
   * `--resume <id>` invocation: when claude has rotated its internal id
   * (e.g., after a fork) the JSONL on disk is keyed by the claude id,
   * not the tug id. The fallback to `sessionId` covers un-forked
   * sessions whose tug and claude ids happen to match.
   */
  private resumeSessionId: string | null;
  /**
   * Set true the first time `handleUserMessage` successfully writes a
   * user message to claude's stdin. After that, claude has been seen
   * alive end-to-end and any subsequent exit is a runtime crash, not
   * an init failure. The early-exit watcher gates its IPC emission on
   * this flag — without it, indefinite watching would mis-classify
   * mid-conversation crashes as init failures.
   */
  private claudeReceivedInput: boolean = false;
  /**
   * Set true when shutdown has begun (signal handler, stdin EOF,
   * killAndCleanup). The early-exit watcher reads this before emitting
   * to avoid surfacing a phantom resume_failed for a claude exit that
   * was caused by us killing it.
   */
  private isShuttingDown: boolean = false;
  /**
   * True while a spontaneous-wake bracket is open on the wire — set
   * when `handleInterTurnEvent` emits a `wake_started` IPC frame in
   * response to a `system/task_notification` event, cleared when the
   * wake's terminal `result` lands and the ActiveTurn closes.
   *
   * Gates two behaviors:
   *   1. Nested `system/task_notification` arriving inside an open
   *      wake is a no-op (idempotent — one bracket per wake on the
   *      wire; inner trigger metadata is logged at debug level only).
   *   2. The ActiveTurn-cleanup site in `handleClaudeLine` also clears
   *      this flag so the next `system/task_notification` re-opens a
   *      fresh bracket.
   *
   * See the session-wake design record [D02] for the detector
   * design and [Q01] for the empirical wire shape that justifies
   * `handleInterTurnEvent` (not `routeTopLevelEvent`) as the detector
   * site — `task_notification` arrives strictly between turns.
   */
  private isInWake: boolean = false;
  /**
   * Live tailers for running background agents, keyed by `agentId`
   * (= the agent's task id on its lifecycle frames). Started from the
   * async-launch echo ({@link extractAsyncLaunch}), stopped with a
   * final flush on the agent's terminal `task_updated` /
   * `task_notification` or on claude teardown, and rewound to offset 0
   * by `runReplay` so a reconnecting deck re-receives the full child
   * set (the deck's id-keyed dedup absorbs the overlap).
   */
  private subagentTailers = new Map<string, SubagentTailer>();
  /** Where Claude Code keeps the JSONL archive; defaults to the environment's. */
  private claudeHome: ClaudeHome;
  /**
   * The conversation a directory change forks from — the parent's claude id
   * and the directory its transcript lives under. Set from `--relocate-from`
   * / `--relocate-from-dir`; `null` for every session that did not move.
   * While the fork's own JSONL is absent ({@link relocationForkPending}),
   * every spawn is the fork, because nothing else carries the context.
   */
  private relocation: { parentClaudeId: string; parentProjectDir: string } | null;
  /** Configurable JSONL reader; default uses `Bun.file`. */
  private jsonlReader: (path: string) => Promise<JsonlReadResult>;
  /** Configurable JSONL writer ([#step-7-2]); default uses `Bun.write`. */
  private jsonlWriter: (path: string, content: string) => Promise<void>;
  /**
   * Replays the session's JSONL archive onto the wire, and owns the
   * replay's own state: the in-flight flag the early-exit watcher reads,
   * the abort resolver `cancel_replay` wakes, and the read-only
   * `sessions.db` handle.
   */
  private readonly replay: ReplayRunner;
  /**
   * Promise that resolves once {@link spawnClaudeAndWatch} has
   * finished its synchronous setup (claude process handle assigned,
   * watchers installed). {@link handleUserMessage} awaits this before
   * any claude stdin write so a user submit that lands during the
   * cold-boot replay window — between `prepareSession()` and the
   * background `spawnClaudeAndWatch()` — blocks until claude is
   * ready, rather than throwing "Session not initialized".
   *
   * `null` until {@link prepareSession} or {@link spawnClaudeAndWatch}
   * sets it. New-mode `initialize()` resolves it eagerly inside the
   * spawn step (no preceding gate); resume-mode flows establish the
   * gate in `prepareSession()` and resolve it in
   * `spawnClaudeAndWatch()`.
   */
  private claudeReadyPromise: Promise<void> | null = null;
  private claudeReadyResolve: (() => void) | null = null;
  /**
   * Held while a respawn is in flight — the kill of the live claude through
   * the seating of the next one. Inbound frames are dispatched without
   * awaiting one another, so a `user_message` that arrives behind a
   * `session_command` would otherwise be written to the process being
   * retired, or refused on its EOF, and never reach the fresh one.
   * {@link handleUserMessage} waits on this; {@link respawn} owns it.
   */
  private respawnGate: Promise<void> | null = null;
  /**
   * The horizon each of the two send-path gates is raced against, in ms.
   * An instance field rather than a bare read of {@link SEND_HORIZON_MS} so
   * a test can narrow it and prove the expiry in milliseconds instead of
   * half a minute; nothing in production writes it.
   */
  private sendHorizonMs: number = SEND_HORIZON_MS;
  /**
   * The bound on a pending stdin write, in ms. An instance field so a test
   * can narrow it; nothing in production writes it.
   */
  private stdinWriteTimeoutMs: number = STDIN_WRITE_TIMEOUT_MS;
  /** User-message writes to claude's stdin still waiting on a full pipe. */
  private stdinWritesPending = 0;
  /**
   * Set true the first time the stdout drain observes a `system/init`
   * event for the current claude subprocess. Subsequent `system/init`
   * events from the same subprocess are **wake bracket signals** — the
   * harness's built-in scheduler fires `ScheduleWakeup` / `CronCreate`
   * timers between turns and emits a fresh `system/init` to bracket
   * the resulting assistant turn (verified by long-hold capture probes;
   * see the wake-investigation findings and design decision
   * [D07]). Reset to false in {@link killAndCleanup} so a respawn
   * (fork / continue / new session) treats its own first init as a
   * first init, not as a wake.
   */
  private sessionInitSeen: boolean = false;

  /**
   * The segment announcement armed for the *next* subprocess, when the id it
   * will run under is not knowable until claude says so ([P05]).
   *
   * `--continue` and `--continue --fork-session` mint their id inside claude,
   * so the only place the change can be seen is the first `system/init` off
   * the new process's stdout. `sessionFork` / `sessionContinue` arm this
   * before spawning; the init handler fills in `newSessionId`, writes the
   * frame, and clears it. `null` at every other moment.
   */
  private pendingSegment: {
    kind: "fork" | "continue";
    parentSessionId: string;
  } | null = null;

  /**
   * `request_id` of the `initialize` control-request sent at spawn, or
   * `null` before it's sent / after its response lands. claude answers
   * this turn-free with a `control_response` carrying the session's
   * capabilities (model list, command catalog, …); the stdout drain
   * correlates the response by this id and emits a `session_capabilities`
   * IPC. Reset on respawn so a fresh handshake is issued each spawn.
   */
  private initializeRequestId: string | null = null;
  /**
   * Resolvers parked on {@link awaitSpawnReady} — callers that need to know
   * the CURRENT spawn has loaded, not merely that it was launched. Drained
   * when the handshake acks and again in {@link killAndCleanup}, so a waiter
   * whose process died never hangs. Empty when nobody is waiting.
   */
  private initializeAckWaiters: Array<() => void> = [];
  /**
   * Re-entrancy guard for {@link forceTerminateAndRespawn}: the interrupt
   * ladder and the result watchdog can both fire for the same wedge, and the
   * teardown/respawn must run exactly once.
   */
  private forceTerminateInProgress: boolean = false;

  /**
   * In-flight `/btw` side questions, keyed by the `request_id` the client
   * minted (reused verbatim as the control `request_id`, so one map keys the
   * whole round-trip). Each entry carries the originating `question` for
   * logging. The `control_response` is caught turn-free in
   * {@link handleClaudeLine} — the same pre-routing pattern as the
   * `initialize` handshake and the rewind requests — which is why a
   * side question answers idle *and* mid-turn (the correlation is
   * turn-state-independent). Cleared on correlation.
   */
  private pendingSideQuestions = new Map<string, { question: string }>();

  /**
   * `/rewind` and prompt retraction: the verbs, their in-flight
   * `rewind_files` requests, the cached preview read, and the JSONL side of
   * a conversation rewind. The respawn it ends in is the manager's
   * ({@link respawnIntoRewindFork}, {@link respawnRewoundInPlace}).
   */
  private readonly rewind: Rewind;

  constructor(
    projectDir: string,
    sessionId: string,
    sessionMode: "new" | "resume" = "new",
    resumeSessionId?: string,
    options?: {
      claudeHome?: ClaudeHome;
      jsonlReader?: (path: string) => Promise<JsonlReadResult>;
      jsonlWriter?: (path: string, content: string) => Promise<void>;
      replayTimeoutMs?: number;
      replayLiveBufferMax?: number;
      replayTelemetry?: ReplayTelemetry;
      /**
       * Override for the translate loop's continuous-work budget
       * (`TranslateSessionOptions.timeSliceMs`). Tests pass `0` to
       * force a yield after every message — the deterministic stand-in
       * for "the iterator stalls mid-replay" that the hard-timeout
       * test needs. Omit → the translator's default slice.
       */
      replayTimeSliceMs?: number;
      /**
       * Override for the sessions.db path. Tests pass a tempfile so
       * they don't read the real user's database. Pass `null` to
       * explicitly skip opening any DB (cold-boot fallback paths
       * exercise this). Omit / undefined → use {@link defaultSessionsDbPath}.
       */
      sessionsDbPath?: string | null;
      /**
       * Pre-constructed context_breakdown emitter. main.ts builds it
       * once at startup (after reading settings.json) and threads it
       * here so the emitter knows the session id and the user's
       * autocompact preference. `null` / undefined → no
       * `context_breakdown` frames are produced; the popover hits its
       * 20.4.7.C fallback view. Tests omit it for backwards-compat.
       */
      contextBreakdownEmitter?: ContextBreakdownEmitter | null;
      /**
       * Permission mode to seed the session with — tugdeck's resolved
       * per-card / deck-wide default, forwarded by tugcast as
       * `--permission-mode` ([main.ts]). Applied to the {@link PermissionManager}
       * before the first spawn, so `buildClaudeArgs` passes the correct
       * `--permission-mode` from claude's first instant rather than tugcode's
       * baseline default (which a post-spawn `permission_mode` frame would
       * otherwise have to correct at runtime, racing the first turn). Omit /
       * undefined → the manager keeps its `"default"` baseline.
       */
      initialPermissionMode?: PermissionMode;
      /**
       * The conversation this session forks from when a card changes its
       * project directory — forwarded by tugcast as `--relocate-from` /
       * `--relocate-from-dir` ([main.ts]). Omit for every other session.
       */
      relocation?: { parentClaudeId: string; parentProjectDir: string };
      /**
       * Starts the claude process from the arguments and environment the
       * manager composed. Omit → `ClaudeProcess`'s default spawner, which resolves the
       * binary and calls `Bun.spawn`. Tests pass a fake child here.
       */
      spawner?: ClaudeSpawner;
    },
  ) {
    if (!sessionId) {
      throw new Error("SessionManager: sessionId is required");
    }
    this.projectDir = projectDir;
    this.sessionId = sessionId;
    this.sessionMode = sessionMode;
    // Seed the permission manager with tugdeck's resolved default (forwarded
    // as `--permission-mode`) so the first spawn carries it; absent → the
    // manager's own `"default"` baseline.
    this.permissionManager = new PermissionManager(options?.initialPermissionMode);
    // Coerce `undefined` / empty string to `null` so the fallback
    // logic in `initialize()` has a single test (`!= null`) rather
    // than two (`!== undefined && !== ""`).
    this.resumeSessionId =
      typeof resumeSessionId === "string" && resumeSessionId.length > 0
        ? resumeSessionId
        : null;
    this.claudeHome =
      options?.claudeHome ?? claudeHomeFromEnv();
    this.relocation = options?.relocation ?? null;
    this.jsonlReader = options?.jsonlReader ?? defaultJsonlReader;
    this.jsonlWriter = options?.jsonlWriter ?? defaultJsonlWriter;
    this.contextBreakdownEmitter = options?.contextBreakdownEmitter ?? null;
    this.claude = new ClaudeProcess({
      cwd: projectDir,
      spawner: options?.spawner,
      host: {
        onStdoutLine: (line) => this.handleClaudeLineGuarded(line),
        onStdoutEnd: () => this.signalEofToActiveTurn(),
        sessionId: () => this.sessionId,
      },
    });
    this.replay = new ReplayRunner(
      {
        sessionId: () => this.sessionId,
        resumeSessionId: () => this.resumeSessionId,
        projectDir: () => this.projectDir,
        claudeHome: () => this.claudeHome,
        readJsonl: (path) => this.jsonlReader(path),
        relocation: () => this.relocation,
        claudeProcess: () => this.claudeProcess,
        activeTurn: () => this.activeTurn,
        stderrClassification: () => this.claude.stderrClassification,
        emitInflightTurnFromActiveTurn: (turn) =>
          this.emitInflightTurnFromActiveTurn(turn),
        resetSubagentTailersForReplay: () => {
          for (const tailer of this.subagentTailers.values()) {
            tailer.resetForReplay();
          }
        },
      },
      {
        replayTimeoutMs: options?.replayTimeoutMs,
        replayLiveBufferMax: options?.replayLiveBufferMax,
        replayTelemetry: options?.replayTelemetry,
        replayTimeSliceMs: options?.replayTimeSliceMs,
        sessionsDbPath: options?.sessionsDbPath,
      },
    );
    this.rewind = new Rewind({
      sessionId: () => this.sessionId,
      resumeSessionId: () => this.resumeSessionId,
      projectDir: () => this.projectDir,
      claudeHome: () => this.claudeHome,
      readJsonl: (path) => this.jsonlReader(path),
      writeJsonl: (path, content) => this.jsonlWriter(path, content),
      claudeProcess: () => this.claudeProcess,
      activeTurn: () => this.activeTurn,
      killAndCleanup: () => this.killAndCleanup(),
      respawnIntoRewindFork: (newId) => this.respawnIntoRewindFork(newId),
      respawnRewoundInPlace: (liveId) => this.respawnRewoundInPlace(liveId),
    });
  }

  private nextSeq(): number {
    return this.seq++;
  }

  /**
   * The spawn fields that describe the LIVE session's settings rather than
   * which conversation to open — plugin dir, permission mode, reasoning
   * effort, model, and the `/add-dir` roots.
   *
   * Every `buildClaudeArgs` caller needs all of them, and each caller differs
   * only in its session flags (`--resume` / `--session-id` / `--continue` /
   * `--fork-session`). Threading them by hand at three call sites is how the
   * model came to be applied at none of them: a field added beside
   * `currentEffort` reaches only the call site whose author remembered it.
   * Spread this instead, and the next flag lands everywhere at once.
   */
  private liveSpawnConfig(): Pick<
    ClaudeSpawnConfig,
    | "pluginDir"
    | "permissionMode"
    | "effort"
    | "model"
    | "additionalDirectories"
    | "pluginPrompts"
  > {
    return {
      pluginDir: this.getPluginDir(),
      permissionMode: this.permissionManager.getMode(),
      effort: this.currentEffort,
      model: this.currentModel,
      additionalDirectories: this.additionalDirectories,
      // Read per spawn rather than per session, so an edit to the shipped
      // prompt file takes effect on the next respawn.
      pluginPrompts: readPluginPrompts(this.getPluginDir()),
    };
  }

  /**
   * True while a directory change's fork has not been written yet: this
   * session relocated from another directory, and claude has not created
   * `<id>.jsonl` under this session's (canonical) project directory. Claude
   * writes the fork only when the first user message arrives, so until then
   * the carried context exists only in the parent's transcript.
   *
   * Synchronous because {@link spawnClaude} is — hence `realpathSync`, with
   * the raw path as the fallback for a directory that does not resolve.
   */
  private relocationForkPending(): boolean {
    if (this.relocation === null) return false;
    let canonicalProjectDir = this.projectDir;
    try {
      canonicalProjectDir = realpathSync(this.projectDir);
    } catch {
      // Unresolvable (test fixture, deleted dir) — keep the raw path.
    }
    return !existsSync(
      jsonlPathFor(this.claudeHome, canonicalProjectDir, this.sessionId),
    );
  }

  /**
   * The session flags of a claude spawn — which conversation it opens.
   *
   * While a relocation fork is pending the answer is the fork whatever `mode`
   * asked for: `--session-id <new>` would start empty and `--resume <new>`
   * would exit "No conversation found", so `--resume <parent> --fork-session
   * --session-id <new>` is the only spawn that carries the context. Deciding
   * it here, in the one method every spawn reads, is what makes the initial
   * spawn and every live-setting respawn take it without each caller knowing.
   * A separate method so the decision has one home outside the spawn itself.
   */
  private claudeSessionFlags(
    id: string | null,
    mode: "session-id" | "resume",
  ): Pick<ClaudeSpawnConfig, "sessionId" | "forkSession" | "sessionIdOverride"> {
    if (this.relocation !== null && this.relocationForkPending()) {
      return {
        sessionId: this.relocation.parentClaudeId,
        forkSession: true,
        sessionIdOverride: this.sessionId,
      };
    }
    return {
      sessionId: mode === "resume" ? id : null,
      sessionIdOverride: mode === "session-id" && id !== null ? id : undefined,
    };
  }

  /**
   * Spawn the claude CLI process with stream-json flags.
   *
   * `mode` picks between `--session-id <id>` (for a fresh spawn that
   * claims a tugdeck-generated UUID as claude's own session id) and
   * `--resume <id>` (for a resume of an existing conversation). `null`
   * lets claude generate its own session id — used by the fork/new
   * session handlers below.
   */
  private spawnClaude(
    id: string | null,
    mode: "session-id" | "resume",
  ): ClaudeSubprocess {
    const args = buildClaudeArgs({
      ...this.liveSpawnConfig(),
      ...this.claudeSessionFlags(id, mode),
    });

    console.log(`Spawning claude with args: ${args.join(" ")}`);
    logSessionLifecycle("tugcode.claude_spawn", {
      session_id: this.sessionId,
      mode: this.relocationForkPending() ? "relocate-fork" : mode,
      cwd: this.projectDir,
      args: args.join(" "),
    });

    // The spawn environment: auth keys scrubbed, and the three variables
    // tugcode sets per spawn — chief among them `TUG_SESSION_ID`, re-stamped
    // from this manager's own id rather than inherited, because a rotation
    // respawns claude without respawning tugcode. See
    // {@link buildClaudeSpawnEnv}, where the reasoning and its test live.
    const scrubbedEnv = buildClaudeSpawnEnv(
      process.env as Record<string, string | undefined>,
      this.sessionId,
      this.currentArc,
    );

    return this.claude.launch(args, scrubbedEnv);
  }

  /**
   * Kill and clean up the current claude process.
   *
   * Default (graceful): closes stdin (EOF) to signal claude to finish, waits
   * up to 5s, then force-kills if still running — used by respawn / fork /
   * truncate where claude is healthy and reading stdin.
   *
   * `escalate` mode: a *wedged* claude isn't servicing its stdin, so an EOF
   * won't land. Skip the graceful wait and go straight to the signal ladder —
   * SIGINT, a short grace, then SIGKILL ({@link ClaudeProcess.terminate}).
   * This is the OS-level lever the in-band interrupt can't reach
   * (the 2026-07-22 commit-xp hang).
   *
   * Either way, the old stdout drain is awaited before returning so its EOF
   * `finally` ({@link signalEofToActiveTurn} — emits the turn's terminal frame
   * and resolves its completion) runs before a respawn resets
   * `claudeStdoutEofObserved`; without the await the two race and a fresh
   * spawn can inherit a stale "EOF observed" flag.
   */
  private async killAndCleanup(opts?: {
    escalate?: boolean;
    graceMs?: number;
  }): Promise<void> {
    const escalate = opts?.escalate === true;
    const graceMs = opts?.graceMs ?? CLAUDE_EOF_GRACE_MS;
    // Mark shutdown so the early-exit watcher ignores the exit code
    // from our kill rather than surfacing a phantom resume_failed.
    this.isShuttingDown = true;
    // A deliberate teardown cancels every timer armed for this process — the
    // cancel-escalation, the result watchdog, the resume handshake gate, and
    // the activity-flush heartbeat (a respawn re-arms it on its first turn
    // event via `ensureActivityFlush`).
    this.timers.clearAll();
    // The session is changing (respawn / fork / truncate) — drop the cached
    // `/rewind` preview JSONL so the next preview re-reads ([#step-7-3]).
    this.rewind.clearPreviewCache();
    // Claude exit forces each live background-agent tailer's final
    // flush: drain what its file holds and compose the final answer.
    await this.stopAllSubagentTailers();
    await this.claude.terminate({ escalate, graceMs });
    // Reset the re-init tracker so the respawn's first `system/init`
    // is classified as a first init (not a wake bracket signal). See
    // [D07] for the wake-bracket detector design. Lives outside the
    // `if (this.claudeProcess)` guard so the reset still happens for
    // an already-dead subprocess (manager state can drift if a prior
    // crash left `sessionInitSeen` true but `claudeProcess` null).
    this.sessionInitSeen = false;
    // Clear the pending `initialize` correlation so a respawn issues a
    // fresh handshake rather than matching the dead process's id.
    this.initializeRequestId = null;
    // The next spawn re-proves itself before its exit is read as a crash:
    // `terminate` ended the phase at `dead`, so `handshakeAcked` reads false.
    // Nobody may wait on a handshake from a process that is gone; the next
    // spawn parks its own waiters.
    this.drainInitializeAckWaiters();
  }

  /** Clear the armed cancel-escalation timer, if any. */
  private clearInterruptEscalation(): void {
    this.timers.clear(TIMER.interruptEscalation);
  }

  /** Clear the armed result-liveness watchdog timer, if any. */
  private clearResultWatchdog(): void {
    this.timers.clear(TIMER.resultWatchdog);
  }

  /**
   * Force-terminate a wedged claude and respawn `--resume`, keeping the card
   * bound. The recovery primitive shared by the cancel-escalation ladder
   * ({@link handleInterrupt}) and the result-liveness watchdog
   * ({@link armResultWatchdog}).
   *
   * The turn (if any) is flagged `interrupted` first so the drain's EOF path
   * closes it as `turn_cancelled` (a clean cancel receipt), not `error`. The
   * kill is the escalate signal ladder; the respawn is a plain resume against
   * the current claude id, so everything claude persisted to its JSONL is
   * retained — this is a recovery, never a retraction/truncation. Resume mode
   * is forced even for a `new`-mode session: its on-disk JSONL already exists
   * under its id, so `--resume` is correct and avoids a `--session-id`
   * collision.
   *
   * Idempotent via {@link forceTerminateInProgress}: the interrupt ladder and
   * the watchdog may both fire for one wedge.
   */
  private async forceTerminateAndRespawn(reason: string): Promise<void> {
    if (this.forceTerminateInProgress) return;
    this.forceTerminateInProgress = true;
    try {
      logSessionLifecycle("tugcode.force_terminate", {
        session_id: this.sessionId,
        reason,
      });
      // Close the in-flight turn as a cancel, not an error, when the drain
      // observes the kill's EOF.
      if (this.activeTurn !== null) {
        this.activeTurn.interrupted = true;
        // Claimed only if nothing has: reaching here from the interrupt
        // ladder means the user cancelled and tugcode merely had to press
        // harder, and the cause stays theirs.
        this.activeTurn.interruptCause ??= "recovery";
      }

      await this.killAndCleanup({ escalate: true });

      // killAndCleanup latched `isShuttingDown` for the teardown; clear it so
      // the fresh spawn's watcher is armed normally.
      this.isShuttingDown = false;

      const claudeId = this.respawnResume();

      logSessionLifecycle("tugcode.force_terminate_respawned", {
        session_id: this.sessionId,
        claude_session_id: claudeId,
        reason,
      });
    } finally {
      this.forceTerminateInProgress = false;
    }
  }

  /**
   * Respawn `--resume` against the current claude id after a teardown,
   * keeping the card bound: the same conversation, its JSONL intact, and a
   * synthetic `session_init` so the card re-announces it.
   *
   * One body for {@link forceTerminateAndRespawn} and
   * {@link handleStopAllWork}, because two copies of this sequence is how one
   * of them comes to skip the synthetic init. Resume mode is forced even for
   * a `new`-mode session: its on-disk JSONL already exists under its id, so
   * `--resume` is correct and avoids a `--session-id` collision.
   *
   * Returns the claude id the respawn resumed.
   */
  private respawnResume(): string {
    this.sessionMode = "resume";
    // A different process from here on; the flag is a fact about the one
    // that just died.
    this.claudeReceivedInput = false;
    const claudeId = this.resolveClaudeId();
    this.claudeProcess = this.spawnClaude(claudeId, "resume");
    this.startStdoutDrain(this.claudeProcess);
    this.claude.startStderrReader();
    this.installEarlyExitWatcher();
    this.sendInitializeHandshake();
    this.writeSyntheticSessionInit(claudeId);
    return claudeId;
  }

  /**
   * Bring a live claude back under a card whose claude died — the recovery
   * the `send_after_eof` dead end used to refuse.
   *
   * The dead end was never a *decision*, only a guard: `handleUserMessage`
   * cannot install an `ActiveTurn` against a stdout that has EOF'd, because
   * nothing will ever resolve the turn's completion promise. But the two
   * ways a card reaches that state — a claude killed out from under tugcode
   * (the 2026-09-30 incident: SIGTERM mid-turn, `drain_eof_open_turn`) and a
   * claude that exited on its own — both leave **tugcode itself alive and
   * serving**, holding the session id, its JSONL, and its bindings. Nothing
   * about them is unrecoverable; the session was only unattended. So the
   * submit that used to be refused is the natural moment to reattach: the
   * user asking for the next turn IS the request to have one.
   *
   * `--resume` against the same claude id, which is what {@link respawnResume}
   * does for {@link forceTerminateAndRespawn} and {@link handleStopAllWork} —
   * same conversation, JSONL intact, synthetic `session_init` so the card
   * re-announces its binding rather than rebinding to something new. The
   * `killAndCleanup` first is not ceremony: the dead process's handle,
   * watchers and group are still held, and its sweep is what stops a tool
   * subprocess that outlived its claude from outliving its replacement too.
   *
   * Returns `false` when there is nothing to do it with — then, and only
   * then, does the caller emit `send_after_eof` and leave the card for the
   * user to close. One attempt per EOF episode ({@link eofReattachAttempted});
   * a spawn that failed once fails the same way on the next keystroke.
   */
  private async reattachAfterEof(): Promise<boolean> {
    if (!this.claudeStdoutEofObserved) return true;
    if (this.eofReattachAttempted) return false;
    this.eofReattachAttempted = true;
    return this.respawn(async () => {
      // Re-read under the gate: a rotation, fork or effort change may have
      // seated a fresh claude while this submit waited for it, and that
      // claude is the one the turn belongs to.
      if (!this.claudeStdoutEofObserved) return true;
      try {
        await this.killAndCleanup();
        // killAndCleanup latched `isShuttingDown` for the teardown; clear it
        // so the fresh spawn's early-exit watcher is armed normally.
        this.isShuttingDown = false;
        const claudeId = this.respawnResume();
        logSessionLifecycle("tugcode.reattach_after_eof", {
          session_id: this.sessionId,
          claude_session_id: claudeId,
          outcome: "respawned",
        });
        return true;
      } catch (err) {
        logSessionLifecycle("tugcode.reattach_after_eof", {
          session_id: this.sessionId,
          outcome: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
    });
  }

  /**
   * Handle `stop_all_work` ([P04], Spec S02): end every piece of work this
   * session's claude is doing, then respawn it `--resume` and answer.
   *
   * In order, each awaited: a `stop_task` for every id tugcast named (the
   * supervisor holds the open-job set; tugcode holds none, so the ids ride
   * the verb — best-effort, an id claude does not know is a no-op); clear
   * the pending scheduled triggers, wakeups and crons alike; then the
   * teardown. `killAndCleanup({ escalate: false })` lets a healthy claude
   * exit on its stdin EOF and then sweeps its process group unconditionally,
   * which is the rung that actually ends the work — the ladders never run
   * for a claude that exits politely. Then the respawn, exactly as
   * {@link forceTerminateAndRespawn} does it: same claude id, `--resume`,
   * JSONL intact, synthetic `session_init`, so the card stays bound.
   *
   * **The respawn is the mechanism, not an accident of it.** A
   * terminate-and-respawn is the one act that provably ends in-process
   * `ScheduleWakeup` timers, `Monitor` watchers, `Workflow` agents, and any
   * tool subprocess in the group — they lived in the process that is gone.
   * What it does **not** establish ([Q01]): whether a `CronCreate` entry
   * survives the respawn on claude's side. A cron is claude's own record, and
   * whether a resumed session re-arms one is claude's behavior, not this
   * teardown's; the trigger list here is cleared either way, so no wake from
   * one is announced by tugcode.
   *
   * Answers `stop_all_work_done` once the respawn's handshake acks — and on
   * the failure paths too. A teardown that half-worked still swept the
   * group, so the jobs are gone either way, and a `done` withheld would only
   * leave tugcast's wait to its ceiling ([P12]).
   *
   * A stop racing a wedge recovery rides that recovery rather than
   * respawning twice: the recovery's own teardown sweeps the group and its
   * respawn is the same act, so this answers `done` and leaves the latch to
   * it.
   */
  async handleStopAllWork(taskIds: string[]): Promise<void> {
    const answer = (): void => {
      const frame: StopAllWorkDone = {
        type: "stop_all_work_done",
        tug_session_id: this.sessionId,
        ipc_version: IPC_VERSION,
      };
      writeLine(frame);
    };
    if (this.forceTerminateInProgress) {
      logSessionLifecycle("tugcode.stop_all_work", {
        session_id: this.sessionId,
        tasks_stopped: 0,
        triggers_cleared: this.pendingScheduledTriggers.length,
        rode_recovery: true,
      });
      this.pendingScheduledTriggers = [];
      answer();
      return;
    }
    this.forceTerminateInProgress = true;
    try {
      let tasksStopped = 0;
      for (const taskId of taskIds) {
        this.handleStopTask(taskId);
        tasksStopped += 1;
      }
      const triggersCleared = this.pendingScheduledTriggers.length;
      this.pendingScheduledTriggers = [];
      logSessionLifecycle("tugcode.stop_all_work", {
        session_id: this.sessionId,
        tasks_stopped: tasksStopped,
        triggers_cleared: triggersCleared,
      });
      // Close the in-flight turn as a cancel, not an error, when the drain
      // observes the teardown's EOF.
      if (this.activeTurn !== null) {
        this.activeTurn.interrupted = true;
        this.activeTurn.interruptCause ??= "recovery";
      }

      await this.killAndCleanup({ escalate: false });
      this.isShuttingDown = false;

      const claudeId = this.respawnResume();
      const child = this.claudeProcess;
      if (child !== null) {
        await this.awaitSpawnReady(child, STOP_ALL_WORK_READY_TIMEOUT_MS);
      }
      logSessionLifecycle("tugcode.stop_all_work_respawned", {
        session_id: this.sessionId,
        claude_session_id: claudeId,
        handshake_acked: this.claude.handshakeAcked,
      });
    } finally {
      this.forceTerminateInProgress = false;
      answer();
    }
  }

  /**
   * Arm the cancel-escalation timer for an interrupted turn. If the in-band
   * interrupt control-request doesn't end the turn within
   * {@link INTERRUPT_ACK_GRACE_MS}, claude is wedged and can't service its own
   * stdin — force-terminate and resume-respawn so the user's cancel wins.
   * The timer is cancelled the instant the turn completes by any path.
   */
  private armInterruptEscalation(turn: ActiveTurn): void {
    // Unref'd: a pending escalation must never keep tugcode alive at shutdown.
    this.timers.setTimeout(
      TIMER.interruptEscalation,
      () => {
        // The turn ended on its own (clean interrupt ack, or the drain already
        // closed it) — nothing to escalate.
        if (this.activeTurn !== turn || turn.gotResult) return;
        logSessionLifecycle("tugcode.interrupt_escalation", {
          session_id: this.sessionId,
        });
        void this.forceTerminateAndRespawn("interrupt_unacked");
      },
      INTERRUPT_ACK_GRACE_MS,
      { unref: true },
    );
    // Cancel the escalation the moment the turn completes by ANY path
    // (clean result, or the force-kill's own EOF).
    void turn.completion.then(() => this.clearInterruptEscalation());
  }

  /**
   * Arm the result-liveness watchdog for a turn that just closed its final
   * assistant message (terminal `stop_reason`) but hasn't emitted `result`.
   * If `result` doesn't land within {@link RESULT_WATCHDOG_MS} the turn is
   * wedged post-content — force-terminate and resume-respawn. Re-arming (a
   * later terminal stop in the same turn) resets the clock.
   */
  private armResultWatchdog(turn: ActiveTurn): void {
    // Unref'd: a pending watchdog must never keep tugcode alive at shutdown.
    this.timers.setTimeout(
      TIMER.resultWatchdog,
      () => {
        if (this.activeTurn !== turn || turn.gotResult) return;
        logSessionLifecycle("tugcode.result_watchdog_fired", {
          session_id: this.sessionId,
        });
        void this.forceTerminateAndRespawn("result_timeout");
      },
      RESULT_WATCHDOG_MS,
      { unref: true },
    );
  }

  /**
   * The claude session id this session is live under.
   *
   * Unconditional ([P05]): `resumeSessionId` is now written at the moment the
   * id changes, on every arm that changes it — a rotation, a rewind-fork, a
   * `--continue`, a crash respawn — so it is always either the live id or
   * `null` on a session whose id has never moved. The old `sessionMode`
   * qualifier made this answer depend on how the session was *started*, which
   * is a different question and went wrong the moment a fresh rotation left
   * the mode reading `resume`.
   */
  private resolveClaudeId(): string {
    return this.resumeSessionId ?? this.sessionId;
  }

  /**
   * Announce a claude session id change the moment it becomes visible ([P05]).
   *
   * Called on the **first** `system/init` of every subprocess, before the
   * event is routed anywhere, so the announcement always precedes the
   * `session_init` that records the id — which is the ordering tugcast's
   * bridge relies on to attach the segment to the card's line.
   *
   * Two cases reach here. An **armed** announcement (`--continue`, with or
   * without `--fork-session`) knows what it is and was waiting only for the
   * id. An **unarmed** init whose id disagrees with the live one is a claude
   * that re-identified itself without being asked — a crash respawn — and is
   * announced as `respawn` rather than passed over: an unannounced id change
   * is exactly what used to strand a segment from its line.
   *
   * An init that agrees with the live id is the ordinary case and says
   * nothing.
   */
  private announceSegmentIfIdChanged(event: {
    session_id?: unknown;
  }): void {
    const announced = typeof event.session_id === "string" ? event.session_id : "";
    if (announced.length === 0) return;

    const armed = this.pendingSegment;
    if (armed !== null) {
      this.pendingSegment = null;
      this.resumeSessionId = announced;
      writeLine({
        type: "session_segment",
        kind: armed.kind,
        parentSessionId: armed.parentSessionId,
        newSessionId: announced,
        ipc_version: IPC_VERSION,
      });
      return;
    }

    const live = this.resolveClaudeId();
    if (announced === live) return;
    logSessionLifecycle("tugcode.segment_respawn", {
      session_id: this.sessionId,
      parent_session_id: live,
      new_session_id: announced,
    });
    this.resumeSessionId = announced;
    writeLine({
      type: "session_segment",
      kind: "respawn",
      parentSessionId: live,
      newSessionId: announced,
      ipc_version: IPC_VERSION,
    });
  }

  /**
   * Emit the synthesized `session_init` IPC line.
   *
   * The synthesized init carries the same id we'll spawn claude with
   * (`claudeId`), not always `this.sessionId`. For fresh spawns the
   * two are equal. For resume spawns whose claude id has diverged
   * from the tug id (forked session, or a resume of a session whose
   * claude id was already different), the distinction matters:
   * tugcast's `relay_session_io` atomic-promote block reads this id
   * and persists it as `LedgerEntry::claude_session_id`, so emitting
   * the wrong id here would briefly corrupt the on-disk record until
   * the real `system:init` from claude's stream-json arrives on the
   * first user message and overwrites it.
   */
  private writeSyntheticSessionInit(claudeId: string): void {
    writeLine({
      type: "session_init",
      session_id: claudeId,
      ipc_version: IPC_VERSION,
    });
  }

  /**
   * Resume-only: emit the synthetic `session_init` and arm the
   * `claudeReadyPromise` gate, all *before* claude has been spawned.
   * The cold-boot resume flow (Step R0d / R4) is:
   *
   *   1. `prepareSession()` — emit the init synchronously so tugcast
   *      sees the session as live and broadcasts `spawn_session_ok`;
   *      tugdeck constructs services and dispatches `request_replay`
   *      (Step R1c). The user sees the card open.
   *   2. `void spawnClaudeAndWatch()` — spawn claude in the
   *      background. The returned Promise resolves once the spawn
   *      handle is wired up; `handleUserMessage` awaits it. The
   *      stdout drain (Step R1e) starts here.
   *
   * The replay step is no longer in this list. Step R4 (Phase A-R4)
   * removed the direct `runReplay()` invocation from cold-boot:
   * replay is request-driven only, triggered by the `request_replay`
   * inbound verb. The supervisor queues the verb during the Spawning
   * window and drains it into tugcode's stdin during the same
   * critical section that promotes Spawning→Live, so replay arrives
   * at the same wire timing as the pre-collapse startup-replay path.
   *
   * Wire-semantic note. Pre-R0d, `spawn_session_ok` reaching tugdeck
   * meant "claude is alive on the other side". Post-R0d, it means
   * "tugcode has accepted ownership of this id, and claude is being
   * spawned in the background." The wire bytes are identical; only
   * the timing relative to the claude spawn changes. Future code
   * must not silently rely on `spawn_session_ok` as a "claude alive"
   * signal — use the `claudeReadyPromise` gate instead.
   *
   * Throws on `sessionMode === "new"`. New-mode spawns retain the
   * historical eager path through `initialize()`.
   */
  prepareSession(): void {
    if (this.sessionMode !== "resume") {
      throw new Error(
        "SessionManager.prepareSession(): resume-mode only; " +
          "new-mode callers should call initialize() directly.",
      );
    }
    const claudeId = this.resolveClaudeId();

    // Establish the readiness gate. handleUserMessage awaits it;
    // spawnClaudeAndWatch resolves it. Order:
    // prepareSession → runReplay → spawnClaudeAndWatch — and any
    // user_message that lands during replay is gated until claude
    // is ready instead of throwing "Session not initialized".
    this.claudeReadyPromise = new Promise<void>((resolve) => {
      this.claudeReadyResolve = resolve;
    });

    logSessionLifecycle("tugcode.prepare_session", {
      session_id: this.sessionId,
      claude_session_id: claudeId,
      session_mode: "resume",
    });

    this.writeSyntheticSessionInit(claudeId);
  }

  /**
   * Spawn claude with `--session-id` (new mode) or `--resume` (resume
   * mode), wire up the stdout reader, and install the stderr reader
   * + early-exit watcher. Resolves the `claudeReadyPromise` so any
   * subsequent `handleUserMessage` may proceed.
   *
   * Used by both modes. New mode calls this from `initialize()`
   * (eager). Resume mode (Step R0d) calls it directly from `main.ts`
   * after `runReplay()` so claude's 5–10s binary load happens in the
   * background while the user is already looking at the populated
   * transcript.
   *
   * Failure-detection posture (post-R1d):
   *
   * The early-exit watcher (`installEarlyExitWatcher`) catches the
   * common cases — claude exits during init for any reason (stale
   * `--resume` id, `--session-id` collision, missing binary, immediate
   * crash) — by pattern-matching claude's stderr and surfacing
   * `resume_failed`. That is the only observable "claude failed"
   * signal tugcode has at startup.
   *
   * R0d originally introduced a 30s spawn-watchdog timer on top of
   * the watcher to catch a "claude is hung silently — running but
   * unresponsive" failure mode. That timer was removed in
   * Step R1d:
   * the proxy it used (`claudeReceivedInput`) only flips on user
   * input, so its actual semantic was "user idle for 30s," not
   * "claude is hung." Smoke B exposed this — Maker>Reload doesn't
   * trigger a `user_message`, the timer fired regardless of claude's
   * health, and a healthy claude got killed at the 30-second mark.
   *
   * The trade-off the removal accepts: a genuinely-hung claude
   * (running but never emits, never exits) leaves the user with a
   * populated transcript that doesn't react to the first submit.
   * That failure mode is rare; the user's recourse is to close the
   * card and reopen. The false-positive on user idle was the larger
   * cost. Empirically (kept from the pre-R0d notes): claude in
   * stream-json mode does NOT emit `system:init` until it receives
   * input, regardless of mode — so absence-of-stdout is
   * indistinguishable from absence-of-input, and there is no
   * observable signal we could plumb that would distinguish "hung"
   * from "idle" without sending a probe.
   */
  spawnClaudeAndWatch(): Promise<void> {
    const claudeFlag = this.sessionMode === "resume" ? "resume" : "session-id";
    const claudeId = this.resolveClaudeId();

    this.claudeProcess = this.spawnClaude(claudeId, claudeFlag);
    this.startStdoutDrain(this.claudeProcess);
    this.claude.startStderrReader();
    this.installEarlyExitWatcher();
    this.sendInitializeHandshake();

    logSessionLifecycle("tugcode.spawn_claude_async", {
      session_id: this.sessionId,
      session_mode: this.sessionMode,
      claude_session_id: claudeId,
    });

    // Resolve (or freshly satisfy) the readiness gate. If
    // `prepareSession()` set it up, callers awaiting on it can now
    // proceed. Otherwise we install an already-resolved promise so
    // `handleUserMessage`'s `await` is a clean no-op for the
    // new-mode `initialize()` path.
    if (this.claudeReadyResolve !== null) {
      this.claudeReadyResolve();
      this.claudeReadyResolve = null;
    } else {
      this.claudeReadyPromise = Promise.resolve();
    }

    return this.claudeReadyPromise!;
  }

  /**
   * Send the `initialize` control-request to claude after spawn so the
   * frontend learns the session's capabilities (model list, command
   * catalog with plugin commands merged, version, …) without waiting for
   * the first user turn — claude in stream-json mode is otherwise silent
   * until input arrives.
   *
   * **Every spawn mode needs this handshake.** The capabilities frame is
   * the ONLY producer of the command catalog: tugcast retains it in an
   * in-memory `latest_capabilities` slot (not persisted), so after an app
   * restart a resumed session's catalog exists only if ITS spawn ran the
   * handshake. The on-bind ledger-metadata replay covers model / version /
   * mode — never capabilities. Historically resume spawns skipped the
   * handshake and got away with it because the pre-[D06]/[D11] sideband
   * broadcast leaked every session's capabilities to every card; the
   * per-session isolation filter (correctly) ended that, which surfaced
   * the gap as "resumed sessions lose their slash commands until the
   * first turn."
   *
   * **Resume spawns are health-gated, not skipped.** The original reason
   * for skipping resume was real: a `--resume` spawn with a stale id
   * emits "No conversation found" and exits fast (< ~1s — the supervisor
   * eager-spawn contract), and injecting a control-request into that
   * dying window perturbed failure classification. The gate preserves
   * that property by *waiting out the fast-exit window*: the handshake is
   * sent only after claude has survived {@link RESUME_INITIALIZE_DELAY_MS}
   * — a failing resume is dead before we ever write to it (byte-identical
   * to the pre-handshake behavior), and classification is stderr-pattern
   * driven regardless ({@link ClaudeProcess.stderrClassification}). A healthy resume
   * gets its catalog seconds after spawn, and tugcast captures it for
   * every later bind / reload of the card.
   *
   * Fire-and-forget: the response is correlated by `request_id` and
   * handled in {@link handleClaudeLine}. This does NOT block the first
   * user message — `spawnClaudeAndWatch`'s readiness gate is independent.
   * No-op if the process is gone (or replaced) by send time.
   */
  private sendInitializeHandshake(): void {
    if (!this.claudeProcess) return;
    if (this.sessionMode === "new") {
      this.dispatchInitializeHandshake(this.claudeProcess);
      return;
    }
    // Resume: defer past the stale-id fast-exit window so a failing
    // spawn is never written to and its exit stays byte-identical for
    // the early-exit watcher.
    const child = this.claudeProcess;
    this.timers.setTimeout(
      TIMER.resumeHandshake,
      () => {
        if (this.isShuttingDown) return;
        // The spawn we gated on must still be the live process — a
        // respawn or crash-restart in the window minted a new subprocess
        // (whose own sendInitializeHandshake re-arms the gate).
        if (this.claudeProcess !== child) return;
        if (child.exitCode !== null) return;
        this.dispatchInitializeHandshake(child);
      },
      RESUME_INITIALIZE_DELAY_MS,
    );
  }

  /**
   * Write the `initialize` control-request to a live claude subprocess
   * and arm the `request_id` correlation. Split from
   * {@link sendInitializeHandshake} so the immediate (new-mode) and
   * health-gated (resume-mode) paths share one send site. A write racing
   * a just-exited process is swallowed — the early-exit watcher owns
   * that outcome, and a dangling correlation id is cleared so a later
   * unrelated control_response can't match it.
   */
  private dispatchInitializeHandshake(child: ClaudeSubprocess): void {
    this.initializeRequestId = generateRequestId();
    logSessionLifecycle("tugcode.initialize_handshake", {
      session_id: this.sessionId,
      session_mode: this.sessionMode,
    });
    if (child === this.claudeProcess) this.claude.markHandshakeSent();
    try {
      sendControlRequest(child.stdin, this.initializeRequestId, {
        subtype: "initialize",
      });
    } catch {
      this.initializeRequestId = null;
    }
  }

  /** Release everyone parked on {@link awaitSpawnReady}. */
  private drainInitializeAckWaiters(): void {
    if (this.initializeAckWaiters.length === 0) return;
    const waiters = this.initializeAckWaiters;
    this.initializeAckWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /**
   * Resolve once the live spawn has proven it loaded — its `initialize`
   * handshake acked ({@link ClaudeProcess.handshakeAcked}) — or once waiting is
   * pointless: the subprocess exited, or `timeoutMs` elapsed.
   *
   * Spawned is not ready. `--resume` against a real conversation takes seconds
   * to read the JSONL back in, and claude in stream-json mode is silent for
   * all of it, so the only observable proof that it is answering is a
   * control-response. `/rewind` awaits this before acking, so the sheet's
   * progress state covers the whole window ([#step-7-2]).
   *
   * Never rejects: every path here means stop waiting, and the caller decides
   * what an unproven spawn is worth.
   */
  private awaitSpawnReady(
    child: ClaudeSubprocess,
    timeoutMs: number,
  ): Promise<void> {
    if (this.claude.handshakeAcked) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(settle, timeoutMs);
      this.initializeAckWaiters.push(settle);
      void child.exited.then(settle, settle);
    });
  }

  /**
   * Initialize session — single entry point for new mode and the
   * legacy (eager) resume path.
   *
   * Resume mode (cold-boot, Step R0d / R4): `main.ts` does NOT call
   * `initialize()`; it calls `prepareSession()` →
   * `void spawnClaudeAndWatch()` so the claude spawn runs in the
   * background while tugdeck dispatches the `request_replay` verb
   * (Step R1c) that — queued during Spawning, drained on
   * Spawning→Live (Step R4) — drives the actual replay. `initialize()`
   * remains for non-cold-boot callers (and tests that don't care to
   * exercise the cold-boot order); for resume mode it composes
   * `prepareSession()` + `await spawnClaudeAndWatch()`. It does NOT
   * invoke `runReplay()` itself; replay is request-driven only
   * post-R4.
   *
   * New mode: spawns claude eagerly via `spawnClaudeAndWatch()`,
   * then emits the synthetic `session_init`. Same wire shape as
   * pre-R0d.
   *
   * The empirical "claude doesn't emit system:init until input
   * arrives" fact, plus the early-exit watcher's stderr pattern-
   * matching, is documented on `spawnClaudeAndWatch`.
   */
  async initialize(): Promise<void> {
    const inputSessionId = this.sessionId;
    const inputMode = this.sessionMode;
    logSessionLifecycle("tugcode.init.start", {
      session_id: inputSessionId,
      session_mode: inputMode,
      resume_session_id: this.resumeSessionId ?? "",
    });

    if (this.sessionMode === "resume") {
      // Legacy / non-cold-boot order: synthesize the init, then spawn
      // claude eagerly. Bytes-identical to the pre-R0d wire shape;
      // tests that prime via `initialize()` continue to see the same
      // observable outcome.
      this.prepareSession();
      await this.spawnClaudeAndWatch();
      // Surface the resolved cwd from the drop on resume too — symmetric
      // with the new-session branch. The replay's synthesized
      // `system_metadata` carries an empty cwd, and a session resumed
      // before it ever took a turn has no persisted cwd to replay, so
      // without this its cwd-derived surfaces (e.g. `/memory`) would be
      // blank until the first turn. The merge keeps this value over the
      // replay's empty one.
      this.emitInitialSessionCwd();
    } else {
      // New mode: spawn first, then synthesize the init. Order
      // matches the pre-R0d code; the only refactor here is the
      // helper extraction.
      await this.spawnClaudeAndWatch();
      // A directory change's fork announces its parentage before the init,
      // the order `applyConversationRewind` uses, so tugcast queues the
      // `relocate` edge and records it when the matching init arrives. Once
      // the fork's JSONL exists this is an ordinary new-mode respawn and
      // announces nothing.
      if (this.relocation !== null && this.relocationForkPending()) {
        writeLine({
          type: "session_segment",
          kind: "relocate",
          parentSessionId: this.relocation.parentClaudeId,
          newSessionId: this.sessionId,
          ipc_version: IPC_VERSION,
        });
      }
      this.writeSyntheticSessionInit(this.resolveClaudeId());
      // Emit the `context_breakdown` immediately — claude stays silent
      // (no `system:init`) until the first input, so the static
      // estimate is computed from disk so the Context surface is
      // populated the moment the session opens.
      this.emitInitialContextBreakdown();
      this.emitInitialSessionCwd();
    }

    const claudeId = this.resolveClaudeId();
    logSessionLifecycle("tugcode.init.end", {
      session_mode: inputMode,
      session_id_in: inputSessionId,
      session_id_out: claudeId,
      fallback_taken: false,
    });
  }

  /**
   * Watch claude's exit indefinitely. The watcher only emits IPC if
   * claude exits AND none of these guards apply:
   *
   *   - the exited process is no longer `this.claudeProcess`: a
   *     deliberate teardown ({@link killAndCleanup} /
   *     {@link forceTerminateAndRespawn}) nulls or replaces the handle
   *     before this callback runs, so its exit was ours — never a failure.
   *   - `isShuttingDown`: we initiated the kill (signal, stdin EOF,
   *     close); a phantom resume_failed for a user-driven close would
   *     reach the bridge after the card is already gone.
   *   - `claudeReceivedInput`: claude has been seen alive end-to-end
   *     (it accepted at least one user message). A subsequent exit
   *     is a runtime crash, not an init failure — the existing
   *     handleUserMessage stream-end path classifies it.
   *
   * A `resume_failed` is only correct BEFORE claude proves it launched.
   * Once the turn-free `initialize` handshake is acked
   * ({@link ClaudeProcess.handshakeAcked}), claude has fully loaded and — for a
   * resume — opened its JSONL, so any later exit is a runtime crash. Emitting
   * `resume_failed` there is the 2026-07-22 commit-xp regression: a healthy
   * resumed session that a force-kill or a genuine crash later tore down was
   * mislabeled a stale-id failure, which unbinds the card and marks the ledger
   * row failed instead of letting the bridge's crash budget retry the resume.
   * So a post-handshake exit with no *definitive* stderr signature is routed
   * to the bridge's crash path (recoverable), which respawns and re-resumes.
   *
   * When a genuine init failure IS emitted, the failure mode is taken from
   * {@link ClaudeProcess.stderrClassification} (definitive, harvested from
   * stderr by its stderr reader) and falls back to the session mode only when stderr
   * carried nothing recognizable.
   */
  private installEarlyExitWatcher(): void {
    if (!this.claudeProcess) return;
    const child = this.claudeProcess;
    const sessionId = this.sessionId;
    const sessionMode = this.sessionMode;

    void child.exited.then(async (code) => {
      // The live handle moved on (teardown / respawn) — this exit was ours.
      if (this.claudeProcess !== child) return;
      if (this.isShuttingDown) return;
      if (this.claudeReceivedInput) return;
      if (this.replay.replayActive) {
        // `runReplay` watches `child.exited` itself: it surfaces the
        // crash via `replay_complete { claude_exited_during_replay }`
        // first, then emits the lifecycle `resume_failed`. Letting the
        // watcher run in parallel would race that ordering and leave
        // the card stuck in `replaying` phase.
        return;
      }

      // Definitive classification wins; mode is the fallback. A stale
      // `--resume` id ("No conversation found") and a `new`-mode `--session-id`
      // that collides with an existing transcript ("is already in use") are
      // both non-retrying resume failures: re-spawning with the same args just
      // hits the same wall. Route both to the bridge's `resume_failed` path
      // (which clears the binding and offers the picker) rather than letting
      // the bridge read the exit as a generic crash and burn its retry budget
      // on three identical collisions before locking the card as `errored`.
      const classification = this.claude.stderrClassification;
      const definitiveInitFailure =
        classification === "resume_failed" || classification === "collision";

      // Post-handshake exit with no definitive stderr → a runtime crash, not an
      // init/resume failure. Exit WITHOUT `resume_failed` so the bridge reads
      // stdout-close as `Crashed` and its crash budget respawns + re-resumes
      // the intact JSONL. Emitting the error frame keeps the card honest about
      // the blip; the retry re-populates it.
      if (this.claude.handshakeAcked && !definitiveInitFailure) {
        const reason = `claude exited with code ${code} after handshake (runtime crash)`;
        logSessionLifecycle("tugcode.claude_crash_post_handshake", {
          session_id: sessionId,
          reason,
          exit_code: code,
          // A shell reports a signalled death as 128 + signum, and "claude
          // exited 143" read alone says nothing about who sent the 15. This
          // pair is what separates the two cases a reader actually has to
          // tell apart: a claude that fell over on its own, and one that was
          // signalled — by us, or by somebody else on the machine. The
          // 2026-09-30 investigation had neither field and spent its whole
          // length establishing what these two say outright.
          signal: code > 128 && code < 192 ? code - 128 : null,
          // False here means tugcode did not ask for this exit: no respawn,
          // no stop, no quiesce was in flight. Then the sender was external,
          // and the search starts outside this process.
          self_inflicted: this.isShuttingDown,
        });
        await writeLineAndExit(
          errorFrame("post_handshake_exit", reason, true),
          0,
        );
        return;
      }

      const isResumeFailure =
        definitiveInitFailure ||
        (classification === null && sessionMode === "resume");

      if (isResumeFailure) {
        const reason =
          classification === "collision"
            ? `claude reported session id "${sessionId}" is already in use`
            : classification === "resume_failed"
              ? `claude reported "No conversation found" (stale --resume id)`
              : `claude exited with code ${code} during resume init (likely stale id)`;
        logSessionLifecycle("tugcode.resume_failed", {
          stale_session_id: sessionId,
          reason,
          exit_code: code,
          classification: classification ?? "mode_default",
        });
        await writeLineAndExit(
          {
            type: "resume_failed",
            reason,
            stale_session_id: sessionId,
            ipc_version: IPC_VERSION,
          },
          0,
        );
      } else {
        const reason = `claude exited with code ${code} during fresh init`;
        await writeLineAndExit(
          errorFrame("fresh_init_exit", reason, false),
          0,
        );
      }
    });
  }

  /**
   * Replay the resumed session's JSONL archive onto the wire, bracketed by
   * `replay_started` / `replay_complete` — the `request_replay` verb. The
   * work, and its concurrency model, are {@link ReplayRunner.runReplay}'s.
   */
  runReplay(
    window?: ReplayWindow,
    lineage?: ReplayLineageEntry[],
    relocation?: ReplayRelocationOrigin,
  ): Promise<void> {
    return this.replay.runReplay(window, lineage, relocation);
  }

  /** Abort the in-flight replay, if any — the `cancel_replay` verb. */
  cancelReplay(): void {
    this.replay.cancelReplay();
  }

  /**
   * Start a long-lived stdout drain task on the given claude process
   * (Step R1e). The drain reads claude's stdout line-by-line until
   * EOF, parses each line as JSON, and dispatches it via
   * {@link handleClaudeLine}. On EOF, signals the active turn (if
   * any) before exiting.
   *
   * Single-owner invariant: nothing else in this class may call
   * `getReader()` on `claudeProcess.stdout`. The drain is the only
   * reader for claude's stdout for the lifetime of `claudeProcess`.
   */
  private startStdoutDrain(claudeProcess: ClaudeSubprocess): void {
    // Reset the EOF flag — a fresh claude means a fresh stdout
    // stream that hasn't EOF'd yet. Without this reset, a respawn
    // (fork / continue / new) after a prior EOF would leave
    // handleUserMessage on the fast-path "claude is dead" branch
    // forever.
    this.claudeStdoutEofObserved = false;
    // …and with it the one reattach attempt the next EOF episode gets. A
    // claude that came up is proof the spawn path works, so the attempt
    // spent on the last episode must not be held against the next.
    this.eofReattachAttempted = false;
    this.claude.startStdoutDrain(claudeProcess);
  }

  /**
   * Dispatch a parsed claude stdout line. If a turn is currently
   * active (`handleUserMessage` registered an `ActiveTurn`), route
   * the event into it via {@link dispatchEventToTurn}. Otherwise the
   * event is between turns — forward init-shaped events through
   * {@link handleInterTurnEvent} so `session_init` and
   * `system_metadata` arrive at tugcast immediately rather than
   * waiting for a user submit to drain the pipe (the pre-R1e
   * blocker).
   *
   * Bad JSON is logged and skipped (preserves the pre-R1e
   * `handleUserMessage` shape).
   */
  /**
   * {@link handleClaudeLine} behind a throw barrier. The stdout drain has
   * no `catch`: before this guard, one synchronous throw from any handler
   * escaped the read loop, the drain exited for good, and every subsequent
   * claude line — tool frames, turn completes, everything — was silently
   * lost while the process stayed alive (a full session wedge that also
   * blinds attribution). One bad line loses that line only.
   */
  private handleClaudeLineGuarded(line: string): void {
    try {
      this.handleClaudeLine(line);
    } catch (err) {
      logSessionLifecycle("stdout_drain.line_exception", {
        session_id: this.sessionId,
        message: err instanceof Error ? err.message : String(err),
        line_preview: line.slice(0, 200),
      });
    }
  }

  private handleClaudeLine(line: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      console.log(`Skipping non-JSON line: ${line}`);
      return;
    }
    // Background-agent tailer lifecycle. Observed here — not in the
    // per-turn or inter-turn dispatchers — because the launch echo
    // arrives in-turn while the completion signals can land in either
    // tier; this is the one site that sees every event. Purely
    // observational: it never consumes the line, and it never throws
    // into the drain.
    this.observeSubagentLifecycle(event);
    // `ai-title`: claude's auto-generated session title. It arrives
    // turn-free and carries no `uuid`, so it must be caught here rather
    // than in the turn dispatchers. Forwarded as `session_title` and
    // consumed — tugcast writes it to the ledger (never over a
    // `/rename`), so the picker and the chip see the title as it is
    // written rather than at the next external scan.
    if (event.type === "ai-title") {
      const title = typeof event.aiTitle === "string" ? event.aiTitle.trim() : "";
      if (title.length > 0) {
        writeLine({ type: "session_title", title });
      }
      return;
    }
    // Intercept the `initialize` control-response before any turn
    // routing — it arrives turn-free (no active turn), so it must be
    // caught here rather than in `routeTopLevelEvent` (which only runs
    // for an open turn). Correlate by `request_id` against the one we
    // sent at spawn; emit the capabilities as `session_capabilities` and
    // consume the line. Any other `control_response` falls through to the
    // normal path.
    if (
      this.initializeRequestId !== null &&
      readControlResponseRequestId(event) === this.initializeRequestId
    ) {
      this.initializeRequestId = null;
      // The handshake ack proves claude launched and (for a resume) opened
      // its JSONL. A later exit is now a runtime crash, not a resume failure.
      // Correlated on the id alone: claude answered, which is the proof —
      // a response whose payload doesn't parse as capabilities still proves
      // the process is up and reading, and anyone awaiting readiness
      // ({@link awaitSpawnReady}) must not be left hanging on the shape of a
      // payload they never look at.
      this.claude.markHandshakeAcked();
      this.drainInitializeAckWaiters();
      const parsed = parseInitializeControlResponse(
        event,
        this.currentEffort,
        this.claudeCodeVersion,
      );
      if (parsed !== null) {
        // claude's turn-free handshake omits `--plugin-dir` plugin commands
        // (they load lazily, surfacing only with the first turn's system
        // init). Merge the bundled plugin's commands from disk so a fresh
        // card can list and submit them from the drop.
        const withPlugins = mergePluginCommands(
          parsed.capabilities,
          enumeratePluginCommands(this.getPluginDir()),
        );
        writeLine(withPlugins);
      }
      return;
    }
    // `rewind_files` control-response correlation ([#step-7-1]). Like the
    // `initialize` handshake, a rewind response arrives turn-free (we only
    // issue rewind requests while claude is idle), so it must be caught
    // here before turn routing. Correlate by `request_id` against the map
    // and relay as the matching outbound IPC. Any uncorrelated
    // `control_response` falls through (logged at the `case` site).
    if (
      event.type === "control_response" &&
      this.rewind.hasPendingRequests() &&
      this.rewind.tryHandleRewindControlResponse(event)
    ) {
      return;
    }
    // `/btw` side-question control-response correlation. Like the
    // `initialize` handshake and rewind, it must be caught turn-free before
    // turn routing — but UNLIKE them, the response can arrive mid-turn (the
    // whole point of `/btw`), and this pre-routing catch is exactly why that
    // works: a correlated response is consumed and does not reach
    // `dispatchEventToTurn` (Risk R01). Uncorrelated responses fall through.
    if (
      event.type === "control_response" &&
      this.pendingSideQuestions.size > 0 &&
      this.trySideQuestionControlResponse(event)
    ) {
      return;
    }
    // Wake bracket detector ([D07]). The harness's built-in scheduler
    // fires ScheduleWakeup / CronCreate timers between turns and emits
    // a fresh `system/init` to bracket the resulting assistant turn.
    // But `system/init` ALSO re-emits mid-turn after `compact_boundary`
    // events — the SDK reissues init metadata once the compact
    // completes. Distinguish by turn state: a wake re-init arrives
    // between turns (`activeTurn === null`), a compact re-init arrives
    // inside an open turn.
    //
    // First init: flip the flag, fall through to normal dispatch.
    // Re-init between turns: handle as wake (emit `wake_started`,
    //   open a fresh ActiveTurn so subsequent stream events route).
    // Re-init mid-turn: fall through to `dispatchEventToTurn` so the
    //   refreshed `system_metadata` IPC is forwarded normally.
    //
    // Lives in `handleClaudeLine` (not `handleInterTurnEvent`) because
    // claude's first real `system/init` in new-mode sessions arrives
    // DURING the first user turn — it must flip the flag even when
    // routed through `dispatchEventToTurn`.
    if (event.type === "system" && event.subtype === "init") {
      if (this.sessionInitSeen) {
        if (this.activeTurn === null) {
          this.handleWakeReInit();
          this.maybeEmitContextBreakdown(event);
          return;
        }
        // Mid-turn re-init (compact boundary). Fall through.
      } else {
        this.sessionInitSeen = true;
        this.announceSegmentIfIdChanged(event);
      }
    }
    // Open a turn for a buffered follow-on. `handleUserMessage` opens
    // the turn for the idle case; when it instead queued the message
    // (a turn was already running), claude runs it as a separate turn
    // after the current one's `result`. Those events would otherwise
    // arrive with `activeTurn === null` and be dropped as inter-turn —
    // the overlapping-turn routing bug. The drain claims the head of
    // `pendingTurnInputs` as the follow-on turn's user-message payload.
    if (this.activeTurn === null && this.pendingTurnInputs.length > 0) {
      this.openTurnFromPending();
    }
    if (this.activeTurn !== null) {
      const turn = this.activeTurn;
      this.dispatchEventToTurn(turn, event);
      // `result` ends the turn — `dispatchEventToTurn` latched
      // `gotResult` and resolved `turn.completion`. Clear the slot so
      // the next claude event opens a fresh turn instead of
      // dispatching into a finished one. Turn ownership is
      // `result`-bounded and lives here, not in `handleUserMessage`.
      //
      // Also clear `isInWake` if it was set — the terminating
      // `result` closes the wake bracket (no separate `wake_complete`
      // frame on the wire; the tugdeck reducer's commit path maps
      // `waking → idle` on the `turn_complete` that this `result`
      // produces). See `handleTaskNotification` for the bracket-open
      // side and the session-wake design record [D02].
      if (turn.gotResult) {
        // Trailing flush ([Q06]): emit the final bin's accumulated work
        // before the turn's slot clears, so a turn that ends within a bin
        // still reports its last decaying sample.
        this.flushActivity(turn);
        this.activeTurn = null;
        if (this.isInWake) {
          this.isInWake = false;
        }
        // Retraction hook: a turn interrupted with `retract: true`
        // truncates its own prompt out of the session JSONL now that
        // the turn is closed. Only on this clean `result`-bounded
        // close — the EOF close means claude died, and a respawn
        // decision there belongs to the crash/early-exit paths, not
        // the retraction.
        this.rewind.maybeScheduleRetraction(turn);
      }
    } else {
      this.handleInterTurnEvent(event);
    }
    // After the canonical dispatch has written its own frames, give
    // the context_breakdown emitter a chance to append its frame for
    // the same event. Order matters: a `cost_update` from the
    // dispatcher is followed by a `context_breakdown` so reducers
    // that join the two by arrival order see them in the expected
    // sequence. The emitter is silent when not initialized or when
    // the event is not a trigger.
    this.maybeEmitContextBreakdown(event);
  }

  /**
   * Start / stop live background-agent tailers from the raw claude
   * event stream. Three signals:
   *
   *  - **Launch** — the async-launch echo ({@link extractAsyncLaunch})
   *    starts a {@link SubagentTailer} on the echo's `outputFile`,
   *    keyed by `agentId`. The tailer's frames go straight to
   *    `writeLine` with seqs from the shared live counter, exactly like
   *    any other live frame.
   *  - **Genuine completion** — a terminal `system/task_updated`
   *    (`completed` / `failed` / `stopped`) or a
   *    `system/task_notification` (the wake trigger) for the agent's
   *    task id stops its tailer with a final flush, which drains any
   *    remaining lines and composes the parent's final answer.
   *  - Anything else is ignored. Foreground agents never emit the
   *    async echo, so they never get a tailer.
   *
   * Best-effort: nothing here may throw into the stdout drain.
   */
  private observeSubagentLifecycle(event: Record<string, unknown>): void {
    try {
      const launch = extractAsyncLaunch(event);
      if (launch !== undefined && !this.subagentTailers.has(launch.agentId)) {
        const tailer = new SubagentTailer({
          parentToolUseId: launch.parentToolUseId,
          agentId: launch.agentId,
          outputFile: launch.outputFile,
          emit: (frame) => writeLine(frame),
          nextSeq: () => this.nextSeq(),
        });
        this.subagentTailers.set(launch.agentId, tailer);
        tailer.start();
        return;
      }
      if (event.type !== "system") return;
      let taskId: string | undefined;
      if (event.subtype === "task_updated") {
        const patch =
          typeof event.patch === "object" && event.patch !== null
            ? (event.patch as Record<string, unknown>)
            : null;
        const status = patch?.status;
        if (
          status === "completed" ||
          status === "failed" ||
          status === "stopped"
        ) {
          taskId = typeof event.task_id === "string" ? event.task_id : undefined;
        }
      } else if (event.subtype === "task_notification") {
        taskId = typeof event.task_id === "string" ? event.task_id : undefined;
      }
      if (taskId === undefined) return;
      const tailer = this.subagentTailers.get(taskId);
      if (tailer === undefined) return;
      this.subagentTailers.delete(taskId);
      void tailer.stop(true);
    } catch {
      // Tailer bookkeeping must never kill the drain.
    }
  }

  /**
   * Stop every live tailer with a final flush — claude is going away
   * (respawn / fork / shutdown), so whatever the agents' files hold now
   * is all the deck will ever get from this process. Awaited so the
   * composed final answers are written before stdout ownership changes.
   */
  private async stopAllSubagentTailers(): Promise<void> {
    const tailers = Array.from(this.subagentTailers.values());
    this.subagentTailers.clear();
    for (const tailer of tailers) {
      await tailer.stop(true);
    }
  }

  /**
   * Open an `ActiveTurn` for the head of {@link pendingTurnInputs} and
   * install it as {@link activeTurn}. Called by the stdout drain when
   * claude's events for a buffered follow-on turn begin to arrive
   * (see {@link handleClaudeLine}). A fresh `seq` is allocated here,
   * at turn-open, so the user-half `seq` orders just before the
   * turn's own frames. No-op when the FIFO is empty.
   */
  private openTurnFromPending(): void {
    const pending = this.pendingTurnInputs.shift();
    if (pending === undefined) return;
    this.activeTurn = new ActiveTurn(
      this.nextSeq(),
      pending.content,
    );
  }

  /**
   * Inspect a parsed claude stdout event and, if it is a trigger,
   * write a corresponding `context_breakdown` frame to the wire.
   * Trigger events (per spike S4):
   *   - `system:init`      → initial frame after static-categories tokenize
   *   - `result`           → recomputed frame after each cost_update
   *   - `system:compact_boundary` → emitter is notified; the next
   *      `result` produces the updated frame via subtraction
   *
   * No-op when the emitter is not injected. Defensive: any
   * unexpected event shape (missing fields, wrong types) leaves the
   * emitter untouched and produces no frame.
   */
  /**
   * Emit the session-open `context_breakdown` frame — the static
   * estimate computed entirely from disk, so the Context surface
   * populates the moment the session opens (before claude's
   * `system:init`, which only lands once the first turn sends input).
   * No-op when the emitter is not injected (tests).
   */
  private emitInitialContextBreakdown(): void {
    const emitter = this.contextBreakdownEmitter;
    if (emitter) writeLine(emitter.onSpawn());
  }

  /**
   * Emit the session's resolved cwd at spawn — before claude's first turn —
   * as a minimal `system_metadata` frame ([#step-12a]). claude stays silent
   * (no `system:init`, hence no `cwd`) until the first input, so without this
   * the client wouldn't know the project's resolved path from the drop, and
   * cwd-derived surfaces (e.g. `/memory`'s auto-memory folder) would have to
   * guess from the user-typed (possibly symlinked) path. `this.projectDir` is
   * already canonicalized in `main.ts` to claude's resolved form. Only `cwd`
   * is carried; tugcast's field-aware merge fills the rest from claude's real
   * `system_metadata` once it arrives, and on a resumed session the persisted
   * richer metadata is preserved (incoming-absent fields keep current).
   */
  private emitInitialSessionCwd(): void {
    writeLine({
      type: "system_metadata",
      cwd: this.projectDir,
      ipc_version: IPC_VERSION,
    });
  }

  /**
   * Inter-turn `system/task_notification` arm — the wake detector.
   *
   * A `system/task_notification` event arrives between turns when an
   * async deferred-completion tool (Monitor timeout, Cron firing,
   * ScheduleWakeup arrival, etc.) raises an event after the parent
   * assistant turn has already completed. Claude resumes in a fresh
   * turn to respond to the notification, *without* a preceding user
   * submission.
   *
   * Detection and emission:
   *   1. Build the {@link WakeStarted} IPC frame via
   *      {@link buildWakeStartedMessage} (pure helper — testable).
   *      Returns null on malformed events; we silently drop those.
   *   2. Suppress emission if a wake bracket is already open
   *      ({@link isInWake} true). Nested wakes flatten to one outer
   *      bracket on the wire; inner trigger metadata is logged at
   *      debug level only. See plan [#spec-phase-transitions].
   *   3. Emit the frame, flip {@link isInWake}, open a fresh
   *      `ActiveTurn` so the wake's content events (which will
   *      arrive next — `message_start`, `assistant`, `stream_event`,
   *      and the terminal `result`) route through the existing
   *      `dispatchEventToTurn` machinery. Without opening a turn,
   *      every subsequent wake event would fall back to
   *      `handleInterTurnEvent` and be silently dropped — the
   *      precise upstream cause of [PPF-01] before this fix.
   *
   * The wake turn carries no user-typed text: the `ActiveTurn` is
   * opened with empty `userText` + empty `userAttachments`. The
   * tugdeck reducer recognizes this via the `wake_started` bracket
   * (not by inspecting the user text), so the empty marker does not
   * leak as a phantom user bubble in normal rendering. A mid-wake card
   * reload that triggers `runReplay` no longer surfaces an empty
   * `add_user_message`: replay opens orphan assistant content with an
   * honest `assistant_opener` (`tuglaws/turn-metric.md` S02), never a
   * fabricated user message.
   *
   * The wake bracket closes implicitly: when the wake's terminal
   * `result` lands, `handleClaudeLine` clears `activeTurn` AND
   * {@link isInWake} — no `wake_complete` frame on the wire.
   */
  private handleTaskNotification(event: Record<string, unknown>): void {
    const frame = buildWakeStartedMessage(event, this.sessionId);
    if (frame === null) {
      return;
    }
    if (this.isInWake) {
      console.log(
        `[tugcode/wake] nested task_notification ignored ` +
          `(task_id=${frame.wake_trigger.task_id})`,
      );
      return;
    }
    writeLine(frame);
    this.isInWake = true;
    this.activeTurn = new ActiveTurn(this.nextSeq(), []);
  }

  /**
   * Inter-turn `<task-notification>` envelope arm — the same wake as
   * {@link handleTaskNotification}, recognised from the shape claude hands the
   * model rather than from the typed `system` event ([P03]).
   *
   * `tugcode/probes/background-bash-wake/FINDINGS.md` records that on the
   * 2.1.258 wire a backgrounded Bash completion **does** emit
   * `system/task_notification`, so today this arm fires for nothing. It exists
   * anyway, and that is the decision rather than an oversight: the replay path
   * already recognises the envelope because the `system` event is not
   * persisted, and the live path was the only tier that could meet the
   * envelope and say nothing. A wire that stopped emitting the typed event
   * would otherwise take the arc's busy latch down with it, silently.
   *
   * `isInWake` is the same nested-wake guard {@link handleTaskNotification}
   * uses, so a wire emitting both shapes opens one bracket, not two.
   *
   * Returns `true` when the event was a recognised envelope — whether or not a
   * bracket was opened for it — so the drain stops rather than falling through
   * to arms that would read a `user` event as something else.
   */
  private handleUserEnvelope(event: Record<string, unknown>): boolean {
    if (event.type !== "user") return false;
    const message = event.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (typeof content !== "string") return false;
    const wake = extractTaskNotificationWake(content);
    if (wake === null) return false;
    if (this.isInWake) {
      console.log(
        `[tugcode/wake] envelope ignored inside an open bracket ` +
          `(task_id=${wake.taskId})`,
      );
      return true;
    }
    // The envelope names no output file, and its `<tool-use-id>` is the
    // launch's rather than the wake's, so both ride empty — the same shape
    // the scheduler's re-init wake sends.
    const frame: WakeStarted = {
      type: "wake_started",
      session_id: this.sessionId,
      wake_trigger: {
        task_id: wake.taskId,
        tool_use_id: "",
        status: "completed",
        summary: terseWakeSummary(wake.summary),
        output_file: "",
      },
      ipc_version: IPC_VERSION,
    };
    writeLine(frame);
    this.isInWake = true;
    this.activeTurn = new ActiveTurn(this.nextSeq(), []);
    return true;
  }

  /**
   * Cohort B wake bracket — the harness's built-in scheduler fired a
   * `ScheduleWakeup` / `CronCreate` timer and re-bracketed the session
   * with a fresh `system/init`. Mirrors {@link handleTaskNotification}'s
   * Cohort A semantics: emit a `wake_started` frame, set
   * {@link isInWake}, and open a fresh `ActiveTurn` so the subsequent
   * stream events route through {@link dispatchEventToTurn}.
   *
   * The harness's re-init carries no task id / tool_use_id on the wire
   * (verified in `tugcode/probes/wake-investigation/capture-*.stdout`),
   * so the frame's `wake_trigger.task_id` / `tool_use_id` are empty
   * strings. Slice 2 chrome may later snapshot `ScheduleWakeup` /
   * `CronCreate` tool_use payloads and match them to upcoming wakes;
   * for this slice we just open the bracket so the wake turn paints.
   *
   * See the wake-investigation findings and design decision
   * [D07].
   */
  private handleWakeReInit(): void {
    if (this.isInWake) {
      console.log(
        `[tugcode/wake] re-init during open wake bracket — ignored`,
      );
      return;
    }
    // Drain the pending-trigger FIFO so the wake carries its label —
    // "loop pacing" beats a bare "scheduled wake". A wakeup entry is
    // consumed by its fire; a cron entry persists (recurring) until
    // CronDelete clears it.
    const trigger =
      this.pendingScheduledTriggers.length > 0
        ? this.pendingScheduledTriggers[0]
        : null;
    if (trigger !== null && trigger.kind === "wakeup") {
      this.pendingScheduledTriggers.shift();
    }
    const frame: WakeStarted = {
      type: "wake_started",
      session_id: this.sessionId,
      wake_trigger: {
        task_id: "",
        tool_use_id: trigger?.toolUseId ?? "",
        status: "completed",
        summary:
          trigger !== null && trigger.label.length > 0
            ? trigger.label
            : "scheduled wake",
        output_file: "",
      },
      ipc_version: IPC_VERSION,
    };
    writeLine(frame);
    this.isInWake = true;
    this.activeTurn = new ActiveTurn(this.nextSeq(), []);
  }

  private maybeEmitContextBreakdown(event: Record<string, unknown>): void {
    const emitter = this.contextBreakdownEmitter;
    if (!emitter) return;
    if (event.type === "system") {
      const subtype = event.subtype;
      if (subtype === "init") {
        // `system:init` reports the built-in tool count — the one
        // input the filesystem can't reveal. Re-emit with it so
        // `system_tools` switches from the flat heuristic to the
        // exact count. A missing/empty `tools` keeps the heuristic.
        if (Array.isArray(event.tools) && event.tools.length > 0) {
          writeLine(emitter.onSessionInit(event.tools.length));
        }
      } else if (subtype === "compact_boundary") {
        emitter.onCompactBoundary();
      }
    } else if (event.type === "result") {
      const modelUsage =
        typeof event.modelUsage === "object" && event.modelUsage !== null
          ? (event.modelUsage as Record<string, unknown>)
          : undefined;
      const frame = emitter.onCostUpdate(modelUsage);
      if (frame) writeLine(frame);
    }
  }

  /**
   * Forward init-shaped events that arrive when no turn is active.
   * Pre-R1e these were stuck in the OS pipe between claude and
   * tugcode until a user submit ran the per-turn reader. Post-R1e
   * the drain forwards them as soon as they arrive — improving
   * tugcast/tugdeck observability without changing the wire shape.
   *
   * Wake-bracket detection (`system/init` re-init = wake fire) lives
   * in `handleClaudeLine`, which sees every event regardless of turn
   * state. By the time an event reaches this method, a re-init has
   * already been handled and returned. So a `system/init` here is
   * guaranteed to be the FIRST init for this subprocess — forward
   * normally as `session_init` IPC.
   */
  private handleInterTurnEvent(event: Record<string, unknown>): void {
    // The `<task-notification>` envelope, recognised before anything else
    // ([P03]) — it is the one `user`-role event this drain acts on, and every
    // arm below reads a `system` event.
    if (this.handleUserEnvelope(event)) {
      return;
    }
    if (event.type === "system" && event.subtype === "init") {
      const sessionId = (event.session_id as string) || "unknown";
      writeLine({ type: "session_init", session_id: sessionId, ipc_version: IPC_VERSION });
    }
    if (event.type === "system" && event.subtype === "task_notification") {
      this.handleTaskNotification(event);
    }
    // Background-task lifecycle frames also fire BETWEEN turns — an
    // idle completion delivers its terminal `task_updated` after the
    // launch turn's result (v2.1.173-jobs-spike capture). Forward them
    // from the drain so the deck's jobs ledger flips without waiting
    // for the next turn.
    if (event.type === "system" && event.subtype === "task_started") {
      const frame = buildTaskStartedMessage(
        event,
        (event.session_id as string) || this.sessionId,
      );
      if (frame !== null) writeLine(frame);
    }
    if (event.type === "system" && event.subtype === "task_updated") {
      const frame = buildTaskUpdatedMessage(
        event,
        (event.session_id as string) || this.sessionId,
      );
      if (frame !== null) writeLine(frame);
    }
    // A backgrounded agent emits its `task_progress` ticks concurrently
    // with the launching turn, so they too can land in the inter-turn
    // drain (observed inter-result in the background-Agent catalog
    // probe). Forward from both tiers, mirroring task_started/updated.
    if (event.type === "system" && event.subtype === "task_progress") {
      const frame = buildTaskProgressMessage(
        event,
        (event.session_id as string) || this.sessionId,
      );
      if (frame !== null) writeLine(frame);
    }
    // The roster fires at the wake as well as at the launch, and the wake's
    // one lands in this drain — so it is forwarded from both tiers for the
    // same reason the task frames are.
    if (
      event.type === "system" &&
      event.subtype === "background_tasks_changed"
    ) {
      const frame = buildBackgroundTasksChangedMessage(
        event,
        (event.session_id as string) || this.sessionId,
      );
      if (frame !== null) writeLine(frame);
    }
    // `system/status` (the 2.1.197 heartbeat) is intentionally not
    // forwarded from either tier — see the in-turn `routeTopLevelEvent`
    // note for the rationale.
    // Other inter-turn event types are currently no-ops. The drain
    // is intentionally permissive here — it must not throw, since
    // unhandled-but-syntactically-valid lines from claude (a future
    // `system_metadata` between turns, etc.) shouldn't kill the
    // drain task.
  }

  /**
   * Per-turn dispatcher. Migrates the body of pre-R1e
   * `handleUserMessage`'s line-pulling loop verbatim, with one
   * substitution: per-turn mutable state lives on `turn` instead of
   * SessionManager fields. The two-tier routing (`routeTopLevelEvent`
   * + `mapStreamEvent`) is unchanged; control_request/cancel
   * handling is unchanged; turn-end emission of the final
   * `assistant_text` + `turn_complete` is unchanged.
   *
   * On `gotResult`, calls `turn.finish()` to resolve the completion
   * promise so `handleUserMessage`'s await returns.
   */
  /**
   * Ensure the 250 ms activity-flush interval is running ([Q06]). Idempotent
   * — created on the first turn's first event and left running until
   * {@link killAndCleanup} tears the process down. The timer is unref'd so a quiescent tugcode still exits cleanly
   * (the drain / stdin loops own liveness, not this heartbeat).
   */
  private ensureActivityFlush(): void {
    if (this.timers.has(TIMER.activityFlush)) return;
    this.timers.setInterval(
      TIMER.activityFlush,
      () => {
        this.flushActivity(this.activeTurn);
      },
      ACTIVITY_FLUSH_MS,
      { unref: true },
    );
  }

  /**
   * Drain `turn`'s accumulated activity and emit one `activity_delta` frame
   * for the bin (behind `!suppressEmit` — a replay bracket emits nothing).
   * A no-op for a null / idle / suppressed turn. tugcast splices the
   * `tug_session_id` and diverts the frame onto `FeedId::ACTIVITY`.
   */
  private flushActivity(turn: ActiveTurn | null): void {
    if (turn === null || turn.suppressEmit) return;
    const channels = turn.drainActivity();
    if (channels === null) return;
    const frame: ActivityDelta = {
      type: "activity_delta",
      channels,
      ipc_version: IPC_VERSION,
    };
    writeLine(frame);
  }

  /**
   * Pending scheduled-trigger labels, FIFO. When the main lane calls
   * `ScheduleWakeup` / `CronCreate`, the harness's later fire arrives as
   * a bare re-init with no id (Cohort B), so the only way to label the
   * wake is to remember what was scheduled. `handleWakeReInit` drains
   * this: a wakeup entry is consumed by its fire (fire-once); a cron
   * entry persists across fires until `CronDelete`. `ScheduleWakeup
   * {stop:true}` clears pending wakeups (the loop-skill end signal).
   * Bounded — a runaway scheduler can't grow it without limit.
   */
  private pendingScheduledTriggers: Array<{
    toolUseId: string;
    kind: "wakeup" | "cron";
    label: string;
  }> = [];

  /**
   * Observe outbound `tool_use` frames for scheduled-work registration.
   * Main lane only — a subagent's scheduling isn't this session's wake.
   */
  private noteScheduledTriggerFrames(
    messages: OutboundMessage[],
    laneKey: string | null,
  ): void {
    if (laneKey !== null) return;
    for (const m of messages) {
      if (m.type !== "tool_use") continue;
      const name = m.tool_name.toLowerCase();
      if (name !== "schedulewakeup" && name !== "croncreate" && name !== "crondelete") {
        continue;
      }
      const input = m.input as Record<string, unknown> | undefined;
      if (name === "schedulewakeup") {
        if (input?.stop === true) {
          this.pendingScheduledTriggers = this.pendingScheduledTriggers.filter(
            (t) => t.kind !== "wakeup",
          );
          continue;
        }
        const label =
          typeof input?.reason === "string" && input.reason.length > 0
            ? input.reason
            : typeof input?.prompt === "string"
              ? input.prompt
              : "";
        this.pendingScheduledTriggers.push({
          toolUseId: m.tool_use_id,
          kind: "wakeup",
          label,
        });
      } else if (name === "croncreate") {
        const label =
          typeof input?.prompt === "string" && input.prompt.length > 0
            ? input.prompt
            : typeof input?.cron === "string"
              ? input.cron
              : "";
        this.pendingScheduledTriggers.push({
          toolUseId: m.tool_use_id,
          kind: "cron",
          label,
        });
      } else {
        this.pendingScheduledTriggers = this.pendingScheduledTriggers.filter(
          (t) => t.kind !== "cron",
        );
      }
      if (this.pendingScheduledTriggers.length > 8) {
        this.pendingScheduledTriggers = this.pendingScheduledTriggers.slice(-8);
      }
    }
  }

  private dispatchEventToTurn(
    turn: ActiveTurn,
    event: Record<string, unknown>,
  ): void {
    // Keep the per-turn activity heartbeat alive (idempotent). Started here
    // so every turn-open path (handleUserMessage, buffered follow-on,
    // compact/wake re-inits) is covered by construction.
    this.ensureActivityFlush();
    // Resolve the event's lane BEFORE any mapping: a turn's stdout
    // multiplexes the main loop with background subagents' streams,
    // and each runs its own message cycle with its own `message.id`s.
    // All per-message pointer state (msgId / rev / partialText /
    // messageBlocks) is lane-scoped so a subagent's `message_start`
    // can never re-stamp the main loop's in-flight deltas (or vice
    // versa) with the wrong msg_id.
    const rawLaneId = event.parent_tool_use_id;
    const laneKey: string | null =
      typeof rawLaneId === "string" && rawLaneId.length > 0
        ? rawLaneId
        : null;
    const lane = turn.laneFor(laneKey);

    const ctx: EventMappingContext = {
      msgId: lane.msgId ?? "",
      openerId: turn.openerId,
      seq: turn.seq,
      rev: lane.rev,
      pendingCompactSummary: turn.pendingCompactSummary,
    };

    // Tier 1: route the top-level message type. The turn's last
    // tool-loop iteration's `usage` (latest `message_delta`, else last
    // `message_start`) is handed in so the `result` branch emits it as
    // `cost_update.usage` — not `result.usage`, the per-iteration sum.
    const routeResult = routeTopLevelEvent(
      event,
      ctx,
      turn.lastMessageDeltaUsage ?? turn.lastMessageStartUsage,
    );

    // Slide the lane's pointer to claude's most recent `message.id`.
    // Top-level `assistant` snapshots carry it directly; nothing rejects,
    // nothing freezes. Multi-message cycles simply move the pointer to
    // the new id when the next `message_start` (below) arrives.
    if (routeResult.messageId !== undefined) {
      lane.msgId = routeResult.messageId;
      ctx.msgId = lane.msgId;
    }

    // Latch the updated armed-capture state across events ([P08]): a boundary
    // arms it, the captured summary or a `result` disarms it, other events
    // leave it unchanged (`undefined`).
    if (routeResult.pendingCompactSummary !== undefined) {
      turn.pendingCompactSummary = routeResult.pendingCompactSummary;
    }

    // `/rewind` anchor ([#step-7-1]). The live user-echo reveals the
    // turn's prompt-record uuid; latch it onto the turn (so the mid-turn
    // snapshot can carry it on `add_user_message.promptUuid`) and deliver
    // it live as a `prompt_anchor`. Emit once — the first echo carrying a
    // uuid wins. Gated by `suppressEmit`: during a replay bracket the
    // anchor rides `add_user_message.promptUuid` instead, so a live
    // `prompt_anchor` would be redundant (state still latches).
    if (routeResult.promptUuid !== undefined && turn.promptUuid === null) {
      turn.promptUuid = routeResult.promptUuid;
      if (!turn.suppressEmit) {
        writeLine({
          type: "prompt_anchor",
          promptUuid: routeResult.promptUuid,
          ipc_version: IPC_VERSION,
        });
      }
    }

    for (const ipcMsg of routeResult.messages) {
      if (routeResult.parentToolUseId) {
        (ipcMsg as unknown as Record<string, unknown>).parent_tool_use_id =
          routeResult.parentToolUseId;
      }
      // Gate site 1/7: suppressEmit holds back live forwarding while
      // runReplay's bracket is on the wire. State mutations (the lane's
      // msgId / rev / partialText / messageBlocks) continue regardless —
      // the snapshot emission in emitInflightTurnFromActiveTurn reads
      // them. Activity accounting rides the same gate so a replay
      // bracket's re-emitted frames never generate a sample ([Q06]).
      if (!turn.suppressEmit) {
        turn.accountActivity(ipcMsg as unknown as Record<string, unknown>);
        writeLine(ipcMsg);
      }
    }
    // Mirror routed messages onto the lane's per-block state for
    // mid-turn replay snapshot ([D07] § Mid-turn replay snapshot). Runs
    // regardless of suppressEmit so the snapshot has up-to-date block
    // state if the bracket fires.
    turn.updateBlockStateFromMessages(routeResult.messages, laneKey);
    this.noteScheduledTriggerFrames(routeResult.messages, laneKey);

    // Tier 2: delegate stream_event inner payload to mapStreamEvent().
    if (routeResult.streamEvent) {
      const streamResult = mapStreamEvent(
        routeResult.streamEvent,
        ctx,
        lane.partialText,
      );
      // Slide the lane's pointer when `message_start` reveals a new id.
      // claude emits this before any content-bearing event of the
      // message, so by the time `content_block_delta` lands, ctx.msgId
      // is already claude's. Multi-message cycles: a second
      // `message_start` simply moves the pointer to the new id; the
      // prior message's frames are already on the wire under its own
      // id. Lane-scoped: a background subagent's `message_start` slides
      // only ITS lane, so the main loop's in-flight deltas keep their
      // msg_id (and vice versa).
      if (streamResult.messageId !== undefined) {
        lane.msgId = streamResult.messageId;
        ctx.msgId = lane.msgId;
        // A fresh main-lane `message_start` means claude opened another
        // tool-loop iteration — it's alive and working, so disarm any
        // result watchdog a prior terminal `stop_reason` set. (Subagent
        // lanes never gate the main turn's liveness.)
        if (laneKey === null) this.clearResultWatchdog();
      }
      // Result-liveness watchdog ([defect 5]): claude closes its final
      // assistant message with a terminal `stop_reason`, then emits the
      // turn's `result` almost immediately. Arm the watchdog on that terminal
      // stop; if `result` never lands the turn is wedged post-content (the
      // commit-xp hang). Main lane + live only — never during a replay bracket
      // (historical deltas) or on a subagent's message.
      if (
        laneKey === null &&
        !turn.suppressEmit &&
        routeResult.streamEvent.type === "message_delta"
      ) {
        const delta = routeResult.streamEvent.delta as
          | Record<string, unknown>
          | undefined;
        const stopReason = delta?.stop_reason;
        if (typeof stopReason === "string" && TERMINAL_STOP_REASONS.has(stopReason)) {
          this.armResultWatchdog(turn);
        }
      }
      for (const ipcMsg of streamResult.messages) {
        if (routeResult.parentToolUseId) {
          (ipcMsg as unknown as Record<string, unknown>).parent_tool_use_id =
            routeResult.parentToolUseId;
        }
        // Gate site 2/7: live deltas during the suppressed window
        // accumulate into turn state (partialText, messageBlocks) but
        // stay off the wire. After runReplay clears suppressEmit,
        // future deltas writeLine normally. Mid-turn replay's
        // snapshot path emits per-block events from messageBlocks
        // ([D07] § Mid-turn replay snapshot); subsequent live deltas
        // append via (msg_id, block_index) match against Messages the
        // snapshot already minted.
        if (!turn.suppressEmit) {
          turn.accountActivity(ipcMsg as unknown as Record<string, unknown>);
          writeLine(ipcMsg);
        }
      }
      // Mirror streamed messages onto the lane's per-block state. Same
      // rationale as the routeResult call above.
      turn.updateBlockStateFromMessages(streamResult.messages, laneKey);
      this.noteScheduledTriggerFrames(streamResult.messages, laneKey);

      // Tool-input progress: claude streams a tool's argument JSON as
      // `input_json_delta` fragments. The block state (minted by the
      // preceding content_block_start) was just refreshed above, so the
      // delta's block_index now resolves to its tool_use_id / name. Emit a
      // cumulative `tool_input_progress` frame when the narratable state
      // advances. Gate site shares the suppressEmit discipline of the
      // sibling delta emits — accumulation continues, the wire stays quiet
      // during a replay bracket.
      const inner = routeResult.streamEvent;
      if (inner.type === "content_block_delta") {
        const innerDelta = inner.delta as Record<string, unknown> | undefined;
        if (
          innerDelta?.type === "input_json_delta" &&
          typeof innerDelta.partial_json === "string"
        ) {
          const innerIndex =
            typeof inner.index === "number" ? inner.index : 0;
          const progress = turn.recordToolInputDelta(
            ctx.msgId,
            innerIndex,
            innerDelta.partial_json,
            laneKey,
          );
          if (progress !== null) {
            // Tag subagent-lane progress like every other subagent
            // frame so the deck routes it under the Agent block.
            if (routeResult.parentToolUseId) {
              (progress as unknown as Record<string, unknown>).parent_tool_use_id =
                routeResult.parentToolUseId;
            }
            if (!turn.suppressEmit) {
              turn.accountActivity(
                progress as unknown as Record<string, unknown>,
              );
              writeLine(progress);
            }
          }
        }
      }

      lane.rev = streamResult.newRev;
      lane.partialText = streamResult.partialText;
      // Latch this iteration's `usage` — MAIN lane only. The latched
      // pair feeds the turn's terminal `cost_update.usage` and the
      // mid-turn snapshot's `streaming_usage` re-emit, both of which
      // describe the main loop; a background subagent's message cycle
      // must not clobber them.
      if (laneKey === null) {
        if (streamResult.messageStartUsage !== undefined) {
          turn.lastMessageStartUsage = streamResult.messageStartUsage;
        }
        if (streamResult.messageDeltaUsage !== undefined) {
          turn.lastMessageDeltaUsage = streamResult.messageDeltaUsage;
        }
      }
    }

    // Handle control_request: emit ControlRequestForward and store for
    // correlation.
    if (routeResult.controlRequest) {
      const cr = routeResult.controlRequest;
      const requestId = cr.request_id as string;
      const request = cr.request as Record<string, unknown> | undefined;
      const subtype = request?.subtype as string | undefined;

      if (subtype === "can_use_tool" && requestId && request) {
        const toolName = (request.tool_name as string) || "";
        const isQuestion = toolName === "AskUserQuestion";

        // Bypass mode auto-allows every permission request at the bridge:
        // respond to the CLI immediately and never forward, so no dialog
        // surfaces in the deck. AskUserQuestion rides the same
        // `can_use_tool` wire but is a question, not a permission prompt —
        // it still forwards. Nothing is stored in pendingControlRequests,
        // so the mid-turn snapshot re-emit can't resurrect a bypassed
        // request either.
        if (
          !isQuestion &&
          this.permissionManager.getMode() === "bypassPermissions" &&
          this.claudeProcess
        ) {
          sendControlResponse(
            this.claudeProcess.stdin,
            formatPermissionAllow(
              requestId,
              (request.input as Record<string, unknown>) || {},
            ),
          );
          return;
        }

        this.pendingControlRequests.set(requestId, cr);

        const forward: ControlRequestForward = {
          type: "control_request_forward",
          request_id: requestId,
          tool_name: toolName,
          input: (request.input as Record<string, unknown>) || {},
          decision_reason: request.decision_reason as string | undefined,
          permission_suggestions: request.permission_suggestions as
            | unknown[]
            | undefined,
          blocked_path: request.blocked_path as string | undefined,
          tool_use_id: request.tool_use_id as string | undefined,
          is_question: isQuestion,
          ipc_version: IPC_VERSION,
        };
        // Gate site 3/7. The pendingControlRequests entry above is
        // still recorded so a tool_approval response from tugdeck
        // would correlate; the forward itself is held back so the
        // reducer's replaying phase doesn't surface a tool dialog
        // while the bracket is on the wire. In practice runReplay's
        // window is short (tens of ms) and tool approvals are rare
        // mid-window — a request that lands here would deadlock on
        // tugdeck's side until claude retries. Acceptable for v1;
        // see [#roadmap].
        if (!turn.suppressEmit) writeLine(forward);
      } else {
        console.log(`Unhandled control_request subtype=${subtype ?? "unknown"}`);
      }
    }

    // Handle control_cancel_request: clean up pending entry.
    if (routeResult.cancelledRequestId) {
      this.pendingControlRequests.delete(routeResult.cancelledRequestId);
    }

    if (routeResult.gotResult) {
      turn.gotResult = true;
      // The turn's `result` landed — the wedge the watchdog guards against
      // did not happen. Disarm it (and any cancel-escalation timer, which the
      // completion hook also clears).
      this.clearResultWatchdog();
      // Emit final complete terminal frames for each text/thinking
      // block of the current message. The per-delta path has already
      // delivered the text incrementally; these terminal frames serve
      // as a safety baseline (REPLACE-equivalent for the matching
      // Message) and let the reducer recover from any delta-loss
      // window. One frame per block — under [D07]'s per-Message
      // substrate, a single consolidated terminal emit for the full
      // turn's text would be miskeyed (turn spans multiple msgIds and
      // blocks).
      //
      // Scope: ONLY currentMessageId's blocks. A multi-msgId tool-use
      // loop (e.g. thinking+tool → tool_result → thinking+tool →
      // tool_result → text) emits per-delta wire events as it
      // progresses; each iteration's text reaches the reducer
      // incrementally via is_partial: true deltas BEFORE the next
      // iteration's message_start. The intermediate iterations'
      // content is already in the reducer's scratch by the time the
      // terminal `result` lands, so we only need to baseline the
      // FINAL iteration's blocks here. (For mid-turn replay snapshot
      // the picture is different: that path replays ALL msgIds'
      // blocks because the new client never saw the earlier deltas.
      // See emitInflightTurnFromActiveTurn below.)
      //
      // Slash commands (local commands) deliver output via the
      // user/isReplay handler synthesizing both a content_block_start
      // and a terminal assistant_text — those blocks land in
      // messageBlocks via updateBlockStateFromMessages above, so the
      // iteration below picks them up too. No special-case needed.
      //
      // Gate site 4/7. Skipped emits during the suppressed window are
      // reconstructed by emitInflightTurnFromActiveTurn.
      const currentBlocks =
        turn.currentMessageId !== null
          ? turn.messageBlocks.get(turn.currentMessageId) ?? []
          : [];
      for (const block of currentBlocks) {
        if (block.kind !== "text" && block.kind !== "thinking") continue;
        if (block.text.length === 0) continue;
        if (turn.suppressEmit) continue;
        const completeSeq = this.nextSeq();
        if (block.kind === "text") {
          writeLine({
            type: "assistant_text",
            msg_id: turn.currentMessageId ?? "",
            block_index: block.index,
            seq: completeSeq,
            rev: 0,
            text: block.text,
            is_partial: false,
            status: "complete",
            ipc_version: IPC_VERSION,
          });
        } else {
          writeLine({
            type: "thinking_text",
            msg_id: turn.currentMessageId ?? "",
            block_index: block.index,
            seq: completeSeq,
            text: block.text,
            is_partial: false,
            status: "complete",
            ipc_version: IPC_VERSION,
          });
        }
      }

      const turnSeq = this.nextSeq();
      const resultValue =
        (routeResult.resultMetadata?.resultValue as string) || "success";
      // Gate site 5/7. The reconstructed terminal event lives in
      // emitInflightTurnFromActiveTurn (turn_complete branch when
      // gotResult).
      if (!turn.suppressEmit) {
        writeLine({
          type: "turn_complete",
          // Fall back to the turn's opener id, never "": a no-content
          // turn (`/compact`, `/model`) has no claude message id, and an
          // empty msg_id collides in the reducer's `committedMsgIds`
          // dedupe with every other no-content turn's commit.
          msg_id: turn.currentMessageId ?? turn.openerId,
          seq: turnSeq,
          result: resultValue,
          // A turn whose result was an API error (a 403, a 529) ended without
          // running: the arc reads this to stop rather than judge documents
          // the stage never touched.
          ...(routeResult.resultMetadata?.is_api_error === true ? { is_api_error: true } : {}),
          ipc_version: IPC_VERSION,
        });
      }
      turn.finish();
    }
  }
  /**
   * Emit the in-flight turn's content from `ActiveTurn` state, inside
   * `runReplay`'s bracket. Called unconditionally by `runReplay` after
   * the JSONL pass finishes and before the buffered `replay_complete`
   * is written, whenever an in-flight `ActiveTurn` was adopted at
   * bracket entry (`activeTurn !== null && !gotResult && !interrupted`).
   *
   * This is the load-bearing delivery path for claude's pre-HMR
   * streaming content (Step 5.11's never-drop chain link 8). The
   * CODE_OUTPUT broadcast does not backfill new subscribers
   * (`LagPolicy::Replay` only triggers on broadcast lag overflow,
   * not on initial subscribe), the JSONL only contains committed
   * turns, and the Step 5.6 pending-row synthetic delivers only the
   * user-side echo. Without this snapshot, the freshly-connected
   * client sees `pendingUserMessage` set but no scratch text, and
   * post-bracket `is_partial: true` deltas append onto an empty
   * baseline — losing the head of claude's response.
   *
   * The reads here (`turn.userText`, `turn.partialText`, etc.) are
   * tugcode's authoritative state — fresher and more complete than
   * JSONL (the JSONL's incomplete-flush window is the E1 race we're
   * routing around). Caller has set `turn.suppressEmit = true` for
   * the duration of the bracket so live deltas land in turn state but
   * stay off the wire; `runReplay` clears it after `replay_complete`.
   *
   * Tool calls inside the in-flight turn are NOT reconstructed here —
   * the drain currently dispatches tool events through writeLine
   * without buffering per-turn tool state, so we have no record to
   * replay. After this bracket clears, post-suppression live emit
   * resumes; any tool events that landed mid-window did update the
   * pendingControlRequests map but their forwards were skipped (gate
   * site 3/7). A tool approval mid-window is rare given the bracket's
   * tens-of-ms window; documented as a known limitation in the
   * roadmap.
   *
   * Terminal-event branch closes the [DM06] crash-during-suppression
   * pitfall: if the drain hit EOF or claude emitted result while
   * `suppressEmit=true`, `signalEofToActiveTurn` / `dispatchEventToTurn`
   * latched `gotResult` / `interrupted` but skipped their writeLine.
   * Without an explicit terminal here, the reducer's
   * `pendingUserMessage` would stay set and the TurnEntry would
   * never commit. The terminal we synthesize here makes the bracket
   * deliver a complete TurnEntry even when the drain dies mid-replay.
   */
  private emitInflightTurnFromActiveTurn(turn: ActiveTurn): void {
    const msgId = turn.currentMessageId ?? turn.openerId;
    // 1. add_user_message — synthetic. Carries the turn's content
    //    blocks (Anthropic API shape) as-submitted. No `msg_id` on
    //    this frame ([D14]): the reducer's `activeMsgId` is set by
    //    the first content event of the turn (`assistant_text` /
    //    `thinking_text` / `tool_use` / `content_block_start`), not
    //    by the user-side opener. `msgId` from `turn.currentMessageId`
    //    is still locally tracked below so the content frames (which
    //    DO carry msg_id) can be re-emitted with claude's real id.
    writeLine({
      type: "add_user_message",
      content: turn.userContent.slice(),
      // `/rewind` anchor ([#step-7-1]). On this snapshot path the live
      // `prompt_anchor` was suppressed (it fires only outside a replay
      // bracket), so carry the captured uuid here so the freshly-bound
      // client recovers the anchor for the in-flight turn.
      ...(turn.promptUuid !== null ? { promptUuid: turn.promptUuid } : {}),
      ipc_version: IPC_VERSION,
    });

    // 2. Per-message block stream — for each msg_id observed during
    //    this turn (a tool-use loop may span several), iterate the
    //    blocks in arrival order and emit the wire-faithful sequence:
    //    content_block_start (mints the reducer's Message) followed
    //    by the terminal text / tool_use / tool_result frames that
    //    carry the block's accumulated content.
    //
    //    This is [D07]'s Mid-turn replay snapshot pattern (Option 4 —
    //    replay-the-stream): the snapshot IS the event stream that
    //    built the turn up to this moment. The reducer processes
    //    these events through the same handlers it uses live and
    //    during cold-boot replay; content_block_start is idempotent
    //    so any Messages the live path minted before the disconnect
    //    are not duplicate-minted.
    //
    //    Iteration order is by msg_id insertion order (Map iteration
    //    is insertion-ordered in ECMA), then by block.index within
    //    each msg_id (sorted on insert in updateBlockStateFromMessages).
    for (const [blockMsgId, blocks] of turn.messageBlocks) {
      for (const block of blocks) {
        // Emit the kind-specific content_block_start. Under the
        // discriminated BlockState union, the tool_use branch's
        // toolUseId / toolName are guaranteed strings (not undefined),
        // so the wire frame is built without defensive `?? ""`.
        if (block.kind === "text") {
          writeLine({
            type: "content_block_start",
            msg_id: blockMsgId,
            block_index: block.index,
            kind: "text",
            ipc_version: IPC_VERSION,
          });
          if (block.text.length > 0) {
            writeLine({
              type: "assistant_text",
              msg_id: blockMsgId,
              block_index: block.index,
              seq: this.nextSeq(),
              rev: turn.rev,
              text: block.text,
              is_partial: false,
              status: "streaming",
              ipc_version: IPC_VERSION,
            });
          }
        } else if (block.kind === "thinking") {
          writeLine({
            type: "content_block_start",
            msg_id: blockMsgId,
            block_index: block.index,
            kind: "thinking",
            ipc_version: IPC_VERSION,
          });
          if (block.text.length > 0) {
            writeLine({
              type: "thinking_text",
              msg_id: blockMsgId,
              block_index: block.index,
              seq: this.nextSeq(),
              text: block.text,
              is_partial: false,
              status: "streaming",
              ipc_version: IPC_VERSION,
            });
          }
        } else if (block.kind === "tool_use") {
          // Discriminated union narrows toolUseId and toolName to
          // required strings; no fallback needed.
          writeLine({
            type: "content_block_start",
            msg_id: blockMsgId,
            block_index: block.index,
            kind: "tool_use",
            tool_use_id: block.toolUseId,
            tool_name: block.toolName,
            ipc_version: IPC_VERSION,
          });
          writeLine({
            type: "tool_use",
            msg_id: blockMsgId,
            seq: this.nextSeq(),
            tool_name: block.toolName,
            tool_use_id: block.toolUseId,
            input: block.toolInput,
            ipc_version: IPC_VERSION,
          });
          if (block.toolResult !== undefined) {
            writeLine({
              type: "tool_result",
              tool_use_id: block.toolUseId,
              output: block.toolResult.output,
              is_error: block.toolResult.isError,
              ipc_version: IPC_VERSION,
            });
          }
          if (block.toolStructuredResult !== undefined) {
            writeLine({
              type: "tool_use_structured",
              tool_use_id: block.toolUseId,
              tool_name: block.toolName,
              structured_result: block.toolStructuredResult,
              ipc_version: IPC_VERSION,
            });
          }
        } else {
          // Exhaustiveness check — a new BlockState kind added in the
          // future fails this compile-time `never` typecheck, forcing
          // the snapshot path to handle the new case explicitly.
          const _exhaustive: never = block;
          throw new Error(`unknown BlockState kind: ${JSON.stringify(_exhaustive)}`);
        }
      }
    }

    // 3. streaming_usage — re-emit the turn's most recent in-flight
    //    `usage` tuple (delta-iteration preferred, message_start
    //    fallback) so the status bar's TOKENS / CONTEXT cells climb
    //    back to where they were before the reload. Drives
    //    `state.liveTurnUsage` via the reducer's phase-tolerant
    //    `handleStreamingUsage` — same channel the live wire uses
    //    mid-turn, no fake-zero shim required. The reducer's logic
    //    is monotonic-by-iteration (later frame replaces earlier),
    //    so the live `streaming_usage` that lands after the bracket
    //    transparently supersedes this re-emitted one.
    //
    //    Gated by `streamingUsageFrame` on a non-empty msg_id and a
    //    `usage` carrying at least one of the four token fields —
    //    a turn the bracket fired against before `message_start`
    //    revealed any id stays quiet rather than emitting an
    //    all-zero frame.
    const usageForSnapshot =
      turn.lastMessageDeltaUsage ?? turn.lastMessageStartUsage;
    if (usageForSnapshot !== null) {
      const usageFrame = streamingUsageFrame(msgId, usageForSnapshot);
      if (usageFrame !== null) writeLine(usageFrame);
    }

    // 4. Re-emit any pending `can_use_tool` control_request_forward.
    //
    //    Under [D07]'s per-block tracking, the matching tool_use is
    //    already in messageBlocks and was re-emitted in step 2 above.
    //    We only need to re-emit the OOB control_request_forward
    //    here (the SDK's approval request, which never lands in
    //    JSONL). The forward references the tool by `tool_use_id` so
    //    the rehydrated dialog correlates back to the same SDK
    //    request.
    //
    //    Defensive fallback: if the tool_use_id is NOT in any
    //    messageBlocks entry (race / lossy stream / regression), we
    //    synthesize a content_block_start + tool_use pair here at
    //    block_index 0 of the current msg_id so the reducer has
    //    something to anchor the dialog to. The reducer's
    //    content_block_start is idempotent — if the real
    //    content_block_start arrives later, it's a no-op.
    //
    //    Only `can_use_tool` subtypes carry the tool-shape we need;
    //    other subtypes (set_model, set_permission_mode, interrupt,
    //    stop_task) are not dialog-driving and skipped.
    for (const [requestId, cr] of this.pendingControlRequests) {
      const request = cr.request as Record<string, unknown> | undefined;
      const subtype = request?.subtype as string | undefined;
      if (subtype !== "can_use_tool" || !request) continue;
      const toolName = (request.tool_name as string) || "";
      const toolUseId = (request.tool_use_id as string) || "";
      const toolInput =
        (request.input as Record<string, unknown>) || {};
      const isQuestion = toolName === "AskUserQuestion";
      // Defensive synthesis: only fire if the tool wasn't already
      // re-emitted in step 2 (its tool_use_id isn't in any block of
      // any msg_id).
      let toolAlreadyEmitted = false;
      for (const blocks of turn.messageBlocks.values()) {
        if (blocks.some((b) => b.kind === "tool_use" && b.toolUseId === toolUseId)) {
          toolAlreadyEmitted = true;
          break;
        }
      }
      if (!toolAlreadyEmitted && toolUseId !== "" && msgId !== "") {
        writeLine({
          type: "content_block_start",
          msg_id: msgId,
          block_index: 0,
          kind: "tool_use",
          tool_use_id: toolUseId,
          tool_name: toolName,
          ipc_version: IPC_VERSION,
        });
        writeLine({
          type: "tool_use",
          msg_id: msgId,
          seq: this.nextSeq(),
          tool_name: toolName,
          tool_use_id: toolUseId,
          input: toolInput,
          ipc_version: IPC_VERSION,
        });
      }
      writeLine({
        type: "control_request_forward",
        request_id: requestId,
        tool_name: toolName,
        input: toolInput,
        decision_reason: request.decision_reason as string | undefined,
        permission_suggestions: request.permission_suggestions as
          | unknown[]
          | undefined,
        blocked_path: request.blocked_path as string | undefined,
        tool_use_id: request.tool_use_id as string | undefined,
        is_question: isQuestion,
        ipc_version: IPC_VERSION,
      });
    }

    // 5. Terminal event — only fires if the turn already finished
    //    while suppressed. Live turns (gotResult=false, interrupted=false)
    //    skip this; the drain's post-suppression dispatch will emit
    //    the real `turn_complete` when claude's `result` lands.
    if (turn.gotResult) {
      writeLine({
        type: "turn_complete",
        msg_id: msgId,
        seq: this.nextSeq(),
        result: "success",
        ipc_version: IPC_VERSION,
      });
    } else if (turn.interrupted) {
      writeLine({
        type: "turn_cancelled",
        msg_id: msgId,
        seq: this.nextSeq(),
        partial_result: turn.partialText.length > 0
          ? turn.partialText
          : "User interrupted",
        ...(turn.interruptCause === "recovery" ? { is_recovery: true } : {}),
        ipc_version: IPC_VERSION,
      });
    }
  }

  /**
   * Drain-EOF handler. Called once when claude's stdout closes (EOF
   * or read error). If no turn was active, nothing is emitted — the
   * `early-exit watcher` covers process-exit lifecycle separately.
   * If a turn was active, emit the canonical end-of-stream IPC frame
   * (`turn_cancelled` if the user had interrupted, `error` otherwise)
   * and resolve the turn's completion promise so `handleUserMessage`
   * returns.
   */
  private signalEofToActiveTurn(): void {
    // Latch the flag before any branch — handleUserMessage's
    // fast-path read after this point must see "EOF observed."
    this.claudeStdoutEofObserved = true;
    // The turn (if any) is ending on this EOF — disarm the liveness watchdog
    // so a stale timer can't fire against a closed turn.
    this.clearResultWatchdog();
    // claude's stdout is gone: no follow-on turn will ever be
    // bracketed, so drop any still-queued inputs rather than let a
    // respawn's drain claim them for an unrelated turn.
    this.pendingTurnInputs.length = 0;
    const turn = this.activeTurn;
    if (turn === null) {
      logSessionLifecycle("tugcode.claude_stdout_eof", {
        session_id: this.sessionId,
      });
      return;
    }
    // Gate sites 6 & 7. The EOF emit is held back during the
    // suppressed window — a claude crash mid-replay would otherwise
    // race the bracket. emitInflightTurnFromActiveTurn re-synthesizes
    // the right terminal event (turn_complete for gotResult,
    // turn_cancelled for interrupted) from latched state so the
    // bracket delivers a complete TurnEntry even if the drain dies.
    if (turn.interrupted) {
      if (!turn.suppressEmit) {
        writeLine({
          type: "turn_cancelled",
          msg_id: turn.currentMessageId ?? turn.openerId,
          seq: turn.seq,
          partial_result: turn.partialText || "User interrupted",
          ...(turn.interruptCause === "recovery" ? { is_recovery: true } : {}),
          ipc_version: IPC_VERSION,
        });
      }
    } else if (!turn.gotResult) {
      if (!turn.suppressEmit) {
        // The frame alone is anonymous — `site=drain_eof_open_turn` and
        // nothing else, which is what a reader gets when several tugcodes
        // share one stderr capture. Name the session and say whether we
        // asked for this, so a mid-turn death is as legible as the
        // between-turns one the `turn === null` branch above already logs.
        logSessionLifecycle("tugcode.claude_stdout_eof_open_turn", {
          session_id: this.sessionId,
          self_inflicted: this.isShuttingDown,
        });
        emitErrorFrame(
          "drain_eof_open_turn",
          "Claude process stream ended unexpectedly",
          true,
        );
      }
    }
    turn.finish();
    // Trailing activity flush ([Q06]) before the slot clears — the final
    // bin's work (including a turn that ends within a bin via EOF/interrupt)
    // still reports.
    this.flushActivity(turn);
    // Turn ownership is drain-bounded: clear the slot now the turn is
    // finished. `handleUserMessage` no longer clears it — it no longer
    // owns the turn lifecycle.
    this.activeTurn = null;
  }

  /**
   * Handle user_message: forward the inbound content blocks to
   * claude's stdin verbatim (the wire shape IS the API shape post-
   * Step-5c — no construction). If no turn is running, open the
   * `ActiveTurn` for it and await its completion; if a turn is
   * already in flight, queue the message in {@link pendingTurnInputs}
   * and return — claude buffers it and the stdout drain opens its
   * follow-on turn. Turn ownership is drain-bounded: one `ActiveTurn`
   * per claude `result`, never one per `handleUserMessage` call.
   */
  async handleUserMessage(msg: UserMessage): Promise<void> {
    // A new turn will grow the JSONL — drop the cached `/rewind` preview read
    // so the next preview reflects it ([#step-7-3]).
    this.rewind.clearPreviewCache();
    // Step R0d cold-boot order may dispatch handleUserMessage before
    // `spawnClaudeAndWatch()` has finished its synchronous setup —
    // i.e., the user typed and submitted while replay was still
    // streaming events. The readiness gate established in
    // `prepareSession()` blocks until the spawn has completed, so the
    // first claude stdin write here is sequenced correctly. After
    // the gate resolves it stays resolved; subsequent submits await
    // it as a no-op.
    //
    // Both of the gates below are raced against {@link SEND_HORIZON_MS}. The
    // bound is on the *send path*, never on claude's silence — see that
    // constant's docstring and `spawnClaudeAndWatch`'s for why the removed
    // spawn watchdog is not being reintroduced here. On expiry the submit
    // gives up with a named frame and the claude process is not touched.
    if (this.claudeReadyPromise !== null) {
      if (!(await settlesWithin(this.claudeReadyPromise, this.sendHorizonMs))) {
        emitErrorFrame(
          "send_ready_timeout",
          "The session did not finish starting, so the message was not sent.",
          true,
        );
        return;
      }
    }
    // A respawn in flight owns the process slot; the message is for the
    // claude it seats, not the one it is retiring. One deadline covers the
    // whole loop rather than each turn of it: a gate that clears and is
    // immediately replaced would otherwise buy a fresh horizon every pass,
    // which is the unbounded wait wearing a bound.
    const respawnDeadline = Date.now() + this.sendHorizonMs;
    while (this.respawnGate !== null) {
      const remaining = respawnDeadline - Date.now();
      if (
        remaining <= 0 ||
        !(await settlesWithin(this.respawnGate, remaining))
      ) {
        emitErrorFrame(
          "send_respawn_timeout",
          "The session was still restarting, so the message was not sent.",
          true,
        );
        return;
      }
    }

    // The drain already observed claude's stdout closing. Installing an
    // `ActiveTurn` against that process would block on a completion promise
    // nothing will ever resolve — so before anything else, put a live claude
    // back under the card. The EOF latch is checked BEFORE the
    // `claudeProcess` null guard on purpose: the latch can only be set by a
    // drain, and a drain can only exist for a process that was spawned, so
    // reaching here is never the "never initialized" case that guard names.
    if (this.claudeStdoutEofObserved && !(await this.reattachAfterEof())) {
      emitErrorFrame(
        "send_after_eof",
        "Claude process stream ended unexpectedly",
        true,
      );
      return;
    }

    if (!this.claudeProcess) {
      throw new Error("Session not initialized");
    }

    // Forward the inbound content blocks directly to claude. The
    // wire shape IS the Anthropic API shape post-Step-5c; no
    // construction step. Per Step 5c.
    const contentBlocks = msg.content;

    const userInput = JSON.stringify({
      type: "user",
      session_id: "",
      message: {
        role: "user",
        content: contentBlocks,
      },
      parent_tool_use_id: null,
    }) + "\n";
    const stdin = this.claudeProcess.stdin;
    const written = this.writeUserInput(stdin, userInput);
    // Claude has now received input from us, so it has been seen alive
    // end-to-end. The early-exit watcher reads this flag to gate its
    // init-failure classification: any exit from this point on is a
    // runtime crash (handled by the stream-end branch in
    // `signalEofToActiveTurn`), not a resume_failed.
    this.claudeReceivedInput = true;

    // Turn ownership is drain-bounded — one `ActiveTurn` per claude
    // `result`. If no turn is running and nothing is queued ahead of
    // this message, it starts a turn: open the `ActiveTurn` now so an
    // immediate `runReplay` adopts a live turn and the pre-claude
    // submission window brackets exactly as before, then await the
    // drain bracketing it (`result`) or claude's stdout EOFing.
    //
    // If a turn IS already in flight (or messages are queued ahead),
    // claude buffers this message and runs it as a follow-on turn with
    // its own `result`. Queue it; the stdout drain opens its
    // `ActiveTurn` when claude's events for it arrive (see
    // `handleClaudeLine`). Queuing — never installing a second
    // `ActiveTurn` here — is the fix for the overlapping-turn routing
    // bug: a second install would clobber the running turn's slot and
    // strand both turns' events.
    //
    // The turn's `currentMessageId` slot is null until claude reveals
    // its `message.id` on the first stream event. `userText` /
    // `userAttachments` are the source of truth for the in-flight
    // turn's `add_user_message` payload during a mid-turn
    // `runReplay`.
    if (this.activeTurn === null && this.pendingTurnInputs.length === 0) {
      const turn = new ActiveTurn(
        this.nextSeq(),
        msg.content,
      );
      this.activeTurn = turn;
      await written;
      // The drain clears `this.activeTurn` when it brackets the turn;
      // this await only lets callers that sequence on turn completion
      // (the tests, any future awaiting caller) observe it.
      await turn.completion;
    } else {
      this.pendingTurnInputs.push({
        content: msg.content,
      });
      await written;
    }
  }

  /**
   * Whether a user message is still waiting to get into claude's stdin
   * because the pipe is full — claude has stopped reading it.
   */
  get stdinBackpressured(): boolean {
    return this.stdinWritesPending > 0;
  }

  /**
   * Write a user message to claude's stdin and resolve once Bun has accepted
   * all of it. The write and flush are issued synchronously, so the bytes are
   * ordered against every other stdin writer exactly as before; the caller
   * does its turn bookkeeping and then awaits the returned promise, which
   * never rejects.
   *
   * While either result is a pending promise the session reads
   * {@link stdinBackpressured}. A write still pending after
   * {@link stdinWriteTimeoutMs} means claude is wedged, and takes the path a
   * stalled turn takes: {@link forceTerminateAndRespawn}, which closes the
   * turn as a recovery cancel and resumes a fresh claude. There is no queue
   * of our own in front of Bun's.
   */
  private writeUserInput(
    stdin: ClaudeSubprocess["stdin"],
    data: string,
  ): Promise<void> {
    const pending = [stdin.write(data), stdin.flush()].filter(isPending);
    if (pending.length === 0) return Promise.resolve();
    return this.awaitStdinDrain(pending, Buffer.byteLength(data));
  }

  private async awaitStdinDrain(
    pending: Promise<unknown>[],
    bytes: number,
  ): Promise<void> {
    const child = this.claudeProcess;
    this.stdinWritesPending += 1;
    logSessionLifecycle("tugcode.stdin_backpressured", {
      session_id: this.sessionId,
      bytes,
    });
    try {
      // A rejected write is a dead pipe, which the drain's EOF path answers;
      // it is not the wedge this wait is for.
      const drained = await settlesWithin(
        Promise.all(pending),
        this.stdinWriteTimeoutMs,
      ).catch(() => true);
      if (drained || this.claudeProcess !== child) return;
      logSessionLifecycle("tugcode.stdin_write_timeout", {
        session_id: this.sessionId,
        bytes,
        timeout_ms: this.stdinWriteTimeoutMs,
      });
      void this.forceTerminateAndRespawn("stdin_write_timeout");
    } finally {
      this.stdinWritesPending -= 1;
    }
  }

  /**
   * Handle tool_approval: send control_response to claude stdin per D05/D06.
   * Uses "behavior" not "decision" per PN-1.
   *
   * Allow scope: when the user picked a durable scope the chosen
   * `permission_suggestions` entry rides back as `msg.updatedPermissions`
   * and is forwarded as the SDK `updatedPermissions`, so the CLI writes
   * the rule at its `destination`. A plain "Allow once" carries none.
   *
   * Deny message: the SDK passes our `message` string verbatim into the
   * `tool_result.content` the AI sees. A short string like "User denied"
   * leaves the AI without the canonical STOP directive — verified in a
   * 2026-05-23 session where the AI saw "User denied" and proceeded to
   * fire AskUserQuestion instead of halting. The SDK's canonical
   * rejection text (which its own built-in interactive prompts send)
   * is what the AI is trained to honor: "STOP what you are doing and
   * wait for the user to tell you how to proceed." So this is the
   * default when the caller doesn't supply a custom message.
   */
  handleToolApproval(msg: ToolApproval): void {
    if (!this.claudeProcess) {
      console.error("handleToolApproval called with no active claude process");
      return;
    }

    const pending = this.pendingControlRequests.get(msg.request_id);
    if (!pending) {
      console.error(`No pending control_request for request_id: ${msg.request_id}`);
      return;
    }

    const stdin = this.claudeProcess.stdin;
    const pendingRequest = pending.request as Record<string, unknown> | undefined;
    const originalInput = (pendingRequest?.input as Record<string, unknown>) || {};

    if (msg.decision === "allow") {
      const response = formatPermissionAllow(
        msg.request_id,
        msg.updatedInput || originalInput,
        msg.updatedPermissions,
      );
      sendControlResponse(stdin, response);
    } else {
      const response = formatPermissionDeny(
        msg.request_id,
        msg.message || CANONICAL_PERMISSION_DENY_MESSAGE,
      );
      sendControlResponse(stdin, response);
    }

    this.pendingControlRequests.delete(msg.request_id);
  }

  /**
   * Handle question_answer: send control_response with answers per D05.
   */
  handleQuestionAnswer(msg: QuestionAnswer): void {
    if (!this.claudeProcess) {
      console.error("handleQuestionAnswer called with no active claude process");
      return;
    }

    const pending = this.pendingControlRequests.get(msg.request_id);
    if (!pending) {
      console.error(`No pending control_request for request_id: ${msg.request_id}`);
      return;
    }

    const stdin = this.claudeProcess.stdin;
    const pendingRequest = pending.request as Record<string, unknown> | undefined;
    const originalInput = (pendingRequest?.input as Record<string, unknown>) || {};

    const response = formatQuestionAnswer(
      msg.request_id,
      originalInput,
      msg.answers,
      msg.response,
    );
    sendControlResponse(stdin, response);

    this.pendingControlRequests.delete(msg.request_id);
  }

  /**
   * Handle interrupt: send interrupt control_request per D07.
   *
   * Marks the active turn (if any) as interrupted so the stdout
   * drain's `signalEofToActiveTurn` path emits `turn_cancelled`
   * rather than `error` if claude tears down before responding.
   * The flag is per-turn (lives on `ActiveTurn`); a stale interrupt
   * arriving when no turn is active is a no-op.
   *
   * `retract` marks the interrupt as a pull-back (the client's CASE A
   * pull-down): once the turn closes, the aborted prompt must leave
   * claude's history entirely, not merely stop. The SDK has no live
   * verb for this — its `interrupt` keeps the prompt in the session
   * JSONL and appends an `"[Request interrupted by user]"` marker — so
   * the turn is flagged and the close hook
   * ({@link Rewind.maybeScheduleRetraction}) runs the conversation-rewind
   * truncation anchored at the turn's own prompt record.
   *
   * **Both early returns emit an {@link InterruptNoop} receipt.** The deck
   * raises `interruptInFlight` the instant the user presses Stop and has no
   * way to distinguish a working interrupt from one that reached a bridge
   * with nothing to interrupt. A silent early return therefore strands the
   * card; the receipt is what ends it.
   */
  handleInterrupt(retract: boolean = false): void {
    if (!this.claudeProcess) {
      console.log("No active claude process to interrupt");
      this.emitInterruptNoop("no_process");
      return;
    }

    console.log(
      `Interrupting current turn via control_request interrupt${retract ? " (retract)" : ""}`,
    );
    if (this.activeTurn !== null) {
      this.activeTurn.interrupted = true;
      // The user is the originating gesture, so it claims the cause. An
      // escalation to forceTerminateAndRespawn will not overwrite this.
      this.activeTurn.interruptCause ??= "user";
      if (retract) this.activeTurn.retractRequested = true;
    }
    const stdin = this.claudeProcess.stdin;
    sendControlRequest(stdin, generateRequestId(), { subtype: "interrupt" });
    // The in-band interrupt is the graceful path — a healthy claude ends the
    // turn and emits `result`. Arm the escalation ladder so a wedged claude
    // that never services the request still gets force-terminated: the user's
    // cancel must always win.
    if (this.activeTurn !== null) {
      this.armInterruptEscalation(this.activeTurn);
      return;
    }
    // No turn was open. The control request above still went to stdin, which
    // is harmless — but no escalation is armed and no turn can end, so this
    // interrupt has no terminal of its own. Receipt it, or the deck waits for
    // a `turn_complete` that nothing is going to produce.
    this.emitInterruptNoop("no_turn");
  }

  /**
   * Write the {@link InterruptNoop} receipt for an interrupt that found
   * nothing to interrupt. One writer, so neither early return can drift from
   * the other, and so the frame's shape lives in one place.
   */
  private emitInterruptNoop(reason: InterruptNoop["reason"]): void {
    const frame: InterruptNoop = {
      type: "interrupt_noop",
      tug_session_id: this.sessionId,
      reason,
      ipc_version: IPC_VERSION,
    };
    writeLine(frame);
  }

  /**
   * Handle permission_mode: update local permission manager and notify the CLI.
   * Sends a set_permission_mode control_request to the running CLI process so
   * it can apply the new mode without restarting.
   */
  handlePermissionMode(msg: PermissionModeMessage): void {
    console.log(`Setting permission mode: ${msg.mode}`);
    this.permissionManager.setMode(msg.mode);

    // Also notify the CLI process of the mode change.
    if (this.claudeProcess) {
      const stdin = this.claudeProcess.stdin;
      sendControlRequest(stdin, generateRequestId(), {
        subtype: "set_permission_mode",
        mode: msg.mode,
      });
    }
  }

  /**
   * Handle stop_task: send stop_task control_request to claude stdin per §2e.
   */
  handleStopTask(taskId: string): void {
    if (!this.claudeProcess) {
      console.log("No active claude process for stop_task");
      return;
    }
    const stdin = this.claudeProcess.stdin;
    sendControlRequest(stdin, generateRequestId(), { subtype: "stop_task", task_id: taskId });
  }

  /**
   * Handle a `/btw` side question: forward it as a `side_question`
   * control-request on claude's stdin, reusing the client's `request_id` as
   * the control `request_id` so the whole round-trip is keyed by one id. The
   * `control_response` is correlated turn-free in
   * {@link trySideQuestionControlResponse}, so this works idle or mid-turn.
   * Claude applies the side-question semantics itself (system-reminder
   * framing, tool suppression, cache reuse, history exclusion) — tugcode is
   * transport only ([P01]).
   */
  handleSideQuestion(msg: SideQuestion): void {
    if (!this.claudeProcess) {
      console.log("No active claude process for side_question");
      this.emitSideQuestionAnswer(msg.request_id, null, false);
      return;
    }
    this.pendingSideQuestions.set(msg.request_id, { question: msg.question });
    sendControlRequest(this.claudeProcess.stdin, msg.request_id, {
      subtype: "side_question",
      question: msg.question,
    });
  }

  /** Emit a {@link SideQuestionAnswer} frame (overlay-only; see [P05]). */
  private emitSideQuestionAnswer(
    requestId: string,
    answer: string | null,
    synthetic: boolean,
  ): void {
    const frame: SideQuestionAnswer = {
      type: "side_question_answer",
      tug_session_id: this.sessionId,
      request_id: requestId,
      answer,
      synthetic,
      ipc_version: IPC_VERSION,
    };
    writeLine(frame);
  }

  /**
   * Handle model change: record the selector, then send a `set_model`
   * control_request to the live claude.
   *
   * The record comes FIRST, above the no-process bail, for two reasons. A
   * model chosen before claude is up must still reach the first spawn (the
   * shape {@link handleEffortChange} already uses). And when the user commits
   * a model and an effort together, the effort's respawn follows this frame
   * immediately — the respawn reads {@link currentModel}, not the control
   * request, so the record must be written before the process it describes is
   * killed.
   *
   * The `default` selector records as `null`: it names no particular model,
   * so the honest expression of it is the absence of a `--model` flag.
   */
  handleModelChange(model: string): void {
    this.currentModel = model === "default" ? null : model;
    if (!this.claudeProcess) {
      console.log("No active claude process for model change");
      return;
    }
    const stdin = this.claudeProcess.stdin;
    sendControlRequest(stdin, generateRequestId(), { subtype: "set_model", model });
  }

  /** The `rewind_preview` verb — {@link Rewind.handleRewindPreview}. */
  handleRewindPreview(msg: RewindPreview): Promise<void> {
    return this.rewind.handleRewindPreview(msg);
  }

  /** The `session_rewind` verb — {@link Rewind.handleSessionRewind}. */
  handleSessionRewind(msg: SessionRewind): Promise<void> {
    return this.rewind.handleSessionRewind(msg);
  }

  /**
   * Hold the rewind open until its respawned claude has loaded ([#step-7-2]).
   *
   * The rewind ack is the client's whole signal: the `/rewind` sheet stays
   * modal, showing indeterminate progress, from the Rewind press until the
   * ack lands. So the ack has to mean "the session is ready", not "a process
   * was launched" — a `--resume` against a rewound conversation reads its
   * JSONL back in for seconds after `spawnClaude` returns, and dismissing the
   * sheet into that window hands the card back before it can answer.
   *
   * The proof is the `initialize` handshake ack, the same one every other
   * spawn path uses. It is dispatched here directly rather than through
   * {@link sendInitializeHandshake}: that path's {@link
   * RESUME_INITIALIZE_DELAY_MS} health gate exists to avoid writing into a
   * `--resume` that is about to die on a stale id, and this id is not stale —
   * we just wrote the file ourselves. Waiting out the gate would only add two
   * seconds of barber pole. The wait itself is bounded ({@link
   * REWIND_READY_TIMEOUT_MS}), and an unproven spawn still acks: the rewind
   * landed on disk either way.
   */
  private async provePostRewindSpawnReady(
    child: ClaudeSubprocess,
  ): Promise<void> {
    // `killAndCleanup` latched the teardown flag; the fresh spawn is not
    // shutting down (same clearing as `forceTerminateAndRespawn`).
    this.isShuttingDown = false;
    this.dispatchInitializeHandshake(child);
    await this.awaitSpawnReady(child, REWIND_READY_TIMEOUT_MS);
  }

  /**
   * The fork leg of a conversation rewind: the truncated history has been
   * written under `newId`, and the subprocess is down. Point the manager at
   * the fork for this and every later (re)spawn — the `session_segment` the
   * rewind already wrote tells tugcast, so the card→session binding is
   * rebound + persisted (a cold-boot then resumes the truncated fork, not the
   * original) — and spawn it.
   */
  private async respawnIntoRewindFork(newId: string): Promise<void> {
    this.resumeSessionId = newId;
    // The fork's JSONL was just written, so a later effort/add-dir respawn
    // may legitimately `--resume` it. `claudeReceivedInput` is reset because
    // it is a fact about the *process*, and this is a different one.
    this.sessionMode = "resume";
    this.claudeReceivedInput = false;
    const forked = this.spawnClaude(newId, "resume");
    this.claudeProcess = forked;
    this.startStdoutDrain(forked);
    this.writeSyntheticSessionInit(newId);
    await this.provePostRewindSpawnReady(forked);
  }

  /**
   * The in-place leg of a conversation rewind: the live JSONL has been
   * truncated and the subprocess is down. Respawn `--resume` on the same id;
   * a throw here is what makes the rewind roll the truncation back.
   */
  private async respawnRewoundInPlace(liveId: string): Promise<void> {
    const respawned = this.spawnClaude(liveId, "resume");
    this.claudeProcess = respawned;
    this.startStdoutDrain(respawned);
    await this.provePostRewindSpawnReady(respawned);
  }

  /**
   * Correlate a turn-free `control_response` against
   * {@link pendingSideQuestions} (`/btw`). Returns `true` when the response
   * matched a pending side question (and was consumed into a
   * `side_question_answer` frame), `false` when it did not (the caller lets it
   * fall through). Mirrors the `initialize`/rewind correlation: the
   * `request_id` lives on the inner `response` object, and the settled answer
   * is doubly nested at `response.response.{response,synthetic}` (confirmed by
   * the #step-1 probe capture). Runs BEFORE turn routing so a mid-turn
   * response is caught the same way an idle one is (Risk R01).
   */
  private trySideQuestionControlResponse(
    event: Record<string, unknown>,
  ): boolean {
    const response = event.response as Record<string, unknown> | undefined;
    if (!response || typeof response !== "object") return false;
    const requestId = response.request_id as string | undefined;
    if (typeof requestId !== "string") return false;
    if (!this.pendingSideQuestions.has(requestId)) return false;
    this.pendingSideQuestions.delete(requestId);

    // Settled payload: `response.response = { response: string|null,
    // synthetic: boolean }`. A `subtype:"error"` or a missing inner payload
    // degrades to a null answer rather than throwing.
    const inner = response.response as Record<string, unknown> | undefined;
    const answer =
      typeof inner?.response === "string" ? (inner.response as string) : null;
    const synthetic = inner?.synthetic === true;
    this.emitSideQuestionAnswer(requestId, answer, synthetic);
    return true;
  }

  /**
   * Handle reasoning-effort change ([#step-4], [R07]).
   *
   * claude 2.1.158 has NO live control subtype for effort — it is set only via
   * the `--effort` spawn flag — so unlike model / permission mode (which are
   * live `control_request`s) this must respawn claude with the new `--effort`
   * + `--resume <sessionId>`. The transcript survives the brief reconnect via
   * tugcast's resume/replay; the chip already reflects the change optimistically
   * (the client sent it before this frame). Records the level so every
   * subsequent (re)spawn — including the immediate one here — carries it and so
   * the next `session_capabilities` surfaces it.
   *
   * A no-op of the respawn when there is no live session id yet (nothing to
   * resume): the level is still recorded, so it takes effect on the next spawn.
   */
  /**
   * Run one respawn under {@link respawnGate}. Respawns queue behind one
   * another, and user messages queue behind all of them.
   */
  private async respawn<T>(work: () => Promise<T>): Promise<T> {
    while (this.respawnGate !== null) {
      await this.respawnGate;
    }
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.respawnGate = gate;
    try {
      return await work();
    } finally {
      if (this.respawnGate === gate) this.respawnGate = null;
      release();
    }
  }

  async handleEffortChange(effort: string): Promise<void> {
    return this.respawn(() => this.effortChange(effort));
  }

  private async effortChange(effort: string): Promise<void> {
    console.log(`Setting reasoning effort: ${effort}`);
    this.currentEffort = effort;

    // No conversation to resume yet — record the level and let the next spawn
    // pick it up via `buildClaudeArgs`.
    if (this.sessionId === null || this.sessionId === "") return;

    await this.killAndCleanup();
    const mode = this.liveRespawnMode();
    this.claudeProcess = this.spawnClaude(this.liveRespawnId(mode), mode);
    this.startStdoutDrain(this.claudeProcess);
    // The drain forwards claude's `system:init` to tugcast asynchronously, as
    // in `handleSessionFork` / `handleSessionContinue`; no synchronous await.
  }

  /**
   * Spawn mode for a live setting change (effort, add-dir) that must respawn
   * the current session in place: `--resume` when claude has a conversation on
   * disk to load, `--session-id` (re-create the id) when it does not.
   *
   * Claude writes a session's JSONL only once a turn lands, AND rejects
   * `--session-id` for an id that already exists ("is already in use"). So the
   * choice must match the on-disk reality on BOTH ends:
   *  - A session **resumed from disk** (`sessionMode === "resume"`) already has
   *    history — resume it. Re-creating it with `--session-id` collides.
   *  - A **fresh** session that has since committed a turn this process
   *    (`claudeReceivedInput`, set on the first user-message write) likewise has
   *    history — resume it.
   *  - A fresh session with **no** committed turn has nothing on disk — resume
   *    fails with "No conversation found", so re-create it under the same id
   *    (carrying the new setting) instead.
   *
   * Both wrong choices kill the process immediately; the next submit then hits
   * the stdout-EOF path and surfaces "Claude process stream ended unexpectedly".
   */
  private liveRespawnMode(): "resume" | "session-id" {
    return this.sessionMode === "resume" || this.claudeReceivedInput
      ? "resume"
      : "session-id";
  }

  /**
   * The claude id to (re)spawn against for a live-setting respawn: the resume
   * id (`resolveClaudeId()`, which honors a forked session's rotated claude id)
   * when resuming, or the tug session id when re-creating a fresh session.
   */
  private liveRespawnId(mode: "resume" | "session-id"): string {
    return mode === "resume" ? this.resolveClaudeId() : this.sessionId;
  }

  /**
   * Add a working directory to the session ([#step-13c]). Records the dir
   * (deduped) so every (re)spawn grants it via `--add-dir`, then respawns the
   * session in place to apply it now ({@link liveRespawnMode} picks `--resume`
   * vs `--session-id`) — the same shape as {@link handleEffortChange}, because
   * claude exposes no live add-directory control verb over the bridge. A blank
   * or already-present dir is a no-op (no needless respawn). Before the first
   * spawn (no `sessionId` yet) we just record it; the initial spawn picks it up
   * via `buildClaudeArgs`.
   */
  async handleAddDirectory(directory: string): Promise<void> {
    return this.respawn(() => this.addDirectory(directory));
  }

  private async addDirectory(directory: string): Promise<void> {
    const dir = directory.trim();
    if (dir === "" || this.additionalDirectories.includes(dir)) return;
    console.log(`Adding working directory: ${dir}`);
    this.additionalDirectories.push(dir);

    if (this.sessionId === null || this.sessionId === "") return;

    await this.killAndCleanup();
    const mode = this.liveRespawnMode();
    this.claudeProcess = this.spawnClaude(this.liveRespawnId(mode), mode);
    this.startStdoutDrain(this.claudeProcess);
  }

  /**
   * Fork the current session: kill current process, respawn with --continue --fork-session.
   * Per D10 (#d10-session-forking).
   */
  async handleSessionFork(): Promise<void> {
    return this.respawn(() => this.sessionFork());
  }

  private async sessionFork(): Promise<void> {
    await this.killAndCleanup();

    // `--continue --fork-session` mints the fork's id inside claude, so the
    // announcement waits for the first `system/init` to learn it ([P05]).
    this.pendingSegment = {
      kind: "fork",
      parentSessionId: this.resolveClaudeId(),
    };
    this.sessionMode = "resume";
    this.claudeReceivedInput = false;

    const claudePath = resolveClaudePath();
    if (!claudePath) throw new Error("claude CLI not found (PATH or ~/.local/bin)");

    const args = buildClaudeArgs({
      ...this.liveSpawnConfig(),
      sessionId: null,
      continue: true,
      forkSession: true,
    });

    this.claudeProcess = Bun.spawn([claudePath, ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
      cwd: this.projectDir,
    });
    this.startStdoutDrain(this.claudeProcess);
    // Post-R1e: the drain task forwards claude's `system:init` to
    // tugcast as a `session_init` IPC frame as soon as it arrives
    // (see {@link handleInterTurnEvent}). The handler does not
    // synchronously await readiness — `claudeProcess.stdin` buffers
    // any bytes the next `handleUserMessage` writes before claude
    // finishes its handshake, and the drain catches up in the
    // background. Pre-R1e the legacy `waitForSessionReady` await
    // existed because the pull-based reader could not run in the
    // background; that constraint is gone.
  }

  /**
   * Continue in a new session picking up conversation history.
   * Respawns with --continue per D10.
   */
  async handleSessionContinue(): Promise<void> {
    return this.respawn(() => this.sessionContinue());
  }

  private async sessionContinue(): Promise<void> {
    await this.killAndCleanup();

    // Same as the fork: claude picks the id, so the announcement is written
    // when its first `system/init` names it ([P05]).
    this.pendingSegment = {
      kind: "continue",
      parentSessionId: this.resolveClaudeId(),
    };
    this.sessionMode = "resume";
    this.claudeReceivedInput = false;

    const claudePath = resolveClaudePath();
    if (!claudePath) throw new Error("claude CLI not found (PATH or ~/.local/bin)");

    const args = buildClaudeArgs({
      ...this.liveSpawnConfig(),
      sessionId: null,
      continue: true,
    });

    this.claudeProcess = Bun.spawn([claudePath, ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
      cwd: this.projectDir,
    });
    this.startStdoutDrain(this.claudeProcess);
    // See `handleSessionFork` — the drain forwards claude's
    // `system:init` asynchronously; no synchronous await needed.
  }

  /**
   * Start a fresh session with no prior history.
   * Kills current process and respawns without --resume.
   *
   * `stage` is present only when the server-driven arc originated this
   * rotation. It does two things and nothing else: it records the arc name
   * so every spawn from here carries `TUG_ARC`, and it announces the fresh
   * session as lineage before the synthetic `session_init` — the placement
   * {@link rewindSession}'s fork announcement already uses, because the bridge
   * must stage the identity transfer before the `session_init` that consumes
   * it.
   *
   * With no stage the path is byte-identical to what a plain `/new` from the
   * deck emits today, and the arc record is *cleared* — the variable
   * belongs to an arc, not to a card.
   */
  async handleNewSession(stage?: SessionStageSpec): Promise<void> {
    return this.respawn(() => this.newSession(stage));
  }

  private async newSession(stage?: SessionStageSpec): Promise<void> {
    const parentSessionId = this.resolveClaudeId();
    // Close any in-flight turn on the retiring claude as a cancel, not an
    // error, exactly as `forceTerminateAndRespawn` does — the drain observes
    // this kill's EOF and, without the flag, emits
    // `error "Claude process stream ended unexpectedly"`, which the deck
    // renders as the "Protocol error" banner. Retiring a claude is a
    // deliberate act (a rotation, or a `/new` from the deck); a turn it ends
    // was not lost, and the frame family for "something else ended this" is
    // the cancel with `is_recovery`, which the deck already renders with no
    // banner at all.
    if (this.activeTurn !== null) {
      this.activeTurn.interrupted = true;
      // First writer wins: a user cancel already in flight keeps its cause.
      this.activeTurn.interruptCause ??= "recovery";
    }
    await this.killAndCleanup();

    // Absent is what *clears* it: the arc variable belongs to an arc, not to a
    // card, so a rotation naming none spawns claude without it.
    this.currentArc = stage?.arc ?? null;

    // The effort is recorded before the spawn so the level rides that one
    // spawn. Setting it afterwards would cost a second respawn through
    // `handleEffortChange`, which is a fresh claude the rotation never asked
    // for.
    if (stage?.effort !== undefined) this.currentEffort = stage.effort;

    // Generate a new id for the fresh session and claim it with claude
    // via --session-id so downstream persistence and routing have a
    // stable identifier from spawn time forward.
    this.sessionId = crypto.randomUUID();
    // The fresh session is what every later resolve names: a respawn resumes
    // it, and the next rotation announces it — not the session it replaced —
    // as the parent.
    this.resumeSessionId = this.sessionId;
    // **`new`, not `resume`.** The id was minted a line ago and claude has
    // never written a JSONL for it, so `liveRespawnMode` must pick
    // `--session-id`; `--resume` on an id with no transcript is fatal, and the
    // process dies with "No conversation found". `claudeReceivedInput` is
    // reset for the same reason through the other disjunct — nothing else
    // resets it, so a rotation on a card that has taken a turn would answer
    // `resume` on a session that has not.
    this.sessionMode = "new";
    this.claudeReceivedInput = false;
    this.claudeProcess = this.spawnClaude(this.sessionId, "session-id");
    this.startStdoutDrain(this.claudeProcess);
    // Every id change is announced, including this one ([P05]). A rotation
    // carries the divider's facts; a bare `/new` carries none, and is the one
    // gesture that means "a different conversation" — the only kind that
    // births a line rather than joining the card's.
    writeLine({
      type: "session_segment",
      kind: stage ? "rotation" : "new",
      parentSessionId,
      newSessionId: this.sessionId,
      ...(stage
        ? {
            stage: stage.name,
            model: this.currentModel ?? "",
            ...(stage.document !== undefined ? { document: stage.document } : {}),
            ...(this.currentArc !== null ? { arc: this.currentArc } : {}),
            ...(stage.steps !== undefined ? { steps: stage.steps } : {}),
            ...(stage.prompt !== undefined ? { prompt: stage.prompt } : {}),
          }
        : {}),
      ipc_version: IPC_VERSION,
    });
    // Synthesize a session_init for tugcast immediately — the
    // claude id is known synchronously here (we minted it above), so
    // no need to wait for claude's own emission.
    writeLine({ type: "session_init", session_id: this.sessionId, ipc_version: IPC_VERSION });
  }

  /**
   * Dispatch a session command to the appropriate session management method.
   */
  async handleSessionCommand(
    command: "fork" | "continue" | "new",
    stage?: SessionStageSpec,
  ): Promise<void> {
    switch (command) {
      case "fork":
        return this.handleSessionFork();
      case "continue":
        return this.handleSessionContinue();
      case "new":
        return this.handleNewSession(stage);
    }
  }

  /**
   * Public shutdown: close stdin and kill the process gracefully.
   * Called from `main.ts`'s quiesce path. Also closes the read-only
   * sessions.db handle so the file lock is released before any temp
   * teardown the OS / test fixtures may run.
   *
   * `graceMs` bounds how long a healthy claude gets to exit on its own
   * after EOF. Shutdown passes the `tug-quiesce` flush budget: waiting
   * out the full respawn-sized grace is what used to push tugcode past
   * the supervisor's drain deadline and earn it a SIGKILL.
   */
  async shutdown(opts?: { graceMs?: number }): Promise<void> {
    this.replay.closeSessionsDb();
    await this.killAndCleanup({ graceMs: opts?.graceMs });
  }

  /**
   * Upsert the record for this session into `dev.tugapp.dev /
   * sessions`. Keyed by the session id (which claude uses as its own
   * session id and tugcast uses for feed routing — a single identifier
   * across the stack). Value shape:
   *
   *   `{ [sessionId]: { projectDir, createdAt } }`
   *
   * `createdAt` is the epoch-ms timestamp the session was first
   * recorded. Resume keeps the existing `createdAt`; the picker sorts
   * by it to show the newest session first for a given project.
   */
  /**
   * Resolve the tugplug plugin directory for `--plugin-dir`. Delegates to the
   * shared app-level {@link resolvePluginDir} so the context-breakdown emitter
   * (`main.ts`) and the spawn agree on the (universal) plugin dir.
   */
  private getPluginDir(): string {
    return resolvePluginDir();
  }
}
