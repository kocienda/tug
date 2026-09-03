// tugcode/src/replay.ts
//
// JSONL → CODE_OUTPUT translator for dev transcript resume.
//
// Reads claude's per-session JSONL archive
// (`~/.claude/projects/<encoded-project-dir>/<claude_session_id>.jsonl`)
// and translates each entry into the OutboundMessage shapes the live
// wire produces, so tugdeck's reducer can commit replayed turns into
// `transcript` with the same machinery it uses for live turns. The
// surface is bracketed by `replay_started` / `replay_complete` so the
// reducer's `replaying` phase has a clean entry and exit point.
//
// Pure module — no filesystem I/O at translate time. The session-
// level iterator accepts a fully-loaded JSONL string (or a sentinel
// signaling "missing file" / "unreadable file") and produces the
// stream of OutboundMessages. The resume-spawn flow opens the JSONL
// by path, captures any read error, and feeds the iterator. Keeping
// translation pure makes the per-entry and per-session paths
// trivially unit-testable.
//
// Per-turn output ordering:
//
//   add_user_message                 Synthetic; carries the turn's
//                                    user text + attachments. Reducer's
//                                    `handleAddUserMessage` mints a
//                                    `pendingTurn` whose
//                                    `initialMessages` is
//                                    `[user_message]`. No `msg_id` on
//                                    the wire — the substrate's
//                                    correlation key is `turnKey`
//                                    ([D14]).
//   tool_use     [, tool_use_n]      In insertion order.
//   tool_result  [, tool_result_n]   Interleaved by tool_use_id.
//   thinking_text (optional)         `is_partial: false`.
//   assistant_text                   `is_partial: false` (terminal
//                                    text only — replay doesn't
//                                    stream per-token deltas).
//   turn_complete                    `result: "success"`. Emitted when
//                                    an assistant entry's `stop_reason`
//                                    is a clean terminal — `end_turn`,
//                                    `stop_sequence`, `max_tokens`, or
//                                    `refusal`. The trailing in-flight
//                                    assistant entry of an unfinished
//                                    cycle (`tool_use` / `pause_turn` /
//                                    no stop_reason) emits its content
//                                    frames per-entry but no terminal —
//                                    the live drain continuing
//                                    post-replay produces the eventual
//                                    `turn_complete` when claude's
//                                    `result` lands.

import type {
  AddUserMessage,
  AssistantOpener,
  AssistantText,
  ContentBlock,
  ContentBlockStart,
  OutboundMessage,
  ReplayComplete,
  ReplayStarted,
  SystemMetadata,
  ThinkingText,
  ToolResult,
  ToolUse,
  ToolUseStructured,
  TurnComplete,
  TurnCost,
  TurnEndReason,
  TurnTelemetry,
  WakeStarted,
} from "./types.ts";
import type { ReplayWindow } from "@tugproto/inbound";

/**
 * IPC version stamped onto every emitted OutboundMessage. Held local
 * to this module rather than imported from a shared constant because
 * the live IPC version is also a literal `2` everywhere; a future
 * version bump that affects both live and replay would update both
 * sites in one edit.
 */
const IPC_VERSION = 2;

/**
 * Default continuous-work budget for the session-level async
 * iterator. After this much uninterrupted translate work the
 * iterator awaits one macrotask so the IPC pipe stays responsive
 * during replay of very large JSONLs (the largest observed session
 * JSONLs run to tens of thousands of lines). Deliberately coarse —
 * a medium session translates inside one slice — and deliberately
 * not zero: while delivery remains one IPC line per message, the
 * slice doubles as the flood guard for downstream broadcast
 * capacity.
 */
const DEFAULT_TIME_SLICE_MS = 8;

/**
 * One content block inside a JSONL `message.content` array. Fields are
 * optional and loosely typed — Claude's per-session JSONL is an
 * internal persistence format whose shape evolves across releases.
 *
 * Content-block `type` values seen across surveyed JSONLs:
 *   - `text`        — assistant or user text
 *   - `tool_use`    — assistant tool invocation
 *   - `tool_result` — user-side tool response, keyed by tool_use_id
 *   - `thinking`    — extended-thinking content
 *   - `image`       — base64-encoded image attachment in user submission
 */
export interface JsonlContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  // tool_use blocks
  id?: string;
  name?: string;
  input?: unknown;
  // tool_result blocks
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
  // image blocks
  source?: { type?: string; media_type?: string; data?: string };
}

/**
 * Permissive shape for a single JSONL line, covering the variants
 * observed across surveyed JSONL files. Fields are optional and
 * loosely typed because Claude's per-session JSONL is an internal
 * persistence format whose shape evolves across releases. The
 * translator handles the surveyed cases explicitly and dispatches
 * unknown shapes to the `dev::replay::unknown_shape`
 * skip-with-telemetry path.
 *
 * Top-level `type` values seen across surveyed JSONLs:
 *   - `user`                    — user submission (text, image, or
 *                                  tool_result content)
 *   - `assistant`               — assistant turn or tool-use intermediate
 *   - `attachment`              — Claude bookkeeping (tool listings,
 *                                  skill listings, file references) —
 *                                  not transcript-visible
 *   - `queue-operation`         — Claude's internal scheduling marker
 *   - `last-prompt`             — bookmark for `--continue`
 *   - `file-history-snapshot`   — Claude's file-tracking metadata
 *   - `ai-title`                — auto-generated session title
 *   - `system`                  — `system_init`-style bookkeeping
 *   - `permission-mode`         — UI-visible at the chrome layer
 */
/**
 * Per-message token usage as Claude Code persists it on an assistant
 * JSONL entry — the API's snake_case shape. Each field is optional: a
 * turn that used no cache omits the cache fields entirely.
 */
export interface JsonlUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface JsonlEntry {
  type?: string;
  message?: {
    id?: string;
    role?: string;
    model?: string;
    stop_reason?: string | null;
    /**
     * Per-message token usage Claude Code persists on every assistant
     * entry — the same four-token shape the live `cost_update` /
     * `streaming_usage` frames carry, in the API's snake_case form. The
     * terminal entry of a turn carries that turn's last-iteration
     * resident-context usage (the figure the live `cost_update` froze).
     * Replay reads it via {@link extractTurnCostFromUsage} to
     * reconstruct per-turn cost from the file itself, independent of the
     * `turn_telemetry` side-table.
     */
    usage?: JsonlUsage;
    /**
     * Message content. Usually an array of {@link JsonlContentBlock}s,
     * but Claude Code persists a plain-text message — a `user`
     * submission with no attachments, or (defensively) an `assistant`
     * message — as a bare STRING. {@link contentBlocks} normalises
     * both shapes before the per-entry content walk.
     */
    content?: string | ReadonlyArray<JsonlContentBlock>;
  };
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  /**
   * Present on `type: "system"` entries — `"compact_boundary"` marks a
   * `/compact` point. The parent chain BREAKS at each compaction (the
   * boundary record carries `parentUuid: null` and the continuation
   * summary parents to it), so {@link computeDeadEntryIndices}'s live
   * walk bridges backwards across these records by file position.
   */
  subtype?: string;
  /**
   * True on subagent sidechain entries (older sessions persisted agent
   * transcripts inline in the main JSONL). Sidechains root their own
   * parent chains mid-file, so they are exempt from the live-chain walk
   * — {@link computeDeadEntryIndices} never marks them dead.
   */
  isSidechain?: boolean;
  /**
   * Present on `type: "attachment"` entries. Most attachment subtypes are
   * Claude bookkeeping (skipped — see {@link SKIPPED_TOP_LEVEL_TYPES}),
   * but `queued_command` is how Claude Code persists a **steered mid-turn
   * message** (the user typed while a turn ran): there is no `type: "user"`
   * row for it, only this. {@link handleQueuedCommandEntry} translates it
   * into a mid-turn `add_user_message` so reload reconstructs the steered
   * user row ([P07]/Step 6). `prompt` is the submitted content blocks.
   */
  attachment?: {
    type?: string;
    prompt?: string | ReadonlyArray<JsonlContentBlock>;
    commandMode?: string;
  };
  /**
   * Set by Claude Code on the `user` JSONL entry carrying a `/compact`
   * continuation summary ("This session is being continued from a
   * previous conversation…"). The translator skips these — the summary
   * is CLI-internal continuation context, not a transcript-visible
   * user submission (Claude Code's own UI hides it behind a "Compacted"
   * marker too). See {@link isNonSubmissionUserString}.
   */
  isCompactSummary?: boolean;
  /**
   * Set by Claude Code on `user` JSONL entries it injects as SDK-side
   * bookkeeping rather than transcript submissions. Surveyed shapes
   * across the live JSONL corpus:
   *   - image-attachment coordinate hints
   *     (`[Image: original WxH, displayed at WxH. Multiply coordinates …]`)
   *     and source-path notes (`[Image: source: /…]`) the SDK appends
   *     after every image submission so the AI can map clicks back
   *     to the original;
   *   - skill body / `/loop` content the SDK loads when a slash command
   *     is invoked ("Base directory for this skill: …");
   *   - any other SDK-injected pseudo-user entry the runtime persists
   *     for context continuity.
   *
   * None of these are transcript-visible submissions — Claude Code's own
   * UI never shows them. Each surfaces as an extra `add_user_message`
   * opener if the translator processes it, which closes the prior real
   * turn as `interrupted` (bogus phantom row) AND injects a meta-text
   * pseudo-prompt cell. The translator skips them unconditionally
   * regardless of content shape.
   */
  isMeta?: boolean;
  /**
   * Harness-injected synthetic user event — today: the `/goal` Stop-hook
   * evaluator's feedback (`Stop hook feedback:\n[<condition>]: <reason>`),
   * injected mid-cycle to keep the assistant working toward the goal.
   * Not a user submission: the translator skips it so replay never paints
   * evaluator feedback as user prose (and never resurrects goal state —
   * goal tracking is live-only, per the slash-command design record S04).
   */
  isSynthetic?: boolean;
  /**
   * The active permission mode at submit time (`"acceptEdits"`,
   * `"default"`, etc.). Claude Code stamps this on every *real* user
   * submission as it leaves the CLI's input layer. Crucially, it is
   * NOT stamped on the SDK's auto-injected `"[Request interrupted by
   * user …]"` marker (the marker comes out of the SDK's own internal
   * flow, not the user-input path), so the field's absence is a
   * structural disambiguator between real follow-on user submissions
   * and the SDK marker. See {@link isInterruptMarkerEntry}.
   */
  permissionMode?: string;
  /**
   * Structured tool result, sibling to `message.content`. Claude Code
   * persists this as the camelCase `toolUseResult` field on `user`
   * entries that carry a `tool_result` block (the wire-side analog is
   * the snake_case `tool_use_result` field on stream-json events; see
   * `session.ts:670` for the live path). Shape is tool-specific —
   * Read carries `{type: "text", file: {filePath, content, ...}}`,
   * Edit carries `{toolName, filePath, structuredPatch, ...}`, etc.
   * The translator forwards this payload verbatim as the
   * `structured_result` field of a `tool_use_structured` IPC message
   * so the reducer/wrappers see the same shape on replay as on live.
   */
  toolUseResult?: Record<string, unknown>;
  /**
   * Present on `type: "system"` + `subtype: "compact_boundary"` entries —
   * Claude Code's compaction metadata. The JSONL persists it **camelCase**
   * (`compactMetadata.preTokens`), whereas the live stream carries the same
   * payload **snake_case** (`compact_metadata.pre_tokens`, parsed separately
   * in `session.ts`). The two parsers stay separate for exactly this reason.
   * {@link translateJsonlEntry} reads `preTokens` to carry the pre-compaction
   * context size onto the emitted `compact_boundary` frame.
   */
  compactMetadata?: {
    trigger?: string;
    preTokens?: number;
    postTokens?: number;
  };
}

/**
 * The `.meta.json` sidecar Claude Code writes beside each background
 * agent's transcript (`subagents/agent-<agentId>.meta.json`). It records
 * the launching `Agent` `tool_use.id` — the authoritative linkage back to
 * the parent call — plus display fields. `toolUseId` is the only field the
 * splice strictly requires; the rest degrade gracefully.
 */
export interface SubagentTranscriptMeta {
  /** Launching `Agent` `tool_use.id` — the linkage key for the splice. */
  toolUseId: string;
  /** Subagent type, e.g. "Explore". */
  agentType?: string;
  /** The launch description (header detail). */
  description?: string;
  /** Nesting depth (1 = top-level agent). Informational. */
  spawnDepth?: number;
}

/**
 * One background agent's out-of-band transcript — the parsed
 * `subagents/agent-<agentId>.jsonl` entries plus its `.meta.json`. The
 * resume path discovers these ({@link readSubagentTranscripts} in
 * `session.ts`) and hands them to {@link translateJsonlSession}, which
 * splices each transcript's tool calls back under its parent Agent as
 * `parentToolUseId`-tagged child frames.
 */
export interface SubagentTranscript {
  meta: SubagentTranscriptMeta;
  entries: JsonlEntry[];
}

/**
 * Synthesize the child frames that reconstruct a background agent's tool
 * calls under its parent `Agent` on resume. For each `tool_use` block in the
 * transcript's assistant entries emit a `tool_use` frame stamped with
 * `parent_tool_use_id = meta.toolUseId` (the linkage the reducer keeps
 * sticky); for each `tool_result` block a `tool_result`; and for an entry's
 * `toolUseResult` sidecar a `tool_use_structured` bound to that entry's first
 * `tool_use_id` (so e.g. a child `Read`'s file body restores). The parent id
 * rides ONLY the `tool_use` frame — the reducer merges `tool_result` /
 * `tool_use_structured` by id onto the already-linked call.
 *
 * Emits **no** turn-lifecycle frames (`turn_started` / `turn_complete` /
 * `system_metadata`): the children live inside the parent Agent's turn, so
 * the splice site ({@link translateJsonlSession}) yields these mid-turn and
 * the reducer attaches them to the open turn. `seq` values come from the
 * caller's `nextSeq` so they thread the translator's global sequence; the
 * function is otherwise pure over the transcript.
 */
export function synthesizeSubagentChildFrames(
  transcript: SubagentTranscript,
  nextSeq: () => number,
): OutboundMessage[] {
  const parentId = transcript.meta.toolUseId;
  const out: OutboundMessage[] = [];
  for (const entry of transcript.entries) {
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    const msgId =
      typeof entry.message?.id === "string" ? entry.message.id : "";
    // First `tool_use_id` in this entry — binds an entry-level
    // `toolUseResult` to its call, mirroring `handleUserEntry`.
    let firstToolUseId = "";
    for (const block of content) {
      const blockType = typeof block.type === "string" ? block.type : "";
      if (blockType === "tool_use") {
        const toolUseId = typeof block.id === "string" ? block.id : "";
        const toolName = typeof block.name === "string" ? block.name : "";
        if (toolUseId.length === 0 || toolName.length === 0) continue;
        const toolUse: ToolUse = {
          type: "tool_use",
          msg_id: msgId,
          seq: nextSeq(),
          tool_name: toolName,
          tool_use_id: toolUseId,
          input:
            typeof block.input === "object" && block.input !== null
              ? (block.input as object)
              : {},
          parent_tool_use_id: parentId,
          timestamp: parseEntryTimestamp(entry),
          ipc_version: IPC_VERSION,
        };
        out.push(toolUse);
      } else if (blockType === "tool_result") {
        const toolUseId =
          typeof block.tool_use_id === "string" ? block.tool_use_id : "";
        if (toolUseId.length === 0) continue;
        if (firstToolUseId.length === 0) firstToolUseId = toolUseId;
        const toolResult: ToolResult = {
          type: "tool_result",
          tool_use_id: toolUseId,
          output: coerceToolResultContent(block.content),
          is_error: block.is_error === true,
          timestamp: parseEntryTimestamp(entry),
          ipc_version: IPC_VERSION,
        };
        out.push(toolResult);
      }
    }
    // Entry-level structured result (e.g. a child `Read`'s `file.content`),
    // bound to the entry's first tool_use_id. Emitted after the tool_result
    // so the reducer's last-write-wins merge lands the richer payload.
    const toolUseResult = entry.toolUseResult;
    if (toolUseResult !== undefined && firstToolUseId.length > 0) {
      const structured: ToolUseStructured = {
        type: "tool_use_structured",
        tool_use_id: firstToolUseId,
        tool_name:
          typeof toolUseResult.toolName === "string"
            ? toolUseResult.toolName
            : "",
        structured_result: toolUseResult,
        ipc_version: IPC_VERSION,
      };
      out.push(structured);
    }
  }
  return out;
}

/**
 * Reconstruct the parent `Agent`'s `structured_result` from its transcript.
 * On resume the persisted Agent result is only the async-launch echo (no
 * content), so the block would show its restored calls but no final answer or
 * footer stats. This composes the shape `composeAgentTranscriptData` consumes:
 * `content` (the trailing assistant text answer — NOT the tool calls, which
 * arrive as parent-linked children), plus `agentType`/`status` and the stats
 * derived from the entries (`totalToolUseCount` = tool_use count;
 * `totalTokens` = summed assistant output tokens; `totalDurationMs` = last −
 * first timestamp).
 */
export function composeAgentStructuredResult(
  transcript: SubagentTranscript,
): Record<string, unknown> {
  const entries = transcript.entries;
  // Final answer: the trailing assistant entry that carries text and no
  // tool_use (the tool calls themselves restore as children, not content).
  let content: Array<{ type: "text"; text: string }> = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const c = entries[i].message?.content;
    if (!Array.isArray(c)) continue;
    const texts = c.filter(
      (b) => b.type === "text" && typeof b.text === "string",
    );
    const hasTool = c.some((b) => b.type === "tool_use");
    if (texts.length > 0 && !hasTool) {
      content = texts.map((b) => ({ type: "text", text: b.text as string }));
      break;
    }
  }
  let totalToolUseCount = 0;
  let totalTokens = 0;
  for (const e of entries) {
    const c = e.message?.content;
    if (Array.isArray(c)) {
      totalToolUseCount += c.filter((b) => b.type === "tool_use").length;
    }
    const usage = e.message?.usage;
    if (usage !== undefined) totalTokens += usageTokens(usage.output_tokens);
  }
  const firstTs = entries.length > 0 ? parseEntryTimestamp(entries[0]) : undefined;
  const lastTs =
    entries.length > 0
      ? parseEntryTimestamp(entries[entries.length - 1])
      : undefined;
  const totalDurationMs =
    firstTs !== undefined && lastTs !== undefined && lastTs >= firstTs
      ? lastTs - firstTs
      : undefined;
  return {
    ...(transcript.meta.agentType !== undefined
      ? { agentType: transcript.meta.agentType }
      : {}),
    status: "completed",
    content,
    totalToolUseCount,
    ...(totalTokens > 0 ? { totalTokens } : {}),
    ...(totalDurationMs !== undefined ? { totalDurationMs } : {}),
  };
}

// ---------------------------------------------------------------------------
// Per-turn cost reconstruction from JSONL `usage`
// ---------------------------------------------------------------------------

/**
 * Coerce a possibly-missing / non-numeric token field to a finite
 * number, defaulting to 0. Mirrors the client-side tolerance in
 * tugdeck's `extractTurnCost` — the JSONL may omit a cache field
 * entirely on a turn that used no cache.
 */
function usageTokens(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * The zero-cost {@link TurnCost} a turn replays with when its closing
 * entry carries no `usage` — an interrupted-before-response turn, or an
 * orphan synthesized from the *next* opener entry (whose usage is not
 * this turn's). `deriveContextWindows` carries the prior window forward
 * across such a turn, so it adds no delta rather than dropping CONTEXT.
 */
export const ZERO_TURN_COST: TurnCost = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  totalCostUsd: 0,
};

/**
 * Map an assistant entry's `message.usage` to a {@link TurnCost} (Spec
 * S01). The four token fields come straight from the snake_case JSONL
 * usage (each defaulting to 0); `totalCostUsd` is always 0 — the JSONL
 * carries no per-message dollar cost, and dollar cost is not a Z2
 * readout. A missing `usage` yields {@link ZERO_TURN_COST}.
 *
 * Pure and exported for unit testing.
 */
export function extractTurnCostFromUsage(
  usage: JsonlUsage | undefined,
): TurnCost {
  if (usage === undefined) {
    return { ...ZERO_TURN_COST };
  }
  return {
    inputTokens: usageTokens(usage.input_tokens),
    outputTokens: usageTokens(usage.output_tokens),
    cacheCreationInputTokens: usageTokens(usage.cache_creation_input_tokens),
    cacheReadInputTokens: usageTokens(usage.cache_read_input_tokens),
    totalCostUsd: 0,
  };
}

/**
 * Whether a JSONL `message.model` string names a real model rather than
 * a placeholder. Claude Code interleaves `"<synthetic>"` assistant
 * entries (and other angle-bracketed placeholders) whose model field is
 * not a usable identifier; synthesizing the model from one yields MODEL
 * "?" and the wrong CONTEXT denominator. Rejects empty/whitespace and
 * any `<...>`-style placeholder; a normal `claude-…` name passes.
 */
export function isRealModelName(model: string | undefined | null): model is string {
  if (typeof model !== "string") return false;
  const trimmed = model.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.startsWith("<")) return false;
  return true;
}

/**
 * Derive the session's `sessionInitTokens` (`window(0)` — the resident
 * context before any turn) from the first turn's `usage` — its
 * input-baseline `input + cache_read + cache_creation`, excluding
 * `output`. This mirrors what the live path's first `streaming_usage`
 * captured (the prompt context the model started with), so
 * `perTurn(1) = window(1) − sessionInit ≈ output_tokens` — the same
 * "new tokens this turn" reading the live TOKENS cell showed.
 * Calibrated against a real session (#q01-session-init-tokens):
 * `sessionInit = 0` would instead report turn-1 TOKENS as the full
 * resident window. Returns `null` when no usage anchors the session.
 */
export function sessionInitTokensFromUsage(
  usage: JsonlUsage | undefined,
): number | null {
  if (usage === undefined) return null;
  return (
    usageTokens(usage.input_tokens) +
    usageTokens(usage.cache_read_input_tokens) +
    usageTokens(usage.cache_creation_input_tokens)
  );
}

/**
 * Build a replayed `turn_complete`'s telemetry block (Spec S02): the
 * JSONL-reconstructed `cost` and session `sessionInitTokens`, the
 * terminal `turnEndReason`, and zero timing — the multi-clock wall /
 * active / ttft figures the JSONL does not carry. tugcast may later
 * overlay those timing keys from the `turn_telemetry` side-table; it
 * must never touch `cost` / `sessionInitTokens` ([P03]).
 */
export function buildReplayTurnTelemetry(
  cost: TurnCost,
  sessionInitTokens: number | null,
  turnEndReason: TurnEndReason,
): TurnTelemetry {
  return {
    cost,
    wallClockMs: 0,
    awaitingApprovalMs: 0,
    transportDowntimeMs: 0,
    activeMs: 0,
    ttftMs: null,
    ttftcMs: null,
    reconnectCount: 0,
    maxStreamGapMs: 0,
    sessionInitTokens,
    turnEndReason,
  };
}

// ---------------------------------------------------------------------------
// Telemetry — structured warn lines emitted on shape oddities
// ---------------------------------------------------------------------------

/**
 * Telemetry sink. Tests inject a capturing implementation; production
 * uses the default that forwards to `console.error`. The shape
 * matches the structured-log convention the tugcast supervisor uses
 * (`target=`, `event=`, `key=value` pairs).
 */
export interface ReplayTelemetry {
  /** Surveyed shape inventory drift signal — the JSONL carried a
   * top-level type or content-block type the translator doesn't
   * recognize. Skipped silently; entry-level data is lost. */
  unknownShape(detail: { kind: "top_level" | "content_block"; type: string }): void;
  /** A JSONL line failed `JSON.parse`. Skipped; surrounding turns
   * still commit. Translator emits the warn so an operator can
   * grep for `dev::replay::malformed` in production. */
  malformedLine(detail: { reason: string; preview: string }): void;
}

const NOOP_TELEMETRY: ReplayTelemetry = {
  unknownShape() {},
  malformedLine() {},
};

const DEFAULT_TELEMETRY: ReplayTelemetry = {
  unknownShape(detail) {
    console.error(
      `[dev::replay::unknown_shape] kind=${detail.kind} type=${detail.type}`,
    );
  },
  malformedLine(detail) {
    console.error(
      `[dev::replay::malformed] reason=${detail.reason} preview=${JSON.stringify(detail.preview)}`,
    );
  },
};

// ---------------------------------------------------------------------------
// TranslateContext — per-translation state
// ---------------------------------------------------------------------------

/**
 * Per-session context for the JSONL → frame translator. Carries the
 * minimum state required for [D13]'s per-entry direct emission
 * discipline: a global sequence counter, a turn-commit count, the
 * load-bearing msg_id of any currently open turn, and a synthesized-id
 * counter. No cross-entry buffering of user submissions, no paired
 * "cycle" gate — each entry maps to its own IPC events.
 *
 * **The open-turn tracker.** `openTurnMsgId` is the canonical record
 * of "which turn is currently open on the wire." It carries:
 *
 *   - a synthesized opener id (`u-<n>` for user-text openers,
 *     `w-<n>` for wake openers) when no content event has emitted
 *     yet — the turn exists only as `pendingTurn` in the reducer;
 *   - claude's real `msg_id` once the first content event of the
 *     turn emits — {@link noteContentMsgId} swaps the synthesized
 *     opener id for the real id, so the orphan-synthesis path and the
 *     reducer's `activeMsgId` (which ALSO sets to the real id on
 *     first content per [D14]) stay in lockstep.
 *
 * Cleared on every terminal `turn_complete` emit; checked at every
 * new-opener boundary AND at EOF — non-null then triggers a
 * `turn_complete{result: "interrupted"}` carrying `openTurnMsgId`.
 *
 * **Wake-replay regression guarantee.** Wake openers and user openers
 * share the same tracker; the orphan-synthesis path doesn't care which
 * kind of opener it's closing. The class of bug that produced the
 * wake-replay regression (a new opener kind requiring a third mode
 * added to cycle pairing) cannot recur — adding a new opener kind is
 * a one-line addition (mint a new prefix), not a structural change.
 *
 * See the session-wake design record [D13] (replay direct
 * emission), [D14] (activeMsgId tracking), and `#spec-translate-context`
 * for the normative state-rules table.
 */
export interface TranslateContext {
  /**
   * Wire-message sequence counter — used for `seq` fields on shapes
   * that carry one (`assistant_text`, `tool_use`, `thinking_text`,
   * `turn_complete`). Bumped on every emission. Live wire's seq
   * counter restarts at 0 per session; replay does the same.
   */
  globalSeq: number;
  /** Number of turns committed via `turn_complete` so far. */
  turnsCommitted: number;
  /**
   * Tracks the load-bearing `msg_id` of the currently open turn.
   * See the interface docstring above for the full lifecycle; see
   * {@link noteContentMsgId} for the content-emit update rule and
   * {@link emitOrphanIfOpen} for the orphan-synthesis path.
   */
  openTurnMsgId: string | null;
  /**
   * True while the open turn was opened by a slash-command envelope
   * ({@link isCommandEnvelope}) and no model content has arrived.
   *
   * A local slash command (`/model`, `/compact`) is answered by the CLI
   * itself, not the model, so its turn legitimately ends with no
   * assistant cycle — the JSONL holds the envelope and a
   * `<local-command-stdout>` line and nothing else. Orphan synthesis
   * would otherwise close it `interrupted`, painting a stop marker on a
   * turn the user never interrupted. Cleared the moment content arrives
   * ({@link noteContentMsgId}) — a skill command that DOES drive a model
   * turn is an ordinary turn from that point on.
   */
  openTurnLocalCommand: boolean;
  /**
   * Counter for synthesized opener ids. Bumped every time a new
   * synthesized id is minted (`u-<n>` for user-text openers,
   * `w-<n>` for wake openers — see {@link mintOpenerId}). Monotonic
   * within a translator session. Reaches the wire only via the
   * orphan-synthesis `turn_complete` frame and ONLY in the no-content
   * interrupt case ([D13]'s wire-appearance rule).
   */
  orphanCounter: number;
  /**
   * Per-`msg_id` running count of content blocks emitted so far.
   *
   * Claude Code occasionally persists ONE assistant message across
   * multiple JSONL entries that share a `message.id` (e.g. a thinking
   * block in one entry and a text block in a follow-on entry — see
   * session ecc343d8). Each entry's `content[]` array starts at index
   * 0 in the JSONL, but the LIVE wire delivers those same blocks with
   * consecutive `index` values (0, 1, …) across the message. The
   * reducer's `${msg_id}:${block_index}` minting is idempotent, so if
   * the translator naively re-uses the per-entry local index 0 for
   * the continuation entry's first block, that mint collides with the
   * prior thinking mint and the second-block frame (text) lands on
   * the wrong-kind Message — losing its content on render.
   *
   * This map preserves the wire's per-msg_id block-index discipline:
   * the per-entry translator reads the current count for `msg_id`,
   * emits `content_block_start` with `block_index = count + i`, then
   * stores `count + entry.content.length` back. Cleared on every
   * terminal `turn_complete` emit (paired with `openTurnMsgId`'s
   * clear) since per-msg_id state is meaningless across turns.
   */
  blockCountByMsgId: Map<string, number>;
  /**
   * Session-level `sessionInitTokens` (`window(0)`) carried on every
   * replayed `turn_complete`'s telemetry. Captured once before the
   * emit loop from the first turn's input-baseline usage
   * ({@link sessionInitTokensFromUsage}); `null` until set / when no
   * usage anchors the session. Session-level, so it is identical on
   * every turn (the reducer keeps the first non-null — Spec S02).
   */
  sessionInitTokens: number | null;
  /** Telemetry sink. */
  telemetry: ReplayTelemetry;
}

/**
 * Subset of {@link WakeStarted.wake_trigger} the replay translator
 * extracts from the JSONL envelope. `tool_use_id` / `output_file` /
 * `status` aren't persisted on the user-entry envelope, so they
 * default to the live "Cohort A" Monitor shape ([Q01]) — empty
 * strings + `"completed"` (the cohort the envelope represents on
 * Claude's JSONL).
 */
export interface ReplayWakeTrigger {
  taskId: string;
  summary: string;
}

export function makeTranslateContext(
  telemetry: ReplayTelemetry = DEFAULT_TELEMETRY,
): TranslateContext {
  return {
    globalSeq: 0,
    turnsCommitted: 0,
    openTurnMsgId: null,
    openTurnLocalCommand: false,
    orphanCounter: 0,
    blockCountByMsgId: new Map(),
    sessionInitTokens: null,
    telemetry,
  };
}

// ---------------------------------------------------------------------------
// Open-turn tracker primitives ([D13])
// ---------------------------------------------------------------------------

/**
 * Note that a content frame for the given `msg_id` is being emitted.
 * Idempotent (no-op if `openTurnMsgId === msgId`); otherwise swaps
 * `openTurnMsgId` to `msgId` — which flips a synthesized opener id
 * (`u-<n>` / `w-<n>`) to claude's real `msg_id` on the FIRST content
 * event of a turn, per [D13]'s wire-truth update rule.
 *
 * Empty-id calls are a no-op: only real ids are load-bearing on the
 * orphan-synthesis path; a content-block-start event with no `msg_id`
 * doesn't tell us anything new about which turn is open.
 *
 * Called from every emit site in {@link handleAssistantEntry} that
 * carries an `msg_id` (content_block_start, assistant_text,
 * thinking_text, tool_use). With this rule, the orphan-synthesis
 * `turn_complete` always carries an id the reducer can match — claude's
 * real `msg_id` when content has arrived (reducer's normal-commit
 * path), the synthesized opener id when it hasn't (reducer's
 * no-content fallback per `#spec-reducer-state` rule 2).
 */
function noteContentMsgId(ctx: TranslateContext, msgId: string): void {
  if (msgId.length === 0) return;
  if (ctx.openTurnMsgId === msgId) return;
  ctx.openTurnMsgId = msgId;
  ctx.openTurnLocalCommand = false;
}

/**
 * Mint a synthesized opener id and bump the counter. Returns
 * `${prefix}-${n}` where `prefix` is `u` (user-submission opener), `w`
 * (wake opener), or `a` (neutral assistant-originated opener). The minted
 * id is translator-internal in the steady-state path — opener frames
 * (`add_user_message`, `wake_started`, `assistant_opener`) carry no
 * `msg_id` on the wire ([D15]). The id reaches the wire only on the
 * orphan-synthesis `turn_complete` AND only when no content event arrived
 * to swap it via {@link noteContentMsgId}.
 */
function mintOpenerId(ctx: TranslateContext, prefix: "u" | "w" | "a"): string {
  const id = `${prefix}-${ctx.orphanCounter}`;
  ctx.orphanCounter += 1;
  return id;
}

/**
 * Parse a JSONL entry's `timestamp` (ISO 8601 string Claude Code writes
 * on every entry) into epoch milliseconds. Returns `undefined` when the
 * field is absent or unparseable so callers can omit the field from the
 * emitted frame on the live path (where the JSONL is never sourced) and
 * fall back to `Date.now()` in the reducer.
 */
function parseEntryTimestamp(entry: JsonlEntry): number | undefined {
  const t = entry.timestamp;
  if (typeof t !== "string" || t.length === 0) return undefined;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Emit `turn_complete{msg_id: openTurnMsgId, result: "interrupted"}`
 * when a turn is open at an orphan-synthesis trigger point — a new
 * opener arriving (closing the prior turn) or EOF on a cold resume.
 * Clears `openTurnMsgId` and bumps `turnsCommitted` (the orphan IS
 * committed to the transcript).
 *
 * The committed turn's substrate shape depends on whether content
 * arrived. With content (`openTurnMsgId` holds claude's real
 * `msg_id`, having been swapped via {@link noteContentMsgId}), the
 * reducer's `handleTurnComplete` matches on `activeMsgId` and commits
 * scratch normally — the partial content lands in the TurnEntry.
 * Without content (`openTurnMsgId` is still the synthesized opener
 * id; `activeMsgId === null`), the reducer's no-content fallback
 * (`#spec-reducer-state` rule 2) commits `pendingTurn` as an
 * interrupted-before-response turn — `[user_message]` for `u-<n>`
 * openers, `[]` for `w-<n>` openers.
 *
 * A turn opened by a slash-command envelope with no model content is
 * the one exception: it closes `success`. See
 * {@link TranslateContext.openTurnLocalCommand}.
 *
 * Idempotent on no open turn — returns `[]` if `openTurnMsgId` is
 * null, so callers can invoke unconditionally before any new opener.
 */
function emitOrphanIfOpen(
  ctx: TranslateContext,
  closingEntry?: JsonlEntry,
): OutboundMessage[] {
  if (ctx.openTurnMsgId === null) return [];
  const msgId = ctx.openTurnMsgId;
  const result = ctx.openTurnLocalCommand ? "success" : "interrupted";
  const timestamp =
    closingEntry !== undefined ? parseEntryTimestamp(closingEntry) : undefined;
  const turnComplete: TurnComplete = {
    type: "turn_complete",
    msg_id: msgId,
    seq: ctx.globalSeq++,
    result,
    timestamp,
    // An orphan/interrupted turn replays with zero cost: `closingEntry`
    // is the *next* opener (callers pass the arriving entry that closes
    // the prior open turn), NOT this turn's own content, so its `usage`
    // is not this turn's (Risk R01). `deriveContextWindows` carries the
    // prior window forward across a zero-usage turn, so CONTEXT is set
    // by the last real turn rather than dropped.
    telemetry: buildReplayTurnTelemetry(
      { ...ZERO_TURN_COST },
      ctx.sessionInitTokens,
      result === "success" ? "complete" : "interrupted",
    ),
    ipc_version: IPC_VERSION,
  };
  ctx.openTurnMsgId = null;
  ctx.openTurnLocalCommand = false;
  ctx.turnsCommitted += 1;
  return [turnComplete];
}

// ---------------------------------------------------------------------------
// `<task-notification>` envelope recognizer
// ---------------------------------------------------------------------------

/**
 * Match Claude Code's `<task-notification>` envelope — the synthetic
 * `user` JSONL entry the runtime injects when a between-turn Monitor /
 * Bash-runbg / Task-runbg notification (Cohort A wake source per
 * the session-wake design record [Q01]) closes a wait. The
 * envelope shape, from a captured Monitor wake:
 *
 *     <task-notification>
 *     <task-id>b08a41726</task-id>
 *     <summary>Monitor event: "tail system.log for 'kernel'"</summary>
 *     <event>[Monitor timed out — re-arm if needed.]</event>
 *     </task-notification>
 *
 * Live tugcode never sees this envelope on the wire — the SDK lifts
 * the same event as `system/task_notification` and tugcode brackets
 * the wake via `buildWakeStartedMessage`. The JSONL persists the
 * envelope text instead, so the replay translator recognizes it and
 * synthesizes the equivalent IPC `wake_started` frame.
 *
 * Match is anchored at start (after leading whitespace) — defensive
 * against a runaway prose user entry that just happens to contain
 * the literal `<task-notification>` somewhere in its body. Returns
 * `null` for any non-envelope content.
 */
const TASK_NOTIFICATION_OPEN_RE = /^\s*<task-notification>/;
const TASK_ID_RE = /<task-id>([^<]*)<\/task-id>/;
const TASK_SUMMARY_RE = /<summary>([^<]*)<\/summary>/;

export function extractTaskNotificationWake(
  text: string,
): ReplayWakeTrigger | null {
  if (!TASK_NOTIFICATION_OPEN_RE.test(text)) return null;
  const taskIdMatch = TASK_ID_RE.exec(text);
  const summaryMatch = TASK_SUMMARY_RE.exec(text);
  return {
    taskId: taskIdMatch?.[1] ?? "",
    summary: summaryMatch?.[1] ?? "",
  };
}

// ---------------------------------------------------------------------------
// Per-entry translator
// ---------------------------------------------------------------------------

/**
 * Top-level entry types whose surveyed semantics is "skip silently".
 * These either represent Claude bookkeeping (`attachment` references,
 * scheduling markers, file-history snapshots, auto-generated titles)
 * or surface state that's already represented elsewhere on the live
 * wire (`system` mirrors `session_init` / `system_metadata`,
 * `permission-mode` rides the chrome layer).
 */
const SKIPPED_TOP_LEVEL_TYPES: ReadonlySet<string> = new Set([
  "attachment",
  "queue-operation",
  "last-prompt",
  "file-history-snapshot",
  "ai-title",
  "system",
  "permission-mode",
  // Terminal-app transcripts open with a `mode` record (the TUI's
  // normal/plan toggle) — chrome state, not transcript content.
  "mode",
]);

/**
 * `assistant` `stop_reason` values that close a cycle cleanly — the
 * turn finished and the terminal `turn_complete { result: "success" }`
 * fires. These are the API's non-continuation stop reasons:
 *
 *   - `end_turn`       claude finished its response normally
 *   - `stop_sequence`  a configured stop sequence was hit
 *   - `max_tokens`     the response hit the output-token ceiling
 *   - `refusal`        claude declined to continue
 *
 * `tool_use` and `pause_turn` are NOT here — the cycle legitimately
 * continues (a tool result or a resumed turn follows). A `null` /
 * absent `stop_reason` is likewise non-terminal (the JSONL was
 * truncated mid-stream). The Step 20.5.B.1 corpus audit found only
 * `end_turn` and `stop_sequence` in practice; `max_tokens` / `refusal`
 * are included because they are valid API terminals a future session
 * could carry. Recognising all four keeps a last turn that ended on a
 * non-`end_turn` terminal from being mislabelled `interrupted` by the
 * `synthesizeDanglingTerminal` synthetic ([replay-1]).
 */
const TERMINAL_STOP_REASONS: ReadonlySet<string> = new Set([
  "end_turn",
  "stop_sequence",
  "max_tokens",
  "refusal",
]);

/**
 * Normalise a JSONL `message.content` field into a block array.
 *
 * Claude Code persists a plain-text message as a bare STRING
 * `message.content`, not the usual `[{ type: "text", … }]` array — a
 * `user` submission with no attachments is the common case (~280 such
 * entries across the surveyed corpus). Iterating that string with the
 * per-entry `for…of` content walk yields its *characters*, each a
 * non-block that falls through, so the text is silently dropped. (The
 * assistant side is block-array in every surveyed JSONL; the string
 * branch covers it defensively.) Wrapping a string as one synthetic
 * `text` block lets both content walks treat it uniformly. A non-string
 * `content` (the array shape, or absent) passes through unchanged.
 */
function contentBlocks(
  rawContent: string | ReadonlyArray<JsonlContentBlock> | undefined,
): ReadonlyArray<JsonlContentBlock> {
  if (typeof rawContent === "string") {
    return [{ type: "text", text: rawContent }];
  }
  return rawContent ?? [];
}

/**
 * Tag prefixes Claude Code wraps slash-command scaffolding in when it
 * persists the interaction as `user` JSONL entries: the `<command-name>`
 * / `<command-message>` / `<command-args>` markers of a slash
 * invocation and the `<local-command-stdout>` / `<local-command-caveat>`
 * output blocks. These are CLI-internal bookkeeping.
 *
 * The `<command-*>` envelope is the exception ({@link isCommandEnvelope}):
 * it is the ONLY persisted record of what the user typed when they
 * submitted a slash command, so it replays as a genuine submission.
 * See {@link isCommandEnvelope} for why.
 */
const COMMAND_SCAFFOLDING_PREFIXES: readonly string[] = [
  "<command-name>",
  "<command-message>",
  "<command-args>",
  "<local-command-stdout>",
  "<local-command-caveat>",
];

/** Matches one `<command-message|name|args>…</…>` envelope tag. */
const COMMAND_ENVELOPE_TAG_RE =
  /<command-(?:message|name|args)>[\s\S]*?<\/command-(?:message|name|args)>/g;

/**
 * True when a bare-string `message.content` is Claude Code's
 * slash-command **envelope** — the record it writes in place of the
 * literal the user typed:
 *
 * ```
 * <command-message>NAME</command-message>
 * <command-name>/NAME</command-name>
 * <command-args>ARGS</command-args>
 * ```
 *
 * This is the user's submission, not bookkeeping. Nothing else in the
 * JSONL carries it: the expanded skill body that follows is `isMeta`
 * (skipped), and a command with no expansion (`/compact`, `/model`)
 * leaves the envelope plus a `<local-command-stdout>` line and nothing
 * more. Skipping it — as every `<command-*>`-prefixed string once was —
 * erased the user's row from a resumed transcript entirely: after a
 * relaunch the `/compact` the user typed simply vanished, and the
 * assistant's reply to a `/tugplug:…` skill invocation replayed as an
 * assistant-originated opener with no prompt above it.
 *
 * Surfacing the envelope verbatim is what makes replay match live:
 * tugdeck's `detectCommandEcho` (`lib/command-atom.ts`) parses exactly
 * this shape back into the command chip + argument chips the composer
 * showed on submit.
 *
 * Requires `<command-name>` and requires the string to be ONLY envelope
 * tags plus whitespace — the same both-signals gate `detectCommandEcho`
 * applies, so prose that merely quotes the tags is left to the ordinary
 * text path.
 */
function isCommandEnvelope(text: string): boolean {
  if (!text.includes("<command-name>")) return false;
  return text.replace(COMMAND_ENVELOPE_TAG_RE, "").trim() === "";
}

/** Reads the `<command-name>` out of a slash-command envelope. */
const COMMAND_ENVELOPE_NAME_RE = /<command-name>\s*([^<\s]+)\s*<\/command-name>/;

/**
 * Slash commands the **bridge** issues on the user's behalf, so their
 * envelope is machinery rather than a submission.
 *
 * `/model` is the whole list. The session card never sends `/model` as a
 * prompt — it is a local command that opens the AI mixer, and the model
 * change itself travels as a `set_model` control_request
 * (`SessionManager.handleModelChange`). claude services that request by
 * writing a `/model` envelope into the JSONL anyway, once per change and
 * once more per card mount when the restore effect re-applies the
 * remembered model. Live, nothing of that reaches the transcript; on
 * replay the envelope would surface as a user row the first run never
 * showed — a wart that multiplies with every relaunch.
 */
const BRIDGE_ISSUED_COMMANDS: readonly string[] = ["/model"];

/** True when {@link isCommandEnvelope} names a {@link BRIDGE_ISSUED_COMMANDS} command. */
function isBridgeIssuedCommandEnvelope(text: string): boolean {
  if (!isCommandEnvelope(text)) return false;
  const name = COMMAND_ENVELOPE_NAME_RE.exec(text)?.[1];
  return name !== undefined && BRIDGE_ISSUED_COMMANDS.includes(name);
}

/** Reads the `<command-args>` out of a slash-command envelope. */
const COMMAND_ENVELOPE_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;

/**
 * A submission's text as the sender put it on the wire — which is not always
 * what the JSONL holds.
 *
 * Claude Code rewrites a slash command into its `<command-*>` envelope before
 * it writes the record, so the literal `/tugplug:arc-implement foo Steps 4-13`
 * that went out comes back as three tags. Put back together, name then args,
 * it is the sent text again — and that is what {@link WheelPromptLedger}
 * matches on, since Tug's record holds what Tug sent.
 *
 * Everything else is the concatenation of the entry's text blocks, which is
 * the same rule the translator uses to build the submission itself.
 */
function submissionAsSent(content: readonly unknown[]): string {
  const text = content
    .map((block) => {
      const b = block as { type?: unknown; text?: unknown };
      return b.type === "text" && typeof b.text === "string" ? b.text : "";
    })
    .join("");
  if (!isCommandEnvelope(text.trimStart())) return text;
  const name = COMMAND_ENVELOPE_NAME_RE.exec(text)?.[1];
  if (name === undefined) return text;
  const args = COMMAND_ENVELOPE_ARGS_RE.exec(text)?.[1] ?? "";
  return args.length > 0 ? `${name} ${args}` : name;
}

/**
 * Tug's record of what the **wheel** put on the wire, spent one prompt at a
 * time as a replay walks the JSONL.
 *
 * The wheel speaks in the transcript under its own name. Claude's JSONL cannot
 * say so — that file is claude's, and it records a prompt the wheel sent
 * exactly as it records one the user typed — so tugcast writes down every
 * prompt the wheel sends (`wheel_prompts` in `sessions.db`) and the replay
 * reads it back here. Authorship is therefore *stated*, from the sender's own
 * record, rather than guessed from where a prompt happens to sit in the file.
 *
 * A **claim** is a match against the remaining record, not a position: the
 * first submission whose sent text is still held is the wheel's, and holding
 * it is then spent. That is what lets one ledger span a card's whole lineage —
 * several JSONL files, replayed in order, with the user's own prompts
 * interleaved — and stay right when a file in the middle is unreadable and
 * skipped. Two identical prompts spend two records, in the order they are met.
 */
export interface WheelPromptLedger {
  /**
   * True when `text` is one of the wheel's unspent prompts, which also spends
   * it. False for the user's own words, and for the wheel's Nth repeat of a
   * prompt it only sent N-1 times.
   */
  claim(text: string): boolean;
}

/**
 * Build a {@link WheelPromptLedger} over the texts tugcast recorded, oldest
 * first. An empty list answers `false` to everything, which is what makes a
 * card no arc ever drove cost nothing.
 */
export function wheelPromptLedger(texts: readonly string[]): WheelPromptLedger {
  const unspent = new Map<string, number>();
  for (const text of texts) unspent.set(text, (unspent.get(text) ?? 0) + 1);
  return {
    claim(text: string): boolean {
      const left = unspent.get(text);
      if (left === undefined || left === 0) return false;
      if (left === 1) unspent.delete(text);
      else unspent.set(text, left - 1);
      return true;
    },
  };
}

/**
 * True when a `user` entry's bare-string `message.content` is NOT a
 * genuine transcript submission, so the translator skips it rather
 * than surfacing it as a turn:
 *
 *   - the `isCompactSummary` continuation block (the "This session is
 *     being continued…" summary a `/compact` injects) — CLI-internal
 *     continuation context, hidden in Claude Code's own UI;
 *   - slash-command scaffolding ({@link COMMAND_SCAFFOLDING_PREFIXES}).
 *
 * Surfacing these would inject junk orphan turns into a resumed
 * transcript (a `/compact` alone persists four-plus consecutive
 * scaffolding strings). A genuine plain-text submission returns
 * `false` and is normalised to a text block by {@link contentBlocks}.
 */
function isNonSubmissionUserString(entry: JsonlEntry, text: string): boolean {
  if (entry.isCompactSummary === true) {
    return true;
  }
  const trimmed = text.trimStart();
  if (isBridgeIssuedCommandEnvelope(trimmed)) {
    return true;
  }
  if (
    !isCommandEnvelope(trimmed) &&
    COMMAND_SCAFFOLDING_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
  ) {
    return true;
  }
  // The `<task-notification>` envelope is also non-submission — the
  // runtime injected it to wake claude with the prior tool's result.
  // The replay translator recognizes it separately so it can
  // synthesize a `wake_started` IPC frame ([D07] wake
  // discriminator); both the envelope text AND the add_user_message
  // are suppressed in that path.
  return extractTaskNotificationWake(text) !== null;
}

/**
 * Per-call options for {@link translateJsonlEntry}.
 *
 * Threaded by the session-level loop when peek-ahead detects shape
 * variants the per-entry translator can't see on its own.
 */
export interface TranslateJsonlEntryOptions {
  /**
   * When true, the per-entry translator skips emitting `turn_complete`
   * for an `assistant` entry whose `stop_reason` is a clean terminal
   * ({@link TERMINAL_STOP_REASONS}), leaving the open-turn tracker
   * (`ctx.openTurnMsgId`) unchanged so a following same-msg_id entry's
   * content frames land in the same logical turn.
   *
   * The session-level loop sets this when the immediately-following
   * non-skipped JSONL entry is another `assistant` entry sharing the
   * current entry's `message.id`. Claude Code's SDK occasionally
   * persists a single assistant message across multiple JSONL records
   * (one snapshot when the thinking block was complete, another when
   * the text block was complete), with both records carrying
   * `stop_reason: "end_turn"`. Without suppression the leading entry
   * would emit a terminal `turn_complete` and clear `openTurnMsgId`,
   * causing the trailing entry's content emits to find no open turn
   * (the reducer's `activeMsgId` would then be set by the trailing
   * entry's first content event, and the trailing entry's terminal
   * would dedupe-drop) — fragile, observable as a stale `pendingTurn`
   * after `replay_complete`. Suppression keeps exactly one
   * `turn_complete` at the end of the run.
   */
  suppressTurnComplete?: boolean;
  /**
   * Tug's record of what the wheel put on the wire, for the line this file
   * belongs to. A submission this entry emits that the record still holds is
   * the wheel's words rather than the user's, and carries `origin: "wheel"`.
   *
   * Claimed at the emit site, so only a genuine submission spends a record —
   * an entry the translator skips leaves the wheel's prompt for the entry
   * that really carries it.
   */
  wheelPrompts?: WheelPromptLedger;
}

/**
 * Translate one JSONL entry into 0..N outbound messages. Pure with
 * respect to external state; the only mutation is on the passed `ctx`.
 *
 * Invariants (per [D13]'s per-entry direct emission discipline):
 *   - A `user` entry with `text` content emits exactly one
 *     `add_user_message{text, attachments}` (text blocks within the
 *     entry concatenate; one entry → one frame). `message.content`
 *     may be a bare string (a plain-text submission persisted without
 *     the block-array wrapper) — {@link contentBlocks} normalises it;
 *     a bare-string entry that is Claude Code scaffolding (slash-
 *     command markers, the `/compact` summary) is skipped outright,
 *     and a `<task-notification>` envelope emits `wake_started`
 *     instead (see {@link extractTaskNotificationWake}).
 *   - A `user` entry with `tool_result` blocks emits one
 *     `tool_result` outbound per block immediately. The reducer
 *     pairs them with the prior `tool_use` by `tool_use_id`; no
 *     translator-side buffering is needed.
 *   - An `assistant` entry emits its content frames immediately,
 *     keyed on its own `message.id`. Multi-message claude cycles
 *     (text → tool_use → tool_result → second text) produce two
 *     separately-keyed assistant streams on the wire — one per
 *     `message.id`. That matches the live shape (one id per claude
 *     message; no canonicalization).
 *   - An `assistant` entry whose `stop_reason` is a clean terminal
 *     ({@link TERMINAL_STOP_REASONS}) additionally emits a terminal
 *     `turn_complete` and increments `ctx.turnsCommitted` (which feeds
 *     `replay_complete.count`), UNLESS `options.suppressTurnComplete`
 *     is true (set by the session-level loop when peek-ahead detects a
 *     same-msg_id continuation entry; see {@link TranslateJsonlEntryOptions}).
 *     A terminal `turn_complete` clears `ctx.openTurnMsgId`.
 *   - The opener (`add_user_message` or `wake_started`) is emitted
 *     by the user entry that mints it — not by the assistant entry
 *     that follows. Under [D13]'s per-entry direct emission discipline,
 *     each entry maps to its own IPC events with no cross-entry
 *     buffering. Multiple consecutive user-text entries each get
 *     their own committed turn (orphan-synthesis closes the prior
 *     before the next opener fires).
 *   - A `SKIPPED_TOP_LEVEL_TYPES` entry returns `[]` immediately.
 *   - Anything else falls into the `unknown_shape` skip path.
 */
/**
 * Translate a `queued_command` attachment — a steered mid-turn message
 * ([P07]/Step 6) — into a **mid-turn** `add_user_message`. Unlike a turn
 * opener ({@link handleUserEntry}), this deliberately does NOT close the
 * open turn (`emitOrphanIfOpen`) or mint a new opener id: the message was
 * merged INTO the running turn, so the turn stays open and the assistant's
 * continuation after it belongs to the same turn. The reducer's reload
 * fork in `handleAddUserMessage` appends it to the in-flight turn because
 * a turn is still open (`pendingTurn !== null`) at this point in the
 * bracket. No `promptUuid` is carried — `/rewind` stays anchored on the
 * turn opener ([P05]). Only `commandMode: "prompt"` (a plain steered
 * message) is surfaced; other modes (e.g. a queued slash command) skip.
 */
function handleQueuedCommandEntry(entry: JsonlEntry): OutboundMessage[] {
  if (entry.attachment?.commandMode !== "prompt") return [];
  const submittedContent: ContentBlock[] = [];
  for (const block of contentBlocks(entry.attachment?.prompt)) {
    const blockType = typeof block.type === "string" ? block.type : "";
    if (blockType === "text" && typeof block.text === "string") {
      submittedContent.push({ type: "text", text: block.text });
    } else if (blockType === "image") {
      const source = block.source ?? {};
      const mediaType =
        typeof source.media_type === "string" ? source.media_type : "image/png";
      const data = typeof source.data === "string" ? source.data : "";
      submittedContent.push({
        type: "image",
        source: { type: "base64", media_type: mediaType, data },
      });
    }
  }
  if (submittedContent.length === 0) return [];
  return [
    {
      type: "add_user_message",
      content: submittedContent,
      timestamp: parseEntryTimestamp(entry),
      ipc_version: IPC_VERSION,
    },
  ];
}

export function translateJsonlEntry(
  entry: JsonlEntry,
  ctx: TranslateContext,
  options?: TranslateJsonlEntryOptions,
): OutboundMessage[] {
  const topType = typeof entry.type === "string" ? entry.type : "";
  // A steered mid-turn message persists ONLY as a `queued_command`
  // attachment (no `type: "user"` row). Intercept before the blanket
  // `attachment` skip so reload reconstructs the steered user row
  // ([P07]/Step 6). Other attachment subtypes still skip below.
  if (topType === "attachment" && entry.attachment?.type === "queued_command") {
    return handleQueuedCommandEntry(entry);
  }
  // A `compact_boundary` system record marks a compaction point. `system` is
  // skipped wholesale below, so intercept the boundary first and emit the
  // divider frame carrying the pre-compaction context size. Purely emissive:
  // it never opens a turn, latches `openTurnMsgId`, or triggers orphan
  // synthesis — the summary that follows (`isCompactSummary`) does the same.
  if (topType === "system" && entry.subtype === "compact_boundary") {
    return [
      {
        type: "compact_boundary",
        trigger: entry.compactMetadata?.trigger,
        pre_tokens: entry.compactMetadata?.preTokens,
        post_tokens: entry.compactMetadata?.postTokens,
        timestamp: parseEntryTimestamp(entry),
        ipc_version: IPC_VERSION,
      },
    ];
  }
  if (SKIPPED_TOP_LEVEL_TYPES.has(topType)) {
    return [];
  }

  if (topType === "user") {
    return handleUserEntry(entry, ctx, options);
  }

  if (topType === "assistant") {
    return handleAssistantEntry(entry, ctx, options);
  }

  ctx.telemetry.unknownShape({ kind: "top_level", type: topType || "<missing>" });
  return [];
}

/**
 * SDK auto-injected "interrupt-marker" sentinel.
 *
 * When a turn is interrupted (Stop button, Cmd-Q resume, or — the
 * symptom this guard addresses — the user denying a pending
 * `control_request_forward`), the SDK writes a synthetic `user` JSONL
 * entry whose `content[0].text` carries one of these phrases:
 *
 *   - `"[Request interrupted by user]"` — plain interrupt.
 *   - `"[Request interrupted by user for tool use]"` — interrupt fired
 *     while a permission/question was pending; the SDK appends
 *     `" for tool use"` so the AI can distinguish the two cases.
 *
 * Surveyed in the archived tugtalk protocol survey §2b ("control_request
 * interrupt sends on stdin, CLI acknowledges, injects
 * `[Request interrupted by user]`, emits a proper `result` event") and
 * verified across the SDK v2.1.x JSONL corpus (31 markers, both forms
 * present; 2026-05-06 + 2026-05-23 incident reports).
 *
 * The marker text *is* the SDK's wire contract here — there is no
 * separate `{ "interrupt_marker": true }` field. We disambiguate against
 * a hypothetical real user submission that happens to type the same
 * string by pairing the text prefix with a structural signal: every
 * real user submission carries a `permissionMode` field (stamped by
 * Claude Code's input layer); the SDK-injected marker does not. Both
 * signals must agree for the entry to be treated as a sentinel — a
 * defense-in-depth check that fails closed (the worst-case is a
 * phantom turn re-appearing, not silent data loss).
 */
const INTERRUPT_MARKER_PREFIX = "[Request interrupted by user";

/**
 * Test whether a `user` JSONL entry is the SDK's interrupt-marker
 * sentinel. Both signals must agree:
 *
 *   1. **Text prefix** — the entry's single text block starts with
 *      `"[Request interrupted by user"` and ends with `"]"`, in one of
 *      the documented forms (exact, or with a space-prefixed
 *      `<suffix>` before the closing bracket).
 *   2. **Structural** — the entry has no `permissionMode` field,
 *      because the SDK does not stamp `permissionMode` on its own
 *      auto-injected markers (only the user-input path does).
 *
 * Both-signals-must-agree means a hypothetical user typing the exact
 * marker text as a chat message still rounds-trip correctly (the
 * `permissionMode` field on their submission flunks the structural
 * check, so the text matches but the entry is NOT swallowed). If the
 * SDK ever drops `permissionMode` from real submissions, this matcher
 * fails *closed* in the safe direction — we miss the marker and the
 * phantom-turn symptom returns, but no real user message gets lost.
 */
function isInterruptMarkerEntry(entry: JsonlEntry, text: string): boolean {
  if (!text.startsWith(INTERRUPT_MARKER_PREFIX)) return false;
  if (!text.endsWith("]")) return false;
  // Exact match for the base form is OK; the suffix form requires a
  // space between the prefix and the content before `"]"`. This
  // distinguishes the marker from a defensive coincidental match like
  // `"[Request interrupted by userX]"`.
  if (text !== `${INTERRUPT_MARKER_PREFIX}]`) {
    const after = text.slice(INTERRUPT_MARKER_PREFIX.length, -1);
    if (!after.startsWith(" ") || after.length <= 1) return false;
  }
  // Structural disambiguator: real user submissions carry
  // `permissionMode`; the SDK-injected marker does not. See the
  // module comment on `INTERRUPT_MARKER_PREFIX` for the wire-corpus
  // evidence.
  return entry.permissionMode === undefined;
}

/**
 * Per-entry translator for `user` JSONL entries. Direct emit, no
 * cross-entry buffering — each entry maps to its own IPC events per
 * [D13]:
 *
 *   - **`<task-notification>` envelope** (bare-string `message.content`
 *     matching {@link extractTaskNotificationWake}): close any open
 *     turn (orphan synthesis), emit `wake_started{wake_trigger}`, set
 *     `openTurnMsgId` to a synthesized `w-<n>`. Live tugcode never
 *     sees this envelope on the wire — the SDK lifts the same event as
 *     `system/task_notification`. The JSONL persists the envelope text
 *     so replay synthesizes the equivalent `wake_started` frame.
 *   - **Scaffolding** (slash-command markers, `/compact` summary):
 *     skip outright. CLI-internal bookkeeping, not transcript
 *     submissions.
 *   - **Text content** (`text` blocks, concatenated within the entry
 *     per [D13]; optional `image` attachments): close any open turn,
 *     emit `add_user_message{text, attachments}`, set `openTurnMsgId`
 *     to a synthesized `u-<n>`. The synthesized id is translator-
 *     internal — `add_user_message` carries no `msg_id` per [D15].
 *   - **`tool_result` blocks**: emit `tool_result` per block (and one
 *     `tool_use_structured` for the entry's first `tool_use_id` when
 *     the entry-level `toolUseResult` is present). These are mid-turn
 *     events inside the currently open turn (claude's tool-use loop);
 *     they do NOT touch `openTurnMsgId`.
 *   - **Interrupt-marker sentinel** ({@link isInterruptMarkerEntry}):
 *     drop. The orphan-synthesis path at the next opener (or EOF)
 *     closes any open turn naturally — the marker itself is a
 *     non-event under [D13]'s model.
 *
 * The opener path closes any prior open turn BEFORE emitting the new
 * opener. Multiple consecutive openers without an assistant terminal
 * in between (the interrupted-mid-submission case) each fire orphan
 * synthesis for the prior, leaving every turn cleanly bracketed on
 * the wire.
 */
function handleUserEntry(
  entry: JsonlEntry,
  ctx: TranslateContext,
  options?: TranslateJsonlEntryOptions,
): OutboundMessage[] {
  const out: OutboundMessage[] = [];
  const rawContent = entry.message?.content;

  // SDK-injected bookkeeping entry. Image coordinate / source-path
  // hints, skill body loaders, `/loop` content imports — none are
  // user submissions. Surfacing any of them as an `add_user_message`
  // would (a) inject a pseudo-prompt row into the transcript and (b)
  // close the prior real turn as `interrupted` via orphan synthesis.
  // See `JsonlEntry.isMeta` for the surveyed shape inventory.
  if (entry.isMeta === true) return out;

  // Goal-evaluator feedback (`isSynthetic`) — harness-injected, not a
  // user submission. See {@link JsonlEntry.isSynthetic}.
  if (entry.isSynthetic === true) return out;

  // Bare-string `message.content` shapes: scaffolding (skip), the
  // `<task-notification>` wake envelope (emit `wake_started`), or a
  // plain-text submission (fall through to the block-walk below).
  if (typeof rawContent === "string") {
    // The compaction summary record — emit it as a `compact_summary` frame so
    // reload restores the carry-forward block. Ordered right after the
    // `compact_boundary` frame (the boundary record precedes it in the JSONL).
    // No opener, no orphan synthesis, no turn-state change.
    if (entry.isCompactSummary === true) {
      out.push({
        type: "compact_summary",
        summary: rawContent,
        ipc_version: IPC_VERSION,
      });
      return out;
    }
    const trimmed = rawContent.trimStart();
    // The `<command-*>` envelope IS the user's submission — it falls
    // through to the block walk below and opens a turn like any other
    // prompt, unless the bridge issued it rather than the user
    // ({@link isBridgeIssuedCommandEnvelope}). Every other scaffolding
    // string is CLI bookkeeping.
    if (isBridgeIssuedCommandEnvelope(trimmed)) {
      return out;
    }
    if (
      !isCommandEnvelope(trimmed) &&
      COMMAND_SCAFFOLDING_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
    ) {
      return out;
    }
    const wake = extractTaskNotificationWake(rawContent);
    if (wake !== null) {
      // New opener: close any prior open turn first, then emit
      // wake_started. The synthesized `w-<n>` is translator-internal
      // (`wake_started` carries no `msg_id` on the wire); it reaches
      // the wire only via the orphan-synthesis `turn_complete` AND
      // only when no content event arrives to swap it.
      out.push(...emitOrphanIfOpen(ctx, entry));
      out.push({
        type: "wake_started",
        session_id: "",
        wake_trigger: {
          task_id: wake.taskId,
          tool_use_id: "",
          status: "completed",
          summary: wake.summary,
          output_file: "",
        },
        ipc_version: IPC_VERSION,
      });
      ctx.openTurnMsgId = mintOpenerId(ctx, "w");
      ctx.openTurnLocalCommand = false;
      return out;
    }
    // Fall through: plain-text submission. `contentBlocks` wraps it
    // as a single text block for the walk below.
  }

  const content = contentBlocks(rawContent);
  // Submitted content blocks for the `add_user_message` frame —
  // preserves interleaving (text / image / text / image …) verbatim
  // from JSONL, which is Anthropic's canonical storage format. Per
  // Step 5c.
  const submittedContent: ContentBlock[] = [];
  const textParts: string[] = [];
  let hasImage = false;
  // First `tool_use_id` seen — used to bind the entry-level
  // `toolUseResult` payload (when present) to its initiating
  // tool_use on the `tool_use_structured` IPC frame. Mirrors
  // `session.ts` `firstToolUseId` on the live path.
  let firstToolUseId = "";
  // Buffer tool_result emissions separately from the opener decision
  // — they bind to the currently open turn (the assistant's prior
  // tool_use), so they emit BEFORE any orphan-synthesis trigger from
  // a new opener within the same entry (defensive against a future
  // hybrid entry shape).
  const toolResultFrames: OutboundMessage[] = [];

  for (const block of content) {
    const blockType = typeof block.type === "string" ? block.type : "";
    if (blockType === "text") {
      if (typeof block.text === "string") {
        textParts.push(block.text);
        submittedContent.push({ type: "text", text: block.text });
      }
      continue;
    }
    if (blockType === "tool_result") {
      const toolUseId =
        typeof block.tool_use_id === "string" ? block.tool_use_id : "";
      if (toolUseId.length === 0) {
        // Stray tool_result without its initiating tool_use is a
        // malformed JSONL signal; drop silently rather than emit a
        // dangling frame.
        continue;
      }
      if (firstToolUseId.length === 0) firstToolUseId = toolUseId;
      const isError = block.is_error === true;
      const output = coerceToolResultContent(block.content);
      const toolResult: ToolResult = {
        type: "tool_result",
        tool_use_id: toolUseId,
        output,
        is_error: isError,
        timestamp: parseEntryTimestamp(entry),
        ipc_version: IPC_VERSION,
      };
      toolResultFrames.push(toolResult);
      continue;
    }
    if (blockType === "image") {
      const source = block.source ?? {};
      const mediaType =
        typeof source.media_type === "string" ? source.media_type : "image/png";
      const data = typeof source.data === "string" ? source.data : "";
      submittedContent.push({
        type: "image",
        source: { type: "base64", media_type: mediaType, data },
      });
      hasImage = true;
      continue;
    }
    if (blockType.length === 0) {
      // Empty block type — `user` entries with no content (sometimes
      // a bare `{role: "user", content: []}` shows up in JSONLs) are
      // benign no-ops. Don't fire telemetry for them.
      continue;
    }
    ctx.telemetry.unknownShape({ kind: "content_block", type: blockType });
  }

  // Entry-level `toolUseResult` (camelCase, JSONL persistence shape;
  // wire-side equivalent is the snake_case `tool_use_result` field
  // session.ts forwards as `structured_result`). Emit one
  // `tool_use_structured` frame paired with the first tool_result's
  // tool_use_id. Without this, replayed Read tool calls land in the
  // reducer with `structuredResult: null`, and the Read tool wrapper
  // has no clean `file.content` to render — the body comes up empty.
  const toolUseResult = entry.toolUseResult;
  if (toolUseResult !== undefined && firstToolUseId.length > 0) {
    const structured: ToolUseStructured = {
      type: "tool_use_structured",
      tool_use_id: firstToolUseId,
      tool_name:
        typeof toolUseResult.toolName === "string"
          ? toolUseResult.toolName
          : "",
      structured_result: toolUseResult,
      ipc_version: IPC_VERSION,
    };
    toolResultFrames.push(structured);
  }

  // Emit tool_result + tool_use_structured frames first — they bind
  // to the currently open turn (the assistant's prior tool_use call),
  // so they MUST land before any orphan-synthesis trigger fires from
  // a new opener within the same entry. In every surveyed JSONL,
  // text and tool_result do NOT mix within a single user entry, but
  // the ordering is defensive against a future hybrid shape.
  out.push(...toolResultFrames);

  // Combine text blocks within this single entry — multi-block within
  // one user entry is the same submission and concatenates per [D13]
  // ("the translator emits one `add_user_message` per user JSONL
  // entry — never more").
  const entryText = textParts.join("");

  // Sentinel: claude's "[Request interrupted by user ...]" marker in
  // any of its known forms (see `isInterruptMarkerEntry`). Drop the
  // marker outright. The orphan-synthesis path at the next opener
  // (or EOF) handles any open-turn closure naturally — under [D13]'s
  // model the marker is a non-event, not the orphan trigger it was
  // under the cycle-pairing apparatus.
  if (isInterruptMarkerEntry(entry, entryText) && !hasImage) {
    return out;
  }

  // No opener content: a tool_result-only entry (mid-turn) or a
  // benign empty user entry. Return whatever tool_result frames we
  // gathered (possibly none); do NOT touch openTurnMsgId.
  if (submittedContent.length === 0) {
    return out;
  }

  // New opener: close any prior open turn first, then emit
  // add_user_message. Multiple consecutive user-text entries with no
  // assistant cycle between them are structural orphans — each gets
  // its own committed turn rather than a concatenated submission.
  // Post-Step-5c: emit the interleaved content blocks verbatim from
  // JSONL; tugdeck's wrapper walks them through
  // `synthesizeUserMessageFromBlocks` to produce the substrate.
  out.push(...emitOrphanIfOpen(ctx, entry));
  out.push({
    type: "add_user_message",
    content: submittedContent,
    timestamp: parseEntryTimestamp(entry),
    // `/rewind` anchor ([#step-7-1]). The JSONL `user` record's `uuid` is
    // claude's prompt-record id — the value `rewind_files.user_message_id`
    // takes and the JSONL truncation boundary. Carry it so a resumed /
    // cold-booted session-card recovers each turn's anchor from the replay.
    ...(typeof entry.uuid === "string" && entry.uuid.length > 0
      ? { promptUuid: entry.uuid }
      : {}),
    // Stated, never inferred: the wheel's own record says which submissions it
    // sent, and claiming one here is what spends it. Every other frame omits
    // the field for the reader to default.
    ...(options?.wheelPrompts?.claim(submissionAsSent(submittedContent)) === true
      ? { origin: "wheel" as const }
      : {}),
    ipc_version: IPC_VERSION,
  });
  ctx.openTurnMsgId = mintOpenerId(ctx, "u");
  ctx.openTurnLocalCommand =
    typeof rawContent === "string" && isCommandEnvelope(rawContent.trimStart());
  return out;
}

/**
 * Coerce a `tool_result.content` field — which may be a string or a
 * structured array of content blocks — into a plain string suitable
 * for `ToolResult.output`. The live `ToolResult` outbound shape
 * carries a single string; replay flattens structured tool_result
 * content via JSON.stringify rather than synthesizing a richer
 * shape, since the tugdeck side already accepts string output.
 */
function coerceToolResultContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (content === null || content === undefined) {
    return "";
  }
  if (Array.isArray(content)) {
    // Structured tool_result content: array of `{type: "text", text: "..."}`
    // blocks (or other shapes). Concatenate text blocks; fall back to
    // JSON for anything else.
    const parts: string[] = [];
    let allText = true;
    for (const item of content) {
      if (
        item !== null &&
        typeof item === "object" &&
        (item as { type?: unknown }).type === "text" &&
        typeof (item as { text?: unknown }).text === "string"
      ) {
        parts.push((item as { text: string }).text);
      } else {
        allText = false;
        break;
      }
    }
    if (allText) {
      return parts.join("");
    }
  }
  try {
    return JSON.stringify(content);
  } catch {
    return "";
  }
}

/**
 * Per-entry translator for `assistant` JSONL entries. Emits the
 * entry's content blocks (one `content_block_start` + kind-specific
 * terminal per block, in arrival order) and, on a clean terminal
 * `stop_reason`, a `turn_complete` keyed on the entry's `msg_id`.
 *
 * Calls {@link noteContentMsgId} at every msg_id-bearing emit so the
 * open-turn tracker flips from a synthesized opener id to claude's
 * real `msg_id` on the FIRST content event of the turn. The orphan-
 * synthesis path (at next-opener boundary or EOF) reads
 * `openTurnMsgId` to decide the orphan `turn_complete`'s msg_id:
 *
 *   - content arrived → real `msg_id` → reducer matches normally;
 *   - no content → synthesized opener id → reducer's no-content
 *     fallback commits `pendingTurn`.
 *
 * On a clean terminal, clears `openTurnMsgId` (matched commit). The
 * `suppressTurnComplete` option defers the terminal when peek-ahead
 * detects the SDK split a single assistant message across two
 * same-msg_id JSONL records — the trailing record fires the single
 * terminal.
 *
 * The cycle-pairing apparatus (`pendingUserText`, `pendingUserAttachments`,
 * `cycleOpen`, `cycleMsgId`, `pendingWakeFromReplay`) is gone per
 * [D13]; the assistant entry no longer mints any opener — the opener
 * already fired from {@link handleUserEntry}.
 */
function handleAssistantEntry(
  entry: JsonlEntry,
  ctx: TranslateContext,
  options?: TranslateJsonlEntryOptions,
): OutboundMessage[] {
  const content = contentBlocks(entry.message?.content);
  const stopReason = entry.message?.stop_reason ?? null;
  const entryMsgId =
    typeof entry.message?.id === "string" ? entry.message.id : "";

  const out: OutboundMessage[] = [];

  // Assistant-originated opener: an `assistant` entry arriving with no
  // open turn (the JSONL opens with an assistant; the prior turn closed;
  // or a skipped entry like `isCompactSummary` swallowed the user side)
  // needs a `pendingTurn` to commit onto. Open an HONEST
  // assistant-originated turn (`tuglaws/turn-metric.md` S02) — no user
  // message is fabricated. This replaces the old synthesized empty
  // `add_user_message{content:[]}`, which rendered as a phantom `#u`
  // user row for content the user never submitted (`--continue` leading
  // orphans, `/compact` continuations). The turn now renders
  // assistant-only (`#a`); the reducer opens an empty message scratch
  // for it just as it does for a wake.
  if (ctx.openTurnMsgId === null) {
    const opener: AssistantOpener = {
      type: "assistant_opener",
      timestamp: parseEntryTimestamp(entry),
      ipc_version: IPC_VERSION,
    };
    out.push(opener);
    ctx.openTurnMsgId = mintOpenerId(ctx, "a");
    ctx.openTurnLocalCommand = false;
  }

  // Capture per-block records preserving the JSONL's arrival order.
  // Each block is keyed by its position in `message.content` (the
  // block_index), which mirrors the live wire's
  // `content_block_start.index` numbering. Per [D07], the reducer
  // mints a Message at each `(msg_id, block_index)` and appends
  // terminal text/tool content into the same Message — so the replay
  // path emits one content_block_start + terminal frame per block, in
  // arrival order, to reconstruct the same `messages` sequence the
  // live path would produce.
  //
  // **Per-msg_id block-index offset.** When one `message.id` spans
  // multiple JSONL entries (e.g. thinking-only then text-only — see
  // session ecc343d8 / `TranslateContext.blockCountByMsgId`), each
  // entry's `content[]` array re-starts its local index at 0. The
  // wire delivered those blocks with CONSECUTIVE indices though, and
  // the reducer's idempotent mint keys on `(msg_id, block_index)`. We
  // start this entry's emitted block_index at the running count for
  // this `msg_id` (default 0 for the first entry) and bump it once
  // the per-block emit loop finishes — preserving the wire's
  // consecutive-index discipline across entry boundaries.
  type BlockRecord =
    | { index: number; kind: "text"; text: string }
    | { index: number; kind: "thinking"; text: string }
    | { index: number; kind: "tool_use"; toolUseId: string; toolName: string; input: unknown };
  const blocks: BlockRecord[] = [];
  const baseBlockIndex = entryMsgId.length > 0
    ? ctx.blockCountByMsgId.get(entryMsgId) ?? 0
    : 0;
  let localBlockIndex = 0;

  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    const blockType = typeof block.type === "string" ? block.type : "";
    if (blockType === "text") {
      const text = typeof block.text === "string" ? block.text : "";
      blocks.push({ index: baseBlockIndex + localBlockIndex, kind: "text", text });
      localBlockIndex += 1;
      continue;
    }
    if (blockType === "thinking") {
      // Tolerate a handful of older JSONL shapes that put the thinking
      // text in the `text` field on a `thinking` block.
      const text =
        typeof block.thinking === "string"
          ? block.thinking
          : typeof block.text === "string"
            ? block.text
            : "";
      blocks.push({ index: baseBlockIndex + localBlockIndex, kind: "thinking", text });
      localBlockIndex += 1;
      continue;
    }
    if (blockType === "tool_use") {
      const toolUseId = typeof block.id === "string" ? block.id : "";
      const toolName = typeof block.name === "string" ? block.name : "";
      const input = block.input ?? {};
      // Skip tool_use blocks with no id — they can't be paired with a
      // tool_result and are useless to the reducer.
      if (toolUseId.length > 0) {
        blocks.push({
          index: baseBlockIndex + localBlockIndex,
          kind: "tool_use",
          toolUseId,
          toolName,
          input,
        });
        localBlockIndex += 1;
      }
      continue;
    }
    if (blockType === "image") {
      // Assistants don't normally produce image content blocks; skip
      // with an unknown_shape signal so a future shape change is
      // observable.
      ctx.telemetry.unknownShape({
        kind: "content_block",
        type: "image (in assistant entry)",
      });
      continue;
    }
    if (blockType.length === 0) {
      continue;
    }
    ctx.telemetry.unknownShape({ kind: "content_block", type: blockType });
  }

  // Bump the per-msg_id block count by the number of blocks this
  // entry contributed. A trailing same-msg_id continuation entry will
  // start its block_index at this updated count.
  if (entryMsgId.length > 0 && localBlockIndex > 0) {
    ctx.blockCountByMsgId.set(entryMsgId, baseBlockIndex + localBlockIndex);
  }

  // Emit per-block events in arrival order: content_block_start (mints
  // the reducer's Message) followed by the kind-specific terminal
  // frame. All keyed on this entry's `message.id` (claude's id; no
  // canonicalization). At every msg_id-bearing emit, call
  // `noteContentMsgId` so the open-turn tracker flips from the
  // synthesized opener id (`u-<n>` or `w-<n>`) to claude's real
  // `msg_id` on the FIRST content event — see [D13]'s wire-truth
  // update rule.
  for (const block of blocks) {
    // Construct kind-specific content_block_start; the discriminated
    // union narrows tool_use_id / tool_name to required strings only
    // for the tool_use variant.
    const blockStart: ContentBlockStart =
      block.kind === "tool_use"
        ? {
            type: "content_block_start",
            msg_id: entryMsgId,
            block_index: block.index,
            kind: "tool_use",
            tool_use_id: block.toolUseId,
            tool_name: block.toolName,
            timestamp: parseEntryTimestamp(entry),
            ipc_version: IPC_VERSION,
          }
        : {
            type: "content_block_start",
            msg_id: entryMsgId,
            block_index: block.index,
            kind: block.kind,
            timestamp: parseEntryTimestamp(entry),
            ipc_version: IPC_VERSION,
          };
    out.push(blockStart);
    noteContentMsgId(ctx, entryMsgId);

    if (block.kind === "text") {
      if (block.text.length > 0) {
        const assistant: AssistantText = {
          type: "assistant_text",
          msg_id: entryMsgId,
          block_index: block.index,
          seq: ctx.globalSeq++,
          rev: 0,
          text: block.text,
          is_partial: false,
          status: "complete",
          ipc_version: IPC_VERSION,
        };
        out.push(assistant);
        noteContentMsgId(ctx, entryMsgId);
      }
    } else if (block.kind === "thinking") {
      if (block.text.length > 0) {
        const thinking: ThinkingText = {
          type: "thinking_text",
          msg_id: entryMsgId,
          block_index: block.index,
          seq: ctx.globalSeq++,
          text: block.text,
          is_partial: false,
          status: "complete",
          ipc_version: IPC_VERSION,
        };
        out.push(thinking);
        noteContentMsgId(ctx, entryMsgId);
      }
    } else if (block.kind === "tool_use") {
      const toolUse: ToolUse = {
        type: "tool_use",
        msg_id: entryMsgId,
        seq: ctx.globalSeq++,
        tool_name: block.toolName,
        tool_use_id: block.toolUseId,
        input:
          typeof block.input === "object" && block.input !== null
            ? (block.input as object)
            : {},
        timestamp: parseEntryTimestamp(entry),
        ipc_version: IPC_VERSION,
      };
      out.push(toolUse);
      noteContentMsgId(ctx, entryMsgId);
    } else {
      // Exhaustiveness check — a future BlockRecord kind that the
      // upstream parser added but this terminal emitter forgot to
      // handle fails at compile.
      const _exhaustive: never = block;
      throw new Error(`unknown BlockRecord kind: ${JSON.stringify(_exhaustive)}`);
    }
  }

  // Cycle terminal: on a clean terminal `stop_reason`
  // (`TERMINAL_STOP_REASONS` — `end_turn`, `stop_sequence`,
  // `max_tokens`, `refusal`), AND only when the session-level loop
  // hasn't asked us to defer. Suppression applies when peek-ahead
  // identified a same-msg_id continuation entry — claude's SDK split a
  // single assistant message across two JSONL records (each carrying
  // the terminal stop_reason), and we want exactly one `turn_complete`
  // to land at the end of the run rather than two (the second of which
  // the reducer would dedupe, stranding pending state). `tool_use`,
  // `pause_turn`, and a null / absent stop_reason are non-terminal —
  // the cycle legitimately continues. Bumps `turnsCommitted` so
  // `replay_complete.count` reflects committed cycles; clears
  // `openTurnMsgId` so the next opener starts fresh.
  if (
    stopReason !== null &&
    TERMINAL_STOP_REASONS.has(stopReason) &&
    options?.suppressTurnComplete !== true
  ) {
    const turnComplete: TurnComplete = {
      type: "turn_complete",
      msg_id: entryMsgId,
      seq: ctx.globalSeq++,
      result: "success",
      timestamp: parseEntryTimestamp(entry),
      // Reconstruct the turn's cost from the closing entry's own
      // `usage` — the last-iteration resident-context figure the live
      // `cost_update` froze (#emit-point). This is the JSONL-authoritative
      // cost the reducer commits onto `TurnEntry.cost` ([P02]).
      telemetry: buildReplayTurnTelemetry(
        extractTurnCostFromUsage(entry.message?.usage),
        ctx.sessionInitTokens,
        "complete",
      ),
      ipc_version: IPC_VERSION,
    };
    out.push(turnComplete);
    ctx.turnsCommitted += 1;
    ctx.openTurnMsgId = null;
    // Per-msg_id block-count tracking is meaningful only within a
    // single turn; clear it at the terminal turn_complete so a future
    // assistant entry that happens to reuse this `msg_id` (e.g. a
    // resume scenario or a defensive replay) starts its block_index
    // discipline from 0 again.
    if (entryMsgId.length > 0) {
      ctx.blockCountByMsgId.delete(entryMsgId);
    }
  }

  return out;
}

// Per-message flushing makes a separate "in-flight trailing turn"
// flush at end-of-JSONL unnecessary: each `assistant` entry emits its
// content frames immediately when its line is processed, regardless of
// `stop_reason`. The trailing entry of an unfinished cycle has already
// emitted; only the cycle-terminal `turn_complete` is absent (because
// `stop_reason` was not a clean terminal). The live drain continuing
// post-replay produces the eventual `turn_complete` naturally when
// claude's `result` lands. The translateJsonlSession loop body no
// longer needs an EOF-time flush for assistant content — but it does
// flush a stranded trailing user-only orphan on a cold resume; see
// `synthesizeDanglingTerminal`.

// ---------------------------------------------------------------------------
// Session-level async iterator
// ---------------------------------------------------------------------------

/**
 * Discriminated input shape for `translateJsonlSession`. The
 * resume-spawn flow produces one of these by attempting to read the
 * JSONL file; the translator threads the outcome into the
 * `replay_started` / `replay_complete` bracket pair without needing
 * any filesystem awareness itself.
 */
export type ReplayInput =
  | {
      kind: "ok";
      jsonl: string;
      /**
       * Claude's per-session id (matches the JSONL filename). Threaded
       * through so the synthesized `system_metadata` IPC emitted at the
       * top of replay can carry the right `session_id`. Optional —
       * tests that don't care about the synthesized frame can omit it
       * and the field defaults to "" downstream.
       */
      claudeSessionId?: string;
      /**
       * Background-agent transcripts discovered beside the main JSONL
       * ({@link SubagentTranscript}). When a parent `Agent` `tool_use` is
       * emitted during replay, its transcript's tool calls are spliced in
       * as `parent_tool_use_id`-tagged children so a resumed session
       * restores the agent's work (which lives out-of-band and is not in
       * the main JSONL). Absent/empty ⇒ byte-identical to legacy replay.
       */
      subagents?: SubagentTranscript[];
    }
  | { kind: "missing"; message?: string }
  | { kind: "unreadable"; message: string };

export interface TranslateSessionOptions {
  /** Continuous-work budget before the translate loop yields the
   * event loop once. Default: {@link DEFAULT_TIME_SLICE_MS} (8ms).
   * The slice keeps the IPC pipe responsive on whale-sized sessions
   * without taxing the common case (a medium session translates in
   * ~2ms — zero yields), and deliberately stays coarse (not zero) as
   * the flood guard for the broadcast channel while delivery remains
   * per-frame. */
  timeSliceMs?: number;
  /** Clock for the time-slice check. Default `performance.now`.
   * Tests inject a fake to force or forbid slice expiry
   * deterministically. */
  now?: () => number;
  /** Test seam — invoked immediately before each event-loop yield.
   * Lets tests observe that (and how often) the slice fired without
   * racing real timers. Production never sets it. */
  onYield?: () => void;
  /** Telemetry sink. Default: stderr-forwarding. Tests inject a
   * capturing sink. */
  telemetry?: ReplayTelemetry;
  /** Disable the time-slice yield entirely. Tests set this to keep
   * the translate synchronous; production never sets it. */
  disableYield?: boolean;
  /**
   * When `true`, an open turn at EOF that no live turn will resolve
   * is committed via {@link emitOrphanIfOpen} before `replay_complete`
   * rather than left stranded. Under [D13]'s unified open-turn
   * tracker, both pre-Step-5.6 EOF cases — a dangling assistant cycle
   * ([replay-1]) and a trailing user-only orphan ([W2]) — collapse
   * into the same path: if `ctx.openTurnMsgId !== null` at EOF, emit
   * one `turn_complete{result: "interrupted"}` carrying that id.
   *
   * The id naturally selects the reducer-side commit path:
   *   - dangling cycle (content arrived, no clean terminal): the
   *     `noteContentMsgId` rule swapped `openTurnMsgId` to claude's
   *     real `msg_id`, so the reducer's `handleTurnComplete` matches
   *     on `activeMsgId` and commits the partial content;
   *   - trailing orphan (no content): `openTurnMsgId` is the
   *     synthesized opener id (`u-<n>` / `w-<n>`), and the reducer's
   *     no-content fallback (`#spec-reducer-state` rule 2) commits
   *     `pendingTurn`.
   *
   * `runReplay` sets this from the absence of a live `ActiveTurn`:
   * `true` on a cold resume (no live turn will continue the JSONL),
   * `false` on reload-mid-stream (a live `ActiveTurn` is still
   * producing the turn / carrying the trailing submission, and the
   * live drain delivers the real `turn_complete`). Default `false` —
   * the safe choice for any caller that hasn't reasoned about live
   * continuation.
   */
  synthesizeDanglingTerminal?: boolean;
  /**
   * Recency window. When present, the translator emits only the
   * requested committed-turn range — `{ lastTurns: N }` for the most
   * recent N turns, or `{ turnRange: [start, end) }` for an explicit
   * half-open range — and reports the window on `replay_complete`
   * (`firstLoadedTurnIndex` / `totalTurns` / `hasOlder`). Absent ⇒ the
   * whole session (the unbounded legacy behavior, no metadata).
   *
   * Turn boundaries are located by {@link computeTurnStartIndices}, a
   * dry run of the real per-entry translator, so the window edge can't
   * drift from the emit path across same-`message.id` continuations and
   * orphan-synthesized turns.
   */
  window?: ReplayWindow;
  /**
   * Tug's record of the prompts the wheel sent on this card's line — see
   * {@link WheelPromptLedger}. Shared across every file of a lineage replay,
   * so one ledger spans the whole restore and no prompt is claimed twice.
   * Absent ⇒ nothing is attributed to the wheel, which is every replay of a
   * card no arc ever drove.
   */
  wheelPrompts?: WheelPromptLedger;
}

/**
 * Result returned by `translateJsonlSession`'s AsyncGenerator (the
 * value reachable via `.next()` when `done: true`, also typed as the
 * generator's `TReturn` parameter).
 *
 * `count` mirrors the per-wire `replay_complete.count` and counts
 * every turn committed via `turn_complete` — both clean terminals
 * (`{result: "success"}`, one per `assistant` JSONL entry whose
 * `stop_reason` is in {@link TERMINAL_STOP_REASONS}) and orphan
 * synthesizes (`{result: "interrupted"}`, emitted by
 * {@link emitOrphanIfOpen} when a new opener arrives or at EOF).
 *
 * EOF behavior depends on {@link TranslateSessionOptions.synthesizeDanglingTerminal}:
 * `false` leaves an open turn for the live drain (the post-replay
 * `turn_complete` lands when claude's `result` arrives); `true` emits
 * the orphan synthetic so a cold-resumed session commits its final
 * turn instead of stranding an in-flight row.
 */
export interface TranslateSessionResult {
  count: number;
}

/**
 * Walk forward from `start` (inclusive, up to `limit` exclusive)
 * returning the index of the next entry the per-entry translator would
 * process — skipping nulls (empty / malformed lines) and
 * `SKIPPED_TOP_LEVEL_TYPES` entries (claude bookkeeping the translator
 * silently drops). Returns `-1` when no such entry exists.
 *
 * The peek is needed to detect the same-`message.id` continuation case
 * (see {@link continuationSuppressed}). `limit` lets a windowed pass
 * stop peeking at its own upper edge.
 */
function nextSignificantIndex(
  parsedEntries: ReadonlyArray<JsonlEntry | null>,
  start: number,
  limit: number = parsedEntries.length,
): number {
  for (let j = start; j < limit; j++) {
    const e = parsedEntries[j];
    if (e === null) continue;
    const t = typeof e.type === "string" ? e.type : "";
    if (SKIPPED_TOP_LEVEL_TYPES.has(t)) continue;
    return j;
  }
  return -1;
}

/**
 * Whether the entry at `i` is the leading half of a same-`message.id`
 * continuation — two consecutive `assistant` entries sharing a
 * `message.id` (the SDK split one assistant message across two JSONL
 * records). The leading entry's terminal `turn_complete` must be
 * deferred so the trailing record's content lands in the same turn and
 * exactly one terminal fires. `limit` bounds the peek so a windowed
 * pass never reaches across its own upper edge.
 */
function continuationSuppressed(
  parsedEntries: ReadonlyArray<JsonlEntry | null>,
  i: number,
  limit: number = parsedEntries.length,
): boolean {
  const parsed = parsedEntries[i];
  if (
    parsed === null ||
    parsed.type !== "assistant" ||
    typeof parsed.message?.id !== "string" ||
    parsed.message.id.length === 0
  ) {
    return false;
  }
  const currentMsgId = parsed.message.id;
  const nextIdx = nextSignificantIndex(parsedEntries, i + 1, limit);
  if (nextIdx === -1) return false;
  const next = parsedEntries[nextIdx]!;
  return (
    next.type === "assistant" &&
    typeof next.message?.id === "string" &&
    next.message.id === currentMsgId
  );
}

/**
 * Locate the JSONL entry index at which each committed turn begins, by
 * dry-running the real per-entry translator over a throwaway context
 * and watching its opener-id counter — which bumps exactly once per
 * turn open (a user/wake opener, or the synthesized opener an
 * `assistant` entry mints when no turn is open). Reusing the real
 * translator — rather than re-deriving turn boundaries — keeps the
 * window edge in lockstep with the emit path across the tricky cases
 * (same-`message.id` continuations, orphan-synthesized turns), so a
 * window never splits or duplicates a turn at its edge.
 *
 * Returns one entry per committed turn, in order: its JSONL `startIndex`
 * and its `messages` count — the number of transcript rows the turn
 * produces (matching the dev transcript's row model so the window can be
 * sized, and numbered, in *messages* rather than turns). A turn always
 * contributes its one assistant row (the eventual `turn_complete`); a
 * turn that emits an `add_user_message` (a user/synth opener — not a
 * wake) also contributes a user row, so `messages` is `2`, else `1`.
 *
 * Total length is the session's committed-turn count. The throwaway
 * context uses a no-op telemetry sink so the scan doesn't double-count
 * the malformed/unknown-shape signals the real pass already reports.
 *
 * The scan walks every entry (its cost is O(total) translate work with
 * no emit / IPC), so the bounded win is on the emit + downstream side;
 * a turn-boundary index that bounds even this scan is a measured
 * follow-on.
 */
interface TurnInfo {
  /** JSONL entry index at which this turn opens. */
  startIndex: number;
  /** Transcript rows this turn produces: 2 (user + assistant) or 1 (wake). */
  messages: number;
  /**
   * Intrinsic origin of the turn (`tuglaws/turn-metric.md` S01) — `"user"`
   * for a genuine user submission (emits `add_user_message`), `"assistant"`
   * for a wake / continuation / orphan (emits `wake_started` /
   * `assistant_opener`). The real-corpus contract (#step-7) compares this
   * to the Rust engine's per-turn origin.
   */
  origin: "user" | "assistant";
}

function computeTurns(
  parsedEntries: ReadonlyArray<JsonlEntry | null>,
): TurnInfo[] {
  const scanCtx = makeTranslateContext(NOOP_TELEMETRY);
  const turns: TurnInfo[] = [];
  for (let i = 0; i < parsedEntries.length; i++) {
    const parsed = parsedEntries[i];
    if (parsed === null) continue;
    const suppressTurnComplete = continuationSuppressed(parsedEntries, i);
    const before = scanCtx.orphanCounter;
    const msgs = translateJsonlEntry(parsed, scanCtx, { suppressTurnComplete });
    if (scanCtx.orphanCounter > before) {
      // This entry opened a new turn. It carries a user row iff it
      // emitted an `add_user_message` (a genuine user submission); a wake
      // (`wake_started`) or an orphan assistant (`assistant_opener`) opens
      // an assistant-originated turn → assistant row only, no `#u`. The
      // turn's assistant row is the +1 every committed turn earns from its
      // eventual `turn_complete`.
      const hasUserRow = msgs.some((m) => m.type === "add_user_message");
      turns.push({
        startIndex: i,
        messages: hasUserRow ? 2 : 1,
        origin: hasUserRow ? "user" : "assistant",
      });
    }
  }
  return turns;
}

/**
 * Dead-branch detection: which entries are OFF the session's live parent
 * chain and must not replay.
 *
 * Claude's session JSONL is append-only and `parentUuid`-threaded — a
 * tree, not a list. History edits never remove bytes; they abandon them:
 *   - the REPL's pre-response Escape drops the aborted prompt from its
 *     in-memory history, leaving the persisted record as an orphan
 *     (`parentUuid` chain no later entry points into);
 *   - a conversation rewind (`/rewind` from a terminal,
 *     `--resume-session-at`) branches: the next submission parents to an
 *     ancestor, stranding everything after the branch point as a dead
 *     branch.
 * Claude itself resumes by walking the chain from the newest leaf, so
 * dead entries never re-enter its context. A flat scan replays them as
 * phantom turns — this walk computes the same live set claude uses.
 *
 * Algorithm: walk `parentUuid` upward from the LAST uuid-bearing entry
 * (the newest leaf — the file is append-only, so the tail is live).
 * When a walk terminates at a compaction record (`compact_boundary`
 * system entry, or a continuation summary), the chain has hit a
 * `/compact` break, not the session start: bridge backwards to the last
 * uuid-bearing entry BEFORE the compaction (by file position) and keep
 * walking — pre-compaction history is display-relevant even though it
 * left claude's context.
 *
 * Off-chain alone is NOT dead. Real files carry benign mid-turn spurs
 * that sit off the strict ancestor chain — hook-result `attachment`
 * records, an occasional `tool_result` user record whose sibling
 * carried the chain forward, an abandoned API-retry `assistant` branch
 * — and, crucially, whole null-parent SEGMENTS: a session restart
 * writes its first submission with `parentUuid: null` mid-file, and
 * everything before a `/compact` break is disconnected from the live
 * tail by construction. All of that is legitimate transcript content
 * the flat scan has always shown.
 *
 * What must not replay is an abandoned BRANCH: a subtree rooted at a
 * genuine user submission whose parent IS on the live chain — the
 * exact shape a conversation rewind strands (the next submission
 * parents to an ancestor, bypassing the branch). Requiring a live
 * parent is what separates a rewound-away turn from a restart segment
 * (whose root has no parent at all): a REPL-escape orphan with a null
 * parent therefore stays visible — flat parity; rare, and honest — and
 * Tug's own retraction never produces one (it truncates the bytes).
 * The dead set is the descendant closure of live-parented off-chain
 * user-submission roots, nothing else.
 *
 * Exemptions: entries with no `uuid` (bookkeeping — `last-prompt`,
 * `queue-operation`, `file-history-snapshot`, …) and sidechain entries
 * (`isSidechain: true` — they root their own chains mid-file) are never
 * marked dead.
 *
 * A uuid is NOT unique in the file. Claude Code re-appends a
 * compaction's preserved messages verbatim — same `uuid`, later
 * position — so a uuid can name several records. Parent resolution
 * therefore has to respect the append-only invariant every part of this
 * walk rests on: **a parent always precedes its child**. Resolving a
 * `parentUuid` to the file's LAST occurrence instead of the newest one
 * before the child sends the ancestor walk FORWARD into the re-appended
 * copy, where it immediately meets an already-live entry and stops. The
 * segment root is then an ordinary `assistant` record rather than a
 * compaction record, no bridge fires, and the walk ends with most of the
 * session unvisited — after which the dead-roots rule below sweeps that
 * genuinely-live history away as abandoned branches. Observed on a real
 * 9-compaction session: 980 of 5082 entries dropped, including every
 * turn of the most recent day's work ([L23]).
 */
export function computeDeadEntryIndices(
  parsedEntries: ReadonlyArray<JsonlEntry | null>,
): Set<number> {
  // Index the chain participants: uuid-bearing, non-sidechain entries.
  // `occurrencesByUuid` holds EVERY position a uuid appears at, ascending
  // — a compaction re-append makes duplicates routine.
  const occurrencesByUuid = new Map<string, number[]>();
  const childIndices = new Map<string, number[]>();
  const chainIndices: number[] = [];
  for (let i = 0; i < parsedEntries.length; i++) {
    const entry = parsedEntries[i];
    if (entry === null) continue;
    if (entry.isSidechain === true) continue;
    if (typeof entry.uuid !== "string" || entry.uuid.length === 0) continue;
    const at = occurrencesByUuid.get(entry.uuid);
    if (at === undefined) occurrencesByUuid.set(entry.uuid, [i]);
    else at.push(i);
    chainIndices.push(i);
    if (typeof entry.parentUuid === "string") {
      const siblings = childIndices.get(entry.parentUuid);
      if (siblings === undefined) childIndices.set(entry.parentUuid, [i]);
      else siblings.push(i);
    }
  }
  if (chainIndices.length === 0) return new Set();

  /**
   * Resolve `parentUuid` for a child at `childIndex` — the newest
   * occurrence strictly BEFORE the child. `undefined` when the uuid is
   * unknown or appears only later (a forward edge is not a parent).
   * Occurrence lists are ascending by construction, so this is a
   * binary search for the rightmost entry below `childIndex`.
   */
  const resolveParent = (
    childIndex: number,
    parentUuid: string,
  ): number | undefined => {
    const at = occurrencesByUuid.get(parentUuid);
    if (at === undefined) return undefined;
    let lo = 0;
    let hi = at.length - 1;
    let found: number | undefined;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (at[mid] < childIndex) {
        found = at[mid];
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  };

  const isCompactionRecord = (entry: JsonlEntry): boolean =>
    (entry.type === "system" && entry.subtype === "compact_boundary") ||
    entry.isCompactSummary === true;

  // Live = the ancestor closure of the newest leaf, bridged backwards
  // across /compact chain breaks.
  const live = new Set<number>();
  let cursor: number | undefined = chainIndices[chainIndices.length - 1];
  while (cursor !== undefined) {
    // Walk this segment's chain upward. The `live` check breaks cycles
    // (corrupt files) and stops when a bridge merges into an
    // already-live entry.
    let rootIndex: number = cursor;
    let walk: number | undefined = cursor;
    while (walk !== undefined && !live.has(walk)) {
      live.add(walk);
      rootIndex = walk;
      const parent: string | null | undefined =
        parsedEntries[walk]?.parentUuid;
      walk =
        typeof parent === "string" ? resolveParent(walk, parent) : undefined;
    }
    // Segment root reached. A compaction root means the chain broke at
    // a `/compact` — bridge to the newest chain entry before it.
    const rootEntry = parsedEntries[rootIndex];
    cursor = undefined;
    if (rootEntry !== null && rootEntry !== undefined && isCompactionRecord(rootEntry)) {
      for (let j = chainIndices.length - 1; j >= 0; j--) {
        const candidate = chainIndices[j];
        if (candidate < rootIndex && !live.has(candidate)) {
          cursor = candidate;
          break;
        }
      }
    }
  }

  // A genuine user submission: string content, or blocks with at least
  // one non-tool_result block. Mirrors the anchor test in
  // `computeConversationTruncation` — a tool_result echo or a
  // bookkeeping record never roots an abandoned turn.
  const isUserSubmission = (entry: JsonlEntry): boolean => {
    if (entry.type !== "user") return false;
    const content = entry.message?.content;
    if (typeof content === "string") return content.length > 0;
    if (!Array.isArray(content)) return false;
    return content.some((b) => b?.type !== "tool_result");
  };

  // Dead roots: off-chain user submissions whose parent is LIVE — true
  // branch points. Their descendant closure is off-chain by
  // construction (live is an ancestor closure), so the BFS needs no
  // re-check.
  const dead = new Set<number>();
  const queue: number[] = [];
  for (const i of chainIndices) {
    if (live.has(i)) continue;
    const entry = parsedEntries[i];
    if (entry === null || !isUserSubmission(entry)) continue;
    const parentIndex =
      typeof entry.parentUuid === "string"
        ? resolveParent(i, entry.parentUuid)
        : undefined;
    if (parentIndex !== undefined && live.has(parentIndex)) queue.push(i);
  }
  while (queue.length > 0) {
    const i = queue.pop()!;
    if (dead.has(i)) continue;
    dead.add(i);
    const uuid = parsedEntries[i]?.uuid;
    if (typeof uuid !== "string") continue;
    for (const child of childIndices.get(uuid) ?? []) {
      // `childIndices` is keyed by uuid, so a re-appended duplicate's
      // children are pooled with this record's. Descend only into the
      // children that actually parent to THIS occurrence.
      if (resolveParent(child, uuid) !== i) continue;
      if (!dead.has(child)) queue.push(child);
    }
  }
  return dead;
}

/**
 * True when a `user` entry is the `/compact` invocation envelope.
 */
function isCompactCommandEntry(entry: JsonlEntry): boolean {
  if (entry.type !== "user") return false;
  const content = entry.message?.content;
  if (typeof content !== "string") return false;
  const trimmed = content.trimStart();
  return isCommandEnvelope(trimmed) && trimmed.includes("<command-name>/compact<");
}

/**
 * Move the `/compact` invocation envelope ahead of its `compact_boundary`
 * record, in place.
 *
 * Claude Code writes the compaction *result* first — the boundary record
 * and the continuation summary — and only then the scaffolding for the
 * `/compact` the user typed to cause it. (The `parentUuid` chain says the
 * same: the envelope parents to the last pre-compaction entry, while the
 * summary parents to the boundary.) Replayed in file order, the "Session
 * compacted" divider would sit ABOVE the user's own `/compact` row —
 * inverted from what the live session showed.
 *
 * The scan stops at the first entry that opens a turn of its own, so it
 * only ever reaches across the compaction's own scaffolding.
 */
function hoistCompactCommandEnvelope(
  parsedEntries: Array<JsonlEntry | null>,
): void {
  for (let i = 0; i < parsedEntries.length; i++) {
    const entry = parsedEntries[i];
    if (entry === null) continue;
    if (entry.type !== "system" || entry.subtype !== "compact_boundary") continue;
    for (let j = i + 1; j < parsedEntries.length; j++) {
      const candidate = parsedEntries[j];
      if (candidate === null) continue;
      if (isCompactCommandEntry(candidate)) {
        parsedEntries.splice(j, 1);
        parsedEntries.splice(i, 0, candidate);
        break;
      }
      // A turn-opening entry means the compaction's scaffolding is behind
      // us — the envelope isn't there to hoist.
      if (candidate.type === "assistant") break;
      if (
        candidate.type === "user" &&
        candidate.isMeta !== true &&
        candidate.isCompactSummary !== true &&
        typeof candidate.message?.content === "string" &&
        !COMMAND_SCAFFOLDING_PREFIXES.some((p) =>
          candidate.message!.content!.toString().trimStart().startsWith(p),
        )
      ) {
        break;
      }
    }
  }
}

/**
 * Suppress compaction re-appends: for every uuid appearing more than once,
 * exactly one occurrence survives — the earliest one not already nulled.
 * Mutates `parsedEntries` in place, nulling the rest, and returns how many
 * it suppressed.
 *
 * Claude Code re-appends a compaction's preserved messages verbatim (same
 * `uuid`, same content, a later file position). The first occurrence sits
 * at the turn's true chronological position; a re-append is a copy with
 * stale context. Replaying both paints each preserved turn twice.
 *
 * "Earliest not-yet-nulled" rather than simply "first" is what makes this
 * composable with dead-branch nulling: where an original occurrence was
 * legitimately swept as a dead branch, its re-appended copy is live
 * preserved content and must still emit.
 *
 * The suppression domain is exactly {@link computeDeadEntryIndices}'
 * index domain — chain entries, i.e. uuid-bearing and non-sidechain.
 * Sidechain records root their own chains mid-file and can share a uuid
 * with a main-chain record; they are never suppressed, and never suppress.
 */
function suppressReappendDuplicates(
  parsedEntries: Array<JsonlEntry | null>,
): number {
  const seen = new Set<string>();
  let suppressed = 0;
  for (let i = 0; i < parsedEntries.length; i++) {
    const entry = parsedEntries[i];
    if (entry === null) continue;
    if (entry.isSidechain === true) continue;
    if (typeof entry.uuid !== "string" || entry.uuid.length === 0) continue;
    if (seen.has(entry.uuid)) {
      parsedEntries[i] = null;
      suppressed++;
    } else {
      seen.add(entry.uuid);
    }
  }
  return suppressed;
}

/**
 * The **effective record sequence**: the entries segmentation and replay
 * both operate on. Nulls, in place, every entry that is either on a dead
 * branch or a re-appended duplicate occurrence, and returns the two counts.
 *
 * This composition is the whole point — the canonical turn count
 * (`tuglaws/turn-metric.md`) must equal what the transcript renders, so
 * whatever replay skips, segmentation must skip too. `translateJsonlSession`
 * and {@link segmentJsonlOrigins} therefore both start here, as does the
 * Rust engine via `tugcast/src/dead_branch.rs`.
 *
 * Order matters: dead-branch detection runs first and over ALL occurrences,
 * because occurrence-aware parent resolution needs the full occurrence
 * lists. Suppression then picks the earliest surviving occurrence.
 */
function nullNonEffectiveEntries(parsedEntries: Array<JsonlEntry | null>): {
  dead: number;
  suppressed: number;
} {
  const deadIndices = computeDeadEntryIndices(parsedEntries);
  for (const idx of deadIndices) {
    parsedEntries[idx] = null;
  }
  return {
    dead: deadIndices.size,
    suppressed: suppressReappendDuplicates(parsedEntries),
  };
}

/**
 * The real-corpus contract's tugcode side (#step-7): segment a whole JSONL
 * string into the ordered per-turn origin list `["user" | "assistant", …]`
 * by dry-running the real translator (`computeTurns`) over the effective
 * record sequence. The Rust engine (`tugcast/src/turn_engine.rs`) produces
 * the same list over the same file; the contract asserts they are equal
 * per-turn (origin + ordinal).
 */
export function segmentJsonlOrigins(
  jsonl: string,
): Array<"user" | "assistant"> {
  const parsedEntries: Array<JsonlEntry | null> = jsonl
    .split("\n")
    .map((raw) => {
      const line = raw.trim();
      if (line.length === 0) return null;
      try {
        return JSON.parse(line) as JsonlEntry;
      } catch {
        return null;
      }
    });
  nullNonEffectiveEntries(parsedEntries);
  return computeTurns(parsedEntries).map((t) => t.origin);
}

/**
 * Resolve a {@link ReplayWindow} against the located turn boundaries
 * into the concrete JSONL entry range `[startIndex, endIndex)` to emit
 * plus the metadata to report. The window is sized in turns —
 * `{ lastTurns: N }` loads the most recent N turns, `{ turnRange }` an
 * explicit range. A window covering the whole session yields
 * `hasOlder: false` (load-all).
 *
 * Reports `firstLoadedTurnIndex` (for backward paging — the next older
 * request) and the turn-based window metadata. Turns are the only unit on
 * the wire — there is no row counting here.
 */
function resolveWindow(
  window: ReplayWindow,
  turns: ReadonlyArray<TurnInfo>,
  entryCount: number,
): {
  startIndex: number;
  endIndex: number;
  firstLoadedTurnIndex: number;
  totalTurns: number;
  hasOlder: boolean;
} {
  const totalTurns = turns.length;

  let firstTurn: number;
  let endTurn: number; // exclusive
  if ("lastTurns" in window) {
    // Most recent N committed turns directly — the canonical unit, no row
    // accumulation. `firstLoadedTurnIndex` falls out as the clamped start.
    const n = Math.max(0, Math.floor(window.lastTurns));
    firstTurn = Math.max(0, totalTurns - n);
    endTurn = totalTurns;
  } else {
    // Explicit half-open turn range. Backward paging ("load previous N")
    // sends `[firstLoadedTurnIndex − N, firstLoadedTurnIndex]` — the
    // emitted range is exactly those turns, which prepend above the view.
    const [rawStart, rawEnd] = window.turnRange;
    firstTurn = Math.max(0, Math.min(Math.floor(rawStart), totalTurns));
    endTurn = Math.max(firstTurn, Math.min(Math.floor(rawEnd), totalTurns));
  }
  const startIndex =
    firstTurn < totalTurns ? turns[firstTurn].startIndex : entryCount;
  const endIndex =
    endTurn < totalTurns ? turns[endTurn].startIndex : entryCount;
  return {
    startIndex,
    endIndex,
    firstLoadedTurnIndex: firstTurn,
    totalTurns,
    hasOlder: firstTurn > 0,
  };
}

/**
 * Translate a complete JSONL replay session into a stream of
 * OutboundMessages bracketed by `replay_started` /
 * `replay_complete`.
 *
 * The bracket pair is *always* emitted, regardless of whether the
 * JSONL is missing, unreadable, malformed, or empty — the reducer's
 * `replaying` phase is gated on the bracket events, so omitting one
 * would leave the card stuck. On the error branches the
 * `replay_complete` carries an `error` payload identifying the
 * failure mode; tugdeck surfaces this via `lastReplayResult`.
 *
 * The loop yields the event loop on a TIME budget, not a count: after
 * `timeSliceMs` (default 8ms) of continuous work it awaits one
 * macrotask so the IPC writer can drain and inbound verbs stay
 * responsive. A medium session translates inside a single slice
 * (zero yields); a whale pays a handful — not the hundreds of forced
 * idles the old per-16-messages pacing cost (~600ms at 8k messages).
 */
/**
 * Yield the child frames for the background agent launched by
 * `parentToolUseId` — and, recursively, for any nested agent among those
 * children (a nested `Agent` `tool_use` owns its own transcript). `consumed`
 * guards against splicing a transcript more than once (a re-emitted parent
 * `tool_use`, or a defensive cycle). Nesting resolves by enumeration:
 * because a nested agent's own `tool_use` is itself yielded here, its
 * transcript matches on the recursive call — no depth walk needed.
 */
/**
 * Collect the `Agent` `tool_use.id`s that were launched in the BACKGROUND —
 * a `user` entry whose `toolUseResult` is the async-launch echo (`isAsync ===
 * true` or `status === "async_launched"`). The linkage id is the entry's first
 * `tool_result` block's `tool_use_id`.
 *
 * The child SPLICE is not gated on this set — every parent with a
 * `subagents/` transcript is spliced (foreground children live only
 * there too). This set gates the narrower echo-structured drop: an
 * async parent's persisted `tool_use_structured` is just the empty
 * launch echo and must not clobber the splice's composed answer,
 * whereas a foreground parent's structured frame is the REAL result
 * and must survive.
 */
function collectAsyncAgentToolUseIds(
  parsedEntries: ReadonlyArray<JsonlEntry | null>,
): Set<string> {
  const ids = new Set<string>();
  for (const entry of parsedEntries) {
    if (entry === null || entry.type !== "user") continue;
    const tur = entry.toolUseResult;
    const isAsync =
      tur !== undefined &&
      (tur.isAsync === true || tur.status === "async_launched");
    if (!isAsync) continue;
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        block.type === "tool_result" &&
        typeof block.tool_use_id === "string" &&
        block.tool_use_id.length > 0
      ) {
        ids.add(block.tool_use_id);
        break;
      }
    }
  }
  return ids;
}

function* spliceSubagentChildren(
  parentToolUseId: string,
  byParent: ReadonlyMap<string, SubagentTranscript>,
  consumed: Set<string>,
  nextSeq: () => number,
): Generator<OutboundMessage> {
  if (consumed.has(parentToolUseId)) return;
  const transcript = byParent.get(parentToolUseId);
  if (transcript === undefined) return;
  consumed.add(parentToolUseId);
  for (const frame of synthesizeSubagentChildFrames(transcript, nextSeq)) {
    yield frame;
    if (frame.type === "tool_use") {
      yield* spliceSubagentChildren(
        frame.tool_use_id,
        byParent,
        consumed,
        nextSeq,
      );
    }
  }
  // Restore the agent's own final answer + stats. The persisted Agent result
  // on the main JSONL is only the async-launch echo (no content); the caller
  // drops that echo's structured frame, so this composed one is the sole
  // writer of the Agent's `structuredResult`.
  const structured: ToolUseStructured = {
    type: "tool_use_structured",
    tool_use_id: parentToolUseId,
    tool_name: "Agent",
    structured_result: composeAgentStructuredResult(transcript),
    ipc_version: IPC_VERSION,
  };
  yield structured;
}

export async function* translateJsonlSession(
  input: ReplayInput,
  opts: TranslateSessionOptions = {},
): AsyncGenerator<OutboundMessage, TranslateSessionResult> {
  const timeSliceMs = opts.timeSliceMs ?? DEFAULT_TIME_SLICE_MS;
  const now = opts.now ?? (() => performance.now());
  const onYield = opts.onYield;
  const telemetry = opts.telemetry ?? DEFAULT_TELEMETRY;
  const yieldBetweenBatches = opts.disableYield !== true;
  const synthesizeDanglingTerminal = opts.synthesizeDanglingTerminal === true;
  const window = opts.window;

  const started: ReplayStarted = {
    type: "replay_started",
    ipc_version: IPC_VERSION,
  };
  yield started;

  // Error branches: replay_started → replay_complete{error} with no
  // turns between. This is the contract the reducer relies on for the
  // missing/unreadable/timeout cases.
  if (input.kind === "missing") {
    const complete: ReplayComplete = {
      type: "replay_complete",
      count: 0,
      error: {
        kind: "jsonl_missing",
        message: input.message ?? "JSONL not found",
      },
      ipc_version: IPC_VERSION,
    };
    yield complete;
    return { count: 0 };
  }
  if (input.kind === "unreadable") {
    const complete: ReplayComplete = {
      type: "replay_complete",
      count: 0,
      error: {
        kind: "jsonl_unreadable",
        message: input.message,
      },
      ipc_version: IPC_VERSION,
    };
    yield complete;
    return { count: 0 };
  }

  // OK branch: parse + translate line by line.
  const ctx = makeTranslateContext(telemetry);
  const claudeSessionId = input.claudeSessionId ?? "";
  // Background-agent transcripts, indexed by the parent `Agent`
  // `tool_use.id` (`meta.toolUseId`). When that parent tool_use is emitted
  // below, its children splice in mid-turn. `consumedSubagents` ensures each
  // transcript splices at most once across the pass.
  const subagentsByParent = new Map<string, SubagentTranscript>();
  for (const transcript of input.subagents ?? []) {
    subagentsByParent.set(transcript.meta.toolUseId, transcript);
  }
  const consumedSubagents = new Set<string>();
  // Synthesize a `system_metadata` IPC each time the active model
  // changes across the replayed `assistant` entries. The JSONL's
  // top-level `system` entries are skipped (they mirror live
  // session_init and aren't surveyed in current Claude Code JSONLs);
  // the model field is duplicated on every assistant message via
  // `message.model`. Emitting on the first real model AND on every
  // subsequent change populates tugdeck's `SessionMetadataStore` —
  // which keeps the latest payload per feed — so the store lands on
  // the **active** (last) model at end of replay, faithfully tracking
  // a user who switched models mid-session, rather than freezing the
  // opener's model. `lastEmittedModel` holds the most-recently emitted
  // real model so unchanged turns don't re-emit.
  let lastEmittedModel: string | null = null;
  let sawAnyMalformed = false;
  let sliceStartedAt = now();

  // Split on newlines without losing trailing-no-newline content. The
  // tail (after the final \n) is included if non-empty so the last
  // entry of a JSONL that lacks a trailing newline still parses.
  //
  // Pre-parse every line up-front so the iteration loop can peek
  // ahead one significant entry. The peek is needed to detect the
  // same-msg_id continuation case described in
  // {@link TranslateJsonlEntryOptions.suppressTurnComplete}: when two
  // consecutive `assistant` entries share a `message.id`, the leading
  // entry's `turn_complete` must be deferred so the cycle stays open
  // and the trailing entry's content lands in the same scratch.
  // Telemetry for malformed lines fires at parse time, identical to
  // the prior streaming behavior.
  const lines = input.jsonl.split("\n");
  const parsedEntries: Array<JsonlEntry | null> = lines.map((rawLine) => {
    const line = rawLine.trim();
    if (line.length === 0) {
      return null;
    }
    try {
      return JSON.parse(line) as JsonlEntry;
    } catch (err) {
      sawAnyMalformed = true;
      telemetry.malformedLine({
        reason: err instanceof Error ? err.message : String(err),
        preview: line.slice(0, 80),
      });
      return null;
    }
  });

  // Reduce to the effective record sequence: entries off the live
  // `parentUuid` chain (retracted prompts, REPL-escape orphans, abandoned
  // rewind branches) and re-appended duplicate occurrences are nulled so
  // every downstream pass — the anchor scans, turn location, windowing,
  // and the emit loop — skips them uniformly, the same way malformed
  // lines are skipped. Claude's own resume walks the chain and shows each
  // preserved message once; replaying the rest paints phantom turns the
  // live session never showed.
  const effective = nullNonEffectiveEntries(parsedEntries);
  if (effective.dead > 0) {
    console.log(
      `Replay: skipping ${effective.dead} dead-branch JSONL entr${effective.dead === 1 ? "y" : "ies"} (off the live parent chain)`,
    );
  }
  if (effective.suppressed > 0) {
    console.log(
      `Replay: skipping ${effective.suppressed} re-appended duplicate JSONL entr${effective.suppressed === 1 ? "y" : "ies"} (compaction re-append)`,
    );
  }

  hoistCompactCommandEnvelope(parsedEntries);

  // Which parent `Agent` calls were launched in the BACKGROUND — their
  // main-JSONL result is the async-launch echo (`isAsync` / `status:
  // "async_launched"`). The splice restores only these: a foreground agent's
  // real children + answer already live in the main JSONL's structured
  // result, so touching it would double-render. Computed only when there are
  // subagent transcripts to place.
  const asyncAgentToolUseIds =
    subagentsByParent.size > 0
      ? collectAsyncAgentToolUseIds(parsedEntries)
      : new Set<string>();

  // Session-created anchor: the wall-clock of the first real turn-bearing
  // entry (a `user` or `assistant` message — `summary` / `system` meta
  // lines are skipped so this reads as "when the conversation began", not
  // the resume/compaction moment). Session-level, independent of any
  // recency window, so it rides EVERY `replay_complete` (windowed or full)
  // — the dev transcript's permanent Z0 strip surfaces it as "Session
  // created". `undefined` when nothing carries a parseable timestamp; the
  // frame then omits the field and the reducer leaves the anchor unset.
  let sessionCreatedAtMs: number | undefined;
  for (const entry of parsedEntries) {
    if (entry === null) continue;
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    const ts = parseEntryTimestamp(entry);
    if (ts !== undefined) {
      sessionCreatedAtMs = ts;
      break;
    }
  }

  // Session `sessionInitTokens` baseline: the input-baseline usage of
  // the FIRST assistant entry that carries `usage` — the resident
  // context the session started with, before turn 1 produced output
  // (#q01-session-init-tokens). Scanned over the whole file (not the
  // recency window) so it is the true session baseline regardless of
  // which turns this pass emits; carried identically on every turn's
  // telemetry (the reducer keeps the first non-null — Spec S02).
  for (const entry of parsedEntries) {
    if (entry === null || entry.type !== "assistant") continue;
    const usage = entry.message?.usage;
    if (usage !== undefined) {
      ctx.sessionInitTokens = sessionInitTokensFromUsage(usage);
      break;
    }
  }

  // Every turn's start entry, located by a dry run of the real translator
  // (see {@link computeTurns}). One consumer asks for it: the recency window,
  // which resolves its entry range from the turn boundaries. Skipped when it
  // did not ask — the unbounded path pays nothing extra, as it always did.
  const turns = window !== undefined ? computeTurns(parsedEntries) : null;

  // Recency window. When requested, resolve the turn boundaries above into the
  // `[windowStartIndex, windowEndIndex)` entry range to emit plus the metadata
  // to report. Absent ⇒ the whole session and no metadata (legacy).
  let windowStartIndex = 0;
  let windowEndIndex = parsedEntries.length;
  let windowMeta:
    | {
        firstLoadedTurnIndex: number;
        totalTurns: number;
        hasOlder: boolean;
      }
    | null = null;
  if (window !== undefined) {
    const resolved = resolveWindow(window, turns!, parsedEntries.length);
    windowStartIndex = resolved.startIndex;
    windowEndIndex = resolved.endIndex;
    windowMeta = {
      firstLoadedTurnIndex: resolved.firstLoadedTurnIndex,
      totalTurns: resolved.totalTurns,
      hasOlder: resolved.hasOlder,
    };
  }
  // A bounded window that stops before real EOF (paging in an older
  // range) must commit its last in-range turn at the cut: a turn that
  // historically closed via the next opener's orphan synthesis would
  // otherwise be left open, since the next opener is outside the window.
  // That commit is identical (`turn_complete{interrupted}`) to what the
  // next-opener orphan would have produced, so the older slice is
  // faithful. At real EOF the existing `synthesizeDanglingTerminal` rule
  // governs (a live drain may still continue the tail on reload-mid-stream).
  const synthesizeAtCut =
    synthesizeDanglingTerminal || windowEndIndex < parsedEntries.length;

  for (let i = windowStartIndex; i < windowEndIndex; i++) {
    const parsed = parsedEntries[i];
    if (parsed === null) {
      continue;
    }

    const candidateModel =
      parsed.type === "assistant" ? parsed.message?.model : undefined;
    if (isRealModelName(candidateModel) && candidateModel !== lastEmittedModel) {
      // Replay synthesizes a system_metadata IPC from a `message.model`
      // it finds in the resumed-session JSONL — that's enough to paint
      // the model badge before claude's live init lands. We emit on the
      // first real model AND whenever the model changes from the last
      // one emitted, so a session where the user switched models
      // mid-stream restores its **active** (last) model: the store keeps
      // the latest payload per feed. Every OTHER field is omitted (or
      // empty) because the JSONL doesn't carry it; the wire-layer merge
      // in `session_metadata_merge.rs` treats empty strings as "no
      // signal" and preserves whatever the ledger already has. `version`
      // in particular is OMITTED (not `""`) so it doesn't race the live
      // init and trick the frontend into showing `Claude Code ` (empty)
      // instead of `Claude Code ?` with its normal fallback chain. The
      // live `system/init` is the only source that ever populates
      // `version`.
      const sysMeta: SystemMetadata = {
        type: "system_metadata",
        session_id: claudeSessionId,
        cwd: "",
        tools: [],
        model: candidateModel,
        permissionMode: "",
        slash_commands: [],
        plugins: [],
        agents: [],
        skills: [],
        mcp_servers: [],
        output_style: "",
        fast_mode_state: "",
        apiKeySource: "",
        ipc_version: IPC_VERSION,
      };
      yield sysMeta;
      lastEmittedModel = candidateModel;
    }

    // Peek ahead for the same-msg_id continuation case, bounded to the
    // window's upper edge so a windowed pass never reaches across it.
    // (The window cuts on turn boundaries, so a continuation pair never
    // straddles the edge — the bound is defensive.)
    const suppressTurnComplete = continuationSuppressed(
      parsedEntries,
      i,
      windowEndIndex,
    );

    const messages = translateJsonlEntry(parsed, ctx, {
      suppressTurnComplete,
      wheelPrompts: opts.wheelPrompts,
    });
    for (const msg of messages) {
      // Drop the async-launch echo's own `tool_use_structured` for an agent
      // we're restoring — it carries no content, and the composed structured
      // result the splice emits below is the sole, richer writer. Without this
      // the echo (which lands after the splice) would clobber the composed one
      // (`handleToolStructured` is last-write-wins).
      if (
        msg.type === "tool_use_structured" &&
        asyncAgentToolUseIds.has(msg.tool_use_id) &&
        subagentsByParent.has(msg.tool_use_id)
      ) {
        continue;
      }
      yield msg;
      if (yieldBetweenBatches && now() - sliceStartedAt >= timeSliceMs) {
        onYield?.();
        await yieldToEventLoop();
        sliceStartedAt = now();
      }
      // Splice an agent's persisted children directly after its parent
      // `Agent` tool_use — mid-turn, so the reducer attaches them to
      // the open turn (`handleToolUse` resolves the turn via `pendingTurn`,
      // not `msg_id`). EVERY parent with a `subagents/` transcript is
      // spliced — foreground agents included: the main JSONL carries only
      // the Agent call and its final result, never the child tool calls
      // (verified on 2.1.198), so without the splice a reload loses every
      // foreground child block the live stream showed. A foreground
      // parent's REAL `tool_use_structured` (full content + stats) lands
      // after the splice and last-write-wins over the splice's composed
      // one, so its inline result is never degraded; only the async echo's
      // empty structured frame is dropped (`asyncAgentToolUseIds` above).
      // A windowed-out Agent never emits its tool_use here, so it yields
      // no children (window-safe by construction). Nested agents resolve
      // recursively inside `spliceSubagentChildren`.
      if (msg.type === "tool_use" && subagentsByParent.has(msg.tool_use_id)) {
        for (const child of spliceSubagentChildren(
          msg.tool_use_id,
          subagentsByParent,
          consumedSubagents,
          () => ctx.globalSeq++,
        )) {
          yield child;
          if (yieldBetweenBatches && now() - sliceStartedAt >= timeSliceMs) {
            onYield?.();
            await yieldToEventLoop();
            sliceStartedAt = now();
          }
        }
      }
    }
  }

  // EOF orphan synthesis (gated on `synthesizeDanglingTerminal`).
  // Under [D13]'s unified open-turn tracker model, both the
  // "dangling assistant cycle" case (assistant content arrived but no
  // clean terminal `stop_reason`) and the "trailing user-only orphan"
  // case (user submitted and quit before any assistant entry) collapse
  // into one path: if `openTurnMsgId !== null`, emit a single
  // `turn_complete{result: "interrupted"}` carrying that id.
  //
  // The id naturally selects the right reducer path:
  //   - dangling cycle: `noteContentMsgId` already swapped
  //     `openTurnMsgId` to claude's real `msg_id` from the open
  //     assistant entry, so the reducer's normal `handleTurnComplete`
  //     match commits the partial content;
  //   - trailing orphan: `openTurnMsgId` is still the synthesized
  //     opener id (`u-<n>` for user-text, `w-<n>` for wake — the
  //     latter shouldn't reach EOF in practice but the path handles
  //     it symmetrically), and the reducer's no-content fallback
  //     (`#spec-reducer-state` rule 2) commits `pendingTurn`.
  //
  // The two outcomes for an open turn are decided by the caller via
  // `synthesizeDanglingTerminal`:
  //   - `false` (default — reload-mid-stream, where a live
  //     `ActiveTurn` continues the turn): leave the turn open. The
  //     live drain (or `emitInflightTurnFromActiveTurn`) delivers
  //     the eventual `turn_complete`.
  //   - `true` (cold resume — no live continuation): emit the orphan
  //     synthetic so the resumed transcript shows an `interrupted`
  //     TurnEntry instead of stranding an in-flight row that animates
  //     its thinking indicator forever ([replay-1] / [W2]).
  if (synthesizeAtCut) {
    for (const msg of emitOrphanIfOpen(ctx)) {
      yield msg;
    }
  }

  const complete: ReplayComplete = {
    type: "replay_complete",
    count: ctx.turnsCommitted,
    ipc_version: IPC_VERSION,
    ...(windowMeta !== null
      ? {
          firstLoadedTurnIndex: windowMeta.firstLoadedTurnIndex,
          totalTurns: windowMeta.totalTurns,
          hasOlder: windowMeta.hasOlder,
        }
      : {}),
    ...(sessionCreatedAtMs !== undefined ? { sessionCreatedAtMs } : {}),
    ...(sawAnyMalformed
      ? {
          error: {
            kind: "jsonl_malformed" as const,
            message: "one or more JSONL lines failed to parse; surrounding turns committed",
          },
        }
      : {}),
  };
  yield complete;
  return { count: ctx.turnsCommitted };
}

/**
 * Yield control to the event loop for one tick. Equivalent to
 * `setImmediate` in Node, expressed as a Bun-compatible Promise.
 * Tests with `disableYield: true` short-circuit this.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Convenience exports for tests
// ---------------------------------------------------------------------------

/** Exposed for tests that want to inject a capturing telemetry sink. */
export const REPLAY_NOOP_TELEMETRY = NOOP_TELEMETRY;

/** Re-export for test ergonomics — avoids a separate const import. */
export { DEFAULT_TIME_SLICE_MS as REPLAY_TIME_SLICE_MS };
