/**
 * turn-entry-markdown.ts — serialize a committed assistant `TurnEntry`
 * into a self-contained markdown document.
 *
 * Backs the Z1B COPY affordance on the assistant transcript row. The
 * row body renders the turn's tool calls and the assistant's prose,
 * and COPY is expected to reproduce all of it — not just the final
 * prose. (Thinking is part of the entry but is intentionally left out
 * of the copy.)
 *
 * Output shape — flat sections, tool-agnostic:
 *
 *     ## Tool: <name>
 *
 *     Input:
 *     ```json
 *     { ... }
 *     ```
 *
 *     Output:
 *     ```
 *     ...
 *     ```
 *
 *     ## Response
 *
 *     <assistant prose — verbatim markdown>
 *
 * Every tool call is rendered with the same generic shape, so a tool
 * added later needs no new serialization code. Subagent tool calls
 * (`ToolUseMessage.parentToolUseId` set) nest one heading level deeper
 * under their spawning `Agent` call.
 *
 * The `## Response` heading is emitted only when the turn also made
 * tool calls — a pure-prose turn copies as just its prose, no heading.
 *
 * [D07] sequence substrate — the helper iterates `turn.messages`,
 * filtering by Message kind, instead of reaching for the paired
 * `turn.toolCalls` / `turn.assistant` fields that retired.
 *
 * @module lib/turn-entry-markdown
 */

import type { Message, ToolUseMessage, TurnEntry } from "@/lib/code-session-store/types";

// ---------------------------------------------------------------------------
// Fenced-code helpers
// ---------------------------------------------------------------------------

/** Longest run of consecutive backticks in `s` (0 when there are none). */
function longestBacktickRun(s: string): number {
  let longest = 0;
  let run = 0;
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === "`") {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  return longest;
}

/**
 * Wrap `content` in a fenced code block. The fence is one backtick
 * longer than the longest backtick run inside `content` (floored at
 * 3), so a tool output that itself contains ``` fences can't close
 * the block early — CommonMark closes an N-backtick fence only with
 * a run of N-or-more backticks.
 */
function fence(content: string, lang = ""): string {
  const ticks = "`".repeat(Math.max(3, longestBacktickRun(content) + 1));
  return `${ticks}${lang}\n${content}\n${ticks}`;
}

/** `JSON.stringify` with indentation, guarded against throws / `undefined`. */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

// ---------------------------------------------------------------------------
// Per-tool-call serialization
// ---------------------------------------------------------------------------

/** True when a tool input carries nothing worth printing. */
function isEmptyInput(input: unknown): boolean {
  if (input === undefined || input === null) return true;
  if (Array.isArray(input)) return input.length === 0;
  if (typeof input === "object") return Object.keys(input).length === 0;
  return false;
}

/**
 * The `Output:` block body for one tool call. Prefers the raw textual
 * result (`tool_result.output`); falls back to the typed structured
 * result, then to a JSON dump of a non-string raw result, so whichever
 * field a given tool populates, its content lands in the copy.
 */
function toolOutput(call: ToolUseMessage): string {
  if (typeof call.result === "string" && call.result.length > 0) {
    return fence(call.result);
  }
  if (call.structuredResult !== null && call.structuredResult !== undefined) {
    return fence(safeJson(call.structuredResult), "json");
  }
  if (call.result !== null && call.result !== undefined) {
    return fence(safeJson(call.result), "json");
  }
  return call.status === "pending"
    ? "_(no result — tool was still pending when the turn ended)_"
    : "_(no output)_";
}

/**
 * Partition a flat tool-call list into top-level calls + the
 * `parentToolUseId → children[]` map. The reducer's substrate keeps
 * tool calls flat in `turn.messages`; a subagent's intermediate calls
 * land alongside the spawning `Agent` call, each tagged with
 * `parentToolUseId` ([#step-17-5]). This helper rebuilds the nesting
 * for display: a call with a `parentToolUseId` is a child (rendered
 * inside its parent's section); everything else is top-level.
 */
export function groupToolCallsByParent(
  toolCalls: ReadonlyArray<ToolUseMessage>,
): {
  topLevel: ReadonlyArray<ToolUseMessage>;
  childrenByParent: ReadonlyMap<string, ReadonlyArray<ToolUseMessage>>;
} {
  const topLevel: ToolUseMessage[] = [];
  const childrenByParent = new Map<string, ToolUseMessage[]>();
  for (const call of toolCalls) {
    const parentId = call.parentToolUseId;
    if (parentId === undefined) {
      topLevel.push(call);
      continue;
    }
    const siblings = childrenByParent.get(parentId);
    if (siblings === undefined) childrenByParent.set(parentId, [call]);
    else siblings.push(call);
  }
  return { topLevel, childrenByParent };
}

/**
 * Serialize one tool call (and, recursively, any subagent children)
 * to a markdown section. `depth` drives the heading level: a top-level
 * call is `##`, each nesting level adds one `#`, clamped at the
 * markdown maximum of `######`.
 */
function serializeToolCall(
  call: ToolUseMessage,
  depth: number,
  childrenByParent: ReadonlyMap<string, ReadonlyArray<ToolUseMessage>>,
): string {
  const hashes = "#".repeat(Math.min(6, 2 + depth));
  const lines: string[] = [`${hashes} Tool: ${call.toolName}`];

  if (!isEmptyInput(call.input)) {
    lines.push("", "Input:", fence(safeJson(call.input), "json"));
  }
  lines.push("", "Output:", toolOutput(call));

  const children = childrenByParent.get(call.toolUseId) ?? [];
  for (const child of children) {
    lines.push("", serializeToolCall(child, depth + 1, childrenByParent));
  }
  return lines.join("\n");
}

/**
 * Serialize one top-level tool call (with any subagent children) to the
 * same markdown section `turnEntryToMarkdown` produces — the per-tool
 * path the partial-copy reconstruction reuses ([#partial-copy-design])
 * so a tool block touched by a selection copies identically whether it
 * was copied alone or as part of the whole row. `childrenByParent` is
 * the partition from {@link groupToolCallsByParent}.
 */
export function toolCallToMarkdown(
  call: ToolUseMessage,
  childrenByParent: ReadonlyMap<string, ReadonlyArray<ToolUseMessage>>,
): string {
  return serializeToolCall(call, 0, childrenByParent);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Serialize a committed assistant `TurnEntry` to a markdown document
 * covering every tool call followed by the assistant's prose. Returns
 * an empty string for a turn with neither (the COPY affordance is
 * suppressed for an empty result by its own length check).
 */
export function turnEntryToMarkdown(turn: TurnEntry): string {
  const toolCalls: ToolUseMessage[] = [];
  const proseChunks: string[] = [];
  for (const m of turn.messages) {
    if (m.kind === "tool_use") {
      toolCalls.push(m);
    } else if (m.kind === "assistant_text") {
      proseChunks.push(m.text);
    }
  }
  const { topLevel, childrenByParent } = groupToolCallsByParent(toolCalls);
  const sections: string[] = topLevel.map((call) =>
    serializeToolCall(call, 0, childrenByParent),
  );

  // Concatenate the turn's `assistant_text` Messages in arrival
  // order. A multi-block turn (text → tool → text) emits two text
  // Messages; today's COPY surface gives them back as one continuous
  // prose body. Future work could intersperse tool sections in
  // arrival position if that reads better.
  const prose = proseChunks.join("\n\n").trim();
  if (prose.length > 0) {
    // A heading delimits the prose from the tool sections above it;
    // a pure-prose turn copies as just its prose, with no heading.
    sections.push(sections.length > 0 ? `## Response\n\n${prose}` : prose);
  }

  return sections.join("\n\n");
}

/**
 * The copy text of the most recent assistant turn in a transcript — what
 * `/copy` puts on the clipboard ([#step-13b1b]). Walks committed turns newest-
 * first and returns the first non-empty {@link turnEntryToMarkdown}, so it
 * reuses the exact text the per-row COPY affordance produces and skips turns
 * with no assistant content (an interrupted-before-reply turn). `null` when no
 * turn has copyable assistant content (a fresh session, or only empty turns).
 *
 * Pure — operates on the committed transcript only (not the in-flight turn), so
 * `/copy` copies a settled message, never a half-streamed one.
 */
export function lastAssistantCopyText(
  transcript: ReadonlyArray<TurnEntry>,
): string | null {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const markdown = turnEntryToMarkdown(transcript[i]);
    if (markdown.length > 0) return markdown;
  }
  return null;
}

/**
 * The assistant prose from a turn's messages — every `assistant_text`
 * block joined in arrival order, tool sections dropped. Used to capture
 * `/compact`'s summary off the *in-flight* (suppressed) summarization
 * turn's live `ActiveTurnSnapshot.messages`, where the turn never commits
 * to the transcript. Pure; returns `""` when there is no prose yet.
 */
export function assistantProseFromMessages(
  messages: ReadonlyArray<Message>,
): string {
  const chunks: string[] = [];
  for (const m of messages) {
    if (m.kind === "assistant_text") chunks.push(m.text);
  }
  return chunks.join("\n\n").trim();
}
