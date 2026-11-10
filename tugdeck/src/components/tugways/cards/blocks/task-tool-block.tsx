/**
 * `TaskToolBlock` — Layer-2 wrapper for the Task / Agent tool.
 *
 * Composes `BlockChrome` (header / status / error band) around
 * an `embedded` `AgentTranscriptBlock` body kind. Per [Spec S03] /
 * [Table T02] / [#bk-conformance]:
 *
 *   - **Header:** a bot icon + tool name + the subagent type (e.g.
 *     "Explore") and the task description in the detail row, plus a
 *     trailing nested-call-count badge (the `Agent` analog of `Read`'s
 *     "N lines"). The subagent type comes from the
 *     `structured_result.agentType`, falling back to the input's
 *     `subagent_type` while the result is still streaming; the
 *     description comes from the input fragment, so the block says what
 *     it is doing the instant it kicks off. Lifecycle status is the
 *     header dot's alone ([D02]) — no status text on this row.
 *   - **Body:** `AgentTranscriptBlock` composed `embedded={true}` —
 *     the wrapper chrome owns identity, so the body kind's own header
 *     is suppressed and its actions cluster (fold cue + Copy) portals
 *     into the chrome's actions slot.
 *
 * Wire shape (`structured_result`, from the v2.1.x stream-json catalog
 * `test-22-subagent-spawn.jsonl`): `{ agentType, status, content:
 * [...], totalDurationMs, totalTokens, totalToolUseCount, toolStats,
 * usage }`. `composeAgentTranscriptData` narrows it to
 * `AgentTranscriptData` — `content[]` entries narrow to
 * `AgentTranscriptEntry` (text answers and nested `tool_use` blocks).
 *
 * Recursion ([D17]): a nested `tool_use` content entry is dispatched
 * by `AgentTranscriptBlock` through the same `dispatchToolUseMessage`
 * at `depth + 1`, so a nested tool call gets its real wrapper and a
 * nested `Agent` recurses into `TaskToolBlock` → `AgentTranscriptBlock`
 * one level deeper. `depth` arrives on `ToolBlockProps` and is
 * threaded straight to the body kind.
 *
 * Child calls come from two converging sources, deduped by
 * `toolUseId` at render time:
 *   - `childToolCallsByParent.get(toolUseId)` — turn-attached children
 *     (streamed inline for a foreground agent; spliced onto the
 *     committed turn by the resume path on reload).
 *   - `job.childCalls` — the live inter-turn children of a
 *     backgrounded agent, routed onto the job ledger by the reducer as
 *     the tugcode tailer streams them.
 * The final answer prefers `job.agentStructuredResult` (composed on
 * genuine completion, live) over the launching call's
 * `structuredResult` prop (which for a background agent is just the
 * async-launch echo).
 *
 * Body selection is keyed on whether the transcript has entries, not on
 * `status`:
 *   - entries present (live child calls and/or the final answer) →
 *     the embedded `AgentTranscriptBlock`, even mid-stream.
 *   - no entries yet → no body (header only). Real child blocks fill
 *     the window as they stream in; there is no summary placeholder.
 *   - `status === "error"` → the body is dropped; the chrome paints the
 *     error band from the plain-text `tool_result.output`.
 *
 * Registration: `session-assistant-renderer-registrations.ts` imports this
 * module and calls `registerToolBlock("agent", TaskToolBlock)` from
 * its registration loop — the historical `task` name resolves here via
 * the `task → agent` alias ([D16]).
 *
 * Laws:
 *  - [L06] no React state for appearance; chrome owns DOM attributes;
 *    body composition is pure props derived via `useMemo`.
 *  - [L19] file pair (`.tsx` + `.css`), exported props interface,
 *    `data-slot="task-tool-block"` (delegated via the chrome's
 *    `rootSlot`).
 *  - [L20] reuses the chrome's `--tugx-block-*` and the body's
 *    `--tugx-agent-*`; the status badge rides the chrome's args-row
 *    typography. No new tokens.
 *
 * Decisions:
 *  - [D05] two-layer hybrid — `AgentTranscriptBlock` owns the
 *    transcript rendering, the wrapper owns chrome.
 *  - [D17] recursion runs through the same dispatch, depth-bounded.
 *
 * @module components/tugways/cards/blocks/task-tool-block
 */

import "./task-tool-block.css";

import React from "react";

import {
  AgentTranscriptBlock,
  type AgentTranscriptData,
  type AgentTranscriptEntry,
} from "@/components/tugways/body-kinds/agent-transcript-block";

import type { ToolUseMessage } from "@/lib/code-session-store";
import { useJobForToolUse } from "@/lib/code-session-store/hooks/use-job-for-tool-use";

import { BlockChrome } from "../../blocks/block-chrome";
import type { ToolResultSummary } from "../../blocks/tool-result-summary";
import type { ToolBlockProps } from "../../blocks/types";

// ---------------------------------------------------------------------------
// Wire-shape narrowings
// ---------------------------------------------------------------------------

/** Task / Agent tool input — the wire fields under `tool_use.input`. */
export interface AgentToolInput {
  /** Short description of the subagent task — not surfaced today. */
  description?: string;
  /** The prompt handed to the subagent — not surfaced today. */
  prompt?: string;
  /** The subagent type (`input.subagent_type`), e.g. "Explore". */
  subagentType?: string;
}

/**
 * Task / Agent tool structured result — the wire shape under
 * `tool_use_structured.structured_result`. Every field is optional and
 * defensively narrowed so a partial / drifted event degrades
 * gracefully. `content` stays `unknown[]` here —
 * `composeAgentTranscriptData` deep-narrows each entry.
 */
export interface AgentStructuredResult {
  agentType?: string;
  status?: string;
  content?: unknown[];
  totalDurationMs?: number;
  totalTokens?: number;
  totalToolUseCount?: number;
}

// ---------------------------------------------------------------------------
// Pure helpers — exported because tests pin them
// ---------------------------------------------------------------------------

/** Narrow the wrapper-side `unknown` input to {@link AgentToolInput}. */
export function narrowAgentInput(value: unknown): AgentToolInput {
  if (value === null || typeof value !== "object") return {};
  const v = value as Record<string, unknown>;
  return {
    description:
      typeof v.description === "string" ? v.description : undefined,
    prompt: typeof v.prompt === "string" ? v.prompt : undefined,
    subagentType:
      typeof v.subagent_type === "string" ? v.subagent_type : undefined,
  };
}

/** Narrow the wrapper-side `unknown` structured result. */
export function narrowAgentStructured(value: unknown): AgentStructuredResult {
  if (value === null || typeof value !== "object") return {};
  const v = value as Record<string, unknown>;
  return {
    agentType: typeof v.agentType === "string" ? v.agentType : undefined,
    status: typeof v.status === "string" ? v.status : undefined,
    content: Array.isArray(v.content) ? v.content : undefined,
    totalDurationMs:
      typeof v.totalDurationMs === "number" ? v.totalDurationMs : undefined,
    totalTokens:
      typeof v.totalTokens === "number" ? v.totalTokens : undefined,
    totalToolUseCount:
      typeof v.totalToolUseCount === "number"
        ? v.totalToolUseCount
        : undefined,
  };
}

/**
 * Narrow one wire `content[]` block to an {@link AgentTranscriptEntry},
 * or `undefined` to drop it. Anthropic content blocks are
 * `{ type: "text", text }` and `{ type: "tool_use", id, name, input }`;
 * a `tool_use` block becomes a `ToolUseMessage` with no result yet
 * (status `"done"` — the wrapper renders the call without a body).
 * Any other block type is dropped.
 */
function narrowContentEntry(value: unknown): AgentTranscriptEntry | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (v.type === "text" && typeof v.text === "string") {
    return { kind: "text", text: v.text };
  }
  if (v.type === "tool_use") {
    const id = typeof v.id === "string" ? v.id : undefined;
    const name = typeof v.name === "string" ? v.name : undefined;
    if (id === undefined || name === undefined) return undefined;
    // The synthesized `ToolUseMessage` is a display-only projection
    // of an `Agent` result's inlined tool_use blocks — it never
    // enters the reducer's substrate, so the `messageKey` is a
    // synthetic id and `createdAt` defaults to the structured-result's
    // arrival time (unknown here; `0` is acceptable for a UI-only
    // fixture that the renderer doesn't read).
    return {
      kind: "tool_use",
      toolCall: {
        kind: "tool_use",
        messageKey: `agent-inline-${id}`,
        createdAt: 0,
        toolUseId: id,
        toolName: name,
        input: v.input ?? {},
        status: "done",
        result: null,
        structuredResult: null,
        toolWallMs: null,
      },
    };
  }
  return undefined;
}

/**
 * The subagent's nested-call count for the header's trailing badge —
 * the `Agent` analog of `Read`'s "N lines". While the run is still
 * streaming the reducer-linked `childToolCalls` are the live truth; the
 * structured result's `totalToolUseCount` lands once the run finishes.
 * Take the larger of the two so the badge is correct in both states and
 * never regresses as the structured result arrives.
 *
 * A `SubagentHandback` call is plumbing that draws no row, so it is
 * not counted: it leaves the live list, and once one has been seen the
 * reported total (which includes it) is taken down by one.
 */
export function agentNestedCallCount(
  childToolCalls: ReadonlyArray<ToolUseMessage> | undefined,
  structured: AgentStructuredResult,
): number {
  const all = childToolCalls ?? [];
  const live = all.filter((c) => !isSubagentHandback(c.toolName)).length;
  const handbacks = all.length - live;
  const reported = Math.max(0, (structured.totalToolUseCount ?? 0) - handbacks);
  return Math.max(live, reported);
}

/**
 * Merge a subagent's child tool calls from its two possible sources —
 * the turn-attached set (`childToolCallsByParent.get(toolUseId)`,
 * populated inline for a foreground agent and by the resume splice on
 * reload) and the job-fed set (`job.childCalls`, populated inter-turn
 * by the live tailer) — deduping by `toolUseId`, first occurrence
 * wins. A reload mid-run is the one case both sources carry the same
 * call; the id-dedup fuses them into one list.
 */
export function mergeChildToolCalls(
  turnLinked: ReadonlyArray<ToolUseMessage> | undefined,
  jobCalls: ReadonlyArray<ToolUseMessage> | undefined,
): ReadonlyArray<ToolUseMessage> | undefined {
  if (turnLinked === undefined && jobCalls === undefined) return undefined;
  const seen = new Set<string>();
  const merged: ToolUseMessage[] = [];
  for (const call of [...(turnLinked ?? []), ...(jobCalls ?? [])]) {
    if (seen.has(call.toolUseId)) continue;
    seen.add(call.toolUseId);
    merged.push(call);
  }
  return merged;
}

/**
 * Compose the `AgentTranscriptData` payload `AgentTranscriptBlock`
 * consumes.
 *
 * Entries come from two sources ([#step-17-5]):
 *  - `childToolCalls` — the subagent's *intermediate* tool calls,
 *    linked by the reducer via `parentToolUseId` and resolved by the
 *    transcript view's `groupToolCallsByParent` (merged with the job
 *    ledger's live children via `mergeChildToolCalls`). These render
 *    first, in producer order, deduped by `toolUseId`.
 *  - `structured.content[]` — the subagent's *final* answer (text
 *    blocks) plus any inline `tool_use` content blocks. Junk blocks
 *    drop; this follows the intermediate calls. An inline `tool_use`
 *    whose id already appeared as a child call is dropped — the child
 *    call is the richer record (it carries the result).
 *
 * `agentType` falls back to the input's `subagent_type` when the
 * structured result hasn't supplied it yet. Returns `undefined` when
 * the structured result carries nothing renderable at all (drift /
 * streaming-incomplete) — an empty `content` array with any metadata
 * (or any child tool call) still composes.
 *
 * Hand-back (v2.1.322+): a subagent may end by calling
 * `SubagentHandback({ message })`, and then the Agent call's own result
 * is not its answer but a harness stub ("This agent's report was
 * delivered to you as a message from …", plus a note about where
 * WebFetch saves files) addressed to the model. The `message` is the
 * answer, so it becomes the final text entry and the stub is dropped;
 * the hand-back call itself is plumbing and draws no entry. A stub
 * that arrives without its hand-back (a reload whose children were
 * not spliced) is still dropped — the reader never sees the
 * boilerplate.
 */
export function composeAgentTranscriptData(
  input: AgentToolInput,
  structured: AgentStructuredResult,
  childToolCalls?: ReadonlyArray<ToolUseMessage>,
): AgentTranscriptData | undefined {
  const seenIds = new Set<string>();
  const childEntries: AgentTranscriptEntry[] = [];
  let handback: string | undefined;
  for (const toolCall of childToolCalls ?? []) {
    if (seenIds.has(toolCall.toolUseId)) continue;
    seenIds.add(toolCall.toolUseId);
    if (isSubagentHandback(toolCall.toolName)) {
      const message = handbackMessage(toolCall.input);
      if (message !== undefined) handback = message;
      continue;
    }
    childEntries.push({ kind: "tool_use", toolCall });
  }
  const wireEntries = (structured.content ?? [])
    .map(narrowContentEntry)
    .filter((e): e is AgentTranscriptEntry => e !== undefined)
    .filter((e) => {
      if (e.kind === "tool_use") {
        if (isSubagentHandback(e.toolCall.toolName)) {
          const message = handbackMessage(e.toolCall.input);
          if (message !== undefined) handback ??= message;
          return false;
        }
        return !seenIds.has(e.toolCall.toolUseId);
      }
      return !isHandbackStub(e.text);
    });
  // The hand-back is the answer; any wire text beside it is the stub.
  const entries: AgentTranscriptEntry[] =
    handback === undefined
      ? [...childEntries, ...wireEntries]
      : [
          ...childEntries,
          ...wireEntries.filter((e) => e.kind !== "text"),
          { kind: "text", text: handback },
        ];
  const agentType = structured.agentType ?? input.subagentType;
  const data: AgentTranscriptData = {
    agentType,
    status: structured.status,
    durationMs: structured.totalDurationMs,
    toolUseCount: structured.totalToolUseCount,
    totalTokens: structured.totalTokens,
    entries,
  };
  const hasAnything =
    agentType !== undefined ||
    data.status !== undefined ||
    data.durationMs !== undefined ||
    data.toolUseCount !== undefined ||
    data.totalTokens !== undefined ||
    entries.length > 0;
  return hasAnything ? data : undefined;
}

/** Whether a tool name is the subagent's `SubagentHandback` call. */
function isSubagentHandback(toolName: string): boolean {
  return toolName.toLowerCase() === "subagenthandback";
}

/** The report a `SubagentHandback` call carries in `input.message`. */
function handbackMessage(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const message = (input as Record<string, unknown>).message;
  return typeof message === "string" && message.trim().length > 0
    ? message
    : undefined;
}

/**
 * Whether a text answer is the harness stub that stands in for a
 * handed-back report — written for the model, never for the reader.
 * Exported for tests.
 */
export function isHandbackStub(text: string): boolean {
  return /^\s*This agent.s report was delivered to you as a message from\b/.test(
    text,
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const TaskToolBlock: React.FC<ToolBlockProps> = ({
  toolUseId,
  toolName,
  input,
  structuredResult,
  textOutput,
  status,
  phase,
  caution,
  depth = 0,
  childToolCallsByParent,
  turnInterrupted = false,
  session,
}) => {
  // The launched background job (if any) for this call. A backgrounded
  // agent's children and composed final answer arrive inter-turn on the
  // job ledger — the live counterpart of the turn-attached sources.
  const job = useJobForToolUse(session, toolUseId);
  const agentInput = React.useMemo(() => narrowAgentInput(input), [input]);
  // The final answer + footer stats. `job.agentStructuredResult` is the
  // live composed answer (emitted only on genuine completion); the
  // launching call's `structuredResult` prop is the reload-path value —
  // for a background agent the prop alone is just the async-launch echo.
  const jobStructured = job?.agentStructuredResult;
  const structured = React.useMemo(
    () => narrowAgentStructured(jobStructured ?? structuredResult),
    [jobStructured, structuredResult],
  );
  // This subagent's own intermediate tool calls — the turn-attached
  // children whose `parentToolUseId` is this call's `toolUseId`
  // ([#step-17-5]), merged with the job ledger's live children and
  // deduped by id. The full map is threaded on to `AgentTranscriptBlock`
  // so deeper subagents resolve theirs.
  const jobChildCalls = job?.childCalls;
  const childToolCalls = React.useMemo(
    () =>
      mergeChildToolCalls(childToolCallsByParent?.get(toolUseId), jobChildCalls),
    [childToolCallsByParent, toolUseId, jobChildCalls],
  );
  const transcriptData = React.useMemo(
    () => composeAgentTranscriptData(agentInput, structured, childToolCalls),
    [agentInput, structured, childToolCalls],
  );

  // Header detail — the agent type plus the task description. Read
  // straight from the narrowed shapes (not `transcriptData`) so a
  // still-streaming call surfaces the `subagent_type` and `description`
  // from its input fragment the moment they arrive — the block says
  // what it is doing the instant it kicks off. Lifecycle status is the
  // header dot's job alone ([D02]); no status text rides this row.
  const agentType = structured.agentType ?? agentInput.subagentType;
  const description = agentInput.description;
  const argsSummary =
    agentType !== undefined ||
    (description !== undefined && description.length > 0) ? (
      <span
        className="task-tool-block-args tool-call-header-clamp"
        data-tugx-findable=""
      >
        {agentType !== undefined ? (
          <code data-slot="task-tool-block-agent-type">{agentType}</code>
        ) : null}
        {description !== undefined && description.length > 0 ? (
          <span
            data-slot="task-tool-block-description"
            className="task-tool-block-description"
          >
            {description}
          </span>
        ) : null}
      </span>
    ) : undefined;

  // Trailing badge — the subagent's nested-call count, the `Agent`
  // analog of `Read`'s "N lines". Present in both collapsed and
  // expanded states because it rides the chrome's one badge slot.
  const nestedCallCount = agentNestedCallCount(childToolCalls, structured);
  const resultSummary: ToolResultSummary | undefined =
    nestedCallCount > 0
      ? { kind: "count", count: nestedCallCount, noun: "call" }
      : undefined;

  // Errored subagent runs carry the failure message in `textOutput`;
  // surface it through the chrome's error band rather than the body.
  // Body, keyed on whether the transcript has anything to show — never
  // on `status` alone, so a still-streaming run renders its child
  // calls the moment the first one arrives. Error → none (the chrome's
  // error band is the primary content). Entries present → the embedded
  // AgentTranscriptBlock. Otherwise no body at all — the header stands
  // alone until real child blocks fill the window.
  const hasEntries =
    transcriptData !== undefined && transcriptData.entries.length > 0;
  let body: React.ReactNode = null;
  if (status !== "error" && hasEntries) {
    body = (
      <AgentTranscriptBlock
        data={transcriptData}
        depth={depth}
        childToolCallsByParent={childToolCallsByParent}
        turnInterrupted={turnInterrupted}
        embedded
        className="task-tool-block-transcript"
        componentStatePreservationKey={`${toolUseId}-body`}
      />
    );
  }

  return (
    <BlockChrome
      rootSlot="task-tool-block"
      toolName={toolName}
      argsSummary={argsSummary}
      resultSummary={resultSummary}
      status={status}
      phase={phase}
      caution={caution}
      notice={
        status === "error" && textOutput !== undefined && textOutput.length > 0
          ? { tone: "error", text: textOutput }
          : undefined
      }
    >
      {body}
    </BlockChrome>
  );
};
