/**
 * reducer.subagent-child-routing.test.ts — a subagent child's identity
 * and input arrive as two wire events (`content_block_start` opens the
 * call, `tool_use` fills the input). Both must land on the SAME record:
 * a job-owned child (backgrounded agent) lives on the job ledger from
 * the open onward; a scratch-minted child keeps the fill even when a
 * job lands between its open and its fill. A split produces the bare
 * "Bash — no command, forever pending" row.
 */

import { describe, expect, test } from "bun:test";

import {
  reduce,
  createInitialState,
  type CodeSessionState,
} from "@/lib/code-session-store/reducer";
import type { CodeSessionEvent } from "@/lib/code-session-store/events";
import type { ToolUseMessage } from "@/lib/code-session-store/types";

const TURN_KEY = "turn-1";
const AGENT_TU = "tu-agent";
const AGENT_JOB_ID = "agent-job-1";

function fresh(): CodeSessionState {
  return createInitialState("session", "test", "new");
}

function applyAll(
  state: CodeSessionState,
  events: ReadonlyArray<CodeSessionEvent>,
): CodeSessionState {
  let current = state;
  for (const ev of events) current = reduce(current, ev).state;
  return current;
}

function send(text: string): CodeSessionEvent {
  return {
    type: "send",
    text,
    atoms: [],
    content: [{ type: "text", text }],
    turnKey: TURN_KEY,
  };
}

/** Launch a backgrounded Agent whose echo inserts a job on the ledger. */
function backgroundAgentLaunch(): CodeSessionEvent[] {
  return [
    {
      type: "content_block_start",
      msg_id: "m1",
      block_index: 0,
      kind: "tool_use",
      tool_use_id: AGENT_TU,
      tool_name: "Agent",
    },
    {
      type: "tool_use",
      msg_id: "m1",
      tool_use_id: AGENT_TU,
      tool_name: "Agent",
      input: { prompt: "explore", run_in_background: true },
      seq: 0,
    },
    {
      type: "tool_result",
      tool_use_id: AGENT_TU,
      output:
        "Async agent launched successfully.\n" +
        `agentId: ${AGENT_JOB_ID} (internal)\n` +
        "output_file: /tmp/agent.output",
      is_error: false,
    },
  ];
}

function scratchMessages(state: CodeSessionState): ReadonlyArray<unknown> {
  return state.scratch.get(TURN_KEY)?.messages ?? [];
}

function scratchToolCall(
  state: CodeSessionState,
  toolUseId: string,
): ToolUseMessage | undefined {
  return scratchMessages(state).find(
    (m): m is ToolUseMessage =>
      (m as ToolUseMessage).kind === "tool_use" &&
      (m as ToolUseMessage).toolUseId === toolUseId,
  );
}

function jobChild(
  state: CodeSessionState,
  toolUseId: string,
): ToolUseMessage | undefined {
  const job = state.jobs.find((j) => j.toolUseId === AGENT_TU);
  return job?.childCalls?.find((c) => c.toolUseId === toolUseId);
}

describe("subagent child routing — open and fill converge on one record", () => {
  test("job-owned child opens on the job ledger, not in scratch", () => {
    let state = applyAll(fresh(), [send("go"), ...backgroundAgentLaunch()]);
    expect(state.jobs.some((j) => j.toolUseId === AGENT_TU)).toBe(true);

    state = applyAll(state, [
      {
        type: "content_block_start",
        msg_id: "m2",
        block_index: 0,
        kind: "tool_use",
        tool_use_id: "c1",
        tool_name: "Bash",
        parent_tool_use_id: AGENT_TU,
      },
    ]);

    expect(scratchToolCall(state, "c1")).toBeUndefined();
    const opened = jobChild(state, "c1");
    expect(opened?.toolName).toBe("Bash");
    expect(opened?.status).toBe("pending");
    expect(opened?.parentToolUseId).toBe(AGENT_TU);

    state = applyAll(state, [
      {
        type: "tool_use",
        msg_id: "m2",
        tool_use_id: "c1",
        tool_name: "Bash",
        input: { command: "ls -la" },
        parent_tool_use_id: AGENT_TU,
        seq: 0,
      },
      { type: "tool_result", tool_use_id: "c1", output: "total 0", is_error: false },
    ]);

    // One record: still exactly one ledger child, filled and terminal,
    // with a recovered wall time; scratch never saw the call.
    const job = state.jobs.find((j) => j.toolUseId === AGENT_TU);
    expect(job?.childCalls?.length).toBe(1);
    const child = jobChild(state, "c1");
    expect((child?.input as Record<string, unknown> | undefined)?.command).toBe("ls -la");
    expect(child?.status).toBe("done");
    expect(typeof child?.toolWallMs).toBe("number");
    expect(scratchToolCall(state, "c1")).toBeUndefined();
  });

  test("scratch mint wins when the job lands between open and fill", () => {
    // Child opens BEFORE the agent's launch echo inserts the job…
    let state = applyAll(fresh(), [
      send("go"),
      {
        type: "content_block_start",
        msg_id: "m1",
        block_index: 0,
        kind: "tool_use",
        tool_use_id: AGENT_TU,
        tool_name: "Agent",
      },
      {
        type: "tool_use",
        msg_id: "m1",
        tool_use_id: AGENT_TU,
        tool_name: "Agent",
        input: { prompt: "explore", run_in_background: true },
        seq: 0,
      },
      {
        type: "content_block_start",
        msg_id: "m2",
        block_index: 0,
        kind: "tool_use",
        tool_use_id: "c2",
        tool_name: "Read",
        parent_tool_use_id: AGENT_TU,
      },
      // …the echo lands (job inserted)…
      {
        type: "tool_result",
        tool_use_id: AGENT_TU,
        output:
          "Async agent launched successfully.\n" +
          `agentId: ${AGENT_JOB_ID} (internal)\n` +
          "output_file: /tmp/agent.output",
        is_error: false,
      },
      // …then the fill arrives. It must land on the scratch mint.
      {
        type: "tool_use",
        msg_id: "m2",
        tool_use_id: "c2",
        tool_name: "Read",
        input: { file_path: "/tmp/foo.ts" },
        parent_tool_use_id: AGENT_TU,
        seq: 0,
      },
    ]);

    const minted = scratchToolCall(state, "c2");
    expect((minted?.input as Record<string, unknown> | undefined)?.file_path).toBe(
      "/tmp/foo.ts",
    );
    expect(minted?.parentToolUseId).toBe(AGENT_TU);
    expect(jobChild(state, "c2")).toBeUndefined();

    state = applyAll(state, [
      { type: "tool_result", tool_use_id: "c2", output: "file body", is_error: false },
    ]);
    const done = scratchToolCall(state, "c2");
    expect(done?.status).toBe("done");
    expect(typeof done?.toolWallMs).toBe("number");
  });

  test("foreground child's mint carries parentToolUseId from the open", () => {
    const state = applyAll(fresh(), [
      send("go"),
      {
        type: "content_block_start",
        msg_id: "m1",
        block_index: 0,
        kind: "tool_use",
        tool_use_id: "c3",
        tool_name: "Grep",
        parent_tool_use_id: "tu-foreground-agent",
      },
    ]);
    expect(scratchToolCall(state, "c3")?.parentToolUseId).toBe(
      "tu-foreground-agent",
    );
  });

  test("tail-fed child (no open) recovers wall time from frame timestamps", () => {
    let state = applyAll(fresh(), [send("go"), ...backgroundAgentLaunch()]);
    const t0 = 1_700_000_000_000;
    state = applyAll(state, [
      {
        type: "tool_use",
        msg_id: "m-c4",
        tool_use_id: "c4",
        tool_name: "Bash",
        input: { command: "pwd" },
        parent_tool_use_id: AGENT_TU,
        timestamp: t0,
        seq: 0,
      },
      {
        type: "tool_result",
        tool_use_id: "c4",
        output: "boom",
        is_error: true,
        timestamp: t0 + 1234,
      },
    ]);
    const child = jobChild(state, "c4");
    expect(child?.status).toBe("error");
    expect(child?.toolWallMs).toBe(1234);
  });
});
