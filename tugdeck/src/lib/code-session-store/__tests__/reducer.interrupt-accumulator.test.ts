/**
 * Reducer tests for the per-turn interrupt-in-flight accumulator and
 * the parallel interval-array projections used by live-derivation.
 *
 * The latched `interruptInFlight` boolean and the matching `turn_complete`
 * → "interrupted" reason are covered by `reducer.diagnostics.test.ts`.
 * This file pins the new pieces from `#step-20-4-5-a`: the
 * `interruptInFlightSegmentStartedAt` timestamp + the three closed-
 * intervals arrays that the snapshot projects so the pure live-clock
 * helper can compute an overlap-correct active duration.
 *
 * The arrays' close-and-push semantics for the awaiting-approval and
 * transport-downtime axes are exercised by their dedicated accounting
 * tests; this file focuses on the new interrupt axis end-to-end, plus
 * the cross-axis turn-boundary contracts.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";

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

describe("reducer — interrupt-in-flight accumulator", () => {
  it("initial state has no open interrupt segment and an empty intervals array", () => {
    const s = fresh();
    expect(s.interruptInFlight).toBe(false);
    expect(s.interruptInFlightSegmentStartedAt).toBeNull();
    expect(s.interruptInFlightIntervals).toEqual([]);
  });

  it("`interrupt` from a content-bearing phase (CASE B) opens the segment at Date.now()", () => {
    const { state: s } = applyAll(fresh(), [
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
    expect(s.interruptInFlight).toBe(false);
    expect(s.interruptInFlightSegmentStartedAt).toBeNull();

    advance(1_500);
    const openAt = now;
    const { state: after } = applyAll(s, [{ type: "interrupt_action" }]);

    expect(after.interruptInFlight).toBe(true);
    expect(after.interruptInFlightSegmentStartedAt).toBe(openAt);
    // The closed intervals array is still empty — the segment is open.
    expect(after.interruptInFlightIntervals).toEqual([]);
  });

  it("`turn_complete` closes the open interrupt segment and pushes `[start, end]` to the intervals array", () => {
    const { state: opened } = applyAll(fresh(), [
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
    advance(1_000);
    const openAt = now;
    const { state: midInterrupt } = applyAll(opened, [
      { type: "interrupt_action" },
    ]);
    expect(midInterrupt.interruptInFlightSegmentStartedAt).toBe(openAt);

    advance(750);
    const closeAt = now;
    const { state: completed } = applyAll(midInterrupt, [
      { type: "turn_complete", msg_id: "m1", result: "error", seq: 0 },
    ]);

    // Latched bool resets via `resetPerTurnTelemetry`; segment start
    // is closed (null); the closed `[open, close]` pair lands on the
    // intervals array so live-derivation consumers (clipped to the
    // just-ended turn's window) can read the full pause history
    // through the brief idle gap before the next `send`.
    expect(completed.interruptInFlight).toBe(false);
    expect(completed.interruptInFlightSegmentStartedAt).toBeNull();
    expect(completed.interruptInFlightIntervals).toEqual([[openAt, closeAt]]);
  });

  it("CASE A interrupt (from `submitting`, no content) does NOT open an interrupt segment", () => {
    // CASE A: interrupt fires while phase === "submitting" (no
    // content has arrived yet). The UI never sees an INTERRUPTING
    // state in this path — phase goes straight back to idle.
    const { state } = applyAll(fresh(), [
      { type: "send", text: "hi", atoms: [], content: [{ type: "text" as const, text: "hi" }], turnKey: "k1" },
      { type: "interrupt_action" },
    ]);
    expect(state.phase).toBe("idle");
    expect(state.interruptInFlight).toBe(false);
    expect(state.interruptInFlightSegmentStartedAt).toBeNull();
    expect(state.interruptInFlightIntervals).toEqual([]);
  });

  it("a fresh `send` resets the per-turn intervals projections from the prior turn", () => {
    // Run a CASE B interrupt cycle to populate the array, then submit
    // again and confirm the arrays + segment-start are wiped.
    const { state: prior } = applyAll(fresh(), [
      { type: "send", text: "first", atoms: [], content: [{ type: "text" as const, text: "first" }], turnKey: "k1" },
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
      { type: "turn_complete", msg_id: "m1", result: "error", seq: 0 },
    ]);
    expect(prior.interruptInFlightIntervals.length).toBe(1);

    const { state: nextTurn } = applyAll(prior, [
      { type: "send", text: "second", atoms: [], content: [{ type: "text" as const, text: "second" }], turnKey: "k2" },
    ]);
    expect(nextTurn.interruptInFlightIntervals).toEqual([]);
    expect(nextTurn.interruptInFlightSegmentStartedAt).toBeNull();
    expect(nextTurn.awaitingApprovalIntervals).toEqual([]);
    expect(nextTurn.transportDowntimeIntervals).toEqual([]);
  });

  it("`turn_complete` is a no-op for the intervals array when no interrupt was open", () => {
    // A normal successful turn — no interrupt fired — leaves the
    // interrupt intervals array empty and the segment-start null.
    const { state } = applyAll(fresh(), [
      { type: "send", text: "hi", atoms: [], content: [{ type: "text" as const, text: "hi" }], turnKey: "k1" },
      { type: "assistant_text", msg_id: "m1",
      block_index: 0,
      text: "ok", is_partial: false,
      seq: 0,
      rev: 0,
      status: "complete" },
      { type: "turn_complete", msg_id: "m1", result: "success", seq: 0 },
    ]);
    expect(state.interruptInFlight).toBe(false);
    expect(state.interruptInFlightSegmentStartedAt).toBeNull();
    expect(state.interruptInFlightIntervals).toEqual([]);
  });
});

describe("reducer — pause-axis interval arrays at turn boundary", () => {
  it("a closed awaiting-approval dialog populates `awaitingApprovalIntervals` mid-turn", () => {
    const { state: opened } = applyAll(fresh(), [
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
      {
        type: "control_request_forward",
        request_id: "r1",
        is_question: false,
        tool_name: "Bash",
        input: {},
      },
    ]);
    expect(opened.awaitingApprovalSince).toBe(now);

    advance(500);
    const respondAt = now;
    const { state: answered } = applyAll(opened, [
      {
        type: "respond_approval",
        request_id: "r1",
        decision: "allow",
      },
    ]);
    expect(answered.awaitingApprovalSince).toBeNull();
    expect(answered.awaitingApprovalIntervals).toEqual([
      [respondAt - 500, respondAt],
    ]);
  });

  it("a closed transport-downtime interval populates `transportDowntimeIntervals` when the wire settles", () => {
    const { state: opened } = applyAll(fresh(), [
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
      { type: "transport_close" },
      { type: "transport_open" },
    ]);
    const downAt = opened.transportNonOnlineSince;
    expect(downAt).not.toBeNull();

    advance(900);
    const settleAt = now;
    const { state: settled } = applyAll(opened, [{ type: "transport_settled" }]);
    expect(settled.transportNonOnlineSince).toBeNull();
    expect(settled.transportDowntimeIntervals.length).toBe(1);
    const [interval] = settled.transportDowntimeIntervals;
    expect(interval[0]).toBe(downAt as number);
    expect(interval[1]).toBe(settleAt);
  });

  it("the snapshot projects all six new fields verbatim from reducer state", async () => {
    const { CodeSessionStore } = await import("@/lib/code-session-store");
    const { ConnectionLifecycle } = await import("@/lib/connection-lifecycle");
    const { TestFrameChannel } = await import(
      "@/lib/code-session-store/testing/mock-feed-store"
    );
    const store = new CodeSessionStore({
      conn: new TestFrameChannel() as never,
      lifecycle: new ConnectionLifecycle(),
      tugSessionId: FIXTURE_IDS.TUG_SESSION_ID,
      sessionMode: "new",
    });
    const snap = store.getSnapshot();
    expect(snap.awaitingApprovalIntervals).toEqual([]);
    expect(snap.awaitingApprovalSegmentStartedAt).toBeNull();
    expect(snap.transportDowntimeIntervals).toEqual([]);
    expect(snap.transportDowntimeSegmentStartedAt).toBeNull();
    expect(snap.interruptInFlightIntervals).toEqual([]);
    expect(snap.interruptInFlightSegmentStartedAt).toBeNull();
    store.dispose();
  });
});
