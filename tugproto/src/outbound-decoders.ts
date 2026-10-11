/**
 * tugproto/outbound-decoders — one {@link Decoder} per CODE_OUTPUT wire tag,
 * built from the `decode` combinators and checked against the payload types
 * in `outbound.ts`.
 *
 * A consumer reads a frame's `type`, looks its decoder up in
 * {@link OUTBOUND_DECODERS}, and runs it through {@link decodeOutbound}: the
 * result is the frame typed as its payload, or a `DecodeError` naming the tag,
 * the path, what was expected and what arrived.
 *
 * **What a decoder checks.** Every payload field the type declares, with its
 * declared kind; optional fields are checked when present. The envelope —
 * `session_id` and `ipc_version` — is checked when present and never
 * required: tugcode always stamps it, but no consumer reads it, and a frame
 * that carried the payload without it would otherwise be dropped for a field
 * nobody wanted. Undeclared fields pass through untouched (tugcast's
 * `tug_session_id` stamp is one), and a decoded frame is the object that
 * arrived.
 *
 * The golden stream-json catalog is the proof these accept what tugcode
 * emits: the deck's catalog test runs every captured frame with a decoder
 * through it and asserts no failure, so a decoder stricter than the wire
 * fails there.
 *
 * Pure functions — no React, no DOM, no Node/Bun API.
 *
 * @module tugproto/outbound-decoders
 */

import { arr, bool, type Decoder, DecodeError, decode, lit, num, obj, opt, str, union } from "./decode";
import type { OutboundMessage, OutboundTag } from "./outbound";

/** The envelope fields every outbound frame carries and no consumer reads. */
type Envelope = "session_id" | "ipc_version";

/** The outbound payload type for a wire tag. */
export type FrameOf<T extends OutboundTag> = Extract<OutboundMessage, { type: T }>;

/** `F` with the keys `K` made optional, member by member when `F` is a union. */
type Loosen<F, K extends PropertyKey> = F extends unknown
  ? Omit<F, K> & Partial<Pick<F, K & keyof F>>
  : never;

/** A frame as a decoder admits it: the payload type with its envelope optional. */
export type Received<F> = Loosen<F, Envelope>;

/**
 * Payload fields an older tugcode did not emit, by tag. `outbound.ts` states
 * what tugcode emits now. These fields are required there, but the golden
 * catalog still holds captures from before they existed, and the deck's
 * fixture-replay tests drive the store with those captures. So the decoder
 * admits them absent, and its type says so.
 *
 * `block_index` arrived with `content_block_start`; every capture before
 * v2.1.154 lacks it on `assistant_text`, and before v2.1.147 on
 * `thinking_text` too.
 *
 * `error`'s `site` and `recoverable` came after the frame itself. The deck's
 * banner reads their absence as "the bridge had no opinion" (no site shown,
 * and not offered back as recoverable) rather than as a malformed frame, and
 * its tests hold that.
 */
interface LegacyOptional {
  assistant_text: "block_index";
  thinking_text: "block_index";
  error: "site" | "recoverable";
}

/** What a tag's decoder yields: {@link Received}, with its legacy fields optional. */
export type Admitted<T extends OutboundTag> = Loosen<
  Received<FrameOf<T>>,
  T extends keyof LegacyOptional ? LegacyOptional[T] : never
>;

const envelope = {
  session_id: opt(str),
  ipc_version: opt(num),
};

/** A non-null, non-array object of any shape — a field typed `object` or a record. */
const anyObject = obj({});

/** Any value at all — the element of a field typed `unknown[]`. */
const anyValue: Decoder<unknown> = (value) => value;

// ---------------------------------------------------------------------------
// Turn content — the frames a turn is made of, opener to close
// ---------------------------------------------------------------------------

const sessionInit = obj({ type: lit("session_init"), ...envelope });

const contentBlockStart = union(
  obj({
    type: lit("content_block_start"),
    ...envelope,
    msg_id: str,
    block_index: num,
    kind: lit("text", "thinking"),
    timestamp: opt(num),
  }),
  obj({
    type: lit("content_block_start"),
    ...envelope,
    msg_id: str,
    block_index: num,
    kind: lit("tool_use"),
    tool_use_id: str,
    tool_name: str,
    timestamp: opt(num),
  }),
);

const assistantText = obj({
  type: lit("assistant_text"),
  ...envelope,
  msg_id: str,
  block_index: opt(num),
  seq: num,
  rev: num,
  text: str,
  is_partial: bool,
  status: str,
});

const thinkingText = obj({
  type: lit("thinking_text"),
  ...envelope,
  msg_id: str,
  block_index: opt(num),
  seq: num,
  text: str,
  is_partial: bool,
  status: str,
});

const toolUse = obj({
  type: lit("tool_use"),
  ...envelope,
  msg_id: str,
  seq: num,
  tool_name: str,
  tool_use_id: str,
  input: anyObject,
  parent_tool_use_id: opt(str),
  timestamp: opt(num),
});

const toolResult = obj({
  type: lit("tool_result"),
  ...envelope,
  tool_use_id: str,
  output: str,
  is_error: bool,
  timestamp: opt(num),
});

const toolUseStructured = obj({
  type: lit("tool_use_structured"),
  ...envelope,
  tool_use_id: str,
  tool_name: str,
  structured_result: union(anyObject, str),
});

const turnTelemetry = obj({
  cost: obj({
    inputTokens: num,
    outputTokens: num,
    cacheCreationInputTokens: num,
    cacheReadInputTokens: num,
    totalCostUsd: num,
  }),
  wallClockMs: num,
  awaitingApprovalMs: num,
  transportDowntimeMs: num,
  activeMs: num,
  ttftMs: union(num, lit(null)),
  ttftcMs: union(num, lit(null)),
  reconnectCount: num,
  maxStreamGapMs: num,
  sessionInitTokens: union(num, lit(null)),
  turnEndReason: opt(lit("complete", "interrupted", "error", "transport_lost")),
});

const turnComplete = obj({
  type: lit("turn_complete"),
  ...envelope,
  msg_id: str,
  seq: num,
  // `outbound.ts` types this `string`, but tugcode writes only these three
  // (`event-mapping.ts` maps claude's subtype onto success / error, the
  // replay translator adds interrupted), and the reducer's event narrows
  // to exactly them.
  result: lit("success", "error", "interrupted"),
  is_api_error: opt(bool),
  telemetry: opt(turnTelemetry),
  timestamp: opt(num),
});

const turnCancelled = obj({
  type: lit("turn_cancelled"),
  ...envelope,
  msg_id: str,
  seq: num,
  partial_result: str,
  is_recovery: opt(bool),
});

const interruptNoop = obj({
  type: lit("interrupt_noop"),
  ...envelope,
  tug_session_id: str,
  reason: lit("no_process", "no_turn"),
});

const stopAllWorkDone = obj({
  type: lit("stop_all_work_done"),
  ...envelope,
  tug_session_id: str,
});

const contentBlock = union(
  obj({ type: lit("text"), text: str }),
  obj({
    type: lit("image"),
    source: obj({ type: lit("base64"), media_type: str, data: str }),
  }),
);

const addUserMessage = obj({
  type: lit("add_user_message"),
  ...envelope,
  content: arr(contentBlock),
  timestamp: opt(num),
  promptUuid: opt(str),
  origin: opt(lit("user", "wheel")),
});

const wakeStarted = obj({
  type: lit("wake_started"),
  ...envelope,
  wake_trigger: obj({
    task_id: str,
    tool_use_id: str,
    status: lit("completed", "failed", "stopped"),
    summary: str,
    output_file: str,
  }),
});

const assistantOpener = obj({
  type: lit("assistant_opener"),
  ...envelope,
  timestamp: opt(num),
});

/**
 * `tug_notice` — the one CODE_OUTPUT frame tugcode never emits, so it has no
 * interface in `outbound.ts` and no place in `OUTBOUND_TAGS`. tugcast writes
 * it itself, beside a turn Tug injects into a session (`notice_payload`) or as
 * a notice with no turn behind it (`bulletin_payload`, which adds
 * `standalone: true`), both in `tugrust/crates/tugcast/src/feeds/base_motion.rs`.
 * This is that JSON's shape; the deck's `TugNoticeEvent` is it plus the
 * `turnKey` the store mints on receipt.
 */
export interface TugNotice {
  type: "tug_notice";
  tug_session_id?: string;
  /** Which subsystem spoke (e.g. `"base-motion"`). */
  origin?: string;
  text?: string;
  standalone?: boolean;
  timestamp?: number;
}

const tugNotice = obj({
  type: lit("tug_notice"),
  tug_session_id: opt(str),
  origin: opt(str),
  text: opt(str),
  standalone: opt(bool),
  timestamp: opt(num),
});

// ---------------------------------------------------------------------------
// Telemetry and display — metadata, cost, retries, notices, errors
// ---------------------------------------------------------------------------

const systemMetadata = obj({
  type: lit("system_metadata"),
  ...envelope,
  cwd: str,
  tools: opt(arr(anyValue)),
  model: opt(str),
  permissionMode: opt(str),
  slash_commands: opt(arr(anyValue)),
  plugins: opt(arr(anyValue)),
  agents: opt(arr(anyValue)),
  skills: opt(arr(anyValue)),
  mcp_servers: opt(arr(anyValue)),
  version: opt(str),
  output_style: opt(str),
  fast_mode_state: opt(str),
  apiKeySource: opt(str),
});

const controlRequestForward = obj({
  type: lit("control_request_forward"),
  ...envelope,
  request_id: str,
  tool_name: str,
  input: anyObject,
  decision_reason: opt(str),
  permission_suggestions: opt(arr(anyValue)),
  blocked_path: opt(str),
  tool_use_id: opt(str),
  is_question: bool,
});

const costUpdate = obj({
  type: lit("cost_update"),
  ...envelope,
  total_cost_usd: num,
  num_turns: num,
  duration_ms: num,
  duration_api_ms: num,
  usage: anyObject,
  modelUsage: anyObject,
  permission_denials: opt(arr(anyValue)),
});

const apiRetry = obj({
  type: lit("api_retry"),
  ...envelope,
  attempt: num,
  max_retries: num,
  retry_delay_ms: num,
  error_status: union(num, lit(null)),
  error: str,
});

const modelRefusalFallback = obj({
  type: lit("model_refusal_fallback"),
  ...envelope,
  original_model: str,
  fallback_model: str,
  trigger: str,
  direction: str,
});

const outputTruncated = obj({ type: lit("output_truncated"), ...envelope });

const goalFeedback = obj({
  type: lit("goal_feedback"),
  ...envelope,
  condition: str,
  reason: str,
});

const streamingUsage = obj({
  type: lit("streaming_usage"),
  ...envelope,
  msg_id: str,
  usage: anyObject,
});

const contextBreakdown = obj({
  type: lit("context_breakdown"),
  ...envelope,
  tug_session_id: str,
  context_max: num,
  categories: arr(
    obj({
      id: lit(
        "system_prompt",
        "system_tools",
        "custom_agents",
        "memory_files",
        "skills",
        "autocompact_buffer",
      ),
      label: str,
      tokens: num,
    }),
  ),
  from_supervisor_attach: opt(bool),
});

const unknownEvent = obj({
  type: lit("unknown_event"),
  ...envelope,
  original_type: str,
  payload_hex_preview: str,
});

const errorFrame = obj({
  type: lit("error"),
  ...envelope,
  message: str,
  recoverable: opt(bool),
  site: opt(lit(
    "stub_transcript_load",
    "protocol_version_unsupported",
    "session_prepare_failed",
    "background_spawn_failed",
    "session_init_failed",
    "user_message_failed",
    "inbound_dispatch",
    "local_command_stderr",
    "post_handshake_exit",
    "fresh_init_exit",
    "drain_eof_open_turn",
    "send_after_eof",
    "send_ready_timeout",
    "send_respawn_timeout",
    "stub_replay_exhausted",
  )),
});

const resumeFailed = obj({
  type: lit("resume_failed"),
  ...envelope,
  reason: str,
  stale_session_id: str,
});

// ---------------------------------------------------------------------------
// Replay, lineage and rewind — the brackets, the segment chain, the anchors
// ---------------------------------------------------------------------------

const compactBoundary = obj({
  type: lit("compact_boundary"),
  ...envelope,
  trigger: opt(str),
  timestamp: opt(num),
  pre_tokens: opt(num),
  post_tokens: opt(num),
});

const compactSummary = obj({
  type: lit("compact_summary"),
  ...envelope,
  summary: str,
});

const sessionSegment = obj({
  type: lit("session_segment"),
  ...envelope,
  parentSessionId: str,
  newSessionId: str,
  kind: lit("rotation", "rewind", "fork", "continue", "respawn", "new", "relocate"),
  forkPoint: opt(str),
  stage: opt(str),
  model: opt(str),
  document: opt(str),
  arc: opt(str),
  prompt: opt(str),
  steps: opt(str),
});

const replayStage = obj({
  type: lit("replay_stage"),
  ...envelope,
  stage: str,
  model: str,
  document: str,
  arc: str,
});

const replayRelocation = obj({
  type: lit("replay_relocation"),
  ...envelope,
  from_dir: str,
  to_dir: str,
});

const replayStarted = obj({ type: lit("replay_started"), ...envelope });

const replayComplete = obj({
  type: lit("replay_complete"),
  ...envelope,
  count: num,
  error: opt(
    obj({
      kind: lit(
        "jsonl_missing",
        "jsonl_unreadable",
        "jsonl_malformed",
        "replay_timeout",
        "replay_exception",
      ),
      message: str,
    }),
  ),
  firstLoadedTurnIndex: opt(num),
  totalTurns: opt(num),
  hasOlder: opt(bool),
  sessionCreatedAtMs: opt(num),
  aborted: opt(bool),
});

const promptAnchor = obj({
  type: lit("prompt_anchor"),
  ...envelope,
  promptUuid: str,
});

const rewindPreviewResult = obj({
  type: lit("rewind_preview_result"),
  ...envelope,
  promptUuid: str,
  canRewind: bool,
  error: opt(str),
  filesChanged: opt(arr(str)),
  insertions: opt(num),
  deletions: opt(num),
  conversationRewindable: opt(bool),
});

const rewindResult = obj({
  type: lit("rewind_result"),
  ...envelope,
  promptUuid: str,
  scope: lit("conversation", "code", "both"),
  canRewind: bool,
  error: opt(str),
  newSessionId: opt(str),
  cutAtMs: opt(num),
});

// ---------------------------------------------------------------------------
// Unwrapped before admission — the batch envelope and the progress frames
// ---------------------------------------------------------------------------

/**
 * A `replay_batch` as its decoder admits it: an envelope around a run of
 * frames. The frames stay `unknown` here on purpose. The consumer unwraps the
 * batch and decodes each inner frame with that frame's own decoder, so one
 * drifted frame is dropped alone rather than taking the whole batch with it.
 */
export interface ReplayBatchEnvelope {
  type: "replay_batch";
  frames: unknown[];
  ipc_version?: number;
}

const replayBatch = obj({
  type: lit("replay_batch"),
  ipc_version: opt(num),
  frames: arr(anyValue),
});

const toolProgress = obj({
  type: lit("tool_progress"),
  ...envelope,
  tool_use_id: str,
  tool_name: str,
  elapsed_time_seconds: num,
  parent_tool_use_id: union(str, lit(null)),
});

/**
 * `run_progress`, like {@link TugNotice}, comes from tugcast and not tugcode.
 * `run_progress_payload` in `tugrust/crates/tugcast/src/feeds/agent_supervisor/mod.rs`
 * writes it: `tool_use_id` is `null` when the report is attached to no running
 * call, and absent numbers are omitted. This is that JSON's shape.
 */
export interface RunProgressFrame {
  type: "run_progress";
  tool_use_id: string | null;
  label?: string;
  text?: string;
  done?: number;
  total?: number;
  failures?: number;
  at_ms?: number;
  tug_session_id?: string;
}

const runProgress = obj({
  type: lit("run_progress"),
  tool_use_id: union(str, lit(null)),
  label: opt(str),
  text: opt(str),
  done: opt(num),
  total: opt(num),
  failures: opt(num),
  at_ms: opt(num),
  tug_session_id: opt(str),
});

// ---------------------------------------------------------------------------
// Background tasks — `task_started` / `task_updated` / `task_progress`
// ---------------------------------------------------------------------------

const taskStarted = obj({
  type: lit("task_started"),
  ...envelope,
  task_id: str,
  tool_use_id: str,
  description: str,
  task_type: str,
  subagent_type: opt(str),
});

const taskUpdated = obj({
  type: lit("task_updated"),
  ...envelope,
  task_id: str,
  status: str,
  end_time: opt(num),
});

const taskProgress = obj({
  type: lit("task_progress"),
  ...envelope,
  task_id: str,
  tool_use_id: str,
  description: str,
  subagent_type: opt(str),
  last_tool_name: opt(str),
  usage: opt(
    obj({
      total_tokens: opt(num),
      tool_uses: opt(num),
      duration_ms: opt(num),
    }),
  ),
});

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/**
 * The decoder for each wire tag the deck admits. `satisfies` holds every entry
 * to its tag's payload type, so a decoder that drifts from `outbound.ts`
 * fails to compile.
 */
export const OUTBOUND_DECODERS = {
  session_init: sessionInit,
  content_block_start: contentBlockStart,
  assistant_text: assistantText,
  thinking_text: thinkingText,
  tool_use: toolUse,
  tool_result: toolResult,
  tool_use_structured: toolUseStructured,
  turn_complete: turnComplete,
  turn_cancelled: turnCancelled,
  interrupt_noop: interruptNoop,
  stop_all_work_done: stopAllWorkDone,
  add_user_message: addUserMessage,
  wake_started: wakeStarted,
  assistant_opener: assistantOpener,
  // From tugcast, not tugcode — see {@link TugNotice} for where its shape lives.
  tug_notice: tugNotice,
  system_metadata: systemMetadata,
  control_request_forward: controlRequestForward,
  cost_update: costUpdate,
  api_retry: apiRetry,
  model_refusal_fallback: modelRefusalFallback,
  output_truncated: outputTruncated,
  goal_feedback: goalFeedback,
  streaming_usage: streamingUsage,
  context_breakdown: contextBreakdown,
  unknown_event: unknownEvent,
  error: errorFrame,
  resume_failed: resumeFailed,
  compact_boundary: compactBoundary,
  compact_summary: compactSummary,
  session_segment: sessionSegment,
  replay_stage: replayStage,
  replay_relocation: replayRelocation,
  replay_started: replayStarted,
  replay_complete: replayComplete,
  prompt_anchor: promptAnchor,
  rewind_preview_result: rewindPreviewResult,
  rewind_result: rewindResult,
  task_started: taskStarted,
  task_updated: taskUpdated,
  task_progress: taskProgress,
  // Unwrapped before admission: the store's `routeFrame` and `divertProgress`
  // decode these, and none of them reaches the reducer as itself.
  replay_batch: replayBatch,
  tool_progress: toolProgress,
  // From tugcast, not tugcode — see {@link RunProgressFrame}.
  run_progress: runProgress,
} as const satisfies {
  readonly [T in Exclude<OutboundTag, "replay_batch">]?: Decoder<Admitted<T>>;
} & {
  readonly tug_notice: Decoder<TugNotice>;
  readonly replay_batch: Decoder<ReplayBatchEnvelope>;
  readonly run_progress: Decoder<RunProgressFrame>;
};

/** A wire tag with a decoder. */
export type DecodedTag = keyof typeof OUTBOUND_DECODERS;

/**
 * The other half of the table's `satisfies`, which proves only that a decoder
 * admits nothing its type does not. This proves the converse: every frame the
 * type describes, the decoder admits. Without it a member added to a literal
 * union in `outbound.ts` — a new `ErrorFrameSite`, a new segment `kind` —
 * would compile, and the deck would drop every frame carrying it. `F` is
 * distributed so a union frame is checked member by member. `turn_complete`
 * is narrower than its type on purpose (see its `result`). `readonly` is
 * stripped first: a decoder's arrays are mutable, and that is not a gap.
 */
type Writable<T> =
  T extends ReadonlyArray<infer E>
    ? Writable<E>[]
    : T extends object
      ? { -readonly [K in keyof T]: Writable<T[K]> }
      : T;
type Unadmitted = {
  [T in Exclude<DecodedTag & OutboundTag, "replay_batch" | "turn_complete">]: Admitted<T> extends infer F
    ? F extends unknown
      ? Writable<F> extends DecodedFrame<T>
        ? never
        : T
      : never
    : never;
}[Exclude<DecodedTag & OutboundTag, "replay_batch" | "turn_complete">];
const everyTypedFrameDecodes: [Unadmitted] extends [never] ? true : Unadmitted = true;
void everyTypedFrameDecodes;

/** The type a tag's decoder yields. */
export type DecodedFrame<T extends DecodedTag> =
  (typeof OUTBOUND_DECODERS)[T] extends Decoder<infer F> ? F : never;

/** True when `tag` has a decoder. */
export function hasDecoder(tag: string): tag is DecodedTag {
  return Object.prototype.hasOwnProperty.call(OUTBOUND_DECODERS, tag);
}

/** Decode `frame` as `tag`'s payload; a failure carries the tag. */
export function decodeOutbound<T extends DecodedTag>(
  tag: T,
  frame: unknown,
): DecodedFrame<T> | DecodeError {
  const decoder = OUTBOUND_DECODERS[tag] as Decoder<DecodedFrame<T>>;
  return decode(tag, decoder, frame);
}

/** Any decoded frame, discriminated by its `type`. */
export type AnyDecodedFrame = { [T in DecodedTag]: DecodedFrame<T> }[DecodedTag];

/**
 * Decode a frame by its own `type`. A value with no string `type`, or with a
 * tag that has no decoder, is `null`: there is nothing to decode it against,
 * which is a different fact from a frame that failed its decoder.
 */
export function decodeTagged(frame: unknown): AnyDecodedFrame | DecodeError | null {
  const tag =
    typeof frame === "object" && frame !== null ? (frame as { type?: unknown }).type : undefined;
  if (typeof tag !== "string" || !hasDecoder(tag)) return null;
  // `decodeOutbound` over the whole tag union yields the union of frames.
  return decodeOutbound(tag, frame) as AnyDecodedFrame | DecodeError;
}
