/**
 * CodeSessionStore — per-Session-card L02 store that owns Claude Code turn
 * state for a single `tug_session_id`. It observes filtered
 * CODE_OUTPUT / SESSION_STATE frames through a real `FeedStore`,
 * dispatches CODE_INPUT messages via `encodeCodeInputPayload`, and
 * exposes an append-only transcript plus an in-flight streaming
 * document that `TugMarkdownView` can render.
 *
 * Step 3 wires the basic `idle → submitting → awaiting_first_token →
 * streaming → idle` round-trip; Steps 4–8 extend the reducer to cover
 * streaming deltas, tool calls, control forwards, interrupt + queue,
 * and errored transitions.
 *
 * [D01] store owns filtered FeedStore
 * [D02] card owns CONTROL lifecycle
 * [D03] three-identifier model
 * [D04] transcript + streaming
 * [D09] metadata store independent
 * [D11] effect-list reducer
 */

import {
  FeedId,
  encodeCodeInputPayload,
  encodeRecordContextBreakdown,
  encodeRecordSessionStateChange,
  encodeRecordTurnTelemetry,
  encodeRequestReplay,
  DEFAULT_REPLAY_WINDOW_TURNS,
  type ContentBlock,
  type FeedIdValue,
} from "@/protocol";
import type { PermissionMode } from "@tugproto/inbound";
import type { TugConnection } from "@/connection";
import type { ConnectionLifecycle } from "@/lib/connection-lifecycle";
import {
  PropertyStore,
} from "@/components/tugways/property-store";
import { FeedStore } from "@/lib/feed-store";
import type { AtomSegment } from "./tug-atom-img";
import { TUG_ATOM_CHAR } from "./tug-atom-img";
import { hasLeadingCommandAtom } from "./command-atom";
import type { PendingContextStore } from "./pending-context-store";
import {
  createAtomBytesStore,
  type AtomBytesStore,
} from "./atom-bytes-store";
import { buildWirePayload } from "./build-wire-payload";
import { synthesizeUserMessageFromBlocks } from "./synthesize-user-message";
import { sessionTagStore } from "./session-tag-store";
import {
  isCompactionSummarizeText,
  splitCompactionSeed,
} from "./compaction-request";
import {
  narrowTaskStartedFrame,
  narrowTaskUpdatedFrame,
  narrowTaskProgressFrame,
} from "./code-session-store/select-jobs";
import { goalIsActive } from "./code-session-store/select-goal";
import {
  createInitialState,
  deriveActiveTurnSnapshot,
  reduce,
  truncateTranscriptAtAnchor,
  upsertInkTurn,
  appendTurnInterleavingInk,
  absorbDashNotes,
  systemNoteKey,
  type CodeSessionState,
} from "./code-session-store/reducer";
import { logSessionLifecycle } from "./session-lifecycle-log";
import { getPulseStore } from "./pulse-store";
import {
  clearCachedParses,
  invalidateCachedParsesByPrefix,
} from "./markdown/parse-cache";
import { tugDevLogStore } from "./tug-dev-log-store/tug-dev-log-store";
import type {
  CodeSessionEvent,
  RefsResultActionEvent,
} from "./code-session-store/events";
import type { Effect } from "./code-session-store/effects";
import { publishLocalSessionStateChange } from "./session-state-changes-local-events";
import type {
  CardSessionMode,
  CodeSessionSnapshot,
  InterruptReason,
  LiveMessageUsage,
  PendingAsk,
  TurnEntry,
  SystemNote,
} from "./code-session-store/types";

export type {
  ActiveTurnSnapshot,
  CardSessionMode,
  CodeSessionSnapshot,
  CodeSessionPhase,
  TransportState,
  TurnEntry,
  Message,
  MessageKind,
  UserMessage,
  AssistantText,
  AssistantThinking,
  SystemNote,
  ToolUseMessage,
  QueuedSend,
  ControlRequestForward,
  PendingAsk,
  CostSnapshot,
  LastReplayResult,
} from "./code-session-store/types";

export {
  REPLAY_PREFLIGHT_TIMEOUT_MS,
  REPLAY_SOFT_BUDGET_MS,
  REPLAY_TIMEOUT_DWELL_MS,
} from "./code-session-store/reducer";

/**
 * Timer source injected into `CodeSessionStore` for the replay-clock
 * `schedule_timer` / `cancel_timer` effects. Defaults to globalThis
 * timers in production; tests inject a fake source so they can
 * deterministically advance time without racing real wall-clock
 * delays.
 */
export interface TimerSource {
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const DEFAULT_TIMER_SOURCE: TimerSource = {
  setTimeout: (cb, ms) =>
    (globalThis as { setTimeout: (cb: () => void, ms: number) => unknown })
      .setTimeout(cb, ms),
  clearTimeout: (handle) =>
    (globalThis as { clearTimeout: (handle: unknown) => void })
      .clearTimeout(handle),
};

const STREAM_SOURCE_TAG = "code-session-store";

/**
 * Streaming-document path carrying the latest `streaming_usage` frame —
 * high-frequency display telemetry kept OFF the snapshot so a usage frame
 * re-renders only the status cells observing this path, never the
 * transcript list. Cleared at `activeTurn` boundaries by `dispatch`.
 */
const LIVE_USAGE_PATH = "telemetry.liveTurnUsage";

/**
 * Trailing-flush delay for live wire-origin snapshot notifications —
 * one display frame. Same-phase streaming bursts coalesce to this
 * cadence; the ≤16 ms added notify latency is under one frame and
 * invisible (streamed text paints imperatively, off this path).
 */
const LIVE_NOTIFY_MIN_MS = 16;

/**
 * Replay-fold flush threshold. While the reducer's `replaying` phase
 * is open, wire-origin events reduce immediately but their listener
 * notification (and snapshot publication) is deferred; every
 * `REPLAY_FOLD_FLUSH_THRESHOLD` deferred events the fold flushes one
 * notify so a whale-sized replay paints progressively instead of
 * holding the UI to the very end. Flushes are event-driven only —
 * the other triggers are the window closing (`replay_complete` or
 * any phase exit) and store teardown. No timers, no rAF.
 */
export const REPLAY_FOLD_FLUSH_THRESHOLD = 250;

/**
 * Per-replay-window ingest counters (the `perf.replay_ingest`
 * instrumentation surface). One record is opened on `replay_started`,
 * accumulated per dispatched event / listener notification, and
 * closed + emitted on `replay_complete`.
 *
 * `commits` is the store's own `notifyListeners` count inside the
 * window — the "≤ N commits per replay" assertion surface. `folds`
 * counts buffered-fold flushes; zero until the replay fold lands and
 * kept in the shape from day one so consumers never see a field
 * appear mid-plan.
 */
export interface ReplayIngestPerf {
  startedAtMs: number;
  completedAtMs: number | null;
  /** Reducer-relevant events dispatched inside the window. */
  frames: number;
  /** Buffered-fold flushes (0 until the replay fold exists). */
  folds: number;
  /** Listener notifications (React commit triggers) inside the window. */
  commits: number;
  /**
   * Synchronous CPU spent in the pure `reduce()` call, summed across
   * every frame in the window (ms). Isolates the reducer's own cost
   * from arrival pacing.
   */
  reduceMs: number;
  /**
   * Synchronous CPU spent in the whole dispatch body — reduce +
   * effects + persist + publish/notify — summed across every frame
   * (ms). Compare against the window's wall span (`completedAtMs -
   * startedAtMs`): if `dispatchMs` is much smaller, the browser spent
   * the window *waiting for frames to arrive*, not processing them —
   * the cost lives upstream in emit/transport, not in ingest.
   */
  dispatchMs: number;
}

/**
 * Per-live-turn commit counters (the `perf.live_commits` surface).
 * Opened on `send`, closed + emitted on the matching `turn_complete`.
 */
export interface LiveTurnPerf {
  turnKey: string;
  startedAtMs: number;
  /** Listener notifications between send and turn_complete. */
  commits: number;
}

/**
 * Mint a stable per-turn key. Used as the React-key seed for the
 * inflight cell pair and preserved unchanged through commit into
 * `TurnEntry.turnKey`. Lives in the store wrapper (not the reducer)
 * because `crypto.randomUUID()` is impure and the reducer is
 * contractually pure + time-independent.
 *
 * Fallback `turn-${time}-${random}` shape covers runtimes without
 * `crypto.randomUUID` — uniqueness is per-session, not global.
 */
function mintTurnKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Whether a callsign names a session this client has seen — the discriminator
 * that recovers a session `@`-mention from a value shaped like a relative
 * path. Handed to the synthesizer rather than reached for there, so that
 * module stays pure.
 */
function isKnownSessionTag(tag: string): boolean {
  return sessionTagStore.knownTags().has(tag);
}

/** CODE_OUTPUT frame `type` values the reducer currently handles. */
const KNOWN_CODE_OUTPUT_TYPES: ReadonlySet<string> = new Set([
  "session_init",
  "content_block_start",
  "assistant_text",
  "thinking_text",
  "tool_use",
  "tool_result",
  "tool_use_structured",
  "turn_complete",
  "system_metadata",
  "control_request_forward",
  "cost_update",
  // Claude's SDK is backing off and retrying a retryable API failure.
  // Display-only: the reducer folds it into `apiRetry`, no phase change.
  "api_retry",
  // A model declined and the SDK retried on a fallback model (non-fatal).
  // Display-only: the reducer folds it into `refusalFallback`, no phase change.
  "model_refusal_fallback",
  // An assistant message closed on `max_tokens` — the output was truncated.
  // Display-only: the reducer folds it into `outputTruncated`, no phase change.
  "output_truncated",
  // `/goal` evaluator feedback — the Stop-hook evaluator judged the goal
  // condition unmet mid-cycle. The reducer folds it into `goal` (round
  // count + latest reason); no phase change, no transcript ink.
  "goal_feedback",
  // Claude compacted its context (auto-compaction at capacity, or a native
  // `/compact`). The reducer appends a compaction `system_note` divider to the
  // active turn (or the last committed turn on replay).
  "compact_boundary",
  // The compaction summary text, emitted right after `compact_boundary` on both
  // the live and replay paths. The reducer folds it into `compactionSeed` so
  // the carry-forward block restores; no phase change, no transcript ink.
  "compact_summary",
  // tugcode announced that the card's live claude session id changed, and
  // how. Only `kind: "rotation"` — the server seating the next stage of a
  // dash arc — reaches the reducer, as its `session_stage` event: a stage
  // `system_note` divider so the arc reads as one scroll, and the wheel's
  // turn opened from the prompt the frame echoes. Every other kind is the
  // bridge's identity record and draws nothing; no phase change, and the
  // transcript survives the rotation.
  "session_segment",
  // The same boundary, replayed: tugcode emits this between the JSONLs of an
  // arc's stages during a lineage restore. A separate wire type from
  // `session_segment` because a replayed rotation is only a divider — the
  // identity transfer it names already happened.
  "replay_stage",
  // tugcode's forward-compat catch-all: claude streamed a top-level event
  // type this build doesn't translate. The reducer folds it into
  // `unknownEvent`, driving a soft warn banner; no phase change.
  "unknown_event",
  // Live intra-turn token usage — high-frequency telemetry frame published
  // to the streaming document's live-usage path (never the snapshot); no
  // phase change, no persist.
  "streaming_usage",
  "context_breakdown",
  "error",
  // tugcode emits this after a failed `--resume` spawn. The reducer
  // rolls it into `lastError`.
  "resume_failed",
  // Replay bracket events emitted by the JSONL replay translator.
  // The reducer transitions into / out of the `replaying` phase on
  // these and populates `lastReplayResult` on completion.
  "replay_started",
  "replay_complete",
  // Per-turn synthetic user-message frame emitted by the replay
  // translator at the start of each replayed turn (and by tugcode's
  // mid-turn snapshot path). The reducer's `handleAddUserMessage`
  // mints a `pendingTurn` whose `initialMessages` is `[user_message]`
  // so the subsequent `turn_complete` commits a `TurnEntry` with the
  // historical user submission text. Named per [D15]'s `add_<kind>`
  // template.
  "add_user_message",
  // Wake-bracket opener emitted by tugcode when claude resumes from
  // idle in response to an async deferred-completion trigger
  // (Monitor / CronCreate / ScheduleWakeup / …). The reducer
  // transitions `idle → waking` and accepts the wake's content
  // events; the bracket closes implicitly on the next `turn_complete`.
  // See `dash/tugplan-session-wake.md` [D01].
  "wake_started",
  // Neutral assistant-originated turn opener (`tuglaws/turn-metric.md`
  // S02): opens an assistant-only turn for orphan assistant content
  // (`--continue` leading orphan, `/compact` continuation) with no user
  // message — the honest replacement for the deleted synth add_user_message.
  "assistant_opener",
  // Server-originated turn opener, emitted by tugcast (not tugcode) beside
  // every turn Tug injects into a session — today the base-motion engine's,
  // when a dash's base moves under it. Journaling an injection makes the turn
  // real to the server, not visible on screen: the live user row comes from the
  // composer echoing its own submission, and an injection has no composer. This
  // is what keeps a server-initiated turn from arriving with no visible cause.
  "tug_notice",
  // Background-job lifecycle frames (the JOBS cell's feed — unrelated
  // to the TaskCreate/TaskUpdate tool calls behind TASKS). tugcode
  // forwards claude's `system/task_started` / `system/task_updated`
  // from both routing tiers; the reducer folds them into the
  // session-lifetime jobs ledger.
  "task_started",
  "task_updated",
  // `task_progress`: in-flight ticks for a backgrounded agent (NEW on
  // the 2.1.197-era wire). The reducer folds the latest tick's tool +
  // usage onto the running job row; it never inserts a row.
  "task_progress",
  // `/rewind` frames ([#step-7-1]/[#step-7-2]). `prompt_anchor` carries the
  // live turn's rewind anchor (the reducer stamps it onto the turn);
  // `rewind_preview_result` carries a per-turn diff-stat (folded into the
  // preview cache); `rewind_result` is the applied-rewind ack (records the
  // result + drives the L26-safe local truncation).
  "prompt_anchor",
  "rewind_preview_result",
  "rewind_result",
]);

export interface CodeSessionStoreOptions {
  conn: TugConnection;
  /**
   * Connection-lifecycle event pipe. The store subscribes to
   * `connectionDidClose` to dispatch `transport_close` into the reducer
   * (idle phases drop it, non-idle routes to `errored`). Required so the
   * store has a single, named source of truth for transport-close
   * events; the legacy `TugConnection.onClose` callable was removed in
   * favor of this lifecycle.
   */
  lifecycle: ConnectionLifecycle;
  tugSessionId: string;
  displayLabel?: string;
  /**
   * The user's session-mode intent at card-open time, captured from
   * the per-card `CardSessionBinding`. Threaded onto
   * `CodeSessionSnapshot.sessionMode` so pure derivations (e.g.
   * `deriveSessionCardBannerSpec`) can branch on it without a second
   * subscription to `cardSessionBindingStore`. Required: every binding
   * carries a mode, so every store has one. Stable for the store's
   * lifetime — a re-bind constructs a fresh services bag with a
   * fresh store.
   */
  sessionMode: CardSessionMode;
  /**
   * Committed turns this resume requested: the default window N turns, or
   * deeper for a faithful restore to a saved anchor above it. Turns are the
   * canonical unit (`tuglaws/turn-metric.md`); exposed on the snapshot so the
   * load bar reports progress against the real target. Defaults to
   * {@link DEFAULT_REPLAY_WINDOW_TURNS}.
   */
  restoreWindowTurns?: number;
  /**
   * The per-card queue of shell / `/btw` interactions staged to ride the next
   * code-route submission as attributed `<tug-context>` context. Consulted at
   * {@link CodeSessionStore.send}: a non-suppressed, non-command submission
   * consumes the queue and prepends the sentinel prefix to the outgoing user
   * message. Optional — a store constructed without it (tests) simply never
   * prepends context.
   */
  pendingContextStore?: PendingContextStore;
  /**
   * Test seam — defaults to globalThis `setTimeout` / `clearTimeout`.
   * Production callers omit this. Tests inject a captured-table
   * timer source so they can advance time deterministically.
   */
  timerSource?: TimerSource;
}

/**
 * L02 external store for a single Claude Code session's turn state.
 * See module JSDoc for scope and phasing.
 */
export class CodeSessionStore {
  readonly streamingDocument: PropertyStore;

  private readonly conn: TugConnection;
  private readonly lifecycle: ConnectionLifecycle;
  private readonly tugSessionId: string;
  private readonly displayLabel: string;
  private readonly sessionMode: CardSessionMode;
  private readonly restoreWindowTurns: number;
  private readonly feedStore: FeedStore;
  private readonly pendingContextStore: PendingContextStore | undefined;
  private readonly timerSource: TimerSource;
  /**
   * Active replay-clock timers keyed by their effect `name`
   * (`"preflight"`, `"soft_budget"`, `"timeout_dwell"`). Populated by
   * `schedule_timer` effects from the reducer; cleared by
   * `cancel_timer` effects, by the timer's own callback after it
   * dispatches the named tick event, and by `dispose()`.
   */
  private readonly _replayTimers: Map<string, unknown> = new Map();

  /**
   * Per-card bytes side-table for inline image attachments. One
   * instance is created at construction and survives until `dispose`;
   * the drop / paste handlers in the embedded text editor populate
   * it, the wire-flattening at submit-time reads from it, and the
   * `useCardStatePreservation` snapshot round-trips its contents
   * across cold boot / pane restore.
   *
   * Exposed via {@link getAtomBytesStore} so non-React consumers
   * (the drop / paste extensions inside CodeMirror) can reach it
   * through a thunk read at fire time ([L07]). Per
   * [D03](dash/dev-atoms.md#d03-atom-bytes-store).
   */
  private readonly atomBytesStore: AtomBytesStore;

  private state: CodeSessionState;

  private _transcript: ReadonlyArray<TurnEntry> = [];
  // Older turns staged by a load-previous (prepend) replay bracket, in
  // arrival order. `flush-prepend` commits this batch to the FRONT of
  // `_transcript` at the bracket's `replay_complete`, then clears it.
  private _prependStaging: TurnEntry[] = [];
  // Target message count of the in-flight load-previous (0 when none),
  // for the load sheet's determinate progress. The loaded-so-far value
  // is derived from `_prependStaging` at snapshot time.
  private _loadPreviousTarget = 0;
  private _listeners: Array<() => void> = [];
  private _cachedSnapshot: CodeSessionSnapshot | null = null;

  /**
   * A question from outside the turn stream, waiting on the human. Set by the
   * pending-ask store rather than the reducer — it arrives over `/api/ask`, not
   * over the session's wire, and belongs to no turn.
   */
  private _pendingAsk: PendingAsk | null = null;
  private _disposed = false;
  private _feedStoreUnsub: (() => void) | null = null;
  /**
   * Aggregated unsubscribe callbacks for every `ConnectionLifecycle`
   * channel the store observes. Currently `connectionDidClose` (Step 1b)
   * and `connectionDidReconnect` (Step 5). Held as an array so adding
   * future channels is a one-line append at construction and a
   * one-line iteration at dispose; no chance of forgetting one.
   */
  private _lifecycleUnsubs: Array<() => void> = [];
  private _lastFrameByFeed: Map<number, unknown> = new Map();

  /**
   * Perf instrumentation state — pure observability, no behavior.
   * `_perfReplay` is the open replay window (null between windows);
   * `_perfLastReplay` retains the most recently completed window so
   * the transcript host can stamp `perf.replay_render` against its
   * start time after the replay paint gate drops. `_perfLiveTurn`
   * is the open live-turn commit counter (null between turns).
   */
  private _perfReplay: ReplayIngestPerf | null = null;
  private _perfLastReplay: ReplayIngestPerf | null = null;
  private _perfLiveTurn: LiveTurnPerf | null = null;
  private _perfLastLiveTurn: LiveTurnPerf | null = null;

  /**
   * Replay-fold deferred-notify count. Non-zero while the `replaying`
   * phase has reduced wire events whose listener notification (and
   * snapshot publication — `_cachedSnapshot` stays pinned) has not
   * flushed yet. The fold is notification-deferral only: every event
   * still reduces and processes its effects immediately, so the
   * reducer's semantics are byte-identical to per-frame dispatch —
   * React simply observes one snapshot tick per flush ([L02]).
   */
  private _foldPending = 0;

  /**
   * Live-notify coalescing: same-phase wire dispatches ride ONE
   * trailing flush per {@link LIVE_NOTIFY_MIN_MS} window, so a
   * streaming burst costs React one render per ~frame instead of one
   * per token. Local dispatches (user actions) and phase transitions
   * always publish immediately, flushing anything pending. Time-based
   * rather than rAF-based on purpose: rAF stalls in occluded /
   * background WebViews, which would freeze background-card
   * transcripts; a timer coalesces identically (~60 Hz) everywhere —
   * and rides the injectable {@link TimerSource} for deterministic
   * tests.
   */
  private _trailingNotify: unknown | null = null;

  /**
   * Whether a caller is holding this store's notifications for the
   * duration of something it is showing — see
   * {@link holdNotifications}. Held is not the same as replaying: the
   * hold has no phase of its own and no threshold, it simply ends when
   * the holder says so or when the watchdog decides the holder is not
   * coming back.
   */
  private _held = false;

  /** The watchdog handle that ends a hold nobody released. */
  private _holdWatchdog: unknown | null = null;

  constructor(options: CodeSessionStoreOptions) {
    this.conn = options.conn;
    this.lifecycle = options.lifecycle;
    this.tugSessionId = options.tugSessionId;
    this.displayLabel = options.displayLabel ?? options.tugSessionId.slice(0, 8);
    this.restoreWindowTurns =
      options.restoreWindowTurns ?? DEFAULT_REPLAY_WINDOW_TURNS;
    this.sessionMode = options.sessionMode;
    this.pendingContextStore = options.pendingContextStore;
    this.timerSource = options.timerSource ?? DEFAULT_TIMER_SOURCE;

    // Per-card bytes side-table — populated at drop / paste, drained
    // at `clear()` on dispose. Snapshot rides
    // `useCardStatePreservation` so attachment bytes survive cold
    // boot and pane restore alongside the rest of the prompt-entry
    // draft. Per [D03](dash/dev-atoms.md#d03-atom-bytes-store).
    this.atomBytesStore = createAtomBytesStore();

    // The streaming document holds per-turn streaming paths only,
    // shaped `turn.${turnKey}.${channel}` (assistant / thinking /
    // tools). Each turn writes to its own path; every committed
    // turn's cell keeps observing the same path forever (no
    // overwrites). The previous legacy `inflight.*` paths are gone —
    // they were a parallel path system from before the turnKey
    // architecture and were inert in the transcript dispatch.
    this.streamingDocument = new PropertyStore({
      schema: [],
      initialValues: {},
      // Per-turn paths (`turn.${turnKey}.{channel}`) are minted at
      // `handleSend` and observed by `AssistantTurnCell` for the rest of
      // that turn's life — including after `turn_complete`, when
      // the path retains its final value forever. The set of paths
      // is unknowable at construction time; `dynamicPaths` lets
      // them register on first write rather than requiring a
      // brittle global enumeration.
      dynamicPaths: true,
    });

    this.state = createInitialState(
      this.tugSessionId,
      this.displayLabel,
      this.sessionMode,
    );

    this.feedStore = new FeedStore(
      this.conn,
      [
        FeedId.CODE_OUTPUT,
        FeedId.SESSION_STATE,
        FeedId.CONTROL,
      ] as ReadonlyArray<FeedIdValue>,
      undefined,
      (feedId, decoded) => this.acceptFrame(feedId, decoded),
    );
    this._feedStoreUnsub = this.feedStore.subscribe(() =>
      this.onFeedStoreChange(),
    );

    // Lifecycle wiring per [D07]: `ConnectionLifecycle` is the action
    // source, the reducer is the responder. The store subscribes once
    // at construction and translates the two lifecycle events that
    // matter to its reducer:
    //
    //   - `connectionDidClose` → `transport_close`. The reducer flips
    //     `transportState` to `offline` (and, for non-idle phases, the
    //     phase to `errored` per [D06]).
    //   - `connectionDidReconnect` → `transport_open`. The reducer
    //     flips `transportState` to `restoring` per [D08]. The
    //     lifecycle gates this event on a prior open + close, so the
    //     store never has to maintain a `_seenFirstOpen` flag of its
    //     own — initial-mount opens never reach this callback.
    //
    // Both subscriptions live for the store's lifetime; `dispose()`
    // unsubscribes the whole list.
    this._lifecycleUnsubs.push(
      this.lifecycle.observeConnectionDidClose(() => {
        if (this._disposed) return;
        this.dispatch({ type: "transport_close" });
      }),
    );
    this._lifecycleUnsubs.push(
      this.lifecycle.observeConnectionDidReconnect(() => {
        if (this._disposed) return;
        this.dispatch({ type: "transport_open" });
      }),
    );
  }

  /** L02 subscribe contract. Returns an unsubscribe function. */
  subscribe = (listener: () => void): (() => void) => {
    this._listeners.push(listener);
    return () => {
      const idx = this._listeners.indexOf(listener);
      if (idx >= 0) this._listeners.splice(idx, 1);
    };
  };

  /**
   * Fine-grained [L02] pair for the live intra-turn usage telemetry —
   * rides the streaming document's per-path observers, NOT the snapshot,
   * so a `streaming_usage` frame ticks only the status cells:
   *
   * ```ts
   * useSyncExternalStore(store.observeLiveTurnUsage, store.getLiveTurnUsage)
   * ```
   */
  observeLiveTurnUsage = (listener: () => void): (() => void) =>
    this.streamingDocument.observe(LIVE_USAGE_PATH, listener);

  /** Latest `streaming_usage` frame, or null between turns. */
  getLiveTurnUsage = (): LiveMessageUsage | null =>
    (this.streamingDocument.get(LIVE_USAGE_PATH) as
      | LiveMessageUsage
      | null
      | undefined) ?? null;

  /**
   * Dev-only read-only accessor over the internal reducer state.
   * Used by the Cards card Telemetry section to surface live
   * counters and live-clock anchors (`awaitingApprovalSince`,
   * `transportNonOnlineSince`, etc.) that aren't on the public
   * snapshot because they would surprise non-dev consumers. The
   * inspector pairs the returned state with the public snapshot for
   * stable fields (transcript, phase, transport).
   *
   * Returns the same reference for consecutive calls when no
   * dispatch has occurred — uses the same listener notification path
   * as `getSnapshot`, so consumers can subscribe via `subscribe` and
   * read this for fresh data.
   *
   * @internal — only consumed by the dev panel; not part of the
   *  public L02 contract.
   */
  _getInternalStateForDevPanel = (): CodeSessionState => this.state;

  /**
   * Test-only. Feed a wire frame into the store exactly as
   * `onFeedStoreChange` would for a real frame off the connection —
   * decode via `frameToEvent`, then `dispatch`. The app-test harness
   * drives a session card through the lifecycle matrix with this;
   * production frames always arrive through the `FeedStore`
   * subscription, never here.
   *
   * `feedId` is a `FeedId` value (`CODE_OUTPUT` / `SESSION_STATE` /
   * `CONTROL`); `decoded` is the already-decoded frame payload, with
   * a `tug_session_id` matching this store's session. A frame whose
   * `type` is not reducer-relevant decodes to `null` and is a no-op.
   *
   * @internal — reached only through the DEV-gated `window.__tug` test
   *  surface; not part of the public L02 contract.
   */
  _ingestFrameForTest = (feedId: number, decoded: unknown): void => {
    if (this._disposed) return;
    this.routeFrame(feedId, decoded);
  };

  /**
   * Test-only. Drive the transport-lifecycle transitions the store
   * normally receives from `ConnectionLifecycle` — `"close"` dispatches
   * `transport_close` (→ `transportState: "offline"`), `"reconnect"`
   * dispatches `transport_open` (→ `"restoring"`). Lets an app-test
   * exercise the TRANSPORT_DOWN overlay without tearing down the real
   * shared connection.
   *
   * @internal — reached only through the DEV-gated `window.__tug` test
   *  surface.
   */
  _simulateTransportForTest = (kind: "close" | "reconnect"): void => {
    if (this._disposed) return;
    this.dispatch({
      type: kind === "close" ? "transport_close" : "transport_open",
    });
  };

  /**
   * L02 snapshot contract. Returns a stable reference between dispatches
   * that produce no state or transcript change — required for
   * `useSyncExternalStore` to avoid tearing ([D11]).
   */
  getSnapshot = (): CodeSessionSnapshot => {
    if (this._cachedSnapshot !== null) {
      return this._cachedSnapshot;
    }
    const snap: CodeSessionSnapshot = {
      phase: this.state.phase,
      transportState: this.state.transportState,
      interruptInFlight: this.state.interruptInFlight,
      tugSessionId: this.tugSessionId,
      displayLabel: this.displayLabel,
      sessionMode: this.sessionMode,
      restoreWindowTurns: this.restoreWindowTurns,
      activeMsgId: this.state.activeMsgId,
      // [D01] submit is gated on the conjunction of phase and
      // transport health. An idle card whose wire is offline must
      // refuse new turns until reconnect; a card whose phase is
      // errored but whose wire is back can still retry.
      // `replaying` excludes both submit and interrupt — the bracket
      // window owns the card; the user can only watch.
      canSubmit:
        (this.state.phase === "idle" || this.state.phase === "errored") &&
        this.state.transportState === "online",
      // `waking` is included per [Q03] resolution in
      // `dash/tugplan-session-wake.md`: the user can stop a
      // runaway wake turn just like a user-initiated one. The
      // interrupt frame uses the same wire shape regardless — the
      // server doesn't need to distinguish.
      canInterrupt:
        this.state.phase === "submitting" ||
        this.state.phase === "awaiting_first_token" ||
        this.state.phase === "streaming" ||
        this.state.phase === "tool_work" ||
        this.state.phase === "awaiting_approval" ||
        this.state.phase === "waking",
      pendingApproval: this.state.pendingApproval,
      pendingAsk: this._pendingAsk,
      pendingQuestion: this.state.pendingQuestion,
      // The reducer rebuilds `queuedSends` only on enqueue / flush /
      // clear; passing the reference through unchanged preserves
      // `Object.is` stability across quiescent snapshot rebuilds so
      // `useSyncExternalStore` consumers ([L02]) don't see spurious
      // queue churn.
      queuedSends: this.state.queuedSends,
      transcript: this._transcript,
      // `/rewind` ([#step-7-3]): pass the reducer references through unchanged
      // so they stay `Object.is`-stable across quiescent rebuilds ([L02]) —
      // the reducer rebuilds `rewindPreviews` only on a preview round-trip and
      // `lastRewindResult` only on an applied rewind.
      rewindPreviews: this.state.rewindPreviews,
      lastRewindResult: this.state.lastRewindResult,
      // [D07] Derive the public `activeTurn` projection from
      // `state.pendingTurn` + `state.scratch[turnKey]`. `null` when no
      // turn is in flight; otherwise carries the turn-stable
      // `turnKey` + `submitAt` + `origin` plus the live Message
      // sequence the data source iterates. The derivation is pure but
      // produces a fresh object on each call — the outer snapshot
      // cache (`_cachedSnapshot`) ensures `Object.is` stability across
      // quiescent reads, satisfying [L02] for downstream
      // `useSyncExternalStore` consumers.
      activeTurn: deriveActiveTurnSnapshot(this.state),
      // [D10]-style identity stability: pass the reducer's
      // pendingDraftRestore reference through unchanged so the
      // prompt-entry's `useLayoutEffect` (keyed on the slot's identity)
      // fires exactly once per CASE A interrupt — not on every
      // snapshot rebuild that touches an unrelated field.
      pendingDraftRestore: this.state.pendingDraftRestore,
      // Same identity-stability contract: the reducer parks a fresh
      // object only on `insert_command_draft` and clears it to null on
      // `consume_command_insert`, so passing the reference through
      // unchanged lets the prompt entry's seeding `useLayoutEffect` (keyed
      // on the slot's identity) fire exactly once per clicked command.
      pendingCommandInsert: this.state.pendingCommandInsert,
      pendingJotInsert: this.state.pendingJotInsert,
      pendingAtomInsert: this.state.pendingAtomInsert,
      lastCost: this.state.lastCost,
      // Live API-retry announcement (or null). The reducer assigns a
      // fresh object only on an `api_retry` frame and clears it to null
      // at turn boundaries, so the reference is `Object.is`-stable across
      // quiescent rebuilds ([L02]).
      apiRetry: this.state.apiRetry,
      // Most recent model-refusal fallback (or null). Fresh object only on a
      // `model_refusal_fallback` frame, cleared at turn boundary — reference
      // stable across quiescent rebuilds ([L02]).
      refusalFallback: this.state.refusalFallback,
      // True when the latest turn's output was truncated at the token ceiling
      // (`max_tokens`). Set per-turn, cleared at the boundary ([L02]).
      outputTruncated: this.state.outputTruncated,
      // Most recent forward-incompatible `unknown_event` (or null). The
      // reducer assigns a fresh object only on an `unknown_event` frame,
      // so the reference is `Object.is`-stable across quiescent rebuilds
      // ([L02]).
      unknownEvent: this.state.unknownEvent,
      // Set once on a `/compact`-born session (drives the divider header);
      // session-lived, so the reference is trivially stable ([L02]).
      compactionSeed: this.state.compactionSeed,
      // Accumulated denials for the Recently-denied tab. `mergeDenials`
      // preserves the reference when nothing new lands, so this is
      // `Object.is`-stable across quiescent rebuilds ([L02]).
      permissionDenials: this.state.permissionDenials,
      // `window(0)` — captured once from the session's first telemetry
      // iteration, never reassigned thereafter, so the reference is
      // trivially stable.
      sessionInitTokens: this.state.sessionInitTokens,
      // The reducer assigns a fresh `lastContextBreakdown` only when
      // a new `context_breakdown` frame lands; reading the state's
      // reference through unchanged preserves `Object.is` stability
      // across quiescent snapshot rebuilds ([L02]).
      lastContextBreakdown: this.state.lastContextBreakdown,
      lastError: this.state.lastError,
      lastReplayResult: this.state.lastReplayResult,
      replayEverCompleted: this.state.replayEverCompleted,
      replayWindow: this.state.replayWindow,
      sessionCreatedAtMs: this.state.sessionCreatedAtMs,
      loadingPrevious: this.state.replayPrependActive,
      // Determinate load-previous progress: target turns requested vs
      // turns staged so far. Both 0 when no load is in flight.
      loadingPreviousTarget: this.state.replayPrependActive
        ? this._loadPreviousTarget
        : 0,
      loadingPreviousLoaded: this.state.replayPrependActive
        ? this._prependStaging.length
        : 0,
      replayPreflightActive: this.state.replayPreflightActive,
      replaySoftBudgetElapsed: this.state.replaySoftBudgetElapsed,
      replayTimeoutDwellActive: this.state.replayTimeoutDwellActive,
      // Per-turn pause-axis projections for the live-clock
      // derivation. Three closed-intervals arrays + three
      // segment-start timestamps, one set per axis. References pass
      // through unchanged so identity is stable across snapshot
      // rebuilds while the underlying reducer fields don't change
      // ([L02] `useSyncExternalStore` consumers see `Object.is`
      // stability during quiescent renders).
      //
      // Two of the three segment-start fields are renamed
      // projections of existing reducer fields (`awaitingApprovalSince`
      // → `awaitingApprovalSegmentStartedAt`, `transportNonOnlineSince`
      // → `transportDowntimeSegmentStartedAt`). The renames give all
      // three axes a uniform `<axis>SegmentStartedAt` vocabulary at
      // the snapshot surface so `deriveInflightActiveMs` can read
      // them generically.
      awaitingApprovalIntervals: this.state.awaitingApprovalIntervals,
      awaitingApprovalSegmentStartedAt: this.state.awaitingApprovalSince,
      transportDowntimeIntervals: this.state.transportDowntimeIntervals,
      transportDowntimeSegmentStartedAt: this.state.transportNonOnlineSince,
      interruptInFlightIntervals: this.state.interruptInFlightIntervals,
      interruptInFlightSegmentStartedAt:
        this.state.interruptInFlightSegmentStartedAt,
      // Wake-bracket trigger metadata, set during `phase === "waking"`
      // and cleared at the wake's terminal `turn_complete`. Reference
      // passed through unchanged so identity is stable across snapshot
      // rebuilds while the reducer's underlying field doesn't change
      // ([L02]). Slice 1 has no consumers; the field is plumbed so
      // Slice 2 chrome can read it without further reducer changes.
      wakeTrigger: this.state.wakeTrigger,
      // Background-jobs ledger — reference passed through unchanged so
      // identity is stable across snapshot rebuilds while the reducer
      // field doesn't change ([L02]). The JOBS cell reads it via
      // `useJobsState`.
      jobs: this.state.jobs,
      // The session's `/goal` — reference passed through unchanged
      // ([L02]). Read via `useGoalState`.
      goal: this.state.goal,
    };
    this._cachedSnapshot = snap;
    return snap;
  };

  /**
   * Submit a user message. The route (>, $, :) — when present — is the
   * leading atom in `atoms`; `tug-prompt-entry` (T3.4.b) owns route
   * extraction and the store is route-oblivious.
   */
  send(text: string, atoms: AtomSegment[], opts?: { suppress?: boolean }): void {
    if (this._disposed) return;
    // A fresh submission makes prior PULSE commentary stale for this
    // card — clear its strip; the new turn's lines repopulate it.
    // Suppressed (programmatic) sends are not user submissions.
    if (opts?.suppress !== true) {
      getPulseStore()?.clearScope(this.tugSessionId);
    }
    // Staged shell / `/btw` context rides an ordinary user submission — [P08]
    // "Claude never sees a shell exchange implicitly" made on-demand. The
    // sentinel prefix is prepended so it travels *inside* the user message
    // (→ wire content → JSONL → faithful restore) and Claude reads attributed
    // context. Skipped for a suppressed programmatic send, and for a leading
    // slash-command send (a command must stay at message start to expand) —
    // which leaves the queue intact for the next plain submission. The prefix
    // carries no `U+FFFC`, so the atom↔placeholder alignment below is
    // untouched: every atom still pairs with the same object-replacement char.
    let effText = text;
    if (
      opts?.suppress !== true &&
      this.pendingContextStore !== undefined &&
      !hasLeadingCommandAtom(text, atoms, TUG_ATOM_CHAR)
    ) {
      const prefix = this.pendingContextStore.takePrefix();
      if (prefix !== null) effText = prefix + text;
    }
    // `turnKey` is generated in the impure wrapper layer (not in the
    // reducer) so the reducer remains pure and time-independent —
    // mirrors how timers live outside the reducer.
    //
    // Step 5c's two-stage flatten lives here, in the impure wrapper:
    //  1. `buildWirePayload` walks the editor's `(text, atoms)` and
    //     emits Anthropic-API content blocks with image atoms as
    //     standalone blocks at their original positions. The
    //     returned `atomIdAt` resolver maps image-block index to
    //     the editor's original atom id so the synthesizer can reuse
    //     those ids (no bytes-store orphans).
    //  2. `synthesizeUserMessageFromBlocks` produces the JSONL-honest
    //     substrate (`image-N` atom labels, `U+FFFC` positions) and
    //     ensures the bytes-store carries `content` + `mediaType` +
    //     `thumbnailDataUrl` for every image block.
    // The reducer receives the synthesized substrate + the wire
    // content blocks and never touches the bytes-store.
    const wire = buildWirePayload(effText, atoms, this.atomBytesStore);
    // A leading command atom is sent as a clean `/name` for claude to
    // expand (no `@`-mention marker), so `wire.content` can't round-trip the
    // command-ness. Re-synthesizing from it would render plain `/name` text
    // (losing the command chip outright when an argument atom follows) and
    // only recover it when claude's `<command-name>` echo replays. Preserve
    // the editor's full substrate for the optimistic echo so it already
    // matches the replayed chips — no flicker, no dropped command. (Replay
    // rebuilds the same substrate from the envelope via `detectCommandEcho`.)
    const synth = hasLeadingCommandAtom(effText, atoms, TUG_ATOM_CHAR)
      ? { text: effText, atoms, thumbnailBake: Promise.resolve() }
      : synthesizeUserMessageFromBlocks(wire.content, this.atomBytesStore, {
          atomIdAt: wire.atomIdAt,
          isKnownTag: isKnownSessionTag,
        });
    this.dispatch({
      type: "send",
      text: synth.text,
      atoms: synth.atoms,
      content: wire.content,
      turnKey: mintTurnKey(),
      suppress: opts?.suppress === true,
    });
  }

  /**
   * Mint / settle a `$`-route shell exchange as a `shell`-origin transcript
   * turn ([P06]/[P12]). Called by `ShellSessionStore` — which owns the
   * `SHELL_OUTPUT` feed — on `exchange_started` (mint an in-flight turn) and
   * `exchange_complete` (settle it in place, or mint-whole for a restore /
   * bare complete). This is the ONLY way shell content enters the transcript;
   * `SHELL_OUTPUT` is deliberately absent from the code-session feed filter.
   */
  ingestShellExchange(
    event:
      | {
          phase: "started";
          exchangeId: string;
          command: string;
          cwd: string;
          startedAtMs: number;
          autoRouted?: boolean;
        }
      | {
          phase: "complete";
          exchangeId: string;
          command: string;
          output: string;
          exitCode: number | null;
          cwd: string;
          cwdAfter: string | null;
          startedAtMs: number;
          settledAtMs: number;
          autoRouted?: boolean;
          /** Restore only — the ledger row's written position anchor. */
          anchorMsgId?: string;
        },
  ): void {
    if (this._disposed) return;
    if (event.phase === "started") {
      this.dispatch({
        type: "shell_exchange_started",
        exchangeId: event.exchangeId,
        command: event.command,
        cwd: event.cwd,
        startedAtMs: event.startedAtMs,
        autoRouted: event.autoRouted,
      });
    } else {
      this.dispatch({
        type: "shell_exchange_complete",
        exchangeId: event.exchangeId,
        command: event.command,
        output: event.output,
        exitCode: event.exitCode,
        cwd: event.cwd,
        cwdAfter: event.cwdAfter,
        startedAtMs: event.startedAtMs,
        settledAtMs: event.settledAtMs,
        autoRouted: event.autoRouted,
        anchorMsgId: event.anchorMsgId,
      });
    }
  }

  /**
   * Seat a dash gesture's quiet line ([P12]). Called by `useLandingReceipts`
   * for each fresh dash note the changeset verb store delivers. The reducer
   * decides the seat: inside the open turn's message stream when one is
   * streaming (the note narrates work this turn is doing, and renders between
   * the tool calls it arrived among), or as its own quiet ink row when none
   * is. This is the ONLY live path for a dash note; the restore path replays
   * the same ledger rows through `ingestShellExchange` as `dash …` commands,
   * which the quiet-row registration claims.
   */
  ingestDashNote(event: {
    exchangeId: string;
    command: string;
    text: string;
    cwd: string;
    timestamp: number;
  }): void {
    if (this._disposed) return;
    this.dispatch({ type: "dash_note", ...event });
  }

  /**
   * Mint / update a `/match` or `/search` run as a `refs`-origin transcript
   * turn. Called by `RefsSessionStore` — which owns the `REFS_OUTPUT` feed —
   * on every frame of a run, carrying the run's whole current state. This is
   * the ONLY way refs content enters the transcript; `REFS_OUTPUT` is
   * deliberately absent from the code-session feed filter.
   */
  ingestRefs(event: Omit<RefsResultActionEvent, "type">): void {
    if (this._disposed) return;
    this.dispatch({ type: "refs_result", ...event });
  }

  /**
   * Per-card byte-payload store for inline image attachments. The
   * drop / paste extensions populate it at insert time; the
   * wire-flattening at submit reads from it; the
   * `useCardStatePreservation` snapshot round-trips it across pane
   * restore and cold boot. See {@link AtomBytesStore} and
   * [D03](dash/dev-atoms.md#d03-atom-bytes-store).
   *
   * Returns the live instance — callers should not snapshot or
   * memoize the reference across disposal. Survives until
   * `dispose()` clears it.
   */
  getAtomBytesStore(): AtomBytesStore {
    return this.atomBytesStore;
  }

  /**
   * System notification: the per-card binding has been (re-)acked by
   * the supervisor and the wire is fully settled. Dispatched by the
   * `cardSessionBindingStore` subscriber in `session-restore.ts`
   * after a restore completes; the reducer flips `transportState`
   * from `restoring` → `online` (and is a no-op when already online).
   *
   * Public rather than internal because the dispatch source lives
   * outside this class. The store does not subscribe to the binding
   * store directly: per [D04] / [D07] the binding subscriber in
   * `session-restore.ts` is the canonical "binding has arrived"
   * signal, and feeding the event through a named method here keeps
   * `dispatch` private and the binding subscriber free of any
   * knowledge of the reducer event vocabulary.
   */
  notifyTransportSettled(): void {
    if (this._disposed) return;
    this.dispatch({ type: "transport_settled" });
  }

  /**
   * System notification: the per-card binding for a resume-mode
   * session has just been (re-)constructed and the wire is online.
   * Called by `cardServicesStore._construct` once, immediately after
   * the binding for `sessionMode === "resume"` lands. The reducer
   * opens the cold-boot preflight beat — `replayPreflightActive`
   * flips true and a 12s last-resort timer is scheduled. The
   * preflight clears on the first of: `replay_started`,
   * `replay_complete`, `transport_close`, or the 12s tick.
   *
   * Idempotent — re-calling while preflight is already active is a
   * reducer no-op (no second timer is scheduled). A no-op when
   * not in `idle` (e.g. mid-replay) since the live replay is what
   * the banner would otherwise be reflecting anyway.
   *
   * Public rather than internal because the dispatch source lives
   * outside this class — `cardServicesStore` is the single signal
   * point for "resume binding landed". Routing through a named
   * method here keeps `dispatch` private and the binding subscriber
   * free of any knowledge of the reducer event vocabulary, mirroring
   * the existing `notifyTransportSettled()` precedent.
   */
  notifyResumeBindingLanded(): void {
    if (this._disposed) return;
    this.dispatch({ type: "bind_resume_acknowledged" });
  }

  /**
   * Mark the next replay bracket as a load-previous (older-range)
   * prepend: the reducer routes that bracket's committed turns to the
   * prepend-staging buffer and flushes them ahead of the existing
   * transcript at `replay_complete`. Dispatch this immediately before
   * sending the older-range `request_replay` (the send itself is the
   * caller's job). Internal-vocabulary routing kept here so callers
   * stay free of the reducer event names, mirroring
   * `notifyResumeBindingLanded()`.
   */
  beginLoadPreviousBracket(): void {
    if (this._disposed) return;
    this.dispatch({ type: "begin_load_previous" });
  }

  /**
   * Page older turns in above the current view ("load previous N").
   * Marks the next replay bracket as a prepend, then sends a windowed
   * `request_replay` for the `amount` turns immediately older than the
   * oldest currently-loaded turn — `"all"` loads everything older. The
   * supervisor forwards the window to tugcode, which translates only that
   * older range; the reducer prepends it (held scroll via [L23]) and
   * re-bases the absolute numbering from the new `replay_complete`
   * metadata. No-op when nothing older exists (`hasOlder` false) or the
   * window is unknown (a full / legacy load). The caller (the transcript
   * affordance) is responsible for the modal sheet ([P08]).
   */
  loadPrevious(amount: number | "all"): void {
    if (this._disposed) return;
    const win = this.state.replayWindow;
    if (win === null || !win.hasOlder) return;
    // Cap a numeric request to the turns actually older, so the displayed
    // target matches what loads (and the progress bar reaches full).
    const turns =
      amount === "all"
        ? win.firstLoadedTurnIndex
        : Math.min(Math.max(0, amount), win.firstLoadedTurnIndex);
    if (turns <= 0) return;
    this._loadPreviousTarget = turns;
    this.beginLoadPreviousBracket();
    // The N turns immediately older than the current oldest-loaded turn.
    const frame = encodeRequestReplay(this.tugSessionId, {
      turnRange: [
        Math.max(0, win.firstLoadedTurnIndex - turns),
        win.firstLoadedTurnIndex,
      ],
    });
    this.conn.send(frame.feedId, frame.payload);
  }

  /**
   * Cancel an in-flight load-previous / load-all. Sends `cancel_replay`;
   * tugcode aborts the bracket and closes it with
   * `replay_complete{aborted}`, which the reducer turns into a
   * `discard-prepend` so the partial older batch is dropped and the prior
   * loaded window stays intact. The transcript sheet dismisses when the
   * aborted bracket lands. Direct CODE_INPUT (tugcode is live mid-replay),
   * mirroring `interrupt` / `stopJob`.
   */
  cancelLoadPrevious(): void {
    if (this._disposed) return;
    this.conn.send(
      FeedId.CODE_INPUT,
      encodeCodeInputPayload({ type: "cancel_replay" }, this.tugSessionId),
    );
  }

  /**
   * Cancel the in-flight turn. Emits an `interrupt` CODE_INPUT frame
   * and clears any queued sends per [D05]. A no-op when the store is
   * `idle` / `errored` — accidental double-clicks don't spam the
   * server.
   *
   * Behavior splits on whether any *answer-channel* content has begun
   * — an `assistant_text` delta or a `tool_use`
   * (`firstAssistantDeltaAt === null && firstToolUseAt === null`).
   * Thinking does not cross the line: a turn that has emitted only
   * `thinking_text` is still a clean pull-down.
   *
   *   - **CASE A** (no answer content yet) — the wire received our
   *     `user_message` and claude may have thought, but produced
   *     nothing committable. The reducer captures `pendingUserMessage`
   *     into `pendingDraftRestore` for the prompt entry to seed back
   *     into the editor, clears the in-flight pair so the transcript
   *     stops rendering it, and returns `phase` to `idle`. The wire's
   *     eventual `turn_complete(error)` is suppressed by the
   *     `pendingCaseAEchoes` gate — no `TurnEntry` is appended.
   *   - **CASE B** (answer content has begun) — claude has produced at
   *     least one `assistant_text` delta or `tool_use`. Phase stays put
   *     (or restores from `awaiting_approval` to its `prevPhase`), the
   *     wire's `turn_complete(error)` commits a `TurnEntry` carrying
   *     whatever scratch has accumulated with `result: "interrupted"`.
   */
  interrupt(reason?: InterruptReason): void {
    if (this._disposed) return;
    this.dispatch({ type: "interrupt_action", reason });
  }

  /**
   * Set the session's permission mode. Emits a `permission_mode` CODE_INPUT
   * frame and changes no transcript state — the session-card's Z4B chip reflects
   * the new mode from the next `system_metadata` (owned by
   * `SessionMetadataStore`), not from this call, so the indicator stays
   * truthful even if the change races an in-flight turn.
   *
   * The dispatch source is the session-card's `Shift+Tab` handler (and the
   * per-card mode restore on mount); routing through a named method here
   * keeps `dispatch` private and the caller free of reducer-event
   * vocabulary — same precedent as `interrupt` / `respondQuestion`.
   */
  setPermissionMode(mode: PermissionMode): void {
    if (this._disposed) return;
    this.dispatch({ type: "set_permission_mode", mode });
  }

  /**
   * Set the session's model. Emits a `model_change` CODE_INPUT frame and
   * changes no transcript state — the session-card's Z4B model chip reflects the
   * new model from the next `system_metadata` (owned by
   * `SessionMetadataStore`), not from this call, so the indicator stays
   * truthful even if the change races an in-flight turn. The dispatch source
   * is the `/model` picker and the model chip press; routing through a named
   * method here keeps `dispatch` private and the caller free of reducer-event
   * vocabulary — same precedent as `setPermissionMode`.
   */
  setModel(model: string): void {
    if (this._disposed) return;
    this.dispatch({ type: "set_model", model });
  }

  /**
   * Set the session's reasoning-effort level. Emits an `effort_change`
   * CODE_INPUT frame and changes no transcript state — tugcode applies it by
   * respawning claude with `--effort` + `--resume` (no live control verb in
   * 2.1.158, [R07]), and the Z4B effort chip reflects the level optimistically
   * (`SessionMetadataStore`). The dispatch source is the effort picker and the
   * effort chip; routing through a named method here keeps `dispatch` private
   * and the caller free of reducer-event vocabulary — same precedent as
   * `setModel` / `setPermissionMode`.
   */
  setEffort(effort: string): void {
    if (this._disposed) return;
    this.dispatch({ type: "set_effort", effort });
  }

  /**
   * Add a working directory to the session ([#step-13c]). Emits an
   * `add_directory` CODE_INPUT frame and changes no transcript state — tugcode
   * applies it by respawning claude with the dir in `--add-dir` + `--resume`
   * (claude exposes no live add-directory control verb over the bridge), the
   * same respawn-to-apply shape as {@link setEffort}. Sent directly rather than
   * through the reducer: there is no transcript/optimistic state to track, so a
   * reducer event would be ceremony. The `/add-dir` surface is the only caller.
   */
  addDirectory(directory: string): void {
    if (this._disposed) return;
    this.conn.send(
      FeedId.CODE_INPUT,
      encodeCodeInputPayload({ type: "add_directory", directory }, this.tugSessionId),
    );
  }

  /**
   * Stop a running background job. Emits a `stop_task` CODE_INPUT frame
   * (tugcode forwards it to claude as a `stop_task` control request). Sent
   * directly rather than through the reducer — the {@link addDirectory}
   * precedent: no optimistic ledger flip happens here. The wire confirms the
   * stop with `task_updated{status:"killed"}` + a `stopped` task
   * notification (pinned by the v2.1.173-jobs-spike capture), and the
   * ledger row flips when those land — the row stays truthful rather than
   * guessing. The Jobs popover's per-row stop button is the only caller.
   */
  stopJob(taskId: string): void {
    if (this._disposed) return;
    this.conn.send(
      FeedId.CODE_INPUT,
      encodeCodeInputPayload({ type: "stop_task", task_id: taskId }, this.tugSessionId),
    );
  }

  /**
   * Clear the jobs ledger's finished rows — the Jobs popover's Clear
   * button. Deck-local (no wire traffic): dispatches `clear_jobs_action`,
   * which drops terminal rows and always preserves `running` ones. Routing
   * through a named method keeps `dispatch` private — the `interrupt` /
   * `setPermissionMode` precedent.
   */
  clearJobs(): void {
    if (this._disposed) return;
    this.dispatch({ type: "clear_jobs_action" });
  }

  /**
   * Soft-cancel a scheduled cron — the Jobs popover's per-row Cancel
   * button. Harness-owned timers can't be stopped over the wire (tugcode
   * is a passive wake detector, [Q01]), so the honest path is to ask the
   * assistant to `CronDelete` it: a real user message that opens its own
   * turn. Gated to idle (so it doesn't interleave with in-flight work)
   * and to cron rows (a one-shot `ScheduleWakeup` is fire-once and
   * harness-owned — its row's Cancel is disabled in the UI, and this
   * method no-ops defensively). The row flips to `stopped` when the
   * assistant's `CronDelete` lands (the reducer's CronDelete fold).
   */
  cancelScheduledWork(jobId: string): void {
    if (this._disposed) return;
    const job = this.state.jobs.find((j) => j.jobId === jobId);
    if (
      job === undefined ||
      job.status !== "scheduled" ||
      job.kind !== "cron" ||
      this.state.phase !== "idle"
    ) {
      return;
    }
    const label = job.scheduleLabel ?? job.description;
    const suffix = label.length > 0 ? ` (${label})` : "";
    this.send(`Please cancel the scheduled cron \`${jobId}\`${suffix} using CronDelete.`, []);
  }

  /**
   * Stop a running `/loop` paced by a pending wakeup — the scheduled
   * row's Stop button for `kind: "wakeup"`. A harness-owned wakeup
   * can't be cancelled over the wire, and unlike a cron there is no
   * delete verb; the honest path (the `cancelScheduledWork` precedent)
   * is a real user message asking the assistant to end the loop's
   * protocol (`ScheduleWakeup {stop: true}` — the fire consumes the
   * pending wake, and the stop keeps a new one from being scheduled).
   * Gated to idle and to scheduled wakeup rows.
   */
  stopLoop(jobId: string): void {
    if (this._disposed) return;
    const job = this.state.jobs.find((j) => j.jobId === jobId);
    if (
      job === undefined ||
      job.status !== "scheduled" ||
      job.kind !== "wakeup" ||
      this.state.phase !== "idle"
    ) {
      return;
    }
    const label = job.scheduleLabel ?? job.description;
    const suffix = label.length > 0 ? ` (${label})` : "";
    this.send(
      `Please stop the running loop${suffix}: do not act on its next wakeup, ` +
        `and end it with ScheduleWakeup {stop: true} so no further wakeups are scheduled.`,
      [],
    );
  }

  /**
   * Clear the session's active `/goal` — sends the real `/goal clear`
   * command as a user message. Gated to idle/errored like any submit: a
   * goal RUN is one long in-flight cycle, and the honest way to stop the
   * cycle itself is the existing interrupt control; once the turn is
   * stopped (or between evaluator rounds after a respawn), this clears
   * the claude-side goal so the evaluator never re-arms. No-ops without
   * an active goal.
   */
  clearGoal(): void {
    if (this._disposed) return;
    if (!goalIsActive(this.state.goal)) return;
    if (this.state.phase !== "idle" && this.state.phase !== "errored") return;
    this.send("/goal clear", []);
  }

  /**
   * Request the per-turn code diff-stat preview for the `/rewind` sheet
   * ([#step-7-1]/[#step-7-3]). Marks `rewindPreviews[promptUuid]` loading and
   * emits a `rewind_preview` (dry-run) CODE_INPUT frame; the result folds back
   * into the cache when `rewind_preview_result` lands. The sheet calls this
   * lazily for visible/uncached rows only (the N+1 trap lives here if misused).
   */
  requestRewindPreview(promptUuid: string): void {
    if (this._disposed) return;
    this.dispatch({ type: "request_rewind_preview", promptUuid });
  }

  /**
   * Apply a `/rewind` ([#step-7-1]/[#step-7-2]/[#step-7-3]). Emits a
   * `session_rewind` CODE_INPUT frame; the result lands as `lastRewindResult`,
   * and a successful conversation/both rewind truncates the transcript locally
   * (L26-safe — survivors keep their mounts). `fork` (conversation/both only)
   * selects a forked copy (default) over the destructive in-place variant.
   *
   * `draft` is the rewound-to turn's command (text + attachments); when a
   * conversation/both rewind succeeds the reducer routes it into
   * `pendingDraftRestore` so the composer offers the command back for re-edit
   * (seeded iff the editor is empty). Pass it for conversation/both rewinds;
   * omit it (or for a code-only rewind) to leave the composer untouched.
   */
  sessionRewind(
    promptUuid: string,
    scope: "conversation" | "code" | "both",
    fork?: boolean,
    draft?: { text: string; atoms: ReadonlyArray<AtomSegment> },
  ): void {
    if (this._disposed) return;
    this.dispatch({
      type: "session_rewind_request",
      promptUuid,
      scope,
      fork,
      draft,
    });
  }

  /**
   * Acknowledge that the prompt-entry editor has applied the most
   * recent CASE A draft restore. The reducer clears
   * `pendingDraftRestore` to `null` so the editor's
   * `useLayoutEffect` (keyed on the slot's identity) does not
   * re-apply the same restore on subsequent snapshot rebuilds.
   *
   * Idempotent — a call while the slot is already `null` is a state-
   * ref-stable no-op and produces no listener notification.
   *
   * Public rather than internal because the dispatch source is the
   * UI surface (`TugPromptEntry`), not the reducer; routing through a
   * named method here keeps `dispatch` private and the prompt-entry
   * free of any reducer-event-vocabulary knowledge — the same
   * precedent as `notifyTransportSettled` /
   * `notifyResumeBindingLanded`.
   */
  consumePendingDraftRestore(): void {
    if (this._disposed) return;
    this.dispatch({ type: "consume_draft_restore" });
  }

  /**
   * Text stashed by {@link stashUnsentText} before an interrupt could
   * clear it. Empty outside a termination.
   */
  private _stashedUnsentText: string[] = [];

  /**
   * Take a copy of the session's unsent text *now*, before anything
   * clears it.
   *
   * A CASE A interrupt resets `queuedSends` to empty — correctly, for a
   * user pulling a turn back, since the queue belonged to a turn that no
   * longer exists. But the termination pipeline interrupts before it
   * captures, so without this stash a quit taken with sends queued behind
   * a live turn would interrupt the turn and *then* find an empty queue.
   * The pipeline calls this on every live session before interrupting it.
   */
  stashUnsentText(): void {
    if (this._disposed) return;
    this._stashedUnsentText = this.captureUnsentText();
  }

  /**
   * Every piece of text the user has committed to this session that is
   * not on screen in the composer and not yet on the wire, oldest first:
   * an unconsumed `pendingDraftRestore` (a CASE A interrupt's pulled-back
   * submission, or a cancelled queued send), then each queued send, then
   * anything {@link stashUnsentText} preserved from before an interrupt.
   * Deduplicated by text, so a stash that survived the interrupt intact
   * contributes nothing twice.
   *
   * `queuedSends` lives only in memory, and `pendingDraftRestore` is
   * consumed by a render that may never come, so at app exit both are one
   * `process::exit` away from being lost. The prompt entry folds this into
   * the draft it persists — but only for a `"termination"` save, since in
   * steady state the queue is still visible as ghost rows and the restore
   * slot is about to be seeded into the editor. [L23].
   */
  captureUnsentText(): string[] {
    const snap = this.getSnapshot();
    const unsent: string[] = [];
    const add = (text: string | undefined): void => {
      if (text === undefined || text.length === 0) return;
      if (unsent.includes(text)) return;
      unsent.push(text);
    };
    add(snap.pendingDraftRestore?.text);
    for (const queued of snap.queuedSends) add(queued.text);
    for (const stashed of this._stashedUnsentText) add(stashed);
    return unsent;
  }

  /**
   * Park a clicked transcript slash command on `pendingCommandInsert` for
   * the prompt entry to seed as a ready-to-run draft. `name` is the bare
   * command name (no leading slash — the value an editor command atom
   * carries); `args` is the trailing argument text (`""` when none). The
   * prompt entry observes the slot, seeds the atomized command, and calls
   * {@link consumePendingCommandInsert}. Public for the same reason as
   * {@link consumePendingDraftRestore}: the dispatch source is a UI
   * surface (the transcript click), not the reducer.
   */
  insertCommandDraft(name: string, args: string): void {
    if (this._disposed) return;
    this.dispatch({ type: "insert_command_draft", name, args });
  }

  /**
   * Clear `pendingCommandInsert` once the prompt entry has seeded the
   * editor. Idempotent — a call while the slot is already `null` is a
   * state-ref-stable no-op and produces no listener notification.
   */
  consumePendingCommandInsert(): void {
    if (this._disposed) return;
    this.dispatch({ type: "consume_command_insert" });
  }

  /**
   * Park a jot's text on `pendingJotInsert` for the prompt entry to
   * insert. `at` is the drop point in client coordinates (resolved to a
   * document offset), or `null` for append semantics (a click / no point).
   * The entry observes the slot, inserts, and calls
   * {@link consumePendingJotInsert}. Public because the dispatch source is
   * a UI surface (a Cards card drag / double-click), not the reducer.
   */
  insertJot(text: string, at: { x: number; y: number } | null): void {
    if (this._disposed) return;
    this.dispatch({ type: "insert_jot", text, at });
  }

  /**
   * Clear `pendingJotInsert` once the prompt entry has inserted the text.
   * Idempotent — a call while already `null` is a state-ref-stable no-op.
   */
  consumePendingJotInsert(): void {
    if (this._disposed) return;
    this.dispatch({ type: "consume_jot_insert" });
  }

  /**
   * Park one atom on `pendingAtomInsert` for the prompt entry to insert at
   * the caret. Used by Insert into Prompt on a transcript file reference,
   * which hands the prompt an object rather than path text. The entry
   * observes the slot, inserts, and calls
   * {@link consumePendingAtomInsert}. Public because the dispatch source is a
   * UI surface (the transcript's context menu), not the reducer.
   */
  insertAtomDraft(segment: AtomSegment): void {
    if (this._disposed) return;
    this.dispatch({ type: "insert_atom_draft", segment });
  }

  /**
   * Clear `pendingAtomInsert` once the prompt entry has inserted the atom.
   * Idempotent — a call while already `null` is a state-ref-stable no-op.
   */
  consumePendingAtomInsert(): void {
    if (this._disposed) return;
    this.dispatch({ type: "consume_atom_insert" });
  }

  /**
   * Un-send one queued mid-turn submission, identified by the
   * `turnKey` its transcript ghost row carries. The send was queued
   * but never dispatched, so this is a pure local removal — no wire
   * frame. The reducer offers the prompt back through
   * `pendingDraftRestore`. A no-op if the send already flushed (a race
   * with `turn_complete`) or the store is disposed.
   */
  cancelQueuedSend(turnKey: string): void {
    if (this._disposed) return;
    this.dispatch({ type: "cancel_queued_send", turnKey });
  }

  /**
   * Pop the newest pending interactive — the unified Stop / Esc /
   * Cancel gesture across the Dev interactive-dialog family.
   *
   * Stack semantic. The "interactive stack" is the implicit LIFO
   * order of cancellable things attached to the current turn:
   *
   *   1. Queued sends — user messages already submitted but not yet
   *      on the wire (the turn ahead is still running). Popping one
   *      of these is a true un-send: no wire frame; the reducer
   *      offers the prompt back via `pendingDraftRestore`.
   *   2. The running turn itself — the assistant's in-flight work.
   *      Once the queue is empty, this method reaches the turn and
   *      emits an `interrupt` frame (CASE A pull-down or CASE B
   *      interrupt per the threshold).
   *
   * A turn with N queued sends takes N + 1 pops to fully unwind.
   *
   * What "interactive" means here. Every Dev UI surface that asks
   * the user for input — the prompt entry, `QuestionDialog`, the
   * Stop button — funnels its walk-away gesture through this
   * method. Esc reaches it via the responder chain's
   * `CANCEL_DIALOG` action; the prompt entry's Stop button calls it
   * directly; `QuestionDialog`'s Cancel button calls it directly.
   * One gesture, one wire signal, one model reading — no
   * `respondX({})` paths that the assistant could read as "user
   * picked the defaults."
   *
   * Carve-outs (gestures that look like "cancel" but are not pops):
   *
   *   - `PermissionDialog`'s `Deny` is a positive decision via
   *     `respondApproval`, not a walk-away. Routed through the
   *     dialog's own handler.
   *   - `AskUserQuestionToolBlock`'s salvage UI `Cancel` is a local
   *     dismissal of the recovery surface — the failed tool call
   *     has already resolved with an error before the salvage UI
   *     mounts, so there is no pending interactive to pop. Uses
   *     local component state, not this method.
   *
   * No-op when the store is disposed.
   */
  popInteractive(): void {
    if (this._disposed) return;
    const queued = this.getSnapshot().queuedSends;
    if (queued.length > 0) {
      this.cancelQueuedSend(queued[queued.length - 1].turnKey);
      return;
    }
    this.interrupt();
  }

  /**
   * The raw queued sends, for capture before this store is disposed.
   *
   * Returns the reducer's own entries rather than the snapshot
   * projection because a re-seeded send has to reach the wire, and
   * only the raw entry carries the `content` blocks the send-frame is
   * built from.
   */
  exportQueuedSends(): CodeSessionState["queuedSends"] {
    return this.state.queuedSends;
  }

  /**
   * Adopt sends stranded by the disposal of this card's previous
   * store. No-op if this store already has a queue of its own.
   */
  seedQueuedSends(sends: CodeSessionState["queuedSends"]): void {
    if (this._disposed || sends.length === 0) return;
    this.dispatch({ type: "seed_queued_sends", sends });
  }

  /**
   * Respond to a pending permission prompt. Emits a `tool_approval`
   * frame and restores the phase that was active before the
   * `control_request_forward` arrived (typically `tool_work`).
   */
  respondApproval(
    requestId: string,
    payload: {
      decision: "allow" | "deny";
      updatedInput?: Record<string, unknown>;
      message?: string;
      updatedPermissions?: unknown[];
    },
  ): void {
    if (this._disposed) return;
    this.dispatch({
      type: "respond_approval",
      request_id: requestId,
      decision: payload.decision,
      updatedInput: payload.updatedInput,
      message: payload.message,
      updatedPermissions: payload.updatedPermissions,
    });
  }

  /**
   * Respond to a pending `AskUserQuestion` prompt. Emits a
   * `question_answer` frame and restores the phase that was active
   * before the `control_request_forward` arrived.
   *
   * Two mutually-exclusive outcomes: answer the questions
   * (`{ answers }`) or decline and reply in prose (`{ response }`, the
   * `Chat about this` path — resolves the tool with a freeform reply,
   * distinct from `interrupt`).
   */
  respondQuestion(
    requestId: string,
    payload:
      | { answers: Record<string, string> }
      | { response: string },
  ): void {
    if (this._disposed) return;
    this.dispatch({
      type: "respond_question",
      request_id: requestId,
      ...("response" in payload
        ? { response: payload.response }
        : { answers: payload.answers }),
    });
  }

  /**
   * Local teardown: unsubscribe from FeedStore, clear listeners, clear
   * queuedSends, clear in-flight streaming paths. Per [L23] the
   * transcript is user-visible state and is NOT cleared. Per [D02] the
   * card owns `close_session` — this method never writes a CONTROL frame.
   */
  dispose(): void {
    if (this._disposed) return;
    // An open hold ends here rather than outliving the store: the
    // watchdog is cancelled and anything held rides the teardown flush
    // below, so a card torn down mid-gesture strands nothing.
    this._held = false;
    if (this._holdWatchdog !== null) {
      this.timerSource.clearTimeout(this._holdWatchdog);
      this._holdWatchdog = null;
    }
    // Teardown flush of an open replay fold — nothing is ever
    // stranded: listeners still attached observe the final reduced
    // state in one last snapshot tick before they're cleared.
    // A pending coalesced live notify flushes with the fold below (or
    // is dropped by the `_disposed` guard if the timer outlives us).
    if (this._trailingNotify !== null) {
      this.timerSource.clearTimeout(this._trailingNotify);
      this._trailingNotify = null;
      this._publishAndNotify();
    }
    this._flushReplayFold();
    this._disposed = true;
    if (this._feedStoreUnsub) {
      this._feedStoreUnsub();
      this._feedStoreUnsub = null;
    }
    for (const unsub of this._lifecycleUnsubs) {
      unsub();
    }
    this._lifecycleUnsubs = [];
    this.feedStore.dispose();
    // Cancel every in-flight replay-clock timer. After dispose, even
    // if a callback fires before the cancel takes effect (timer
    // sources without instant cancellation guarantees), the
    // `_disposed` guard inside the schedule_timer callback drops the
    // dispatch — listeners are already cleared and the reducer
    // wouldn't observe its tick anyway.
    for (const handle of this._replayTimers.values()) {
      this.timerSource.clearTimeout(handle);
    }
    this._replayTimers.clear();
    this._listeners = [];
    this.state.queuedSends = [];
    // Release any retained attachment bytes; the bytes-store is per-
    // card and has no consumers past dispose.
    this.atomBytesStore.clear();
    // No per-turn-path cleanup on dispose: the streamingDocument
    // dies with the store instance, taking its accumulated paths
    // with it. Consumers that survived past dispose would already
    // be in undefined-behaviour territory.
    //
    // The render-once parse cache is scoped to the streamingDocument
    // and would be GC'd with it; the explicit clear keeps the
    // session-scoped lifetime contract exact rather than
    // GC-eventual.
    clearCachedParses(this.streamingDocument);
    this._cachedSnapshot = null;
  }

  // ---------------------------------------------------------------------
  // Internal dispatch pipeline
  // ---------------------------------------------------------------------

  /**
   * Per-card frame filter: one rule for every feed — match on the
   * payload's `tug_session_id`.
   *
   * CONTROL error frames used to be exempt. Both of the ones that reach
   * a session store (`session_unknown` from the supervisor's orphan
   * dispatcher, `session_not_owned` from the router's authz reject) now
   * carry the id of the session whose turn they killed, so the exemption
   * has nothing left to admit — and keeping it would be actively wrong,
   * because each notice ends a live turn from any phase. An unaddressed
   * error would end the wrong card's turn.
   */
  private acceptFrame(feedId: number, decoded: unknown): boolean {
    const d = decoded as { tug_session_id?: string };
    return d.tug_session_id === this.tugSessionId;
  }

  private onFeedStoreChange(): void {
    if (this._disposed) return;
    const snap = this.feedStore.getSnapshot();
    for (const [feedId, value] of snap.entries()) {
      if (this._lastFrameByFeed.get(feedId) !== value) {
        this._lastFrameByFeed.set(feedId, value);
        this.routeFrame(feedId, value);
      }
    }
  }

  /**
   * Route one decoded feed value into the reducer. A CODE_OUTPUT
   * `replay_batch` is a transport-only envelope: its `frames` are
   * unwrapped here and each dispatched through the same
   * `frameToEvent` + `dispatch` path a per-frame replay would take, so
   * the reducer never sees the batch. Everything else takes the
   * single-frame path unchanged. The session filter has already run on
   * the outer value at the FeedStore boundary, so inner frames dispatch
   * post-filter and need no `tug_session_id` of their own.
   */
  private routeFrame(feedId: number, value: unknown): void {
    if (
      feedId === FeedId.CODE_OUTPUT &&
      (value as { type?: string }).type === "replay_batch"
    ) {
      const frames = (value as { frames?: unknown }).frames;
      if (Array.isArray(frames)) {
        for (const inner of frames) {
          const event = this.frameToEvent(feedId, inner);
          if (event !== null) this.dispatch(event, "wire");
        }
        return;
      }
    }
    const event = this.frameToEvent(feedId, value);
    if (event !== null) this.dispatch(event, "wire");
  }

  private frameToEvent(
    feedId: number,
    decoded: unknown,
  ): CodeSessionEvent | null {
    if (feedId === FeedId.CODE_OUTPUT) {
      const ev = decoded as { type?: string } & Record<string, unknown>;
      if (typeof ev.type !== "string") return null;
      if (!KNOWN_CODE_OUTPUT_TYPES.has(ev.type)) return null;
      if (ev.type === "session_init") {
        // Divergence check: log loudly if claude's session_id differs
        // from our tugSessionId. Tugdeck operates on a single id
        // (tugSessionId, decided by the picker); a divergence here
        // would be a tugcast/tugcode bug that broke the post-Phase-B
        // invariant. The store does not consume claude's id for any
        // user-facing purpose — see reducer.handleSessionInit.
        const claudeSid = typeof ev.session_id === "string" ? ev.session_id : null;
        logSessionLifecycle("code_store.session_init_recv", {
          tug_session_id: this.tugSessionId,
          claude_session_id: claudeSid,
          divergent: claudeSid !== null && claudeSid !== this.tugSessionId,
        });
      } else if (ev.type === "resume_failed") {
        logSessionLifecycle("code_store.resume_failed_recv", {
          tug_session_id: this.tugSessionId,
          stale_session_id: typeof ev.stale_session_id === "string"
            ? ev.stale_session_id
            : null,
          reason: typeof ev.reason === "string" ? ev.reason : null,
        });
      }
      if (ev.type === "add_user_message") {
        // `turnKey` is a client-side React-key seed minted by the
        // store wrapper for every dispatched replay event. The wire
        // doesn't (and shouldn't) carry it — replay is a synthesis
        // of historical user submissions, and the cell wrapper
        // identity is purely React's concern. Minting here keeps the
        // reducer pure: it never calls `crypto.randomUUID()`.
        //
        // Step 5c: the wire's `content` blocks (Anthropic API shape,
        // carried verbatim through tugcast / tugcode) are walked
        // through `synthesizeUserMessageFromBlocks` to produce the
        // substrate `(text, atoms)` pair. No resolver — replay path
        // mints fresh atom ids; the bytes-store is per-card-mount
        // (fresh on reload) so orphan-from-id-reuse is impossible.
        const rawContent = Array.isArray(ev.content)
          ? (ev.content as ContentBlock[])
          : [];
        // A `/compact`-born first message carries the recap as a marked
        // leading content block (it rode the wire with the user's text).
        // Split it off the *raw* content before synthesis so the recap
        // never passes through `synthesizeUserMessageFromBlocks` (which
        // parses `@`-mention markers): the bubble is the residual user
        // content, the recap re-marks `compactionSeed` so the
        // carry-forward summary renders on reload exactly as live.
        const lead = rawContent[0];
        const leadText = lead !== undefined && lead.type === "text" ? lead.text : "";
        const seedSummary = leadText !== "" ? splitCompactionSeed(leadText) : null;
        // A canceled `/compact` leaves its throwaway summarization turn in the
        // discarded session's JSONL (claude persisted it; the client's
        // `suppress` never crossed the wire). Recognize it on reload and mark
        // the turn suppressed so it is dropped, not committed.
        const suppressedTurn = leadText !== "" && isCompactionSummarizeText(leadText);
        const content =
          seedSummary !== null ? rawContent.slice(1) : rawContent;
        const synth = synthesizeUserMessageFromBlocks(
          content,
          this.atomBytesStore,
          { isKnownTag: isKnownSessionTag },
        );
        return {
          type: "add_user_message",
          text: synth.text,
          atoms: synth.atoms,
          tug_session_id: typeof ev.tug_session_id === "string"
            ? ev.tug_session_id
            : undefined,
          turnKey: mintTurnKey(),
          timestamp:
            typeof ev.timestamp === "number" && Number.isFinite(ev.timestamp)
              ? ev.timestamp
              : undefined,
          // `/rewind` anchor on the replay / mid-turn-snapshot path
          // ([#step-7-1]); the reducer stamps it onto the turn.
          promptUuid:
            typeof ev.promptUuid === "string" && ev.promptUuid.length > 0
              ? ev.promptUuid
              : undefined,
          // Who authored the submission, as tugcode's translator stated it on
          // the one frame it identified as a stage's opening prompt. The value
          // is narrowed rather than passed through: this boundary's job is to
          // make an untrusted wire value one of the shapes the reducer knows,
          // exactly as every sibling field here does.
          origin: ev.origin === "wheel" ? "wheel" : undefined,
          ...(seedSummary !== null ? { compactionSummary: seedSummary } : {}),
          ...(suppressedTurn ? { suppressedTurn: true } : {}),
        } as unknown as CodeSessionEvent;
      }
      if (ev.type === "wake_started") {
        // Same mint contract as `add_user_message`: the wake's
        // turnKey is a React-key seed with no meaning on the wire.
        // tugcode does not mint it (tugcode is a Node subprocess; it
        // has no React); the store wrapper mints it on receipt and
        // threads it onto the dispatched event so the reducer stays
        // pure. See `dash/tugplan-session-wake.md` [D02].
        return { ...ev, turnKey: mintTurnKey() } as unknown as CodeSessionEvent;
      }
      if (ev.type === "assistant_opener") {
        // Honest assistant-originated opener (`tuglaws/turn-metric.md`
        // S02) — opens an assistant-only turn for orphan assistant
        // content, no user message. Same turnKey mint contract as
        // `wake_started`; the reducer seeds an empty scratch.
        return { ...ev, turnKey: mintTurnKey() } as unknown as CodeSessionEvent;
      }
      if (ev.type === "tug_notice") {
        // Same turnKey mint contract as `wake_started` / `assistant_opener`:
        // tugcast does not mint it (it has no React), so the wrapper mints on
        // receipt and the reducer stays pure.
        return { ...ev, turnKey: mintTurnKey() } as unknown as CodeSessionEvent;
      }
      if (ev.type === "api_retry") {
        // The wire carries `retry_delay_ms` (a duration); the banner
        // wants an absolute `deadline` to count down toward. Stamping
        // `Date.now() + delay` HERE — in the impure wrapper, like
        // `add_user_message` mints its turnKey — keeps the reducer
        // time-free. Wire fields are snake_case; normalize to camelCase
        // for the reducer event.
        const delayMs =
          typeof ev.retry_delay_ms === "number" ? ev.retry_delay_ms : 0;
        return {
          type: "api_retry",
          attempt: typeof ev.attempt === "number" ? ev.attempt : 0,
          maxRetries: typeof ev.max_retries === "number" ? ev.max_retries : 0,
          deadline: Date.now() + delayMs,
          error: typeof ev.error === "string" ? ev.error : "unknown",
          errorStatus:
            typeof ev.error_status === "number" ? ev.error_status : null,
        } as unknown as CodeSessionEvent;
      }
      if (ev.type === "model_refusal_fallback") {
        // Snake_case wire → camelCase reducer event. Display-only one-shot.
        return {
          type: "model_refusal_fallback",
          originalModel:
            typeof ev.original_model === "string" ? ev.original_model : "",
          fallbackModel:
            typeof ev.fallback_model === "string" ? ev.fallback_model : "",
        } as unknown as CodeSessionEvent;
      }
      if (ev.type === "output_truncated") {
        // No payload — the reducer flips a per-turn boolean. Drop the wire's
        // `ipc_version` so the reducer event is clean.
        return { type: "output_truncated" } as unknown as CodeSessionEvent;
      }
      if (ev.type === "goal_feedback") {
        // Flat string payload; drop `ipc_version`, narrow defensively.
        return {
          type: "goal_feedback",
          condition: typeof ev.condition === "string" ? ev.condition : "",
          reason: typeof ev.reason === "string" ? ev.reason : "",
        } as unknown as CodeSessionEvent;
      }
      if (ev.type === "compact_boundary") {
        // Normalize the wire's snake_case `pre_tokens` to the reducer
        // event's `preTokens`; both fields are optional (claude omits
        // `compactMetadata` on some boundaries).
        return {
          type: "compact_boundary",
          ...(typeof ev.trigger === "string" ? { trigger: ev.trigger } : {}),
          ...(typeof ev.pre_tokens === "number"
            ? { preTokens: ev.pre_tokens }
            : {}),
          ...(typeof ev.post_tokens === "number"
            ? { postTokens: ev.post_tokens }
            : {}),
          ...(typeof ev.timestamp === "number" ? { timestamp: ev.timestamp } : {}),
        } as unknown as CodeSessionEvent;
      }
      if (ev.type === "session_segment" && ev.kind !== "rotation") {
        // A rewind, fork, continue, respawn, or `/new` — the bridge's
        // lineage record. The transcript has nothing to draw for it.
        return null;
      }
      if (ev.type === "session_segment" || ev.type === "replay_stage") {
        // The arc's stage announcement, straight off tugcode's IPC line. Only
        // the display fields are carried across: the session ids belong to the
        // bridge's identity transfer, not to the divider.
        return {
          type: "session_stage",
          stage: typeof ev.stage === "string" ? ev.stage : "",
          model: typeof ev.model === "string" ? ev.model : "",
          document: typeof ev.document === "string" ? ev.document : "",
          arc: typeof ev.arc === "string" ? ev.arc : "",
          ...(typeof ev.steps === "string" && ev.steps.length > 0
            ? { steps: ev.steps }
            : {}),
          // A live rotation carries the prompt the runner sent behind it;
          // the turn key is minted here because the reducer is pure.
          ...(ev.type === "session_segment" &&
          typeof ev.prompt === "string" &&
          ev.prompt.length > 0
            ? { prompt: ev.prompt, turnKey: mintTurnKey() }
            : {}),
        } as unknown as CodeSessionEvent;
      }
      if (ev.type === "compact_summary") {
        // The compaction summary string — folded into `compactionSeed` so
        // the carry-forward block restores (live and on reload).
        return {
          type: "compact_summary",
          summary: typeof ev.summary === "string" ? ev.summary : "",
        } as unknown as CodeSessionEvent;
      }
      if (
        ev.type === "task_started" ||
        ev.type === "task_updated" ||
        ev.type === "task_progress"
      ) {
        // Background-job lifecycle frames — snake_case wire narrowed
        // to the camelCase reducer events by the select-jobs helpers.
        // A drifted/malformed frame narrows to undefined and is
        // dropped here rather than dispatched.
        const narrowed =
          ev.type === "task_started"
            ? narrowTaskStartedFrame(ev)
            : ev.type === "task_updated"
              ? narrowTaskUpdatedFrame(ev)
              : narrowTaskProgressFrame(ev);
        return narrowed ?? null;
      }
      if (ev.type === "unknown_event") {
        // Normalize tugcode's snake_case forward-compat frame to the
        // reducer event's camelCase. The reducer stamps `at` itself
        // (time-free wire, like the error path).
        return {
          type: "unknown_event",
          originalType:
            typeof ev.original_type === "string" ? ev.original_type : "unknown",
          payloadHexPreview:
            typeof ev.payload_hex_preview === "string"
              ? ev.payload_hex_preview
              : "",
        } as unknown as CodeSessionEvent;
      }
      return ev as unknown as CodeSessionEvent;
    }
    if (feedId === FeedId.SESSION_STATE) {
      // SESSION_STATE payload shape is `{ tug_session_id, state, detail }`.
      // Only `state: "errored"` maps to a reducer event; all other
      // states (`pending`, `spawning`, `closed`, …) are dropped.
      const ss = decoded as { state?: string; detail?: string };
      if (ss.state !== "errored") return null;
      return {
        type: "session_state_errored",
        detail: typeof ss.detail === "string" ? ss.detail : undefined,
      };
    }
    if (feedId === FeedId.CONTROL) {
      // Only CONTROL *error* frames map to reducer events. Everything
      // else (`spawn_session_ok`, `session_backpressure`, app-level
      // actions like `reload` / `set-theme`) either belongs to
      // `action-dispatch.ts` or is dropped by `acceptFrame` upstream
      // of this point. The two error details we recognize are
      // `session_unknown` (supervisor orphan dispatcher) and
      // `session_not_owned` (router P5 authz reject).
      const ce = decoded as { type?: string; detail?: string };
      if (ce.type !== "error") return null;
      if (ce.detail === "session_unknown") {
        return { type: "session_unknown", detail: ce.detail };
      }
      if (ce.detail === "session_not_owned") {
        return { type: "session_not_owned", detail: ce.detail };
      }
      return null;
    }
    return null;
  }

  private dispatch(
    event: CodeSessionEvent,
    origin: "wire" | "local" = "local",
  ): void {
    this._perfBeforeReduce(event);
    const prev = this.state;
    const dispatchStart = performance.now();
    const reduceStart = dispatchStart;
    const { state, effects } = reduce(this.state, event);
    const reduceMs = performance.now() - reduceStart;
    this.state = state;
    this.processEffects(effects);
    this.maybePersistStateChange(prev, state);
    // Turn boundary (send or commit): the live usage path clears so the
    // status cells never read a stale frame across turns — the old
    // in-state lifecycle (`reset at send / superseded at commit`),
    // preserved at the wrapper now that usage rides the streaming
    // document instead of the snapshot.
    if (
      prev.pendingTurn !== state.pendingTurn &&
      (prev.pendingTurn === null || state.pendingTurn === null) &&
      this.streamingDocument.get(LIVE_USAGE_PATH) != null
    ) {
      this.streamingDocument.set(LIVE_USAGE_PATH, null, STREAM_SOURCE_TAG);
    }
    // `write-live-usage` is fine-grained by design — its observers ride
    // the streaming document, so the effect alone must not tick the
    // whole-store snapshot.
    const notifyWorthy =
      prev !== state ||
      effects.some((e) => e.kind !== "write-live-usage");
    if (notifyWorthy) {
      // Replay fold ([P03]): while the reducer's `replaying` phase is
      // open, WIRE events defer their notification — the snapshot
      // stays pinned (`_cachedSnapshot` untouched) so React observes
      // one tick per flush instead of one per frame. Deferral is
      // wire-only: local actions, timer ticks (the soft-budget
      // banner), and transport events publish immediately so
      // mid-window UI stays truthful. `replay_started` itself
      // publishes so the replay paint gate mounts; any event that
      // exits the phase (`replay_complete`, an error path) lands in
      // the else-branch and flushes everything pending in its own
      // notify.
      const defer =
        origin === "wire" &&
        state.phase === "replaying" &&
        event.type !== "replay_started";
      // A hold defers on the same terms and for the same reason, just
      // with a different stop condition: the replay fold ends when the
      // phase does, a hold ends when the holder releases it. Wire-only
      // is the shared rule — a local action is the user's own gesture
      // and must never look ignored, and a timer tick is what keeps the
      // soft-budget banner honest.
      if (defer || (this._held && origin === "wire")) {
        this._foldPending += 1;
        // The threshold is the replay fold's, and only the replay fold's:
        // a hold has a caller who knows when it ends, and flushing out
        // from under that caller mid-gesture is the cost it asked not to
        // pay. A hold that runs long is the watchdog's problem.
        if (defer && this._foldPending >= REPLAY_FOLD_FLUSH_THRESHOLD) {
          this._flushReplayFold();
        }
      } else if (
        origin === "wire" &&
        prev.phase === state.phase &&
        (event.type === "assistant_text" || event.type === "thinking_text")
      ) {
        // Live streaming firehose: same-phase text/thinking deltas
        // coalesce to one notify per LIVE_NOTIFY_MIN_MS window
        // (trailing flush), so a token burst costs React one render
        // per ~frame instead of one per token. Everything else — phase
        // transitions, tool results, errors, control frames — is
        // low-frequency and publishes synchronously below, so
        // side-effectful observers (binding clears, notices) stay
        // prompt.
        this._publishCoalesced();
      } else {
        this._publishAndNotify();
      }
    }
    if (this._perfReplay !== null) {
      this._perfReplay.reduceMs += reduceMs;
      this._perfReplay.dispatchMs += performance.now() - dispatchStart;
    }
    this._perfAfterDispatch(event);
  }

  /**
   * Publish the current state (invalidate the pinned snapshot) and
   * notify listeners once. Any deferred fold events ride this notify —
   * a single snapshot tick covers everything reduced since the last
   * publication.
   */
  private _publishAndNotify(): void {
    // A pending trailing flush is superseded — this publish carries
    // everything reduced so far.
    if (this._trailingNotify !== null) {
      this.timerSource.clearTimeout(this._trailingNotify);
      this._trailingNotify = null;
    }
    const hadFold = this._foldPending > 0;
    this._foldPending = 0;
    this._cachedSnapshot = null;
    this.notifyListeners();
    this._perfOnCommit();
    if (hadFold && this._perfReplay !== null) {
      this._perfReplay.folds += 1;
    }
  }

  /**
   * Arm ONE trailing flush a frame from now (if none is pending):
   * every same-phase wire event inside the window rides that single
   * notify. State/effects are already applied by the time this runs —
   * only the React notification defers, exactly like the replay fold's
   * pinned snapshot, just on a ~frame cadence instead of a count
   * threshold. The ≤16 ms notify latency is under one display frame,
   * and the streamed text itself paints imperatively (the [L22]
   * PropertyStore path) with no deferral at all.
   */
  private _publishCoalesced(): void {
    // Reads stay truthful immediately — a synchronous `getSnapshot`
    // after this dispatch sees the reduced state (unlike the replay
    // fold, which pins the snapshot on purpose). Only the listener
    // notification defers, so React renders once per window instead of
    // once per token.
    this._cachedSnapshot = null;
    if (this._trailingNotify !== null) return;
    this._trailingNotify = this.timerSource.setTimeout(() => {
      this._trailingNotify = null;
      if (this._disposed) return;
      this._publishAndNotify();
    }, LIVE_NOTIFY_MIN_MS);
  }

  /** Threshold / teardown flush of the replay fold. */
  private _flushReplayFold(): void {
    if (this._foldPending === 0) return;
    this._publishAndNotify();
  }

  /**
   * Hold listener notifications until {@link releaseNotifications}.
   *
   * Wire events keep reducing and keep running their effects — nothing
   * is dropped, delayed, or re-requested, and a synchronous read still
   * has to wait for the flush exactly as it does under the replay fold.
   * What waits is the React notification, so a caller that is in the
   * middle of showing the user something can finish showing it before
   * the tree re-renders underneath.
   *
   * The imposer's arrangement settle is the first caller, and the
   * numbers behind it are worth keeping: a React commit landing inside
   * the gesture window costs far more than the same commit landing
   * outside it — measured 1809 walk samples for settle-plus-commits
   * against 343 and 654 for each alone, so 81% above what the two cost
   * added together, with median frame delivery going 17ms to 20ms
   * (`dash/jul30-perf-brief.md#s5-imposer`). A commit during a
   * running transform animation dirties compositing while the
   * animation's extent is reserved, which forces exactly the recompute
   * the reservation exists to avoid.
   *
   * Local actions and timer ticks are never held: the user's own
   * gesture must never look ignored, and the soft-budget banner has to
   * stay honest. Both also flush anything the hold has accumulated.
   *
   * `capMs` arms a watchdog that releases the hold on its own. That is
   * not the clock — the holder's release is the clock — it is the guard
   * against a holder that throws, unmounts, or otherwise never comes
   * back, which would leave the card showing stale content with no way
   * back ([L23]). Re-holding while already held re-arms the watchdog
   * rather than nesting; there is no depth count, because a caller that
   * needs one is really two callers and should say so.
   */
  holdNotifications(capMs: number): void {
    this._held = true;
    // A coalesce flush armed before the hold would fire a frame into it
    // and publish mid-window — the exact commit the holder asked to
    // keep out. Absorb it: the timer is cancelled and the reductions it
    // carried ride the release flush instead.
    if (this._trailingNotify !== null) {
      this.timerSource.clearTimeout(this._trailingNotify);
      this._trailingNotify = null;
      this._foldPending += 1;
    }
    if (this._holdWatchdog !== null) {
      this.timerSource.clearTimeout(this._holdWatchdog);
    }
    this._holdWatchdog = this.timerSource.setTimeout(() => {
      this._holdWatchdog = null;
      this.releaseNotifications();
    }, capMs);
  }

  /**
   * End a hold and publish once if anything accumulated under it.
   *
   * Idempotent, and safe to call when no hold is open — a caller
   * releasing on a teardown path should not have to know whether it
   * ever held.
   */
  releaseNotifications(): void {
    if (this._holdWatchdog !== null) {
      this.timerSource.clearTimeout(this._holdWatchdog);
      this._holdWatchdog = null;
    }
    if (!this._held) return;
    this._held = false;
    if (this._disposed) return;
    if (this._foldPending > 0) {
      this._publishAndNotify();
    }
  }

  // ---------------------------------------------------------------------
  // Perf instrumentation (pure observability — no behavior, no state
  // visible to React; counters live beside the dispatch pipeline
  // because the store is the only place that sees every event AND
  // every listener notification)
  // ---------------------------------------------------------------------

  /**
   * Dev-only read accessor over the perf counters. Consumed by the
   * transcript host's `perf.replay_render` emission and by tests;
   * not part of the public L02 contract.
   *
   * @internal
   */
  _getPerfForDevPanel = (): {
    replay: ReplayIngestPerf | null;
    lastReplay: ReplayIngestPerf | null;
    liveTurn: LiveTurnPerf | null;
    lastLiveTurn: LiveTurnPerf | null;
  } => ({
    replay: this._perfReplay,
    lastReplay: this._perfLastReplay,
    liveTurn: this._perfLiveTurn,
    lastLiveTurn: this._perfLastLiveTurn,
  });

  /** Open windows and count the dispatched event before it reduces. */
  private _perfBeforeReduce(event: CodeSessionEvent): void {
    if (event.type === "replay_started") {
      this._perfReplay = {
        startedAtMs: Date.now(),
        completedAtMs: null,
        frames: 0,
        folds: 0,
        commits: 0,
        reduceMs: 0,
        dispatchMs: 0,
      };
    }
    if (this._perfReplay !== null) {
      this._perfReplay.frames += 1;
    }
    if (event.type === "send") {
      this._perfLiveTurn = {
        turnKey: event.turnKey,
        startedAtMs: Date.now(),
        commits: 0,
      };
    }
  }

  /** Count one listener notification against any open window. */
  private _perfOnCommit(): void {
    if (this._perfReplay !== null) {
      this._perfReplay.commits += 1;
    } else if (this._perfLiveTurn !== null) {
      this._perfLiveTurn.commits += 1;
    }
  }

  /** Close windows + emit summaries after the event fully dispatched. */
  private _perfAfterDispatch(event: CodeSessionEvent): void {
    if (event.type === "replay_complete" && this._perfReplay !== null) {
      const perf = this._perfReplay;
      perf.completedAtMs = Date.now();
      this._perfLastReplay = perf;
      this._perfReplay = null;
      const wallMs = perf.completedAtMs - perf.startedAtMs;
      const summary = {
        tug_session_id: this.tugSessionId,
        ms: wallMs,
        frames: perf.frames,
        folds: perf.folds,
        commits: perf.commits,
        // CPU breakdown: dispatchMs is the synchronous browser work
        // across the window; reduceMs is the pure-reducer slice of it.
        // `ms - dispatchMs` is time the browser spent idle waiting for
        // frames — the share of the load that lives upstream of ingest.
        reduceMs: Math.round(perf.reduceMs),
        dispatchMs: Math.round(perf.dispatchMs),
        waitMs: Math.round(wallMs - perf.dispatchMs),
      };
      logSessionLifecycle("perf.replay_ingest", summary);
      tugDevLogStore.info("perf", "replay_ingest", summary);
      return;
    }
    if (
      event.type === "turn_complete" &&
      this._perfReplay === null &&
      this._perfLiveTurn !== null
    ) {
      const turn = this._perfLiveTurn;
      this._perfLiveTurn = null;
      this._perfLastLiveTurn = turn;
      const summary = {
        tug_session_id: this.tugSessionId,
        turnKey: turn.turnKey,
        commits: turn.commits,
        ms: Date.now() - turn.startedAtMs,
      };
      logSessionLifecycle("perf.live_commits", summary);
      tugDevLogStore.info("perf", "live_commits", summary);
    }
  }

  /**
   * After every reduce, compare the indicator-tone triple `(phase,
   * transportState, interruptInFlight)` between prev and next state.
   * If any axis changed, fire-and-forget a
   * `record_session_state_change` CONTROL frame so the supervisor
   * appends one row to the `session_state_changes` ledger. This is
   * the client-side primary dedupe; the ledger layer dedupes against
   * the most-recent persisted triple as a race safety-net.
   *
   * The triple seeds the popover's state-change log
   * (Step 20.4.9); persistence survives reload so the log is not
   * lost when the card re-mounts. The collapse rules (transcript-
   * length, `pendingApproval` vs `pendingQuestion`, `queuedSends`,
   * `turnEndReason`, DRILLDOWN_OPEN) are owned by the reducer's
   * indicator-tone derivation; this hook only sees what the snapshot
   * already exposes through these three fields. See the parent plan
   * step's "Coverage and known collapses" note.
   */
  private maybePersistStateChange(
    prev: CodeSessionState,
    next: CodeSessionState,
  ): void {
    if (
      prev.phase === next.phase &&
      prev.transportState === next.transportState &&
      prev.interruptInFlight === next.interruptInFlight
    ) {
      return;
    }
    const atMs = Date.now();
    const frame = encodeRecordSessionStateChange({
      tugSessionId: this.tugSessionId,
      atMs,
      phase: next.phase,
      transportState: next.transportState,
      interruptInFlight: next.interruptInFlight,
    });
    this.conn.send(frame.feedId, frame.payload);
    // Local notify for any popover subscribed to this card's
    // state-change log. Same `atMs` as the wire write so the
    // persisted row and the locally-published row carry identical
    // timestamps — important for the popover's dedupe-on-subsequent-
    // reload path.
    publishLocalSessionStateChange({
      tugSessionId: this.tugSessionId,
      atMs,
      phase: next.phase,
      transportState: next.transportState,
      interruptInFlight: next.interruptInFlight,
    });
  }

  private processEffects(effects: Effect[]): void {
    for (const effect of effects) {
      switch (effect.kind) {
        case "write-live-usage":
          // High-frequency display telemetry — a per-path write only its
          // observers (the Tokens / Context cells) see; the transcript
          // list never re-renders for it.
          this.streamingDocument.set(
            LIVE_USAGE_PATH,
            effect.usage,
            STREAM_SOURCE_TAG,
          );
          break;
        case "write-inflight": {
          // Per-Message path `turn.${turnKey}.message.${messageKey}.${channel}`
          // ([D07]). Each Message's path is stable from mint through
          // commit (the cell wrapper subscribing to it survives the
          // inflight → committed transition without a React unmount);
          // each new Message of the same turn writes to its own path
          // so streaming subscriptions don't cross-pollinate.
          const path = `turn.${effect.turnKey}.message.${effect.messageKey}.${effect.channel}`;
          this.streamingDocument.set(path, effect.value, STREAM_SOURCE_TAG);
          break;
        }
        case "clear-inflight":
          // No-op under the per-turn-paths architecture. Each turn
          // writes to its own path; nothing needs clearing at
          // `turn_complete`. Kept as an enum variant so the reducer
          // (which still emits the effect at turn boundaries — see
          // `handleTurnComplete`) doesn't need a coordinated change.
          // If `clear-inflight` outlives its callers, fold the
          // emission out of the reducer too.
          break;
        case "send-frame":
          this.conn.send(
            FeedId.CODE_INPUT,
            encodeCodeInputPayload(effect.msg, this.tugSessionId),
          );
          break;
        case "append-transcript":
          // Copy-on-write so old snapshot refs remain valid for
          // useSyncExternalStore consumers.
          if (effect.prepend === true) {
            // Load-previous bracket: stage older turns (arrival order)
            // for a single front-commit at flush-prepend. Staging keeps
            // the prepended block's order correct and lets the list view
            // observe one structural growth at the front rather than M.
            this._prependStaging.push(effect.entry);
          } else {
            // Append, but keep the turn interleaved with any shell rows the
            // ledger restore ([P07]) seated ahead of it — on a Maker ▸
            // Reload the `list_shell_exchanges` restore can land before the
            // JSONL replay, so a bare append would strand the replayed Claude
            // turn behind shell rows it chronologically precedes. The helper
            // only slides past trailing shell turns; non-shell order is intact.
            // The arriving turn may be the one a restored dash-note row was
            // waiting for — absorb it inside at its clock position ([P12]),
            // so the reload race converges on the live reading whichever
            // side landed first.
            this._transcript = absorbDashNotes(
              appendTurnInterleavingInk(this._transcript, effect.entry),
            );
          }
          break;
        case "ingest-ink-turn":
          // Shell exchange ([P06]/[P12]): upsert the turn — settle in place
          // (same turnKey) or insert at its timestamp position (mint /
          // restore interleave). Copy-on-write, disjoint from the Claude
          // turn lifecycle. A dash-note row whose turn is already committed
          // is then absorbed into it ([P12]) — the other side of the same
          // convergence the `append-transcript` case runs.
          this._transcript = absorbDashNotes(
            upsertInkTurn(this._transcript, effect.entry),
          );
          break;
        case "flush-prepend":
          // Commit the staged older batch ahead of the existing
          // transcript. Copy-on-write; existing `TurnEntry` refs (and
          // their `turnKey`s) are reused, so React preserves the
          // already-mounted rows' identity across the index shift ([L26]).
          if (this._prependStaging.length > 0) {
            // The older bracket may hold the turns that restored dash-note
            // rows were waiting for — the same absorption the append path
            // runs ([P12]), on the block that just became visible.
            this._transcript = absorbDashNotes([
              ...this._prependStaging,
              ...this._transcript,
            ]);
            this._prependStaging = [];
          }
          break;
        case "discard-prepend":
          // Cancelled load-previous: drop the staged older turns; the
          // prior transcript/window is untouched.
          this._prependStaging = [];
          break;
        case "truncate-transcript": {
          // L26-safe local truncation ([#step-7-3]): drop the anchor turn
          // and everything after; survivors keep their `TurnEntry` reference
          // (and thus `turnKey`/`msgId`) so React preserves their mounts. The
          // pure helper returns the SAME array reference when the anchor
          // isn't present, so a stale ack is a true no-op (no snapshot churn).
          const before = this._transcript;
          this._transcript = truncateTranscriptAtAnchor(
            before,
            effect.promptUuid,
          );
          // Row removal is the one structural "mutation" of finalized
          // rows — drop the removed turns' render-once parse entries
          // through the explicit invalidation API. (TurnKeys are
          // UUIDs, never reused, so a missed drop would only be dead
          // weight — this keeps the cache exact anyway.)
          if (this._transcript !== before) {
            const surviving = new Set(this._transcript.map((t) => t.turnKey));
            for (const turn of before) {
              if (!surviving.has(turn.turnKey)) {
                invalidateCachedParsesByPrefix(
                  this.streamingDocument,
                  `turn.${turn.turnKey}.`,
                );
              }
            }
          }
          break;
        }
        case "append-compact-note": {
          // [P04] replay fallback: the `compact_boundary` arrived with no open
          // turn, so seat the divider on the last committed turn (the
          // transcript lives here, not in reducer state — [D04]). Copy-on-write
          // so old snapshot refs stay valid; the note's key is minted from the
          // last turn's `turnKey` + `messages.length` (deterministic, pure,
          // collision-safe). Empty transcript ⇒ no-op.
          if (this._transcript.length > 0) {
            const lastIndex = this._transcript.length - 1;
            const turn = this._transcript[lastIndex];
            const note: SystemNote = {
              kind: "system_note",
              messageKey: systemNoteKey(turn.turnKey, turn.messages.length),
              createdAt: effect.timestamp ?? Date.now(),
              text: effect.text,
              source: "compact",
            };
            const nextTranscript = [...this._transcript];
            nextTranscript[lastIndex] = {
              ...turn,
              messages: [...turn.messages, note],
              // Replay honest-total stamp (H1, Spec S03): the divider seats on
              // this last surviving turn, so "window after this turn = the
              // post-compaction total" is exactly honest. `deriveContextWindows`
              // reads it as `window(N)` even with no post-compaction turn. On
              // the live path the scratch stamp already set it, so the effect
              // omits it and this leaves the committed value untouched.
              ...(typeof effect.compactionPostTotal === "number"
                ? { compactionPostTotal: effect.compactionPostTotal }
                : {}),
            };
            this._transcript = nextTranscript;
          }
          break;
        }
        case "append-stage-note": {
          // The arc rotated at idle, so there is no open turn: seat the stage
          // divider on the last committed turn, copy-on-write, with a key
          // minted from that turn's `turnKey` + `messages.length`. Same shape
          // as `append-compact-note` above; empty transcript ⇒ no-op.
          if (this._transcript.length > 0) {
            const lastIndex = this._transcript.length - 1;
            const turn = this._transcript[lastIndex];
            const note: SystemNote = {
              kind: "system_note",
              messageKey: systemNoteKey(turn.turnKey, turn.messages.length),
              createdAt: Date.now(),
              text: effect.text,
              source: "stage",
            };
            const nextTranscript = [...this._transcript];
            nextTranscript[lastIndex] = {
              ...turn,
              messages: [...turn.messages, note],
            };
            this._transcript = nextTranscript;
          }
          break;
        }
        case "schedule_timer": {
          // Re-entry on the same name cancels the prior timer first
          // so neither callback can race with the new one.
          const prior = this._replayTimers.get(effect.name);
          if (prior !== undefined) {
            this.timerSource.clearTimeout(prior);
          }
          const fire = effect.fire;
          const name = effect.name;
          const handle = this.timerSource.setTimeout(() => {
            this._replayTimers.delete(name);
            if (this._disposed) return;
            this.dispatch(fire);
          }, effect.ms);
          this._replayTimers.set(effect.name, handle);
          break;
        }
        case "cancel_timer": {
          const handle = this._replayTimers.get(effect.name);
          if (handle !== undefined) {
            this.timerSource.clearTimeout(handle);
            this._replayTimers.delete(effect.name);
          }
          break;
        }
        case "record-telemetry": {
          // Fire-and-forget CONTROL frame to the supervisor. Persists
          // the per-turn telemetry block in the sqlite SessionLedger
          // so the next resume can inline it onto the replayed
          // `turn_complete`. The supervisor doesn't ack; the
          // reducer's TurnEntry is already committed locally — the
          // wire write is purely "remember this for the next reload."
          const frame = encodeRecordTurnTelemetry({
            tugSessionId: this.tugSessionId,
            msgId: effect.msgId,
            telemetry: effect.telemetry,
            endedAt: effect.endedAt,
          });
          this.conn.send(frame.feedId, frame.payload);
          break;
        }
        case "record-context-breakdown": {
          // Fire-and-forget CONTROL frame to the supervisor. Persists
          // the `/context`-style breakdown blob in the sqlite
          // `context_breakdown_latest` table so the next bind can
          // re-emit it as a synthetic `context_breakdown` frame
          // before any new live frame lands. Idempotent on
          // `tug_session_id` via UPSERT — repeat writes overwrite.
          const frame = encodeRecordContextBreakdown({
            tugSessionId: this.tugSessionId,
            payload: effect.payload,
            capturedAt: effect.capturedAt,
          });
          this.conn.send(frame.feedId, frame.payload);
          break;
        }
      }
    }
  }

  /**
   * Publish a question from outside the turn stream, or clear it with `null`.
   *
   * Bypasses the reducer on purpose: an ask arrives over `/api/ask` rather than
   * the session's wire, carries no turn, and must not disturb the phase
   * machine. The publication is immediate rather than coalesced — there is
   * exactly one of these per invocation of some command-line tool, and someone
   * is blocked on the other end of it.
   */
  setPendingAsk(ask: PendingAsk | null): void {
    if (this._pendingAsk === ask) return;
    this._pendingAsk = ask;
    this._cachedSnapshot = null;
    this.notifyListeners();
  }

  private notifyListeners(): void {
    for (const listener of this._listeners.slice()) {
      listener();
    }
  }
}
