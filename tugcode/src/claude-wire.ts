// Claude's stream-json wire, declared once: every message the claude CLI
// writes to its stdout that tugcode reads, as one discriminated union over
// `type` — `system` and `result` by `subtype`, `stream_event` by
// `event.type`. The IPC frames tugcode emits to tugcast are a different
// layer and live in `types.ts` / `tugproto`.
//
// The members are the Agent SDK's published message types
// (`@anthropic-ai/claude-agent-sdk`, a type-only dependency), opened to
// fields Tug does not read: Claude adding a field must never be a type
// error here, only a field nobody reads yet. The shapes the SDK does not
// declare — the stdin/stdout control frames' cancel, `keep_alive`, the
// turn-free `ai-title`, and the `system` subtypes the CLI emits that the
// SDK does not list — are declared below beside them.
//
// What arrives is checked against what is declared by the wire drift test,
// which narrows every line of the catalog's raw `wire/` capture with
// {@link isClaudeWireMessage}.

import type {
  SDKAssistantMessage,
  SDKControlRequest,
  SDKControlResponse,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKRateLimitEvent,
  SDKResultMessage,
  SDKSystemMessage,
  SDKTaskNotificationMessage,
  SDKTaskProgressMessage,
  SDKTaskStartedMessage,
  SDKTaskUpdatedMessage,
  SDKToolProgressMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

// ---------------------------------------------------------------------------
// Opening a member
// ---------------------------------------------------------------------------

/**
 * A wire member with its declared fields typed and every other field
 * readable as `unknown`. Each member of {@link ClaudeWireMessage} is open
 * this way, so a field Claude adds upstream reads as `unknown` rather than
 * failing to compile, and a field Tug starts reading is declared here once.
 */
export type Open<T> = T & { readonly [field: string]: unknown };

/** {@link Open}, distributed over each member of a union. */
type OpenEach<T> = T extends unknown ? Open<T> : never;

// ---------------------------------------------------------------------------
// Members the SDK does not declare
// ---------------------------------------------------------------------------

/**
 * `system/thinking_tokens`: a running estimate of the thinking a turn has
 * spent, emitted while extended thinking streams.
 */
export interface WireSystemThinkingTokens {
  type: "system";
  subtype: "thinking_tokens";
  estimated_tokens: number;
  estimated_tokens_delta: number;
  session_id: string;
  uuid: string;
}

/**
 * `system/background_tasks_changed`: the set of backgrounded tasks, fired
 * at a backgrounded call's launch and again at its wake.
 */
export interface WireSystemBackgroundTasksChanged {
  type: "system";
  subtype: "background_tasks_changed";
  tasks: Array<Open<{ task_id: string; task_type: string; description: string }>>;
  session_id: string;
  uuid: string;
}

/**
 * `system/model_refusal_fallback`: the model declined and the CLI retried on
 * a fallback model. Not in the captured wire; its fields are the camelCase
 * spellings tugcode reads (a snake_case variant reads through the index).
 */
export interface WireSystemModelRefusalFallback {
  type: "system";
  subtype: "model_refusal_fallback";
  originalModel?: string;
  fallbackModel?: string;
  trigger?: string;
  direction?: string;
}

/** `ai-title`: Claude's auto-generated session title. Turn-free; carries no `uuid`. */
export interface WireAiTitle {
  type: "ai-title";
  aiTitle: string;
}

/** `keep_alive`: a liveness tick between messages. */
export interface WireKeepAlive {
  type: "keep_alive";
}

/** `control_cancel_request`: Claude withdrawing a `control_request` it sent. */
export interface WireControlCancelRequest {
  type: "control_cancel_request";
  request_id: string;
}

/**
 * `command_lifecycle`: a queued command's progress through Claude's input
 * queue, keyed on the uuid the inbound message carried (Tug's submission id).
 */
export interface WireCommandLifecycle {
  type: "command_lifecycle";
  command_uuid: string;
  state: "queued" | "started" | "completed" | "cancelled" | "discarded" | "refused";
}

// ---------------------------------------------------------------------------
// The union
// ---------------------------------------------------------------------------

/** Every message Claude writes to its stdout that tugcode reads. */
export type ClaudeWireMessage =
  | OpenEach<SDKMessage>
  | Open<SDKControlRequest>
  | Open<SDKControlResponse>
  | Open<WireSystemThinkingTokens>
  | Open<WireSystemBackgroundTasksChanged>
  | Open<WireSystemModelRefusalFallback>
  | Open<WireAiTitle>
  | Open<WireKeepAlive>
  | Open<WireControlCancelRequest>
  | Open<WireCommandLifecycle>;

/** The top-level discriminant. */
export type ClaudeWireType = ClaudeWireMessage["type"];

/** The members of one top-level `type`. */
export type WireOfType<T extends ClaudeWireType> = Extract<ClaudeWireMessage, { type: T }>;

/** The `system` members' discriminant. */
export type WireSystemSubtype = WireOfType<"system">["subtype"];

/** The `result` members' discriminant. */
export type WireResultSubtype = WireOfType<"result">["subtype"];

/** The `stream_event` members' discriminant, carried on `event.type`. */
export type WireStreamEventType = WireOfType<"stream_event">["event"]["type"];

/** The payload a `stream_event` carries on `event`: one raw Messages-API stream event. */
export type WireStreamPayload = WireOfType<"stream_event">["event"];

// Named members, for the readers that take one kind.
export type WireAssistant = Open<SDKAssistantMessage>;
export type WireUser = WireOfType<"user">;
export type WireUserMessage = Open<SDKUserMessage>;
export type WireResult = Open<SDKResultMessage>;
export type WireStreamEvent = Open<SDKPartialAssistantMessage>;
export type WireSystemInit = Open<SDKSystemMessage>;
export type WireTaskNotification = Open<SDKTaskNotificationMessage>;
export type WireTaskStarted = Open<SDKTaskStartedMessage>;
export type WireTaskUpdated = Open<SDKTaskUpdatedMessage>;
export type WireTaskProgress = Open<SDKTaskProgressMessage>;
export type WireToolProgress = Open<SDKToolProgressMessage>;
export type WireRateLimitEvent = Open<SDKRateLimitEvent>;
export type WireControlRequest = Open<SDKControlRequest>;
export type WireControlResponse = Open<SDKControlResponse>;

// ---------------------------------------------------------------------------
// Narrowing a parsed line
// ---------------------------------------------------------------------------

// The discriminant tables. Each is a `Record` keyed by the union's own
// discriminant, so a member added to the union without its row — or a row
// for a member the union does not have — fails to compile.

const WIRE_TYPES: Record<ClaudeWireType, true> = {
  assistant: true,
  user: true,
  result: true,
  system: true,
  stream_event: true,
  tool_progress: true,
  auth_status: true,
  tool_use_summary: true,
  rate_limit_event: true,
  prompt_suggestion: true,
  control_request: true,
  control_response: true,
  control_cancel_request: true,
  keep_alive: true,
  command_lifecycle: true,
  "ai-title": true,
};

const SYSTEM_SUBTYPES: Record<WireSystemSubtype, true> = {
  init: true,
  compact_boundary: true,
  status: true,
  api_retry: true,
  local_command_output: true,
  hook_started: true,
  hook_progress: true,
  hook_response: true,
  plugin_install: true,
  task_notification: true,
  task_started: true,
  task_updated: true,
  task_progress: true,
  session_state_changed: true,
  notification: true,
  files_persisted: true,
  memory_recall: true,
  elicitation_complete: true,
  permission_denied: true,
  mirror_error: true,
  thinking_tokens: true,
  background_tasks_changed: true,
  model_refusal_fallback: true,
};

const RESULT_SUBTYPES: Record<WireResultSubtype, true> = {
  success: true,
  error_during_execution: true,
  error_max_turns: true,
  error_max_budget_usd: true,
  error_max_structured_output_retries: true,
};

const STREAM_EVENT_TYPES: Record<WireStreamEventType, true> = {
  message_start: true,
  message_delta: true,
  message_stop: true,
  content_block_start: true,
  content_block_delta: true,
  content_block_stop: true,
};

/** A JSON object: not `null`, not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function has<K extends string>(table: Record<K, true>, key: unknown): key is K {
  return typeof key === "string" && Object.prototype.hasOwnProperty.call(table, key);
}

/**
 * Whether a parsed stdout line is a member of {@link ClaudeWireMessage}: its
 * `type` is one the union declares and, for `system`, `result` and
 * `stream_event`, so is its second discriminant. The check reads the
 * discriminants only — the fields behind them are trusted to the declared
 * shape, which is what the wire drift test holds against the capture.
 */
export function isClaudeWireMessage(value: unknown): value is ClaudeWireMessage {
  if (!isRecord(value) || !has(WIRE_TYPES, value.type)) return false;
  switch (value.type) {
    case "system":
      return has(SYSTEM_SUBTYPES, value.subtype);
    case "result":
      return has(RESULT_SUBTYPES, value.subtype);
    case "stream_event":
      return isRecord(value.event) && has(STREAM_EVENT_TYPES, value.event.type);
    default:
      return true;
  }
}

/**
 * Whether a parsed stdout line carries a top-level `type` the union
 * declares — the routing guard. Unlike {@link isClaudeWireMessage} it does
 * not check the second discriminant: the router's `system` arm notes a
 * subtype it does not translate, and its `result` arm completes the turn on
 * any subtype, so an unknown second discriminant is routed by the arm its
 * `type` names rather than refused. Fields behind the discriminants are
 * trusted to the declared shape and still read defensively.
 */
export function hasClaudeWireType(value: unknown): value is ClaudeWireMessage {
  return isRecord(value) && has(WIRE_TYPES, value.type);
}

/** Whether a value is a stream payload whose `type` the union declares. */
export function isWireStreamPayload(value: unknown): value is WireStreamPayload {
  return isRecord(value) && has(STREAM_EVENT_TYPES, value.type);
}

/**
 * A short label for a parsed line's discriminants — `system/init`,
 * `stream_event/content_block_delta`, `assistant` — for logs and the drift
 * test's list of members the union does not know. A line with no string
 * `type` reads as `<untyped>`.
 */
export function wireKindOf(value: unknown): string {
  if (!isRecord(value) || typeof value.type !== "string") return "<untyped>";
  const second =
    value.type === "stream_event" && isRecord(value.event) ? value.event.type : value.subtype;
  return typeof second === "string" ? `${value.type}/${second}` : value.type;
}

// ---------------------------------------------------------------------------
// Tool inputs and results Tug reads by shape
// ---------------------------------------------------------------------------

/** `AskUserQuestion`'s tool input. */
export interface AskUserQuestionInput {
  questions: Array<{
    question: string;
    header?: string;
    multiSelect?: boolean;
    options?: Array<{ label: string; description?: string }>;
  }>;
}

/** One hunk of the `structuredPatch` an `Edit` or `Write` result carries. */
export interface StructuredPatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/** `Edit`'s structured tool result (`tool_use_result` on the `user` message). */
export interface EditToolResult {
  filePath: string;
  oldString: string;
  newString: string;
  originalFile: string | null;
  structuredPatch: StructuredPatchHunk[];
  userModified?: boolean;
  replaceAll?: boolean;
}

/** `Write`'s structured tool result (`tool_use_result` on the `user` message). */
export interface WriteToolResult {
  type: "create" | "overwrite";
  filePath: string;
  content: string;
  structuredPatch: StructuredPatchHunk[];
  originalFile: string | null;
}
