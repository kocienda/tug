// IPC message type definitions (tugcast ↔ tugcode stdin/stdout)

// The inbound client → tugcode contract ([#step-13c1]) is authored once in
// `@tugproto/inbound` and re-exported here so tugcode call sites keep importing
// these from `./types.ts`. ContentBlock is the Anthropic content-block shape
// carried verbatim on `user_message`. Per-type guards below derive from the
// imported types; `isInboundMessage` derives from the shared verb list.
import type {
  ContentBlock,
  ProtocolInit,
  UserMessage,
  ToolApproval,
  QuestionAnswer,
  Interrupt,
  PermissionModeMessage,
  ModelChange,
  EffortChange,
  AddDirectory,
  SessionCommand,
  SessionStageSpec,
  StopTask,
  RequestReplay,
  ReplayWindow,
  ReplayLineageEntry,
  CancelReplay,
  RewindPreview,
  SessionRewind,
  SkillsInventoryQuery,
  HooksQuery,
  SideQuestion,
  InboundMessage,
} from "@tugproto/inbound";
export type {
  ContentBlock,
  ProtocolInit,
  UserMessage,
  ToolApproval,
  QuestionAnswer,
  Interrupt,
  PermissionModeMessage,
  ModelChange,
  EffortChange,
  AddDirectory,
  SessionCommand,
  SessionStageSpec,
  StopTask,
  RequestReplay,
  ReplayWindow,
  ReplayLineageEntry,
  CancelReplay,
  RewindPreview,
  SessionRewind,
  SkillsInventoryQuery,
  HooksQuery,
  SideQuestion,
  InboundMessage,
};
export type {
  ContentBlockText,
  ContentBlockImage,
  ContentBlockImageSourceBase64,
} from "@tugproto/inbound";
export { isInboundMessage } from "@tugproto/inbound";

/**
 * Legacy wire-shape attachment — used only on the journal-projection
 * path (`derive_legacy_journal_view` in tugcast and
 * `buildContentBlocksFromLegacyJournal` here). The live user_message
 * frame carries {@link ContentBlock}[] directly; this shape exists for
 * the never-drop synthetic emit path that bridges the gap between
 * submit and JSONL ack and reads from the tugcast journal's legacy
 * `text` + `attachments` columns.
 */
export interface Attachment {
  filename: string;
  content: string; // text or base64
  media_type: string; // MIME type
}

export interface QuestionDef {
  id: string;
  text: string;
  type: "single_choice" | "multi_choice" | "text";
  options?: Array<{ label: string; description?: string }>;
}

// Outbound message types (tugcode stdout → tugcast)
// ipc_version is required per D15 (#d15-ipc-version). Always set to 2.

export interface ProtocolAck {
  type: "protocol_ack";
  version: number;
  session_id: string;
  ipc_version: number;
}

export interface SessionInit {
  type: "session_init";
  session_id: string;
  ipc_version: number;
}

export interface AssistantText {
  type: "assistant_text";
  msg_id: string;
  /**
   * Position of this text block within its message (the `index` from
   * the wire's `content_block_start { index }` for the block this
   * delta belongs to). Within a single `message_start`, blocks are
   * numbered 0, 1, 2, ... in arrival order; index resets to 0 at the
   * next `message_start`. The reducer uses `(msg_id, block_index)` as
   * the mint key: a new `content_block_start` mints a Message,
   * subsequent deltas with the same pair append to it.
   *
   * Synthetic emissions (slash-command output, the consolidated
   * mid-turn snapshot, terminal emissions from top-level `assistant`
   * snapshots) carry `block_index: 0` paired with a preceding
   * synthetic `content_block_start { block_index: 0, kind: "text" }`
   * so the reducer's mint path is uniform across live, replay, and
   * synthetic.
   */
  block_index: number;
  seq: number;
  rev: number;
  text: string;
  is_partial: boolean;
  status: string;
  ipc_version: number;
}

export interface ToolUse {
  type: "tool_use";
  msg_id: string;
  seq: number;
  tool_name: string;
  tool_use_id: string;
  input: object;
  /**
   * Set when this call was made by a subagent — the parent `Agent`
   * `tool_use.id`. The live path stamps it onto the forwarded frame from
   * `parent_tool_use_id` on the stream event; the resume path stamps it on
   * children synthesized from a subagent transcript. The reducer links the
   * child under its parent Agent from this field.
   */
  parent_tool_use_id?: string;
  /**
   * Original JSONL entry time (epoch ms) of the call's `tool_use` block.
   * Set only on the resume/replay path so the reducer can reconstruct the
   * call's wall time (`tool_result.timestamp − tool_use.timestamp`) from
   * the persisted transcript. Live frames omit it — the reducer's own
   * clock anchors cover the live case.
   */
  timestamp?: number;
  ipc_version: number;
}

export interface ToolResult {
  type: "tool_result";
  tool_use_id: string;
  output: string;
  is_error: boolean;
  /**
   * Original JSONL entry time (epoch ms) of the `tool_result` block.
   * Replay-only, paired with {@link ToolUse.timestamp} to recover the
   * call's wall time on resume; live frames omit it.
   */
  timestamp?: number;
  ipc_version: number;
}

/**
 * Live progress for an in-flight tool call, derived from the streaming
 * `input_json_delta` fragments claude emits while assembling a tool's
 * argument JSON. Emitted only while the argument carries something worth
 * narrating (a `file_path` or growing `content`), so a long Write reads as
 * "Writing foo.ts — 37 lines and climbing" instead of a frozen strip.
 *
 * Display-only telemetry: the authoritative tool input still arrives on the
 * terminal `tool_use` frame. The deck's transcript reducer drops this type
 * (not in `KNOWN_CODE_OUTPUT_TYPES`); the pulse daemon is the consumer.
 */
export interface ToolInputProgress {
  type: "tool_input_progress";
  msg_id: string;
  seq: number;
  block_index: number;
  tool_use_id: string;
  tool_name: string;
  /** Cumulative bytes of partial argument JSON streamed so far. */
  bytes: number;
  /** Best-effort newlines seen inside the `content` field (0 if none yet). */
  content_lines: number;
  /** `file_path` argument once its value has finished streaming, else null. */
  file_path: string | null;
  ipc_version: number;
}

export interface ToolApprovalRequest {
  type: "tool_approval_request";
  request_id: string;
  tool_name: string;
  input: object;
  ipc_version: number;
}

export interface Question {
  type: "question";
  request_id: string;
  questions: QuestionDef[];
  ipc_version: number;
}

/**
 * Per-turn telemetry block — the persistable cost + multi-clock
 * timing snapshot the reducer commits onto `TurnEntry` at
 * `turn_complete`. Mirrors the tugdeck `TurnTelemetry` shape (see
 * `tugdeck/src/lib/code-session-store/telemetry.ts`). Used in two
 * places on the wire:
 *
 *  - inlined onto a replayed `TurnComplete` by the tugcast supervisor
 *    (the supervisor reads it from its sqlite SessionLedger and
 *    attaches it so the client reducer's merge function adopts the
 *    persisted values), and
 *  - carried on an inbound `RecordTurnTelemetry` from tugdeck so the
 *    supervisor can persist it for the next reload.
 *
 * Round-trip-stable: every field is a primitive scalar; nullable
 * fields are `number | null` per the data model.
 *
 * Field semantics live with the source of truth in tugdeck's
 * `TurnTelemetry` and `TurnEntry`. This type carries the wire shape
 * only; tugcode does not interpret any field.
 */
export interface TurnTelemetry {
  cost: TurnCost;
  wallClockMs: number;
  awaitingApprovalMs: number;
  transportDowntimeMs: number;
  activeMs: number;
  ttftMs: number | null;
  ttftcMs: number | null;
  reconnectCount: number;
  maxStreamGapMs: number;
  /**
   * `window(0)` — the session's resident context before any turn.
   * Session-level: every turn carries the same value (the reducer keeps
   * the first non-null). On the replay path tugcode derives it from the
   * first assistant entry's input-baseline usage; the reducer restores
   * `sessionInitTokens` from it (`event.telemetry?.sessionInitTokens`).
   * `null` when no usage anchors the session.
   */
  sessionInitTokens: number | null;
  /**
   * The turn's terminal classification. Carried on the persisted block
   * so a resumed turn recovers its original outcome; tugcode's replay
   * sets `"complete"` for a clean terminal `stop_reason` and
   * `"interrupted"` for an orphan/EOF synthesis. Optional — the reducer
   * falls back to its `event.result`-derived reason when absent.
   */
  turnEndReason?: TurnEndReason;
}

/**
 * Per-turn terminal classification — mirrors tugdeck's `TurnEndReason`.
 * tugcode's replay path only ever emits `"complete"` / `"interrupted"`;
 * `"error"` / `"transport_lost"` arise only on the live reducer path.
 */
export type TurnEndReason =
  | "complete"
  | "interrupted"
  | "error"
  | "transport_lost";

/**
 * Cost subfield of {@link TurnTelemetry}. Field names match
 * tugdeck's `TurnCost` interface (camelCase, not the snake_case
 * `cost_update.usage.*` wire shape — that conversion happens
 * client-side in `extractTurnCost`).
 */
export interface TurnCost {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  totalCostUsd: number;
}

export interface TurnComplete {
  type: "turn_complete";
  msg_id: string;
  seq: number;
  result: string;
  /** The turn's result was an API error rather than a response; absent otherwise. */
  is_api_error?: boolean;
  /**
   * Optional per-turn telemetry payload. Populated only on replay
   * (tugcast supervisor attaches it from the SessionLedger when
   * resuming a session). Live `turn_complete` frames from tugcode
   * never carry it — the client reducer derives telemetry from
   * in-memory clock anchors + cost snapshots on the live path. See
   * plan `#step-20-3-3` / `#step-20-3-4`.
   */
  telemetry?: TurnTelemetry;
  /**
   * Optional original wall-clock timestamp (epoch milliseconds) of
   * the terminal assistant JSONL entry that closes this turn. Set
   * only on the replay path so the reducer can stamp the committed
   * `TurnEntry.endedAt` with the original completion time instead of
   * `Date.now()` (the replay-emission time). Live `turn_complete`
   * frames omit it — the reducer falls back to `Date.now()` for live
   * turns.
   */
  timestamp?: number;
  ipc_version: number;
}

export interface TurnCancelled {
  type: "turn_cancelled";
  msg_id: string;
  seq: number;
  partial_result: string;
  /**
   * The cancel was tugcode recovering a wedged claude rather than the user
   * cancelling; absent otherwise. Both reach the same emit sites through one
   * `ActiveTurn.interrupted` flag, so without this the two are
   * indistinguishable on the wire — and a consumer that reads every cancel as
   * the user taking their card back would act on a session that is still
   * alive and still working. An older frame carries no field and reads as a
   * user cancel, which is what every frame before this was.
   */
  is_recovery?: boolean;
  ipc_version: number;
}

export interface ErrorEvent {
  type: "error";
  message: string;
  recoverable: boolean;
  ipc_version: number;
}

// ---------------------------------------------------------------------------
// New outbound IPC types (Step 2.1)
// ---------------------------------------------------------------------------

/**
 * Extended thinking text stream per D12 (#d12-extended-thinking).
 */
export interface ThinkingText {
  type: "thinking_text";
  msg_id: string;
  /** See {@link AssistantText.block_index} — same semantics. */
  block_index: number;
  seq: number;
  text: string;
  is_partial: boolean;
  status: string;
  ipc_version: number;
}

/**
 * Opens a content block within an assistant message. Emitted by tugcode's
 * `mapStreamEvent` at every wire `content_block_start`, and by `replay.ts`
 * + `emitInflightTurnFromActiveTurn` at every reconstructed block.
 *
 * The reducer mints a `Message` of the corresponding kind on receipt
 * and indexes by `(msg_id, block_index)` for subsequent delta lookup.
 *
 * Discriminated by `kind`: `tool_use_id` and `tool_name` are required
 * when `kind === "tool_use"` and forbidden otherwise — the union below
 * encodes this in the type system so nonsensical constructions are
 * compile errors.
 *
 * Idempotent on the reducer side: a `content_block_start` for an
 * already-minted `(msg_id, block_index)` is a no-op. This is what
 * makes the mid-turn replay snapshot pattern ([D07] § Mid-turn replay)
 * safe: the live path may have already minted before the disconnect;
 * the snapshot's re-emission must not duplicate-mint.
 */
export type ContentBlockStart =
  | ContentBlockStartText
  | ContentBlockStartThinking
  | ContentBlockStartToolUse;

export interface ContentBlockStartText {
  type: "content_block_start";
  msg_id: string;
  block_index: number;
  kind: "text";
  /** @see {@link ContentBlockStartToolUse.timestamp} */
  timestamp?: number;
  ipc_version: number;
}

export interface ContentBlockStartThinking {
  type: "content_block_start";
  msg_id: string;
  block_index: number;
  kind: "thinking";
  /** @see {@link ContentBlockStartToolUse.timestamp} */
  timestamp?: number;
  ipc_version: number;
}

export interface ContentBlockStartToolUse {
  type: "content_block_start";
  msg_id: string;
  block_index: number;
  kind: "tool_use";
  tool_use_id: string;
  tool_name: string;
  /**
   * Original JSONL entry time (epoch ms) of the entry this block came from.
   * Set only on the resume/replay path; live frames omit it, where the
   * reducer's own clock is already the honest answer.
   *
   * This event is what mints the reducer's Message, and the Message's
   * `createdAt` is what the committed transcript sorts on. Without this
   * field a replayed turn wears the relaunch wall-clock, which sorts it
   * after durable ink that genuinely followed it.
   */
  timestamp?: number;
  ipc_version: number;
}

/**
 * Forwarded control_request from claude stdout to tugcast frontend.
 */
export interface ControlRequestForward {
  type: "control_request_forward";
  request_id: string;
  tool_name: string;
  input: Record<string, unknown>;
  decision_reason?: string;
  permission_suggestions?: unknown[];
  blocked_path?: string;
  tool_use_id?: string;
  is_question: boolean;
  ipc_version: number;
}

/**
 * A rewind-fork announcement, emitted just before the fork's synthetic
 * `session_init` ([P11]).
 *
 * The fork is a new session that descends from an existing one, and tugcast
 * owns the lineage grammar — it allocates `<root>-<Letter><Number>` against
 * the parent's lineage and stages the composed callsign so the `session_init`
 * that follows records the fork under it. Nothing round-trips: tugcode
 * announces the fork's parentage and the rewind point it was taken at, and
 * tugcast does the naming.
 */
export interface SessionFork {
  type: "session_fork";
  /** The session being forked FROM — claude's own id for it. */
  parentSessionId: string;
  /** The fork's freshly minted claude session id. */
  newSessionId: string;
  /** The rewound-to prompt uuid — the branch point, stable across forks. */
  forkPoint: string;
}

/**
 * A stage rotation announcement, emitted just before the stage's synthetic
 * `session_init`.
 *
 * A stage is a fresh session the server started on the same card, and it is
 * announced as *lineage* rather than as a stranger: tugcast stages the same
 * identity transfer it stages for a rewind-fork, so the whole arc wears one
 * callsign and durable ink written in any stage resolves to the same head.
 * The one difference is the fork point — a stage has none, because nothing
 * was copied.
 */
export interface SessionStage {
  type: "session_stage";
  /** The session being rotated away from — claude's own id for it. */
  parentSessionId: string;
  /** The stage's freshly minted claude session id. */
  newSessionId: string;
  /**
   * The stage label. `devise` / `review` / `implement` are the arc's three;
   * any other word is a rotation no score is driving.
   */
  stage: string;
  /** The model selector the rotation set, or empty for the account default. */
  model: string;
  /**
   * The document the score opened on, repo-relative. Absent on a scoreless
   * rotation. The bridge's parser requires only `parentSessionId`,
   * `newSessionId`, and `stage`; every other field is optional there.
   */
  document?: string;
  /** The dash name the score is keyed by. Absent on a scoreless rotation. */
  arc?: string;
  /**
   * The stage's opening prompt, echoed from the command so the deck opens the
   * turn it is about to watch. Absent on a stage the runner sent no prompt for.
   */
  prompt?: string;
  /**
   * The inclusive step range a *continued* implement stage walks, `N-M`.
   * Absent on every other stage, which is what tells the transcript's divider
   * a continued stage from a first one ([P07], [B13]).
   */
  steps?: string;
  ipc_version: number;
}

/**
 * A stage boundary *replayed* — the divider half of {@link SessionStage},
 * with none of the identity half.
 *
 * A live rotation is two facts at once: a new session started (which tugcast
 * stages as an identity transfer, and records as an `arc-stage` line), and a
 * boundary happened (which the transcript draws). On restore only the second
 * is true — the sessions started long ago and are already recorded — so
 * replay emits its own frame rather than re-emitting `session_stage`. Re-using
 * that type would make the relay re-stage a transfer and append a duplicate
 * `arc-stage` line for a rotation that already happened.
 *
 * The deck folds this into the same transcript divider a `session_stage`
 * produces.
 */
export interface ReplayStage {
  type: "replay_stage";
  /** Which stage of the arc the following turns belong to. */
  stage: string;
  /** The model selector the rotation set, or empty for the account default. */
  model: string;
  /** The document the arc opened on, repo-relative. */
  document: string;
  /** The dash name the arc is keyed by. */
  arc: string;
  ipc_version: number;
}

/**
 * The auto-generated session title claude writes as an `ai-title` record.
 *
 * The record lands in the session JSONL, so the external scan has always been
 * able to read it — but only on the next scan, which meant a title could be
 * hours stale. This frame forwards it the moment it arrives. tugcast writes it
 * to `sessions.name` only when `name_user_set = 0`: a `/rename` is the user's
 * word and an auto title never overwrites it.
 */
export interface SessionTitle {
  type: "session_title";
  title: string;
}

/**
 * System init metadata forwarded to tugcast for UI population.
 *
 * `version` is optional and is included only when the source actually
 * knows the running Claude Code version. The live init path
 * (`session.ts` `case "system"` / `subtype === "init"`) reads
 * `event.claude_code_version` from claude's own init event and
 * includes it when present. The replay path
 * (`replay.ts` synthesized `system_metadata` from JSONL) NEVER
 * includes it — the JSONL doesn't carry the Claude Code version.
 * Treating absence as "no signal" (instead of `""` as "empty
 * signal") lets the downstream `session_metadata_merge` preserve
 * whatever real version the ledger already has, and lets the
 * frontend's `??` fallback chain fire correctly when the live init
 * hasn't landed yet.
 */
export interface SystemMetadata {
  type: "system_metadata";
  cwd: string;
  ipc_version: number;
  // Content fields are optional: a frame may carry only what its emitter
  // knows. The full frame (forwarded from claude's `system/init`) supplies
  // all of them; the spawn-time `cwd`-only frame ([#step-12a]) omits the
  // rest, and tugcast's field-aware merge (`session_metadata_merge.rs` —
  // non-empty incoming wins, else keep current) fills them from claude's
  // real frame once it lands. Emitting empty strings here instead would
  // clobber the model / permission-mode chips, so the fields are absent.
  session_id?: string;
  tools?: unknown[];
  model?: string;
  permissionMode?: string;
  slash_commands?: unknown[];
  plugins?: unknown[];
  agents?: unknown[];
  skills?: unknown[];
  mcp_servers?: unknown[];
  version?: string;
  output_style?: string;
  fast_mode_state?: string;
  apiKeySource?: string;
}

/**
 * One model offered by the `initialize` control-response `models` list.
 * The picker ([#step-2b]) reads `value` (the `--model` selector) and
 * `displayName` (the user-facing label); `description` is the optional
 * subtitle. `models[0]` is the account default by convention
 * (`value: "default"`, `displayName: "Default (recommended)"`), so the
 * model chip falls back to its `displayName` for a new no-`--model`
 * session.
 *
 * `supportsEffort` + `supportedEffortLevels` are the reasoning-effort
 * capability for this model, surfaced for the Z4B effort chip ([#step-4]):
 * `supportsEffort` is absent on the wire when the model does not support
 * effort (e.g. haiku), and `supportedEffortLevels` VARIES by model (opus
 * supports `low|medium|high|xhigh|max`, sonnet drops `xhigh`). The remaining
 * wire fields (`supportsAdaptiveThinking`, … ) are still dropped per the
 * strict-shape policy; re-add when a consumer needs them.
 */
export interface CapabilityModel {
  value: string;
  displayName: string;
  description?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
}

/**
 * One slash command from the `initialize` control-response `commands`
 * list — the turn-free catalog the slash popup + allowlist consume.
 */
export interface CapabilityCommand {
  name: string;
  description?: string;
  argumentHint?: string;
}

/**
 * Turn-free session capabilities, parsed from claude's `initialize`
 * control-response and emitted once per spawn. Distinct from
 * `system_metadata` (which only lands after the first user turn and
 * carries the *live current* model / version / mode): `initialize`
 * answers immediately at spawn but carries only *capabilities* — the
 * available model list, the command catalog, agents, output styles, and
 * account info — NOT the exact current model id / version / mode. The
 * frontend uses `models` for the picker and the default-model label.
 */
export interface SessionCapabilities {
  type: "session_capabilities";
  models: CapabilityModel[];
  commands: CapabilityCommand[];
  agents: string[];
  available_output_styles: string[];
  output_style: string;
  account: Record<string, unknown> | null;
  /**
   * The session's current reasoning-effort level ([#step-4]), or `null` when
   * no `--effort` override is in force (the model runs at its built-in
   * default, which claude does NOT expose on the wire). tugcode owns the
   * `--effort` spawn flag, so it — not claude's `initialize` response, which
   * carries no current-effort field — is the authority for this value.
   */
  effort: string | null;
  /**
   * The Claude Code CLI version (e.g. `"2.1.195"`), or `null` when it could
   * not be resolved. claude's `initialize` response does NOT carry a version
   * (only the post-turn `system/init` does), so tugcode sources it locally by
   * running `claude --version` at spawn and folds it into the handshake — the
   * same locally-augmented-handshake pattern as the bundled plugin commands.
   * This makes the frontend's Claude Code badge correct from the drop instead
   * of showing "?" until the first turn.
   */
  version: string | null;
  ipc_version: number;
}

/**
 * Cost and usage summary emitted after each turn completes per PN-19.
 *
 * `usage` carries the turn's LAST tool-loop iteration's `usage` — the
 * most recent `message_delta` of the turn (or last `message_start`
 * when the turn produced no `message_delta`; `{}` for a fully
 * degenerate turn). It is NOT `result.usage`: `result.usage` is the
 * SUM of `usage` across every API call of the turn, so a turn making
 * K tool calls re-reads the (cached) context K times and over-counts
 * by ~K×. The last iteration's `input + cache_read + cache_creation +
 * output` IS the resident context window after the turn — the figure
 * the client's per-turn / context surfaces need.
 *
 * `total_cost_usd` and `num_turns` are unchanged — those genuinely
 * accumulate across the session and are read straight off the `result`
 * event.
 */
export interface CostUpdate {
  type: "cost_update";
  total_cost_usd: number;
  num_turns: number;
  duration_ms: number;
  duration_api_ms: number;
  usage: Record<string, unknown>;
  modelUsage: Record<string, unknown>;
  /**
   * Tool calls the turn denied — by a permission rule OR the auto-mode
   * classifier — lifted verbatim from the `result` event's
   * `permission_denials` (`{ tool_name, tool_use_id, tool_input }` each).
   * Empty/omitted for a turn with no denials. The session card accumulates these
   * per session for its `/permissions` Recently-denied tab. Captured shape:
   * `dash/transport-exploration.md`.
   */
  permission_denials?: unknown[];
  ipc_version: number;
}

/**
 * Live intra-turn token usage, emitted from the streaming
 * `message_start` / `message_delta` events of the in-flight turn —
 * one frame per event, so the client's `Tokens` / `Context` status
 * cells can climb mid-turn instead of sitting frozen until the
 * terminal `cost_update`.
 *
 * `usage` is the same four-token shape `cost_update` carries
 * (`input_tokens` / `output_tokens` / `cache_creation_input_tokens` /
 * `cache_read_input_tokens`); both `message_start` and `message_delta`
 * carry the complete four fields (verified against live wire data).
 * `msg_id` is claude's `message.id`.
 *
 * `observedInput` (`input + cache_read + cache_creation`) grows
 * monotonically across a turn's API calls — each call re-reads the
 * prior call's context plus its own output and tool result. So the
 * MOST RECENT frame is always the current window; the client keeps
 * the latest frame and does not accumulate across `msg_id`s. The
 * terminal `cost_update` carries this same last-iteration `usage` and
 * supersedes the live frame at turn-complete with no discontinuity.
 *
 * Display-only: drives no phase transition and is never persisted.
 */
export interface StreamingUsage {
  type: "streaming_usage";
  msg_id: string;
  usage: Record<string, unknown>;
  ipc_version: number;
}

/**
 * Stream-derived work sample for the ACTIVITY feed. tugcode is the single
 * authoritative interpreter of the claude stream (Q05); it accumulates
 * per-channel work in the live `ActiveTurn` and flushes one `activity_delta`
 * per 250 ms bin (Q06). tugcast's merger diverts these off CODE_OUTPUT onto
 * `FeedId::ACTIVITY`, splicing the `tug_session_id` (which tugcode does not
 * carry). No outbound allowlist gate applies.
 *
 * `channels` carries only the rate channels tugcode derives — `text`
 * (streamed prose + forming tool input), `tokens` (output-token velocity),
 * `tools` (foreground tool cadence), `subagents` (background agent cadence).
 * Only channels with a non-zero accumulation for the bin are present; a bin
 * with no activity is not emitted. The OS gauge channels (cpu/memory/disk)
 * ride the same feed but are produced cast-side, not here.
 */
export type ActivityChannel = "text" | "tokens" | "tools" | "subagents";

export interface ActivityDelta {
  type: "activity_delta";
  channels: Partial<Record<ActivityChannel, number>>;
  ipc_version: number;
}

/**
 * Compact context boundary marker. Emitted when claude's live stream
 * reports a `system`/`compact_boundary` — both auto-compaction at capacity
 * and a typed `/compact`, which dispatches over the stream-json bridge as a
 * plain user message and compacts in place under the same session id.
 * `trigger` / `pre_tokens` carry claude's `compactMetadata` when present so
 * the session-card divider can show the pre-compaction context size.
 */
export interface CompactBoundary {
  type: "compact_boundary";
  /** `"auto"` (capacity) | `"manual"` (/compact); absent if claude omits it. */
  trigger?: string;
  /**
   * Original JSONL entry time (epoch ms) of the boundary record. Set only on
   * the resume/replay path; live frames omit it, where the reducer's own
   * clock is honest. The divider note this event mints can open a turn's
   * Message list, making its `createdAt` the turn's sort key — a fabricated
   * value there walls every later replayed turn behind it (the incident-seven
   * shape).
   */
  timestamp?: number;
  /** Context token count just before compaction, when claude reports it. */
  pre_tokens?: number;
  /**
   * Claude's post-compaction CONVERSATION token count (summary + preserved
   * tail), when reported. This is BELOW the session base — not the resident
   * window — so tugdeck never renders it raw; it is an addend in the honest
   * total `sessionInitTokens + post_tokens` that drops the CONTEXT readout in
   * place without lagging until the next turn ([P01]).
   */
  post_tokens?: number;
  ipc_version: number;
}

/**
 * The compaction summary text. Emitted right after `compact_boundary` on both
 * paths: live from the ordering-armed capture of the post-boundary synthetic
 * user event, and on replay from the JSONL's `isCompactSummary` user record.
 * The frontend feeds it into the carry-forward block. At most one per
 * compaction, always ordered after that compaction's boundary frame.
 */
export interface CompactSummary {
  type: "compact_summary";
  /** Verbatim summary string (claude's own framing text included; no Tug markers). */
  summary: string;
  ipc_version: number;
}

/**
 * Forward-compat catch-all. Emitted by `routeTopLevelEvent`'s default
 * branch when claude streams a top-level event type this tugcode build
 * doesn't translate, instead of silently dropping it. The frame carries
 * the raw `original_type` and a short hex preview of the payload so the
 * frontend can surface a soft warn banner without tugcode having to model
 * the unknown shape. The default-branch console log stays alongside for
 * operator visibility.
 */
export interface UnknownEvent {
  type: "unknown_event";
  /** The raw `type` claude sent that no case handled (`"unknown"` if absent). */
  original_type: string;
  /** First 64 bytes of the JSON-serialized payload, hex-encoded. */
  payload_hex_preview: string;
  ipc_version: number;
}

/**
 * Category identities the `context_breakdown` wire frame carries —
 * the *static* half of the `/context`-style breakdown.
 *
 * `messages` is intentionally absent: it is not a static, locally-
 * tokenizable category. tugdeck derives it feed-exact (`window -
 * sessionInit`) and appends it when assembling the popover breakdown.
 *
 * `autocompact_buffer` is conditional: present only when the user has
 * Claude Code's autocompact feature enabled.
 *
 * MCP is intentionally absent — Tug treats MCP as out of scope, so
 * no `mcp_tools` id ever appears.
 */
export type ContextBreakdownCategoryId =
  | "system_prompt"
  | "system_tools"
  | "custom_agents"
  | "memory_files"
  | "skills"
  | "autocompact_buffer";

/**
 * One category slice of the {@link ContextBreakdown} wire frame.
 */
export interface ContextBreakdownCategory {
  /** Identity for stable React keys + per-tone color mapping. */
  id: ContextBreakdownCategoryId;
  /** Display label (e.g. "System prompt"). */
  label: string;
  /** Per-category token count. Already calibrated when applicable. */
  tokens: number;
}

/**
 * The *static* half of a `/context`-style context breakdown — the
 * five session-stable categories (system prompt, tool schemas, custom
 * agents, memory files, skills) plus the conditional
 * `autocompact_buffer`. Emitted by tugcode at `session_init` (so the
 * Context surface populates the moment the session opens) and
 * re-emitted after every `cost_update` to refresh `context_max`;
 * consumed by tugdeck's reducer + popover. Persisted by the tugcast
 * supervisor to `context_breakdown_latest` (one row per session,
 * UPSERT) so the popover renders pre-populated on a fresh bind.
 *
 * This frame carries NO `messages` category and NO total — both are
 * feed-exact and assembled tugdeck-side: tugdeck scales these static
 * categories so they sum to the feed-exact `sessionInit`, then
 * appends `messages = window(latest) - sessionInit`.
 */
export interface ContextBreakdown {
  type: "context_breakdown";
  tug_session_id: string;
  /** Model's context-window cap (e.g. 200_000 for current sonnet/opus). */
  context_max: number;
  categories: ReadonlyArray<ContextBreakdownCategory>;
  /**
   * Set to `true` when the supervisor synthesizes this frame from the
   * persisted `context_breakdown_latest` row at bind time. The
   * tugdeck reducer uses the flag to suppress the redundant
   * `record_context_breakdown` round-trip — the row already exists,
   * re-persisting it would be a no-op write of the same bytes.
   *
   * Absent on live frames emitted by tugcode (the reducer dispatches
   * the persist effect for those as normal). The renderer ignores
   * the flag.
   */
  from_supervisor_attach?: boolean;
  ipc_version: number;
}

/**
 * One skill in the `/skills` inventory ([#step-12d]) — the read-only listing
 * of the **plugin + user** skills (the on-disk, user-manageable set, matching
 * Claude Code's own `/skills`; built-in skills live inside the claude package
 * and are intentionally excluded — they surface in `/context` instead).
 *
 * Every field is sourced by tugcode from the skill's `SKILL.md` (the same
 * files the context breakdown tokenizes): the display name, the frontmatter
 * description, the originating plugin (or user scope), the frontmatter token
 * estimate (what loads into the system prompt), and whether the skill is
 * plugin-managed (author-locked, edited via `/plugin`).
 */
export interface SkillInventoryEntry {
  /** Display name — `<plugin>:<name>` for plugin skills, bare for user skills. */
  name: string;
  /** One-line `description:` from the SKILL.md frontmatter; `""` when absent. */
  description: string;
  /** Originating plugin name, or `"user"` for `~/.claude/skills`. */
  source: string;
  /** Plugin skills are author-locked ("managed via /plugin"); user skills are not. */
  locked: boolean;
  /** Frontmatter token estimate — the per-skill cost loaded into the prompt. */
  tokens: number;
}

/**
 * tugcode → client answer to a {@link SkillsInventoryQuery} ([#step-12d]) —
 * the assembled plugin + user skill listing for the `/skills` sheet. Rides
 * tugcode's stdout, relayed verbatim by tugcast on `CODE_OUTPUT` (no Rust
 * routing, no ledger persistence). `request_id` correlates the answer to the
 * in-flight request so a stale reply is ignored.
 */
export interface SkillsInventory {
  type: "skills_inventory";
  tug_session_id: string;
  request_id: string;
  skills: ReadonlyArray<SkillInventoryEntry>;
  ipc_version: number;
}

/** One hook command under a matcher group — a `settings.json` `hooks` entry. */
export interface HookCommand {
  /** Hook kind, e.g. `"command"`. */
  type: string;
  /** The shell command to run (for `type: "command"`). */
  command?: string;
  /** Optional per-hook timeout in seconds. */
  timeout?: number;
}

/** A matcher group under a hook event — a tool-name matcher + its commands. */
export interface HookMatcherGroup {
  /** Tool-name matcher pattern (e.g. `"Bash"`, `"Edit|Write"`); absent = all. */
  matcher?: string;
  /** The hook commands that fire for this matcher. */
  hooks: HookCommand[];
}

/**
 * tugcode → client answer to a {@link HooksQuery} ([#step-12c]) — the hook
 * configuration merged across the user / project / local `settings.json`
 * files, keyed by event name (e.g. `"PreToolUse"`). Read-only: the `/hooks`
 * sheet displays it; edits happen in `settings.json`. Rides tugcode's stdout,
 * relayed verbatim by tugcast on `CODE_OUTPUT`.
 */
export interface HooksInventory {
  type: "hooks_inventory";
  tug_session_id: string;
  request_id: string;
  /** Event name → its matcher groups (concatenated across settings scopes). */
  events: Record<string, HookMatcherGroup[]>;
  ipc_version: number;
}

/**
 * tugcode → client answer to a {@link SideQuestion} `/btw` — the settled
 * one-shot reply Claude returned to a `side_question` control-request,
 * correlated back by `request_id`. Ephemeral and overlay-only: it is
 * deliberately **NOT** in `KNOWN_CODE_OUTPUT_TYPES`, so the code-session store
 * drops it and it never becomes a transcript row (upholds the side question's
 * "never enters history" contract and keeps replay/reload clean). Read instead
 * by tugdeck's dedicated per-session `SideQuestionStore` feed. `answer` is
 * `null` when Claude returned no response; `synthetic` flags a CLI-synthesized
 * answer (default `false`).
 */
export interface SideQuestionAnswer {
  type: "side_question_answer";
  tug_session_id: string;
  request_id: string;
  answer: string | null;
  synthetic: boolean;
  ipc_version: number;
}

/**
 * API retry notification. Claude Code retries up to 10 times with exponential backoff.
 */
export interface ApiRetry {
  type: "api_retry";
  attempt: number;
  max_retries: number;
  retry_delay_ms: number;
  error_status: number | null;
  error: string;
  ipc_version: number;
}

/**
 * Model-refusal fallback. Claude Code's SDK retried a turn on a *different*
 * model after the originally-selected one declined (a non-fatal recovery —
 * `trigger: "refusal"`, `direction: "retry"`, e.g. `claude-fable-5` →
 * `claude-opus-4-8`). Display-only: the session card surfaces it as a one-shot
 * notice so the silent model swap is visible.
 */
export interface ModelRefusalFallback {
  type: "model_refusal_fallback";
  original_model: string;
  fallback_model: string;
  trigger: string;
  direction: string;
  ipc_version: number;
}

/**
 * Output truncation. An assistant message closed with `stop_reason:
 * "max_tokens"` — the response hit the output-token ceiling and was cut off,
 * not a clean `end_turn`. Display-only: the session card surfaces it as a one-shot
 * notice so a truncated turn doesn't read as a silent stop.
 */
export interface OutputTruncated {
  type: "output_truncated";
  ipc_version: number;
}

/**
 * `/goal` evaluator feedback. While a goal is active, claude's Stop-hook
 * evaluator injects a synthetic `user` event (`isSynthetic: true`, text
 * `Stop hook feedback:\n[<condition>]: <reason>`) into the SAME result
 * cycle to keep the assistant working — a goal run is one long turn, not
 * a wake bracket (probe: `tugcode/probes/goal-loop/FINDINGS.md#q01-goal`).
 * tugcode translates each such event into this frame so the deck can track
 * goal state (active, latest evaluator reason) without parsing prose. The
 * synthetic event itself emits no user-visible content and is excluded
 * from the rewind prompt-anchor latch.
 */
export interface GoalFeedback {
  type: "goal_feedback";
  /** The goal condition, verbatim from the bracketed feedback text. */
  condition: string;
  /** The evaluator's reason the condition is not yet met. */
  reason: string;
  ipc_version: number;
}

/**
 * Subscription-quota status broadcast emitted by Claude Code 2.1.x at the
 * start of every turn (post-`system/init`, pre-stream). Distinct from
 * {@link ApiRetry}, which fires on backoff-retryable HTTP failures.
 *
 * Mirrors the claude top-level event shape verbatim:
 * `{ type, rate_limit_info: { status, resetsAt, rateLimitType,
 *    overageStatus, overageDisabledReason, isUsingOverage }, uuid,
 *    session_id }`. The frontend reads this to surface "X hours until
 * quota reset" in the chrome and to flip into a "rate-limited" mode when
 * `status !== "allowed"`.
 */
export interface RateLimitInfo {
  /** `"allowed"`, `"warning"`, `"exceeded"`, etc. */
  status: string;
  /** Unix epoch seconds at which the current window resets. */
  resetsAt: number;
  /** `"five_hour"`, `"daily"`, etc. */
  rateLimitType: string;
  /** `"accepted"` or `"rejected"`. */
  overageStatus: string;
  /** Reason overage is disabled (`"org_level_disabled"`, etc.). May be absent. */
  overageDisabledReason?: string;
  /** Whether the current turn is consuming overage allotment. */
  isUsingOverage: boolean;
  /** Window utilization as a 0–1 fraction (CLI ≥ 2.1.17x; absent on
   *  older payloads). */
  utilization?: number;
}

export interface RateLimitEvent {
  type: "rate_limit_event";
  rate_limit_info: RateLimitInfo;
  ipc_version: number;
}

/**
 * Structured tool result for rich UI display per D11/PN-4.
 */
export interface ToolUseStructured {
  type: "tool_use_structured";
  tool_use_id: string;
  tool_name: string;
  structured_result: Record<string, unknown>;
  ipc_version: number;
}

/**
 * Cancellation notice for a pending permission or question dialog.
 */
export interface ControlRequestCancel {
  type: "control_request_cancel";
  request_id: string;
  ipc_version: number;
}

/**
 * Emitted by `SessionManager.initialize()` when a `--session-mode resume`
 * spawn attempt fails (claude exits before `system:init`, JSONL missing,
 * stale id, etc.). Tugcast forwards the frame to the card as a CODE_OUTPUT
 * event and tugdeck surfaces it through `CodeSessionStore.lastError`,
 * which the card observer reads to unbind and re-present the picker
 * with the reason. tugcode then exits cleanly — the silent fresh-spawn
 * fallback was removed because it caused the bound `claudeSessionId`
 * to drift away from the id the user picked.
 */
export interface ResumeFailed {
  type: "resume_failed";
  /** Machine-readable category describing why resume failed. */
  reason: string;
  /** The id tugcode attempted to resume. */
  stale_session_id: string;
  ipc_version: number;
}

// ---------------------------------------------------------------------------
// Replay event types — JSONL → CODE_OUTPUT translator output
// ---------------------------------------------------------------------------

/**
 * Replay user-message frame. Emitted by the JSONL replay translator
 * at the start of each replayed turn (and by tugcode's mid-turn
 * `emitInflightTurnFromActiveTurn` snapshot path), carrying the
 * original user submission text + attachments.
 *
 * Named after the substrate operation it performs — adds a
 * `user_message` Message to the substrate — symmetric with
 * `content_block_start { kind: "text" | "thinking" | "tool_use" }`'s
 * message-kind-keyed naming. The `add_<kind>` template established
 * here applies to all future Message-creating IPC frames (Step 8's
 * `add_system_note` for scheduled prompts, anything beyond).
 *
 * Distinct from the inbound `user_message` (`tugcast → tugcode`
 * submission shape) because:
 *   - It rides CODE_OUTPUT (`tugcode → tugcast`), not CODE_INPUT.
 *   - It is a *substrate add*, not a *submission*. The outbound
 *     submission keeps its operation-centric name (`UserMessage`)
 *     because it is heading to claude, semantically distinct from
 *     "add a Message to the substrate."
 *   - The reducer's `handleAddUserMessage` mints a `pendingTurn`
 *     whose `initialMessages` is `[user_message]`; the substrate's
 *     correlation key is `turnKey`, not `msg_id`.
 *
 * No `msg_id` field. Under [D14] the reducer's `activeMsgId` is set
 * only by the first content event (`assistant_text` / `thinking_text`
 * / `tool_use` / `content_block_start`) — it is never pre-bound from
 * a user-side opener. The replay translator's `openTurnMsgId` tracker
 * holds whatever synthesized opener id it minted ([D13]); that id is
 * translator-internal and never reaches the wire on this frame.
 *
 * See `dash/tugplan-session-wake.md` [D14] (activeMsgId
 * tracking), [D15] (add_<kind> naming), and `#spec-wire-frames` for
 * the canonical wire-shape definition.
 */
export interface AddUserMessage {
  type: "add_user_message";
  /**
   * Anthropic-API content-block array.
   *
   * On the JSONL-replay path (`replay.ts`), this is the recorded
   * message's `content` array passed through verbatim — JSONL is
   * Anthropic's storage format, so the interleaving of text + image
   * blocks survives round-trip.
   *
   * On the never-drop synthetic path (`session.ts`'s
   * `injectPendingRowSynthetics`), this is built via
   * `buildContentBlocksFromLegacyJournal` from the tugcast journal's
   * legacy `text` + `attachments` columns — a flat all-images-first
   * shape. Interleaving is lost here; the never-drop path is the
   * gap-bridge, not the primary restore path.
   */
  content: ContentBlock[];
  /**
   * Optional original wall-clock timestamp (epoch milliseconds) of
   * the user JSONL entry that produced this opener. Set only on the
   * replay path so the reducer can stamp the synthesized `UserMessage`
   * with the original submission time instead of `Date.now()` (the
   * replay-emission time). Live `add_user_message` frames omit it —
   * the reducer falls back to `Date.now()` for live submissions.
   */
  timestamp?: number;
  /**
   * Optional claude user-prompt-record `uuid` — the `/rewind` anchor
   * ([#step-7]). Additive: this is the value `rewind_files.user_message_id`
   * takes and the JSONL truncation boundary, NOT the assistant `msg_id`.
   *
   * Set on the paths where the frame mints the turn from a record that
   * carries the uuid:
   *   - replay (`replay.ts`) — the JSONL `user` entry's `uuid`;
   *   - mid-turn snapshot (`emitInflightTurnFromActiveTurn`) — the
   *     `uuid` captured from the live user-echo onto `ActiveTurn`.
   * Absent on the never-drop synthetic path (the tugcast journal does
   * not store claude's prompt uuid) and on the steady-state LIVE path
   * (which emits no `add_user_message` — the live anchor rides
   * {@link PromptAnchor} instead). The session-card stores it on the
   * opening user `Message` and sends it back on a {@link RewindPreview}
   * / {@link SessionRewind}.
   */
  promptUuid?: string;
  ipc_version: number;
}

/**
 * Bracket marker emitted by the replay translator at the start of a
 * JSONL replay window. The reducer transitions
 * `phase: idle → replaying` on this event and gates `canSubmit` /
 * `canInterrupt` to `false` for the duration.
 */
/**
 * Bracket marker emitted by tugcode when it observes a
 * `system/task_notification` event on the claude stream-json wire.
 * Signals that claude is about to resume from idle in response to a
 * deferred-completion tool's async event (Monitor timing out, a cron
 * job firing, a wakeup arriving, etc.) — without a preceding user
 * submission.
 *
 * The reducer transitions `phase: idle → waking` on this event and
 * accepts the subsequent assistant_text / thinking_text / tool_use
 * events that would otherwise be dropped by guards expecting an
 * active turn. The bracket closes implicitly on the next
 * `turn_complete` (no separate `wake_complete` frame on the wire —
 * the reducer's commit path extends to map `waking → idle`).
 *
 * `wake_trigger` is a verbatim forward of the SDK's
 * `SDKTaskNotificationMessage` payload (`sdk.d.ts:1659-1668`),
 * minus the `type:"system" / subtype:"task_notification"` envelope.
 * `turnKey` is intentionally absent here — tugdeck's store wrapper
 * (`frameToEvent`) mints it on frame receipt, mirroring the
 * `add_user_message` pattern.
 *
 * See `dash/tugplan-session-wake.md` [D02] for the detector
 * rationale and [Q01] for the empirical capture this contract is
 * pinned against.
 */
export interface WakeStarted {
  type: "wake_started";
  session_id: string;
  wake_trigger: {
    task_id: string;
    tool_use_id: string;
    status: "completed" | "failed" | "stopped";
    summary: string;
    output_file: string;
  };
  ipc_version: number;
}

/**
 * Neutral assistant-originated turn opener (`tuglaws/turn-metric.md` S02).
 * Opens an `origin: assistant` turn that holds orphan assistant content —
 * a `--continue` leading orphan, a `/compact` continuation, or any
 * assistant output that arrives with no open turn — with **no user
 * message**. It is the honest replacement for the deleted synthesized
 * empty `add_user_message{content:[]}`: there is no fabricated user slot,
 * so the turn renders assistant-only (`#a`) and never as a phantom user
 * row.
 *
 * A wake ({@link WakeStarted}) is the same assistant-originated turn
 * carrying an optional wake annotation; this opener is the wake-baggage-free
 * variant. Like the other openers it carries no `msg_id` on the wire — the
 * turn's correlation key is the store wrapper's minted `turnKey`.
 */
export interface AssistantOpener {
  type: "assistant_opener";
  /** Original JSONL entry time (replay), so the turn's timestamp is the
   * archived wall-clock rather than the replay-emission time. */
  timestamp?: number;
  ipc_version: number;
}

/**
 * Background-task lifecycle opener — a verbatim forward of claude's
 * `system/task_started` event minus the `type/subtype` envelope. Fired
 * when a background task starts (`Bash` / `Agent` with
 * `run_in_background: true`) — and ALSO for foreground subagents, whose
 * frames are shape-identical: the wire carries no backgrounded
 * discriminant. Consumers that only want background jobs must gate on
 * the launching tool call's `input.run_in_background` via
 * `tool_use_id`.
 *
 * `task_type` distinguishes the task's kind (`"local_bash"` /
 * `"local_agent"` observed), not its foreground/background mode.
 * Empirical contract: `tugrust/crates/tugcast/tests/fixtures/`
 * `stream-json-catalog/v2.1.173-jobs-spike/`.
 */
export interface TaskStarted {
  type: "task_started";
  session_id: string;
  task_id: string;
  tool_use_id: string;
  description: string;
  task_type: string;
  subagent_type?: string;
  ipc_version: number;
}

/**
 * Background-task status flip — claude's `system/task_updated` with the
 * `patch` object flattened onto the frame. Observed `status` values:
 * `"completed"` / `"failed"` / `"killed"` (a stop — via the `TaskStop`
 * tool or a `stop_task` control request — reads `"killed"` here and
 * `"stopped"` on the corresponding `task_notification`). `end_time` is
 * epoch ms when claude supplies it. Same empirical contract as
 * {@link TaskStarted}.
 */
export interface TaskUpdated {
  type: "task_updated";
  session_id: string;
  task_id: string;
  status: string;
  end_time?: number;
  ipc_version: number;
}

/**
 * Background-task progress tick — claude's `system/task_progress`, fired
 * for an in-flight background agent each time it makes observable
 * progress (a tool call completing). NEW in the 2.1.197-era wire: the
 * v2.1.173-jobs-spike noted `task_progress` existed but tugcode dropped
 * it, so a background agent rendered start→terminal with no visibility
 * into its work. This frame carries that intermediate detail — the
 * agent's most recent tool (`last_tool_name`) and cumulative `usage`
 * (token count, tool-use count, wall-clock). Like {@link TaskStarted}
 * it fires for foreground subagents too; consumers gate on the
 * launching tool call's `input.run_in_background` via `tool_use_id`.
 *
 * Empirical contract: the background-Agent probe in the recurring
 * stream-json catalog (promoted from `v2.1.173-jobs-spike`).
 */
export interface TaskProgress {
  type: "task_progress";
  session_id: string;
  task_id: string;
  tool_use_id: string;
  description: string;
  subagent_type?: string;
  last_tool_name?: string;
  usage?: {
    total_tokens?: number;
    tool_uses?: number;
    duration_ms?: number;
  };
  ipc_version: number;
}


export interface ReplayStarted {
  type: "replay_started";
  ipc_version: number;
}

/**
 * Bracket marker emitted by the replay translator at end-of-JSONL
 * (or on a hard-budget timeout). The reducer transitions
 * `phase: replaying → idle` and populates `lastReplayResult`.
 *
 * `count` is the number of `turn_complete` events emitted during
 * this replay window. `error` is set when replay terminated
 * abnormally; `kind` matches tugdeck's `LastReplayResult.kind` enum
 * exactly so the reducer can pass it through without translation.
 */
export interface ReplayComplete {
  type: "replay_complete";
  count: number;
  error?: {
    kind:
      | "jsonl_missing"
      | "jsonl_unreadable"
      | "jsonl_malformed"
      | "replay_timeout"
      | "replay_exception";
    message: string;
  };
  /**
   * Recency-window metadata. Present only when the replay request
   * carried a window; absent on a full / legacy replay. Together they
   * tell the reducer which slice of the session loaded and whether
   * older turns remain to be paged in:
   *
   *   - `firstLoadedTurnIndex` — the absolute turn index (0-based,
   *     counting from the oldest committed turn) of the first turn in
   *     this window; the boundary for the next backward-paging request,
   *     and the base the transcript adds to a row's window-relative turn
   *     index to address it by its true session turn.
   *   - `totalTurns` — the whole session's committed turn count,
   *     independent of how many this window emitted.
   *   - `hasOlder` — whether any turns precede the window
   *     (`firstLoadedTurnIndex > 0`); drives the "load previous"
   *     affordance.
   */
  firstLoadedTurnIndex?: number;
  totalTurns?: number;
  hasOlder?: boolean;
  /**
   * Wall-clock (epoch ms) of the session's first real turn-bearing entry
   * — when the conversation began. Session-level, so it rides EVERY
   * success `replay_complete` (windowed or full), independent of the
   * window fields above; a backward-paging bracket reports the same value
   * as the initial restore. Absent only when no entry carried a parseable
   * timestamp. The dev transcript's permanent Z0 strip renders it as
   * "Session created".
   */
  sessionCreatedAtMs?: number;
  /**
   * Set when the replay was cancelled in flight (a `cancel_replay`
   * arrived before the bracket finished). The client discards the
   * partial older batch this bracket staged and leaves the prior loaded
   * window intact. Window metadata is omitted on an aborted bracket —
   * nothing new was committed.
   */
  aborted?: boolean;
  ipc_version: number;
}

/**
 * Outbound result of a {@link RewindPreview} ([#step-7-1]). Relays the
 * `rewind_files{dry_run:true}` control-response back to the session-card so
 * the `/rewind` picker can render the turn's code diff-stat badge.
 *
 * `canRewind:false` is the "how far back you can restore" limit — the
 * checkpoint aged out or file checkpointing is off. `error` carries
 * claude's reason in that case ("No file checkpoint found …",
 * "File rewinding is not enabled."). On `canRewind:true`,
 * `filesChanged`/`insertions`/`deletions` populate the badge
 * (`+N −M`, or "No code changes" when the arrays are empty).
 *
 * `promptUuid` echoes the request's anchor so the session-card can match
 * the result to the picker row that asked for it (the bridge supports
 * concurrent single-anchor lazy queries — [#step-7-3]'s N+1 discipline).
 */
export interface RewindPreviewResult {
  type: "rewind_preview_result";
  promptUuid: string;
  canRewind: boolean;
  error?: string;
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
  /**
   * Whether the CONVERSATION dimension can rewind to this anchor ([#step-7-3]):
   * `false` when the chop range crosses a `/compact` boundary (or the anchor
   * is unknown / would leave no retained turns) — i.e. the same condition
   * `computeConversationTruncation` refuses at apply time. Distinct from
   * `canRewind` (the CODE checkpoint state). The picker disables a row whose
   * conversation rewind would error, so it never offers a dead turn. Absent
   * means "not determined" (the picker treats it as rewindable).
   */
  conversationRewindable?: boolean;
  ipc_version: number;
}

/**
 * Outbound acknowledgement of a {@link SessionRewind} ([#step-7-1]).
 * The code-restore half (`scope:"code"` or the code leg of `"both"`)
 * relays the `rewind_files{dry_run:false}` outcome: `canRewind:true`
 * means the working tree was reverted; `canRewind:false` + `error`
 * means it could not be (aged-out checkpoint, checkpointing disabled).
 *
 * The conversation half (`scope:"conversation"|"both"`, [#step-7-2]) is a
 * JSONL truncate + silent `--resume` respawn (no `rewind_files` control
 * request). When `fork` was requested, the respawn loads a truncated COPY
 * under a freshly-minted claude session id; `newSessionId` carries that id
 * so the session-card can rebind the card→session binding (and persist it, so a
 * cold-boot resumes the fork rather than the original). Absent for the
 * destructive in-place variant (same id) and for the pure-code dimension.
 * `scope` echoes the request so the session-card knows which dimensions were
 * applied.
 */
export interface RewindResult {
  type: "rewind_result";
  promptUuid: string;
  scope: "conversation" | "code" | "both";
  canRewind: boolean;
  error?: string;
  newSessionId?: string;
  ipc_version: number;
}

/**
 * Outbound `prompt_anchor` ([#step-7-1]) — the LIVE-path delivery of a
 * turn's `/rewind` anchor. Emitted once per live turn when tugcode
 * captures the user-prompt `uuid` from claude's user-echo event
 * (`--replay-user-messages`), during the active turn.
 *
 * Why a dedicated frame rather than {@link AddUserMessage.promptUuid}:
 * the steady-state live path emits NO `add_user_message` (the session-card
 * minted the turn locally at `handleSend`, keyed by `turnKey`). A live
 * `add_user_message` would duplicate-mint the turn. `prompt_anchor`
 * carries only the anchor; the reducer ([#step-7-3]) attaches it to the
 * in-flight turn (the unambiguous active pending turn) without minting.
 * Purely additive — existing consumers ignore it; `msgId`/`turnKey`/
 * reducer keying are untouched.
 *
 * Resume/cold-boot/reconnect recover the anchor from
 * {@link AddUserMessage.promptUuid} instead (those paths DO emit
 * `add_user_message`), so `prompt_anchor` is the live path's
 * counterpart, not a second copy of the same delivery.
 */
export interface PromptAnchor {
  type: "prompt_anchor";
  promptUuid: string;
  ipc_version: number;
}

/**
 * Transport-only envelope that carries a run of replay frames in a
 * single IPC line. The cold-replay consumer buffers committed-turn
 * frames and flushes them as one `replay_batch` instead of one wire
 * line per frame — collapsing the per-frame syscall / relay / WebSocket
 * cost that dominates load time. tugcast relays it unchanged (the
 * `tug_session_id` splice lands on this outer object); the browser
 * unwraps `frames` at the FeedStore ingest boundary and dispatches each
 * inner frame through the normal per-frame path. Brackets
 * (`replay_started` / `replay_complete`) are never batched — they stay
 * raw so the paint gate and fold flush keep their timing.
 */
export interface ReplayBatch {
  type: "replay_batch";
  frames: OutboundMessage[];
  ipc_version: number;
}

export type OutboundMessage =
  | ProtocolAck
  | SessionInit
  | AssistantText
  | ToolUse
  | ToolResult
  | ToolInputProgress
  | ToolApprovalRequest
  | Question
  | TurnComplete
  | TurnCancelled
  | ErrorEvent
  | ThinkingText
  | ContentBlockStart
  | ControlRequestForward
  | SystemMetadata
  | SessionFork
  | SessionStage
  | ReplayStage
  | SessionTitle
  | SessionCapabilities
  | CostUpdate
  | StreamingUsage
  | ActivityDelta
  | CompactBoundary
  | CompactSummary
  | ContextBreakdown
  | ApiRetry
  | ModelRefusalFallback
  | OutputTruncated
  | GoalFeedback
  | RateLimitEvent
  | ToolUseStructured
  | ControlRequestCancel
  | ResumeFailed
  | AddUserMessage
  | ReplayStarted
  | ReplayComplete
  | ReplayBatch
  | WakeStarted
  | AssistantOpener
  | TaskStarted
  | TaskUpdated
  | TaskProgress
  | RewindPreviewResult
  | RewindResult
  | SkillsInventory
  | HooksInventory
  | SideQuestionAnswer
  | PromptAnchor
  | UnknownEvent;

// Type guards. `isInboundMessage` is the shared, verb-list-derived guard
// (re-exported at the top of this file from `@tugproto/inbound`); the per-type
// guards below narrow a known `InboundMessage` to a specific verb.
export function isProtocolInit(msg: InboundMessage): msg is ProtocolInit {
  return msg.type === "protocol_init";
}

export function isUserMessage(msg: InboundMessage): msg is UserMessage {
  return msg.type === "user_message";
}

export function isToolApproval(msg: InboundMessage): msg is ToolApproval {
  return msg.type === "tool_approval";
}

export function isQuestionAnswer(msg: InboundMessage): msg is QuestionAnswer {
  return msg.type === "question_answer";
}

export function isInterrupt(msg: InboundMessage): msg is Interrupt {
  return msg.type === "interrupt";
}

export function isPermissionMode(msg: InboundMessage): msg is PermissionModeMessage {
  return msg.type === "permission_mode";
}

export function isModelChange(msg: InboundMessage): msg is ModelChange {
  return msg.type === "model_change";
}

export function isEffortChange(msg: InboundMessage): msg is EffortChange {
  return msg.type === "effort_change";
}

export function isAddDirectory(msg: InboundMessage): msg is AddDirectory {
  return msg.type === "add_directory";
}

export function isSessionCommand(msg: InboundMessage): msg is SessionCommand {
  return msg.type === "session_command";
}

export function isStopTask(msg: InboundMessage): msg is StopTask {
  return msg.type === "stop_task";
}

export function isRequestReplay(msg: InboundMessage): msg is RequestReplay {
  return msg.type === "request_replay";
}

export function isCancelReplay(msg: InboundMessage): msg is CancelReplay {
  return msg.type === "cancel_replay";
}

export function isRewindPreview(msg: InboundMessage): msg is RewindPreview {
  return msg.type === "rewind_preview";
}

export function isSessionRewind(msg: InboundMessage): msg is SessionRewind {
  return msg.type === "session_rewind";
}

export function isSkillsInventoryQuery(
  msg: InboundMessage,
): msg is SkillsInventoryQuery {
  return msg.type === "skills_inventory_query";
}

export function isHooksQuery(msg: InboundMessage): msg is HooksQuery {
  return msg.type === "hooks_query";
}
