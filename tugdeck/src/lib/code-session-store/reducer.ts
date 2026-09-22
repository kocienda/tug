/**
 * Pure reducer for `CodeSessionStore`.
 *
 * Step 3 implements the basic `idle → submitting → awaiting_first_token
 * → streaming → idle` round-trip. Later steps extend this with streaming
 * delta accumulation (4), tool lifecycle (5), control forwards (6),
 * interrupt + queue (7), errored triggers (8), JSONL replay bracketing,
 * and the cold-boot replay-clock derivations
 * (`replayPreflightActive` / `replaySoftBudgetElapsed` /
 * `replayTimeoutDwellActive`) that drive the resume placeholder /
 * banner UX.
 *
 * Step 5 ([D07]) lifts the substrate to a full Message-sequence
 * model. `state.scratch` re-keys from `Map<msgId, …>` to
 * `Map<turnKey, ScratchEntry>` (one scratch entry per turn, spanning
 * every msgId iteration of the turn's tool-use loop). The committed
 * `TurnEntry` exposes `messages: ReadonlyArray<Message>` instead of
 * the old paired `userMessage` / `thinking` / `assistant` /
 * `toolCalls` fields. `pendingUserMessage` → `pendingTurn`;
 * `toolCallMap` retires (folded into `ScratchEntry.toolCallIndex`).
 *
 * `transcript` intentionally does NOT live here — the class wrapper
 * owns it and appends via `AppendTranscript` effects ([D04] / [D11]).
 *
 * Timers are also outside the reducer: the `schedule_timer` /
 * `cancel_timer` effects are processed by the dispatch loop, which
 * keeps a `Map<string, TimerHandle>` and dispatches the named tick
 * event back into the reducer when a timer fires. The reducer stays
 * pure and time-independent.
 */

import type { AtomSegment } from "../tug-atom-img";
import type { ContentBlock } from "../../protocol";
import type { Effect } from "./effects";
import { isNetworkStalled } from "./lifecycle-state";
import type {
  AddUserMessageEvent,
  ApiRetryEvent,
  ModelRefusalFallbackEvent,
  OutputTruncatedEvent,
  CompactBoundaryEvent,
  CompactSummaryEvent,
  SessionStageEvent,
  UnknownEventEvent,
  AssistantTextEvent,
  CancelQueuedSendActionEvent,
  InsertCommandDraftActionEvent,
  InsertJotActionEvent,
  InsertAtomDraftActionEvent,
  InsertFilesActionEvent,
  CodeSessionEvent,
  ContentBlockStartEvent,
  ContextBreakdownEvent,
  ControlRequestForwardEvent,
  CostUpdateEvent,
  ReplayCompleteEvent,
  SeedQueuedSendsEvent,
  NetworkPathSatisfiedEvent,
  ReplayStartedEvent,
  RespondApprovalActionEvent,
  RespondQuestionActionEvent,
  SendActionEvent,
  SessionInitEvent,
  SetPermissionModeActionEvent,
  SessionNotOwnedEvent,
  SessionStateErroredEvent,
  SessionUnknownEvent,
  StreamingUsageEvent,
  ThinkingTextEvent,
  ToolResultEvent,
  ToolUseEvent,
  ToolUseStructuredEvent,
  TaskStartedEvent,
  TaskUpdatedEvent,
  TaskProgressEvent,
  TurnCompleteEvent,
  TurnCancelledEvent,
  InterruptNoopEvent,
  WakeStartedEvent,
  AssistantOpenerEvent,
  TugNoticeEvent,
  WireErrorEvent,
  PromptAnchorEvent,
  RewindPreviewResultEvent,
  RewindResultEvent,
  RequestRewindPreviewActionEvent,
  SessionRewindActionEvent,
  ShellExchangeStartedActionEvent,
  ShellExchangeCompleteActionEvent,
  ArcNoteActionEvent,
  RefsResultActionEvent,
} from "./events";
import type {
  ActiveTurnSnapshot,
  ApiRetryState,
  RefusalFallbackState,
  UnknownEventState,
  AssistantText,
  AssistantThinking,
  CardSessionMode,
  CodeSessionPhase,
  ContextBreakdownSnapshot,
  ControlRequestForward,
  CostSnapshot,
  InterruptReason,
  LastReplayResult,
  ReplayWindowMeta,
  LiveMessageUsage,
  Message,
  PermissionDenial,
  RewindResultAck,
  RefsResultMessage,
  RewindTurnPreview,
  ShellExchangeMessage,
  SystemNote,
  ToolUseMessage,
  TransportState,
  TurnCost,
  TurnEndReason,
  TurnEntry,
  TurnOrigin,
  UserMessage,
  WakeTrigger,
} from "./types";
import { isInkOrigin } from "./types";
import { arcNoteSentence, matchesArcNote } from "../arc-note-command";
import { compactionNoteText, isCompactionSubmission } from "./compaction";
import { stageNoteText, type StageBoundaryFacts } from "./stages";
import {
  applyJobAgentStructured,
  applyJobChildResult,
  applyJobChildToolUse,
  applyJobFlip,
  applyJobProgress,
  clearTerminalJobs,
  EMPTY_JOBS_LEDGER,
  insertJob,
  isJobLaunch,
  jobExistsForParent,
  jobIdForChild,
  jobKindForLaunch,
  markRunningJobsStopped,
  parseBackgroundLaunchResult,
  terminalJobStatusFromWire,
  type JobItem,
} from "./select-jobs";
import {
  flipEarliestElapsedScheduled,
  narrowCronCreateInput,
  narrowCronDeleteInput,
  narrowRemoteTriggerToolInput,
  narrowScheduleWakeupInput,
  parseRemoteTriggerCreateId,
  reapElapsedScheduled,
  relabelScheduledRow,
  remoteTriggerLabels,
  scheduledRowFromCron,
  scheduledRowFromRemoteTrigger,
  scheduledRowFromWakeup,
  stopScheduledRow,
} from "./select-scheduled-work";
import {
  commandLineFromSend,
  reduceGoalOnFeedback,
  reduceGoalOnSend,
  settleGoalOnCycleCommit,
  type GoalState,
} from "./select-goal";
import { TUG_ATOM_CHAR } from "../tug-atom-img";
import { mintLeadingCommandAtom } from "../command-atom";
import { decodePermissionDenials, mergeDenials } from "./denials";
import { tugDevLogStore } from "../tug-dev-log-store/tug-dev-log-store";
import {
  deriveTurnTelemetry,
  mergeTurnTelemetry,
  readUsage,
  type TurnTelemetry,
} from "./telemetry";

// ---------------------------------------------------------------------------
// Per-turn scratch ([D07])
// ---------------------------------------------------------------------------

/**
 * One scratch entry per turn — accumulates the wire's Message sequence
 * across every msgId iteration of the turn ([D07] § Multi-msgId-per-
 * turn handling). The `messages` array is the substrate's primary
 * payload; `blockIndex` and `toolCallIndex` are O(1) lookup tables
 * into it.
 *
 * `blockIndex` keys are `${msg_id}:${block_index}` — the wire's
 * coordinate for one content block. `handleContentBlockStart` mints a
 * Message and writes its array index here; `handleTextDelta` reads
 * this index to find the Message to mutate.
 *
 * `toolCallIndex` keys are `tool_use_id`. The mint at
 * `handleContentBlockStart` (for `kind: "tool_use"`) populates both
 * indices; subsequent `tool_use` (input fill), `tool_result`, and
 * `tool_use_structured` events look up via `toolCallIndex` and mutate
 * the indexed `ToolUseMessage`.
 *
 * `systemNoteSeq` is the monotonic per-turn counter for
 * `SystemNote.messageKey` derivation (`${turnKey}-sys${seq}`).
 */
export interface ScratchEntry {
  turnKey: string;
  messages: Message[];
  blockIndex: Map<string, number>;
  toolCallIndex: Map<string, number>;
  systemNoteSeq: number;
  /**
   * Honest post-compaction resident window for this turn ([P01], Spec S04),
   * when it compacted: `compact_boundary.post_tokens`, which is the whole
   * resident window and not a figure above the base (see
   * `honestCompactionTotal`), stamped in
   * `handleCompactBoundary` when it is finite and positive. `buildTurnEntry`
   * copies it onto the committed `TurnEntry.compactionPostTotal`, where
   * `deriveContextWindows` reads it as `window(N)` so the CONTEXT readout
   * drops in place immediately instead of carrying the pre-compaction peak
   * forward until the next turn. Never written into `cost`, so it cannot
   * masquerade as usage. Absent for ordinary turns. Per-turn scoped:
   * discarded with the scratch entry at commit.
   */
  compactionPostTotal?: number;
}

/**
 * The in-flight turn marker — replaces `pendingUserMessage` under
 * [D07]. `origin` is the turn's intrinsic, stated attribution (S01,
 * [P01]): `"user"` opens with a `user_message` at the head of
 * `scratch[turnKey].messages`; `"assistant"` (wake / continuation /
 * orphan) opens with an empty scratch and no user message. Handlers
 * branch on `origin`, never by inspecting `messages[0]`.
 */
export interface PendingTurn {
  turnKey: string;
  submitAt: number;
  origin: TurnOrigin;
  /**
   * When true, this turn is suppressed from the transcript: its in-flight
   * rows are skipped and `turn_complete` drops the transcript append (the
   * turn still runs on claude). The `/compact` seed sets this.
   */
  suppressed?: boolean;
  /**
   * Claude's user-prompt-record `uuid` — the `/rewind` anchor ([#step-7-1]).
   * Set from `add_user_message.promptUuid` (replay) at turn open, or from a
   * live `prompt_anchor` frame mid-turn ({@link handlePromptAnchor}), and
   * copied onto the committed `TurnEntry` by {@link buildTurnEntry}. Absent
   * until the anchor arrives.
   */
  promptUuid?: string;
}

/** Derive a Message's `messageKey` from the wire coordinate it owns. */
function wireMessageKey(msgId: string, blockIndex: number): string {
  return `${msgId}-b${blockIndex}`;
}

/** Derive a user_message's `messageKey` from its turn. */
function userMessageKey(turnKey: string): string {
  return `${turnKey}-user`;
}

/**
 * Derive a system_note's `messageKey` from its turn + monotonic seq. Exported
 * so the store wrapper mints an identical key when it applies the
 * `append-compact-note` effect to a committed turn ([P04]).
 */
export function systemNoteKey(turnKey: string, seq: number): string {
  return `${turnKey}-sys${seq}`;
}

/** Composite key into `ScratchEntry.blockIndex`. */
function blockKey(msgId: string, blockIndex: number): string {
  return `${msgId}:${blockIndex}`;
}

/**
 * Build a fresh `ScratchEntry`. The caller seeds `messages` with the
 * turn's opening Messages (e.g., the `user_message` for a normal
 * turn, `[]` for a wake) and the indices are initialized empty —
 * wire-derived Messages mint into `blockIndex` (and `toolCallIndex`
 * for tool_use) as `content_block_start` events arrive.
 */
function newScratchEntry(
  turnKey: string,
  initialMessages: Message[],
): ScratchEntry {
  return {
    turnKey,
    messages: initialMessages,
    blockIndex: new Map(),
    toolCallIndex: new Map(),
    systemNoteSeq: 0,
  };
}

/**
 * Replace `scratch[turnKey]` via copy-on-write at the smallest
 * container that changes ([D07] mutation discipline). Returns a fresh
 * `Map<turnKey, ScratchEntry>` for the next state slot; other turns'
 * entries stay reference-identical.
 */
function withScratchEntry(
  scratch: ReadonlyMap<string, ScratchEntry>,
  turnKey: string,
  entry: ScratchEntry,
): Map<string, ScratchEntry> {
  const next = new Map(scratch);
  next.set(turnKey, entry);
  return next;
}

/**
 * Iterate a turn's `tool_use` Messages — the substrate's replacement
 * for today's `toolCallMap.values()`. Pure over the entry's messages
 * array; preserves arrival order.
 */
function* toolUseMessages(
  entry: ScratchEntry | undefined,
): IterableIterator<ToolUseMessage> {
  if (entry === undefined) return;
  for (const m of entry.messages) {
    if (m.kind === "tool_use") yield m;
  }
}

/**
 * Predicate driving the `tool_work → streaming` transition: every
 * tool_use Message in the turn's scratch must be terminal
 * (`done` / `error`). An empty iteration counts as "all done" but
 * the reducer only calls this after a state-changing tool event, so
 * the empty case never triggers a spurious return.
 */
function allToolsTerminal(entry: ScratchEntry | undefined): boolean {
  for (const m of toolUseMessages(entry)) {
    if (m.status !== "done" && m.status !== "error") return false;
  }
  return true;
}

/** Reducer-internal state. Not exposed to consumers. */
export interface CodeSessionState {
  phase: CodeSessionPhase;
  transportState: TransportState;

  tugSessionId: string;
  displayLabel: string;
  /**
   * Captured at construction from the per-card `CardSessionBinding`'s
   * `sessionMode`. Mirrored onto `CodeSessionSnapshot.sessionMode` for
   * pure-derivation consumers. Reducer transitions never mutate this
   * field — a re-bind builds a fresh state via `createInitialState`,
   * and the in-flight reducer is mode-agnostic for everything except
   * derivations that read the snapshot.
   */
  sessionMode: CardSessionMode;

  activeMsgId: string | null;
  /**
   * `/rewind` per-turn diff-stat previews ([#step-7-3]), keyed by
   * `promptUuid`. Folded from `rewind_preview_result` frames; surfaced on the
   * snapshot for the sheet ([L02]). Session-cached — never reset at turn
   * boundaries. Reference-stable across dispatches that don't touch it.
   */
  rewindPreviews: ReadonlyMap<string, RewindTurnPreview>;
  /**
   * Most recent applied-rewind ack ([#step-7-3]); `null` until a
   * `session_rewind` completes. The sheet observes it to dismiss / rebind.
   */
  lastRewindResult: RewindResultAck | null;
  /**
   * The rewound-to turn's command, stashed from a `session_rewind_request`
   * until its matching successful `rewind_result` ack lands ([#step-7-3]).
   * On that ack the reducer routes it into `pendingDraftRestore` (so the
   * composer offers the command back for re-edit) and clears this. Cleared
   * without seeding on a refused / non-matching ack. Internal — not part of
   * the public snapshot. `null` when no rewind is in flight.
   */
  pendingRewindDraft: {
    promptUuid: string;
    text: string;
    atoms: ReadonlyArray<AtomSegment>;
  } | null;
  /**
   * Per-turn scratch ([D07]) — one entry per turn, keyed by `turnKey`,
   * spanning every msgId iteration of the turn's tool-use loop. The
   * shift from `Map<msgId, …>` was a correctness fix: today's
   * substrate dropped intermediate iterations' Messages at commit
   * because `buildTurnEntry` only read `scratch[activeMsgId]`.
   *
   * The entry's `toolCallIndex` field absorbs what `toolCallMap` used
   * to hold (toolUseId → array index instead of toolUseId → state),
   * so tool lookup stays O(1) and there's no parallel storage to
   * drift out of sync with the Message sequence.
   */
  scratch: Map<string, ScratchEntry>;
  pendingApproval: ControlRequestForward | null;
  pendingQuestion: ControlRequestForward | null;
  prevPhase: CodeSessionPhase | null;
  /**
   * The in-flight turn marker — replaces the [D07]-superseded
   * `pendingUserMessage`. Set the moment `send()` or
   * `handleWakeStarted` opens a turn; cleared at commit / interrupt /
   * transport_close. Carries the React-key seed (`turnKey`) that
   * `TurnEntry` adopts at commit (so the row's React identity is
   * stable across the inflight → committed transition) plus the turn's
   * `origin` (S01) — the attribution handlers branch on instead of the
   * retired [D06] empty-text sentinel.
   */
  pendingTurn: PendingTurn | null;
  /**
   * One-shot draft restore for CASE A interrupt — `interrupt()` fired
   * while `phase === "submitting"`, before claude produced any content
   * keyed to a `msg_id`. The reducer captures the in-flight user
   * submission's text + atoms here so the prompt entry can seed the
   * editor with them for re-edit. Cleared by `consume_draft_restore`
   * (the prompt entry's signal that it has applied the restore) —
   * never overwritten elsewhere; a brand-new CASE A interrupt while
   * a previous restore still sits in this slot replaces the contents
   * (the editor effectively "missed" the prior restore, but losing
   * the older draft is preferable to stranding the most recent one).
   *
   * Mirrored onto the public snapshot as
   * `CodeSessionSnapshot.pendingDraftRestore`. The reference is shared
   * with the snapshot so identity is stable across snapshot rebuilds
   * (per the same [D10]-style stability contract previously honored
   * by `pendingUserMessage`).
   */
  pendingDraftRestore: {
    text: string;
    atoms: ReadonlyArray<AtomSegment>;
  } | null;

  /**
   * A clicked transcript slash command, parked by `insert_command_draft`
   * for the prompt entry to seed as a ready-to-run draft, cleared by
   * `consume_command_insert` once seeded. `name` is the bare command name
   * (no leading slash); `args` the trailing argument text (`""` when
   * none); `submit` asks the entry to send the seeded draft as this card's
   * next turn rather than leaving it for the user to press Return on.
   * Mirrored onto `CodeSessionSnapshot.pendingCommandInsert` with a
   * shared reference so the seeding `useLayoutEffect` fires once per
   * click, matching the `pendingDraftRestore` stability contract.
   */
  pendingCommandInsert: {
    name: string;
    args: string;
    submit: boolean;
  } | null;
  /**
   * A jot dragged/clicked into the prompt entry, parked by
   * `insert_jot` and cleared by `consume_jot_insert`. Mirrored onto
   * `CodeSessionSnapshot.pendingJotInsert` with a shared reference so the
   * seeding `useLayoutEffect` fires once per gesture.
   */
  pendingJotInsert: {
    text: string;
    atoms: AtomSegment[];
    at: { x: number; y: number } | null;
  } | null;
  /**
   * An atom the transcript asked the composer to carry, parked by
   * `insert_atom_draft` and cleared by `consume_atom_insert`. Mirrored onto
   * `CodeSessionSnapshot.pendingAtomInsert` with a shared reference so the
   * seeding `useLayoutEffect` fires once per gesture.
   */
  pendingAtomInsert: AtomSegment | null;
  /**
   * Files a surface outside the prompt entry accepted on the card's behalf,
   * parked by `insert_files` and cleared by `consume_file_insert`. Mirrored
   * onto `CodeSessionSnapshot.pendingFileInsert` with a shared reference so
   * the consuming `useLayoutEffect` fires once per drop.
   */
  pendingFileInsert: File[] | null;
  /**
   * Counter of outstanding CASE A wire echoes the reducer expects to
   * suppress. Incremented every time `handleInterrupt` fires from
   * `phase === "submitting"`; decremented when `handleTurnComplete`'s
   * suppression gate matches and drops the echo.
   *
   * Why a counter and not a boolean: a single bit can't represent
   * multiple in-flight aborted cycles, and the wire doesn't carry a
   * client-assigned correlation id. The user can rapid-fire
   * interrupts (CASE A → re-submit → CASE A → …) before any single
   * wire echo lands; each pending abort needs its own slot. The
   * counter rises with the user's actions and falls as wire echoes
   * arrive in FIFO order.
   *
   * Why this is correct under FIFO wire ordering: tugcode processes
   * inbound user_message frames sequentially via
   * `await turn.completion`, so the aborted cycle's eventual
   * `turn_complete(error)` (which the abort probe shows carries
   * `msg_id: ""` for a no-content abort) always lands before any
   * frame from the next cycle. At the moment the gate fires,
   * `state.activeMsgId === null` confirms no live turn has produced
   * content yet — the echo can only belong to an aborted cycle.
   *
   * Reset to 0 on `transport_close` (any stranded echoes are lost
   * with the dead wire — letting them carry across a reconnect would
   * falsely suppress the next live turn's pre-content error). Not
   * exposed on the snapshot.
   */
  pendingCaseAEchoes: number;
  /**
   * Send actions queued while the session is busy. Each entry carries
   * the `turnKey` that was minted at the queueing `send` event; when
   * the queue drains at `handleTurnComplete` the queued turnKey is
   * reused as the new in-flight turn's React-key seed. Carrying the
   * key with the queued send (rather than minting at drain time)
   * keeps the reducer pure.
   *
   * `content` is the Anthropic-API content-block array forwarded on
   * the `send-frame` effect at queue-flush time. `text` + `atoms`
   * are the already-synthesized substrate (produced by
   * `synthesizeUserMessageFromBlocks` at the queueing `send`) —
   * synthesis happens once per submission regardless of whether the
   * message goes active or queued. The bytes-store entries are also
   * minted at synthesis time and persist across the queue gap (the
   * bytes-store is per-card-mount).
   *
   * Same field names as {@link QueuedSend} (the public snapshot
   * projection) so the snapshot can pass the array reference
   * through without reshaping — preserves `Object.is` stability for
   * `useSyncExternalStore` consumers ([L02]).
   *
   * Per [Step 5c](../../../arc/dev-atoms.md#step-5c).
   */
  queuedSends: Array<{
    content: ContentBlock[];
    text: string;
    atoms: AtomSegment[];
    turnKey: string;
    origin: "user" | "wheel";
    queuedAt: number;
    /**
     * Waiting for the network rather than for the turn ahead of it — see
     * {@link QueuedSend.held}, whose doc is the contract. A held entry is
     * skipped by every flush until a proving event releases it.
     */
    held: boolean;
  }>;
  lastError: {
    cause:
      | "session_state_errored"
      | "transport_closed"
      | "wire_error"
      | "session_unknown"
      | "session_not_owned"
      | "resume_failed"
      | "replay_stalled"
      | "replay_bracket_timeout";
    message: string;
    at: number;
    /**
     * For `wire_error` only: the bridge's slug for the emit site that wrote
     * the frame. Absent on every other cause, and on a frame from a tugcode
     * older than the field.
     */
    site?: string;
  } | null;
  lastCost: CostSnapshot | null;
  /**
   * Live API-retry announcement, or `null` when none is in flight. Set by
   * `handleApiRetry`; cleared at the next turn boundary (`cost_update` and
   * `resetPerTurnTelemetry`, which every `turn_complete` path spreads).
   */
  apiRetry: ApiRetryState | null;
  /**
   * Most recent model-refusal fallback, or `null`. Set by
   * `handleModelRefusalFallback`; cleared at the next turn boundary
   * (`resetPerTurnTelemetry`), so each occurrence re-notifies.
   */
  refusalFallback: RefusalFallbackState | null;
  /**
   * True when the latest turn's output truncated at the token ceiling. Set by
   * `handleOutputTruncated`; cleared at the next turn boundary
   * (`resetPerTurnTelemetry`), so each truncated turn re-notifies.
   */
  outputTruncated: boolean;
  /**
   * The most recent forward-incompatible `unknown_event` tugcode
   * forwarded, or `null`. Set by `handleUnknownEvent`; not cleared at the
   * turn boundary (a forward-compat notice outlives a turn — the user
   * dismisses it, or a fresh unknown type with a new `at` overwrites it).
   */
  unknownEvent: UnknownEventState | null;
  /**
   * The latest compaction's summary, set by a `compact_summary` frame (native
   * live / replay) or the legacy `add_user_message.compactionSummary` replay
   * path: the transcript renders a carry-forward summary block (the `summary`
   * body, labelled by `preTokens` when a boundary latched it). Latest-wins;
   * `null` for uncompacted sessions. Session-lived.
   */
  compactionSeed: {
    summary: string;
    preTokens: number | null;
  } | null;
  /**
   * Tool calls denied this session, accumulated from each `cost_update`'s
   * `permission_denials`, deduped by `toolUseId`, most-recent last. Surfaced on
   * the snapshot for the `/permissions` Recently-denied tab. See {@link
   * PermissionDenial}.
   */
  permissionDenials: readonly PermissionDenial[];
  /**
   * `window(0)` — the resident context before any turn. Captured once,
   * from the `observedInput` (`input + cache_read + cache_creation`)
   * of the session's first telemetry iteration: the first
   * `streaming_usage` frame, or the first `cost_update` as a fallback.
   * Never overwritten once set. `null` until the first frame lands.
   *
   * Session-level — NOT reset at turn boundaries. The transcript
   * window-walk uses it as the prior window for turn 1. Restored on
   * resume from the first replayed `turn_complete`'s inlined
   * `TurnTelemetry.sessionInitTokens`.
   */
  sessionInitTokens: number | null;
  /**
   * Most-recent `/context`-style breakdown captured from a
   * `context_breakdown` wire frame. Projected onto
   * `CodeSessionSnapshot.lastContextBreakdown` with reference
   * stability — the reducer assigns a fresh object only when a new
   * frame lands (handleContextBreakdown); quiescent reductions
   * preserve the reference so [L02] consumers see `Object.is`
   * stability.
   */
  lastContextBreakdown: ContextBreakdownSnapshot | null;
  /**
   * Set of msg_ids already committed to the transcript. Used to
   * dedupe `turn_complete` events whose msg_id has already produced a
   * TurnEntry — defense-in-depth against a supervisor that
   * accidentally re-emits a turn (a misordered replay-vs-live during
   * a fast reconnect, a manual dev-tool replay) so the worst case is
   * a silent no-op, not a duplicate transcript row.
   *
   * **Assistant-side-first dedupe** (per [D14]). In the steady-state
   * path the ids stored here are claude's *real* `msg_id` values, set
   * onto `activeMsgId` by the first content event of each turn
   * (`assistant_text` / `thinking_text` / `tool_use` /
   * `content_block_start`) and read back here at `handleTurnComplete`.
   *
   * The no-content interrupt fallback ([D13] / `#spec-reducer-state`
   * rule 2) also adds an entry: when the translator emits an
   * orphan-synthesis `turn_complete` carrying a synthesized opener
   * id (`u-<n>` for user-text openers, `w-<n>` for wake openers),
   * `handleTurnComplete` falls through to a `pendingTurn`-based
   * commit and adds the synthesized id to this set so a duplicate
   * orphan-synthesis frame (replay overlap, dev-tool re-emission)
   * is deduped on second arrival rather than committing a phantom
   * second TurnEntry. The synthesized ids are unique per
   * `orphanCounter`, so cross-orphan collisions don't happen in
   * normal operation. See `reducer.no-content-fallback.test.ts`.
   *
   * Maintained alongside the class wrapper's `_transcript` array. The
   * reducer adds entries on `turn_complete`; `dispose` and clear
   * paths are owned by the wrapper.
   */
  committedMsgIds: Set<string>;
  /**
   * Outcome of the most recent JSONL replay window. `null` between
   * windows; populated on every `replay_complete` (success and error
   * variants). The class wrapper mirrors this to
   * `CodeSessionSnapshot.lastReplayResult`.
   */
  lastReplayResult: LastReplayResult | null;
  /**
   * MONOTONIC: has any replay window ever closed on this store?
   * Unlike `lastReplayResult` (cleared when the next window opens),
   * this never resets — it distinguishes the INITIAL resume replay
   * (transcript not yet reconstructed; the deferred-content hold keeps
   * the list unmounted) from a later reconnect catch-up window (list
   * mounted with content the user is looking at — never unmount it).
   */
  replayEverCompleted: boolean;
  /**
   * Recency-window metadata from the most recent `replay_complete`
   * (which slice is loaded; whether older turns remain). `null` until
   * a windowed replay completes. Mirrored to
   * `CodeSessionSnapshot.replayWindow`.
   */
  replayWindow: ReplayWindowMeta | null;
  /**
   * Wall-clock (epoch ms) of the session's first real turn — session-level
   * (unlike `replayWindow`, present on a full load too). Set from every
   * success `replay_complete`'s `sessionCreatedAtMs`, retained when a frame
   * omits it. Mirrored to `CodeSessionSnapshot.sessionCreatedAtMs`.
   */
  sessionCreatedAtMs: number | null;
  /**
   * True while a load-previous (older-range) replay bracket is in
   * flight: set by `begin_load_previous` (the store dispatches it just
   * before sending the older-range request), read by
   * `handleTurnComplete` to route the bracket's turns to prepend
   * staging, and cleared at `replay_complete` (which also flushes the
   * staged batch to the front of the transcript). Internal-only — not
   * surfaced on the snapshot.
   */
  replayPrependActive: boolean;
  /**
   * Replay-clock derived flags. Exposed through the snapshot identically-
   * named (`replayPreflightActive`, `replaySoftBudgetElapsed`,
   * `replayTimeoutDwellActive`); see `types.ts` for semantics. Driven
   * by `bind_resume_acknowledged` / `replay_started` / `replay_complete` /
   * `transport_close` / `tick_*` events; the dispatch loop manages the
   * actual `setTimeout` handles via `schedule_timer` / `cancel_timer`
   * effects so the reducer stays pure.
   */
  replayPreflightActive: boolean;
  replaySoftBudgetElapsed: boolean;
  replayTimeoutDwellActive: boolean;

  // -------------------------------------------------------------------------
  // Per-turn telemetry — populated incrementally during a turn, frozen
  // onto the committed `TurnEntry` at `handleTurnComplete` and reset at
  // each turn boundary.
  // -------------------------------------------------------------------------

  /**
   * `Date.now()` when the in-flight turn entered `awaiting_approval`
   * (permission OR question dialog). `null` while no dialog is open.
   * Cleared on every dialog response, on interrupt, on transport-close,
   * and at turn boundaries — the awaiting-approval clock has at most
   * one in-progress interval at any moment.
   */
  awaitingApprovalSince: number | null;
  /**
   * Cumulative ms paused on `TugInlineDialog` so far in the in-flight
   * turn. Each closed dialog interval folds into this accumulator;
   * `liveTurnAwaitingApprovalMs` adds the live in-progress interval
   * (from `awaitingApprovalSince`) on top.
   */
  awaitingApprovalAccumulatedMs: number;
  /**
   * `Date.now()` when the transport first left `online` during the
   * in-flight turn (either to `offline` or `restoring`). `null` while
   * the transport is online. Set by `handleTransportClose`, cleared by
   * `handleTransportSettled` after accumulating the elapsed downtime.
   */
  transportNonOnlineSince: number | null;
  /**
   * Cumulative ms the transport was not `"online"` during the
   * in-flight turn. `liveTurnTransportDowntimeMs` folds in the live
   * in-progress interval (from `transportNonOnlineSince`) on top.
   */
  transportDowntimeAccumulatedMs: number;
  /**
   * Number of transport reconnects (`restoring → online` transitions)
   * observed during the in-flight turn. Used to populate
   * `TurnEntry.reconnectCount` at completion.
   */
  transportReconnectCount: number;
  /**
   * `Date.now()` of the most recent stream event observed during the
   * in-flight turn (assistant_delta / tool_use / tool_result /
   * tool_use_structured). `null` until the first stream event lands.
   * Used to compute the inter-event gap that feeds `maxStreamGapMs`.
   */
  lastStreamEventAt: number | null;
  /**
   * Longest single inter-event silence (ms) observed during the
   * in-flight turn. `0` until at least two stream events have landed.
   */
  maxStreamGapMs: number;
  /**
   * `Date.now()` of the first `assistant_delta` of the in-flight turn,
   * for the TTFT (time-to-first-token) latency. `null` if no assistant
   * output has landed yet.
   */
  firstAssistantDeltaAt: number | null;
  /**
   * `Date.now()` of the first `tool_use` of the in-flight turn, for the
   * TTFTC (time-to-first-tool-call) latency. `null` if no tool call has
   * landed yet.
   */
  firstToolUseAt: number | null;
  /**
   * Snapshot of `lastCost` taken at `handleSend` so the per-turn cost
   * delta can be computed at `handleTurnComplete` against the
   * `lastCost` snapshot current at completion. `null` for the first
   * turn of a session (the helper degenerates the delta to `after`).
   */
  costAtSubmit: CostSnapshot | null;
  /**
   * `true` from the moment `handleInterrupt` fires until the matching
   * `handleTurnComplete` (any reason) clears it. Drives the
   * INTERRUPTING lifecycle state in the per-turn coordinator matrix.
   */
  interruptInFlight: boolean;
  /**
   * A stop went unanswered past `INTERRUPT_SILENCE_DEADLINE_MS`, so the
   * deck stopped waiting on a receipt and said so. Set by
   * {@link handleTickInterruptSilence}; cleared at every turn end, in
   * `enterErrored`, and at the next `send`.
   *
   * **It is not a claim that the turn ended.** `pendingTurn` stays open
   * and only a real turn end — `turn_cancelled`, `turn_complete`, a
   * terminal — commits it ([P01]). What the flag changes is what the
   * stop control *means*: the card offers Force Stop rather than
   * repeating a stop nothing answered. Committing a turn the far end may
   * still be writing would be the same lie the app-wide restore modal
   * told, and this arc is removing that lie rather than adding one.
   */
  stopStalled: boolean;
  /**
   * A live turn has gone `STREAM_SILENCE_STALL_MS` without a single stream
   * event. Set by {@link handleTickStreamStall}; cleared by the next stream
   * event ({@link foldStreamEvent}), at every turn end, in `enterErrored`,
   * and at the next `send`.
   *
   * Like {@link stopStalled} it is a claim about the *wait*, not about the
   * turn: the turn stays open, `lastError` is not stamped, and Stop stays
   * deliverable. The card reads "Waiting" instead of
   * "Streaming", which is the difference between a screen that is lying and
   * one that is quiet about a real wait.
   */
  streamStalled: boolean;
  /**
   * Why the in-flight CASE B interrupt fired, when it wasn't a plain
   * user Stop. Stashed by `handleInterrupt` when an app-level flow stops
   * turns, and read by `buildTurnEntry` so the committed turn's end-state
   * names that flow (see {@link InterruptReason});
   * `handleTurnComplete` clears it alongside {@link interruptInFlight}.
   * `null` for an ordinary user-initiated stop. The interrupted
   * `TurnEntry` is committed at `turn_complete`, not at interrupt, so
   * the reason must bridge across the round-trip on state.
   */
  pendingInterruptReason: InterruptReason | null;
  /**
   * Wall-clock ms when `handleInterrupt` opened the current
   * CASE B interrupt round-trip; `null` while no interrupt is in
   * flight. Companion to {@link interruptInFlight} (which is the
   * latched bool) — this field is the entry-side timestamp the
   * live-clock helper folds in via the yellow-axis union.
   *
   * The two fields could be inferred from each other (bool ↔
   * timestamp), but keeping them parallel matches the
   * `awaitingApprovalSince` / `transportNonOnlineSince` pattern and
   * lets `closeInterruptInFlightInterval` push a closed `[start, end]`
   * pair into {@link interruptInFlightIntervals} without re-deriving
   * the start time.
   */
  interruptInFlightSegmentStartedAt: number | null;
  /**
   * Closed pause-axis intervals observed within the current in-flight
   * turn, as `[startMs, endMs]` pairs in chronological order. The
   * three arrays mirror the three scalar accumulators / segment-start
   * timestamps and are appended to whenever the matching segment
   * closes:
   *
   *   - awaiting-approval: closes when a dialog (permission OR
   *     question) is answered, or when an interrupt fires while a
   *     dialog is open
   *   - transport-downtime: closes when the wire returns to `online`
   *     via `transport_settled`
   *   - interrupt-in-flight: closes at the matching `turn_complete`
   *     (the only path that flips `interruptInFlight` back to false)
   *
   * Reset to `[]` at every new turn start (`handleSend`). They are
   * deliberately NOT reset at `handleTurnComplete` — the closed
   * intervals from the just-ended turn linger through the brief idle
   * gap so the reducer-state inspector can show the full pause
   * history of the most recent turn, and so the next `handleSend`
   * does the canonical reset in one place.
   *
   * The arrays sit alongside the existing scalar accumulators
   * (`awaitingApprovalAccumulatedMs` / `transportDowntimeAccumulatedMs`).
   * The scalars continue to drive the committed `TurnEntry` per-turn
   * telemetry; the arrays are an additional, parallel projection that
   * the pure live-derivation helper (`deriveInflightActiveMs`) unions
   * across axes so overlapping pauses contribute only once. See plan
   * `#step-20-4-5-a` for the overlap-correctness rationale — naive
   * scalar sums over-subtract under any pair-overlap, the union is
   * the smallest fix.
   */
  awaitingApprovalIntervals: ReadonlyArray<readonly [number, number]>;
  transportDowntimeIntervals: ReadonlyArray<readonly [number, number]>;
  interruptInFlightIntervals: ReadonlyArray<readonly [number, number]>;
  /**
   * Per-tool-call start timestamps captured at `handleContentBlockStart`
   * (`kind: "tool_use"`), used by `handleToolResult` to compute the
   * matching `ToolUseMessage.toolWallMs`. Reducer-internal — never
   * exposed on the snapshot. Cleared on turn boundaries with the
   * rest of the per-turn state.
   */
  toolUseStartedAt: Map<string, number>;
  /**
   * Trigger metadata for the in-flight wake turn (`phase === "waking"`),
   * `null` otherwise. Set by `handleWakeStarted` from the wire
   * `wake_started.wake_trigger` payload; cleared by `handleTurnComplete`'s
   * `waking → idle` commit branch. Mirrored unchanged onto
   * `CodeSessionSnapshot.wakeTrigger` for stable `Object.is` identity
   * across quiescent snapshot rebuilds ([L02]).
   */
  wakeTrigger: WakeTrigger | null;
  /**
   * Session-lifetime background-jobs ledger behind the Z2 JOBS cell —
   * unlike `wakeTrigger` it is durable: rows accumulate across turns
   * and survive turn commits, cleared only by session reset or the
   * user's explicit Clear (`clear_jobs_action`, terminal rows only).
   * Lives in reducer state rather than as a fold over `toolCalls`
   * because the lifecycle events are not all tool calls (terminal
   * status arrives as system frames) and Clear must *forget* rows.
   * Mirrored unchanged onto `CodeSessionSnapshot.jobs` for stable
   * `Object.is` identity across quiescent rebuilds ([L02]). Replay
   * never populates it — see `handleToolResult`'s launch-insert guard.
   */
  jobs: readonly JobItem[];
  /**
   * The session's one `/goal` (claude allows one per session), or null.
   * Reduced from the user's own `/goal …` submissions, `goal_feedback`
   * frames, and the goal cycle's `turn_complete` — see `select-goal.ts`.
   * Live-only: replay never populates it; a respawn keeps it in-memory as
   * possibly-active. Mirrored unchanged onto `CodeSessionSnapshot.goal`
   * for stable `Object.is` identity across quiescent rebuilds ([L02]).
   */
  goal: GoalState | null;
}

/**
 * Replay-clock millisecond constants. Re-exported from
 * `code-session-store.ts` as the public surface; the reducer uses
 * them inline where it emits `schedule_timer` effects.
 *
 * - `REPLAY_SOFT_BUDGET_MS` — once `phase === "replaying"` has been
 *   held for this long without leaving, `replaySoftBudgetElapsed`
 *   flips true. Drives the count-aware banner copy per [D10].
 * - `REPLAY_TIMEOUT_DWELL_MS` — after a `replay_complete` carrying a
 *   `replay_timeout` outcome, `replayTimeoutDwellActive` stays true
 *   for this long so the user has a chance to read the failure copy
 *   before the banner dismisses.
 * - `REPLAY_PREFLIGHT_TIMEOUT_MS` — last-resort escape hatch for the
 *   preflight window: if `replay_started` somehow never lands (e.g.
 *   a tugcode that didn't run replay at all), the preflight banner
 *   dismisses on its own at this mark instead of hanging forever.
 *   Sized large enough to easily cover a normal cold boot's 5–10s
 *   wait while still bounding the worst case.
 * - `REPLAY_SILENCE_DEADLINE_MS` — how long `phase === "replaying"` may
 *   go without a wire frame before the card gives up on the bracket and
 *   raises `lastError` on itself (see {@link replaySilenceEffect}). It
 *   measures silence, never duration: every frame restarts it, and it is
 *   re-armed *after* a frame's ingest, so the deck's own synchronous work
 *   on a large `replay_batch` is never counted against it. What it has to
 *   clear is therefore the longest wait for tugcode's *next* frame. Chosen
 *   from `elapsed_ms` on `[dev::replay::complete]` across 3,907 recorded
 *   replays — the whole bracket, so an upper bound on any gap inside one:
 *   p99 579 ms, max 1,451 ms. 15 s is ten times the worst bracket ever
 *   seen and still inside a user's patience for a modal that cannot be
 *   dismissed.
 * - `REPLAY_BRACKET_DEADLINE_MS` — the absolute cap on a bracket, armed
 *   once when `phase` becomes `replaying` and never re-armed, so no
 *   amount of wire traffic can buy a bracket more of it. tugcast already
 *   caps a bracket at 120 s and synthesizes
 *   `replay_complete{replay_timeout}`, an honest close carrying an
 *   outcome the card can explain; where that frame can arrive it should
 *   win, so this sits above it. What it exists for is the cases where it
 *   cannot: a CODE_OUTPUT replay-ring overflow, a `replay_complete`
 *   dropped by `handleReplayComplete`'s own phase guard, a
 *   `request_replay` dropped before session init. 150 s costs one card's
 *   patience rather than the whole deck's ([P04]) — affordable only
 *   because the app-wide restore modal goes away in the same arc.
 */
export const REPLAY_SOFT_BUDGET_MS = 2000;
export const REPLAY_TIMEOUT_DWELL_MS = 1500;
export const REPLAY_PREFLIGHT_TIMEOUT_MS = 12_000;
export const REPLAY_SILENCE_DEADLINE_MS = 15_000;
export const REPLAY_BRACKET_DEADLINE_MS = 150_000;

/**
 * How long the deck waits for *any* answer to a stop before it stops
 * waiting. Sized just past tugcode's own escalation ladder:
 * `INTERRUPT_ACK_GRACE_MS` (2000) before it force-terminates, plus the
 * 1500 ms SIGINT grace before SIGKILL, plus headroom for the respawn —
 * so a ladder that runs to its end still beats this deadline and the
 * card settles on a real receipt rather than on a clock.
 *
 * Which is to say: with the `turn_cancelled` handler and tugcode's
 * `interrupt_noop` receipts both in place, this timer should never fire
 * ([B05]). It exists because the failure this arc came from *was* a
 * receipt that was supposed to be impossible to lose — the deck had no
 * horizon behind the protocol, so when the protocol went quiet the card
 * waited forever. A deadline that never fires is the cost of not needing
 * the protocol to be perfect.
 */
export const INTERRUPT_SILENCE_DEADLINE_MS = 6000;

/**
 * How long a live turn may go without a single stream event before the card
 * says so. Twenty seconds is chosen against the thing being measured rather
 * than against a feeling: `maxStreamGapMs` — the longest inter-event silence
 * inside a healthy turn — is the telemetry this deck already keeps, and a
 * long thinking block or a slow tool call sits well inside it. Twenty
 * seconds is past anything a working turn produces and well short of the
 * patience a user has for a screen that says nothing.
 *
 * **It is not an error and not a horizon.** Nothing is abandoned when it
 * fires: no `lastError` is stamped ([P05]), no turn is committed, Stop stays
 * live and deliverable. All that changes is that the card stops claiming to
 * be streaming and says it is waiting — which is the honest reading of a
 * turn whose far end has gone quiet, and the one the user on a plane needed
 * and did not get.
 */
export const STREAM_SILENCE_STALL_MS = 20_000;

/** Copy for the `replay_stalled` error the silence deadline raises. */
export const REPLAY_STALLED_MESSAGE =
  "The session stopped responding while it was being restored.";

/** Copy for the `replay_bracket_timeout` error the absolute cap raises. */
export const REPLAY_BRACKET_MESSAGE =
  "The session took too long to restore and was given up on.";

/** Copy for a stop that went unanswered past its deadline. */
export const INTERRUPT_STALLED_MESSAGE =
  "The session did not answer the stop request.";

/**
 * The frame types that belong to a replay bracket, and so are the only
 * ones that may restart the silence deadline ([P05]).
 *
 * The set is the replay translator's own output vocabulary
 * (`tugcode/src/replay.ts`) plus the two bracket markers the supervisor
 * adds and the live-tail turn frames a bracket can carry across its
 * close. Everything else on CODE_OUTPUT — `api_retry` above all, but also
 * `cost_update`, `streaming_usage`, `context_breakdown`, the task frames —
 * is chatter from a claude that is doing something other than replaying,
 * and a bracket that hears only chatter is a bracket that has stopped.
 *
 * `replay_batch` is here for completeness rather than for effect: it is a
 * transport envelope that `routeFrame` unwraps, so the reducer never sees
 * one, and each inner frame arms on its own account.
 *
 * A frame type added to the replay path and not added here silently loses
 * its right to buy time, so `code-session-store.replay-clock.test.ts`
 * asserts the partition against `KNOWN_CODE_OUTPUT_TYPES`.
 */
export const BRACKET_FRAME_TYPES: ReadonlySet<string> = new Set([
  // Bracket markers.
  "replay_started",
  "replay_batch",
  "replay_complete",
  "replay_stage",
  // Turn openers the replay translator emits.
  "add_user_message",
  "assistant_opener",
  "wake_started",
  // Turn content.
  "content_block_start",
  "assistant_text",
  "thinking_text",
  "tool_use",
  "tool_result",
  "tool_use_structured",
  "system_metadata",
  // Turn closers, including the live tail's cancel receipt.
  "turn_complete",
  "turn_cancelled",
  // Compaction dividers, emitted on the replay path as well as the live one.
  "compact_boundary",
  "compact_summary",
]);

/**
 * The silence deadline's arming rule, as a pure function of one
 * dispatch: the phase before it, the phase after it, whether the event
 * came off the wire, and which frame type it was.
 *
 * - entering `replaying` arms the timer, from any origin and any event;
 * - a wire frame in {@link BRACKET_FRAME_TYPES} ingested while
 *   `replaying` restarts it;
 * - leaving `replaying` — `replay_complete`, an error, either tick —
 *   disarms it;
 * - anything else leaves it alone: a local action, a timer tick inside
 *   the window, any event outside it, and — the fourth value, new to
 *   this arc — a wire frame that does not belong to the bracket.
 *
 * That fourth value is what makes `REPLAY_SILENCE_DEADLINE_MS`'s own
 * sizing argument true. It justifies 15 s as ten times the longest wait
 * for tugcode's *next replay frame* ever recorded — an argument about
 * bracket-borne frames that the old rule did not hold to, because it
 * restarted on any frame at all. A claude retrying a dead API emits
 * `api_retry` more often than every 15 s, so the deadline never expired
 * and the restore hung behind a modal until the user quit. The deadline
 * was not too generous; it was measuring the wrong silence.
 *
 * An event-armed timer on the thing being watched, not a poll. It depends
 * on no frame arriving: the case it exists for is the one where tugcast
 * never says anything again.
 */
export function replaySilenceEffect(
  prevPhase: CodeSessionState["phase"],
  nextPhase: CodeSessionState["phase"],
  fromWire: boolean,
  eventType: string,
): Effect | null {
  if (nextPhase !== "replaying") {
    return prevPhase === "replaying"
      ? { kind: "cancel_timer", name: "replay_silence" }
      : null;
  }
  if (prevPhase !== "replaying" || (fromWire && BRACKET_FRAME_TYPES.has(eventType))) {
    return {
      kind: "schedule_timer",
      name: "replay_silence",
      ms: REPLAY_SILENCE_DEADLINE_MS,
      fire: { type: "tick_replay_silence" },
    };
  }
  return null;
}

/**
 * The bracket cap's arming rule, and deliberately the simpler of the two:
 * schedule on the transition **into** `replaying`, cancel on the
 * transition out, `null` otherwise. It reads neither the origin nor the
 * event, because nothing that happens inside a bracket is allowed to
 * change when the bracket ends — that is the whole of what "absolute"
 * means here, and expressing it as one pure function of the two phases is
 * what keeps a later caller from re-arming it by accident.
 */
export function replayBracketEffect(
  prevPhase: CodeSessionState["phase"],
  nextPhase: CodeSessionState["phase"],
): Effect | null {
  if (nextPhase === "replaying") {
    return prevPhase === "replaying"
      ? null
      : {
          kind: "schedule_timer",
          name: "replay_bracket",
          ms: REPLAY_BRACKET_DEADLINE_MS,
          fire: { type: "tick_replay_bracket" },
        };
  }
  return prevPhase === "replaying"
    ? { kind: "cancel_timer", name: "replay_bracket" }
    : null;
}

/**
 * The interrupt deadline's arming rule, in the shape the two replay
 * rules establish: a pure function of the flag before a dispatch and
 * the flag after it. Arm when `interruptInFlight` rises — which is
 * exactly `handleInterrupt`'s CASE B, the one place it rises — and
 * cancel when it falls, which is exactly every way an interrupt can
 * end.
 *
 * Written this way rather than as a literal in each handler because
 * the flag falls at more than a dozen returns: three in
 * `handleTurnComplete`, the queue-flush path, `handleTurnCancelled`,
 * `handleInterruptNoop`, the wake and notice openers, and all six
 * terminals through `enterErrored`. That is the shape `enterErrored`
 * itself was written for in this arc — a clear whose sole performer
 * was one handler is what produced the defect the arc started from —
 * and a cancel that has to be remembered at fourteen returns is the
 * same bet, made again. Here it cannot be forgotten: the timer's life
 * is tied to the flag's, by construction.
 *
 * The tick itself clears the flag, so a fired timer earns a cancel for
 * a timer that has already gone. That is a no-op at the wrapper, and
 * cheaper than a special case.
 */
export function interruptSilenceEffect(
  prevInFlight: boolean,
  nextInFlight: boolean,
): Effect | null {
  if (prevInFlight === nextInFlight) return null;
  return nextInFlight
    ? {
        kind: "schedule_timer",
        name: "interrupt_silence",
        ms: INTERRUPT_SILENCE_DEADLINE_MS,
        fire: { type: "tick_interrupt_silence" },
      }
    : { kind: "cancel_timer", name: "interrupt_silence" };
}

/**
 * The phases in which a stream stall is a meaningful thing to watch for: a
 * turn is open and the far end owes content.
 *
 * Deliberately narrower than {@link isLiveTurnPhase}, which answers a
 * different question — "is there a turn a terminal would have to kill" —
 * and counts `awaiting_approval` for exactly the reason this one does not.
 *
 * `awaiting_approval` is deliberately out. A turn parked on a permission
 * dialog is silent *because the user has not answered*, and reporting that
 * as a network stall would blame the wire for the one wait the user is
 * themselves holding up. `replaying` is out too — a bracket has its own two
 * deadlines, and a second reading over the top of them would say the same
 * thing twice in a different register.
 */
function isStallWatchedPhase(phase: CodeSessionState["phase"]): boolean {
  return (
    phase === "submitting" ||
    phase === "awaiting_first_token" ||
    phase === "streaming" ||
    phase === "tool_work" ||
    phase === "waking"
  );
}

/**
 * The stall timer's arming rule, in `replaySilenceEffect`'s shape and for
 * the same reason: a pure function returning the one effect, so the schedule
 * is written once and read at each call site rather than inlined four times.
 *
 * Emitted by the four handlers that fold a live stream event, with the phase
 * the dispatch is landing in. Every stream event restarts it — a
 * `schedule_timer` with a live name cancels the prior one at the wrapper —
 * so the timer measures the gap since the last event, which is exactly what
 * it claims to measure. Event-armed on the thing being watched, never a poll
 * ([P11]).
 *
 * A fold that lands outside a live turn cancels instead of arming, so the
 * one rule covers both directions.
 */
export function streamStallEffect(phase: CodeSessionState["phase"]): Effect {
  return isStallWatchedPhase(phase)
    ? {
        kind: "schedule_timer",
        name: "stream_stall",
        ms: STREAM_SILENCE_STALL_MS,
        fire: { type: "tick_stream_stall" },
      }
    : { kind: "cancel_timer", name: "stream_stall" };
}

/**
 * The stall timer's *cancel* rule — a transition on the phase, armed in the
 * store wrapper beside the other three.
 *
 * The arming rule above cannot carry this half: it is only consulted when a
 * stream event lands, and the endings that matter are the ones where no
 * further stream event ever comes — a `turn_complete`, a terminal, a
 * transport loss, a dialog opening. Leaving those to be remembered at each
 * handler is the exact bet this arc exists to stop making, so the rule is
 * written once as a function of the phase before a dispatch and the phase
 * after it.
 *
 * `enterErrored` clears the *flag* on its own, because a card that has
 * errored must not still read "Waiting"; this cancels the timer
 * behind it.
 */
export function streamStallCancelEffect(
  prevPhase: CodeSessionState["phase"],
  nextPhase: CodeSessionState["phase"],
): Effect | null {
  if (!isStallWatchedPhase(prevPhase) || isStallWatchedPhase(nextPhase)) {
    return null;
  }
  return { kind: "cancel_timer", name: "stream_stall" };
}

/** Build the initial state for a freshly constructed store. */
export function createInitialState(
  tugSessionId: string,
  displayLabel: string,
  sessionMode: CardSessionMode,
): CodeSessionState {
  return {
    phase: "idle",
    transportState: "online",
    tugSessionId,
    displayLabel,
    sessionMode,
    activeMsgId: null,
    rewindPreviews: new Map(),
    lastRewindResult: null,
    pendingRewindDraft: null,
    scratch: new Map(),
    pendingApproval: null,
    pendingQuestion: null,
    prevPhase: null,
    pendingTurn: null,
    pendingDraftRestore: null,
    pendingCommandInsert: null,
    pendingJotInsert: null,
    pendingAtomInsert: null,
    pendingFileInsert: null,
    pendingCaseAEchoes: 0,
    queuedSends: [],
    lastError: null,
    lastCost: null,
    apiRetry: null,
    refusalFallback: null,
    outputTruncated: false,
    unknownEvent: null,
    compactionSeed: null,
    permissionDenials: [],
    sessionInitTokens: null,
    lastContextBreakdown: null,
    committedMsgIds: new Set(),
    lastReplayResult: null,
    replayEverCompleted: false,
    replayWindow: null,
    sessionCreatedAtMs: null,
    replayPrependActive: false,
    replayPreflightActive: false,
    replaySoftBudgetElapsed: false,
    replayTimeoutDwellActive: false,
    awaitingApprovalSince: null,
    awaitingApprovalAccumulatedMs: 0,
    transportNonOnlineSince: null,
    transportDowntimeAccumulatedMs: 0,
    transportReconnectCount: 0,
    lastStreamEventAt: null,
    maxStreamGapMs: 0,
    firstAssistantDeltaAt: null,
    firstToolUseAt: null,
    costAtSubmit: null,
    interruptInFlight: false,
    pendingInterruptReason: null,
    interruptInFlightSegmentStartedAt: null,
    stopStalled: false,
    streamStalled: false,
    awaitingApprovalIntervals: [],
    transportDowntimeIntervals: [],
    interruptInFlightIntervals: [],
    toolUseStartedAt: new Map(),
    wakeTrigger: null,
    jobs: EMPTY_JOBS_LEDGER,
    goal: null,
  };
}

// ---------------------------------------------------------------------------
// Transition handlers
// ---------------------------------------------------------------------------

/**
 * The notice origin that names the wheel — the one sender of an injected
 * submission that is a participant in the transcript rather than an anonymous
 * subsystem. Matches `WHEEL_NOTICE_ORIGIN` in tugcast's arc runner, which is
 * what puts it on the wire.
 */
const WHEEL_NOTICE_ORIGIN = "wheel";

/**
 * Who wrote a submission: the sender the event names, else the user.
 *
 * One reading for every mint site, so a `UserMessage`'s attribution is a fact
 * about the submission rather than about the turn it comes to rest in.
 */
function senderOrigin(origin: "user" | "wheel" | undefined): "user" | "wheel" {
  return origin === "wheel" ? "wheel" : "user";
}

/**
 * Should this submission be **held** for the network rather than sent ([P10])?
 *
 * Two readings, and both of them are negatives — which is the whole design.
 * The card's `stalled` overlay means claude has already told us a connection
 * failure is in progress, or a live turn has gone silent past its deadline.
 * `pathUnsatisfied` means the host has no route at all. Neither is a guess:
 * each is something that has already failed.
 *
 * There is deliberately no positive test anywhere. A submission is sent unless
 * one of these two negatives is standing, because `satisfied` is what a
 * captive portal reports while answering everything with its login page — a
 * send gated on it would be gated on the one reading that lies.
 */
function shouldHoldSubmission(
  state: CodeSessionState,
  event: SendActionEvent,
): boolean {
  return isNetworkStalled(state) || event.pathUnsatisfied === true;
}

/**
 * Drop the hold from every entry, returning the same array reference when
 * nothing was held — so a proving event on an ordinary queue costs no
 * snapshot churn and no re-render ([L02]).
 *
 * Release is a state change and never a send: what puts the released head on
 * the wire is the flush path that was already going to run.
 */
function releaseHeldSends(
  sends: CodeSessionState["queuedSends"],
): CodeSessionState["queuedSends"] {
  if (!sends.some((s) => s.held)) return sends;
  return sends.map((s) => (s.held ? { ...s, held: false } : s));
}

/** True when the queue's head is waiting on the network — no flush may take it. */
function headIsHeld(state: CodeSessionState): boolean {
  return state.queuedSends.length > 0 && state.queuedSends[0].held;
}

/**
 * The state with every hold released — handed to a flush at a proving
 * boundary so the released head is the one the flush picks up.
 */
function withHeldReleased(state: CodeSessionState): CodeSessionState {
  const sends = releaseHeldSends(state.queuedSends);
  return sends === state.queuedSends ? state : { ...state, queuedSends: sends };
}

function handleSend(
  state: CodeSessionState,
  event: SendActionEvent,
): { state: CodeSessionState; effects: Effect[] } {
  // Submit is gated to idle/errored. While replaying, submit is
  // refused at the snapshot level (`canSubmit: false`); the reducer
  // drops the action defensively in case a UI race fires `send`
  // anyway. The queue is also bypassed — a queued message that
  // commits after replay completes would surprise the user with a
  // dispatch they don't remember initiating.
  if (state.phase === "replaying") {
    return { state, effects: [] };
  }

  // A submission the network cannot carry is held rather than sent or
  // refused ([B14]): it enters the same FIFO a mid-turn submit enters, with
  // `held` set, and waits there for a proving event. The composer is never
  // blocked and the words are never lost — holding is the third answer
  // between sending into a dead path and telling the user no.
  const held = shouldHoldSubmission(state, event);

  if (!held && (state.phase === "idle" || state.phase === "errored")) {
    const submitAt = Date.now();
    const userMessage: UserMessage = {
      kind: "user_message",
      messageKey: userMessageKey(event.turnKey),
      createdAt: submitAt,
      text: event.text,
      attachments: event.atoms,
      origin: senderOrigin(event.origin),
      submitAt,
    };
    const next: CodeSessionState = {
      ...state,
      phase: "submitting",
      pendingTurn: {
        turnKey: event.turnKey,
        submitAt,
        origin: event.origin ?? "user",
        suppressed: event.suppress === true,
      },
      // Seed the scratch with the opening user_message so the
      // substrate carries the user submission as its first Message
      // (no separate paired field). Wire-derived assistant content
      // mints into the same scratch entry as `content_block_start`
      // events arrive.
      scratch: withScratchEntry(
        state.scratch,
        event.turnKey,
        newScratchEntry(event.turnKey, [userMessage]),
      ),
      // The user is moving on to a new turn. The prompt-entry editor
      // consumes `pendingDraftRestore` synchronously via
      // `useLayoutEffect` before user input is possible, so by the
      // time `send` fires the restore slot is moot — clear it for
      // cleanliness.
      //
      // `pendingCaseAEchoes` is deliberately NOT cleared here:
      // outstanding aborted-cycle echoes are still in flight on the
      // wire and must be matched against their respective suppression
      // slots. Wire FIFO ordering guarantees those echoes arrive
      // before any frame from this new cycle, so the counter drains
      // naturally as `handleTurnComplete`'s gate fires.
      pendingDraftRestore: null,
      // Snapshot the cost cursor so the per-turn delta is computed
      // against this submit point at completion. `null` on the first
      // turn of a session is fine — `extractTurnCost` degenerates the
      // delta to `after`.
      costAtSubmit: state.lastCost,
      // A `/goal …` submission sets / clears the session goal; every
      // other send leaves it untouched (see select-goal.ts).
      goal: reduceGoalOnSend(
        state.goal,
        commandLineFromSend(event.text, event.atoms, TUG_ATOM_CHAR),
        submitAt,
        event.turnKey,
      ),
      // Reset per-turn accumulators. `transportNonOnlineSince` is
      // owned by the transport handlers — leave it alone so a
      // disconnect that started before this submit still folds into
      // the turn correctly. The new per-turn interval arrays + the
      // interrupt segment-start ARE reset here (canSubmit gating
      // ensures the wire is online at submit time, so no
      // transport-downtime segment can carry over the boundary in a
      // way the next turn cares about; the array projection is
      // strictly per-turn).
      awaitingApprovalSince: null,
      awaitingApprovalAccumulatedMs: 0,
      transportDowntimeAccumulatedMs: 0,
      transportReconnectCount: 0,
      lastStreamEventAt: null,
      maxStreamGapMs: 0,
      firstAssistantDeltaAt: null,
      firstToolUseAt: null,
      interruptInFlight: false,
      pendingInterruptReason: null,
      interruptInFlightSegmentStartedAt: null,
      // A new turn is not the turn whose stop went unanswered.
      stopStalled: false,
      // Nor the turn that went quiet. The submit is itself the stream event
      // the previous turn stopped producing.
      streamStalled: false,
      awaitingApprovalIntervals: [],
      transportDowntimeIntervals: [],
      interruptInFlightIntervals: [],
    };
    return {
      state: next,
      effects: [
        {
          kind: "send-frame",
          msg: {
            type: "user_message",
            // Anthropic-API content-block array built by
            // `buildWirePayload` in the store wrapper before
            // dispatch. The substrate's `UserMessage` retains the
            // synthesized `(text, atoms)` pair so the transcript chip
            // renderer can paint chips at the original positions.
            // Per [Step 5c].
            content: event.content,
          },
        },
      ],
    };
  }

  // Mid-turn send — enqueue. The queue is speculative: a single
  // entry flushes at `turn_complete(success)` via the single-tick
  // collapse in `handleTurnComplete`; `interrupt()` clears it.
  // The queued entry carries both the wire content blocks (for the
  // send-frame at flush time) and the already-synthesized substrate
  // (so the flush mints the new turn's `UserMessage` without
  // re-running the synthesizer at the reducer layer).
  const queuedSends = [
    ...state.queuedSends,
    {
      content: event.content,
      text: event.text,
      atoms: [...event.atoms],
      turnKey: event.turnKey,
      // The sender, not the turn it lands in.
      origin: senderOrigin(event.origin),
      // Submission time, stamped here rather than at the flush: this is
      // the moment the user posted, which is what the row's timestamp
      // shows and what its position among shell rows sorts on.
      queuedAt: Date.now(),
      // Waiting for the network, or merely for the turn ahead of it. An
      // idle card only ever reaches this enqueue when `held` is true.
      held,
    },
  ];
  return { state: { ...state, queuedSends }, effects: [] };
}

/**
 * Read the in-flight turn's `user_message` text + attachments, if
 * present. Returns `null` for a wake turn (no user_message Message at
 * head) or when no turn is in flight. Used by `handleInterrupt`'s
 * CASE A capture and by anywhere that needs the in-flight user
 * submission's payload.
 */
function readInflightUserMessage(state: CodeSessionState): UserMessage | null {
  const turnKey = state.pendingTurn?.turnKey;
  if (turnKey === undefined) return null;
  const entry = state.scratch.get(turnKey);
  if (entry === undefined) return null;
  const head = entry.messages[0];
  if (head !== undefined && head.kind === "user_message") return head;
  return null;
}

/**
 * Drop the in-flight turn's scratch entry. Returns a fresh scratch
 * Map with the entry removed (other turns' entries reference-stable).
 */
function withoutPendingTurnScratch(
  state: CodeSessionState,
): Map<string, ScratchEntry> {
  const turnKey = state.pendingTurn?.turnKey;
  if (turnKey === undefined) return new Map(state.scratch);
  const next = new Map(state.scratch);
  next.delete(turnKey);
  return next;
}

function handleInterrupt(
  state: CodeSessionState,
  reason?: InterruptReason,
): { state: CodeSessionState; effects: Effect[] } {
  // Idle / errored: no in-flight turn to interrupt. Drop silently so
  // accidental calls from stale UI state don't spam the server with
  // noop interrupt frames.
  if (state.phase === "idle" || state.phase === "errored") {
    return { state, effects: [] };
  }

  // CASE A — interrupt fired before claude produced any answer-channel
  // content: no `assistant_text` delta and no `tool_use` yet
  // (`firstAssistantDeltaAt === null && firstToolUseAt === null`). The
  // dividing line between A and B is the first *answer* — thinking
  // does NOT cross it: a turn that has emitted only `thinking_text` is
  // still a clean pull-down, because thinking is not an answer and
  // there is nothing committable as an interrupted `TurnEntry`. (Phase
  // cannot express this line — `submitting → awaiting_first_token →
  // streaming` is a text-event count ladder driven identically by
  // `assistant_text` and `thinking_text`, so `phase` advances on
  // thinking alone; `firstAssistantDeltaAt` / `firstToolUseAt` are the
  // real "answer has begun" signals.) The user's intent is "pull it
  // back and re-edit" — capture the user submission into a one-shot
  // restore slot, drop the in-flight scratch so the transcript stops
  // rendering it, and return the phase to `idle` so the user can
  // resubmit immediately without waiting for the wire's
  // `turn_complete(error)` round-trip.
  //
  // Wire echo handling: increment `pendingCaseAEchoes` so the matching
  // `turn_complete(error)` is suppressed by the gate at the top of
  // `handleTurnComplete`. That gate keys on `state.activeMsgId ===
  // null` — which the reset below establishes — NOT on the echo's
  // `msg_id`, so it suppresses correctly whether the aborted cycle
  // carried no `msg_id` (the not-yet-started case, `msg_id: ""` —
  // verified via `tugcode/probe-case-a.ts`) or a real one (the
  // thinking-only case, where a `thinking_text` partial had already
  // bound `activeMsgId`). The counter (rather than a boolean) makes
  // back-to-back CASE A cancels and re-submit-before-echo races
  // correct: each abort claims its own pending suppression slot,
  // decremented in FIFO order as wire echoes arrive. Late content
  // frames hit their own phase guards and drop with phase `idle` —
  // no scratch leakage.
  // CASE A's precondition is really "claude has not started, so the turn can
  // be pulled back whole." The content flags are a PROXY for that, and a
  // compaction turn is the one place the proxy inverts: `/compact` streams no
  // answer-channel content for its entire run by design — minutes, on a full
  // context — so it satisfies every CASE A test while being the least
  // retractable turn there is. Claude Code is rewriting the session's context
  // in place; it does not reliably abort mid-run (observed: a canceled
  // compaction ran on to completion and wrote its boundary 2m39s later); and
  // the `compact_boundary` + summary it writes land AFTER the prompt record
  // that CASE A's `retract: true` truncates the JSONL at. Taking CASE A there
  // erases a turn locally — scratch dropped, wire echo suppressed, draft
  // stranded back in the composer — while the far end works on, and the
  // compaction then exists on disk and nowhere in the card until a reload
  // replays it.
  //
  // So a compaction interrupt is CASE B whatever the content flags say. The
  // turn stays open, the interrupt goes out plain (no retract), and both
  // resolutions are honest: the boundary lands on the still-open turn and
  // commits with it, or `turn_complete(error)` commits an interrupted entry.
  // Nothing is discarded locally while the far end may still be running.
  const inflightUserMessage = readInflightUserMessage(state);
  const inflightIsCompaction =
    inflightUserMessage !== null &&
    isCompactionSubmission(
      inflightUserMessage.text,
      inflightUserMessage.attachments,
    );

  if (
    !inflightIsCompaction &&
    state.firstAssistantDeltaAt === null &&
    state.firstToolUseAt === null
  ) {
    // An assistant-originated in-flight turn (a wake, or an orphan
    // continuation) has no user submission (S01), so there is nothing to
    // route into the restore slot — and its wake bracket (if any) clears.
    // A user turn keeps its stranded draft. This rides the turn's `origin`,
    // not a wake-specific flag.
    const inflightIsAssistantOrigin =
      state.pendingTurn?.origin === "assistant";
    // A suppressed turn is an internal detail — never strand its text in
    // the composer on cancel.
    const inflightSuppressed = state.pendingTurn?.suppressed === true;
    const inflightUser =
      inflightIsAssistantOrigin || inflightSuppressed
        ? null
        : inflightUserMessage;
    const restore =
      inflightUser !== null
        ? { text: inflightUser.text, atoms: inflightUser.attachments }
        : state.pendingDraftRestore;
    return {
      state: {
        ...state,
        phase: "idle",
        activeMsgId: null,
        scratch: withoutPendingTurnScratch(state),
        toolUseStartedAt: new Map(),
        pendingTurn: null,
        pendingDraftRestore: restore,
        // An assistant-origin pull-down clears the wake bracket marker —
        // the wire echo (`turn_complete(error)`) will arrive later and is
        // suppressed by `pendingCaseAEchoes` below, same as a normal CASE A
        // user pull-down. (For a non-wake orphan, `wakeTrigger` is already
        // null, so this is a no-op there.)
        wakeTrigger: inflightIsAssistantOrigin ? null : state.wakeTrigger,
        pendingCaseAEchoes: state.pendingCaseAEchoes + 1,
        pendingApproval: null,
        pendingQuestion: null,
        prevPhase: null,
        queuedSends: [],
        // CASE A is locally terminal — phase goes straight to idle and
        // no TurnEntry will commit (the wire echo is suppressed).
        // Reset all per-turn accumulators here so a subsequent send
        // starts fresh; do NOT set interruptInFlight (the UI never
        // sees an INTERRUPTING state for CASE A — it's instant).
        awaitingApprovalSince: null,
        awaitingApprovalAccumulatedMs: 0,
        lastStreamEventAt: null,
        maxStreamGapMs: 0,
        streamStalled: false,
        firstAssistantDeltaAt: null,
        firstToolUseAt: null,
        // Transport-downtime accumulator is bounded to the active
        // turn boundary; reset on CASE A so a transport blip during
        // an aborted submit doesn't leak into the next turn.
        transportDowntimeAccumulatedMs: 0,
        transportReconnectCount: 0,
        // `transportNonOnlineSince` is owned by the transport
        // handlers; leave it as-is so an in-progress disconnect that
        // outlasts the abort still folds into the next turn correctly.
        // `costAtSubmit` is moot on CASE A (no commit); reset for
        // cleanliness.
        costAtSubmit: null,
        interruptInFlight: false,
        // CASE A commits no TurnEntry, so there is no row to carry a
        // logout marker — clear it for cleanliness.
        pendingInterruptReason: null,
        // Per-turn interval projections: clear alongside the scalar
        // accumulators so the next turn starts with empty pause
        // history. CASE A doesn't open an interrupt segment (the UI
        // never sees an INTERRUPTING state for a no-content abort),
        // so `interruptInFlightSegmentStartedAt` is already null
        // here — written explicitly for invariant clarity.
        interruptInFlightSegmentStartedAt: null,
        awaitingApprovalIntervals: [],
        transportDowntimeIntervals: [],
        interruptInFlightIntervals: [],
      },
      effects: [
        // A user-origin pull-down is a retraction: the row already left
        // the local transcript and the draft is back in the composer, so
        // the prompt must also leave claude's history — `retract: true`
        // has tugcode truncate the session JSONL at the prompt record and
        // silently respawn once the interrupt's echo lands. Without it
        // the SDK keeps the prompt in context (with an
        // `"[Request interrupted by user]"` marker) and a reload replays
        // it as a phantom user row. Assistant-origin (wake) and suppressed
        // turns carry no user submission to retract — they interrupt plain.
        // A compaction never reaches here at all (it takes CASE B above),
        // which is what keeps a truncation off a JSONL claude may be
        // appending a `compact_boundary` to.
        {
          kind: "send-frame",
          msg:
            inflightUser !== null
              ? { type: "interrupt", retract: true }
              : { type: "interrupt" },
        },
        // `clear-inflight` is a no-op under the per-turn-paths
        // streaming architecture (each turn writes its own
        // `turn.${turnKey}.*` paths). The in-flight pair stops
        // rendering because `pendingTurn` is now `null`; a
        // thinking-only pull-down's per-turn streaming paths are simply
        // never read again — the next turn mints a fresh `turnKey`.
        // The effect is still emitted for turn-boundary symmetry with
        // `handleTurnComplete`.
        { kind: "clear-inflight" },
      ],
    };
  }

  // CASE B — interrupt fired after claude produced at least one
  // content frame (`activeMsgId` is set, scratch may hold partial
  // text/thinking/tool-use content). The wire's eventual
  // `turn_complete(result: "error")` commits a `TurnEntry` with
  // `result: "interrupted"` carrying whatever has accumulated.
  //
  // Interrupting from `awaiting_approval` must also abandon the
  // approval prompt: the `interrupt` frame dooms the turn, but the
  // following `turn_complete(error)` is a round-trip away. Between
  // those two moments the UI would otherwise see `pendingApproval`
  // still set and `phase === "awaiting_approval"`, which reads as a
  // live prompt on a dead turn. Clear pending + restore to the pre-
  // approval phase so subscribers observe a coherent
  // "interrupted-tool-work" state until `turn_complete(error)` lands.
  const restoredPhase =
    state.phase === "awaiting_approval"
      ? state.prevPhase ?? "streaming"
      : state.phase;

  // CASE B: the wire's eventual `turn_complete(error)` commits an
  // interrupted entry. Set `interruptInFlight` so the UI can show
  // an INTERRUPTING state during the round-trip; `handleTurnComplete`
  // clears it. Open the interrupt-in-flight segment at this same
  // instant so live-derivation can pause the in-flight active clock
  // for the round-trip's duration (the segment closes at
  // `handleTurnComplete` and the closed `[start, end]` pair lands on
  // `interruptInFlightIntervals`). If we were paused on a dialog,
  // fold the in-progress awaiting interval into the accumulator so
  // the committed entry reports the full time the user waited.
  const interruptOpenedAt = Date.now();
  return {
    state: {
      ...state,
      phase: restoredPhase,
      pendingApproval: null,
      pendingQuestion: null,
      prevPhase: null,
      queuedSends: [],
      interruptInFlight: true,
      // Bridge the interrupt reason across the round-trip: the interrupted
      // TurnEntry is committed later at `turn_complete`, so stash it here
      // for `buildTurnEntry` to read (cleared in `handleTurnComplete`).
      pendingInterruptReason: reason ?? null,
      interruptInFlightSegmentStartedAt: interruptOpenedAt,
      ...closeAwaitingApprovalInterval(state, interruptOpenedAt),
    },
    // The deadline is armed by the store wrapper off this state's rising
    // `interruptInFlight` — see `interruptSilenceEffect`.
    effects: [{ kind: "send-frame", msg: { type: "interrupt" } }],
  };
}

function handleConsumeDraftRestore(
  state: CodeSessionState,
): { state: CodeSessionState; effects: Effect[] } {
  // Idempotent — return the same state ref when the slot is already
  // null so the dispatch loop sees no change and skips the listener
  // notification. Callers can safely fire `consume_draft_restore` from
  // a `useLayoutEffect` keyed on `pendingDraftRestore` identity
  // without worrying about a notification storm.
  if (state.pendingDraftRestore === null) {
    return { state, effects: [] };
  }
  return {
    state: { ...state, pendingDraftRestore: null },
    effects: [],
  };
}

function handleInsertCommandDraft(
  state: CodeSessionState,
  event: InsertCommandDraftActionEvent,
): { state: CodeSessionState; effects: Effect[] } {
  return {
    state: {
      ...state,
      pendingCommandInsert: {
        name: event.name,
        args: event.args,
        submit: event.submit,
      },
    },
    effects: [],
  };
}

function handleConsumeCommandInsert(
  state: CodeSessionState,
): { state: CodeSessionState; effects: Effect[] } {
  // Idempotent — ref-stable no-op when the slot is already null, so the
  // prompt entry's seeding `useLayoutEffect` can fire this without a
  // notification storm (mirrors `handleConsumeDraftRestore`).
  if (state.pendingCommandInsert === null) {
    return { state, effects: [] };
  }
  return {
    state: { ...state, pendingCommandInsert: null },
    effects: [],
  };
}

function handleInsertJot(
  state: CodeSessionState,
  event: InsertJotActionEvent,
): { state: CodeSessionState; effects: Effect[] } {
  return {
    state: {
      ...state,
      pendingJotInsert: {
        text: event.text,
        atoms: event.atoms,
        at: event.at,
      },
    },
    effects: [],
  };
}

function handleConsumeJotInsert(
  state: CodeSessionState,
): { state: CodeSessionState; effects: Effect[] } {
  // Idempotent — ref-stable no-op when the slot is already null.
  if (state.pendingJotInsert === null) {
    return { state, effects: [] };
  }
  return {
    state: { ...state, pendingJotInsert: null },
    effects: [],
  };
}

function handleInsertAtomDraft(
  state: CodeSessionState,
  event: InsertAtomDraftActionEvent,
): { state: CodeSessionState; effects: Effect[] } {
  return {
    state: { ...state, pendingAtomInsert: event.segment },
    effects: [],
  };
}

function handleConsumeAtomInsert(
  state: CodeSessionState,
): { state: CodeSessionState; effects: Effect[] } {
  // Idempotent — ref-stable no-op when the slot is already null.
  if (state.pendingAtomInsert === null) {
    return { state, effects: [] };
  }
  return {
    state: { ...state, pendingAtomInsert: null },
    effects: [],
  };
}

function handleInsertFiles(
  state: CodeSessionState,
  event: InsertFilesActionEvent,
): { state: CodeSessionState; effects: Effect[] } {
  return {
    state: { ...state, pendingFileInsert: event.files },
    effects: [],
  };
}

function handleConsumeFileInsert(
  state: CodeSessionState,
): { state: CodeSessionState; effects: Effect[] } {
  // Idempotent — ref-stable no-op when the slot is already null.
  if (state.pendingFileInsert === null) {
    return { state, effects: [] };
  }
  return {
    state: { ...state, pendingFileInsert: null },
    effects: [],
  };
}

/**
 * Cancel one queued send, identified by the `turnKey` its ghost row
 * carries. The send was queued mid-turn but never dispatched, so
 * removing it is a pure local edit — no wire frame. The un-sent
 * prompt routes back through `pendingDraftRestore`; the prompt-entry
 * seeds the editor from it iff the editor is empty (a cancel never
 * clobbers in-progress content). A no-op when the `turnKey` is no
 * longer queued — it flushed first, racing the cancel.
 */
function handleCancelQueuedSend(
  state: CodeSessionState,
  event: CancelQueuedSendActionEvent,
): { state: CodeSessionState; effects: Effect[] } {
  const target = state.queuedSends.find((q) => q.turnKey === event.turnKey);
  if (target === undefined) {
    return { state, effects: [] };
  }
  return {
    state: {
      ...state,
      queuedSends: state.queuedSends.filter(
        (q) => q.turnKey !== event.turnKey,
      ),
      pendingDraftRestore: { text: target.text, atoms: target.atoms },
    },
    effects: [],
  };
}

function handleSessionInit(
  state: CodeSessionState,
  _event: SessionInitEvent,
): { state: CodeSessionState; effects: Effect[] } {
  // Tugdeck uses a single session id (`tugSessionId`, chosen by the
  // picker and known from CodeSessionStore construction) for
  // everything user-facing — history keys, picker matching, the
  // sessions record. Claude's `session_init.session_id` is verified to
  // equal `tugSessionId` by the lifecycle log on the wire side; if they
  // ever diverge it's a tugcast/tugcode bug, not something React state
  // has to mirror.
  //
  // The one state mutation: stale-mark the jobs ledger. `session_init`
  // means a fresh claude subprocess (tugcode forwards only a
  // subprocess's FIRST init; re-inits route to the wake detector), and
  // a respawned claude cannot have carried background tasks across —
  // rows still `running` are dead, and a `scheduled` wakeup will not
  // re-fire after `--resume` (an upstream harness limitation), so both
  // flip to `stopped` rather than pulsing forever.
  const jobs = markRunningJobsStopped(state.jobs, Date.now());
  if (jobs === state.jobs) {
    return { state, effects: [] };
  }
  return { state: { ...state, jobs }, effects: [] };
}

/**
 * Update the stream-gap accumulator from a live stream event landing at
 * `now`. Replay events should NOT call this — replay does not
 * correspond to wall-clock event arrival. Returns the patch to fold
 * into the next state.
 *
 * A live stream event is also the signal that any retry the banner was
 * mirroring has *recovered*: claude's SDK only resumes streaming once a
 * retried request succeeds. The per-turn clear (`handleCostUpdate` /
 * `resetPerTurnTelemetry`) fires at turn end, which leaves the banner
 * stuck for the rest of a turn that retried and then picked back up
 * mid-stream. Clearing `apiRetry` here dismisses it the instant content
 * flows again. A subsequent failure re-announces a fresh `api_retry`,
 * so this never races a still-failing turn.
 *
 * That clear is also, for free, the recovery half of the `stalled` overlay's
 * connection arm: the overlay is raised by an `api_retry` whose category is
 * `connection`, and clearing `apiRetry` here drops it the instant content
 * flows again. So both arms of the overlay — the retry announcement and
 * `streamStalled` right below — fall through this one function, and neither
 * needs a clear of its own anywhere else. Do not add one.
 */
function foldStreamEvent(
  state: CodeSessionState,
  now: number,
): {
  lastStreamEventAt: number;
  maxStreamGapMs: number;
  apiRetry: ApiRetryState | null;
  streamStalled: false;
} {
  if (state.lastStreamEventAt === null) {
    return {
      lastStreamEventAt: now,
      maxStreamGapMs: state.maxStreamGapMs,
      apiRetry: null,
      streamStalled: false,
    };
  }
  const gap = Math.max(0, now - state.lastStreamEventAt);
  return {
    lastStreamEventAt: now,
    maxStreamGapMs: gap > state.maxStreamGapMs ? gap : state.maxStreamGapMs,
    apiRetry: null,
    streamStalled: false,
  };
}

// ---------------------------------------------------------------------------
// Message-sequence handlers ([D07])
// ---------------------------------------------------------------------------

/**
 * Phases in which wire events that mint or mutate Messages are
 * accepted. Matches the previous `handleTextDelta` / `handleToolUse`
 * guard surface. `submitting` / `awaiting_first_token` / `streaming`
 * are normal live progression; `tool_work` admits text and tool
 * follow-ups within an active tool-loop iteration; `replaying` /
 * `waking` are the two bracket phases ([D01]).
 */
function isContentBearingPhase(phase: CodeSessionPhase): boolean {
  return (
    phase === "submitting" ||
    phase === "awaiting_first_token" ||
    phase === "streaming" ||
    phase === "tool_work" ||
    phase === "replaying" ||
    phase === "waking"
  );
}

/**
 * `content_block_start` mint — idempotent per [D07]. The reducer
 * looks up `${msg_id}:${block_index}` in the active turn's
 * `blockIndex`; if already present, no-op (the live path minted, and
 * a snapshot replay is re-emitting the same envelope). Otherwise
 * mints a Message of the given `kind`, appends to the scratch
 * `messages` array, and indexes it. For `kind: "tool_use"` also
 * indexes by `tool_use_id` so subsequent tool events resolve in O(1).
 *
 * `handleContentBlockStart` does NOT advance the phase ladder —
 * `submitting → awaiting_first_token → streaming` advances on the
 * first text/tool delta, NOT on block-open ([D07] § Phase machine).
 * Block-open is metadata; the first delta is the first user-visible
 * event.
 */
function handleContentBlockStart(
  state: CodeSessionState,
  event: ContentBlockStartEvent,
): { state: CodeSessionState; effects: Effect[] } {
  // Background-agent child opening its block. The call's identity and
  // its input arrive as two separate events (`content_block_start`
  // opens, `tool_use` fills); the fill for a job-owned child routes to
  // the job ledger in `handleToolUse`, so the open must mint there too
  // — a scratch mint here would be a second record for the same call,
  // stuck at `input: {}` forever (the bare "Bash · 0m 03s" row).
  // Ordered before the content-bearing bail: a background agent's
  // children can stream inter-turn.
  if (event.kind === "tool_use") {
    const parentId =
      typeof event.parent_tool_use_id === "string"
        ? event.parent_tool_use_id
        : undefined;
    const id = typeof event.tool_use_id === "string" ? event.tool_use_id : "";
    const name = typeof event.tool_name === "string" ? event.tool_name : "";
    if (
      parentId !== undefined &&
      id !== "" &&
      name !== "" &&
      jobExistsForParent(state.jobs, parentId)
    ) {
      const child: ToolUseMessage = {
        kind: "tool_use",
        messageKey: `agent-child-${id}`,
        // Same value the start anchor below reads — one event, one clock.
        createdAt: typeof event.timestamp === "number" ? event.timestamp : Date.now(),
        toolUseId: id,
        toolName: name,
        input: {},
        status: "pending",
        result: null,
        structuredResult: null,
        parentToolUseId: parentId,
        toolWallMs: null,
      };
      const jobs = applyJobChildToolUse(state.jobs, parentId, child);
      let toolUseStartedAt = state.toolUseStartedAt;
      if (!toolUseStartedAt.has(id)) {
        toolUseStartedAt = new Map(toolUseStartedAt);
        toolUseStartedAt.set(
          id,
          typeof event.timestamp === "number" ? event.timestamp : Date.now(),
        );
      }
      if (
        jobs === state.jobs &&
        toolUseStartedAt === state.toolUseStartedAt
      ) {
        return { state, effects: [] };
      }
      return { state: { ...state, jobs, toolUseStartedAt }, effects: [] };
    }
  }

  if (!isContentBearingPhase(state.phase)) {
    return { state, effects: [] };
  }
  const turnKey = state.pendingTurn?.turnKey;
  if (turnKey === undefined) {
    return { state, effects: [] };
  }
  const entry = state.scratch.get(turnKey);
  if (entry === undefined) {
    return { state, effects: [] };
  }

  const key = blockKey(event.msg_id, event.block_index);
  if (entry.blockIndex.has(key)) {
    // Idempotent: already minted (live path beat us, or a snapshot
    // replay is re-emitting). State stays reference-identical so
    // `useSyncExternalStore` subscribers see no spurious churn.
    return { state, effects: [] };
  }

  // The entry's own time on the replay path, our clock on the live one. This
  // value becomes the Message's `createdAt`, and `createdAt` on `messages[0]`
  // is what the committed transcript sorts on — so minting `Date.now()` for a
  // replayed block dates a historical turn to the relaunch, which sorts it
  // after durable ink that genuinely followed it.
  const now = typeof event.timestamp === "number" ? event.timestamp : Date.now();
  const messageKey = wireMessageKey(event.msg_id, event.block_index);
  let message: Message;
  let toolUseId: string | undefined;
  switch (event.kind) {
    case "text":
      message = {
        kind: "assistant_text",
        messageKey,
        createdAt: now,
        text: "",
      } satisfies AssistantText;
      break;
    case "thinking":
      message = {
        kind: "assistant_thinking",
        messageKey,
        createdAt: now,
        text: "",
      } satisfies AssistantThinking;
      break;
    case "tool_use": {
      const id = typeof event.tool_use_id === "string" ? event.tool_use_id : "";
      const name = typeof event.tool_name === "string" ? event.tool_name : "";
      if (id === "" || name === "") {
        // Wire-input boundary regression — `content_block_start` for
        // tool_use missing the required id/name. Log a dev warning
        // and drop; minting a Message with empty identity would
        // orphan downstream lookups by `tool_use_id`.
        tugDevLogStore.warn(
          "code-session-store",
          "content_block_start tool_use missing id/name",
          { msgId: event.msg_id, blockIndex: event.block_index },
        );
        return { state, effects: [] };
      }
      toolUseId = id;
      // A foreground subagent child (no job for its parent) mints into
      // scratch like any call, but carries `parentToolUseId` from the
      // open so it nests under its Agent block immediately rather than
      // waiting for the input-fill `tool_use` to stamp it.
      const mintParentId =
        typeof event.parent_tool_use_id === "string"
          ? event.parent_tool_use_id
          : undefined;
      message = {
        kind: "tool_use",
        messageKey,
        createdAt: now,
        toolUseId: id,
        toolName: name,
        input: {},
        status: "pending",
        result: null,
        structuredResult: null,
        ...(mintParentId !== undefined
          ? { parentToolUseId: mintParentId }
          : {}),
        toolWallMs: null,
      } satisfies ToolUseMessage;
      break;
    }
    default: {
      const _exhaustive: never = event.kind;
      void _exhaustive;
      return { state, effects: [] };
    }
  }

  const arrayIdx = entry.messages.length;
  const nextMessages: Message[] = [...entry.messages, message];
  const nextBlockIndex = new Map(entry.blockIndex);
  nextBlockIndex.set(key, arrayIdx);
  const nextToolCallIndex = new Map(entry.toolCallIndex);
  if (toolUseId !== undefined) {
    nextToolCallIndex.set(toolUseId, arrayIdx);
  }
  const nextEntry: ScratchEntry = {
    ...entry,
    messages: nextMessages,
    blockIndex: nextBlockIndex,
    toolCallIndex: nextToolCallIndex,
  };

  // Capture the tool wall-clock anchor on the mint (the wire's open
  // event), not the input-fill `tool_use` event — the open is the
  // moment the user-visible block appears.
  let toolUseStartedAt = state.toolUseStartedAt;
  if (toolUseId !== undefined && !state.toolUseStartedAt.has(toolUseId)) {
    // Capture the call's start anchor. Live turns have no `timestamp` on
    // the wire event, so the wall-clock `now` is the anchor. Replay frames
    // carry the original JSONL entry time (`event.timestamp`, epoch ms) —
    // use it so `handleToolResult` recovers the real recorded wall time
    // (`tool_result.timestamp − tool_use.timestamp`) rather than a
    // meaningless replay-instant delta.
    toolUseStartedAt = new Map(state.toolUseStartedAt);
    toolUseStartedAt.set(
      toolUseId,
      typeof event.timestamp === "number" ? event.timestamp : now,
    );
  }

  return {
    state: {
      ...state,
      scratch: withScratchEntry(state.scratch, turnKey, nextEntry),
      activeMsgId: event.msg_id,
      toolUseStartedAt,
    },
    effects: [],
  };
}

/**
 * `assistant_text` / `thinking_text` delta — mutate the Message minted
 * by the matching `content_block_start`. The `(msg_id, block_index)`
 * coordinate is the wire's correlation key and resolves to the
 * Message via `scratch[turnKey].blockIndex`. Each delta shallow-clones
 * the affected Message + the messages-array slot per [D07] mutation
 * discipline; other Messages stay reference-identical.
 *
 * Defensive: if no `content_block_start` ever opened this block (a
 * tugcode regression, or a wire-shape change), the delta defensively
 * mints the Message in place — losing the createdAt anchor but
 * preserving the text. A dev-log warning surfaces the irregularity
 * without breaking the user's session.
 */
function handleTextDelta(
  state: CodeSessionState,
  event: AssistantTextEvent | ThinkingTextEvent,
  kind: "assistant_text" | "assistant_thinking",
): { state: CodeSessionState; effects: Effect[] } {
  if (!isContentBearingPhase(state.phase)) {
    return { state, effects: [] };
  }
  const turnKey = state.pendingTurn?.turnKey;
  if (turnKey === undefined) {
    return { state, effects: [] };
  }
  const entry = state.scratch.get(turnKey);
  if (entry === undefined) {
    return { state, effects: [] };
  }

  const msgId = event.msg_id;
  const text = event.text ?? "";
  const key = blockKey(msgId, event.block_index);

  // Resolve the Message via blockIndex. If absent (no prior
  // `content_block_start` for this coordinate), defensively mint —
  // surfaces a wire-shape regression in dev-log but preserves the
  // text in the user-visible substrate.
  let arrayIdx = entry.blockIndex.get(key);
  let nextMessages: Message[];
  let nextBlockIndex = entry.blockIndex;
  let messageKey: string;
  if (arrayIdx === undefined) {
    tugDevLogStore.warn(
      "code-session-store",
      `${kind} delta without matching content_block_start; defensive mint`,
      { msgId, blockIndex: event.block_index },
    );
    messageKey = wireMessageKey(msgId, event.block_index);
    const minted: Message =
      kind === "assistant_text"
        ? {
            kind: "assistant_text",
            messageKey,
            createdAt: Date.now(),
            text,
          }
        : {
            kind: "assistant_thinking",
            messageKey,
            createdAt: Date.now(),
            text,
          };
    arrayIdx = entry.messages.length;
    nextMessages = [...entry.messages, minted];
    nextBlockIndex = new Map(entry.blockIndex);
    nextBlockIndex.set(key, arrayIdx);
  } else {
    const existing = entry.messages[arrayIdx];
    if (existing.kind !== kind) {
      // The minted Message's kind disagrees with this delta — a
      // tugcode bug (the wire shouldn't emit text deltas under a
      // tool_use block, etc.). Drop with a dev-log warning rather
      // than mutating across kinds.
      tugDevLogStore.warn(
        "code-session-store",
        `${kind} delta into Message of kind ${existing.kind}; dropping`,
        { msgId, blockIndex: event.block_index },
      );
      return { state, effects: [] };
    }
    messageKey = existing.messageKey;
    const buffer = event.is_partial ? existing.text + text : text;
    const mutated: Message =
      kind === "assistant_text"
        ? {
            kind: "assistant_text",
            messageKey: existing.messageKey,
            createdAt: existing.createdAt,
            text: buffer,
          }
        : {
            kind: "assistant_thinking",
            messageKey: existing.messageKey,
            createdAt: existing.createdAt,
            text: buffer,
          };
    nextMessages = entry.messages.slice();
    nextMessages[arrayIdx] = mutated;
  }

  const nextEntry: ScratchEntry = {
    ...entry,
    messages: nextMessages,
    blockIndex: nextBlockIndex,
  };

  // Phase transitions only fire on live turns. While replaying, the
  // bracket pair owns phase entry/exit — text accumulates into the
  // Message but does not flip phase. (Replay always synthesizes
  // is_partial: false, so the live submitting → awaiting_first_token
  // → streaming sequence has no analogue.) Wake bracket-phase stays
  // `waking` for the same reason.
  let nextPhase: CodeSessionPhase;
  if (state.phase === "submitting") {
    nextPhase = "awaiting_first_token";
  } else if (state.phase === "awaiting_first_token") {
    nextPhase = "streaming";
  } else {
    nextPhase = state.phase;
  }

  // Telemetry: only fold for live turns. Replay events are
  // synthesized from JSONL and do not correspond to wall-clock
  // arrivals. The first `assistant_text` of a live turn captures
  // `firstAssistantDeltaAt` for the TTFT readout; thinking deltas do
  // NOT count for TTFT (TTFT is "time-to-first-assistant-output").
  const now = Date.now();
  const isReplay = state.phase === "replaying";
  const streamFold = isReplay ? {} : foldStreamEvent(state, now);
  // A live stream event is the path proving itself, which is the release a
  // held prompt gets without the monitor's help ([P10]). Replay proves
  // nothing about the network — it is JSONL off the local disk.
  const heldRelease = isReplay
    ? {}
    : { queuedSends: releaseHeldSends(state.queuedSends) };
  const firstAssistantDeltaAt =
    !isReplay && kind === "assistant_text" && state.firstAssistantDeltaAt === null
      ? now
      : state.firstAssistantDeltaAt;

  // Per-Message PropertyStore path ([D07] § Streaming substrate). The
  // `text` channel carries the rendered buffer for both text and
  // thinking Messages; `TugMarkdownBlock` subscribes to the resulting
  // `turn.${turnKey}.message.${messageKey}.text` path and writes the
  // DOM imperatively per delta ([L22]). Per-Message paths survive
  // the inflight → committed transition ([L26]) because `messageKey`
  // is stable from mint through commit.
  const mutatedText = (nextMessages[arrayIdx] as AssistantText | AssistantThinking).text;
  const effects: Effect[] = [
    {
      kind: "write-inflight",
      turnKey,
      messageKey,
      channel: "text",
      value: mutatedText,
    },
  ];
  // Content arrived, so the stall clock starts again from here. Emitted
  // beside the fold at all four of its call sites; the fold is what clears
  // the flag, this is what re-arms the timer behind it.
  if (!isReplay) effects.push(streamStallEffect(nextPhase));

  return {
    state: {
      ...state,
      phase: nextPhase,
      activeMsgId: msgId,
      scratch: withScratchEntry(state.scratch, turnKey, nextEntry),
      ...streamFold,
      ...heldRelease,
      firstAssistantDeltaAt,
    },
    effects,
  };
}

// ---------------------------------------------------------------------------
// Tool call lifecycle ([D07])
// ---------------------------------------------------------------------------

/**
 * `tool_use` input-fill / continuation. The minted `ToolUseMessage`
 * lives in scratch from the prior `content_block_start { kind:
 * "tool_use" }`; this event mutates `input` once the wire's
 * `input_json_delta` accumulator finalizes the payload.
 *
 * Two continuation paths are tolerated:
 *  - **Normal**: `content_block_start` (mint, `input: {}`) → `tool_use`
 *    (input fill, populates `input`).
 *  - **Re-emit**: a second `tool_use` for the same `tool_use_id` —
 *    same `tool_name`, possibly empty `input` continuation. The
 *    handler overwrites `input` only when the incoming payload is
 *    non-empty so an empty-object continuation doesn't clobber a
 *    previously-filled payload.
 *
 * Defensive: if the mint never landed (`toolCallIndex` miss), the
 * handler defensively mints a `ToolUseMessage` in place — losing
 * the createdAt anchor but preserving the call. A dev-log warning
 * surfaces the irregularity.
 */
function handleToolUse(
  state: CodeSessionState,
  event: ToolUseEvent,
): { state: CodeSessionState; effects: Effect[] } {
  const incomingParentId =
    typeof event.parent_tool_use_id === "string"
      ? event.parent_tool_use_id
      : undefined;

  // Background-agent child. Its parent Agent's turn already committed
  // (a backgrounded agent runs *after* the launching turn ends), so the
  // child arrives inter-turn and can't attach to a turn. Route it onto the
  // job ledger — the inter-turn carrier the Agent block already reads via
  // `useJobForToolUse` — where it renders the same broken-out block a
  // resume reconstructs, live. Only a background agent has a job; a
  // foreground agent's streamed children have no job and fall through to
  // normal turn attachment below. Ordered before the content-bearing bail
  // precisely because inter-turn phase is not content-bearing.
  //
  // The live turn's scratch record wins over the job route: when a
  // `content_block_start` already minted this call into the turn (the
  // job landed between the open and this fill), the input must land on
  // that mint — a second record on the ledger would leave the rendered
  // one bare (`input: {}`) and forever pending.
  const scratchTurnKey = isContentBearingPhase(state.phase)
    ? state.pendingTurn?.turnKey
    : undefined;
  const scratchEntry =
    scratchTurnKey !== undefined
      ? state.scratch.get(scratchTurnKey)
      : undefined;
  const mintedInScratch =
    scratchEntry?.toolCallIndex.has(event.tool_use_id) === true;
  if (
    !mintedInScratch &&
    incomingParentId !== undefined &&
    jobExistsForParent(state.jobs, incomingParentId)
  ) {
    const child: ToolUseMessage = {
      kind: "tool_use",
      messageKey: `agent-child-${event.tool_use_id}`,
      // Same value the start anchor below reads — one event, one clock.
      createdAt: typeof event.timestamp === "number" ? event.timestamp : Date.now(),
      toolUseId: event.tool_use_id,
      toolName: event.tool_name,
      input: (event.input ?? {}) as Record<string, unknown>,
      status: "pending",
      result: null,
      structuredResult: null,
      parentToolUseId: incomingParentId,
      toolWallMs: null,
    };
    const jobs = applyJobChildToolUse(state.jobs, incomingParentId, child);
    // Start anchor for the child's wall time — the tail-fed path has no
    // `content_block_start`, so this fill is the open. Tail-synthesized
    // frames carry the original JSONL time; live frames anchor at now.
    let toolUseStartedAt = state.toolUseStartedAt;
    if (!toolUseStartedAt.has(event.tool_use_id)) {
      toolUseStartedAt = new Map(toolUseStartedAt);
      toolUseStartedAt.set(
        event.tool_use_id,
        typeof event.timestamp === "number" ? event.timestamp : Date.now(),
      );
    }
    if (jobs === state.jobs && toolUseStartedAt === state.toolUseStartedAt) {
      return { state, effects: [] };
    }
    return { state: { ...state, jobs, toolUseStartedAt }, effects: [] };
  }

  if (!isContentBearingPhase(state.phase)) {
    return { state, effects: [] };
  }
  const turnKey = state.pendingTurn?.turnKey;
  if (turnKey === undefined) {
    return { state, effects: [] };
  }
  const entry = state.scratch.get(turnKey);
  if (entry === undefined) {
    return { state, effects: [] };
  }

  const toolUseId = event.tool_use_id;
  const toolName = event.tool_name;
  const incomingInput = (event.input ?? {}) as Record<string, unknown>;

  let arrayIdx = entry.toolCallIndex.get(toolUseId);
  let nextMessages: Message[];
  let nextToolCallIndex = entry.toolCallIndex;
  let defensiveStartCapture: number | null = null;
  if (arrayIdx === undefined) {
    // Defensive mint — no prior `content_block_start`. Logged so a
    // tugcode wire-shape regression surfaces in the dev-log rather
    // than silently orphaning the call's lookup.
    tugDevLogStore.warn(
      "code-session-store",
      "tool_use without matching content_block_start; defensive mint",
      { toolUseId, toolName },
    );
    const messageKey =
      typeof event.msg_id === "string"
        ? `${event.msg_id}-tu-${toolUseId}`
        : `defensive-${toolUseId}`;
    const now = Date.now();
    const minted: ToolUseMessage = {
      kind: "tool_use",
      messageKey,
      createdAt: now,
      toolUseId,
      toolName,
      input: incomingInput,
      status: "pending",
      result: null,
      structuredResult: null,
      parentToolUseId: incomingParentId,
      toolWallMs: null,
    };
    arrayIdx = entry.messages.length;
    nextMessages = [...entry.messages, minted];
    nextToolCallIndex = new Map(entry.toolCallIndex);
    nextToolCallIndex.set(toolUseId, arrayIdx);
    // The defensive mint must also capture the start anchor so
    // `handleToolResult` can compute `toolWallMs`. The normal mint
    // path in `handleContentBlockStart` does this; the defensive
    // path mirrors it. This is also the path replayed tool calls take
    // (tugcode emits `tool_use` directly, with no `content_block_start`),
    // so prefer the frame's original JSONL time when present.
    if (!state.toolUseStartedAt.has(toolUseId)) {
      defensiveStartCapture =
        typeof event.timestamp === "number" ? event.timestamp : now;
    }
  } else {
    const existing = entry.messages[arrayIdx];
    if (existing.kind !== "tool_use") {
      tugDevLogStore.warn(
        "code-session-store",
        `tool_use into Message of kind ${existing.kind}; dropping`,
        { toolUseId },
      );
      return { state, effects: [] };
    }
    // Continuation — Claude streams `tool_use` twice for a logical
    // call (first with `input: {}`, then with the filled-in input).
    // Only `input` is gated so an empty-object continuation doesn't
    // clobber a previously-filled payload. `parentToolUseId` is
    // sticky once set; the mint's `toolName` is authoritative
    // (continuations may omit it).
    const nextInput =
      Object.keys(incomingInput).length > 0 ? incomingInput : existing.input;
    const mutated: ToolUseMessage = {
      ...existing,
      input: nextInput,
      parentToolUseId: existing.parentToolUseId ?? incomingParentId,
    };
    nextMessages = entry.messages.slice();
    nextMessages[arrayIdx] = mutated;
  }

  const nextEntry: ScratchEntry = {
    ...entry,
    messages: nextMessages,
    toolCallIndex: nextToolCallIndex,
  };

  // Phase transition is live-only: a `tool_use` flips `streaming` /
  // `submitting` / `awaiting_first_token` to `tool_work`; replay and
  // wake keep their bracket phase (the bracket pair owns phase
  // entry/exit).
  const isReplaying = state.phase === "replaying";
  const isWaking = state.phase === "waking";
  const isBracketed = isReplaying || isWaking;

  // Telemetry: skip for replay (synthesized from JSONL, no wall-clock
  // arrival). Wake is live (real wall-clock event arrival from claude),
  // so fold and capture TTFTC just like a normal turn. Continuations
  // of the same tool_use_id still count for the stream-gap fold but
  // do NOT advance `firstToolUseAt` past the first call.
  const now = Date.now();
  const streamFold = isReplaying ? {} : foldStreamEvent(state, now);
  // The path proved itself — release any hold, as at the other stream sites.
  const heldRelease = isReplaying
    ? {}
    : { queuedSends: releaseHeldSends(state.queuedSends) };
  const firstToolUseAt =
    !isReplaying && state.firstToolUseAt === null
      ? now
      : state.firstToolUseAt;
  let toolUseStartedAt = state.toolUseStartedAt;
  if (defensiveStartCapture !== null) {
    toolUseStartedAt = new Map(toolUseStartedAt);
    toolUseStartedAt.set(toolUseId, defensiveStartCapture);
  }

  return {
    state: {
      ...state,
      phase: isBracketed ? state.phase : "tool_work",
      activeMsgId: event.msg_id ?? state.activeMsgId,
      scratch: withScratchEntry(state.scratch, turnKey, nextEntry),
      toolUseStartedAt,
      ...streamFold,
      ...heldRelease,
      firstToolUseAt,
    },
    // Beside the fold, as at the other three call sites.
    effects: isReplaying
      ? []
      : [streamStallEffect(isBracketed ? state.phase : "tool_work")],
  };
}

function handleToolResult(
  state: CodeSessionState,
  event: ToolResultEvent,
): { state: CodeSessionState; effects: Effect[] } {
  // Background-agent child result. Routed to the job that owns the child
  // (its parent turn already committed; the child tool_use landed on the
  // job in `handleToolUse`). Ordered before the phase bail because these
  // arrive inter-turn. Wall time pairs the start anchor captured at the
  // child's open with this result, same as the scratch path below.
  if (jobIdForChild(state.jobs, event.tool_use_id) !== undefined) {
    const startedAt = state.toolUseStartedAt.get(event.tool_use_id);
    const resultAt =
      typeof event.timestamp === "number" ? event.timestamp : Date.now();
    const jobs = applyJobChildResult(state.jobs, event.tool_use_id, {
      result: event.output ?? null,
      status: event.is_error === true ? "error" : "done",
      ...(typeof startedAt === "number"
        ? { toolWallMs: Math.max(0, resultAt - startedAt) }
        : {}),
    });
    let toolUseStartedAt = state.toolUseStartedAt;
    if (toolUseStartedAt.has(event.tool_use_id)) {
      toolUseStartedAt = new Map(toolUseStartedAt);
      toolUseStartedAt.delete(event.tool_use_id);
    }
    if (jobs === state.jobs && toolUseStartedAt === state.toolUseStartedAt) {
      return { state, effects: [] };
    }
    return { state: { ...state, jobs, toolUseStartedAt }, effects: [] };
  }

  // tool_result is accepted in `tool_work`, `replaying`, and `waking` —
  // pairing with a prior `tool_use` that minted the Message during
  // this same bracketed turn.
  if (
    state.phase !== "tool_work" &&
    state.phase !== "replaying" &&
    state.phase !== "waking"
  ) {
    return { state, effects: [] };
  }
  const turnKey = state.pendingTurn?.turnKey;
  if (turnKey === undefined) {
    return { state, effects: [] };
  }
  const entry = state.scratch.get(turnKey);
  if (entry === undefined) {
    return { state, effects: [] };
  }

  const toolUseId = event.tool_use_id;
  const arrayIdx = entry.toolCallIndex.get(toolUseId);
  if (arrayIdx === undefined) {
    console.warn(
      `[code-session-store] tool_result for unknown tool_use_id: ${toolUseId}`,
    );
    return { state, effects: [] };
  }
  const existing = entry.messages[arrayIdx];
  if (existing.kind !== "tool_use") {
    console.warn(
      `[code-session-store] tool_result indexed Message of kind ${existing.kind}; dropping`,
    );
    return { state, effects: [] };
  }

  const isReplaying = state.phase === "replaying";
  const isWaking = state.phase === "waking";
  const now = Date.now();
  const startedAt = state.toolUseStartedAt.get(toolUseId);
  // Wall time = result anchor − start anchor. Live frames omit
  // `event.timestamp`, so the pair is (Date.now(), Date.now()-at-mint);
  // replay frames carry the original JSONL times, so the same subtraction
  // recovers the recorded duration. Either way the start anchor must be
  // known — a call whose `tool_use` we never saw keeps its prior value.
  const resultAt =
    typeof event.timestamp === "number" ? event.timestamp : now;
  const toolWallMs =
    typeof startedAt === "number"
      ? Math.max(0, resultAt - startedAt)
      : existing.toolWallMs;

  const mutated: ToolUseMessage = {
    ...existing,
    status: event.is_error === true ? "error" : "done",
    result: event.output ?? null,
    toolWallMs,
  };
  const nextMessages = entry.messages.slice();
  nextMessages[arrayIdx] = mutated;

  // Steering pickup at the agent-loop boundary ([Q01]/[P06]/[P07]). A
  // `tool_result` while a turn is live (`tool_work`, not replay or a
  // wake) is the iteration boundary at which claude merges a queued
  // message. When the queue is non-empty we pick up its head atomically:
  // forward it to claude (`send-frame`), remove it from `queuedSends`,
  // and append it as a `user_message` to THIS turn's `messages` so the
  // retractable foot ghost becomes a real mid-turn user row after the
  // tool block. The message keeps its own queue-time key
  // (`${turnKey}-user`, [P04]) — distinct from the host opener's. Held
  // off the wire until now (`handleSend` only parks it), which is what
  // kept it retractable; removal-on-pickup means the `turn_complete`
  // collapse only ever sees never-picked-up entries (no double-forward,
  // Risk R03). Live position is approximate (the boundary we act on,
  // since claude emits no live echo — [Q02]); reload from JSONL tightens
  // it to claude's exact merge point.
  const isLive = !isReplaying && !isWaking;
  // A live tool_result is a stream event, so the hold releases here too —
  // before the pickup reads the head, which is what lets a prompt held at
  // submit be steered into the turn that has just proved the path.
  let queuedSends = isLive
    ? releaseHeldSends(state.queuedSends)
    : state.queuedSends;
  const pickupEffects: Effect[] = [];
  if (isLive && queuedSends.length > 0) {
    const [head, ...rest] = queuedSends;
    // Queue-time stamp, as at the `turn_complete` flush: the row's
    // timestamp is when the user posted, not when the agent loop picked
    // the message up.
    const steered: UserMessage = {
      kind: "user_message",
      messageKey: userMessageKey(head.turnKey),
      createdAt: head.queuedAt,
      text: head.text,
      attachments: head.atoms,
      origin: head.origin,
      submitAt: head.queuedAt,
    };
    nextMessages.push(steered);
    queuedSends = rest;
    pickupEffects.push({
      kind: "send-frame",
      msg: { type: "user_message", content: head.content },
    });
  }
  const nextEntry: ScratchEntry = { ...entry, messages: nextMessages };

  let toolUseStartedAt = state.toolUseStartedAt;
  if (toolUseStartedAt.has(toolUseId)) {
    toolUseStartedAt = new Map(toolUseStartedAt);
    toolUseStartedAt.delete(toolUseId);
  }

  const nextScratch = withScratchEntry(state.scratch, turnKey, nextEntry);
  // Phase transition: tool_result drives `tool_work → streaming` once
  // every tool_use Message in the turn is terminal. Replay and wake
  // keep their bracket phase.
  const nextPhase: CodeSessionPhase = isReplaying || isWaking
    ? state.phase
    : allToolsTerminal(nextEntry)
      ? "streaming"
      : "tool_work";

  const streamFold = isReplaying ? {} : foldStreamEvent(state, now);

  // Jobs ledger — two folds, both suppressed during replay. Replay
  // re-delivers tool events but never the task lifecycle frames, so a
  // replayed launch insert would sit at `running` forever; after a
  // reload the ledger deliberately starts empty.
  let jobs = state.jobs;
  if (!isReplaying && mutated.status === "done") {
    const input =
      typeof mutated.input === "object" && mutated.input !== null
        ? (mutated.input as Record<string, unknown>)
        : null;
    // The tool_result ECHO is the authoritative background-launch
    // discriminant. At claude 2.1.197 an async Agent launch no longer
    // carries `input.run_in_background` (input is just
    // description/prompt/subagent_type) — the signal moved to the RESULT
    // (`isAsync` / "Async agent launched successfully" + an `agentId`
    // that equals the task frames' `task_id`, so progress/terminal
    // frames correctly update this row). A background Bash / Monitor
    // likewise announces itself in its result.
    // `parseBackgroundLaunchResult` matches exactly those three echoes
    // and nothing else, so a foreground tool never trips it — the result
    // is the reliable gate `input.run_in_background` no longer is. (The
    // `task_started` frame is the other insert path via
    // `handleTaskStarted`; `insertJob` composes the two idempotently.)
    const echo = parseBackgroundLaunchResult(mutated.result);
    if (echo !== undefined) {
      const launchDescription =
        typeof input?.description === "string" ? input.description : "";
      jobs = insertJob(jobs, {
        jobId: echo.jobId,
        source: "claude",
        kind: echo.kind,
        toolUseId: mutated.toolUseId,
        description: launchDescription,
        ...(echo.outputFile !== undefined
          ? { outputFile: echo.outputFile }
          : {}),
        status: "running",
        startedAtMs: now,
        endedAtMs: null,
      });
    } else if (mutated.toolName.toLowerCase() === "taskstop") {
      // Defensive fold: the wire also confirms a stop via
      // `task_updated{killed}`, but folding the TaskStop call keeps
      // the row honest if that frame is ever missed. First terminal
      // flip wins, so the double-delivery is harmless.
      const stoppedId =
        typeof input?.task_id === "string"
          ? input.task_id
          : typeof input?.shell_id === "string"
            ? input.shell_id
            : undefined;
      if (stoppedId !== undefined) {
        jobs = applyJobFlip(jobs, stoppedId, "stopped", now);
      }
    } else {
      // Scheduled-work registration — the harness-owned timers
      // (`ScheduleWakeup` / `CronCreate`) emit no `task_started` frame,
      // so the scheduling tool call is the only insert path. The fired
      // wake carries no `task_id`, so a row is reconciled by time
      // (`flipEarliestElapsedScheduled` / `reapElapsedScheduled`), not
      // by id. `CronDelete` removes the matching cron row.
      const toolName = mutated.toolName.toLowerCase();
      if (toolName === "schedulewakeup") {
        const wakeInput = narrowScheduleWakeupInput(input);
        if (wakeInput !== undefined) {
          jobs = insertJob(
            jobs,
            scheduledRowFromWakeup(mutated.toolUseId, wakeInput, now),
          );
        }
      } else if (toolName === "croncreate") {
        const cronInput = narrowCronCreateInput(input);
        if (cronInput !== undefined) {
          jobs = insertJob(
            jobs,
            scheduledRowFromCron(
              mutated.toolUseId,
              cronInput,
              mutated.result,
              now,
            ),
          );
        }
      } else if (toolName === "crondelete") {
        const delInput = narrowCronDeleteInput(input);
        if (delInput !== undefined) {
          jobs = stopScheduledRow(jobs, delInput.cronId, now);
        }
      } else if (toolName === "remotetrigger") {
        // claude.ai routines: `create` registers a scheduled remote row;
        // `update` re-labels the matching row; `run` / `list` / `get`
        // track no local state (fire-and-forget or read-only).
        const rtInput = narrowRemoteTriggerToolInput(input);
        if (rtInput !== undefined) {
          if (rtInput.action === "create") {
            jobs = insertJob(
              jobs,
              scheduledRowFromRemoteTrigger(
                mutated.toolUseId,
                rtInput,
                mutated.result,
                now,
              ),
            );
          } else if (rtInput.action === "update") {
            const rowId =
              parseRemoteTriggerCreateId(mutated.result) ?? rtInput.triggerId;
            if (rowId !== undefined) {
              const labels = remoteTriggerLabels(rtInput);
              jobs = relabelScheduledRow(
                jobs,
                rowId,
                labels.description,
                labels.scheduleLabel,
              );
            }
          }
        }
      }
    }
    // Any landed tool result is a clock reading: reap scheduled rows
    // whose fire is long past with no wake, so a mis-targeted or
    // never-arriving timer cannot linger un-clearable.
    jobs = reapElapsedScheduled(jobs, now);
  }

  return {
    state: {
      ...state,
      phase: nextPhase,
      scratch: nextScratch,
      toolUseStartedAt,
      jobs,
      queuedSends,
      ...streamFold,
    },
    // Beside the fold, as at the other three call sites.
    effects: isReplaying
      ? pickupEffects
      : [...pickupEffects, streamStallEffect(nextPhase)],
  };
}

/**
 * Whether a `structured_result` is the async-launch echo of a
 * backgrounded `Agent` (`{ isAsync: true }` / `{ status: "async_launched" }`)
 * rather than a real composed answer. Used so the echo can't overwrite the
 * tailer's composed result on the job.
 */
function isAsyncLaunchEcho(structured: unknown): boolean {
  if (structured === null || typeof structured !== "object") return false;
  const s = structured as Record<string, unknown>;
  return s.isAsync === true || s.status === "async_launched";
}

function handleToolUseStructured(
  state: CodeSessionState,
  event: ToolUseStructuredEvent,
): { state: CodeSessionState; effects: Effect[] } {
  // Background-agent structured result, routed to the job (inter-turn):
  //  - a child call's structured result (e.g. a nested Read's file body)
  //    folds onto that child in the job's `childCalls`;
  //  - the AGENT's own composed structured result (final answer + stats,
  //    keyed by the launching call's `tool_use_id`) folds onto the job.
  //    The async-launch echo also arrives as a `tool_use_structured` for
  //    the same id, but it carries no content — its `isAsync`/
  //    `async_launched` shape is ignored here so it can't overwrite the
  //    composed answer; the tailer's real result lands via the else-branch.
  if (jobIdForChild(state.jobs, event.tool_use_id) !== undefined) {
    const jobs = applyJobChildResult(state.jobs, event.tool_use_id, {
      structuredResult: event.structured_result ?? null,
    });
    return jobs === state.jobs
      ? { state, effects: [] }
      : { state: { ...state, jobs }, effects: [] };
  }
  if (
    jobExistsForParent(state.jobs, event.tool_use_id) &&
    !isAsyncLaunchEcho(event.structured_result)
  ) {
    const jobs = applyJobAgentStructured(
      state.jobs,
      event.tool_use_id,
      event.structured_result ?? null,
    );
    return jobs === state.jobs
      ? { state, effects: [] }
      : { state: { ...state, jobs }, effects: [] };
  }

  // Accept in the same phases that admit the paired `tool_use` and
  // `tool_result` events. `replaying` is critical: the JSONL replay
  // path emits `tool_use_structured` from the entry-level
  // `toolUseResult` (see `tugcode/src/replay.ts`); a guard that
  // excluded `replaying` would silently drop those events, leaving
  // resumed Read tool calls with `structuredResult: null` and the
  // wrapper rendering an empty body. `waking` is admitted for the
  // same reason — a wake's structured tool result must populate the
  // pending call's `structuredResult`.
  if (
    state.phase !== "tool_work" &&
    state.phase !== "streaming" &&
    state.phase !== "replaying" &&
    state.phase !== "waking"
  ) {
    return { state, effects: [] };
  }
  const turnKey = state.pendingTurn?.turnKey;
  if (turnKey === undefined) {
    return { state, effects: [] };
  }
  const entry = state.scratch.get(turnKey);
  if (entry === undefined) {
    return { state, effects: [] };
  }

  const toolUseId = event.tool_use_id;
  const arrayIdx = entry.toolCallIndex.get(toolUseId);
  if (arrayIdx === undefined) {
    console.warn(
      `[code-session-store] tool_use_structured for unknown tool_use_id: ${toolUseId}`,
    );
    return { state, effects: [] };
  }
  const existing = entry.messages[arrayIdx];
  if (existing.kind !== "tool_use") {
    console.warn(
      `[code-session-store] tool_use_structured indexed Message of kind ${existing.kind}; dropping`,
    );
    return { state, effects: [] };
  }

  const mutated: ToolUseMessage = {
    ...existing,
    structuredResult: event.structured_result ?? null,
  };
  const nextMessages = entry.messages.slice();
  nextMessages[arrayIdx] = mutated;
  const nextEntry: ScratchEntry = { ...entry, messages: nextMessages };

  const isReplaying = state.phase === "replaying";
  const streamFold = isReplaying ? {} : foldStreamEvent(state, Date.now());
  // The path proved itself — release any hold, as at the other stream sites.
  const heldRelease = isReplaying
    ? {}
    : { queuedSends: releaseHeldSends(state.queuedSends) };

  return {
    state: {
      ...state,
      scratch: withScratchEntry(state.scratch, turnKey, nextEntry),
      ...streamFold,
      ...heldRelease,
    },
    // Beside the fold, as at the other three call sites. The phase is
    // untouched here, so the re-arm reads the one the card is already in.
    effects: isReplaying ? [] : [streamStallEffect(state.phase)],
  };
}

/**
 * Close any open per-turn pause segments (awaiting-approval +
 * interrupt-in-flight) and produce the resulting interval-array
 * updates. Called by every turn-boundary callsite (`handleTurnComplete`,
 * transport-lost commit) so the just-ended turn's intervals projection
 * is complete before the post-state lands.
 *
 * Note the asymmetry with transport-downtime: a transport-downtime
 * segment that's still open at turn boundary (the transport-lost
 * commit case) is deliberately NOT closed here — the disconnect
 * outlives the turn and the segment continues into the next
 * idle/errored window. `handleTransportSettled` is the sole closer of
 * transport segments. (At the next `handleSend`, `transportDowntimeIntervals`
 * is reset to `[]` along with the rest of the per-turn array
 * projections; an open `transportNonOnlineSince` remains the
 * transport handler's concern.)
 */
function closeTurnPauseSegments(
  state: CodeSessionState,
  end: number,
): {
  awaitingApprovalIntervals: ReadonlyArray<readonly [number, number]>;
  interruptInFlightIntervals: ReadonlyArray<readonly [number, number]>;
  interruptInFlightSegmentStartedAt: null;
} {
  const awaitingApprovalIntervals =
    state.awaitingApprovalSince === null
      ? state.awaitingApprovalIntervals
      : [
          ...state.awaitingApprovalIntervals,
          [state.awaitingApprovalSince, end] as const,
        ];
  const interruptInFlightIntervals =
    state.interruptInFlightSegmentStartedAt === null
      ? state.interruptInFlightIntervals
      : [
          ...state.interruptInFlightIntervals,
          [state.interruptInFlightSegmentStartedAt, end] as const,
        ];
  return {
    awaitingApprovalIntervals,
    interruptInFlightIntervals,
    interruptInFlightSegmentStartedAt: null,
  };
}

/**
 * Per-turn reset slice — fields cleared at every turn boundary
 * (`turn_complete` success/error, `turn_complete` interrupted,
 * mid-turn transport-lost). The active-turn axis (phase, scratch,
 * pendingTurn, etc.) is reset separately at each call site because
 * the queue-flush path needs to populate the next turn's slots
 * synchronously.
 *
 * The per-turn interval arrays (`awaitingApprovalIntervals` /
 * `transportDowntimeIntervals` / `interruptInFlightIntervals`) are
 * deliberately NOT reset here — the closed-intervals projection
 * from the just-ended turn persists through the brief idle gap so
 * the dev-panel inspector and any debug-time consumer can see the
 * full pause history. The arrays reset at the next `handleSend`
 * (start of the next turn). Open segments are closed by
 * {@link closeTurnPauseSegments} at the same callsite that spreads
 * this reset.
 */
function resetPerTurnTelemetry(): Pick<
  CodeSessionState,
  | "awaitingApprovalSince"
  | "awaitingApprovalAccumulatedMs"
  | "transportDowntimeAccumulatedMs"
  | "transportReconnectCount"
  | "lastStreamEventAt"
  | "maxStreamGapMs"
  | "firstAssistantDeltaAt"
  | "firstToolUseAt"
  | "costAtSubmit"
  | "interruptInFlight"
  | "pendingInterruptReason"
  | "stopStalled"
  | "streamStalled"
  | "apiRetry"
  | "refusalFallback"
  | "outputTruncated"
> {
  return {
    awaitingApprovalSince: null,
    awaitingApprovalAccumulatedMs: 0,
    transportDowntimeAccumulatedMs: 0,
    transportReconnectCount: 0,
    lastStreamEventAt: null,
    maxStreamGapMs: 0,
    firstAssistantDeltaAt: null,
    firstToolUseAt: null,
    costAtSubmit: null,
    interruptInFlight: false,
    // Cleared with `interruptInFlight`: the interrupted turn has committed
    // (buildTurnEntry read the reason off the pre-reset state), so the
    // bridge closes for the next turn.
    pendingInterruptReason: null,
    // The turn ended, so whether its stop was ever answered is no longer
    // a live question. Force Stop has nothing left to offer.
    stopStalled: false,
    // Same reading, one axis over: a turn that has ended is not a turn
    // waiting on anything. The timer behind this is cancelled by
    // `streamStallCancelEffect` at the same transition.
    streamStalled: false,
    // A retry banner is per-turn-transient: the turn it was retrying has
    // ended, so the announcement is stale. Cleared on every turn_complete
    // path (each spreads this) and at wake start.
    apiRetry: null,
    // Per-turn one-shot: cleared at the boundary so the next turn's refusal
    // (even on the same models) re-notifies via a fresh null → set.
    refusalFallback: null,
    // Per-turn one-shot: cleared at the boundary so the next truncated turn
    // re-notifies via a fresh false → true.
    outputTruncated: false,
  };
}

/**
 * Build a `record-telemetry` effect for a freshly-committed live
 * `TurnEntry`. The effect carries the telemetry block in the wire
 * shape the supervisor's `record_turn_telemetry` CONTROL handler
 * expects; the store wrapper looks up `tug_session_id` and dispatches
 * the frame.
 *
 * Returns `undefined` when the persistence shouldn't run — the
 * caller's branch on `event.telemetry !== undefined` (replay path)
 * is the precondition; this helper just packages the payload.
 */
function buildRecordTelemetryEffect(
  entry: TurnEntry,
  sessionInitTokens: number | null,
): Effect {
  // `sessionInitTokens` is session-level — it is not on `TurnEntry`,
  // so the caller passes the reducer's captured value. Persisting it
  // on every turn's telemetry row lets a resumed session restore it
  // from the first replayed `turn_complete`.
  const telemetry: TurnTelemetry = {
    cost: entry.cost,
    wallClockMs: entry.wallClockMs,
    awaitingApprovalMs: entry.awaitingApprovalMs,
    transportDowntimeMs: entry.transportDowntimeMs,
    activeMs: entry.activeMs,
    ttftMs: entry.ttftMs,
    ttftcMs: entry.ttftcMs,
    reconnectCount: entry.reconnectCount,
    maxStreamGapMs: entry.maxStreamGapMs,
    sessionInitTokens,
    // Persist the terminal reason so a future resume recovers it
    // instead of re-deriving (the re-derivation can't tell an
    // interrupted turn from an errored one — [replay-2]).
    turnEndReason: entry.turnEndReason,
  };
  return {
    kind: "record-telemetry",
    msgId: entry.msgId,
    telemetry,
    endedAt: entry.endedAt,
  };
}

/**
 * Read `submitAt` from a turn's opening `user_message` Message (if
 * any). Wake turns carry no `user_message`, so the fallback path
 * uses the `pendingTurn.submitAt` recorded at `handleWakeStarted`.
 */
function submitAtFor(
  state: CodeSessionState,
  endedAt: number,
): number {
  const pending = state.pendingTurn;
  if (pending !== null) return pending.submitAt;
  return endedAt;
}

function buildTurnEntry(
  state: CodeSessionState,
  msgId: string,
  reason: TurnEndReason,
  endedAt: number,
  inlineTelemetry: TurnTelemetry | undefined,
): TurnEntry {
  const turnKey = state.pendingTurn?.turnKey ?? `msg-${msgId}`;
  const entry = state.scratch.get(turnKey);
  const messages: ReadonlyArray<Message> =
    entry !== undefined ? entry.messages.slice() : [];
  const submitAt = submitAtFor(state, endedAt);
  // Live path derives the telemetry block from reducer state at this
  // moment; replay path receives it inlined on the wire event. The
  // merge picks the authoritative source — see telemetry.ts /
  // `mergeTurnTelemetry` for the contract.
  const derivedTelemetry = deriveTurnTelemetry(state, submitAt, endedAt);
  const telemetry = mergeTurnTelemetry(inlineTelemetry, derivedTelemetry);
  // Compaction turn: the summarization turn's own `cost_update` reports the
  // pre-compaction context it read (or nothing), so the window-walk would carry
  // the stale peak forward until the next turn. The honest post-compaction
  // window rides `entry.compactionPostTotal` (`sessionInit + post_tokens`) and
  // is copied onto the committed entry below, where `deriveContextWindows`
  // reads it as `window(N)` — the cost stays the real, zero-usage `TurnCost` so
  // the value never masquerades as usage ([P01]).
  const cost: TurnCost = telemetry.cost;
  // The terminal reason is recovered from the persisted telemetry
  // block on the replay path — `mergeTurnTelemetry` adopted the inline
  // block wholesale, so `telemetry.turnEndReason` is the value the
  // live reducer classified during the original turn. The live path
  // carries no inline block, so the freshly-passed `reason` stands.
  // Without this, a replayed interrupted turn (wire `result: "error"`,
  // no live `interruptInFlight`) mis-commits as `error` ([replay-2]).
  const effectiveReason: TurnEndReason = telemetry.turnEndReason ?? reason;
  // Origin is the opener's stated attribution ([P01], S01) — never inferred
  // from `messages[0]`. `pendingTurn` is set on every real commit; the
  // `assistant` default covers only the degenerate no-pending fallback
  // (`msg-${msgId}` turnKey), where asserting no user row is the safe,
  // honest choice.
  const origin: TurnOrigin = state.pendingTurn?.origin ?? "assistant";
  return {
    msgId,
    turnKey,
    origin,
    // Replay-window stamp: a turn committing while the replay window
    // is open is reconstructed history, not a watched live turn.
    ...(state.phase === "replaying" ? { replayed: true } : {}),
    // The `/rewind` anchor captured during the turn ([#step-7-1]); `undefined`
    // for turns whose anchor never arrived (older sessions, wake turns).
    ...(state.pendingTurn?.promptUuid !== undefined
      ? { promptUuid: state.pendingTurn.promptUuid }
      : {}),
    messages,
    result: effectiveReason === "complete" ? "success" : "interrupted",
    // App-flow sidecar: a turn stopped by logout or by the setup wizard
    // carries the flow's `interruptReason` so its end-state names it rather
    // than reading a bare "Interrupted". Only on a live interrupt (the replay
    // path leaves
    // `pendingInterruptReason` null, so JSONL never revives the marker).
    ...(effectiveReason === "interrupted" && state.pendingInterruptReason !== null
      ? { interruptReason: state.pendingInterruptReason }
      : {}),
    endedAt,
    wallClockMs: telemetry.wallClockMs,
    awaitingApprovalMs: telemetry.awaitingApprovalMs,
    transportDowntimeMs: telemetry.transportDowntimeMs,
    activeMs: telemetry.activeMs,
    ttftMs: telemetry.ttftMs,
    ttftcMs: telemetry.ttftcMs,
    reconnectCount: telemetry.reconnectCount,
    maxStreamGapMs: telemetry.maxStreamGapMs,
    turnEndReason: effectiveReason,
    cost,
    // Honest post-compaction window ([P01]) — copied from the scratch when
    // this turn compacted mid-turn; consumed by `deriveContextWindows` as
    // `window(N)`, never folded into `cost`.
    ...(typeof entry?.compactionPostTotal === "number"
      ? { compactionPostTotal: entry.compactionPostTotal }
      : {}),
  };
}

/**
 * Flush the head of `queuedSends` into a new `submitting` turn at a
 * turn-boundary commit. Shared by every terminal branch that settles a
 * turn while a queued send is waiting — the normal `turn_complete`
 * success collapse AND the `waking` branch (a wake settling with a
 * pending user message is a turn boundary too, so the queue drains here
 * rather than stranding at idle with no later trigger). Mirrors
 * `handleSend`'s per-turn telemetry reset so the flushed turn measures
 * its deltas from this point; the just-ended turn's closed pause
 * segments are discarded (the new turn's intervals start empty).
 * `priorEffects` are the just-ended turn's commit effects
 * (append-transcript / clear-inflight / telemetry); the flush's
 * `send-frame` is appended after them. `extraState` carries any
 * per-branch overrides (e.g. the wake branch clears `wakeTrigger`).
 */
function flushQueuedHeadResult(
  state: CodeSessionState,
  scratch: ReadonlyMap<string, ScratchEntry>,
  committedMsgIds: Set<string>,
  sessionInitTokens: number | null,
  priorEffects: Effect[],
  extraState: Partial<CodeSessionState>,
): { state: CodeSessionState; effects: Effect[] } {
  const [next, ...rest] = state.queuedSends;
  const flushedSubmitAt = Date.now();
  // Mint the flushed turn's `UserMessage` directly from the queued
  // entry's already-synthesized substrate — no re-synthesis at flush
  // time. Bytes-store entries minted at the original queueing `send`
  // stayed live across the queue gap (the bytes-store is per-card-mount).
  // The Message carries the QUEUE-time stamp — the moment the user hit
  // submit — while `pendingTurn.submitAt` below stays at dispatch time
  // (telemetry measures the turn, not the wait). Stamping the Message at
  // flush would re-date the row forward past any shell exchange run while
  // it sat queued, permanently seating that exchange above a message the
  // user submitted first ([D111]).
  const flushedUserMessage: UserMessage = {
    kind: "user_message",
    messageKey: userMessageKey(next.turnKey),
    createdAt: next.queuedAt,
    text: next.text,
    attachments: next.atoms,
    origin: next.origin,
    submitAt: next.queuedAt,
  };
  return {
    state: {
      ...state,
      phase: "submitting",
      activeMsgId: null,
      scratch: withScratchEntry(
        scratch,
        next.turnKey,
        newScratchEntry(next.turnKey, [flushedUserMessage]),
      ),
      toolUseStartedAt: new Map(),
      pendingApproval: null,
      pendingQuestion: null,
      prevPhase: null,
      pendingTurn: {
        turnKey: next.turnKey,
        submitAt: flushedSubmitAt,
        origin: "user",
      },
      queuedSends: rest,
      lastError: null,
      committedMsgIds,
      sessionInitTokens,
      // Queue-flush IS the next `handleSend` for telemetry purposes, so
      // apply the same per-turn reset. The closed-segment push from the
      // just-ended turn is discarded — the new turn's intervals start
      // empty.
      ...resetPerTurnTelemetry(),
      awaitingApprovalIntervals: [],
      transportDowntimeIntervals: [],
      interruptInFlightIntervals: [],
      interruptInFlightSegmentStartedAt: null,
      costAtSubmit: state.lastCost,
      ...extraState,
    },
    effects: [
      ...priorEffects,
      {
        kind: "send-frame",
        msg: {
          type: "user_message",
          // The queued entry carries the wire content blocks built at
          // queue time by `buildWirePayload`. We pass them through
          // verbatim — the reducer never re-reads the bytes-store.
          content: next.content,
        },
      },
    ],
  };
}

function handleTurnComplete(
  state: CodeSessionState,
  event: TurnCompleteEvent,
): { state: CodeSessionState; effects: Effect[] } {
  // CASE A wire-echo suppression gate. When the user cancelled a
  // turn while `phase === "submitting"`, the wire eventually echoes
  // a `turn_complete(result: "error")` for the aborted cycle
  // (verified via `tugcode/probe-case-a.ts`; its msg_id is the turn's
  // synthesized `t-<seq>` opener id — claude never revealed a message
  // id before the abort). Suppress it so no phantom transcript entry
  // lands.
  //
  // The triple-clause gate is what makes this correct under all
  // observed user-action races:
  //
  //   - `pendingCaseAEchoes > 0` — at least one aborted cycle is
  //     awaiting its echo. The counter is incremented per CASE A
  //     interrupt (in `handleInterrupt`) and decremented here in
  //     FIFO order, so back-to-back cancels each consume their own
  //     suppression slot.
  //   - `state.activeMsgId === null` — no live turn has bound a
  //     `msg_id` yet. Wire FIFO ordering (verified via
  //     `tugcode/probe-case-a-race.ts`) means an aborted cycle's
  //     `turn_complete(error)` always arrives before any content
  //     frame of a subsequent cycle, so this clause distinguishes
  //     "aborted cycle echo" from "live turn errored mid-stream"
  //     (which would have set `activeMsgId` via a prior content
  //     delta) AND from "live turn errored without ever producing
  //     content" (which falls through this gate when the counter is
  //     zero).
  //   - `event.result === "error"` — defensive; the aborted cycle
  //     never completes successfully on the wire.
  //
  // Counter is reset to 0 on `transport_close` (any stranded echoes
  // are lost with the dead wire) so a stale aborted-cycle suppression
  // can't carry across a reconnect and falsely consume a future live
  // turn's pre-content error.
  if (
    state.pendingCaseAEchoes > 0 &&
    state.activeMsgId === null &&
    event.result === "error"
  ) {
    return {
      state: {
        ...state,
        pendingCaseAEchoes: state.pendingCaseAEchoes - 1,
      },
      effects: [],
    };
  }

  // Guard `activeMsgId === null`. Three sub-cases:
  //
  //   1. Phase is `idle` — stray live `turn_complete` arrived between
  //      turns. No turn to commit. Drop.
  //
  //   2. `pendingTurn === null` — no turn open. A `turn_complete`
  //      here is either a translator regression (orphan synthesis
  //      without an opener) or a wire-side stray. Drop with a warn so
  //      a real regression is visible without breaking the session.
  //
  //   3. `pendingTurn !== null` — the no-content interrupt fallback
  //      ([D13] / [D14] / `#spec-reducer-state` rule 2). The
  //      translator's orphan-synthesis `turn_complete` arrived with a
  //      synthesized opener id (today: `orphan-<n>` from
  //      `flushPendingOrphan`; under [D13] / Step 5.6: `u-<n>` /
  //      `w-<n>` from the `openTurnMsgId` tracker) because transport
  //      loss hit before any first-content event could set
  //      `activeMsgId` to claude's real `msg_id`. Commit `pendingTurn`
  //      as an interrupted-before-response turn. `pendingTurn.turnKey`
  //      drives the scratch lookup (see `buildTurnEntry`); the
  //      committed `messages` is `[user_message]` for user-side
  //      openers, `[]` for wake openers. The synthesized id enters
  //      `committedMsgIds` only here, not via `add_user_message`
  //      (which carries no `msg_id` per [D15]).
  //
  // The `replaying` phase is the common case for sub-case 3. The
  // `waking` phase could in principle reach sub-case 3 if a live wake
  // interrupted before any assistant content arrived; today's wire
  // does not exercise this path (live `turn_complete` on a wake
  // always follows at least a `message_start`), but the same commit
  // path serves it correctly if the wire shape ever changes.
  if (state.activeMsgId === null) {
    if (state.phase === "idle") {
      return { state, effects: [] };
    }
    if (state.pendingTurn === null) {
      tugDevLogStore.warn(
        "code-session-store",
        "dropping turn_complete with no pendingTurn or activeMsgId",
        { eventMsgId: event.msg_id, phase: state.phase },
      );
      return { state, effects: [] };
    }
    // Sub-case 3 fall-through: pendingTurn-based commit via the
    // existing path below. `buildTurnEntry` uses
    // `state.pendingTurn.turnKey` to look up scratch — `msgId` is
    // recorded onto the TurnEntry for diagnostics but does not gate
    // the lookup.
  }

  const msgId = event.msg_id ?? state.activeMsgId ?? "";

  // Dedupe by msg_id. A `turn_complete` whose id is already in
  // `committedMsgIds` is a no-op — defense-in-depth against a
  // supervisor that re-emits a turn (e.g. replay overlapping live).
  // Logged at debug level so a real regression is observable without
  // spamming the console on every legitimate redundant event.
  //
  // Belt-and-suspenders: a duplicate `turn_complete` is also a signal
  // that an upstream emitter opened a phantom cycle for an already-
  // committed msg_id — the prior `add_user_message` (if any) wrote
  // junk to `pendingTurn` and any preceding content frames wrote to
  // scratch. If we early-return here without clearing that pending
  // state, `replay_complete`'s "in-flight cycle survived the bracket"
  // branch (chain-link 13) sees `pendingTurn !== null` and transitions
  // phase to `streaming` after replay closes — leaving the card stuck
  // with `canInterrupt=true` and a Stop button that can't reach the
  // wire. Clear the stale pending state so duplicate turn_complete
  // events are inert beyond the no-op transcript commit.
  // An empty msg_id is NOT an identity — it was the shared key every
  // no-content turn (`/compact`, `/model`, any local-echo command) used
  // to carry before tugcode stamped opener-id fallbacks, and deduping on
  // it swallowed the second such turn's commit: scratch dropped (the
  // `/compact` row vanished until a reload replayed it) and phase left
  // stranded in-flight ("Waiting" forever). Dedupe only real identities.
  if (msgId !== "" && state.committedMsgIds.has(msgId)) {
    tugDevLogStore.warn(
      "code-session-store",
      "dropping duplicate turn_complete",
      { msgId },
    );
    return {
      state: {
        ...state,
        // A phantom cycle can have advanced the live phase ladder (e.g.
        // its stdout echo streamed a text delta) — dropping the commit
        // must not strand an in-flight phase with no turn behind it.
        // Replay/wake brackets own their own exits; leave them alone.
        phase:
          state.phase === "replaying" || state.phase === "waking"
            ? state.phase
            : "idle",
        pendingTurn: null,
        activeMsgId: state.activeMsgId === msgId ? null : state.activeMsgId,
        scratch: withoutPendingTurnScratch(state),
      },
      effects: [],
    };
  }

  const isSuccess = event.result === "success";
  // Choose the terminal reason for this completion:
  //  - `result: "interrupted"` is an explicit cut-off terminal —
  //    tugcode's replay translator emits it for orphan-interrupted
  //    submissions and for a dangling cold-resume turn ([replay-1]).
  //    Honored directly so a replayed interrupted turn is not
  //    mislabelled `error` (the replay path has no `interruptInFlight`).
  //  - a wire-side `turn_complete(error)` that landed because the user
  //    pressed Stop (CASE B) maps to `"interrupted"` via the live
  //    `interruptInFlight` signal set by `handleInterrupt`.
  //  - otherwise an error-result completion is a genuine `"error"`.
  const turnEndReason: TurnEndReason = isSuccess
    ? "complete"
    : event.result === "interrupted"
      ? "interrupted"
      : state.interruptInFlight
        ? "interrupted"
        : "error";
  // Pass `event.telemetry` straight through: when the supervisor
  // attached a persisted telemetry block (replay path), buildTurnEntry
  // adopts it via `mergeTurnTelemetry`; when it's undefined (live
  // path), buildTurnEntry derives the block from reducer state.
  // `event.timestamp` (replay path) carries the original JSONL terminal
  // assistant entry's wall-clock time; without it, `endedAt` would
  // reset to the replay-emission time and the Z1 transcript timestamp
  // would re-stamp on every session restore.
  const endedAt = event.timestamp ?? Date.now();
  const entry: TurnEntry = buildTurnEntry(
    state,
    msgId,
    turnEndReason,
    endedAt,
    event.telemetry,
  );
  // Restore `sessionInitTokens` on the resume path: the live capture
  // (`handleStreamingUsage` / `handleCostUpdate`) never ran for a
  // replayed session, so the value rides in on the first replayed
  // `turn_complete`'s inlined telemetry. Keep an already-captured
  // value; otherwise adopt the inlined one.
  const sessionInitTokens =
    state.sessionInitTokens ?? event.telemetry?.sessionInitTokens ?? null;
  // Close any open per-turn pause segments (awaiting-approval +
  // interrupt-in-flight) into their interval-array projections. The
  // committed `TurnEntry` above already folds the scalar
  // accumulators; this is the parallel projection for live-derivation
  // consumers (see `deriveInflightActiveMs` in telemetry.ts). The
  // transport-downtime segment is owned by the transport handlers
  // and deliberately not closed here.
  const closedPauseSegments = closeTurnPauseSegments(state, endedAt);

  const scratch = withoutPendingTurnScratch(state);
  const committedMsgIds = new Set(state.committedMsgIds);
  // Never record "" as a committed identity (see the dedupe gate above):
  // one legacy no-content commit would poison the set and swallow every
  // later no-content turn.
  if (msgId !== "") {
    committedMsgIds.add(msgId);
  }

  // While replaying, turn_complete commits a transcript entry but
  // stays in `replaying` — the bracket's terminal `replay_complete`
  // is what returns the phase to `idle`. Skip the queued-send flush
  // (replay produces no queued sends) and the `clear-inflight` effect
  // (replay never wrote to the in-flight streaming document).
  if (state.phase === "replaying") {
    return {
      state: {
        ...state,
        // phase stays `replaying`
        activeMsgId: null,
        scratch,
        toolUseStartedAt: new Map(),
        pendingApproval: null,
        pendingQuestion: null,
        prevPhase: null,
        pendingTurn: null,
        committedMsgIds,
        sessionInitTokens,
        ...resetPerTurnTelemetry(),
        ...closedPauseSegments,
      },
      // A load-previous bracket stages its turns for a front-commit at
      // `replay_complete`; a normal bracket appends newest-at-the-end. A
      // suppressed turn (a canceled `/compact`'s throwaway summarization
      // turn, replayed from JSONL) is dropped — it must never commit.
      effects:
        state.pendingTurn?.suppressed === true
          ? []
          : [
              {
                kind: "append-transcript",
                entry,
                ...(state.replayPrependActive ? { prepend: true } : {}),
              },
            ],
    };
  }

  // The wake bracket closes here — `turn_complete` is the implicit
  // close (no separate `wake_complete` frame, by design at [D01]).
  // Mirrors the normal `streaming → idle` commit path with two
  // additions: clears `wakeTrigger`, and the committed entry's
  // `messages` carries no `user_message` Message — that absence IS
  // the substrate's wake discriminator under [D07] (consumers that
  // need to gate on user-row presence inline-check
  // `turn.messages[0]?.kind === "user_message"`).
  if (state.phase === "waking") {
    // Wake-close commit effects — identical to the normal branch below.
    // Wakes are live turns, so per-turn telemetry is persisted the same
    // way.
    const wakeCommitEffects: Effect[] = [
      { kind: "append-transcript", entry },
      { kind: "clear-inflight" },
      ...(event.telemetry === undefined
        ? [buildRecordTelemetryEffect(entry, sessionInitTokens)]
        : []),
    ];
    // A wake settling with a queued send is a turn boundary too: drain
    // the queue here (same single-tick collapse as the success branch),
    // otherwise the message strands at idle with no later trigger to
    // flush it — nothing drives the "gets its own turn" the old comment
    // assumed. `wakeTrigger` is cleared as the wake closes.
    if (state.queuedSends.length > 0) {
      // A turn that ended is a proving event for a held prompt ([P10]): the
      // wire carried a turn to completion, so whatever the hold was raised
      // for has passed. Release before the flush, so the head this drains is
      // the released one.
      return flushQueuedHeadResult(
        withHeldReleased(state),
        scratch,
        committedMsgIds,
        sessionInitTokens,
        wakeCommitEffects,
        { wakeTrigger: null },
      );
    }
    return {
      state: {
        ...state,
        phase: "idle",
        activeMsgId: null,
        scratch,
        toolUseStartedAt: new Map(),
        pendingApproval: null,
        pendingQuestion: null,
        prevPhase: null,
        pendingTurn: null,
        wakeTrigger: null,
        // A wake does not touch `lastError` — the user did not submit
        // anything, so a wake-success does not "clear" a prior error
        // cue that still applies to the user's most recent action. The
        // normal commit branch below clears on success because a
        // successful user turn is the recovery signal; a wake is not.
        committedMsgIds,
        sessionInitTokens,
        ...resetPerTurnTelemetry(),
        ...closedPauseSegments,
      },
      effects: wakeCommitEffects,
    };
  }

  // Single-tick collapse: a queued send on a successful turn flushes
  // in the same dispatch as the commit, so observers see the final
  // phase as `submitting`, not a transient `idle`. Persist the per-turn
  // telemetry block via the supervisor's SessionLedger so the next
  // resume can inline it onto the replayed `turn_complete`. Live path
  // only — the replaying branch above returns before reaching here, and
  // inlined event.telemetry on a non-replay event would be an upstream
  // bug (the wire shape's replay-only contract is enforced by tugcast's
  // supervisor; defensively, only persist when there was no inline
  // source).
  if (isSuccess && state.queuedSends.length > 0) {
    const successCommitEffects: Effect[] = [
      { kind: "append-transcript", entry },
      { kind: "clear-inflight" },
      ...(event.telemetry === undefined
        ? [buildRecordTelemetryEffect(entry, sessionInitTokens)]
        : []),
    ];
    // Released for the same reason the wake branch releases: the turn
    // reached its end over the wire, which is the proof a hold was waiting
    // for.
    return flushQueuedHeadResult(
      withHeldReleased(state),
      scratch,
      committedMsgIds,
      sessionInitTokens,
      successCommitEffects,
      {},
    );
  }

  // [P07] — the exhausted-retries route. A turn that ends with claude's SDK
  // out of retries, having produced nothing but the user's own message, is a
  // submission that never reached the model. The words go back to the
  // composer through `pendingDraftRestore` — the same slot a CASE A cancel
  // uses — and emphatically NOT back onto the held queue.
  //
  // There is no re-send path here and there must not be one: the prompt is
  // already in claude's session JSONL, so a re-send writes a second user
  // record and the next `--resume` replays both, a duplicate turn visible
  // forever. The committed entry stands in the transcript as the interrupted
  // attempt it was, and the person who can see what happened is one keystroke
  // from sending it again.
  const exhaustedRestore =
    state.apiRetry !== null &&
    state.apiRetry.attempt >= state.apiRetry.maxRetries &&
    state.pendingTurn?.suppressed !== true &&
    entry.messages.length === 1 &&
    entry.messages[0].kind === "user_message"
      ? {
          text: entry.messages[0].text,
          atoms: entry.messages[0].attachments,
        }
      : null;

  return {
    state: {
      ...state,
      phase: "idle",
      activeMsgId: null,
      scratch,
      toolUseStartedAt: new Map(),
      pendingApproval: null,
      pendingQuestion: null,
      prevPhase: null,
      pendingTurn: null,
      pendingDraftRestore: exhaustedRestore ?? state.pendingDraftRestore,
      // Error-path queue clear: if a turn errored out without a
      // preceding `interrupt()`, any enqueued follow-ups are dropped.
      // Interrupt-driven paths already cleared the queue.
      queuedSends: isSuccess ? state.queuedSends : [],
      // A successful turn clears any lingering `lastError` from an
      // earlier errored-phase recovery.
      lastError: isSuccess ? null : state.lastError,
      committedMsgIds,
      ...resetPerTurnTelemetry(),
      ...closedPauseSegments,
    },
    effects: [
      // A suppressed turn (the `/compact` seed) ran on claude but never
      // enters the transcript — drop the append and its telemetry. The
      // in-flight document is still cleared.
      ...(state.pendingTurn?.suppressed === true
        ? []
        : [{ kind: "append-transcript" as const, entry }]),
      { kind: "clear-inflight" },
      // Persist per-turn telemetry via the supervisor's SessionLedger
      // on the live path. See note above in the queue-flush branch.
      ...(state.pendingTurn?.suppressed !== true && event.telemetry === undefined
        ? [buildRecordTelemetryEffect(entry, sessionInitTokens)]
        : []),
    ],
  };
}

/**
 * tugcode's sentinel for "the turn streamed nothing before it was cut". It is
 * not model output and must never enter the transcript as assistant text — a
 * cancelled turn that produced nothing commits empty, which is the honest
 * record of what happened. A real turn whose entire output was this exact
 * string loses one line, which is the cheaper of the two mistakes.
 */
const CANCEL_NO_PARTIAL_SENTINEL = "User interrupted";

/**
 * `turn_cancelled` — the clean cancel receipt. tugcode writes it wherever a
 * turn ends with `ActiveTurn.interrupted` set: the escalation ladder that
 * force-terminates a wedged claude after `INTERRUPT_ACK_GRACE_MS`, the drain's
 * EOF path, and `stop_all_work`. Until this handler existed the deck dropped
 * the frame at the `KNOWN_CODE_OUTPUT_TYPES` guard, and the only clearer of
 * `interruptInFlight` was `turn_complete` — so a stop that escalated left the
 * card reading "Interrupting" with no frame able to end it.
 *
 * The commit is `handleTurnComplete`'s interrupted commit, reached by a
 * different frame: same `buildTurnEntry`, same `closeTurnPauseSegments` so
 * `deriveInflightActiveMs` stays correct, same `resetPerTurnTelemetry` spread
 * that clears `interruptInFlight` / `pendingInterruptReason` / `apiRetry`.
 */
function handleTurnCancelled(
  state: CodeSessionState,
  event: TurnCancelledEvent,
): { state: CodeSessionState; effects: Effect[] } {
  // Idempotence guard, in `handleReplayComplete`'s style: a cancel with no
  // turn behind it has nothing to commit. It reaches us when the ladder raced
  // a `turn_complete` that already settled the turn, or when the frame lands
  // after a transport-lost commit. tugcode's replay translator emits
  // `turn_complete(result: "interrupted")` rather than this frame, so a cancel
  // inside a replay bracket is a wire-shape regression, not a path to serve.
  // Every drop returns the same state reference, so no observer re-renders.
  if (
    state.pendingTurn === null ||
    state.phase === "idle" ||
    state.phase === "replaying"
  ) {
    tugDevLogStore.warn(
      "code-session-store",
      "dropping turn_cancelled with no live turn to cancel",
      { msgId: event.msg_id, phase: state.phase },
    );
    return { state, effects: [] };
  }

  const msgId =
    event.msg_id !== "" ? event.msg_id : (state.activeMsgId ?? "");
  // Same dedupe contract as `handleTurnComplete`: an identity already
  // committed is a turn this frame cannot close twice. "" is never an
  // identity — it is the shared key every no-content turn carries.
  if (msgId !== "" && state.committedMsgIds.has(msgId)) {
    tugDevLogStore.warn("code-session-store", "dropping duplicate turn_cancelled", {
      msgId,
    });
    return { state, effects: [] };
  }

  const turnKey = state.pendingTurn.turnKey;
  const endedAt = Date.now();

  // The partial fold. On the live path the content frames already wrote the
  // streamed text into scratch, so `partial_result` is a duplicate and folding
  // it would double the turn's last block. It is the only copy when no content
  // frame reached the deck — a turn cut while suppressed, or one cut before
  // its first delta — so fold it exactly then, and only when it is real text
  // rather than tugcode's nothing-streamed sentinel.
  const scratchEntry = state.scratch.get(turnKey);
  const hasAssistantContent =
    scratchEntry !== undefined &&
    scratchEntry.messages.some((m) => m.kind !== "user_message");
  const partial = event.partial_result;
  const foldPartial =
    !hasAssistantContent &&
    partial !== "" &&
    partial !== CANCEL_NO_PARTIAL_SENTINEL;
  const scratchForCommit =
    foldPartial && scratchEntry !== undefined
      ? withScratchEntry(state.scratch, turnKey, {
          ...scratchEntry,
          messages: [
            ...scratchEntry.messages,
            {
              kind: "assistant_text" as const,
              messageKey: wireMessageKey(msgId, 0),
              createdAt: endedAt,
              text: partial,
            },
          ],
        })
      : state.scratch;

  // The reason bridge. `buildTurnEntry` reads `pendingInterruptReason` off the
  // pre-reset state, so a recovery cancel is named by setting the field here
  // rather than by widening the builder's signature. A cancel landing on top
  // of an app-flow interrupt keeps the flow's own reason: logout and Configure
  // Tug are the truer cause, and they are what the user acted on.
  const pendingInterruptReason: InterruptReason | null =
    event.is_recovery === true && state.pendingInterruptReason === null
      ? "recovery"
      : state.pendingInterruptReason;

  const commitState: CodeSessionState = {
    ...state,
    scratch: scratchForCommit,
    pendingInterruptReason,
  };
  const entry = buildTurnEntry(
    commitState,
    msgId,
    "interrupted",
    endedAt,
    undefined,
  );

  const closedPauseSegments = closeTurnPauseSegments(state, endedAt);
  const scratch = withoutPendingTurnScratch(commitState);
  const committedMsgIds = new Set(state.committedMsgIds);
  if (msgId !== "") {
    committedMsgIds.add(msgId);
  }

  const suppressed = state.pendingTurn.suppressed === true;
  const commitEffects: Effect[] = [
    ...(suppressed ? [] : [{ kind: "append-transcript" as const, entry }]),
    { kind: "clear-inflight" },
    // A cancel is always live — the replay path never reaches here — so the
    // per-turn telemetry block is always derived and always persisted.
    ...(suppressed
      ? []
      : [buildRecordTelemetryEffect(entry, state.sessionInitTokens)]),
  ];

  // A queued send flushes here, on the same single-tick collapse the wake
  // branch uses. The user-cancel path never exercises it — `handleInterrupt`
  // cleared the queue before the stop went out — so what this serves is the
  // recovery cancel, where the user stopped nothing and the message they
  // posted mid-turn is waiting for exactly this boundary. Stranding it at idle
  // would leave nothing to flush it later.
  // A held head stays held here. A cancel is not a proving event — nothing
  // reached the far end — so flushing one would send the prompt into exactly
  // the dead path it was held for.
  if (state.queuedSends.length > 0 && !headIsHeld(state)) {
    return flushQueuedHeadResult(
      commitState,
      scratch,
      committedMsgIds,
      state.sessionInitTokens,
      commitEffects,
      { wakeTrigger: null },
    );
  }

  return {
    state: {
      ...state,
      phase: "idle",
      activeMsgId: null,
      scratch,
      toolUseStartedAt: new Map(),
      pendingApproval: null,
      pendingQuestion: null,
      prevPhase: null,
      pendingTurn: null,
      // A cancel closes a wake bracket the same way `turn_complete` does:
      // there is no separate `wake_complete` frame ([D01]).
      wakeTrigger: null,
      committedMsgIds,
      ...resetPerTurnTelemetry(),
      ...closedPauseSegments,
    },
    effects: commitEffects,
  };
}

/**
 * `interrupt_noop` — tugcode's receipt for an interrupt that found nothing to
 * interrupt: no claude process (`no_process`), or a live claude with no turn
 * open (`no_turn`).
 *
 * It ends the interrupt and nothing else. The per-interrupt flags come down
 * and the open in-flight segment is closed into its intervals projection, so
 * `deriveInflightActiveMs` still accounts for the time the user spent
 * waiting; the phase, the transcript and `pendingTurn` are left exactly as
 * they were, because by construction there was no turn for this receipt to
 * close.
 *
 * `no_turn` can arrive while the deck believes a turn IS in flight — the two
 * sides disagreeing about whether one is open is precisely the condition that
 * produced the receipt. Ending the deck's turn here would be the worse
 * reading of that disagreement: it would discard a turn that may still be
 * streaming, on the word of the side that has already said it is not
 * watching one. Clearing the flag is the honest minimum, and it is enough —
 * the card stops saying "Interrupting" and goes back to showing whatever it
 * actually has.
 */
function handleInterruptNoop(
  state: CodeSessionState,
  event: InterruptNoopEvent,
): { state: CodeSessionState; effects: Effect[] } {
  if (
    !state.interruptInFlight &&
    state.pendingInterruptReason === null &&
    state.interruptInFlightSegmentStartedAt === null &&
    !state.stopStalled
  ) {
    // Nothing to clear. Returning the same reference keeps `getSnapshot()`
    // stable for `useSyncExternalStore`, the same idempotence contract every
    // drop in this file keeps.
    return { state, effects: [] };
  }
  tugDevLogStore.warn(
    "code-session-store",
    "interrupt reached the bridge with nothing to interrupt",
    { reason: event.reason },
  );
  const end = Date.now();
  const interruptInFlightIntervals =
    state.interruptInFlightSegmentStartedAt === null
      ? state.interruptInFlightIntervals
      : [
          ...state.interruptInFlightIntervals,
          [state.interruptInFlightSegmentStartedAt, end] as const,
        ];
  return {
    state: {
      ...state,
      interruptInFlight: false,
      pendingInterruptReason: null,
      interruptInFlightSegmentStartedAt: null,
      interruptInFlightIntervals,
      // A receipt, late or not, answers the stop. Force Stop is for a stop
      // nothing answered, and this is the thing answering it.
      stopStalled: false,
    },
    effects: [],
  };
}

// ---------------------------------------------------------------------------
// Control request forward + respond actions
// ---------------------------------------------------------------------------

/**
 * Extract the `ControlRequestForward` fields from the event envelope.
 * Strips `type` so the stored record matches the public type. All other
 * fields (including unknown ones from forward-compat wire versions)
 * pass through so UI code can read `tool_name`, `input`, `options`,
 * `question`, etc.
 */
function extractForward(
  event: ControlRequestForwardEvent,
): ControlRequestForward {
  const { type: _type, ...rest } = event;
  return rest as ControlRequestForward;
}

function handleControlRequestForward(
  state: CodeSessionState,
  event: ControlRequestForwardEvent,
): { state: CodeSessionState; effects: Effect[] } {
  // Meaningful in two windows:
  //   1. **Live turn** — the normal path. claude has called a tool
  //      requiring permission, the SDK forwards `can_use_tool`, and
  //      the reducer flips the phase to `awaiting_approval`.
  //   2. **Replay bracket** — the in-flight snapshot path. tugcode's
  //      `emitInflightTurnFromActiveTurn` re-emits any pending
  //      `control_request_forward` from `pendingControlRequests` so a
  //      Maker > Reload mid-dialog can rehydrate the dialog
  //      against the same `request_id`. During replay we stash the
  //      forward into `pendingApproval` / `pendingQuestion` but do
  //      NOT transition the phase — `replay_complete` owns the post-
  //      bracket phase decision and reads these fields to land in
  //      `awaiting_approval` instead of the normal `streaming`
  //      tail-preservation branch.
  // Outside both windows, silently drop — the reducer stays total and
  // the mid-turn gate tolerates stray forwards from a stale feed
  // replay.
  const isReplay = state.phase === "replaying";
  const isWaking = state.phase === "waking";
  if (
    !isReplay &&
    !isWaking &&
    state.phase !== "streaming" &&
    state.phase !== "tool_work" &&
    state.phase !== "awaiting_first_token" &&
    state.phase !== "submitting" &&
    state.phase !== "awaiting_approval"
  ) {
    return { state, effects: [] };
  }

  const forward = extractForward(event);
  if (state.phase === "awaiting_approval") {
    // A second dialog while one is already up. Dropping it — the old
    // behavior — left the CLI blocked on a request no dialog would ever
    // answer and the session latched `awaiting_approval` forever. Stash it
    // into its own slot instead, so answering the first dialog reveals it;
    // the phase and `prevPhase` are already right, and the awaiting clock is
    // already running. A slot already occupied by an earlier forward of the
    // same kind keeps the earlier one — swapping mid-decision would orphan
    // the caller the user is looking at.
    return {
      state: {
        ...state,
        pendingApproval:
          event.is_question || state.pendingApproval !== null
            ? state.pendingApproval
            : forward,
        pendingQuestion:
          event.is_question && state.pendingQuestion === null
            ? forward
            : state.pendingQuestion,
      },
      effects: [],
    };
  }
  if (isReplay) {
    // Stash only; do not move off `replaying`. `replay_complete`
    // checks for a populated pending dialog and lands in
    // `awaiting_approval` accordingly. The awaiting-approval clock
    // starts when the post-bracket phase resolves, not here — the
    // user wasn't actually awaiting during the replay window.
    return {
      state: {
        ...state,
        pendingApproval: event.is_question ? state.pendingApproval : forward,
        pendingQuestion: event.is_question ? forward : state.pendingQuestion,
      },
      effects: [],
    };
  }
  const next: CodeSessionState = {
    ...state,
    phase: "awaiting_approval",
    prevPhase: state.phase,
    pendingApproval: event.is_question ? state.pendingApproval : forward,
    pendingQuestion: event.is_question ? forward : state.pendingQuestion,
    // Stamp the entry-side timestamp for the awaiting-approval clock.
    // If a prior dialog's `awaitingApprovalSince` is still set (e.g.
    // back-to-back forwards without a respond in between — shouldn't
    // happen on a sane wire, but defensive), preserve it: the user
    // never left the dialog state, so the interval is still open.
    awaitingApprovalSince: state.awaitingApprovalSince ?? Date.now(),
  };
  return { state: next, effects: [] };
}

/**
 * Close the awaiting-approval interval and fold it into the
 * accumulator. Used by both `handleRespondApproval` and
 * `handleRespondQuestion` so the two dialog kinds count identically.
 *
 * Also appends the closed `[since, end]` pair onto
 * `awaitingApprovalIntervals` so live-derivation (which unions
 * per-axis intervals) sees the closed segment. The scalar accumulator
 * and the intervals array are populated in lockstep — the scalar
 * continues to drive the committed `TurnEntry`, the array drives the
 * live in-flight clock.
 */
function closeAwaitingApprovalInterval(
  state: CodeSessionState,
  end: number = Date.now(),
): {
  awaitingApprovalSince: null;
  awaitingApprovalAccumulatedMs: number;
  awaitingApprovalIntervals: ReadonlyArray<readonly [number, number]>;
} {
  if (state.awaitingApprovalSince === null) {
    return {
      awaitingApprovalSince: null,
      awaitingApprovalAccumulatedMs: state.awaitingApprovalAccumulatedMs,
      awaitingApprovalIntervals: state.awaitingApprovalIntervals,
    };
  }
  const start = state.awaitingApprovalSince;
  const elapsed = Math.max(0, end - start);
  return {
    awaitingApprovalSince: null,
    awaitingApprovalAccumulatedMs: state.awaitingApprovalAccumulatedMs + elapsed,
    awaitingApprovalIntervals: [
      ...state.awaitingApprovalIntervals,
      [start, end] as const,
    ],
  };
}

/**
 * Close the in-flight transport-downtime interval. Folds the elapsed
 * non-online time into the scalar accumulator AND appends the closed
 * `[since, end]` pair onto `transportDowntimeIntervals`. Used by
 * `handleTransportSettled` when the wire returns to `online`. No-op
 * (returns the existing references) when no segment is open.
 */
function closeTransportDowntimeInterval(
  state: CodeSessionState,
  end: number = Date.now(),
): {
  transportNonOnlineSince: null;
  transportDowntimeAccumulatedMs: number;
  transportDowntimeIntervals: ReadonlyArray<readonly [number, number]>;
} {
  if (state.transportNonOnlineSince === null) {
    return {
      transportNonOnlineSince: null,
      transportDowntimeAccumulatedMs: state.transportDowntimeAccumulatedMs,
      transportDowntimeIntervals: state.transportDowntimeIntervals,
    };
  }
  const start = state.transportNonOnlineSince;
  const elapsed = Math.max(0, end - start);
  return {
    transportNonOnlineSince: null,
    transportDowntimeAccumulatedMs:
      state.transportDowntimeAccumulatedMs + elapsed,
    transportDowntimeIntervals: [
      ...state.transportDowntimeIntervals,
      [start, end] as const,
    ],
  };
}

function handleRespondApproval(
  state: CodeSessionState,
  event: RespondApprovalActionEvent,
): { state: CodeSessionState; effects: Effect[] } {
  // No pending approval — drop the action. Prevents accidental writes
  // if the UI double-clicks or replays an action after dispose.
  if (state.pendingApproval === null) {
    return { state, effects: [] };
  }

  // The decision is sent out on the wire below and the SDK's
  // tool_use/tool_result for the gated tool IS the durable transcript
  // artifact — there is no client-side record kept here. See
  // `#step-3-5` in `arc/archive/dev-interactive-dialogs.md` for why
  // JSONL cannot durably reconstruct a separate permission record.
  //
  // The phase restores only when this was the LAST dialog up. A question can
  // be pending beside the approval (a stacked forward, or a replay bracket
  // that stashed both), and restoring under it would paint the session as
  // working while a dialog still waits — the stuck state's own recipe. The
  // awaiting interval stays open for the same reason: the user is still
  // waiting, just on the other dialog.
  const stillAwaiting = state.pendingQuestion !== null;
  const next: CodeSessionState = stillAwaiting
    ? { ...state, pendingApproval: null }
    : {
        ...state,
        phase: state.prevPhase ?? "streaming",
        prevPhase: null,
        pendingApproval: null,
        // Close and fold the awaiting-approval interval into the
        // accumulator. Same fold for permission and question dialogs;
        // see `closeAwaitingApprovalInterval`.
        ...closeAwaitingApprovalInterval(state),
      };
  return {
    state: next,
    effects: [
      {
        kind: "send-frame",
        msg: {
          type: "tool_approval",
          request_id: event.request_id,
          decision: event.decision,
          updatedInput: event.updatedInput,
          message: event.message,
          updatedPermissions: event.updatedPermissions,
        },
      },
    ],
  };
}

function handleRespondQuestion(
  state: CodeSessionState,
  event: RespondQuestionActionEvent,
): { state: CodeSessionState; effects: Effect[] } {
  if (state.pendingQuestion === null) {
    return { state, effects: [] };
  }

  // Mirror of `handleRespondApproval`: restore only when no approval dialog
  // remains beside this question, else the phase would lie under it.
  const stillAwaiting = state.pendingApproval !== null;
  const next: CodeSessionState = stillAwaiting
    ? { ...state, pendingQuestion: null }
    : {
        ...state,
        phase: state.prevPhase ?? "streaming",
        prevPhase: null,
        pendingQuestion: null,
        ...closeAwaitingApprovalInterval(state),
      };
  // Two mutually-exclusive outcomes share one frame: answer the questions
  // (`answers`) or decline and reply in prose (`response`, the `Chat about
  // this` path). A decline supersedes — emit `response` when present.
  return {
    state: next,
    effects: [
      {
        kind: "send-frame",
        msg:
          event.response !== undefined
            ? {
                type: "question_answer",
                request_id: event.request_id,
                response: event.response,
              }
            : {
                type: "question_answer",
                request_id: event.request_id,
                answers: event.answers ?? {},
              },
      },
    ],
  };
}

/**
 * Emit a `permission_mode` frame and change no transcript state. The mode
 * the chip displays comes back from the post-mutation `system_metadata`
 * round-trip (owned by `SessionMetadataStore`), not from this dispatch —
 * keeping the indicator truthful even if a mode change races a turn.
 */
function handleSetPermissionMode(
  state: CodeSessionState,
  event: SetPermissionModeActionEvent,
): { state: CodeSessionState; effects: Effect[] } {
  return {
    state,
    effects: [
      { kind: "send-frame", msg: { type: "permission_mode", mode: event.mode } },
    ],
  };
}

/**
 * Emit a `model_change` frame and change no transcript state. The model the
 * chip displays comes back from the post-mutation `system_metadata` round-trip
 * (owned by `SessionMetadataStore`), not from this dispatch — keeping the
 * indicator truthful even if a model change races a turn.
 */
function handleSetModel(
  state: CodeSessionState,
  event: { type: "set_model"; model: string },
): { state: CodeSessionState; effects: Effect[] } {
  return {
    state,
    effects: [
      { kind: "send-frame", msg: { type: "model_change", model: event.model } },
    ],
  };
}

/**
 * Emit an `effort_change` frame and change no transcript state. tugcode
 * applies the level by respawning claude with `--effort` + `--resume` (no live
 * control verb — [R07]); the Z4B effort chip reflects it optimistically
 * (`SessionMetadataStore`), since a resumed respawn emits no fresh metadata.
 */
function handleSetEffort(
  state: CodeSessionState,
  event: { type: "set_effort"; effort: string },
): { state: CodeSessionState; effects: Effect[] } {
  return {
    state,
    effects: [
      { kind: "send-frame", msg: { type: "effort_change", effort: event.effort } },
    ],
  };
}

// ---------------------------------------------------------------------------
// /rewind ([#step-7-3]) — anchor capture, diff-stat previews, applied ack +
// L26-safe local truncation. The transcript array lives in the store wrapper
// (NOT reducer state, [D04]), so truncation is an effect the wrapper applies
// via `truncateTranscriptAtAnchor`; everything else is pure reducer state.
// ---------------------------------------------------------------------------

/**
 * Stamp the live `/rewind` anchor ([#step-7-1]) onto the in-flight turn.
 * First wins; a no-op when there's no pending turn (between turns) or the
 * anchor is already set (replay opener carried it, or a duplicate frame).
 */
function handlePromptAnchor(
  state: CodeSessionState,
  event: PromptAnchorEvent,
): { state: CodeSessionState; effects: Effect[] } {
  const pending = state.pendingTurn;
  if (
    pending === null ||
    pending.promptUuid !== undefined ||
    typeof event.promptUuid !== "string" ||
    event.promptUuid.length === 0
  ) {
    return { state, effects: [] };
  }
  return {
    state: {
      ...state,
      pendingTurn: { ...pending, promptUuid: event.promptUuid },
    },
    effects: [],
  };
}

/** Fold a `rewind_preview_result` diff-stat into the cache ([#step-7-3]). */
function handleRewindPreviewResult(
  state: CodeSessionState,
  event: RewindPreviewResultEvent,
): { state: CodeSessionState; effects: Effect[] } {
  const next = new Map(state.rewindPreviews);
  next.set(event.promptUuid, {
    loading: false,
    canRewind: event.canRewind,
    ...(event.filesChanged !== undefined
      ? { filesChanged: event.filesChanged }
      : {}),
    ...(event.insertions !== undefined ? { insertions: event.insertions } : {}),
    ...(event.deletions !== undefined ? { deletions: event.deletions } : {}),
    ...(event.error !== undefined ? { error: event.error } : {}),
    ...(event.conversationRewindable !== undefined
      ? { conversationRewindable: event.conversationRewindable }
      : {}),
  });
  return { state: { ...state, rewindPreviews: next }, effects: [] };
}

/**
 * Record an applied-rewind ack ([#step-7-2]) and, for a successful
 * conversation/both rewind, emit the local transcript truncation. The
 * truncation is coupled to the ack (not optimistic) so a refused rewind never
 * mangles the transcript.
 *
 * The same successful ack also routes the stashed rewound-to command (from the
 * `session_rewind_request`) into `pendingDraftRestore`, so the composer offers
 * that command back for re-edit — the prompt-entry seeds it iff its editor is
 * empty, exactly as for a CASE A interrupt / queued-send cancel. Seeding the
 * slot from a wire-event reducer transition (never a React effect) keeps the
 * editor out of any store→React→store cycle ([L02]); the stash is cleared on
 * any ack so a refused / non-matching result never seeds.
 */
function handleRewindResult(
  state: CodeSessionState,
  event: RewindResultEvent,
): { state: CodeSessionState; effects: Effect[] } {
  const ack: RewindResultAck = {
    promptUuid: event.promptUuid,
    scope: event.scope,
    canRewind: event.canRewind,
    ...(event.error !== undefined ? { error: event.error } : {}),
    ...(event.newSessionId !== undefined
      ? { newSessionId: event.newSessionId }
      : {}),
  };
  const effects: Effect[] = [];
  const conversationRewound =
    event.canRewind &&
    (event.scope === "conversation" || event.scope === "both");
  if (conversationRewound) {
    effects.push({ kind: "truncate-transcript", promptUuid: event.promptUuid });
  }
  // Route the stashed command back into the composer on a successful
  // conversation/both rewind whose anchor matches; clear the stash on any ack.
  const stash = state.pendingRewindDraft;
  const seedDraft =
    conversationRewound && stash !== null && stash.promptUuid === event.promptUuid;
  return {
    state: {
      ...state,
      lastRewindResult: ack,
      pendingRewindDraft: null,
      ...(seedDraft
        ? {
            pendingDraftRestore: { text: stash.text, atoms: stash.atoms },
          }
        : {}),
    },
    effects,
  };
}

/**
 * Store-method action: mark a turn's preview loading and emit the dry-run
 * `rewind_preview` frame ([#step-7-1]). The sheet owns the cache discipline
 * (request visible/uncached rows only); this just records the in-flight state.
 */
function handleRequestRewindPreview(
  state: CodeSessionState,
  event: RequestRewindPreviewActionEvent,
): { state: CodeSessionState; effects: Effect[] } {
  const next = new Map(state.rewindPreviews);
  next.set(event.promptUuid, { loading: true, canRewind: false });
  return {
    state: { ...state, rewindPreviews: next },
    effects: [
      {
        kind: "send-frame",
        msg: { type: "rewind_preview", promptUuid: event.promptUuid },
      },
    ],
  };
}

/**
 * Store-method action: emit the `session_rewind` apply frame ([#step-7-2]) and
 * stash the rewound-to command so a successful ack can offer it back in the
 * composer ({@link handleRewindResult}). Stashing here (not seeding the editor
 * now) keeps the seeding coupled to the wire ack, like the truncation.
 */
function handleSessionRewindRequest(
  state: CodeSessionState,
  event: SessionRewindActionEvent,
): { state: CodeSessionState; effects: Effect[] } {
  return {
    state: {
      ...state,
      pendingRewindDraft:
        event.draft !== undefined
          ? {
              promptUuid: event.promptUuid,
              text: event.draft.text,
              atoms: event.draft.atoms,
            }
          : null,
    },
    effects: [
      {
        kind: "send-frame",
        msg: {
          type: "session_rewind",
          promptUuid: event.promptUuid,
          scope: event.scope,
          ...(event.fork !== undefined ? { fork: event.fork } : {}),
        },
      },
    ],
  };
}

/**
 * L26-safe local transcript truncation ([#step-7-3]). Returns the prefix of
 * `transcript` strictly BEFORE the turn whose `promptUuid` matches `anchor` —
 * dropping that turn and every turn after it, matching tugcode's JSONL chop
 * ([#step-7-2]: rewinding to a turn returns to the state before it). Survivors
 * are the SAME `TurnEntry` references, so their `turnKey`/`msgId` (React's
 * reconciliation identity inputs) are byte-identical and no mount tears down.
 * Returns the array unchanged (same reference) when no turn carries the
 * anchor — a stale/absent anchor never destroys the transcript.
 */
export function truncateTranscriptAtAnchor(
  transcript: ReadonlyArray<TurnEntry>,
  anchor: string,
): ReadonlyArray<TurnEntry> {
  const idx = transcript.findIndex((t) => t.promptUuid === anchor);
  if (idx === -1) return transcript;
  return transcript.slice(0, idx);
}

// ---------------------------------------------------------------------------
// Cost update — telemetry surface, phase-tolerant
// ---------------------------------------------------------------------------

function numericOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function handleCostUpdate(
  state: CodeSessionState,
  event: CostUpdateEvent,
): { state: CodeSessionState; effects: Effect[] } {
  // Guard against non-numeric total_cost_usd. Live Claude sends a
  // number; the golden loader's `"{{f64}}"` → `0` preprocessing also
  // lands as a number. A string or undefined would mean a wire
  // contract break and the frame is dropped.
  if (typeof event.total_cost_usd !== "number") {
    return { state, effects: [] };
  }

  const lastCost: CostSnapshot = {
    totalCostUsd: event.total_cost_usd,
    numTurns: numericOrNull(event.num_turns),
    durationMs: numericOrNull(event.duration_ms),
    durationApiMs: numericOrNull(event.duration_api_ms),
    usage: event.usage ?? null,
    modelUsage: event.modelUsage ?? null,
  };

  // Accumulate any tool calls this turn denied (rule or auto-mode classifier)
  // for the Recently-denied tab. `mergeDenials` returns the same reference when
  // there's nothing new, so quiescent cost_updates don't churn the snapshot.
  const permissionDenials = mergeDenials(
    state.permissionDenials,
    decodePermissionDenials(event.permission_denials),
  );

  return {
    // `cost_update.usage` is the turn's last-iteration usage — the
    // `streaming_usage` path captures `sessionInitTokens` first in
    // practice; this is the fallback for a session whose first turn
    // produced a `cost_update` but no `streaming_usage` frame.
    state: {
      ...state,
      lastCost,
      // A `cost_update` lands at turn end (and only mid-turn after a
      // successful resolution). Either way the retry the banner mirrored
      // has resolved — clear the announcement.
      apiRetry: null,
      permissionDenials,
      sessionInitTokens: captureSessionInit(
        state.sessionInitTokens,
        readUsage(event.usage),
      ),
    },
    effects: [],
  };
}

/**
 * `api_retry` reducer handler — display-only, like {@link
 * handleCostUpdate}. Records the retry announcement on `apiRetry` with no
 * phase change; a subsequent attempt overwrites it. Cleared at the next
 * turn boundary (`handleCostUpdate` + `resetPerTurnTelemetry`).
 */
function handleApiRetry(
  state: CodeSessionState,
  event: ApiRetryEvent,
): { state: CodeSessionState; effects: Effect[] } {
  const apiRetry: ApiRetryState = {
    attempt: event.attempt,
    maxRetries: event.maxRetries,
    deadline: event.deadline,
    error: event.error,
    errorStatus: event.errorStatus,
  };
  return { state: { ...state, apiRetry }, effects: [] };
}

/**
 * `model_refusal_fallback` reducer handler — display-only, like {@link
 * handleApiRetry}. Records the fallback on `refusalFallback` with no phase
 * change; cleared at the next turn boundary (`resetPerTurnTelemetry`) so each
 * occurrence re-notifies.
 */
function handleModelRefusalFallback(
  state: CodeSessionState,
  event: ModelRefusalFallbackEvent,
): { state: CodeSessionState; effects: Effect[] } {
  const refusalFallback: RefusalFallbackState = {
    originalModel: event.originalModel,
    fallbackModel: event.fallbackModel,
  };
  return { state: { ...state, refusalFallback }, effects: [] };
}

/**
 * `output_truncated` reducer handler — display-only, like {@link
 * handleModelRefusalFallback}. Flips `outputTruncated` true; cleared at the
 * next turn boundary (`resetPerTurnTelemetry`) so each truncated turn
 * re-notifies.
 */
function handleOutputTruncated(
  state: CodeSessionState,
  _event: OutputTruncatedEvent,
): { state: CodeSessionState; effects: Effect[] } {
  return { state: { ...state, outputTruncated: true }, effects: [] };
}

/**
 * `unknown_event` reducer handler — display-only, like {@link
 * handleApiRetry}. Records tugcode's forward-compat catch-all on
 * `unknownEvent` (stamping `at` for Dismiss keying) with no phase change;
 * a later unknown type overwrites it. Not cleared at the turn boundary —
 * the notice is a forward-compat signal the user acknowledges, not
 * per-turn telemetry.
 */
function handleUnknownEvent(
  state: CodeSessionState,
  event: UnknownEventEvent,
): { state: CodeSessionState; effects: Effect[] } {
  const unknownEvent: UnknownEventState = {
    originalType: event.originalType,
    payloadHexPreview: event.payloadHexPreview,
    at: Date.now(),
  };
  return { state: { ...state, unknownEvent }, effects: [] };
}

/**
 * `compact_boundary` reducer handler — appends a compaction `system_note`
 * (`source: "compact"`) rendered as a soft divider. Live (mid-turn: a native
 * `/compact` send opens a turn, auto-compaction fires inside one) the note
 * attaches to the active turn's scratch. On replay the `/compact` scaffolding
 * records are skipped, so the boundary usually arrives with no open turn ([P04]):
 * fall back to an `append-compact-note` effect the store wrapper applies to the
 * LAST committed turn (the committed transcript lives in the wrapper, not
 * reducer state — [D04]), so the divider lands where compaction happened in
 * reading order; an empty transcript makes it a no-op. The mid-turn note keys
 * off the per-turn `systemNoteSeq`; the committed-turn fallback keys off the
 * last turn's `messages.length` (minted wrapper-side).
 */
/**
 * The honest post-compaction resident window ([P01], [Q02]): Claude's own
 * `post_tokens`, verbatim.
 *
 * It used to be `sessionInitTokens + post_tokens`, on the reading that
 * `post_tokens` was a sub-base conversation figure needing the base added
 * back. The feed says otherwise, and says it exactly: in
 * `1d8cb92b-…`, `compact_metadata.pre_tokens` was 468_833 and the
 * pre-compaction turn's measured window was 468_833 — the same number, not a
 * number above a base. `pre_tokens` IS the whole resident window, so its
 * partner `post_tokens` is the whole one too (the pair's own arithmetic
 * agrees: `pre − post === cumulative_dropped_tokens`). Adding the base to it
 * double-counted the base.
 *
 * That is what put 231.8K on the CONTEXT cell of a session that had just
 * compacted to 9_205: a resumed session's `sessionInitTokens` had latched at
 * 222_603 — the whole resident transcript, not a baseline — and 222_603 +
 * 9_205 is what the cell read (`d7bb9a1d-…`, 2026-09-15).
 *
 * `undefined` when `post_tokens` is absent or non-finite; the window then
 * carries forward as it does across any zero-usage turn. This is the single
 * derivation point for both the live scratch stamp and the replay-path
 * `append-compact-note` stamp (Spec S03, H1).
 */
function honestCompactionTotal(
  postTokens: number | undefined,
): number | undefined {
  if (typeof postTokens === "number" && Number.isFinite(postTokens) && postTokens > 0) {
    return postTokens;
  }
  return undefined;
}

function handleCompactBoundary(
  state: CodeSessionState,
  event: CompactBoundaryEvent,
): { state: CodeSessionState; effects: Effect[] } {
  // The honest post-compaction window (Claude's own `post_tokens`) — the same
  // derivation on both paths ([P01]). The transcript is left intact (the
  // Compaction Summary renders inline right above the compaction divider at the
  // compaction point); only the CONTEXT accounting drops in place.
  const honestTotal = honestCompactionTotal(event.postTokens);
  const turnKey = state.pendingTurn?.turnKey;
  if (turnKey === undefined) {
    // No open turn (replay path) — append the divider to the last committed
    // turn and stamp the honest total (H1) on it so CONTEXT is honest on reload.
    return {
      state,
      effects: [
        {
          kind: "append-compact-note",
          text: compactionNoteText(event.preTokens),
          ...(typeof event.timestamp === "number" ? { timestamp: event.timestamp } : {}),
          ...(honestTotal !== undefined ? { compactionPostTotal: honestTotal } : {}),
        },
      ],
    };
  }
  const entry = state.scratch.get(turnKey);
  if (entry === undefined) {
    // An open turn with no scratch (a suppressed `/compact` summarization turn,
    // whose commit is dropped) would swallow the boundary silently. Seat the
    // divider on the last committed turn instead — the same fallback the
    // no-open-turn path takes — so a compaction never goes unmarked.
    return {
      state,
      effects: [
        {
          kind: "append-compact-note",
          text: compactionNoteText(event.preTokens),
          ...(typeof event.timestamp === "number" ? { timestamp: event.timestamp } : {}),
          ...(honestTotal !== undefined ? { compactionPostTotal: honestTotal } : {}),
        },
      ],
    };
  }
  const note: SystemNote = {
    kind: "system_note",
    messageKey: systemNoteKey(turnKey, entry.systemNoteSeq),
    // The boundary can beat the turn's first content block, making this
    // note `messages[0]` — the turn's sort key. A replayed boundary carries
    // the entry's own time; fabricating one here dates a historical turn to
    // the relaunch and walls every later replayed turn behind it.
    createdAt: event.timestamp ?? Date.now(),
    text: compactionNoteText(event.preTokens),
    source: "compact",
  };
  // Live mid-turn boundary: stamp the HONEST post-compaction resident window on
  // the open turn's scratch (base + Claude's post-compaction conversation
  // figure) so it commits with the reduced context ([P01], [P02]).
  const nextEntry: ScratchEntry = {
    ...entry,
    messages: [...entry.messages, note],
    systemNoteSeq: entry.systemNoteSeq + 1,
    ...(honestTotal !== undefined ? { compactionPostTotal: honestTotal } : {}),
  };
  return {
    state: {
      ...state,
      scratch: withScratchEntry(state.scratch, turnKey, nextEntry),
    },
    effects: [],
  };
}

/**
 * `session_stage` reducer handler — appends the arc's stage divider
 * (`source: "stage"`) and touches nothing else. The rotation replaces the
 * card's claude session; the transcript deliberately survives it, so the
 * whole arc is one scroll with named boundaries.
 *
 * The runner rotates a session only once it has gone idle, so the ordinary
 * path is the no-open-turn one: an `append-stage-note` effect the wrapper
 * seats on the last committed turn (the committed transcript lives there,
 * not in reducer state — [D04]). The mid-turn branch mirrors
 * `handleCompactBoundary`'s so a divider is never swallowed by a turn that
 * happens to be open.
 */
function handleSessionStage(
  state: CodeSessionState,
  event: SessionStageEvent,
): { state: CodeSessionState; effects: Effect[] } {
  const text = stageNoteText(event.stage, event.model, event.document, event.steps);
  // The same facts the text was composed from, carried through unsplit: the
  // boundary fills its event / detail / badge from these.
  const stageFacts: StageBoundaryFacts = {
    stage: event.stage,
    model: event.model,
    document: event.document,
    ...(event.steps === undefined ? {} : { steps: event.steps }),
  };
  // A rotation announced a fresh claude, which disproves a wire error raised
  // on the one it superseded — the same rule `clearedTransportError` states
  // for a recovered transport. Nothing else moves: a `session_state_errored`
  // is about the card's process supervision, which a rotation does not
  // replace, and it survives here exactly as it survives a reconnect.
  const base = clearedWireError(state);
  const turnKey = base.pendingTurn?.turnKey;
  const entry = turnKey === undefined ? undefined : base.scratch.get(turnKey);
  if (turnKey === undefined || entry === undefined) {
    const divider: Effect = { kind: "append-stage-note", text, stageFacts };
    if (event.prompt === undefined || event.turnKey === undefined) {
      return { state: base, effects: [divider] };
    }
    // The runner's prompt opens the turn the deck will watch, on the path a
    // typed prompt takes — the same pending turn, the same scratch seed —
    // less the frame, which the runner already sent. The divider lands on
    // the committed transcript first, so the new turn reads below it.
    // The runner composed this prompt, so a leading `/command` in it was
    // *invoked*, not written about, and gets the command atom the composer
    // mints for a typed one — see `mintLeadingCommandAtom`. `content` keeps
    // the raw prompt: it records what the runner already sent.
    const minted = mintLeadingCommandAtom(event.prompt, [], TUG_ATOM_CHAR);
    const opened = handleSend(base, {
      type: "send",
      origin: "wheel",
      text: minted?.text ?? event.prompt,
      atoms: minted?.atoms ?? [],
      content: [{ type: "text", text: event.prompt }],
      turnKey: event.turnKey,
    } as SendActionEvent);
    return {
      state: opened.state,
      effects: [divider, ...opened.effects.filter((e) => e.kind !== "send-frame")],
    };
  }
  const note: SystemNote = {
    kind: "system_note",
    messageKey: systemNoteKey(turnKey, entry.systemNoteSeq),
    createdAt: Date.now(),
    text,
    source: "stage",
    stageFacts,
  };
  const nextEntry: ScratchEntry = {
    ...entry,
    messages: [...entry.messages, note],
    systemNoteSeq: entry.systemNoteSeq + 1,
  };
  return {
    state: {
      ...base,
      scratch: withScratchEntry(base.scratch, turnKey, nextEntry),
    },
    effects: [],
  };
}

/**
 * `compact_summary` reducer handler — folds the compaction summary into
 * `compactionSeed` so the carry-forward block renders (live and on reload),
 * latest-wins ([P05]). Preserves a `preTokens` a preceding `compact_boundary`
 * may have latched, else `null`. Phase-tolerant: live it arrives mid-turn, on
 * replay during `replaying`. No transcript ink, no phase change.
 */
function handleCompactSummary(
  state: CodeSessionState,
  event: CompactSummaryEvent,
): { state: CodeSessionState; effects: Effect[] } {
  return {
    state: {
      ...state,
      compactionSeed: {
        summary: event.summary,
        preTokens: state.compactionSeed?.preTokens ?? null,
      },
    },
    effects: [],
  };
}

/**
 * `streaming_usage` reducer handler — live intra-turn token telemetry,
 * phase-tolerant like {@link handleCostUpdate}.
 *
 * `observedInput` (`input + cache_read + cache_creation`) grows
 * monotonically across a turn's API calls — each call re-reads the
 * prior context plus its own output and tool result — so the LATEST
 * frame is always the current context window. The handler publishes the
 * frame's `usage` via a `write-live-usage` effect (the streaming
 * document's `telemetry.liveTurnUsage` path), replacing the prior
 * frame; there is no accumulation and no per-message map. Usage lives
 * OFF the snapshot on purpose: these frames arrive at streaming
 * frequency, and a snapshot change would re-render the whole transcript
 * list for a value only the status cells read.
 *
 * Also captures `sessionInitTokens` once: the `observedInput` of the
 * session's first token-bearing telemetry iteration is `window(0)` —
 * the bootstrap the transcript walk measures turn 1 against. That
 * capture is the ONLY snapshot change this handler can make, and it
 * happens once per session; every later frame returns the state
 * reference untouched.
 *
 * Drops a frame with no `msg_id` — a malformed frame (tugcode gates
 * the wire emit on a non-empty id). No phase transition: a
 * display-only telemetry frame.
 */
function handleStreamingUsage(
  state: CodeSessionState,
  event: StreamingUsageEvent,
): { state: CodeSessionState; effects: Effect[] } {
  const msgId = typeof event.msg_id === "string" ? event.msg_id : "";
  if (msgId === "") {
    return { state, effects: [] };
  }
  const usage = readUsage(event.usage);
  const effects: Effect[] = [{ kind: "write-live-usage", usage }];
  const sessionInitTokens = captureSessionInit(state.sessionInitTokens, usage);
  if (sessionInitTokens === state.sessionInitTokens) {
    return { state, effects };
  }
  return { state: { ...state, sessionInitTokens }, effects };
}

/**
 * `observedInput` of a `usage` — `input + cache_read + cache_creation`,
 * the model's resident context excluding its own output. `window(0)`
 * for the session's first iteration; the per-turn input term elsewhere.
 */
function observedInput(usage: LiveMessageUsage): number {
  return (
    usage.inputTokens +
    usage.cacheReadInputTokens +
    usage.cacheCreationInputTokens
  );
}

/**
 * Latch `sessionInitTokens` on the first token-bearing iteration:
 * keep an already-captured value, else adopt this iteration's
 * `observedInput` when it is positive, else stay `null`.
 */
function captureSessionInit(
  current: number | null,
  usage: LiveMessageUsage,
): number | null {
  if (current !== null) {
    return current;
  }
  const obs = observedInput(usage);
  return obs > 0 ? obs : null;
}

/**
 * `context_breakdown` reducer handler. Projects the wire frame onto
 * `state.lastContextBreakdown` and fires a `record-context-breakdown`
 * effect so the supervisor persists the latest blob.
 *
 * Validation: drops malformed frames silently (non-numeric
 * `context_max`, non-array `categories`, individual category entries
 * missing the required `id`/`label`/`tokens` triple). A dropped
 * frame leaves state unchanged — the popover keeps showing whatever
 * the prior frame produced (or the 20.4.7.C fallback if none has
 * landed). The renderer is resilient; the reducer doesn't need to
 * surface a wire-contract error.
 */
function handleContextBreakdown(
  state: CodeSessionState,
  event: ContextBreakdownEvent,
): { state: CodeSessionState; effects: Effect[] } {
  if (typeof event.context_max !== "number" || !Array.isArray(event.categories)) {
    return { state, effects: [] };
  }
  const categories: Array<ContextBreakdownSnapshot["categories"][number]> = [];
  for (const c of event.categories) {
    if (typeof c !== "object" || c === null) continue;
    const id = (c as { id?: unknown }).id;
    const label = (c as { label?: unknown }).label;
    const tokens = (c as { tokens?: unknown }).tokens;
    if (typeof id !== "string" || typeof label !== "string" || typeof tokens !== "number") {
      continue;
    }
    categories.push({
      id: id as ContextBreakdownSnapshot["categories"][number]["id"],
      label,
      tokens,
    });
  }
  const projection: ContextBreakdownSnapshot = {
    contextMax: event.context_max,
    categories,
  };
  // Suppress the persist effect for bind-attach frames: the supervisor
  // synthesized this frame from the row it already holds, so writing
  // the same bytes back via record_context_breakdown would just be a
  // no-op UPSERT round-trip. Live frames from tugcode (no flag) get
  // persisted as normal.
  const effects: Effect[] =
    event.from_supervisor_attach === true
      ? []
      : [
          {
            kind: "record-context-breakdown",
            payload: projection,
            capturedAt: Date.now(),
          },
        ];
  return {
    state: { ...state, lastContextBreakdown: projection },
    effects,
  };
}

// ---------------------------------------------------------------------------
// Errored triggers —
// ---------------------------------------------------------------------------

/**
 * The `lastError` record a terminal handler stamps, with the `null` that
 * means "this card has no standing error" taken off — {@link enterErrored}
 * reads `null` as "do not stamp one", which is a different thing.
 */
type SessionLastError = NonNullable<CodeSessionState["lastError"]>;

/** What {@link enterErrored} contributes to a terminal handler's state. */
type ErroredSlice = Pick<
  CodeSessionState,
  | "phase"
  | "wakeTrigger"
  | "interruptInFlight"
  | "pendingInterruptReason"
  | "interruptInFlightSegmentStartedAt"
  | "stopStalled"
  | "streamStalled"
> &
  Partial<Pick<CodeSessionState, "lastError">>;

/**
 * The one sanctioned way to set `phase: "errored"`.
 *
 * Every terminal handler routes through here so the per-interrupt fields are
 * cleared at a single chokepoint. The reason is the defect this arc is named
 * after: `interruptInFlight` was set by `handleInterrupt` and cleared only by
 * `resetPerTurnTelemetry`, which in an interrupting state is reachable only
 * through `handleTurnComplete` — so the flag's sole clearer was one frame
 * type. When that frame did not come the flag outlived its turn, and
 * `session-phase-visual.ts` reads it *above* the phase, so a card that had
 * genuinely errored still painted "Interrupting". A flag whose clearer is a
 * single frame type is the pattern; a shared terminal slice is the answer.
 *
 * `session-phase-visual.ts` is deliberately left alone. Its precedence —
 * `interruptInFlight` over the phase — is correct once the flag is honest,
 * and re-ordering the projection would paper over a lying signal rather than
 * fix it.
 *
 * `lastError` is `null` for the one caller that enters errored without
 * stamping anything (`handleTransportClose`, whose comment gives the
 * argument: a wire blip heals itself, and a stamp here would be sticky). A
 * `null` therefore leaves whatever `lastError` already stood, rather than
 * clearing it — no terminal path clears one on the way in.
 *
 * The returned `effects` are still empty, and the interrupt-silence deadline
 * this comment once expected to put here went somewhere better. Its
 * `cancel_timer` is a transition rule on `interruptInFlight` in the store
 * wrapper ({@link interruptSilenceEffect}), so a terminal cancels it by
 * clearing the flag, which the slice above already does. The shape stays: a
 * chokepoint with an effects channel is the right place for the next such
 * thing, and one is cheaper to have than to add.
 *
 * It takes no `state`: every field in the slice is a constant, and a
 * parameter read by nothing is a worse signature than one argument fewer.
 */
function enterErrored(lastError: SessionLastError | null): {
  slice: ErroredSlice;
  effects: Effect[];
} {
  return {
    slice: {
      phase: "errored",
      // After a terminal, no bracket-close `turn_complete` is coming, so a
      // wake marker left standing would outlive the wake it named.
      wakeTrigger: null,
      interruptInFlight: false,
      pendingInterruptReason: null,
      interruptInFlightSegmentStartedAt: null,
      stopStalled: false,
      // A card that has errored is not a card waiting for the network. The
      // timer behind the flag is cancelled by `streamStallCancelEffect`,
      // which reads the same transition into `errored`.
      streamStalled: false,
      ...(lastError !== null ? { lastError } : {}),
    },
    effects: [],
  };
}

function handleSessionStateErrored(
  state: CodeSessionState,
  event: SessionStateErroredEvent,
): { state: CodeSessionState; effects: Effect[] } {
  // Distinct from `interrupted` per [D08]: an errored session is not
  // recoverable via a simple retry — the underlying session is dead.
  // The next `send()` from `errored` re-submits and clears `lastError`
  // on the following `turn_complete(success)`.
  const message = event.detail ?? "session errored";
  const { slice, effects } = enterErrored({
    cause: "session_state_errored",
    message,
    at: Date.now(),
  });
  return {
    state: {
      ...state,
      ...slice,
    },
    effects,
  };
}

function handleWireError(
  state: CodeSessionState,
  event: WireErrorEvent,
): { state: CodeSessionState; effects: Effect[] } {
  // Distinct from SESSION_STATE errored and transport close. The
  // renderer can dispatch on `lastError.cause === "wire_error"` to
  // surface a different affordance (e.g. a retry button for a
  // `recoverable: true` wire error).
  const message = event.message ?? "wire error";
  const { slice, effects } = enterErrored({
    cause: "wire_error",
    message,
    at: Date.now(),
    // The bridge names which of its emit sites wrote the frame; the
    // banner's detail panel shows it, so "Protocol error" stops being a
    // label with nothing behind it. Older bridges send none.
    ...(typeof event.site === "string" && event.site.length > 0
      ? { site: event.site }
      : {}),
  });
  return {
    state: {
      ...state,
      ...slice,
    },
    effects,
  };
}

function handleResumeFailed(
  state: CodeSessionState,
  event: { reason?: string; stale_session_id?: string },
): { state: CodeSessionState; effects: Effect[] } {
  // tugcode emits `resume_failed` and exits; the bridge promotes
  // EOF to a terminal `ResumeFailed` outcome and broadcasts
  // `SESSION_STATE = errored { detail: "resume_failed" }`. Set
  // `lastError` here so the card-side observer (clear binding,
  // re-present picker with notice) can read both the cause and the
  // human-readable reason; the phase flip to `errored` arrives via
  // the subsequent `session_state_errored` event.
  const parts: string[] = [];
  if (event.reason) parts.push(event.reason);
  if (event.stale_session_id) parts.push(`stale id ${event.stale_session_id}`);
  const message = parts.length > 0 ? parts.join("; ") : "resume failed";
  return {
    state: {
      ...state,
      lastError: {
        cause: "resume_failed",
        message,
        at: Date.now(),
      },
    },
    effects: [],
  };
}

/**
 * Re-seed a fresh store's queue with sends stranded by the disposal of
 * the previous store for this card.
 *
 * Guarded on an empty queue: seeding must never displace something the
 * user submitted to the new store in the meantime. The entries keep
 * their original `queuedAt`, so the flushed turn's row is dated to the
 * moment the user actually hit submit rather than to the recovery.
 */
function handleSeedQueuedSends(
  state: CodeSessionState,
  event: SeedQueuedSendsEvent,
): { state: CodeSessionState; effects: Effect[] } {
  if (event.sends.length === 0 || state.queuedSends.length > 0) {
    return { state, effects: [] };
  }
  return {
    state: {
      ...state,
      queuedSends: event.sends.map((s) => ({
        content: [...s.content],
        text: s.text,
        atoms: [...s.atoms],
        turnKey: s.turnKey,
        origin: s.origin,
        queuedAt: s.queuedAt,
        // The hold rides across the disposal with the words. A card that
        // lost its store while the network was down inherits a prompt that
        // is still waiting for the network, not one about to be sent into
        // it.
        held: s.held,
      })),
    },
    effects: [],
  };
}

/**
 * The host's path went to `satisfied` — the one release a held prompt can get
 * while nothing else is happening ([P10]).
 *
 * With no turn in flight there are no `api_retry` frames and no stream
 * events, so this transition is the only event available. It is a nudge and
 * not an assurance — a captive portal reports the same thing — so the release
 * is optimistic: the send finds out for itself, and if it fails the turn's
 * own retries raise the overlay again and the next submission holds.
 *
 * Release is a state change. The send that follows is the ordinary flush,
 * reached here because an idle card has no later boundary that would reach
 * it: every other flush hangs off a turn ending, and there is no turn.
 */
function handleNetworkPathSatisfied(
  state: CodeSessionState,
  _event: NetworkPathSatisfiedEvent,
): { state: CodeSessionState; effects: Effect[] } {
  const released = releaseHeldSends(state.queuedSends);
  if (released === state.queuedSends) return { state, effects: [] };
  const next = { ...state, queuedSends: released };
  if (state.phase !== "idle" && state.phase !== "errored") {
    // Mid-turn: the entries are unheld now and the turn's own end flushes
    // the head, exactly as it does for an ordinary queued send.
    return { state: next, effects: [] };
  }
  return flushQueuedHeadResult(
    next,
    next.scratch,
    next.committedMsgIds,
    next.sessionInitTokens,
    [],
    {},
  );
}

function handleTransportClose(
  state: CodeSessionState,
): { state: CodeSessionState; effects: Effect[] } {
  // Idempotence: a duplicate close from the lifecycle (e.g., a stray
  // dispatch during teardown) on an already-offline state is a no-op.
  // Returning the same state reference keeps `getSnapshot()`
  // reference-stable for `useSyncExternalStore`.
  if (state.transportState === "offline") {
    return { state, effects: [] };
  }

  // Transport-state takes precedence over the cold-boot preflight
  // beat: if the wire goes down (or starts restoring) the preflight
  // banner has nothing left to bridge to, so cancel and clear. The
  // dwell and soft-budget timers are scoped to the active replay
  // window itself; they survive a transport blip and let the live
  // replay outcome (or a subsequent replay_started) clear them.
  const wasPreflightActive = state.replayPreflightActive;
  const cancelPreflightEffect: Effect[] = wasPreflightActive
    ? [{ kind: "cancel_timer", name: "preflight" }]
    : [];
  const preflightCleared = wasPreflightActive
    ? { replayPreflightActive: false }
    : {};

  // Any aborted CASE A cycles whose `turn_complete(error)` had not
  // yet arrived will never arrive — the wire is dead and the next
  // `transport_open` brings up a fresh connection with no memory of
  // the prior cycles. Letting `pendingCaseAEchoes` carry across the
  // close would falsely suppress the first live `turn_complete(error)`
  // after reconnect (e.g. a real claude error on a new turn).
  const caseAEchoesCleared = state.pendingCaseAEchoes !== 0
    ? { pendingCaseAEchoes: 0 }
    : {};

  // Transport-downtime timer: opening the non-online interval. The
  // entry-side timestamp is set when the transport first leaves
  // `online` (whether to `offline` or `restoring`). Idempotent — if
  // it's already set (e.g. `online → restoring → offline` skipping
  // settled), preserve it: the user never returned to online.
  const transportClock =
    state.transportNonOnlineSince === null
      ? { transportNonOnlineSince: Date.now() }
      : {};

  // Transport close from `idle` no longer drops silently — per [D06]
  // the offline transportState gates submit even for cards that had
  // nothing in flight. Phase stays `idle` (there is nothing to error
  // on); `lastError` is left untouched for the same reason.
  if (state.phase === "idle") {
    return {
      state: {
        ...state,
        transportState: "offline",
        ...preflightCleared,
        ...caseAEchoesCleared,
        ...transportClock,
      },
      effects: cancelPreflightEffect,
    };
  }

  // Non-idle close with an in-flight turn: the turn is dead — the
  // wire will not deliver its `turn_complete`. Commit a TurnEntry
  // with `turnEndReason: "transport_lost"` so the transcript records
  // what happened (and the chrome can show the failure mode) instead
  // of leaving an orphaned in-flight cell behind.
  const endedAt = Date.now();
  const transportLostCommit: Effect[] = [];
  let perTurnReset: Partial<CodeSessionState> = {};
  if (state.pendingTurn !== null) {
    const msgId = state.activeMsgId ?? `transport-lost-${state.pendingTurn.turnKey}`;
    if (!state.committedMsgIds.has(msgId)) {
      // Transport-lost commits never come from replay (replay never
      // synthesizes a transport_lost reason); the live derivation is
      // always the source.
      const entry = buildTurnEntry(state, msgId, "transport_lost", endedAt, undefined);
      transportLostCommit.push({ kind: "append-transcript", entry });
      transportLostCommit.push({ kind: "clear-inflight" });
      const committedMsgIds = new Set(state.committedMsgIds);
      committedMsgIds.add(msgId);
      perTurnReset = {
        committedMsgIds,
        activeMsgId: null,
        scratch: withoutPendingTurnScratch(state),
        toolUseStartedAt: new Map(),
        pendingApproval: null,
        pendingQuestion: null,
        prevPhase: null,
        pendingTurn: null,
        // `queuedSends` is deliberately absent from this reset. Every
        // other member of it belongs to the turn that just died and is
        // correctly discarded; the queue belongs to the *user* — those
        // are messages they typed and asked to deliver. Dropping them
        // on a wire blip is silent data loss with nothing to mark it.
        ...resetPerTurnTelemetry(),
        // Same per-turn-boundary close as `handleTurnComplete`:
        // close awaiting + interrupt segments into their arrays so
        // the just-lost turn's pause history is complete. The
        // transport segment is deliberately left open — the
        // disconnect that lost the turn is still live.
        ...closeTurnPauseSegments(state, endedAt),
      };
    }
  }

  // Non-idle: flip phase to errored and record `transportState =
  // "offline"`. The card observer reads phase to surface "errored";
  // submit gating reads the conjunction of phase ∈ {idle, errored} and
  // transportState. `wakeTrigger` is cleared unconditionally — after
  // transport-lost there is no active wake; the bracket-close
  // (`turn_complete`) will not arrive on the dead wire.
  //
  // No `lastError` is stamped. The banner is the one surface allowed
  // to lock the card body, and it is reserved for breakage that does
  // not heal itself — a wire blip does not qualify. The condition is
  // already fully represented without it: `transportState = "offline"`
  // raises the non-blocking "Reconnecting…" bulletin and gates
  // `canSubmit` on its own. A stamp here would also be *sticky*, since
  // nothing on the recovery path clears it — worst exactly in the case
  // where the wire never comes back.
  //
  // `enterErrored(null)` is that "no stamp": the shared terminal slice
  // carries the phase, the wake clear, and the per-interrupt clears, and
  // leaves `lastError` exactly as it stood. It is spread after
  // `perTurnReset` because the two agree on every field they share — the
  // reset's `closeTurnPauseSegments` already nulls the open interrupt
  // segment after folding it into `interruptInFlightIntervals`, which the
  // slice does not touch.
  const { slice: erroredSlice, effects: erroredEffects } = enterErrored(null);
  return {
    state: {
      ...state,
      ...perTurnReset,
      ...erroredSlice,
      transportState: "offline",
      ...preflightCleared,
      ...caseAEchoesCleared,
      ...transportClock,
    },
    effects: [
      ...erroredEffects,
      ...cancelPreflightEffect,
      ...transportLostCommit,
    ],
  };
}

function handleTransportOpen(
  state: CodeSessionState,
): { state: CodeSessionState; effects: Effect[] } {
  // [D08] no-op when already online. The lifecycle layer already
  // gates `connectionDidReconnect` on having seen a prior close, so a
  // `transport_open` against `online` would be a duplicate dispatch
  // (or a bootstrap-time event that arrived before any close). Return
  // the same state ref so subscribers don't observe a churn.
  if (state.transportState === "online") {
    return { state, effects: [] };
  }
  // `transportNonOnlineSince` is not closed here — we're still
  // non-online (just transitioning offline → restoring) and the
  // interval continues until `handleTransportSettled` returns to
  // `online`. Defensive: if the timer wasn't set (transport_open
  // observed without a prior close on this side), open it now so the
  // restoring window counts toward downtime correctly.
  const transportClock =
    state.transportNonOnlineSince === null
      ? { transportNonOnlineSince: Date.now() }
      : {};
  return {
    state: {
      ...state,
      transportState: "restoring",
      ...clearedTransportError(state),
      ...transportClock,
    },
    effects: [],
  };
}

/**
 * Drop a `transport_closed` error on the recovery edge, and only that
 * cause.
 *
 * States the invariant positively where a reader will look for it — a
 * recovered transport has no transport error — rather than leaving it
 * to rest on the absence of a stamp elsewhere. It also catches any
 * such error that predates this rule or arrives from a path the
 * transport-close handler does not cover: nothing that the recovery
 * disproves should outlive it.
 *
 * Every other cause is deliberately untouched. A `session_state_errored`
 * that merely happened to coincide with an outage is real breakage and
 * survives the reconnect.
 */
function clearedTransportError(
  state: CodeSessionState,
): Partial<CodeSessionState> {
  return state.lastError?.cause === "transport_closed"
    ? { lastError: null }
    : {};
}

/**
 * Drop a `wire_error` banner on the rotation edge, and only that cause.
 *
 * A rotation is the wheel's deliberate act: it retires one claude and
 * announces a fresh one, so a wire-level error frame raised on the retired
 * process describes a line the rotation has already closed. The banner is the
 * one surface that locks the card body, and it has no other path off a
 * superseded line — a `turn_complete(success)` for that line will never
 * arrive, and a rotation with no prompt opens no turn to clear it. Same rule
 * as {@link clearedTransportError}: nothing the fresh session disproves
 * should outlive it.
 *
 * Every other cause is untouched. A `session_state_errored` from the crash
 * budget is about the card's process supervision, which a rotation does not
 * replace, and the two ownership causes are about the binding.
 *
 * **Live rotations only.** A `replay_stage` divider reaches the same handler,
 * and it redraws a rotation that already happened rather than performing one —
 * so it supersedes nothing and disproves nothing. Without this gate a banner's
 * survival across a bridge respawn would turn on whether the replayed
 * transcript happened to contain a stage divider, which is no rule at all.
 *
 * Returns the state itself when there is nothing to clear, so a quiescent
 * rotation costs no snapshot identity ([L02]).
 */
function clearedWireError(state: CodeSessionState): CodeSessionState {
  return state.phase !== "replaying" && state.lastError?.cause === "wire_error"
    ? { ...state, lastError: null }
    : state;
}

function handleTransportSettled(
  state: CodeSessionState,
): { state: CodeSessionState; effects: Effect[] } {
  // Idempotence: settling while already online is a no-op. The
  // `cardSessionBindingStore` subscription path may dispatch this on
  // first bind even when `transportState` was already `online`
  // (initial mount, no transport_close had been observed); skipping
  // the churn keeps the snapshot ref stable.
  if (state.transportState === "online") {
    return { state, effects: [] };
  }
  // Close the transport-downtime interval and fold the elapsed time
  // into both the scalar accumulator and the per-turn intervals
  // array; increment the reconnect counter. If `transportNonOnlineSince`
  // was somehow null (defensive — both transport_close and
  // transport_open set it), the helper is a no-op and only the
  // reconnect count moves.
  return {
    state: {
      ...state,
      transportState: "online",
      ...clearedTransportError(state),
      ...closeTransportDowntimeInterval(state),
      transportReconnectCount: state.transportReconnectCount + 1,
    },
    effects: [],
  };
}

/**
 * Whether a turn is open on this store — the phases from which a
 * terminal event still has something to kill. `awaiting_approval` counts:
 * the turn is blocked on the user but very much alive, and a supervisor
 * that has forgotten the session will never deliver its `turn_complete`.
 */
function isLiveTurnPhase(state: CodeSessionState): boolean {
  switch (state.phase) {
    case "submitting":
    case "awaiting_first_token":
    case "streaming":
    case "tool_work":
    case "awaiting_approval":
    case "waking":
      return true;
    case "idle":
    case "errored":
    case "replaying":
      return false;
  }
}

function handleSessionUnknown(
  state: CodeSessionState,
  event: SessionUnknownEvent,
): { state: CodeSessionState; effects: Effect[] } {
  // The wire frame carries `tug_session_id` (`build_session_unknown_frame`
  // in `agent_supervisor.rs`), so `acceptFrame`'s tsid match already
  // routed it here: this notice is about THIS card, whatever phase it is
  // in. Accept it from any live turn rather than only the two
  // waiting-for-first-token phases — the supervisor has forgotten the
  // session, so no `turn_complete` is ever coming, and dropping the
  // notice strands a `streaming` / `tool_work` turn live forever with a
  // bowing in-flight indicator and no event left to stop it.
  if (!isLiveTurnPhase(state)) {
    return { state, effects: [] };
  }
  const message = event.detail ?? "session unknown to supervisor";
  const { slice, effects } = enterErrored({
    cause: "session_unknown",
    message,
    at: Date.now(),
  });
  return {
    state: {
      ...state,
      ...slice,
    },
    effects,
  };
}

function handleSessionNotOwned(
  state: CodeSessionState,
  event: SessionNotOwnedEvent,
): { state: CodeSessionState; effects: Effect[] } {
  // The rejection names the session whose write it killed (`router.rs`'s
  // `InputDecision::NotOwned`), so `acceptFrame`'s tsid match already
  // routed it here. Accept it from any live turn: a rejected write is the
  // only notice that write is ever getting, and the approval / interrupt
  // / mode writes all leave the phase somewhere past the
  // waiting-for-first-token window the old self-routing gate could see.
  if (!isLiveTurnPhase(state)) {
    return { state, effects: [] };
  }
  const message = event.detail ?? "session not owned by this client";
  const { slice, effects } = enterErrored({
    cause: "session_not_owned",
    message,
    at: Date.now(),
  });
  return {
    state: {
      ...state,
      ...slice,
    },
    effects,
  };
}

// ---------------------------------------------------------------------------
// Replay bracket handlers (replay_started / replay_complete /
// add_user_message)
// ---------------------------------------------------------------------------

/**
 * Open a replay window. Allowed only from `idle` or `errored` —
 * other phases mean a live turn is in flight, which would race the
 * supervisor's flush-before-live ordering. The `errored` case is the
 * explicit invariant: a previously-errored card whose
 * `spawn_session_ok` cleared the error before replay began would
 * already be `idle` by the time `replay_started` lands; this branch
 * exists in case the supervisor sequences differently.
 */
function handleReplayStarted(
  state: CodeSessionState,
  _event: ReplayStartedEvent,
): { state: CodeSessionState; effects: Effect[] } {
  if (state.phase !== "idle" && state.phase !== "errored") {
    console.warn(
      `[code-session-store] replay_started in unexpected phase ${state.phase}; dropping`,
    );
    return { state, effects: [] };
  }
  return {
    state: {
      ...state,
      phase: "replaying",
      // Clear pendingTurn defensively — replay should never observe
      // one (idle/errored have it null), but a future caller that
      // drives `send` then `replay_started` synchronously would
      // otherwise leak the pending turn into the first replayed
      // turn's commit.
      pendingTurn: null,
      // Same defensive clear for any in-flight scratch.
      activeMsgId: null,
      scratch: new Map(),
      toolUseStartedAt: new Map(),
      pendingApproval: null,
      pendingQuestion: null,
      prevPhase: null,
      // Clear lastReplayResult — the new window is the new outcome.
      lastReplayResult: null,
      // Replay-clock: opening a replay window clears preflight (its
      // job is done) and the prior window's timeout-dwell (the new
      // window supersedes the prior outcome). Soft-budget starts
      // false and the dispatch loop schedules the soft-budget timer
      // via the effect below.
      replayPreflightActive: false,
      replaySoftBudgetElapsed: false,
      replayTimeoutDwellActive: false,
    },
    effects: [
      { kind: "cancel_timer", name: "preflight" },
      { kind: "cancel_timer", name: "timeout_dwell" },
      {
        kind: "schedule_timer",
        name: "soft_budget",
        ms: REPLAY_SOFT_BUDGET_MS,
        fire: { type: "tick_soft_budget" },
      },
    ],
  };
}

/**
 * Close a replay window. Always returns to `idle` and populates
 * `lastReplayResult` with the success or error variant. Idempotent:
 * a stray `replay_complete` outside `replaying` is logged and
 * dropped so the normal idle / errored state isn't perturbed.
 */
function handleReplayComplete(
  state: CodeSessionState,
  event: ReplayCompleteEvent,
): { state: CodeSessionState; effects: Effect[] } {
  if (state.phase !== "replaying") {
    console.warn(
      `[code-session-store] replay_complete in unexpected phase ${state.phase}; dropping`,
    );
    return { state, effects: [] };
  }
  // Cancelled load-previous: the bracket was aborted in flight. Discard
  // the staged older batch and return to idle with the prior window and
  // last-result untouched — nothing was committed, so this is not a new
  // outcome (no banner, no window change). A load-previous always runs
  // from a fully-loaded idle card, so there is no in-flight cycle to
  // preserve.
  if (event.aborted === true) {
    return {
      state: {
        ...state,
        phase: "idle",
        activeMsgId: null,
        scratch: new Map(),
        toolUseStartedAt: new Map(),
        pendingApproval: null,
        pendingQuestion: null,
        prevPhase: null,
        pendingTurn: null,
        replayPrependActive: false,
        replayEverCompleted: true,
        replayPreflightActive: false,
        replaySoftBudgetElapsed: false,
        replayTimeoutDwellActive: false,
      },
      effects: [
        { kind: "cancel_timer", name: "preflight" },
        { kind: "cancel_timer", name: "soft_budget" },
        { kind: "discard-prepend" },
      ],
    };
  }
  const lastReplayResult: LastReplayResult = event.error
    ? {
        kind: event.error.kind,
        message: event.error.message,
        count: event.count,
        at: Date.now(),
      }
    : {
        kind: "success",
        message: "",
        count: event.count,
        at: Date.now(),
      };
  // Recency-window metadata: present only on a windowed replay. When
  // absent (a full / legacy / error replay) keep whatever the prior
  // window recorded rather than nulling it.
  const replayWindow: ReplayWindowMeta | null =
    typeof event.firstLoadedTurnIndex === "number" &&
    typeof event.totalTurns === "number"
      ? {
          firstLoadedTurnIndex: event.firstLoadedTurnIndex,
          totalTurns: event.totalTurns,
          hasOlder: event.hasOlder === true,
        }
      : state.replayWindow;
  // Replay-clock: closing the window cancels preflight (defensive — it
  // would already be cleared by the preceding replay_started) and the
  // soft-budget timer. A timeout outcome opens the timeout-dwell timer
  // so the banner copy lingers briefly before dismissing.
  const isTimeout = lastReplayResult.kind === "replay_timeout";
  const effects: Effect[] = [
    { kind: "cancel_timer", name: "preflight" },
    { kind: "cancel_timer", name: "soft_budget" },
  ];
  // A load-previous bracket staged its older turns; commit them to the
  // front of the transcript now that the bracket has closed.
  if (state.replayPrependActive) {
    effects.push({ kind: "flush-prepend" });
  }
  if (isTimeout) {
    effects.push({
      kind: "schedule_timer",
      name: "timeout_dwell",
      ms: REPLAY_TIMEOUT_DWELL_MS,
      fire: { type: "tick_timeout_dwell_done" },
    });
  }

  // Never-drop chain link 13: if `pendingTurn` survived the bracket,
  // the in-flight snapshot's `add_user_message` landed without a
  // matching `turn_complete` (the live tail is still streaming).
  // Preserve `pendingTurn` + scratch, transition to `streaming` so
  // post-bracket live deltas continue to accumulate, and let the
  // eventual live `turn_complete` commit the TurnEntry naturally.
  // Without this preservation, replay_complete wipes the cycle and
  // post-bracket deltas land in `idle` (which `handleTextDelta`'s
  // phase guard rejects), the user sees no inflight indicator after
  // HMR-mid-stream, and the response never auto-syncs.
  //
  // Dialog-survival sibling: if the snapshot also re-emitted a
  // `control_request_forward` (tugcode replays any pending
  // `can_use_tool` from `pendingControlRequests` on resume), the
  // forward stashed `pendingApproval` / `pendingQuestion` while the
  // phase guard kept us in `replaying`. The right post-bracket
  // landing is `awaiting_approval` — not `streaming` — so the
  // permission / question dialog reappears and the awaiting-approval
  // clock starts now (the user wasn't actually waiting during the
  // replay window). Without this branch, the rehydrated dialog
  // fields would be wiped below and the user sees only the empty
  // streaming indicator.
  if (state.pendingTurn !== null) {
    const hasPendingDialog =
      state.pendingApproval !== null || state.pendingQuestion !== null;
    if (hasPendingDialog) {
      // `prevPhase` is what `handleRespondApproval` / `handleRespondQuestion`
      // restore to once the user resolves the dialog. The live flow's
      // forward landed at `tool_work` (the `tool_use` for the gated
      // tool flipped phase there before the SDK control_request
      // arrived), so the post-resolve phase MUST be `tool_work` —
      // it is the only phase that accepts the subsequent `tool_result`
      // (`handleToolResult` drops the event outside `tool_work` /
      // `replaying`). The snapshot path synthesised a `tool_use` for
      // the same toolUseId during the bracket, so the scratch has
      // the pending entry waiting for the result. Restoring to
      // `streaming` here would drop the live `tool_result` and the
      // tool block would dangle in its pending state forever.
      return {
        state: {
          ...state,
          phase: "awaiting_approval",
          prevPhase: "tool_work",
          pendingApproval: state.pendingApproval,
          pendingQuestion: state.pendingQuestion,
          awaitingApprovalSince: state.awaitingApprovalSince ?? Date.now(),
          lastReplayResult,
          replayWindow,
          replayPrependActive: false,
          replayEverCompleted: true,
          replayPreflightActive: false,
          replaySoftBudgetElapsed: false,
          replayTimeoutDwellActive: isTimeout,
        },
        effects,
      };
    }
    return {
      state: {
        ...state,
        phase: "streaming",
        // activeMsgId stays as whatever the snapshot's
        // assistant_text set (claude's id for the in-flight
        // message). scratch preserved as-is. pendingTurn preserved
        // as-is.
        pendingApproval: null,
        pendingQuestion: null,
        prevPhase: null,
        lastReplayResult,
        replayWindow,
        replayPrependActive: false,
        replayEverCompleted: true,
        replayPreflightActive: false,
        replaySoftBudgetElapsed: false,
        replayTimeoutDwellActive: isTimeout,
      },
      effects,
    };
  }

  // No surviving in-flight cycle: clean replay terminates to idle.
  const replayBookkeeping: Partial<CodeSessionState> = {
    lastReplayResult,
    replayWindow,
    replayPrependActive: false,
    replayEverCompleted: true,
    replayPreflightActive: false,
    replaySoftBudgetElapsed: false,
    replayTimeoutDwellActive: isTimeout,
  };

  // A queue waiting at the end of a replay is a turn boundary too, and
  // it is the ONLY trigger this path will ever get: the queue-flush
  // everywhere else hangs off a `turn_complete`, and on this path there
  // is no prior turn to complete. This is how a send that was stranded
  // by a transport close and carried across the rebind finally reaches
  // the wire — without the flush here the stash would refill the store
  // and then sit there forever, which is worse than no stash at all.
  // Held stays held across a replay, for the cancel branch's reason: a
  // bracket closing is JSONL off the local disk and proves nothing about the
  // network. The release comes from a stream event, a completed turn, or the
  // host's path transition, and until one of those lands the words wait.
  if (state.queuedSends.length > 0 && !headIsHeld(state)) {
    return flushQueuedHeadResult(
      state,
      new Map(),
      state.committedMsgIds,
      state.sessionInitTokens,
      effects,
      replayBookkeeping,
    );
  }

  return {
    state: {
      ...state,
      phase: "idle",
      activeMsgId: null,
      scratch: new Map(),
      toolUseStartedAt: new Map(),
      pendingApproval: null,
      pendingQuestion: null,
      prevPhase: null,
      pendingTurn: null,
      ...replayBookkeeping,
    },
    effects,
  };
}

/**
 * Replay user-message echo: the synthetic open of each replayed turn.
 * Sets `pendingTurn` + seeds the scratch with the opening user_message
 * so the upcoming `turn_complete` commits a `TurnEntry` with this user
 * submission. No `send-frame` effect — the user already submitted this
 * message historically; replaying it must NOT round-trip back to the
 * wire.
 *
 * Does NOT pre-bind `activeMsgId` (per [D14]). The first content event
 * of the turn (`assistant_text` / `thinking_text` / `tool_use` /
 * `content_block_start`) sets `activeMsgId` to claude's real `msg_id`;
 * `handleTurnComplete` matches on that. For the no-content interrupt
 * case (translator emits orphan `turn_complete` with no content
 * arrived), `handleTurnComplete` falls back to committing `pendingTurn`
 * when `activeMsgId === null` (per `#spec-reducer-state` rule 2 and
 * [D13]'s orphan-synthesis path).
 *
 * `committedMsgIds` dedupe is therefore assistant-side-only — the
 * translator's synthesized `u-<n>` opener id ([D13]) never reaches
 * `committedMsgIds`. Documented on `committedMsgIds` itself.
 *
 * Drops in any phase other than `replaying`.
 */
function handleAddUserMessage(
  state: CodeSessionState,
  event: AddUserMessageEvent,
): { state: CodeSessionState; effects: Effect[] } {
  if (state.phase !== "replaying") {
    return { state, effects: [] };
  }
  // The store wrapper has already walked the inbound `content` blocks
  // through `synthesizeUserMessageFromBlocks` and dispatches the
  // substrate `(text, atoms)` pair on the event. The reducer trusts
  // the contract — no shape check, no fallback path. Per [Step 5c].
  // `event.timestamp` (replay path) carries the original JSONL entry's
  // wall-clock submission time; without it, `submitAt` would reset to
  // the replay-emission time and the Z1 transcript timestamp would
  // re-stamp on every session restore.
  const now = event.timestamp ?? Date.now();
  const userMessage: UserMessage = {
    kind: "user_message",
    messageKey: userMessageKey(event.turnKey),
    createdAt: now,
    text: event.text,
    attachments: event.atoms,
    origin: senderOrigin(event.origin),
    submitAt: now,
  };

  // Legacy fake-compaction replay ([P06]): a `/compact` seed block split off
  // this opener re-marks the carry-forward summary so an OLD JSONL renders it
  // exactly as it did live. Applied before placement so both the
  // mid-bracket-append and new-turn branches carry it.
  const base: CodeSessionState =
    typeof event.compactionSummary === "string"
      ? {
          ...state,
          compactionSeed: {
            summary: event.compactionSummary,
            preTokens: null,
          },
        }
      : state;

  // Reload-authoritative placement of a merged/steered message ([P07]).
  // During replay, a turn already in flight (`pendingTurn !== null`)
  // means this `add_user_message` is threaded mid-bracket — a steered
  // message claude merged after a `tool_result`, not a new turn opener.
  // Append it to the in-flight turn's `messages` (keeping its own
  // `${turnKey}-user` key, [P04]) rather than opening a new turn — the
  // reload analogue of the live boundary append in `handleToolResult`.
  // This relocates the message to claude's EXACT merge point in the
  // JSONL, tightening the live optimistic placement; `/rewind` stays on
  // the host turn's opener `promptUuid` ([P05]), so the merged message's
  // own `promptUuid` is intentionally not latched here.
  if (state.pendingTurn !== null) {
    const hostKey = state.pendingTurn.turnKey;
    const entry = state.scratch.get(hostKey);
    if (entry !== undefined) {
      const nextEntry: ScratchEntry = {
        ...entry,
        messages: [...entry.messages, userMessage],
      };
      return {
        state: {
          ...base,
          scratch: withScratchEntry(state.scratch, hostKey, nextEntry),
        },
        effects: [],
      };
    }
  }

  return {
    state: {
      ...base,
      pendingTurn: {
        turnKey: event.turnKey,
        submitAt: now,
        // Stated by the producer, defaulted by the reader — the same line
        // `handleSend` takes on the live path, so the two agree by
        // construction rather than by two mechanisms kept in step.
        origin: event.origin ?? "user",
        // A canceled `/compact`'s throwaway summarization turn, replayed from
        // the discarded session's JSONL — mark it suppressed so its
        // `turn_complete` drops the transcript append (it must never commit).
        ...(event.suppressedTurn === true ? { suppressed: true } : {}),
        // Replay / mid-turn-snapshot path carries the `/rewind` anchor on the
        // opener; the live path delivers it later via `prompt_anchor`.
        ...(typeof event.promptUuid === "string" && event.promptUuid.length > 0
          ? { promptUuid: event.promptUuid }
          : {}),
      },
      scratch: withScratchEntry(
        state.scratch,
        event.turnKey,
        newScratchEntry(event.turnKey, [userMessage]),
      ),
      // No `activeMsgId` pre-bind per [D14]. The first content event
      // of the turn (assistant_text / thinking_text / tool_use /
      // content_block_start) sets it to claude's real `msg_id`. The
      // LIVE `handleSend` path also doesn't pre-bind; replay and live
      // converge on the same handler behavior.
    },
    effects: [],
  };
}

/**
 * Honest assistant-originated opener (`tuglaws/turn-metric.md` S02) — the
 * reducer's response to a wire `assistant_opener`. Opens a turn that holds
 * orphan assistant content (a `--continue` leading orphan, a `/compact`
 * continuation, or any assistant output with no open turn) with **no user
 * message**: the scratch is seeded empty, exactly as for a wake, so the
 * turn renders assistant-only (`#a`) and never as a phantom user row. This
 * replaces the old synthesized empty `add_user_message`.
 *
 * Unlike {@link handleWakeStarted} this carries no wake annotations — no
 * `wakeTrigger`, no jobs fold, no `waking` phase. It is replay-only today
 * (orphan assistant content lives in the JSONL); the live wake path keeps
 * using `wake_started`. Like `handleAddUserMessage` it admits only the
 * `replaying` phase.
 */
/**
 * Server-originated turn opener — the reducer's response to a wire
 * `tug_notice`.
 *
 * Tug injected a submission into this session, and this is what makes that
 * turn visible. Who gets credit for the words depends on whether the sender
 * is somebody the transcript can name.
 *
 * The **wheel** is. It is a participant — the thing steering an arc, with its
 * own name and its own mark in the transcript — so a prompt it sends opens a
 * `wheel` turn holding a `user_message` the wheel wrote, exactly as a typed
 * prompt opens a `user` turn. This is the same path a stage's opening prompt
 * already takes through {@link handleStageNote}, and it is here so that the
 * arc's later prompts (a continued implement range, a `/compact`) read as the
 * same voice that opened it. Rendered as a quoted note instead, the wheel
 * stopped being the thing driving the session and became something the
 * session was quoting.
 *
 * Every other origin is not a participant, and its notice stays what it was:
 * an `origin: assistant` turn seeded with one `notice` system_note. Nameless
 * words must not be attributed to the user — that would put them in the
 * user's mouth in their own transcript.
 *
 * Admitted only from `idle`, which is the only state an injecting gate ever
 * injects into. On reload the JSONL records the injection as an ordinary user
 * entry, so the replay translator renders the same text as a user row; the two
 * are two renderings of one submission and never both appear.
 */
function handleTugNotice(
  state: CodeSessionState,
  event: TugNoticeEvent,
): { state: CodeSessionState; effects: Effect[] } {
  // A bulletin, before anything else: it is Tug telling this session
  // something, and there is no turn behind it to open or to wait for. That
  // makes the idle check below wrong for it twice over — it would drop the
  // notice whenever the session happened to be working, and the seat it
  // guards would open a turn nothing ever finishes.
  if (event.standalone === true) {
    return handleStandaloneNotice(state, event);
  }
  if (state.phase !== "idle") {
    return { state, effects: [] };
  }
  return handleTurnOpeningNotice(state, event);
}

/**
 * A notice with nothing behind it — Tug speaking, seated wherever the session
 * happens to be ([P08]).
 *
 * Two seats, one row. Mid-turn it joins the open turn's scratch as a
 * `source: "notice"` system note, the seat {@link handleArcNote} already uses
 * for the same reason: a thing that happened *during* this turn belongs inside
 * it, and hoisting it out would put it after work it preceded. At idle there
 * is no turn to join, so it is ingested as an ink turn of its own — a
 * synthetic `tug notice <origin>` shell exchange the command-block registry
 * claims and renders quietly.
 *
 * **The phase is never touched.** That is the whole distinction from the
 * turn-opening notice above: this one is not the head of anything, so a
 * session that was idle stays idle and one that was working keeps working.
 *
 * `cwd` is `""` deliberately. `CodeSessionState` carries no project dir — the
 * arc-note path gets one from `useLandingReceipts`, which holds the binding,
 * while a `tug_notice` is a wire event and carries none — and the `quiet`
 * presentation renders no shell chrome, so the field has no reader on this row.
 */
function handleStandaloneNotice(
  state: CodeSessionState,
  event: TugNoticeEvent,
): { state: CodeSessionState; effects: Effect[] } {
  const text = typeof event.text === "string" ? event.text : "";
  if (text.length === 0) {
    return { state, effects: [] };
  }
  const origin =
    typeof event.origin === "string" && event.origin.length > 0
      ? event.origin
      : "tug";
  const at = event.timestamp ?? Date.now();

  const turnKey = state.pendingTurn?.turnKey;
  const entry = turnKey !== undefined ? state.scratch.get(turnKey) : undefined;
  if (turnKey !== undefined && entry !== undefined) {
    const note: SystemNote = {
      kind: "system_note",
      messageKey: systemNoteKey(turnKey, entry.systemNoteSeq),
      createdAt: at,
      text,
      source: "notice",
      noticeOrigin: origin,
    };
    return {
      state: {
        ...state,
        scratch: withScratchEntry(state.scratch, turnKey, {
          ...entry,
          messages: [...entry.messages, note],
          systemNoteSeq: entry.systemNoteSeq + 1,
        }),
      },
      effects: [],
    };
  }

  const row = buildShellTurnEntry(
    shellMessage({
      type: "shell_exchange_complete",
      exchangeId: `tug-notice-${event.turnKey}`,
      command: `tug notice ${origin}`,
      output: text,
      exitCode: 0,
      cwd: "",
      cwdAfter: null,
      startedAtMs: at,
      settledAtMs: at,
    }),
  );
  return { state, effects: [{ kind: "ingest-ink-turn", entry: row }] };
}

/**
 * The turn-opening half: a notice that heads an injected submission.
 *
 * Reached only from `idle`, and only when the notice is not a bulletin — the
 * two facts {@link handleTugNotice} checks before delegating here.
 */
function handleTurnOpeningNotice(
  state: CodeSessionState,
  event: TugNoticeEvent,
): { state: CodeSessionState; effects: Effect[] } {
  const text = typeof event.text === "string" ? event.text : "";
  if (text.length === 0) {
    return { state, effects: [] };
  }
  if (event.origin === WHEEL_NOTICE_ORIGIN) {
    // The wheel composed this prompt, so a leading `/command` in it was
    // *invoked*, not written about, and earns the command atom the composer
    // mints for a typed one. `content` keeps the raw prompt: it records what
    // the sender already put on the wire. The `send-frame` effect is dropped
    // for that same reason — tugcast dispatched the submission itself, and
    // this event is only its arrival.
    const minted = mintLeadingCommandAtom(text, [], TUG_ATOM_CHAR);
    const opened = handleSend(state, {
      type: "send",
      origin: "wheel",
      text: minted?.text ?? text,
      atoms: minted?.atoms ?? [],
      content: [{ type: "text", text }],
      turnKey: event.turnKey,
    } as SendActionEvent);
    return {
      state: opened.state,
      effects: opened.effects.filter((e) => e.kind !== "send-frame"),
    };
  }
  const submitAt = event.timestamp ?? Date.now();
  const note: SystemNote = {
    kind: "system_note",
    messageKey: systemNoteKey(event.turnKey, 0),
    createdAt: submitAt,
    text,
    source: "notice",
    ...(typeof event.origin === "string" && event.origin.length > 0
      ? { noticeOrigin: event.origin }
      : {}),
  };
  return {
    state: {
      ...state,
      // The injected submission is about to run a real turn, so the session
      // leaves idle the same way a wake does — assistant-originated work
      // starting with no composer behind it.
      phase: "waking",
      activeMsgId: null,
      scratch: withScratchEntry(state.scratch, event.turnKey, {
        ...newScratchEntry(event.turnKey, [note]),
        systemNoteSeq: 1,
      }),
      toolUseStartedAt: new Map(),
      pendingApproval: null,
      pendingQuestion: null,
      prevPhase: null,
      pendingTurn: {
        turnKey: event.turnKey,
        submitAt,
        origin: "assistant",
      },
      ...resetPerTurnTelemetry(),
      awaitingApprovalIntervals: [],
    },
    effects: [],
  };
}

function handleAssistantOpener(
  state: CodeSessionState,
  event: AssistantOpenerEvent,
): { state: CodeSessionState; effects: Effect[] } {
  if (state.phase !== "replaying") {
    return { state, effects: [] };
  }
  const submitAt = event.timestamp ?? Date.now();
  return {
    state: {
      ...state,
      // No `activeMsgId` pre-bind per [D14]; the first assistant content
      // event of the turn sets it to claude's real `msg_id`.
      activeMsgId: null,
      pendingTurn: {
        turnKey: event.turnKey,
        submitAt,
        origin: "assistant",
      },
      // Empty scratch — an assistant-originated turn has no `user_message`.
      // The first wire content event (assistant_text / thinking_text /
      // tool_use) mints into this scratch via `handleContentBlockStart`.
      scratch: withScratchEntry(
        state.scratch,
        event.turnKey,
        newScratchEntry(event.turnKey, []),
      ),
    },
    effects: [],
  };
}

/**
 * Wake-bracket opener for a spontaneous resume — fires when claude
 * resumes from idle in response to an async deferred-completion event
 * (Monitor timeout, CronCreate firing, ScheduleWakeup arriving, etc.).
 * Closes [PPF-01]: the wake's subsequent content events would
 * otherwise be dropped by guards expecting an active turn.
 *
 * Pattern mirrors `handleSend`'s state setup so the wake turn behaves
 * like any user-initiated turn for streaming + telemetry, with three
 * differences:
 *   - `phase: "waking"` rather than `"submitting"` so the bracket is
 *     visible to consumers and `handleTurnComplete` can branch on it.
 *   - `pendingTurn.origin === "assistant"` (S01) — a wake is an
 *     assistant-originated turn; its wake-ness rides `wakeTrigger` + the
 *     `waking` phase, not the attribution. The scratch opens with NO
 *     `user_message` Message — wake turns have no user submission to
 *     surface.
 *   - `pendingDraftRestore` is preserved — the user's in-progress
 *     draft must not be touched by a wake (a wake mid-compose should
 *     not clobber what the user was typing).
 *
 * Idempotent on nested wakes: a `wake_started` arriving while already
 * `phase === "waking"` is treated as a metadata refresh (updates
 * `wakeTrigger` only when the new payload is non-null and the prior
 * was null). Flattens nested wakes to a single outer bracket per the
 * design at [D01].
 *
 * Closed implicitly by `turn_complete`'s `waking → idle` commit
 * branch — no separate `wake_complete` frame.
 *
 * Phases other than `idle` and `waking` drop defensively. Live
 * tugcode only emits `wake_started` from idle (the detector flips
 * `isInWake` and gates re-emission until the next `result`); a stray
 * frame from a busy phase would be a tugcode bug.
 *
 * See `arc/tugplan-session-wake.md` [D01] [D02]
 * [#spec-wake-started-state-reset].
 */
function handleWakeStarted(
  state: CodeSessionState,
  event: WakeStartedEvent,
): { state: CodeSessionState; effects: Effect[] } {
  // Wire payload is snake_case (verbatim SDK shape); reducer state
  // is camelCase per tugdeck convention. Translate once at the
  // reducer boundary so downstream consumers read camelCase.
  const trigger: WakeTrigger = {
    taskId: event.wake_trigger.task_id,
    toolUseId: event.wake_trigger.tool_use_id,
    status: event.wake_trigger.status,
    summary: event.wake_trigger.summary,
    outputFile: event.wake_trigger.output_file,
  };
  // Jobs-ledger fold: the wake trigger carries the job's terminal
  // status, so a matching `running` row flips here even if the
  // sibling `task_updated` frame was missed (first terminal flip
  // wins). Monitor rows are exempt: a watcher reaches terminal only
  // via `task_updated`. On the captured wire this is defense in
  // depth — mid-life monitor events wake via task-id-less re-inits
  // and a monitor's only notification is terminal with an agreeing
  // status (test-monitor-lifecycle-raw.jsonl) — but the exemption
  // pins the invariant structurally against future per-event
  // notifications. During replay the ledger is structurally empty
  // (launch inserts are suppressed), so a synthesized replay wake
  // cannot flip anything.
  const wakeNow = Date.now();
  const wireStatus = terminalJobStatusFromWire(trigger.status);
  const foldTarget = state.jobs.find((j) => j.jobId === trigger.taskId);
  const flipped =
    wireStatus !== undefined &&
    foldTarget !== undefined &&
    foldTarget.kind !== "monitor"
      ? applyJobFlip(state.jobs, trigger.taskId, wireStatus, wakeNow)
      : state.jobs;
  // Id-less cohort: a fired `ScheduleWakeup` / `CronCreate` re-init
  // carries an empty `task_id` (the background-job fold above no-ops on
  // it), so reconcile by time — flip the earliest elapsed scheduled
  // row. A wake with a real `task_id` never touches scheduled rows.
  const jobs =
    trigger.taskId === ""
      ? flipEarliestElapsedScheduled(flipped, wakeNow, wakeNow)
      : flipped;
  if (state.phase === "waking") {
    // Nested wake — idempotent refresh of trigger metadata only.
    if (state.wakeTrigger === null) {
      return {
        state: { ...state, wakeTrigger: trigger, jobs },
        effects: [],
      };
    }
    if (jobs !== state.jobs) {
      return { state: { ...state, jobs }, effects: [] };
    }
    return { state, effects: [] };
  }
  // Accept wake_started from `replaying` too — the cold-boot replay
  // path emits a synthesized `wake_started` when it recognizes the
  // JSONL's `<task-notification>` envelope (see
  // `tugcode/src/replay.ts`'s `extractTaskNotificationWake`). During
  // replay, the bracket pair (replay_started / replay_complete) owns
  // phase entry/exit, so the wake opens its scratch + pendingTurn
  // here but the phase stays `replaying`. The wake's content frames
  // accumulate under the same handlers that admit `replaying`, and
  // the matching `turn_complete` commits the entry via the
  // replaying-stays-in-replaying branch.
  if (state.phase !== "idle" && state.phase !== "replaying") {
    // The wake bracket is refused mid-turn, but the trigger's job flip
    // still folds — the terminal status is real regardless of phase.
    if (jobs !== state.jobs) {
      return { state: { ...state, jobs }, effects: [] };
    }
    return { state, effects: [] };
  }
  const submitAt = Date.now();
  const nextPhase: CodeSessionPhase = state.phase === "replaying" ? "replaying" : "waking";
  return {
    state: {
      ...state,
      phase: nextPhase,
      wakeTrigger: trigger,
      jobs,
      activeMsgId: null,
      scratch: withScratchEntry(
        state.scratch,
        event.turnKey,
        // No user_message — wake turns are assistant-originated. Seed the
        // trigger's summary as a `scheduled` system_note so the wake turn
        // opens with its label ("loop pacing" beats an unexplained
        // assistant row); wire content mints into the same scratch via
        // `handleContentBlockStart`. `systemNoteSeq` starts past the
        // seeded note so a later note in the same turn keys uniquely.
        trigger.summary.length > 0
          ? {
              ...newScratchEntry(event.turnKey, [
                {
                  kind: "system_note",
                  messageKey: systemNoteKey(event.turnKey, 0),
                  createdAt: submitAt,
                  text: trigger.summary,
                  source: "scheduled",
                } satisfies SystemNote,
              ]),
              systemNoteSeq: 1,
            }
          : newScratchEntry(event.turnKey, []),
      ),
      toolUseStartedAt: new Map(),
      pendingApproval: null,
      pendingQuestion: null,
      prevPhase: null,
      pendingTurn: {
        turnKey: event.turnKey,
        submitAt,
        // A wake is an assistant-originated turn (S01); its wake-ness rides
        // `wakeTrigger` + the `waking` phase, not the attribution.
        origin: "assistant",
      },
      // Per-turn telemetry reset — same single-source-of-truth helper
      // `handleSend` uses on the queue-flush path. Future fields added
      // to the helper apply to wakes automatically.
      ...resetPerTurnTelemetry(),
      // The per-turn interval arrays + the interrupt segment-start
      // ARE reset here (mirrors handleSend). `transportNonOnlineSince`
      // is owned by the transport handlers and intentionally left
      // alone so an in-progress disconnect that pre-dates the wake
      // still folds into the wake's downtime correctly.
      awaitingApprovalIntervals: [],
      transportDowntimeIntervals: [],
      interruptInFlightIntervals: [],
      interruptInFlightSegmentStartedAt: null,
      // Snapshot the cost cursor so the per-turn delta is computed
      // against this wake-start point at completion. (resetPerTurnTelemetry
      // clears `costAtSubmit` to null; re-set it here after the spread.)
      costAtSubmit: state.lastCost,
    },
    effects: [],
  };
}

// ---------------------------------------------------------------------------
// Background-jobs ledger handlers
// ---------------------------------------------------------------------------

/**
 * `task_started` — primary ledger insert. The frame fires for
 * foreground subagents too (no backgrounded discriminant on the
 * wire), so the insert is gated on the launching tool call — looked
 * up by `toolUseId` in the in-flight turn's scratch — via
 * `isJobLaunch`: explicitly backgrounded, or a `Monitor` watcher
 * (background activity by nature; its frame's `task_type` reads
 * `local_bash` and cannot discriminate, so kind derives from the
 * tool name). A frame whose launching call isn't visible in our
 * stream (e.g. an async subagent's internal jobs) or isn't a job
 * launch is ignored. Replay never reaches here — task frames aren't
 * part of the replay stream.
 */
function handleTaskStarted(
  state: CodeSessionState,
  event: TaskStartedEvent,
): { state: CodeSessionState; effects: Effect[] } {
  // Replay never populates the ledger. Task frames aren't part of the
  // replay stream today, but a replayed turn's tool calls DO satisfy
  // the run_in_background gate below — this guard keeps the invariant
  // structural rather than incidental.
  if (state.phase === "replaying") {
    return { state, effects: [] };
  }
  const turnKey = state.pendingTurn?.turnKey;
  const entry = turnKey !== undefined ? state.scratch.get(turnKey) : undefined;
  const arrayIdx = entry?.toolCallIndex.get(event.toolUseId);
  const launching =
    entry !== undefined && arrayIdx !== undefined
      ? entry.messages[arrayIdx]
      : undefined;
  if (launching === undefined || launching.kind !== "tool_use") {
    return { state, effects: [] };
  }
  const input =
    typeof launching.input === "object" && launching.input !== null
      ? (launching.input as Record<string, unknown>)
      : null;
  if (!isJobLaunch(launching.toolName, input)) {
    return { state, effects: [] };
  }
  const kind = jobKindForLaunch(launching.toolName, event.taskType);
  const jobs = insertJob(state.jobs, {
    jobId: event.taskId,
    source: "claude",
    kind,
    toolUseId: event.toolUseId,
    description: event.description,
    status: "running",
    startedAtMs: Date.now(),
    endedAtMs: null,
  });
  if (jobs === state.jobs) {
    return { state, effects: [] };
  }
  return { state: { ...state, jobs }, effects: [] };
}

/**
 * `task_updated` — terminal status flip, keyed by job id. Unknown
 * wire vocabulary is dropped (a future non-terminal status must not
 * finish a running row); unknown ids and already-terminal rows are
 * no-ops. `endTime` is claude's epoch-ms stamp; absent, the receipt
 * clock stands in.
 */
function handleTaskUpdated(
  state: CodeSessionState,
  event: TaskUpdatedEvent,
): { state: CodeSessionState; effects: Effect[] } {
  const status = terminalJobStatusFromWire(event.status);
  if (status === undefined) {
    return { state, effects: [] };
  }
  const jobs = applyJobFlip(
    state.jobs,
    event.taskId,
    status,
    event.endTime ?? Date.now(),
  );
  if (jobs === state.jobs) {
    return { state, effects: [] };
  }
  return { state: { ...state, jobs }, effects: [] };
}

/**
 * `task_progress` — fold a running agent's latest tool + cumulative
 * usage onto its ledger row. {@link applyJobProgress} no-ops when the
 * row is terminal (a late tick must not disturb the final snapshot),
 * returning the same `jobs` reference so an ignored tick produces no
 * state change.
 *
 * An **orphan background** tick — one whose `taskId` matches no ledger
 * row and whose launching call is NOT in the live turn's scratch —
 * re-hydrates a `running` agent job first (when not replaying). Replay
 * deliberately never populates the jobs ledger, so after a reload a
 * still-running background agent has no row; its tailer's inter-turn
 * children would then find `jobExistsForParent === false` and be
 * dropped. Only agents emit `task_progress`, and the frame carries
 * both the `taskId` (= the job id) and the launching Agent call's
 * `toolUseId` — everything the insert needs. `insertJob` keeps this
 * idempotent with the launch-echo / `task_started` inserts. The
 * scratch guard keeps a *foreground* agent's mid-turn ticks (whose
 * launching call is still open in the live turn) from minting a
 * phantom job.
 */
function handleTaskProgress(
  state: CodeSessionState,
  event: TaskProgressEvent,
): { state: CodeSessionState; effects: Effect[] } {
  let jobs = state.jobs;
  const known = jobs.some((j) => j.jobId === event.taskId);
  if (!known && state.phase !== "replaying") {
    const turnKey = state.pendingTurn?.turnKey;
    const scratchEntry =
      turnKey !== undefined ? state.scratch.get(turnKey) : undefined;
    const launchingLive =
      scratchEntry?.toolCallIndex.has(event.toolUseId) === true;
    if (!launchingLive) {
      jobs = insertJob(jobs, {
        jobId: event.taskId,
        source: "claude",
        kind: "agent",
        toolUseId: event.toolUseId,
        description: event.description,
        status: "running",
        startedAtMs: Date.now(),
        endedAtMs: null,
      });
    }
  }
  jobs = applyJobProgress(jobs, event);
  if (jobs === state.jobs) {
    return { state, effects: [] };
  }
  return { state: { ...state, jobs }, effects: [] };
}

/**
 * `clear_jobs_action` — the popover's Clear button: a deck-local wipe
 * of terminal rows. `running` rows always survive (clearing one would
 * orphan it from the UI with no way to stop it from Z2). No wire
 * traffic.
 */
function handleClearJobs(
  state: CodeSessionState,
): { state: CodeSessionState; effects: Effect[] } {
  const jobs = clearTerminalJobs(state.jobs);
  if (jobs === state.jobs) {
    return { state, effects: [] };
  }
  return { state: { ...state, jobs }, effects: [] };
}

// ---------------------------------------------------------------------------
// Replay-clock handlers (preflight + soft-budget + timeout-dwell)
// ---------------------------------------------------------------------------

/**
 * `bind_resume_acknowledged` — emitted once by `cardServicesStore`
 * after constructing services for a `sessionMode === "resume"`
 * binding. Opens the preflight window. Idempotent: a second call
 * while preflight is already active is a no-op (no second timer
 * scheduled). Also a no-op if not in `idle` (e.g. mid-replay) — the
 * downstream `replay_started` will populate the live replay copy
 * directly without a redundant preflight beat.
 */
function handleBindResumeAcknowledged(
  state: CodeSessionState,
): { state: CodeSessionState; effects: Effect[] } {
  if (state.replayPreflightActive) {
    return { state, effects: [] };
  }
  if (state.phase !== "idle") {
    return { state, effects: [] };
  }
  if (state.transportState !== "online") {
    // Transport-state takes precedence: there's no point opening a
    // preflight banner over a transport restoring/offline backdrop.
    return { state, effects: [] };
  }
  return {
    state: { ...state, replayPreflightActive: true },
    effects: [
      {
        kind: "schedule_timer",
        name: "preflight",
        ms: REPLAY_PREFLIGHT_TIMEOUT_MS,
        fire: { type: "tick_preflight_done" },
      },
    ],
  };
}

/**
 * `tick_soft_budget` — scheduled by `replay_started`, fires
 * `REPLAY_SOFT_BUDGET_MS` later. Drops if not currently replaying
 * (the `replay_complete` cancel path should already have cleared
 * the timer; this is defense-in-depth against a stale tick racing
 * the cancel).
 */
function handleTickSoftBudget(
  state: CodeSessionState,
): { state: CodeSessionState; effects: Effect[] } {
  if (state.phase !== "replaying") {
    return { state, effects: [] };
  }
  if (state.replaySoftBudgetElapsed) {
    return { state, effects: [] };
  }
  return {
    state: { ...state, replaySoftBudgetElapsed: true },
    effects: [],
  };
}

/**
 * `tick_timeout_dwell_done` — scheduled by `replay_complete` when
 * the outcome is `replay_timeout`. Dismisses the timeout banner
 * after the dwell window.
 */
function handleTickTimeoutDwellDone(
  state: CodeSessionState,
): { state: CodeSessionState; effects: Effect[] } {
  if (!state.replayTimeoutDwellActive) {
    return { state, effects: [] };
  }
  return {
    state: { ...state, replayTimeoutDwellActive: false },
    effects: [],
  };
}

/**
 * `tick_preflight_done` — last-resort 12s timer expiring. Clears the
 * preflight banner if it somehow survived `replay_started` /
 * `replay_complete` / `transport_close` (none of which lit up).
 */
function handleTickPreflightDone(
  state: CodeSessionState,
): { state: CodeSessionState; effects: Effect[] } {
  if (!state.replayPreflightActive) {
    return { state, effects: [] };
  }
  return {
    state: { ...state, replayPreflightActive: false },
    effects: [],
  };
}

/**
 * `tick_replay_silence` — `REPLAY_SILENCE_DEADLINE_MS` passed inside a
 * replay bracket with no wire frame. The bracket is abandoned: the card
 * errors on itself, which takes down its own `SessionRestoring` placeholder
 * (`deriveColdRestoreActive` is false under any `lastError`) and mounts
 * the body so the banner shows. Whatever the bracket had staged goes with
 * it — a half-built cycle in scratch, a load-previous batch that will
 * never be flushed. Turns the bracket already committed stay.
 *
 * Dropped outside `replaying`: the timer is cancelled on phase exit, and
 * this guards the stale tick that races the cancel.
 */
function handleTickReplaySilence(
  state: CodeSessionState,
): { state: CodeSessionState; effects: Effect[] } {
  if (state.phase !== "replaying") {
    return { state, effects: [] };
  }
  return abandonBracket(state, "replay_stalled", REPLAY_STALLED_MESSAGE);
}

/**
 * `tick_replay_bracket` — `REPLAY_BRACKET_DEADLINE_MS` passed since the
 * bracket opened, whatever arrived inside it. Ends it the same way the
 * silence deadline does and differs only in the cause it stamps, which is
 * the point: `replay_stalled` says the relay stopped talking,
 * `replay_bracket_timeout` says it never stopped and never finished.
 *
 * Dropped outside `replaying`: the timer is cancelled on phase exit, and
 * this guards the stale tick that races the cancel.
 */
function handleTickReplayBracket(
  state: CodeSessionState,
): { state: CodeSessionState; effects: Effect[] } {
  if (state.phase !== "replaying") {
    return { state, effects: [] };
  }
  return abandonBracket(
    state,
    "replay_bracket_timeout",
    REPLAY_BRACKET_MESSAGE,
  );
}

/**
 * `tick_interrupt_silence` — the stop went out and nothing came back:
 * no `turn_complete`, no `turn_cancelled`, no `interrupt_noop`, no
 * terminal. Every one of those cancels this timer by clearing
 * `interruptInFlight`, so reaching here means the protocol went quiet.
 *
 * What the deck knows is that its stop was not answered, and that is
 * all it says. `interruptInFlight` falls so the card stops claiming an
 * interrupt is in progress, the interrupt segment closes so the turn
 * clock does not count the unanswered window twice, and `stopStalled`
 * rises so the stop control can become Force Stop.
 *
 * **`pendingTurn` stays open** ([P01]). The far end may still be
 * writing, and committing a turn on a timer would be exactly the kind
 * of confident lie the app-wide restore modal told. The turn is
 * committed by a real turn end or not at all — and Force Stop's own
 * receipt produces one in about a second.
 *
 * Dropped when the flag is already false: the timer is cancelled on
 * every fall, and this guards the tick that races the cancel.
 */
function handleTickInterruptSilence(
  state: CodeSessionState,
): { state: CodeSessionState; effects: Effect[] } {
  if (!state.interruptInFlight) {
    return { state, effects: [] };
  }
  const end = Date.now();
  const interruptInFlightIntervals =
    state.interruptInFlightSegmentStartedAt === null
      ? state.interruptInFlightIntervals
      : [
          ...state.interruptInFlightIntervals,
          [state.interruptInFlightSegmentStartedAt, end] as const,
        ];
  return {
    state: {
      ...state,
      interruptInFlight: false,
      pendingInterruptReason: null,
      interruptInFlightSegmentStartedAt: null,
      interruptInFlightIntervals,
      stopStalled: true,
    },
    effects: [],
  };
}

/**
 * `tick_stream_stall` — a live turn has produced nothing for
 * `STREAM_SILENCE_STALL_MS`.
 *
 * It raises one flag and stops. No turn is committed ([P01]), no `lastError`
 * is stamped ([P05]), no frame is sent, and the submit button stays Stop —
 * a stalled stream leaves loopback healthy and the stop entirely
 * deliverable. What changes is only what the card *says*: it stops claiming
 * to be streaming and starts saying it is waiting, which is the difference
 * the report this arc came from was actually about.
 *
 * Dropped outside a live turn: the timer is cancelled by
 * `streamStallCancelEffect` on every exit, and this guards the tick that
 * races the cancel. Idempotent on an already-raised flag, so a re-arm that
 * fires twice costs nothing.
 */
function handleTickStreamStall(
  state: CodeSessionState,
): { state: CodeSessionState; effects: Effect[] } {
  if (!isStallWatchedPhase(state.phase) || state.streamStalled) {
    return { state, effects: [] };
  }
  return { state: { ...state, streamStalled: true }, effects: [] };
}

/**
 * `force_stop` — the user pressed the control an unanswered stop turned
 * the submit button into. One frame: `stop_all_work`, which tugcode has
 * implemented and answered since the arc machinery needed it, so Force
 * Stop needs no new protocol.
 *
 * `task_ids` is empty on purpose. tugcode keeps no open-job set of its
 * own — the ids ride the verb from tugcast's supervisor, which holds
 * them — so a deck-origin stop skips the per-task `stop_task` courtesy
 * and goes straight to the group sweep, which is the rung that actually
 * ends the work.
 *
 * `stopStalled` is deliberately left standing: the frame has gone out
 * and nothing has come back yet, which is the same state the card was
 * already in. What clears it is the answer — `turn_cancelled` from
 * `handleStopAllWork`'s own teardown, or `stop_all_work_done`.
 *
 * Guarded on `stopStalled` ([P02]): there is no route to this frame that
 * does not run through a stop the session failed to answer. A dispatch
 * from anywhere else returns the same state reference and sends nothing.
 */
function handleForceStop(
  state: CodeSessionState,
): { state: CodeSessionState; effects: Effect[] } {
  if (!state.stopStalled) {
    return { state, effects: [] };
  }
  return {
    state,
    effects: [
      { kind: "send-frame", msg: { type: "stop_all_work", task_ids: [] } },
    ],
  };
}

/**
 * `stop_all_work_done` — tugcode swept the group and its respawn acked.
 *
 * The belt to `turn_cancelled`'s braces. `handleStopAllWork` sets
 * `activeTurn.interrupted` before it tears down, so the drain's EOF
 * normally emits `turn_cancelled{is_recovery:true}` and that commits the
 * turn. But tugcode sends this frame on its *failure* paths too — a
 * teardown that half-worked still swept the group — and on those paths
 * the cancel may never come. Clearing `stopStalled` here means the card
 * settles either way.
 *
 * It touches nothing else: the turn is not this frame's to end, and if a
 * cancel is coming it will do that properly.
 */
function handleStopAllWorkDone(
  state: CodeSessionState,
): { state: CodeSessionState; effects: Effect[] } {
  if (!state.stopStalled) {
    return { state, effects: [] };
  }
  return { state: { ...state, stopStalled: false }, effects: [] };
}

/**
 * Abandon an open replay bracket: error the card on itself with the
 * caller's cause, and take the bracket's half-built state with it — a
 * cycle in scratch, a load-previous batch that will never be flushed.
 * Turns the bracket already committed stay.
 *
 * Shared by both replay deadlines so the two endings cannot drift; each
 * supplies only the cause and the copy.
 */
function abandonBracket(
  state: CodeSessionState,
  cause: SessionLastError["cause"],
  message: string,
): { state: CodeSessionState; effects: Effect[] } {
  const effects: Effect[] = [{ kind: "cancel_timer", name: "soft_budget" }];
  if (state.replayPrependActive) {
    effects.push({ kind: "discard-prepend" });
  }
  const { slice, effects: erroredEffects } = enterErrored({
    cause,
    message,
    at: Date.now(),
  });
  return {
    state: {
      ...state,
      activeMsgId: null,
      scratch: new Map(),
      toolUseStartedAt: new Map(),
      pendingApproval: null,
      pendingQuestion: null,
      prevPhase: null,
      pendingTurn: null,
      replayPrependActive: false,
      replayPreflightActive: false,
      replaySoftBudgetElapsed: false,
      replayTimeoutDwellActive: false,
      ...slice,
    },
    effects: [...effects, ...erroredEffects],
  };
}

// ---------------------------------------------------------------------------
// Snapshot derivation helpers ([D07])
// ---------------------------------------------------------------------------

/**
 * Derive the public {@link ActiveTurnSnapshot} from reducer state.
 * Returns `null` when no turn is in flight. Used by
 * `CodeSessionStore.getSnapshot` to project `state.pendingTurn` +
 * `state.scratch[turnKey]` onto the snapshot surface.
 *
 * Pure: returns a fresh object each call. The class wrapper memoizes
 * the full snapshot, so callers don't pay re-derivation costs across
 * quiescent reads.
 */
export function deriveActiveTurnSnapshot(
  state: CodeSessionState,
): ActiveTurnSnapshot | null {
  const pending = state.pendingTurn;
  if (pending === null) return null;
  const entry = state.scratch.get(pending.turnKey);
  const messages: ReadonlyArray<Message> =
    entry !== undefined ? entry.messages : [];
  return {
    turnKey: pending.turnKey,
    submitAt: pending.submitAt,
    origin: pending.origin,
    suppressed: pending.suppressed === true,
    messages,
  };
}

// ---------------------------------------------------------------------------
// Shell exchanges ([P06]/[P12])
// ---------------------------------------------------------------------------

/**
 * A turn's sort timestamp for interleaving shell exchanges among Claude turns
 * ([P07]). The opener message's `createdAt` is the turn's start: a
 * `user_message`'s `submitAt`, an assistant opener's mint time, a shell
 * exchange's `startedAtMs`. Falls back to `endedAt` for an empty turn.
 */
function turnSortTs(turn: TurnEntry): number {
  return turn.messages[0]?.createdAt ?? turn.endedAt;
}

/**
 * Build a committed `shell`-origin `TurnEntry` around one exchange message.
 * Shell turns bypass the Claude turn machinery (no scratch / activeTurn /
 * phase) — they append directly to `transcript`. Telemetry fields are zero /
 * null: a shell exchange has no tokens, no TTFT, no approvals.
 */
function buildShellTurnEntry(msg: ShellExchangeMessage, anchorMsgId?: string): TurnEntry {
  const end = msg.settledAtMs ?? msg.startedAtMs;
  const wall = Math.max(0, end - msg.startedAtMs);
  // Honest end-state so the Z1B badge reads the exchange's outcome: a
  // settled non-zero exit is an error, a kill (null exit) is interrupted,
  // and an in-flight or clean exit is complete. Drives `endStateBadgeFor`
  // in the shell Z1B exactly as `turn_complete` drives it for a Claude turn.
  const settled = msg.settledAtMs !== null;
  const turnEndReason: TurnEndReason = !settled
    ? "complete"
    : msg.exitCode === null
      ? "interrupted"
      : msg.exitCode === 0
        ? "complete"
        : "error";
  return {
    turnKey: `shell-${msg.exchangeId}`,
    msgId: msg.exchangeId,
    ...(anchorMsgId !== undefined ? { anchorMsgId } : {}),
    origin: "shell",
    messages: [msg],
    // `result` is coarse (`success | interrupted`): a non-zero exit still ran
    // to completion — its failure nuance rides `turnEndReason: "error"`. Only
    // a kill / timeout is `interrupted`.
    result: turnEndReason === "interrupted" ? "interrupted" : "success",
    endedAt: end,
    wallClockMs: wall,
    awaitingApprovalMs: 0,
    transportDowntimeMs: 0,
    activeMs: wall,
    ttftMs: null,
    ttftcMs: null,
    reconnectCount: 0,
    maxStreamGapMs: 0,
    turnEndReason,
    cost: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalCostUsd: 0,
    },
  };
}

/**
 * Insert a turn into `transcript` at its timestamp position (stable: a tie
 * lands AFTER existing turns, so a live exchange whose timestamp equals the
 * newest turn still appends). For a live shell exchange the timestamp is the
 * newest, so this is an append; for a restored one ([P07]) it lands between
 * the Claude turns it happened among.
 */
function insertTurnByTimestamp(
  transcript: ReadonlyArray<TurnEntry>,
  entry: TurnEntry,
): TurnEntry[] {
  const ts = turnSortTs(entry);
  const next = transcript.slice();
  let i = next.length;
  while (i > 0 && turnSortTs(next[i - 1]) > ts) i--;
  next.splice(i, 0, entry);
  return next;
}

/**
 * Append a Claude turn, keeping it interleaved with any ink turns that were
 * restored *ahead* of it ([P07]). Claude turns replay (and stream) in
 * ascending-timestamp order, so relative to each other an append already is a
 * timestamp sort — this helper only slides the new turn left past a run of
 * trailing *ink* turns (shell, refs) whose timestamp is greater. That is
 * exactly the reload race: a ledger restore (`list_shell_exchanges`,
 * `list_refs`) can land before the JSONL replay, seating restored ink rows
 * ahead of the Claude turns they happened among; without this the replayed
 * Claude turn would append to the end instead of interleaving back to its own
 * timestamp. It never reorders two non-ink turns (the walk stops at the first
 * non-ink tail entry), so every existing Claude-path ordering is untouched.
 *
 * The store wrapper owns `_transcript`, so this pure helper runs there (via the
 * `append-transcript` effect), not inside the reducer's `CodeSessionState`.
 */
export function appendTurnInterleavingInk(
  transcript: ReadonlyArray<TurnEntry>,
  entry: TurnEntry,
): TurnEntry[] {
  const ts = turnSortTs(entry);
  const next = transcript.slice();
  let i = next.length;
  while (i > 0 && isInkOrigin(next[i - 1]!.origin) && turnSortTs(next[i - 1]!) > ts) {
    i--;
  }
  next.splice(i, 0, entry);
  return hoistInkAnchoredTo(next, entry);
}

/**
 * Does `turn` answer to `anchor`? True when the turn's wire `msgId` is the
 * anchor, or when it holds a Message minted under that `msg_id`.
 *
 * The second test is for compaction re-append, where one `message.id` can
 * appear at two file positions: `wireMessageKey` is `` `${msgId}-b${index}` ``,
 * so a turn carrying such a Message is a turn that anchor names even when the
 * turn's own `msgId` ended up being a later one.
 */
function turnAnswersToAnchor(turn: TurnEntry, anchor: string): boolean {
  if (turn.msgId === anchor) return true;
  const prefix = `${anchor}-b`;
  return turn.messages.some((m) => m.messageKey.startsWith(prefix));
}

/**
 * Order two ink turns that share one anchor ([P03], R04). Settle time first,
 * then ledger row id — the two ink ledgers assign ids independently, so an id
 * comparison across them means nothing, but a settle time always does.
 *
 * A refs run has no numeric row id (its table is keyed by session), so it
 * sorts after a shell row it settled with in the same millisecond. Arbitrary
 * but deterministic, which is the property that matters.
 */
function compareInkSiblings(a: TurnEntry, b: TurnEntry): number {
  if (a.endedAt !== b.endedAt) return a.endedAt - b.endedAt;
  return inkLedgerRowId(a) - inkLedgerRowId(b);
}

/** The `shell_exchanges` row id behind a restored shell turn, or `Infinity`. */
function inkLedgerRowId(entry: TurnEntry): number {
  const match = /^shell-restored-(\d+)$/.exec(entry.turnKey);
  return match === null ? Number.POSITIVE_INFINITY : Number(match[1]);
}

/**
 * Move every ink turn anchored to `turn` so it sits immediately after it
 * ([P05]).
 *
 * This is what makes the final transcript identical whichever way the boot
 * race falls: a ledger restore that lands before the JSONL replay seats its
 * rows by timestamp against turns that do not exist yet, and this re-seats
 * them the moment their anchor turn arrives. It is also what fixes the common
 * window case (R02) — an older row whose anchor was outside the loaded window
 * moves into place as `loadPrevious` brings that turn in.
 */
function hoistInkAnchoredTo(transcript: TurnEntry[], turn: TurnEntry): TurnEntry[] {
  if (isInkOrigin(turn.origin) || turn.msgId === "") return transcript;
  const claimed = transcript.filter(
    (t) => t.anchorMsgId !== undefined && t !== turn && turnAnswersToAnchor(turn, t.anchorMsgId),
  );
  if (claimed.length === 0) return transcript;
  const rest = transcript.filter((t) => !claimed.includes(t));
  claimed.sort(compareInkSiblings);
  rest.splice(rest.indexOf(turn) + 1, 0, ...claimed);
  return rest;
}

/**
 * Seat a restored ink turn at the position it was written at ([P03]).
 *
 * The anchor names the transcript turn this row followed when it was written.
 * The row goes immediately after the **last** entry answering to that anchor,
 * and after any ink already seated there that sorts before it.
 *
 * Every miss — no anchor at all (a live row, or one written before the column
 * existed), or an anchor naming a turn not in the loaded window — falls back
 * to {@link insertTurnByTimestamp}, which is what every ink row used to do.
 * That fallback is deliberate [L23] posture: a bad anchor costs a row its
 * position, never its existence. On a long session it is also the *common*
 * path at first paint, because Claude turns load windowed while ink restores
 * whole — {@link hoistInkAnchoredTo} re-seats those rows as their anchors
 * arrive.
 */
export function insertInkAnchored(
  transcript: ReadonlyArray<TurnEntry>,
  entry: TurnEntry,
): TurnEntry[] {
  const anchor = entry.anchorMsgId;
  if (anchor === undefined) return insertTurnByTimestamp(transcript, entry);

  let at = -1;
  for (let i = transcript.length - 1; i >= 0; i--) {
    if (turnAnswersToAnchor(transcript[i]!, anchor)) {
      at = i;
      break;
    }
  }
  if (at === -1) return insertTurnByTimestamp(transcript, entry);

  // Step past siblings already seated under this anchor that come before it.
  while (
    at + 1 < transcript.length &&
    transcript[at + 1]!.anchorMsgId === anchor &&
    compareInkSiblings(transcript[at + 1]!, entry) < 0
  ) {
    at++;
  }

  const next = transcript.slice();
  next.splice(at + 1, 0, entry);
  return next;
}

/**
 * Upsert an ink turn into the committed transcript ([P12]): replace the turn
 * with the same `turnKey` in place (settle preserving mount identity / row
 * position), or insert a new one at its anchored position (mint). This is
 * what makes a streaming run update the row it already owns instead of
 * growing a new one per batch. The store wrapper owns `_transcript`, so this
 * pure helper runs there (via the `ingest-ink-turn` effect), not inside the
 * reducer's `CodeSessionState`.
 *
 * A live row carries no anchor and mints at the transcript's end, which is
 * where it belongs at the moment of the act ([P06]); a restored row mints at
 * the position it recorded ([P03]).
 */
export function upsertInkTurn(
  transcript: ReadonlyArray<TurnEntry>,
  entry: TurnEntry,
): TurnEntry[] {
  const idx = transcript.findIndex((t) => t.turnKey === entry.turnKey);
  if (idx !== -1) {
    const next = transcript.slice();
    next[idx] = entry;
    return next;
  }
  return insertInkAnchored(transcript, entry);
}

/**
 * Absorb restored arc-note ink rows into the turns they narrated ([P12]).
 *
 * An arc note seated live lands INSIDE the streaming turn ({@link
 * handleArcNote}); after a relaunch the same note re-arrives as a shell
 * ledger row, which alone would seat it *between* turns — a transcript that
 * reads one way live and another way after every reopen. This pass closes
 * that gap deterministically from the clocks both sides already carry: the
 * ledger row's `startedAtMs` is the gesture's wall-clock, and replayed turns
 * carry their original submit/end times (the same clocks [P07]'s
 * between-turn interleave already trusts). An arc-note ink row whose
 * timestamp falls within a committed Claude turn's span is re-seated in that
 * turn as a `source: "arc"` system_note at its clock position among the
 * messages — the seat the note had when it happened.
 *
 * Runs wrapper-side on the committed transcript at every site that can
 * complete the pair — ink arriving (`ingest-ink-turn`), a turn arriving
 * (`append-transcript`), an older bracket committing (`flush-prepend`) — so
 * both orders of the reload race converge on the same reading. Idempotent
 * and dedup-safe: the re-seat keys on the ledger identity
 * (`arc-note-<exchangeId>`, the same key the live seat takes), and a turn
 * already carrying the note (by key, or an arc note with the identical
 * sentence) absorbs the row by dropping it. Returns the SAME array
 * reference when nothing moved, so a quiet pass costs no snapshot churn.
 *
 * A row no turn spans — a verb run by hand while the card sat idle, a
 * run-start line between stages — stays exactly where it is: between turns
 * is that note's true seat.
 */
export function absorbArcNotes(
  transcript: ReadonlyArray<TurnEntry>,
): ReadonlyArray<TurnEntry> {
  interface Seat {
    turnIndex: number;
    note: SystemNote;
    duplicate: boolean;
  }
  const seats = new Map<number, Seat>();
  for (let i = 0; i < transcript.length; i++) {
    const row = transcript[i]!;
    if (row.origin !== "shell") continue;
    const msg = row.messages[0];
    if (
      row.messages.length !== 1 ||
      msg === undefined ||
      msg.kind !== "shell_exchange" ||
      !matchesArcNote(msg.command)
    ) {
      continue;
    }
    const ts = msg.startedAtMs;
    for (let t = 0; t < transcript.length; t++) {
      const turn = transcript[t]!;
      if (isInkOrigin(turn.origin)) continue;
      if (ts < turnSortTs(turn) || ts > turn.endedAt) continue;
      const key = `arc-note-${msg.exchangeId}`;
      const text = arcNoteSentence(msg);
      const duplicate = turn.messages.some(
        (m) =>
          m.messageKey === key ||
          (m.kind === "system_note" && m.source === "arc" && m.text === text),
      );
      seats.set(i, {
        turnIndex: t,
        duplicate,
        note: {
          kind: "system_note",
          messageKey: key,
          createdAt: ts,
          text,
          command: msg.command,
          source: "arc",
        },
      });
      break;
    }
  }
  if (seats.size === 0) return transcript;
  const next: TurnEntry[] = [];
  const insertsByTurn = new Map<number, SystemNote[]>();
  for (const seat of seats.values()) {
    if (seat.duplicate) continue;
    const list = insertsByTurn.get(seat.turnIndex) ?? [];
    list.push(seat.note);
    insertsByTurn.set(seat.turnIndex, list);
  }
  for (let i = 0; i < transcript.length; i++) {
    if (seats.has(i)) continue; // the row's content moved (or already lives) inside its turn
    const turn = transcript[i]!;
    const inserts = insertsByTurn.get(i);
    if (inserts === undefined) {
      next.push(turn);
      continue;
    }
    const messages = turn.messages.slice();
    for (const note of inserts) {
      let at = messages.length;
      while (at > 0 && messages[at - 1]!.createdAt > note.createdAt) at--;
      messages.splice(at, 0, note);
    }
    next.push({ ...turn, messages });
  }
  return next;
}

function shellMessage(
  event: ShellExchangeStartedActionEvent | ShellExchangeCompleteActionEvent,
): ShellExchangeMessage {
  const settled = event.type === "shell_exchange_complete";
  return {
    kind: "shell_exchange",
    messageKey: `shell-${event.exchangeId}`,
    createdAt: event.startedAtMs,
    exchangeId: event.exchangeId,
    command: event.command,
    output: settled ? event.output : "",
    exitCode: settled ? event.exitCode : null,
    cwd: event.cwd,
    cwdAfter: settled ? event.cwdAfter : null,
    startedAtMs: event.startedAtMs,
    settledAtMs: settled ? event.settledAtMs : null,
    autoRouted: event.autoRouted === true,
  };
}

/**
 * `exchange_started` → mint an in-flight shell turn; `exchange_complete` →
 * settle it in place (or mint-whole for a restore / bare complete). Both build
 * the committed `TurnEntry` (pure) and emit an `ingest-ink-turn` effect; the
 * store wrapper upserts it into `_transcript` (which it owns) via
 * {@link upsertInkTurn}. No `CodeSessionState` mutation — shell turns are
 * disjoint from the Claude phase / activeTurn / scratch machinery ([P12]).
 */
function handleShellExchange(
  state: CodeSessionState,
  event: ShellExchangeStartedActionEvent | ShellExchangeCompleteActionEvent,
): { state: CodeSessionState; effects: Effect[] } {
  // Only a restore carries an anchor, and a restore always arrives whole as a
  // `complete` — an in-flight exchange is live, and live ink belongs at the end.
  const anchorMsgId =
    event.type === "shell_exchange_complete" ? event.anchorMsgId : undefined;
  const entry = buildShellTurnEntry(shellMessage(event), anchorMsgId);
  return { state, effects: [{ kind: "ingest-ink-turn", entry }] };
}

/**
 * `arc_note` reducer handler — seat an arc gesture's quiet line ([P12])
 * where a reader would expect the sentence in a conversation.
 *
 * A note that arrives while a turn is open narrates work THAT turn is doing —
 * the seated session ran the verb between two of its own tool calls — so it
 * appends to the open turn's scratch as a `source: "arc"` system_note,
 * exactly the mid-turn seat a live compaction boundary takes
 * ({@link handleCompactBoundary}). It renders between the tool calls it
 * arrived among and commits with the turn.
 *
 * A note with no open turn (a verb run by hand from a bare terminal, a
 * run-start line landing between stages) falls back to its own quiet ink row
 * at the transcript's end — built with the exchangeId the restore path mints
 * for the same ledger row, so a later ledger replay upserts the same turn key
 * instead of drawing the gesture twice.
 *
 * The suppressed-`/compact`-turn edge (open turn, no scratch) takes the same
 * fallback: a note must land somewhere, and a turn whose commit is dropped is
 * nowhere.
 */
function handleArcNote(
  state: CodeSessionState,
  event: ArcNoteActionEvent,
): { state: CodeSessionState; effects: Effect[] } {
  const turnKey = state.pendingTurn?.turnKey;
  const entry = turnKey !== undefined ? state.scratch.get(turnKey) : undefined;
  if (turnKey === undefined || entry === undefined) {
    const row = buildShellTurnEntry(
      shellMessage({
        type: "shell_exchange_complete",
        exchangeId: event.exchangeId,
        command: event.command,
        output: event.text,
        exitCode: 0,
        cwd: event.cwd,
        cwdAfter: null,
        startedAtMs: event.timestamp,
        settledAtMs: event.timestamp,
      }),
    );
    return { state, effects: [{ kind: "ingest-ink-turn", entry: row }] };
  }
  // Keyed on the ledger identity, not the per-turn systemNoteSeq: the same
  // note restored after a relaunch re-arrives as the `restored-N` ledger row,
  // and {@link absorbArcNotes} dedups its re-seat against exactly this key —
  // one gesture, one line, on every path.
  const note: SystemNote = {
    kind: "system_note",
    messageKey: `arc-note-${event.exchangeId}`,
    createdAt: event.timestamp,
    text: event.text,
    command: event.command,
    source: "arc",
  };
  return {
    state: {
      ...state,
      scratch: withScratchEntry(state.scratch, turnKey, {
        ...entry,
        messages: [...entry.messages, note],
      }),
    },
    effects: [],
  };
}

// ---------------------------------------------------------------------------
// Refs runs — the second ink origin
// ---------------------------------------------------------------------------

function refsMessage(event: RefsResultActionEvent): RefsResultMessage {
  return {
    kind: "refs_result",
    messageKey: `refs-${event.runId}`,
    createdAt: event.startedAtMs,
    runId: event.runId,
    opKind: event.opKind,
    command: event.command,
    root: event.root,
    refs: event.refs,
    inFlight: event.inFlight,
    cancelled: event.cancelled,
    notice: event.notice,
    startedAtMs: event.startedAtMs,
    settledAtMs: event.settledAtMs,
  };
}

/**
 * Build a committed `refs`-origin `TurnEntry` around one run's message.
 * Like a shell turn it bypasses the Claude turn machinery entirely — no
 * scratch, no activeTurn, no phase — and carries zero telemetry, because a
 * search costs no tokens.
 */
export function buildRefsTurnEntry(msg: RefsResultMessage, anchorMsgId?: string): TurnEntry {
  const end = msg.settledAtMs ?? msg.startedAtMs;
  const wall = Math.max(0, end - msg.startedAtMs);
  // A cancelled run really was interrupted; everything else — including a
  // run that found nothing — ran to completion.
  const turnEndReason: TurnEndReason = msg.cancelled ? "interrupted" : "complete";
  return {
    turnKey: `refs-${msg.runId}`,
    msgId: msg.runId,
    ...(anchorMsgId !== undefined ? { anchorMsgId } : {}),
    origin: "refs",
    messages: [msg],
    result: msg.cancelled ? "interrupted" : "success",
    endedAt: end,
    wallClockMs: wall,
    awaitingApprovalMs: 0,
    transportDowntimeMs: 0,
    activeMs: wall,
    ttftMs: null,
    ttftcMs: null,
    reconnectCount: 0,
    maxStreamGapMs: 0,
    turnEndReason,
    cost: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalCostUsd: 0,
    },
  };
}

/**
 * A refs run's state changed: mint its turn, or replace the one it already
 * owns. The event carries the run's whole state, so mint, every streaming
 * batch, and settle are one path — the ink upsert keeps the row's mount
 * identity and position across all of them ([L26]).
 */
function handleRefsResult(
  state: CodeSessionState,
  event: RefsResultActionEvent,
): { state: CodeSessionState; effects: Effect[] } {
  const entry = buildRefsTurnEntry(refsMessage(event), event.anchorMsgId);
  return { state, effects: [{ kind: "ingest-ink-turn", entry }] };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Pure reducer. Returns the next state and an ordered effect list; the
 * class wrapper in `code-session-store.ts` processes the effects.
 */
export function reduce(
  state: CodeSessionState,
  event: CodeSessionEvent,
): { state: CodeSessionState; effects: Effect[] } {
  switch (event.type) {
    case "send":
      return handleSend(state, event);
    case "shell_exchange_started":
    case "shell_exchange_complete":
      return handleShellExchange(state, event);
    case "arc_note":
      return handleArcNote(state, event);
    case "refs_result":
      return handleRefsResult(state, event);
    case "session_init":
      return handleSessionInit(state, event);
    case "content_block_start":
      return handleContentBlockStart(state, event);
    case "assistant_text":
      return handleTextDelta(state, event, "assistant_text");
    case "thinking_text":
      return handleTextDelta(state, event, "assistant_thinking");
    case "tool_use":
      return handleToolUse(state, event);
    case "tool_result":
      return handleToolResult(state, event);
    case "tool_use_structured":
      return handleToolUseStructured(state, event);
    case "turn_complete": {
      // Settle the goal against the PRE-commit state (the pendingTurn the
      // commit consumes is the goal's cycle), then apply it to the
      // handler's result. A successful commit of the goal's own cycle
      // means the evaluator passed — the goal is achieved. An errored /
      // interrupted / suppressed cycle leaves it possibly-active.
      const res = handleTurnComplete(state, event);
      const committedKey =
        state.pendingTurn !== null && res.state.pendingTurn === null
          ? state.pendingTurn.turnKey
          : null;
      const settled = settleGoalOnCycleCommit(
        res.state.goal,
        committedKey,
        event.result === "success",
      );
      return settled === res.state.goal
        ? res
        : { ...res, state: { ...res.state, goal: settled } };
    }
    case "turn_cancelled": {
      // Same goal settlement the `turn_complete` case performs, against the
      // same PRE-commit state: a cancelled cycle is never a success, so the
      // goal is left possibly-active rather than achieved.
      const res = handleTurnCancelled(state, event);
      const committedKey =
        state.pendingTurn !== null && res.state.pendingTurn === null
          ? state.pendingTurn.turnKey
          : null;
      const settled = settleGoalOnCycleCommit(
        res.state.goal,
        committedKey,
        false,
      );
      return settled === res.state.goal
        ? res
        : { ...res, state: { ...res.state, goal: settled } };
    }
    case "interrupt_noop":
      return handleInterruptNoop(state, event);
    case "goal_feedback":
      return {
        state: {
          ...state,
          goal: reduceGoalOnFeedback(
            state.goal,
            event.condition,
            event.reason,
            state.pendingTurn?.turnKey ?? null,
          ),
        },
        effects: [],
      };
    case "control_request_forward":
      return handleControlRequestForward(state, event);
    case "respond_approval":
      return handleRespondApproval(state, event);
    case "respond_question":
      return handleRespondQuestion(state, event);
    case "interrupt_action":
      return handleInterrupt(state, event.reason);
    case "set_permission_mode":
      return handleSetPermissionMode(state, event);
    case "set_model":
      return handleSetModel(state, event);
    case "set_effort":
      return handleSetEffort(state, event);
    case "consume_draft_restore":
      return handleConsumeDraftRestore(state);
    case "insert_command_draft":
      return handleInsertCommandDraft(state, event);
    case "consume_command_insert":
      return handleConsumeCommandInsert(state);
    case "insert_jot":
      return handleInsertJot(state, event);
    case "consume_jot_insert":
      return handleConsumeJotInsert(state);
    case "insert_atom_draft":
      return handleInsertAtomDraft(state, event);
    case "consume_atom_insert":
      return handleConsumeAtomInsert(state);
    case "insert_files":
      return handleInsertFiles(state, event);
    case "consume_file_insert":
      return handleConsumeFileInsert(state);
    case "cancel_queued_send":
      return handleCancelQueuedSend(state, event);
    case "cost_update":
      return handleCostUpdate(state, event);
    case "api_retry":
      return handleApiRetry(state, event);
    case "model_refusal_fallback":
      return handleModelRefusalFallback(state, event);
    case "output_truncated":
      return handleOutputTruncated(state, event);
    case "compact_boundary":
      return handleCompactBoundary(state, event);
    case "compact_summary":
      return handleCompactSummary(state, event);
    case "session_stage":
      return handleSessionStage(state, event);
    case "unknown_event":
      return handleUnknownEvent(state, event);
    case "streaming_usage":
      return handleStreamingUsage(state, event);
    case "context_breakdown":
      return handleContextBreakdown(state, event);
    case "system_metadata":
      // [D09] SessionMetadataStore owns this feed — drop explicitly.
      return { state, effects: [] };
    case "session_state_errored":
      return handleSessionStateErrored(state, event);
    case "session_unknown":
      return handleSessionUnknown(state, event);
    case "session_not_owned":
      return handleSessionNotOwned(state, event);
    case "seed_queued_sends":
      return handleSeedQueuedSends(state, event);
    case "network_path_satisfied":
      return handleNetworkPathSatisfied(state, event);
    case "transport_close":
      return handleTransportClose(state);
    case "transport_open":
      return handleTransportOpen(state);
    case "transport_settled":
      return handleTransportSettled(state);
    case "error":
      return handleWireError(state, event);
    case "resume_failed":
      return handleResumeFailed(state, event);
    case "replay_started":
      return handleReplayStarted(state, event);
    case "replay_complete": {
      const result = handleReplayComplete(state, event);
      // The session-created anchor is invariant and rides every success
      // `replay_complete` (windowed or full). Thread it onto whatever
      // state the handler's many branches returned — retaining the prior
      // value when this frame omits it (error / legacy) — so the single
      // assignment lives here rather than in each handler branch.
      const sessionCreatedAtMs =
        typeof event.sessionCreatedAtMs === "number"
          ? event.sessionCreatedAtMs
          : result.state.sessionCreatedAtMs;
      return sessionCreatedAtMs === result.state.sessionCreatedAtMs
        ? result
        : { ...result, state: { ...result.state, sessionCreatedAtMs } };
    }
    case "add_user_message":
      return handleAddUserMessage(state, event);
    case "wake_started":
      return handleWakeStarted(state, event);
    case "assistant_opener":
      return handleAssistantOpener(state, event);
    case "tug_notice":
      return handleTugNotice(state, event);
    case "task_started":
      return handleTaskStarted(state, event);
    case "task_updated":
      return handleTaskUpdated(state, event);
    case "task_progress":
      return handleTaskProgress(state, event);
    case "clear_jobs_action":
      return handleClearJobs(state);
    case "bind_resume_acknowledged":
      return handleBindResumeAcknowledged(state);
    case "begin_load_previous":
      // Mark the next replay bracket as a prepend (older range). Pure
      // flag flip; the request itself is sent by the store wrapper.
      return { state: { ...state, replayPrependActive: true }, effects: [] };
    case "tick_soft_budget":
      return handleTickSoftBudget(state);
    case "tick_timeout_dwell_done":
      return handleTickTimeoutDwellDone(state);
    case "tick_preflight_done":
      return handleTickPreflightDone(state);
    case "tick_replay_silence":
      return handleTickReplaySilence(state);
    case "tick_replay_bracket":
      return handleTickReplayBracket(state);
    case "tick_interrupt_silence":
      return handleTickInterruptSilence(state);
    case "tick_stream_stall":
      return handleTickStreamStall(state);
    case "force_stop":
      return handleForceStop(state);
    case "stop_all_work_done":
      return handleStopAllWorkDone(state);
    case "prompt_anchor":
      return handlePromptAnchor(state, event);
    case "rewind_preview_result":
      return handleRewindPreviewResult(state, event);
    case "rewind_result":
      return handleRewindResult(state, event);
    case "request_rewind_preview":
      return handleRequestRewindPreview(state, event);
    case "session_rewind_request":
      return handleSessionRewindRequest(state, event);
    default:
      return { state, effects: [] };
  }
}
