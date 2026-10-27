/**
 * `SessionEngine` — one session's reduction, wherever the frames land.
 *
 * Everything `CodeSessionStore` used to do with a frame before React could see
 * it lives here: routing a decoded frame to its reducer event, diverting the
 * progress frames, reducing, running the effects that are not the page's, the
 * transcript cap, the replay and interrupt deadlines, the replay fold, and the
 * session's own wire writes (`send-frame`, telemetry, the context breakdown,
 * and the state-change record). The store that draws the session is a mirror
 * of what this posts.
 *
 * It posts patches, never a snapshot. At each point where the store used to
 * publish, the engine emits a `structure` patch carrying only what changed
 * since its last post: the top-level state fields whose identity moved, the
 * transcript as identity splices, and the engine-owned meta the snapshot
 * reads. So a field nothing touched keeps its identity in the mirror, which
 * is what every selector downstream depends on. Streamed text and live usage
 * go as `stream` writes into the mirror's `PropertyStore`, and a delta that
 * only grew text posts nothing else, exactly as it used to publish nothing.
 * What only the page can do — confirm a written path, tell the state-change
 * log, carry a replayed image's bytes — goes as an `effect` patch, and a
 * running tool's progress as a `progress` patch.
 *
 * It also owns every fact the display rule for tugcast's renders reads
 * ([P06]), held in its `RenderTracker`: the engine tells the tracker each
 * Message text it writes, each dispatch's end, and each batch of renders,
 * and the tracker posts the `rendered-blocks` records.
 *
 * It is born Worker-safe: the import fence walks this module, so nothing it
 * loads may be a main-thread singleton. It logs through `dev-log-port`.
 */

import {
  FeedId,
  encodeCodeInputPayload,
  encodeRecordContextBreakdown,
  encodeRecordSessionStateChange,
  encodeRecordTurnTelemetry,
  encodeRequestReplay,
  type ContentBlock,
} from "@/protocol";
import { isDecodeError } from "@tugproto/decode";
import {
  decodeTagged,
  OUTBOUND_DECODERS,
  type AnyDecodedFrame,
  type DecodedTag,
} from "@tugproto/outbound-decoders";
import { devLog, lifecycleLog } from "@/lib/dev-log-port";
import { createAtomBytesStore, type AtomBytesStore } from "@/lib/atom-bytes-store";
import { synthesizeUserMessageFromBlocks } from "@/lib/synthesize-user-message";
import { isCompactionSummarizeText, splitCompactionSeed } from "@/lib/compaction-request";
import { diffStateFields, diffTranscript, type SessionMeta, type SessionPatch } from "@/lib/ingest/session-patch";
import type { RenderedMessageWire, RenderInput } from "@tugproto/rendered";
import { RenderTracker, type RenderDispatchView, type TimerSource } from "./render-tracker";
export {
  RENDER_FINISHER_MS,
  RENDER_RESYNC_ASKS,
  RENDER_RESYNC_BACKOFF_MS,
  RENDER_RESYNC_MAX_MS,
  type TimerHandle,
  type TimerSource,
} from "./render-tracker";
import type { CardSessionMode } from "@/lib/card-session-binding-store";
import { taskStartedEvent, taskUpdatedEvent, taskProgressEvent } from "./select-jobs";
import {
  createInitialState,
  isTextOnlyChange,
  reduce,
  interruptSilenceEffect,
  replayBracketEffect,
  replaySilenceEffect,
  streamStallCancelEffect,
  truncateTranscriptAtAnchor,
  evictOldestTurns,
  countContextTurns,
  TRANSCRIPT_TURN_CAP,
  upsertInkTurn,
  appendTurnInterleavingInk,
  absorbArcNotes,
  systemNoteKey,
  type CodeSessionState,
} from "./reducer";
import { RELOCATION_BOUNDARY_EVENT } from "./stages";
import type { CodeSessionEvent } from "./events";
import type { Effect } from "./effects";
import { isInkOrigin, type SystemNote, type TurnEntry } from "./types";
import type { ReplayAfterTurn, ReplayWindow } from "@tugproto/inbound";

/** How many of a card's newest turns a catch-up names. */
const CATCH_UP_NAMED_TURNS = 16;

/**
 * What a catch-up names: the msg-ids of the newest turns the card holds,
 * newest first, and how many turns it holds counting from the session's
 * first. Several ids ride so a turn tugcode cannot find by its id — one that
 * committed with no content, under an id the translator minted — does not
 * leave the card unplaced; the count is tugcode's last resort.
 *
 * Only turns are named or counted. An ink entry (a shell exchange, a refs
 * run) is never in the JSONL: its `msgId` is an id the deck minted, and
 * counting it would place the card past turns it never held. An entry
 * carrying such a minted id is passed over whatever its origin says.
 */
export function heldTurnsOf(
  transcript: ReadonlyArray<TurnEntry>,
  firstLoadedTurnIndex: number,
): ReplayAfterTurn {
  const minted = new Set<string>();
  for (const entry of transcript) {
    for (const m of entry.messages) {
      if (m.kind === "refs_result") minted.add(m.runId);
      else if (m.kind === "shell_exchange") minted.add(m.exchangeId);
    }
  }
  const isTurn = (entry: TurnEntry) => !isInkOrigin(entry.origin) && !minted.has(entry.msgId);
  const msgIds: string[] = [];
  let held = 0;
  for (let i = transcript.length - 1; i >= 0; i--) {
    const entry = transcript[i];
    if (!isTurn(entry)) continue;
    held += 1;
    if (entry.msgId !== "" && msgIds.length < CATCH_UP_NAMED_TURNS) msgIds.push(entry.msgId);
  }
  return { msgIds, heldTurns: firstLoadedTurnIndex + held };
}

/** The global timers, looked up at call time. */
export const DEFAULT_TIMER_SOURCE: TimerSource = {
  setTimeout: (cb, ms) =>
    (globalThis as { setTimeout: (cb: () => void, ms: number) => unknown }).setTimeout(cb, ms),
  clearTimeout: (handle) =>
    (globalThis as { clearTimeout: (handle: unknown) => void }).clearTimeout(handle),
};

/**
 * Streaming-document path carrying the latest `streaming_usage` frame —
 * high-frequency display telemetry kept OFF the snapshot so a usage frame
 * re-renders only the status cells observing this path, never the
 * transcript list. Cleared at `activeTurn` boundaries.
 */
export const LIVE_USAGE_PATH = "telemetry.liveTurnUsage";

/**
 * The refusal a conversation rewind gets when its anchor is not in the loaded
 * transcript window — a turn the transcript cap evicted, or one never paged
 * in. Carried in `lastRewindResult.error`, which the rewind sheet shows.
 */
export const REWIND_ANCHOR_OUTSIDE_WINDOW =
  "That message is no longer loaded. Load previous to reach it, then rewind.";

/**
 * Replay-fold flush threshold. While the reducer's `replaying` phase
 * is open, wire-origin events reduce immediately but their structure post
 * (and so the mirror's snapshot publication) is deferred; every
 * `REPLAY_FOLD_FLUSH_THRESHOLD` deferred events the fold flushes one
 * post so a whale-sized replay paints progressively instead of
 * holding the UI to the very end. Flushes are event-driven only —
 * the other triggers are the window closing (`replay_complete` or
 * any phase exit) and session close. No timers, no rAF.
 */
export const REPLAY_FOLD_FLUSH_THRESHOLD = 250;

/**
 * Per-replay-window ingest counters (the `perf.replay_ingest`
 * instrumentation surface). One record is opened on `replay_started`,
 * accumulated per dispatched event / structure post, and closed on
 * `replay_complete`; the mirror logs it when the batch carrying the close
 * lands.
 *
 * `commits` is the number of listener notifications inside the window —
 * the "≤ N commits per replay" assertion surface. The engine counts its own
 * structure posts; the mirror counts the notifies it actually made, which
 * is fewer once several posts share a batch, and that is the number both
 * the logged summary and its dev panel report. `folds` counts
 * buffered-fold flushes.
 */
export interface ReplayIngestPerf {
  startedAtMs: number;
  completedAtMs: number | null;
  /** Reducer-relevant events dispatched inside the window. */
  frames: number;
  /** Buffered-fold flushes. */
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
   * effects + persist + publish — summed across every frame
   * (ms). Compare against the window's wall span (`completedAtMs -
   * startedAtMs`): if `dispatchMs` is much smaller, the engine spent
   * the window *waiting for frames to arrive*, not processing them —
   * the cost lives upstream in emit/transport, not in ingest.
   */
  dispatchMs: number;
}

/**
 * Per-live-turn commit counters (the `perf.live_commits` surface).
 * Opened on `send`, closed on the matching `turn_complete`, and logged by
 * the mirror as `ReplayIngestPerf` is.
 */
export interface LiveTurnPerf {
  turnKey: string;
  startedAtMs: number;
  completedAtMs: number | null;
  /** Listener notifications between send and turn_complete. */
  commits: number;
}

/**
 * Mint a stable per-turn key. Used as the React-key seed for the
 * inflight cell pair and preserved unchanged through commit into
 * `TurnEntry.turnKey`. Lives outside the reducer because
 * `crypto.randomUUID()` is impure and the reducer is contractually pure +
 * time-independent.
 *
 * Fallback `turn-${time}-${random}` shape covers runtimes without
 * `crypto.randomUUID` — uniqueness is per-session, not global.
 *
 * The fallback is not a UUID, so tugcode's `isSubmissionId` withholds it
 * from claude and the submission is matched by tugcast's minted id
 * instead. That is correct but silent, so the first fallback says so.
 */
export function mintTurnKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  if (!warnedTurnKeyFallback) {
    warnedTurnKeyFallback = true;
    console.warn("mintTurnKey: no crypto.randomUUID; turn keys will not ride to claude as submission ids");
  }
  return `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

let warnedTurnKeyFallback = false;

/**
 * CODE_OUTPUT tags the engine takes apart before admission. Each has a
 * decoder, and none reaches the reducer as itself: `routeFrame` unwraps a
 * `replay_batch` and routes its frames one by one, and `divertProgress`
 * sends the two progress frames to the mirror's `ReportStore`.
 */
export const UNWRAPPED_CODE_OUTPUT_TYPES: ReadonlySet<string> = new Set<DecodedTag>([
  "replay_batch",
  "tool_progress",
  "report",
]);

/**
 * CODE_OUTPUT frame `type` values the reducer admits: every tag in the
 * decoder table (`@tugproto/outbound-decoders`) that the engine does not
 * take apart first. What each one means to the reducer is written at its
 * case in `SessionEngine.wireToEvent`.
 */
export const KNOWN_CODE_OUTPUT_TYPES: ReadonlySet<string> = new Set(
  (Object.keys(OUTBOUND_DECODERS) as DecodedTag[]).filter(
    (tag) => !UNWRAPPED_CODE_OUTPUT_TYPES.has(tag),
  ),
);

/**
 * Decode a CODE_OUTPUT value by its own tag. A value whose tag the decoder
 * table does not know is dropped silently, as an unknown tag always was. A
 * frame whose tag has a decoder and whose shape has drifted is dropped with
 * one line naming the tag, the path, what was expected and what arrived, so
 * an upstream drift reads as a decode error here and never reaches the
 * reducer as the wrong shape.
 */
function decodeCodeOutput(value: unknown): AnyDecodedFrame | null {
  const frame = decodeTagged(value);
  if (isDecodeError(frame)) {
    devLog.warn("code-session-store", `CODE_OUTPUT decode error: ${frame.toString()}`, {
      tag: frame.tag,
      path: frame.path,
      expected: frame.expected,
      got: frame.got,
    });
    return null;
  }
  return frame;
}

/**
 * tugcast's `tug_session_id` stamp, which no decoder declares and every
 * decoded frame carries through untouched.
 */
export function stampedSessionId(frame: unknown): string | undefined {
  if (frame === null || typeof frame !== "object") return undefined;
  const id = (frame as { tug_session_id?: unknown }).tug_session_id;
  return typeof id === "string" ? id : undefined;
}

/** Replayed images get their thumbnails on the page; the engine bakes none. */
const NO_BAKE = (): Promise<string | null> => Promise.resolve(null);

/** What an engine needs from the host it runs in. */
export interface SessionEngineHost {
  /** Send one frame on the wire, on the session's behalf. */
  send(feedId: number, payload: Uint8Array): void;
  /** Append one patch to the pending batch. */
  emit(patch: SessionPatch): void;
  /** Send one `RENDER_INPUT` control, at the deck's protocol version. */
  sendRenderControl(control: RenderInput): void;
  /**
   * Whether tugcast has said, on the current socket, that it renders at a
   * version this deck reads. Until it has, a live Message mints no pending
   * state and its row parses its own text.
   */
  tugcastRenders(): boolean;
}

export interface SessionEngineOptions {
  /** The open's handle; every patch names it ([P06]). */
  readonly handle: string;
  readonly tugSessionId: string;
  readonly displayLabel: string;
  readonly sessionMode: CardSessionMode;
  /** Committed turns this resume requested; see `CodeSessionStoreOptions`. */
  readonly restoreWindowTurns: number;
  /** Context turns the transcript holds before evicting; defaults to the cap. */
  readonly transcriptTurnCap?: number;
  /** The replay clock's timers. */
  readonly timerSource: TimerSource;
}

/** What one dispatch publishes, in the store's old vocabulary. */
type Publish = "none" | "text" | "fold" | "tick" | "sync";

const PUBLISH_RANK: Record<Publish, number> = { none: 0, text: 1, fold: 2, tick: 3, sync: 4 };

export class SessionEngine {
  readonly handle: string;
  readonly tugSessionId: string;
  private readonly host: SessionEngineHost;
  private readonly timerSource: TimerSource;

  private state: CodeSessionState;
  private _transcript: ReadonlyArray<TurnEntry> = [];
  // Older turns staged by a load-previous (prepend) replay bracket, in
  // arrival order. `flush-prepend` commits this batch to the FRONT of
  // `_transcript` at the bracket's `replay_complete`, then clears it.
  private _prependStaging: TurnEntry[] = [];
  // Target turn count of the in-flight load-previous (0 when none), for the
  // load sheet's determinate progress. The loaded-so-far value is
  // `_prependStaging.length`.
  private _loadPreviousTarget = 0;
  // Context turns `_transcript` may hold before the oldest are evicted.
  // Starts at the cap, or at the restore window when that is deeper, and
  // only rises: a load-previous that pages in past it raises it to what the
  // user asked to see, so the window keeps what they paged in and slides by
  // one per later turn rather than snapping back.
  private _transcriptTurnLimit: number;
  // True from a conversation rewind's send until its `rewind_result` ack (or
  // a transport close). The cap holds off meanwhile, so the anchor the ack
  // truncates at cannot be evicted out from under it.
  private _conversationRewindInFlight = false;
  /**
   * Active replay-clock timers keyed by their effect `name`
   * (`"preflight"`, `"soft_budget"`, `"timeout_dwell"`, …). Populated by
   * `schedule_timer` effects from the reducer; cleared by `cancel_timer`
   * effects, by the timer's own callback after it dispatches the named tick
   * event, and by `close()`.
   */
  private readonly _replayTimers: Map<string, unknown> = new Map();
  /**
   * Replay-fold deferred-post count. Non-zero while the `replaying` phase
   * has reduced wire events whose structure post has not flushed yet. The
   * fold is post-deferral only: every event still reduces and processes its
   * effects immediately, so the reducer's semantics are byte-identical to
   * per-frame dispatch. A folded event posts no structure at all; the flush
   * diffs once against what was last posted, so the mirror receives one
   * structure patch per flush, sized to what changed across the fold rather
   * than to the number of events in it ([L02]).
   */
  private _foldPending = 0;
  /** The last `user_message` this session put on the wire, for the test witness. */
  private _lastSentUserMessage: unknown = null;
  /**
   * The last value written to {@link LIVE_USAGE_PATH}. The turn-boundary
   * clear used to read the streaming document, which lives on the page; this
   * shadow is what the engine wrote there.
   */
  private _liveUsage: unknown = null;
  /** Bytes the replay path's synthesizer writes, carried to the page and cleared. */
  private readonly _replayBytes: AtomBytesStore = createAtomBytesStore();
  private _closed = false;

  // Perf instrumentation — pure observability, no behavior.
  private _perfReplay: ReplayIngestPerf | null = null;
  private _perfLastReplay: ReplayIngestPerf | null = null;
  private _perfLiveTurn: LiveTurnPerf | null = null;
  private _perfLastLiveTurn: LiveTurnPerf | null = null;
  private _perfDirty = false;
  /** Set when a closing window already counted this dispatch's post. */
  private _commitCounted = false;

  // What was last posted, which every structure patch is diffed against.
  private _postedState: CodeSessionState;
  private _postedTranscript: ReadonlyArray<TurnEntry> = [];
  private _postedLoadPreviousTarget = 0;
  private _postedPrependStagingCount = 0;
  private _postedLastSentUserMessage: unknown = null;

  // The current dispatch's stream writes and publish class.
  private _writes: { path: string; value: unknown }[] = [];
  private _publish: Publish = "none";

  /** Every fact the display rule for tugcast's renders reads ([P06]). */
  private readonly _renderTracker: RenderTracker;

  constructor(options: SessionEngineOptions, host: SessionEngineHost) {
    this.handle = options.handle;
    this.tugSessionId = options.tugSessionId;
    this.host = host;
    this.timerSource = options.timerSource;
    this._renderTracker = new RenderTracker({
      timerSource: this.timerSource,
      post: (messages) => this.host.emit({ kind: "rendered-blocks", session: this.handle, payload: { messages } }),
      askWhole: (messageKey) =>
        this.host.sendRenderControl({ kind: "resync", tugSessionId: this.tugSessionId, messageKey }),
      tugcastRenders: () => this.host.tugcastRenders(),
    });
    // A faithful restore deeper than the cap asked to see its saved anchor;
    // the window holds what it restores, as it holds what load previous adds.
    this._transcriptTurnLimit = Math.max(
      options.transcriptTurnCap ?? TRANSCRIPT_TURN_CAP,
      options.restoreWindowTurns,
    );
    this.state = createInitialState(options.tugSessionId, options.displayLabel, options.sessionMode);
    // The mirror builds the same initial state, so the first post diffs
    // against this one.
    this._postedState = this.state;
  }

  // ---------------------------------------------------------------------
  // What the host calls
  // ---------------------------------------------------------------------

  /**
   * Route one decoded feed value into the reducer, as a wire event. The host
   * has already matched its `tug_session_id`; a test frame skips that match
   * and arrives here the same way.
   *
   * A CODE_OUTPUT value is decoded by its tag first ({@link decodeCodeOutput}),
   * and one that does not decode goes no further. A `replay_batch` is a
   * transport-only envelope: its `frames` are decoded and admitted one by one,
   * exactly as a per-frame replay would be, so one drifted frame drops alone
   * and the reducer never sees the batch. Inner frames dispatch post-filter
   * and need no `tug_session_id` of their own.
   */
  frame(feedId: number, value: unknown): void {
    if (this._closed) return;
    if (feedId !== FeedId.CODE_OUTPUT) {
      const event = this.frameToEvent(feedId, value);
      if (event !== null) this.dispatch(event, "wire");
      return;
    }
    const frame = decodeCodeOutput(value);
    if (frame?.type === "replay_batch") {
      for (const inner of frame.frames) this.admitWireFrame(decodeCodeOutput(inner));
      return;
    }
    this.admitWireFrame(frame);
  }

  /**
   * A local action the page assembled. Two carry a fact only the engine can
   * act on: a conversation rewind is checked against the engine's own
   * transcript before it is sent, and a load-previous names how many turns
   * it asked for.
   */
  action(event: CodeSessionEvent): void {
    if (this._closed) return;
    if (event.type === "session_rewind_request") {
      this.rewind(event);
      return;
    }
    if (event.type === "begin_load_previous" && event.target !== undefined) {
      this._loadPreviousTarget = event.target;
    }
    if (event.type === "begin_catch_up") {
      this.catchUp(event);
      return;
    }
    this.dispatch(event);
  }

  /**
   * A dormant body's catch-up: the reveal's ask, sent only when the reducer
   * takes it — read from the reduction just run, which is the state, rather
   * than from a page mirror that can trail it. A reveal inside the catch-up's
   * own bracket is refused there, and nothing is sent. A card that slept
   * inside a bracket asks for that bracket's window again; any other asks for
   * what follows the turns it holds ({@link heldTurnsOf}).
   */
  private catchUp(event: Extract<CodeSessionEvent, { type: "begin_catch_up" }>): void {
    const open = this.state.phase === "replaying" ? this.state.catchUp.openWindow : null;
    this.dispatch(event);
    if (!this.state.catchUp.asks.some((ask) => ask.id === event.askId)) return;
    const window: ReplayWindow = open ?? {
      afterTurn: heldTurnsOf(this._transcript, this.state.replayWindow?.firstLoadedTurnIndex ?? 0),
    };
    this.dispatch({ type: "replay_asked", window });
    const frame = encodeRequestReplay(this.tugSessionId, "catch-up", window, event.askId);
    this.host.send(frame.feedId, frame.payload);
  }

  /**
   * The session is closing: flush an open replay fold, so nothing is ever
   * stranded, and cancel every timer ([L27]).
   */
  close(): void {
    if (this._closed) return;
    if (this._foldPending > 0) {
      this._publish = "sync";
      this.endDispatch();
    }
    this._closed = true;
    for (const handle of this._replayTimers.values()) {
      this.timerSource.clearTimeout(handle);
    }
    this._replayTimers.clear();
    this._renderTracker.close();
  }

  // ---------------------------------------------------------------------
  // Admission
  // ---------------------------------------------------------------------

  /** Divert a decoded CODE_OUTPUT frame's progress meaning, then dispatch its event. */
  private admitWireFrame(frame: AnyDecodedFrame | null): void {
    if (frame === null || this.divertProgress(frame)) return;
    const event = this.wireToEvent(frame);
    if (event !== null) this.dispatch(event, "wire");
  }

  /**
   * Send a CODE_OUTPUT frame's live-progress meaning to the mirror's
   * `ReportStore`. Returns true for the two progress frames, which the
   * reducer never sees; a `tool_result` also closes its call there, and still
   * goes on to the reducer.
   */
  private divertProgress(frame: AnyDecodedFrame): boolean {
    switch (frame.type) {
      case "tool_progress":
        this.progress({
          op: "heartbeat",
          toolUseId: frame.tool_use_id,
          elapsedSeconds: frame.elapsed_time_seconds,
          nowMs: Date.now(),
        });
        return true;
      case "report": {
        const id = frame.tool_use_id;
        this.progress({
          op: "report",
          frame,
          nowMs: Date.now(),
          // Whether the call is a running background job, which keeps its
          // reports coming after its tool_result closed the call.
          runningJob:
            id !== null && this.state.jobs.some((j) => j.toolUseId === id && j.status === "running"),
        });
        return true;
      }
      case "tool_result":
        this.progress({ op: "close", toolUseId: frame.tool_use_id });
        return false;
      default:
        return false;
    }
  }

  private progress(payload: Extract<SessionPatch, { kind: "progress" }>["payload"]): void {
    this.host.emit({ kind: "progress", session: this.handle, payload });
  }

  /**
   * The reducer event a decoded CODE_OUTPUT frame becomes, or null for a
   * frame the reducer has nothing to do with. Most frames are their own
   * event; the rest are renamed to camelCase here, or carry a value only
   * this impure wrapper can supply (a minted `turnKey`, a wall-clock
   * deadline), so the reducer stays pure.
   */
  private wireToEvent(frame: AnyDecodedFrame): CodeSessionEvent | null {
    switch (frame.type) {
      case "session_init": {
        // Divergence check: log loudly if claude's session_id differs
        // from our tugSessionId. Tugdeck operates on a single id
        // (tugSessionId, decided by the picker); a divergence here
        // would be a tugcast/tugcode bug that broke the post-Phase-B
        // invariant. The store does not consume claude's id for any
        // user-facing purpose — see reducer.handleSessionInit.
        const claudeSid = frame.session_id ?? null;
        lifecycleLog("code_store.session_init_recv", {
          tug_session_id: this.tugSessionId,
          claude_session_id: claudeSid,
          divergent: claudeSid !== null && claudeSid !== this.tugSessionId,
        });
        return frame;
      }
      case "content_block_start":
      case "assistant_text":
      case "thinking_text":
      case "tool_use":
      case "tool_result":
      case "tool_use_structured":
      case "turn_complete":
      case "system_metadata":
      case "control_request_forward":
      case "cost_update":
      case "context_breakdown":
      case "error":
        return frame;
      case "turn_cancelled":
        // The cancel receipt: tugcode closes an interrupted turn with this
        // rather than `turn_complete` whenever the turn ended with
        // `ActiveTurn.interrupted` set — the escalation ladder that
        // force-terminates a wedged claude, the drain's EOF path, and
        // `stop_all_work`. The reducer commits the turn as interrupted and
        // clears the per-interrupt flags; `is_recovery: true` marks a cancel
        // tugcode performed to recover a wedged claude, which commits the
        // same way but is not badged as a stop the user asked for. The field
        // names stay the wire's: there is no turnKey to mint and no deadline
        // to compute, so nothing to normalize toward.
        return {
          type: "turn_cancelled",
          msg_id: frame.msg_id,
          seq: frame.seq,
          partial_result: frame.partial_result,
          ...(frame.is_recovery === true ? { is_recovery: true } : {}),
        };
      case "interrupt_noop":
        // The receipt for an interrupt that found nothing to interrupt —
        // tugcode's `handleInterrupt` reached a card with no claude process
        // (`no_process`) or a live claude with no turn open (`no_turn`).
        // The reducer clears the per-interrupt flags, and under `no_turn`
        // commits any turn the deck still holds, since nothing else can.
        return { type: "interrupt_noop", reason: frame.reason };
      case "stop_all_work_done":
        // tugcode's answer to `stop_all_work` — the group was swept and its
        // respawn acked. Emitted on its failure paths too, which is exactly
        // why the deck listens: it is the belt to `turn_cancelled`'s
        // braces, so a teardown that half-worked still settles a card
        // offering Force Stop.
        return frame;
      case "api_retry":
        // Claude's SDK is backing off and retrying a retryable API failure.
        // Display-only: the reducer folds it into `apiRetry`, no phase
        // change. The wire carries `retry_delay_ms` (a duration); the banner
        // wants an absolute `deadline` to count down toward, stamped here so
        // the reducer stays time-free.
        return {
          type: "api_retry",
          attempt: frame.attempt,
          maxRetries: frame.max_retries,
          deadline: Date.now() + frame.retry_delay_ms,
          error: frame.error,
          errorStatus: frame.error_status,
        };
      case "model_refusal_fallback":
        // A model declined and the SDK retried on a fallback model
        // (non-fatal). Display-only: the reducer folds it into
        // `refusalFallback`, no phase change.
        return {
          type: "model_refusal_fallback",
          originalModel: frame.original_model,
          fallbackModel: frame.fallback_model,
        };
      case "output_truncated":
        // An assistant message closed on `max_tokens`. Display-only: the
        // reducer flips `outputTruncated`, no phase change.
        return { type: "output_truncated" };
      case "goal_feedback":
        // `/goal` evaluator feedback — the Stop-hook evaluator judged the
        // goal condition unmet mid-cycle. The reducer folds it into `goal`
        // (round count + latest reason); no phase change, no transcript ink.
        return {
          type: "goal_feedback",
          condition: frame.condition,
          reason: frame.reason,
        };
      case "compact_boundary":
        // Claude compacted its context (auto-compaction at capacity, or a
        // native `/compact`). The reducer appends a compaction `system_note`
        // divider to the active turn (or the last committed turn on replay).
        // Every field is optional: claude omits `compactMetadata` on some
        // boundaries.
        return {
          type: "compact_boundary",
          ...(frame.trigger !== undefined ? { trigger: frame.trigger } : {}),
          ...(frame.pre_tokens !== undefined ? { preTokens: frame.pre_tokens } : {}),
          ...(frame.post_tokens !== undefined ? { postTokens: frame.post_tokens } : {}),
          ...(frame.timestamp !== undefined ? { timestamp: frame.timestamp } : {}),
        };
      case "compact_summary":
        // The compaction summary text, emitted right after
        // `compact_boundary` on both the live and replay paths. The reducer
        // folds it into `compactionSeed` so the carry-forward block
        // restores; no phase change, no transcript ink.
        return { type: "compact_summary", summary: frame.summary };
      case "session_segment":
        // tugcode announced that the card's live claude session id changed,
        // and how. Only `kind: "rotation"` — the server seating the next
        // stage of an arc — reaches the reducer, as its `session_stage`
        // event: a stage divider so the arc reads as one scroll, and the
        // wheel's turn opened from the prompt the frame echoes. Every other
        // kind is the bridge's identity record and draws nothing. Only the
        // display fields cross: the session ids belong to the bridge's
        // identity transfer, not to the divider.
        if (frame.kind !== "rotation") return null;
        return {
          type: "session_stage",
          stage: frame.stage ?? "",
          model: frame.model ?? "",
          document: frame.document ?? "",
          arc: frame.arc ?? "",
          ...(frame.steps !== undefined && frame.steps.length > 0
            ? { steps: frame.steps }
            : {}),
          // The turn key is minted here because the reducer is pure.
          ...(frame.prompt !== undefined && frame.prompt.length > 0
            ? { prompt: frame.prompt, turnKey: mintTurnKey() }
            : {}),
        };
      case "replay_stage":
        // The same boundary, replayed: tugcode emits this between the
        // JSONLs of an arc's stages during a lineage restore. A replayed
        // rotation is only a divider — the identity transfer it names
        // already happened.
        return {
          type: "session_stage",
          stage: frame.stage,
          model: frame.model,
          document: frame.document,
          arc: frame.arc,
        };
      case "replay_relocation":
        // Where, in a replay, the card changed its project directory: after
        // the history carried from the old directory and before the first
        // turn said in the new one. Only a divider.
        return {
          type: "session_relocation",
          fromDir: frame.from_dir,
          toDir: frame.to_dir,
        };
      case "unknown_event":
        // tugcode's forward-compat catch-all: claude streamed a top-level
        // event type this build doesn't translate. The reducer folds it
        // into `unknownEvent`, driving a soft warn banner, and stamps `at`
        // itself.
        return {
          type: "unknown_event",
          originalType: frame.original_type,
          payloadHexPreview: frame.payload_hex_preview,
        };
      case "streaming_usage":
        // Live intra-turn token usage — high-frequency telemetry published
        // to the streaming document's live-usage path (never the snapshot);
        // no phase change, no persist.
        return frame;
      case "resume_failed":
        // tugcode emits this after a failed `--resume` spawn. The reducer
        // rolls it into `lastError`.
        lifecycleLog("code_store.resume_failed_recv", {
          tug_session_id: this.tugSessionId,
          stale_session_id: frame.stale_session_id,
          reason: frame.reason,
        });
        return frame;
      case "replay_started":
      case "replay_complete":
        // Replay bracket events emitted by the JSONL replay translator. The
        // reducer transitions into / out of the `replaying` phase on these
        // and populates `lastReplayResult` on completion.
        return frame;
      case "request_replay_dropped":
        // tugcode dropped a named ask that reached it while a replay ran; the
        // reducer lets the ask go as it does tugcast's CONTROL notice of a
        // queue drop.
        return { type: "request_replay_dropped", askId: frame.ask_id };
      case "add_user_message":
        return this.addUserMessageEvent(frame);
      case "wake_started":
      case "assistant_opener":
      case "tug_notice":
        // Turn openers with no user message. `wake_started` opens a wake
        // bracket when claude resumes from idle on an async trigger
        // (Monitor / CronCreate / ScheduleWakeup / …); `assistant_opener`
        // opens an assistant-only turn for orphan assistant content
        // (`tuglaws/turn-metric.md` S02); `tug_notice` is tugcast's opener
        // beside a turn Tug injected itself, so no server-initiated turn
        // arrives with no visible cause. The `turnKey` is a React-key seed
        // with no meaning on the wire, minted here so the reducer stays
        // pure.
        return { ...frame, turnKey: mintTurnKey() };
      case "task_started":
        // Background-job lifecycle frames (the JOBS cell's feed — unrelated
        // to the TaskCreate/TaskUpdate tool calls behind TASKS), folded into
        // the session-lifetime jobs ledger. An empty id is refused by the
        // mapping and the frame dropped.
        return taskStartedEvent(frame) ?? null;
      case "task_updated":
        return taskUpdatedEvent(frame) ?? null;
      case "task_progress":
        // In-flight ticks for a backgrounded agent: the reducer folds the
        // latest tick's tool and usage onto the running job row, and never
        // inserts one.
        return taskProgressEvent(frame) ?? null;
      case "prompt_anchor":
      case "rewind_preview_result":
      case "rewind_result":
        // `/rewind` frames. `prompt_anchor` carries the live turn's rewind
        // anchor (the reducer stamps it onto the turn);
        // `rewind_preview_result` carries a per-turn diff-stat (folded into
        // the preview cache); `rewind_result` is the applied-rewind ack.
        return frame;
      case "replay_batch":
      case "tool_progress":
      case "report":
        // Taken apart before admission (`UNWRAPPED_CODE_OUTPUT_TYPES`).
        return null;
    }
  }

  /**
   * Per-turn synthetic user-message frame, emitted by the replay translator
   * at the start of each replayed turn and by tugcode's mid-turn snapshot
   * path. The reducer's `handleAddUserMessage` mints a `pendingTurn` whose
   * `initialMessages` is `[user_message]`, so the following
   * `turn_complete` commits a `TurnEntry` with the historical submission.
   */
  private addUserMessageEvent(
    frame: Extract<AnyDecodedFrame, { type: "add_user_message" }>,
  ): CodeSessionEvent {
    // `turnKey` is a client-side React-key seed minted for every dispatched
    // replay event. The wire doesn't (and shouldn't) carry it — replay is a
    // synthesis of historical user submissions, and the cell wrapper
    // identity is purely React's concern. Minting here keeps the reducer
    // pure.
    //
    // The wire's `content` blocks (Anthropic API shape, carried verbatim
    // through tugcast / tugcode) are walked through
    // `synthesizeUserMessageFromBlocks` to produce the substrate
    // `(text, atoms)` pair. No resolver — replay path mints fresh atom ids.
    // The bytes the synthesizer files for each image block belong in the
    // card's bytes store, which lives on the page, so they go there as an
    // `atom-bytes` effect, ahead of the structure that draws them; the page
    // bakes their thumbnails.
    const rawContent: ContentBlock[] = frame.content;
    // A `/compact`-born first message carries the recap as a marked
    // leading content block (it rode the wire with the user's text).
    // Split it off the *raw* content before synthesis so the recap never
    // passes through `synthesizeUserMessageFromBlocks` (which parses
    // `@`-mention markers): the bubble is the residual user content, the
    // recap re-marks `compactionSeed` so the carry-forward summary renders
    // on reload exactly as live.
    const lead = rawContent[0];
    const leadText = lead !== undefined && lead.type === "text" ? lead.text : "";
    const seedSummary = leadText !== "" ? splitCompactionSeed(leadText) : null;
    // A canceled `/compact` leaves its throwaway summarization turn in the
    // discarded session's JSONL (claude persisted it; the client's
    // `suppress` never crossed the wire). Recognize it on reload and mark
    // the turn suppressed so it is dropped, not committed.
    const suppressedTurn = leadText !== "" && isCompactionSummarizeText(leadText);
    const content = seedSummary !== null ? rawContent.slice(1) : rawContent;
    const synth = synthesizeUserMessageFromBlocks(content, this._replayBytes, { bakeImage: NO_BAKE });
    this.carryReplayBytes(synth.atoms);
    return {
      type: "add_user_message",
      text: synth.text,
      atoms: synth.atoms,
      tug_session_id: stampedSessionId(frame),
      turnKey: mintTurnKey(),
      timestamp: frame.timestamp,
      // `/rewind` anchor on the replay / mid-turn-snapshot path; the
      // reducer stamps it onto the turn.
      promptUuid:
        frame.promptUuid !== undefined && frame.promptUuid.length > 0
          ? frame.promptUuid
          : undefined,
      // Who authored the submission, as tugcode's translator stated it on
      // the one frame it identified as a stage's opening prompt.
      origin: frame.origin === "wheel" ? "wheel" : undefined,
      ...(frame.inflightSnapshot === true ? { inflightSnapshot: true } : {}),
      ...(frame.submissionId !== undefined && frame.submissionId.length > 0
        ? { submissionId: frame.submissionId }
        : {}),
      ...(seedSummary !== null ? { compactionSummary: seedSummary } : {}),
      ...(suppressedTurn ? { suppressedTurn: true } : {}),
    };
  }

  /** Send the page the bytes the synthesizer filed for these atoms, then forget them. */
  private carryReplayBytes(atoms: ReadonlyArray<{ type: string; id?: string }>): void {
    const entries: { id: string; content: string; mediaType: string }[] = [];
    for (const atom of atoms) {
      if (atom.type !== "image" || atom.id === undefined) continue;
      const entry = this._replayBytes.get(atom.id);
      if (entry !== null) entries.push({ id: atom.id, content: entry.content, mediaType: entry.mediaType });
    }
    this._replayBytes.clear();
    if (entries.length === 0) return;
    this.host.emit({ kind: "effect", session: this.handle, payload: { effect: "atom-bytes", entries } });
  }

  private frameToEvent(feedId: number, decoded: unknown): CodeSessionEvent | null {
    if (feedId === FeedId.SESSION_STATE) {
      // SESSION_STATE payload shape is `{ tug_session_id, state, detail }`.
      // `errored`, `spawning` and `live` map to reducer events; the other
      // states (`pending`, `closed`, …) are dropped.
      const ss = decoded as { state?: string; detail?: string };
      if (ss.state === "spawning" || ss.state === "live") {
        return { type: "session_spawn_state", state: ss.state };
      }
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
      // `action-dispatch.ts` or never reached this session. The two error
      // details we recognize are `session_unknown` (supervisor orphan
      // dispatcher) and `session_not_owned` (router P5 authz reject).
      const ce = decoded as { type?: string; detail?: string };
      // And one notice of tugcast's own: a catch-up's ask it dropped from the
      // session's queue unanswered.
      if (ce.type === "request_replay_dropped") {
        const askId = (decoded as { ask_id?: unknown }).ask_id;
        return typeof askId === "string" ? { type: "request_replay_dropped", askId } : null;
      }
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

  /**
   * A conversation rewind cuts the loaded transcript at its anchor, so the
   * anchor has to be in the window. The sheet only offers loaded turns; an
   * anchor outside the window is refused in the ack's own shape rather than
   * sent, because the server would chop turns the deck cannot cut. Load
   * previous reaches an older turn first.
   */
  private rewind(event: Extract<CodeSessionEvent, { type: "session_rewind_request" }>): void {
    if (
      event.scope !== "code" &&
      !this._transcript.some((turn) => turn.promptUuid === event.promptUuid)
    ) {
      this.dispatch({
        type: "rewind_result",
        promptUuid: event.promptUuid,
        scope: event.scope,
        canRewind: false,
        error: REWIND_ANCHOR_OUTSIDE_WINDOW,
      });
      return;
    }
    if (event.scope !== "code") this._conversationRewindInFlight = true;
    this.dispatch(event);
  }

  // ---------------------------------------------------------------------
  // The dispatch pipeline
  // ---------------------------------------------------------------------

  /**
   * Hold the transcript at its turn limit. When the window holds more
   * context turns than the limit, the oldest leave `_transcript` (the mirror
   * drops their render-once parse entries when its splice removes them), and
   * the reducer advances the recency window past them and forgets their ids —
   * so they read as older turns the load-previous door pages back in, as on a
   * partially restored session.
   * Never mid-bracket: a replay's turns land first and are held to the
   * limit once it closes, and a load-previous bracket only ever raises it.
   */
  private enforceTranscriptCap(): void {
    if (
      this.state.phase === "replaying" ||
      this.state.replayPrependActive ||
      this._conversationRewindInFlight
    ) {
      return;
    }
    const { transcript, evicted, windowTurns } = evictOldestTurns(
      this._transcript,
      this._transcriptTurnLimit,
    );
    if (evicted.length === 0) return;
    this._transcript = transcript;
    this.state = reduce(this.state, {
      type: "transcript_evicted",
      evicted: evicted.length,
      evictedMsgIds: evicted.flatMap((turn) => (turn.msgId ? [turn.msgId] : [])),
      windowTurns,
    }).state;
  }

  private dispatch(event: CodeSessionEvent, origin: "wire" | "local" = "local"): void {
    this._perfBeforeReduce(event);
    if (event.type === "rewind_result" || event.type === "transport_close") {
      this._conversationRewindInFlight = false;
    }
    const prev = this.state;
    const dispatchStart = performance.now();
    const reduced = reduce(this.state, event);
    const effects = reduced.effects;
    const reduceMs = performance.now() - dispatchStart;
    this.state = reduced.state;
    const transcriptBefore = this._transcript;
    this.processEffects(effects);
    // The transcript cap runs only when the effects moved the transcript or
    // a replay bracket closed over the turns it held back, so a token delta
    // never pays for a count of the window.
    if (
      this._transcript !== transcriptBefore ||
      (prev.phase === "replaying" && this.state.phase !== "replaying")
    ) {
      this.enforceTranscriptCap();
    }
    const state = this.state;
    // The two replay deadlines, both armed here rather than in the
    // reducer: the silence one because only the wrapper knows an event's
    // origin, and the bracket cap because arming and cancelling it are
    // one rule about a phase transition, and splitting them would leave
    // the cancel to be remembered at every exit. Both run after
    // `processEffects`, so the engine's own ingest work on a large
    // `replay_batch` never counts against either.
    //
    // Silence restarts on a bracket-borne wire frame only ([P05]);
    // the cap is armed once per bracket and never re-armed ([P04]).
    const silence = replaySilenceEffect(prev.phase, state.phase, origin === "wire", event.type);
    if (silence !== null) this.processEffects([silence]);
    const bracket = replayBracketEffect(prev.phase, state.phase);
    if (bracket !== null) this.processEffects([bracket]);
    // The interrupt deadline, on the same terms and for the same reason:
    // its life is the `interruptInFlight` flag's, and a rule written once
    // here cannot be forgotten at one of the fourteen returns that clear
    // the flag.
    const interrupt = interruptSilenceEffect(prev.interruptInFlight, state.interruptInFlight);
    if (interrupt !== null) this.processEffects([interrupt]);
    // The stall timer's cancel half, on the same terms again. Its *arm* is
    // emitted by the four handlers that fold a live stream event, because
    // only they know an event arrived; its cancel is a transition on the
    // phase, because the endings that matter are the ones where no further
    // stream event ever comes.
    const stall = streamStallCancelEffect(prev.phase, state.phase);
    if (stall !== null) this.processEffects([stall]);
    this.maybePersistStateChange(prev, state);
    // Turn boundary (send or commit): the live usage path clears so the
    // status cells never read a stale frame across turns — the old
    // in-state lifecycle (`reset at send / superseded at commit`),
    // preserved here now that usage rides the streaming document instead
    // of the snapshot.
    if (
      prev.pendingTurn !== state.pendingTurn &&
      (prev.pendingTurn === null || state.pendingTurn === null) &&
      this._liveUsage != null
    ) {
      this.write(LIVE_USAGE_PATH, null);
      this._liveUsage = null;
    }
    // `write-live-usage` is fine-grained by design — its observers ride
    // the streaming document, so the effect alone must not tick the
    // whole-store snapshot.
    const notifyWorthy = prev !== state || effects.some((e) => e.kind !== "write-live-usage");
    if (notifyWorthy) {
      // Replay fold ([P03]): while the reducer's `replaying` phase is
      // open, WIRE events defer their structure post — the mirror's
      // snapshot stays pinned — so React observes one tick per flush
      // instead of one per frame. Deferral is wire-only: local actions,
      // timer ticks (the soft-budget banner), and transport events
      // publish immediately so mid-window UI stays truthful.
      // `replay_started` itself publishes so the replay paint gate mounts;
      // any event that exits the phase (`replay_complete`, an error path)
      // lands in the else-branch and flushes everything pending in its own
      // post.
      const defer = origin === "wire" && state.phase === "replaying" && event.type !== "replay_started";
      if (defer) {
        this._foldPending += 1;
        this.publish(this._foldPending >= REPLAY_FOLD_FLUSH_THRESHOLD ? "sync" : "fold");
      } else if (
        origin === "wire" &&
        prev.phase === state.phase &&
        (event.type === "assistant_text" || event.type === "thinking_text")
      ) {
        // Live streaming firehose. A delta that only grew text publishes
        // nothing: the mirror's snapshot stays pinned, and the text reaches
        // the DOM through the `PropertyStore` write the reducer's
        // `write-inflight` effect produced ([L22]) — a token costs React no
        // commit. A delta that also moved something a reader draws (a
        // cleared stall or retry, a released held send, a minted Message)
        // publishes like everything else: the mirror notifies once per
        // batch, and the host posts one batch per display period, so a
        // burst costs React one render per frame however many deltas it
        // carried.
        this.publish(isTextOnlyChange(prev, state) ? "text" : "tick");
      } else {
        this.publish("sync");
      }
    }
    if (this._perfReplay !== null) {
      this._perfReplay.reduceMs += reduceMs;
      this._perfReplay.dispatchMs += performance.now() - dispatchStart;
      this._perfDirty = true;
    }
    this._perfAfterDispatch(event);
    this._renderTracker.afterDispatch(this.renderView());
    this.endDispatch();
  }

  /** Raise this dispatch's publish class. */
  private publish(kind: Publish): void {
    if (PUBLISH_RANK[kind] > PUBLISH_RANK[this._publish]) this._publish = kind;
  }

  /** Queue a write into the mirror's streaming document. */
  private write(path: string, value: unknown): void {
    this._writes.push({ path, value });
  }

  /**
   * Post what this dispatch produced: its stream writes, then — when it
   * published — one structure patch carrying everything that changed since
   * the last post.
   */
  private endDispatch(): void {
    const publish = this._publish;
    const writes = this._writes;
    this._publish = "none";
    this._writes = [];
    const counted = this._commitCounted;
    this._commitCounted = false;
    if (writes.length > 0 || publish === "text") {
      this.host.emit({
        kind: "stream",
        session: this.handle,
        payload: { writes, textGrew: publish === "text" },
      });
    }
    // A same-phase delta publishes as any other post does; it was never a
    // commit the engine counts, so it does not count here either.
    // A folded event posts nothing: the flush that closes the fold diffs
    // everything it reduced against the posted baseline at once.
    if (publish === "tick") this.postStructure(true);
    else if (publish === "sync") this.postStructure(counted);
  }

  /**
   * One structure patch: the state fields, transcript splices and meta that
   * moved since the last post. It publishes, and it closes any open fold.
   */
  private postStructure(counted = false): void {
    const state = diffStateFields(this._postedState, this.state);
    const transcript = diffTranscript(this._postedTranscript, this._transcript);
    const meta = this.metaDiff();
    this._postedState = this.state;
    this._postedTranscript = this._transcript;
    if (this._foldPending > 0 && this._perfReplay !== null) {
      this._perfReplay.folds += 1;
      this._perfDirty = true;
    }
    this._foldPending = 0;
    if (!counted) this._perfOnCommit();
    this.host.emit({
      kind: "structure",
      session: this.handle,
      payload: {
        ...(state !== null ? { state } : {}),
        ...(transcript !== null ? { transcript } : {}),
        ...(meta !== null ? { meta } : {}),
      },
    });
  }

  /** The engine-owned facts the snapshot reads, where they moved since the last post. */
  private metaDiff(): SessionMeta | null {
    const meta: SessionMeta = {};
    let moved = false;
    if (this._loadPreviousTarget !== this._postedLoadPreviousTarget) {
      meta.loadPreviousTarget = this._postedLoadPreviousTarget = this._loadPreviousTarget;
      moved = true;
    }
    if (this._prependStaging.length !== this._postedPrependStagingCount) {
      meta.prependStagingCount = this._postedPrependStagingCount = this._prependStaging.length;
      moved = true;
    }
    if (this._lastSentUserMessage !== this._postedLastSentUserMessage) {
      meta.lastSentUserMessage = this._postedLastSentUserMessage = this._lastSentUserMessage;
      moved = true;
    }
    if (this._perfDirty) {
      // Perf is plain observability: the counters run in this engine, and
      // what the mirror needs is the whole record set as of this post.
      meta.perf = {
        replay: this._perfReplay,
        lastReplay: this._perfLastReplay,
        liveTurn: this._perfLiveTurn,
        lastLiveTurn: this._perfLastLiveTurn,
      };
      this._perfDirty = false;
      moved = true;
    }
    return moved ? meta : null;
  }

  // ---------------------------------------------------------------------
  // Perf instrumentation (pure observability — no behavior)
  // ---------------------------------------------------------------------

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
      this._perfDirty = true;
    }
    if (this._perfReplay !== null) {
      this._perfReplay.frames += 1;
      this._perfDirty = true;
    }
    if (event.type === "send") {
      this._perfLiveTurn = {
        turnKey: event.turnKey,
        startedAtMs: Date.now(),
        completedAtMs: null,
        commits: 0,
      };
      this._perfDirty = true;
    }
  }

  /** Count one synchronous post against any open window, for the logged summary. */
  private _perfOnCommit(): void {
    if (this._perfReplay !== null) {
      this._perfReplay.commits += 1;
      this._perfDirty = true;
    } else if (this._perfLiveTurn !== null) {
      this._perfLiveTurn.commits += 1;
      this._perfDirty = true;
    }
  }

  /**
   * Close windows after the event fully dispatched. The summaries are the
   * mirror's to log: only it knows how many notifies the window cost.
   */
  private _perfAfterDispatch(event: CodeSessionEvent): void {
    if (event.type === "replay_complete" && this._perfReplay !== null) {
      const perf = this._perfReplay;
      // The window's own closing post, and the fold it flushes, count
      // against it before it closes, as its notify always did.
      if (this._publish === "sync") {
        if (this._foldPending > 0) perf.folds += 1;
        perf.commits += 1;
        this._commitCounted = true;
      }
      perf.completedAtMs = Date.now();
      this._perfLastReplay = perf;
      this._perfReplay = null;
      this._perfDirty = true;
      return;
    }
    if (event.type === "turn_complete" && this._perfReplay === null && this._perfLiveTurn !== null) {
      const turn = this._perfLiveTurn;
      if (this._publish === "sync") {
        turn.commits += 1;
        this._commitCounted = true;
      }
      turn.completedAtMs = Date.now();
      this._perfLiveTurn = null;
      this._perfLastLiveTurn = turn;
      this._perfDirty = true;
    }
  }

  // ---------------------------------------------------------------------
  // Effects
  // ---------------------------------------------------------------------

  /**
   * After every reduce, compare the indicator-tone triple `(phase,
   * transportState, interruptInFlight)` between prev and next state.
   * If any axis changed, fire-and-forget a
   * `record_session_state_change` CONTROL frame so the supervisor
   * appends one row to the `session_state_changes` ledger, and tell the
   * page's state-change log with the same `atMs`. This is the client-side
   * primary dedupe; the ledger layer dedupes against the most-recent
   * persisted triple as a race safety-net.
   */
  private maybePersistStateChange(prev: CodeSessionState, next: CodeSessionState): void {
    if (
      prev.phase === next.phase &&
      prev.transportState === next.transportState &&
      prev.interruptInFlight === next.interruptInFlight
    ) {
      return;
    }
    const change = {
      tugSessionId: this.tugSessionId,
      atMs: Date.now(),
      phase: next.phase,
      transportState: next.transportState,
      interruptInFlight: next.interruptInFlight,
    };
    const frame = encodeRecordSessionStateChange(change);
    this.host.send(frame.feedId, frame.payload);
    // Same `atMs` as the wire write, so the persisted row and the locally
    // published row carry identical timestamps — the popover's
    // dedupe-on-reload path depends on it.
    this.host.emit({ kind: "effect", session: this.handle, payload: { effect: "local-state-change", change } });
  }

  private processEffects(effects: Effect[]): void {
    for (const effect of effects) {
      switch (effect.kind) {
        case "write-live-usage":
          // High-frequency display telemetry — a per-path write only its
          // observers (the Tokens / Context cells) see; the transcript
          // list never re-renders for it.
          this.write(LIVE_USAGE_PATH, effect.usage);
          this._liveUsage = effect.usage;
          break;
        case "write-inflight":
          // Per-Message path `turn.${turnKey}.message.${messageKey}.${channel}`
          // ([D07]). Each Message's path is stable from mint through
          // commit (the cell wrapper subscribing to it survives the
          // inflight → committed transition without a React unmount);
          // each new Message of the same turn writes to its own path
          // so streaming subscriptions don't cross-pollinate.
          this.write(`turn.${effect.turnKey}.message.${effect.messageKey}.${effect.channel}`, effect.value);
          this._renderTracker.textWritten(effect.messageKey, effect.value);
          break;
        case "clear-inflight":
          // No-op under the per-turn-paths architecture. Each turn
          // writes to its own path; nothing needs clearing at
          // `turn_complete`. Kept as an enum variant so the reducer
          // (which still emits the effect at turn boundaries — see
          // `handleTurnComplete`) doesn't need a coordinated change.
          break;
        case "send-frame":
          // The test witness; one assignment on a path that already
          // encodes and writes a frame.
          if (effect.msg.type === "user_message") {
            this._lastSentUserMessage = effect.msg;
          }
          this.host.send(FeedId.CODE_INPUT, encodeCodeInputPayload(effect.msg, this.tugSessionId));
          break;
        case "request-replay": {
          // A catch-up's ask again, after the bracket ahead of it closed.
          const frame = encodeRequestReplay(this.tugSessionId, "catch-up", effect.window, effect.askId);
          this.host.send(frame.feedId, frame.payload);
          break;
        }
        case "append-transcript":
          // Copy-on-write so old snapshot refs remain valid.
          if (effect.prepend === true) {
            // Load-previous bracket: stage older turns (arrival order)
            // for a single front-commit at flush-prepend. Staging keeps
            // the prepended block's order correct and lets the list view
            // observe one structural growth at the front rather than M.
            this._prependStaging.push(effect.entry);
          } else if (effect.replaces === true && this._transcript.some((t) => t.msgId === effect.entry.msgId)) {
            // A catch-up's late answer: its whole copy of a turn replaces the
            // tail the deadline committed, in place. It keeps its own key, so
            // nothing cached against the tail's row outlives the tail.
            this._transcript = this._transcript.map((t) => (t.msgId === effect.entry.msgId ? effect.entry : t));
          } else if (effect.before !== undefined && this._transcript.some((t) => t.msgId === effect.before)) {
            // A turn of the late answer older than the held tail goes in
            // ahead of it, so the transcript reads in the answer's order.
            const at = this._transcript.findIndex((t) => t.msgId === effect.before);
            this._transcript = [...this._transcript.slice(0, at), effect.entry, ...this._transcript.slice(at)];
          } else {
            // Append, but keep the turn interleaved with any shell rows the
            // ledger restore ([P07]) seated ahead of it — on a Maker ▸
            // Reload the `list_shell_exchanges` restore can land before the
            // JSONL replay, so a bare append would strand the replayed Claude
            // turn behind shell rows it chronologically precedes. The helper
            // only slides past trailing shell turns; non-shell order is intact.
            // The arriving turn may be the one a restored arc-note row was
            // waiting for — absorb it inside at its clock position ([P12]),
            // so the reload race converges on the live reading whichever
            // side landed first.
            this._transcript = absorbArcNotes(appendTurnInterleavingInk(this._transcript, effect.entry));
          }
          break;
        case "ingest-ink-turn":
          // Shell exchange ([P06]/[P12]): upsert the turn — settle in place
          // (same turnKey) or insert at its timestamp position (mint /
          // restore interleave). Copy-on-write, disjoint from the Claude
          // turn lifecycle. An arc-note row whose turn is already committed
          // is then absorbed into it ([P12]) — the other side of the same
          // convergence the `append-transcript` case runs.
          this._transcript = absorbArcNotes(upsertInkTurn(this._transcript, effect.entry));
          break;
        case "flush-prepend":
          // Commit the staged older batch ahead of the existing
          // transcript. Copy-on-write; existing `TurnEntry` refs (and
          // their `turnKey`s) are reused, so React preserves the
          // already-mounted rows' identity across the index shift ([L26]).
          if (this._prependStaging.length > 0) {
            // The older bracket may hold the turns that restored arc-note
            // rows were waiting for — the same absorption the append path
            // runs ([P12]), on the block that just became visible.
            this._transcript = absorbArcNotes([...this._prependStaging, ...this._transcript]);
            this._prependStaging = [];
            // The user asked to see these; the cap rises to hold them.
            this._transcriptTurnLimit = Math.max(this._transcriptTurnLimit, countContextTurns(this._transcript));
          }
          break;
        case "discard-prepend":
          // Cancelled load-previous: drop the staged older turns; the
          // prior transcript/window is untouched.
          this._prependStaging = [];
          break;
        case "truncate-transcript":
          // L26-safe local truncation ([#step-7-3]): drop the anchor turn
          // and everything after; survivors keep their `TurnEntry` reference
          // (and thus `turnKey`/`msgId`) so React preserves their mounts. The
          // pure helper returns the SAME array reference when the anchor
          // isn't present, so a stale ack is a true no-op (no snapshot
          // churn). The mirror drops the removed turns' parse entries.
          this._transcript = truncateTranscriptAtAnchor(this._transcript, effect.promptUuid);
          break;
        case "append-compact-note":
          // [P04] replay fallback: the `compact_boundary` arrived with no open
          // turn, so seat the divider on the last committed turn (the
          // transcript lives here, not in reducer state — [D04]). The note's
          // key is minted from the last turn's `turnKey` + `messages.length`
          // (deterministic, pure, collision-safe). Empty transcript ⇒ no-op.
          //
          // Replay honest-total stamp (H1, Spec S03): the divider seats on
          // this last surviving turn, so "window after this turn = the
          // post-compaction total" is exactly honest. `deriveContextWindows`
          // reads it as `window(N)` even with no post-compaction turn. On the
          // live path the scratch stamp already set it, so the effect omits
          // it and this leaves the committed value untouched.
          this.appendNoteToLastTurn(
            (turn) => ({
              kind: "system_note",
              messageKey: systemNoteKey(turn.turnKey, turn.messages.length),
              createdAt: effect.timestamp ?? Date.now(),
              text: effect.text,
              source: "compact",
            }),
            typeof effect.compactionPostTotal === "number"
              ? { compactionPostTotal: effect.compactionPostTotal }
              : {},
          );
          break;
        case "append-stage-note":
          // The arc rotated at idle, so there is no open turn: seat the stage
          // divider on the last committed turn, the same way.
          this.appendNoteToLastTurn((turn) => ({
            kind: "system_note",
            messageKey: systemNoteKey(turn.turnKey, turn.messages.length),
            createdAt: Date.now(),
            text: effect.text,
            source: "stage",
            stageFacts: effect.stageFacts,
          }));
          break;
        case "append-relocation-note":
          // A directory change, seated like a stage divider: on the last
          // committed turn. Every replayed frame before it has committed, so
          // it reads after the history the card carried and before the first
          // turn in the new directory.
          this.appendNoteToLastTurn((turn) => ({
            kind: "system_note",
            messageKey: systemNoteKey(turn.turnKey, turn.messages.length),
            createdAt: Date.now(),
            text: RELOCATION_BOUNDARY_EVENT,
            source: "relocation",
            relocation: { fromDir: effect.fromDir, toDir: effect.toDir },
          }));
          break;
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
            if (this._closed) return;
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
          this.host.send(frame.feedId, frame.payload);
          break;
        }
        case "confirm-written-paths":
          // The one write the deck watched happen. The resolver lives on the
          // page, so the paths go there; the reducer has already ruled out a
          // replayed result, which is the only case where a past write would
          // be a lie about the present.
          this.host.emit({
            kind: "effect",
            session: this.handle,
            payload: { effect: "confirm-written-paths", paths: [...effect.paths] },
          });
          break;
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
          this.host.send(frame.feedId, frame.payload);
          break;
        }
      }
    }
  }

  // ---------------------------------------------------------------------
  // tugcast's renders ([P06])
  // ---------------------------------------------------------------------

  /** The facts of this dispatch the render tracker reads. */
  private renderView(): RenderDispatchView {
    const state = this.state;
    const pending = state.pendingTurn;
    const entry = pending !== null ? state.scratch.get(pending.turnKey) : undefined;
    const last = entry?.messages[entry.messages.length - 1];
    return {
      pendingTurnKey: pending?.turnKey ?? null,
      last:
        last === undefined
          ? undefined
          : {
              messageKey: last.messageKey,
              text: last.kind === "assistant_text" || last.kind === "assistant_thinking" ? last.text : null,
            },
      replaying: state.phase === "replaying",
      transcript: this._transcript,
    };
  }

  /**
   * tugcast's renders for this session. A Message the engine tracks takes
   * the render at once; a committed one it does not (a reload's resync)
   * starts a finalized track; one not minted yet waits for its mint.
   */
  rendered(messages: ReadonlyArray<RenderedMessageWire>): void {
    if (this._closed) return;
    this._renderTracker.rendered(messages, (key) => this.findTextMessage(key), this.state.pendingTurn !== null);
  }

  /** A committed or in-flight assistant-text or thinking Message, by key. */
  private findTextMessage(key: string): { turnKey: string; text: string } | null {
    const pending = this.state.pendingTurn;
    const scratch = pending !== null ? this.state.scratch.get(pending.turnKey) : undefined;
    const turns: ReadonlyArray<{ turnKey: string; messages: ReadonlyArray<TurnEntry["messages"][number]> }> =
      scratch !== undefined ? [...this._transcript, scratch] : this._transcript;
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      const turn = turns[i]!;
      for (const m of turn.messages) {
        if (m.messageKey !== key) continue;
        if (m.kind !== "assistant_text" && m.kind !== "assistant_thinking") return null;
        // A Message minting live is the mint scan's to start.
        if (turn === scratch && this.state.phase !== "replaying") return null;
        return { turnKey: turn.turnKey, text: m.text };
      }
    }
    return null;
  }

  /**
   * Seat a divider on the last committed turn, copy-on-write so earlier
   * posts stay valid. Empty transcript ⇒ no-op.
   */
  private appendNoteToLastTurn(note: (turn: TurnEntry) => SystemNote, extra: Partial<TurnEntry> = {}): void {
    if (this._transcript.length === 0) return;
    const lastIndex = this._transcript.length - 1;
    const turn = this._transcript[lastIndex];
    const next = [...this._transcript];
    next[lastIndex] = { ...turn, messages: [...turn.messages, note(turn)], ...extra };
    this._transcript = next;
  }
}
