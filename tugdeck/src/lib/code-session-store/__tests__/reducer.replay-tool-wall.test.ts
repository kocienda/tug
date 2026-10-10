/**
 * Reducer test — replay-path `toolWallMs` reconstruction.
 *
 * On resume the wall clock is meaningless (JSONL replays instantly), so
 * the replay translator stamps each `tool_use` / `tool_result` frame with
 * the original JSONL entry time (`timestamp`, epoch ms). The reducer must
 * recover the call's wall time from that pair — including for a subagent's
 * child call, which lands via the same defensive `tool_use` mint (no
 * `content_block_start`) as a top-level replayed call.
 */
import { describe, it, expect } from "bun:test";

import {
  reduce,
  createInitialState,
  type CodeSessionState,
} from "@/lib/code-session-store/reducer";
import type { CodeSessionEvent } from "@/lib/code-session-store/events";
import { FIXTURE_IDS } from "@/lib/code-session-store/testing/golden-catalog";

function fresh(): CodeSessionState {
  return createInitialState(FIXTURE_IDS.TUG_SESSION_ID, "test", "new");
}

function applyAll(
  state: CodeSessionState,
  events: ReadonlyArray<CodeSessionEvent>,
): CodeSessionState {
  let cur = state;
  for (const ev of events) cur = reduce(cur, ev).state;
  return cur;
}

function toolWallOf(
  state: CodeSessionState,
  turnKey: string,
  toolUseId: string,
): number | null | undefined {
  const scratch = state.scratch.get(turnKey);
  const idx = scratch?.toolCallIndex.get(toolUseId);
  const msg = idx !== undefined ? scratch!.messages[idx] : undefined;
  return msg && msg.kind === "tool_use" ? msg.toolWallMs : undefined;
}

describe("reducer — replay toolWallMs from frame timestamps", () => {
  it("reconstructs wall time for a replayed top-level call and its subagent child", () => {
    const T0 = 1_700_000_000_000;
    let s = applyAll(fresh(), [{ type: "replay_started" }]);
    expect(s.phase).toBe("replaying");

    // Open a replayed turn with a top-level Task call (2s) and a subagent
    // child Bash call (750ms) carrying original JSONL timestamps.
    s = applyAll(s, [
      { type: "add_user_message", text: "go", atoms: [], turnKey: "tk1" },
      {
        type: "tool_use",
        msg_id: "m1",
        tool_use_id: "parent",
        tool_name: "Task",
        input: { description: "d" },
        timestamp: T0,
        seq: 0,
      },
      {
        type: "tool_use",
        msg_id: "m1",
        tool_use_id: "child",
        tool_name: "Bash",
        input: { command: "ls" },
        parent_tool_use_id: "parent",
        timestamp: T0 + 500,
        seq: 0,
      },
      {
        type: "tool_result",
        tool_use_id: "child",
        output: "ok",
        is_error: false,
        timestamp: T0 + 1_250,
      },
      {
        type: "tool_result",
        tool_use_id: "parent",
        output: "done",
        is_error: false,
        timestamp: T0 + 2_000,
      },
    ]);

    // Parent Task: 2000ms. Child Bash: 750ms. Both from frame timestamps,
    // NOT the (instant) replay wall clock.
    expect(toolWallOf(s, "tk1", "parent")).toBe(2_000);
    expect(toolWallOf(s, "tk1", "child")).toBe(750);
  });

  it("live call (no frame timestamp) still uses the wall clock", () => {
    const realNow = Date.now;
    let now = 5_000_000_000;
    Date.now = () => now;
    try {
      let s = applyAll(fresh(), [
        { type: "send", text: "hi", atoms: [], content: [{ type: "text", text: "hi" }], turnKey: "k1" },
        { type: "tool_use", msg_id: "m1", tool_use_id: "t1", tool_name: "Bash", input: { command: "ls" }, seq: 0 },
      ]);
      now += 120;
      s = applyAll(s, [
        { type: "tool_result", tool_use_id: "t1", output: "ok", is_error: false },
      ]);
      expect(toolWallOf(s, "k1", "t1")).toBe(120);
    } finally {
      Date.now = realNow;
    }
  });
});
