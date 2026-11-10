/**
 * Pure-logic tests for `TaskToolBlock`'s wire-narrowing helpers, the
 * `Agent` dispatch routing, and the [D17] recursive depth threading.
 *
 * The wrapper component itself is decoration over composition
 * (`BlockChrome` + an `embedded` `AgentTranscriptBlock`) — its
 * behaviour *is* the exported pure helpers:
 *
 *  - `narrowAgentInput` / `narrowAgentStructured` — defensive
 *    narrowing of the `unknown` wire props.
 *  - `composeAgentTranscriptData` — `structured_result` →
 *    `AgentTranscriptData`; deep-narrows `content[]` blocks into
 *    transcript entries (text answers + nested `tool_use` blocks).
 *  - the dispatch routes `Agent` (and the historical `Task` alias) to
 *    the real `TaskToolBlock`.
 *  - a nested `tool_use` entry, dispatched at `depth + 1`, routes to
 *    its real wrapper and carries the incremented `depth` — the
 *    [D17] recursion contract.
 *
 * No DOM: per the project's testing policy these are `bun:test`
 * pure-logic assertions, not fake-DOM render tests.
 */

import { describe, expect, test } from "bun:test";

import {
  TaskToolBlock,
  agentNestedCallCount,
  composeAgentTranscriptData,
  isHandbackStub,
  mergeChildToolCalls,
  narrowAgentInput,
  narrowAgentStructured,
} from "../task-tool-block";
import { GrepToolBlock } from "../grep-tool-block";
import {
  _resetToolBlockRegistryForTests,
  dispatchToolCallState,
  registerToolBlock,
  resolveToolBlock,
} from "../../session-assistant-renderer-dispatch";
import {
  AGENT_MAX_DEPTH,
  shouldCollapseAgentDepth,
} from "@/components/tugways/body-kinds/agent-transcript-block";
import type { ToolUseMessage } from "@/lib/code-session-store";

/** Build a minimal `ToolUseMessage` for the child-tool-call merge tests. */
function childCall(toolUseId: string, toolName: string): ToolUseMessage {
  return {
    kind: "tool_use",
    messageKey: `fixture-${toolUseId}`,
    createdAt: 0,
    toolUseId,
    toolName,
    input: {},
    status: "done",
    result: null,
    structuredResult: null,
    parentToolUseId: "agent-1",
    toolWallMs: null,
  };
}

// ---------------------------------------------------------------------------
// Synthetic fixtures — the catalog's only Agent probe
// (`test-22-subagent-spawn.jsonl`) carries a text-only `content[]`, so
// the nested-tool-call and depth cases use synthetic results per
// [#step-17].
// ---------------------------------------------------------------------------

/** Mirrors the real `test-22` Agent structured result — text-only content. */
const TEXT_ONLY_FIXTURE: unknown = {
  agentType: "Explore",
  status: "completed",
  content: [{ type: "text", text: "src/feed.rs\nsrc/lib.rs" }],
  totalDurationMs: 3566,
  totalTokens: 15700,
  totalToolUseCount: 1,
};

/** Content-mode fixture with a nested Grep `tool_use` block. */
const NESTED_GREP_FIXTURE: unknown = {
  agentType: "Explore",
  status: "completed",
  content: [
    { type: "text", text: "Searching…" },
    {
      type: "tool_use",
      id: "tu-grep-1",
      name: "Grep",
      input: { pattern: "FeedId", path: "/repo" },
    },
    { type: "text", text: "Done." },
  ],
  totalToolUseCount: 1,
};

/** Content-mode fixture with a nested Agent `tool_use` block (depth case). */
const NESTED_AGENT_FIXTURE: unknown = {
  agentType: "Plan",
  status: "completed",
  content: [
    {
      type: "tool_use",
      id: "tu-agent-1",
      name: "Agent",
      input: { subagent_type: "Explore", prompt: "dig deeper" },
    },
  ],
};

// ---------------------------------------------------------------------------
// narrowAgentInput
// ---------------------------------------------------------------------------

describe("narrowAgentInput", () => {
  test("keeps the wire fields when well-typed (subagent_type → subagentType)", () => {
    expect(
      narrowAgentInput({
        description: "Find refs",
        prompt: "search the workspace",
        subagent_type: "Explore",
      }),
    ).toEqual({
      description: "Find refs",
      prompt: "search the workspace",
      subagentType: "Explore",
    });
  });

  test("drops mistyped fields and tolerates non-objects", () => {
    expect(narrowAgentInput({ description: 42, subagent_type: ["x"] })).toEqual({
      description: undefined,
      prompt: undefined,
      subagentType: undefined,
    });
    expect(narrowAgentInput(null)).toEqual({});
    expect(narrowAgentInput("nope")).toEqual({});
    expect(narrowAgentInput(undefined)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// narrowAgentStructured
// ---------------------------------------------------------------------------

describe("narrowAgentStructured", () => {
  test("narrows the text-only fixture", () => {
    const result = narrowAgentStructured(TEXT_ONLY_FIXTURE);
    expect(result.agentType).toBe("Explore");
    expect(result.status).toBe("completed");
    expect(result.content?.length).toBe(1);
    expect(result.totalDurationMs).toBe(3566);
    expect(result.totalTokens).toBe(15700);
    expect(result.totalToolUseCount).toBe(1);
  });

  test("a missing or mistyped content array narrows to undefined", () => {
    expect(narrowAgentStructured({ agentType: "Explore" }).content).toBeUndefined();
    expect(narrowAgentStructured({ content: "nope" }).content).toBeUndefined();
  });

  test("tolerates non-objects", () => {
    expect(narrowAgentStructured(null)).toEqual({});
    expect(narrowAgentStructured("nope")).toEqual({});
    expect(narrowAgentStructured(undefined)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// composeAgentTranscriptData
// ---------------------------------------------------------------------------

describe("composeAgentTranscriptData", () => {
  test("composes the text-only fixture into a text entry + metadata", () => {
    const data = composeAgentTranscriptData(
      {},
      narrowAgentStructured(TEXT_ONLY_FIXTURE),
    );
    expect(data).toBeDefined();
    if (data === undefined) throw new Error("unreachable");
    expect(data.agentType).toBe("Explore");
    expect(data.status).toBe("completed");
    expect(data.durationMs).toBe(3566);
    expect(data.toolUseCount).toBe(1);
    expect(data.totalTokens).toBe(15700);
    expect(data.entries).toEqual([
      { kind: "text", text: "src/feed.rs\nsrc/lib.rs" },
    ]);
  });

  test("narrows a nested tool_use content block into a tool_use entry", () => {
    const data = composeAgentTranscriptData(
      {},
      narrowAgentStructured(NESTED_GREP_FIXTURE),
    );
    expect(data?.entries.map((e) => e.kind)).toEqual([
      "text",
      "tool_use",
      "text",
    ]);
    const toolEntry = data?.entries[1];
    if (toolEntry?.kind !== "tool_use") throw new Error("unreachable");
    expect(toolEntry.toolCall.toolName).toBe("Grep");
    expect(toolEntry.toolCall.toolUseId).toBe("tu-grep-1");
    expect(toolEntry.toolCall.input).toEqual({
      pattern: "FeedId",
      path: "/repo",
    });
    // No result yet — a content-block tool_use renders as a done call.
    expect(toolEntry.toolCall.status).toBe("done");
  });

  test("drops junk content blocks (bad type, missing id / name)", () => {
    const data = composeAgentTranscriptData(
      {},
      narrowAgentStructured({
        content: [
          { type: "text", text: "kept" },
          { type: "image", url: "x" }, // unsupported block type → dropped
          { type: "tool_use", name: "Grep" }, // missing id → dropped
          { type: "tool_use", id: "tu-2" }, // missing name → dropped
          null,
          42,
        ],
      }),
    );
    expect(data?.entries).toEqual([{ kind: "text", text: "kept" }]);
  });

  test("agentType falls back to the input's subagent_type", () => {
    const data = composeAgentTranscriptData(
      { subagentType: "Plan" },
      narrowAgentStructured({ content: [], status: "in_progress" }),
    );
    expect(data?.agentType).toBe("Plan");
    expect(data?.status).toBe("in_progress");
    expect(data?.entries).toEqual([]);
  });

  test("an entirely empty structured result composes undefined", () => {
    expect(composeAgentTranscriptData({}, {})).toBeUndefined();
    expect(
      composeAgentTranscriptData({}, narrowAgentStructured(null)),
    ).toBeUndefined();
  });

  test("merges reducer-linked child tool calls ahead of the wire content", () => {
    // [#step-17-5]: a subagent's intermediate tool calls (linked by
    // the reducer via `parentToolUseId`) render first; its final text
    // answer (the wire `content[]`) follows.
    const data = composeAgentTranscriptData(
      {},
      narrowAgentStructured(TEXT_ONLY_FIXTURE),
      [childCall("grep-1", "Grep"), childCall("read-1", "Read")],
    );
    expect(data?.entries.map((e) => e.kind)).toEqual([
      "tool_use",
      "tool_use",
      "text",
    ]);
    const first = data?.entries[0];
    const second = data?.entries[1];
    if (first?.kind !== "tool_use" || second?.kind !== "tool_use") {
      throw new Error("unreachable");
    }
    expect(first.toolCall.toolName).toBe("Grep");
    expect(second.toolCall.toolName).toBe("Read");
  });

  test("child tool calls alone compose a transcript (no wire content)", () => {
    const data = composeAgentTranscriptData({ subagentType: "Explore" }, {}, [
      childCall("grep-1", "Grep"),
    ]);
    expect(data).toBeDefined();
    if (data === undefined) throw new Error("unreachable");
    expect(data.agentType).toBe("Explore");
    expect(data.entries.map((e) => e.kind)).toEqual(["tool_use"]);
  });
});

// ---------------------------------------------------------------------------
// agentNestedCallCount — the trailing badge count
// ---------------------------------------------------------------------------

describe("agentNestedCallCount", () => {
  test("counts live child calls while the run streams (no structured result yet)", () => {
    expect(
      agentNestedCallCount([childCall("a", "Grep"), childCall("b", "Read")], {}),
    ).toBe(2);
  });

  test("uses the structured totalToolUseCount once the run finishes", () => {
    expect(
      agentNestedCallCount(undefined, narrowAgentStructured(TEXT_ONLY_FIXTURE)),
    ).toBe(1);
  });

  test("takes the larger of live vs reported so the badge never regresses", () => {
    // Live children outrun a stale low report…
    expect(
      agentNestedCallCount(
        [childCall("a", "Grep"), childCall("b", "Read"), childCall("c", "Bash")],
        { totalToolUseCount: 1 },
      ),
    ).toBe(3);
    // …and a final report outruns a partial child set.
    expect(
      agentNestedCallCount([childCall("a", "Grep")], { totalToolUseCount: 5 }),
    ).toBe(5);
  });

  test("is zero when nothing has run yet", () => {
    expect(agentNestedCallCount(undefined, {})).toBe(0);
    expect(agentNestedCallCount([], {})).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Body decision boundary — the body mounts the transcript iff the
// composed data has entries (the wrapper keys on entry count, not
// status, so a streaming run renders its children the moment the first
// one arrives; zero entries → no body at all, header only).
// ---------------------------------------------------------------------------

describe("body decision boundary (transcript entry count)", () => {
  test("a streaming run with only metadata composes zero entries → no body", () => {
    const data = composeAgentTranscriptData(
      { subagentType: "Explore" },
      narrowAgentStructured({ status: "in_progress" }),
    );
    expect(data?.entries.length).toBe(0);
  });

  test("the first live child call yields an entry → the transcript mounts", () => {
    const data = composeAgentTranscriptData({ subagentType: "Explore" }, {}, [
      childCall("grep-1", "Grep"),
    ]);
    expect((data?.entries.length ?? 0) > 0).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Child-source convergence — turn-attached and job-fed children merge
// into one id-deduped list, and an inline wire tool_use that repeats a
// child call's id is dropped in favor of the richer child record.
// ---------------------------------------------------------------------------

describe("mergeChildToolCalls", () => {
  test("returns undefined when both sources are absent", () => {
    expect(mergeChildToolCalls(undefined, undefined)).toBeUndefined();
  });

  test("merges overlapping sources into one entry per toolUseId, first wins", () => {
    const turnLinked = [childCall("a", "Grep"), childCall("b", "Read")];
    const jobCalls = [childCall("b", "Read"), childCall("c", "Bash")];
    const merged = mergeChildToolCalls(turnLinked, jobCalls);
    expect(merged?.map((c) => c.toolUseId)).toEqual(["a", "b", "c"]);
    // The turn-attached record wins for the overlapping id.
    expect(merged?.[1]).toBe(turnLinked[1]);
  });

  test("passes a single source through unchanged", () => {
    const jobCalls = [childCall("x", "Bash")];
    expect(mergeChildToolCalls(undefined, jobCalls)?.length).toBe(1);
  });
});

describe("composeAgentTranscriptData dedup", () => {
  test("overlapping turn-linked + job children yield one entry per toolUseId", () => {
    const merged = mergeChildToolCalls(
      [childCall("a", "Grep"), childCall("b", "Read")],
      [childCall("a", "Grep"), childCall("c", "Bash")],
    );
    const data = composeAgentTranscriptData({}, {}, merged);
    expect(data?.entries.length).toBe(3);
  });

  test("duplicate ids within one child list collapse to one entry", () => {
    const data = composeAgentTranscriptData({}, {}, [
      childCall("a", "Grep"),
      childCall("a", "Grep"),
    ]);
    expect(data?.entries.length).toBe(1);
  });

  test("an inline wire tool_use repeating a child call's id is dropped", () => {
    const structured = narrowAgentStructured({
      content: [
        { type: "tool_use", id: "a", name: "Grep", input: {} },
        { type: "text", text: "done" },
      ],
    });
    const data = composeAgentTranscriptData({}, structured, [
      childCall("a", "Grep"),
    ]);
    // One child entry + the text answer; the repeated tool_use dropped.
    expect(data?.entries.length).toBe(2);
    expect(data?.entries[1]).toEqual({ kind: "text", text: "done" });
  });
});

// ---------------------------------------------------------------------------
// SubagentHandback (v2.1.322) — the report replaces the harness stub
// ---------------------------------------------------------------------------

/** The stub the Agent call returns when its subagent handed back. */
const HANDBACK_STUB =
  "  This agent's report was delivered to you as a message from \"a084e309469c67b4f\" (its SubagentHandback call). Read it there; it is not repeated here.\n  \n  [Harness note, not part of the agent's report: WebFetch saved no files during this run.]";

function handbackCall(toolUseId: string, message: string): ToolUseMessage {
  return { ...childCall(toolUseId, "SubagentHandback"), input: { message } };
}

describe("SubagentHandback", () => {
  const stubbed = narrowAgentStructured({
    agentType: "web-fetch",
    status: "completed",
    content: [{ type: "text", text: HANDBACK_STUB }],
    totalToolUseCount: 2,
  });

  test("recognises the harness stub, and only it", () => {
    expect(isHandbackStub(HANDBACK_STUB)).toBe(true);
    expect(isHandbackStub("Chromostereopsis is a visual illusion.")).toBe(false);
  });

  test("the hand-back message replaces the stub as the final answer", () => {
    const data = composeAgentTranscriptData({}, stubbed, [
      childCall("fetch-1", "WebFetch"),
      handbackCall("hb-1", "**What it is:** a depth illusion."),
    ]);
    expect(data?.entries.map((e) => (e.kind === "text" ? e.text : e.toolCall.toolName))).toEqual([
      "WebFetch",
      "**What it is:** a depth illusion.",
    ]);
  });

  test("a stub with no hand-back in sight is dropped, never shown", () => {
    const data = composeAgentTranscriptData({}, stubbed, [childCall("fetch-1", "WebFetch")]);
    expect(data?.entries.map((e) => e.kind)).toEqual(["tool_use"]);
  });

  test("the hand-back is not counted as a call", () => {
    expect(
      agentNestedCallCount(
        [childCall("fetch-1", "WebFetch"), handbackCall("hb-1", "report")],
        stubbed,
      ),
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Dispatch routing — Agent / Task → TaskToolBlock
// ---------------------------------------------------------------------------

describe("Agent dispatch routing", () => {
  test("resolveToolBlock routes Agent (and the Task alias) to TaskToolBlock", () => {
    _resetToolBlockRegistryForTests();
    registerToolBlock("agent", TaskToolBlock);
    expect(resolveToolBlock("agent")).toBe(TaskToolBlock);
    expect(resolveToolBlock("Agent")).toBe(TaskToolBlock);
    expect(resolveToolBlock("AGENT")).toBe(TaskToolBlock);
    // The historical `Task` name resolves via the `task → agent` alias.
    expect(resolveToolBlock("Task")).toBe(TaskToolBlock);
    expect(resolveToolBlock("task")).toBe(TaskToolBlock);
  });
});

// ---------------------------------------------------------------------------
// [D17] recursion — nested tool calls dispatch at depth + 1
// ---------------------------------------------------------------------------

describe("synthetic Grep-in-subagent fixture — nested call routes via GrepToolBlock", () => {
  test("a nested Grep tool_use entry dispatches to GrepToolBlock at depth + 1", () => {
    _resetToolBlockRegistryForTests();
    registerToolBlock("grep", GrepToolBlock);
    registerToolBlock("agent", TaskToolBlock);

    const data = composeAgentTranscriptData(
      {},
      narrowAgentStructured(NESTED_GREP_FIXTURE),
    );
    const toolEntry = data?.entries[1];
    if (toolEntry?.kind !== "tool_use") throw new Error("unreachable");

    // AgentTranscriptBlock at depth 0 dispatches its nested calls at
    // depth + 1.
    const result = dispatchToolCallState(toolEntry.toolCall, 1);
    expect(result.Component).toBe(GrepToolBlock);
    expect(result.props.depth).toBe(1);
  });
});

describe("synthetic depth fixture — depth-3 renders, depth-4 collapses", () => {
  test("a nested Agent entry dispatches to TaskToolBlock carrying the deeper depth", () => {
    _resetToolBlockRegistryForTests();
    registerToolBlock("agent", TaskToolBlock);

    const data = composeAgentTranscriptData(
      {},
      narrowAgentStructured(NESTED_AGENT_FIXTURE),
    );
    const toolEntry = data?.entries[0];
    if (toolEntry?.kind !== "tool_use") throw new Error("unreachable");

    // A depth-3 AgentTranscriptBlock dispatches its nested Agent at
    // depth 4 — the nested TaskToolBlock carries `depth: 4`.
    const result = dispatchToolCallState(toolEntry.toolCall, 4);
    expect(result.Component).toBe(TaskToolBlock);
    expect(result.props.depth).toBe(4);
  });

  test("the depth cap renders depth-3 expanded and collapses depth-4", () => {
    // AGENT_MAX_DEPTH is 3: a depth-3 transcript renders expanded, a
    // depth-4 one starts collapsed behind the "+N nested calls" cue.
    expect(AGENT_MAX_DEPTH).toBe(3);
    expect(shouldCollapseAgentDepth(3)).toBe(false);
    expect(shouldCollapseAgentDepth(4)).toBe(true);
  });
});
