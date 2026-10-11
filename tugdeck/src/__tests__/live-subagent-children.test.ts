/**
 * Live subagent-children routing test.
 *
 * A backgrounded `Agent` runs AFTER its launching turn commits, so its
 * child tool calls arrive inter-turn — a phase where the reducer's turn
 * handlers bail. This drives the REAL `CodeSessionStore` through that exact
 * sequence (launch → async echo → turn_complete → inter-turn children) and
 * asserts the children are routed onto the job ledger (`JobItem.childCalls`)
 * rather than dropped, so the Agent block can render them live. Frames use
 * the real 2.1.197 shapes (async-launch echo, `parent_tool_use_id` children).
 */

import { describe, it, expect } from "bun:test";

import { CodeSessionStore } from "@/lib/code-session-store";
import { ConnectionLifecycle } from "@/lib/connection-lifecycle";
import type { TugConnection } from "@/connection";
import { TestFrameChannel } from "@/lib/code-session-store/testing/mock-feed-store";
import { FeedId } from "@/protocol";
import {
  composeAgentTranscriptData,
  mergeChildToolCalls,
  narrowAgentInput,
  narrowAgentStructured,
} from "@/components/tugways/cards/blocks/task-tool-block";

const TUG = "tug-live-subagent";
const IPC_VERSION = 2;
const MSG = "m-agent";
const AGENT_TU = "toolu_agent1"; // the Agent tool_use id (job.toolUseId)
const AGENT_ID = "aab9c08ad28ba7eac"; // the async agentId (job.jobId)

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

/** Launch a backgrounded Agent and commit its turn — the job now exists. */
function launchBackgroundAgent(
  store: CodeSessionStore,
  conn: TestFrameChannel,
): void {
  store.send("Explore the codebase for block-renderer deps.", []);
  emit(conn, {
    type: "content_block_start",
    msg_id: MSG,
    block_index: 0,
    kind: "tool_use",
    tool_use_id: AGENT_TU,
    tool_name: "Agent",
    ipc_version: IPC_VERSION,
  });
  emit(conn, {
    type: "tool_use",
    seq: 0,
    msg_id: MSG,
    tool_use_id: AGENT_TU,
    tool_name: "Agent",
    input: { description: "Find block renderer dependencies", subagent_type: "Explore" },
    ipc_version: IPC_VERSION,
  });
  // The async-launch echo — creates the background-agent job.
  emit(conn, {
    type: "tool_result",
    is_error: false,
    tool_use_id: AGENT_TU,
    output:
      "Async agent launched successfully.\nagentId: " +
      AGENT_ID +
      " (internal ID). output_file: /tmp/" +
      AGENT_ID +
      ".output",
    ipc_version: IPC_VERSION,
  });
  // The launching turn ends — the agent runs on in the background.
  emit(conn, {
    type: "turn_complete",
    seq: 0,
    msg_id: MSG,
    result: "success",
    ipc_version: IPC_VERSION,
  });
}

/** Emit one inter-turn child call (tool_use + tool_result), parent-linked. */
function emitChild(
  conn: TestFrameChannel,
  id: string,
  command: string,
  output: string,
): void {
  emit(conn, {
    type: "tool_use",
    seq: 0,
    msg_id: `m-child-${id}`,
    tool_use_id: id,
    tool_name: "Bash",
    input: { command },
    parent_tool_use_id: AGENT_TU,
    ipc_version: IPC_VERSION,
  });
  emit(conn, {
    type: "tool_result",
    is_error: false,
    tool_use_id: id,
    output,
    ipc_version: IPC_VERSION,
  });
}

describe("live subagent children — inter-turn routing to the job", () => {
  it("routes inter-turn children onto job.childCalls with results", () => {
    const { store, conn } = makeStore();
    launchBackgroundAgent(store, conn);

    // Sanity: the job exists and the launching turn committed (idle).
    expect(store.getSnapshot().jobs).toHaveLength(1);
    expect(store.getSnapshot().jobs[0].toolUseId).toBe(AGENT_TU);

    emitChild(conn, "toolu_c1", "find . -name '*.ts'", "a.ts\nb.ts");
    emitChild(conn, "toolu_c2", "grep -r Block .", "match1\nmatch2");

    const job = store.getSnapshot().jobs[0];
    const children = job.childCalls ?? [];
    expect(children).toHaveLength(2);
    expect(children.map((c) => c.toolUseId)).toEqual(["toolu_c1", "toolu_c2"]);
    expect(children.every((c) => c.toolName === "Bash")).toBe(true);
    expect(children.every((c) => c.parentToolUseId === AGENT_TU)).toBe(true);
    // Results folded on, status flipped to done.
    expect(children[0].status).toBe("done");
    expect(children[0].result).toBe("a.ts\nb.ts");
    expect(children[1].result).toBe("match1\nmatch2");
  });

  it("dedupes a child redelivered (live/resume overlap)", () => {
    const { store, conn } = makeStore();
    launchBackgroundAgent(store, conn);
    emitChild(conn, "toolu_c1", "find .", "out");
    // Redeliver the same child tool_use (as a resume splice would).
    emit(conn, {
      type: "tool_use",
      seq: 0,
      msg_id: "m-child-dup",
      tool_use_id: "toolu_c1",
      tool_name: "Bash",
      input: { command: "find ." },
      parent_tool_use_id: AGENT_TU,
      ipc_version: IPC_VERSION,
    });
    const children = store.getSnapshot().jobs[0].childCalls ?? [];
    expect(children).toHaveLength(1);
  });

  it("folds the agent's composed structured result onto the job, ignoring the async echo", () => {
    const { store, conn } = makeStore();
    launchBackgroundAgent(store, conn);
    // The composed final answer (what the tailer emits on completion).
    emit(conn, {
      type: "tool_use_structured",
      tool_use_id: AGENT_TU,
      tool_name: "Agent",
      structured_result: {
        agentType: "Explore",
        status: "completed",
        content: [{ type: "text", text: "## Summary\nFound 42 files." }],
        totalToolUseCount: 2,
      },
      ipc_version: IPC_VERSION,
    });
    const sr = store.getSnapshot().jobs[0].agentStructuredResult as {
      status?: string;
      content?: unknown[];
    } | undefined;
    expect(sr?.status).toBe("completed");
    expect(sr?.content).toHaveLength(1);
  });

  it("re-hydrates a running agent job from an orphan task_progress after reload", () => {
    const { store, conn } = makeStore();
    // Fresh store, empty ledger — the post-reload state (replay never
    // populates jobs). The still-running agent's tick re-hydrates it.
    emit(conn, {
      type: "task_progress",
      task_id: AGENT_ID,
      tool_use_id: AGENT_TU,
      description: "Find block renderer dependencies",
      last_tool_name: "Bash",
      usage: { total_tokens: 1200, tool_uses: 3 },
      ipc_version: IPC_VERSION,
    });
    const jobs = store.getSnapshot().jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].jobId).toBe(AGENT_ID);
    expect(jobs[0].toolUseId).toBe(AGENT_TU);
    expect(jobs[0].kind).toBe("agent");
    expect(jobs[0].status).toBe("running");
    expect(jobs[0].progress?.lastToolName).toBe("Bash");

    // The re-hydrated job owns the tailer's re-streamed children.
    emitChild(conn, "toolu_r1", "ls", "file.ts");
    expect(store.getSnapshot().jobs[0].childCalls).toHaveLength(1);

    // A subsequent terminal update flips it as usual.
    emit(conn, {
      type: "task_updated",
      task_id: AGENT_ID,
      status: "completed",
      ipc_version: IPC_VERSION,
    });
    expect(store.getSnapshot().jobs[0].status).toBe("completed");
  });

  it("a replaying-phase orphan tick inserts nothing", () => {
    const { store, conn } = makeStore();
    emit(conn, {
      type: "replay_started",
      session_id: TUG,
      ipc_version: IPC_VERSION,
    });
    emit(conn, {
      type: "task_progress",
      task_id: AGENT_ID,
      tool_use_id: AGENT_TU,
      description: "Find block renderer dependencies",
      last_tool_name: "Bash",
      usage: { total_tokens: 100 },
      ipc_version: IPC_VERSION,
    });
    expect(store.getSnapshot().jobs).toHaveLength(0);
  });

  it("a foreground agent's mid-turn tick does not mint a phantom job", () => {
    const { store, conn } = makeStore();
    // A live turn with an open (foreground) Agent call in scratch.
    store.send("explore", []);
    emit(conn, {
      type: "tool_use",
      seq: 0,
      msg_id: "m-fg-agent",
      tool_use_id: "toolu_fg_agent",
      tool_name: "Agent",
      input: { description: "look around", subagent_type: "Explore" },
      ipc_version: IPC_VERSION,
    });
    emit(conn, {
      type: "task_progress",
      task_id: "fg-task-1",
      tool_use_id: "toolu_fg_agent",
      description: "look around",
      last_tool_name: "Read",
      usage: { total_tokens: 50 },
      ipc_version: IPC_VERSION,
    });
    expect(store.getSnapshot().jobs).toHaveLength(0);
  });

  it("does not create phantom children for a foreground agent (no job)", () => {
    const { store, conn } = makeStore();
    // No background launch → no job. A parent-linked child with no job must
    // NOT be routed to the ledger (it belongs to a live foreground turn).
    store.send("do it", []);
    emit(conn, {
      type: "tool_use",
      seq: 0,
      msg_id: "m-fg",
      tool_use_id: "toolu_fg_child",
      tool_name: "Bash",
      input: { command: "ls" },
      parent_tool_use_id: "toolu_some_fg_agent",
      ipc_version: IPC_VERSION,
    });
    expect(store.getSnapshot().jobs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Derived transcript — the exact composition the Agent block renders,
// run over the REAL store's job ledger: launch echo → streamed children
// → composed final answer, through mergeChildToolCalls +
// composeAgentTranscriptData (the block's own helpers).
// ---------------------------------------------------------------------------

describe("live subagent children — the derived Agent-block transcript", () => {
  /** The composed final answer the tailer emits on genuine completion. */
  const COMPOSED_ANSWER = {
    agentType: "Explore",
    status: "completed",
    content: [{ type: "text", text: "## Summary\nFound 42 files." }],
    totalToolUseCount: 2,
    totalTokens: 35700,
    totalDurationMs: 61234,
  };

  /** Derive what TaskToolBlock renders from the live store snapshot. */
  function deriveTranscript(store: CodeSessionStore) {
    const job = store
      .getSnapshot()
      .jobs.find((j) => j.toolUseId === AGENT_TU);
    const input = narrowAgentInput({
      description: "Find block renderer dependencies",
      subagent_type: "Explore",
    });
    // Live path: no turn-attached children (the launch echo's own
    // structuredResult is just the async echo, so the job's composed
    // result wins — mirroring `job?.agentStructuredResult ?? structuredResult`).
    const children = mergeChildToolCalls(undefined, job?.childCalls);
    const structured = narrowAgentStructured(job?.agentStructuredResult);
    return composeAgentTranscriptData(input, structured, children);
  }

  it("streamed children + the composed answer yield the full rendered transcript", () => {
    const { store, conn } = makeStore();
    launchBackgroundAgent(store, conn);
    emitChild(conn, "toolu_c1", "find . -name '*.ts'", "a.ts\nb.ts");

    // Mid-run: child entries render, but NO final answer — the tailer
    // has not composed yet, so the job carries no structured result.
    const midRun = deriveTranscript(store);
    expect(midRun?.entries).toHaveLength(1);
    expect(midRun?.entries[0].kind).toBe("tool_use");
    expect(midRun?.status).toBeUndefined();
    expect(
      midRun?.entries.some((e) => e.kind === "text"),
    ).toBe(false);

    emitChild(conn, "toolu_c2", "grep -r Block .", "match1\nmatch2");
    emit(conn, {
      type: "tool_use_structured",
      tool_use_id: AGENT_TU,
      tool_name: "Agent",
      structured_result: COMPOSED_ANSWER,
      ipc_version: IPC_VERSION,
    });

    const done = deriveTranscript(store);
    expect(done).toBeDefined();
    // Two child tool calls, in producer order, then the final answer.
    expect(done!.entries).toHaveLength(3);
    expect(done!.entries[0]).toMatchObject({
      kind: "tool_use",
      toolCall: { toolUseId: "toolu_c1", toolName: "Bash", status: "done" },
    });
    expect(done!.entries[1]).toMatchObject({
      kind: "tool_use",
      toolCall: { toolUseId: "toolu_c2", toolName: "Bash" },
    });
    expect(done!.entries[2]).toEqual({
      kind: "text",
      text: "## Summary\nFound 42 files.",
    });
    // Footer stats from the composed result.
    expect(done!.status).toBe("completed");
    expect(done!.toolUseCount).toBe(2);
    expect(done!.totalTokens).toBe(35700);
    expect(done!.durationMs).toBe(61234);
    expect(done!.agentType).toBe("Explore");
  });

  it("a redelivered child (live/resume overlap) does not duplicate a rendered entry", () => {
    const { store, conn } = makeStore();
    launchBackgroundAgent(store, conn);
    emitChild(conn, "toolu_c1", "find .", "out");

    const job = store.getSnapshot().jobs[0];
    // The resume splice's turn-attached copy of the same child — the
    // reload-mid-run overlap the block's merge must fuse.
    const turnAttachedCopy = (job.childCalls ?? []).map((c) => ({ ...c }));
    const merged = mergeChildToolCalls(turnAttachedCopy, job.childCalls);
    const data = composeAgentTranscriptData({}, {}, merged);
    expect(data?.entries).toHaveLength(1);
    expect(data?.entries[0]).toMatchObject({
      kind: "tool_use",
      toolCall: { toolUseId: "toolu_c1" },
    });
  });
});
