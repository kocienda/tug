/**
 * Reducer tests for the retract intent on the interrupt wire frame.
 *
 * A CASE A pull-down (interrupt before any answer content) of a
 * user-origin turn is a retraction: the row leaves the local transcript
 * and the draft returns to the composer, so the frame must carry
 * `retract: true` — tugcode truncates the prompt out of the session
 * JSONL so claude's history matches what the user sees. CASE B (answer
 * content has begun) and assistant-origin CASE A (a wake — no user
 * submission to retract) stay plain interrupts.
 *
 * The pull-down mechanics themselves (draft restore, echo suppression,
 * accumulator resets) are covered elsewhere; this file pins only the
 * wire-frame shape per case.
 */

import { describe, it, expect } from "bun:test";

import {
  reduce,
  createInitialState,
  type CodeSessionState,
} from "@/lib/code-session-store/reducer";
import type { CodeSessionEvent } from "@/lib/code-session-store/events";
import type { Effect } from "@/lib/code-session-store/effects";
import { FIXTURE_IDS } from "@/lib/code-session-store/testing/golden-catalog";

function fresh(): CodeSessionState {
  return createInitialState(FIXTURE_IDS.TUG_SESSION_ID, "test", "new");
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

function sentFrames(effects: Effect[]): unknown[] {
  return effects
    .filter((e) => e.kind === "send-frame")
    .map((e) => (e as { kind: "send-frame"; msg: unknown }).msg);
}

describe("reducer — interrupt retract intent", () => {
  it("CASE A on a user-origin turn sends `interrupt{retract:true}`", () => {
    const { state: submitted } = applyAll(fresh(), [
      {
        type: "send",
        text: "fat-fingered",
        atoms: [],
        content: [{ type: "text" as const, text: "fat-fingered" }],
        turnKey: "k1",
      },
    ]);
    const { state: after, effects } = applyAll(submitted, [
      { type: "interrupt_action" },
    ]);
    expect(sentFrames(effects)).toEqual([{ type: "interrupt", retract: true }]);
    // The retraction pairs with the local pull-down: draft offered back,
    // phase idle.
    expect(after.pendingDraftRestore?.text).toBe("fat-fingered");
    expect(after.phase).toBe("idle");
  });

  it("CASE A after thinking-only content still retracts (thinking is not an answer)", () => {
    const { state: submitted } = applyAll(fresh(), [
      {
        type: "send",
        text: "fat-fingered",
        atoms: [],
        content: [{ type: "text" as const, text: "fat-fingered" }],
        turnKey: "k1",
      },
      {
        type: "thinking_text",
        msg_id: "m1",
        block_index: 0,
        text: "hmm",
        is_partial: true,
        seq: 0,
        status: "partial",
      },
    ]);
    const { effects } = applyAll(submitted, [{ type: "interrupt_action" }]);
    expect(sentFrames(effects)).toEqual([{ type: "interrupt", retract: true }]);
  });

  it("CASE B (answer content has begun) sends a plain `interrupt`", () => {
    const { state: streaming } = applyAll(fresh(), [
      {
        type: "send",
        text: "keep me",
        atoms: [],
        content: [{ type: "text" as const, text: "keep me" }],
        turnKey: "k1",
      },
      {
        type: "assistant_text",
        msg_id: "m1",
        block_index: 0,
        text: "partial answer",
        is_partial: true,
        seq: 0,
        rev: 0,
        status: "partial",
      },
    ]);
    const { effects } = applyAll(streaming, [{ type: "interrupt_action" }]);
    expect(sentFrames(effects)).toEqual([{ type: "interrupt" }]);
  });

  it("CASE A on an assistant-origin wake turn sends a plain `interrupt`", () => {
    const { state: waking } = applyAll(fresh(), [
      {
        type: "wake_started",
        session_id: "s",
        wake_trigger: {
          task_id: "t1",
          tool_use_id: "",
          status: "completed",
          summary: "",
          output_file: "",
        },
        turnKey: "w1",
      },
    ]);
    const { effects } = applyAll(waking, [{ type: "interrupt_action" }]);
    expect(sentFrames(effects)).toEqual([{ type: "interrupt" }]);
  });
});
