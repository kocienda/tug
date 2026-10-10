// stream-json → IPC event mapping: the top-level event router, the stream-event
// mapper, and the `build*Message` helpers they share. Pure: each takes an event
// and a context and returns the frames to emit; the wire stays untyped
// (`Record<string, unknown>`) here.

import { errorFrame } from "./ipc.ts";
import type {
  OutboundMessage,
  ThinkingText,
  CompactBoundary,
  RateLimitEvent,
  ToolProgress,
  ControlRequestCancel,
  SystemMetadata,
  CostUpdate,
  StreamingUsage,
  WakeStarted,
  TaskStarted,
  TaskUpdated,
  TaskProgress,
  BackgroundTasksChanged,
} from "./types.ts";
import { IPC_VERSION } from "./types.ts";
import { extractTaskNotificationWake } from "./replay.ts";

/**
 * Context passed to mapStreamEvent and routeTopLevelEvent for IPC message construction.
 */
export interface EventMappingContext {
  msgId: string;
  /**
   * The owning turn's synthesized opener id ({@link ActiveTurn.openerId}).
   * The `msg_id` fallback for frames synthesized while claude has not
   * revealed a `message.id` (`msgId === ""`) — e.g. the local-command
   * stdout echo of a `/compact` or `/model` turn. Empty string when no
   * turn context applies.
   */
  openerId: string;
  seq: number;
  rev: number;
  /**
   * Whether a preceding `compact_boundary` this turn has armed the summary
   * capture ([P08]). The next synthetic `user` event carrying a plain-string
   * summary is captured as a `compact_summary` frame while this is true.
   * `routeTopLevelEvent` reads this and returns the updated state on
   * {@link TopLevelRoutingResult.pendingCompactSummary}; the caller latches it
   * back onto {@link ActiveTurn.pendingCompactSummary} across events.
   */
  pendingCompactSummary?: boolean;
}

/**
 * Result of mapping a single stream-json (inner) event to IPC outbound messages.
 *
 * `messageId` carries claude's `message.id` whenever the stream event reveals
 * it (today: `message_start` only; future event types may also expose it).
 * `dispatchEventToTurn` slides `ActiveTurn.currentMessageId` to this value so
 * subsequent events whose claude shape doesn't carry an id directly
 * (`content_block_delta`, `content_block_start`) emit under the right key.
 * Absent on events that don't reveal the id.
 *
 * `messageStartUsage` / `messageDeltaUsage` carry the raw token-bearing
 * `usage` object whenever a `message_start` / `message_delta` revealed
 * one. `dispatchEventToTurn` latches them onto `ActiveTurn` so the
 * terminal `result` event can emit `cost_update.usage` from the turn's
 * LAST tool-loop iteration — never `result.usage`, which is the
 * per-turn SUM across every iteration. Absent on every other event.
 */
export interface EventMappingResult {
  messages: OutboundMessage[];
  newRev: number;
  partialText: string;
  gotResult: boolean;
  messageId?: string;
  messageStartUsage?: Record<string, unknown>;
  messageDeltaUsage?: Record<string, unknown>;
}

/**
 * Result metadata from a result event, stored for CostUpdate emission.
 */
export interface ResultMetadata {
  subtype: string;
  is_error?: boolean;
  total_cost_usd?: number;
  num_turns?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  usage?: Record<string, unknown>;
  modelUsage?: Record<string, unknown>;
  permission_denials?: unknown[];
  is_api_error?: boolean;
  resultValue?: string;
}

/**
 * Result of routing a single top-level stdout message to IPC outbound messages.
 * Per D03 (#d03-event-routing) two-tier routing architecture.
 */
/**
 * Clamp a `system/task_notification` summary to a terse, single-line wake
 * label. The wake-trigger chip is a subdued marker naming what woke the
 * session ("Agent \"X\" completed") — it is NOT a surface for the agent's
 * answer, which renders in full under the Agent block. Claude Code
 * 2.1.150–2.1.173 emitted a terse `summary`; 2.1.207 began packing the
 * agent's entire final message into that same field, which the chip then
 * rendered as a wall of raw markdown. Take the first non-empty line, strip a
 * leading markdown heading / quote / list marker, and cap the length so the
 * chip stays a one-liner whatever the field carries. An already-terse
 * summary (a scheduled-wake label, an older-CLI notice) passes through
 * unchanged. The replay path reads the JSONL envelope's own short
 * `<summary>`, so it needs no clamp — only the live event field bloated.
 */
export function terseWakeSummary(summary: string): string {
  const firstLine = summary
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine === undefined) return "";
  const unmarked = firstLine.replace(/^(?:#{1,6}|>|[-*+])\s+/, "");
  const MAX = 140;
  return unmarked.length > MAX
    ? `${unmarked.slice(0, MAX - 1).trimEnd()}…`
    : unmarked;
}

/**
 * Pure factory for the {@link WakeStarted} IPC frame from a
 * `system/task_notification` event. Returns null for events that
 * are not task notifications, or for ones missing the expected
 * `task_id` field.
 *
 * The SDK's `SDKTaskNotificationMessage` payload
 * (`@anthropic-ai/claude-agent-sdk/sdk.d.ts:1659-1668`) is forwarded
 * onto `wake_trigger`, except `summary` is clamped to a terse label via
 * {@link terseWakeSummary}. Missing optional fields default to
 * empty strings or "stopped" for status — permissive on the wire so
 * a malformed event doesn't drop the wake bracket entirely.
 *
 * Caller (handleInterTurnEvent) is responsible for:
 *   - Side effects (writeLine, set isInWake, open ActiveTurn).
 *   - Idempotency (suppress emit on nested wake).
 *   - turnKey minting — NOT carried on the wire; the tugdeck store
 *     wrapper mints it on receipt, mirroring the existing
 *     add_user_message pattern.
 *
 * See the session-wake design record [D02] for the detector
 * rationale and [Q01] for the empirical wire shape this contract is
 * pinned against.
 */
export function buildWakeStartedMessage(
  event: Record<string, unknown>,
  sessionId: string,
): WakeStarted | null {
  if (event.type !== "system" || event.subtype !== "task_notification") {
    return null;
  }
  const taskId = event.task_id;
  if (typeof taskId !== "string" || taskId.length === 0) {
    return null;
  }
  const status = event.status as "completed" | "failed" | "stopped" | undefined;
  return {
    type: "wake_started",
    session_id: sessionId,
    wake_trigger: {
      task_id: taskId,
      tool_use_id: (event.tool_use_id as string) ?? "",
      status: status ?? "stopped",
      summary: terseWakeSummary((event.summary as string) ?? ""),
      output_file: (event.output_file as string) ?? "",
    },
    ipc_version: IPC_VERSION,
  };
}

/**
 * Distinct `system/<subtype>` values already reported by
 * {@link noteUnhandledSystemSubtype}, so each unknown subtype is logged
 * once per process rather than on every occurrence (`system/status`
 * fires ~once per API request — many times a turn).
 */
const reportedUnhandledSystemSubtypes = new Set<string>();

/**
 * Surface a `system` event whose `subtype` tugcode does not translate.
 * The `case "system"` dispatch translates a known set
 * (`init` / `compact_boundary` / `api_retry` / `model_refusal_fallback`
 * / `task_started` / `task_updated` / `task_progress`) and historically
 * had no final branch, so a newly-introduced subtype vanished silently —
 * the failure mode that hid `task_progress`. This makes the next wire
 * addition visible (e.g. `system/status`) so it can be classified and
 * forwarded deliberately rather than discovered by accident.
 */
function noteUnhandledSystemSubtype(subtype: string): void {
  if (reportedUnhandledSystemSubtypes.has(subtype)) return;
  reportedUnhandledSystemSubtypes.add(subtype);
  console.log(`[tugcode] unhandled system subtype="${subtype}" (not forwarded)`);
}

/**
 * Pure factory for the {@link TaskStarted} IPC frame from a
 * `system/task_started` event. Returns null for non-matching events or
 * ones missing the required `task_id` / `tool_use_id` strings —
 * permissive on the optional fields so a partial frame still forwards.
 *
 * Note the frame fires for foreground subagents too (shape-identical
 * to the background case); tugcode forwards verbatim and leaves the
 * background gate to the consumer, which holds the launching tool
 * call's `input.run_in_background`. Empirical contract:
 * `stream-json-catalog/v2.1.173-jobs-spike/`.
 */
export function buildTaskStartedMessage(
  event: Record<string, unknown>,
  sessionId: string,
): TaskStarted | null {
  if (event.type !== "system" || event.subtype !== "task_started") {
    return null;
  }
  const taskId = event.task_id;
  const toolUseId = event.tool_use_id;
  if (typeof taskId !== "string" || taskId.length === 0) return null;
  if (typeof toolUseId !== "string" || toolUseId.length === 0) return null;
  const subagentType = event.subagent_type;
  return {
    type: "task_started",
    session_id: sessionId,
    task_id: taskId,
    tool_use_id: toolUseId,
    description: typeof event.description === "string" ? event.description : "",
    task_type: typeof event.task_type === "string" ? event.task_type : "",
    ...(typeof subagentType === "string" ? { subagent_type: subagentType } : {}),
    ipc_version: IPC_VERSION,
  };
}

/**
 * Pure factory for the {@link TaskUpdated} IPC frame from a
 * `system/task_updated` event. Flattens claude's `patch` object onto
 * the frame (`patch.status` / `patch.end_time`). Returns null for
 * non-matching events or ones missing `task_id` / `patch.status`.
 */
export function buildTaskUpdatedMessage(
  event: Record<string, unknown>,
  sessionId: string,
): TaskUpdated | null {
  if (event.type !== "system" || event.subtype !== "task_updated") {
    return null;
  }
  const taskId = event.task_id;
  if (typeof taskId !== "string" || taskId.length === 0) return null;
  const patch =
    typeof event.patch === "object" && event.patch !== null
      ? (event.patch as Record<string, unknown>)
      : null;
  const status = patch?.status;
  if (typeof status !== "string" || status.length === 0) return null;
  const endTime = patch?.end_time;
  return {
    type: "task_updated",
    session_id: sessionId,
    task_id: taskId,
    status,
    ...(typeof endTime === "number" ? { end_time: endTime } : {}),
    ipc_version: IPC_VERSION,
  };
}

/**
 * The trio a background-agent async-launch echo hands tugcode — enough
 * to start a {@link SubagentTailer} with no directory scan or sidecar
 * parse: the launching `Agent` call's id (stamps every child frame),
 * the agent id (the tailer map key, also the task id of its lifecycle
 * frames), and the live-growing transcript path.
 */
export interface AsyncLaunch {
  parentToolUseId: string;
  agentId: string;
  outputFile: string;
}

/**
 * Narrow a raw claude stdout event to an {@link AsyncLaunch}, or
 * `undefined` for anything that isn't a background-agent launch echo.
 *
 * The echo is a `user` event whose **live** `tool_use_result` field
 * (snake_case — the persisted JSONL's camelCase `toolUseResult` is the
 * replay path's concern) carries `isAsync: true` /
 * `status: "async_launched"` plus `agentId` + `outputFile`, and whose
 * `message.content` holds the linked `tool_result` block naming the
 * launching `Agent` call. All four fields must be present — a
 * foreground result, or a drifted echo missing the linkage, yields
 * `undefined` and no tailer starts.
 */
export function extractAsyncLaunch(
  event: Record<string, unknown>,
): AsyncLaunch | undefined {
  if (event.type !== "user") return undefined;
  const result = event.tool_use_result;
  if (result === null || typeof result !== "object") return undefined;
  const r = result as Record<string, unknown>;
  if (r.isAsync !== true && r.status !== "async_launched") return undefined;
  const agentId = r.agentId;
  const outputFile = r.outputFile;
  if (typeof agentId !== "string" || agentId.length === 0) return undefined;
  if (typeof outputFile !== "string" || outputFile.length === 0) {
    return undefined;
  }
  const message = event.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content as Array<Record<string, unknown>>) {
    if (
      block.type === "tool_result" &&
      typeof block.tool_use_id === "string" &&
      block.tool_use_id.length > 0
    ) {
      return { parentToolUseId: block.tool_use_id, agentId, outputFile };
    }
  }
  return undefined;
}

/**
 * Pure factory for the {@link TaskProgress} IPC frame from a
 * `system/task_progress` event. Returns null for non-matching events or
 * ones missing the required `task_id` / `tool_use_id` strings —
 * permissive on the optional progress detail (`last_tool_name`,
 * `usage`) so a partial frame still forwards. Like
 * {@link buildTaskStartedMessage} the frame fires for foreground
 * subagents too; tugcode forwards verbatim and leaves the background
 * gate to the consumer.
 */
export function buildTaskProgressMessage(
  event: Record<string, unknown>,
  sessionId: string,
): TaskProgress | null {
  if (event.type !== "system" || event.subtype !== "task_progress") {
    return null;
  }
  const taskId = event.task_id;
  const toolUseId = event.tool_use_id;
  if (typeof taskId !== "string" || taskId.length === 0) return null;
  if (typeof toolUseId !== "string" || toolUseId.length === 0) return null;
  const subagentType = event.subagent_type;
  const lastToolName = event.last_tool_name;
  const rawUsage =
    typeof event.usage === "object" && event.usage !== null
      ? (event.usage as Record<string, unknown>)
      : null;
  const usage = rawUsage
    ? {
        ...(typeof rawUsage.total_tokens === "number"
          ? { total_tokens: rawUsage.total_tokens }
          : {}),
        ...(typeof rawUsage.tool_uses === "number"
          ? { tool_uses: rawUsage.tool_uses }
          : {}),
        ...(typeof rawUsage.duration_ms === "number"
          ? { duration_ms: rawUsage.duration_ms }
          : {}),
      }
    : undefined;
  return {
    type: "task_progress",
    session_id: sessionId,
    task_id: taskId,
    tool_use_id: toolUseId,
    description: typeof event.description === "string" ? event.description : "",
    ...(typeof subagentType === "string" ? { subagent_type: subagentType } : {}),
    ...(typeof lastToolName === "string" ? { last_tool_name: lastToolName } : {}),
    ...(usage && Object.keys(usage).length > 0 ? { usage } : {}),
    ipc_version: IPC_VERSION,
  };
}

/**
 * Pure factory for the {@link BackgroundTasksChanged} IPC frame from a
 * `system/background_tasks_changed` event. Returns null for every other
 * event.
 *
 * The whole event minus its `type` / `subtype` envelope rides under
 * `payload`, unread. That is deliberate: this frame is the one place the wire
 * states the background roster as a fact rather than as the sum of edges a
 * consumer managed to observe, and a factory that picked fields would decide
 * today which of them a later reader is allowed to see. tugcast logs it;
 * nothing decides on it.
 *
 * It fires twice around a backgrounded call — once at the launch carrying the
 * new task, once at the wake carrying what remains — and was dropped as an
 * unhandled subtype until `tugcode/probes/background-bash-wake` caught it.
 */
export function buildBackgroundTasksChangedMessage(
  event: Record<string, unknown>,
  sessionId: string,
): BackgroundTasksChanged | null {
  if (event.type !== "system" || event.subtype !== "background_tasks_changed") {
    return null;
  }
  const { type: _type, subtype: _subtype, ...payload } = event;
  return {
    type: "background_tasks_changed",
    session_id: sessionId,
    payload,
    ipc_version: IPC_VERSION,
  };
}

export interface TopLevelRoutingResult {
  messages: OutboundMessage[];
  gotResult: boolean;
  sessionId?: string;
  streamEvent?: Record<string, unknown>;
  controlRequest?: Record<string, unknown>;
  cancelledRequestId?: string;
  parentToolUseId?: string;
  resultMetadata?: ResultMetadata;
  systemMetadata?: Record<string, unknown>;
  /**
   * Claude's `message.id` for the turn, when revealed by this top-level
   * event (today: the `assistant` snapshot only). Belt-and-suspenders to the
   * `mapStreamEvent` `message_start` path: whichever lands first slides
   * `ActiveTurn.currentMessageId` to it. Absent on events that don't reveal
   * the id.
   */
  messageId?: string;
  /**
   * Claude's user-prompt-record `uuid`, set when this top-level event is
   * the live echo of the turn's own submission (`--replay-user-messages`).
   * The `/rewind` anchor ([#step-7-1]); `dispatchEventToTurn` captures it
   * onto `ActiveTurn.promptUuid` and emits a {@link PromptAnchor}. Absent
   * on tool-result `user` events and on echoes carrying no `uuid`.
   */
  promptUuid?: string;
  /**
   * Updated armed state for the ordering-armed summary capture ([P08]).
   * `true` after a `compact_boundary` arms it, `false` after the summary is
   * captured or a `result` disarms it, `undefined` when this event leaves the
   * armed state unchanged. `dispatchEventToTurn` writes any non-`undefined`
   * value back onto {@link ActiveTurn.pendingCompactSummary}.
   */
  pendingCompactSummary?: boolean;
}

/**
 * Hex-encode the first `maxBytes` bytes of an event's JSON serialization,
 * for the `unknown_event` frame's `payload_hex_preview`. A short, bounded
 * peek at an untranslated payload — enough for an operator to recognize
 * the shape without forwarding (and bloating the wire with) the whole
 * thing. Serialization failures (e.g. a cyclic payload) yield an empty
 * preview rather than throwing. Pure; exported for unit testing.
 */
export function payloadHexPreview(payload: unknown, maxBytes = 64): string {
  let json: string;
  try {
    json = JSON.stringify(payload) ?? "";
  } catch {
    json = "";
  }
  const bytes = new TextEncoder().encode(json).subarray(0, maxBytes);
  let hex = "";
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Route a single top-level stdout message to IPC outbound messages.
 * Handles all 8+ top-level message types per D03.
 * Exported for unit testing.
 *
 * `lastIterationUsage` is the `usage` of the turn's LAST tool-loop
 * iteration — the most recent `message_delta` (or `message_start`
 * fallback) `ActiveTurn` latched while draining the turn. The `result`
 * branch emits it as `cost_update.usage`. `result.usage` (on the event
 * itself) is deliberately NOT used for the wire `usage`: it is the
 * per-turn SUM across every API call, so a K-tool-call turn would
 * over-report context by ~K×. `result.usage` still flows into
 * `resultMetadata.usage` untouched. Omitted (pure-function callers
 * with no turn) → `cost_update.usage` is `{}`.
 */
export function routeTopLevelEvent(
  event: Record<string, unknown>,
  ctx: EventMappingContext,
  lastIterationUsage?: Record<string, unknown> | null
): TopLevelRoutingResult {
  const messages: OutboundMessage[] = [];
  let gotResult = false;
  let sessionId: string | undefined;
  let streamEvent: Record<string, unknown> | undefined;
  let controlRequest: Record<string, unknown> | undefined;
  let cancelledRequestId: string | undefined;
  let parentToolUseId: string | undefined;
  let resultMetadata: ResultMetadata | undefined;
  let systemMetadata: Record<string, unknown> | undefined;
  let messageId: string | undefined;
  let promptUuid: string | undefined;
  // Undefined = this event leaves the armed summary-capture state unchanged;
  // true/false = it arms/disarms it ([P08]).
  let pendingCompactSummary: boolean | undefined;

  // parent_tool_use_id is present on all 5 message types per PN-8.
  const rawParentId = event.parent_tool_use_id;
  if (typeof rawParentId === "string" && rawParentId.length > 0) {
    parentToolUseId = rawParentId;
  }

  const eventType = event.type as string | undefined;

  switch (eventType) {
    case "system": {
      const subtype = event.subtype as string | undefined;
      if (subtype === "init") {
        const sid = event.session_id as string | undefined;
        if (sid) {
          sessionId = sid;
        }
        systemMetadata = {
          tools: event.tools,
          model: event.model,
          permissionMode: event.permissionMode,
          cwd: event.cwd,
          slash_commands: event.slash_commands,
          plugins: event.plugins,
          agents: event.agents,
          skills: event.skills,
          mcp_servers: event.mcp_servers,
          claude_code_version: event.claude_code_version,
          output_style: event.output_style,
          fast_mode_state: event.fast_mode_state,
          apiKeySource: event.apiKeySource,
        };
        // Emit SystemMetadata IPC so the frontend can populate settings and help panels.
        const ccVersion =
          typeof event.claude_code_version === "string" &&
          event.claude_code_version.length > 0
            ? event.claude_code_version
            : undefined;
        const sysMsg: SystemMetadata = {
          type: "system_metadata",
          session_id: sid || "",
          cwd: (event.cwd as string) || "",
          tools: (event.tools as unknown[]) || [],
          model: (event.model as string) || "",
          permissionMode: (event.permissionMode as string) || "",
          slash_commands: (event.slash_commands as unknown[]) || [],
          plugins: (event.plugins as unknown[]) || [],
          agents: (event.agents as unknown[]) || [],
          skills: (event.skills as unknown[]) || [],
          mcp_servers: (event.mcp_servers as unknown[]) || [],
          // Only include `version` when claude's init event actually
          // carried `claude_code_version`. An empty string here would
          // race the live init through the merge layer and mislead
          // the frontend into showing "Claude Code " (empty) instead
          // of letting its fallback chain fire — see the rename plan
          // and the merge rules in `session_metadata_merge.rs`.
          ...(ccVersion !== undefined ? { version: ccVersion } : {}),
          output_style: (event.output_style as string) || "",
          fast_mode_state: (event.fast_mode_state as string) || "",
          apiKeySource: (event.apiKeySource as string) || "",
          ipc_version: IPC_VERSION,
        };
        messages.push(sysMsg);
      } else if (subtype === "compact_boundary") {
        // Forward claude's `compact_metadata` (trigger + pre-compaction
        // token count) when present so the session-card divider can show it;
        // the bare marker stands alone otherwise. The SDK shape is
        // snake_case (`compact_metadata.pre_tokens`); tolerate a camelCase
        // variant defensively.
        const meta = (event.compact_metadata ?? event.compactMetadata ?? {}) as {
          trigger?: unknown;
          pre_tokens?: unknown;
          preTokens?: unknown;
          post_tokens?: unknown;
          postTokens?: unknown;
        };
        const preTokens =
          typeof meta.pre_tokens === "number"
            ? meta.pre_tokens
            : typeof meta.preTokens === "number"
              ? meta.preTokens
              : undefined;
        const postTokens =
          typeof meta.post_tokens === "number"
            ? meta.post_tokens
            : typeof meta.postTokens === "number"
              ? meta.postTokens
              : undefined;
        const marker: CompactBoundary = {
          type: "compact_boundary",
          ...(typeof meta.trigger === "string" ? { trigger: meta.trigger } : {}),
          ...(preTokens !== undefined ? { pre_tokens: preTokens } : {}),
          ...(postTokens !== undefined ? { post_tokens: postTokens } : {}),
          ipc_version: IPC_VERSION,
        };
        messages.push(marker);
        // Arm the ordering-armed summary capture ([P08]): the next synthetic
        // `user` event carrying a plain-string summary is the compaction
        // summary (no `isCompactSummary` flag on the live wire — ordering
        // after the boundary is the reliable discriminator).
        pendingCompactSummary = true;
      } else if (subtype === "api_retry") {
        messages.push({
          type: "api_retry",
          attempt: (event.attempt as number) || 0,
          max_retries: (event.max_retries as number) || 10,
          retry_delay_ms: (event.retry_delay_ms as number) || 0,
          error_status: (event.error_status as number | null) ?? null,
          error: (event.error as string) || "unknown",
          ipc_version: IPC_VERSION,
        });
      } else if (subtype === "model_refusal_fallback") {
        // The model declined and the SDK retried on a fallback model — a
        // non-fatal recovery the session card surfaces as a one-shot notice.
        // Tolerate snake/camel field variants defensively.
        messages.push({
          type: "model_refusal_fallback",
          original_model:
            (event.originalModel as string) ??
            (event.original_model as string) ??
            "",
          fallback_model:
            (event.fallbackModel as string) ??
            (event.fallback_model as string) ??
            "",
          trigger: (event.trigger as string) || "",
          direction: (event.direction as string) || "",
          ipc_version: IPC_VERSION,
        });
      } else if (subtype === "task_started") {
        // Background-task lifecycle frames can fire mid-turn (the
        // launching tool call runs inside the turn; a fast job can
        // even flip terminal before the turn ends — observed in the
        // v2.1.173-jobs-spike capture). Forward both verbatim.
        const frame = buildTaskStartedMessage(
          event,
          (event.session_id as string) || "",
        );
        if (frame !== null) messages.push(frame);
      } else if (subtype === "task_updated") {
        const frame = buildTaskUpdatedMessage(
          event,
          (event.session_id as string) || "",
        );
        if (frame !== null) messages.push(frame);
      } else if (subtype === "task_progress") {
        // In-flight background-agent progress (NEW on the 2.1.197-era
        // wire). Carries the agent's most recent tool + cumulative
        // usage so the JOBS cell can show what a backgrounded agent is
        // doing instead of a bare running→done flip. Like the other
        // task frames it can fire mid-turn (the agent runs concurrently
        // with the launching turn).
        const frame = buildTaskProgressMessage(
          event,
          (event.session_id as string) || "",
        );
        if (frame !== null) messages.push(frame);
      } else if (subtype === "background_tasks_changed") {
        // The background roster, whole. Forwarded rather than noted as
        // unhandled ([Q01]): it is the only frame that states which jobs
        // claude thinks are running, which is what makes a disagreement with
        // tugcast's own open-job set diagnosable after the fact.
        const frame = buildBackgroundTasksChangedMessage(
          event,
          (event.session_id as string) || "",
        );
        if (frame !== null) messages.push(frame);
      } else if (subtype === "status") {
        // Agent activity heartbeat (NEW at 2.1.197) — `system/status`,
        // one per outbound API request (`status:"requesting"` observed).
        // Deliberately NOT forwarded: it is a foreground per-request
        // pulse whose "the loop is alive" meaning is already conveyed by
        // the deck's `activeTurn`-driven live-activity readout, and
        // piping a high-frequency heartbeat into the catalog-pinned wire
        // earns drift churn for no gain the live line doesn't provide.
        // Characterized + handled here (not a silent drop) so the choice
        // is explicit; revisit if a finer foreground request pulse is
        // ever wanted.
      } else if (subtype !== undefined) {
        // Guard against silently dropping a newly-introduced system
        // subtype (e.g. `system/status`, observed first at 2.1.197).
        // The catch-all dispatch had NO final branch, so any unknown
        // subtype vanished with no trace — exactly how `task_progress`
        // went unforwarded for several releases. Log each distinct
        // subtype once per process so a future wire addition surfaces
        // in the dev log / stderr instead of disappearing.
        noteUnhandledSystemSubtype(subtype);
      }
      break;
    }

    case "assistant": {
      // The assistant top-level event is a complete snapshot of the message.
      // For normal API responses, text was already delivered via stream_event
      // as partial assistant_text messages — we skip re-emitting to avoid
      // duplicates. Tool use blocks are still emitted since they may not
      // arrive via streaming.
      //
      // EXCEPTION: Synthetic messages (model: "<synthetic>") are produced by
      // built-in slash commands like /cost, /compact. These have no streaming
      // events — the assistant message is the only source of text. Emit it.
      const message = event.message as Record<string, unknown> | undefined;
      const rawId = message?.id;
      if (typeof rawId === "string" && rawId.length > 0) {
        messageId = rawId;
      }
      // Use claude's id for any messages built here when present, so the
      // first emit (synthetic text or tool_use within this snapshot)
      // already carries the same id the wire / reducer will use.
      // dispatchEventToTurn slides `turn.currentMessageId` to this id
      // after this function returns; the messages built below already
      // carry it via this local.
      const effectiveMsgId = messageId ?? ctx.msgId;
      const model = (message?.model as string) || "";
      const isSynthetic = model === "<synthetic>";
      const content = (message?.content as Array<Record<string, unknown>>) || [];

      // A message that closed on `max_tokens` was cut off at the output
      // ceiling, not a clean `end_turn`. Surface a one-shot notice so the
      // truncation is visible rather than reading as a silent stop. (Live
      // path only — replay has its own translator and shouldn't re-fire a
      // past turn's truncation.)
      if (message?.stop_reason === "max_tokens") {
        messages.push({ type: "output_truncated", ipc_version: IPC_VERSION });
      }

      for (let blockIndex = 0; blockIndex < content.length; blockIndex++) {
        const block = content[blockIndex];
        if (block.type === "text" && isSynthetic) {
          const text = (block.text as string) || "";
          if (text.length > 0) {
            // Synthetic messages have no streaming `content_block_start`
            // (they arrive as a complete snapshot). Synthesize one so
            // the reducer's mint path is uniform with the live and
            // replay paths per [D07].
            messages.push({
              type: "content_block_start",
              msg_id: effectiveMsgId,
              block_index: blockIndex,
              kind: "text",
              ipc_version: IPC_VERSION,
            });
            messages.push({
              type: "assistant_text",
              msg_id: effectiveMsgId,
              block_index: blockIndex,
              seq: ctx.seq,
              rev: ctx.rev,
              text,
              is_partial: false,
              status: "complete",
              ipc_version: IPC_VERSION,
            });
          }
        } else if (block.type === "tool_use") {
          // Emit content_block_start before tool_use for defensive
          // consistency with the streaming and replay paths. For a
          // tool_use that already arrived via the streaming wire's
          // content_block_start, the reducer's mint is idempotent so
          // this re-emit is a no-op. For a synthetic message whose
          // tool block has no streaming origin (rare — slash-command
          // outputs are usually pure text, but the type system doesn't
          // forbid synthetic tool blocks), this emission is the ONLY
          // mint signal the reducer gets; without it the tool would
          // arrive at the reducer without a minted ToolUseMessage and
          // be silently dropped.
          //
          // Wire-input boundary check: top-level assistant snapshots
          // MUST carry `id` and `name` on tool_use content blocks (the
          // snapshot is supposed to be the complete summary of the
          // message). Missing fields surface as a console.error;
          // emission proceeds so the reducer at least mints something.
          const toolUseId = (block.id as string) || "";
          const toolName = (block.name as string) || "";
          if (toolUseId === "" || toolName === "") {
            console.error(
              `[tugcode] assistant snapshot tool_use missing id or name (msg_id=${effectiveMsgId}, block_index=${blockIndex}, id="${toolUseId}", name="${toolName}")`,
            );
          }
          messages.push({
            type: "content_block_start",
            msg_id: effectiveMsgId,
            block_index: blockIndex,
            kind: "tool_use",
            tool_use_id: toolUseId,
            tool_name: toolName,
            ipc_version: IPC_VERSION,
          });
          messages.push({
            type: "tool_use",
            msg_id: effectiveMsgId,
            seq: ctx.seq,
            tool_name: toolName,
            tool_use_id: toolUseId,
            input: (block.input as object) || {},
            ipc_version: IPC_VERSION,
          });
        }
      }
      break;
    }

    case "user": {
      const message = event.message as Record<string, unknown> | undefined;
      const rawContent = message?.content;

      // The `<task-notification>` envelope ([P03]). A background completion
      // is not a submission, and the anchor capture below would read it as
      // one — plain-string content is exactly its test — moving the `/rewind`
      // anchor off the user's last prompt onto a job's completion notice. The
      // wake itself is opened by the inter-turn drain, the only tier that can;
      // this arm's whole job is to decline.
      if (
        typeof rawContent === "string" &&
        extractTaskNotificationWake(rawContent) !== null
      ) {
        break;
      }

      // Goal-evaluator feedback. While a `/goal` is active, the Stop-hook
      // evaluator injects synthetic user events (`isSynthetic: true`, text
      // `Stop hook feedback:\n[<condition>]: <reason>`) into the SAME result
      // cycle — a goal run is one long turn (see
      // tugcode/probes/goal-loop/FINDINGS.md#q01-goal). Translate the event
      // to a `goal_feedback` frame and stop: it is not the user's prompt
      // (it must not latch the rewind anchor below) and it carries no
      // tool_result blocks.
      if (event.isSynthetic === true) {
        const feedback = parseGoalFeedbackText(rawContent);
        if (feedback !== null) {
          messages.push({
            type: "goal_feedback",
            condition: feedback.condition,
            reason: feedback.reason,
            ipc_version: IPC_VERSION,
          });
        } else if (
          ctx.pendingCompactSummary === true &&
          typeof rawContent === "string" &&
          !rawContent.startsWith("<local-command-stdout>")
        ) {
          // The post-boundary summary event ([P08]): capture it as a
          // `compact_summary` frame and disarm. Goal feedback is parsed and
          // consumed first (above); `<local-command-stdout>` echoes are
          // excluded by prefix; disarm ensures one-shot capture per compaction.
          messages.push({
            type: "compact_summary",
            summary: rawContent,
            ipc_version: IPC_VERSION,
          });
          pendingCompactSummary = false;
        }
        break;
      }

      // `/rewind` anchor capture ([#step-7-1]). With `--replay-user-messages`
      // claude echoes the turn's own submission back as a `user` event
      // carrying the prompt-record `uuid`. That uuid is the rewind anchor
      // (`rewind_files.user_message_id` + the JSONL truncation boundary).
      // Capture it only from a *submission* echo — content that is a
      // plain string (slash command) or an array bearing a non-`tool_result`
      // block (the user's text/image). Mid-turn tool-result `user` events
      // (content is exclusively `tool_result` blocks) are NOT the prompt and
      // must not overwrite the anchor. `dispatchEventToTurn` latches the
      // surfaced value onto `ActiveTurn` and emits a `prompt_anchor`.
      const echoUuid = event.uuid;
      if (typeof echoUuid === "string" && echoUuid.length > 0) {
        const isSubmissionEcho =
          typeof rawContent === "string" ||
          (Array.isArray(rawContent) &&
            (rawContent as Array<Record<string, unknown>>).some(
              (b) => b.type !== "tool_result",
            ));
        if (isSubmissionEcho) {
          promptUuid = echoUuid;
        }
      }

      // Slash commands return content as a plain string (not an array).
      // Per §13c: {"type":"user","isReplay":true,"message":{"role":"user",
      //   "content":"<local-command-stdout>...</local-command-stdout>"}}
      //
      // A local-command-only turn never reveals a claude `message.id`, so
      // `ctx.msgId` is still "" when the stdout echo arrives — key the
      // synthesized block on the turn's opener id so the frames (and the
      // reducer's `activeMsgId`) match the terminal `turn_complete`.
      const localEchoMsgId = ctx.msgId !== "" ? ctx.msgId : ctx.openerId;
      if (event.isReplay === true && typeof rawContent === "string") {
        const stdoutMatch = rawContent.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
        if (stdoutMatch) {
          // Slash-command stdout: synthesize a single text block.
          messages.push({
            type: "content_block_start",
            msg_id: localEchoMsgId,
            block_index: 0,
            kind: "text",
            ipc_version: IPC_VERSION,
          });
          messages.push({
            type: "assistant_text",
            msg_id: localEchoMsgId,
            block_index: 0,
            seq: ctx.seq,
            rev: ctx.rev,
            text: stdoutMatch[1],
            is_partial: false,
            status: "complete",
            ipc_version: IPC_VERSION,
          });
        }
        const stderrMatch = rawContent.match(/<local-command-stderr>([\s\S]*?)<\/local-command-stderr>/);
        if (stderrMatch) {
          messages.push(errorFrame("local_command_stderr", stderrMatch[1], true));
        }
        break;
      }

      const content = (rawContent as Array<Record<string, unknown>>) || [];

      let firstToolUseId: string | undefined;

      for (const block of content) {
        if (block.type === "tool_result") {
          const blockContent = block.content;
          let output = "";
          if (typeof blockContent === "string") {
            // Per PN-3: strip <tool_use_error> tags when is_error is true.
            if (block.is_error === true && blockContent.includes("<tool_use_error>")) {
              output = blockContent
                .replace(/<tool_use_error>/g, "")
                .replace(/<\/tool_use_error>/g, "")
                .trim();
            } else {
              output = blockContent;
            }
          } else if (Array.isArray(blockContent)) {
            output = (blockContent as Array<Record<string, unknown>>)
              .filter((b) => b.type === "text")
              .map((b) => b.text as string)
              .join("");
          }
          const toolUseId = (block.tool_use_id as string) || "";
          if (!firstToolUseId) {
            firstToolUseId = toolUseId;
          }
          messages.push({
            type: "tool_result",
            tool_use_id: toolUseId,
            output,
            is_error: block.is_error === true,
            ipc_version: IPC_VERSION,
          });
        }
      }

      // Check outer event for tool_use_result (structured result) per PN-4.
      const toolUseResult = event.tool_use_result as Record<string, unknown> | undefined;
      if (toolUseResult && firstToolUseId) {
        messages.push({
          type: "tool_use_structured",
          tool_use_id: firstToolUseId,
          tool_name: (toolUseResult.toolName as string) || "",
          structured_result: toolUseResult,
          ipc_version: IPC_VERSION,
        });
      }

      // Handle isReplay + slash command output in tool_result blocks (array content).
      if (event.isReplay === true) {
        for (const block of content) {
          if (block.type === "tool_result") {
            const blockContent = block.content;
            if (typeof blockContent === "string") {
              const stdoutMatch = blockContent.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
              if (stdoutMatch) {
                // Slash-command stdout via tool_result: same synthesized
                // block pattern as the user-content path above.
                messages.push({
                  type: "content_block_start",
                  msg_id: localEchoMsgId,
                  block_index: 0,
                  kind: "text",
                  ipc_version: IPC_VERSION,
                });
                messages.push({
                  type: "assistant_text",
                  msg_id: localEchoMsgId,
                  block_index: 0,
                  seq: ctx.seq,
                  rev: ctx.rev,
                  text: stdoutMatch[1],
                  is_partial: false,
                  status: "complete",
                  ipc_version: IPC_VERSION,
                });
              }
              const stderrMatch = blockContent.match(/<local-command-stderr>([\s\S]*?)<\/local-command-stderr>/);
              if (stderrMatch) {
                messages.push(
                  errorFrame("local_command_stderr", stderrMatch[1], true),
                );
              }
            }
          }
        }
      }
      break;
    }

    case "result": {
      gotResult = true;
      // Disarm the summary capture ([P08]) so a summary-less compaction can't
      // leak the armed state into the next turn.
      pendingCompactSummary = false;
      const subtype = (event.subtype as string) || "error";
      const resultText = event.result as string | undefined;

      let isApiError = false;
      if (subtype === "success" && typeof resultText === "string" && resultText.startsWith("API Error:")) {
        isApiError = true;
      }

      resultMetadata = {
        subtype,
        is_error: event.is_error === true,
        total_cost_usd: event.total_cost_usd as number | undefined,
        num_turns: event.num_turns as number | undefined,
        duration_ms: event.duration_ms as number | undefined,
        duration_api_ms: event.duration_api_ms as number | undefined,
        usage: event.usage as Record<string, unknown> | undefined,
        modelUsage: event.modelUsage as Record<string, unknown> | undefined,
        permission_denials: event.permission_denials as unknown[] | undefined,
        is_api_error: isApiError || undefined,
      };

      // Emit CostUpdate from result event. The final assistant_text and
      // turn_complete are emitted by handleUserMessage with fresh seq values
      // so they pass through the frontend ordering buffer's dedup logic.
      //
      // `usage` carries the turn's LAST tool-loop iteration's usage
      // (`lastIterationUsage`), NOT `result.usage`. `result.usage` is a
      // SUM across every API call of the turn — a context-window snapshot
      // it is not. The last iteration's `input + cache_read +
      // cache_creation + output` IS the resident context after the turn.
      const costMsg: CostUpdate = {
        type: "cost_update",
        total_cost_usd: (event.total_cost_usd as number) || 0,
        num_turns: (event.num_turns as number) || 0,
        duration_ms: (event.duration_ms as number) || 0,
        duration_api_ms: (event.duration_api_ms as number) || 0,
        usage: lastIterationUsage ?? {},
        modelUsage: (event.modelUsage as Record<string, unknown>) || {},
        // Forward the turn's denials so the session card can surface them in its
        // Recently-denied tab; omit the field entirely when there were none.
        ...(resultMetadata.permission_denials &&
        resultMetadata.permission_denials.length > 0
          ? { permission_denials: resultMetadata.permission_denials }
          : {}),
        ipc_version: IPC_VERSION,
      };
      messages.push(costMsg);

      // Store result value for handleUserMessage to emit turn_complete.
      resultMetadata.resultValue = subtype === "success" ? "success" : "error";
      break;
    }

    case "stream_event": {
      streamEvent = event.event as Record<string, unknown> | undefined;
      break;
    }

    case "control_request": {
      controlRequest = event;
      break;
    }

    case "control_response": {
      console.log(`Received control_response: ${JSON.stringify(event)}`);
      break;
    }

    case "rate_limit_event": {
      // Subscription-quota broadcast emitted once per turn (post
      // `system/init`, pre-stream) since claude 2.1.x. Forward the
      // structured info so the frontend can show reset time + status;
      // the claude top-level `uuid` and `session_id` are dropped
      // because tugcode tracks session_id authoritatively and the
      // UI doesn't need claude's per-event uuid.
      const info = event.rate_limit_info as Record<string, unknown> | undefined;
      if (info && typeof info === "object") {
        const evt: RateLimitEvent = {
          type: "rate_limit_event",
          rate_limit_info: {
            status: (info.status as string) || "",
            resetsAt: (info.resetsAt as number) || 0,
            rateLimitType: (info.rateLimitType as string) || "",
            overageStatus: (info.overageStatus as string) || "",
            ...(typeof info.overageDisabledReason === "string"
              ? { overageDisabledReason: info.overageDisabledReason }
              : {}),
            isUsingOverage: Boolean(info.isUsingOverage),
            ...(typeof info.utilization === "number"
              ? { utilization: info.utilization }
              : {}),
          },
          ipc_version: IPC_VERSION,
        };
        messages.push(evt);
      }
      break;
    }

    case "keep_alive": {
      break;
    }

    case "tool_progress": {
      // Top-level progress/heartbeat telemetry the engine yields while a
      // long-running tool executes: `bash_progress` / `powershell_progress`
      // (elapsed_time_seconds + task_id), `repl_call`, `heartbeat:true`, and
      // subagent-retry frames. None carries tool output.
      //
      // The tool-call shape — a `tool_use_id` and an `elapsed_time_seconds` —
      // is forwarded as a `tool_progress` IPC message: it is the one thing
      // that is true about a running Bash call while it runs, since the
      // call's output arrives only in its `tool_result`, and the deck ticks
      // the running block's clock from it. Every other variant is swallowed
      // (claude's own SDK adapter ignores the heartbeat and subagent-retry
      // frames), so none falls into the `unknown_event` default and raises a
      // spurious "Unsupported event" banner downstream.
      const toolUseId = event.tool_use_id;
      const elapsed = event.elapsed_time_seconds;
      if (typeof toolUseId === "string" && toolUseId !== "" && typeof elapsed === "number") {
        const msg: ToolProgress = {
          type: "tool_progress",
          tool_use_id: toolUseId,
          tool_name: typeof event.tool_name === "string" ? event.tool_name : "",
          elapsed_time_seconds: elapsed,
          parent_tool_use_id:
            typeof event.parent_tool_use_id === "string" ? event.parent_tool_use_id : null,
          ipc_version: IPC_VERSION,
        };
        messages.push(msg);
      }
      break;
    }

    case "control_cancel_request": {
      const cancelId = event.request_id as string | undefined;
      if (cancelId) {
        cancelledRequestId = cancelId;
        const cancelMsg: ControlRequestCancel = {
          type: "control_request_cancel",
          request_id: cancelId,
          ipc_version: IPC_VERSION,
        };
        messages.push(cancelMsg);
      } else {
        console.log(`Received control_cancel_request with no request_id: ${JSON.stringify(event)}`);
      }
      break;
    }

    default: {
      const originalType = eventType ?? "unknown";
      // Forward-compat: keep the operator-visible log AND emit an
      // `unknown_event` IPC frame instead of silently dropping, so a
      // newer claude that streams an event type this build doesn't
      // translate still surfaces a soft warn banner downstream.
      console.log(`Unhandled top-level event type=${originalType}`);
      messages.push({
        type: "unknown_event",
        original_type: originalType,
        payload_hex_preview: payloadHexPreview(event),
        ipc_version: IPC_VERSION,
      });
      break;
    }
  }

  return {
    messages,
    gotResult,
    sessionId,
    streamEvent,
    controlRequest,
    cancelledRequestId,
    parentToolUseId,
    resultMetadata,
    systemMetadata,
    messageId,
    promptUuid,
    pendingCompactSummary,
  };
}

/** The four token-count keys a claude `usage` object carries. */
const USAGE_TOKEN_KEYS = [
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
] as const;

/**
 * Build a `streaming_usage` IPC frame from a raw claude `usage` object,
 * or `null` when there is nothing worth emitting: an empty `msg_id`
 * (claude has not revealed the message id yet) or a `usage` carrying
 * none of the four token fields (a lifecycle-only payload, an empty
 * `{}`, a malformed object). The gate keeps the high-frequency wire
 * quiet rather than emitting an all-zero frame.
 *
 * The whole `usage` object is forwarded raw — same as `cost_update`
 * does with `result.usage` — so the client reads whichever fields it
 * needs without tugcode taking a position on the shape.
 */
export function streamingUsageFrame(
  msgId: string,
  usage: unknown,
): StreamingUsage | null {
  if (msgId.length === 0) return null;
  if (typeof usage !== "object" || usage === null) return null;
  const u = usage as Record<string, unknown>;
  if (!USAGE_TOKEN_KEYS.some((k) => typeof u[k] === "number")) return null;
  return { type: "streaming_usage", msg_id: msgId, usage: u, ipc_version: IPC_VERSION };
}

/**
 * Map a single stream-json inner event (from stream_event wrapper) to IPC messages.
 * Exported for unit testing.
 */
// ---------------------------------------------------------------------------
// Tool-input progress — derived from the streaming `input_json_delta`
// fragments claude emits while assembling a tool's argument JSON. tugcode's
// reducer otherwise waits for the terminal `tool_use` (assembled input); these
// fragments let tugcast's session digester (`feeds/session_digest.rs`) narrate
// a long Write as it happens.
//
// `parseToolInputProgress` is pure and unit-tested: given the partial argument
// JSON accumulated so far, it returns a best-effort progress summary. While the
// JSON is still open, file path / line count are best-effort regex reads
// (exact once the value's closing quote streams in).
// ---------------------------------------------------------------------------

export interface ToolInputProgressSummary {
  /** Raw bytes of partial argument JSON accumulated so far. */
  bytes: number;
  /** `file_path` field value once it has streamed in, else null. */
  filePath: string | null;
  /** Newlines seen inside the `content` field so far (best-effort while open). */
  contentLines: number | null;
}

export function parseToolInputProgress(partialJson: string): ToolInputProgressSummary {
  const pathMatch = partialJson.match(/"file_path"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const filePath = pathMatch ? pathMatch[1] : null;

  // Count escaped newlines (`\n`, two chars in JSON) inside the content field.
  // While the JSON is still open this is best-effort; exact once parseable.
  let contentLines: number | null = null;
  const contentKey = partialJson.indexOf('"content"');
  if (contentKey !== -1) {
    const after = partialJson.slice(contentKey);
    const matches = after.match(/\\n/g);
    contentLines = (matches ? matches.length : 0) + 1;
  }

  return { bytes: partialJson.length, filePath, contentLines };
}

/**
 * Parse a goal-evaluator feedback text out of a synthetic user event's
 * content. The wire shape (pinned by the goal-lifecycle capture in
 * `tugcode/probes/goal-loop/`) is a single text block:
 *
 *     Stop hook feedback:\n[<condition>]: <reason>
 *
 * The condition match is greedy (a condition may itself contain `]: `);
 * the reason is whatever follows the last `]: `. Returns null when the
 * content carries no such text — synthetic events that are not goal
 * feedback stay untranslated rather than guessed at.
 */
export function parseGoalFeedbackText(
  rawContent: unknown,
): { condition: string; reason: string } | null {
  let text = "";
  if (typeof rawContent === "string") {
    text = rawContent;
  } else if (Array.isArray(rawContent)) {
    text = (rawContent as Array<Record<string, unknown>>)
      .filter((b) => b.type === "text")
      .map((b) => (b.text as string) || "")
      .join("");
  }
  const match = text.match(/^Stop hook feedback:\s*\n\[([\s\S]*)\]:\s([\s\S]*)$/);
  if (match === null) return null;
  return { condition: match[1], reason: match[2].trim() };
}

export function mapStreamEvent(
  event: Record<string, unknown>,
  ctx: EventMappingContext,
  accumulatedPartialText: string
): EventMappingResult {
  const messages: OutboundMessage[] = [];
  let newRev = ctx.rev;
  let partialText = accumulatedPartialText;
  let gotResult = false;
  let messageId: string | undefined;
  let messageStartUsage: Record<string, unknown> | undefined;
  let messageDeltaUsage: Record<string, unknown> | undefined;

  const eventType = event.type as string | undefined;

  if (eventType === "message_start") {
    // claude reveals its message.id in the message_start frame BEFORE any
    // emit-bearing event for the message (content_block_start / _delta
    // land after). Surface it so dispatchEventToTurn can slide
    // ActiveTurn.currentMessageId to claude's id before any wire emit
    // for this message. Multi-message claude turns (text → tool_use →
    // tool_result → second text) trigger another `message_start` with a
    // fresh id; the slide simply overwrites — no rejection, no warning.
    const message = event.message as Record<string, unknown> | undefined;
    const rawId = message?.id;
    if (typeof rawId === "string" && rawId.length > 0) {
      messageId = rawId;
    }
    // Surface the message's opening `usage` snapshot so the client's
    // live token cells update the moment a message begins (the
    // input + cache figures are known here; `output` is a small
    // partial that the terminal `message_delta` finalizes).
    const startUsage = streamingUsageFrame(
      typeof rawId === "string" ? rawId : "",
      message?.usage,
    );
    if (startUsage) {
      messages.push(startUsage);
      // Latch the raw `usage` so the turn can fall back to the last
      // `message_start` when it produced no `message_delta` at all.
      messageStartUsage = startUsage.usage;
    }
  } else if (eventType === "message_delta") {
    // The terminal per-message frame: carries the message's final,
    // authoritative four-token `usage`. `ctx.msgId` is the current
    // message id, slid by this message's earlier `message_start`.
    const deltaUsage = streamingUsageFrame(ctx.msgId, event.usage);
    if (deltaUsage) {
      messages.push(deltaUsage);
      // Latch the raw `usage`: the most recent `message_delta` of the
      // turn is the last tool-loop iteration, and `dispatchEventToTurn`
      // emits it as `cost_update.usage` at the terminal `result`.
      messageDeltaUsage = deltaUsage.usage;
    }
  } else if (eventType === "content_block_start") {
    const contentBlock = event.content_block as Record<string, unknown> | undefined;
    const blockIndex = typeof event.index === "number" ? event.index : 0;
    if (contentBlock?.type === "text") {
      // Surface the block open to tugdeck so the reducer can mint an
      // assistant_text Message before any delta lands. Idempotent on
      // the reducer side per [D07].
      messages.push({
        type: "content_block_start",
        msg_id: ctx.msgId,
        block_index: blockIndex,
        kind: "text",
        ipc_version: IPC_VERSION,
      });
    } else if (contentBlock?.type === "thinking") {
      messages.push({
        type: "content_block_start",
        msg_id: ctx.msgId,
        block_index: blockIndex,
        kind: "thinking",
        ipc_version: IPC_VERSION,
      });
    } else if (contentBlock?.type === "tool_use") {
      // Two emissions: a content_block_start so the reducer mints the
      // ToolUseMessage with kind/id/name, and the existing tool_use
      // IPC frame so the toolCallMap entry forms with empty input
      // (input is filled in by the post-`input_json_delta` `tool_use`
      // emission at the matching `assistant` top-level event or via a
      // continuation `tool_use` event).
      //
      // Wire-input boundary check: claude's wire MUST carry `id` and
      // `name` on tool_use content blocks (verified across all captured
      // probes). If either is missing the emission still proceeds with
      // an empty string so the reducer at least mints SOMETHING, but
      // we surface the anomaly loudly — a regression in claude's wire
      // shape would otherwise produce a tool Message with an empty
      // toolUseId that no tool_result could correlate against.
      const toolUseId = (contentBlock.id as string) || "";
      const toolName = (contentBlock.name as string) || "";
      if (toolUseId === "" || toolName === "") {
        console.error(
          `[tugcode] content_block_start tool_use missing id or name on live wire (msg_id=${ctx.msgId}, block_index=${blockIndex}, id="${toolUseId}", name="${toolName}")`,
        );
      }
      messages.push({
        type: "content_block_start",
        msg_id: ctx.msgId,
        block_index: blockIndex,
        kind: "tool_use",
        tool_use_id: toolUseId,
        tool_name: toolName,
        ipc_version: IPC_VERSION,
      });
      messages.push({
        type: "tool_use",
        msg_id: ctx.msgId,
        seq: ctx.seq,
        tool_name: toolName,
        tool_use_id: toolUseId,
        input: {},
        ipc_version: IPC_VERSION,
      });
    }
  } else if (eventType === "content_block_delta") {
    const delta = event.delta as Record<string, unknown> | undefined;
    const blockIndex = typeof event.index === "number" ? event.index : 0;
    if (delta?.type === "text_delta" && typeof delta.text === "string") {
      partialText += delta.text;
      // The wire emit carries the delta only (`text: delta.text`), not
      // the cumulative `partialText`. The reducer's append-or-mutate
      // rule keyed on `(msg_id, block_index)` appends each delta to
      // the Message minted by the preceding `content_block_start`. See
      // [D07] § Append-or-mutate rule.
      messages.push({
        type: "assistant_text",
        msg_id: ctx.msgId,
        block_index: blockIndex,
        seq: ctx.seq,
        rev: newRev++,
        text: delta.text,
        is_partial: true,
        status: "partial",
        ipc_version: IPC_VERSION,
      });
    } else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
      // Per §14: thinking_delta has delta.thinking (NOT delta.text).
      const thinkingMsg: ThinkingText = {
        type: "thinking_text",
        msg_id: ctx.msgId,
        block_index: blockIndex,
        seq: ctx.seq,
        text: delta.thinking,
        is_partial: true,
        status: "partial",
        ipc_version: IPC_VERSION,
      };
      messages.push(thinkingMsg);
    }
    // `input_json_delta` is intentionally not mapped to an outbound message
    // here — mapStreamEvent stays pure and stateless. The cumulative
    // `tool_input_progress` frame is emitted from `dispatchEventToTurn`,
    // which holds the per-turn block state needed to correlate the delta's
    // block_index to its tool_use_id / tool_name.
  } else if (eventType === "tool_use") {
    messages.push({
      type: "tool_use",
      msg_id: ctx.msgId,
      seq: ctx.seq,
      tool_name: event.name as string,
      tool_use_id: event.id as string,
      input: (event.input as object) || {},
      ipc_version: IPC_VERSION,
    });
  } else if (eventType === "tool_result" || eventType === "tool_progress") {
    messages.push({
      type: "tool_result",
      tool_use_id: (event.tool_use_id as string) || "",
      output: (event.output as string) || "",
      is_error: event.is_error === true,
      ipc_version: IPC_VERSION,
    });
  }

  return {
    messages,
    newRev,
    partialText,
    gotResult,
    messageId,
    messageStartUsage,
    messageDeltaUsage,
  };
}
