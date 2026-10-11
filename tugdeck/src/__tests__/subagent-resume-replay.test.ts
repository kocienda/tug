/**
 * Subagent-resume deck replay test.
 *
 * Drives the REAL `CodeSessionStore` with the frames tugcode's resume
 * splice emits for a backgrounded agent — the parent `Agent` `tool_use`,
 * its persisted child `tool_use` / `tool_result` calls (each tagged with
 * `parent_tool_use_id`), and the composed Agent `tool_use_structured`
 * (final answer + stats). Frames are grounded in the real captured fixture
 * (`tugcode/src/__tests__/fixtures/subagent-resume/`), the same session a
 * user saw go empty after Maker ▸ Reload.
 *
 * This verifies the DECK side of the contract the splice depends on:
 *  - a child `tool_use` with `parent_tool_use_id` links under its parent
 *    Agent (reducer `handleToolUse` keeps `parentToolUseId` sticky),
 *  - `composeAgentTranscriptData` yields the child calls + the restored
 *    final answer, so the Agent block renders full instead of empty,
 *  - a child id delivered twice collapses to one message (idempotency —
 *    the still-running-at-resume case where spliced + live frames overlap).
 */

import { describe, it, expect, beforeAll } from "bun:test";

import { CodeSessionStore } from "@/lib/code-session-store";
import type { ToolUseMessage } from "@/lib/code-session-store";
import { ConnectionLifecycle } from "@/lib/connection-lifecycle";
import type { TugConnection } from "@/connection";
import { TestFrameChannel } from "@/lib/code-session-store/testing/mock-feed-store";
import { FeedId } from "@/protocol";

const TUG = "tug-subagent-resume";
const IPC_VERSION = 2;

// ---------------------------------------------------------------------------
// Fixture extraction — real captured Agent + child calls
// ---------------------------------------------------------------------------

interface ChildCall {
  toolUseId: string;
  toolName: string;
  input: unknown;
  resultOutput: string;
}

let AGENT_ID = "";
let AGENT_INPUT: Record<string, unknown> = {};
const children: ChildCall[] = [];

beforeAll(async () => {
  const fixtureDir = new URL(
    "../../../tugcode/src/__tests__/fixtures/subagent-resume/",
    import.meta.url,
  ).pathname;

  // Parent Agent id + input from the main JSONL.
  const mainText = await Bun.file(`${fixtureDir}main.jsonl`).text();
  for (const line of mainText.split("\n")) {
    if (!line.trim()) continue;
    const o = JSON.parse(line) as Record<string, unknown>;
    const msg = o.message as Record<string, unknown> | undefined;
    const content = msg?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content as Array<Record<string, unknown>>) {
      if (b.type === "tool_use" && b.name === "Agent") {
        AGENT_ID = String(b.id);
        AGENT_INPUT = (b.input as Record<string, unknown>) ?? {};
      }
    }
  }

  // Child tool_use + tool_result pairs from the subagent transcript.
  const subText = await Bun.file(
    `${fixtureDir}agent-aa523090963dd46d9.jsonl`,
  ).text();
  const pendingResults = new Map<string, string>();
  const order: Array<{ toolUseId: string; toolName: string; input: unknown }> =
    [];
  for (const line of subText.split("\n")) {
    if (!line.trim()) continue;
    const o = JSON.parse(line) as Record<string, unknown>;
    const msg = o.message as Record<string, unknown> | undefined;
    const content = msg?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content as Array<Record<string, unknown>>) {
      if (b.type === "tool_use") {
        order.push({
          toolUseId: String(b.id),
          toolName: String(b.name),
          input: b.input ?? {},
        });
      } else if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
        const out =
          typeof b.content === "string" ? b.content : JSON.stringify(b.content);
        pendingResults.set(b.tool_use_id, out);
      }
    }
  }
  for (const c of order) {
    children.push({
      ...c,
      resultOutput: pendingResults.get(c.toolUseId) ?? "",
    });
  }
});

// ---------------------------------------------------------------------------
// Store + frame helpers
// ---------------------------------------------------------------------------

function makeStore(): { store: CodeSessionStore; conn: TestFrameChannel } {
  const conn = new TestFrameChannel();
  const store = new CodeSessionStore({
    conn: conn as unknown as TugConnection,
    lifecycle: new ConnectionLifecycle(),
    tugSessionId: TUG,
    sessionMode: "new",
  });
  return { store, conn };
}

function emit(conn: TestFrameChannel, evt: Record<string, unknown>): void {
  conn.dispatchDecoded(FeedId.CODE_OUTPUT, { ...evt, tug_session_id: TUG });
}

/**
 * Drive the parent Agent turn plus its spliced children exactly as the
 * resume path delivers them: the Agent tool_use, then each child tool_use
 * (parent-linked, no content_block_start — the defensive-mint path the
 * synthesized frames hit), its tool_result, then the composed Agent
 * structured result. `duplicateFirstChild` re-sends the first child's
 * tool_use to exercise idempotency.
 */
function driveResume(
  store: CodeSessionStore,
  conn: TestFrameChannel,
  opts: { duplicateFirstChild?: boolean } = {},
): string {
  const msgId = "msg-agent";
  store.send("Explore the codebase for block-renderer deps.", []);
  emit(conn, {
    type: "content_block_start",
    msg_id: msgId,
    block_index: 0,
    kind: "tool_use",
    tool_use_id: AGENT_ID,
    tool_name: "Agent",
    ipc_version: IPC_VERSION,
  });
  emit(conn, {
    type: "tool_use",
    seq: 0,
    msg_id: msgId,
    tool_use_id: AGENT_ID,
    tool_name: "Agent",
    input: AGENT_INPUT,
    ipc_version: IPC_VERSION,
  });

  children.forEach((c, idx) => {
    const childFrame = {
      type: "tool_use",
      seq: 0,
      msg_id: `msg-child-${idx}`,
      tool_use_id: c.toolUseId,
      tool_name: c.toolName,
      input: c.input,
      parent_tool_use_id: AGENT_ID,
      ipc_version: IPC_VERSION,
    };
    emit(conn, childFrame);
    if (opts.duplicateFirstChild && idx === 0) emit(conn, childFrame);
    emit(conn, {
      type: "tool_result",
      is_error: false,
      tool_use_id: c.toolUseId,
      output: c.resultOutput,
      ipc_version: IPC_VERSION,
    });
  });

  emit(conn, {
    type: "tool_use_structured",
    tool_use_id: AGENT_ID,
    tool_name: "Agent",
    structured_result: {
      agentType: "Explore",
      status: "completed",
      content: [{ type: "text", text: "## Summary\nRestored answer." }],
      totalToolUseCount: children.length,
      totalTokens: 1234,
    },
    ipc_version: IPC_VERSION,
  });
  emit(conn, {
    type: "turn_complete",
    seq: 0,
    msg_id: msgId,
    result: "success",
    ipc_version: IPC_VERSION,
  });
  return msgId;
}

/** All committed tool_use messages across the transcript. */
function committedToolCalls(store: CodeSessionStore): ToolUseMessage[] {
  const out: ToolUseMessage[] = [];
  for (const turn of store.getSnapshot().transcript) {
    for (const m of turn.messages) {
      if (m.kind === "tool_use") out.push(m);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("subagent-resume — deck reconstruction", () => {
  it("the fixture yields a parent Agent id and child calls", () => {
    expect(AGENT_ID).toMatch(/^toolu_/);
    expect(children.length).toBeGreaterThanOrEqual(3);
  });

  it("links spliced children under the parent Agent and composes them", () => {
    const { store, conn } = makeStore();
    driveResume(store, conn);

    const calls = committedToolCalls(store);
    const agent = calls.find((m) => m.toolUseId === AGENT_ID);
    expect(agent).toBeDefined();

    // Every persisted child links under the Agent — this is what
    // `groupToolCallsByParent` partitions into the block's children, and
    // what `composeAgentTranscriptData` (unit-tested in task-tool-block)
    // renders. The empty-block regression is: zero linked children.
    const linked = calls.filter((m) => m.parentToolUseId === AGENT_ID);
    expect(linked.length).toBe(children.length);
    expect(linked.length).toBeGreaterThan(0);

    // The restored final answer rides the composed structured result — so
    // the block shows an answer + footer stats, not an empty body.
    const sr = agent!.structuredResult as {
      content?: Array<{ type: string; text?: string }>;
      totalToolUseCount?: number;
    } | null;
    expect(sr).not.toBeNull();
    expect((sr!.content ?? []).some((c) => c.type === "text")).toBe(true);
    expect(sr!.totalToolUseCount).toBe(children.length);
  });

  it("dedupes a child delivered twice (still-running-at-resume overlap)", () => {
    const { store, conn } = makeStore();
    driveResume(store, conn, { duplicateFirstChild: true });

    const calls = committedToolCalls(store);
    const firstChildId = children[0].toolUseId;
    const dupes = calls.filter((m) => m.toolUseId === firstChildId);
    // One message despite two tool_use frames sharing the id.
    expect(dupes).toHaveLength(1);
    expect(dupes[0].parentToolUseId).toBe(AGENT_ID);
  });
});
