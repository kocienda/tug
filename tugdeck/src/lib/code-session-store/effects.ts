/**
 * Effect discriminated union per.
 *
 * The reducer in `reducer.ts` is a pure `(state, event) => { state, effects }`
 * function; the class wrapper in `code-session-store.ts` processes the
 * returned `effects[]` in order after each dispatch. Keeping effects
 * first-class makes every side effect grep-able and testable without a
 * live store.
 *
 * [D11] effect-list reducer
 */

import type { InboundMessage } from "@/protocol";
import type { CodeSessionEvent } from "./events";
import type { LiveMessageUsage, TurnEntry } from "./types";
import type { StageBoundaryFacts } from "./stages";

/** Logical channel a streaming write targets ([D07]). Combined with
 *  the turn's React-key seed (`turnKey`) and the Message's stable
 *  identity seed (`messageKey`) to form the final PropertyStore path:
 *  `turn.${turnKey}.message.${messageKey}.${channel}`.
 *
 *  Only one channel today: `"text"` — append-only text for
 *  `assistant_text` / `assistant_thinking` / `system_note` Messages.
 *  `TugMarkdownBlock` subscribes to the resulting path and writes the
 *  rendered DOM imperatively per delta (per [L22]) — bypassing React's
 *  render cycle, which is what makes per-token streaming smooth.
 *
 *  Tool-use state is NOT a streaming channel. `ToolUseMessage` mutates
 *  a small number of times per call (mint, input fill, result,
 *  structuredResult) and tool blocks are React components that
 *  re-render normally on snapshot updates; piping them through
 *  PropertyStore would duplicate the snapshot's authority without a
 *  perf win. The state channel from [D07]'s sketch was a placeholder
 *  for a perf concern the snapshot model already resolves.
 *
 *  Per-Message paths mean a committed cell can keep observing its own
 *  path forever without being polluted by other Messages' writes —
 *  the [L26] mount-identity foundation that lets each Message's
 *  streaming subscription survive the inflight → committed transition.
 */
export type StreamChannel = "text";

export interface WriteInflightEffect {
  kind: "write-inflight";
  /** Turn-stable React-key seed (shared by every Message of the turn). */
  turnKey: string;
  /** Message-stable identity seed (see {@link MessageBase.messageKey}). */
  messageKey: string;
  /** {@link StreamChannel} this write targets. */
  channel: StreamChannel;
  value: string;
}

export interface ClearInflightEffect {
  kind: "clear-inflight";
}

export interface SendFrameEffect {
  kind: "send-frame";
  msg: InboundMessage;
}

/**
 * Upsert a `shell`-origin turn into the committed transcript ([P06]/[P12]).
 * The store wrapper applies it with {@link upsertInkTurn}: replace a turn
 * with the same `turnKey` in place (settle), or insert at its timestamp
 * position (mint / restore interleave). Disjoint from the Claude turn
 * lifecycle — no phase change, no `activeTurn` touch.
 */
export interface IngestInkTurnEffect {
  kind: "ingest-ink-turn";
  entry: TurnEntry;
}

export interface AppendTranscriptEffect {
  kind: "append-transcript";
  entry: TurnEntry;
  /**
   * When true, this turn belongs to a load-previous (older) replay
   * bracket: the store stages it (in arrival order) rather than
   * appending, and `flush-prepend` commits the whole staged batch
   * ahead of the existing transcript at `replay_complete`. Absent /
   * false ⇒ the normal append (newest at the end).
   */
  prepend?: boolean;
}

/**
 * Commit a staged load-previous batch: move the turns staged by
 * `append-transcript { prepend: true }` to the FRONT of the transcript,
 * in arrival order, then clear the staging buffer. Emitted by
 * `replay_complete` when the bracket was a prepend. Idempotent — an
 * empty staging buffer is a no-op.
 */
export interface FlushPrependEffect {
  kind: "flush-prepend";
}

/**
 * Discard a staged load-previous batch without committing it: clear the
 * staging buffer the prepend bracket accumulated. Emitted by
 * `replay_complete{aborted}` — the user cancelled the load, so the
 * partial older turns are dropped and the prior loaded window stays
 * intact. Idempotent — an empty staging buffer is a no-op.
 */
export interface DiscardPrependEffect {
  kind: "discard-prepend";
}

/**
 * Schedule a named timer that dispatches `fire` on expiry. The store's
 * dispatch loop tracks pending timers in a `Map<string, TimerHandle>`;
 * a second `schedule_timer` with the same `name` cancels the prior
 * timer first so re-entry produces no leaks. On expiry the timer
 * removes itself from the map and dispatches `fire` back into the
 * reducer. The reducer is pure — only the store wrapper sees real
 * `setTimeout` calls.
 *
 * The four names used today are `"preflight"` (cleared by the first
 * of `replay_started` / `replay_complete` / `transport_close` /
 * 12s tick), `"soft_budget"` (cleared by `replay_started` /
 * `replay_complete`), `"timeout_dwell"` (cleared by the dwell
 * tick itself or by `replay_started` opening the next window), and
 * `"replay_silence"` (restarted by every wire frame inside a replay
 * bracket, cleared on leaving it — armed by the store wrapper through
 * `replaySilenceEffect`, since only the wrapper knows a frame's origin).
 */
export interface ScheduleTimerEffect {
  kind: "schedule_timer";
  name: string;
  ms: number;
  fire: CodeSessionEvent;
}

/**
 * Cancel a named timer scheduled via `schedule_timer`. Idempotent: a
 * `cancel_timer` for an unknown name is a no-op.
 */
export interface CancelTimerEffect {
  kind: "cancel_timer";
  name: string;
}

/**
 * Persist a per-turn telemetry block via the tugcast SessionLedger.
 * Emitted by `handleTurnComplete` on the LIVE path only — replayed
 * turns arrive with `event.telemetry` already inlined, and the
 * reducer doesn't re-persist them (the persisted row already exists,
 * which is how the inline made it onto the wire in the first place).
 *
 * The store wrapper looks up `tugSessionId` from its own state and
 * builds the `record_turn_telemetry` CONTROL frame via
 * `encodeRecordTurnTelemetry`. The effect carries the
 * tug_session_id-independent payload so the reducer stays pure.
 *
 * Fire-and-forget: no ack frame is awaited. The row's reason for
 * existing is to survive the next reload, not the next render — see
 * plan `#step-20-3-3` / `#step-20-3-4`.
 */
export interface RecordTelemetryEffect {
  kind: "record-telemetry";
  msgId: string;
  telemetry: import("./telemetry").TurnTelemetry;
  endedAt: number;
}

/**
 * Persist a `/context`-style breakdown frame via the tugcast
 * SessionLedger. Emitted by `handleContextBreakdown` on every frame
 * the reducer consumes — both live frames from tugcode and the
 * bind-time attach the supervisor re-emits from the persisted row
 * (the latter writes the same bytes back, which is idempotent).
 *
 * The store wrapper builds the `record_context_breakdown` CONTROL
 * frame via `encodeRecordContextBreakdown`, threading the store's
 * own `tugSessionId`. Fire-and-forget: no ack frame is awaited.
 *
 * `payload` carries the wire-frame shape the supervisor stores
 * verbatim. `capturedAt` is `Date.now()` at the moment the reducer
 * built the effect — used by the ledger row's `captured_at` column.
 */
export interface RecordContextBreakdownEffect {
  kind: "record-context-breakdown";
  payload: import("./types").ContextBreakdownSnapshot;
  capturedAt: number;
}

/**
 * Locally truncate the committed transcript to the `/rewind` anchor
 * ([#step-7-3]): drop the turn whose `promptUuid` matches AND every turn
 * after it; survivors keep their `TurnEntry` reference (and thus their
 * `turnKey`/`msgId`) byte-identical so React preserves their mounts ([L26]).
 * Emitted by the `rewind_result` handler for a successful conversation/both
 * rewind; the store wrapper applies it to its `_transcript` array (which does
 * not live in reducer state — [D04]) via `truncateTranscriptAtAnchor`. A no-op
 * when the anchor isn't in the transcript.
 */
export interface TruncateTranscriptEffect {
  kind: "truncate-transcript";
  promptUuid: string;
}

/**
 * Append a compaction `system_note` divider to the LAST committed turn ([P04]).
 * Emitted by `handleCompactBoundary` on the replay path when the boundary
 * arrives with no open turn (the `/compact` scaffolding records are skipped, so
 * it lands right after the prior turn closed). Like {@link
 * TruncateTranscriptEffect}, the store wrapper applies it to its `_transcript`
 * array (which does not live in reducer state — [D04]): it mints the note's
 * `messageKey` from the last turn's `turnKey` + `messages.length` (a committed
 * turn carries no `systemNoteSeq`; `messages.length` is deterministic and
 * collision-safe) and appends copy-on-write. A no-op on an empty transcript.
 *
 * `compactionPostTotal` (H1) carries the honest post-compaction window
 * (`post_tokens`) on the replay path, where there is no scratch
 * entry to stamp: the wrapper writes it onto the same last committed `TurnEntry`
 * it seats the note on, so `deriveContextWindows` reads the honest window even
 * with no post-compaction turn. Absent when the boundary carried no finite,
 * positive `post_tokens`.
 */
export interface AppendCompactNoteEffect {
  kind: "append-compact-note";
  text: string;
  /**
   * The boundary record's own time (epoch ms), present on the replay path.
   * The wrapper mints the divider note's `createdAt` from it so a replayed
   * compaction never wears the relaunch clock; absent on the live path,
   * where `Date.now()` is honest.
   */
  timestamp?: number;
  compactionPostTotal?: number;
}

/**
 * Seat an arc stage divider on the LAST committed turn. The counterpart of
 * {@link AppendCompactNoteEffect} for a `session_stage`, and the ordinary
 * path rather than the fallback: the runner rotates a session only once it
 * has gone idle, so there is no open turn to attach to. The committed
 * transcript lives in the store wrapper, not reducer state ([D04]), so the
 * reducer asks for the append instead of performing it. An empty transcript
 * makes it a no-op.
 */
export interface AppendStageNoteEffect {
  kind: "append-stage-note";
  text: string;
  /** The rotation's facts, carried to the boundary beside the display text. */
  stageFacts: StageBoundaryFacts;
}

/**
 * Publish the latest live intra-turn token usage to the store's streaming
 * document (`telemetry.liveTurnUsage`) instead of reducer state. Usage
 * frames are pure display telemetry at high frequency; keeping them out of
 * the snapshot means a `streaming_usage` frame re-renders ONLY the status
 * cells observing the path — never the transcript list. The store wrapper
 * clears the path at `activeTurn` boundaries, preserving the old
 * "reset at send / superseded at commit" lifecycle.
 */
export interface WriteLiveUsageEffect {
  kind: "write-live-usage";
  usage: LiveMessageUsage;
}

export type Effect =
  | WriteLiveUsageEffect
  | WriteInflightEffect
  | ClearInflightEffect
  | SendFrameEffect
  | AppendTranscriptEffect
  | IngestInkTurnEffect
  | FlushPrependEffect
  | DiscardPrependEffect
  | ScheduleTimerEffect
  | CancelTimerEffect
  | RecordTelemetryEffect
  | RecordContextBreakdownEffect
  | TruncateTranscriptEffect
  | AppendCompactNoteEffect
  | AppendStageNoteEffect;

export function isWriteInflight(e: Effect): e is WriteInflightEffect {
  return e.kind === "write-inflight";
}

export function isClearInflight(e: Effect): e is ClearInflightEffect {
  return e.kind === "clear-inflight";
}

export function isSendFrame(e: Effect): e is SendFrameEffect {
  return e.kind === "send-frame";
}

export function isAppendTranscript(e: Effect): e is AppendTranscriptEffect {
  return e.kind === "append-transcript";
}

export function isScheduleTimer(e: Effect): e is ScheduleTimerEffect {
  return e.kind === "schedule_timer";
}

export function isCancelTimer(e: Effect): e is CancelTimerEffect {
  return e.kind === "cancel_timer";
}

export function isRecordTelemetry(e: Effect): e is RecordTelemetryEffect {
  return e.kind === "record-telemetry";
}

export function isRecordContextBreakdown(
  e: Effect,
): e is RecordContextBreakdownEffect {
  return e.kind === "record-context-breakdown";
}
