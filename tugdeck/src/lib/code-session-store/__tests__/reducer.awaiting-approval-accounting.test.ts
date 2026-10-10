/**
 * Reducer tests for the awaiting-approval clock — the cumulative time
 * a turn spent paused on a `TugInlineDialog` waiting for a user answer.
 *
 * Pins:
 *   - one permission dialog folds correctly,
 *   - two sequential permission dialogs accumulate,
 *   - a question dialog accumulates the same way (same fold helper),
 *   - a CASE B interrupt that fires while paused folds the in-progress
 *     interval so the committed entry reports the full wait,
 *   - a turn with no dialogs commits with `awaitingApprovalMs === 0`.
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

function appendedEntries(effects: ReadonlyArray<Effect>) {
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

// `Date.now()` is the only impurity in the reducer; pin it for
// deterministic time accounting. Each test asserts intervals between
// scheduled ticks so the math is exact.
let now = 0;
let originalDateNow: () => number;
beforeEach(() => {
  now = 1_000_000_000;
  originalDateNow = Date.now;
  Date.now = () => now;
});
afterEach(() => {
  Date.now = originalDateNow;
});

function advance(ms: number): void {
  now += ms;
}

describe("reducer — awaiting-approval accounting", () => {
  it("a turn with one permission dialog accumulates the wait into TurnEntry.awaitingApprovalMs", () => {
    // submit → assistant_text (kicks awaiting_first_token → streaming)
    // → control_request_forward (paused) → respond_approval → turn_complete
    const { state: s1 } = applyAll(fresh(), [
      { type: "send", text: "hi", atoms: [], content: [{ type: "text" as const, text: "hi" }], turnKey: "k1" },
    ]);
    advance(50);
    const { state: s2 } = applyAll(s1, [
      {
        type: "assistant_text",
        msg_id: "m1",
      block_index: 0,
      text: "hello",
        is_partial: true,
        seq: 0,
        rev: 0,
        status: "partial",
      },
    ]);
    advance(20);
    const { state: s3 } = applyAll(s2, [
      {
        type: "control_request_forward",
        request_id: "rq1",
        is_question: false,
        tool_name: "Edit",
        input: {},
      },
    ]);
    expect(s3.awaitingApprovalSince).toBe(now);
    advance(2_000); // user takes 2 seconds to allow
    const { state: s4 } = applyAll(s3, [
      {
        type: "respond_approval",
        request_id: "rq1",
        decision: "allow",
        updatedInput: undefined,
        message: undefined,
      },
    ]);
    expect(s4.awaitingApprovalSince).toBeNull();
    expect(s4.awaitingApprovalAccumulatedMs).toBe(2_000);
    advance(10);
    const { state: s5, effects } = applyAll(s4, [
      {
        type: "turn_complete",
        msg_id: "m1",
        result: "success",
        seq: 0,
      },
    ]);
    expect(s5.awaitingApprovalAccumulatedMs).toBe(0); // reset after commit
    const appended = appendedEntries(effects);
    expect(appended.length).toBe(1);
    expect(appended[0].entry.awaitingApprovalMs).toBe(2_000);
    expect(appended[0].entry.turnEndReason).toBe("complete");
    // activeMs = wallClockMs - awaitingApprovalMs (and 0 downtime)
    expect(appended[0].entry.activeMs).toBe(
      appended[0].entry.wallClockMs - 2_000,
    );
  });

  it("two sequential permission dialogs accumulate the sum", () => {
    const seeded = applyAll(fresh(), [
      { type: "send", text: "hi", atoms: [], content: [{ type: "text" as const, text: "hi" }], turnKey: "k1" },
      {
        type: "assistant_text",
        msg_id: "m1",
      block_index: 0,
      text: "hello",
        is_partial: true,
        seq: 0,
        rev: 0,
        status: "partial",
      },
    ]).state;

    const { state: a } = applyAll(seeded, [
      {
        type: "control_request_forward",
        request_id: "rq1",
        is_question: false,
        tool_name: "Edit",
        input: {},
      },
    ]);
    advance(500);
    const { state: b } = applyAll(a, [
      {
        type: "respond_approval",
        request_id: "rq1",
        decision: "allow",
        updatedInput: undefined,
        message: undefined,
      },
    ]);
    expect(b.awaitingApprovalAccumulatedMs).toBe(500);

    advance(100);
    const { state: c } = applyAll(b, [
      {
        type: "control_request_forward",
        request_id: "rq2",
        is_question: false,
        tool_name: "Write",
        input: {},
      },
    ]);
    advance(750);
    const { state: d } = applyAll(c, [
      {
        type: "respond_approval",
        request_id: "rq2",
        decision: "allow",
        updatedInput: undefined,
        message: undefined,
      },
    ]);
    expect(d.awaitingApprovalAccumulatedMs).toBe(1_250);

    const { effects } = applyAll(d, [
      {
        type: "turn_complete",
        msg_id: "m1",
        result: "success",
        seq: 0,
      },
    ]);
    const appended = appendedEntries(effects);
    expect(appended[0].entry.awaitingApprovalMs).toBe(1_250);
  });

  it("a question dialog accumulates the wait with the same semantics", () => {
    const seeded = applyAll(fresh(), [
      { type: "send", text: "hi", atoms: [], content: [{ type: "text" as const, text: "hi" }], turnKey: "k1" },
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
    ]).state;

    const { state: q } = applyAll(seeded, [
      {
        type: "control_request_forward",
        request_id: "rq1",
        is_question: true,
        tool_name: "AskUserQuestion",
        input: {},
        question: "pick one",
        options: ["a", "b"],
      },
    ]);
    expect(q.awaitingApprovalSince).toBe(now);
    expect(q.pendingQuestion).not.toBeNull();
    advance(1_500);
    const { state: a } = applyAll(q, [
      {
        type: "respond_question",
        request_id: "rq1",
        answers: { choice: "a" },
      },
    ]);
    expect(a.awaitingApprovalSince).toBeNull();
    expect(a.awaitingApprovalAccumulatedMs).toBe(1_500);
  });

  it("a CASE B interrupt while paused folds the in-progress interval", () => {
    const seeded = applyAll(fresh(), [
      { type: "send", text: "hi", atoms: [], content: [{ type: "text" as const, text: "hi" }], turnKey: "k1" },
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
      {
        type: "control_request_forward",
        request_id: "rq1",
        is_question: false,
        tool_name: "Edit",
        input: {},
      },
    ]).state;
    expect(seeded.awaitingApprovalSince).toBe(now);
    advance(800);
    const { state: i } = applyAll(seeded, [
      { type: "interrupt_action" },
    ]);
    expect(i.awaitingApprovalSince).toBeNull();
    expect(i.awaitingApprovalAccumulatedMs).toBe(800);
    expect(i.interruptInFlight).toBe(true);

    // Wire echoes the eventual turn_complete(error) — committed entry
    // reports the full 800ms wait and `turnEndReason: "interrupted"`.
    advance(20);
    const { effects } = applyAll(i, [
      {
        type: "turn_complete",
        msg_id: "m1",
        result: "error",
        seq: 0,
      },
    ]);
    const appended = appendedEntries(effects);
    expect(appended[0].entry.awaitingApprovalMs).toBe(800);
    expect(appended[0].entry.turnEndReason).toBe("interrupted");
  });

  it("a turn with no dialogs commits with awaitingApprovalMs === 0", () => {
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
    const appended = appendedEntries(effects);
    expect(appended[0].entry.awaitingApprovalMs).toBe(0);
  });
});
