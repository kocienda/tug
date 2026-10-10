/**
 * Reducer tests for the per-turn diagnostics suite: `ttftMs`,
 * `ttftcMs`, `maxStreamGapMs`, `turnEndReason`, and the per-tool
 * `ToolUseMessage.toolWallMs`.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";

import {
  reduce,
  createInitialState,
  type CodeSessionState,
} from "@/lib/code-session-store/reducer";
import type { CodeSessionEvent } from "@/lib/code-session-store/events";
import type {
  AppendTranscriptEffect,
  Effect,
} from "@/lib/code-session-store/effects";
import { FIXTURE_IDS } from "@/lib/code-session-store/testing/golden-catalog";

function fresh(): CodeSessionState {
  return createInitialState(FIXTURE_IDS.TUG_SESSION_ID, "test", "new");
}

function appended(effects: ReadonlyArray<Effect>) {
  return effects.filter(
    (e): e is AppendTranscriptEffect => e.kind === "append-transcript",
  );
}

function applyAll(
  state: CodeSessionState,
  events: ReadonlyArray<CodeSessionEvent>,
): { state: CodeSessionState; effects: Effect[] } {
  let current = state;
  const collected: Effect[] = [];
  for (const ev of events) {
    const r = reduce(current, ev);
    current = r.state;
    collected.push(...r.effects);
  }
  return { state: current, effects: collected };
}

let now = 0;
let originalDateNow: () => number;
beforeEach(() => {
  now = 3_000_000_000;
  originalDateNow = Date.now;
  Date.now = () => now;
});
afterEach(() => {
  Date.now = originalDateNow;
});

function advance(ms: number): void {
  now += ms;
}

describe("reducer — diagnostics", () => {
  it("ttftMs is the time from submitAt to first assistant_text", () => {
    const { state: s1 } = applyAll(fresh(), [
      { type: "send", text: "hi", atoms: [], content: [{ type: "text" as const, text: "hi" }], turnKey: "k1" },
    ]);
    const submitAt = s1.pendingTurn!.submitAt;
    advance(200);
    const { state: s2 } = applyAll(s1, [
      {
        type: "assistant_text",
        msg_id: "m1",
      block_index: 0,
      text: "thinking",
        is_partial: true,
        seq: 0,
        rev: 0,
        status: "partial",
      },
    ]);
    expect(s2.firstAssistantDeltaAt).toBe(submitAt + 200);
    advance(50);
    const { effects } = applyAll(s2, [
      { type: "turn_complete", msg_id: "m1", result: "success", seq: 0 },
    ]);
    const entry = appended(effects)[0].entry;
    expect(entry.ttftMs).toBe(200);
    expect(entry.ttftcMs).toBeNull(); // no tool calls
  });

  it("ttftcMs is the time from submitAt to first tool_use", () => {
    const { state: s1 } = applyAll(fresh(), [
      { type: "send", text: "hi", atoms: [], content: [{ type: "text" as const, text: "hi" }], turnKey: "k1" },
    ]);
    const submitAt = s1.pendingTurn!.submitAt;
    advance(120);
    const { state: s2 } = applyAll(s1, [
      {
        type: "tool_use",
        msg_id: "m1",
        tool_use_id: "t1",
        tool_name: "Bash",
        input: { command: "ls" },
        seq: 0,
      },
    ]);
    expect(s2.firstToolUseAt).toBe(submitAt + 120);
    advance(80);
    const { state: s3 } = applyAll(s2, [
      {
        type: "tool_result",
        tool_use_id: "t1",
        output: "ok",
        is_error: false,
      },
    ]);
    const turn3Scratch = s3.scratch.get("k1")!;
    const t1Idx3 = turn3Scratch.toolCallIndex.get("t1")!;
    const t1Msg = turn3Scratch.messages[t1Idx3];
    if (t1Msg.kind !== "tool_use") throw new Error("expected tool_use");
    expect(t1Msg.toolWallMs).toBe(80);
    advance(40);
    const { effects } = applyAll(s3, [
      { type: "turn_complete", msg_id: "m1", result: "success", seq: 0 },
    ]);
    const entry = appended(effects)[0].entry;
    expect(entry.ttftMs).toBeNull(); // no assistant_text in this turn
    expect(entry.ttftcMs).toBe(120);
    const toolMsg = entry.messages.find((m) => m.kind === "tool_use");
    expect(toolMsg?.kind === "tool_use" ? toolMsg.toolWallMs : null).toBe(80);
  });

  it("maxStreamGapMs captures the largest inter-event gap", () => {
    const { state: s1 } = applyAll(fresh(), [
      { type: "send", text: "hi", atoms: [], content: [{ type: "text" as const, text: "hi" }], turnKey: "k1" },
    ]);
    advance(50);
    const { state: s2 } = applyAll(s1, [
      {
        type: "assistant_text",
        msg_id: "m1",
      block_index: 0,
      text: "a",
        is_partial: true,
        seq: 0,
        rev: 0,
        status: "partial",
      },
    ]);
    advance(150);
    const { state: s3 } = applyAll(s2, [
      {
        type: "assistant_text",
        msg_id: "m1",
      block_index: 0,
      text: "b",
        is_partial: true,
        seq: 0,
        rev: 0,
        status: "partial",
      },
    ]);
    expect(s3.maxStreamGapMs).toBe(150);
    advance(700);
    const { state: s4 } = applyAll(s3, [
      {
        type: "assistant_text",
        msg_id: "m1",
      block_index: 0,
      text: "c",
        is_partial: true,
        seq: 0,
        rev: 0,
        status: "partial",
      },
    ]);
    expect(s4.maxStreamGapMs).toBe(700);
    advance(30);
    const { effects } = applyAll(s4, [
      { type: "turn_complete", msg_id: "m1", result: "success", seq: 0 },
    ]);
    expect(appended(effects)[0].entry.maxStreamGapMs).toBe(700);
  });

  it("turnEndReason: a clean completion lands as 'complete'", () => {
    const { effects } = applyAll(fresh(), [
      { type: "send", text: "hi", atoms: [], content: [{ type: "text" as const, text: "hi" }], turnKey: "k1" },
      {
        type: "assistant_text",
        msg_id: "m1",
      block_index: 0,
      text: "done",
        is_partial: false,
        seq: 0,
        rev: 0,
        status: "complete",
      },
      { type: "turn_complete", msg_id: "m1", result: "success", seq: 0 },
    ]);
    expect(appended(effects)[0].entry.turnEndReason).toBe("complete");
  });

  it("turnEndReason: an interrupted turn (CASE B) lands as 'interrupted'", () => {
    const { state } = applyAll(fresh(), [
      { type: "send", text: "hi", atoms: [], content: [{ type: "text" as const, text: "hi" }], turnKey: "k1" },
      {
        type: "assistant_text",
        msg_id: "m1",
      block_index: 0,
      text: "partial",
        is_partial: true,
        seq: 0,
        rev: 0,
        status: "partial",
      },
      { type: "interrupt_action" },
    ]);
    expect(state.interruptInFlight).toBe(true);
    const { effects } = applyAll(state, [
      { type: "turn_complete", msg_id: "m1", result: "error", seq: 0 },
    ]);
    const entry = appended(effects)[0].entry;
    expect(entry.turnEndReason).toBe("interrupted");
    expect(entry.result).toBe("interrupted");
  });

  it("turnEndReason: a wire error without a preceding interrupt lands as 'error'", () => {
    const { state } = applyAll(fresh(), [
      { type: "send", text: "hi", atoms: [], content: [{ type: "text" as const, text: "hi" }], turnKey: "k1" },
      {
        type: "assistant_text",
        msg_id: "m1",
      block_index: 0,
      text: "partial",
        is_partial: true,
        seq: 0,
        rev: 0,
        status: "partial",
      },
    ]);
    expect(state.interruptInFlight).toBe(false);
    const { effects } = applyAll(state, [
      { type: "turn_complete", msg_id: "m1", result: "error", seq: 0 },
    ]);
    expect(appended(effects)[0].entry.turnEndReason).toBe("error");
  });
});
