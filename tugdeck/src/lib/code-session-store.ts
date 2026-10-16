/**
 * CodeSessionStore — per-Session-card L02 store for a single
 * `tug_session_id`'s Claude Code turn state, as a mirror.
 *
 * The session is reduced elsewhere: its `SessionEngine` runs in an ingest
 * host, routes the session's CODE_OUTPUT / SESSION_STATE / CONTROL frames,
 * runs the reducer and its effects, and posts patches. This store applies
 * them — field-level structure patches merged into its own state and
 * transcript, so everything a patch does not name keeps its identity, and
 * stream writes into the `PropertyStore` that `TugMarkdownView` reads — and
 * publishes to React once per batch the host posts: the host paces its
 * batches to the display period, so a streaming burst costs React one render
 * per frame, and a replay fold keeps the snapshot pinned until it flushes.
 * Local actions are assembled here, where the page's stores are, and posted
 * to the engine as finished events, each with a sequence number the engine
 * acknowledges; {@link CodeSessionStore.whenSettled} is how a reader that
 * needs the result of its own action waits for it ([P09]).
 *
 * [D01] store owns its session's engine
 * [D02] card owns CONTROL lifecycle
 * [D03] three-identifier model
 * [D04] transcript + streaming
 * [D09] metadata store independent
 * [D11] effect-list reducer
 */

import {
  FeedId,
  encodeCodeInputPayload,
  encodeRequestReplay,
  DEFAULT_REPLAY_WINDOW_TURNS,
} from "@/protocol";
import type { EditorView } from "@codemirror/view";
import type { PermissionMode } from "@tugproto/inbound";
import type { TugConnection } from "@/connection";
import type { ConnectionLifecycle } from "@/lib/connection-lifecycle";
import { PropertyStore } from "@/lib/property-store";
import { Subscribable } from "@/lib/subscribable";
import { RunProgressStore, type RunProgressFrame } from "@/lib/run-progress-store";
import { RoutedFrameStore } from "@/lib/ingest/routed-frame-store";
import type { AtomSegment } from "./tug-atom-img";
import { TUG_ATOM_CHAR } from "./tug-atom-char";
import { hasLeadingCommandAtom } from "./command-atom";
import type { PendingContextStore } from "./pending-context-store";
import {
  createAtomBytesStore,
  type AtomBytesStore,
} from "./atom-bytes-store";
import { buildWirePayload } from "./build-wire-payload";
import { sessionCitationStore } from "./session-citation-store";
import { sessionVerdictAskKey } from "./session-atom";
import type { SessionRefVerdict } from "./session-ref-block";
import { putImageBytes, synthesizeUserMessageFromBlocks } from "./synthesize-user-message";
import {
  createInitialState,
  deriveActiveTurnSnapshot,
  type CodeSessionState,
} from "./code-session-store/reducer";
import {
  LIVE_USAGE_PATH,
  mintTurnKey,
  type LiveTurnPerf,
  type ReplayIngestPerf,
  type TimerSource,
} from "./code-session-store/session-engine";
import { logSessionLifecycle } from "./session-lifecycle-log";
import { getDigestStore } from "./digest-store";
import {
  networkPathStore,
  type NetworkPathStatus,
} from "./network-path-store";
import {
  clearCachedParses,
  invalidateCachedParsesByPrefix,
} from "./markdown/parse-cache";
import { isRenderedRecord, mergeRenderedMessage } from "./ingest/rendered-merge";
import { tugDevLogStore } from "./tug-dev-log-store/tug-dev-log-store";
import { installDevLogSink } from "./dev-log-port";
import { pathResolutionStore } from "./annotator/path-resolution";
import type {
  CodeSessionEvent,
  RefsResultActionEvent,
  SendCondition,
} from "./code-session-store/events";
import {
  publishLocalSessionStateChange,
  type LocalSessionStateChange,
} from "./session-state-changes-local-events";
import {
  openInProcessSession,
  type SessionFindRequest,
  type SessionLink,
  type SessionOpener,
} from "./ingest/session-link";
import type { FindResultFrame } from "@tugproto/rendered";
import type { FlushPolicyFactory } from "./ingest/ingest-host";
import {
  applyTranscriptSplices,
  type SessionMeta,
  type SessionPatchOf,
  type SessionPatchTarget,
  type SessionTranscriptSplice,
} from "./ingest/session-patch";
import type {
  CardSessionMode,
  CodeSessionSnapshot,
  InterruptReason,
  LiveMessageUsage,
  PendingAsk,
  TurnEntry,
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
  BRACKET_FRAME_TYPES,
  INTERRUPT_SILENCE_DEADLINE_MS,
  INTERRUPT_STALLED_MESSAGE,
  REPLAY_BRACKET_DEADLINE_MS,
  REPLAY_BRACKET_MESSAGE,
  REPLAY_PREFLIGHT_TIMEOUT_MS,
  REPLAY_SHADOW_DEADLINE_MS,
  REPLAY_SILENCE_DEADLINE_MS,
  REPLAY_SOFT_BUDGET_MS,
  REPLAY_STALLED_MESSAGE,
  REPLAY_TIMEOUT_DWELL_MS,
} from "./code-session-store/reducer";

export {
  KNOWN_CODE_OUTPUT_TYPES,
  REPLAY_FOLD_FLUSH_THRESHOLD,
  REWIND_ANCHOR_OUTSIDE_WINDOW,
  UNWRAPPED_CODE_OUTPUT_TYPES,
} from "./code-session-store/session-engine";

export type {
  LiveTurnPerf,
  ReplayIngestPerf,
  TimerSource,
} from "./code-session-store/session-engine";

// The session engine and the reducer log through the dev-log port. On the
// page both halves go to the stores they always went to, each looked up at
// call time so a test that reassigns a level still sees the call.
installDevLogSink({
  log: (level, source, message, data) => tugDevLogStore[level](source, message, data),
  lifecycle: (tag, fields) => logSessionLifecycle(tag, fields),
});

const STREAM_SOURCE_TAG = "code-session-store";

/**
 * How long a find waits on tugcast's answer before its units are projected on
 * the page instead.
 */
export const FIND_FINISHER_MS = 1500;

/**
 * The longest any reader waits on the ingest host's acknowledgment of what
 * this store posted ([L33]). It is the teardown's budget: sized to contain
 * tugcode's own interrupt ladder with margin, so a live host always answers
 * inside it, and a host that has stopped answering is waited on no longer.
 */
export const SETTLE_WAIT_BUDGET_MS = 5000;

/** The engine's perf records, as of its last post. */
interface MirrorPerf {
  replay: ReplayIngestPerf | null;
  lastReplay: ReplayIngestPerf | null;
  liveTurn: LiveTurnPerf | null;
  lastLiveTurn: LiveTurnPerf | null;
}

const NO_PERF: MirrorPerf = { replay: null, lastReplay: null, liveTurn: null, lastLiveTurn: null };

/**
 * What the client knows about one session atom, for the trailing reference
 * block — read from the store, never asked here.
 *
 * The key is {@link sessionVerdictAskKey}'s, which is the whole point of that
 * function existing: answers are filed under the spelling the ASKER used, and
 * a reader spelling it differently would find nothing and stamp every
 * reference `unverified`.
 *
 * The mapping is written whole: a verdict the block can say is a verdict the
 * map must carry, so no answer the store holds can reach the block as a
 * silent `unverified`.
 */
function sessionAtomVerdict(atom: AtomSegment): {
  verdict: SessionRefVerdict;
  sessionId?: string;
  projectDir?: string;
} {
  const answer = sessionCitationStore.getAnswer(sessionVerdictAskKey(atom));
  if (answer.status === "found") {
    return {
      verdict: "here",
      sessionId: answer.sessionId,
      projectDir: answer.projectDir,
    };
  }
  if (answer.status === "elsewhere") {
    return {
      verdict: "elsewhere",
      sessionId: answer.sessionId,
      projectDir: answer.projectDir,
    };
  }
  // `unknown` is the ledger's word that no such session exists; `pending` is
  // this client not having heard back. They are different facts and the block
  // says so — "not on this machine" is actionable, "not answered yet" names
  // the command that answers it.
  return { verdict: answer.status === "unknown" ? "absent" : "unverified" };
}

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
   * Context turns the transcript holds before an append evicts the oldest
   * into the load-previous window. Defaults to {@link TRANSCRIPT_TURN_CAP};
   * tests pass a small one. A {@link restoreWindowTurns} deeper than the cap
   * raises the limit to it, so a faithful restore keeps its anchor.
   */
  transcriptTurnCap?: number;
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
  /**
   * Test seam — when the session's host posts its batches. Omitted, an
   * engine on this thread posts at the end of every message, so a frame has
   * reached the mirror by the time it returns; a test that reads the
   * per-period cadence passes a `Pacer` on a manual clock. Like
   * {@link timerSource} it is a function, so a store that passes it gets an
   * engine on this thread.
   */
  makeFlushPolicy?: FlushPolicyFactory;
}

/**
 * L02 external store for a single Claude Code session's turn state.
 * See module JSDoc for scope and phasing.
 */
export class CodeSessionStore extends Subscribable {
  readonly streamingDocument: PropertyStore;
  /**
   * Live progress for running tool calls — the engine's `tool_progress`
   * heartbeat and the command's own `run_progress` reports. Diverted out of
   * the frame stream before the reducer, because neither is part of the
   * session's record and a heartbeat a second must not rebuild the snapshot.
   * The session engine diverts them; its `progress` patches land here.
   */
  readonly runProgress = new RunProgressStore();

  /**
   * The narrow per-session stores' frames, one store per routed CODE_OUTPUT
   * type ([P14]). The ingest host routes a `/skills` or `/hooks` response or
   * a `/btw` answer to this session's mirror, and the mirror hands it to the
   * store for its type; the page never reads CODE_OUTPUT itself.
   */
  private readonly _routedFrames = new Map<string, RoutedFrameStore>();

  private readonly conn: TugConnection;
  private readonly lifecycle: ConnectionLifecycle;
  private readonly tugSessionId: string;
  private readonly displayLabel: string;
  private readonly sessionMode: CardSessionMode;
  private readonly restoreWindowTurns: number;
  private readonly pendingContextStore: PendingContextStore | undefined;
  /** The line to this session's engine, which reduces every frame and action. */
  private readonly _link: SessionLink;
  /** Where the engine's patches land; identity-stable for the store's life. */
  private readonly _patchTarget: SessionPatchTarget = {
    stream: (patch) => this.applyStream(patch),
    structure: (patch) => this.applyStructure(patch),
    progress: (patch) => this.applyProgress(patch),
    effect: (patch) => this.applyEffect(patch),
    ack: (patch) => this.applyAck(patch),
    routedFrame: (patch) => this.routedFrames(patch.payload.type).accept(patch.payload.feedId, patch.payload.decoded),
    rendered: (patch) => this.applyRendered(patch),
    findResult: (patch) => this.applyFindResult(patch),
    endOfBatch: () => this.endOfBatch(),
  };

  /**
   * Per-card bytes side-table for inline image attachments. One
   * instance is created at construction and survives until `dispose`;
   * the drop / paste handlers in the embedded text editor populate
   * it, the wire-flattening at submit-time reads from it, and the
   * `useCardStatePreservation` snapshot round-trips its contents
   * across cold boot / pane restore. A replayed message's images arrive
   * as the engine's `atom-bytes` effect.
   *
   * Exposed via {@link getAtomBytesStore} so non-React consumers
   * (the drop / paste extensions inside CodeMirror) can reach it
   * through a thunk read at fire time ([L07]). Per
   * [D03](arc/dev-atoms.md#d03-atom-bytes-store).
   */
  private readonly atomBytesStore: AtomBytesStore;

  /** The session's state, as of the engine's last structure patch. */
  private state: CodeSessionState;
  /** The transcript, as of the engine's last structure patch. */
  private _transcript: ReadonlyArray<TurnEntry> = [];
  // Load-previous progress as the engine reports it: the turns the load
  // asked for, and the older turns staged so far.
  private _loadPreviousTarget = 0;
  private _prependStagingCount = 0;
  private _cachedSnapshot: CodeSessionSnapshot | null = null;

  /**
   * A question from outside the turn stream, waiting on the human. Set by the
   * pending-ask store rather than the reducer — it arrives over `/api/ask`, not
   * over the session's wire, and belongs to no turn.
   */
  private _pendingAsk: PendingAsk | null = null;
  /**
   * The last `user_message` the engine put on the wire, kept for
   * {@link _lastSentUserMessageForTest} and read by nothing else.
   */
  private _lastSentUserMessage: unknown = null;
  private _disposed = false;
  /** The last find request's number, for minting the next id. */
  private _findSeq = 0;
  /** Each find waiting on tugcast, by request id. */
  private readonly _pendingFinds = new Map<
    string,
    { resolve: (answer: FindResultFrame | null) => void; timer: ReturnType<typeof setTimeout> }
  >();
  /** Set by {@link holdSendsForHandOver}; every later send queues. */
  private _sendsHeldForHandOver = false;
  /** Set by `bindEditorView`; outside `state`, so it notifies nobody. */
  private _editorView: (() => EditorView | null) | null = null;
  /**
   * Aggregated unsubscribe callbacks for every `ConnectionLifecycle`
   * channel the store observes. Currently `connectionDidClose` (Step 1b)
   * and `connectionDidReconnect` (Step 5). Held as an array so adding
   * future channels is a one-line append at construction and a
   * one-line iteration at dispose; no chance of forgetting one.
   */
  private _lifecycleUnsubs: Array<() => void> = [];
  /** Unsubscribe from the host's path hint; cleared at dispose. */
  private _pathUnsub: (() => void) | null = null;
  /**
   * The last path status this store saw, so the release fires on the
   * *transition* into `satisfied` and not on every repeat report of it.
   */
  private _lastPathStatus: NetworkPathStatus | null = null;
  /** The highest action sequence number the engine has acknowledged. */
  private _ackedSeq = 0;
  /** The highest sequence number this store has posted. */
  private _postedSeq = 0;
  /**
   * The seq of a `bind_resume_acknowledged` the engine has not acknowledged
   * yet, while the page holds the preflight beat it opens; 0 when none is
   * outstanding. See {@link notifyResumeBindingLanded}.
   */
  private _preflightBridgeSeq = 0;
  /** Readers waiting on an acknowledgment, each with the seq it waits for. */
  private _settleWaiters: Array<{ seq: number; resolve: () => void }> = [];
  /**
   * The `File` lists this store parked, oldest first, until the engine's
   * structure patch for each arrives. A `File` crosses to the engine as a
   * structured clone, but the prompt entry decodes the bytes of the objects
   * the drop produced, so the slot it reads carries these.
   */
  private readonly _parkedFiles: File[][] = [];

  /**
   * Perf instrumentation — pure observability, no behavior. The counters
   * run in the engine; the commits are this store's own notifies, counted
   * against the window that was open when the engine published.
   */
  private _perf: MirrorPerf = NO_PERF;
  private _replayCommits = 0;
  private _lastReplayCommits = 0;
  private _liveCommits = 0;
  private _lastLiveCommits = 0;

  /**
   * Whether a publishing structure patch has been applied in the batch now
   * being applied. The batch's end notifies once for all of them, so a
   * streaming burst costs React one render per batch — one per display
   * period, as the host paces them — and every session's render lands in
   * the same task. The host's timer, not the page's frames, sets the
   * cadence, so an occluded window's background-card transcripts keep
   * moving.
   */
  private _notifyPending = false;
  /** The perf as it stood before this batch's first structure patch. */
  private _batchPerf: MirrorPerf | null = null;

  /**
   * Streamed text is not a publish ([L22]): a delta that only grew a
   * Message's text leaves the snapshot pinned and tells nobody through
   * `subscribe`, because the `PropertyStore` already carries the text to the
   * blocks that paint it. A reader that genuinely follows the text as a whole
   * — the open find bar's index — observes this signal instead: a version
   * that moves once per batch while text streams.
   */
  private _streamTextVersion = 0;
  private _streamTextPending = false;
  private readonly _streamTextListeners = new Set<() => void>();

  /** Subscribe to streamed-text growth, signalled once per batch. */
  observeStreamText = (listener: () => void): (() => void) => {
    this._streamTextListeners.add(listener);
    return () => {
      this._streamTextListeners.delete(listener);
    };
  };

  /** The streamed-text version {@link observeStreamText} moves. */
  getStreamTextVersion = (): number => this._streamTextVersion;

  constructor(options: CodeSessionStoreOptions) {
    super();
    this.conn = options.conn;
    this.lifecycle = options.lifecycle;
    this.tugSessionId = options.tugSessionId;
    this.displayLabel = options.displayLabel ?? options.tugSessionId.slice(0, 8);
    this.restoreWindowTurns =
      options.restoreWindowTurns ?? DEFAULT_REPLAY_WINDOW_TURNS;
    this.sessionMode = options.sessionMode;
    this.pendingContextStore = options.pendingContextStore;

    // Per-card bytes side-table — populated at drop / paste, drained
    // at `clear()` on dispose. Snapshot rides
    // `useCardStatePreservation` so attachment bytes survive cold
    // boot and pane restore alongside the rest of the prompt-entry
    // draft. Per [D03](arc/dev-atoms.md#d03-atom-bytes-store).
    this.atomBytesStore = createAtomBytesStore();

    // The streaming document holds per-turn streaming paths only,
    // shaped `turn.${turnKey}.${channel}` (assistant / thinking /
    // tools). Each turn writes to its own path; every committed
    // turn's cell keeps observing the same path forever (no
    // overwrites).
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

    // The engine starts from the same initial state, so its first
    // structure patch diffs against what this mirror already holds.
    this.state = createInitialState(
      this.tugSessionId,
      this.displayLabel,
      this.sessionMode,
    );

    // Open the session's engine. A connection that hosts engines opens it
    // there; a frame source that offers no opener — a test's fake — gets an
    // in-process host fed by its own frames. Either way a frame the source
    // replays on subscribe reaches the engine, and its patches this store,
    // before the constructor returns.
    const open = {
      tugSessionId: this.tugSessionId,
      displayLabel: this.displayLabel,
      sessionMode: this.sessionMode,
      restoreWindowTurns: this.restoreWindowTurns,
      ...(options.transcriptTurnCap !== undefined
        ? { transcriptTurnCap: options.transcriptTurnCap }
        : {}),
    };
    const local = { timerSource: options.timerSource, makePolicy: options.makeFlushPolicy };
    const opener = options.conn as Partial<SessionOpener>;
    this._link =
      typeof opener.openSession === "function"
        ? opener.openSession(open, this._patchTarget, local)
        : openInProcessSession(options.conn, open, this._patchTarget, local);

    // Lifecycle wiring per [D07]: `ConnectionLifecycle` is the action
    // source, the reducer is the responder. The store subscribes once
    // at construction and translates the two lifecycle events that
    // matter to its session:
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
        this.runProgress.clear();
        this.dispatch({ type: "transport_close" });
      }),
    );
    this._lifecycleUnsubs.push(
      this.lifecycle.observeConnectionDidReconnect(() => {
        if (this._disposed) return;
        this.dispatch({ type: "transport_open" });
      }),
    );

    // The host's path hint ([P10]), watched for the one transition that does
    // anything: into `satisfied`, which releases a prompt held for the
    // network. A repeated report of the same status is not a transition and
    // dispatches nothing, and nothing here asks at an interval ([P11]) — the
    // host pushes, this listens.
    //
    // The seed is the status standing at construction, so a store built while
    // the path was already satisfied does not read its first notification as
    // a transition into it.
    this._lastPathStatus = networkPathStore.getSnapshot().status;
    this._pathUnsub = networkPathStore.subscribe(() => {
      if (this._disposed) return;
      const status = networkPathStore.getSnapshot().status;
      const prev = this._lastPathStatus;
      this._lastPathStatus = status;
      if (status === "satisfied" && prev !== "satisfied") {
        this.dispatch({ type: "network_path_satisfied" });
      }
    });
  }

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
   * decode through the tag's decoder, then `dispatch`. The app-test harness
   * drives a session card through the lifecycle matrix with this;
   * production frames always arrive through the `FeedStore`
   * subscription, never here.
   *
   * `feedId` is a `FeedId` value (`CODE_OUTPUT` / `SESSION_STATE` /
   * `CONTROL`); `decoded` is the already-decoded frame payload, with
   * a `tug_session_id` matching this store's session. A frame whose
   * `type` is not reducer-relevant is a no-op, and one whose shape has
   * drifted from its decoder is logged and dropped.
   *
   * @internal — reached only through the DEV-gated `window.__tug` test
   *  surface; not part of the public L02 contract.
   */
  _ingestFrameForTest = (feedId: number, decoded: unknown): void => {
    if (this._disposed) return;
    this._postedSeq = this._link.testFrame(feedId, decoded);
  };

  /**
   * Test-only. The content blocks of the last `user_message` this store put
   * on the wire, or `null` when it has sent none.
   *
   * It exists because the wire payload is the one artifact of a submission
   * that nothing downstream keeps: the reducer turns it into a `send-frame`
   * effect and the transcript row is built from the SYNTHESIZED substrate
   * instead, which is exactly the separation the trailing session-reference
   * block depends on — it rides out to the model and never appears in the
   * transcript. A test with no view of the frame can see one half of that
   * and never the other.
   *
   * @internal — reached only through the DEV-gated `window.__tug` test
   *  surface; not part of the public L02 contract.
   */
  _lastSentUserMessageForTest = (): unknown => this._lastSentUserMessage;

  /**
   * Test-only. How many message ids the reducer's commit dedupe holds — the
   * one reducer set that grows with the session, which the transcript cap
   * holds to the size of the loaded window.
   *
   * @internal — not part of the public L02 contract.
   */
  _committedMsgIdCountForTest = (): number => this.state.committedMsgIds.size;

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
      stopStalled: this.state.stopStalled,
      streamStalled: this.state.streamStalled,
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
      // `arc/tugplan-session-wake.md`: the user can stop a
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
      pendingFileInsert: this.state.pendingFileInsert,
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
      coldRevealSettled: this.state.coldRevealSettled,
      replayWindow: this.state.replayWindow,
      sessionCreatedAtMs: this.state.sessionCreatedAtMs,
      loadingPrevious: this.state.replayPrependActive,
      // Determinate load-previous progress: target turns requested vs
      // turns staged so far. Both 0 when no load is in flight.
      loadingPreviousTarget: this.state.replayPrependActive
        ? this._loadPreviousTarget
        : 0,
      loadingPreviousLoaded: this.state.replayPrependActive
        ? this._prependStagingCount
        : 0,
      replayPreflightActive: this.state.replayPreflightActive || this._preflightBridgeSeq !== 0,
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
    // A fresh submission makes prior digest lines stale for this
    // card — clear its strip; the new turn's lines repopulate it.
    // Suppressed (programmatic) sends are not user submissions.
    if (opts?.suppress !== true) {
      getDigestStore()?.clearScope(this.tugSessionId);
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
    const wire = buildWirePayload(effText, atoms, this.atomBytesStore, {
      sessionVerdict: sessionAtomVerdict,
    });
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
        });
    this.dispatch({
      type: "send",
      text: synth.text,
      atoms: synth.atoms,
      content: wire.content,
      turnKey: mintTurnKey(),
      suppress: opts?.suppress === true,
      queueOnly: this._sendsHeldForHandOver,
      // Read here rather than in the reducer, which is pure and cannot see a
      // module store. Only the believed negative is passed: `unsatisfied`
      // means there is no route and the submission is held ([P10]). The
      // positive reading is not passed at all, because nothing may be gated
      // on it.
      pathUnsatisfied: networkPathStore.getSnapshot().status === "unsatisfied",
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
   * Seat an arc gesture's quiet line ([P12]). Called by `useLandingReceipts`
   * for each fresh arc note the changeset verb store delivers. The reducer
   * decides the seat: inside the open turn's message stream when one is
   * streaming (the note narrates work this turn is doing, and renders between
   * the tool calls it arrived among), or as its own quiet ink row when none
   * is. This is the ONLY live path for an arc note; the restore path replays
   * the same ledger rows through `ingestShellExchange` as `arc …` commands,
   * which the quiet-row registration claims.
   */
  ingestArcNote(event: {
    exchangeId: string;
    command: string;
    text: string;
    cwd: string;
    timestamp: number;
  }): void {
    if (this._disposed) return;
    this.dispatch({ type: "arc_note", ...event });
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
   * [D03](arc/dev-atoms.md#d03-atom-bytes-store).
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
    // The engine reduces this on its own thread, and its beat comes back a
    // batch later, after the card body has already mounted an empty list
    // with nothing saying it is restoring. So the page raises the beat now,
    // under the reducer's own guard, and holds it until the engine
    // acknowledges the action, by when the engine's snapshot carries the
    // beat or its end. An engine on this thread has already answered.
    if (
      this._ackedSeq < this._postedSeq &&
      !this.state.replayPreflightActive &&
      this.state.phase === "idle" &&
      this.state.transportState === "online"
    ) {
      this._preflightBridgeSeq = this._postedSeq;
      this._cachedSnapshot = null;
      this.notify();
    }
  }

  /**
   * System notification: the transcript host's list has raised its first
   * settle after the initial resume replay, or the host's settle bound
   * ran out. The reducer flips the monotonic `coldRevealSettled`, which
   * is what releases `TugRestoreGate`'s hold on this card
   * (`deriveColdRevealPending`). Idempotent; a no-op once settled.
   *
   * Public because the dispatch source is the transcript host, and
   * routing through a named method keeps `dispatch` private, mirroring
   * `notifyTransportSettled()`.
   */
  notifyColdRevealSettled(): void {
    if (this._disposed) return;
    this.dispatch({ type: "cold_reveal_settled" });
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
    if (this._disposed) return;
    this.dispatch({ type: "begin_load_previous", target: turns });
    // The N turns immediately older than the current oldest-loaded turn.
    // `page`: this extends the loaded transcript backward; it is not a reload.
    const frame = encodeRequestReplay(this.tugSessionId, "page", {
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
   * Force Stop — the control an unanswered stop turns the submit button
   * into. Emits `stop_all_work`, which tugcode implements and answers, and
   * which reaches it with no new plumbing: the verb is already in
   * `INBOUND_VERBS`, and tugcast's `dispatch_one` routes CODE_INPUT by
   * session id rather than by verb.
   *
   * A no-op unless `stopStalled` is set — the reducer's guard, not this
   * method's, so every door to the frame runs through the same one.
   */
  forceStop(): void {
    if (this._disposed) return;
    this.dispatch({ type: "force_stop" });
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
    if (job === undefined) return;
    const label = job.scheduleLabel ?? job.description;
    const suffix = label.length > 0 ? ` (${label})` : "";
    this.sendWhen(`Please cancel the scheduled cron \`${jobId}\`${suffix} using CronDelete.`, {
      kind: "scheduled-job",
      jobId,
      jobKind: "cron",
    });
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
    if (job === undefined) return;
    const label = job.scheduleLabel ?? job.description;
    const suffix = label.length > 0 ? ` (${label})` : "";
    this.sendWhen(
      `Please stop the running loop${suffix}: do not act on its next wakeup, ` +
        `and end it with ScheduleWakeup {stop: true} so no further wakeups are scheduled.`,
      { kind: "scheduled-job", jobId, jobKind: "wakeup" },
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
    this.sendWhen("/goal clear", { kind: "goal-clearable" });
  }

  /**
   * A programmatic send whose rightness depends on the session's state —
   * idle, a scheduled job, an active goal. The engine checks `condition`
   * against its own state and drops the send when it fails, because this
   * mirror reads that state a hop behind. It is not the user's submission,
   * so it neither clears the digest strip nor carries staged context: a
   * dropped one must not have spent either.
   */
  private sendWhen(text: string, condition: SendCondition): void {
    const wire = buildWirePayload(text, [], this.atomBytesStore, {
      sessionVerdict: sessionAtomVerdict,
    });
    const synth = synthesizeUserMessageFromBlocks(wire.content, this.atomBytesStore, {
      atomIdAt: wire.atomIdAt,
    });
    this.dispatch({
      type: "send",
      text: synth.text,
      atoms: synth.atoms,
      content: wire.content,
      turnKey: mintTurnKey(),
      queueOnly: this._sendsHeldForHandOver,
      pathUnsatisfied: networkPathStore.getSnapshot().status === "unsatisfied",
      onlyIf: condition,
    });
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
    // A conversation rewind cuts the loaded transcript at its anchor, so the
    // anchor has to be in the window. The sheet only offers loaded turns; an
    // anchor outside the window is refused in the ack's own shape rather
    // than sent, because the server would chop turns the deck cannot cut.
    // Load previous reaches an older turn first. The engine holds the
    // transcript, so it runs that check before it sends.
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
    this.dispatch({ type: "insert_command_draft", name, args, submit: false });
  }

  /**
   * Seed the same command AND send it, as this card's next turn — the
   * menu's Run in This Session. It rides the one slot {@link insertCommandDraft} uses,
   * with `submit` set, so the two cannot be in flight at once and the entry
   * seeds and submits inside a single paint rather than leaving a draft
   * somebody has to press Return on.
   *
   * The seed is what makes it a real turn rather than a side channel: the
   * text the card sends is the text the composer held, so the transcript,
   * the history, and the queue all see exactly what a typed command would
   * have been.
   */
  runCommandDraft(name: string, args: string): void {
    if (this._disposed) return;
    this.dispatch({ type: "insert_command_draft", name, args, submit: true });
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
   * Park a jot's `(text, atoms)` substrate on `pendingJotInsert` for the
   * prompt entry to insert — the atoms travel with the text, so a chip moved
   * from a jot to the prompt is still a chip rather than the placeholder
   * character it stands at.
   *
   * `at` is the drop point in client coordinates (resolved to a
   * document offset), or `null` for append semantics (a click / no point).
   * The entry observes the slot, inserts, and calls
   * {@link consumePendingJotInsert}. Public because the dispatch source is
   * a UI surface (a Cards card drag / double-click), not the reducer.
   */
  insertJot(
    text: string,
    atoms: ReadonlyArray<AtomSegment>,
    at: { x: number; y: number } | null,
  ): void {
    if (this._disposed) return;
    this.dispatch({ type: "insert_jot", text, atoms: [...atoms], at });
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
   * Park dropped files on `pendingFileInsert` for the prompt entry to run
   * through its own attachment pipeline at the caret. Used by the Session
   * card's content-area drop surface, which accepts the gesture but holds
   * neither the `EditorView` nor the bytes store `processAttachmentFiles`
   * needs — so the entry stays the one place that decides what a dropped
   * file becomes. The entry observes the slot, inserts, and calls
   * {@link consumePendingFileInsert}. An empty list is not a gesture and
   * parks nothing.
   */
  insertFiles(files: readonly File[]): void {
    if (this._disposed) return;
    if (files.length === 0) return;
    const parked = [...files];
    this._parkedFiles.push(parked);
    this.dispatch({ type: "insert_files", files: parked });
  }

  /**
   * Clear `pendingFileInsert` once the prompt entry has taken the files.
   * Idempotent — a call while already `null` is a state-ref-stable no-op.
   */
  consumePendingFileInsert(): void {
    if (this._disposed) return;
    this.dispatch({ type: "consume_file_insert" });
  }

  /**
   * Register a thunk reading the prompt entry's live `EditorView`, or `null`
   * on unmount. Called from the entry's editor ref callback ([L03] — a
   * registration an event depends on, made before any paint that could fire
   * one).
   *
   * **A thunk rather than the view.** The entry's view is replaced on remount
   * and is `null` between passes, so a stored view would be detached the first
   * time anything reached for it; a thunk is read at use time and answers
   * honestly.
   *
   * **Outside `state`, and it emits nothing.** Nothing renders from the view's
   * identity, so putting it in the snapshot would re-render every subscriber of
   * this store on a remount that changed nothing anybody draws ([L02]).
   */
  bindEditorView(getter: (() => EditorView | null) | null): void {
    this._editorView = getter;
  }

  /** The prompt entry's live `EditorView`, or `null` when there is none. */
  editorView(): EditorView | null {
    return this._editorView?.() ?? null;
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
    // The engine decides which of the three it is, against its own state:
    // this mirror is a hop behind, so an Escape a frame after Enter would
    // read no queued send and interrupt the turn instead. A stop this session
    // already failed to answer escalates to Force Stop on both doors — the Z5
    // button and Escape ([F04]).
    this.dispatch({ type: "pop_interactive" });
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
   * Stop sending: every later submission is queued instead, for
   * {@link exportQueuedSends} to hand to the store that replaces this one.
   *
   * For a directory change, which keeps this store on screen until the new
   * session's transcript is ready: the session behind this store is already
   * closed, so a send from it would reach nothing. One-way — the store is
   * disposed at the hand-over.
   */
  holdSendsForHandOver(): void {
    this._sendsHeldForHandOver = true;
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
   * Local teardown: close the session's engine, clear listeners, clear
   * queuedSends, clear in-flight streaming paths. Per [L23] the
   * transcript is user-visible state and is NOT cleared. Per [D02] the
   * card owns `close_session` — this method never writes a CONTROL frame.
   */
  dispose(): void {
    if (this._disposed) return;
    // Closing the engine flushes an open replay fold — on this thread the
    // flush arrives before the close returns, so listeners still attached
    // observe the final reduced state in one last snapshot before they're
    // cleared — and cancels every replay-clock timer it holds ([L27]).
    // Nothing it posts after reaches this store.
    this._link.close();
    this._disposed = true;
    this._streamTextPending = false;
    this._notifyPending = false;
    // Nobody waits on an engine that is gone.
    this._ackedSeq = this._postedSeq;
    this.releaseSettleWaiters();
    for (const { resolve, timer } of this._pendingFinds.values()) {
      clearTimeout(timer);
      resolve(null);
    }
    this._pendingFinds.clear();
    for (const unsub of this._lifecycleUnsubs) {
      unsub();
    }
    this._lifecycleUnsubs = [];
    if (this._pathUnsub !== null) {
      this._pathUnsub();
      this._pathUnsub = null;
    }
    this.clearListeners();
    this.state.queuedSends = [];
    // Release any retained attachment bytes; the bytes-store is per-
    // card and has no consumers past dispose.
    this.atomBytesStore.clear();
    for (const store of this._routedFrames.values()) store.dispose();
    this._routedFrames.clear();
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
  // The engine's patches
  // ---------------------------------------------------------------------

  /**
   * A local action. The event is assembled here and reduced by the engine,
   * whose patches come back before this returns when the engine is
   * in-process.
   */
  private dispatch(event: CodeSessionEvent): void {
    if (this._disposed) return;
    this._postedSeq = this._link.action(event);
  }

  /**
   * Whether the engine has acknowledged every action and test frame this
   * store has posted, so the mirror reads what they did. Always true for an
   * engine on this thread, which answers before the post returns.
   */
  isSettled(): boolean {
    return this._ackedSeq >= this._postedSeq;
  }

  /**
   * Resolves once the mirror has applied the engine's acknowledgment of the
   * last action this store posted before the call — at once when nothing is
   * outstanding, and at dispose. A reader that must see what its own action
   * did (the queued sends a hand-over exports, the text a quit stashes)
   * awaits this rather than assuming the reduction already happened ([P09]).
   */
  whenSettled(): Promise<void> {
    if (this.isSettled()) return Promise.resolve();
    return new Promise((resolve) => {
      this._settleWaiters.push({ seq: this._postedSeq, resolve });
    });
  }

  /**
   * {@link whenSettled}, with a horizon: resolves `true` once settled, or
   * `false` once `budgetMs` passes first, so a reader proceeds on the mirror
   * as it stands rather than waiting on a host that has stopped answering.
   */
  whenSettledWithin(budgetMs: number = SETTLE_WAIT_BUDGET_MS): Promise<boolean> {
    if (this.isSettled()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiter = {
        seq: this._postedSeq,
        resolve: () => {
          clearTimeout(timer);
          resolve(true);
        },
      };
      const timer = setTimeout(() => {
        this._settleWaiters = this._settleWaiters.filter((w) => w !== waiter);
        resolve(false);
      }, budgetMs);
      this._settleWaiters.push(waiter);
    });
  }

  /** Resolve every waiter whose seq the engine has acknowledged. */
  private releaseSettleWaiters(): void {
    if (this._settleWaiters.length === 0) return;
    const still: typeof this._settleWaiters = [];
    for (const waiter of this._settleWaiters) {
      if (waiter.seq <= this._ackedSeq) waiter.resolve();
      else still.push(waiter);
    }
    this._settleWaiters = still;
  }

  /** Streamed text and live usage: writes into the streaming document. */
  private applyStream(patch: SessionPatchOf<"stream">): void {
    for (const write of patch.payload.writes) {
      this.streamingDocument.set(write.path, write.value, STREAM_SOURCE_TAG);
    }
    // A delta that only grew text publishes nothing; the readers that
    // follow the text as a whole hear it once, at the batch's end.
    if (patch.payload.textGrew) this._streamTextPending = true;
  }

  /**
   * One structure patch: merge the state fields it names, splice the
   * transcript, take the meta, and mark the batch to publish. An open replay
   * fold posts none, so a snapshot already read stays pinned until the patch
   * that flushes it.
   * Everything the patch does not name keeps its identity ([P05]).
   */
  private applyStructure(patch: SessionPatchOf<"structure">): void {
    const { state, transcript, meta } = patch.payload;
    if (this._batchPerf === null) this._batchPerf = this._perf;
    if (state !== undefined) {
      const next = { ...this.state, ...state };
      if (state.pendingFileInsert != null) {
        next.pendingFileInsert = this._parkedFiles.shift() ?? state.pendingFileInsert;
      }
      this.state = next;
    }
    if (transcript !== undefined) {
      const before = this._transcript;
      this._transcript = applyTranscriptSplices(before, transcript);
      this.dropRemovedTurnParses(before, transcript);
    }
    if (meta !== undefined) this.takeMeta(meta);
    // Reads stay truthful at once — a `getSnapshot` sees the merged
    // state. Only the notification waits for the batch's end.
    this._cachedSnapshot = null;
    this._notifyPending = true;
  }

  /**
   * The batch is applied: notify once if anything in it published, and
   * signal streamed text once if any grew. A perf window the batch closed
   * keeps the commit its own closing post published, and is logged here,
   * with the notifies this store made rather than the posts the engine did.
   */
  private endOfBatch(): void {
    const prevPerf = this._batchPerf ?? this._perf;
    this._batchPerf = null;
    if (this._disposed) return;
    if (this._notifyPending) {
      this._notifyPending = false;
      this._publishAndNotify(prevPerf);
    }
    if (prevPerf.replay !== null && this._perf.replay === null) {
      this._lastReplayCommits = this._replayCommits;
      if (this._perf.lastReplay !== null) this.logReplayIngest(this._perf.lastReplay, this._lastReplayCommits);
    }
    if (prevPerf.liveTurn !== null && this._perf.liveTurn === null) {
      this._lastLiveCommits = this._liveCommits;
      if (this._perf.lastLiveTurn !== null) this.logLiveCommits(this._perf.lastLiveTurn, this._lastLiveCommits);
    }
    if (this._streamTextPending) {
      this._streamTextPending = false;
      this._streamTextVersion += 1;
      for (const listener of [...this._streamTextListeners]) listener();
    }
  }

  /**
   * Drop the render-once parse entries of every turn the splices removed —
   * an eviction by the transcript cap, or a rewind's truncation. A turn
   * replaced by a newer version of itself keeps its key, and its entries.
   * The same turns' rendered records are released with them.
   */
  private dropRemovedTurnParses(
    before: ReadonlyArray<TurnEntry>,
    splices: ReadonlyArray<SessionTranscriptSplice>,
  ): void {
    if (!splices.some((s) => s.deleteCount > 0)) return;
    const surviving = new Set(this._transcript.map((t) => t.turnKey));
    for (const turn of before) {
      if (!surviving.has(turn.turnKey)) {
        invalidateCachedParsesByPrefix(this.streamingDocument, `turn.${turn.turnKey}.`);
        // The `PropertyStore` has no delete; a record's HTML is released by
        // writing `null` over it, as the parse entry is released above.
        for (const message of turn.messages) {
          if (message.kind !== "assistant_text" && message.kind !== "assistant_thinking") continue;
          const path = `turn.${turn.turnKey}.message.${message.messageKey}.rendered`;
          if (this.streamingDocument.get(path) != null) this.streamingDocument.set(path, null, STREAM_SOURCE_TAG);
        }
      }
    }
  }

  /** Take the engine-owned facts the patch carries. */
  private takeMeta(meta: SessionMeta): void {
    if (meta.loadPreviousTarget !== undefined) this._loadPreviousTarget = meta.loadPreviousTarget;
    if (meta.prependStagingCount !== undefined) this._prependStagingCount = meta.prependStagingCount;
    if ("lastSentUserMessage" in meta) this._lastSentUserMessage = meta.lastSentUserMessage;
    if (meta.perf !== undefined) {
      const prev = this._perf;
      const next = meta.perf as MirrorPerf;
      // A window opened since the last post starts its own count.
      if (next.replay !== null && prev.replay?.startedAtMs !== next.replay.startedAtMs) {
        this._replayCommits = 0;
      }
      if (next.liveTurn !== null && prev.liveTurn?.turnKey !== next.liveTurn.turnKey) {
        this._liveCommits = 0;
      }
      this._perf = next;
    }
  }

  /** A running tool's progress, in batch order. */
  private applyProgress(patch: SessionPatchOf<"progress">): void {
    const op = patch.payload;
    switch (op.op) {
      case "heartbeat":
        this.runProgress.applyHeartbeat(op.toolUseId, op.elapsedSeconds, op.nowMs);
        return;
      case "report":
        this.runProgress.applyReport(op.frame as RunProgressFrame, op.nowMs, () => op.runningJob);
        return;
      case "close":
        this.runProgress.close(op.toolUseId);
        return;
      case "clear":
        this.runProgress.clear();
        return;
    }
  }

  /** What only the page can do for the session. */
  private applyEffect(patch: SessionPatchOf<"effect">): void {
    const effect = patch.payload;
    switch (effect.effect) {
      case "confirm-written-paths":
        // The one write the deck watched happen. The resolver's other two
        // doors — a probe it asked for, a filesystem frame — are reports
        // about somebody else's write and both cost a round trip; this
        // one is already the answer, so it is handed over rather than
        // asked about.
        pathResolutionStore.confirmWritten(effect.paths);
        return;
      case "local-state-change":
        // Local notify for any popover subscribed to this card's
        // state-change log, carrying the `atMs` of the engine's wire write.
        publishLocalSessionStateChange(effect.change as LocalSessionStateChange);
        return;
      case "atom-bytes":
        // A replayed message's images, filed where the card's other
        // attachments are, with their thumbnails baked here.
        for (const bytes of effect.entries) {
          void putImageBytes(this.atomBytesStore, bytes.id, bytes.content, bytes.mediaType);
        }
        return;
    }
  }

  /** The store this session's routed frames of `type` land in; one per type, for the store's life. */
  routedFrames(type: string): RoutedFrameStore {
    let store = this._routedFrames.get(type);
    if (store === undefined) {
      store = new RoutedFrameStore(type);
      this._routedFrames.set(type, store);
    }
    return store;
  }

  private applyAck(patch: SessionPatchOf<"ack">): void {
    this._ackedSeq = Math.max(this._ackedSeq, patch.payload.seq);
    if (this._preflightBridgeSeq !== 0 && this._ackedSeq >= this._preflightBridgeSeq) {
      this._preflightBridgeSeq = 0;
      this._cachedSnapshot = null;
      this._notifyPending = true;
    }
    this.releaseSettleWaiters();
  }

  /**
   * Ask tugcast to answer a find over this session's rendered text: the
   * assistant-text and thinking units it names, in order. Resolves with the
   * answer, or with `null` when none arrives within
   * {@link FIND_FINISHER_MS} or the store is gone, in which case the caller
   * projects those units itself.
   */
  requestFind(request: Omit<SessionFindRequest, "requestId">): Promise<FindResultFrame | null> {
    if (this._disposed) return Promise.resolve(null);
    this._findSeq += 1;
    const requestId = `${this._link.handle}:find:${this._findSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._pendingFinds.delete(requestId);
        resolve(null);
      }, FIND_FINISHER_MS);
      this._pendingFinds.set(requestId, { resolve, timer });
      this._link.find({ ...request, requestId });
    });
  }

  /** tugcast's answer to a find this store asked; a late or unknown one is dropped. */
  private applyFindResult(patch: SessionPatchOf<"find-result">): void {
    const pending = this._pendingFinds.get(patch.payload.requestId);
    if (pending === undefined) return;
    this._pendingFinds.delete(patch.payload.requestId);
    clearTimeout(pending.timer);
    pending.resolve(patch.payload);
  }

  /**
   * tugcast's renders: each Message's `.rendered` path, beside its `.text`.
   * A record merges into the record the path holds, so only new HTML crossed
   * from the Worker; a pending or `null` state replaces it ([P06]).
   */
  private applyRendered(patch: SessionPatchOf<"rendered-blocks">): void {
    for (const { turnKey, messageKey, state } of patch.payload.messages) {
      const path = `turn.${turnKey}.message.${messageKey}.rendered`;
      if (isRenderedRecord(state)) {
        const held = this.streamingDocument.get(path);
        const earlier = isRenderedRecord(held) ? held.message : null;
        this.streamingDocument.set(
          path,
          { ...state, message: mergeRenderedMessage(earlier, state.message) },
          STREAM_SOURCE_TAG,
        );
      } else {
        this.streamingDocument.set(path, state, STREAM_SOURCE_TAG);
      }
    }
  }

  /**
   * Notify listeners once for the batch's publishes. The snapshot was
   * already invalidated where each publish was applied.
   * `prevPerf` is the perf as it stood before the patch being published, so
   * a post that closed a window counts against it.
   */
  private _publishAndNotify(prevPerf: MirrorPerf = this._perf): void {
    this.notify();
    this.countCommit(prevPerf);
  }

  // ---------------------------------------------------------------------
  // Perf instrumentation (pure observability — no behavior)
  // ---------------------------------------------------------------------

  /**
   * Dev-only read accessor over the perf counters: the engine's records,
   * with the commits this store counted. Consumed by the transcript host's
   * `perf.replay_render` emission and by tests; not part of the public L02
   * contract.
   *
   * @internal
   */
  _getPerfForDevPanel = (): {
    replay: ReplayIngestPerf | null;
    lastReplay: ReplayIngestPerf | null;
    liveTurn: LiveTurnPerf | null;
    lastLiveTurn: LiveTurnPerf | null;
  } => {
    const perf = this._perf;
    return {
      replay: perf.replay && { ...perf.replay, commits: this._replayCommits },
      lastReplay: perf.lastReplay && { ...perf.lastReplay, commits: this._lastReplayCommits },
      liveTurn: perf.liveTurn && { ...perf.liveTurn, commits: this._liveCommits },
      lastLiveTurn: perf.lastLiveTurn && { ...perf.lastLiveTurn, commits: this._lastLiveCommits },
    };
  };

  /**
   * Count one notify against the window that was open when the engine
   * published it: a replay window first, then a live turn — including the
   * window the publishing post itself closed.
   */
  private countCommit(prev: MirrorPerf): void {
    const perf = this._perf;
    if (perf.replay !== null || prev.replay !== null) {
      this._replayCommits += 1;
    } else if (perf.liveTurn !== null || prev.liveTurn !== null) {
      this._liveCommits += 1;
    }
  }

  /** `perf.replay_ingest`: one closed replay window, with this store's commits. */
  private logReplayIngest(perf: ReplayIngestPerf, commits: number): void {
    const wallMs = (perf.completedAtMs ?? perf.startedAtMs) - perf.startedAtMs;
    const summary = {
      tug_session_id: this.tugSessionId,
      ms: wallMs,
      frames: perf.frames,
      folds: perf.folds,
      commits,
      // CPU breakdown: dispatchMs is the synchronous work across the
      // window; reduceMs is the pure-reducer slice of it. `ms -
      // dispatchMs` is time spent idle waiting for frames — the share of
      // the load that lives upstream of ingest.
      reduceMs: Math.round(perf.reduceMs),
      dispatchMs: Math.round(perf.dispatchMs),
      waitMs: Math.round(wallMs - perf.dispatchMs),
    };
    logSessionLifecycle("perf.replay_ingest", summary);
    tugDevLogStore.info("perf", "replay_ingest", summary);
  }

  /** `perf.live_commits`: one closed live turn, with this store's commits. */
  private logLiveCommits(turn: LiveTurnPerf, commits: number): void {
    const summary = {
      tug_session_id: this.tugSessionId,
      turnKey: turn.turnKey,
      commits,
      ms: (turn.completedAtMs ?? turn.startedAtMs) - turn.startedAtMs,
    };
    logSessionLifecycle("perf.live_commits", summary);
    tugDevLogStore.info("perf", "live_commits", summary);
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
    this.notify();
  }
}
