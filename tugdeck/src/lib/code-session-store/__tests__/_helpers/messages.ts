/**
 * Shared test helpers for constructing Message-substrate fixtures and
 * reading their fields. The reducer tests + transcript-data-source
 * tests use these so the substrate shape stays expressed in one place
 * — a future tweak to `Message.createdAt` defaulting or a new
 * required field on `TurnEntry` is one edit here, not ~30 across
 * every test file.
 */

import type {
  AssistantText,
  AssistantThinking,
  Message,
  ToolUseMessage,
  TurnCost,
  TurnEntry,
  TurnOrigin,
  UserMessage,
} from "../../types";

const ZERO_COST: TurnCost = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  totalCostUsd: 0,
};

// ---------------------------------------------------------------------------
// Message constructors
// ---------------------------------------------------------------------------

export function userMessage(
  args: { turnKey: string; text: string; submitAt?: number; origin?: "user" | "wheel" },
): UserMessage {
  const submitAt = args.submitAt ?? Date.now();
  return {
    kind: "user_message",
    messageKey: `${args.turnKey}-user`,
    createdAt: submitAt,
    text: args.text,
    attachments: [],
    origin: args.origin ?? "user",
    submitAt,
  };
}

export function assistantText(
  args: { msgId: string; blockIndex: number; text: string; createdAt?: number },
): AssistantText {
  return {
    kind: "assistant_text",
    messageKey: `${args.msgId}-b${args.blockIndex}`,
    createdAt: args.createdAt ?? Date.now(),
    text: args.text,
  };
}

export function assistantThinking(
  args: { msgId: string; blockIndex: number; text: string; createdAt?: number },
): AssistantThinking {
  return {
    kind: "assistant_thinking",
    messageKey: `${args.msgId}-b${args.blockIndex}`,
    createdAt: args.createdAt ?? Date.now(),
    text: args.text,
  };
}

export function toolUseMessage(
  args: {
    msgId: string;
    blockIndex: number;
    toolUseId: string;
    toolName: string;
    input?: unknown;
    status?: ToolUseMessage["status"];
    result?: unknown;
    structuredResult?: unknown;
    parentToolUseId?: string;
    toolWallMs?: number | null;
    createdAt?: number;
  },
): ToolUseMessage {
  return {
    kind: "tool_use",
    messageKey: `${args.msgId}-b${args.blockIndex}`,
    createdAt: args.createdAt ?? Date.now(),
    toolUseId: args.toolUseId,
    toolName: args.toolName,
    input: args.input ?? {},
    status: args.status ?? "pending",
    result: args.result ?? null,
    structuredResult: args.structuredResult ?? null,
    parentToolUseId: args.parentToolUseId,
    toolWallMs: args.toolWallMs ?? null,
  };
}

// ---------------------------------------------------------------------------
// TurnEntry constructor
// ---------------------------------------------------------------------------

/**
 * Build a fixture `TurnEntry` with sensible defaults. Tests pass the
 * `messages` they want to pin against; turn-level metadata (cost,
 * timestamps, telemetry) defaults to zeros / nulls.
 */
export function turnEntry(
  args: {
    turnKey: string;
    msgId: string;
    messages: ReadonlyArray<Message>;
    origin?: TurnOrigin;
    endedAt?: number;
    result?: "success" | "interrupted";
    turnEndReason?: TurnEntry["turnEndReason"];
    wallClockMs?: number;
    awaitingApprovalMs?: number;
    transportDowntimeMs?: number;
    activeMs?: number;
    ttftMs?: number | null;
    ttftcMs?: number | null;
    reconnectCount?: number;
    maxStreamGapMs?: number;
    cost?: TurnCost;
  },
): TurnEntry {
  return {
    turnKey: args.turnKey,
    msgId: args.msgId,
    // Fixture convenience: default origin from the head message kind so
    // existing fixtures get the right attribution without per-call edits.
    // (Production never infers origin — the opener states it.)
    origin:
      args.origin ??
      (args.messages[0]?.kind === "user_message" ? "user" : "assistant"),
    messages: args.messages,
    result: args.result ?? "success",
    endedAt: args.endedAt ?? Date.now(),
    wallClockMs: args.wallClockMs ?? 0,
    awaitingApprovalMs: args.awaitingApprovalMs ?? 0,
    transportDowntimeMs: args.transportDowntimeMs ?? 0,
    activeMs: args.activeMs ?? 0,
    ttftMs: args.ttftMs ?? null,
    ttftcMs: args.ttftcMs ?? null,
    reconnectCount: args.reconnectCount ?? 0,
    maxStreamGapMs: args.maxStreamGapMs ?? 0,
    turnEndReason: args.turnEndReason ?? "complete",
    cost: args.cost ?? ZERO_COST,
  };
}

// ---------------------------------------------------------------------------
// Readers — common derivations the assertion side uses
// ---------------------------------------------------------------------------

/**
 * Concatenate the turn's `assistant_text` Messages' text fields in
 * arrival order. Replaces the legacy `turn.assistant` field for
 * tests that pin "what did the assistant say".
 */
export function readAssistantText(turn: TurnEntry | undefined): string {
  if (turn === undefined) return "";
  return turn.messages
    .filter((m): m is AssistantText => m.kind === "assistant_text")
    .map((m) => m.text)
    .join("");
}

/** Sibling of {@link readAssistantText} for `assistant_thinking`. */
export function readAssistantThinking(turn: TurnEntry | undefined): string {
  if (turn === undefined) return "";
  return turn.messages
    .filter((m): m is AssistantThinking => m.kind === "assistant_thinking")
    .map((m) => m.text)
    .join("");
}

/** Read the turn's tool_use Messages, in arrival order. */
export function readToolCalls(
  turn: TurnEntry | undefined,
): ReadonlyArray<ToolUseMessage> {
  if (turn === undefined) return [];
  return turn.messages.filter((m): m is ToolUseMessage => m.kind === "tool_use");
}

/**
 * Read the turn's `user_message` Message text (head of `messages`).
 * Wake turns return the empty string (they have no `user_message`).
 */
export function readUserText(turn: TurnEntry | undefined): string {
  if (turn === undefined) return "";
  const head = turn.messages[0];
  return head !== undefined && head.kind === "user_message" ? head.text : "";
}
